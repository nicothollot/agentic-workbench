import { startTransition, useDeferredValue, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { APP_NAME, PROJECT_SHELL_LAUNCHER_CMD_PATH, PROJECT_SHELL_LAUNCH_LOG_PATH } from "@shared/constants";
import {
  DEFAULT_AGENT_REASONING_EFFORTS,
  DEFAULT_AGENT_REASONING_MODE,
  INTERFACE_REASONING_EFFORTS,
  resolveAgentReasoningEffort,
  resolveInterfaceCreationReasoningEffort
} from "@shared/modelConfig";
import { buildRepairReportMarkdown, collectRepairAttemptReports } from "@shared/workflowRepairReport";
import {
  buildWorkflowGoalView,
  buildWorkflowTimelineSteps,
  getWorkflowRecoveryCandidate,
  getWorkflowRepairCounterView,
  workflowActionGuide,
  workflowRunStateLabel,
  workflowSectionProminence,
  workflowStageGuidance,
  workflowStageLabel,
  workflowStatusSummary
} from "@shared/workflowView";
import type {
  AgentCategory,
  AgentListResponse,
  AgentReasoningEfforts,
  AgentReasoningMode,
  AgentState,
  ApprovalRequestRecord,
  CredentialEntryMetadata,
  DiscoveredModel,
  ExecutionMode,
  FileSummary,
  GitHubStatus,
  HumanInterventionRecord,
  InterfaceReasoningEffort,
  InterfaceCandidate,
  LoadedProjectView,
  ProjectLoadResult,
  ProjectLogFeedResponse,
  ProjectWorkflowState,
  RuntimeEventRecord,
  SummarySource,
  UserInputRequestQuestion,
  UserInputRequestRecord,
  UltimateGoalImportPreview,
  UltimateGoalProgressEstimate,
  UltimateGoal,
  ValidationStatus,
  WorkflowActivityEvent,
  WorkspaceCenterTab,
  WorkflowRecommendationOption,
  WorkbenchState
} from "@shared/types";

type NoticeState = {
  message: string;
  tone: "info" | "error";
};

type AgentPageView = Pick<AgentListResponse, "agents" | "total" | "offset" | "limit"> & {
  loading: boolean;
};

type LogFeedView = ProjectLogFeedResponse & {
  loading: boolean;
};

type WorkflowPrimaryActionView = ReturnType<typeof workflowActionGuide> | {
  kind: "resume_workflow";
  title: string;
  description: string;
  actionLabel: string;
} | {
  kind: "recover_workflow";
  title: string;
  description: string;
  actionLabel: string;
};

const interfaceIconUrl = new URL("../../assets/branding/interface_icon.png", import.meta.url).href;
const WORKFLOW_AGENT_STALE_MS = 10 * 60 * 1000;
const AGENT_HISTORY_PAGE_SIZE = 20;
const LOG_ACTIVITY_PAGE_SIZE = 80;
const LOG_COMMAND_PAGE_SIZE = 50;

const buildUltimateGoalFormatGuide = (projectName: string): string => [
  "Ultimate Goal authoring format for Codex Agent Workbench",
  "",
  "Use this prompt with ChatGPT or another LLM when you want it to draft an Ultimate Goal that this workbench can turn into a reliable checklist and workflow cycle.",
  "",
  "Prompt to give the LLM:",
  "",
  `You are drafting an Ultimate Goal for the project named "${projectName}". The result will be imported into Codex Agent Workbench, which will infer a goal checklist and then run repeated recommendation, scoped planning, coding, integrity validation, and merge cycles against the repository.`,
  "",
  "Write the goal so each success criterion can become an observable checklist item. Keep criteria outcome-focused and merge near-duplicates instead of splitting tiny implementation details apart. Be concrete about user-visible behavior, acceptance conditions, quality expectations, constraints, and what is out of scope. Avoid secrets, credentials, machine-specific paths, or private environment details.",
  "",
  "Return plain text only. Do not wrap the result in Markdown fences. Use exactly these section headings:",
  "",
  "Project Charter: [one sentence describing the durable end state]",
  "",
  "Detailed Intent:",
  "[2-5 sentences explaining the best finished outcome, why it matters, who it should impress, and how the agent should prioritize tradeoffs]",
  "",
  "Success Criteria:",
  "- [observable outcome the workflow can validate]",
  "- [observable outcome the workflow can validate]",
  "- [observable outcome the workflow can validate]",
  "",
  "Constraints:",
  "- [technical, security, platform, compatibility, or process rule the agents must preserve]",
  "- [technical, security, platform, compatibility, or process rule the agents must preserve]",
  "",
  "Non-goals:",
  "- [explicitly out-of-scope work so the workflow does not chase it]",
  "- [explicitly out-of-scope work so the workflow does not chase it]",
  "",
  "Quality Bar:",
  "[the standard for an excellent outcome: tests, UX polish, performance, reliability, accessibility, packaging expectations, or review expectations]",
  "",
  "Target Audience:",
  "[who will use or evaluate the finished project]",
  "",
  "Checklist inference guidance:",
  "- Describe outcomes, not just implementation chores; the workflow will choose bounded implementation slices from those outcomes.",
  "- Make every success criterion testable or inspectable.",
  "- Include enough detail for a scoped coding agent to choose the next bounded task without asking for basic intent.",
  "- Put hard rules in Constraints, not in Success Criteria.",
  "- Put excluded work in Non-goals, especially packaging, deployment, account setup, or optional polish that should not happen automatically.",
  "- Mention required validation commands or manual review expectations in Quality Bar when they matter.",
  ""
].join("\n");

const validationClass = (status: ValidationStatus): string =>
  ({
    exact: "badge-exact",
    stale: "badge-stale",
    incompatible: "badge-incompatible",
    unvalidated: "badge-unvalidated"
  })[status];

const sourceLabel = (source: SummarySource): string =>
  ({
    deterministic: "Deterministic scan",
    codex: "Agent analysis",
    hybrid: "Scan + agent",
    mock: "Mock analysis"
  })[source];

const ultimateGoalFieldLabel = (field: UltimateGoalImportPreview["missingFields"][number]): string =>
  ({
    summary: "Project charter",
    detailedIntent: "Detailed intent",
    successCriteria: "Success criteria",
    constraints: "Constraints",
    nonGoals: "Non-goals",
    qualityBar: "Quality bar",
    targetAudience: "Target audience"
  })[field];

const availabilityMessage = (state: WorkbenchState): string => {
  const availability = state.codexAvailability;
  if (!availability) {
    return "Codex availability is still initializing.";
  }

  if (availability.source === "live") {
    if (availability.installedCodexVersion && availability.generatedProtocolVersion) {
      return `Codex model discovery is available. CLI ${availability.installedCodexVersion}, app-server protocol ${availability.generatedProtocolVersion}.`;
    }
    return "Codex model discovery is available.";
  }

  if (availability.source === "mock") {
    return "Mock mode is active. Analysis results are synthetic.";
  }

  return `Codex model access is unavailable. ${availability.message ?? ""}`.trim();
};

const formatDateTime = (value?: string): string => {
  if (!value) {
    return "Not yet";
  }

  try {
    return new Date(value).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short"
    });
  } catch {
    return value;
  }
};

const formatClockTime = (value?: string): string => {
  if (!value) {
    return "Not yet";
  }

  try {
    return new Date(value).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit"
    });
  } catch {
    return value;
  }
};

const formatElapsedDuration = (startedAt?: string, completedAt?: string, nowTime = Date.now()): string | null => {
  if (!startedAt) {
    return null;
  }

  const startedTime = new Date(startedAt).getTime();
  if (Number.isNaN(startedTime)) {
    return null;
  }

  const endTime = completedAt ? new Date(completedAt).getTime() : nowTime;
  if (Number.isNaN(endTime) || endTime < startedTime) {
    return null;
  }

  const totalSeconds = Math.max(0, Math.round((endTime - startedTime) / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return `${minutes}m ${seconds}s`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
};

const sanitizeReportName = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "project";

const formatBytes = (value: number): string => {
  if (!value) {
    return "0 KB";
  }

  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  return `${Math.max(1, Math.round(value / 1024))} KB`;
};

const getUserInputQuestionSelectValue = (question: UserInputRequestQuestion, answer: string): string => {
  if (!question.options.length) {
    return "";
  }
  if (question.options.some((option) => option.label === answer)) {
    return answer;
  }
  return "";
};

const reasoningEffortLabel = (value: InterfaceReasoningEffort): string =>
  ({
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra high"
  })[value];

const reasoningEffortDescription = (value: InterfaceReasoningEffort): string =>
  ({
    low: "Fast coordination for simple deterministic work.",
    medium: "Balanced planning and repository review.",
    high: "Careful analysis for complex tasks and implementation.",
    xhigh: "Deepest analysis for coding and high-risk changes."
  })[value];

const configurableAgentCategories: AgentCategory[] = [
  "bootstrap",
  "goal",
  "coding",
  "integrity",
  "merge",
  "recommendation",
  "manual"
];

const normalizeAgentReasoningEfforts = (efforts?: AgentReasoningEfforts): Record<AgentCategory, InterfaceReasoningEffort> => ({
  ...DEFAULT_AGENT_REASONING_EFFORTS,
  ...(efforts ?? {})
});

const normalizeReasoningMode = (mode?: AgentReasoningMode): AgentReasoningMode => mode ?? DEFAULT_AGENT_REASONING_MODE;

const exclusionRuleLabel = (rule: "default" | "gitignore"): string =>
  rule === "default" ? "Built-in default exclusion" : ".gitignore exclusion";

const getTopFileTypes = (breakdown?: Record<string, number>): Array<[string, number]> =>
  Object.entries(breakdown ?? {})
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 6);

const getExcludedPathEntries = (
  entries?: Array<{
    path: string;
    kind: "file" | "directory";
    rule: "default" | "gitignore";
    fileCount: number;
    totalSizeBytes: number;
  }>
) => entries ?? [];

const candidateRank = (candidate: InterfaceCandidate): number => {
  const statusScore =
    candidate.validationStatus === "exact"
      ? 0
      : candidate.validationStatus === "stale"
        ? 1
        : candidate.validationStatus === "unvalidated"
          ? 2
          : 3;
  const sourceScore = candidate.source === "local" ? 0 : 1;
  return sourceScore * 10 + statusScore;
};

const toTime = (value?: string): number => {
  if (!value) {
    return 0;
  }

  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
};

const agentCategoryLabel = (category: AgentCategory): string =>
  ({
    bootstrap: "Bootstrap",
    goal: "Goal / planning",
    coding: "Coding",
    integrity: "Integrity",
    merge: "Merge",
    recommendation: "Recommendation",
    manual: "Manual"
  })[category];

const buildManualAgentName = (prompt: string): string => {
  const firstLine = prompt.trim().split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ") ?? "Manual request";
  const summary = firstLine.length > 52 ? `${firstLine.slice(0, 49)}...` : firstLine;
  return `Manual Agent: ${summary}`;
};

const workflowStopReasonLabel = (reason?: string): string =>
  ({
    none: "No blocker",
    charter_missing: "Ultimate Goal needs confirmation",
    recommendation_missing: "Run recommendations for the next cycle",
    awaiting_recommendation_approval: "Approve one recommended next step",
    goal_not_scoped: "Turn the approved recommendation into a scoped goal",
    human_intervention_required: "A blocking human intervention is pending",
    integrity_failed: "Integrity validation found follow-up work",
    repair_stopped_early: "Automatic repair stopped early",
    repair_budget_exhausted: "Automatic repair limit reached",
    merge_conflicts: "Merge conflicts require follow-up",
    appeal_missing: "Prepare final appeal pass",
    awaiting_appeal_approval: "Approve one appeal improvement",
    ultimate_goal_satisfied: "Ultimate Goal satisfied",
    cycle_completed: "Cycle complete"
  })[reason ?? "none"] ?? reason ?? "No blocker";

const isEnvironmentRepairHandoff = (workflow?: ProjectWorkflowState | null): boolean =>
  workflow?.manualHandoff?.reason === "repair_stopped_early" &&
  workflow.manualHandoff.latestFailureReason.startsWith("Integrity hit an environment or dependency blocker");

const isMergeConflictHandoff = (workflow?: ProjectWorkflowState | null): boolean =>
  workflow?.manualHandoff?.reason === "merge_conflicts" || workflow?.repair.status === "merge_conflicts";

const manualHandoffBadgeLabel = (workflow: ProjectWorkflowState): string =>
  isMergeConflictHandoff(workflow)
    ? "Merge conflicts"
    : workflow.manualHandoff?.reason === "repair_stopped_early"
      ? "Repair stopped"
      : "Repair exhausted";

const manualHandoffRetryLabel = (workflow: ProjectWorkflowState): string =>
  isMergeConflictHandoff(workflow)
    ? "Retry merge"
    : isEnvironmentRepairHandoff(workflow)
      ? "Retry validation"
      : "Retry current goal";

const goalSourceLabel = (goal: Pick<UltimateGoal, "source" | "confirmedAt">): string =>
  goal.confirmedAt ? "User confirmed" : goal.source === "detected" ? "Agent detected draft" : "User draft";

const ultimateGoalProgressSourceLabel = (source: UltimateGoalProgressEstimate["source"]): string =>
  source === "recommendation" ? "Estimated by recommendation agent" : "Estimated from goal checks";

const workflowObjectiveLabel = (objective: LoadedProjectView["record"]["localState"]["workflowObjective"]): string =>
  objective === "optimize" ? "Optimize project" : "Deliver goal";

const ultimateGoalCompletionStateLabel = (
  state: NonNullable<ProjectWorkflowState["ultimateGoalCompletion"]>["state"]
): string => state === "goal_satisfied" ? "Goal satisfied" : "More work needed";

const goalCheckStatusLabel = (status: ProjectWorkflowState["goalChecklist"][number]["status"]): string => {
  switch (status) {
    case "met":
      return "Met";
    case "unmet":
      return "Unmet";
    case "not_applicable":
      return "N/A";
    case "unknown":
    default:
      return "Unknown";
  }
};

const goalCheckSourceLabel = (source: ProjectWorkflowState["goalChecklist"][number]["source"]): string =>
  ({
    success_criterion: "Success criterion",
    quality_bar: "Quality bar",
    constraint: "Constraint",
    agent: "Agent",
    deterministic: "Deterministic"
  })[source];

const toLineList = (value: string): string[] =>
  value
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const fromLineList = (entries: string[] | undefined): string => (entries ?? []).join("\n");

const interventionSeverityClass = (severity: HumanInterventionRecord["severity"]): string => `badge-severity-${severity}`;

const sortAgentsByActivity = (agents: AgentState[]): AgentState[] =>
  [...agents].sort((left, right) => {
    const timeDelta = toTime(right.lastActivityAt) - toTime(left.lastActivityAt);
    return timeDelta !== 0 ? timeDelta : left.name.localeCompare(right.name);
  });

const sortApprovalsByAge = (approvals: ApprovalRequestRecord[]): ApprovalRequestRecord[] =>
  [...approvals].sort((left, right) => toTime(right.createdAt) - toTime(left.createdAt));

const sortEventsByAge = (events: RuntimeEventRecord[]): RuntimeEventRecord[] =>
  [...events].sort((left, right) => toTime(right.timestamp) - toTime(left.timestamp));

const isWorkflowAgentActive = (agent: AgentState): boolean =>
  agent.status === "starting" || agent.status === "running" || agent.status === "waiting_approval";

const workflowActivitySourceLabel = (source: WorkflowActivityEvent["source"]): string =>
  ({
    workflow: "Workflow",
    agent: "Agent",
    validation: "Validation",
    approval: "Approval",
    system: "System"
  })[source];

const workflowEventStatusLabel = (status?: RuntimeEventRecord["status"]): string =>
  ({
    info: "Info",
    running: "Running",
    waiting: "Waiting",
    completed: "Completed",
    failed: "Failed"
  })[status ?? "info"];

const recommendationRiskLabel = (riskLevel: WorkflowRecommendationOption["riskLevel"]): string =>
  ({
    low: "Low risk",
    medium: "Medium risk",
    high: "High risk"
  })[riskLevel];

const recommendationPriorityLabel = (priority: WorkflowRecommendationOption["priority"]): string =>
  ({
    high: "High priority",
    medium: "Medium priority",
    low: "Lower priority"
  })[priority];

const latestMeaningfulAgentDetail = (agent: AgentState): string | undefined =>
  sortEventsByAge(agent.events).find((event) => event.detail?.trim().length)?.detail;

const agentPreviewText = (agent: AgentState, workflow?: ProjectWorkflowState): string => {
  if (agent.category === "recommendation" && agent.recommendationReport?.summary) {
    return agent.recommendationReport.summary;
  }
  if (agent.category === "goal" && workflow?.scopedGoal && agent.workflowCycleNumber === workflow.workflowCycle.cycleNumber) {
    return workflow.scopedGoal.summary;
  }
  if (agent.category === "integrity" && agent.integrityReport?.summary) {
    return agent.integrityReport.summary;
  }
  if (agent.category === "merge" && agent.mergeReport?.summary) {
    return agent.mergeReport.summary;
  }

  return agent.currentSubtask ?? agent.currentPhase ?? latestMeaningfulAgentDetail(agent) ?? agent.lastMessageSnippet ?? "No live detail yet.";
};

const agentDetailedExplanation = (agent: AgentState, workflow?: ProjectWorkflowState): string => {
  if (agent.category === "recommendation" && agent.recommendationReport) {
    const topTitles = agent.recommendationReport.nextSteps.slice(0, 3).map((step) => step.title).join("; ");
    return topTitles
      ? `${agent.recommendationReport.summary}\n\nCurrent top recommendations: ${topTitles}.`
      : agent.recommendationReport.summary;
  }

  if (agent.category === "goal" && workflow?.scopedGoal && agent.workflowCycleNumber === workflow.workflowCycle.cycleNumber) {
    const acceptance = workflow.scopedGoal.acceptanceCriteria.length
      ? `Acceptance criteria: ${workflow.scopedGoal.acceptanceCriteria.join("; ")}.`
      : "";
    return [workflow.scopedGoal.executionBrief, acceptance].filter(Boolean).join("\n\n");
  }

  if (agent.category === "integrity" && agent.integrityReport) {
    const risks = agent.integrityReport.risks.length
      ? `Open risks: ${agent.integrityReport.risks.join("; ")}.`
      : "No additional risks were reported.";
    return `${agent.integrityReport.summary}\n\n${risks}`;
  }

  if (agent.category === "merge" && agent.mergeReport) {
    const conflicts = agent.mergeReport.conflicts.length
      ? `Conflicts: ${agent.mergeReport.conflicts.join("; ")}.`
      : "No merge conflicts were reported.";
    return `${agent.mergeReport.summary}\n\n${conflicts}`;
  }

  const commandSummary = agent.commandLog[0]
    ? `Latest command: ${agent.commandLog[0].command}${agent.commandLog[0].status ? ` (${agent.commandLog[0].status})` : ""}.`
    : "";
  const recentDetail = latestMeaningfulAgentDetail(agent) ?? agent.lastMessageSnippet ?? "";
  return [agent.currentPhase, agent.currentSubtask, recentDetail, commandSummary]
    .filter((entry) => entry && entry.trim().length > 0)
    .join("\n\n") || "No detailed explanation is available yet.";
};

const splitAgentExplanation = (value: string): string[] =>
  value
    .split(/\n{2,}/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const ValidationBadge = ({ status }: { status: ValidationStatus }) => (
  <span className={`badge ${validationClass(status)}`}>{status}</span>
);

const SourceBadge = ({ source }: { source: SummarySource }) => (
  <span className="badge badge-source">{sourceLabel(source)}</span>
);

const LoadingIndicator = ({
  label,
  compact = false
}: {
  label: string;
  compact?: boolean;
}) => (
  <div className={`loading-indicator ${compact ? "loading-indicator--compact" : ""}`} role="status" aria-live="polite" aria-label={label}>
    <span className="loading-indicator__mark" aria-hidden="true" />
    <span>{label}</span>
  </div>
);

const SectionTitle = ({
  eyebrow,
  title,
  meta
}: {
  eyebrow?: string;
  title: string;
  meta?: JSX.Element | null;
}) => (
  <div className="section-title">
    <div>
      {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
      <h2>{title}</h2>
    </div>
    {meta}
  </div>
);

const CandidateCard = ({
  candidate,
  onUse
}: {
  candidate: InterfaceCandidate;
  onUse: (candidate: InterfaceCandidate) => void;
}) => (
  <button className="candidate-card" onClick={() => onUse(candidate)}>
    <div className="candidate-card__title-row">
      <strong>{candidate.preview.projectName}</strong>
      <ValidationBadge status={candidate.validationStatus} />
    </div>
    <p>{candidate.preview.summarySnippet}</p>
    <div className="candidate-card__meta">
      <SourceBadge source={candidate.preview.contentSource} />
      <span>{candidate.preview.subsystemCount} subsystems</span>
      <span>{candidate.preview.pathSummaryCount} path summaries</span>
    </div>
    <div className="candidate-card__meta">
      <span>{candidate.preview.dependencyCount} dependencies</span>
      <span>{candidate.preview.agentPanelCount} agent panels</span>
      <span>{candidate.preview.versionSummary}</span>
    </div>
    <div className="candidate-card__meta">
      <span>{candidate.label}</span>
      <span>{candidate.preview.lastOpenedAt ? formatDateTime(candidate.preview.lastOpenedAt) : "Never opened here"}</span>
    </div>
  </button>
);

const RepoTree = ({
  nodes,
  filter,
  selected,
  onSelect
}: {
  nodes: LoadedProjectView["tree"];
  filter: string;
  selected?: string;
  onSelect: (path: string) => void;
}) => {
  const treeRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(480);
  const rowHeight = 40;
  const overscan = 10;

  const rows = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const flattened: Array<{ path: string; name: string; type: "file" | "directory"; depth: number }> = [];

    const pushTree = (entries: LoadedProjectView["tree"], depth: number): void => {
      for (const entry of entries) {
        flattened.push({
          path: entry.path,
          name: entry.name,
          type: entry.type,
          depth
        });
        if (entry.children?.length) {
          pushTree(entry.children, depth + 1);
        }
      }
    };

    if (!query) {
      pushTree(nodes, 0);
    } else {
      const collectFilteredTree = (
        entries: LoadedProjectView["tree"],
        depth: number
      ): Array<{ path: string; name: string; type: "file" | "directory"; depth: number }> => {
        const branchRows: Array<{ path: string; name: string; type: "file" | "directory"; depth: number }> = [];
        for (const entry of entries) {
          const childRows = entry.children?.length ? collectFilteredTree(entry.children, depth + 1) : [];
          const selfMatched = entry.path.toLowerCase().includes(query);
          if (!selfMatched && childRows.length === 0) {
            continue;
          }
          branchRows.push({
            path: entry.path,
            name: entry.name,
            type: entry.type,
            depth
          });
          branchRows.push(...childRows);
        }
        return branchRows;
      };

      flattened.push(...collectFilteredTree(nodes, 0));
    }

    return flattened;
  }, [filter, nodes]);

  useEffect(() => {
    const node = treeRef.current;
    if (!node || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const nextHeight = entries[0]?.contentRect.height;
      if (nextHeight) {
        setViewportHeight(nextHeight);
      }
    });
    observer.observe(node);
    setViewportHeight(node.clientHeight || 480);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setScrollTop(0);
    treeRef.current?.scrollTo({ top: 0 });
  }, [filter]);

  const totalHeight = rows.length * rowHeight;
  const visibleStart = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const visibleCount = Math.ceil(viewportHeight / rowHeight) + overscan * 2;
  const visibleRows = rows.slice(visibleStart, visibleStart + visibleCount);

  return (
    <div
      ref={treeRef}
      className="tree"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      {rows.length ? (
        <div className="tree__spacer" style={{ height: `${totalHeight}px` }}>
          <div className="tree__window" style={{ transform: `translateY(${visibleStart * rowHeight}px)` }}>
            {visibleRows.map((row) => (
              <button
                key={row.path}
                className={`tree-row ${selected === row.path ? "tree-row--selected" : ""}`}
                style={{ paddingLeft: `${row.depth * 16 + 14}px` }}
                type="button"
                onClick={() => row.type === "file" && onSelect(row.path)}
              >
                <span className="tree-row__marker">{row.type === "directory" ? "▸" : "•"}</span>
                <span className="tree-row__label">{row.name}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="empty-copy">No files match the current filter.</div>
      )}
    </div>
  );
};

const AgentCard = ({
  agent,
  workflow,
  selected = false,
  onSelect
}: {
  agent: AgentState;
  workflow?: ProjectWorkflowState;
  selected?: boolean;
  onSelect?: (agentId: string) => void;
}) => (
  <button className={`agent-card ${selected ? "agent-card--selected" : ""}`} onClick={() => onSelect?.(agent.id)} type="button">
    <div className="agent-card__header">
      <div>
        <strong>{agent.name}</strong>
        <div className="agent-card__subtle">{agentCategoryLabel(agent.category)}</div>
      </div>
      <div className={`status-pill status-${agent.status}`}>{agent.status}</div>
    </div>
    <div className="agent-card__meta">
      <span>{agent.lastActivityAt ? `Updated ${formatDateTime(agent.lastActivityAt)}` : "Waiting to start"}</span>
      <span>{agent.reasoningEffort ? `${reasoningEffortLabel(agent.reasoningEffort)}${agent.reasoningEffortSource === "auto" ? " auto" : agent.reasoningEffortSource === "manual" ? " manual" : ""}` : "Default reasoning"}</span>
      <span>{agent.approvals.filter((approval) => approval.status === "pending").length} approvals</span>
      <span>{agent.changedFiles.length} changed files</span>
    </div>
    <p>{agentPreviewText(agent, workflow)}</p>
  </button>
);

const PagedAgentList = ({
  agents,
  workflow,
  selectedAgentId,
  emptyCopy,
  onSelect,
  totalAgents,
  pageIndex,
  onPageChange,
  pageSize = AGENT_HISTORY_PAGE_SIZE
}: {
  agents: AgentState[];
  workflow?: ProjectWorkflowState;
  selectedAgentId?: string;
  emptyCopy: string;
  onSelect: (agentId: string) => void;
  totalAgents?: number;
  pageIndex?: number;
  onPageChange?: (pageIndex: number) => void;
  pageSize?: number;
}) => {
  const [localPageIndex, setLocalPageIndex] = useState(0);
  const previousSelectedAgentId = useRef<string | undefined>(undefined);
  const isControlled = typeof totalAgents === "number" && typeof pageIndex === "number" && onPageChange;
  const total = totalAgents ?? agents.length;
  const currentPageIndex = pageIndex ?? localPageIndex;
  const setCurrentPageIndex = onPageChange ?? setLocalPageIndex;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const boundedPageIndex = Math.min(currentPageIndex, totalPages - 1);
  const pageStart = boundedPageIndex * pageSize;
  const visibleAgents = isControlled ? agents : agents.slice(pageStart, pageStart + pageSize);
  const pageEnd = Math.min(pageStart + visibleAgents.length, total);

  useEffect(() => {
    setCurrentPageIndex(Math.min(currentPageIndex, totalPages - 1));
  }, [currentPageIndex, setCurrentPageIndex, totalPages]);

  useEffect(() => {
    if (isControlled) {
      return;
    }
    if (previousSelectedAgentId.current === selectedAgentId) {
      return;
    }
    previousSelectedAgentId.current = selectedAgentId;

    if (!selectedAgentId) {
      return;
    }

    const selectedIndex = agents.findIndex((agent) => agent.id === selectedAgentId);
    if (selectedIndex >= 0) {
      setLocalPageIndex(Math.floor(selectedIndex / pageSize));
    }
  }, [agents, isControlled, pageSize, selectedAgentId]);

  if (!total) {
    return <div className="empty-copy">{emptyCopy}</div>;
  }

  return (
    <>
      <div className="workflow-agent-list__pager">
        <span>
          Showing {pageStart + 1}-{pageEnd} of {total}
        </span>
        <div className="workflow-agent-list__pager-actions">
          <button
            className="secondary-button"
            disabled={boundedPageIndex === 0}
            onClick={() => setCurrentPageIndex(Math.max(0, boundedPageIndex - 1))}
            type="button"
          >
            Previous {pageSize}
          </button>
          <button
            className="secondary-button"
            disabled={boundedPageIndex >= totalPages - 1}
            onClick={() => setCurrentPageIndex(Math.min(totalPages - 1, boundedPageIndex + 1))}
            type="button"
          >
            Next {pageSize}
          </button>
        </div>
      </div>
      <div className="workflow-agent-list workflow-agent-list--paged">
        {visibleAgents.map((agent) => (
          <AgentCard
            key={agent.id}
            agent={agent}
            workflow={workflow}
            selected={selectedAgentId === agent.id}
            onSelect={onSelect}
          />
        ))}
      </div>
    </>
  );
};

const FeedPager = ({
  label,
  pageIndex,
  pageSize,
  total,
  visibleCount,
  onPageChange
}: {
  label: string;
  pageIndex: number;
  pageSize: number;
  total: number;
  visibleCount: number;
  onPageChange: (pageIndex: number) => void;
}) => {
  if (total === 0) {
    return null;
  }

  const pageStart = pageIndex * pageSize;
  const pageEnd = Math.min(pageStart + visibleCount, total);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="workflow-agent-list__pager">
      <span>{label}: {pageStart + 1}-{pageEnd} of {total}</span>
      <div className="workflow-agent-list__pager-actions">
        <button
          className="secondary-button"
          disabled={pageIndex === 0}
          onClick={() => onPageChange(Math.max(0, pageIndex - 1))}
          type="button"
        >
          Previous
        </button>
        <button
          className="secondary-button"
          disabled={pageIndex >= totalPages - 1}
          onClick={() => onPageChange(Math.min(totalPages - 1, pageIndex + 1))}
          type="button"
        >
          Next
        </button>
      </div>
    </div>
  );
};

const AgentLane = ({
  eyebrow,
  title,
  description,
  agents,
  selectedAgentId,
  emptyCopy,
  action,
  children,
  workflow,
  onSelect
}: {
  eyebrow: string;
  title: string;
  description: string;
  agents: AgentState[];
  selectedAgentId?: string;
  emptyCopy: string;
  action?: JSX.Element | null;
  children?: JSX.Element | null;
  workflow?: ProjectWorkflowState;
  onSelect: (agentId: string) => void;
}) => (
  <section className="agent-lane">
    <div className="agent-lane__header">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h3>{title}</h3>
      </div>
      <span className="badge">{agents.length}</span>
    </div>
    <p className="agent-lane__copy">{description}</p>
    {children}
    {action ? <div className="agent-lane__actions">{action}</div> : null}
    <div className="agent-lane__list">
      {agents.length ? agents.map((agent) => (
        <AgentCard key={agent.id} agent={agent} workflow={workflow} selected={selectedAgentId === agent.id} onSelect={onSelect} />
      )) : (
        <div className="empty-copy">{emptyCopy}</div>
      )}
    </div>
  </section>
);

const AgentFocusPanel = ({ agent, workflow }: { agent?: AgentState; workflow?: ProjectWorkflowState }) => {
  if (!agent) {
    return (
      <aside className="agent-focus card-surface">
        <div className="eyebrow">Focused agent</div>
        <h3>Agent details</h3>
        <div className="empty-copy">
          <p>Select an agent card to inspect its prompt, runtime details, and latest output.</p>
        </div>
      </aside>
    );
  }

  const recentEvents = sortEventsByAge(agent.events).slice(0, 6);
  const explanation = splitAgentExplanation(agentDetailedExplanation(agent, workflow));

  return (
    <aside className="agent-focus card-surface">
      <div className="agent-focus__header">
        <div>
          <div className="eyebrow">Focused agent</div>
          <h3>{agent.name}</h3>
          <div className="agent-card__subtle">{agentCategoryLabel(agent.category)}</div>
        </div>
        <div className={`status-pill status-${agent.status}`}>{agent.status}</div>
      </div>
      <div className="agent-focus__meta">
        <span>{agent.model}</span>
        <span>{agent.reasoningEffort ? `${reasoningEffortLabel(agent.reasoningEffort)} reasoning${agent.reasoningEffortSource ? ` (${agent.reasoningEffortSource})` : ""}` : "Default reasoning"}</span>
        <span>{agent.threadId ?? "No thread yet"}</span>
        <span>{agent.worktree?.branch ?? "No worktree"}</span>
      </div>
      <section className="agent-focus__section">
        <div className="agent-focus__label">Full explanation</div>
        <div className="agent-focus__copy">
          {explanation.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
        </div>
      </section>
      <section className="agent-focus__section">
        <div className="agent-focus__label">Objective</div>
        <p>{agent.taskPrompt}</p>
      </section>
      {agent.currentPhase ? (
        <section className="agent-focus__section">
          <div className="agent-focus__label">Current phase</div>
          <p>{agent.currentPhase}</p>
        </section>
      ) : null}
      {agent.lastMessageSnippet ? (
        <section className="agent-focus__section">
          <div className="agent-focus__label">Latest output</div>
          <p>{agent.lastMessageSnippet}</p>
        </section>
      ) : null}
      {agent.integrityReport ? (
        <section className="agent-focus__section">
          <div className="agent-focus__label">Integrity report</div>
          <p>{agent.integrityReport.summary}</p>
          <div className="tag-row">
            {agent.integrityReport.checks.map((check) => (
              <span key={check.name} className="tag">{check.name}: {check.status}</span>
            ))}
          </div>
        </section>
      ) : null}
      {agent.recommendationReport ? (
        <section className="agent-focus__section">
          <div className="agent-focus__label">Recommendations</div>
          <p>{agent.recommendationReport.summary}</p>
          {agent.recommendationReport.ultimateGoalProgress ? (
            <p>
              Estimated Ultimate Goal completion: {agent.recommendationReport.ultimateGoalProgress.percentComplete}%.
              {" "}
              {agent.recommendationReport.ultimateGoalProgress.rationale}
            </p>
          ) : null}
          <div className="tag-row">
            {agent.recommendationReport.nextSteps.map((step) => (
              <span key={step.title} className="tag">{step.priority}: {step.title}</span>
            ))}
          </div>
        </section>
      ) : null}
      {agent.mergeReport ? (
        <section className="agent-focus__section">
          <div className="agent-focus__label">Merge status</div>
          <p>{agent.mergeReport.summary}</p>
          <div className="tag-row">
            {agent.mergeReport.mergedBranches.map((branch) => <span key={branch} className="tag">{branch}</span>)}
            {agent.mergeReport.conflicts.length ? <span className="tag">{agent.mergeReport.conflicts.length} conflicts</span> : null}
          </div>
        </section>
      ) : null}
      {agent.category === "goal" && workflow?.scopedGoal && agent.workflowCycleNumber === workflow.workflowCycle.cycleNumber ? (
        <section className="agent-focus__section">
          <div className="agent-focus__label">Scoped plan</div>
          <div className="tag-row">
            {workflow.scopedGoal.acceptanceCriteria.map((criterion) => (
              <span key={criterion} className="tag">{criterion}</span>
            ))}
          </div>
          {workflow.scopedGoal.testStrategy.length ? (
            <div className="tag-row">
              {workflow.scopedGoal.testStrategy.map((strategy) => (
                <span key={strategy} className="tag">{strategy}</span>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
      {agent.changedFiles.length ? (
        <section className="agent-focus__section">
          <div className="agent-focus__label">Changed files</div>
          <div className="tag-row">
            {agent.changedFiles.map((file) => <span key={file} className="tag">{file}</span>)}
          </div>
        </section>
      ) : null}
      <section className="agent-focus__section">
        <div className="agent-focus__label">Recent events</div>
        <div className="activity-list activity-list--compact">
          {recentEvents.length ? recentEvents.map((event) => (
            <div key={event.id} className="activity-row">
              <strong>{event.title}</strong>
              <span>{event.detail ?? "No detail"}</span>
            </div>
          )) : <div className="empty-copy">No agent events have been recorded yet.</div>}
        </div>
      </section>
    </aside>
  );
};

const CredentialsPanel = ({
  project,
  onSaved,
  onError
}: {
  project: LoadedProjectView;
  onSaved: (message: string) => void;
  onError: (error: unknown) => void;
}) => {
  const [draft, setDraft] = useState({
    entryId: "",
    providerName: "",
    keyLabel: "API key",
    apiKey: "",
    secretKey: "",
    notes: "",
    status: "active" as CredentialEntryMetadata["status"],
    linkedRequestIds: [] as string[]
  });
  const [busy, setBusy] = useState(false);
  const [submitBusyRequestId, setSubmitBusyRequestId] = useState<string>();
  const credentials = project.record.credentials;
  const pendingRequests = credentials.requests.filter((request) => request.status === "pending");
  const entriesByLinkedRequest = useMemo(() => {
    const map = new Map<string, CredentialEntryMetadata>();
    for (const entry of credentials.entries) {
      for (const requestId of entry.linkedRequestIds) {
        map.set(requestId, entry);
      }
    }
    return map;
  }, [credentials.entries]);

  useEffect(() => {
    setDraft({
      entryId: "",
      providerName: "",
      keyLabel: "API key",
      apiKey: "",
      secretKey: "",
      notes: "",
      status: "active",
      linkedRequestIds: []
    });
  }, [project.record.id]);

  const applyRequestToDraft = (requestId: string) => {
    const request = credentials.requests.find((entry) => entry.id === requestId);
    if (!request) {
      return;
    }
    setDraft((current) => ({
      ...current,
      providerName: request.providerName,
      keyLabel: request.keyLabel,
      linkedRequestIds: current.linkedRequestIds.includes(request.id)
        ? current.linkedRequestIds
        : [...current.linkedRequestIds, request.id]
    }));
  };

  const editEntry = (entry: CredentialEntryMetadata) => {
    setDraft({
      entryId: entry.id,
      providerName: entry.providerName,
      keyLabel: entry.keyLabel,
      apiKey: "",
      secretKey: "",
      notes: entry.notes ?? "",
      status: entry.status,
      linkedRequestIds: entry.linkedRequestIds
    });
  };

  const saveCredential = async () => {
    try {
      setBusy(true);
      await window.workbench.saveCredentialEntry(project.record.id, {
        entryId: draft.entryId || undefined,
        providerName: draft.providerName,
        keyLabel: draft.keyLabel,
        apiKey: draft.apiKey,
        secretKey: draft.secretKey || undefined,
        notes: draft.notes || undefined,
        status: draft.status,
        linkedRequestIds: draft.linkedRequestIds
      });
      setDraft({
        entryId: "",
        providerName: "",
        keyLabel: "API key",
        apiKey: "",
        secretKey: "",
        notes: "",
        status: "active",
        linkedRequestIds: []
      });
      onSaved("Stored credential metadata locally. Secret values were not sent to agents.");
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  const deleteCredential = async (entryId: string) => {
    try {
      setBusy(true);
      await window.workbench.deleteCredentialEntry(project.record.id, entryId);
      onSaved("Removed the local credential entry.");
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  const dismissRequest = async (requestId: string) => {
    try {
      await window.workbench.updateCredentialRequest(project.record.id, requestId, "dismissed", "Dismissed by the user.");
      onSaved("Dismissed the credential request.");
    } catch (error) {
      onError(error);
    }
  };

  const submitRequestToAgent = async (requestId: string) => {
    try {
      setSubmitBusyRequestId(requestId);
      await window.workbench.submitCredentialRequestToAgent(project.record.id, requestId);
      onSaved("Sent the stored credential to the waiting agent with explicit approval.");
    } catch (error) {
      onError(error);
    } finally {
      setSubmitBusyRequestId(undefined);
    }
  };

  return (
    <section className="workflow-control-center panel credentials-workspace">
      <SectionTitle
        eyebrow="Local credentials"
        title="API Keys / Credentials"
        meta={<span className="badge">{credentials.entries.length} stored • {pendingRequests.length} pending</span>}
      />
      <div className="notice">
        Secret values are stored only on this machine and are never added to portable interface files, review logs, or prompts automatically.
        Send a secret to an agent only through an explicit pending input request.
      </div>
      <div className="credentials-grid">
        <article className="overview-card workflow-panel">
          <SectionTitle eyebrow="Requests" title="Pending credential requests" meta={<span className="badge">{pendingRequests.length}</span>} />
          <div className="workflow-option-list credentials-list">
            {pendingRequests.length ? pendingRequests.map((request) => (
              <article key={request.id} className="workflow-option workflow-option--blocked">
                <div className="candidate-card__title-row">
                  <strong>{request.providerName} {request.keyLabel}</strong>
                  <span className="badge badge-incompatible">Pending</span>
                </div>
                <p>{request.description}</p>
                <div className="notice notice--compact">
                  {request.freeOnly ?? true
                    ? "Free/no-card credential only. If this provider requires payment, dismiss the request and let the agent choose a free provider or demo mode."
                    : "Paid services may be considered because the setting is enabled, but billing still requires explicit approval."}
                </div>
                {entriesByLinkedRequest.get(request.id) ? (
                  <div className="lane-note">
                    <strong>Stored credential ready</strong>
                    <span>Use Send to waiting agent only if you want this secret shared with the current run.</span>
                  </div>
                ) : null}
                <div className="workflow-option__meta">
                  <span>{request.requestedByAgentCategory ? agentCategoryLabel(request.requestedByAgentCategory) : "Workflow"}</span>
                  <span>Requested {formatDateTime(request.createdAt)}</span>
                </div>
                <div className="actions-row">
                  <button className="primary-button" type="button" onClick={() => applyRequestToDraft(request.id)}>Use in credential form</button>
                  {request.userInputRequestId && entriesByLinkedRequest.get(request.id) ? (
                    <button
                      className="primary-button"
                      type="button"
                      disabled={submitBusyRequestId === request.id}
                      onClick={() => void submitRequestToAgent(request.id)}
                    >
                      {submitBusyRequestId === request.id ? "Sending..." : "Send to waiting agent"}
                    </button>
                  ) : null}
                  <button className="secondary-button" type="button" onClick={() => void dismissRequest(request.id)}>Dismiss</button>
                </div>
              </article>
            )) : <div className="empty-copy">No credential requests are pending.</div>}
          </div>
        </article>

        <article className="overview-card workflow-panel">
          <SectionTitle eyebrow={draft.entryId ? "Replace" : "Add"} title={draft.entryId ? "Replace stored credential" : "Add credential"} />
          <div className="workflow-form">
            <label className="form-field">
              <span>Provider</span>
              <input className="input" value={draft.providerName} onChange={(event) => setDraft({ ...draft, providerName: event.target.value })} />
            </label>
            <label className="form-field">
              <span>Key label</span>
              <input className="input" value={draft.keyLabel} onChange={(event) => setDraft({ ...draft, keyLabel: event.target.value })} />
            </label>
            <label className="form-field">
              <span>API key</span>
              <input
                className="input"
                type="password"
                autoComplete="off"
                value={draft.apiKey}
                onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
              />
            </label>
            <label className="form-field">
              <span>Secret key</span>
              <input
                className="input"
                type="password"
                autoComplete="off"
                value={draft.secretKey}
                onChange={(event) => setDraft({ ...draft, secretKey: event.target.value })}
              />
            </label>
            <label className="form-field">
              <span>Status</span>
              <select className="input" value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as CredentialEntryMetadata["status"] })}>
                <option value="active">Active</option>
                <option value="needs_attention">Needs attention</option>
                <option value="disabled">Disabled</option>
              </select>
            </label>
            <label className="form-field">
              <span>Notes</span>
              <textarea className="textarea" value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} />
            </label>
          </div>
          <div className="actions-row">
            <button className="primary-button" disabled={busy || !draft.providerName.trim() || !draft.keyLabel.trim() || !draft.apiKey.trim()} onClick={() => void saveCredential()}>
              {busy ? "Saving..." : draft.entryId ? "Replace credential" : "Store credential"}
            </button>
            {draft.entryId ? (
              <button className="secondary-button" type="button" onClick={() => setDraft({ ...draft, entryId: "", apiKey: "", secretKey: "" })}>Cancel replace</button>
            ) : null}
          </div>
        </article>
      </div>

      <article className="overview-card workflow-panel">
        <SectionTitle eyebrow="Stored locally" title="Configured providers" meta={<span className="badge">{credentials.entries.length}</span>} />
        <div className="credential-entry-grid">
          {credentials.entries.length ? credentials.entries.map((entry) => (
            <article key={entry.id} className="workflow-option credential-entry">
              <div className="candidate-card__title-row">
                <strong>{entry.providerName}</strong>
                <span className={`badge ${entry.status === "active" ? "badge-exact" : "badge-source"}`}>{entry.status.replace("_", " ")}</span>
              </div>
              <div className="credential-secret-preview">
                <span>{entry.keyLabel}</span>
                <code>{entry.hasApiKey ? "••••••••" : "No API key"}</code>
                <code>{entry.hasSecretKey ? "secret ••••••••" : "No secret key"}</code>
              </div>
              {entry.notes ? <p>{entry.notes}</p> : null}
              <div className="workflow-option__meta">
                <span>Updated {formatDateTime(entry.updatedAt)}</span>
                <span>{entry.linkedRequestIds.length} linked requests</span>
              </div>
              <div className="actions-row">
                <button className="secondary-button" type="button" onClick={() => editEntry(entry)}>Replace</button>
                <button className="secondary-button" type="button" disabled={busy} onClick={() => void deleteCredential(entry.id)}>Remove</button>
              </div>
            </article>
          )) : <div className="empty-copy">No credentials are stored for this project.</div>}
        </div>
      </article>
    </section>
  );
};

const RecommendationDecisionCard = ({
  recommendation,
  approved,
  disabled,
  onApprove
}: {
  recommendation: WorkflowRecommendationOption;
  approved: boolean;
  disabled: boolean;
  onApprove: (recommendationId: string) => void;
}) => (
  <article className={`workflow-option workflow-option--recommendation ${approved ? "workflow-option--approved" : ""}`}>
    <div className="workflow-option__header">
      <div className="workflow-option__rank">
        <span className="workflow-option__rank-label">Rank</span>
        <strong>#{recommendation.rank}</strong>
      </div>
      <div className="workflow-option__heading">
        <div className="candidate-card__title-row">
          <strong>{recommendation.title}</strong>
          <span className={`badge ${approved ? "badge-exact" : "badge-source"}`}>{recommendationPriorityLabel(recommendation.priority)}</span>
        </div>
        <p>{recommendation.summary}</p>
      </div>
    </div>
    <div className="workflow-option__meta">
      <span>Confidence {Math.round(recommendation.confidence * 100)}%</span>
      <span>{recommendation.estimatedScope} scope</span>
      <span>{recommendationRiskLabel(recommendation.riskLevel)}</span>
    </div>
    <div className="workflow-option__callouts">
      <div className="workflow-option__callout">
        <span className="workflow-option__label">Why this is recommended now</span>
        <p>{recommendation.rationale}</p>
      </div>
      <div className="workflow-option__callout">
        <span className="workflow-option__label">Expected value</span>
        <p>{recommendation.expectedImpact}</p>
      </div>
    </div>
    {recommendation.relatedPaths.length ? (
      <div className="tag-row">
        {recommendation.relatedPaths.slice(0, 5).map((relatedPath) => (
          <span key={`${recommendation.id}:${relatedPath}`} className="tag">{relatedPath}</span>
        ))}
      </div>
    ) : null}
    <div className="actions-row">
      <button className={approved ? "secondary-button" : "primary-button"} disabled={disabled} onClick={() => onApprove(recommendation.id)}>
        {approved ? "Chosen next step" : "Choose this next step"}
      </button>
    </div>
  </article>
);

const UltimateGoalProgressCard = ({
  progress,
  completion,
  checklist,
  taskMap,
  objective,
  appeal
}: {
  progress?: ProjectWorkflowState["ultimateGoalProgress"];
  completion?: ProjectWorkflowState["ultimateGoalCompletion"];
  checklist?: ProjectWorkflowState["goalChecklist"];
  taskMap?: ProjectWorkflowState["taskMap"];
  objective: LoadedProjectView["record"]["localState"]["workflowObjective"];
  appeal?: ProjectWorkflowState["appeal"];
}) => {
  if (!progress) {
    return null;
  }

  const allChecks = [...(checklist ?? [])].sort((left, right) => {
    const order = { unmet: 0, unknown: 1, met: 2, not_applicable: 3 } as const;
    if (left.required !== right.required) {
      return left.required ? -1 : 1;
    }
    return order[left.status] - order[right.status] || left.title.localeCompare(right.title);
  });
  const requiredChecks = allChecks.filter((check) => check.required && check.status !== "not_applicable");
  const metChecks = requiredChecks.filter((check) => check.status === "met");
  const visibleChecks = allChecks.slice(0, 20);
  const hiddenCheckCount = Math.max(0, allChecks.length - visibleChecks.length);
  const openTaskGroups = (taskMap?.groups ?? [])
    .filter((group) => group.status !== "complete")
    .sort((left, right) => right.priority - left.priority || left.title.localeCompare(right.title))
    .slice(0, 5);

  return (
    <section className="workflow-goal-progress">
      <div className="candidate-card__title-row">
        <span className="workflow-option__label">Ultimate Goal completion</span>
        <strong>{progress.percentComplete}%</strong>
      </div>
      <div
        className="workflow-goal-progress__bar"
        role="progressbar"
        aria-label="Estimated Ultimate Goal completion"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percentComplete}
      >
        <div className="workflow-goal-progress__fill" style={{ width: `${progress.percentComplete}%` }} />
      </div>
      <div className="workflow-step-card__meta">
        <span>{ultimateGoalProgressSourceLabel(progress.source)}</span>
        <span>{metChecks.length}/{requiredChecks.length} checks met</span>
        <span>Updated {formatDateTime(progress.updatedAt)}</span>
      </div>
      {completion ? (
        <div className="lane-note">
          <strong>{ultimateGoalCompletionStateLabel(completion.state)}</strong>
          <span>
            {completion.state === "goal_satisfied" && objective === "optimize"
              ? "The base goal appears satisfied, and optimize mode will keep looking for bounded improvements."
              : completion.state === "goal_satisfied" && appeal?.status === "pending"
                ? "The base goal appears satisfied, and a final appeal pass is ready to choose."
                : completion.state === "goal_satisfied" && appeal?.status === "running"
                  ? "The base goal appears satisfied, and the final appeal pass is in progress."
                  : completion.state === "goal_satisfied" && appeal?.status === "completed"
                    ? "The base goal and final appeal pass are complete."
              : completion.rationale}
          </span>
        </div>
      ) : null}
      {openTaskGroups.length > 0 ? (
        <div className="goal-checklist-preview">
          <div className="goal-checklist-preview__header">
            <strong>Task map</strong>
            <span>{taskMap?.openRequiredChecks ?? 0} open checks across {taskMap?.groups.filter((group) => group.status !== "complete").length ?? 0} groups</span>
          </div>
          {openTaskGroups.map((group) => (
            <div key={group.id} className="goal-checklist-preview__item">
              <span className="badge goal-check-badge goal-check-badge--unknown">{group.openCheckCount}</span>
              <div className="goal-checklist-preview__copy">
                <strong>{group.title}</strong>
                <span>
                  {group.representativeChecks.slice(0, 3).join(" · ")}
                  {group.relatedPaths.length ? ` · ${group.relatedPaths.slice(0, 3).join(", ")}` : ""}
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {allChecks.length > 0 ? (
        <div className="goal-checklist-preview">
          <div className="goal-checklist-preview__header">
            <strong>Full goal checklist</strong>
            <span>
              {hiddenCheckCount > 0 ? `Showing ${visibleChecks.length} of ` : ""}
              {allChecks.length} item{allChecks.length === 1 ? "" : "s"}
            </span>
          </div>
          {visibleChecks.map((check) => (
            <div key={check.id} className="goal-checklist-preview__item">
              <span className={`badge goal-check-badge goal-check-badge--${check.status}`}>
                {goalCheckStatusLabel(check.status)}
              </span>
              <div className="goal-checklist-preview__copy">
                <strong>{check.title}</strong>
                <span>
                  {check.required ? "Required" : "Optional"} · {goalCheckSourceLabel(check.source)}
                  {check.evidence ? ` · ${check.evidence}` : check.description ? ` · ${check.description}` : ""}
                </span>
              </div>
            </div>
          ))}
          {hiddenCheckCount > 0 ? (
            <p className="agent-card__subtle">
              {hiddenCheckCount} lower-priority checklist item{hiddenCheckCount === 1 ? "" : "s"} hidden in this panel.
            </p>
          ) : null}
        </div>
      ) : null}
      <p>{progress.rationale}</p>
    </section>
  );
};

const WorkflowStepRail = ({
  steps,
  nowTime
}: {
  steps: ReturnType<typeof buildWorkflowTimelineSteps>;
  nowTime: number;
}) => (
  <div className="workflow-step-rail">
    {steps.map((step, index) => (
      <div key={step.id} className={`workflow-step-rail__item ${step.isCurrent ? "workflow-step-rail__item--current" : ""}`}>
        <div className="workflow-step-rail__index">{index + 1}</div>
        <div className="workflow-step-rail__body">
          <div className="candidate-card__title-row">
            <strong>{step.title}</strong>
            <span className={`badge workflow-step-badge workflow-step-badge--${step.displayStatus}`}>{step.displayStatusLabel}</span>
          </div>
          <p>{step.isCurrent ? (step.currentActivity ?? step.description) : step.description}</p>
          {step.isCurrent && step.currentSubstep ? <p className="agent-card__subtle">{step.currentSubstep}</p> : null}
          <div className="workflow-step-card__meta">
            {step.agentCategory ? <span>{agentCategoryLabel(step.agentCategory)}</span> : null}
            {step.updatedAt ? <span>Updated {formatClockTime(step.updatedAt)}</span> : null}
            {step.startedAt ? <span>{formatElapsedDuration(step.startedAt, step.completedAt, nowTime) ?? "In progress"}</span> : null}
            {step.requiresUserInput ? <span>User input needed</span> : null}
          </div>
        </div>
      </div>
    ))}
  </div>
);

const WorkflowAtAGlance = ({
  goalTitle,
  currentActivity,
  recommendationTitle,
  executionPlan,
  intendedSteps,
  stageLabel,
  activeStepTitle,
  agentName,
  agentStatus,
  checklistSummary,
  nextGuidance
}: {
  goalTitle: string;
  currentActivity: string;
  recommendationTitle: string;
  executionPlan: string;
  intendedSteps: string[];
  stageLabel: string;
  activeStepTitle?: string;
  agentName?: string;
  agentStatus?: AgentState["status"];
  checklistSummary: string;
  nextGuidance?: string;
}) => (
  <article className="workflow-at-glance">
    <div className="workflow-at-glance__main">
      <span className="workflow-option__label">Workflow look</span>
      <h3>{goalTitle}</h3>
      <div className="workflow-at-glance__brief">
        <div>
          <span className="workflow-option__label">Now</span>
          <p>{currentActivity}</p>
        </div>
        <div>
          <span className="workflow-option__label">Recommendation</span>
          <p>{recommendationTitle}</p>
        </div>
        <div>
          <span className="workflow-option__label">Plan</span>
          <p>{executionPlan}</p>
        </div>
        <div>
          <span className="workflow-option__label">Intended steps</span>
          {intendedSteps.length ? (
            <ol className="workflow-at-glance__steps">
              {intendedSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          ) : (
            <p>Steps will appear when the workflow has a recommendation or scoped goal.</p>
          )}
        </div>
      </div>
    </div>
    <div className="workflow-at-glance__facts">
      <div className="workflow-at-glance__fact">
        <span>Stage</span>
        <strong>{stageLabel}</strong>
      </div>
      <div className="workflow-at-glance__fact">
        <span>Agent</span>
        <strong>{agentName ?? "Waiting for next run"}</strong>
        {agentStatus ? <em>{agentStatus}</em> : null}
      </div>
      <div className="workflow-at-glance__fact">
        <span>Step</span>
        <strong>{activeStepTitle ?? "No active step yet"}</strong>
      </div>
      <div className="workflow-at-glance__fact">
        <span>Checklist</span>
        <strong>{checklistSummary}</strong>
      </div>
    </div>
    {nextGuidance ? <p className="workflow-at-glance__next">{nextGuidance}</p> : null}
  </article>
);

interface TranscriptEntryView {
  id: string;
  timestamp: string;
  sourceLabel: string;
  statusLabel: string;
  statusTone: NonNullable<RuntimeEventRecord["status"]>;
  title: string;
  detail?: string;
}

const LiveUpdatesPanel = ({
  agents,
  workflowActivity,
  activeStepTitle,
  activeStepId,
  selectedAgent,
  onSelectAgent,
  nowTime
}: {
  agents: AgentState[];
  workflowActivity: WorkflowActivityEvent[];
  activeStepTitle?: string;
  activeStepId?: string;
  selectedAgent?: AgentState;
  onSelectAgent: (agentId: string) => void;
  nowTime: number;
}) => {
  const transcriptEntries = useMemo(() => {
    const selectedStepId = selectedAgent?.events[0]?.stepId ?? activeStepId;
    const agentEntries: TranscriptEntryView[] = selectedAgent
      ? [...selectedAgent.events]
        .sort((left, right) => toTime(left.timestamp) - toTime(right.timestamp))
        .map((event) => ({
          id: `agent-${event.id}`,
          timestamp: event.timestamp,
          sourceLabel: selectedAgent.name,
          statusLabel: workflowEventStatusLabel(event.status),
          statusTone: event.status ?? "info",
          title: event.title,
          detail: event.detail
        }))
      : [];

    const workflowEntries: TranscriptEntryView[] = [...workflowActivity]
      .filter((event) => {
        if (event.source === "agent" && selectedAgent) {
          return false;
        }
        if (selectedAgent?.id && event.agentId === selectedAgent.id) {
          return true;
        }
        if (selectedAgent?.category && event.agentCategory === selectedAgent.category) {
          return true;
        }
        if (selectedStepId && event.stepId === selectedStepId) {
          return true;
        }
        return !selectedAgent && !selectedStepId;
      })
      .sort((left, right) => toTime(left.timestamp) - toTime(right.timestamp))
      .map((event) => ({
        id: `workflow-${event.id}`,
        timestamp: event.timestamp,
        sourceLabel: event.agentCategory ? `${workflowActivitySourceLabel(event.source)} · ${agentCategoryLabel(event.agentCategory)}` : workflowActivitySourceLabel(event.source),
        statusLabel: workflowEventStatusLabel(event.status),
        statusTone: event.status,
        title: event.title,
        detail: event.detail
      }));

    return [...workflowEntries, ...agentEntries]
      .sort((left, right) => toTime(left.timestamp) - toTime(right.timestamp))
      .slice(-120);
  }, [activeStepId, selectedAgent, workflowActivity]);

  const elapsed = selectedAgent ? formatElapsedDuration(selectedAgent.startedAt, selectedAgent.completedAt, nowTime) : null;

  return (
    <article className="overview-card workflow-transcript">
      <SectionTitle
        eyebrow="Live updates"
        title="Execution transcript"
        meta={<span className="badge">{agents.length} agent runs</span>}
      />
      <div className="workflow-transcript__layout">
        <div className="workflow-transcript__runs">
          <div className="workflow-transcript__runs-header">
            <strong>Recent runs</strong>
            <span>{activeStepTitle ?? "Workflow"}</span>
          </div>
          <div className="workflow-transcript__runs-list">
            {agents.length ? agents.map((agent) => (
              <button
                key={agent.id}
                className={`workflow-transcript__run ${selectedAgent?.id === agent.id ? "workflow-transcript__run--active" : ""}`}
                type="button"
                onClick={() => onSelectAgent(agent.id)}
              >
                <div className="workflow-transcript__run-header">
                  <strong>{agent.name}</strong>
                  <span className={`status-pill status-${agent.status}`}>{agent.status}</span>
                </div>
                <div className="workflow-transcript__run-meta">
                  <span>{agentCategoryLabel(agent.category)}</span>
                  <span>{agent.startedAt ? `Started ${formatClockTime(agent.startedAt)}` : "Queued"}</span>
                </div>
                <p>{agent.currentSubtask ?? agent.currentPhase ?? agent.lastMessageSnippet ?? "No live detail yet."}</p>
              </button>
            )) : (
              <div className="empty-copy">
                <p>No workflow agents have started yet.</p>
              </div>
            )}
          </div>
        </div>
        <div className="workflow-transcript__main">
          <div className="workflow-transcript__summary">
            <div>
              <div className="eyebrow">Focused run</div>
              <h3>{selectedAgent?.name ?? activeStepTitle ?? "Workflow activity"}</h3>
              <p>
                {selectedAgent
                  ? `${agentCategoryLabel(selectedAgent.category)} agent`
                  : "Follow the current workflow step as activity arrives in real time."}
              </p>
            </div>
            <div className="workflow-transcript__summary-meta">
              <span>{selectedAgent?.startedAt ? `Started ${formatDateTime(selectedAgent.startedAt)}` : "Not started yet"}</span>
              <span>{selectedAgent?.lastActivityAt ? `Last update ${formatDateTime(selectedAgent.lastActivityAt)}` : "Waiting for updates"}</span>
              <span>{elapsed ? `Elapsed ${elapsed}` : "Elapsed not available yet"}</span>
              <span>{selectedAgent?.currentSubtask ?? selectedAgent?.currentPhase ?? activeStepTitle ?? "No active subtask yet"}</span>
            </div>
          </div>
          {selectedAgent?.commandLog.length ? (
            <div className="workflow-transcript__commands">
              {selectedAgent.commandLog.slice(0, 3).map((command) => (
                <div key={`${selectedAgent.id}:${command.itemId ?? command.startedAt}`} className="workflow-transcript__command">
                  <strong>{command.command}</strong>
                  <span>{command.cwd ?? "No cwd provided"}</span>
                  <span>{command.status}</span>
                </div>
              ))}
            </div>
          ) : null}
          <div className="workflow-transcript__list">
            {transcriptEntries.length ? transcriptEntries.map((entry) => (
              <div key={entry.id} className={`workflow-transcript__entry workflow-transcript__entry--${entry.statusTone}`}>
                <div className="workflow-transcript__entry-meta">
                  <span>{formatClockTime(entry.timestamp)}</span>
                  <span>{entry.sourceLabel}</span>
                  <span className={`badge workflow-transcript__badge workflow-transcript__badge--${entry.statusTone}`}>{entry.statusLabel}</span>
                </div>
                <strong>{entry.title}</strong>
                {entry.detail ? <p>{entry.detail}</p> : null}
              </div>
            )) : (
              <div className="empty-copy">
                <p>Live updates will appear here as soon as the workflow emits them.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </article>
  );
};

const WorkspaceTabButton = ({
  label,
  active,
  count,
  onClick
}: {
  label: string;
  active: boolean;
  count?: number;
  onClick: () => void;
}) => (
  <button className={`workspace-tab ${active ? "workspace-tab--active" : ""}`} onClick={onClick} type="button">
    <span>{label}</span>
    {typeof count === "number" ? <span className="workspace-tab__count">{count}</span> : null}
  </button>
);

const ModelOptionCard = ({
  model,
  selected,
  onSelect
}: {
  model: DiscoveredModel;
  selected: boolean;
  onSelect: (model: string) => void;
}) => (
  <button className={`model-option ${selected ? "model-option--selected" : ""}`} onClick={() => onSelect(model.model)}>
    <div className="candidate-card__title-row">
      <strong>{model.displayName}</strong>
      {model.recommendedForInterfaceCreation ? <span className="badge badge-exact">Recommended</span> : null}
    </div>
    <div className="agent-card__subtle">{model.model}</div>
    <p>{model.description || "No description available from model discovery."}</p>
    <div className="tag-row">
      {model.defaultReasoningEffort ? <span className="tag">{model.defaultReasoningEffort} default reasoning</span> : null}
      {model.labels.map((label) => <span key={label} className="tag">{label}</span>)}
    </div>
  </button>
);

const SettingsDialog = ({
  state,
  settingsDraft,
  github,
  onChange,
  onSave,
  onClose,
  onOpenDevTools,
  onRefreshGitHubStatus
}: {
  state: WorkbenchState;
  settingsDraft: {
    executionMode: ExecutionMode;
    distroName: string;
    codexBinaryPath: string;
    codexHome: string;
    worktreeBaseDir: string;
    warnOnMntMount: boolean;
    maxRepairCycles: number;
    interfaceCreationModel: string;
    interfaceCreationReasoningEffort: InterfaceReasoningEffort;
    agentReasoningMode: AgentReasoningMode;
    agentReasoningEfforts: Record<AgentCategory, InterfaceReasoningEffort>;
    autoApproveCommands: boolean;
    autoApproveGitCommits: boolean;
    autoApproveGitPushes: boolean;
    considerPaidServices: boolean;
  };
  github: GitHubStatus;
  onChange: (next: {
    executionMode?: ExecutionMode;
    distroName?: string;
    codexBinaryPath?: string;
    codexHome?: string;
    worktreeBaseDir?: string;
    warnOnMntMount?: boolean;
    maxRepairCycles?: number;
    interfaceCreationModel?: string;
    interfaceCreationReasoningEffort?: InterfaceReasoningEffort;
    agentReasoningMode?: AgentReasoningMode;
    agentReasoningEfforts?: AgentReasoningEfforts;
    autoApproveCommands?: boolean;
    autoApproveGitCommits?: boolean;
    autoApproveGitPushes?: boolean;
    considerPaidServices?: boolean;
  }) => void;
  onSave: () => void;
  onClose: () => void;
  onOpenDevTools: () => void;
  onRefreshGitHubStatus: () => void;
}) => {
  const selectedModel = state.availableModels.find((model) => model.model === settingsDraft.interfaceCreationModel);
  const supportedReasoningEfforts = selectedModel?.supportedReasoningEfforts.length
    ? selectedModel.supportedReasoningEfforts
    : INTERFACE_REASONING_EFFORTS;
  const agentReasoningEfforts = normalizeAgentReasoningEfforts(settingsDraft.agentReasoningEfforts);
  const setAgentReasoningEffort = (category: AgentCategory, effort: InterfaceReasoningEffort) => {
    onChange({
      agentReasoningEfforts: {
        ...agentReasoningEfforts,
        [category]: effort
      }
    });
  };

  return (
    <div className="settings-modal">
      <div className="settings-panel">
        <SectionTitle eyebrow="Preferences" title="Settings" meta={<img className="settings-panel__icon" src={interfaceIconUrl} alt="" />} />
        <p className="settings-panel__copy">
          Tune agent run defaults and open diagnostics only when you need them. Developer Tools no longer open automatically on launch.
        </p>
        <div className="notice">{availabilityMessage(state)}</div>
        <div className="settings-section">
          <div className="settings-card">
            <div className="settings-section__heading">
              <strong>GitHub access</strong>
              <span className="badge">Required</span>
            </div>
            <p className="settings-card__copy">
              The workbench now requires a linked GitHub account. Existing workspaces must point at GitHub, and new workspaces create SSH-backed repositories automatically.
            </p>
            <div className={github.state === "linked" ? "notice notice--status notice--completed" : github.state === "needs_ssh" ? "notice" : "notice notice--error"}>
              {github.message}
            </div>
            <div className="tag-row">
              <span className="tag">Account: {github.username ?? "Not linked"}</span>
              <span className="tag">SSH: {github.sshReady ? "ready" : "required"}</span>
            </div>
            <div className="lane-note">
              <strong>Link command</strong>
              <span><code>gh auth login --hostname github.com --git-protocol ssh --web</code></span>
            </div>
            <div className="actions-row">
              <button className="secondary-button" onClick={onRefreshGitHubStatus}>Refresh GitHub Status</button>
            </div>
          </div>
        </div>
        <div className="settings-section">
          <div className="settings-card">
            <div className="settings-section__heading">
              <strong>Runtime target</strong>
              <span className="badge">Execution</span>
            </div>
            <p className="settings-card__copy">
              Use WSL when the Electron app runs natively on Windows but Codex, Git, and project commands should stay inside Ubuntu.
            </p>
            <label className="form-field">
              <span>Execution mode</span>
              <select
                className="input"
                value={settingsDraft.executionMode}
                onChange={(event) => onChange({ executionMode: event.target.value as ExecutionMode })}
              >
                <option value="local">Local/native process</option>
                <option value="wsl">WSL-backed runtime</option>
              </select>
            </label>
            <label className="form-field">
              <span>WSL distro</span>
              <input
                className="input"
                value={settingsDraft.distroName}
                onChange={(event) => onChange({ distroName: event.target.value })}
                disabled={settingsDraft.executionMode !== "wsl"}
                spellCheck={false}
              />
            </label>
            <label className="form-field">
              <span>Warn on `/mnt` paths</span>
              <select
                className="input"
                value={settingsDraft.warnOnMntMount ? "yes" : "no"}
                onChange={(event) => onChange({ warnOnMntMount: event.target.value === "yes" })}
              >
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </label>
          </div>
          <div className="settings-card">
            <div className="settings-section__heading">
              <strong>Runtime paths</strong>
              <span className="badge">Codex + worktrees</span>
            </div>
            <p className="settings-card__copy">
              These values are passed to the main-process runtime layer. They do not expose Node APIs in the renderer.
            </p>
            <label className="form-field">
              <span>Codex binary</span>
              <input
                className="input"
                value={settingsDraft.codexBinaryPath}
                onChange={(event) => onChange({ codexBinaryPath: event.target.value })}
                spellCheck={false}
              />
            </label>
            <label className="form-field">
              <span>CODEX_HOME</span>
              <input
                className="input"
                value={settingsDraft.codexHome}
                onChange={(event) => onChange({ codexHome: event.target.value })}
                placeholder="Optional"
                spellCheck={false}
              />
            </label>
            <label className="form-field">
              <span>Worktree base</span>
              <input
                className="input"
                value={settingsDraft.worktreeBaseDir}
                onChange={(event) => onChange({ worktreeBaseDir: event.target.value })}
                spellCheck={false}
              />
            </label>
          </div>
        </div>
        <div className="settings-section">
          <div className="settings-section__heading">
            <strong>Model</strong>
            <span className="badge">Model discovery</span>
          </div>
          <p className="settings-card__copy">
            The selected model is used directly for agent-backed repository analysis, goal drafting, coding, validation, and merge runs.
          </p>
          <div className="loader-grid">
            {state.availableModels.length ? state.availableModels.map((model) => (
              <ModelOptionCard
                key={model.id}
                model={model}
                selected={settingsDraft.interfaceCreationModel === model.model}
                onSelect={(selectedModelName) => onChange({ interfaceCreationModel: selectedModelName })}
              />
            )) : <div className="overview-card"><p>No models are currently available.</p></div>}
          </div>
        </div>
        <div className="settings-section">
          <div className="settings-card">
            <div className="settings-section__heading">
              <strong>Agent reasoning</strong>
              <span className="badge">{settingsDraft.agentReasoningMode === "auto" ? "Automatic" : "Manual"}</span>
            </div>
            <p className="settings-card__copy">
              Automatic mode sizes reasoning to the agent role and task. Manual mode uses the per-role values below.
            </p>
            <label className="form-field">
              <span>Selection mode</span>
              <select
                className="input"
                value={settingsDraft.agentReasoningMode}
                onChange={(event) => onChange({ agentReasoningMode: event.target.value as AgentReasoningMode })}
                disabled={!state.availableModels.length}
              >
                <option value="auto">Automatic per task</option>
                <option value="manual">Manual per agent role</option>
              </select>
            </label>
            <div className="reasoning-role-grid">
              {configurableAgentCategories.map((category) => {
                const automaticEffort = resolveAgentReasoningEffort(
                  selectedModel,
                  category,
                  `${agentCategoryLabel(category)} ${DEFAULT_AGENT_REASONING_EFFORTS[category]}`,
                  "auto",
                  agentReasoningEfforts[category]
                );
                return (
                  <label key={category} className="form-field">
                    <span>{agentCategoryLabel(category)}</span>
                    <select
                      className="input"
                      value={agentReasoningEfforts[category]}
                      onChange={(event) => setAgentReasoningEffort(category, event.target.value as InterfaceReasoningEffort)}
                      disabled={!state.availableModels.length || settingsDraft.agentReasoningMode === "auto"}
                    >
                      {supportedReasoningEfforts.map((effort) => (
                        <option key={effort} value={effort}>
                          {reasoningEffortLabel(effort)}: {reasoningEffortDescription(effort)}
                        </option>
                      ))}
                    </select>
                    <span className="agent-card__subtle">
                      Auto: {reasoningEffortLabel(automaticEffort)}
                    </span>
                  </label>
                );
              })}
            </div>
            <div className="tag-row">
              {selectedModel?.defaultReasoningEffort ? <span className="tag">Model default: {selectedModel.defaultReasoningEffort}</span> : null}
              <span className="tag">Supported: {supportedReasoningEfforts.map(reasoningEffortLabel).join(", ")}</span>
              <span className="tag">Coding auto: {reasoningEffortLabel(resolveAgentReasoningEffort(selectedModel, "coding", "Implement the scoped coding task.", "auto"))}</span>
              <span className="tag">Merge auto: {reasoningEffortLabel(resolveAgentReasoningEffort(selectedModel, "merge", "Integrate validated work deterministically.", "auto"))}</span>
            </div>
          </div>
          <div className="settings-card">
            <div className="settings-section__heading">
              <strong>Approval defaults</strong>
              <span className="badge">Automation</span>
            </div>
            <p className="settings-card__copy">
              Command approvals can be auto-accepted globally or only for Git commits and pushes. File changes, patches, and permission escalations still stay explicit.
            </p>
            <label className="form-field">
              <span>Standard command approvals</span>
              <select
                className="input"
                value={settingsDraft.autoApproveCommands ? "yes" : "no"}
                onChange={(event) => onChange({ autoApproveCommands: event.target.value === "yes" })}
              >
                <option value="no">Require approval</option>
                <option value="yes">Auto-approve</option>
              </select>
            </label>
            <label className="form-field">
              <span>Git commit approvals</span>
              <select
                className="input"
                value={settingsDraft.autoApproveGitCommits ? "yes" : "no"}
                onChange={(event) => onChange({ autoApproveGitCommits: event.target.value === "yes" })}
              >
                <option value="no">Require approval</option>
                <option value="yes">Auto-approve</option>
              </select>
            </label>
            <label className="form-field">
              <span>Git push approvals</span>
              <select
                className="input"
                value={settingsDraft.autoApproveGitPushes ? "yes" : "no"}
                onChange={(event) => onChange({ autoApproveGitPushes: event.target.value === "yes" })}
              >
                <option value="no">Require approval</option>
                <option value="yes">Auto-approve</option>
              </select>
            </label>
          </div>
          <div className="settings-card">
            <div className="settings-section__heading">
              <strong>External services</strong>
              <span className="badge">API cost</span>
            </div>
            <p className="settings-card__copy">
              Keep this off to make agents prefer no-key, open-data, demo, and free-tier providers. Paid accounts, billing setup, and credit-card-backed keys remain out of scope.
            </p>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={settingsDraft.considerPaidServices}
                onChange={(event) => onChange({ considerPaidServices: event.target.checked })}
              />
              <span>Consider Paid Services</span>
            </label>
          </div>
        </div>
        <div className="settings-section">
          <div className="settings-card">
            <div className="settings-section__heading">
              <strong>Workflow repair limit</strong>
              <span className="badge">Repair</span>
            </div>
            <p className="settings-card__copy">
              This is the only direct workflow execution limit here. You can change it during an active run and the workflow will use the updated limit.
            </p>
            <label className="form-field">
              <span>Maximum repair cycles per workflow cycle</span>
              <input
                className="input"
                type="number"
                min={1}
                max={10}
                value={settingsDraft.maxRepairCycles}
                onChange={(event) => onChange({ maxRepairCycles: Math.max(1, Math.min(10, Number(event.target.value) || 1)) })}
              />
            </label>
          </div>
        </div>
        <div className="settings-section">
          <div className="settings-card">
            <div className="settings-section__heading">
              <strong>Developer Tools</strong>
              <span className="badge">Manual only</span>
            </div>
            <p className="settings-card__copy">
              Use this only when you explicitly want Chromium diagnostics. It opens on demand and never by default on app launch.
            </p>
            <div className="actions-row">
              <button className="secondary-button" onClick={onOpenDevTools}>Open Developer Tools</button>
            </div>
          </div>
        </div>
        <div className="actions-row">
          <button className="primary-button" onClick={onSave}>Save Settings</button>
          <button className="secondary-button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
};

const AgentReasoningPicker = ({
  category,
  model,
  taskPrompt,
  mode,
  effort,
  onModeChange,
  onEffortChange
}: {
  category: AgentCategory;
  model?: DiscoveredModel;
  taskPrompt: string;
  mode: AgentReasoningMode;
  effort: InterfaceReasoningEffort;
  onModeChange: (mode: AgentReasoningMode) => void;
  onEffortChange: (effort: InterfaceReasoningEffort) => void;
}) => {
  const supportedReasoningEfforts = model?.supportedReasoningEfforts.length
    ? model.supportedReasoningEfforts
    : INTERFACE_REASONING_EFFORTS;
  const normalizedEffort = resolveAgentReasoningEffort(model, category, taskPrompt, "manual", effort);
  const automaticEffort = resolveAgentReasoningEffort(model, category, taskPrompt, "auto", normalizedEffort);

  return (
    <div className="agent-reasoning-picker">
      <label className="form-field">
        <span>Reasoning</span>
        <select className="input" value={mode} onChange={(event) => onModeChange(event.target.value as AgentReasoningMode)}>
          <option value="auto">Automatic ({reasoningEffortLabel(automaticEffort)})</option>
          <option value="manual">Manual</option>
        </select>
      </label>
      <label className="form-field">
        <span>Manual effort</span>
        <select
          className="input"
          value={normalizedEffort}
          onChange={(event) => onEffortChange(event.target.value as InterfaceReasoningEffort)}
          disabled={mode === "auto"}
        >
          {supportedReasoningEfforts.map((candidate) => (
            <option key={candidate} value={candidate}>
              {reasoningEffortLabel(candidate)}: {reasoningEffortDescription(candidate)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
};

const BrandHeader = ({
  title,
  subtitle,
  actions
}: {
  title: string;
  subtitle: string;
  actions: JSX.Element;
}) => (
  <header className="app-header">
    <div className="brand-lockup">
      <img className="brand-lockup__icon" src={interfaceIconUrl} alt="" />
      <div>
        <div className="eyebrow">{subtitle}</div>
        <h1>{title}</h1>
      </div>
    </div>
    {actions}
  </header>
);

const LauncherActionCard = ({
  eyebrow,
  title,
  copy,
  actionLabel,
  onAction,
  featured = false,
  disabled = false
}: {
  eyebrow: string;
  title: string;
  copy: string;
  actionLabel: string;
  onAction: () => void;
  featured?: boolean;
  disabled?: boolean;
}) => (
  <article className={`overview-card launcher-action ${featured ? "launcher-action--featured" : ""}`}>
    <div className="eyebrow">{eyebrow}</div>
    <h3>{title}</h3>
    <p>{copy}</p>
    <div className="actions-row">
      <button className={featured ? "primary-button" : "secondary-button"} disabled={disabled} onClick={onAction}>{actionLabel}</button>
    </div>
  </article>
);

export const App = () => {
  const [state, setState] = useState<WorkbenchState | null>(null);
  const [pendingLoad, setPendingLoad] = useState<ProjectLoadResult | null>(null);
  const [initialStateLoading, setInitialStateLoading] = useState(true);
  const [projectLoadBusy, setProjectLoadBusy] = useState<"open" | "create" | "import" | null>(null);
  const [openingRecentProjectId, setOpeningRecentProjectId] = useState<string>();
  const [selectedFile, setSelectedFile] = useState<string>();
  const [fileSummary, setFileSummary] = useState<FileSummary | null>(null);
  const [codingAgentForm, setCodingAgentForm] = useState({
    name: "Implement Task",
    prompt: "",
    model: "",
    reasoningMode: "auto" as AgentReasoningMode,
    reasoningEffort: DEFAULT_AGENT_REASONING_EFFORTS.coding
  });
  const [manualAgentPrompt, setManualAgentPrompt] = useState("");
  const [manualAgentModel, setManualAgentModel] = useState("");
  const [manualAgentReasoningMode, setManualAgentReasoningMode] = useState<AgentReasoningMode>("auto");
  const [manualAgentReasoningEffort, setManualAgentReasoningEffort] = useState<InterfaceReasoningEffort>(DEFAULT_AGENT_REASONING_EFFORTS.manual);
  const [customRecommendationPrompt, setCustomRecommendationPrompt] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showExistingChoice, setShowExistingChoice] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState({
    executionMode: "local" as ExecutionMode,
    distroName: "",
    codexBinaryPath: "codex",
    codexHome: "",
    worktreeBaseDir: "",
    warnOnMntMount: true,
    maxRepairCycles: 3,
    interfaceCreationModel: "",
    interfaceCreationReasoningEffort: "medium" as InterfaceReasoningEffort,
    agentReasoningMode: DEFAULT_AGENT_REASONING_MODE,
    agentReasoningEfforts: normalizeAgentReasoningEfforts(),
    autoApproveCommands: false,
    autoApproveGitCommits: false,
    autoApproveGitPushes: false,
    considerPaidServices: false
  });
  const [notice, setNotice] = useState<NoticeState>();
  const [launchIntent, setLaunchIntent] = useState<"open" | "create">("open");
  const [treeFilterDraft, setTreeFilterDraft] = useState("");
  const [focusedAgentId, setFocusedAgentId] = useState<string>();
  const [ultimateGoalDraft, setUltimateGoalDraft] = useState({
    summary: "",
    detailedIntent: "",
    successCriteria: "",
    constraints: "",
    nonGoals: "",
    targetAudience: "",
    qualityBar: ""
  });
  const [ultimateGoalImportPreview, setUltimateGoalImportPreview] = useState<UltimateGoalImportPreview | null>(null);
  const [interventionNotes, setInterventionNotes] = useState<Record<string, string>>({});
  const [userInputDrafts, setUserInputDrafts] = useState<Record<string, Record<string, string>>>({});
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [shellLaunchBusy, setShellLaunchBusy] = useState(false);
  const [overviewRefreshBusy, setOverviewRefreshBusy] = useState(false);
  const [userInputSubmitBusyId, setUserInputSubmitBusyId] = useState<string>();
  const [userInputAttachmentBusyId, setUserInputAttachmentBusyId] = useState<string>();
  const [workflowAgentPageIndex, setWorkflowAgentPageIndex] = useState(0);
  const [manualAgentPageIndex, setManualAgentPageIndex] = useState(0);
  const [workflowAgentPage, setWorkflowAgentPage] = useState<AgentPageView>({
    agents: [],
    total: 0,
    offset: 0,
    limit: AGENT_HISTORY_PAGE_SIZE,
    loading: false
  });
  const [manualAgentPage, setManualAgentPage] = useState<AgentPageView>({
    agents: [],
    total: 0,
    offset: 0,
    limit: AGENT_HISTORY_PAGE_SIZE,
    loading: false
  });
  const [agentDetail, setAgentDetail] = useState<AgentState>();
  const [activityLogPageIndex, setActivityLogPageIndex] = useState(0);
  const [commandLogPageIndex, setCommandLogPageIndex] = useState(0);
  const [logFeed, setLogFeed] = useState<LogFeedView>({
    projectId: "",
    activity: {
      offset: 0,
      limit: LOG_ACTIVITY_PAGE_SIZE,
      total: 0,
      entries: []
    },
    commands: {
      offset: 0,
      limit: LOG_COMMAND_PAGE_SIZE,
      total: 0,
      entries: []
    },
    loading: false
  });

  useEffect(() => {
    void window.workbench.getState()
      .then((result) => startTransition(() => setState(result)))
      .finally(() => setInitialStateLoading(false));
    return window.workbench.onStateUpdated((nextState) => {
      startTransition(() => setState(nextState));
    });
  }, []);

  useEffect(() => {
    const favicon = document.querySelector("link[rel='icon']") ?? document.createElement("link");
    favicon.setAttribute("rel", "icon");
    favicon.setAttribute("href", interfaceIconUrl);
    document.head.appendChild(favicon);
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setClockNow(Date.now());
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, []);

  const activeProject = state?.activeProjectId ? state.projects.find((project) => project.record.id === state.activeProjectId) : undefined;
  const stateLoaded = state !== null;
  const availableModels = useMemo(() => state?.availableModels ?? [], [state?.availableModels]);
  const interfaceCreationConfiguredAt = state?.settings.interfaceCreationConfiguredAt;
  const settingsModel = state?.settings.interfaceCreationModel;
  const settingsReasoning = state?.settings.interfaceCreationReasoningEffort;
  const settingsAgentReasoningMode = normalizeReasoningMode(state?.settings.agentReasoningMode);
  const settingsAgentReasoningEfforts = useMemo(
    () => normalizeAgentReasoningEfforts(state?.settings.agentReasoningEfforts),
    [state?.settings.agentReasoningEfforts]
  );
  const settingsExecutionMode = state?.settings.executionMode ?? "local";
  const settingsDistroName = state?.settings.distroName ?? "";
  const settingsCodexBinaryPath = state?.settings.codexBinaryPath ?? "codex";
  const settingsCodexHome = state?.settings.codexHome ?? "";
  const settingsWorktreeBaseDir = state?.settings.worktreeBaseDir ?? "";
  const settingsWarnOnMntMount = state?.settings.warnOnMntMount ?? true;
  const settingsMaxRepairCycles = state?.settings.maxRepairCycles ?? 3;
  const settingsAutoApproveCommands = state?.settings.autoApproveCommands ?? false;
  const settingsAutoApproveGitCommits = state?.settings.autoApproveGitCommits ?? false;
  const settingsAutoApproveGitPushes = state?.settings.autoApproveGitPushes ?? false;
  const settingsConsiderPaidServices = state?.settings.considerPaidServices ?? false;
  const githubStatus = state?.github;
  const githubLinked = githubStatus?.state === "linked" || githubStatus?.state === "needs_ssh";
  const githubSshReady = githubStatus?.sshReady ?? false;
  const launcherActionsLocked = !githubLinked;
  const createWorkspaceLocked = !githubSshReady;
  const activeProjectId = activeProject?.record.id;
  const selectedFileFromState = activeProject?.record.localState.selectedFile;
  const storedTreeFilter = activeProject?.record.localState.treeFilter ?? "";
  const storedActiveAgentId = activeProject?.record.localState.activeAgentId;
  const autopilotEnabled = activeProject?.record.localState.autopilotEnabled ?? false;
  const workflowObjective = activeProject?.record.localState.workflowObjective ?? "deliver";
  const optimizeModeEnabled = workflowObjective === "optimize";
  const workflowPauseRequested = activeProject?.record.localState.workflowPauseRequested ?? false;
  const recommendedModel = useMemo(
    () => state?.availableModels.find((model) => model.recommendedForInterfaceCreation)?.model ?? state?.availableModels[0]?.model ?? "",
    [state?.availableModels]
  );
  const modelOptionsByName = useMemo(() => new Map(availableModels.map((model) => [model.model, model])), [availableModels]);
  const deferredTreeFilter = useDeferredValue(treeFilterDraft);
  const workflow = activeProject?.record.workflow;
  const allAgents = useMemo(() => activeProject ? sortAgentsByActivity(activeProject.record.agents) : [], [activeProject]);
  const agentHistoryVersion = useMemo(
    () => allAgents.map((agent) => `${agent.id}:${agent.status}:${agent.lastActivityAt ?? ""}:${agent.approvals.length}:${agent.changedFiles.length}`).join("|"),
    [allAgents]
  );
  const workflowAgents = useMemo(() => allAgents.filter((agent) => agent.category !== "manual"), [allAgents]);
  const workflowHasActiveAgent = useMemo(() => workflowAgents.some((agent) => isWorkflowAgentActive(agent)), [workflowAgents]);
  const manualAgents = useMemo(() => allAgents.filter((agent) => agent.category === "manual"), [allAgents]);
  const goalAgents = useMemo(() => workflowAgents.filter((agent) => agent.category === "bootstrap" || agent.category === "goal"), [workflowAgents]);
  const codingAgents = useMemo(() => workflowAgents.filter((agent) => agent.category === "coding"), [workflowAgents]);
  const integrityAgents = useMemo(() => workflowAgents.filter((agent) => agent.category === "integrity"), [workflowAgents]);
  const recommendationAgents = useMemo(() => workflowAgents.filter((agent) => agent.category === "recommendation"), [workflowAgents]);
  const mergeAgents = useMemo(() => workflowAgents.filter((agent) => agent.category === "merge"), [workflowAgents]);
  const pendingUserInputRequests = useMemo(
    () => activeProject?.record.userInputRequests.filter((request) => request.status === "pending") ?? [],
    [activeProject]
  );
  const pendingHumanInterventions = useMemo(
    () =>
      workflow?.humanInterventions.filter(
        (intervention) => intervention.status === "pending" && !intervention.linkedUserInputRequestId
      ) ?? [],
    [workflow]
  );
  const pendingApprovals = useMemo(
    () =>
      activeProject
        ? sortApprovalsByAge(
          activeProject.record.agents.flatMap((agent) => agent.approvals.filter((approval) => approval.status === "pending"))
        )
        : [],
    [activeProject]
  );
  useEffect(() => {
    const activeRequestIds = new Set(pendingUserInputRequests.map((request) => request.id));
    setUserInputDrafts((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([requestId]) => activeRequestIds.has(requestId))
      )
    );
  }, [pendingUserInputRequests]);
  const workflowPendingApprovals = useMemo(
    () =>
      sortApprovalsByAge(
        workflowAgents.flatMap((agent) => agent.approvals.filter((approval) => approval.status === "pending"))
      ),
    [workflowAgents]
  );
  const workflowRecoveryCandidate = useMemo(
    () => workflow ? getWorkflowRecoveryCandidate(workflow, workflowAgents, clockNow, WORKFLOW_AGENT_STALE_MS) : null,
    [clockNow, workflow, workflowAgents]
  );
  const manualPendingApprovalCount = useMemo(
    () => manualAgents.reduce((count, agent) => count + agent.approvals.filter((approval) => approval.status === "pending").length, 0),
    [manualAgents]
  );
  const workflowTimeline = useMemo(
    () => workflow ? buildWorkflowTimelineSteps(workflow) : [],
    [workflow]
  );
  const workflowAction = useMemo<WorkflowPrimaryActionView | null>(() => {
    if (!workflow) {
      return null;
    }
    if (workflowRecoveryCandidate && workflowPendingApprovals.length === 0) {
      return {
        kind: "recover_workflow",
        title: workflowRecoveryCandidate.kind === "disconnected"
          ? "Workflow was interrupted"
          : workflowRecoveryCandidate.kind === "startup_stalled"
            ? "Agent startup may be stalled"
            : "Workflow may be stalled",
        description: workflowRecoveryCandidate.kind === "disconnected"
          ? `${workflowRecoveryCandidate.agent.name} lost its Codex connection. Continue from the last saved workflow decision.`
          : workflowRecoveryCandidate.kind === "startup_stalled"
            ? `${workflowRecoveryCandidate.agent.name} has not received a Codex thread yet. Continue from the saved workflow state to restart the step.`
          : `${workflowRecoveryCandidate.agent.name} has not reported progress recently. Continue from the last saved workflow decision if it stopped responding.`,
        actionLabel: "Continue from saved state"
      };
    }
    if (workflowPauseRequested) {
      if (workflowHasActiveAgent) {
        return {
          kind: "none",
          title: "Pause requested",
          description: "The current workflow agent can finish, but no new automatic step will start until you continue."
        };
      }
      return {
        kind: "resume_workflow",
        title: "Workflow is paused",
        description: "The current workflow state was saved. Continue when you want automation to resume from here.",
        actionLabel: "Continue workflow"
      };
    }
    return workflowActionGuide(workflow, workflowPendingApprovals.length > 0, autopilotEnabled, workflowObjective);
  }, [autopilotEnabled, workflow, workflowHasActiveAgent, workflowObjective, workflowPauseRequested, workflowPendingApprovals.length, workflowRecoveryCandidate]);
  const workflowProminence = useMemo(
    () => workflow ? workflowSectionProminence(workflow) : { recommendations: false, humanIntervention: false, manualHandoff: false },
    [workflow]
  );
  const activeWorkflowStep = useMemo(
    () => workflowTimeline.find((step) => step.isCurrent) ?? workflowTimeline[0],
    [workflowTimeline]
  );
  const workflowGoalView = useMemo(
    () => workflow ? buildWorkflowGoalView(workflow) : null,
    [workflow]
  );
  const currentWorkflowAgent = useMemo(() => {
    if (!workflow) {
      return undefined;
    }

    const isCurrentCycleAgent = (agent: AgentState): boolean =>
      agent.workflowCycleNumber === undefined || agent.workflowCycleNumber === workflow.workflowCycle.cycleNumber;

    return workflowAgents.find((agent) => isCurrentCycleAgent(agent) && isWorkflowAgentActive(agent))
      ?? workflowAgents.find(isCurrentCycleAgent)
      ?? workflowAgents[0];
  }, [workflow, workflowAgents]);
  const workflowChecklistSummary = useMemo(() => {
    const checks = workflow?.goalChecklist ?? [];
    if (checks.length === 0) {
      return "No checks yet";
    }

    const requiredChecks = checks.filter((check) => check.required && check.status !== "not_applicable");
    const metChecks = requiredChecks.filter((check) => check.status === "met");
    return `${metChecks.length}/${requiredChecks.length} required met (${checks.length} total)`;
  }, [workflow]);
  const workflowGlanceGoal = workflowGoalView?.currentGoal ?? workflow?.ultimateGoal.summary ?? "Set the Ultimate Goal";
  const workflowGlanceActivity = currentWorkflowAgent
    ? agentPreviewText(currentWorkflowAgent, workflow)
    : activeWorkflowStep?.currentActivity ?? workflowGoalView?.currentFocus ?? (
      workflow ? workflowStatusSummary(workflow, autopilotEnabled, workflowObjective) : "Workflow state unavailable."
    );
  const workflowGlanceRecommendation = workflow?.approvedRecommendation?.title
    ?? (workflow?.recommendations[0]?.title ? `Awaiting choice: ${workflow.recommendations[0].title}` : "No recommendation selected yet");
  const workflowGlancePlan = workflow?.scopedGoal?.executionBrief
    ?? workflowGoalView?.executionPlan
    ?? workflow?.approvedRecommendation?.summary
    ?? "Waiting for a scoped execution plan.";
  const workflowGlanceSteps = useMemo(() => {
    if (!workflow) {
      return [];
    }

    if (workflow.scopedGoal) {
      return [
        workflow.scopedGoal.summary,
        ...workflow.scopedGoal.acceptanceCriteria.slice(0, 3).map((criterion) => `Meet: ${criterion}`),
        ...workflow.scopedGoal.testStrategy.slice(0, 2).map((strategy) => `Validate: ${strategy}`)
      ].filter((step) => step.trim().length > 0);
    }

    if (workflow.approvedRecommendation) {
      return [
        "Turn the chosen recommendation into a scoped goal.",
        "Run the coding agent against that scoped goal.",
        "Run integrity checks against the scoped goal and Ultimate Goal.",
        "Merge or finalize the validated result."
      ];
    }

    if (workflow.recommendations.length > 0) {
      return [
        "Choose one recommendation.",
        "Create a scoped implementation goal.",
        "Run coding, validation, and integration for that goal."
      ];
    }

    return [];
  }, [workflow]);
  const workflowRepairCounter = useMemo(
    () => workflow ? getWorkflowRepairCounterView(workflow) : null,
    [workflow]
  );
  const repairAttemptReports = useMemo(
    () => workflow ? collectRepairAttemptReports(workflow, workflowAgents) : [],
    [workflow, workflowAgents]
  );
  const recentActivity = useMemo(
    () =>
      workflow
        ? [...workflow.activityLog].sort((left, right) => toTime(right.timestamp) - toTime(left.timestamp)).slice(0, 12)
        : [],
    [workflow]
  );
  const activeAgent = useMemo(
    () => allAgents.find((agent) => agent.id === focusedAgentId) ?? allAgents[0],
    [allAgents, focusedAgentId]
  );
  const activeAgentForDetail = agentDetail?.id === activeAgent?.id ? agentDetail : activeAgent;
  const activeWorkspaceTab: WorkspaceCenterTab = activeProject?.record.layout.activeCenterTab === "reports"
    ? "workflow"
    : activeProject?.record.layout.activeCenterTab === "file" || activeProject?.record.layout.activeCenterTab === "diff"
      ? "overview"
      : activeProject?.record.layout.activeCenterTab ?? "overview";
  const workflowRunState = workflow && activeProject
    ? workflowPauseRequested
      ? workflowHasActiveAgent
        ? "Pausing after current run"
        : "Paused"
      : workflowRunStateLabel(workflow, activeProject.record.identity.kind, workflowPendingApprovals.length > 0, autopilotEnabled, workflowObjective)
    : "Running automatically";
  const activeStageGuidance = workflow ? workflowStageGuidance(workflow.workflowStage) : null;
  const workflowLead = workflow
    ? workflowPauseRequested
      ? workflowHasActiveAgent
        ? "Pause requested. The current workflow agent can finish, then automation will stop."
        : "Workflow automation is paused. Continue when you are ready to resume this cycle."
      : workflowStatusSummary(workflow, autopilotEnabled, workflowObjective)
    : "Workflow state unavailable.";
  const workflowNextGuidance = workflowPauseRequested
    ? workflowHasActiveAgent
      ? "No follow-up workflow step will start after the current run finishes until you continue."
      : "Use Continue workflow to resume from the saved state in this cycle."
    : activeStageGuidance?.next;
  const recommendationRegenerationLocked = Boolean(
    workflow?.approvedRecommendation &&
    workflow.workflowCycle.status !== "completed" &&
    workflow.workflowCycle.status !== "merged"
  );
  const overviewRefreshRunning = overviewRefreshBusy || activeProject?.record.interfaceCreation?.status === "running";

  const setWorkspaceTab = async (tab: Extract<WorkspaceCenterTab, "overview" | "workflow" | "logs" | "agents" | "credentials">) => {
    if (!activeProject) {
      return;
    }

    try {
      await window.workbench.updateLayout(activeProject.record.id, { activeCenterTab: tab });
    } catch (error) {
      handleError(error);
    }
  };

  useEffect(() => {
    document.title = activeProject ? `${activeProject.record.identity.projectName} · ${APP_NAME}` : APP_NAME;
  }, [activeProject]);

  useEffect(() => {
    const goal = activeProject?.record.workflow.ultimateGoal;
    setUltimateGoalDraft({
      summary: goal?.summary ?? "",
      detailedIntent: goal?.detailedIntent ?? "",
      successCriteria: fromLineList(goal?.successCriteria),
      constraints: fromLineList(goal?.constraints),
      nonGoals: fromLineList(goal?.nonGoals),
      targetAudience: goal?.targetAudience ?? "",
      qualityBar: goal?.qualityBar ?? ""
    });
    setUltimateGoalImportPreview(null);
    setInterventionNotes({});
  }, [activeProject?.record.id, activeProject?.record.workflow.ultimateGoal]);

  useEffect(() => {
    if (!stateLoaded) {
      return;
    }

    setCodingAgentForm((current) => {
      const nextModel = current.model && availableModels.some((model) => model.model === current.model) ? current.model : recommendedModel;
      const nextReasoningEffort = resolveAgentReasoningEffort(
        modelOptionsByName.get(nextModel),
        "coding",
        current.prompt || current.name,
        "manual",
        current.reasoningEffort
      );
      return current.model === nextModel && current.reasoningEffort === nextReasoningEffort
        ? current
        : { ...current, model: nextModel, reasoningEffort: nextReasoningEffort };
    });
    setManualAgentModel((current) => current && availableModels.some((model) => model.model === current) ? current : recommendedModel);
    setManualAgentReasoningEffort((current) =>
      resolveAgentReasoningEffort(modelOptionsByName.get(manualAgentModel || recommendedModel), "manual", manualAgentPrompt, "manual", current)
    );
    if (!interfaceCreationConfiguredAt) {
      setShowSettings(true);
    }
  }, [availableModels, interfaceCreationConfiguredAt, manualAgentModel, manualAgentPrompt, modelOptionsByName, recommendedModel, stateLoaded]);

  useEffect(() => {
    setManualAgentPrompt("");
    setCustomRecommendationPrompt("");
  }, [activeProject?.record.id]);

  useEffect(() => {
    if (!stateLoaded || !showSettings) {
      return;
    }

    const nextModel = settingsModel ?? recommendedModel;
    const nextReasoning = resolveInterfaceCreationReasoningEffort(modelOptionsByName.get(nextModel), settingsReasoning) ?? "medium";
    setSettingsDraft((current) =>
      current.executionMode === settingsExecutionMode &&
      current.distroName === settingsDistroName &&
      current.codexBinaryPath === settingsCodexBinaryPath &&
      current.codexHome === settingsCodexHome &&
      current.worktreeBaseDir === settingsWorktreeBaseDir &&
      current.warnOnMntMount === settingsWarnOnMntMount &&
      current.maxRepairCycles === settingsMaxRepairCycles &&
      current.interfaceCreationModel === nextModel &&
      current.interfaceCreationReasoningEffort === nextReasoning &&
      current.agentReasoningMode === settingsAgentReasoningMode &&
      JSON.stringify(current.agentReasoningEfforts) === JSON.stringify(settingsAgentReasoningEfforts) &&
      current.autoApproveCommands === settingsAutoApproveCommands &&
      current.autoApproveGitCommits === settingsAutoApproveGitCommits &&
      current.autoApproveGitPushes === settingsAutoApproveGitPushes &&
      current.considerPaidServices === settingsConsiderPaidServices
        ? current
        : {
          executionMode: settingsExecutionMode,
          distroName: settingsDistroName,
          codexBinaryPath: settingsCodexBinaryPath,
          codexHome: settingsCodexHome,
          worktreeBaseDir: settingsWorktreeBaseDir,
          warnOnMntMount: settingsWarnOnMntMount,
          maxRepairCycles: settingsMaxRepairCycles,
          interfaceCreationModel: nextModel,
          interfaceCreationReasoningEffort: nextReasoning,
          agentReasoningMode: settingsAgentReasoningMode,
          agentReasoningEfforts: settingsAgentReasoningEfforts,
          autoApproveCommands: settingsAutoApproveCommands,
          autoApproveGitCommits: settingsAutoApproveGitCommits,
          autoApproveGitPushes: settingsAutoApproveGitPushes,
          considerPaidServices: settingsConsiderPaidServices
        }
    );
  }, [
    modelOptionsByName,
    recommendedModel,
    settingsAutoApproveCommands,
    settingsAutoApproveGitCommits,
    settingsAutoApproveGitPushes,
    settingsAgentReasoningEfforts,
    settingsAgentReasoningMode,
    settingsConsiderPaidServices,
    settingsCodexBinaryPath,
    settingsCodexHome,
    settingsDistroName,
    settingsExecutionMode,
    settingsMaxRepairCycles,
    settingsModel,
    settingsReasoning,
    settingsWarnOnMntMount,
    settingsWorktreeBaseDir,
    showSettings,
    stateLoaded
  ]);

  useEffect(() => {
    if (!activeProjectId) {
      setSelectedFile(undefined);
      setFileSummary(null);
      return;
    }

    setSelectedFile(selectedFileFromState);
    if (fileSummary && selectedFileFromState !== fileSummary.relativePath) {
      setFileSummary(null);
    }
  }, [activeProjectId, fileSummary, selectedFileFromState]);

  useEffect(() => {
    if (!activeProjectId) {
      setTreeFilterDraft("");
      setFocusedAgentId(undefined);
      setWorkflowAgentPageIndex(0);
      setManualAgentPageIndex(0);
      setActivityLogPageIndex(0);
      setCommandLogPageIndex(0);
      setAgentDetail(undefined);
      return;
    }

    setTreeFilterDraft(storedTreeFilter);
    setFocusedAgentId(storedActiveAgentId);
  }, [activeProjectId, storedActiveAgentId, storedTreeFilter]);

  useEffect(() => {
    setWorkflowAgentPageIndex(0);
    setManualAgentPageIndex(0);
    setActivityLogPageIndex(0);
    setCommandLogPageIndex(0);
    setAgentDetail(undefined);
  }, [activeProjectId]);

  useEffect(() => {
    if (!activeProjectId || activeWorkspaceTab !== "agents") {
      return;
    }

    let cancelled = false;
    setWorkflowAgentPage((current) => ({ ...current, loading: true }));
    void window.workbench.listAgents(
      activeProjectId,
      "workflow",
      workflowAgentPageIndex * AGENT_HISTORY_PAGE_SIZE,
      AGENT_HISTORY_PAGE_SIZE
    ).then((page) => {
      if (!cancelled) {
        setWorkflowAgentPage({ ...page, loading: false });
      }
    }).catch(handleError);

    return () => {
      cancelled = true;
    };
  }, [activeProjectId, activeWorkspaceTab, agentHistoryVersion, workflowAgentPageIndex]);

  useEffect(() => {
    if (!activeProjectId || activeWorkspaceTab !== "agents") {
      return;
    }

    let cancelled = false;
    setManualAgentPage((current) => ({ ...current, loading: true }));
    void window.workbench.listAgents(
      activeProjectId,
      "manual",
      manualAgentPageIndex * AGENT_HISTORY_PAGE_SIZE,
      AGENT_HISTORY_PAGE_SIZE
    ).then((page) => {
      if (!cancelled) {
        setManualAgentPage({ ...page, loading: false });
      }
    }).catch(handleError);

    return () => {
      cancelled = true;
    };
  }, [activeProjectId, activeWorkspaceTab, agentHistoryVersion, manualAgentPageIndex]);

  useEffect(() => {
    if (!activeProjectId || activeWorkspaceTab !== "agents" || !activeAgent?.id) {
      setAgentDetail(undefined);
      return;
    }

    let cancelled = false;
    void window.workbench.getAgent(activeProjectId, activeAgent.id)
      .then((agent) => {
        if (!cancelled) {
          setAgentDetail(agent);
        }
      })
      .catch(handleError);

    return () => {
      cancelled = true;
    };
  }, [activeAgent?.id, activeProjectId, activeWorkspaceTab, agentHistoryVersion]);

  useEffect(() => {
    if (!activeProjectId || activeWorkspaceTab !== "logs") {
      return;
    }

    let cancelled = false;
    setLogFeed((current) => ({ ...current, loading: true }));
    void window.workbench.getLogFeed(activeProjectId, {
      activityOffset: activityLogPageIndex * LOG_ACTIVITY_PAGE_SIZE,
      activityLimit: LOG_ACTIVITY_PAGE_SIZE,
      commandOffset: commandLogPageIndex * LOG_COMMAND_PAGE_SIZE,
      commandLimit: LOG_COMMAND_PAGE_SIZE
    }).then((feed) => {
      if (!cancelled) {
        setLogFeed({ ...feed, loading: false });
      }
    }).catch(handleError);

    return () => {
      cancelled = true;
    };
  }, [activeProjectId, activeWorkspaceTab, activityLogPageIndex, agentHistoryVersion, commandLogPageIndex]);

  useEffect(() => {
    if (!activeProjectId || treeFilterDraft === storedTreeFilter) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void window.workbench.updateUiState(activeProjectId, { treeFilter: treeFilterDraft });
    }, 140);

    return () => window.clearTimeout(timeoutId);
  }, [activeProjectId, storedTreeFilter, treeFilterDraft]);

  const importantPathSummaries = useMemo(
    () =>
      activeProject?.record.summaryCache
        .slice()
        .sort((left, right) => {
          if (left.source === right.source) {
            return left.relativePath.localeCompare(right.relativePath);
          }
          return left.source === "hybrid" || left.source === "codex" ? -1 : 1;
        })
        .slice(0, 10) ?? [],
    [activeProject]
  );

  const preferredPendingCandidate = useMemo(
    () => pendingLoad ? [...pendingLoad.interfaceCandidates].sort((left, right) => candidateRank(left) - candidateRank(right))[0] : undefined,
    [pendingLoad]
  );

  const recentProjects = useMemo(
    () =>
      state
        ? [...state.projects].sort((left, right) => {
          const leftTime = left.record.localState.lastOpenedAt ? new Date(left.record.localState.lastOpenedAt).getTime() : 0;
          const rightTime = right.record.localState.lastOpenedAt ? new Date(right.record.localState.lastOpenedAt).getTime() : 0;
          return rightTime - leftTime;
        })
        : [],
    [state]
  );

  const showInfoNotice = (message: string) => {
    setNotice({ message, tone: "info" });
  };

  const handleError = (error: unknown) => {
    setNotice({ message: error instanceof Error ? error.message : String(error), tone: "error" });
  };

  const refreshGitHubStatus = async () => {
    try {
      setNotice(undefined);
      await window.workbench.refreshGitHubStatus();
      showInfoNotice("GitHub status refreshed.");
    } catch (error) {
      handleError(error);
    }
  };

  const openFolder = async (intent: "open" | "create" = "open") => {
    try {
      const folder = await window.workbench.chooseFolder();
      if (!folder) {
        return;
      }
      setProjectLoadBusy(intent);
      setLaunchIntent(intent);
      setNotice(undefined);
      setShowExistingChoice(false);
      setFileSummary(null);
      setSelectedFile(undefined);
      setPendingLoad(await window.workbench.loadProject(folder, intent));
    } catch (error) {
      handleError(error);
    } finally {
      setProjectLoadBusy(null);
    }
  };

  const openRecentProject = async (projectId: string) => {
    try {
      setNotice(undefined);
      setPendingLoad(null);
      setShowExistingChoice(false);
      setFileSummary(null);
      setSelectedFile(undefined);
      setOpeningRecentProjectId(projectId);
      await window.workbench.openProject(projectId);
    } catch (error) {
      handleError(error);
    } finally {
      setOpeningRecentProjectId(undefined);
    }
  };

  const showLauncher = async () => {
    try {
      setNotice(undefined);
      setPendingLoad(null);
      setProjectLoadBusy(null);
      setOpeningRecentProjectId(undefined);
      setShowExistingChoice(false);
      setLaunchIntent("open");
      setFileSummary(null);
      setSelectedFile(undefined);
      await window.workbench.showLauncher();
    } catch (error) {
      handleError(error);
    }
  };

  const importBundle = async () => {
    try {
      setProjectLoadBusy("import");
      setLaunchIntent("open");
      setNotice(undefined);
      const imported = await window.workbench.importInterfaceBundle();
      if (!imported) {
        return;
      }
      setPendingLoad(null);
      setShowExistingChoice(false);
    } catch (error) {
      handleError(error);
    } finally {
      setProjectLoadBusy(null);
    }
  };

  const exportInterfaceToProject = async () => {
    if (!activeProject) {
      return;
    }

    try {
      setNotice(undefined);
      const exportPath = await window.workbench.exportInterface(activeProject.record.id);
      showInfoNotice(`Exported the portable interface to ${exportPath}.`);
    } catch (error) {
      handleError(error);
    }
  };

  const downloadInterface = async () => {
    if (!activeProject) {
      return;
    }

    try {
      setNotice(undefined);
      const exportPath = await window.workbench.downloadInterface(activeProject.record.id);
      if (!exportPath) {
        return;
      }
      showInfoNotice(`Saved a shareable interface file to ${exportPath}.`);
    } catch (error) {
      handleError(error);
    }
  };

  const downloadLogs = async () => {
    if (!activeProject) {
      return;
    }

    try {
      setNotice(undefined);
      const exportPath = await window.workbench.downloadLogs(activeProject.record.id);
      if (!exportPath) {
        return;
      }
      showInfoNotice(`Saved review logs to ${exportPath}. Paths were redacted, but command output may still contain sensitive content.`);
    } catch (error) {
      handleError(error);
    }
  };

  const downloadRepairReport = () => {
    if (!activeProject || !workflow) {
      return;
    }

    try {
      setNotice(undefined);
      const markdown = buildRepairReportMarkdown(activeProject.record.identity.projectName, workflow, workflowAgents);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const fileName = `${sanitizeReportName(activeProject.record.identity.projectName)}-cycle-${workflow.workflowCycle.cycleNumber}-repair-report-${timestamp}.md`;
      const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
      const downloadUrl = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = downloadUrl;
      anchor.download = fileName;
      anchor.click();
      window.setTimeout(() => window.URL.revokeObjectURL(downloadUrl), 0);
      showInfoNotice(`Downloaded repair report as ${fileName}.`);
    } catch (error) {
      handleError(error);
    }
  };

  const downloadUltimateGoalFormat = () => {
    const projectName = activeProject?.record.identity.projectName ?? "project";

    try {
      setNotice(undefined);
      const fileName = `${sanitizeReportName(projectName)}-ultimate-goal-format.txt`;
      const blob = new Blob([buildUltimateGoalFormatGuide(projectName)], { type: "text/plain;charset=utf-8" });
      const downloadUrl = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = downloadUrl;
      anchor.download = fileName;
      anchor.click();
      window.setTimeout(() => window.URL.revokeObjectURL(downloadUrl), 0);
      showInfoNotice(`Downloaded Ultimate Goal authoring format as ${fileName}.`);
    } catch (error) {
      handleError(error);
    }
  };

  const refreshOverview = async () => {
    if (!activeProject) {
      return;
    }

    try {
      setOverviewRefreshBusy(true);
      setNotice(undefined);
      await window.workbench.refreshOverview(activeProject.record.id);
      showInfoNotice("Overview refresh started. The interface-creation agent is reanalyzing the repository.");
    } catch (error) {
      handleError(error);
    } finally {
      setOverviewRefreshBusy(false);
    }
  };

  const selectCandidate = async (candidate: InterfaceCandidate) => {
    try {
      setProjectLoadBusy("open");
      setNotice(undefined);
      await window.workbench.selectInterface(candidate.source, candidate.path);
      setPendingLoad(null);
      setShowExistingChoice(false);
    } catch (error) {
      handleError(error);
    } finally {
      setProjectLoadBusy(null);
    }
  };

  const createFresh = async () => {
    try {
      setProjectLoadBusy("create");
      setNotice(undefined);
      await window.workbench.selectInterface("fresh");
      setPendingLoad(null);
      setShowExistingChoice(false);
    } catch (error) {
      handleError(error);
    } finally {
      setProjectLoadBusy(null);
    }
  };

  const openPreferredExistingInterface = async () => {
    if (!preferredPendingCandidate) {
      return;
    }
    await selectCandidate(preferredPendingCandidate);
  };

  const replaceExistingInterface = async () => {
    try {
      setNotice(undefined);
      await window.workbench.selectInterface("fresh", undefined, "replace");
      setPendingLoad(null);
      setShowExistingChoice(false);
    } catch (error) {
      handleError(error);
    }
  };

  const duplicateExistingInterface = async () => {
    try {
      setNotice(undefined);
      await window.workbench.selectInterface("fresh", undefined, "duplicate");
      setPendingLoad(null);
      setShowExistingChoice(false);
    } catch (error) {
      handleError(error);
    }
  };

  const loadSummary = async (relativePath: string) => {
    if (!activeProject) {
      return;
    }

    try {
      setNotice(undefined);
      setSelectedFile(relativePath);
      const [summary] = await Promise.all([
        window.workbench.getFileSummary(activeProject.record.id, relativePath),
        window.workbench.updateUiState(activeProject.record.id, { selectedFile: relativePath })
      ]);
      setFileSummary(summary);
    } catch (error) {
      handleError(error);
    }
  };

  const selectAgent = async (agentId: string) => {
    if (!activeProject) {
      return;
    }

    try {
      setFocusedAgentId(agentId);
      await window.workbench.updateUiState(activeProject.record.id, { activeAgentId: agentId });
    } catch (error) {
      handleError(error);
    }
  };

  const createCodingAgent = async () => {
    if (!activeProject) {
      return;
    }

    try {
      setNotice(undefined);
      await window.workbench.createAgent(
        activeProject.record.id,
        "coding",
        codingAgentForm.name,
        codingAgentForm.prompt,
        codingAgentForm.model,
        codingAgentForm.reasoningMode,
        codingAgentForm.reasoningMode === "manual" ? codingAgentForm.reasoningEffort : undefined
      );
      setCodingAgentForm((current) => ({ ...current, prompt: "" }));
    } catch (error) {
      handleError(error);
    }
  };

  const createManualAgent = async () => {
    if (!activeProject) {
      return;
    }

    try {
      setNotice(undefined);
      await window.workbench.createAgent(
        activeProject.record.id,
        "manual",
        buildManualAgentName(manualAgentPrompt),
        manualAgentPrompt,
        manualAgentModel,
        manualAgentReasoningMode,
        manualAgentReasoningMode === "manual" ? manualAgentReasoningEffort : undefined
      );
      setManualAgentPrompt("");
    } catch (error) {
      handleError(error);
    }
  };

  const runRecommendation = async (customFocus?: string) => {
    if (!activeProject) {
      return;
    }

    try {
      setNotice(undefined);
      await window.workbench.runRecommendation(activeProject.record.id, customFocus?.trim() || undefined);
    } catch (error) {
      handleError(error);
    }
  };

  const toggleAutopilot = async () => {
    if (!activeProject) {
      return;
    }

    try {
      setNotice(undefined);
      await window.workbench.updateUiState(activeProject.record.id, {
        autopilotEnabled: !autopilotEnabled
      });
      showInfoNotice(!autopilotEnabled ? "Autopilot enabled." : "Autopilot disabled.");
    } catch (error) {
      handleError(error);
    }
  };

  const toggleOptimizeMode = async () => {
    if (!activeProject) {
      return;
    }

    try {
      const enabling = !optimizeModeEnabled;
      setNotice(undefined);
      await window.workbench.updateUiState(activeProject.record.id, {
        workflowObjective: enabling ? "optimize" : "deliver",
        autopilotEnabled: enabling ? true : autopilotEnabled,
        workflowPauseRequested: enabling ? false : workflowPauseRequested
      });
      showInfoNotice(
        enabling
          ? "Optimize mode enabled. Autopilot is on and the workflow will keep searching for bounded improvements."
          : "Optimize mode disabled. The workflow will stop once the stated Ultimate Goal is satisfied."
      );
    } catch (error) {
      handleError(error);
    }
  };

  const toggleWorkflowPause = async () => {
    if (!activeProject) {
      return;
    }

    try {
      setNotice(undefined);
      await window.workbench.updateUiState(activeProject.record.id, {
        workflowPauseRequested: !workflowPauseRequested
      });
      showInfoNotice(
        workflowPauseRequested
          ? "Workflow automation resumed."
          : workflowHasActiveAgent
            ? "Workflow will pause after the current agent finishes."
            : "Workflow paused."
      );
    } catch (error) {
      handleError(error);
    }
  };

  const recoverWorkflow = async () => {
    if (!activeProject) {
      return;
    }

    try {
      setNotice(undefined);
      await window.workbench.recoverWorkflow(activeProject.record.id);
      showInfoNotice("Workflow recovery started from the saved state.");
    } catch (error) {
      handleError(error);
    }
  };

  const retryWorkflowGoal = async () => {
    if (!activeProject) {
      return;
    }

    const retryingMerge = isMergeConflictHandoff(activeProject.record.workflow);
    const retryingValidation = isEnvironmentRepairHandoff(activeProject.record.workflow);
    try {
      setNotice(undefined);
      await window.workbench.retryWorkflowGoal(activeProject.record.id);
      showInfoNotice(
        retryingMerge
          ? "Retrying the merge after conflict resolution."
          : retryingValidation
          ? "Retrying validation after the environment fix."
          : "Retrying the current scoped goal."
      );
    } catch (error) {
      handleError(error);
    }
  };

  const saveUltimateGoal = async () => {
    if (!activeProject) {
      return;
    }

    try {
      setNotice(undefined);
      await window.workbench.updateUltimateGoal(
        activeProject.record.id,
        {
          summary: ultimateGoalDraft.summary.trim(),
          detailedIntent: ultimateGoalDraft.detailedIntent.trim(),
          successCriteria: toLineList(ultimateGoalDraft.successCriteria),
          constraints: toLineList(ultimateGoalDraft.constraints),
          nonGoals: toLineList(ultimateGoalDraft.nonGoals),
          targetAudience: ultimateGoalDraft.targetAudience.trim(),
          qualityBar: ultimateGoalDraft.qualityBar.trim(),
          source: "user"
        },
        true
      );
      setUltimateGoalImportPreview(null);
      showInfoNotice("Ultimate Goal confirmed.");
    } catch (error) {
      handleError(error);
    }
  };

  const detectUltimateGoal = async () => {
    if (!activeProject) {
      return;
    }

    try {
      setNotice(undefined);
      const detected = await window.workbench.detectUltimateGoal(activeProject.record.id);
      setUltimateGoalDraft({
        summary: detected.summary,
        detailedIntent: detected.detailedIntent,
        successCriteria: fromLineList(detected.successCriteria),
        constraints: fromLineList(detected.constraints),
        nonGoals: fromLineList(detected.nonGoals),
        targetAudience: detected.targetAudience,
        qualityBar: detected.qualityBar
      });
      setUltimateGoalImportPreview(null);
      showInfoNotice("Ultimate Goal draft detected. Confirm it to move the workflow forward.");
    } catch (error) {
      handleError(error);
    }
  };

  const importUltimateGoalText = async () => {
    if (!activeProject) {
      return;
    }

    try {
      setNotice(undefined);
      const imported = await window.workbench.importUltimateGoalText(activeProject.record.id);
      if (!imported) {
        return;
      }
      setUltimateGoalDraft({
        summary: imported.goal.summary,
        detailedIntent: imported.goal.detailedIntent,
        successCriteria: fromLineList(imported.goal.successCriteria),
        constraints: fromLineList(imported.goal.constraints),
        nonGoals: fromLineList(imported.goal.nonGoals),
        targetAudience: imported.goal.targetAudience,
        qualityBar: imported.goal.qualityBar
      });
      setUltimateGoalImportPreview(imported);
      showInfoNotice(
        imported.completeness === "complete"
          ? `Imported Ultimate Goal draft from ${imported.sourceFileName}.`
          : `Imported a partial Ultimate Goal draft from ${imported.sourceFileName}. Review the missing sections before confirming.`
      );
    } catch (error) {
      handleError(error);
    }
  };

  const loadDetectedGoalDraft = () => {
    const detected = activeProject?.record.workflow.ultimateGoalDraft;
    if (!detected) {
      return;
    }

    setUltimateGoalDraft({
      summary: detected.summary,
      detailedIntent: detected.detailedIntent,
      successCriteria: fromLineList(detected.successCriteria),
      constraints: fromLineList(detected.constraints),
      nonGoals: fromLineList(detected.nonGoals),
      targetAudience: detected.targetAudience,
      qualityBar: detected.qualityBar
    });
    setUltimateGoalImportPreview(null);
  };

  const approveRecommendation = async (recommendationId: string) => {
    if (!activeProject) {
      return;
    }

    try {
      setNotice(undefined);
      await window.workbench.approveRecommendation(activeProject.record.id, recommendationId);
    } catch (error) {
      handleError(error);
    }
  };

  const createScopedGoal = async () => {
    if (!activeProject) {
      return;
    }

    try {
      setNotice(undefined);
      await window.workbench.createScopedGoal(activeProject.record.id);
    } catch (error) {
      handleError(error);
    }
  };

  const advanceWorkflowStage = async () => {
    if (!activeProject) {
      return;
    }

    try {
      setNotice(undefined);
      await window.workbench.advanceWorkflowStage(activeProject.record.id);
    } catch (error) {
      handleError(error);
    }
  };

  const resolveHumanIntervention = async (interventionId: string, status: "resolved" | "dismissed" = "resolved") => {
    if (!activeProject) {
      return;
    }

    try {
      setNotice(undefined);
      await window.workbench.resolveHumanIntervention(
        activeProject.record.id,
        interventionId,
        status,
        interventionNotes[interventionId]?.trim() ?? ""
      );
      setInterventionNotes((current) => {
        const next = { ...current };
        delete next[interventionId];
        return next;
      });
    } catch (error) {
      handleError(error);
    }
  };

  const updateUserInputDraft = (requestId: string, questionId: string, value: string) => {
    setUserInputDrafts((current) => ({
      ...current,
      [requestId]: {
        ...(current[requestId] ?? {}),
        [questionId]: value
      }
    }));
  };

  const openUserInputRequestInbox = async (requestId: string) => {
    if (!activeProject) {
      return;
    }

    try {
      setNotice(undefined);
      await window.workbench.openUserInputRequestInbox(activeProject.record.id, requestId);
      setNotice({ message: "Opened the attachment inbox for this request.", tone: "info" });
    } catch (error) {
      handleError(error);
    }
  };

  const addUserInputRequestAttachments = async (requestId: string) => {
    if (!activeProject) {
      return;
    }

    try {
      setUserInputAttachmentBusyId(requestId);
      setNotice(undefined);
      await window.workbench.addUserInputRequestAttachments(activeProject.record.id, requestId);
    } catch (error) {
      handleError(error);
    } finally {
      setUserInputAttachmentBusyId((current) => current === requestId ? undefined : current);
    }
  };

  const submitUserInputRequest = async (request: UserInputRequestRecord) => {
    if (!activeProject) {
      return;
    }

    const answers = request.questions.map((question) => userInputDrafts[request.id]?.[question.id]?.trim() ?? "");
    const missingQuestion = request.questions.find((question, index) => !answers[index]);
    if (missingQuestion) {
      setNotice({ message: `Answer required for "${missingQuestion.header}".`, tone: "error" });
      return;
    }

    try {
      setUserInputSubmitBusyId(request.id);
      setNotice(undefined);
      await window.workbench.submitUserInputRequest(activeProject.record.id, request.id, answers);
      setUserInputDrafts((current) => {
        const next = { ...current };
        delete next[request.id];
        return next;
      });
      setNotice({ message: "Submitted your response to the agent.", tone: "info" });
    } catch (error) {
      handleError(error);
    } finally {
      setUserInputSubmitBusyId((current) => current === request.id ? undefined : current);
    }
  };

  const openProjectShell = async () => {
    if (!activeProject) {
      return;
    }

    try {
      setShellLaunchBusy(true);
      setNotice(undefined);
      const result = await window.workbench.openProjectShell(activeProject.record.id);
      setNotice({ message: result.message, tone: result.launched ? "info" : "error" });
    } catch (error) {
      handleError(error);
    } finally {
      setShellLaunchBusy(false);
    }
  };

  const saveSettings = async () => {
    try {
      setNotice(undefined);
      await window.workbench.updateSettings({
        executionMode: settingsDraft.executionMode,
        distroName: settingsDraft.distroName.trim(),
        codexBinaryPath: settingsDraft.codexBinaryPath.trim(),
        codexHome: settingsDraft.codexHome.trim() || undefined,
        worktreeBaseDir: settingsDraft.worktreeBaseDir.trim(),
        warnOnMntMount: settingsDraft.warnOnMntMount,
        maxRepairCycles: settingsDraft.maxRepairCycles,
        interfaceCreationModel: settingsDraft.interfaceCreationModel || undefined,
        interfaceCreationReasoningEffort: settingsDraft.agentReasoningEfforts.bootstrap ?? settingsDraft.interfaceCreationReasoningEffort,
        agentReasoningMode: settingsDraft.agentReasoningMode,
        agentReasoningEfforts: settingsDraft.agentReasoningEfforts,
        autoApproveCommands: settingsDraft.autoApproveCommands,
        autoApproveGitCommits: settingsDraft.autoApproveGitCommits,
        autoApproveGitPushes: settingsDraft.autoApproveGitPushes,
        considerPaidServices: settingsDraft.considerPaidServices
      });
      setShowSettings(false);
    } catch (error) {
      handleError(error);
    }
  };

  const openDevTools = async () => {
    try {
      const opened = await window.workbench.openDevTools();
      setNotice({
        message: opened ? "Developer Tools opened." : "Developer Tools could not be opened because no main window is active.",
        tone: opened ? "info" : "error"
      });
    } catch (error) {
      handleError(error);
    }
  };

  const quitApp = async () => {
    try {
      setNotice(undefined);
      await window.workbench.quit();
    } catch (error) {
      handleError(error);
    }
  };

  if (!state) {
    return (
      <div className="shell shell--loader">
        <div className="loader-card loader-card--wide">
          <BrandHeader
            title={APP_NAME}
            subtitle="Preparing workspace"
            actions={<div className="badge">Loading</div>}
          />
          <div className="empty-state">
            <LoadingIndicator label={initialStateLoading ? "Loading workbench state and recent projects" : "Buffering workspace state"} />
          </div>
        </div>
      </div>
    );
  }

  const settingsDialog = showSettings && state ? (
    <SettingsDialog
      state={state}
      github={state.github}
      settingsDraft={settingsDraft}
      onChange={(next) => setSettingsDraft((current) => {
        const nextModel = next.interfaceCreationModel ?? current.interfaceCreationModel;
        const nextReasoning = resolveInterfaceCreationReasoningEffort(
          modelOptionsByName.get(nextModel),
          next.interfaceCreationReasoningEffort ?? current.interfaceCreationReasoningEffort
        ) ?? current.interfaceCreationReasoningEffort;
        const rawAgentReasoningEfforts = normalizeAgentReasoningEfforts(
          next.agentReasoningEfforts ?? current.agentReasoningEfforts
        );
        const nextAgentReasoningEfforts = Object.fromEntries(
          configurableAgentCategories.map((category) => [
            category,
            resolveAgentReasoningEffort(modelOptionsByName.get(nextModel), category, agentCategoryLabel(category), "manual", rawAgentReasoningEfforts[category])
          ])
        ) as Record<AgentCategory, InterfaceReasoningEffort>;
        return {
          executionMode: next.executionMode ?? current.executionMode,
          distroName: next.distroName ?? current.distroName,
          codexBinaryPath: next.codexBinaryPath ?? current.codexBinaryPath,
          codexHome: next.codexHome ?? current.codexHome,
          worktreeBaseDir: next.worktreeBaseDir ?? current.worktreeBaseDir,
          warnOnMntMount: next.warnOnMntMount ?? current.warnOnMntMount,
          maxRepairCycles: next.maxRepairCycles ?? current.maxRepairCycles,
          interfaceCreationModel: nextModel,
          interfaceCreationReasoningEffort: nextAgentReasoningEfforts.bootstrap ?? nextReasoning,
          agentReasoningMode: next.agentReasoningMode ?? current.agentReasoningMode,
          agentReasoningEfforts: nextAgentReasoningEfforts,
          autoApproveCommands: next.autoApproveCommands ?? current.autoApproveCommands,
          autoApproveGitCommits: next.autoApproveGitCommits ?? current.autoApproveGitCommits,
          autoApproveGitPushes: next.autoApproveGitPushes ?? current.autoApproveGitPushes,
          considerPaidServices: next.considerPaidServices ?? current.considerPaidServices
        };
      })}
      onSave={saveSettings}
      onClose={() => setShowSettings(false)}
      onOpenDevTools={() => void openDevTools()}
      onRefreshGitHubStatus={() => void refreshGitHubStatus()}
    />
  ) : null;

  if (pendingLoad) {
    const hasCandidates = pendingLoad.interfaceCandidates.length > 0;
    const pendingTitle = hasCandidates
      ? launchIntent === "create"
        ? "Choose a Starting Point"
        : "Existing Interface Found"
      : launchIntent === "create"
        ? "New Workspace Ready"
        : "New Project Ready";
    const pendingLead = hasCandidates
      ? launchIntent === "create"
        ? "You asked to create a new workspace. We found saved interface data for this folder, so choose whether to reuse it or deliberately create a new version."
        : "We found saved interface data for this project. Choose the best match or start a new version deliberately."
      : launchIntent === "create"
        ? "This folder is ready for a fresh project interface."
        : "No saved interface was detected for this project. You can generate a fresh interface immediately.";

    return (
      <div className="shell shell--loader">
        <div className="loader-card">
          <BrandHeader
            title={pendingTitle}
            subtitle="Project intake"
            actions={
              <div className="actions-row">
                <button className="secondary-button" onClick={() => void showLauncher()}>Home</button>
                <button className="secondary-button" onClick={() => setShowSettings(true)}>Settings</button>
              </div>
            }
          />
          <section className="hero-card hero-card--intake">
            <div className="hero-card__content">
              <p className="hero-card__lead">{pendingLead}</p>
              <div className="stat-strip">
                <div className="metric-card">
                  <span className="metric-card__label">Files scanned</span>
                  <strong>{pendingLoad.stats.totalFiles}</strong>
                  <span>{pendingLoad.stats.includedFiles} indexed</span>
                </div>
                <div className="metric-card">
                  <span className="metric-card__label">Included size</span>
                  <strong>{formatBytes(pendingLoad.stats.includedSizeBytes)}</strong>
                  <span>{pendingLoad.stats.includedFolders} indexed folders</span>
                </div>
                <div className="metric-card">
                  <span className="metric-card__label">Excluded</span>
                  <strong>{pendingLoad.stats.excludedFiles}</strong>
                  <span>{formatBytes(pendingLoad.stats.excludedSizeBytes)}</span>
                </div>
                <div className="metric-card">
                  <span className="metric-card__label">Dependencies</span>
                  <strong>{pendingLoad.dependencies.length}</strong>
                  <span>{pendingLoad.stats.testsPresent ? "Tests detected" : "Tests not found"}</span>
                </div>
              </div>
            </div>
          </section>
          {notice ? <div className={notice.tone === "error" ? "notice notice--error" : "notice"}>{notice.message}</div> : null}
          {hasCandidates ? (
            <div className="loader-grid">
              {pendingLoad.interfaceCandidates.map((candidate) => (
                <CandidateCard key={`${candidate.source}-${candidate.path}`} candidate={candidate} onUse={selectCandidate} />
              ))}
            </div>
          ) : (
            <div className="overview-card">
              <p>{pendingLoad.stats.explanation}</p>
              <p>
                Indexed {pendingLoad.stats.includedFiles} files ({formatBytes(pendingLoad.stats.includedSizeBytes)}) and excluded{" "}
                {pendingLoad.stats.excludedFiles} files ({formatBytes(pendingLoad.stats.excludedSizeBytes)}) using built-in defaults and any
                project <code>.gitignore</code> rules.
              </p>
              <div className="tag-row">
                {getTopFileTypes(pendingLoad.stats.fileTypeBreakdown).map(([label, count]) => (
                  <span key={label} className="tag">{label}: {count}</span>
                ))}
              </div>
            </div>
          )}
          <div className="actions-row">
            <button className="primary-button" onClick={hasCandidates ? () => setShowExistingChoice(true) : () => void createFresh()}>Create New Interface</button>
            <button className="secondary-button" onClick={() => void importBundle()}>Import Interface</button>
            <button className="secondary-button" onClick={() => void showLauncher()}>Back to Launcher</button>
            <button className="secondary-button" onClick={() => void quitApp()}>Exit App</button>
          </div>
        </div>
        {hasCandidates && showExistingChoice ? (
          <div className="settings-modal">
            <div className="settings-panel settings-panel--narrow">
              <SectionTitle eyebrow="Resolution" title="Existing Interface Choices" />
              <p className="settings-panel__copy">Choose how to proceed for this project without creating unnecessary duplicate records.</p>
              <div className="overview-card">
                <div className="candidate-card__title-row">
                  <strong>Best existing match</strong>
                  {preferredPendingCandidate ? <ValidationBadge status={preferredPendingCandidate.validationStatus} /> : null}
                </div>
                <p>{preferredPendingCandidate?.preview.summarySnippet ?? "No candidate available."}</p>
              </div>
              <div className="actions-grid">
                <button className="primary-button" onClick={() => void openPreferredExistingInterface()}>Use Existing Interface</button>
                <button className="secondary-button" onClick={() => void replaceExistingInterface()}>Regenerate / Replace Existing Interface</button>
                <button className="secondary-button" onClick={() => void duplicateExistingInterface()}>Create New Version / Duplicate</button>
              </div>
              <div className="notice">
                <p><code>Use Existing Interface</code> opens the best saved match.</p>
                <p><code>Regenerate / Replace Existing Interface</code> reuses the existing local record when one exists.</p>
                <p><code>Create New Version / Duplicate</code> creates an additional local interface record on purpose.</p>
              </div>
              <div className="actions-row">
                <button className="secondary-button" onClick={() => setShowExistingChoice(false)}>Close</button>
              </div>
            </div>
          </div>
        ) : null}
        {settingsDialog}
      </div>
    );
  }

  if (!activeProject) {
    return (
      <div className="shell shell--launcher">
        <div className="loader-card loader-card--wide launcher-shell">
          <BrandHeader
            title={APP_NAME}
            subtitle="Desktop launcher"
            actions={
              <div className="actions-row">
                <button className="secondary-button" onClick={() => setShowSettings(true)}>Open Settings</button>
                <button className="secondary-button" onClick={() => void quitApp()}>Exit App</button>
              </div>
            }
          />
          <section className="hero-card launcher-hero">
            <div className="hero-card__content">
              <div className="eyebrow">Start here</div>
              <h2>Open a GitHub repository, create a new GitHub workspace, or resume a recent workspace.</h2>
              <p className="hero-card__lead">
                The workbench now starts from a proper launcher so GitHub linking, project selection, imports, and settings all begin from one clear home screen.
              </p>
              <div className="actions-row">
                <button className="primary-button" disabled={launcherActionsLocked || Boolean(projectLoadBusy)} onClick={() => void openFolder("open")}>
                  {projectLoadBusy === "open" ? <LoadingIndicator label="Opening" compact /> : "Open GitHub Repo"}
                </button>
                <button className="secondary-button" disabled={createWorkspaceLocked || Boolean(projectLoadBusy)} onClick={() => void openFolder("create")}>
                  {projectLoadBusy === "create" ? <LoadingIndicator label="Creating" compact /> : "Create New Workspace"}
                </button>
              </div>
            </div>
            <div className="hero-card__aside">
              <div className="metric-card">
                <span className="metric-card__label">Recent projects</span>
                <strong>{recentProjects.length}</strong>
                <span>{recentProjects.length ? "Ready to reopen in this window" : "No saved workspaces yet"}</span>
              </div>
              <div className="notice">{availabilityMessage(state)}</div>
            </div>
          </section>
          {notice ? <div className={notice.tone === "error" ? "notice notice--error" : "notice"}>{notice.message}</div> : null}
          {projectLoadBusy ? (
            <div className="notice notice--status notice--running">
              <LoadingIndicator
                label={
                  projectLoadBusy === "create"
                    ? "Preparing workspace and scanning repository"
                    : projectLoadBusy === "import"
                      ? "Importing portable interface"
                      : "Opening project and scanning repository"
                }
              />
            </div>
          ) : null}
          {!githubLinked && githubStatus ? <div className="notice notice--error">{githubStatus.message}</div> : null}
          {githubStatus?.state === "needs_ssh" ? <div className="notice">{githubStatus.message}</div> : null}
          <section className="launcher-grid">
            <div className="launcher-actions">
              <LauncherActionCard
                eyebrow="Primary"
                title="Open GitHub Repo"
                copy="Choose a GitHub-backed repository folder and load it into this window without spawning a second blank workspace."
                actionLabel="Choose Folder"
                onAction={() => void openFolder("open")}
                featured
                disabled={launcherActionsLocked || Boolean(projectLoadBusy)}
              />
              <LauncherActionCard
                eyebrow="Create"
                title="New GitHub Workspace"
                copy="Start from a folder selection, initialize a GitHub SSH repository when needed, and generate a fresh interface or deliberately replace an older saved version."
                actionLabel="Start New Workspace"
                onAction={() => void openFolder("create")}
                disabled={createWorkspaceLocked || Boolean(projectLoadBusy)}
              />
              <LauncherActionCard
                eyebrow="Import"
                title="Import Interface"
                copy="Bring in a portable interface file, validate it against a project folder, and open the result in the same window."
                actionLabel="Import Interface"
                onAction={() => void importBundle()}
                disabled={launcherActionsLocked || Boolean(projectLoadBusy)}
              />
              <LauncherActionCard
                eyebrow="Preferences"
                title="Settings"
                copy="Update interface creation defaults, inspect model availability, or open Developer Tools manually when needed."
                actionLabel="Open Settings"
                onAction={() => setShowSettings(true)}
              />
            </div>
            <section className="panel panel--recent launcher-recents">
              <SectionTitle eyebrow="Reopen" title="Recent Projects" />
              <div className="recent-list">
                {recentProjects.length ? recentProjects.map((project) => (
                  <button
                    key={project.record.id}
                    className="recent-project"
                    disabled={launcherActionsLocked || Boolean(openingRecentProjectId)}
                    onClick={() => void openRecentProject(project.record.id)}
                  >
                    <div>
                      <strong>{project.record.identity.projectName}</strong>
                      <div className="recent-project__path">{project.record.displayPath}</div>
                    </div>
                    <div className="recent-project__meta">
                      {openingRecentProjectId === project.record.id ? (
                        <LoadingIndicator label="Opening" compact />
                      ) : (
                        <span>{formatDateTime(project.record.localState.lastOpenedAt)}</span>
                      )}
                      <ValidationBadge status={project.validationStatus} />
                    </div>
                  </button>
                )) : <div className="empty-copy">No saved projects yet. Open a folder to create the first workspace.</div>}
              </div>
            </section>
          </section>
        </div>
        {settingsDialog}
      </div>
    );
  }

  return (
    <div className="shell">
      <BrandHeader
        title={APP_NAME}
        subtitle="Professional agent workspace"
        actions={
          <div className="actions-row">
            <button className="secondary-button" onClick={() => void showLauncher()}>Home</button>
            <button className="secondary-button" onClick={() => setShowSettings(true)}>Settings</button>
            <button className="secondary-button" disabled={!githubLinked} onClick={() => void openFolder("open")}>Open Another Folder</button>
            <button className="secondary-button" onClick={() => void exportInterfaceToProject()}>Export to Project</button>
            <button className="secondary-button" onClick={() => void downloadInterface()}>Download Interface</button>
            <button className="secondary-button" onClick={() => void downloadLogs()}>Download Logs</button>
            <button className="secondary-button" disabled={overviewRefreshRunning} onClick={() => void refreshOverview()}>Refresh Overview</button>
            <button className="secondary-button" onClick={() => void window.workbench.revalidate(activeProject.record.id)}>Revalidate</button>
            <button className="secondary-button" onClick={() => void quitApp()}>Exit App</button>
          </div>
        }
      />

      <section className="project-hero">
        <div className="project-hero__main">
          <div className="eyebrow">Active project</div>
          <h2>{activeProject.record.identity.projectName}</h2>
          <p className="project-hero__summary">
            {activeProject.record.overview?.summary ?? activeProject.record.stats?.explanation ?? "Interface creation is still in progress for this project."}
          </p>
          <div className="topbar__meta">
            <ValidationBadge status={activeProject.validationStatus} />
            <span>{activeProject.record.validation.branch ?? activeProject.record.validation.projectKind}</span>
            <span>{activeProject.record.displayPath}</span>
          </div>
        </div>
        <div className="project-hero__stats">
          <div className="metric-card">
            <span className="metric-card__label">Project files</span>
            <strong>{activeProject.record.stats?.totalFiles ?? 0}</strong>
            <span>{activeProject.record.stats?.includedFiles ?? 0} indexed • {activeProject.record.stats?.excludedFiles ?? 0} excluded</span>
          </div>
          <div className="metric-card">
            <span className="metric-card__label">Indexed size</span>
            <strong>{formatBytes(activeProject.record.stats?.includedSizeBytes ?? 0)}</strong>
            <span>Full project {formatBytes(activeProject.record.stats?.totalSizeBytes ?? 0)}</span>
          </div>
          <div className="metric-card">
            <span className="metric-card__label">Dependencies</span>
            <strong>{activeProject.record.dependencies.length}</strong>
            <span>{activeProject.record.stats?.primaryManagers?.join(", ") || "Unknown toolchain"}</span>
          </div>
          <div className="metric-card">
            <span className="metric-card__label">Agents</span>
            <strong>{activeProject.record.agents.length}</strong>
            <span>{pendingApprovals.length} approvals pending • {activeProject.record.stats?.testsPresent ? "tests detected" : "tests not detected"}</span>
          </div>
        </div>
      </section>

      {notice ? <div className={notice.tone === "error" ? "notice notice--error" : "notice"}>{notice.message}</div> : null}
      {activeProject.record.validation.projectAccess ? (
        <section
          className={
            activeProject.record.validation.projectAccess.status === "failed"
              ? "notice notice--error"
              : "notice notice--status notice--completed"
          }
        >
          <strong>Project Access Check</strong>
          <p>{activeProject.record.validation.projectAccess.message}</p>
          {activeProject.record.validation.projectAccess.error ? <div>{activeProject.record.validation.projectAccess.error}</div> : null}
        </section>
      ) : null}
      {activeProject.record.interfaceCreation ? (
        <section className={`notice notice--status notice--${activeProject.record.interfaceCreation.status}`}>
          <div className="candidate-card__title-row">
            <strong>Creating Interface</strong>
            <span className={`status-pill status-${activeProject.record.interfaceCreation.status}`}>{activeProject.record.interfaceCreation.status}</span>
          </div>
          {activeProject.record.interfaceCreation.status === "queued" || activeProject.record.interfaceCreation.status === "running" ? (
            <LoadingIndicator label={activeProject.record.interfaceCreation.message} />
          ) : null}
          <div>{activeProject.record.interfaceCreation.phase}</div>
          <p>{activeProject.record.interfaceCreation.message}</p>
          <div className="candidate-card__meta">
            <span>Model: {activeProject.record.interfaceCreation.model ?? "Unavailable"}</span>
            <span>Reasoning: {activeProject.record.interfaceCreation.reasoningEffort ?? "default"}</span>
            <SourceBadge source={activeProject.record.interfaceCreation.outputSource} />
          </div>
          <div className="candidate-card__meta">
            <span>Deterministic scan: {activeProject.record.interfaceCreation.deterministicScanReady ? "ready" : "pending"}</span>
            <span>Agent analysis: {activeProject.record.interfaceCreation.agentAnalysisReady ? "ready" : "pending"}</span>
          </div>
          {activeProject.record.interfaceCreation.lastError ? <div>{activeProject.record.interfaceCreation.lastError}</div> : null}
        </section>
      ) : null}

      <main className="project-workbench">
        <div className="workspace-tabs">
          <WorkspaceTabButton
            label="Overview"
            active={activeWorkspaceTab === "overview"}
            onClick={() => void setWorkspaceTab("overview")}
          />
          <WorkspaceTabButton
            label="Workflow"
            active={activeWorkspaceTab === "workflow"}
            count={pendingUserInputRequests.length + pendingHumanInterventions.length}
            onClick={() => void setWorkspaceTab("workflow")}
          />
          <WorkspaceTabButton
            label="Logs"
            active={activeWorkspaceTab === "logs"}
            count={pendingApprovals.length}
            onClick={() => void setWorkspaceTab("logs")}
          />
          <WorkspaceTabButton
            label="Agent History"
            active={activeWorkspaceTab === "agents"}
            count={allAgents.length}
            onClick={() => void setWorkspaceTab("agents")}
          />
          <WorkspaceTabButton
            label="API Keys"
            active={activeWorkspaceTab === "credentials"}
            count={(activeProject.record.credentials?.requests ?? []).filter((request) => request.status === "pending").length}
            onClick={() => void setWorkspaceTab("credentials")}
          />
        </div>

        {activeWorkspaceTab === "overview" ? (
          <section className="workspace-summary">
            <section className="panel panel--repo">
              <SectionTitle
                eyebrow="Repository"
                title="Files"
                meta={<span className="badge">{activeProject.record.stats?.includedFiles ?? 0} indexed / {activeProject.record.stats?.totalFiles ?? 0} total</span>}
              />
              <div className="panel-toolbar">
                <div className="panel-toolbar__summary">
                  <span>{activeProject.record.validation.branch ?? activeProject.record.validation.projectKind}</span>
                  <span>{formatBytes(activeProject.record.stats?.includedSizeBytes ?? 0)} indexed</span>
                  <span>{activeProject.record.stats?.excludedFiles ?? 0} excluded</span>
                  <span>{activeProject.record.stats?.testsPresent ? "Tests detected" : "No tests detected"}</span>
                </div>
                <input
                  className="input"
                  placeholder="Filter files"
                  value={treeFilterDraft}
                  onChange={(event) => setTreeFilterDraft(event.target.value)}
                />
              </div>
              <RepoTree key={activeProject.record.id} nodes={activeProject.tree} filter={deferredTreeFilter} selected={selectedFile} onSelect={loadSummary} />
            </section>

            <section className="workspace-summary__content">
              <section
                className="overview-grid overview-grid--summary"
              >
                <article className="overview-card overview-card--feature">
                  <div className="candidate-card__title-row">
                    <h3>Project intent</h3>
                    {activeProject.record.overview ? <SourceBadge source={activeProject.record.overview.source} /> : <span className="badge">Pending</span>}
                  </div>
                  <p>{activeProject.record.overview?.whatProjectDoes ?? activeProject.record.overview?.summary ?? "Interface creation is still in progress."}</p>
                </article>
                <article className="overview-card">
                  <h3>How it is organized</h3>
                  <p>{activeProject.record.overview?.howItIsOrganized ?? activeProject.record.overview?.architecture ?? "Repository structure analysis is still in progress."}</p>
                  <p>{activeProject.record.overview?.importantToKnowFirst}</p>
                </article>
                <article className="overview-card">
                  <h3>Scan coverage</h3>
                  <p>
                    Indexed {activeProject.record.stats?.includedFiles ?? 0} files across {activeProject.record.stats?.includedFolders ?? 0} folders for{" "}
                    {formatBytes(activeProject.record.stats?.includedSizeBytes ?? 0)}. Excluded {activeProject.record.stats?.excludedFiles ?? 0} files across{" "}
                    {activeProject.record.stats?.excludedFolders ?? 0} folders for {formatBytes(activeProject.record.stats?.excludedSizeBytes ?? 0)}.
                  </p>
                  <p>
                    Full scanned footprint: {activeProject.record.stats?.totalFiles ?? 0} files and {formatBytes(activeProject.record.stats?.totalSizeBytes ?? 0)}.
                    Exclusions come from built-in defaults and any project <code>.gitignore</code> rules.
                  </p>
                  <div className="tag-row">
                    {getTopFileTypes(activeProject.record.stats?.fileTypeBreakdown).map(([label, count]) => (
                      <span key={label} className="tag">{label}: {count}</span>
                    ))}
                  </div>
                </article>
                <article className="overview-card">
                  <div className="candidate-card__title-row">
                    <h3>Dependencies</h3>
                    <span className="badge">Deterministic scan</span>
                  </div>
                  <div className="tag-row">
                    {activeProject.record.dependencies.slice(0, 12).map((dependency) => (
                      <span key={`${dependency.manifest}:${dependency.name}`} className="tag">{dependency.name}@{dependency.version}</span>
                    ))}
                  </div>
                  <p>{activeProject.record.overview?.dependencyHighlights?.join(" ") || "Dependency highlights will appear here once analysis is complete."}</p>
                </article>
                <article className="overview-card">
                  <h3>Major subsystems</h3>
                  <div className="path-summary-list">
                    {activeProject.record.overview?.subsystemSummaries?.length ? activeProject.record.overview.subsystemSummaries.slice(0, 4).map((subsystem) => (
                      <div key={subsystem.name} className="path-summary">
                        <strong>{subsystem.name}</strong>
                        <p>{subsystem.summary}</p>
                      </div>
                    )) : <p>No subsystem breakdown is available yet.</p>}
                  </div>
                </article>
                <article className="overview-card">
                  <h3>Excluded paths</h3>
                  <div className="path-summary-list">
                    {getExcludedPathEntries(activeProject.record.stats?.excludedPaths).length ? getExcludedPathEntries(activeProject.record.stats?.excludedPaths).slice(0, 6).map((entry) => (
                      <div key={`${entry.rule}:${entry.path}`} className="path-summary">
                        <div className="candidate-card__title-row">
                          <strong>{entry.path}</strong>
                          <span className="badge">{entry.kind}</span>
                        </div>
                        <p>
                          {exclusionRuleLabel(entry.rule)}. {entry.fileCount} file{entry.fileCount === 1 ? "" : "s"} excluded, totaling{" "}
                          {formatBytes(entry.totalSizeBytes)}.
                        </p>
                      </div>
                    )) : <p>No excluded paths were detected by the scanner.</p>}
                  </div>
                </article>
                <article className="overview-card overview-card--wide">
                  <h3>Important paths</h3>
                  <div className="path-summary-list">
                    {importantPathSummaries.length ? importantPathSummaries.slice(0, 6).map((summary) => (
                      <div key={summary.relativePath} className="path-summary">
                        <div className="candidate-card__title-row">
                          <strong>{summary.relativePath}</strong>
                          <SourceBadge source={summary.source} />
                        </div>
                        <p>{summary.summary}</p>
                      </div>
                    )) : <p>The interface-creation agent has not produced important path summaries yet.</p>}
                  </div>
                </article>
              </section>

              <article className="overview-card overview-card--file">
                <div className="candidate-card__title-row">
                  <h3>File details</h3>
                  {fileSummary ? <SourceBadge source={fileSummary.source} /> : null}
                </div>
                {fileSummary ? (
                  <>
                    <div className="file-summary__title">{fileSummary.relativePath}</div>
                    <p>{fileSummary.purpose}</p>
                    <p>{fileSummary.summary}</p>
                    <div className="tag-row">
                      {fileSummary.keySymbols.map((symbol) => <span key={symbol} className="tag">{symbol}</span>)}
                    </div>
                  </>
                ) : (
                  <div className="empty-copy">
                    <p>Select a file in the repository tree to load its summary and related symbols.</p>
                  </div>
                )}
              </article>
            </section>
          </section>
        ) : null}

        {activeWorkspaceTab === "workflow" ? (
          <section className="workflow-control-center panel workflow-control-center--minimal">
            <header className="workflow-control-center__header">
              <div>
                <div className="eyebrow">Workflow loop</div>
                <h2>{activeProject.record.identity.projectName}</h2>
                <p className="workflow-control-center__lead">{workflowLead}</p>
                <p className="agent-workspace__copy">
                  {workflow ? activeStageGuidance?.meaning : "Workflow guidance is unavailable."}
                </p>
              </div>
              <div className="workflow-control-center__meta">
                <div className="metric-card metric-card--compact">
                  <span className="metric-card__label">Current stage</span>
                  <strong>{workflow ? workflowStageLabel(workflow.workflowStage) : "Workflow unavailable"}</strong>
                  <span>{workflow ? workflowStopReasonLabel(workflow.workflowStopReason) : "No workflow state"}</span>
                </div>
                <div className="metric-card metric-card--compact">
                  <span className="metric-card__label">Cycle</span>
                  <strong>{workflow ? `#${workflow.workflowCycle.cycleNumber}` : "n/a"}</strong>
                  <span>{workflowRunState}</span>
                </div>
                <div className="metric-card metric-card--compact">
                  <span className="metric-card__label">Repair</span>
                  <strong>{workflowRepairCounter?.label ?? "No repairs yet"}</strong>
                  <span>{workflowRepairCounter?.status ?? "idle"}</span>
                </div>
              </div>
            </header>

            <WorkflowAtAGlance
              goalTitle={workflowGlanceGoal}
              currentActivity={workflowGlanceActivity}
              recommendationTitle={workflowGlanceRecommendation}
              executionPlan={workflowGlancePlan}
              intendedSteps={workflowGlanceSteps}
              stageLabel={workflow ? workflowStageLabel(workflow.workflowStage) : "Workflow unavailable"}
              activeStepTitle={activeWorkflowStep?.title}
              agentName={currentWorkflowAgent?.name}
              agentStatus={currentWorkflowAgent?.status}
              checklistSummary={workflowChecklistSummary}
              nextGuidance={workflowNextGuidance}
            />

            <div className="workflow-minimal-layout">
              <div className="workflow-minimal-layout__main">
                <article className={`workflow-primary-action ${workflowAction?.kind === "resolve_blocker" ? "workflow-primary-action--blocked" : ""}`}>
                  <div>
                    <div className="eyebrow">What needs your attention</div>
                    <h3>{workflowAction?.title ?? "Nothing right now; the system is working"}</h3>
                    <p>{workflowAction?.description ?? "No action is needed. The workflow is progressing automatically."}</p>
                    {workflowNextGuidance ? <p className="workflow-primary-action__next">{workflowNextGuidance}</p> : null}
                  </div>
                  {workflowAction?.kind === "confirm_goal" ? (
                    <button className="primary-button" onClick={() => void saveUltimateGoal()} disabled={!ultimateGoalDraft.summary.trim()}>
                      {workflowAction.actionLabel ?? "Confirm Ultimate Goal"}
                    </button>
                  ) : workflowAction?.kind === "resume_workflow" ? (
                    <button className="primary-button" onClick={() => void toggleWorkflowPause()}>
                      {workflowAction.actionLabel}
                    </button>
                  ) : workflowAction?.kind === "recover_workflow" ? (
                    <button className="primary-button" onClick={() => void recoverWorkflow()}>
                      {workflowAction.actionLabel}
                    </button>
                  ) : workflowAction?.kind === "manual_takeover" ? (
                    <button
                      className="primary-button"
                      disabled={shellLaunchBusy || !workflow?.manualHandoff?.shellSupported}
                      onClick={() => void openProjectShell()}
                    >
                      {shellLaunchBusy ? "Opening terminal..." : workflowAction.actionLabel ?? "Open Codex terminal"}
                    </button>
                  ) : null}
                </article>

                {workflowGoalView ? (
                  <details className="workflow-secondary__details workflow-secondary__details--current" open>
                    <summary>
                      <span>Current goal, plan, and checklist</span>
                      <span className="badge">Cycle {activeProject.record.workflow.workflowCycle.cycleNumber}</span>
                    </summary>
                    <div className="workflow-secondary__content">
                      <section className="workflow-cycle-board">
                    <SectionTitle
                      eyebrow="Current cycle"
                      title={workflowGoalView.currentGoal}
                      meta={<span className="badge">Cycle {activeProject.record.workflow.workflowCycle.cycleNumber}</span>}
                    />
                    <p className="workflow-cycle-board__lead">{workflowGoalView.whyThisMatters}</p>
                    <div className="workflow-cycle-board__status">
                      <div className="workflow-autopilot-card card-surface">
                        <div className="candidate-card__title-row">
                          <span className="workflow-option__label">Autopilot</span>
                          <strong>{autopilotEnabled ? "On" : "Off"}</strong>
                        </div>
                        <p className="agent-card__subtle">
                          When autopilot is on, the workflow approves the highest-impact checklist-aligned recommendation automatically. Turning it off only changes the next recommendation decision point and does not interrupt work already in progress.
                        </p>
                        <div className="candidate-card__title-row">
                          <span className="workflow-option__label">Objective</span>
                          <strong>{workflowObjectiveLabel(workflowObjective)}</strong>
                        </div>
                        <p className="agent-card__subtle">
                          {optimizeModeEnabled
                            ? "Optimize mode keeps the cycle running after the base goal is satisfied and looks for bounded improvements in UX, correctness, efficiency, resource use, and overall polish."
                            : "Deliver-goal mode runs one final appeal pass for visual projects, then stops once the current Ultimate Goal looks satisfied."}
                        </p>
                        {workflowPauseRequested ? (
                          <div className="lane-note">
                            <strong>{workflowHasActiveAgent ? "Pause pending" : "Workflow paused"}</strong>
                            <span>
                              {workflowHasActiveAgent
                                ? "The current workflow agent can finish, but no next automatic step will start until you continue."
                                : "Automatic workflow progression is paused until you continue."}
                            </span>
                          </div>
                        ) : null}
                        <div className="actions-row">
                          <button className={autopilotEnabled ? "primary-button" : "secondary-button"} onClick={() => void toggleAutopilot()}>
                            Turn autopilot {autopilotEnabled ? "off" : "on"}
                          </button>
                          <button className={optimizeModeEnabled ? "primary-button" : "secondary-button"} onClick={() => void toggleOptimizeMode()}>
                            {optimizeModeEnabled ? "Stop optimizing" : "Optimize"}
                          </button>
                          <button className="secondary-button" onClick={() => void toggleWorkflowPause()}>
                            {workflowPauseRequested ? "Continue workflow" : "Pause after current run"}
                          </button>
                        </div>
                      </div>
                      <UltimateGoalProgressCard
                        progress={workflow?.ultimateGoalProgress}
                        completion={workflow?.ultimateGoalCompletion}
                        checklist={workflow?.goalChecklist}
                        taskMap={workflow?.taskMap}
                        objective={workflowObjective}
                        appeal={workflow?.appeal}
                      />
                    </div>
                    <div className="workflow-cycle-board__grid">
                      <div className="workflow-goal-panel__section">
                        <span className="workflow-option__label">Chosen next step</span>
                        <p>{workflowGoalView.chosenNextStep}</p>
                      </div>
                      <div className="workflow-goal-panel__section">
                        <span className="workflow-option__label">Scoped plan for the coding agent</span>
                        <p>{workflow?.scopedGoal?.executionBrief ?? workflowGoalView.executionPlan}</p>
                      </div>
                      <div className="workflow-goal-panel__section">
                        <span className="workflow-option__label">Current focus</span>
                        <p>{activeWorkflowStep?.currentActivity ?? workflowGoalView.currentFocus}</p>
                      </div>
                      <div className="workflow-goal-panel__section">
                        <span className="workflow-option__label">Current agent</span>
                        <p>{activeWorkflowStep?.agentCategory ? agentCategoryLabel(activeWorkflowStep.agentCategory) : "Waiting for the next workflow agent"}</p>
                      </div>
                    </div>
                    <WorkflowStepRail steps={workflowTimeline} nowTime={clockNow} />
                    <div className="workflow-goal-panel__criteria">
                      <span className="workflow-option__label">Acceptance criteria</span>
                      {workflowGoalView.acceptanceCriteria.length ? (
                        <div className="tag-row">
                          {workflowGoalView.acceptanceCriteria.map((criterion) => (
                            <span key={criterion} className="tag">{criterion}</span>
                          ))}
                        </div>
                      ) : (
                        <p className="agent-card__subtle">Acceptance criteria will appear here once the plan is scoped.</p>
                      )}
                    </div>
                    {workflow?.scopedGoal?.testStrategy.length ? (
                      <div className="workflow-goal-panel__criteria">
                        <span className="workflow-option__label">Integrity checks expected next</span>
                        <div className="tag-row">
                          {workflow.scopedGoal.testStrategy.map((strategy) => (
                            <span key={strategy} className="tag">{strategy}</span>
                          ))}
                        </div>
                      </div>
                    ) : null}
                      </section>
                    </div>
                  </details>
                ) : null}

                {workflowProminence.manualHandoff && workflow?.manualHandoff ? (
                  <article className="overview-card workflow-panel workflow-manual-handoff">
                    <SectionTitle
                      eyebrow="Manual fallback"
                      title={workflow.manualHandoff.title}
                      meta={<span className="badge badge-incompatible">{manualHandoffBadgeLabel(workflow)}</span>}
                    />
                    <p>{workflow.manualHandoff.whatSystemWasTryingToDo}</p>
                    <div className="workflow-manual-handoff__grid">
                      <div className="workflow-manual-handoff__section">
                        <span className="workflow-option__label">What failed</span>
                        <p>{workflow.manualHandoff.validationIssue}</p>
                      </div>
                      <div className="workflow-manual-handoff__section">
                        <span className="workflow-option__label">Latest failure reason</span>
                        <p>{workflow.manualHandoff.latestFailureReason}</p>
                      </div>
                    </div>
                    <div className="actions-row">
                      <button
                        className="primary-button"
                        onClick={() => void retryWorkflowGoal()}
                      >
                        {manualHandoffRetryLabel(workflow)}
                      </button>
                      <button
                        className="secondary-button"
                        disabled={shellLaunchBusy || !workflow.manualHandoff.shellSupported}
                        onClick={() => void openProjectShell()}
                      >
                        {shellLaunchBusy ? "Opening terminal..." : "Open Codex terminal"}
                      </button>
                      <button
                        className="secondary-button"
                        disabled={repairAttemptReports.length === 0}
                        onClick={downloadRepairReport}
                      >
                        Download repair report
                      </button>
                    </div>
                    {isMergeConflictHandoff(workflow) ? (
                      <div className="lane-note">
                        <strong>Conflict recovery</strong>
                        <p>Resolve the listed paths, commit the resolved Git state if needed, then retry the merge.</p>
                      </div>
                    ) : null}
                    <div className="lane-note">
                      <strong>Terminal helper</strong>
                      <p>
                        If no terminal appears, run <code>{PROJECT_SHELL_LAUNCHER_CMD_PATH}</code> from the project folder on Windows.
                        Then send back the terminal output or the contents of <code>{PROJECT_SHELL_LAUNCH_LOG_PATH}</code>.
                      </p>
                    </div>
                    {workflow.manualHandoff.lastOpenError ? (
                      <div className="lane-note">
                        <strong>Last terminal error</strong>
                        <p>{workflow.manualHandoff.lastOpenError}</p>
                      </div>
                    ) : null}
                  </article>
                ) : null}

                {(workflowProminence.recommendations || activeProject.record.workflow.recommendations.length > 0 || activeProject.record.workflow.approvedRecommendation) ? (
                  <details className={`workflow-secondary__details ${workflowProminence.recommendations ? "workflow-panel--prominent" : "workflow-panel--secondary"}`} open={workflowProminence.recommendations}>
                    <summary>
                      <span>Recommendations</span>
                      <span className="badge">{activeProject.record.workflow.recommendations.length}</span>
                    </summary>
                    <div className="workflow-secondary__content workflow-panel">
                    <SectionTitle
                      eyebrow="Recommendations"
                      title="Pick the next bounded task"
                      meta={<span className="badge">{activeProject.record.workflow.recommendations.length}</span>}
                    />
                    <div className="agent-form card-surface">
                      <span className="workflow-option__label">Custom recommendation</span>
                      <p className="agent-card__subtle">
                        Enter a direction and regenerate closely related recommendation options around it.
                      </p>
                      <textarea
                        className="textarea"
                        placeholder="Example: tighten the Windows/WSL project path handling in the cycle workflow"
                        value={customRecommendationPrompt}
                        onChange={(event) => setCustomRecommendationPrompt(event.target.value)}
                      />
                      <div className="actions-row">
                        <button
                          className="secondary-button"
                          disabled={!customRecommendationPrompt.trim() || recommendationRegenerationLocked}
                          onClick={() => void runRecommendation(customRecommendationPrompt)}
                        >
                          Generate related recommendations
                        </button>
                      </div>
                    </div>
                    {activeProject.record.workflow.approvedRecommendation && !(
                      activeProject.record.workflow.workflowCycle.status === "completed" &&
                      activeProject.record.workflow.recommendations.length > 0
                    ) ? (
                      <div className="workflow-selection-banner">
                        <strong>Chosen next step</strong>
                        <span>{activeProject.record.workflow.approvedRecommendation.title}</span>
                      </div>
                    ) : null}
                    <div className="workflow-option-list">
                      {activeProject.record.workflow.recommendations.length ? activeProject.record.workflow.recommendations.map((recommendation) => (
                        <RecommendationDecisionCard
                          key={recommendation.id}
                          recommendation={recommendation}
                          approved={activeProject.record.workflow.approvedRecommendation?.recommendationId === recommendation.id}
                          disabled={
                            Boolean(activeProject.record.workflow.approvedRecommendation) &&
                            activeProject.record.workflow.approvedRecommendation?.recommendationId !== recommendation.id
                          }
                          onApprove={(recommendationId) => void approveRecommendation(recommendationId)}
                        />
                      )) : (
                        <div className="empty-copy">
                          <p>Recommendations will appear here when the workflow is ready for the next decision.</p>
                        </div>
                      )}
                    </div>
                    </div>
                  </details>
                ) : null}

                <details className="workflow-secondary__details workflow-noisy-detail">
                  <summary>
                    <span>Manual agent</span>
                    <span className="badge">{manualAgents.length}</span>
                  </summary>
                  <div className="workflow-secondary__content workflow-panel workflow-agent-list-card">
                  <SectionTitle
                    eyebrow="Manual Agent"
                    title="Ask about the repo or request a one-off change"
                    meta={<span className="badge">{manualAgents.length}</span>}
                  />
                  <p className="agent-card__subtle">
                    Manual agents stay outside the workflow cycle. Use them for repo questions or independent changes without moving the cycle forward.
                  </p>
                  <div className="agent-form card-surface">
                    <textarea
                      className="textarea"
                      placeholder="Ask a question about the repo or describe a change you want outside the cycle."
                      value={manualAgentPrompt}
                      onChange={(event) => setManualAgentPrompt(event.target.value)}
                    />
                    <select className="input" value={manualAgentModel} onChange={(event) => setManualAgentModel(event.target.value)}>
                      {state.availableModels.map((model) => <option key={model.id} value={model.model}>{model.displayName} ({model.model})</option>)}
                    </select>
                    <AgentReasoningPicker
                      category="manual"
                      model={modelOptionsByName.get(manualAgentModel)}
                      taskPrompt={manualAgentPrompt}
                      mode={manualAgentReasoningMode}
                      effort={manualAgentReasoningEffort}
                      onModeChange={setManualAgentReasoningMode}
                      onEffortChange={setManualAgentReasoningEffort}
                    />
                    <div className="actions-row">
                      <button className="primary-button" disabled={!manualAgentPrompt.trim() || !manualAgentModel} onClick={() => void createManualAgent()}>
                        Run manual agent
                      </button>
                      <span className="agent-card__subtle">{manualPendingApprovalCount} manual approvals pending</span>
                    </div>
                  </div>
                  <div className="workflow-agent-list">
                    {manualAgents.length ? manualAgents.map((agent) => (
                      <AgentCard
                        key={agent.id}
                        agent={agent}
                        workflow={workflow}
                        selected={activeAgent?.id === agent.id}
                        onSelect={(agentId) => void selectAgent(agentId)}
                      />
                    )) : (
                      <div className="empty-copy">No manual agents have started yet.</div>
                    )}
                  </div>
                  </div>
                </details>

                {pendingUserInputRequests.length > 0 ? (
                  <article className="overview-card workflow-panel workflow-user-input-panel workflow-panel--prominent">
                    <SectionTitle
                      eyebrow="Action needed from you"
                      title="External action requests"
                      meta={<span className="badge badge-incompatible">{pendingUserInputRequests.length} pending</span>}
                    />
                    <div className="workflow-option-list">
                      {pendingUserInputRequests.map((request) => (
                        <article key={request.id} className="workflow-option workflow-option--blocked workflow-user-input-card">
                          <div className="candidate-card__title-row">
                            <strong>{request.title}</strong>
                            <span className="badge badge-incompatible">Agent blocked</span>
                          </div>
                          <p>{request.description}</p>
                          <div className="workflow-option__meta">
                            <span>{agentCategoryLabel(request.requestedByAgentCategory)}</span>
                            <span>{request.attachments.length} attachments staged</span>
                            <span>Requested {formatDateTime(request.createdAt)}</span>
                          </div>
                          <div className="workflow-user-input-card__callout">
                            <strong>What to do</strong>
                            <ol className="workflow-user-input-card__steps">
                              {request.questions.map((question) => (
                                <li key={question.id}>{question.question}</li>
                              ))}
                            </ol>
                            <p className="agent-card__subtle">Secret answers stay in-memory and are not persisted into the project record.</p>
                          </div>
                          <div className="workflow-form">
                            {request.questions.map((question) => (
                              <div key={question.id} className="workflow-user-input-card__question">
                                <label className="workflow-option__label" htmlFor={`${request.id}-${question.id}`}>{question.header}</label>
                                <p className="agent-card__subtle">{question.question}</p>
                                {question.options.length > 0 && !question.isOther ? (
                                  <select
                                    id={`${request.id}-${question.id}`}
                                    className="input"
                                    value={getUserInputQuestionSelectValue(question, userInputDrafts[request.id]?.[question.id] ?? "")}
                                    onChange={(event) => updateUserInputDraft(request.id, question.id, event.target.value)}
                                  >
                                    <option value="">Select one option</option>
                                    {question.options.map((option) => (
                                      <option key={option.label} value={option.label}>{option.label}</option>
                                    ))}
                                  </select>
                                ) : question.isSecret ? (
                                  <input
                                    id={`${request.id}-${question.id}`}
                                    className="input"
                                    type="password"
                                    autoComplete="off"
                                    value={userInputDrafts[request.id]?.[question.id] ?? ""}
                                    onChange={(event) => updateUserInputDraft(request.id, question.id, event.target.value)}
                                  />
                                ) : (
                                  <textarea
                                    id={`${request.id}-${question.id}`}
                                    className="textarea"
                                    value={userInputDrafts[request.id]?.[question.id] ?? ""}
                                    onChange={(event) => updateUserInputDraft(request.id, question.id, event.target.value)}
                                  />
                                )}
                                {question.options.length > 0 ? (
                                  <div className="workflow-user-input-card__options">
                                    {question.options.map((option) => (
                                      <div key={option.label} className="lane-note">
                                        <strong>{option.label}</strong>
                                        <span>{option.description}</span>
                                      </div>
                                    ))}
                                  </div>
                                ) : null}
                              </div>
                            ))}
                          </div>
                          <div className="workflow-user-input-card__attachments">
                            <div>
                              <span className="workflow-option__label">Attachment inbox</span>
                              <p className="agent-card__subtle">
                                Files are copied into <code>{request.attachmentInboxRelativePath}</code> so the agent can inspect them inside the project.
                              </p>
                            </div>
                            {request.attachments.length ? (
                              <div className="workflow-user-input-card__attachment-list">
                                {request.attachments.map((attachment) => (
                                  <div key={attachment.id} className="lane-note">
                                    <strong>{attachment.name}</strong>
                                    <span>{attachment.relativePath} • {formatBytes(attachment.sizeBytes)}</span>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <p className="agent-card__subtle">No attachments staged yet.</p>
                            )}
                          </div>
                          <div className="actions-row">
                            <button
                              className="secondary-button"
                              disabled={userInputAttachmentBusyId === request.id}
                              onClick={() => void addUserInputRequestAttachments(request.id)}
                            >
                              {userInputAttachmentBusyId === request.id ? "Adding files..." : "Add attachments"}
                            </button>
                            <button
                              className="secondary-button"
                              onClick={() => void openUserInputRequestInbox(request.id)}
                            >
                              Open inbox folder
                            </button>
                            <button
                              className="primary-button"
                              disabled={userInputSubmitBusyId === request.id}
                              onClick={() => void submitUserInputRequest(request)}
                            >
                              {userInputSubmitBusyId === request.id ? "Submitting..." : "Send to agent"}
                            </button>
                          </div>
                        </article>
                      ))}
                    </div>
                  </article>
                ) : null}

                {pendingHumanInterventions.length > 0 ? (
                  <article className={`overview-card workflow-panel ${workflowProminence.humanIntervention ? "workflow-panel--prominent" : "workflow-panel--secondary"}`}>
                    <SectionTitle
                      eyebrow="Action needed from you"
                      title="Human intervention"
                      meta={<span className={`badge ${pendingHumanInterventions.some((entry) => entry.blocking) ? "badge-incompatible" : "badge-exact"}`}>{pendingHumanInterventions.length} pending</span>}
                    />
                    <div className="workflow-option-list">
                      {pendingHumanInterventions.length ? pendingHumanInterventions.map((intervention) => (
                        <article key={intervention.id} className={`workflow-option ${intervention.blocking ? "workflow-option--blocked" : ""}`}>
                          <div className="candidate-card__title-row">
                            <strong>{intervention.title}</strong>
                            <span className={`badge ${interventionSeverityClass(intervention.severity)}`}>{intervention.severity}</span>
                          </div>
                          <p>{intervention.description}</p>
                          <p className="agent-card__subtle">Why the workflow is paused: {intervention.reason}</p>
                          <div className="workflow-option__meta">
                            <span>{agentCategoryLabel(intervention.requestedByAgentCategory)}</span>
                            <span>{intervention.blocking ? "Blocking" : "Non-blocking"}</span>
                            <span>Requested {formatDateTime(intervention.createdAt)}</span>
                          </div>
                          <textarea
                            className="textarea"
                            placeholder="Add resolution notes"
                            value={interventionNotes[intervention.id] ?? ""}
                            onChange={(event) => setInterventionNotes({ ...interventionNotes, [intervention.id]: event.target.value })}
                          />
                          <div className="actions-row">
                            <button className="primary-button" onClick={() => void resolveHumanIntervention(intervention.id, "resolved")}>Mark resolved</button>
                            <button className="secondary-button" onClick={() => void resolveHumanIntervention(intervention.id, "dismissed")}>Dismiss</button>
                          </div>
                        </article>
                      )) : (
                        <div className="empty-copy">
                          <p>No human interventions are currently pending.</p>
                        </div>
                      )}
                    </div>
                  </article>
                ) : null}

                <details className="workflow-secondary__details workflow-noisy-detail">
                  <summary>
                    <span>Approvals and recent activity</span>
                    <span className="badge">{pendingApprovals.length} approvals</span>
                  </summary>
                  <div className="workflow-secondary__content workflow-feed-card">
                  <SectionTitle eyebrow="Execution feed" title="Approvals and recent activity" meta={<span className="badge">{pendingApprovals.length} approvals</span>} />
                  <div className="workflow-feed-card__grid">
                    <div className="panel support-panel workflow-feed-card__panel">
                      <SectionTitle eyebrow="Approvals" title="Pending requests" />
                      <div className="workflow-feed-card__scroll">
                        <div className="approval-list">
                          {pendingApprovals.length ? pendingApprovals.map((approval) => (
                            <div key={approval.id} className="approval-row">
                              <div>
                                <strong>{approval.summary}</strong>
                                <div>{approval.reason ?? approval.command ?? "Approval required"}</div>
                              </div>
                              <div className="actions-row">
                                <button className="primary-button" onClick={() => void window.workbench.approve(activeProject.record.id, approval.agentId, approval.id, "accept")}>Accept</button>
                                <button className="secondary-button" onClick={() => void window.workbench.approve(activeProject.record.id, approval.agentId, approval.id, "decline")}>Reject</button>
                              </div>
                            </div>
                          )) : <div className="empty-copy">No approvals are currently waiting.</div>}
                        </div>
                      </div>
                    </div>

                    <div className="panel support-panel workflow-feed-card__panel">
                      <SectionTitle eyebrow="Recent activity" title="Workflow log" />
                      <div className="workflow-feed-card__scroll">
                        <div className="activity-list">
                          {recentActivity.length ? recentActivity.map((event) => (
                            <div key={event.id} className="activity-row">
                              <strong>{event.title}</strong>
                              <span>{event.detail ?? workflowActivitySourceLabel(event.source)}</span>
                            </div>
                          )) : <div className="empty-copy">Agent activity will appear here once work starts.</div>}
                        </div>
                      </div>
                    </div>
                  </div>
                  </div>
                </details>

                <details className="workflow-secondary__details" open={!activeProject.record.workflow.ultimateGoal.confirmedAt || Boolean(activeProject.record.workflow.ultimateGoalDraft)}>
                  <summary>Ultimate Goal details</summary>
                  <div className="workflow-secondary__content">
                  <div className="candidate-card__title-row">
                    <strong>{activeProject.record.workflow.ultimateGoal.summary || "No confirmed Ultimate Goal yet"}</strong>
                    <span className="badge">{goalSourceLabel(activeProject.record.workflow.ultimateGoal)}</span>
                  </div>
                  <p>{activeProject.record.workflow.ultimateGoal.detailedIntent || "Add the long-lived intent for this project here."}</p>
                  <div className="workflow-step-card__meta">
                    <span>Confirmed {formatDateTime(activeProject.record.workflow.ultimateGoal.confirmedAt)}</span>
                    <span>Updated {formatDateTime(activeProject.record.workflow.ultimateGoal.lastUpdatedAt)}</span>
                  </div>
                  {activeProject.record.workflow.ultimateGoalDraft ? (
                    <div className="lane-note">
                      <strong>Detected draft waiting for confirmation</strong>
                      <span>{activeProject.record.workflow.ultimateGoalDraft.summary || "A detected draft is ready for review."}</span>
                    </div>
                  ) : null}
                  {ultimateGoalImportPreview ? (
                    <div className="lane-note">
                      <strong>
                        {ultimateGoalImportPreview.completeness === "complete"
                          ? `Imported draft from ${ultimateGoalImportPreview.sourceFileName}`
                          : `Partial import from ${ultimateGoalImportPreview.sourceFileName}`}
                      </strong>
                      <span>
                        {ultimateGoalImportPreview.missingFields.length
                          ? `Review: ${ultimateGoalImportPreview.missingFields.map(ultimateGoalFieldLabel).join(", ")}.`
                          : "All required sections were detected. Review and confirm before the workflow uses them."}
                      </span>
                      {ultimateGoalImportPreview.warnings.length ? (
                        <span>{ultimateGoalImportPreview.warnings.join(" ")}</span>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="workflow-form">
                    <input
                      className="input"
                      placeholder="One-sentence Ultimate Goal"
                      value={ultimateGoalDraft.summary}
                      onChange={(event) => setUltimateGoalDraft({ ...ultimateGoalDraft, summary: event.target.value })}
                    />
                    <textarea
                      className="textarea"
                      placeholder="Detailed intent"
                      value={ultimateGoalDraft.detailedIntent}
                      onChange={(event) => setUltimateGoalDraft({ ...ultimateGoalDraft, detailedIntent: event.target.value })}
                    />
                    <div className="workflow-two-column">
                      <textarea
                        className="textarea"
                        placeholder="Success criteria, one per line"
                        value={ultimateGoalDraft.successCriteria}
                        onChange={(event) => setUltimateGoalDraft({ ...ultimateGoalDraft, successCriteria: event.target.value })}
                      />
                      <textarea
                        className="textarea"
                        placeholder="Constraints, one per line"
                        value={ultimateGoalDraft.constraints}
                        onChange={(event) => setUltimateGoalDraft({ ...ultimateGoalDraft, constraints: event.target.value })}
                      />
                    </div>
                    <div className="workflow-two-column">
                      <textarea
                        className="textarea"
                        placeholder="Non-goals, one per line"
                        value={ultimateGoalDraft.nonGoals}
                        onChange={(event) => setUltimateGoalDraft({ ...ultimateGoalDraft, nonGoals: event.target.value })}
                      />
                      <textarea
                        className="textarea"
                        placeholder="Quality bar"
                        value={ultimateGoalDraft.qualityBar}
                        onChange={(event) => setUltimateGoalDraft({ ...ultimateGoalDraft, qualityBar: event.target.value })}
                      />
                    </div>
                    <input
                      className="input"
                      placeholder="Target audience"
                      value={ultimateGoalDraft.targetAudience}
                      onChange={(event) => setUltimateGoalDraft({ ...ultimateGoalDraft, targetAudience: event.target.value })}
                    />
                  </div>
                  <div className="actions-row">
                    <button className="primary-button" onClick={() => void saveUltimateGoal()} disabled={!ultimateGoalDraft.summary.trim()}>
                      Confirm / Update Ultimate Goal
                    </button>
                    <button className="secondary-button" onClick={() => void importUltimateGoalText()}>
                      Import Goal from .txt
                    </button>
                    <button className="secondary-button" onClick={downloadUltimateGoalFormat}>
                      Download Ultimate Goal format
                    </button>
                    <button className="secondary-button" onClick={() => void detectUltimateGoal()}>
                      Detect Ultimate Goal
                    </button>
                    {activeProject.record.workflow.ultimateGoalDraft ? (
                      <button className="secondary-button" onClick={loadDetectedGoalDraft}>
                        Load detected draft
                      </button>
                    ) : null}
                  </div>
                  </div>
                </details>

                <details className="workflow-secondary__details workflow-noisy-detail">
                  <summary>Advanced traces</summary>
                  <div className="workflow-secondary__content">
                    <LiveUpdatesPanel
                      agents={allAgents}
                      workflowActivity={workflow?.activityLog ?? []}
                      activeStepTitle={activeWorkflowStep?.title}
                      activeStepId={activeWorkflowStep?.id}
                      selectedAgent={activeAgent}
                      onSelectAgent={(agentId) => void selectAgent(agentId)}
                      nowTime={clockNow}
                    />
                    <div className="workflow-secondary__content workflow-secondary__content--agents">
                      <div className="agent-lanes">
                        <AgentLane
                          eyebrow="Planning"
                          title="Goal / planning agents"
                          description="Goal agents handle charter detection and scoped planning."
                          agents={goalAgents}
                          workflow={workflow}
                          selectedAgentId={activeAgent?.id}
                          emptyCopy="No goal or bootstrap agent is active yet."
                          onSelect={(agentId) => void selectAgent(agentId)}
                        />

                        <AgentLane
                          eyebrow="Execution"
                          title="Coding agents"
                          description="Coding progress is grouped here for deeper inspection."
                          agents={codingAgents}
                          workflow={workflow}
                          selectedAgentId={activeAgent?.id}
                          emptyCopy="No coding agents are running yet."
                          onSelect={(agentId) => void selectAgent(agentId)}
                        />

                        <AgentLane
                          eyebrow="Validation"
                          title="Integrity agents"
                          description="Integrity validates the scoped goal and the ultimate goal."
                          agents={integrityAgents}
                          workflow={workflow}
                          selectedAgentId={activeAgent?.id}
                          emptyCopy="Integrity checks have not been run yet."
                          onSelect={(agentId) => void selectAgent(agentId)}
                        />

                        <AgentLane
                          eyebrow="Integration"
                          title="Recommendation and merge agents"
                          description="Recommendation proposes the next step. Merge closes the cycle."
                          agents={[...recommendationAgents, ...mergeAgents]}
                          workflow={workflow}
                          selectedAgentId={activeAgent?.id}
                          emptyCopy="No recommendation or merge agent is active yet."
                          onSelect={(agentId) => void selectAgent(agentId)}
                        />

                        <AgentLane
                          eyebrow="Manual"
                          title="Manual agents"
                          description="Independent repo questions and one-off changes live here outside the cycle."
                          agents={manualAgents}
                          workflow={workflow}
                          selectedAgentId={activeAgent?.id}
                          emptyCopy="No manual agents are active yet."
                          onSelect={(agentId) => void selectAgent(agentId)}
                        />
                      </div>
                    </div>
                  </div>
                </details>

                <details className="workflow-secondary__details workflow-noisy-detail">
                  <summary>Developer controls</summary>
                  <div className="workflow-secondary__content">
                  <p className="agent-card__subtle">
                    These controls are kept for debugging and scaffolding. The normal workflow should advance automatically.
                  </p>
                  <div className="actions-row">
                    <button className="secondary-button" disabled={!activeProject.record.workflow.approvedRecommendation} onClick={() => void createScopedGoal()}>
                      Create scoped goal
                    </button>
                    <button className="secondary-button" disabled={recommendationRegenerationLocked} onClick={() => void runRecommendation()}>
                      Run recommendation
                    </button>
                    <button className="secondary-button" onClick={() => void window.workbench.runIntegrity(activeProject.record.id)}>
                      Run integrity
                    </button>
                    <button className="secondary-button" onClick={() => void window.workbench.runMerge(activeProject.record.id)}>
                      Run merge
                    </button>
                    <button className="secondary-button" onClick={() => void advanceWorkflowStage()}>
                      Advance workflow stage
                    </button>
                  </div>
                  <div className="agent-form card-surface">
                    <input className="input" value={codingAgentForm.name} onChange={(event) => setCodingAgentForm({ ...codingAgentForm, name: event.target.value })} />
                    <textarea className="textarea" placeholder="Describe the coding task" value={codingAgentForm.prompt} onChange={(event) => setCodingAgentForm({ ...codingAgentForm, prompt: event.target.value })} />
                    <select className="input" value={codingAgentForm.model} onChange={(event) => setCodingAgentForm({ ...codingAgentForm, model: event.target.value })}>
                      {state.availableModels.map((model) => <option key={model.id} value={model.model}>{model.displayName} ({model.model})</option>)}
                    </select>
                    <AgentReasoningPicker
                      category="coding"
                      model={modelOptionsByName.get(codingAgentForm.model)}
                      taskPrompt={`${codingAgentForm.name}\n${codingAgentForm.prompt}`}
                      mode={codingAgentForm.reasoningMode}
                      effort={codingAgentForm.reasoningEffort}
                      onModeChange={(reasoningMode) => setCodingAgentForm({ ...codingAgentForm, reasoningMode })}
                      onEffortChange={(reasoningEffort) => setCodingAgentForm({ ...codingAgentForm, reasoningEffort })}
                    />
                    <button className="primary-button" disabled={!codingAgentForm.prompt.trim() || !codingAgentForm.model} onClick={() => void createCodingAgent()}>
                      Create manual coding agent
                    </button>
                  </div>
                  </div>
                </details>
              </div>

              <aside className="workflow-minimal-layout__side">
                <article className="overview-card workflow-agent-list-card workflow-agent-list-card--bounded">
                  <SectionTitle
                    eyebrow="Context selector"
                    title="Relevant prior context"
                    meta={<span className="badge">{activeProject.record.workflow.memory.lastRelevantContext.length}</span>}
                  />
                  <div className="workflow-option-list">
                    {activeProject.record.workflow.memory.lastRelevantContext.length ? activeProject.record.workflow.memory.lastRelevantContext.map((selection) => (
                      <div key={selection.descriptorId} className="lane-note">
                        <strong>Cycle {selection.cycleNumber} · {agentCategoryLabel(selection.agentCategory)}</strong>
                        <span>{selection.summary}</span>
                        {selection.paths.length ? <span>Paths: {selection.paths.join(", ")}</span> : null}
                        {selection.reasons.length ? <span>Why: {selection.reasons.join("; ")}</span> : null}
                      </div>
                    )) : (
                      <div className="empty-copy">Relevant prior context will appear after the next recommendation, planning, or coding prompt is prepared.</div>
                    )}
                  </div>
                </article>

                <article className="overview-card workflow-agent-list-card workflow-agent-list-card--bounded">
                  <SectionTitle eyebrow="Current run" title="Active agent" meta={<span className="badge">{currentWorkflowAgent?.status ?? "idle"}</span>} />
                  {currentWorkflowAgent ? (
                    <AgentCard
                      agent={currentWorkflowAgent}
                      workflow={workflow}
                      selected={activeAgent?.id === currentWorkflowAgent.id}
                      onSelect={(agentId) => void selectAgent(agentId)}
                    />
                  ) : (
                    <div className="empty-copy">No workflow agent is active right now.</div>
                  )}
                </article>
              </aside>
            </div>
          </section>
        ) : null}

        {activeWorkspaceTab === "logs" ? (
          <section className="workflow-control-center panel workflow-log-workspace">
            <SectionTitle eyebrow="Execution feed" title="Logs" meta={<span className="badge">{pendingApprovals.length} approvals pending</span>} />
            <div className="workflow-feed-card__grid">
              <div className="panel support-panel workflow-feed-card__panel">
                <SectionTitle eyebrow="Approvals" title="Pending requests" />
                <div className="workflow-feed-card__scroll workflow-feed-card__scroll--tall">
                  <div className="approval-list">
                    {pendingApprovals.length ? pendingApprovals.map((approval) => (
                      <div key={approval.id} className="approval-row">
                        <div>
                          <strong>{approval.summary}</strong>
                          <div>{approval.reason ?? approval.command ?? "Approval required"}</div>
                        </div>
                        <div className="actions-row">
                          <button className="primary-button" onClick={() => void window.workbench.approve(activeProject.record.id, approval.agentId, approval.id, "accept")}>Accept</button>
                          <button className="secondary-button" onClick={() => void window.workbench.approve(activeProject.record.id, approval.agentId, approval.id, "decline")}>Reject</button>
                        </div>
                      </div>
                    )) : <div className="empty-copy">No approvals are currently waiting.</div>}
                  </div>
                </div>
              </div>

              <div className="panel support-panel workflow-feed-card__panel">
                <SectionTitle eyebrow="Workflow" title="Activity log" meta={logFeed.loading ? <span className="badge">Loading</span> : null} />
                <FeedPager
                  label="Activity"
                  pageIndex={activityLogPageIndex}
                  pageSize={LOG_ACTIVITY_PAGE_SIZE}
                  total={logFeed.activity.total}
                  visibleCount={logFeed.activity.entries.length}
                  onPageChange={setActivityLogPageIndex}
                />
                <div className="workflow-feed-card__scroll workflow-feed-card__scroll--tall">
                  <div className="activity-list">
                    {logFeed.activity.entries.length ? logFeed.activity.entries
                      .map((event) => (
                        <div key={event.id} className="activity-row">
                          <strong>{event.title}</strong>
                          <span>{event.detail ?? workflowActivitySourceLabel(event.source)} · {formatClockTime(event.timestamp)}</span>
                        </div>
                      )) : <div className="empty-copy">Workflow activity will appear here once work starts.</div>}
                  </div>
                </div>
              </div>
            </div>

            <article className="overview-card workflow-panel">
              <SectionTitle eyebrow="Commands" title="Command snippets" meta={logFeed.loading ? <span className="badge">Loading</span> : null} />
              <FeedPager
                label="Commands"
                pageIndex={commandLogPageIndex}
                pageSize={LOG_COMMAND_PAGE_SIZE}
                total={logFeed.commands.total}
                visibleCount={logFeed.commands.entries.length}
                onPageChange={setCommandLogPageIndex}
              />
              <div className="workflow-feed-card__scroll workflow-feed-card__scroll--commands">
                <div className="activity-list">
                  {logFeed.commands.entries.map((command) => (
                    <div key={command.id} className="activity-row">
                      <strong>{command.agentName}</strong>
                      <span>{command.command} · {command.status}</span>
                    </div>
                  ))}
                  {logFeed.commands.entries.length === 0 ? (
                    <div className="empty-copy">No command snippets have been recorded yet.</div>
                  ) : null}
                </div>
              </div>
            </article>
          </section>
        ) : null}

        {activeWorkspaceTab === "agents" ? (
          <section className="workflow-control-center panel agent-history-workspace">
            <SectionTitle eyebrow="Run history" title="Agent History" meta={<span className="badge">{allAgents.length} runs</span>} />
            <div className="agent-history-layout">
              <div className="agent-history-layout__lists">
                <article className="overview-card workflow-agent-list-card">
                  <SectionTitle
                    eyebrow="Workflow"
                    title="Workflow runs"
                    meta={<span className="badge">{workflowAgentPage.loading ? "Loading" : `${workflowAgentPage.total} runs`}</span>}
                  />
                  <PagedAgentList
                    agents={workflowAgentPage.agents}
                    workflow={workflow}
                    selectedAgentId={activeAgent?.id}
                    totalAgents={workflowAgentPage.total}
                    pageIndex={workflowAgentPageIndex}
                    onPageChange={setWorkflowAgentPageIndex}
                    emptyCopy="No workflow agents have started yet."
                    onSelect={(agentId) => void selectAgent(agentId)}
                  />
                </article>
                <article className="overview-card workflow-agent-list-card">
                  <SectionTitle
                    eyebrow="Manual"
                    title="Independent runs"
                    meta={<span className="badge">{manualAgentPage.loading ? "Loading" : `${manualAgentPage.total} runs`}</span>}
                  />
                  <div className="agent-form card-surface">
                    <textarea
                      className="textarea"
                      placeholder="Ask a question about the repo or describe a change outside the workflow cycle."
                      value={manualAgentPrompt}
                      onChange={(event) => setManualAgentPrompt(event.target.value)}
                    />
                    <select className="input" value={manualAgentModel} onChange={(event) => setManualAgentModel(event.target.value)}>
                      {state.availableModels.map((model) => <option key={model.id} value={model.model}>{model.displayName} ({model.model})</option>)}
                    </select>
                    <AgentReasoningPicker
                      category="manual"
                      model={modelOptionsByName.get(manualAgentModel)}
                      taskPrompt={manualAgentPrompt}
                      mode={manualAgentReasoningMode}
                      effort={manualAgentReasoningEffort}
                      onModeChange={setManualAgentReasoningMode}
                      onEffortChange={setManualAgentReasoningEffort}
                    />
                    <div className="actions-row">
                      <button className="primary-button" disabled={!manualAgentPrompt.trim() || !manualAgentModel} onClick={() => void createManualAgent()}>
                        Run manual agent
                      </button>
                      <span className="agent-card__subtle">{manualPendingApprovalCount} manual approvals pending</span>
                    </div>
                  </div>
                  <PagedAgentList
                    agents={manualAgentPage.agents}
                    workflow={workflow}
                    selectedAgentId={activeAgent?.id}
                    totalAgents={manualAgentPage.total}
                    pageIndex={manualAgentPageIndex}
                    onPageChange={setManualAgentPageIndex}
                    emptyCopy="No manual agents have started yet."
                    onSelect={(agentId) => void selectAgent(agentId)}
                  />
                </article>
              </div>
              <div className="agent-history-layout__detail">
                <AgentFocusPanel agent={activeAgentForDetail} workflow={workflow} />
                <article className="overview-card workflow-panel">
                  <SectionTitle eyebrow="Developer" title="Workflow controls" />
                  <div className="actions-row">
                    <button className="secondary-button" disabled={!activeProject.record.workflow.approvedRecommendation} onClick={() => void createScopedGoal()}>
                      Create scoped goal
                    </button>
                    <button className="secondary-button" disabled={recommendationRegenerationLocked} onClick={() => void runRecommendation()}>
                      Run recommendation
                    </button>
                    <button className="secondary-button" onClick={() => void window.workbench.runIntegrity(activeProject.record.id)}>Run integrity</button>
                    <button className="secondary-button" onClick={() => void window.workbench.runMerge(activeProject.record.id)}>Run merge</button>
                    <button className="secondary-button" onClick={() => void advanceWorkflowStage()}>Advance workflow stage</button>
                  </div>
                </article>
              </div>
            </div>
          </section>
        ) : null}

        {activeWorkspaceTab === "credentials" ? (
          <CredentialsPanel project={activeProject} onSaved={showInfoNotice} onError={handleError} />
        ) : null}
      </main>

      {settingsDialog}
    </div>
  );
};
