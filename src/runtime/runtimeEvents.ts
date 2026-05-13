import { nanoid } from "nanoid";
import type { AgentState, ApprovalDecision, ApprovalRequestRecord, RuntimeEventRecord } from "@shared/types";
import { nowIso } from "@shared/utils";

export type WorkbenchTransportEvent =
  | { kind: "thread-status"; threadId: string; status: string }
  | { kind: "turn-started"; threadId: string; turnId: string }
  | { kind: "turn-completed"; threadId: string; turnId: string; status: string }
  | { kind: "item-started"; threadId: string; itemId: string; itemType: string; title: string; detail?: string; command?: string; cwd?: string }
  | { kind: "item-completed"; threadId: string; itemId: string; itemType: string; status?: string; title: string; detail?: string; exitCode?: number | null; raw?: unknown }
  | { kind: "agent-message-delta"; threadId: string; itemId: string; delta: string }
  | { kind: "plan-delta"; threadId: string; itemId: string; delta: string }
  | { kind: "reasoning-delta"; threadId: string; itemId: string; delta: string }
  | { kind: "terminal-input"; threadId: string; itemId: string; input: string }
  | { kind: "command-output"; threadId: string; itemId: string; delta: string }
  | { kind: "file-change"; threadId: string; itemId: string; delta: string }
  | { kind: "approval-request"; approval: ApprovalRequestRecord }
  | { kind: "approval-resolved"; approvalId: string; decision: ApprovalDecision }
  | { kind: "raw"; title: string; detail?: string; raw?: unknown };

const getStepIdForAgent = (agent: AgentState): RuntimeEventRecord["stepId"] => {
  switch (agent.category) {
    case "recommendation":
      return "recommendation";
    case "coding":
      return "coding";
    case "integrity":
      return "integrity";
    case "merge":
      return "merge";
    case "goal":
      return agent.name === "Ultimate Goal Agent" || agent.currentPhase?.toLowerCase().includes("ultimate goal")
        ? "ultimate_goal"
        : "goal_plan";
    default:
      return undefined;
  }
};

const MAX_EVENT_DETAIL_LENGTH = 8_000;
const MAX_EVENT_RAW_STRING_LENGTH = 2_000;
const MAX_EVENT_RAW_ARRAY_LENGTH = 20;
const MAX_EVENT_RAW_OBJECT_KEYS = 40;
const MAX_EVENT_RAW_DEPTH = 4;
const STRUCTURED_STREAM_PLACEHOLDER = "Receiving structured agent output...";
const LATEST_ONLY_EVENT_TITLES = new Set(["Plan updated"]);

const ANSI_ESCAPE_PATTERN = new RegExp(
  String.raw`(?:\u001B\][\s\S]*?(?:\u0007|\u001B\\))|(?:[\u001B\u009B][[\]()#;?]*(?:[0-?]*[ -/]*[@-~]))`,
  "g"
);
const CONTROL_CHARACTER_PATTERN = new RegExp(String.raw`[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]`, "g");

const sanitizeDisplayText = (value: string): string =>
  value
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(CONTROL_CHARACTER_PATTERN, "")
    .replace(/\n{5,}/g, "\n\n\n\n");

const capDetail = (value: string, maxLength = MAX_EVENT_DETAIL_LENGTH): string => {
  const sanitized = sanitizeDisplayText(value);
  return sanitized.length <= maxLength ? sanitized : sanitized.slice(-maxLength);
};

const capLeadingDetail = (value: string, maxLength: number): string => {
  const sanitized = sanitizeDisplayText(value);
  return sanitized.length <= maxLength
    ? sanitized
    : `${sanitized.slice(0, Math.max(0, maxLength - 15)).trimEnd()}...[truncated]`;
};

const compactDisplayText = (value: unknown, maxLength: number): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const sanitized = sanitizeDisplayText(value).trim().replace(/[ \t]{2,}/g, " ");
  return sanitized.length <= maxLength ? sanitized : `${sanitized.slice(0, Math.max(0, maxLength - 15)).trimEnd()}...[truncated]`;
};

const startsLikeStructuredJson = (value: string): boolean => {
  const trimmed = value.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
};

const tryParseJson = (value: string): unknown => {
  const trimmed = sanitizeDisplayText(value).trim();
  if (!startsLikeStructuredJson(trimmed)) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
};

const countGoalCheckUpdateStatuses = (updates: unknown[]): string => {
  const counts = new Map<string, number>();
  for (const update of updates) {
    if (!update || typeof update !== "object") {
      continue;
    }
    const status = (update as { status?: unknown }).status;
    if (typeof status === "string" && status.length > 0) {
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([status, count]) => `${status} ${count}`)
    .join(", ");
};

const summarizeStructuredAgentMessage = (detail: string): string | undefined => {
  const parsed = tryParseJson(detail);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    return undefined;
  }

  const message = parsed as Record<string, unknown>;
  const recommendations = Array.isArray(message.recommendations) ? message.recommendations : [];
  const goalCheckUpdates = Array.isArray(message.goalCheckUpdates) ? message.goalCheckUpdates : [];
  if (!("summary" in message) && recommendations.length === 0 && goalCheckUpdates.length === 0) {
    return undefined;
  }

  const lines: string[] = [];
  const summary = compactDisplayText(message.summary, 360);
  if (summary) {
    lines.push(`Summary: ${summary}`);
  }

  const progress = message.ultimateGoalProgress;
  if (progress && typeof progress === "object") {
    const percentComplete = (progress as { percentComplete?: unknown }).percentComplete;
    const rationale = compactDisplayText((progress as { rationale?: unknown }).rationale, 220);
    if (typeof percentComplete === "number") {
      lines.push(`Goal progress: ${Math.round(percentComplete)}%${rationale ? ` - ${rationale}` : ""}`);
    }
  }

  if (recommendations.length > 0) {
    lines.push("Recommendations:");
    for (const [index, recommendation] of recommendations.slice(0, 5).entries()) {
      if (!recommendation || typeof recommendation !== "object") {
        continue;
      }
      const title = compactDisplayText((recommendation as { title?: unknown }).title, 120) ?? `Option ${index + 1}`;
      const summaryLine = compactDisplayText((recommendation as { summary?: unknown }).summary, 180);
      lines.push(`${index + 1}. ${title}${summaryLine ? ` - ${summaryLine}` : ""}`);
    }
  }

  if (goalCheckUpdates.length > 0) {
    const statusSummary = countGoalCheckUpdateStatuses(goalCheckUpdates);
    const targetTitles = goalCheckUpdates
      .slice(0, 6)
      .map((update) => update && typeof update === "object" ? compactDisplayText((update as { title?: unknown }).title, 80) : undefined)
      .filter((title): title is string => Boolean(title));
    lines.push(`Checklist updates: ${goalCheckUpdates.length}${statusSummary ? ` (${statusSummary})` : ""}.`);
    if (targetTitles.length > 0) {
      lines.push(`Targets: ${targetTitles.join("; ")}${goalCheckUpdates.length > targetTitles.length ? "; ..." : ""}`);
    }
  }

  return lines.length > 0 ? lines.join("\n") : undefined;
};

const formatAgentMessageDetailForDisplay = (detail: string): string =>
  summarizeStructuredAgentMessage(detail) ?? capDetail(detail);

const formatStreamingDetailForDisplay = (
  type: RuntimeEventRecord["type"],
  detail: string
): string => type === "message" && startsLikeStructuredJson(detail)
  ? STRUCTURED_STREAM_PLACEHOLDER
  : detail;

const compactRawValue = (value: unknown, depth = 0): unknown => {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    const sanitized = sanitizeDisplayText(value);
    return sanitized.length <= MAX_EVENT_RAW_STRING_LENGTH
      ? sanitized
      : `${sanitized.slice(0, MAX_EVENT_RAW_STRING_LENGTH).trimEnd()}...[truncated ${sanitized.length - MAX_EVENT_RAW_STRING_LENGTH} chars]`;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "symbol") {
    return value.description ? `Symbol(${value.description})` : "Symbol";
  }
  if (typeof value === "function") {
    return `[function ${value.name || "anonymous"}]`;
  }
  if (typeof value !== "object") {
    return "[unserializable raw payload]";
  }
  if (depth >= MAX_EVENT_RAW_DEPTH) {
    return "[truncated nested raw payload]";
  }
  if (Array.isArray(value)) {
    const compacted = value.slice(0, MAX_EVENT_RAW_ARRAY_LENGTH).map((entry) => compactRawValue(entry, depth + 1));
    if (value.length > MAX_EVENT_RAW_ARRAY_LENGTH) {
      compacted.push(`[truncated ${value.length - MAX_EVENT_RAW_ARRAY_LENGTH} array item(s)]`);
    }
    return compacted;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const compacted: Record<string, unknown> = {};
  for (const [key, entry] of entries.slice(0, MAX_EVENT_RAW_OBJECT_KEYS)) {
    compacted[key] = compactRawValue(entry, depth + 1);
  }
  if (entries.length > MAX_EVENT_RAW_OBJECT_KEYS) {
    compacted.__truncatedKeys = entries.length - MAX_EVENT_RAW_OBJECT_KEYS;
  }
  return compacted;
};

const compactRawPayload = (raw: unknown): unknown => raw === undefined ? undefined : compactRawValue(raw);

export const compactRuntimeEventRecord = (event: RuntimeEventRecord): RuntimeEventRecord => ({
  ...event,
  detail: event.detail ? capDetail(event.detail) : event.detail,
  raw: compactRawPayload(event.raw)
});

const pushEvent = (
  agent: AgentState,
  type: RuntimeEventRecord["type"],
  title: string,
  detail?: string,
  raw?: unknown,
  options?: Pick<RuntimeEventRecord, "status" | "itemId">
): void => {
  const timestamp = nowIso();
  const existingIndex = options?.itemId
    ? agent.events.findIndex((entry) => entry.itemId === options.itemId && entry.type === type && entry.title === title)
    : LATEST_ONLY_EVENT_TITLES.has(title)
      ? agent.events.findIndex((entry) => entry.type === type && entry.title === title)
      : -1;
  const nextEvent = {
    id: nanoid(),
    agentId: agent.id,
    timestamp,
    type,
    status: options?.status,
    stepId: getStepIdForAgent(agent),
    agentCategory: agent.category,
    itemId: options?.itemId,
    title,
    detail: detail ? capDetail(detail) : detail,
    raw: compactRawPayload(raw)
  };
  if (existingIndex >= 0) {
    const [existing] = agent.events.splice(existingIndex, 1);
    agent.events.unshift({
      ...existing,
      ...nextEvent,
      id: existing.id
    });
  } else {
    agent.events.unshift(nextEvent);
  }
  agent.lastActivityAt = timestamp;
  if (agent.events.length > 250) {
    agent.events.length = 250;
  }
};

const findStreamingEventIndex = (
  agent: AgentState,
  type: RuntimeEventRecord["type"],
  itemId?: string
): number => agent.events.findIndex((entry) => entry.type === type && entry.itemId === itemId && entry.status === "running");

const upsertStreamingEvent = (
  agent: AgentState,
  type: RuntimeEventRecord["type"],
  title: string,
  delta: string,
  options?: Pick<RuntimeEventRecord, "itemId"> & { status?: RuntimeEventRecord["status"]; maxLength?: number }
): void => {
  const timestamp = nowIso();
  const index = findStreamingEventIndex(agent, type, options?.itemId);
  if (index >= 0) {
    const [existing] = agent.events.splice(index, 1);
    const nextDetail = existing.detail === STRUCTURED_STREAM_PLACEHOLDER
      ? STRUCTURED_STREAM_PLACEHOLDER
      : formatStreamingDetailForDisplay(type, `${existing.detail ?? ""}${delta}`);
    existing.timestamp = timestamp;
    existing.title = title;
    existing.detail = capDetail(nextDetail, options?.maxLength);
    existing.status = options?.status ?? existing.status ?? "running";
    existing.stepId = getStepIdForAgent(agent);
    existing.agentCategory = agent.category;
    agent.events.unshift(existing);
    agent.lastActivityAt = timestamp;
    return;
  }

  pushEvent(agent, type, title, capDetail(formatStreamingDetailForDisplay(type, delta), options?.maxLength), undefined, {
    status: options?.status ?? "running",
    itemId: options?.itemId
  });
};

const finalizeStreamingEvent = (
  agent: AgentState,
  type: RuntimeEventRecord["type"],
  title: string,
  detail: string | undefined,
  options?: Pick<RuntimeEventRecord, "itemId" | "status"> & { raw?: unknown; maxLength?: number }
): boolean => {
  const timestamp = nowIso();
  const index = findStreamingEventIndex(agent, type, options?.itemId);
  if (index === -1) {
    return false;
  }

  const [existing] = agent.events.splice(index, 1);
  existing.timestamp = timestamp;
  existing.title = title;
  existing.detail = detail ? capDetail(detail, options?.maxLength) : existing.detail;
  existing.status = options?.status ?? "completed";
  existing.raw = options?.raw === undefined ? existing.raw : compactRawPayload(options.raw);
  existing.stepId = getStepIdForAgent(agent);
  existing.agentCategory = agent.category;
  agent.events.unshift(existing);
  agent.lastActivityAt = timestamp;
  return true;
};

export const reduceAgentRuntimeEvent = (agent: AgentState, event: WorkbenchTransportEvent): AgentState => {
  switch (event.kind) {
    case "thread-status":
      agent.status = event.status === "running" ? "running" : event.status === "completed" ? "completed" : agent.status;
      agent.currentPhase = `Thread ${event.status}`;
      if (event.status === "completed" || event.status === "failed") {
        agent.completedAt ??= nowIso();
      }
      pushEvent(agent, "thread", "Thread status changed", event.status, event, {
        status: event.status === "completed" ? "completed" : event.status === "failed" ? "failed" : "running"
      });
      return agent;
    case "turn-started":
      agent.status = "running";
      agent.startedAt ??= nowIso();
      agent.currentPhase = "Turn running";
      pushEvent(agent, "turn", "Turn started", event.turnId, event, { status: "running" });
      return agent;
    case "turn-completed":
      agent.status = event.status === "failed" ? "failed" : "completed";
      agent.currentPhase = `Turn ${event.status}`;
      agent.completedAt ??= nowIso();
      pushEvent(agent, "turn", "Turn completed", event.status, event, {
        status: event.status === "failed" ? "failed" : "completed"
      });
      return agent;
    case "item-started":
      agent.status = "running";
      agent.startedAt ??= nowIso();
      agent.currentSubtask = event.detail ?? event.command ?? event.title;
      if (event.command) {
        const existingCommand = agent.commandLog.find((entry) => entry.itemId === event.itemId);
        if (existingCommand) {
          existingCommand.command = event.command;
          existingCommand.cwd = event.cwd;
          existingCommand.status = "running";
        } else {
          agent.commandLog.unshift({
            itemId: event.itemId,
            command: event.command,
            cwd: event.cwd,
            output: "",
            status: "running",
            startedAt: nowIso()
          });
        }
      }
      pushEvent(agent, "item", event.title, event.detail ?? event.command, event, {
        status: "running",
        itemId: event.itemId
      });
      return agent;
    case "item-completed": {
      if (event.itemType === "commandExecution") {
        const command = agent.commandLog.find((entry) => entry.itemId === event.itemId);
        if (command) {
          command.status = event.status ?? command.status;
          command.completedAt = nowIso();
          command.exitCode = event.exitCode;
        }
      }
      agent.currentSubtask = undefined;
      if (event.itemType === "agentMessage") {
        const displayDetail = formatAgentMessageDetailForDisplay(event.detail ?? "");
        agent.lastMessageSnippet = capLeadingDetail(displayDetail, 240);
        if (finalizeStreamingEvent(agent, "message", "Agent message", event.detail, {
          status: event.status === "failed" ? "failed" : "completed",
          itemId: event.itemId,
          raw: event.raw,
          maxLength: 8_000
        })) {
          const finalized = agent.events.find((entry) => entry.itemId === event.itemId && entry.type === "message");
          if (finalized) {
            finalized.detail = capDetail(displayDetail, 8_000);
          }
          return agent;
        }
        pushEvent(agent, "message", "Agent message", displayDetail, event.raw, {
          status: event.status === "failed" ? "failed" : "completed",
          itemId: event.itemId
        });
        return agent;
      }
      if (event.itemType === "plan") {
        if (finalizeStreamingEvent(agent, "item", "Plan update", event.detail, {
          status: event.status === "failed" ? "failed" : "completed",
          itemId: event.itemId,
          raw: event.raw,
          maxLength: 4_000
        })) {
          return agent;
        }
      }
      if (event.itemType === "reasoning") {
        if (finalizeStreamingEvent(agent, "item", "Reasoning update", event.detail, {
          status: event.status === "failed" ? "failed" : "completed",
          itemId: event.itemId,
          raw: event.raw,
          maxLength: 4_000
        })) {
          return agent;
        }
      }
      if (event.itemType === "fileChange") {
        finalizeStreamingEvent(agent, "file-change", "File change event", undefined, {
          status: event.status === "failed" ? "failed" : "completed",
          itemId: event.itemId
        });
      }
      if (event.itemType === "commandExecution") {
        finalizeStreamingEvent(agent, "command", "Command output", undefined, {
          status: event.status === "failed" ? "failed" : "completed",
          itemId: event.itemId
        });
      }
      pushEvent(agent, event.itemType === "commandExecution" ? "command" : "item", event.title, event.detail, event.raw, {
        status: event.status === "failed" ? "failed" : "completed",
        itemId: event.itemId
      });
      return agent;
    }
    case "agent-message-delta":
      if (agent.lastMessageSnippet === STRUCTURED_STREAM_PLACEHOLDER) {
        agent.lastMessageSnippet = STRUCTURED_STREAM_PLACEHOLDER;
      } else {
        const nextSnippet = formatStreamingDetailForDisplay("message", `${agent.lastMessageSnippet ?? ""}${event.delta}`);
        agent.lastMessageSnippet = capDetail(nextSnippet, 240);
      }
      upsertStreamingEvent(agent, "message", "Agent message", event.delta, {
        status: "running",
        itemId: event.itemId,
        maxLength: 8_000
      });
      return agent;
    case "plan-delta":
      agent.currentSubtask = event.delta.slice(0, 240);
      upsertStreamingEvent(agent, "item", "Plan update", event.delta, {
        status: "running",
        itemId: event.itemId,
        maxLength: 4_000
      });
      return agent;
    case "reasoning-delta":
      upsertStreamingEvent(agent, "item", "Reasoning update", event.delta, {
        status: "running",
        itemId: event.itemId,
        maxLength: 4_000
      });
      return agent;
    case "terminal-input":
      pushEvent(agent, "command", "Terminal input sent", event.input, event, {
        status: "running",
        itemId: event.itemId
      });
      return agent;
    case "command-output": {
      const lastCommand = agent.commandLog.find((entry) => entry.itemId === event.itemId) ?? agent.commandLog[0];
      if (lastCommand) {
        lastCommand.output = capDetail(`${lastCommand.output}${event.delta}`, 12_000);
      }
      upsertStreamingEvent(agent, "command", "Command output", event.delta, {
        status: "running",
        itemId: event.itemId,
        maxLength: 12_000
      });
      return agent;
    }
    case "file-change":
      upsertStreamingEvent(agent, "file-change", "File change event", event.delta, {
        status: "running",
        itemId: event.itemId,
        maxLength: 6_000
      });
      return agent;
    case "approval-request":
      agent.approvals.unshift(event.approval);
      agent.status = "waiting_approval";
      pushEvent(agent, "approval", "Approval requested", event.approval.summary, event.approval, {
        status: "waiting",
        itemId: event.approval.itemId
      });
      return agent;
    case "approval-resolved": {
      const approval = agent.approvals.find((entry) => entry.id === event.approvalId);
      if (approval) {
        approval.status = event.decision === "decline" || event.decision === "cancel" ? "rejected" : "approved";
      }
      agent.status = "running";
      pushEvent(agent, "approval", "Approval resolved", event.decision, event, {
        status: event.decision === "decline" || event.decision === "cancel" ? "failed" : "completed"
      });
      return agent;
    }
    case "raw":
      pushEvent(agent, "raw", event.title, event.detail, event.raw, {
        status: "info"
      });
      return agent;
  }
};
