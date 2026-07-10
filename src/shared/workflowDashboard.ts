import type {
  AgentCategory,
  AgentState,
  ProjectWorkflowState,
  ValidationLedger,
  WorkflowActivityEvent,
  WorkflowExecutionTag,
  WorkflowStage,
  WorkflowStepId
} from "./types";

export type WorkflowDashboardPhase =
  | "goal"
  | "recommendation"
  | "planning"
  | "coding"
  | "integrity"
  | "repair"
  | "merge"
  | "complete"
  | "system";

export type WorkflowTimelineKind = "cycle" | "phase" | "activity" | "validation" | "checklist";
export type WorkflowTimelineStatus = "info" | "pending" | "running" | "waiting" | "completed" | "failed" | "blocked";
export type WorkflowTimelineSortOrder = "ascending" | "descending";

export interface WorkflowTimelineItem {
  id: string;
  kind: WorkflowTimelineKind;
  phase: WorkflowDashboardPhase;
  status: WorkflowTimelineStatus;
  title: string;
  detail?: string;
  timestamp: string;
  endedAt?: string;
  durationMs?: number;
  cycleNumber?: number;
  agentId?: string;
  agentName?: string;
  agentCategory?: AgentCategory;
  incidentId?: string;
  command?: string;
  paths: string[];
  sourceId?: string;
}

export interface WorkflowTimelineFilter {
  cycleNumbers?: readonly number[];
  phases?: readonly WorkflowDashboardPhase[];
  kinds?: readonly WorkflowTimelineKind[];
  statuses?: readonly WorkflowTimelineStatus[];
  agentIds?: readonly string[];
  incidentIds?: readonly string[];
  query?: string;
  from?: string | number | Date;
  to?: string | number | Date;
}

export interface WorkflowTimelineQuery extends WorkflowTimelineFilter {
  sortOrder?: WorkflowTimelineSortOrder;
  offset?: number;
  limit?: number;
}

export interface WorkflowTimelinePage {
  items: WorkflowTimelineItem[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface WorkflowMissionAgentSummary {
  id: string;
  name: string;
  category: AgentCategory;
  model: string;
  status: AgentState["status"];
  currentActivity?: string;
}

export interface WorkflowMissionSummary {
  goal: string;
  cycleNumber: number;
  cycleTitle: string;
  executionTag?: WorkflowExecutionTag;
  stage: WorkflowStage;
  stageLabel: string;
  currentPhase: WorkflowDashboardPhase;
  status: "idle" | "running" | "waiting" | "blocked" | "completed";
  goalProgressPercent?: number;
  cycleProgressPercent: number;
  now: string;
  next: string;
  needsUser: string[];
  activeAgent?: WorkflowMissionAgentSummary;
  autopilot: {
    enabled: boolean;
    paused: boolean;
    detail?: string;
  };
  validationStatus?: ValidationLedger["finalValidationStatus"];
  lastOutcome?: string;
}

export interface WorkflowDurationSummary {
  sampleCount: number;
  totalMs: number;
  averageMs?: number;
  medianMs?: number;
  minimumMs?: number;
  maximumMs?: number;
}

export interface WorkflowPhaseMetric {
  phase: WorkflowDashboardPhase;
  runs: number;
  active: number;
  completed: number;
  failed: number;
  duration: WorkflowDurationSummary;
}

export interface WorkflowTokenTotals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface WorkflowModelMetric {
  model: string;
  agentCount: number;
  completed: number;
  failed: number;
  tokens: WorkflowTokenTotals;
}

export interface WorkflowAgentCategoryMetric {
  category: AgentCategory;
  agentCount: number;
  active: number;
  completed: number;
  failed: number;
}

export interface WorkflowDashboardMetrics {
  cycles: {
    observed: number;
    completed: number;
    failed: number;
    activeCycleNumber?: number;
    duration: WorkflowDurationSummary;
  };
  phases: WorkflowPhaseMetric[];
  validation: {
    cyclesValidated: number;
    firstPassPassed: number;
    firstPassRatePercent?: number;
    repairCyclesAttempted: number;
    repairCyclesSucceeded: number;
    repairSuccessRatePercent?: number;
  };
  work: {
    commandExecutions: number;
    uniqueCommands: number;
    commands: string[];
    fileReferences: number;
    uniqueFiles: number;
    files: string[];
    checklistChangeRecords: number;
    checklistItemsTouched: number;
    checklistItemsAdvanced: number;
    goalProgressPoints: number;
  };
  agents: {
    total: number;
    active: number;
    completed: number;
    failed: number;
    agentsWithTokenUsage: number;
    tokens: WorkflowTokenTotals;
    byCategory: WorkflowAgentCategoryMetric[];
    models: WorkflowModelMetric[];
  };
}

export interface WorkflowDashboardSnapshot {
  generatedAt: string;
  mission: WorkflowMissionSummary;
  timeline: WorkflowTimelinePage;
  metrics: WorkflowDashboardMetrics;
}

export interface WorkflowDashboardOptions {
  now?: string | number | Date;
  timeline?: WorkflowTimelineQuery;
}

const epochIso = new Date(0).toISOString();
const activeAgentStatuses = new Set<AgentState["status"]>(["starting", "running", "waiting_approval"]);
const failedAgentStatuses = new Set<AgentState["status"]>(["failed", "conflicted", "disconnected"]);
const terminalAgentStatuses = new Set<AgentState["status"]>(["completed", "failed", "conflicted", "disconnected"]);
const phaseOrder: WorkflowDashboardPhase[] = [
  "goal",
  "recommendation",
  "planning",
  "coding",
  "integrity",
  "repair",
  "merge",
  "complete",
  "system"
];
const categoryOrder: AgentCategory[] = ["bootstrap", "goal", "recommendation", "coding", "integrity", "merge", "manual"];
const kindOrder: Record<WorkflowTimelineKind, number> = {
  cycle: 0,
  phase: 1,
  validation: 2,
  checklist: 3,
  activity: 4
};

const asArray = <T>(value: readonly T[] | null | undefined): readonly T[] =>
  Array.isArray(value) ? value as readonly T[] : [];

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const parseTime = (value?: string | number | Date): number | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const parsed = value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? value
      : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const resolveNow = (value?: string | number | Date): number => parseTime(value) ?? Date.now();

const timestampOrEpoch = (value?: string): string => parseTime(value) === undefined ? epochIso : value as string;

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const uniqueSorted = (values: readonly string[]): string[] =>
  [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort(compareText);

const clampPercent = (value: number): number => Math.max(0, Math.min(100, Math.round(value)));

const deriveDuration = (startedAt?: string, endedAt?: string, activeUntil?: number): number | undefined => {
  const start = parseTime(startedAt);
  const end = parseTime(endedAt) ?? activeUntil;
  if (start === undefined || end === undefined || end < start) {
    return undefined;
  }
  return end - start;
};

const summarizeDurations = (values: readonly (number | undefined)[]): WorkflowDurationSummary => {
  const samples = values
    .filter((value): value is number => value !== undefined && Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  const totalMs = samples.reduce((total, value) => total + value, 0);
  if (samples.length === 0) {
    return { sampleCount: 0, totalMs: 0 };
  }
  const middle = Math.floor(samples.length / 2);
  const medianMs = samples.length % 2 === 0
    ? (samples[middle - 1] + samples[middle]) / 2
    : samples[middle];
  return {
    sampleCount: samples.length,
    totalMs,
    averageMs: totalMs / samples.length,
    medianMs,
    minimumMs: samples[0],
    maximumMs: samples[samples.length - 1]
  };
};

const canonicalExecution = (workflow: ProjectWorkflowState): ProjectWorkflowState["execution"] | undefined => {
  const execution = workflow.execution;
  const legacyCycle = workflow.workflowCycle?.cycleNumber;
  return execution && (legacyCycle === undefined || execution.cycleNumber === legacyCycle) ? execution : undefined;
};

const currentCycleNumber = (workflow: ProjectWorkflowState): number =>
  workflow.workflowCycle?.cycleNumber ?? canonicalExecution(workflow)?.cycleNumber ?? 0;

const agentCycleNumber = (workflow: ProjectWorkflowState, agent: AgentState): number =>
  agent.workflowCycleNumber ?? currentCycleNumber(workflow);

const isRepairAgent = (workflow: ProjectWorkflowState, agent: AgentState): boolean => {
  if (agent.category !== "coding") {
    return false;
  }
  const repairText = `${agent.name} ${agent.currentPhase ?? ""} ${agent.currentSubtask ?? ""}`;
  if (/\b(repair|remediat|retrying validation|integrity failure|merge conflict)\b/i.test(repairText)) {
    return true;
  }
  return agentCycleNumber(workflow, agent) === currentCycleNumber(workflow)
    && (workflow.workflowStage === "repair_loop" || canonicalExecution(workflow)?.tag === "repairing");
};

const phaseForStep = (stepId?: WorkflowStepId): WorkflowDashboardPhase | undefined => {
  switch (stepId) {
    case "ultimate_goal":
      return "goal";
    case "recommendation":
      return "recommendation";
    case "goal_plan":
      return "planning";
    case "coding":
      return "coding";
    case "integrity":
      return "integrity";
    case "merge":
      return "merge";
    default:
      return undefined;
  }
};

const phaseForAgent = (workflow: ProjectWorkflowState, agent: AgentState): WorkflowDashboardPhase => {
  if (isRepairAgent(workflow, agent)) {
    return "repair";
  }
  switch (agent.category) {
    case "bootstrap":
      return "goal";
    case "goal":
      return /ultimate goal/i.test(`${agent.name} ${agent.currentPhase ?? ""}`) ? "goal" : "planning";
    case "recommendation":
      return "recommendation";
    case "coding":
      return "coding";
    case "integrity":
      return "integrity";
    case "merge":
      return "merge";
    case "manual":
      return "system";
  }
};

const inferStage = (workflow: ProjectWorkflowState): WorkflowStage => {
  switch (canonicalExecution(workflow)?.tag) {
    case "needs_goal": return "charter_needed";
    case "recommending": return "recommendation_pending";
    case "awaiting_recommendation": return "recommendation_approved";
    case "planning": return "goal_ready";
    case "coding": return "coding_running";
    case "validating": return "integrity_running";
    case "repairing": return "repair_loop";
    case "merging": return "ready_to_merge";
    case "awaiting_approval":
    case "awaiting_human":
    case "paused": return "blocked_human";
    case "cycle_complete":
    case "goal_complete": return "cycle_complete";
    default:
      break;
  }
  if (workflow.workflowStage) {
    return workflow.workflowStage;
  }
  switch (workflow.workflowCycle?.status) {
    case "recommendation_approved":
      return "recommendation_approved";
    case "goal_ready":
      return "goal_ready";
    case "coding":
      return "coding_running";
    case "integrity":
      return "integrity_running";
    case "repair_loop":
      return "repair_loop";
    case "ready_to_merge":
      return "ready_to_merge";
    case "merged":
      return "merged";
    case "completed":
      return "cycle_complete";
    case "blocked_human":
      return "blocked_human";
    default:
      return workflow.ultimateGoal?.confirmedAt ? "recommendation_pending" : "charter_needed";
  }
};

const phaseForExecution = (workflow: ProjectWorkflowState): WorkflowDashboardPhase | undefined => {
  const execution = canonicalExecution(workflow);
  if (!execution) return undefined;
  switch (execution.tag) {
    case "needs_goal": return "goal";
    case "recommending":
    case "awaiting_recommendation": return "recommendation";
    case "planning": return "planning";
    case "coding": return "coding";
    case "validating": return "integrity";
    case "repairing": return "repair";
    case "merging": return "merge";
    case "cycle_complete":
    case "goal_complete": return "complete";
    case "awaiting_approval":
    case "awaiting_human":
    case "paused": return phaseForStep(execution.stepId) ?? "system";
  }
};

const executionLabel = (tag?: WorkflowExecutionTag): string | undefined => {
  switch (tag) {
    case "needs_goal": return "Goal needed";
    case "recommending": return "Preparing recommendation";
    case "awaiting_recommendation": return "Awaiting recommendation";
    case "planning": return "Planning";
    case "coding": return "Coding";
    case "validating": return "Validating";
    case "repairing": return "Repairing";
    case "merging": return "Merging";
    case "awaiting_approval": return "Awaiting approval";
    case "awaiting_human": return "Needs user input";
    case "paused": return "Paused";
    case "cycle_complete": return "Cycle complete";
    case "goal_complete": return "Goal complete";
    default: return undefined;
  }
};

const phaseForStage = (stage: WorkflowStage): WorkflowDashboardPhase => {
  switch (stage) {
    case "charter_needed":
      return "goal";
    case "recommendation_pending":
    case "recommendation_approved":
      return "recommendation";
    case "goal_ready":
      return "planning";
    case "coding_running":
      return "coding";
    case "integrity_running":
      return "integrity";
    case "repair_loop":
      return "repair";
    case "ready_to_merge":
      return "merge";
    case "merged":
    case "appeal_pending":
    case "cycle_complete":
      return "complete";
    case "blocked_human":
      return "system";
  }
};

const phaseLabel = (phase: WorkflowDashboardPhase): string => {
  switch (phase) {
    case "goal":
      return "Goal";
    case "recommendation":
      return "Recommendation";
    case "planning":
      return "Plan";
    case "coding":
      return "Coding";
    case "integrity":
      return "Integrity";
    case "repair":
      return "Repair";
    case "merge":
      return "Merge";
    case "complete":
      return "Complete";
    case "system":
      return "System";
  }
};

const stageLabel = (stage: WorkflowStage): string => {
  switch (stage) {
    case "charter_needed": return "Goal needed";
    case "recommendation_pending": return "Preparing recommendation";
    case "recommendation_approved": return "Recommendation approved";
    case "goal_ready": return "Plan ready";
    case "coding_running": return "Coding";
    case "integrity_running": return "Validating";
    case "repair_loop": return "Repairing";
    case "ready_to_merge": return "Ready to merge";
    case "merged": return "Merged";
    case "appeal_pending": return "Assessing completion";
    case "blocked_human": return "Needs attention";
    case "cycle_complete": return "Cycle complete";
  }
};

const statusForAgent = (status: AgentState["status"]): WorkflowTimelineStatus => {
  switch (status) {
    case "idle": return "pending";
    case "starting":
    case "running": return "running";
    case "waiting_approval": return "waiting";
    case "completed": return "completed";
    case "failed":
    case "conflicted":
    case "disconnected": return "failed";
  }
};

const statusForActivity = (status: WorkflowActivityEvent["status"]): WorkflowTimelineStatus => {
  switch (status) {
    case "running": return "running";
    case "waiting": return "waiting";
    case "completed": return "completed";
    case "failed": return "failed";
    case "info": return "info";
  }
};

const statusForCurrentCycle = (workflow: ProjectWorkflowState): WorkflowTimelineStatus => {
  switch (canonicalExecution(workflow)?.tag) {
    case "coding":
    case "validating":
    case "repairing":
    case "merging":
    case "planning":
    case "recommending": return "running";
    case "awaiting_recommendation":
    case "awaiting_approval": return "waiting";
    case "awaiting_human":
    case "paused": return "blocked";
    case "cycle_complete":
    case "goal_complete": return "completed";
    default:
      break;
  }
  switch (workflow.workflowCycle?.status) {
    case "coding":
    case "integrity":
    case "repair_loop": return "running";
    case "recommendation_approved":
    case "goal_ready":
    case "ready_to_merge": return "waiting";
    case "blocked_human": return "blocked";
    case "merged":
    case "completed": return "completed";
    default: return "pending";
  }
};

const cycleFromText = (value: string): number | undefined => {
  const match = /\bcycle\s*#?\s*(\d+)\b/i.exec(value);
  return match ? Number(match[1]) : undefined;
};

const activityCycleNumber = (
  workflow: ProjectWorkflowState,
  event: WorkflowActivityEvent,
  agentsById: ReadonlyMap<string, AgentState>
): number | undefined => {
  const linkedAgent = event.agentId ? agentsById.get(event.agentId) : undefined;
  if (linkedAgent) {
    return agentCycleNumber(workflow, linkedAgent);
  }
  const fromText = cycleFromText(`${event.title} ${event.detail ?? ""}`);
  if (fromText !== undefined) {
    return fromText;
  }
  const cycleStart = parseTime(workflow.workflowCycle?.startedAt);
  const eventTime = parseTime(event.timestamp);
  return cycleStart !== undefined && eventTime !== undefined && eventTime >= cycleStart
    ? currentCycleNumber(workflow)
    : undefined;
};

interface CollectedLedger {
  ledger: ValidationLedger;
  agentId?: string;
}

const ledgerIdentity = (ledger: ValidationLedger): string => [
  ledger.cycleNumber,
  ledger.createdAt,
  ledger.updatedAt,
  ledger.finalValidationStatus,
  ledger.commandResults.map((result) => `${result.commandId}:${result.startedAt}:${result.status}`).join("|")
].join("::");

const ledgerRunIdentity = (ledger: ValidationLedger): string =>
  `${ledger.cycleNumber}::${ledger.createdAt || ledgerIdentity(ledger)}`;

const collectLedgers = (workflow: ProjectWorkflowState, agents: readonly AgentState[]): CollectedLedger[] => {
  const collected = new Map<string, CollectedLedger>();
  const collect = (candidate: CollectedLedger): void => {
    const key = ledgerRunIdentity(candidate.ledger);
    const existing = collected.get(key);
    if (!existing) {
      collected.set(key, candidate);
      return;
    }
    const candidateTime = parseTime(candidate.ledger.updatedAt) ?? 0;
    const existingTime = parseTime(existing.ledger.updatedAt) ?? 0;
    if (candidateTime > existingTime || candidateTime === existingTime && candidate.ledger.commandResults.length > existing.ledger.commandResults.length) {
      collected.set(key, { ...candidate, agentId: candidate.agentId ?? existing.agentId });
    }
  };
  for (const agent of agents) {
    if (agent.validationLedger) {
      collect({ ledger: agent.validationLedger, agentId: agent.id });
    }
  }
  for (const ledger of asArray(workflow.validationLedgers)) {
    collect({ ledger });
  }
  return [...collected.values()].sort((left, right) => {
    const leftTime = parseTime(left.ledger.createdAt) ?? parseTime(left.ledger.updatedAt) ?? 0;
    const rightTime = parseTime(right.ledger.createdAt) ?? parseTime(right.ledger.updatedAt) ?? 0;
    return left.ledger.cycleNumber - right.ledger.cycleNumber || leftTime - rightTime || compareText(ledgerIdentity(left.ledger), ledgerIdentity(right.ledger));
  });
};

interface CycleObservation {
  cycleNumber: number;
  timestamps: string[];
  terminalTimestamps: string[];
  title?: string;
  summary?: string;
  hasRetrospective: boolean;
  validationFailed: boolean;
  validationPassed: boolean;
}

const addTimestamp = (target: string[], value?: string): void => {
  if (parseTime(value) !== undefined) {
    target.push(value as string);
  }
};

const collectCycleObservations = (
  workflow: ProjectWorkflowState,
  agents: readonly AgentState[],
  ledgers: readonly CollectedLedger[]
): Map<number, CycleObservation> => {
  const observations = new Map<number, CycleObservation>();
  const ensure = (cycleNumber: number): CycleObservation => {
    const existing = observations.get(cycleNumber);
    if (existing) {
      return existing;
    }
    const created: CycleObservation = {
      cycleNumber,
      timestamps: [],
      terminalTimestamps: [],
      hasRetrospective: false,
      validationFailed: false,
      validationPassed: false
    };
    observations.set(cycleNumber, created);
    return created;
  };
  const currentNumber = currentCycleNumber(workflow);
  const currentCycle = workflow.workflowCycle;
  if (
    currentCycle?.startedAt
    || currentCycle?.completedAt
    || currentCycle?.approvedRecommendationId
    || currentCycle?.approvedRecommendationTitle
    || currentCycle?.scopedGoalSummary
    || (currentCycle?.status && currentCycle.status !== "idle")
  ) {
    const current = ensure(currentNumber);
    current.title = workflow.cycleContract?.cycleNumber === currentNumber
      ? workflow.cycleContract.selectedTaskTitle
      : currentCycle?.approvedRecommendationTitle ?? workflow.approvedRecommendation?.title;
    current.summary = currentCycle?.scopedGoalSummary ?? workflow.scopedGoal?.summary;
    addTimestamp(current.timestamps, currentCycle?.startedAt);
    addTimestamp(current.timestamps, currentCycle?.completedAt);
    addTimestamp(current.terminalTimestamps, currentCycle?.completedAt);
  }
  for (const agent of agents) {
    const observation = ensure(agentCycleNumber(workflow, agent));
    addTimestamp(observation.timestamps, agent.startedAt ?? agent.createdAt);
    addTimestamp(observation.timestamps, agent.lastActivityAt);
    addTimestamp(observation.timestamps, agent.completedAt);
    if (terminalAgentStatuses.has(agent.status)) {
      addTimestamp(observation.terminalTimestamps, agent.completedAt ?? agent.lastActivityAt);
    }
  }
  for (const { ledger } of ledgers) {
    const observation = ensure(ledger.cycleNumber);
    addTimestamp(observation.timestamps, ledger.createdAt);
    addTimestamp(observation.timestamps, ledger.updatedAt);
    observation.validationFailed ||= ledger.finalValidationStatus === "failed";
    observation.validationPassed ||= ledger.finalValidationStatus === "passed";
  }
  for (const retrospective of asArray(workflow.cycleRetrospectives)) {
    const observation = ensure(retrospective.cycleNumber);
    observation.title ??= retrospective.triedToDo;
    observation.summary ??= [
      retrospective.passed.length > 0 ? `Passed: ${retrospective.passed.join(", ")}` : undefined,
      retrospective.failed.length > 0 ? `Failed: ${retrospective.failed.join(", ")}` : undefined
    ].filter((value): value is string => Boolean(value)).join(" · ") || retrospective.goalChecklistChangeRecommendation;
    observation.hasRetrospective = true;
    addTimestamp(observation.timestamps, retrospective.createdAt);
    addTimestamp(observation.terminalTimestamps, retrospective.createdAt);
  }
  for (const summary of asArray(workflow.memory?.perCycleSummaries)) {
    const observation = ensure(summary.cycleNumber);
    observation.summary ??= summary.summary;
    addTimestamp(observation.timestamps, summary.createdAt);
  }
  for (const decision of asArray(workflow.plannerDecisions)) {
    const observation = ensure(decision.cycleNumber);
    observation.title ??= decision.selectedTaskTitle;
    addTimestamp(observation.timestamps, decision.createdAt);
  }
  for (const delta of asArray(workflow.checklistDeltas)) {
    addTimestamp(ensure(delta.cycleNumber).timestamps, delta.createdAt);
  }
  const execution = canonicalExecution(workflow);
  if (execution && (execution.tag !== "needs_goal" || Boolean(workflow.ultimateGoal?.confirmedAt))) {
    const observation = ensure(execution.cycleNumber);
    addTimestamp(observation.timestamps, execution.enteredAt);
    addTimestamp(observation.timestamps, execution.updatedAt);
    if (execution.tag === "cycle_complete" || execution.tag === "goal_complete") {
      addTimestamp(observation.terminalTimestamps, execution.updatedAt);
    }
  }
  for (const event of asArray(workflow.journal)) {
    const observation = ensure(event.cycleNumber);
    addTimestamp(observation.timestamps, event.occurredAt);
    if (event.kind === "transition" && event.status === "completed") {
      addTimestamp(observation.terminalTimestamps, event.occurredAt);
    }
  }
  for (const incident of asArray(workflow.incidents)) {
    const observation = ensure(incident.cycleNumber);
    addTimestamp(observation.timestamps, incident.openedAt);
    addTimestamp(observation.timestamps, incident.updatedAt);
    if (incident.status === "resolved" || incident.status === "superseded") {
      addTimestamp(observation.terminalTimestamps, incident.resolvedAt ?? incident.updatedAt);
    }
  }
  return observations;
};

const cycleTimelineItems = (
  workflow: ProjectWorkflowState,
  observations: ReadonlyMap<number, CycleObservation>,
  nowMs: number
): WorkflowTimelineItem[] => {
  const currentNumber = currentCycleNumber(workflow);
  return [...observations.values()].map((observation) => {
    const timestamps = observation.timestamps
      .map((timestamp) => ({ timestamp, time: parseTime(timestamp) as number }))
      .sort((left, right) => left.time - right.time || compareText(left.timestamp, right.timestamp));
    const terminals = observation.terminalTimestamps
      .map((timestamp) => ({ timestamp, time: parseTime(timestamp) as number }))
      .sort((left, right) => left.time - right.time || compareText(left.timestamp, right.timestamp));
    const isCurrent = observation.cycleNumber === currentNumber;
    const isPast = currentNumber > observation.cycleNumber;
    const executionTag = canonicalExecution(workflow)?.tag;
    const isComplete = observation.hasRetrospective
      || isPast
      || (isCurrent && (["merged", "completed"].includes(workflow.workflowCycle?.status ?? "") || executionTag === "cycle_complete" || executionTag === "goal_complete"));
    const startedAt = timestamps[0]?.timestamp ?? epochIso;
    const endedAt = isComplete
      ? isCurrent && parseTime(workflow.workflowCycle?.completedAt) !== undefined
        ? workflow.workflowCycle?.completedAt
        : timestamps.at(-1)?.timestamp ?? terminals.at(-1)?.timestamp
      : undefined;
    const status = isCurrent
      ? statusForCurrentCycle(workflow)
      : observation.validationFailed && !observation.validationPassed
        ? "failed"
        : isComplete
          ? "completed"
          : "info";
    return {
      id: `cycle:${observation.cycleNumber}`,
      kind: "cycle",
      phase: status === "completed" ? "complete" : "system",
      status,
      title: observation.title?.trim() || `Cycle ${observation.cycleNumber}`,
      detail: observation.summary?.trim() || undefined,
      timestamp: startedAt,
      endedAt,
      durationMs: deriveDuration(startedAt, endedAt, status === "running" ? nowMs : undefined),
      cycleNumber: observation.cycleNumber,
      paths: []
    };
  });
};

const phaseTimelineItems = (workflow: ProjectWorkflowState, agents: readonly AgentState[], nowMs: number): WorkflowTimelineItem[] => {
  const items = agents.map((agent): WorkflowTimelineItem => {
    const phase = phaseForAgent(workflow, agent);
    const startedAt = timestampOrEpoch(agent.startedAt ?? agent.createdAt);
    const endedAt = terminalAgentStatuses.has(agent.status) ? agent.completedAt ?? agent.lastActivityAt : undefined;
    return {
      id: `phase:agent:${agent.id}`,
      kind: "phase",
      phase,
      status: statusForAgent(agent.status),
      title: `${phaseLabel(phase)} · ${agent.name}`,
      detail: agent.currentSubtask ?? agent.currentPhase ?? agent.lastMessageSnippet,
      timestamp: startedAt,
      endedAt,
      durationMs: deriveDuration(startedAt, endedAt, activeAgentStatuses.has(agent.status) ? nowMs : undefined),
      cycleNumber: agentCycleNumber(workflow, agent),
      agentId: agent.id,
      agentName: agent.name,
      agentCategory: agent.category,
      paths: uniqueSorted(agent.changedFiles),
      sourceId: agent.id
    };
  });

  const phasesWithAgents = new Set(items
    .filter((item) => item.cycleNumber === currentCycleNumber(workflow))
    .map((item) => item.phase));
  for (const [stepId, progress] of Object.entries(workflow.stepProgress ?? {})) {
    const phase = phaseForStep(stepId as WorkflowStepId);
    const timestamp = progress.startedAt ?? progress.updatedAt ?? progress.lastEventAt ?? progress.completedAt;
    if (!phase || !timestamp || phasesWithAgents.has(phase)) {
      continue;
    }
    const endedAt = progress.status === "completed" ? progress.completedAt ?? progress.updatedAt : undefined;
    const status: WorkflowTimelineStatus = progress.status === "failed"
      ? "failed"
      : progress.status === "blocked"
        ? "blocked"
        : progress.status === "completed"
          ? "completed"
          : progress.status === "waiting" || progress.status === "not_started"
            ? "waiting"
            : "running";
    items.push({
      id: `phase:step:${currentCycleNumber(workflow)}:${stepId}`,
      kind: "phase",
      phase,
      status,
      title: `${phaseLabel(phase)} · Workflow`,
      detail: progress.currentSubstep ?? progress.currentActivity ?? progress.latestProgressNote ?? progress.message,
      timestamp: timestampOrEpoch(timestamp),
      endedAt,
      durationMs: deriveDuration(timestamp, endedAt, status === "running" ? nowMs : undefined),
      cycleNumber: currentCycleNumber(workflow),
      agentCategory: progress.agentCategory,
      paths: [],
      sourceId: stepId
    });
  }
  return items;
};

const activityTimelineItems = (workflow: ProjectWorkflowState, agents: readonly AgentState[]): WorkflowTimelineItem[] => {
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  return asArray(workflow.activityLog).map((event): WorkflowTimelineItem => {
    const linkedAgent = event.agentId ? agentsById.get(event.agentId) : undefined;
    return {
      id: `activity:${event.id}`,
      kind: "activity",
      phase: phaseForStep(event.stepId) ?? (linkedAgent ? phaseForAgent(workflow, linkedAgent) : "system"),
      status: statusForActivity(event.status),
      title: event.title,
      detail: event.detail,
      timestamp: timestampOrEpoch(event.timestamp),
      cycleNumber: activityCycleNumber(workflow, event, agentsById),
      agentId: event.agentId,
      agentName: linkedAgent?.name,
      agentCategory: event.agentCategory ?? linkedAgent?.category,
      paths: [],
      sourceId: event.id
    };
  });
};

const journalTimelineItems = (workflow: ProjectWorkflowState, agents: readonly AgentState[]): WorkflowTimelineItem[] => {
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const incidentsById = new Map(asArray(workflow.incidents).map((incident) => [incident.id, incident]));
  return asArray(workflow.journal).map((event): WorkflowTimelineItem => {
    const linkedAgent = event.agentId ? agentsById.get(event.agentId) : undefined;
    const incident = event.incidentId ? incidentsById.get(event.incidentId) : undefined;
    return {
      id: `journal:${event.id}`,
      kind: event.kind === "validation" ? "validation" : "activity",
      phase: phaseForStep(event.stepId) ?? (linkedAgent ? phaseForAgent(workflow, linkedAgent) : "system"),
      status: statusForActivity(event.status),
      title: event.title,
      detail: event.summary,
      timestamp: timestampOrEpoch(event.occurredAt),
      cycleNumber: event.cycleNumber,
      agentId: event.agentId,
      agentName: linkedAgent?.name,
      agentCategory: linkedAgent?.category,
      incidentId: event.incidentId,
      paths: uniqueSorted(incident?.involvedPaths ?? []),
      sourceId: event.id
    };
  });
};

const incidentTimelineItems = (workflow: ProjectWorkflowState, nowMs: number): WorkflowTimelineItem[] =>
  asArray(workflow.incidents).map((incident): WorkflowTimelineItem => {
    const isOpen = incident.status === "open" || incident.status === "resolving";
    const endedAt = isOpen ? undefined : incident.resolvedAt ?? incident.updatedAt;
    return {
      id: `incident:${incident.id}`,
      kind: "activity",
      phase: phaseForStep(incident.sourceStep) ?? "system",
      status: incident.status === "resolved"
        ? "completed"
        : incident.status === "superseded"
          ? "info"
          : incident.status === "resolving"
            ? "waiting"
            : "blocked",
      title: incident.title,
      detail: incident.rootCause || incident.summary,
      timestamp: timestampOrEpoch(incident.openedAt),
      endedAt,
      durationMs: deriveDuration(incident.openedAt, endedAt, isOpen ? nowMs : undefined),
      cycleNumber: incident.cycleNumber,
      incidentId: incident.id,
      paths: uniqueSorted(incident.involvedPaths),
      sourceId: incident.id
    };
  });

const timelineMirrorKey = (item: WorkflowTimelineItem): string =>
  [item.timestamp, item.title.trim(), item.agentId ?? ""].join("::");

const validationTimelineItems = (ledgers: readonly CollectedLedger[]): WorkflowTimelineItem[] => {
  const items: WorkflowTimelineItem[] = [];
  for (const { ledger, agentId } of ledgers) {
    for (const result of ledger.commandResults) {
      const phase: WorkflowDashboardPhase = result.phase === "coding"
        ? "coding"
        : result.phase === "merge"
          ? "merge"
          : result.phase === "manual"
            ? "system"
            : "integrity";
      const status: WorkflowTimelineStatus = result.status === "passed"
        ? "completed"
        : result.status === "skipped"
          ? "info"
          : "failed";
      items.push({
        id: `validation:${ledger.cycleNumber}:${ledger.createdAt}:${result.commandId}:${result.startedAt}`,
        kind: "validation",
        phase,
        status,
        title: result.command,
        detail: result.classifiedFailure?.summary || result.stderrSummary || result.stdoutSummary || undefined,
        timestamp: timestampOrEpoch(result.startedAt),
        endedAt: parseTime(result.endedAt) === undefined ? undefined : result.endedAt,
        durationMs: Number.isFinite(result.durationMs) && result.durationMs >= 0
          ? result.durationMs
          : deriveDuration(result.startedAt, result.endedAt),
        cycleNumber: ledger.cycleNumber,
        agentId,
        command: result.command,
        paths: uniqueSorted(result.relatedFiles),
        sourceId: result.commandId
      });
    }
  }
  return items;
};

const checklistTimelineItems = (workflow: ProjectWorkflowState): WorkflowTimelineItem[] => {
  const changes = asArray(workflow.checklistChanges).map((change): WorkflowTimelineItem => ({
    id: `checklist:change:${change.id}`,
    kind: "checklist",
    phase: "planning",
    status: change.action === "mark_blocked" ? "blocked" : "completed",
    title: change.title?.trim() || `Checklist ${change.action.replaceAll("_", " ")}`,
    detail: change.rationale,
    timestamp: timestampOrEpoch(change.createdAt),
    cycleNumber: change.sourceCycle,
    agentId: change.sourceAgent,
    paths: uniqueSorted(change.linkedChangedFiles),
    sourceId: change.id
  }));
  const deltas = asArray(workflow.checklistDeltas).map((delta): WorkflowTimelineItem => ({
    id: `checklist:delta:${delta.cycleNumber}:${delta.createdAt}`,
    kind: "checklist",
    phase: "integrity",
    status: delta.targetedNeedsAttention.length > 0 ? "blocked" : "completed",
    title: delta.targetedNewlyMet.length > 0
      ? `Checklist advanced by ${delta.targetedNewlyMet.length}`
      : "Checklist evaluated",
    detail: delta.summaryForHumans,
    timestamp: timestampOrEpoch(delta.createdAt),
    cycleNumber: delta.cycleNumber,
    paths: [],
    sourceId: `${delta.cycleNumber}:${delta.createdAt}`
  }));
  return [...changes, ...deltas];
};

export const sortWorkflowTimeline = (
  items: readonly WorkflowTimelineItem[],
  order: WorkflowTimelineSortOrder = "descending"
): WorkflowTimelineItem[] => [...items].sort((left, right) => {
  const leftTime = parseTime(left.timestamp) ?? 0;
  const rightTime = parseTime(right.timestamp) ?? 0;
  const timeComparison = order === "ascending" ? leftTime - rightTime : rightTime - leftTime;
  return timeComparison || kindOrder[left.kind] - kindOrder[right.kind] || compareText(left.id, right.id);
});

export const filterWorkflowTimeline = (
  items: readonly WorkflowTimelineItem[],
  filter: WorkflowTimelineFilter = {}
): WorkflowTimelineItem[] => {
  const cycles = filter.cycleNumbers ? new Set(filter.cycleNumbers) : undefined;
  const phases = filter.phases ? new Set(filter.phases) : undefined;
  const kinds = filter.kinds ? new Set(filter.kinds) : undefined;
  const statuses = filter.statuses ? new Set(filter.statuses) : undefined;
  const agentIds = filter.agentIds ? new Set(filter.agentIds) : undefined;
  const incidentIds = filter.incidentIds ? new Set(filter.incidentIds) : undefined;
  const query = filter.query?.trim().toLowerCase();
  const from = parseTime(filter.from);
  const to = parseTime(filter.to);
  return items.filter((item) => {
    const timestamp = parseTime(item.timestamp) ?? 0;
    if (cycles && (item.cycleNumber === undefined || !cycles.has(item.cycleNumber))) return false;
    if (phases && !phases.has(item.phase)) return false;
    if (kinds && !kinds.has(item.kind)) return false;
    if (statuses && !statuses.has(item.status)) return false;
    if (agentIds && (!item.agentId || !agentIds.has(item.agentId))) return false;
    if (incidentIds && (!item.incidentId || !incidentIds.has(item.incidentId))) return false;
    if (from !== undefined && timestamp < from) return false;
    if (to !== undefined && timestamp > to) return false;
    if (query) {
      const haystack = [
        item.title,
        item.detail,
        item.command,
        item.agentName,
        item.agentCategory,
        item.incidentId,
        ...item.paths
      ].filter((value): value is string => Boolean(value)).join("\n").toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
};

export const buildWorkflowTimelineItems = (
  workflow: ProjectWorkflowState,
  agents: readonly AgentState[] = [],
  now?: string | number | Date
): WorkflowTimelineItem[] => {
  const nowMs = resolveNow(now);
  const ledgers = collectLedgers(workflow, agents);
  const observations = collectCycleObservations(workflow, agents, ledgers);
  const journalItems = journalTimelineItems(workflow, agents);
  const journalMirrorKeys = new Set(journalItems.map(timelineMirrorKey));
  const legacyActivityItems = activityTimelineItems(workflow, agents)
    .filter((item) => !journalMirrorKeys.has(timelineMirrorKey(item)));
  return sortWorkflowTimeline([
    ...cycleTimelineItems(workflow, observations, nowMs),
    ...phaseTimelineItems(workflow, agents, nowMs),
    ...journalItems,
    ...incidentTimelineItems(workflow, nowMs),
    ...legacyActivityItems,
    ...validationTimelineItems(ledgers),
    ...checklistTimelineItems(workflow)
  ]);
};

export const buildWorkflowTimelinePage = (
  workflow: ProjectWorkflowState,
  agents: readonly AgentState[] = [],
  query: WorkflowTimelineQuery = {},
  now?: string | number | Date
): WorkflowTimelinePage => {
  const filtered = sortWorkflowTimeline(
    filterWorkflowTimeline(buildWorkflowTimelineItems(workflow, agents, now), query),
    query.sortOrder
  );
  const offset = Math.max(0, Math.floor(query.offset ?? 0));
  const limit = Math.max(0, Math.floor(query.limit ?? 200));
  const items = filtered.slice(offset, offset + limit);
  return {
    items,
    total: filtered.length,
    offset,
    limit,
    hasMore: offset + items.length < filtered.length
  };
};

const activeAgentForMission = (workflow: ProjectWorkflowState, agents: readonly AgentState[]): AgentState | undefined =>
  [...agents]
    .filter((agent) => activeAgentStatuses.has(agent.status))
    .sort((left, right) => {
      const canonicalAgentId = canonicalExecution(workflow)?.activeAgentId;
      const leftCanonical = canonicalAgentId === left.id ? 1 : 0;
      const rightCanonical = canonicalAgentId === right.id ? 1 : 0;
      const leftCurrent = agentCycleNumber(workflow, left) === currentCycleNumber(workflow) ? 1 : 0;
      const rightCurrent = agentCycleNumber(workflow, right) === currentCycleNumber(workflow) ? 1 : 0;
      const leftTime = parseTime(left.lastActivityAt ?? left.startedAt ?? left.createdAt) ?? 0;
      const rightTime = parseTime(right.lastActivityAt ?? right.startedAt ?? right.createdAt) ?? 0;
      return rightCanonical - leftCanonical || rightCurrent - leftCurrent || rightTime - leftTime || compareText(left.id, right.id);
    })[0];

const latestCurrentLedger = (workflow: ProjectWorkflowState, agents: readonly AgentState[]): ValidationLedger | undefined =>
  collectLedgers(workflow, agents)
    .filter(({ ledger }) => ledger.cycleNumber === currentCycleNumber(workflow))
    .sort((left, right) => {
      const leftTime = parseTime(left.ledger.updatedAt) ?? parseTime(left.ledger.createdAt) ?? 0;
      const rightTime = parseTime(right.ledger.updatedAt) ?? parseTime(right.ledger.createdAt) ?? 0;
      return rightTime - leftTime || compareText(ledgerIdentity(left.ledger), ledgerIdentity(right.ledger));
    })[0]?.ledger;

const cycleProgress = (workflow: ProjectWorkflowState, stage: WorkflowStage): number => {
  if (stage === "cycle_complete" || stage === "merged") {
    return 100;
  }
  const progressEntries = Object.values(workflow.stepProgress ?? {});
  if (progressEntries.length > 0) {
    const points = progressEntries.reduce((total, entry) => {
      if (entry.status === "completed") return total + 1;
      if (["starting", "running", "recovering", "blocked", "failed"].includes(entry.status)) return total + 0.5;
      return total;
    }, 0);
    return clampPercent((points / progressEntries.length) * 100);
  }
  const fallback: Record<WorkflowDashboardPhase, number> = {
    goal: 0,
    recommendation: 15,
    planning: 30,
    coding: 50,
    integrity: 75,
    repair: 65,
    merge: 90,
    complete: 100,
    system: 0
  };
  return fallback[phaseForStage(stage)];
};

const goalProgress = (workflow: ProjectWorkflowState): number | undefined => {
  if (Number.isFinite(workflow.ultimateGoalProgress?.percentComplete)) {
    return clampPercent(workflow.ultimateGoalProgress?.percentComplete ?? 0);
  }
  const required = asArray(workflow.goalChecklist).filter((check) => check.required && !check.mergedInto);
  if (required.length === 0) {
    return undefined;
  }
  return clampPercent((required.filter((check) => check.status === "met").length / required.length) * 100);
};

const defaultNextAction = (stage: WorkflowStage): string => {
  switch (stage) {
    case "charter_needed": return "Confirm the ultimate goal.";
    case "recommendation_pending": return "Generate and choose the next work package.";
    case "recommendation_approved": return "Turn the recommendation into an executable plan.";
    case "goal_ready": return "Start the coding pass.";
    case "coding_running": return "Validate the completed implementation.";
    case "integrity_running": return "Merge passing work or route failures into repair.";
    case "repair_loop": return "Re-run integrity after the repair checkpoint.";
    case "ready_to_merge": return "Integrate the validated changes.";
    case "merged": return "Assess goal progress and close the cycle.";
    case "appeal_pending": return "Decide whether the ultimate goal is satisfied.";
    case "blocked_human": return "Resolve the active request, then resume.";
    case "cycle_complete": return "Choose the next recommendation or finish the goal.";
  }
};

const defaultCurrentAction = (stage: WorkflowStage): string => {
  switch (stage) {
    case "charter_needed": return "Waiting for a confirmed goal.";
    case "recommendation_pending": return "Selecting the next highest-value task.";
    case "recommendation_approved": return "The next task is approved.";
    case "goal_ready": return "The cycle plan is ready to execute.";
    case "coding_running": return "Implementing the current plan.";
    case "integrity_running": return "Running validation and evidence checks.";
    case "repair_loop": return "Repairing the latest validation failure.";
    case "ready_to_merge": return "Validation passed; integration is ready.";
    case "merged": return "The validated work has been integrated.";
    case "appeal_pending": return "Reviewing whether the goal is complete.";
    case "blocked_human": return "Automation is waiting for user input.";
    case "cycle_complete": return "This workflow cycle is complete.";
  }
};

const collectNeedsUser = (workflow: ProjectWorkflowState, agents: readonly AgentState[]): string[] => {
  const needs: string[] = [];
  const interventions = asArray(workflow.humanInterventions)
    .filter((intervention) => intervention.status === "pending")
    .sort((left, right) => parseTime(left.createdAt)! - parseTime(right.createdAt)! || compareText(left.id, right.id));
  for (const intervention of interventions) {
    needs.push(intervention.title || intervention.reason);
  }
  for (const agent of [...agents].sort((left, right) => compareText(left.id, right.id))) {
    for (const approval of asArray(agent.approvals).filter((entry) => entry.status === "pending")) {
      needs.push(approval.summary || `Review approval for ${agent.name}`);
    }
  }
  if (workflow.manualHandoff?.title) {
    needs.push(workflow.manualHandoff.title);
  }
  for (const incident of asArray(workflow.incidents)) {
    if (
      (incident.status === "open" || incident.status === "resolving")
      && (incident.userActionRequired || incident.primaryAction?.kind === "approve" || incident.primaryAction?.kind === "provide_input")
    ) {
      needs.push(incident.userActionRequired?.trim() || incident.title);
    }
  }
  if (workflow.workflowStopReason === "awaiting_recommendation_approval") {
    needs.push("Choose or approve the next recommendation.");
  } else if (workflow.workflowStopReason === "awaiting_appeal_approval") {
    needs.push("Review the goal-completion assessment.");
  } else if (workflow.workflowStopReason === "charter_missing") {
    needs.push("Confirm the ultimate goal.");
  }
  return uniqueSorted(needs);
};

export const buildWorkflowMissionSummary = (
  workflow: ProjectWorkflowState,
  agents: readonly AgentState[] = []
): WorkflowMissionSummary => {
  const stage = inferStage(workflow);
  const execution = canonicalExecution(workflow);
  const activeAgent = activeAgentForMission(workflow, agents);
  const needsUser = collectNeedsUser(workflow, agents);
  const hasBlockingIntervention = asArray(workflow.humanInterventions)
    .some((intervention) => intervention.status === "pending" && intervention.blocking);
  const blockingStopReasons = new Set([
    "human_intervention_required",
    "integrity_failed",
    "repair_stopped_early",
    "repair_budget_exhausted",
    "merge_conflicts"
  ]);
  const isBlocked = (stage === "blocked_human" && execution?.tag !== "awaiting_approval")
    || execution?.tag === "awaiting_human"
    || execution?.tag === "paused"
    || hasBlockingIntervention
    || Boolean(workflow.manualHandoff)
    || blockingStopReasons.has(workflow.workflowStopReason);
  const isComplete = stage === "cycle_complete" || stage === "merged" || execution?.tag === "goal_complete";
  const status: WorkflowMissionSummary["status"] = isBlocked
    ? "blocked"
    : activeAgent
      ? "running"
      : isComplete
        ? "completed"
        : needsUser.length > 0 || stage === "charter_needed" || stage === "recommendation_approved" || stage === "goal_ready"
          ? "waiting"
          : workflow.workflowCycle?.status === "idle"
            ? "idle"
            : "running";
  const currentNumber = currentCycleNumber(workflow);
  const latestLedger = latestCurrentLedger(workflow, agents);
  const latestRetrospective = [...asArray(workflow.cycleRetrospectives)]
    .sort((left, right) => (parseTime(right.createdAt) ?? 0) - (parseTime(left.createdAt) ?? 0) || right.cycleNumber - left.cycleNumber)[0];
  const runtimeAutopilot = workflow.autopilotStatus;
  const activeIncident = execution?.incidentId
    ? asArray(workflow.incidents).find((incident) => incident.id === execution.incidentId)
    : asArray(workflow.incidents).find((incident) => incident.status === "open" || incident.status === "resolving");
  const latestCompletedJournal = [...asArray(workflow.journal)]
    .filter((event) => event.status === "completed")
    .sort((left, right) => (parseTime(right.occurredAt) ?? 0) - (parseTime(left.occurredAt) ?? 0) || right.sequence - left.sequence)[0];
  const autopilotEnabled = runtimeAutopilot?.enabled ?? workflow.autopilotPolicy?.enabled ?? false;
  const goal = workflow.goalCharter?.currentEffectiveGoal?.summary?.trim()
    || workflow.ultimateGoal?.summary?.trim()
    || "No ultimate goal has been confirmed.";
  const cycleTitle = workflow.cycleContract?.cycleNumber === currentNumber
    ? workflow.cycleContract.selectedTaskTitle
    : workflow.workflowCycle?.approvedRecommendationTitle
      ?? workflow.approvedRecommendation?.title
      ?? workflow.scopedGoal?.summary
      ?? (currentNumber > 0 ? `Cycle ${currentNumber}` : "No active cycle");
  return {
    goal,
    cycleNumber: currentNumber,
    cycleTitle,
    executionTag: execution?.tag,
    stage,
    stageLabel: executionLabel(execution?.tag) ?? stageLabel(stage),
    currentPhase: activeAgent ? phaseForAgent(workflow, activeAgent) : phaseForExecution(workflow) ?? phaseForStage(stage),
    status,
    goalProgressPercent: goalProgress(workflow),
    cycleProgressPercent: cycleProgress(workflow, stage),
    now: activeAgent?.currentSubtask ?? activeAgent?.currentPhase ?? runtimeAutopilot?.lastCompletedAction ?? defaultCurrentAction(stage),
    next: activeIncident?.nextSystemAction ?? activeIncident?.userActionRequired ?? runtimeAutopilot?.nextPlannedAction ?? defaultNextAction(stage),
    needsUser,
    activeAgent: activeAgent ? {
      id: activeAgent.id,
      name: activeAgent.name,
      category: activeAgent.category,
      model: activeAgent.model,
      status: activeAgent.status,
      currentActivity: activeAgent.currentSubtask ?? activeAgent.currentPhase
    } : undefined,
    autopilot: {
      enabled: autopilotEnabled,
      paused: Boolean(runtimeAutopilot?.pausedReason) || (autopilotEnabled && isBlocked),
      detail: runtimeAutopilot?.pausedDetail ?? runtimeAutopilot?.pausedReason
    },
    validationStatus: latestLedger?.finalValidationStatus,
    lastOutcome: latestRetrospective?.goalChecklistChangeRecommendation
      || latestLedger?.summaryForHumans
      || latestCompletedJournal?.summary
      || latestCompletedJournal?.title
      || undefined
  };
};

const emptyTokens = (): WorkflowTokenTotals => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0
});

const numberField = (record: Record<string, unknown>, ...keys: string[]): number => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return 0;
};

const tokenTotalsFromUnknown = (value: unknown): WorkflowTokenTotals | undefined => {
  if (typeof value === "string") {
    const match = /([\d,]+)\s*(?:total\s*)?tokens?/i.exec(value);
    if (!match) return undefined;
    const totalTokens = Number(match[1].replaceAll(",", ""));
    return Number.isFinite(totalTokens) ? { ...emptyTokens(), totalTokens } : undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  if (record.tokenUsage !== undefined) {
    const nested = tokenTotalsFromUnknown(record.tokenUsage);
    if (nested) return nested;
  }
  const totalRecord = asRecord(record.total);
  if (totalRecord) {
    const nested = tokenTotalsFromUnknown(totalRecord);
    if (nested) return nested;
  }
  const inputTokens = numberField(record, "inputTokens", "input_tokens");
  const cachedInputTokens = numberField(record, "cachedInputTokens", "cached_input_tokens");
  const outputTokens = numberField(record, "outputTokens", "output_tokens");
  const reasoningOutputTokens = numberField(record, "reasoningOutputTokens", "reasoning_output_tokens");
  const explicitTotal = numberField(record, "totalTokens", "total_tokens");
  const totalTokens = explicitTotal || inputTokens + outputTokens;
  if (totalTokens === 0 && cachedInputTokens === 0 && reasoningOutputTokens === 0) {
    return undefined;
  }
  return { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens };
};

const tokenTotalsForAgent = (agent: AgentState): WorkflowTokenTotals | undefined => {
  const direct = tokenTotalsFromUnknown(agent.tokenUsage);
  if (direct) {
    return direct;
  }
  const candidates = agent.events
    .map((event) => ({
      timestamp: parseTime(event.timestamp) ?? 0,
      tokens: tokenTotalsFromUnknown(event.raw) ?? tokenTotalsFromUnknown(event.detail)
    }))
    .filter((candidate): candidate is { timestamp: number; tokens: WorkflowTokenTotals } => candidate.tokens !== undefined)
    .sort((left, right) => right.timestamp - left.timestamp || right.tokens.totalTokens - left.tokens.totalTokens);
  return candidates[0]?.tokens;
};

const addTokens = (target: WorkflowTokenTotals, source?: WorkflowTokenTotals): void => {
  if (!source) return;
  target.inputTokens += source.inputTokens;
  target.cachedInputTokens += source.cachedInputTokens;
  target.outputTokens += source.outputTokens;
  target.reasoningOutputTokens += source.reasoningOutputTokens;
  target.totalTokens += source.totalTokens;
};

const normalizedCommand = (command: string): string => command.trim().replace(/\s+/g, " ");
const normalizedPath = (path: string): string => path.trim().replaceAll("\\", "/").replace(/^\.\//, "");

const buildWorkMetrics = (workflow: ProjectWorkflowState, agents: readonly AgentState[], ledgers: readonly CollectedLedger[]): WorkflowDashboardMetrics["work"] => {
  const executions = new Map<string, string>();
  const cyclesWithExecution = new Set<number>();
  for (const agent of agents) {
    const cycle = agentCycleNumber(workflow, agent);
    for (const command of asArray(agent.commandLog)) {
      const normalized = normalizedCommand(command.command);
      if (!normalized) continue;
      const key = `${cycle}:${normalized}:${command.startedAt}`;
      executions.set(key, normalized);
      cyclesWithExecution.add(cycle);
    }
  }
  for (const { ledger } of ledgers) {
    for (const result of ledger.commandResults) {
      const normalized = normalizedCommand(result.command);
      if (!normalized) continue;
      const key = `${ledger.cycleNumber}:${normalized}:${result.startedAt}`;
      executions.set(key, normalized);
      cyclesWithExecution.add(ledger.cycleNumber);
    }
  }
  for (const retrospective of asArray(workflow.cycleRetrospectives)) {
    if (cyclesWithExecution.has(retrospective.cycleNumber)) continue;
    retrospective.commandsRun.forEach((command, index) => {
      const normalized = normalizedCommand(command);
      if (normalized) executions.set(`${retrospective.cycleNumber}:retrospective:${index}:${normalized}`, normalized);
    });
  }

  const fileReferences = new Set<string>();
  const files = new Set<string>();
  const addFile = (cycle: number, value: string): void => {
    const path = normalizedPath(value);
    if (!path) return;
    files.add(path);
    fileReferences.add(`${cycle}:${path}`);
  };
  for (const agent of agents) {
    agent.changedFiles.forEach((path) => addFile(agentCycleNumber(workflow, agent), path));
  }
  for (const { ledger } of ledgers) {
    ledger.commandResults.flatMap((result) => result.relatedFiles).forEach((path) => addFile(ledger.cycleNumber, path));
  }
  for (const retrospective of asArray(workflow.cycleRetrospectives)) {
    retrospective.changedFiles.forEach((path) => addFile(retrospective.cycleNumber, path));
  }
  for (const change of asArray(workflow.checklistChanges)) {
    change.linkedChangedFiles.forEach((path) => addFile(change.sourceCycle, path));
  }

  const touched = new Set<string>();
  for (const change of asArray(workflow.checklistChanges)) {
    change.checklistItemIds.forEach((id) => touched.add(id));
  }
  const advanced = new Set<string>();
  let goalProgressPoints = 0;
  for (const delta of asArray(workflow.checklistDeltas)) {
    delta.targetedNewlyMet.forEach((id) => advanced.add(`${delta.cycleNumber}:${id}`));
    goalProgressPoints += Math.max(0, delta.goalProgressAfter - delta.goalProgressBefore);
  }
  const commands = uniqueSorted([...executions.values()]);
  return {
    commandExecutions: executions.size,
    uniqueCommands: commands.length,
    commands,
    fileReferences: fileReferences.size,
    uniqueFiles: files.size,
    files: [...files].sort(compareText),
    checklistChangeRecords: asArray(workflow.checklistChanges).length,
    checklistItemsTouched: touched.size,
    checklistItemsAdvanced: advanced.size,
    goalProgressPoints
  };
};

const ledgerHasRun = (ledger: ValidationLedger): boolean =>
  ledger.finalValidationStatus !== "not_run" || ledger.commandResults.length > 0 || ledger.attemptedCommands.length > 0;

const ledgerHasRepairSignal = (ledger: ValidationLedger): boolean =>
  ledger.repairedFailures.length > 0 || ledger.commandResults.some((result) => Boolean(result.classifiedFailure?.repairedByCommandId));

const buildValidationMetrics = (
  workflow: ProjectWorkflowState,
  agents: readonly AgentState[],
  ledgers: readonly CollectedLedger[]
): WorkflowDashboardMetrics["validation"] => {
  const byCycle = new Map<number, ValidationLedger[]>();
  for (const { ledger } of ledgers) {
    if (!ledgerHasRun(ledger)) continue;
    const entries = byCycle.get(ledger.cycleNumber) ?? [];
    entries.push(ledger);
    byCycle.set(ledger.cycleNumber, entries);
  }
  let firstPassPassed = 0;
  for (const cycleLedgers of byCycle.values()) {
    cycleLedgers.sort((left, right) => {
      const leftTime = parseTime(left.createdAt) ?? parseTime(left.updatedAt) ?? 0;
      const rightTime = parseTime(right.createdAt) ?? parseTime(right.updatedAt) ?? 0;
      return leftTime - rightTime || compareText(ledgerIdentity(left), ledgerIdentity(right));
    });
    const first = cycleLedgers[0];
    const firstHadFailure = first.commandResults.some((result) => !["passed", "skipped"].includes(result.status));
    if (first.finalValidationStatus === "passed" && !firstHadFailure && !ledgerHasRepairSignal(first)) {
      firstPassPassed += 1;
    }
  }
  const repairCycles = new Set<number>();
  for (const [cycle, cycleLedgers] of byCycle) {
    const first = cycleLedgers[0];
    if (cycleLedgers.length > 1 && first.finalValidationStatus !== "passed" || cycleLedgers.some(ledgerHasRepairSignal)) {
      repairCycles.add(cycle);
    }
  }
  for (const agent of agents) {
    if (isRepairAgent(workflow, agent)) repairCycles.add(agentCycleNumber(workflow, agent));
  }
  if ((workflow.repair?.attemptCount ?? 0) > 0 || (workflow.repairLoopCount ?? 0) > 0 || canonicalExecution(workflow)?.tag === "repairing") {
    repairCycles.add(currentCycleNumber(workflow));
  }
  const repairCyclesSucceeded = [...repairCycles].filter((cycle) => {
    const latest = byCycle.get(cycle)?.at(-1);
    return latest?.finalValidationStatus === "passed"
      || latest?.mergeAllowed === true
      || (cycle === currentCycleNumber(workflow) && workflow.repair?.status === "fixed");
  }).length;
  const repairCyclesAttempted = repairCycles.size;
  return {
    cyclesValidated: byCycle.size,
    firstPassPassed,
    firstPassRatePercent: byCycle.size > 0 ? (firstPassPassed / byCycle.size) * 100 : undefined,
    repairCyclesAttempted,
    repairCyclesSucceeded,
    repairSuccessRatePercent: repairCyclesAttempted > 0 ? (repairCyclesSucceeded / repairCyclesAttempted) * 100 : undefined
  };
};

const buildAgentMetrics = (workflow: ProjectWorkflowState, agents: readonly AgentState[]): WorkflowDashboardMetrics["agents"] => {
  const tokens = emptyTokens();
  let agentsWithTokenUsage = 0;
  const modelMap = new Map<string, WorkflowModelMetric>();
  const categoryMap = new Map<AgentCategory, WorkflowAgentCategoryMetric>();
  for (const agent of agents) {
    const agentTokens = tokenTotalsForAgent(agent);
    if (agentTokens) {
      agentsWithTokenUsage += 1;
      addTokens(tokens, agentTokens);
    }
    const model = agent.model.trim() || "unknown";
    const modelMetric = modelMap.get(model) ?? {
      model,
      agentCount: 0,
      completed: 0,
      failed: 0,
      tokens: emptyTokens()
    };
    modelMetric.agentCount += 1;
    modelMetric.completed += agent.status === "completed" ? 1 : 0;
    modelMetric.failed += failedAgentStatuses.has(agent.status) ? 1 : 0;
    addTokens(modelMetric.tokens, agentTokens);
    modelMap.set(model, modelMetric);

    const categoryMetric = categoryMap.get(agent.category) ?? {
      category: agent.category,
      agentCount: 0,
      active: 0,
      completed: 0,
      failed: 0
    };
    categoryMetric.agentCount += 1;
    categoryMetric.active += activeAgentStatuses.has(agent.status) ? 1 : 0;
    categoryMetric.completed += agent.status === "completed" ? 1 : 0;
    categoryMetric.failed += failedAgentStatuses.has(agent.status) ? 1 : 0;
    categoryMap.set(agent.category, categoryMetric);
  }
  const storedTotals = workflow.metrics;
  if (storedTotals && storedTotals.totalTokens >= tokens.totalTokens) {
    tokens.inputTokens = storedTotals.totalInputTokens;
    tokens.cachedInputTokens = storedTotals.totalCachedInputTokens;
    tokens.outputTokens = storedTotals.totalOutputTokens;
    tokens.reasoningOutputTokens = storedTotals.totalReasoningTokens;
    tokens.totalTokens = storedTotals.totalTokens;
  }
  return {
    total: agents.length,
    active: agents.filter((agent) => activeAgentStatuses.has(agent.status)).length,
    completed: agents.filter((agent) => agent.status === "completed").length,
    failed: agents.filter((agent) => failedAgentStatuses.has(agent.status)).length,
    agentsWithTokenUsage,
    tokens,
    byCategory: [...categoryMap.values()].sort((left, right) => categoryOrder.indexOf(left.category) - categoryOrder.indexOf(right.category)),
    models: [...modelMap.values()].sort((left, right) => compareText(left.model, right.model))
  };
};

export const buildWorkflowMetrics = (
  workflow: ProjectWorkflowState,
  agents: readonly AgentState[] = [],
  now?: string | number | Date
): WorkflowDashboardMetrics => {
  const nowMs = resolveNow(now);
  const ledgers = collectLedgers(workflow, agents);
  const observations = collectCycleObservations(workflow, agents, ledgers);
  const timeline = [
    ...cycleTimelineItems(workflow, observations, nowMs),
    ...phaseTimelineItems(workflow, agents, nowMs)
  ];
  const cycleItems = timeline.filter((item) => item.kind === "cycle");
  const phaseItems = timeline.filter((item) => item.kind === "phase");
  const phases = phaseOrder.map((phase): WorkflowPhaseMetric => {
    const runs = phaseItems.filter((item) => item.phase === phase);
    return {
      phase,
      runs: runs.length,
      active: runs.filter((item) => item.status === "running" || item.status === "waiting").length,
      completed: runs.filter((item) => item.status === "completed").length,
      failed: runs.filter((item) => item.status === "failed" || item.status === "blocked").length,
      duration: summarizeDurations(runs.map((item) => item.durationMs))
    };
  }).filter((metric) => metric.runs > 0);
  return {
    cycles: {
      observed: cycleItems.length,
      completed: cycleItems.filter((item) => item.status === "completed").length,
      failed: cycleItems.filter((item) => item.status === "failed" || item.status === "blocked").length,
      activeCycleNumber: cycleItems.some((item) => item.cycleNumber === currentCycleNumber(workflow) && ["running", "waiting", "pending"].includes(item.status))
        ? currentCycleNumber(workflow)
        : undefined,
      duration: summarizeDurations(cycleItems.map((item) => item.durationMs))
    },
    phases,
    validation: buildValidationMetrics(workflow, agents, ledgers),
    work: buildWorkMetrics(workflow, agents, ledgers),
    agents: buildAgentMetrics(workflow, agents)
  };
};

export const buildWorkflowDashboard = (
  workflow: ProjectWorkflowState,
  agents: readonly AgentState[] = [],
  options: WorkflowDashboardOptions = {}
): WorkflowDashboardSnapshot => {
  const nowMs = resolveNow(options.now);
  return {
    generatedAt: new Date(nowMs).toISOString(),
    mission: buildWorkflowMissionSummary(workflow, agents),
    timeline: buildWorkflowTimelinePage(workflow, agents, options.timeline, nowMs),
    metrics: buildWorkflowMetrics(workflow, agents, nowMs)
  };
};
