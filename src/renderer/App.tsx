import { startTransition, useDeferredValue, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
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
  deriveUserFacingWorkflowStatus,
  deriveWorkflowRuntimeStatus,
  getWorkflowRecoveryCandidate,
  workflowActionGuide,
  workflowRunStateLabel,
  workflowSectionProminence,
  workflowStageGuidance,
  workflowStageLabel,
  workflowStatusSummary
} from "@shared/workflowView";
import { buildOperatorWorkflowViewModel, suspiciousPathReason, type OperatorChangedFileGroup, type OperatorWorkflowViewModel } from "@shared/operatorWorkflowView";
import { isWorkflowAutomationBlockingAgent } from "@shared/workflow";
import { buildWorkflowAttentionItems, type WorkflowAttentionItem } from "./workflowAttention";
import { REPOSITORY_ROOT_PARENT, buildRepositoryTreeRows, type RepositoryChildrenByParent } from "./repositoryTree";
import { CommandCenter, type CommandCenterHealthItem, type CommandCenterItem, type CommandCenterTone } from "./components/CommandCenter";
import { createDefaultAutopilotStrategy, goalRestrictivenessMode, listAutopilotPresets as defaultAutopilotPresets } from "@shared/goalCharter";
import type {
  AgentCategory,
  AgentFullOutputResponse,
  AgentHistorySummary,
  AgentListResponse,
  AgentLifecycleStatus,
  AgentReasoningEfforts,
  AgentReasoningMode,
  AgentState,
  AgentTranscriptResponse,
  AutopilotPreset,
  AutopilotPolicy,
  AutopilotProfile,
  AutopilotStrategy,
  ApprovalRequestRecord,
  CredentialEntryMetadata,
  DiscoveredModel,
  ExecutionMode,
  FileSummary,
  GitHubStatus,
  GoalChangeRecord,
  HumanInterventionRecord,
  InterfaceReasoningEffort,
  GoalCharterDraftTextField,
  GoalCharterAiDraft,
  InterfaceCandidate,
  LoadedProjectView,
  ProjectCreationMode,
  ProjectLoadResult,
  ProjectLoadIntent,
  ProjectCommandLogEntry,
  ProjectLogFeedResponse,
  ProjectRepositorySummary,
  ProjectWorkflowState,
  RepositoryChildrenResponse,
  RepositoryScanLimitsResponse,
  RepositoryScanSettings,
  RepositoryScanStatus,
  RepositorySearchResponse,
  RepositoryTreeEntry,
  RuntimeReadinessReport,
  RuntimeEventRecord,
  SummarySource,
  UserInputRequestQuestion,
  UserInputRequestRecord,
  UltimateGoalImportPreview,
  UltimateGoalProgressEstimate,
  UltimateGoal,
  VisualExportCaptureTarget,
  VisualExportTab,
  ValidationStatus,
  WorkflowActivityEvent,
  WorkflowCycleDetail,
  WorkflowCycleListResponse,
  WorkflowCycleSummaryView,
  WorkspaceVisualTabId,
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

type HistoryCycleView = WorkflowCycleListResponse & {
  loading: boolean;
  error?: string;
  expandedCycleIds: string[];
  detailsByCycleId: Record<string, WorkflowCycleDetail>;
  agentsByCycleId: Record<string, {
    loading: boolean;
    total: number;
    agents: AgentHistorySummary[];
    error?: string;
  }>;
};

type AgentOutputViewerState = {
  projectId: string;
  agentId: string;
  agentName: string;
  loading: boolean;
  transcriptLoading?: boolean;
  output?: AgentFullOutputResponse;
  transcript?: AgentTranscriptResponse;
  error?: string;
  query: string;
  wrap: boolean;
  viewMode: "preformatted" | "plain";
};

type RepositoryDataView = ProjectRepositorySummary & {
  loading: boolean;
  childrenByParent: RepositoryChildrenByParent;
  expandedPaths: string[];
  loadingParents: Record<string, boolean>;
  searchResults: RepositorySearchResponse | null;
  searchLoading: boolean;
  treeError?: string;
};

const emptyRepositoryData = (): RepositoryDataView => ({
  projectId: "",
  stats: undefined,
  dependencies: [],
  dependencyTotal: 0,
  summaryCache: [],
  summaryCacheTotal: 0,
  rootChildren: {
    projectId: "",
    parentPath: REPOSITORY_ROOT_PARENT,
    limit: 0,
    total: 0,
    children: [],
    truncated: false
  },
  scanTruncated: false,
  scanTruncationReason: undefined,
  loading: false,
  childrenByParent: {},
  expandedPaths: [],
  loadingParents: {},
  searchResults: null,
  searchLoading: false,
  treeError: undefined
});

const emptyHistoryData = (): HistoryCycleView => ({
  projectId: "",
  cursor: undefined,
  nextCursor: undefined,
  limit: HISTORY_RECENT_CYCLE_LIMIT,
  total: 0,
  cycles: [],
  recentPreloaded: 0,
  loading: false,
  error: undefined,
  expandedCycleIds: [],
  detailsByCycleId: {},
  agentsByCycleId: {}
});

const mergeRepositoryChildrenPage = (
  current: RepositoryDataView,
  page: RepositoryChildrenResponse,
  append: boolean
): RepositoryDataView => {
  const existing = current.childrenByParent[page.parentPath];
  const childrenByPath = new Map<string, RepositoryTreeEntry>();
  if (append && existing) {
    for (const child of existing.children) {
      childrenByPath.set(child.path, child);
    }
  }
  for (const child of page.children) {
    childrenByPath.set(child.path, child);
  }
  const nextPage = {
    ...page,
    children: [...childrenByPath.values()]
  };
  return {
    ...current,
    rootChildren: page.parentPath === REPOSITORY_ROOT_PARENT ? nextPage : current.rootChildren,
    childrenByParent: {
      ...current.childrenByParent,
      [page.parentPath]: nextPage
    },
    loadingParents: {
      ...current.loadingParents,
      [page.parentPath]: false
    },
    treeError: undefined
  };
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

type SettingsDraftState = {
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

type SettingsDraftUpdate = {
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
};

type GoalCharterDraftState = {
  currentSummary: string;
  currentDetailedIntent: string;
  currentSuccessCriteria: string;
  currentConstraints: string;
  currentNonGoals: string;
  currentTargetAudience: string;
  currentQualityBar: string;
  nonNegotiableRequirements: string;
  flexibleRequirements: string;
  niceToHaveIdeas: string;
  explicitNonGoals: string;
  userConstraints: string;
  aestheticPreferences: string;
  technicalPreferences: string;
  definitionOfDone: string;
  autopilotStrategy: AutopilotStrategy;
};

type GoalCharterDraftUpdate = Partial<Omit<GoalCharterDraftState, "autopilotStrategy">> & {
  autopilotStrategy?: AutopilotStrategy;
};

type GoalCharterAiBusyState =
  | { kind: "polish"; field: GoalCharterDraftTextField }
  | { kind: "generate" };

type StatusChipTone =
  | "running"
  | "paused"
  | "idle"
  | "blocked"
  | "completed"
  | "not-started"
  | "pending"
  | "error"
  | "warning"
  | "success";

type ShellStatusTone = Extract<StatusChipTone, "idle" | "running" | "paused" | "blocked" | "completed">;

type ShellAction = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
};

const interfaceIconUrl = new URL("../../assets/branding/interface_icon.png", import.meta.url).href;
const WORKFLOW_AGENT_STALE_MS = 10 * 60 * 1000;
const AGENT_HISTORY_PAGE_SIZE = 20;
const HISTORY_RECENT_CYCLE_LIMIT = 5;
const HISTORY_OLDER_CYCLE_PAGE_SIZE = 20;
const LOG_ACTIVITY_PAGE_SIZE = 80;
const LOG_COMMAND_PAGE_SIZE = 50;
const RUN_DETAIL_PREVIEW_TEXT_LIMIT = 4_000;
const REPOSITORY_TREE_PAGE_SIZE = 20_000;
const REPOSITORY_SEARCH_RESULT_LIMIT = 5_000;
const WORKSPACE_VISUAL_TABS: VisualExportTab[] = [
  { id: "overview", label: "Overview" },
  { id: "workflow", label: "Workflow" },
  { id: "history", label: "History" },
  { id: "repository", label: "Repository" },
  { id: "settings", label: "Settings" }
];
const WORKSPACE_TAB_IDS = new Set<WorkspaceVisualTabId>(WORKSPACE_VISUAL_TABS.map((tab) => tab.id));
const VISUAL_EXPORT_READY_TIMEOUT_MS = 5_000;
const AGENT_BACKED_WORKFLOW_COMMANDS = new Set([
  "run-recommendation",
  "complete-preview",
  "continue",
  "recover",
  "retry-goal",
  "approve-recommendation",
  "create-scoped-goal",
  "advance-stage",
  "run-integrity",
  "run-merge"
]);

type VisualExportReadiness = {
  activeProjectId?: string;
  activeWorkspaceTab: WorkspaceVisualTabId;
  logFeedProjectId: string;
  logFeedLoading: boolean;
  repositoryProjectId: string;
  repositoryLoading: boolean;
  historyProjectId: string;
  historyLoading: boolean;
  workflowAgentPageLoading: boolean;
  manualAgentPageLoading: boolean;
};

type VisualExportScrollMetrics = {
  totalHeight: number;
  maxScrollY: number;
  viewportWidth: number;
  viewportHeight: number;
};

const delay = async (durationMs: number): Promise<void> =>
  await new Promise((resolve) => window.setTimeout(resolve, durationMs));

const waitForVisualRender = async (): Promise<void> => {
  await new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined)));
  await new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined)));
  await delay(80);
};

const waitForVisualCondition = async (
  condition: () => boolean,
  description: string,
  timeoutMs = VISUAL_EXPORT_READY_TIMEOUT_MS
): Promise<void> => {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (condition()) {
      return;
    }
    await delay(80);
  }
  throw new Error(`Timed out waiting for ${description}.`);
};

const getVisualExportScrollMetrics = (): VisualExportScrollMetrics => {
  const scrollingElement = document.scrollingElement ?? document.documentElement;
  const viewportWidth = Math.ceil(window.innerWidth);
  const viewportHeight = Math.ceil(window.innerHeight);
  const totalHeight = Math.ceil(Math.max(
    scrollingElement.scrollHeight,
    document.documentElement.scrollHeight,
    document.body.scrollHeight,
    viewportHeight
  ));

  return {
    totalHeight,
    maxScrollY: Math.max(0, totalHeight - viewportHeight),
    viewportWidth,
    viewportHeight
  };
};

const buildVisualExportCaptureTargets = (
  tab: VisualExportTab,
  metrics: VisualExportScrollMetrics
): VisualExportCaptureTarget[] => {
  const targets: VisualExportCaptureTarget[] = [];
  let nextStartY = 0;

  while (nextStartY < metrics.totalHeight) {
    const scrollY = Math.min(nextStartY, metrics.maxScrollY);
    const cropTop = nextStartY - scrollY;
    const sliceHeight = Math.min(metrics.viewportHeight - cropTop, metrics.totalHeight - nextStartY);
    if (sliceHeight <= 0) {
      break;
    }

    targets.push({
      tab,
      pageIndex: targets.length,
      pageCount: 1,
      scrollY,
      cropTop,
      sliceHeight,
      viewportWidth: metrics.viewportWidth,
      viewportHeight: metrics.viewportHeight
    });
    nextStartY += sliceHeight;
  }

  const pageCount = Math.max(1, targets.length);
  return targets.length
    ? targets.map((target) => ({ ...target, pageCount }))
    : [{
      tab,
      pageIndex: 0,
      pageCount,
      scrollY: 0,
      cropTop: 0,
      sliceHeight: metrics.viewportHeight,
      viewportWidth: metrics.viewportWidth,
      viewportHeight: metrics.viewportHeight
    }];
};

const normalizeWorkspaceTab = (tab?: string): WorkspaceVisualTabId => {
  if (tab === "reports") {
    return "workflow";
  }
  if (tab === "runs" || tab === "logs" || tab === "agents") {
    return "history";
  }
  if (tab === "credentials") {
    return "settings";
  }
  if (tab === "file" || tab === "diff") {
    return "repository";
  }
  return WORKSPACE_TAB_IDS.has(tab as WorkspaceVisualTabId) ? tab as WorkspaceVisualTabId : "overview";
};

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

const runtimeReadinessStatusChip = (report: RuntimeReadinessReport): { label: string; tone: StatusChipTone } => {
  switch (report.status) {
    case "ready":
      return { label: "Ready", tone: "success" };
    case "checking":
      return { label: "Checking", tone: "running" };
    case "blocked":
      return { label: "Blocked", tone: "error" };
  }
};

const runtimeDependencyStatusChip = (status: RuntimeReadinessReport["checks"][number]["status"]): { label: string; tone: StatusChipTone } => {
  switch (status) {
    case "passed":
      return { label: "Passed", tone: "success" };
    case "warning":
      return { label: "Warning", tone: "warning" };
    case "checking":
      return { label: "Checking", tone: "running" };
    case "failed":
      return { label: "Failed", tone: "error" };
  }
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

const formatMilliseconds = (value?: number): string => {
  if (value === undefined) {
    return "Not recorded";
  }
  if (value < 1_000) {
    return `${Math.max(1, Math.round(value))} ms`;
  }
  const seconds = value / 1_000;
  return seconds < 60 ? `${seconds.toFixed(seconds < 10 ? 1 : 0)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
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

const repositorySearchScopeLabel = (scope?: RepositorySearchResponse["searchScope"]): string => {
  if (scope === "loaded_tree_nodes") {
    return "Loaded tree nodes";
  }
  if (scope === "full_deep_index") {
    return "Full deep index";
  }
  return "Indexed files";
};

const excludedPathExplanation = (pathName: string): string => {
  const topLevel = pathName.split("/")[0] ?? pathName;
  if (topLevel === ".git") {
    return "Git object database and refs are excluded because they are repository metadata, not source files.";
  }
  if (topLevel === "node_modules") {
    return "Installed dependencies are excluded to keep scans responsive and avoid indexing vendored packages.";
  }
  if (topLevel === ".agent-workbench") {
    return "Workbench state, managed worktrees, logs, and handoff files are excluded from project indexing.";
  }
  if (topLevel === "dist" || topLevel === "build" || topLevel === "out" || topLevel === "release") {
    return "Generated build output is excluded because it can be large and reproducible from source.";
  }
  if (topLevel.includes("cache") || topLevel === ".vite" || topLevel === ".next" || topLevel === ".turbo") {
    return "Cache folders are excluded because they are generated and can change frequently.";
  }
  return "Excluded by built-in repository defaults or this project's ignore rules.";
};

const commonExcludedPathExplanations = [
  [".git", excludedPathExplanation(".git")],
  ["node_modules", excludedPathExplanation("node_modules")],
  [".agent-workbench", excludedPathExplanation(".agent-workbench")],
  ["dist/build/out", excludedPathExplanation("dist")],
  ["cache folders", excludedPathExplanation(".cache")]
] as const;

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

const workflowModeLabel = (mode: ProjectWorkflowState["workflowMode"]): string =>
  mode === "fast" ? "Fast mode" : "Normal mode";

const previewStatusLabel = (status?: NonNullable<ProjectWorkflowState["previewRequest"]>["status"]): string => {
  switch (status) {
    case "queued":
      return "Preview queued";
    case "active":
      return "Generating preview";
    case "ready":
      return "Preview ready";
    case "completed":
      return "Preview completed";
    case "cancelled":
      return "Preview cancelled";
    case "none":
    default:
      return "No preview";
  }
};

const previewButtonLabel = (status?: NonNullable<ProjectWorkflowState["previewRequest"]>["status"]): string => {
  switch (status) {
    case "queued":
      return "Preview Queued";
    case "active":
      return "Generating Preview";
    case "ready":
      return "Preview Ready";
    default:
      return "Generate Preview";
  }
};

const autopilotProfileLabel = (profile: AutopilotProfile): string => {
  switch (profile) {
    case "conservative":
      return "Conservative";
    case "aggressive":
      return "Aggressive";
    case "custom":
      return "Custom";
    case "balanced":
      return "Balanced";
  }
};

const strategyPresetLabel = (strategy: AutopilotStrategy, presets: AutopilotPreset[]): string =>
  strategy.presetId === "custom"
    ? "Custom"
    : presets.find((preset) => preset.id === strategy.presetId)?.label ?? strategy.presetId.replace(/_/g, " ");

const goalRestrictivenessLabel = (value: number): string => {
  switch (goalRestrictivenessMode(value)) {
    case "very_strict":
      return "Very strict";
    case "goal_first":
      return "Goal-first";
    case "balanced":
      return "Balanced";
    case "exploratory":
      return "Exploratory";
    case "highly_creative":
      return "Highly creative / divergent";
  }
};

const goalRestrictivenessDescription = (value: number): string => {
  switch (goalRestrictivenessMode(value)) {
    case "very_strict":
      return "Follow the Ultimate Goal almost exactly and avoid unrequested features.";
    case "goal_first":
      return "Treat the Ultimate Goal as mostly fixed while allowing small goal-supporting improvements.";
    case "balanced":
      return "Treat the goal as the destination while allowing smarter routing and useful improvements.";
    case "exploratory":
      return "Treat the goal as a strong theme and allow meaningful product improvement proposals.";
    case "highly_creative":
      return "Treat the goal as inspiration. Major changes may be proposed, but not silently applied.";
  }
};

const enumLabel = (value: string): string =>
  value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());

const autopilotPauseReasonLabel = (reason?: NonNullable<ProjectWorkflowState["autopilotStatus"]>["pausedReason"]): string =>
  reason ? reason.replace(/_/g, " ") : "None";

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

type WorkflowChecklistGroupSummary = {
  id: string;
  title: string;
  openCount: number;
  metCount: number;
  unknownCount: number;
  blockedCount: number;
  totalCount: number;
  representative?: string;
  relatedPaths: string[];
};

type WorkflowChecklistOverview = {
  percentComplete?: number;
  requiredMet: number;
  requiredTotal: number;
  openRequired: number;
  unknownCount: number;
  groups: WorkflowChecklistGroupSummary[];
  topOpenGroups: WorkflowChecklistGroupSummary[];
  topMetGroups: WorkflowChecklistGroupSummary[];
  topUnknownGroups: WorkflowChecklistGroupSummary[];
};

const summarizeText = (value?: string, fallback = "Not available", maxLength = 180): string => {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return fallback;
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }

  const prefix = normalized.slice(0, maxLength);
  const sentenceEnd = prefix.lastIndexOf(". ");
  const cutIndex = sentenceEnd > 80 ? sentenceEnd + 1 : prefix.lastIndexOf(" ");
  const safeCut = cutIndex > 80 ? cutIndex : maxLength;
  return `${prefix.slice(0, safeCut).trim().replace(/[.,;:]+$/, "")}...`;
};

const redactSensitiveText = (value?: string): string => {
  if (!value) {
    return "";
  }

  return value
    .replace(/AGENT_WORKBENCH_CREDENTIAL\s+({[^\r\n]+})/g, "AGENT_WORKBENCH_CREDENTIAL [redacted]")
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g, "[redacted-secret]")
    .replace(/\b(?:ghp|github_pat)_[A-Za-z0-9_]{16,}\b/g, "[redacted-token]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[redacted-access-key]")
    .replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted-token]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [redacted]")
    .replace(
      /\b(api[_\s-]?key|secret(?:[_\s-]?key)?|token|access[_\s-]?token|refresh[_\s-]?token|client[_\s-]?secret|authorization|password)\b(\s*[:=]\s*["']?)([A-Za-z0-9_./+=~:-]{12,})(["']?)/gi,
      "$1$2[redacted]$4"
    )
    .replace(/(--(?:api-key|token|secret|password)\s+)(\S{8,})/gi, "$1[redacted]")
    .replace(/([?&](?:api[_-]?key|key|token|secret|access_token|client_secret)=)([^&\s]+)/gi, "$1[redacted]");
};

const summarizeSafeText = (value?: string, fallback = "Not available", maxLength = 180): string =>
  summarizeText(redactSensitiveText(value), fallback, maxLength);

const uniqueSortedStrings = (values: string[]): string[] =>
  [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort((left, right) => left.localeCompare(right));

const getWorkflowLastUpdatedAt = (workflow?: ProjectWorkflowState, agents: AgentState[] = []): string | undefined => {
  const timestamps = [
    workflow?.workflowCycle.completedAt,
    workflow?.workflowCycle.startedAt,
    workflow?.recommendationsGeneratedAt,
    workflow?.ultimateGoal.lastUpdatedAt,
    workflow?.ultimateGoal.confirmedAt,
    workflow?.ultimateGoalProgress?.updatedAt,
    workflow?.ultimateGoalCompletion?.updatedAt,
    workflow?.taskMap.updatedAt,
    workflow?.repair.lastUpdatedAt,
    workflow?.manualHandoff?.createdAt,
    ...(workflow ? Object.values(workflow.stepProgress).flatMap((step) => [
      step.updatedAt,
      step.lastEventAt,
      step.completedAt,
      step.startedAt
    ]) : []),
    ...(workflow?.activityLog.map((event) => event.timestamp) ?? []),
    ...agents.flatMap((agent) => [
      agent.lastActivityAt,
      agent.completedAt,
      agent.startedAt,
      agent.createdAt
    ])
  ]
    .map(toTime)
    .filter((time) => time > 0);

  return timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : undefined;
};

const inferWorkflowChecklistGroupTitle = (check: ProjectWorkflowState["goalChecklist"][number]): string => {
  const text = `${check.title} ${check.description} ${check.evidence} ${check.relatedPaths.join(" ")}`.toLowerCase();
  if (/\bcompany|companies|employer|firm|profile page|company page\b/.test(text)) {
    return "Company pages";
  }
  if (/\bquestion bank|questions|practice problem|prompt|answer key\b/.test(text)) {
    return "Question bank";
  }
  if (/\bcompensation|salary|pay band|source context|offer|level\b/.test(text)) {
    return "Compensation/source context";
  }
  if (/\bprovenance|citation|citations|source|sources|reference|attribution\b/.test(text)) {
    return "Source provenance";
  }
  if (/\bmental math|arithmetic|estimation|calculation|calculate\b/.test(text)) {
    return "Mental math";
  }
  if (/\blocal data|persistence|persist|storage|database|cache|indexeddb|sqlite\b/.test(text)) {
    return "Local data/persistence";
  }
  if (/\btest|tests|validation|validate|integrity|lint|typecheck|build\b/.test(text)) {
    return "Testing/validation";
  }
  if (/\bworkflow|agent|cycle|approval|autopilot|blocker\b/.test(text)) {
    return "Workflow operations";
  }
  if (/\bui|ux|layout|screen|responsive|visual|navigation\b/.test(text)) {
    return "Interface";
  }
  return goalCheckSourceLabel(check.source);
};

const buildWorkflowChecklistGroups = (
  checklist: ProjectWorkflowState["goalChecklist"],
  taskMap?: ProjectWorkflowState["taskMap"]
): WorkflowChecklistGroupSummary[] => {
  const checksById = new Map(checklist.map((check) => [check.id, check]));

  if (taskMap?.groups.length) {
    return taskMap.groups.map((group) => {
      const checks = group.checkIds.map((id) => checksById.get(id)).filter((check): check is ProjectWorkflowState["goalChecklist"][number] => Boolean(check));
      const unknownCount = checks.filter((check) => check.status === "unknown").length;
      const blockedCount = checks.filter((check) =>
        check.status !== "met" &&
        check.status !== "not_applicable" &&
        /\b(block|blocked|fail|failed|missing|required)\b/i.test(`${check.title} ${check.description} ${check.evidence}`)
      ).length;

      return {
        id: group.id,
        title: group.title,
        openCount: group.openCheckCount,
        metCount: group.metCheckCount,
        unknownCount,
        blockedCount,
        totalCount: Math.max(group.checkIds.length, group.openCheckCount + group.metCheckCount),
        representative: group.representativeChecks[0] ?? checks[0]?.title,
        relatedPaths: uniqueSortedStrings([...group.relatedPaths, ...checks.flatMap((check) => check.relatedPaths)]).slice(0, 5)
      };
    });
  }

  const groups = new Map<string, WorkflowChecklistGroupSummary>();
  for (const check of checklist) {
    const title = inferWorkflowChecklistGroupTitle(check);
    const existing = groups.get(title) ?? {
      id: title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      title,
      openCount: 0,
      metCount: 0,
      unknownCount: 0,
      blockedCount: 0,
      totalCount: 0,
      representative: check.title,
      relatedPaths: []
    };

    const isOpen = check.required && check.status !== "met" && check.status !== "not_applicable";
    existing.totalCount += 1;
    existing.openCount += isOpen ? 1 : 0;
    existing.metCount += check.status === "met" ? 1 : 0;
    existing.unknownCount += check.status === "unknown" ? 1 : 0;
    existing.blockedCount += isOpen && /\b(block|blocked|fail|failed|missing|required)\b/i.test(`${check.title} ${check.description} ${check.evidence}`) ? 1 : 0;
    existing.relatedPaths = uniqueSortedStrings([...existing.relatedPaths, ...check.relatedPaths]).slice(0, 5);
    groups.set(title, existing);
  }

  return [...groups.values()];
};

const buildWorkflowChecklistOverview = (
  workflow?: ProjectWorkflowState
): WorkflowChecklistOverview => {
  const checklist = workflow?.goalChecklist ?? [];
  const requiredChecks = checklist.filter((check) => check.required && check.status !== "not_applicable");
  const requiredMet = requiredChecks.filter((check) => check.status === "met").length;
  const requiredTotal = requiredChecks.length;
  const openRequired = requiredChecks.length - requiredMet;
  const groups = buildWorkflowChecklistGroups(checklist, workflow?.taskMap);
  const byOpen = [...groups].sort((left, right) =>
    right.openCount - left.openCount ||
    right.blockedCount - left.blockedCount ||
    left.title.localeCompare(right.title)
  );
  const byMet = [...groups].sort((left, right) =>
    right.metCount - left.metCount ||
    left.title.localeCompare(right.title)
  );
  const byUnknown = [...groups].sort((left, right) =>
    right.unknownCount - left.unknownCount ||
    right.blockedCount - left.blockedCount ||
    left.title.localeCompare(right.title)
  );

  return {
    percentComplete: workflow?.ultimateGoalProgress?.percentComplete ??
      (requiredTotal > 0 ? Math.round((requiredMet / requiredTotal) * 100) : undefined),
    requiredMet,
    requiredTotal,
    openRequired,
    unknownCount: requiredChecks.filter((check) => check.status === "unknown").length,
    groups,
    topOpenGroups: byOpen.filter((group) => group.openCount > 0).slice(0, 5),
    topMetGroups: byMet.filter((group) => group.metCount > 0).slice(0, 4),
    topUnknownGroups: byUnknown.filter((group) => group.unknownCount > 0 || group.blockedCount > 0).slice(0, 4)
  };
};

const getCurrentCycleChangedFiles = (workflow: ProjectWorkflowState | undefined, agents: AgentState[]): string[] => {
  if (!workflow) {
    return [];
  }
  const currentCycleAgents = agents.filter((agent) =>
    agent.workflowCycleNumber === undefined || agent.workflowCycleNumber === workflow.workflowCycle.cycleNumber
  );
  return uniqueSortedStrings(currentCycleAgents.flatMap((agent) => agent.changedFiles));
};

const workflowAttentionKindLabel = (kind: WorkflowAttentionItem["kind"]): string =>
  ({
    approval: "Approval",
    blocker: "Blocker",
    credential: "Credential",
    integrity: "Integrity",
    warning: "Warning"
  })[kind];

type RunFilterId =
  | "all"
  | "recommendation"
  | "planning"
  | "coding"
  | "integrity"
  | "merge"
  | "errors"
  | "completed";

type RunEvidenceItem = {
  id: string;
  title: string;
  detail: string;
  meta?: string;
  tone?: "neutral" | "warning" | "danger";
};

const RUN_FILTERS: Array<{ id: RunFilterId; label: string }> = [
  { id: "all", label: "All" },
  { id: "recommendation", label: "Recommendation" },
  { id: "planning", label: "Planning" },
  { id: "coding", label: "Coding" },
  { id: "integrity", label: "Integrity" },
  { id: "merge", label: "Merge" },
  { id: "errors", label: "Errors/blocked" },
  { id: "completed", label: "Completed" }
];

const agentRunTimestamp = (agent: AgentState): string =>
  agent.completedAt ?? agent.lastActivityAt ?? agent.startedAt ?? agent.createdAt;

const runFilterMatches = (agent: AgentState, filter: RunFilterId): boolean => {
  switch (filter) {
    case "recommendation":
      return agent.category === "recommendation";
    case "planning":
      return agent.category === "bootstrap" || agent.category === "goal";
    case "coding":
      return agent.category === "coding";
    case "integrity":
      return agent.category === "integrity";
    case "merge":
      return agent.category === "merge";
    case "errors":
      return agent.status === "failed" ||
        agent.status === "conflicted" ||
        agent.status === "disconnected" ||
        agent.status === "waiting_approval" ||
        agent.approvals.some((approval) => approval.status === "pending");
    case "completed":
      return agent.status === "completed";
    case "all":
    default:
      return true;
  }
};

const runSearchText = (agent: AgentState, workflow?: ProjectWorkflowState): string => [
  agent.name,
  agent.category,
  agent.status,
  agent.model,
  agent.currentPhase,
  agent.currentSubtask,
  agent.taskPrompt,
  agentPreviewText(agent, workflow),
  agent.recommendationReport?.summary,
  agent.integrityReport?.summary,
  agent.mergeReport?.summary,
  agent.changedFiles.join(" "),
  agent.worktree?.branch
].filter(Boolean).join(" ").toLowerCase();

const runMatchesSearch = (agent: AgentState, search: string, workflow?: ProjectWorkflowState): boolean => {
  const query = search.trim().toLowerCase();
  return !query || runSearchText(agent, workflow).includes(query);
};

const runStageName = (agent: AgentState): string => {
  if (agent.category === "bootstrap" || agent.category === "goal") {
    return "Planning";
  }
  return agentCategoryLabel(agent.category);
};

const runModelSummary = (agent: AgentState): string =>
  `${agent.model}${agent.reasoningEffort ? ` / ${reasoningEffortLabel(agent.reasoningEffort)}${agent.reasoningEffortSource ? ` ${agent.reasoningEffortSource}` : ""}` : ""}`;

const repositoryFileExtensionLabel = (relativePath: string): string => {
  const fileName = relativePath.split("/").pop() ?? relativePath;
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex > 0 && dotIndex < fileName.length - 1 ? fileName.slice(dotIndex) : "";
};

const repositoryTreeRowKindLabel = (row: RepositoryTreeEntry): string =>
  row.type === "directory" ? "Folder" : repositoryFileExtensionLabel(row.path) || "File";

const repositoryTreeRowMeta = (row: RepositoryTreeEntry, loading = false): string => {
  if (loading) {
    return "Loading";
  }
  if (row.type === "directory") {
    return row.childCount === undefined ? "Folder" : `${row.childCount} item${row.childCount === 1 ? "" : "s"}`;
  }
  return [
    row.language,
    formatBytes(row.size ?? 0)
  ].filter(Boolean).join(" · ");
};

const repositoryPathParentDirectories = (relativePath: string): string[] => {
  const parts = relativePath.split("/").filter(Boolean);
  const parents: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    parents.push(parts.slice(0, index).join("/"));
  }
  return parents;
};

const runResultSummary = (agent: AgentState, workflow?: ProjectWorkflowState): string => {
  if (agent.status === "waiting_approval") {
    return "Waiting for an explicit approval before continuing.";
  }
  if (agent.status === "failed" || agent.status === "conflicted" || agent.status === "disconnected") {
    return summarizeText(agent.disconnectedReason ?? agent.currentPhase ?? latestMeaningfulAgentDetail(agent), "Run needs review.", 170);
  }
  if (agent.recommendationReport?.summary) {
    return summarizeText(agent.recommendationReport.summary, "Recommendation report captured.", 170);
  }
  if (agent.integrityReport?.summary) {
    return summarizeText(agent.integrityReport.summary, "Integrity report captured.", 170);
  }
  if (agent.mergeReport?.summary) {
    return summarizeText(agent.mergeReport.summary, "Merge report captured.", 170);
  }
  return summarizeText(agentPreviewText(agent, workflow), "No result summary captured yet.", 170);
};

const runNextAction = (agent: AgentState): string => {
  if (agent.approvals.some((approval) => approval.status === "pending") || agent.status === "waiting_approval") {
    return "Review pending approvals.";
  }
  if (agent.mergeReport?.conflicts.length || agent.status === "conflicted") {
    return "Review conflicts and continue from Workflow.";
  }
  if (agent.integrityReport?.checks.some((check) => check.status === "failed") || agent.status === "failed") {
    return "Review failures and use Workflow for repair or recovery.";
  }
  if (agent.status === "disconnected") {
    return "Recover the workflow from the saved state.";
  }
  if (agent.status === "running" || agent.status === "starting") {
    return "Monitor current output.";
  }
  if (agent.category === "recommendation" && agent.recommendationReport?.nextSteps.length) {
    return "Open Workflow to choose the next bounded task.";
  }
  return "No immediate action recorded.";
};

const runChecksSummary = (agent: AgentState): string => {
  if (agent.integrityReport?.checks.length) {
    const passed = agent.integrityReport.checks.filter((check) => check.status === "passed").length;
    const failed = agent.integrityReport.checks.filter((check) => check.status === "failed").length;
    const skipped = agent.integrityReport.checks.filter((check) => check.status === "skipped").length;
    return `${passed}/${agent.integrityReport.checks.length} checks passed${failed ? `, ${failed} failed` : ""}${skipped ? `, ${skipped} skipped` : ""}`;
  }

  if (agent.commandLog.length) {
    const failedCommands = agent.commandLog.filter((command) =>
      command.exitCode !== undefined && command.exitCode !== null && command.exitCode !== 0
    ).length;
    return `${agent.commandLog.length} command${agent.commandLog.length === 1 ? "" : "s"} recorded${failedCommands ? `, ${failedCommands} failed` : ""}`;
  }

  return "No tests/checks captured";
};

const runApprovalSummary = (agent: AgentState): string => {
  const pending = agent.approvals.filter((approval) => approval.status === "pending").length;
  if (!agent.approvals.length) {
    return "No approvals";
  }
  return `${pending} pending / ${agent.approvals.length} total`;
};

const runRiskItems = (agent: AgentState): string[] => {
  const failedChecks = agent.integrityReport?.checks
    .filter((check) => check.status === "failed")
    .map((check) => `${check.name} failed`) ?? [];
  return [
    ...(agent.disconnectedReason ? [agent.disconnectedReason] : []),
    ...(agent.mergeReport?.conflicts.map((conflict) => `Merge conflict: ${conflict}`) ?? []),
    ...(agent.integrityReport?.risks ?? []),
    ...failedChecks,
    ...agent.approvals.filter((approval) => approval.status === "pending").map((approval) => `Approval pending: ${approval.summary}`)
  ];
};

const runEvidenceItems = (agent: AgentState, workflow?: ProjectWorkflowState): RunEvidenceItem[] => {
  const items: RunEvidenceItem[] = [];

  if (agent.recommendationReport) {
    for (const step of agent.recommendationReport.nextSteps.slice(0, 4)) {
      items.push({
        id: `recommendation:${step.rank}:${step.title}`,
        title: step.title,
        detail: summarizeText(step.summary || step.rationale, "Recommendation captured.", 180),
        meta: `Rank ${step.rank} · ${step.priority} priority · ${Math.round(step.confidence * 100)}% confidence`,
        tone: step.riskLevel === "high" ? "warning" : "neutral"
      });
    }
  }

  if (agent.integrityReport) {
    for (const check of agent.integrityReport.checks.slice(0, 6)) {
      items.push({
        id: `check:${check.name}`,
        title: check.name,
        detail: summarizeText(check.outputSnippet || check.command, "Check recorded.", 180),
        meta: `${check.status}${check.command ? ` · ${check.command}` : ""}`,
        tone: check.status === "failed" ? "danger" : check.status === "skipped" ? "warning" : "neutral"
      });
    }
  }

  if (agent.mergeReport) {
    items.push({
      id: "merge-summary",
      title: "Merge result",
      detail: summarizeText(agent.mergeReport.summary, "Merge report captured.", 180),
      meta: agent.mergeReport.conflicts.length
        ? `${agent.mergeReport.conflicts.length} conflicts`
        : `${agent.mergeReport.mergedBranches.length} branches merged`,
      tone: agent.mergeReport.conflicts.length ? "danger" : "neutral"
    });
  }

  if (agent.category === "goal" && workflow?.scopedGoal && agent.workflowCycleNumber === workflow.workflowCycle.cycleNumber) {
    items.push({
      id: "scoped-goal",
      title: "Scoped goal",
      detail: summarizeText(workflow.scopedGoal.executionBrief || workflow.scopedGoal.summary, "Scoped goal captured.", 180),
      meta: `${workflow.scopedGoal.acceptanceCriteria.length} acceptance criteria`
    });
  }

  for (const event of sortEventsByAge(agent.events).slice(0, 4)) {
    items.push({
      id: `event:${event.id}`,
      title: event.title,
      detail: summarizeText(event.detail, "Runtime event recorded.", 160),
      meta: `${workflowEventStatusLabel(event.status)} · ${formatDateTime(event.timestamp)}`,
      tone: event.status === "failed" ? "danger" : event.status === "waiting" ? "warning" : "neutral"
    });
  }

  if (agent.changedFiles.length) {
    items.push({
      id: "changed-files",
      title: "Files/areas affected",
      detail: agent.changedFiles.slice(0, 8).join(", "),
      meta: `${agent.changedFiles.length} changed file${agent.changedFiles.length === 1 ? "" : "s"}`
    });
  }

  return items;
};

const stringifyRawValue = (value: unknown): string => {
  const toPreview = (text: string): string => {
    const clipped = text.length > RUN_DETAIL_PREVIEW_TEXT_LIMIT
      ? `${text.slice(0, RUN_DETAIL_PREVIEW_TEXT_LIMIT)}\n...[truncated for UI performance]`
      : text;
    return redactSensitiveText(clipped);
  };

  if (typeof value === "string") {
    return toPreview(value);
  }

  try {
    return toPreview(JSON.stringify(value, null, 2));
  } catch {
    return toPreview(String(value));
  }
};

const renderOutputPreview = (value?: string): string => {
  if (!value) {
    return "";
  }
  const clipped = value.length > RUN_DETAIL_PREVIEW_TEXT_LIMIT
    ? `${value.slice(0, RUN_DETAIL_PREVIEW_TEXT_LIMIT)}\n...[truncated for UI performance]`
    : value;
  return redactSensitiveText(clipped);
};

const toLineList = (value: string): string[] =>
  value
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const fromLineList = (entries: string[] | undefined): string => (entries ?? []).join("\n");

const goalCharterTextFields: GoalCharterDraftTextField[] = [
  "currentSummary",
  "currentDetailedIntent",
  "currentSuccessCriteria",
  "currentConstraints",
  "currentNonGoals",
  "currentTargetAudience",
  "currentQualityBar",
  "nonNegotiableRequirements",
  "flexibleRequirements",
  "niceToHaveIdeas",
  "explicitNonGoals",
  "userConstraints",
  "aestheticPreferences",
  "technicalPreferences",
  "definitionOfDone"
];

const goalCharterDraftAiPayload = (draft: GoalCharterDraftState): Record<GoalCharterDraftTextField, string> =>
  Object.fromEntries(goalCharterTextFields.map((field) => [field, draft[field]])) as Record<GoalCharterDraftTextField, string>;

const goalCharterDraftUpdateFromAi = (draft: GoalCharterAiDraft): GoalCharterDraftUpdate => ({
  currentSummary: draft.currentSummary,
  currentDetailedIntent: draft.currentDetailedIntent,
  currentSuccessCriteria: fromLineList(draft.currentSuccessCriteria),
  currentConstraints: fromLineList(draft.currentConstraints),
  currentNonGoals: fromLineList(draft.currentNonGoals),
  currentTargetAudience: draft.currentTargetAudience,
  currentQualityBar: draft.currentQualityBar,
  nonNegotiableRequirements: fromLineList(draft.nonNegotiableRequirements),
  flexibleRequirements: fromLineList(draft.flexibleRequirements),
  niceToHaveIdeas: fromLineList(draft.niceToHaveIdeas),
  explicitNonGoals: fromLineList(draft.explicitNonGoals),
  userConstraints: fromLineList(draft.userConstraints),
  aestheticPreferences: fromLineList(draft.aestheticPreferences),
  technicalPreferences: fromLineList(draft.technicalPreferences),
  definitionOfDone: fromLineList(draft.definitionOfDone)
});

const cloneStrategy = (strategy?: AutopilotStrategy): AutopilotStrategy => {
  const base = strategy ?? createDefaultAutopilotStrategy();
  return {
    ...base,
    visualPreferences: {
      ...base.visualPreferences
    },
    autonomyBudget: {
      ...base.autonomyBudget
    }
  };
};

const goalCharterDraftFromWorkflow = (workflow?: ProjectWorkflowState): GoalCharterDraftState => {
  const charter = workflow?.goalCharter;
  const currentGoal = charter?.currentEffectiveGoal?.summary
    ? charter.currentEffectiveGoal
    : workflow?.ultimateGoal;
  return {
    currentSummary: currentGoal?.summary ?? "",
    currentDetailedIntent: currentGoal?.detailedIntent ?? "",
    currentSuccessCriteria: fromLineList(currentGoal?.successCriteria),
    currentConstraints: fromLineList(currentGoal?.constraints),
    currentNonGoals: fromLineList(currentGoal?.nonGoals),
    currentTargetAudience: currentGoal?.targetAudience ?? "",
    currentQualityBar: currentGoal?.qualityBar ?? "",
    nonNegotiableRequirements: fromLineList(charter?.nonNegotiableRequirements),
    flexibleRequirements: fromLineList(charter?.flexibleRequirements),
    niceToHaveIdeas: fromLineList(charter?.niceToHaveIdeas),
    explicitNonGoals: fromLineList(charter?.explicitNonGoals),
    userConstraints: fromLineList(charter?.userConstraints),
    aestheticPreferences: fromLineList(charter?.aestheticPreferences),
    technicalPreferences: fromLineList(charter?.technicalPreferences),
    definitionOfDone: fromLineList(charter?.definitionOfDone),
    autopilotStrategy: cloneStrategy(charter?.autopilotStrategy)
  };
};

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
  projectId,
  childrenByParent,
  expandedPaths,
  loadingParents,
  searchLoading,
  selected,
  onSelect,
  onToggleDirectory,
  onLoadMore
}: {
  projectId: string;
  childrenByParent: RepositoryChildrenByParent;
  expandedPaths: string[];
  loadingParents: Record<string, boolean>;
  searchLoading: boolean;
  selected?: string;
  onSelect: (path: string) => void;
  onToggleDirectory: (path: string) => void;
  onLoadMore: (parentPath: string) => void;
}) => {
  const treeRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(480);
  const rowHeight = 40;
  const overscan = 10;

  const rows = useMemo(
    () => buildRepositoryTreeRows({
      childrenByParent,
      expandedPaths,
      loadingParents
    }),
    [childrenByParent, expandedPaths, loadingParents]
  );

  const loadMorePages = useMemo(() => {
    const expanded = new Set(expandedPaths);
    return Object.values(childrenByParent)
      .filter((page) => page.nextCursor && (page.parentPath === REPOSITORY_ROOT_PARENT || expanded.has(page.parentPath)))
      .sort((left, right) => left.parentPath.localeCompare(right.parentPath));
  }, [childrenByParent, expandedPaths]);

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
  }, [projectId]);

  useEffect(() => {
    if (!selected) {
      return;
    }
    const selectedIndex = rows.findIndex((row) => row.path === selected);
    if (selectedIndex < 0) {
      return;
    }
    const nextTop = Math.max(0, selectedIndex * rowHeight - rowHeight * 3);
    setScrollTop(nextTop);
    treeRef.current?.scrollTo({ top: nextTop });
  }, [rows, selected]);

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
        <>
          <div className="tree__spacer" style={{ height: `${totalHeight}px` }}>
            <div className="tree__window" style={{ transform: `translateY(${visibleStart * rowHeight}px)` }}>
              {visibleRows.map((row) => (
                <button
                  key={row.path}
                  className={`tree-row tree-row--${row.type} ${selected === row.path ? "tree-row--selected" : ""}`}
                  style={{ paddingLeft: `${row.depth * 16 + 14}px` }}
                  type="button"
                  aria-expanded={row.type === "directory" ? row.expanded : undefined}
                  title={row.path}
                  onClick={() => {
                    onSelect(row.path);
                    if (row.type === "directory") {
                      onToggleDirectory(row.path);
                    }
                  }}
                >
                  <span className="tree-row__marker" aria-hidden="true">
                    {row.type === "directory" ? row.expanded ? "▾" : "▸" : ""}
                  </span>
                  <span className="tree-row__icon" aria-hidden="true">{row.type === "directory" ? "DIR" : repositoryFileExtensionLabel(row.path) || "FILE"}</span>
                  <span className={`tree-row__kind tree-row__kind--${row.type}`}>{repositoryTreeRowKindLabel(row)}</span>
                  <span className="tree-row__label">{row.name}</span>
                  <span className="tree-row__meta">{repositoryTreeRowMeta(row, row.loading)}</span>
                </button>
              ))}
            </div>
          </div>
          {loadMorePages.length ? (
            <div className="tree__load-more">
              {loadMorePages.slice(0, 3).map((page) => (
                <button
                  key={page.parentPath || "root"}
                  className="secondary-button secondary-button--compact"
                  type="button"
                  onClick={() => onLoadMore(page.parentPath)}
                >
                  Load more {page.parentPath || "root"} items
                </button>
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <div className="empty-copy">{searchLoading ? "Searching repository." : "No repository entries are loaded yet."}</div>
      )}
    </div>
  );
};

const AgentCard = ({
  agent,
  workflow,
  selected = false,
  onSelect,
  onOpenOutput
}: {
  agent: AgentState;
  workflow?: ProjectWorkflowState;
  selected?: boolean;
  onSelect?: (agentId: string) => void;
  onOpenOutput?: (agent: AgentState) => void;
}) => {
  const status = agentLifecycleStatusChip(agent.status);
  return (
    <article className={`agent-card ${selected ? "agent-card--selected" : ""}`}>
      <div className="agent-card__header">
        <div>
          <strong>{agent.name}</strong>
          <div className="agent-card__subtle">{agentCategoryLabel(agent.category)}</div>
        </div>
        <StatusChip label={status.label} tone={status.tone} />
      </div>
      <div className="agent-card__meta">
        <span>{agent.lastActivityAt ? `Updated ${formatDateTime(agent.lastActivityAt)}` : "Waiting to start"}</span>
        <span>{runModelSummary(agent)}</span>
        <span>{agent.approvals.filter((approval) => approval.status === "pending").length} approvals</span>
        <span>{agent.changedFiles.length} changed files</span>
      </div>
      <p>{redactSensitiveText(agentPreviewText(agent, workflow))}</p>
      <div className="agent-card__actions">
        <button className="primary-button secondary-button--compact" type="button" onClick={() => onOpenOutput?.(agent)}>
          View full output
        </button>
        <button className="secondary-button secondary-button--compact" type="button" onClick={() => onSelect?.(agent.id)}>
          Select
        </button>
      </div>
    </article>
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

type LogFilterId = "all" | "workflow" | "agent" | "commands" | "approvals" | "errors" | "warnings";
type LogEventKind = "workflow" | "agent" | "command" | "approval";

type LogEventView = {
  id: string;
  timestamp: string;
  kind: LogEventKind;
  typeLabel: string;
  title: string;
  summary: string;
  detail?: string;
  actor?: string;
  statusLabel: string;
  statusTone: StatusChipTone;
};

const LOG_FILTERS: Array<{ id: LogFilterId; label: string }> = [
  { id: "all", label: "All" },
  { id: "workflow", label: "Workflow" },
  { id: "agent", label: "Agent messages" },
  { id: "commands", label: "Commands" },
  { id: "approvals", label: "Approvals" },
  { id: "errors", label: "Errors" },
  { id: "warnings", label: "Warnings" }
];

const textLooksWarning = (value?: string): boolean =>
  /\b(warn|warning|caution|attention|degraded|stale)\b/i.test(value ?? "");

const runtimeStatusChip = (status?: RuntimeEventRecord["status"]): { label: string; tone: StatusChipTone } => {
  if (status === "running") {
    return { label: "Running", tone: "running" };
  }
  if (status === "waiting") {
    return { label: "Pending", tone: "pending" };
  }
  if (status === "completed") {
    return { label: "Completed", tone: "completed" };
  }
  if (status === "failed") {
    return { label: "Error", tone: "error" };
  }
  return { label: "Idle", tone: "idle" };
};

const commandStatusChip = (command: Pick<ProjectCommandLogEntry, "status" | "exitCode" | "completedAt">): { label: string; tone: StatusChipTone } => {
  const status = command.status.toLowerCase();
  if (command.exitCode !== undefined && command.exitCode !== null && command.exitCode !== 0) {
    return { label: "Error", tone: "error" };
  }
  if (/\b(fail|error|cancel|reject)\b/.test(status)) {
    return { label: "Error", tone: "error" };
  }
  if (/\b(run|start|progress)\b/.test(status) && !command.completedAt) {
    return { label: "Running", tone: "running" };
  }
  if (/\b(skip|warn)\b/.test(status)) {
    return { label: "Warning", tone: "warning" };
  }
  return { label: command.completedAt ? "Completed" : "Pending", tone: command.completedAt ? "completed" : "pending" };
};

const agentLifecycleStatusChip = (status: AgentState["status"]): { label: string; tone: StatusChipTone } =>
  ({
    idle: { label: "Idle", tone: "idle" },
    starting: { label: "Running", tone: "running" },
    running: { label: "Running", tone: "running" },
    waiting_approval: { label: "Pending", tone: "pending" },
    completed: { label: "Completed", tone: "completed" },
    failed: { label: "Error", tone: "error" },
    conflicted: { label: "Blocked", tone: "blocked" },
    disconnected: { label: "Warning", tone: "warning" }
  })[status] as { label: string; tone: StatusChipTone };

const credentialStatusChip = (status: CredentialEntryMetadata["status"]): { label: string; tone: StatusChipTone } =>
  ({
    active: { label: "Success", tone: "success" },
    needs_attention: { label: "Warning", tone: "warning" },
    disabled: { label: "Idle", tone: "idle" }
  })[status] as { label: string; tone: StatusChipTone };

const validationStatusChip = (status: ValidationStatus): { label: string; tone: StatusChipTone } =>
  ({
    exact: { label: "Success", tone: "success" },
    stale: { label: "Warning", tone: "warning" },
    incompatible: { label: "Error", tone: "error" },
    unvalidated: { label: "Pending", tone: "pending" }
  })[status] as { label: string; tone: StatusChipTone };

const repositoryScanStatusChip = (status?: RepositoryScanStatus["status"]): { label: string; tone: StatusChipTone } => {
  if (status === "not_scanned") {
    return { label: "Not scanned", tone: "pending" };
  }
  if (status === "indexed") {
    return { label: "Indexed", tone: "success" };
  }
  if (status === "scanning") {
    return { label: "Scanning", tone: "running" };
  }
  if (status === "truncated") {
    return { label: "Truncated", tone: "warning" };
  }
  if (status === "partially_indexed") {
    return { label: "Partially indexed", tone: "warning" };
  }
  if (status === "failed") {
    return { label: "Failed", tone: "error" };
  }
  return { label: "Unknown", tone: "pending" };
};

const codexReadinessStatusChip = (status: WorkbenchState["codexReadiness"]["status"]): { label: string; tone: StatusChipTone } => {
  if (status === "ready") {
    return { label: "Ready", tone: "success" };
  }
  if (status === "outdated") {
    return { label: "Update available", tone: "warning" };
  }
  if (status === "checking") {
    return { label: "Checking", tone: "running" };
  }
  if (status === "skipped") {
    return { label: "Skipped", tone: "idle" };
  }
  return { label: "Unavailable", tone: "error" };
};

const buildLogEvents = ({
  activity,
  commands,
  agents,
  approvals
}: {
  activity: WorkflowActivityEvent[];
  commands: ProjectCommandLogEntry[];
  agents: AgentState[];
  approvals: ApprovalRequestRecord[];
}): LogEventView[] => {
  const activityEvents: LogEventView[] = activity.map((event) => {
    const status = runtimeStatusChip(event.status);
    const warning = textLooksWarning(`${event.title} ${event.detail ?? ""}`);
    const kind: LogEventKind = event.source === "approval" ? "approval" : event.source === "agent" ? "agent" : "workflow";
    return {
      id: `workflow:${event.id}`,
      timestamp: event.timestamp,
      kind,
      typeLabel: workflowActivitySourceLabel(event.source),
      title: redactSensitiveText(event.title),
      summary: summarizeSafeText(event.detail ?? event.title, event.title, 150),
      detail: event.detail ? redactSensitiveText(event.detail) : undefined,
      actor: event.agentCategory ? agentCategoryLabel(event.agentCategory) : undefined,
      statusLabel: warning && status.tone !== "error" ? "Warning" : status.label,
      statusTone: warning && status.tone !== "error" ? "warning" : status.tone
    };
  });

  const commandEvents: LogEventView[] = commands.map((command) => {
    const status = commandStatusChip(command);
    const safeCommand = redactSensitiveText(command.command);
    return {
      id: `command:${command.id}`,
      timestamp: command.completedAt ?? command.startedAt,
      kind: "command",
      typeLabel: "Command",
      title: command.agentName,
      summary: summarizeSafeText(safeCommand, "Command recorded.", 150),
      detail: safeCommand,
      actor: agentCategoryLabel(command.agentCategory),
      statusLabel: status.label,
      statusTone: status.tone
    };
  });

  const runtimeEvents: LogEventView[] = agents.flatMap((agent) =>
    agent.events
      .filter((event) => event.type !== "command")
      .map((event) => {
        const status = runtimeStatusChip(event.status);
        const warning = textLooksWarning(`${event.title} ${event.detail ?? ""}`);
        const kind: LogEventKind = event.type === "approval" ? "approval" : "agent";
        return {
          id: `agent:${agent.id}:${event.id}`,
          timestamp: event.timestamp,
          kind,
          typeLabel: event.type === "message" ? "Agent message" : event.type.replace("-", " "),
          title: redactSensitiveText(event.title),
          summary: summarizeSafeText(event.detail ?? event.title, event.title, 150),
          detail: event.detail ? redactSensitiveText(event.detail) : undefined,
          actor: agent.name,
          statusLabel: warning && status.tone !== "error" ? "Warning" : status.label,
          statusTone: warning && status.tone !== "error" ? "warning" : status.tone
        };
      })
  );

  const approvalEvents: LogEventView[] = approvals.map((approval) => ({
    id: `approval:${approval.agentId}:${approval.id}`,
    timestamp: approval.createdAt,
    kind: "approval",
    typeLabel: "Approval",
    title: redactSensitiveText(approval.summary),
    summary: summarizeSafeText(approval.reason ?? approval.command, "Approval required before work can continue.", 150),
    detail: redactSensitiveText(approval.reason ?? approval.command ?? "Approval required before work can continue."),
    statusLabel: "Pending",
    statusTone: "pending"
  }));

  const byId = new Map<string, LogEventView>();
  for (const event of [...approvalEvents, ...activityEvents, ...commandEvents, ...runtimeEvents]) {
    byId.set(event.id, event);
  }

  return [...byId.values()].sort((left, right) => toTime(right.timestamp) - toTime(left.timestamp));
};

const logEventMatchesFilter = (event: LogEventView, filter: LogFilterId): boolean => {
  if (filter === "all") {
    return true;
  }
  if (filter === "errors") {
    return event.statusTone === "error";
  }
  if (filter === "warnings") {
    return event.statusTone === "warning";
  }
  if (filter === "commands") {
    return event.kind === "command";
  }
  if (filter === "approvals") {
    return event.kind === "approval";
  }
  return event.kind === filter;
};

const logTextMatchesSearch = (event: LogEventView, search: string): boolean => {
  const needle = search.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return [event.typeLabel, event.title, event.summary, event.detail, event.actor]
    .filter(Boolean)
    .some((value) => value!.toLowerCase().includes(needle));
};

const CopyButton = ({ value, label = "Copy" }: { value: string; label?: string }) => {
  const [copied, setCopied] = useState(false);

  const copyValue = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button className="secondary-button secondary-button--compact" type="button" onClick={() => void copyValue()}>
      {copied ? "Copied" : label}
    </button>
  );
};

const LongTextDisclosure = ({
  title = "View details",
  value,
  code = false
}: {
  title?: string;
  value?: string;
  code?: boolean;
}) => {
  const safeValue = redactSensitiveText(value);
  if (!safeValue) {
    return null;
  }

  const isLong = safeValue.split(/\r?\n/).length > 6 || safeValue.length > 520;
  if (!isLong) {
    return code ? <pre className="long-text-block">{safeValue}</pre> : <p className="long-text-inline">{safeValue}</p>;
  }

  return (
    <details className="long-text-disclosure">
      <summary>{title}</summary>
      <pre className="long-text-block">{safeValue}</pre>
    </details>
  );
};

const CompactEmptyState = ({ children }: { children: ReactNode }) => (
  <div className="compact-empty-state">{children}</div>
);

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
  onSelect,
  onOpenOutput
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
  onOpenOutput?: (agent: AgentState) => void;
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
        <AgentCard
          key={agent.id}
          agent={agent}
          workflow={workflow}
          selected={selectedAgentId === agent.id}
          onSelect={onSelect}
          onOpenOutput={onOpenOutput}
        />
      )) : (
        <div className="empty-copy">{emptyCopy}</div>
      )}
    </div>
  </section>
);

const OverviewMetricCard = ({
  label,
  value,
  detail,
  tone
}: {
  label: string;
  value: string | number;
  detail: string;
  tone?: "good" | "warning" | "danger";
}) => (
  <article className={`overview-metric-card ${tone ? `overview-metric-card--${tone}` : ""}`}>
    <span>{label}</span>
    <strong>{value}</strong>
    <p>{detail}</p>
  </article>
);

const OverviewAttentionSummary = ({
  items,
  onOpenWorkflow,
  onOpenLogs,
  onOpenCredentials
}: {
  items: WorkflowAttentionItem[];
  onOpenWorkflow: () => void;
  onOpenLogs: () => void;
  onOpenCredentials: () => void;
}) => {
  const visibleItems = items.slice(0, 5);
  const hiddenCount = Math.max(0, items.length - visibleItems.length);

  return (
    <article className={`overview-attention-card ${items.length === 0 ? "overview-attention-card--empty" : ""}`}>
      <SectionTitle
        eyebrow="Attention"
        title="What needs attention"
        meta={<span className={`badge ${items.some((item) => item.tone === "danger") ? "badge-incompatible" : "badge-exact"}`}>{items.length}</span>}
      />
      {items.length === 0 ? (
        <p className="overview-attention-card__empty">No urgent attention needed.</p>
      ) : (
        <div className="overview-attention-list">
          {visibleItems.map((item) => {
            const action = item.target === "credentials"
              ? { label: "Credentials", onClick: onOpenCredentials }
              : item.kind === "approval"
                ? { label: "Logs", onClick: onOpenLogs }
                : { label: "Workflow", onClick: onOpenWorkflow };
            return (
              <div key={item.id} className={`overview-attention-item overview-attention-item--${item.tone}`}>
                <div>
                  <div className="candidate-card__title-row">
                    <strong>{item.title}</strong>
                    <span className="badge">{workflowAttentionKindLabel(item.kind)}</span>
                  </div>
                  <p>{item.detail}</p>
                </div>
                <button className="secondary-button" type="button" onClick={action.onClick}>{action.label}</button>
              </div>
            );
          })}
          {hiddenCount > 0 ? <p className="agent-card__subtle">{hiddenCount} more item{hiddenCount === 1 ? "" : "s"} in Workflow.</p> : null}
        </div>
      )}
    </article>
  );
};

const OverviewActivitySnapshot = ({ events }: { events: WorkflowActivityEvent[] }) => (
  <article className="overview-activity-card">
    <SectionTitle eyebrow="Recent" title="Recent activity" meta={<span className="badge">{events.length}</span>} />
    {events.length ? (
      <div className="overview-activity-list">
        {events.slice(0, 6).map((event) => (
          <div key={event.id} className="overview-activity-row">
            <span>{formatClockTime(event.timestamp)}</span>
            <strong>{workflowActivitySourceLabel(event.source)}</strong>
            <p>{event.title}{event.detail ? ` - ${summarizeText(event.detail, "", 105)}` : ""}</p>
            <span className={`badge workflow-transcript__badge workflow-transcript__badge--${event.status}`}>{workflowEventStatusLabel(event.status)}</span>
          </div>
        ))}
      </div>
    ) : (
      <p className="overview-attention-card__empty">Workflow activity will appear once work starts.</p>
    )}
  </article>
);

const QuickNavigationCard = ({
  title,
  detail,
  meta,
  onClick
}: {
  title: string;
  detail: string;
  meta?: string;
  onClick: () => void;
}) => (
  <button className="quick-nav-card" type="button" onClick={onClick}>
    <div>
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
    {meta ? <span className="badge">{meta}</span> : null}
  </button>
);

const RunRow = ({
  agent,
  workflow,
  selected,
  onSelect
}: {
  agent: AgentState;
  workflow?: ProjectWorkflowState;
  selected: boolean;
  onSelect: (agentId: string) => void;
}) => {
  const pendingApprovalCount = agent.approvals.filter((approval) => approval.status === "pending").length;
  const status = agentLifecycleStatusChip(agent.status);

  return (
    <button className={`run-row ${selected ? "run-row--selected" : ""}`} type="button" onClick={() => onSelect(agent.id)}>
      <div className="run-row__main">
        <div className="candidate-card__title-row">
          <strong>{agent.name}</strong>
          <StatusChip label={status.label} tone={status.tone} />
        </div>
        <p>{runResultSummary(agent, workflow)}</p>
      </div>
      <div className="run-row__meta">
        <span>{runStageName(agent)}</span>
        <span>{formatDateTime(agentRunTimestamp(agent))}</span>
        <span>{agent.changedFiles.length} files</span>
        <span>{pendingApprovalCount} approvals</span>
        <span>{runModelSummary(agent)}</span>
      </div>
    </button>
  );
};

const RunDetailField = ({
  label,
  value
}: {
  label: string;
  value: string | number;
}) => (
  <div>
    <span>{label}</span>
    <strong>{value}</strong>
  </div>
);

const RunDetailDisclosure = ({
  title,
  count,
  renderBody
}: {
  title: string;
  count?: string | number;
  renderBody: () => ReactNode;
}) => {
  const [open, setOpen] = useState(false);

  return (
    <details className="run-detail-disclosure" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span>{title}</span>
        {count !== undefined ? <span className="badge">{count}</span> : null}
      </summary>
      {open ? <div className="run-detail-disclosure__body">{renderBody()}</div> : null}
    </details>
  );
};

const RunDetailPanel = ({
  agent,
  workflow,
  onOpenWorkflow,
  onOpenLogs,
  onOpenOutput
}: {
  agent?: AgentState;
  workflow?: ProjectWorkflowState;
  onOpenWorkflow: () => void;
  onOpenLogs: () => void;
  onOpenOutput: (agent: AgentState) => void;
}) => {
  if (!agent) {
    return (
      <article className="runs-detail-card">
        <SectionTitle eyebrow="Selected run" title="Run details" />
        <p className="overview-attention-card__empty">No runs yet. Start from Workflow or run a recommendation.</p>
      </article>
    );
  }

  const evidence = runEvidenceItems(agent, workflow);
  const risks = runRiskItems(agent);
  const recentEvents = sortEventsByAge(agent.events).slice(0, 8);
  const pendingApprovalsForAgent = agent.approvals.filter((approval) => approval.status === "pending");
  const visibleApprovals = agent.approvals.slice(0, 12);
  const visibleCommands = agent.commandLog.slice(0, 12);
  const visibleChangedFiles = agent.changedFiles.slice(0, 48);
  const rawEvents = agent.events.filter((event) => event.raw !== undefined).slice(0, 8);
  const status = agentLifecycleStatusChip(agent.status);

  return (
    <article className="runs-detail-card">
      <div className="runs-detail-card__header">
        <div>
          <div className="eyebrow">Selected run</div>
          <h3>{agent.name}</h3>
          <p>{runResultSummary(agent, workflow)}</p>
        </div>
        <div className="runs-detail-card__header-actions">
          <StatusChip label={status.label} tone={status.tone} />
          <button className="primary-button" type="button" onClick={() => onOpenOutput(agent)}>View full output</button>
          <button className="secondary-button" type="button" onClick={onOpenWorkflow}>Open Workflow</button>
          <button className="secondary-button" type="button" onClick={onOpenLogs}>Open History</button>
        </div>
      </div>

      <div className="runs-detail-grid">
        <RunDetailField label="Agent" value={agent.name} />
        <RunDetailField label="Stage" value={runStageName(agent)} />
        <RunDetailField label="Timestamp" value={formatDateTime(agentRunTimestamp(agent))} />
        <RunDetailField label="Model/reasoning" value={runModelSummary(agent)} />
        <RunDetailField label="Decision/result" value={runResultSummary(agent, workflow)} />
        <RunDetailField label="Next action" value={runNextAction(agent)} />
        <RunDetailField label="Changed files" value={agent.changedFiles.length} />
        <RunDetailField label="Tests/checks" value={runChecksSummary(agent)} />
        <RunDetailField label="Approvals" value={runApprovalSummary(agent)} />
        <RunDetailField label="Risks/blockers" value={risks.length ? `${risks.length} noted` : "None noted"} />
      </div>

      {agent.recommendationReport?.nextSteps.length ? (
        <section className="runs-detail-section">
          <SectionTitle eyebrow="Recommendations" title="Key recommendations" meta={<span className="badge">{agent.recommendationReport.nextSteps.length}</span>} />
          <div className="run-evidence-grid">
            {agent.recommendationReport.nextSteps.slice(0, 4).map((step) => (
              <article key={`${agent.id}:recommendation:${step.rank}`} className="run-evidence-card">
                <div className="candidate-card__title-row">
                  <strong>{step.title}</strong>
                  <span className="badge">{step.priority}</span>
                </div>
                <p>{summarizeText(step.summary, "No summary captured.", 170)}</p>
                <span>{step.relatedPaths.slice(0, 3).join(", ") || "No files listed"}</span>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <section className="runs-detail-section">
        <SectionTitle eyebrow="Evidence" title="Evidence and affected areas" meta={<span className="badge">{evidence.length}</span>} />
        {evidence.length ? (
          <div className="run-evidence-list">
            {evidence.slice(0, 10).map((item) => (
              <div key={item.id} className={`run-evidence-row ${item.tone ? `run-evidence-row--${item.tone}` : ""}`}>
                <div>
                  <strong>{item.title}</strong>
                  <p>{item.detail}</p>
                </div>
                {item.meta ? <span>{item.meta}</span> : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="overview-attention-card__empty">No structured evidence has been captured for this run yet.</p>
        )}
      </section>

      <section className="runs-detail-section">
        <SectionTitle eyebrow="Risks" title="Risks and blockers" meta={<span className={`badge ${risks.length ? "badge-incompatible" : "badge-exact"}`}>{risks.length}</span>} />
        {risks.length ? (
          <ul className="workflow-compact-list">
            {risks.slice(0, 8).map((risk) => <li key={risk}>{risk}</li>)}
          </ul>
        ) : (
          <p className="overview-attention-card__empty">No blockers or risks were captured in the run summary.</p>
        )}
      </section>

      <div className="run-detail-raw">
        <RunDetailDisclosure
          title="Full explanation"
          renderBody={() => <p>{redactSensitiveText(agentDetailedExplanation(agent, workflow))}</p>}
        />
        <RunDetailDisclosure
          title="Objective"
          renderBody={() => <p>{redactSensitiveText(agent.taskPrompt)}</p>}
        />
        {agent.lastMessageSnippet ? (
          <RunDetailDisclosure
            title="Latest output"
            renderBody={() => <p>{redactSensitiveText(agent.lastMessageSnippet)}</p>}
          />
        ) : null}
        <RunDetailDisclosure
          title="Changed files"
          count={agent.changedFiles.length}
          renderBody={() => agent.changedFiles.length ? (
            <div className="tag-row">
              {visibleChangedFiles.map((file) => <span key={file} className="tag">{file}</span>)}
              {agent.changedFiles.length > visibleChangedFiles.length ? <span className="tag">+{agent.changedFiles.length - visibleChangedFiles.length} more</span> : null}
            </div>
          ) : <p>No changed files were recorded for this run.</p>}
        />
        <RunDetailDisclosure
          title="Approvals"
          count={agent.approvals.length}
          renderBody={() => (
            <>
              {visibleApprovals.length ? visibleApprovals.map((approval) => (
                <div key={approval.id} className="run-raw-row">
                  <strong>{redactSensitiveText(approval.summary)}</strong>
                  <span>{approval.status} · {approval.kind} · {formatDateTime(approval.createdAt)}</span>
                  <p>{redactSensitiveText(approval.reason ?? approval.command ?? "Approval request recorded.")}</p>
                </div>
              )) : <p>No approvals were recorded for this run.</p>}
              {agent.approvals.length > visibleApprovals.length ? <p className="agent-card__subtle">Showing the latest {visibleApprovals.length} approvals. Open Logs for older entries.</p> : null}
              {pendingApprovalsForAgent.length ? <p className="agent-card__subtle">{pendingApprovalsForAgent.length} approval{pendingApprovalsForAgent.length === 1 ? "" : "s"} still pending.</p> : null}
            </>
          )}
        />
        <RunDetailDisclosure
          title="Commands"
          count={agent.commandLog.length}
          renderBody={() => (
            <>
              {visibleCommands.length ? visibleCommands.map((command) => (
                <div key={`${command.itemId ?? command.startedAt}:${command.command}`} className="run-raw-row">
                  <strong>{redactSensitiveText(command.command)}</strong>
                  <span>{command.status} · {command.cwd ?? "No cwd"} · {formatDateTime(command.startedAt)}</span>
                  {command.output ? <pre>{renderOutputPreview(command.output)}</pre> : <p>No command output included in this preview.</p>}
                </div>
              )) : <p>No commands were recorded for this run.</p>}
              {agent.commandLog.length > visibleCommands.length ? <p className="agent-card__subtle">Showing the latest {visibleCommands.length} command snippets. Open Logs for older entries.</p> : null}
            </>
          )}
        />
        <RunDetailDisclosure
          title="Logs and events"
          count={recentEvents.length}
          renderBody={() => recentEvents.length ? recentEvents.map((event) => (
            <div key={event.id} className="run-raw-row">
              <strong>{redactSensitiveText(event.title)}</strong>
              <span>{workflowEventStatusLabel(event.status)} · {event.type} · {formatDateTime(event.timestamp)}</span>
              {event.detail ? <p>{redactSensitiveText(event.detail)}</p> : null}
            </div>
          )) : <p>No events were recorded for this run.</p>}
        />
        <RunDetailDisclosure
          title="Raw output / JSON"
          count={rawEvents.length}
          renderBody={() => rawEvents.length ? rawEvents.map((event) => (
            <div key={`raw:${event.id}`} className="run-raw-row">
              <strong>{redactSensitiveText(event.title)}</strong>
              <pre>{stringifyRawValue(event.raw)}</pre>
            </div>
          )) : <p>No raw event JSON is available for this run.</p>}
        />
      </div>
    </article>
  );
};

const RunsReviewPage = ({
  agents,
  totalAgents,
  workflowPage,
  manualPage,
  workflowPageIndex,
  manualPageIndex,
  workflow,
  selectedAgent,
  loading,
  manualAgentPrompt,
  manualAgentModel,
  manualAgentReasoningMode,
  manualAgentReasoningEffort,
  availableModels,
  modelOptionsByName,
  manualPendingApprovalCount,
  agentActionsBlocked = false,
  onSelectAgent,
  onWorkflowPageChange,
  onManualPageChange,
  onOpenWorkflow,
  onOpenLogs,
  onOpenOutput,
  onManualPromptChange,
  onManualModelChange,
  onManualReasoningModeChange,
  onManualReasoningEffortChange,
  onCreateManualAgent
}: {
  agents: AgentState[];
  totalAgents: number;
  workflowPage: AgentPageView;
  manualPage: AgentPageView;
  workflowPageIndex: number;
  manualPageIndex: number;
  workflow?: ProjectWorkflowState;
  selectedAgent?: AgentState;
  loading: boolean;
  manualAgentPrompt: string;
  manualAgentModel: string;
  manualAgentReasoningMode: AgentReasoningMode;
  manualAgentReasoningEffort: InterfaceReasoningEffort;
  availableModels: DiscoveredModel[];
  modelOptionsByName: Map<string, DiscoveredModel>;
  manualPendingApprovalCount: number;
  agentActionsBlocked?: boolean;
  onSelectAgent: (agentId: string) => void;
  onWorkflowPageChange: (pageIndex: number) => void;
  onManualPageChange: (pageIndex: number) => void;
  onOpenWorkflow: () => void;
  onOpenLogs: () => void;
  onOpenOutput: (agent: AgentState) => void;
  onManualPromptChange: (value: string) => void;
  onManualModelChange: (value: string) => void;
  onManualReasoningModeChange: (value: AgentReasoningMode) => void;
  onManualReasoningEffortChange: (value: InterfaceReasoningEffort) => void;
  onCreateManualAgent: () => void;
}) => {
  const [filter, setFilter] = useState<RunFilterId>("all");
  const [search, setSearch] = useState("");
  const latestRun = agents[0];
  const selectedRun = selectedAgent ?? latestRun;
  const filteredRuns = useMemo(
    () => agents.filter((agent) => runFilterMatches(agent, filter) && runMatchesSearch(agent, search, workflow)),
    [agents, filter, search, workflow]
  );
  const completedCount = agents.filter((agent) => agent.status === "completed").length;
  const blockedCount = agents.filter((agent) => runFilterMatches(agent, "errors")).length;

  return (
    <section className="runs-page">
      <header className="runs-page-header">
        <div>
          <div className="eyebrow">Run history</div>
          <h2>Runs</h2>
          <p>Review agent runs from structured summaries first. Full prompts, logs, commands, and raw event data stay collapsed below each selected run.</p>
        </div>
        <div className="runs-page-header__stats">
          <RunDetailField label="Total runs" value={totalAgents} />
          <RunDetailField label="Most recent" value={latestRun ? latestRun.status : "None"} />
          <RunDetailField label="Selected" value={selectedRun ? selectedRun.name : "No run"} />
          <RunDetailField label="Loaded completed" value={completedCount} />
          <RunDetailField label="Loaded blocked" value={blockedCount} />
        </div>
      </header>

      <div className="runs-toolbar">
        <div className="runs-filter-tabs" role="tablist" aria-label="Run filters">
          {RUN_FILTERS.map((option) => (
            <button
              key={option.id}
              className={filter === option.id ? "runs-filter-tab runs-filter-tab--active" : "runs-filter-tab"}
              type="button"
              onClick={() => setFilter(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <input
          className="input runs-search"
          placeholder="Search runs, files, output summaries"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      <article className="runs-list-card">
        <div className="candidate-card__title-row">
          <strong>{loading ? "Loading runs" : `${filteredRuns.length} loaded run${filteredRuns.length === 1 ? "" : "s"}`}</strong>
          <span className="badge">{filter === "all" ? "All stages" : RUN_FILTERS.find((option) => option.id === filter)?.label}</span>
        </div>
        <div className="runs-pager-grid">
          <FeedPager
            label="Workflow runs"
            pageIndex={workflowPageIndex}
            pageSize={AGENT_HISTORY_PAGE_SIZE}
            total={workflowPage.total}
            visibleCount={workflowPage.agents.length}
            onPageChange={onWorkflowPageChange}
          />
          <FeedPager
            label="Manual runs"
            pageIndex={manualPageIndex}
            pageSize={AGENT_HISTORY_PAGE_SIZE}
            total={manualPage.total}
            visibleCount={manualPage.agents.length}
            onPageChange={onManualPageChange}
          />
        </div>
        <div className="runs-list">
          {filteredRuns.length ? filteredRuns.map((agent) => (
            <RunRow
              key={agent.id}
              agent={agent}
              workflow={workflow}
              selected={selectedRun?.id === agent.id}
              onSelect={onSelectAgent}
            />
          )) : (
            <p className="overview-attention-card__empty">
              {agents.length ? "No runs match the current filter or search." : "No runs yet. Start from Workflow or run a recommendation."}
            </p>
          )}
        </div>
      </article>

      <RunDetailPanel agent={selectedRun} workflow={workflow} onOpenWorkflow={onOpenWorkflow} onOpenLogs={onOpenLogs} onOpenOutput={onOpenOutput} />

      <details className="runs-manual-panel">
        <summary>
          <span>Manual / independent run</span>
          <span className="badge">{manualPendingApprovalCount} approvals pending</span>
        </summary>
        <div className="agent-form card-surface">
          <textarea
            className="textarea"
            placeholder="Ask a question about the repo or describe a change outside the workflow cycle."
            value={manualAgentPrompt}
            onChange={(event) => onManualPromptChange(event.target.value)}
          />
          <select className="input" value={manualAgentModel} onChange={(event) => onManualModelChange(event.target.value)} disabled={agentActionsBlocked}>
            {availableModels.map((model) => <option key={model.id} value={model.model}>{model.displayName} ({model.model})</option>)}
          </select>
          <AgentReasoningPicker
            category="manual"
            model={modelOptionsByName.get(manualAgentModel)}
            taskPrompt={manualAgentPrompt}
            mode={manualAgentReasoningMode}
            effort={manualAgentReasoningEffort}
            onModeChange={onManualReasoningModeChange}
            onEffortChange={onManualReasoningEffortChange}
          />
          <div className="actions-row">
            <button className="primary-button" disabled={agentActionsBlocked || !manualAgentPrompt.trim() || !manualAgentModel} onClick={onCreateManualAgent}>
              Run manual agent
            </button>
            <span className="agent-card__subtle">Manual runs stay outside the workflow cycle.</span>
          </div>
        </div>
      </details>
    </section>
  );
};

const cycleStatusLabel = (status: WorkflowCycleSummaryView["status"]): string =>
  status === "blocked_human"
    ? "Needs attention"
    : status === "repair_loop"
      ? "Repairing"
      : status.replace(/_/g, " ");

const formatDurationMs = (durationMs?: number): string =>
  durationMs === undefined
    ? "Not recorded"
    : durationMs < 60_000
      ? `${Math.round(durationMs / 1000)}s`
      : durationMs < 3_600_000
        ? `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1000)}s`
        : `${Math.floor(durationMs / 3_600_000)}h ${Math.round((durationMs % 3_600_000) / 60_000)}m`;

const HistoryMiniList = ({
  label,
  items,
  empty = "None recorded",
  limit = 6
}: {
  label: string;
  items: string[];
  empty?: string;
  limit?: number;
}) => {
  const visibleItems = items.slice(0, limit);
  const hiddenCount = Math.max(0, items.length - visibleItems.length);
  return (
    <section className="history-mini-list">
      <span>{label}</span>
      {visibleItems.length ? (
        <div className="tag-row">
          {visibleItems.map((item, index) => <span key={`${label}:${index}:${item}`} className="tag">{redactSensitiveText(item)}</span>)}
          {hiddenCount ? <span className="tag">+{hiddenCount} more</span> : null}
        </div>
      ) : (
        <p>{empty}</p>
      )}
    </section>
  );
};

const HistoryNarrativeField = ({
  label,
  value,
  empty = "Not recorded"
}: {
  label: string;
  value?: string;
  empty?: string;
}) => (
  <div className="history-narrative-field">
    <span>{label}</span>
    <p>{redactSensitiveText(value) || empty}</p>
  </div>
);

const historyCycleCompletedTask = (cycle: WorkflowCycleSummaryView, detail?: WorkflowCycleDetail): string | undefined =>
  detail?.retrospectiveRecord?.triedToDo ?? cycle.selectedTask;

const historyValidationStatus = (cycle: WorkflowCycleSummaryView): { label: string; tone: StatusChipTone; detail: string } => {
  const ledger = cycle.validationLedger;
  if (!ledger) {
    const hasCommandEvidence = cycle.commandsRun.length > 0 || cycle.errorSummaries.length > 0;
    return {
      label: hasCommandEvidence ? "No final ledger" : "Not run",
      tone: hasCommandEvidence ? "warning" : "pending",
      detail: cycle.validationOutcome ?? (hasCommandEvidence ? "Commands were recorded, but no final validation ledger is attached." : "Validation has not run for this cycle.")
    };
  }
  if (ledger.finalValidationStatus === "passed" && ledger.unresolvedValidationFailures.length === 0) {
    return { label: "Final passed", tone: "success", detail: ledger.summaryForHumans };
  }
  if (ledger.finalValidationStatus === "failed") {
    return { label: "Final failed", tone: "error", detail: ledger.summaryForHumans };
  }
  if (ledger.finalValidationStatus === "partial") {
    return { label: "Final partial", tone: "warning", detail: ledger.summaryForHumans };
  }
  return { label: ledger.finalValidationStatus.replace(/_/g, " "), tone: "warning", detail: ledger.summaryForHumans };
};

const historyMergeOutcome = (cycle: WorkflowCycleSummaryView): string => {
  if (cycle.status === "merged") {
    return "Merge completed.";
  }
  if (cycle.validationLedger?.mergeAllowed) {
    return "Merge allowed by final validation ledger.";
  }
  const blocked = [
    ...(cycle.validationLedger?.mergeBlockedReasons ?? []),
    ...(cycle.repoHygieneReport?.mergeBlockingFindings ?? [])
  ];
  if (blocked.length) {
    return `Merge blocked: ${blocked.slice(0, 3).join("; ")}`;
  }
  return "Merge outcome not recorded.";
};

const historyRepeatMessage = (cycle: WorkflowCycleSummaryView): string | undefined => {
  if (!cycle.selectedTask || !cycle.nextStepRecommendation) {
    return undefined;
  }
  const selected = cycle.selectedTask.toLowerCase().replace(/^satisfy work package:\s*/i, "").trim();
  const next = cycle.nextStepRecommendation.toLowerCase().replace(/^satisfy work package:\s*/i, "").trim();
  if (!selected || !next.includes(selected.slice(0, Math.min(40, selected.length)))) {
    return undefined;
  }
  const unknown = cycle.validationLedger?.finalValidationStatus !== "passed" || /unknown|no delta|not consumed|did not reconcile/i.test([
    cycle.validationOutcome,
    cycle.retrospective,
    cycle.checklistChanges.join(" ")
  ].filter(Boolean).join(" "));
  return unknown
    ? "Next recommendation repeats this package because checklist or validation evidence is still unresolved."
    : "Next recommendation repeats this package even though evidence changed; review whether reconciliation consumed the evidence.";
};

const HistoryValidationLedgerDetail = ({ cycle }: { cycle: WorkflowCycleSummaryView }) => {
  const ledger = cycle.validationLedger;
  if (!ledger) {
    return (
      <div className="history-narrative-field">
        <span>Validation ledger</span>
        <p>{historyValidationStatus(cycle).detail}</p>
      </div>
    );
  }
  return (
    <div className="history-narrative-field">
      <span>Validation ledger</span>
      <p>{ledger.summaryForHumans}</p>
      <div className="operator-command-list">
        {ledger.commandResults.slice(0, 10).map((result) => (
          <OperatorCommandDisclosure key={result.commandId} command={result.command} result={result} label={result.phase} />
        ))}
      </div>
      <OperatorMiniList label="Repaired failures" items={ledger.repairedFailures} empty="No repaired validation failures recorded." />
      <OperatorMiniList label="Unresolved failures" items={ledger.unresolvedValidationFailures} empty="No unresolved validation failures recorded." tone={ledger.unresolvedValidationFailures.length ? "danger" : undefined} />
    </div>
  );
};

const HistoryHygieneDetail = ({ cycle }: { cycle: WorkflowCycleSummaryView }) => {
  const suspiciousFiles = uniqueSortedStrings([
    ...cycle.filesChanged.filter((file) => suspiciousPathReason(file)),
    ...(cycle.repoHygieneReport?.forbiddenFiles ?? []).filter((file) => suspiciousPathReason(file))
  ]);
  return (
    <div className="history-narrative-field">
      <span>Merge and hygiene</span>
      <p>{historyMergeOutcome(cycle)}</p>
      <p>{cycle.repoHygieneReport?.summaryForHumans ?? "No repository hygiene report was attached to this cycle."}</p>
      <OperatorMiniList
        label="Suspicious/blocked paths"
        items={suspiciousFiles.map((file) => `${file} - ${suspiciousPathReason(file) ?? "Blocked by hygiene scan"}`)}
        empty="No suspicious changed paths recorded."
        tone={suspiciousFiles.length ? "danger" : undefined}
      />
      <OperatorMiniList label="Cleaned generated artifacts" items={cycle.repoHygieneReport?.cleanedFiles ?? []} empty="No generated artifacts were cleaned." />
    </div>
  );
};

const HistoryAgentCard = ({
  agent,
  onOpenOutput,
  onOpenTranscript
}: {
  agent: AgentHistorySummary;
  onOpenOutput: (agent: AgentHistorySummary) => void;
  onOpenTranscript: (agent: AgentHistorySummary) => void;
}) => {
  const status = agentLifecycleStatusChip(agent.status);
  return (
    <article className="history-agent-card">
      <div className="history-agent-card__header">
        <div>
          <div className="candidate-card__title-row">
            <strong>{agent.name}</strong>
            <StatusChip label={status.label} tone={status.tone} />
          </div>
          <p>{redactSensitiveText(agent.preview)}</p>
        </div>
        <div className="history-agent-card__actions">
          <button className="primary-button" type="button" onClick={() => onOpenOutput(agent)}>
            View full output
          </button>
          <button className="secondary-button" type="button" onClick={() => onOpenTranscript(agent)}>
            Open transcript
          </button>
        </div>
      </div>
      <div className="history-agent-card__grid">
        <RunDetailField label="Category" value={agentCategoryLabel(agent.category)} />
        <RunDetailField label="Model" value={agent.model} />
        <RunDetailField label="Reasoning" value={agent.reasoningEffort ? reasoningEffortLabel(agent.reasoningEffort) : "Default"} />
        <RunDetailField label="Current/final phase" value={agent.currentPhase ?? agent.currentSubtask ?? agent.status.replace(/_/g, " ")} />
        <RunDetailField label="Started" value={formatDateTime(agent.startedAt)} />
        <RunDetailField label="Ended" value={formatDateTime(agent.completedAt)} />
        <RunDetailField label="Files changed" value={agent.changedFiles.length} />
        <RunDetailField label="Commands run" value={agent.commandCount} />
        <RunDetailField label="Approvals" value={`${agent.pendingApprovalCount} pending / ${agent.approvalCount} total`} />
        <RunDetailField label="Errors" value={agent.errorCount} />
        <RunDetailField label="Token usage" value={agent.tokenUsage ?? "Not recorded"} />
      </div>
      <div className="history-agent-card__sections">
        <HistoryNarrativeField label="Task prompt" value={agent.taskPrompt} />
        <HistoryMiniList label="Files changed" items={agent.changedFiles} empty="No changed files were recorded." limit={12} />
        <HistoryMiniList label="Commands run" items={agent.commands} empty="No commands were recorded." limit={8} />
        <HistoryMiniList label="Approvals requested/granted" items={agent.approvalSummaries} empty="No approvals were requested." limit={6} />
        <HistoryMiniList label="Errors" items={agent.errorSummaries} empty="No errors were recorded." limit={6} />
      </div>
    </article>
  );
};

const AgentOutputViewer = ({
  viewer,
  onClose,
  onQueryChange,
  onWrapChange,
  onViewModeChange,
  onLoadTranscript
}: {
  viewer?: AgentOutputViewerState;
  onClose: () => void;
  onQueryChange: (value: string) => void;
  onWrapChange: (value: boolean) => void;
  onViewModeChange: (value: AgentOutputViewerState["viewMode"]) => void;
  onLoadTranscript: () => void;
}) => {
  const [technicalDetailsOpen, setTechnicalDetailsOpen] = useState(false);
  const [showAllTranscriptEvents, setShowAllTranscriptEvents] = useState(false);

  useEffect(() => {
    setTechnicalDetailsOpen(false);
    setShowAllTranscriptEvents(false);
  }, [viewer?.agentId]);

  const outputText = viewer?.output?.output ?? "";
  const query = viewer?.query.trim().toLowerCase() ?? "";
  const visibleOutput = useMemo(
    () => query
      ? outputText
        .split(/\r?\n/)
        .filter((line) => line.toLowerCase().includes(query))
        .join("\n")
      : outputText,
    [outputText, query]
  );
  const transcriptEntries = useMemo(
    () => {
      const entries = viewer?.transcript?.entries ?? [];
      return query
        ? entries.filter((entry) => [entry.kind, entry.title, entry.text, JSON.stringify(entry.metadata ?? {})]
          .filter((value): value is string => typeof value === "string")
          .some((value) => value.toLowerCase().includes(query)))
        : entries;
    },
    [query, viewer?.transcript?.entries]
  );
  const displayedTranscriptEntries = showAllTranscriptEvents ? transcriptEntries : transcriptEntries.slice(0, 220);
  const rawJson = useMemo(
    () => technicalDetailsOpen && viewer?.transcript ? JSON.stringify(viewer.transcript.entries, null, 2) : "",
    [technicalDetailsOpen, viewer?.transcript]
  );
  const outputClassName = [
    "agent-output-block",
    viewer?.wrap ? "agent-output-block--wrap" : "",
    viewer?.viewMode === "plain" ? "agent-output-block--plain" : ""
  ].filter(Boolean).join(" ");

  if (!viewer) {
    return null;
  }

  return (
    <div className="agent-output-modal" role="dialog" aria-modal="true" aria-label="Agent output">
      <div className="agent-output-panel">
        <header className="agent-output-panel__header">
          <div>
            <div className="eyebrow">Agent output</div>
            <h2>{viewer.agentName}</h2>
            <p>{viewer.output?.fromSidecar ? "Loaded from full transcript storage." : "Loaded from retained run preview data."}</p>
          </div>
          <div className="actions-row">
            <CopyButton value={outputText} label="Copy output" />
            <button className="secondary-button" type="button" disabled={viewer.transcriptLoading || Boolean(viewer.transcript)} onClick={onLoadTranscript}>
              {viewer.transcript ? "Transcript loaded" : viewer.transcriptLoading ? "Loading transcript..." : "Open transcript"}
            </button>
            <button className="secondary-button" type="button" onClick={onClose}>Close</button>
          </div>
        </header>
        <div className="agent-output-toolbar">
          <input
            className="input"
            placeholder="Search within output"
            value={viewer.query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
          <div className="segmented-control" aria-label="Output view">
            <button className={viewer.viewMode === "preformatted" ? "segmented-control__button segmented-control__button--active" : "segmented-control__button"} type="button" onClick={() => onViewModeChange("preformatted")}>
              Preformatted
            </button>
            <button className={viewer.viewMode === "plain" ? "segmented-control__button segmented-control__button--active" : "segmented-control__button"} type="button" onClick={() => onViewModeChange("plain")}>
              Plain text
            </button>
          </div>
          <label className="checkbox-row">
            <input type="checkbox" checked={viewer.wrap} onChange={(event) => onWrapChange(event.target.checked)} />
            <span>Wrap text</span>
          </label>
        </div>
        {viewer.loading ? (
          <LoadingIndicator label="Loading full output" />
        ) : viewer.error ? (
          <div className="notice notice--error">{viewer.error}</div>
        ) : (
          <>
            <pre className={outputClassName}>
              {visibleOutput || "No output text is available for this agent."}
            </pre>
            {viewer.transcriptLoading ? <LoadingIndicator label="Loading full transcript" compact /> : null}
            {viewer.transcript ? (
              <section className="agent-transcript-panel">
                <div className="candidate-card__title-row">
                  <strong>Full transcript</strong>
                  <span className="badge">{transcriptEntries.length} event{transcriptEntries.length === 1 ? "" : "s"}</span>
                </div>
                <div className="agent-transcript-list">
                  {displayedTranscriptEntries.map((entry) => (
                    entry.kind === "raw" ? (
                      <details key={entry.id} className="agent-transcript-row agent-transcript-row--raw">
                        <summary>
                          <span>{formatClockTime(entry.timestamp)}</span>
                          <strong>{entry.title}</strong>
                          <em>Raw event</em>
                        </summary>
                        <pre>{entry.text ?? (entry.raw !== undefined ? JSON.stringify(entry.raw, null, 2) : "No raw payload available.")}</pre>
                      </details>
                    ) : (
                      <article key={entry.id} className="agent-transcript-row">
                        <div className="agent-transcript-row__meta">
                          <span>{formatClockTime(entry.timestamp)}</span>
                          <strong>{entry.kind === "message" ? "Agent output" : entry.kind.replace(/_/g, " ")}</strong>
                        </div>
                        <div>
                          <strong>{entry.title}</strong>
                          {entry.text ? <p>{entry.text}</p> : null}
                        </div>
                      </article>
                    )
                  ))}
                </div>
                {displayedTranscriptEntries.length < transcriptEntries.length ? (
                  <button className="secondary-button" type="button" onClick={() => setShowAllTranscriptEvents(true)}>
                    Show all transcript events
                  </button>
                ) : null}
              </section>
            ) : null}
            <details className="workflow-inline-details" onToggle={(event) => setTechnicalDetailsOpen(event.currentTarget.open)}>
              <summary>Technical details</summary>
              {!viewer.transcript ? (
                <div className="history-technical-placeholder">
                  <p>Raw transport and debug details are loaded only when the transcript is opened.</p>
                  <button className="secondary-button" type="button" disabled={viewer.transcriptLoading} onClick={onLoadTranscript}>
                    {viewer.transcriptLoading ? "Loading transcript..." : "Open transcript"}
                  </button>
                </div>
              ) : (
                <pre className="agent-output-raw">{rawJson || "No transcript JSON is available."}</pre>
              )}
            </details>
          </>
        )}
      </div>
    </div>
  );
};

const HistoryPage = ({
  history,
  onLoadMore,
  onToggleCycle,
  onOpenOutput,
  onOpenTranscript
}: {
  history: HistoryCycleView;
  onLoadMore: () => void;
  onToggleCycle: (cycle: WorkflowCycleSummaryView) => void;
  onOpenOutput: (agent: AgentHistorySummary) => void;
  onOpenTranscript: (agent: AgentHistorySummary) => void;
}) => (
  <section className="history-page">
    <header className="history-page-header">
      <div>
        <div className="eyebrow">What happened</div>
        <h2>History</h2>
        <p>Workflow cycles are summarized first. Expand a cycle to load its agents and open full output only when you need it.</p>
      </div>
      <div className="history-page-header__stats">
        <RunDetailField label="Cycles" value={history.total} />
        <RunDetailField label="Loaded" value={history.cycles.length} />
        <RunDetailField label="Ready fast" value={history.recentPreloaded} />
      </div>
    </header>

    {history.error ? <div className="notice notice--error">{history.error}</div> : null}

    <div className="history-cycle-list">
      {history.cycles.length ? history.cycles.map((cycle) => {
        const expanded = history.expandedCycleIds.includes(cycle.id);
        const agents = history.agentsByCycleId[cycle.id];
        const detail = history.detailsByCycleId[cycle.id];
        const validationStatus = historyValidationStatus(cycle);
        const completedTask = historyCycleCompletedTask(cycle, detail);
        const repeatMessage = historyRepeatMessage(cycle);
        const suspiciousFiles = cycle.filesChanged.filter((file) => suspiciousPathReason(file));
        const statusTone: StatusChipTone = cycle.hasErrors
          ? "error"
          : cycle.status === "completed" || cycle.status === "merged"
            ? "completed"
            : cycle.hasApprovals || cycle.hasUserInputRequests
              ? "pending"
              : "running";
        return (
          <article key={cycle.id} className={`history-cycle-card ${expanded ? "history-cycle-card--expanded" : ""}`}>
            <button className="history-cycle-card__summary" type="button" onClick={() => onToggleCycle(cycle)}>
              <div className="history-cycle-card__main">
                <div className="candidate-card__title-row">
                  <strong>Cycle {cycle.cycleNumber}</strong>
                  <StatusChip label={cycleStatusLabel(cycle.status)} tone={statusTone} />
                  <StatusChip label={validationStatus.label} tone={validationStatus.tone} />
                  {suspiciousFiles.length ? <StatusChip label="Suspicious paths" tone="error" /> : null}
                </div>
                <p>Attempted: {redactSensitiveText(cycle.selectedTask ?? cycle.goalPrompt)}</p>
                <span className="agent-card__subtle">{redactSensitiveText(cycle.summary)}</span>
              </div>
              <div className="history-cycle-card__facts">
                <RunDetailField label="Started" value={formatDateTime(cycle.startedAt)} />
                <RunDetailField label="Ended" value={formatDateTime(cycle.completedAt)} />
                <RunDetailField label="Duration" value={formatDurationMs(cycle.durationMs)} />
                <RunDetailField label="Agents" value={cycle.agentCount} />
                <RunDetailField label="Files" value={cycle.filesChanged.length} />
                <RunDetailField label="Commands/tests" value={cycle.commandsRun.length} />
                <RunDetailField label="Validation" value={validationStatus.label} />
                <RunDetailField label="Merge" value={cycle.validationLedger?.mergeAllowed ? "Allowed" : cycle.status === "merged" ? "Merged" : "Blocked/pending"} />
              </div>
            </button>
            <div className="history-cycle-card__insights">
              <HistoryNarrativeField label="What this cycle attempted" value={cycle.selectedTask ?? cycle.goalPrompt} />
              <HistoryNarrativeField label="What this cycle completed" value={completedTask} empty="Completion summary not retained." />
              <HistoryNarrativeField label="Why it was selected" value={cycle.selectionReason} />
              <HistoryNarrativeField label="Checklist delta" value={cycle.checklistChanges.join("\n") || detail?.retrospectiveRecord?.checklistDelta?.summaryForHumans} empty="No checklist delta recorded." />
              <HistoryNarrativeField label="Final validation status" value={validationStatus.detail} />
              <HistoryNarrativeField label="Merge outcome" value={historyMergeOutcome(cycle)} />
            </div>
            <div className="history-cycle-card__lists">
              <HistoryMiniList label="Models used" items={cycle.modelsUsed} empty="No model was recorded." />
              <HistoryMiniList label="Files changed" items={cycle.filesChanged} empty="No files changed." />
              <HistoryMiniList label="Suspicious paths" items={suspiciousFiles.map((file) => `${file}: ${suspiciousPathReason(file)}`)} empty="No suspicious changed paths." />
              <HistoryMiniList label="Commands run" items={cycle.commandsRun} empty="No commands were recorded." />
              <HistoryMiniList label="Strategy settings used" items={cycle.strategySettingsUsed} empty="No planner strategy snapshot was recorded." />
              <HistoryMiniList label="Checklist/goal items targeted" items={cycle.checklistTargets} empty="No targeted checklist items were recorded." />
              <HistoryMiniList label="Checklist changes" items={cycle.checklistChanges} empty="No checklist changes are attached to this cycle." />
              <HistoryMiniList label="Goal proposals" items={cycle.goalChangeProposals} empty="No goal changes were proposed." />
              <HistoryMiniList label="Errors" items={cycle.errorSummaries} empty="No errors were recorded." />
              <HistoryMiniList label="Approvals" items={cycle.approvalSummaries} empty="No approvals were requested." />
              <HistoryMiniList label="User input requests" items={cycle.userInputRequestSummaries} empty="No user input was requested." />
            </div>
            <div className="history-cycle-card__next">
              <HistoryNarrativeField label="What the planner recommended next" value={cycle.nextStepRecommendation} empty="No next recommendation was retained." />
              {repeatMessage ? <div className="notice notice--compact">{repeatMessage}</div> : null}
            </div>
            {cycle.retrospective ? <HistoryNarrativeField label="Retrospective" value={cycle.retrospective} /> : null}
            {expanded ? (
              <div className="history-cycle-card__details">
                {detail ? (
                  <>
                    <div className="history-cycle-detail-grid">
                      <HistoryNarrativeField label="Cycle started with task" value={detail.retrospectiveRecord?.cycleContract?.selectedTaskTitle ?? detail.selectedTask ?? detail.goalPrompt} />
                      <HistoryNarrativeField label="Cycle contract objective" value={detail.retrospectiveRecord?.cycleContract?.concreteGoalForThisCycle} empty="No cycle contract objective retained." />
                      <HistoryNarrativeField label="Why it was selected" value={detail.plannerDecision?.whySelected ?? detail.selectionReason} />
                      <HistoryNarrativeField label="Planner recommended next" value={detail.nextStepRecommendation} empty="No next recommendation retained." />
                    </div>
                    <div className="history-cycle-detail-grid">
                      <HistoryMiniList label="Accepted decisions" items={detail.decisions.map((decision) => `${decision.kind}: ${decision.title}`)} empty="No accepted decisions were retained." limit={8} />
                      <HistoryMiniList label="Open issues" items={detail.openIssues.map((issue) => `${issue.title}: ${issue.detail}`)} empty="No open issues were attached." limit={8} />
                      <HistoryMiniList label="Recent activity" items={detail.activity.map((event) => `${formatClockTime(event.timestamp)} ${event.title}${event.detail ? `: ${event.detail}` : ""}`)} empty="No detailed activity was retained." limit={10} />
                      <HistoryMiniList label="Score breakdown" items={detail.plannerDecision ? Object.entries(detail.plannerDecision.scoreBreakdown).map(([key, value]) => `${key}: ${value}`) : []} empty="No planner score breakdown retained." limit={10} />
                    </div>
                    <div className="history-cycle-detail-grid">
                      <HistoryValidationLedgerDetail cycle={detail} />
                      <HistoryHygieneDetail cycle={detail} />
                    </div>
                    <OperatorRawDetails title="Raw cycle summary" value={detail} />
                  </>
                ) : null}
                {agents?.loading ? <LoadingIndicator label="Loading cycle agents" compact /> : null}
                {agents?.error ? <div className="notice notice--error">{agents.error}</div> : null}
                {agents?.agents.length ? agents.agents.map((agent) => (
                  <HistoryAgentCard key={agent.id} agent={agent} onOpenOutput={onOpenOutput} onOpenTranscript={onOpenTranscript} />
                )) : !agents?.loading ? <CompactEmptyState>No retained agents are attached to this cycle.</CompactEmptyState> : null}
              </div>
            ) : null}
          </article>
        );
      }) : (
        <CompactEmptyState>No workflow cycles have been recorded yet.</CompactEmptyState>
      )}
    </div>

    {history.nextCursor ? (
      <div className="actions-row">
        <button className="secondary-button" type="button" disabled={history.loading} onClick={onLoadMore}>
          {history.loading ? "Loading..." : "Load older cycles"}
        </button>
      </div>
    ) : null}
  </section>
);

const LogsPanel = ({
  logFeed,
  agents,
  pendingApprovals,
  activityLogPageIndex,
  commandLogPageIndex,
  onActivityPageChange,
  onCommandPageChange,
  onApprove,
  onReject
}: {
  logFeed: LogFeedView;
  agents: AgentState[];
  pendingApprovals: ApprovalRequestRecord[];
  activityLogPageIndex: number;
  commandLogPageIndex: number;
  onActivityPageChange: (pageIndex: number) => void;
  onCommandPageChange: (pageIndex: number) => void;
  onApprove: (approval: ApprovalRequestRecord) => void;
  onReject: (approval: ApprovalRequestRecord) => void;
}) => {
  const [filter, setFilter] = useState<LogFilterId>("all");
  const [search, setSearch] = useState("");
  const events = useMemo(
    () => buildLogEvents({
      activity: logFeed.activity.entries,
      commands: logFeed.commands.entries,
      agents,
      approvals: pendingApprovals
    }),
    [agents, logFeed.activity.entries, logFeed.commands.entries, pendingApprovals]
  );
  const visibleEvents = useMemo(
    () => events
      .filter((event) => logEventMatchesFilter(event, filter))
      .filter((event) => logTextMatchesSearch(event, search))
      .slice(0, 160),
    [events, filter, search]
  );
  const visibleCommands = useMemo(
    () => logFeed.commands.entries
      .filter((command) => {
        const status = commandStatusChip(command);
        const event: LogEventView = {
          id: command.id,
          timestamp: command.completedAt ?? command.startedAt,
          kind: "command",
          typeLabel: "Command",
          title: command.agentName,
          summary: redactSensitiveText(command.command),
          detail: redactSensitiveText(command.command),
          actor: agentCategoryLabel(command.agentCategory),
          statusLabel: status.label,
          statusTone: status.tone
        };
        return logEventMatchesFilter(event, filter) && logTextMatchesSearch(event, search);
      })
      .slice(0, 40),
    [filter, logFeed.commands.entries, search]
  );
  const eventStats = useMemo(() => {
    const lastEventTime = events.reduce((latest, event) => Math.max(latest, toTime(event.timestamp)), 0);
    return {
      total: Math.max(logFeed.activity.total + logFeed.commands.total, events.length),
      errors: events.filter((event) => event.statusTone === "error").length,
      warnings: events.filter((event) => event.statusTone === "warning").length,
      lastEventTime: lastEventTime ? new Date(lastEventTime).toISOString() : undefined
    };
  }, [events, logFeed.activity.total, logFeed.commands.total]);

  return (
    <section className="workflow-control-center panel workflow-log-workspace">
      <header className="logs-header">
        <div>
          <div className="eyebrow">Execution feed</div>
          <h2>Logs</h2>
          <p>Recent workflow events, agent messages, command snippets, and approvals with sensitive values redacted before display.</p>
        </div>
        <div className="logs-header__stats" aria-label="Log summary">
          <div>
            <span>Recent events</span>
            <strong>{eventStats.total}</strong>
          </div>
          <div>
            <span>Errors / warnings</span>
            <strong>{eventStats.errors} / {eventStats.warnings}</strong>
          </div>
          <div>
            <span>Pending approvals</span>
            <strong>{pendingApprovals.length}</strong>
          </div>
          <div>
            <span>Last event</span>
            <strong>{formatClockTime(eventStats.lastEventTime)}</strong>
          </div>
        </div>
      </header>

      <div className="logs-toolbar">
        <div className="runs-filter-tabs" aria-label="Log filters">
          {LOG_FILTERS.map((option) => (
            <button
              key={option.id}
              className={`runs-filter-tab ${filter === option.id ? "runs-filter-tab--active" : ""}`}
              type="button"
              onClick={() => setFilter(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <input
          className="input logs-search"
          placeholder="Search logs"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      <section className={`logs-approval-strip ${pendingApprovals.length === 0 ? "logs-approval-strip--empty" : ""}`}>
        <div className="candidate-card__title-row">
          <strong>Pending approvals</strong>
          <StatusChip label={pendingApprovals.length ? "Pending" : "Idle"} tone={pendingApprovals.length ? "pending" : "idle"} />
        </div>
        {pendingApprovals.length ? (
          <div className="logs-approval-list">
            {pendingApprovals.slice(0, 6).map((approval) => (
              <article key={approval.id} className="log-approval-card">
                <div>
                  <strong>{redactSensitiveText(approval.summary)}</strong>
                  <p>{summarizeSafeText(approval.reason ?? approval.command, "Approval required before work can continue.", 180)}</p>
                  <span>{approval.kind} · Requested {formatDateTime(approval.createdAt)}</span>
                </div>
                <div className="actions-row">
                  <button className="primary-button" type="button" onClick={() => onApprove(approval)}>Accept</button>
                  <button className="secondary-button" type="button" onClick={() => onReject(approval)}>Reject</button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <CompactEmptyState>No approvals are waiting. The workflow can continue without operator action.</CompactEmptyState>
        )}
      </section>

      <section className="logs-main-grid">
        <article className="logs-feed-panel">
          <SectionTitle
            eyebrow="Activity feed"
            title="Recent execution"
            meta={logFeed.loading ? <StatusChip label="Running" tone="running" /> : <span className="badge">{visibleEvents.length}</span>}
          />
          <FeedPager
            label="Activity"
            pageIndex={activityLogPageIndex}
            pageSize={LOG_ACTIVITY_PAGE_SIZE}
            total={logFeed.activity.total}
            visibleCount={logFeed.activity.entries.length}
            onPageChange={onActivityPageChange}
          />
          <div className="log-event-list">
            {visibleEvents.length ? visibleEvents.map((event) => (
              <article key={event.id} className={`log-event-row log-event-row--${event.statusTone}`}>
                <div className="log-event-row__time">{formatClockTime(event.timestamp)}</div>
                <div className="log-event-row__body">
                  <div className="log-event-row__title">
                    <span>{event.typeLabel}</span>
                    <strong>{event.title}</strong>
                    {event.actor ? <em>{event.actor}</em> : null}
                  </div>
                  <p>{event.summary}</p>
                  {event.detail ? <LongTextDisclosure value={event.detail} /> : null}
                </div>
                <StatusChip label={event.statusLabel} tone={event.statusTone} />
              </article>
            )) : (
              <CompactEmptyState>No log events match the current filter.</CompactEmptyState>
            )}
          </div>
        </article>

        <article className="logs-command-panel">
          <SectionTitle
            eyebrow="Commands"
            title="Command snippets"
            meta={logFeed.loading ? <StatusChip label="Running" tone="running" /> : <span className="badge">{visibleCommands.length}</span>}
          />
          <FeedPager
            label="Commands"
            pageIndex={commandLogPageIndex}
            pageSize={LOG_COMMAND_PAGE_SIZE}
            total={logFeed.commands.total}
            visibleCount={logFeed.commands.entries.length}
            onPageChange={onCommandPageChange}
          />
          <div className="log-command-list">
            {visibleCommands.length ? visibleCommands.map((command) => {
              const safeCommand = redactSensitiveText(command.command);
              const status = commandStatusChip(command);
              return (
                <article key={command.id} className="log-command-card">
                  <div className="log-command-card__header">
                    <div>
                      <strong>{command.agentName}</strong>
                      <span>{agentCategoryLabel(command.agentCategory)} · {formatDateTime(command.startedAt)}</span>
                    </div>
                    <div className="log-command-card__actions">
                      <StatusChip label={status.label} tone={status.tone} />
                      <CopyButton value={safeCommand} />
                    </div>
                  </div>
                  <pre className="log-command-block">{safeCommand}</pre>
                  <details className="long-text-disclosure">
                    <summary>Command details</summary>
                    <div className="log-command-details">
                      <span>CWD: {redactSensitiveText(command.cwd ?? "Not recorded")}</span>
                      <span>Exit: {command.exitCode ?? "Not recorded"}</span>
                      <span>Completed: {formatDateTime(command.completedAt)}</span>
                    </div>
                  </details>
                </article>
              );
            }) : (
              <CompactEmptyState>No command snippets match the current filter.</CompactEmptyState>
            )}
          </div>
        </article>
      </section>
    </section>
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
      <header className="credentials-header">
        <SectionTitle
          eyebrow="Local credentials"
          title="Credentials"
          meta={<span className="badge">{credentials.entries.length} stored • {pendingRequests.length} pending</span>}
        />
        <div className="credentials-security-note">
          Secrets are stored locally for this project and are never added to portable interface files, logs, or prompts automatically.
        </div>
      </header>

      <section className={`credential-requests-panel ${pendingRequests.length === 0 ? "credential-requests-panel--empty" : ""}`}>
        <div className="candidate-card__title-row">
          <strong>Pending credential requests</strong>
          <StatusChip label={pendingRequests.length ? "Pending" : "Idle"} tone={pendingRequests.length ? "pending" : "idle"} />
        </div>
        {pendingRequests.length ? (
          <div className="credential-request-list">
            {pendingRequests.map((request) => {
              const linkedEntry = entriesByLinkedRequest.get(request.id);
              return (
                <article key={request.id} className="credential-request-card">
                  <div>
                    <div className="candidate-card__title-row">
                      <strong>{request.providerName} · {request.keyLabel}</strong>
                      <StatusChip label="Pending" tone="pending" />
                    </div>
                    <p>{redactSensitiveText(request.description)}</p>
                    <div className="workflow-option__meta">
                      <span>{request.requestedByAgentCategory ? agentCategoryLabel(request.requestedByAgentCategory) : "Workflow"}</span>
                      <span>Requested {formatDateTime(request.createdAt)}</span>
                      <span>{request.freeOnly ?? true ? "Free/no-card only" : "Paid allowed with approval"}</span>
                      {linkedEntry ? <span>Stored credential ready</span> : null}
                    </div>
                  </div>
                  <div className="actions-row">
                    <button className="primary-button" type="button" onClick={() => applyRequestToDraft(request.id)}>Use in form</button>
                    {request.userInputRequestId && linkedEntry ? (
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
              );
            })}
          </div>
        ) : (
          <CompactEmptyState>No credential requests are pending. Agents will pause here when a local secret is needed.</CompactEmptyState>
        )}
      </section>

      <div className="credentials-layout">
        <article className="overview-card workflow-panel credential-form-panel">
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

        <article className="overview-card workflow-panel credential-provider-panel">
          <SectionTitle eyebrow="Stored locally" title="Configured providers" meta={<span className="badge">{credentials.entries.length}</span>} />
          <div className="credential-table">
            {credentials.entries.length ? credentials.entries.map((entry) => {
              const status = credentialStatusChip(entry.status);
              return (
                <article key={entry.id} className="credential-table-row">
                  <div className="credential-table-row__main">
                    <strong>{entry.providerName}</strong>
                    <span>{entry.keyLabel}</span>
                    <span>{entry.hasSecretKey ? "API key + secret stored" : entry.hasApiKey ? "API key stored" : "No secret stored"}</span>
                    {entry.notes ? <p>{redactSensitiveText(entry.notes)}</p> : null}
                  </div>
                  <StatusChip label={status.label} tone={status.tone} />
                  <div className="credential-table-row__meta">
                    <span>Created {formatDateTime(entry.createdAt)}</span>
                    <span>Updated {formatDateTime(entry.updatedAt)}</span>
                    <span>{entry.linkedRequestIds.length} linked requests</span>
                  </div>
                  <div className="actions-row">
                    <button className="secondary-button" type="button" onClick={() => editEntry(entry)}>Replace</button>
                    <button className="secondary-button" type="button" disabled={busy} onClick={() => void deleteCredential(entry.id)}>Remove</button>
                  </div>
                </article>
              );
            }) : (
              <CompactEmptyState>No credentials are stored for this project.</CompactEmptyState>
            )}
          </div>
        </article>
      </div>
    </section>
  );
};

const topLevelDirectories = (nodes: RepositoryTreeEntry[]): RepositoryTreeEntry[] =>
  nodes.filter((node) => node.type === "directory").slice(0, 10);

const dependencyEcosystemSummary = (dependencies: LoadedProjectView["record"]["dependencies"]): Array<{ ecosystem: string; count: number }> => {
  const counts = new Map<string, number>();
  for (const dependency of dependencies) {
    counts.set(dependency.ecosystem, (counts.get(dependency.ecosystem) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([ecosystem, count]) => ({ ecosystem, count }))
    .sort((left, right) => right.count - left.count || left.ecosystem.localeCompare(right.ecosystem));
};

const interfaceCreationStatusChip = (status?: LoadedProjectView["record"]["interfaceCreation"]): { label: string; tone: StatusChipTone } => {
  if (!status) {
    return { label: "Pending", tone: "pending" };
  }
  if (status.status === "running" || status.status === "queued") {
    return { label: "Running", tone: "running" };
  }
  if (status.status === "completed") {
    return { label: "Completed", tone: "completed" };
  }
  if (status.status === "failed") {
    return { label: "Error", tone: "error" };
  }
  return { label: "Idle", tone: "idle" };
};

const RepositoryPanel = ({
  project,
  repositoryData,
  repositoryScanStatus,
  repositoryScanLimits,
  repositoryRescanBusy,
  treeFilterDraft,
  deferredTreeFilter,
  selectedFile,
  fileSummary,
  importantPathSummaries,
  availableModels,
  modelOptionsByName,
  summaryModel,
  summaryReasoningMode,
  summaryReasoningEffort,
  summaryAgent,
  summaryActionBusy,
  questionDraft,
  agentActionsBlocked,
  operatorView,
  onRescanRepository,
  onDeepScanRepository,
  onTreeFilterChange,
  onSelectFile,
  onToggleDirectory,
  onLoadMoreRepositoryChildren,
  onSummaryModelChange,
  onSummaryReasoningModeChange,
  onSummaryReasoningEffortChange,
  onGenerateSummary,
  onQuestionDraftChange,
  onAskQuestion,
  onOpenPathWindow,
  searchResultIndex,
  onSelectSearchResult
}: {
  project: LoadedProjectView;
  repositoryData: RepositoryDataView;
  repositoryScanStatus: RepositoryScanStatus | null;
  repositoryScanLimits: RepositoryScanLimitsResponse | null;
  repositoryRescanBusy?: "normal" | "deep";
  treeFilterDraft: string;
  deferredTreeFilter: string;
  selectedFile?: string;
  fileSummary: FileSummary | null;
  importantPathSummaries: FileSummary[];
  availableModels: DiscoveredModel[];
  modelOptionsByName: Map<string, DiscoveredModel>;
  summaryModel: string;
  summaryReasoningMode: AgentReasoningMode;
  summaryReasoningEffort: InterfaceReasoningEffort;
  summaryAgent?: AgentState;
  summaryActionBusy?: { path: string; action: "summary" | "question" | "window" };
  questionDraft: string;
  agentActionsBlocked: boolean;
  operatorView: OperatorWorkflowViewModel;
  onRescanRepository: () => void;
  onDeepScanRepository: (settings?: RepositoryScanSettings) => void;
  onTreeFilterChange: (value: string) => void;
  onSelectFile: (relativePath: string) => void;
  onToggleDirectory: (relativePath: string) => void;
  onLoadMoreRepositoryChildren: (relativePath: string) => void;
  onSummaryModelChange: (model: string) => void;
  onSummaryReasoningModeChange: (mode: AgentReasoningMode) => void;
  onSummaryReasoningEffortChange: (effort: InterfaceReasoningEffort) => void;
  onGenerateSummary: () => void;
  onQuestionDraftChange: (value: string) => void;
  onAskQuestion: () => void;
  onOpenPathWindow: () => void;
  searchResultIndex: number;
  onSelectSearchResult: (index: number) => void;
}) => {
  const [deepScanPreset, setDeepScanPreset] = useState<"broader" | "maximum">("broader");
  const { record } = project;
  const stats = record.stats;
  const overview = record.overview;
  const dependencies = repositoryData.projectId === record.id ? repositoryData.dependencies : [];
  const summaryCache = repositoryData.projectId === record.id ? repositoryData.summaryCache : [];
  const rootChildren = repositoryData.projectId === record.id
    ? repositoryData.childrenByParent[REPOSITORY_ROOT_PARENT]?.children ?? []
    : [];
  const interfaceScanStatus = interfaceCreationStatusChip(record.interfaceCreation);
  const scanStatus = repositoryScanStatusChip(repositoryScanStatus?.status);
  const validationStatus = validationStatusChip(project.validationStatus);
  const accessProbe = record.validation.projectAccess;
  const accessStatus: { label: string; tone: StatusChipTone } = accessProbe
    ? accessProbe.status === "passed"
      ? { label: "Success", tone: "success" }
      : { label: "Error", tone: "error" }
    : { label: "Pending", tone: "pending" };
  const deterministicScanReady = record.interfaceCreation?.deterministicScanReady ?? Boolean(stats);
  const agentAnalysisReady = record.interfaceCreation?.agentAnalysisReady ?? Boolean(overview);
  const directories = topLevelDirectories(rootChildren);
  const dependencySummary = dependencyEcosystemSummary(dependencies);
  const excludedPathEntries = getExcludedPathEntries(stats?.excludedPaths);
  const dependencyTotal = repositoryData.projectId === record.id ? repositoryData.dependencyTotal : record.dependencies.length;
  const summaryCacheTotal = repositoryData.projectId === record.id ? repositoryData.summaryCacheTotal : record.summaryCache.length;
  const scanTruncationMessage = stats?.truncated
    ? stats.truncationReason ?? "Repository scan was truncated."
    : undefined;
  const scanSearchScope = repositoryData.searchResults?.searchScope ?? repositoryScanStatus?.searchScope;
  const searchResults = repositoryData.searchResults;
  const visibleSearchResults = searchResults?.results ?? [];
  const selectedSearchResultIndex = visibleSearchResults.length
    ? Math.min(Math.max(searchResultIndex, 0), visibleSearchResults.length - 1)
    : -1;
  const selectedSearchResult = selectedSearchResultIndex >= 0 ? visibleSearchResults[selectedSearchResultIndex] : undefined;
  const deepScanSettings = deepScanPreset === "maximum"
    ? repositoryScanLimits?.hardMaximums
    : repositoryScanLimits?.deepDefaults;
  const limitHits = repositoryScanStatus?.limitHits ?? [];
  const rawRepositoryAnalysis = [
    overview?.summary,
    overview?.architecture,
    overview?.howItIsOrganized,
    overview?.importantToKnowFirst,
    overview?.recommendations.length ? `Recommendations:\n${overview.recommendations.map((item) => `- ${item}`).join("\n")}` : undefined
  ].filter(Boolean).join("\n\n");
  const scanDetails = [
    stats?.explanation,
    `Project kind: ${record.validation.projectKind}`,
    `Branch: ${record.validation.branch ?? "Not recorded"}`,
    `Git head: ${record.validation.gitHead ?? "Not recorded"}`,
    `Manifest files: ${stats?.manifestFiles.join(", ") || "None detected"}`,
    `Entry points: ${stats?.entryPoints.join(", ") || "None detected"}`
  ].filter(Boolean).join("\n");
  const selectedPathKind = fileSummary?.pathKind ?? (selectedFile && rootChildren.some((entry) => entry.path === selectedFile && entry.type === "directory") ? "directory" : "file");
  const summaryAgentRunning = summaryAgent ? isWorkflowAgentActive(summaryAgent) : false;
  const selectedPathBusyAction = summaryActionBusy && summaryActionBusy.path === selectedFile ? summaryActionBusy.action : undefined;
  const summaryControlsDisabled = !selectedFile || !summaryModel || agentActionsBlocked || summaryAgentRunning || Boolean(selectedPathBusyAction);
  const questionDisabled = summaryControlsDisabled || !questionDraft.trim();

  return (
    <section className="workspace-summary repository-workspace repository-intelligence-page">
      <header className="repository-header">
        <div>
          <div className="eyebrow">Repository intelligence</div>
          <h2>{record.identity.projectName}</h2>
          <p>{redactSensitiveText(overview?.whatProjectDoes ?? overview?.summary ?? "Repository analysis is still in progress.")}</p>
        </div>
        <div className="repository-header__chips">
          <StatusChip label={scanStatus.label} tone={scanStatus.tone} />
          <StatusChip label={interfaceScanStatus.label} tone={interfaceScanStatus.tone} />
          <StatusChip label={validationStatus.label} tone={validationStatus.tone} />
        </div>
      </header>

      <section className="repository-summary-grid">
        <article className="repository-fact-card repository-fact-card--wide">
          <span>Project intent</span>
          <strong>{record.identity.repositoryName ?? record.identity.projectName}</strong>
          <p>{summarizeSafeText(overview?.importantToKnowFirst ?? overview?.whatProjectDoes ?? overview?.summary, "No project intent has been generated yet.", 220)}</p>
        </article>
        <article className="repository-fact-card">
          <span>Files</span>
          <strong>{stats?.includedFiles ?? 0}</strong>
          <p>{stats?.totalFiles ?? 0} total · {stats?.excludedFiles ?? 0} excluded</p>
        </article>
        <article className="repository-fact-card">
          <span>Indexed size</span>
          <strong>{formatBytes(stats?.includedSizeBytes ?? 0)}</strong>
          <p>{formatBytes(stats?.totalSizeBytes ?? 0)} scanned footprint</p>
        </article>
        <article className="repository-fact-card">
          <span>Dependencies</span>
          <strong>{dependencyTotal}</strong>
          <p>{stats?.primaryManagers.join(", ") || "Package manager not detected"}</p>
        </article>
        <article className="repository-fact-card">
          <span>Last scan</span>
          <strong>{formatClockTime(repositoryScanStatus?.lastScanAt ?? stats?.scanCompletedAt ?? record.validation.lastValidatedAt)}</strong>
          <p>{formatMilliseconds(repositoryScanStatus?.scanDurationMs ?? stats?.scanDurationMs)}</p>
        </article>
      </section>

      <article className="repository-section repository-workflow-health">
        <SectionTitle
          eyebrow="Workflow safety"
          title="Repository health for current cycle"
          meta={<StatusChip label={operatorView.repositoryHealth.hygieneLabel} tone={operatorStatusTone(operatorView.repositoryHealth.hygieneStatus)} />}
        />
        <div className="repository-coverage-grid">
          <div>
            <span>Indexed status</span>
            <strong>{operatorView.repositoryHealth.indexedLabel}</strong>
          </div>
          <div>
            <span>Detected project type</span>
            <strong>{operatorView.repositoryHealth.detectedProjectType}</strong>
          </div>
          <div>
            <span>Validation status</span>
            <strong>{operatorView.repositoryHealth.validationLabel}</strong>
          </div>
          <div>
            <span>Hygiene status</span>
            <strong>{operatorView.repositoryHealth.hygieneLabel}</strong>
          </div>
          <div>
            <span>Runtime</span>
            <strong>{operatorView.repositoryHealth.runtimeLabel}</strong>
          </div>
          <div>
            <span>Changed-file groups</span>
            <strong>{operatorView.repositoryHealth.changedFileGroups.map((group) => `${group.label}: ${group.files.length}`).join(" · ") || "No active changes"}</strong>
          </div>
        </div>
        <div className="repository-two-column">
          <OperatorMiniList
            label="Suspicious paths"
            items={operatorView.repositoryHealth.suspiciousPaths.map((file) => `${file} - ${suspiciousPathReason(file) ?? "Blocked by hygiene scan"}`)}
            empty="No suspicious active-cycle paths detected."
            tone={operatorView.repositoryHealth.suspiciousPaths.length ? "danger" : undefined}
          />
          <OperatorMiniList
            label="Generated artifacts cleaned"
            items={operatorView.repositoryHealth.cleanedGeneratedArtifacts}
            empty="No generated artifacts were cleaned by hygiene."
          />
        </div>
        <div className="repository-two-column">
          <OperatorMiniList
            label="Project-supported validation commands"
            items={operatorView.repositoryHealth.testCommandCandidates}
            empty="No validation command candidates are recorded in the cycle contract."
          />
          <OperatorMiniList
            label="Project-supported evidence commands"
            items={operatorView.repositoryHealth.evidenceCommandCandidates}
            empty="No evidence command candidates discovered for this project."
          />
        </div>
        <div className="operator-contract-section">
          <span className="workflow-option__label">Current changed-file risk grouping</span>
          <OperatorChangedFiles groups={operatorView.repositoryHealth.changedFileGroups} empty="No active workflow changed files are recorded." />
        </div>
        <div className="operator-contract-section">
          <span className="workflow-option__label">Command readiness</span>
          <div className="repository-coverage-grid">
            {operatorView.repositoryHealth.commandAvailability.map((command) => (
              <div key={command.label}>
                <span>{command.label}</span>
                <strong>{command.available === true ? "Available" : command.available === false ? "Not detected" : "Unknown"}</strong>
                <p>{command.detail}</p>
              </div>
            ))}
          </div>
        </div>
      </article>

      <article className="repository-section repository-scan-status-card">
        <SectionTitle
          eyebrow="Index status"
          title="Repository indexed"
          meta={<StatusChip label={scanStatus.label} tone={scanStatus.tone} />}
        />
        <div className="repository-coverage-grid">
          <div>
            <span>Status</span>
            <strong>{scanStatus.label}</strong>
          </div>
          <div>
            <span>Last scan</span>
            <strong>{formatDateTime(repositoryScanStatus?.lastScanAt ?? stats?.scanCompletedAt ?? overview?.generatedAt)}</strong>
          </div>
          <div>
            <span>Duration</span>
            <strong>{formatMilliseconds(repositoryScanStatus?.scanDurationMs ?? stats?.scanDurationMs)}</strong>
          </div>
          <div>
            <span>Total found</span>
            <strong>{repositoryScanStatus?.filesTotal ?? stats?.totalFiles ?? 0} files / {repositoryScanStatus?.foldersTotal ?? stats?.totalFolders ?? 0} folders</strong>
          </div>
          <div>
            <span>Included</span>
            <strong>{repositoryScanStatus?.includedFiles ?? stats?.includedFiles ?? 0} files / {repositoryScanStatus?.includedFolders ?? stats?.includedFolders ?? 0} folders</strong>
          </div>
          <div>
            <span>Skipped/excluded</span>
            <strong>{repositoryScanStatus?.excludedFiles ?? stats?.excludedFiles ?? 0} files / {repositoryScanStatus?.excludedFolders ?? stats?.excludedFolders ?? 0} folders</strong>
          </div>
          <div>
            <span>Indexed size</span>
            <strong>{formatBytes(repositoryScanStatus?.indexedSizeBytes ?? stats?.includedSizeBytes ?? 0)}</strong>
          </div>
          <div>
            <span>Excluded size</span>
            <strong>{formatBytes(repositoryScanStatus?.excludedSizeBytes ?? stats?.excludedSizeBytes ?? 0)}</strong>
          </div>
          <div>
            <span>Truncation</span>
            <strong>{repositoryScanStatus?.truncated || stats?.truncated ? "Yes" : "No"}</strong>
          </div>
          <div>
            <span>Search scope</span>
            <strong>{repositorySearchScopeLabel(scanSearchScope)}</strong>
          </div>
        </div>
        {repositoryScanStatus?.truncated || scanTruncationMessage ? (
          <div className="notice notice--compact">
            Scan limits were reached: {repositoryScanStatus?.truncationReason ?? scanTruncationMessage}. Use Deep Scan if you need broader coverage.
          </div>
        ) : null}
        {limitHits.length ? (
          <div className="tag-row">
            {limitHits.map((hit) => (
              <span key={hit.code} className="tag">
                {hit.label}{hit.limit !== undefined ? `: ${hit.limit}` : ""}{hit.omittedFilesEstimate || hit.omittedDirectoriesEstimate ? ` · omitted about ${hit.omittedFilesEstimate ?? 0} files / ${hit.omittedDirectoriesEstimate ?? 0} folders` : ""}
              </span>
            ))}
          </div>
        ) : null}
        {repositoryScanStatus?.lastError ? (
          <div className="notice notice--compact notice--error">
            <strong>{repositoryScanStatus.lastError}</strong>
            {repositoryScanStatus.recoverySteps.length ? (
              <ul className="workflow-compact-list">
                {repositoryScanStatus.recoverySteps.map((step) => <li key={step}>{step}</li>)}
              </ul>
            ) : null}
          </div>
        ) : null}
        <div className="repository-deep-scan-controls">
          <label className="form-field">
            <span>Deep scan limits</span>
            <select
              className="input"
              value={deepScanPreset}
              onChange={(event) => setDeepScanPreset(event.target.value as "broader" | "maximum")}
            >
              <option value="broader">Broader index</option>
              <option value="maximum">Maximum safe index</option>
            </select>
          </label>
          <div className="notice notice--compact">
            Deep Scan raises file, folder, depth, and time limits and may take longer on large repositories. Generated dependency, build, and cache folders remain excluded.
          </div>
        </div>
        <div className="actions-row">
          <button className="secondary-button" type="button" disabled={Boolean(repositoryRescanBusy)} onClick={onRescanRepository}>
            {repositoryRescanBusy === "normal" ? "Rescanning..." : "Rescan Repository"}
          </button>
          <button className="secondary-button" type="button" disabled={Boolean(repositoryRescanBusy) || repositoryScanStatus?.deepScanAvailable === false} onClick={() => onDeepScanRepository(deepScanSettings)}>
            {repositoryRescanBusy === "deep" ? "Deep scanning..." : "Deep Scan"}
          </button>
        </div>
        <details className="workflow-inline-details">
          <summary>Skipped paths and scan limits</summary>
          <div className="tag-row">
            {repositoryScanStatus?.skippedReasons.length ? repositoryScanStatus.skippedReasons.map((entry) => (
              <span key={`${entry.reason}:${entry.detail ?? ""}`} className="tag">
                {entry.reason}: {entry.count}{entry.detail ? ` · ${entry.detail}` : ""}
              </span>
            )) : <span className="tag">No skipped-path summary is available.</span>}
          </div>
          <pre className="runtime-readiness-command"><code>{JSON.stringify({
            used: repositoryScanStatus?.limits ?? {},
            deepScanSettings: deepScanSettings ?? {},
            hardMaximums: repositoryScanLimits?.hardMaximums ?? {}
          }, null, 2)}</code></pre>
        </details>
      </article>

      <section className="repository-browser-layout">
        <article className="repository-section repository-tree-panel repository-tree-panel--primary">
          <SectionTitle
            eyebrow="Files"
            title="Repository tree"
            meta={<span className="badge">{stats?.includedFiles ?? 0} indexed</span>}
          />
          <div className="panel-toolbar__summary">
            <span>{formatBytes(stats?.includedSizeBytes ?? 0)} indexed</span>
            <span>{stats?.testsPresent ? "Tests detected" : "No tests detected"}</span>
            <span>Search: {repositorySearchScopeLabel(scanSearchScope)}</span>
          </div>
          {repositoryData.loading ? (
            <LoadingIndicator label="Loading repository tree" compact />
          ) : (
            <>
              {repositoryData.treeError ? <div className="notice notice--compact notice--error">{repositoryData.treeError}</div> : null}
              <RepoTree
                key={record.id}
                projectId={record.id}
                childrenByParent={repositoryData.childrenByParent}
                expandedPaths={repositoryData.expandedPaths}
                loadingParents={repositoryData.loadingParents}
                searchLoading={repositoryData.searchLoading}
                selected={selectedFile}
                onSelect={onSelectFile}
                onToggleDirectory={onToggleDirectory}
                onLoadMore={onLoadMoreRepositoryChildren}
              />
            </>
          )}
        </article>

        <aside className="repository-browser-side">
          <article className="repository-section repository-search-panel">
            <SectionTitle
              eyebrow="Find"
              title="Search files"
              meta={searchResults ? <span className="badge">{searchResults.total}</span> : null}
            />
            <input
              className="input"
              placeholder="Search file names or paths"
              value={treeFilterDraft}
              onChange={(event) => onTreeFilterChange(event.target.value)}
            />
            <div className="actions-row">
              <button
                className="secondary-button secondary-button--compact"
                type="button"
                disabled={visibleSearchResults.length <= 1}
                onClick={() => onSelectSearchResult(selectedSearchResultIndex - 1)}
              >
                Previous
              </button>
              <button
                className="secondary-button secondary-button--compact"
                type="button"
                disabled={visibleSearchResults.length <= 1}
                onClick={() => onSelectSearchResult(selectedSearchResultIndex + 1)}
              >
                Next
              </button>
              {treeFilterDraft.trim() ? (
                <button
                  className="secondary-button secondary-button--compact"
                  type="button"
                  onClick={() => onTreeFilterChange("")}
                >
                  Clear
                </button>
              ) : null}
            </div>
            {repositoryData.searchLoading ? <LoadingIndicator label="Searching repository" compact /> : null}
            {deferredTreeFilter.trim() && searchResults ? (
              <div className="notice notice--compact">
                {searchResults.truncated
                  ? `Showing ${visibleSearchResults.length} of ${searchResults.total} matching files from ${repositorySearchScopeLabel(searchResults.searchScope)}.`
                  : `Found ${visibleSearchResults.length} matching file${visibleSearchResults.length === 1 ? "" : "s"} in ${repositorySearchScopeLabel(searchResults.searchScope)}.`}
              </div>
            ) : null}
            {selectedSearchResult ? (
              <div className="repository-search-current">
                <span className="workflow-option__label">Selected result</span>
                <strong>{selectedSearchResultIndex + 1} of {visibleSearchResults.length}</strong>
                <code>{selectedSearchResult.path}</code>
              </div>
            ) : null}
            <div className="repository-search-results">
              {visibleSearchResults.length ? visibleSearchResults.slice(0, 80).map((result, index) => (
                <button
                  key={result.path}
                  className={`repository-search-result ${index === selectedSearchResultIndex ? "repository-search-result--selected" : ""}`}
                  type="button"
                  onClick={() => onSelectSearchResult(index)}
                >
                  <strong>{result.name}</strong>
                  <span>{result.path}</span>
                </button>
              )) : (
                <CompactEmptyState>{deferredTreeFilter.trim() ? "No matching files found." : "Search by file name or path."}</CompactEmptyState>
              )}
            </div>
          </article>

          <article className="repository-section repository-file-panel repository-path-inspector">
            <div className="candidate-card__title-row">
              <h3>Path details</h3>
              {fileSummary ? <SourceBadge source={fileSummary.source} /> : selectedFile ? <span className="badge">{selectedPathKind}</span> : null}
            </div>
            {selectedFile ? (
              <>
                <div className="repository-path-card">
                  <div className="repository-path-card__header">
                    <span className={`repository-path-card__kind repository-path-card__kind--${fileSummary?.pathKind ?? selectedPathKind}`}>
                      {fileSummary?.pathKind ?? selectedPathKind}
                    </span>
                    <strong>{fileSummary?.relativePath ?? selectedFile}</strong>
                  </div>
                  {fileSummary ? (
                    <FormattedSummaryText value={fileSummary.summary} />
                  ) : (
                    <LoadingIndicator label="Loading path summary" compact />
                  )}
                </div>

                <div className="repository-agent-card">
                  <div className="candidate-card__title-row">
                    <h4>Summary agent</h4>
                    {summaryAgent ? <StatusChip label={summaryAgent.status} tone={summaryAgent.status === "completed" ? "completed" : summaryAgent.status === "failed" ? "error" : "running"} /> : null}
                  </div>
                  <label className="form-field">
                    <span>Model</span>
                    <select className="input" value={summaryModel} onChange={(event) => onSummaryModelChange(event.target.value)} disabled={agentActionsBlocked || !availableModels.length}>
                      {availableModels.map((model) => <option key={model.id} value={model.model}>{model.displayName} ({model.model})</option>)}
                    </select>
                  </label>
                  <AgentReasoningPicker
                    category="manual"
                    model={modelOptionsByName.get(summaryModel)}
                    taskPrompt={`Repository path summary: ${selectedFile}`}
                    mode={summaryReasoningMode}
                    effort={summaryReasoningEffort}
                    onModeChange={onSummaryReasoningModeChange}
                    onEffortChange={onSummaryReasoningEffortChange}
                  />
                  {summaryAgentRunning ? <LoadingIndicator label="Summary agent running" compact /> : null}
                  <div className="actions-row">
                    <button className="primary-button" type="button" disabled={summaryControlsDisabled} onClick={onGenerateSummary}>
                      {selectedPathBusyAction === "summary" ? "Starting..." : "Generate LLM Summary"}
                    </button>
                    <button className="secondary-button" type="button" disabled={!selectedFile || selectedPathBusyAction === "window"} onClick={onOpenPathWindow}>
                      {selectedPathBusyAction === "window" ? "Opening..." : "Open in New Window"}
                    </button>
                  </div>
                  <textarea
                    className="textarea repository-question-input"
                    placeholder="Ask about this path"
                    value={questionDraft}
                    onChange={(event) => onQuestionDraftChange(event.target.value)}
                    disabled={agentActionsBlocked || !selectedFile}
                  />
                  <div className="actions-row">
                    <button className="secondary-button" type="button" disabled={questionDisabled} onClick={onAskQuestion}>
                      {selectedPathBusyAction === "question" ? "Opening chat..." : "Ask in Chat"}
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <CompactEmptyState>Select a file or folder in the repository tree to load its summary and related symbols.</CompactEmptyState>
            )}
          </article>
        </aside>
      </section>

      <section className="repository-report-layout">
        <div className="repository-report-main">
          <article className="repository-section">
            <SectionTitle eyebrow="Structure" title="Important paths and modules" />
            <div className="repository-two-column">
              <div>
                <span className="workflow-option__label">Important paths</span>
                <div className="path-summary-list">
                  {importantPathSummaries.length ? importantPathSummaries.slice(0, 6).map((summary) => (
                    <div key={summary.relativePath} className="path-summary path-summary--compact">
                      <div className="candidate-card__title-row">
                        <strong>{summary.relativePath}</strong>
                        <SourceBadge source={summary.source} />
                      </div>
                      <p>{summarizeSafeText(summary.summary, "No summary available.", 170)}</p>
                    </div>
                  )) : <CompactEmptyState>No important path summaries are available yet.</CompactEmptyState>}
                </div>
              </div>
              <div>
                <span className="workflow-option__label">Main directories</span>
                <div className="tag-row">
                  {directories.length ? directories.map((node) => <span key={node.path} className="tag">{node.path}</span>) : <span className="tag">No directories detected</span>}
                </div>
                <span className="workflow-option__label">Entry points</span>
                <div className="tag-row">
                  {stats?.entryPoints.length ? stats.entryPoints.slice(0, 10).map((entry) => <span key={entry} className="tag">{entry}</span>) : <span className="tag">None detected</span>}
                </div>
              </div>
            </div>
            <div className="path-summary-list">
              {overview?.subsystemSummaries.length ? overview.subsystemSummaries.slice(0, 5).map((subsystem) => (
                <div key={subsystem.name} className="path-summary">
                  <strong>{subsystem.name}</strong>
                  <p>{summarizeSafeText(subsystem.summary, "No subsystem summary available.", 180)}</p>
                  {subsystem.paths.length ? <span className="agent-card__subtle">{subsystem.paths.slice(0, 5).join(", ")}</span> : null}
                </div>
              )) : <CompactEmptyState>No subsystem breakdown is available yet.</CompactEmptyState>}
            </div>
          </article>

          <article className="repository-section">
            <SectionTitle eyebrow="Dependencies" title="Runtime and package map" meta={<span className="badge">{dependencyTotal}</span>} />
            <div className="repository-two-column">
              <div>
                <span className="workflow-option__label">Package manager</span>
                <p>{stats?.primaryManagers.join(", ") || "No package manager was detected."}</p>
                <div className="tag-row">
                  {dependencySummary.length ? dependencySummary.map((entry) => <span key={entry.ecosystem} className="tag">{entry.ecosystem}: {entry.count}</span>) : <span className="tag">No dependencies</span>}
                </div>
              </div>
              <div>
                <span className="workflow-option__label">Framework/runtime notes</span>
                {overview?.dependencyHighlights.length ? (
                  <ul className="workflow-compact-list">
                    {overview.dependencyHighlights.slice(0, 5).map((highlight) => <li key={highlight}>{redactSensitiveText(highlight)}</li>)}
                  </ul>
                ) : <p>No dependency highlights have been generated yet.</p>}
              </div>
            </div>
            <details className="workflow-inline-details">
              <summary>View dependency list</summary>
              {dependencyTotal > dependencies.length ? (
                <p>Showing first {dependencies.length} of {dependencyTotal} dependencies.</p>
              ) : null}
              <div className="tag-row">
                {dependencies.length ? dependencies.slice(0, 80).map((dependency) => (
                  <span key={`${dependency.manifest}:${dependency.name}`} className="tag">
                    {dependency.name}@{dependency.version}{dependency.dev ? " dev" : ""}
                  </span>
                )) : <span className="tag">No dependencies detected</span>}
              </div>
            </details>
          </article>

          <article className="repository-section">
            <SectionTitle eyebrow="Scan coverage" title="Included, excluded, and analysis status" />
            <div className="repository-coverage-grid">
              <div>
                <span>Included paths</span>
                <strong>{record.identity.selectedSubpath ?? "."}</strong>
              </div>
              <div>
                <span>Excluded files/folders</span>
                <strong>{repositoryScanStatus?.excludedFiles ?? stats?.excludedFiles ?? 0} / {repositoryScanStatus?.excludedFolders ?? stats?.excludedFolders ?? 0}</strong>
              </div>
              <div>
                <span>Deterministic scan</span>
                <strong>{deterministicScanReady ? "Ready" : "Pending"}</strong>
              </div>
              <div>
                <span>Agent analysis</span>
                <strong>{agentAnalysisReady ? "Ready" : "Pending"}</strong>
              </div>
            </div>
            {scanTruncationMessage ? (
              <div className="notice notice--compact">
                Showing a bounded repository scan: {scanTruncationMessage}.
              </div>
            ) : null}
            <div className="tag-row">
              {getTopFileTypes(stats?.fileTypeBreakdown).map(([label, count]) => (
                <span key={label} className="tag">{label}: {count}</span>
              ))}
            </div>
            <details className="workflow-inline-details">
              <summary>View excluded paths</summary>
              <div className="path-summary-list">
                {excludedPathEntries.length ? excludedPathEntries.slice(0, 18).map((entry) => (
                  <div key={`${entry.rule}:${entry.path}`} className="path-summary path-summary--compact">
                    <div className="candidate-card__title-row">
                      <strong>{entry.path}</strong>
                      <span className="badge">{entry.kind}</span>
                    </div>
                    <p>{exclusionRuleLabel(entry.rule)} · {entry.fileCount} files · {formatBytes(entry.totalSizeBytes)}</p>
                    <p>{excludedPathExplanation(entry.path)}</p>
                  </div>
                )) : <CompactEmptyState>No excluded paths were detected by the scanner.</CompactEmptyState>}
              </div>
              {stats?.excludedPathRecordsTruncated ? (
                <div className="notice notice--compact">Excluded path records were capped at {stats.excludedPathLimit ?? "the configured limit"}.</div>
              ) : null}
              <div className="path-summary-list">
                {commonExcludedPathExplanations.map(([label, explanation]) => (
                  <div key={label} className="path-summary path-summary--compact">
                    <strong>{label}</strong>
                    <p>{explanation}</p>
                  </div>
                ))}
              </div>
            </details>
          </article>

          <article className="repository-section">
            <SectionTitle eyebrow="Access check" title="Project access" meta={<StatusChip label={accessStatus.label} tone={accessStatus.tone} />} />
            <div className="repository-access-card">
              <strong>{accessProbe?.message ?? "No project access validation has been recorded yet."}</strong>
              <p>{accessProbe?.error ? redactSensitiveText(accessProbe.error) : "Workbench access is checked from the local runtime boundary, not from the renderer."}</p>
              <div className="workflow-option__meta">
                <span>Last validation: {formatDateTime(accessProbe?.checkedAt ?? record.validation.lastValidatedAt)}</span>
                <span>Branch: {record.validation.branch ?? "Not recorded"}</span>
              </div>
            </div>
          </article>

          <article className="repository-section">
            <SectionTitle eyebrow="Raw details" title="Collapsed analysis" />
            <LongTextDisclosure title="Raw scan details" value={scanDetails} code />
            <LongTextDisclosure title="Full repository analysis" value={rawRepositoryAnalysis || "No full repository analysis is available yet."} code />
            <details className="workflow-inline-details">
              <summary>File/path details</summary>
              {summaryCacheTotal > summaryCache.length ? (
                <p>Showing first {summaryCache.length} of {summaryCacheTotal} file summaries.</p>
              ) : null}
              <div className="path-summary-list">
                {summaryCache.length ? summaryCache.slice(0, 80).map((summary) => (
                  <div key={summary.relativePath} className="path-summary path-summary--compact">
                    <strong>{summary.relativePath}</strong>
                    <p>{summarizeSafeText(summary.purpose || summary.summary, "No summary available.", 170)}</p>
                  </div>
                )) : <CompactEmptyState>No file summaries are available yet.</CompactEmptyState>}
              </div>
            </details>
          </article>
        </div>

      </section>
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

const WorkflowControlHeader = ({
  projectName,
  statusLabel,
  statusTone,
  cycleLabel,
  stageLabel,
  agentLabel,
  lastUpdatedAt,
  approvalsPending,
  primaryAction,
  secondaryActions
}: {
  projectName: string;
  statusLabel: string;
  statusTone: ShellStatusTone;
  cycleLabel: string;
  stageLabel: string;
  agentLabel: string;
  lastUpdatedAt?: string;
  approvalsPending: number;
  primaryAction?: ShellAction;
  secondaryActions: ShellAction[];
}) => (
  <header className="workflow-operator-header">
    <div className="workflow-operator-header__main">
      <div className="eyebrow">Workflow control</div>
      <h2>{projectName}</h2>
      <div className="workflow-operator-header__chips">
        <span className={`status-chip status-chip--${statusTone}`}>{statusLabel}</span>
        <span className="badge">{cycleLabel}</span>
        <span className="badge">{approvalsPending} approvals pending</span>
      </div>
    </div>
    <div className="workflow-operator-header__facts" aria-label="Workflow facts">
      <div>
        <span>Stage</span>
        <strong>{stageLabel}</strong>
      </div>
      <div>
        <span>Agent</span>
        <strong>{agentLabel}</strong>
      </div>
      <div>
        <span>Updated</span>
        <strong>{formatClockTime(lastUpdatedAt)}</strong>
      </div>
    </div>
    <div className="workflow-operator-header__actions">
      {primaryAction ? (
        <button className="primary-button" disabled={primaryAction.disabled} onClick={primaryAction.onClick} type="button">
          {primaryAction.label}
        </button>
      ) : null}
      <div className="workflow-control-actions" aria-label="Workflow actions">
        {secondaryActions.map((action) => (
          <button key={action.label} className="secondary-button" disabled={action.disabled} onClick={action.onClick} type="button">
            {action.label}
          </button>
        ))}
      </div>
    </div>
  </header>
);

const WorkflowStageTimeline = ({
  steps,
  nowTime
}: {
  steps: ReturnType<typeof buildWorkflowTimelineSteps>;
  nowTime: number;
}) => {
  const displayState = (step: ReturnType<typeof buildWorkflowTimelineSteps>[number]): { label: string; tone: string } => {
    if (step.isBlocked || step.status === "failed" || step.displayStatus === "failed") {
      return { label: "Blocked", tone: "blocked" };
    }
    if (step.isCurrent || step.status === "running" || step.status === "waiting" || step.displayStatus === "repairing" || step.displayStatus === "retrying_validation") {
      return { label: "Active", tone: "active" };
    }
    if (step.status === "completed" || step.displayStatus === "fixed") {
      return { label: "Completed", tone: "completed" };
    }
    return { label: "Not started", tone: "not-started" };
  };

  return (
    <section className="workflow-stage-timeline" aria-label="Workflow stage timeline">
      {steps.map((step, index) => {
        const state = displayState(step);
        return (
          <article key={step.id} className={`workflow-stage-timeline__step workflow-stage-timeline__step--${state.tone} ${step.isCurrent ? "workflow-stage-timeline__step--current" : ""}`}>
            <div className="workflow-stage-timeline__marker">{index + 1}</div>
            <div className="workflow-stage-timeline__body">
              <div className="candidate-card__title-row">
                <strong>{step.title}</strong>
                <span className={`badge workflow-stage-timeline__badge workflow-stage-timeline__badge--${state.tone}`}>{state.label}</span>
              </div>
              <p>{summarizeText(step.isCurrent ? (step.currentActivity ?? step.description) : step.description, step.description, 105)}</p>
              <div className="workflow-step-card__meta">
                {step.updatedAt ? <span>Updated {formatClockTime(step.updatedAt)}</span> : null}
                {step.startedAt ? <span>{formatElapsedDuration(step.startedAt, step.completedAt, nowTime) ?? "In progress"}</span> : null}
              </div>
            </div>
          </article>
        );
      })}
    </section>
  );
};

const WorkflowCurrentActionCard = ({
  stageLabel,
  agentName,
  agentStatus,
  focus,
  runSummary,
  changedFilesCount,
  checksStatus,
  approvalsPending,
  nextAction,
  phase,
  repairAction
}: {
  stageLabel: string;
  agentName: string;
  agentStatus?: AgentState["status"];
  focus: string;
  runSummary: string;
  changedFilesCount: number;
  checksStatus: string;
  approvalsPending: number;
  nextAction: string;
  phase: string;
  repairAction?: {
    label: string;
    disabled?: boolean;
    busy?: boolean;
    onClick: () => void;
  };
}) => (
  <article className="workflow-now-card">
    <SectionTitle
      eyebrow="Current action"
      title="What is happening now"
      meta={agentStatus ? <StatusChip {...agentLifecycleStatusChip(agentStatus)} /> : <StatusChip label="Idle" tone="idle" />}
    />
    <div className="workflow-now-card__focus">
      <span className="workflow-option__label">Current focus</span>
      <strong>{focus}</strong>
      <p>{runSummary}</p>
    </div>
    <div className="workflow-now-card__grid">
      <div>
        <span>Stage</span>
        <strong>{stageLabel}</strong>
      </div>
      <div>
        <span>Agent</span>
        <strong>{agentName}</strong>
      </div>
      <div>
        <span>Phase</span>
        <strong>{phase}</strong>
      </div>
      <div>
        <span>Changed files</span>
        <strong>{changedFilesCount}</strong>
      </div>
      <div>
        <span>Checks</span>
        <strong>{checksStatus}</strong>
      </div>
      <div>
        <span>Approvals</span>
        <strong>{approvalsPending}</strong>
      </div>
    </div>
    <div className="workflow-now-card__next">
      <span className="workflow-option__label">Next recommended action</span>
      <p>{nextAction}</p>
      {repairAction ? (
        <div className="actions-row workflow-now-card__actions">
          <button className="primary-button" disabled={repairAction.disabled || repairAction.busy} onClick={repairAction.onClick} type="button">
            {repairAction.busy ? "Opening repair agent..." : repairAction.label}
          </button>
        </div>
      ) : null}
    </div>
  </article>
);

const WorkflowCurrentAgentMessages = ({
  agent,
  workflow,
  recoveryAvailable,
  onRecover
}: {
  agent?: AgentState;
  workflow?: ProjectWorkflowState;
  recoveryAvailable: boolean;
  onRecover: () => void;
}) => {
  const status = agent ? agentLifecycleStatusChip(agent.status) : { label: "Idle", tone: "idle" as const };
  const recentEvents = agent
    ? sortEventsByAge(agent.events)
      .filter((event) => Boolean(event.title.trim()) || Boolean(event.detail?.trim()))
      .slice(0, 5)
    : [];
  const active = agent ? isWorkflowAgentActive(agent) : false;
  const latestMessage = agent
    ? summarizeSafeText(
      agent.lastMessageSnippet ?? latestMeaningfulAgentDetail(agent) ?? agent.currentSubtask ?? agent.currentPhase,
      "No current agent message has been captured yet.",
      260
    )
    : "No workflow agent is selected for the current cycle.";
  const cycleLabel = agent
    ? `Cycle ${agent.workflowCycleNumber ?? workflow?.workflowCycle.cycleNumber ?? "unknown"}`
    : workflow ? `Cycle ${workflow.workflowCycle.cycleNumber}` : "No cycle";

  return (
    <article className="workflow-agent-messages-card">
      <SectionTitle
        eyebrow="Current agent"
        title="Recent messages"
        meta={<StatusChip label={status.label} tone={status.tone} />}
      />
      <div className="workflow-agent-messages-card__summary">
        <div>
          <span className="workflow-option__label">{cycleLabel}</span>
          <strong>{agent?.name ?? "No current workflow agent"}</strong>
        </div>
        <p>
          {agent
            ? active
              ? "This is the live workflow agent the app is currently tracking."
              : agent.status === "disconnected"
                ? "This is an interrupted saved agent, not a live Codex process."
                : "This is the most recent workflow agent for this project."
            : "The workflow is waiting for the next runnable step."}
        </p>
      </div>
      <div className="lane-note">
        <strong>{agent?.currentSubtask ?? agent?.currentPhase ?? "Latest agent message"}</strong>
        <span>{latestMessage}</span>
      </div>
      {recoveryAvailable ? (
        <div className="workflow-agent-messages-card__recovery">
          <div>
            <strong>Interrupted; recovery available</strong>
            <span>Continue from saved state restarts the workflow step instead of trusting a stale process label.</span>
          </div>
          <button className="primary-button" type="button" onClick={onRecover}>Continue from saved state</button>
        </div>
      ) : null}
      <div className="workflow-agent-messages-card__list">
        {recentEvents.length ? recentEvents.map((event) => (
          <div key={event.id} className="workflow-agent-message-row">
            <div>
              <strong>{redactSensitiveText(event.title)}</strong>
              <p>{summarizeSafeText(event.detail, workflowEventStatusLabel(event.status), 180)}</p>
            </div>
            <span>{formatClockTime(event.timestamp)}</span>
          </div>
        )) : (
          <p className="agent-card__subtle">Recent agent messages will appear here after the current run reports progress.</p>
        )}
      </div>
    </article>
  );
};

const WorkflowNeedsAttentionPanel = ({
  items,
  onApprove,
  onReject,
  onOpenCredentials,
  onViewDetails,
  onRetryManualHandoff,
  onOpenProjectShell,
  onDownloadRepairReport,
  shellLaunchBusy,
  repairReportAvailable
}: {
  items: WorkflowAttentionItem[];
  onApprove: (approval: ApprovalRequestRecord) => void;
  onReject: (approval: ApprovalRequestRecord) => void;
  onOpenCredentials: () => void;
  onViewDetails: (target?: WorkflowAttentionItem["target"]) => void;
  onRetryManualHandoff: () => void;
  onOpenProjectShell: () => void;
  onDownloadRepairReport: () => void;
  shellLaunchBusy: boolean;
  repairReportAvailable: boolean;
}) => {
  const [expandedItemId, setExpandedItemId] = useState<string>();
  const visibleItems = items.slice(0, 8);
  const hiddenCount = Math.max(0, items.length - visibleItems.length);
  const toggleDetails = (item: WorkflowAttentionItem) => {
    setExpandedItemId((current) => current === item.id ? undefined : item.id);
    onViewDetails(item.target);
  };

  return (
    <article id="workflow-needs-attention" className={`workflow-attention-panel ${items.length === 0 ? "workflow-attention-panel--empty" : ""}`}>
      <SectionTitle
        eyebrow="Needs attention"
        title="Approvals, blockers, and warnings"
        meta={<span className={`badge ${items.some((item) => item.tone === "danger") ? "badge-incompatible" : "badge-exact"}`}>{items.length}</span>}
      />
      {items.length === 0 ? (
        <p className="workflow-attention-panel__empty">No approvals, blockers, or credential requests pending.</p>
      ) : (
        <div className="workflow-attention-list">
          {visibleItems.map((item) => {
            const approval = item.approval;
            const manualHandoff = item.manualHandoff;
            const detailsExpanded = expandedItemId === item.id;
            return (
              <div key={item.id} className={`workflow-attention-item workflow-attention-item--${item.tone}`}>
                <div className="workflow-attention-item__copy">
                  <div className="candidate-card__title-row">
                    <strong>{item.title}</strong>
                    <span className="badge">{workflowAttentionKindLabel(item.kind)}</span>
                  </div>
                  <p>{item.detail}</p>
                  {item.createdAt ? <span>Requested {formatDateTime(item.createdAt)}</span> : null}
                </div>
                {approval ? (
                  <div className="workflow-attention-item__actions">
                    <button className="primary-button" onClick={() => onApprove(approval)} type="button">Accept</button>
                    <button className="secondary-button" onClick={() => onReject(approval)} type="button">Reject</button>
                  </div>
                ) : item.target === "credentials" ? (
                  <button className="secondary-button" onClick={onOpenCredentials} type="button">Open credentials</button>
                ) : item.target ? (
                  <button className="secondary-button" onClick={() => toggleDetails(item)} type="button">
                    {detailsExpanded ? "Hide details" : "View details"}
                  </button>
                ) : null}
                {detailsExpanded && manualHandoff ? (
                  <div className="workflow-attention-item__details">
                    <div className="workflow-manual-handoff__grid">
                      <div className="workflow-manual-handoff__section">
                        <span className="workflow-option__label">What failed</span>
                        <p>{manualHandoff.validationIssue}</p>
                      </div>
                      <div className="workflow-manual-handoff__section">
                        <span className="workflow-option__label">Latest failure reason</span>
                        <p>{manualHandoff.latestFailureReason}</p>
                      </div>
                    </div>
                    {manualHandoff.involvedPaths.length ? (
                      <div className="workflow-goal-panel__criteria">
                        <span className="workflow-option__label">Conflict paths</span>
                        <div className="tag-row">
                          {manualHandoff.involvedPaths.map((involvedPath) => (
                            <span key={involvedPath} className="tag">{involvedPath}</span>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    <div className="actions-row">
                      <button className="primary-button" onClick={onRetryManualHandoff} type="button">
                        {manualHandoff.reason === "merge_conflicts" ? "Retry merge" : "Retry current goal"}
                      </button>
                      <button
                        className="secondary-button"
                        disabled={shellLaunchBusy || !manualHandoff.shellSupported}
                        onClick={onOpenProjectShell}
                        type="button"
                      >
                        {shellLaunchBusy ? "Opening terminal..." : "Open Codex terminal"}
                      </button>
                      <button
                        className="secondary-button"
                        disabled={!repairReportAvailable}
                        onClick={onDownloadRepairReport}
                        type="button"
                      >
                        Download repair report
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
          {hiddenCount > 0 ? <p className="agent-card__subtle">{hiddenCount} more attention item{hiddenCount === 1 ? "" : "s"} hidden from this summary.</p> : null}
        </div>
      )}
    </article>
  );
};

const WorkflowStaleRecoveryPanel = ({
  recoveryCandidate,
  onContinue,
  onClearLock
}: {
  recoveryCandidate?: ReturnType<typeof getWorkflowRecoveryCandidate>;
  onContinue: () => void;
  onClearLock: () => void;
}) => (
  <article className="workflow-attention-panel workflow-attention-panel--danger">
    <SectionTitle
      eyebrow="Recovery"
      title="Previous run is detached"
      meta={<span className="badge badge-incompatible">Needs recovery</span>}
    />
    <p>
      Previous run was marked as running, but no active agent process is attached. You can continue from the saved state or clear the stale running lock.
    </p>
    {recoveryCandidate?.agent ? (
      <div className="lane-note">
        <strong>{recoveryCandidate.agent.name}</strong>
        <span>{recoveryCandidate.agent.disconnectedReason ?? recoveryCandidate.agent.currentPhase ?? "Saved agent state is recoverable."}</span>
      </div>
    ) : null}
    <div className="actions-row">
      <button className="primary-button" type="button" onClick={onContinue}>Continue from saved state</button>
      <button className="secondary-button" type="button" onClick={onClearLock}>Clear stale running lock</button>
      <button className="secondary-button" type="button" disabled title="No safe checkpoint rollback is available for this saved state.">
        Rollback unavailable
      </button>
    </div>
  </article>
);

const operatorStatusTone = (status: string): StatusChipTone => {
  if (status === "passed") {
    return "success";
  }
  if (status === "failed") {
    return "error";
  }
  if (status === "partial" || status === "warning") {
    return "warning";
  }
  if (status === "running") {
    return "running";
  }
  return "pending";
};

const operatorGroupTone = (group: OperatorChangedFileGroup): "warning" | "danger" | undefined =>
  group.kind === "suspicious" ? "danger" : group.kind === "generated" ? "warning" : undefined;

const OperatorMiniList = ({
  label,
  items,
  empty,
  limit = 8,
  tone
}: {
  label: string;
  items: string[];
  empty: string;
  limit?: number;
  tone?: "warning" | "danger";
}) => {
  const visible = items.slice(0, limit);
  return (
    <div className={`operator-mini-list ${tone ? `operator-mini-list--${tone}` : ""}`}>
      <span className="workflow-option__label">{label}</span>
      {visible.length ? (
        <div className="tag-row">
          {visible.map((item) => <span key={`${label}:${item}`} className="tag">{redactSensitiveText(item)}</span>)}
          {items.length > visible.length ? <span className="tag">+{items.length - visible.length} more</span> : null}
        </div>
      ) : <p>{empty}</p>}
    </div>
  );
};

const OperatorRawDetails = ({
  title,
  value
}: {
  title: string;
  value: unknown;
}) => (
  <details className="workflow-inline-details">
    <summary>{title}</summary>
    <pre className="long-text-block">{typeof value === "string" ? redactSensitiveText(value) : JSON.stringify(value, null, 2)}</pre>
  </details>
);

const OperatorChangedFiles = ({
  groups,
  empty = "No changed files are recorded for this cycle."
}: {
  groups: OperatorChangedFileGroup[];
  empty?: string;
}) => (
  <div className="operator-changed-files">
    {groups.length ? groups.map((group) => (
      <OperatorMiniList
        key={group.kind}
        label={group.label}
        items={group.files.map((file) => {
          const reason = suspiciousPathReason(file);
          return reason ? `${file} - ${reason}` : file;
        })}
        empty="None"
        limit={10}
        tone={operatorGroupTone(group)}
      />
    )) : <p>{empty}</p>}
  </div>
);

const OperatorCommandDisclosure = ({
  command,
  result,
  label = "Command"
}: {
  command: string;
  result?: NonNullable<OperatorWorkflowViewModel["currentCycle"]["validationLedger"]>["commandResults"][number];
  label?: string;
}) => (
  <details className={`operator-command ${result?.status && result.status !== "passed" ? "operator-command--failed" : ""}`}>
    <summary>
      <span>{label}</span>
      <code>{redactSensitiveText(command)}</code>
      {result ? <StatusChip label={result.status} tone={result.status === "passed" ? "success" : result.status === "skipped" ? "warning" : "error"} /> : <span className="badge">planned</span>}
    </summary>
    <div className="operator-command__body">
      <CopyButton value={command} label="Copy command" />
      <div className="workflow-now-card__grid">
        <div>
          <span>Exit status</span>
          <strong>{result?.exitCode ?? "Not run"}</strong>
        </div>
        <div>
          <span>Phase</span>
          <strong>{result?.phase ?? "Planned"}</strong>
        </div>
        <div>
          <span>Failure class</span>
          <strong>{result?.classifiedFailure?.kind?.replace(/_/g, " ") ?? "None"}</strong>
        </div>
      </div>
      {result?.classifiedFailure ? <p>{result.classifiedFailure.summary}</p> : null}
      {result?.stdoutSummary ? <pre className="long-text-block">{redactSensitiveText(result.stdoutSummary)}</pre> : null}
      {result?.stderrSummary ? <pre className="long-text-block">{redactSensitiveText(result.stderrSummary)}</pre> : null}
      {result?.fullOutputRef ? <p>Full output ref: {result.fullOutputRef}</p> : null}
    </div>
  </details>
);

const OperatorScoreBreakdown = ({
  scores
}: {
  scores: OperatorWorkflowViewModel["planner"]["scoreBreakdown"];
}) => (
  <div className="operator-score-grid">
    {scores.length ? scores.map((score) => (
      <div key={score.key} className={score.value < 0 ? "operator-score-grid__item operator-score-grid__item--negative" : "operator-score-grid__item"}>
        <span>{score.label}</span>
        <strong>{score.value}</strong>
      </div>
    )) : <p>No planner score breakdown was recorded.</p>}
  </div>
);

const WorkflowValidationLedgerCard = ({
  view
}: {
  view: OperatorWorkflowViewModel;
}) => {
  const ledger = view.currentCycle.validationLedger;
  const summary = view.currentCycle.validationSummary;
  return (
    <article className="workflow-checklist-card operator-validation-card">
      <SectionTitle
        eyebrow="Validation ledger"
        title="Failed attempts, repairs, and final status"
        meta={<StatusChip label={summary.finalStatusLabel} tone={operatorStatusTone(summary.finalStatus)} />}
      />
      <div className="workflow-checklist-card__stats">
        <div>
          <span>Planned</span>
          <strong>{summary.planned.length}</strong>
        </div>
        <div>
          <span>Attempted</span>
          <strong>{summary.attempted.length}</strong>
        </div>
        <div>
          <span>Failed attempts</span>
          <strong>{summary.failedAttempts}</strong>
        </div>
        <div>
          <span>Repaired</span>
          <strong>{summary.repaired.length}</strong>
        </div>
        <div>
          <span>Final</span>
          <strong>{summary.finalStatusLabel}</strong>
        </div>
        <div>
          <span>Merge</span>
          <strong>{summary.mergeAllowed ? "Allowed" : "Blocked"}</strong>
        </div>
      </div>
      {view.emptyStates.validationLedger ? <p>{view.emptyStates.validationLedger}</p> : <p>{ledger?.summaryForHumans}</p>}
      <div className="operator-command-list">
        {ledger?.commandResults.length ? ledger.commandResults.map((result) => (
          <OperatorCommandDisclosure key={result.commandId} command={result.command} result={result} label={result.phase} />
        )) : summary.planned.map((command) => (
          <OperatorCommandDisclosure key={command} command={command} />
        ))}
      </div>
      <OperatorMiniList label="Repaired failures" items={summary.repaired} empty="No failed validation attempts were repaired yet." />
      <OperatorMiniList label="Merge blocked reasons" items={summary.mergeBlockedReasons} empty="No merge-blocking validation reasons recorded." tone={summary.mergeBlockedReasons.length ? "danger" : undefined} />
      <OperatorMiniList label="Validation warnings" items={summary.warnings} empty="No validation warnings recorded." tone={summary.warnings.length ? "warning" : undefined} />
      <OperatorRawDetails title="Raw validation ledger" value={ledger ?? view.emptyStates.validationLedger ?? "No validation ledger recorded."} />
    </article>
  );
};

const WorkflowChecklistProgressCard = ({
  view
}: {
  view: OperatorWorkflowViewModel;
}) => {
  const delta = view.currentCycle.checklistDeltaSummary;
  return (
    <article className="workflow-checklist-card operator-checklist-card">
      <SectionTitle
        eyebrow="Checklist progress this cycle"
        title="Evidence reconciliation"
        meta={<span className="badge">{delta.newlyMet.length} newly met</span>}
      />
      <div className="workflow-checklist-card__stats">
        <div>
          <span>Newly met</span>
          <strong>{delta.newlyMet.length}</strong>
        </div>
        <div>
          <span>Still unknown</span>
          <strong>{delta.stillUnknown.length}</strong>
        </div>
        <div>
          <span>Needs attention</span>
          <strong>{delta.needsAttention.length}</strong>
        </div>
        <div>
          <span>Evidence observed</span>
          <strong>{delta.evidenceObserved}</strong>
        </div>
        <div>
          <span>Consumed</span>
          <strong>{delta.evidenceConsumed}</strong>
        </div>
        <div>
          <span>Not consumed</span>
          <strong>{delta.evidenceNotConsumed}</strong>
        </div>
      </div>
      <p>{delta.summary}</p>
      {delta.emptyReason ? <div className="notice notice--compact">{delta.emptyReason}</div> : null}
      <OperatorMiniList label="Newly met check IDs" items={delta.newlyMet} empty="No targeted checks became met in this cycle yet." />
      <OperatorMiniList label="Still unknown check IDs" items={delta.stillUnknown} empty="No targeted checks remain unknown." tone={delta.stillUnknown.length ? "warning" : undefined} />
      <OperatorMiniList label="Needs attention check IDs" items={delta.needsAttention} empty="No targeted checks are marked needs attention." tone={delta.needsAttention.length ? "danger" : undefined} />
      <OperatorMiniList label="Evidence not consumed" items={delta.evidenceNotConsumedReasons} empty="No unconsumed evidence reasons recorded." tone={delta.evidenceNotConsumedReasons.length ? "warning" : undefined} />
      <div className="operator-reason-list">
        {Object.entries(delta.whyStillUnknownByCheckId).length ? Object.entries(delta.whyStillUnknownByCheckId).map(([checkId, reason]) => (
          <div key={checkId} className="lane-note">
            <strong>{checkId}</strong>
            <span>{reason}</span>
          </div>
        )) : <p>No per-check unknown reasons have been recorded yet.</p>}
      </div>
      <OperatorRawDetails title="Raw checklist delta" value={view.currentCycle.checklistDelta ?? view.emptyStates.checklistDelta ?? "No checklist delta recorded."} />
      <OperatorRawDetails title="Evidence observation summary" value={view.currentCycle.checklistDelta ? {
        observed: view.currentCycle.checklistDelta.evidenceObservedCount,
        consumed: view.currentCycle.checklistDelta.evidenceConsumedCount,
        notConsumed: view.currentCycle.checklistDelta.evidenceNotConsumedCount,
        whyStillUnknownByCheckId: view.currentCycle.checklistDelta.whyStillUnknownByCheckId
      } : view.emptyStates.checklistDelta ?? "Evidence observations have not been reconciled for this cycle."} />
    </article>
  );
};

const WorkflowCycleContractCard = ({
  view
}: {
  view: OperatorWorkflowViewModel;
}) => {
  const contract = view.currentCycle.cycleContract;
  if (!contract) {
    return (
      <article className="workflow-plan-card operator-cycle-contract">
        <SectionTitle eyebrow="Cycle Contract" title="No contract recorded" />
        <p>{view.emptyStates.cycleContract ?? "No cycle contract has been recorded yet."}</p>
      </article>
    );
  }
  const validationResultsByCommand = new Map(
    (view.currentCycle.validationLedger?.commandResults ?? []).map((result) => [result.command, result])
  );
  return (
    <article className="workflow-plan-card operator-cycle-contract">
      <SectionTitle
        eyebrow="Cycle Contract"
        title="Goal of this cycle"
        meta={<span className="badge">Cycle {contract.cycleNumber}</span>}
      />
      <p className="workflow-plan-card__goal">
        Goal of this cycle: {contract.concreteGoalForThisCycle}
      </p>
      <div className="operator-contract-section">
        <span className="workflow-option__label">Plain English objective</span>
        <p>{contract.plainEnglishObjective}</p>
      </div>

      <div className="operator-contract-section">
        <div className="candidate-card__title-row">
          <span className="workflow-option__label">Targeted required checks</span>
          <span className="badge">{contract.targetedChecklistItems.length}</span>
        </div>
        <div className="operator-target-checks">
          {contract.targetedChecklistItems.length ? contract.targetedChecklistItems.map((item) => (
            <details key={item.checkId} className="operator-target-check" open>
              <summary>
                <span>{item.checkId}</span>
                <strong>{item.title}</strong>
                <StatusChip label={goalCheckStatusLabel(item.currentStatus)} tone={item.currentStatus === "met" ? "success" : item.currentStatus === "unmet" ? "error" : "warning"} />
              </summary>
              <p>{item.fullDescription}</p>
              <div className="workflow-now-card__grid">
                <div>
                  <span>Previous</span>
                  <strong>{goalCheckStatusLabel(item.previousStatus)}</strong>
                </div>
                <div>
                  <span>Current</span>
                  <strong>{goalCheckStatusLabel(item.currentStatus)}</strong>
                </div>
                <div>
                  <span>Evidence history</span>
                  <strong>{item.evidenceHistoryCount}</strong>
                </div>
              </div>
              <div className="operator-contract-subgrid">
                <div>
                  <span className="workflow-option__label">Why targeted</span>
                  <p>{item.whyTargeted}</p>
                </div>
                <div>
                  <span className="workflow-option__label">Expected evidence</span>
                  <p>{item.acceptanceHint}</p>
                </div>
                <div>
                  <span className="workflow-option__label">Previous evidence</span>
                  <p>{item.currentEvidence || "No previous evidence recorded."}</p>
                </div>
                <div>
                  <span className="workflow-option__label">Observable signals</span>
                  <div className="tag-row">
                    {item.observableSignalsExpected.map((signal) => <span key={`${item.checkId}:${signal}`} className="tag">{signal}</span>)}
                  </div>
                </div>
              </div>
              <CopyButton value={`${item.checkId}\n${item.title}\n${item.fullDescription}\nExpected evidence: ${item.acceptanceHint}`} label="Copy check" />
            </details>
          )) : <p>No targeted checklist items were recorded in the cycle contract.</p>}
        </div>
      </div>

      <div className="workflow-plan-card__grid">
        <div>
          <span className="workflow-option__label">Done when</span>
          <ul className="workflow-compact-list">
            {contract.doneWhen.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
        <div>
          <span className="workflow-option__label">Expected files/areas</span>
          <div className="tag-row">
            {contract.expectedFilesOrAreas.length ? contract.expectedFilesOrAreas.map((file) => (
              <span key={file} className="tag">{file}{view.currentCycle.changedFiles.includes(file) ? " · touched" : ""}</span>
            )) : <span className="tag">No expected files recorded</span>}
          </div>
        </div>
        <div>
          <span className="workflow-option__label">Expected validation commands</span>
          <div className="operator-command-list">
            {contract.expectedValidationCommands.length ? contract.expectedValidationCommands.map((command) => (
              <OperatorCommandDisclosure key={`validation:${command}`} command={command} result={validationResultsByCommand.get(command)} label="validation" />
            )) : <p>No validation commands were scoped for this cycle.</p>}
          </div>
        </div>
        <div>
          <span className="workflow-option__label">Expected evidence commands</span>
          <div className="operator-command-list">
            {contract.expectedEvidenceCommands.length ? contract.expectedEvidenceCommands.map((command) => (
              <OperatorCommandDisclosure key={`evidence:${command}`} command={command} result={validationResultsByCommand.get(command)} label="evidence" />
            )) : <p>{view.emptyStates.evidenceCommands ?? "No evidence commands discovered for this project."}</p>}
          </div>
        </div>
        <div className="workflow-plan-card__wide">
          <span className="workflow-option__label">Why selected now</span>
          <p>{contract.whySelectedNow}</p>
          <OperatorScoreBreakdown scores={view.planner.scoreBreakdown} />
          {view.planner.repeatedWorkWarning ? <div className="notice notice--compact">{view.planner.repeatedWorkWarning}</div> : null}
          {view.planner.fallbackWarning ? <div className="notice notice--compact">{view.planner.fallbackWarning}</div> : null}
        </div>
        <div>
          <span className="workflow-option__label">Prior similar attempts</span>
          {contract.priorSimilarAttempts.length ? contract.priorSimilarAttempts.map((attempt) => (
            <div key={`${attempt.cycleNumber}:${attempt.attemptedTaskTitle}`} className="lane-note">
              <strong>Cycle {attempt.cycleNumber}: {attempt.attemptedTaskTitle}</strong>
              <span>{attempt.validationSummary} · {attempt.checklistDeltaSummary}</span>
            </div>
          )) : <p>No prior similar attempts recorded.</p>}
        </div>
        <div>
          <span className="workflow-option__label">Failure modes</span>
          <ul className="workflow-compact-list">
            {contract.failureModes.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
      </div>

      <div className="operator-contract-section">
        <span className="workflow-option__label">Actual changed files by risk group</span>
        <OperatorChangedFiles groups={view.currentCycle.changedFilesSummary} />
      </div>

      <div className="operator-contract-section">
        <span className="workflow-option__label">Planner health</span>
        <div className="workflow-now-card__grid">
          <div>
            <span>Selected source</span>
            <strong>{contract.selectedTaskSource.replace(/_/g, " ")}</strong>
          </div>
          <div>
            <span>Structured failures</span>
            <strong>{view.currentCycle.recommendationHealth?.consecutiveStructuredFailures ?? 0}</strong>
          </div>
          <div>
            <span>Fallback</span>
            <strong>{view.currentCycle.recommendationHealth?.fallbackUsedForCurrentRecommendation ? "Used" : "Not used"}</strong>
          </div>
        </div>
      </div>

      <div className="operator-raw-grid">
        <OperatorRawDetails title="Full cycle contract JSON" value={contract} />
        <OperatorRawDetails title="Raw recommendation health" value={view.currentCycle.recommendationHealth ?? view.emptyStates.recommendationHealth ?? "No recommendation health recorded."} />
        <OperatorRawDetails title="Raw agent messages" value={view.currentCycle.currentAgentMessages.length ? view.currentCycle.currentAgentMessages : "No current agent messages captured."} />
      </div>
    </article>
  );
};

const WorkflowStatusStrip = ({
  items
}: {
  items: Array<{ label: string; value: string; tone?: "normal" | "warning" | "success" }>;
}) => (
  <section className="workflow-status-strip" aria-label="Workflow status">
    {items.map((item) => (
      <div key={item.label} className={`workflow-status-strip__item workflow-status-strip__item--${item.tone ?? "normal"}`}>
        <span>{item.label}</span>
        <strong>{item.value}</strong>
      </div>
    ))}
  </section>
);

const WorkflowAutopilotPanel = ({
  autopilotEnabled,
  autopilotProfile,
  autopilotPolicy,
  autopilotPausedReason,
  highRiskPackageRequiresApproval,
  currentRecommendationTitle,
  lastCompletedAction,
  objectiveLabel,
  nextAction,
  workflowPauseRequested,
  workflowHasActiveAgent,
  recoveryAvailable,
  optimizeModeEnabled,
  workflowMode,
  previewStatus,
  previewDisabledReason,
  commandBusy,
  onToggleAutopilot,
  onProfileChange,
  onPolicyChange,
  onToggleOptimizeMode,
  onToggleWorkflowMode,
  onRequestPreview,
  onCancelPreview,
  onCompletePreview,
  onContinueWorkflow,
  continueActionLabel,
  canContinueWorkflow,
  continueDisabledReason
}: {
  autopilotEnabled: boolean;
  autopilotProfile: AutopilotProfile;
  autopilotPolicy?: AutopilotPolicy;
  autopilotPausedReason?: NonNullable<ProjectWorkflowState["autopilotStatus"]>["pausedReason"];
  highRiskPackageRequiresApproval: boolean;
  currentRecommendationTitle?: string;
  lastCompletedAction?: string;
  objectiveLabel: string;
  nextAction: string;
  workflowPauseRequested: boolean;
  workflowHasActiveAgent: boolean;
  recoveryAvailable: boolean;
  optimizeModeEnabled: boolean;
  workflowMode: ProjectWorkflowState["workflowMode"];
  previewStatus: NonNullable<ProjectWorkflowState["previewRequest"]>["status"];
  previewDisabledReason?: string;
  commandBusy: boolean;
  onToggleAutopilot: () => void;
  onProfileChange: (profile: AutopilotProfile) => void;
  onPolicyChange: (patch: Partial<AutopilotPolicy>) => void;
  onToggleOptimizeMode: () => void;
  onToggleWorkflowMode: () => void;
  onRequestPreview: () => void;
  onCancelPreview: () => void;
  onCompletePreview: () => void;
  onContinueWorkflow: () => void;
  continueActionLabel: string;
  canContinueWorkflow: boolean;
  continueDisabledReason?: string;
}) => {
  const policy = autopilotPolicy;
  const previewCanRequest = previewStatus === "none" || previewStatus === "completed" || previewStatus === "cancelled";
  const previewCanCancel = previewStatus === "queued";
  const previewCanComplete = previewStatus === "ready";
  const canContinue = !commandBusy && (canContinueWorkflow || workflowPauseRequested || previewCanComplete || recoveryAvailable || Boolean(autopilotPausedReason));
  const numberPatch = (key: "maxChecksPerWorkPackageNormal" | "maxChecksPerWorkPackageFast" | "maxNewRequiredChecksPerCycle", value: string) => {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      onPolicyChange({ profile: "custom", [key]: parsed });
    }
  };

  return (
    <article className="workflow-autopilot-compact">
      <SectionTitle eyebrow="Workflow controls" title="Fast Mode, preview, and Autopilot" meta={<span className={`badge ${autopilotEnabled ? "badge-exact" : ""}`}>{autopilotEnabled ? "Autopilot on" : "Autopilot off"}</span>} />
      <div className="workflow-autopilot-compact__grid">
        <div>
          <span>Objective</span>
          <strong>{objectiveLabel}</strong>
        </div>
        <div>
          <span>Workflow mode</span>
          <strong>{workflowModeLabel(workflowMode)}</strong>
        </div>
        <label>
          <span>Profile</span>
          <select className="input" value={autopilotProfile} onChange={(event) => onProfileChange(event.target.value as AutopilotProfile)}>
            <option value="balanced">Balanced</option>
            <option value="conservative">Conservative</option>
            <option value="aggressive">Aggressive</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        <div>
          <span>Preview</span>
          <strong>{previewStatusLabel(previewStatus)}</strong>
        </div>
        <div>
          <span>Current package</span>
          <strong>{currentRecommendationTitle ?? "No package selected"}</strong>
        </div>
        <div>
          <span>Next planned action</span>
          <strong>{nextAction}</strong>
        </div>
        <div>
          <span>Last action</span>
          <strong>{lastCompletedAction ? lastCompletedAction.replace(/_/g, " ") : "None"}</strong>
        </div>
        <div>
          <span>Pause state</span>
          <strong>{workflowPauseRequested ? (workflowHasActiveAgent ? "Pause pending" : "Paused") : autopilotPauseReasonLabel(autopilotPausedReason)}</strong>
        </div>
        <div>
          <span>Checkpoint</span>
          <strong>{highRiskPackageRequiresApproval ? "High-risk approval needed" : "Policy clear"}</strong>
        </div>
      </div>
      {previewStatus === "ready" ? (
        <div className="workflow-preview-callout">
          <strong>Preview is ready for inspection</strong>
          <span>Resume workflow when the checkpoint has been reviewed.</span>
        </div>
      ) : previewDisabledReason ? (
        <div className="workflow-preview-callout workflow-preview-callout--muted">
          <strong>Preview unavailable</strong>
          <span>{previewDisabledReason}</span>
        </div>
      ) : null}
      <div className="actions-row workflow-control-button-row">
        <button className={autopilotEnabled ? "primary-button" : "secondary-button"} onClick={onToggleAutopilot} type="button">
          Turn autopilot {autopilotEnabled ? "off" : "on"}
        </button>
        <button className={workflowMode === "fast" ? "primary-button" : "secondary-button"} onClick={onToggleWorkflowMode} type="button">
          {workflowMode === "fast" ? "Switch to Normal Mode" : "Switch to Fast Mode"}
        </button>
        <button className="secondary-button" disabled={commandBusy || !previewCanRequest || Boolean(previewDisabledReason)} onClick={onRequestPreview} type="button">
          {previewButtonLabel(previewStatus)}
        </button>
        {previewCanCancel ? (
          <button className="secondary-button" disabled={commandBusy} onClick={onCancelPreview} type="button">
            Cancel Preview
          </button>
        ) : null}
        {previewCanComplete ? (
          <button className="primary-button" disabled={commandBusy} onClick={onCompletePreview} type="button">
            Resume Workflow
          </button>
        ) : null}
        <button className={optimizeModeEnabled ? "primary-button" : "secondary-button"} onClick={onToggleOptimizeMode} type="button">
          {optimizeModeEnabled ? "Stop optimizing" : "Optimize"}
        </button>
        <button className="secondary-button" disabled={!canContinue} onClick={onContinueWorkflow} title={!canContinue ? continueDisabledReason : undefined} type="button">
          {continueActionLabel}
        </button>
      </div>
      <details className="workflow-autopilot-settings">
        <summary>
          <span>Autopilot settings</span>
          <span className="badge">{autopilotProfileLabel(autopilotProfile)}</span>
        </summary>
        <div className="workflow-autopilot-settings__grid">
          <label className="checkbox-field">
            <input
              checked={policy?.preferGroupedChecklistPackages ?? true}
              type="checkbox"
              onChange={(event) => onPolicyChange({ profile: "custom", preferGroupedChecklistPackages: event.target.checked })}
            />
            <span>Prefer grouped checklist packages</span>
          </label>
          <label className="form-field">
            <span>Max checks per package in normal mode</span>
            <input
              className="input"
              max={8}
              min={1}
              type="number"
              value={policy?.maxChecksPerWorkPackageNormal ?? 4}
              onChange={(event) => numberPatch("maxChecksPerWorkPackageNormal", event.target.value)}
            />
          </label>
          <label className="form-field">
            <span>Max checks per package in fast mode</span>
            <input
              className="input"
              max={12}
              min={1}
              type="number"
              value={policy?.maxChecksPerWorkPackageFast ?? 8}
              onChange={(event) => numberPatch("maxChecksPerWorkPackageFast", event.target.value)}
            />
          </label>
          <label className="checkbox-field">
            <input
              checked={policy?.pauseOnPreviewReady ?? true}
              type="checkbox"
              onChange={(event) => onPolicyChange({ profile: "custom", pauseOnPreviewReady: event.target.checked })}
            />
            <span>Pause on preview ready</span>
          </label>
          <label className="checkbox-field">
            <input
              checked={policy?.pauseOnApprovalRequired ?? true}
              type="checkbox"
              onChange={(event) => onPolicyChange({ profile: "custom", pauseOnApprovalRequired: event.target.checked })}
            />
            <span>Pause on required approval</span>
          </label>
          <label className="checkbox-field">
            <input
              checked={policy?.requireExplicitApprovalForHighRiskPackages ?? true}
              type="checkbox"
              onChange={(event) => onPolicyChange({ profile: "custom", requireExplicitApprovalForHighRiskPackages: event.target.checked })}
            />
            <span>Pause on high-risk work</span>
          </label>
          <label className="form-field">
            <span>Max new required checks per cycle</span>
            <input
              className="input"
              max={5}
              min={0}
              type="number"
              value={policy?.maxNewRequiredChecksPerCycle ?? 2}
              onChange={(event) => numberPatch("maxNewRequiredChecksPerCycle", event.target.value)}
            />
          </label>
          <label className="checkbox-field">
            <input
              checked={policy?.allowDeterministicScoping ?? true}
              type="checkbox"
              onChange={(event) => onPolicyChange({ profile: "custom", allowDeterministicScoping: event.target.checked })}
            />
            <span>Allow deterministic scoped goals</span>
          </label>
          <label className="checkbox-field">
            <input
              checked={policy?.stopWhenNoSafeRecommendation ?? true}
              type="checkbox"
              onChange={(event) => onPolicyChange({ profile: "custom", stopWhenNoSafeRecommendation: event.target.checked })}
            />
            <span>Stop when no safe recommendation exists</span>
          </label>
        </div>
      </details>
    </article>
  );
};

const WorkflowContextCards = ({
  selections
}: {
  selections: ProjectWorkflowState["memory"]["lastRelevantContext"];
}) => (
  <article className="workflow-context-panel">
    <SectionTitle eyebrow="Prior context" title="Relevant history" meta={<span className="badge">{selections.length}</span>} />
    {selections.length ? (
      <div className="workflow-context-list">
        {selections.slice(0, 5).map((selection) => (
          <article key={selection.descriptorId} className="workflow-context-card">
            <div className="candidate-card__title-row">
              <strong>Cycle {selection.cycleNumber}</strong>
              <span className="badge">{agentCategoryLabel(selection.agentCategory)}</span>
            </div>
            <p>{summarizeText(selection.summary, "No summary available.", 145)}</p>
            <div className="workflow-step-card__meta">
              <span>{selection.paths.length} changed/related files</span>
              <span>{selection.reasons[0] ? summarizeText(selection.reasons[0], "Context selected by relevance.", 90) : "Selected by relevance"}</span>
            </div>
            <details className="workflow-inline-details workflow-inline-details--compact">
              <summary>View details</summary>
              {selection.paths.length ? <p>Files: {selection.paths.join(", ")}</p> : null}
              {selection.reasons.length ? <p>Why it matters: {selection.reasons.join("; ")}</p> : null}
              {selection.decisionIds.length ? <p>Decisions: {selection.decisionIds.join(", ")}</p> : null}
              {selection.issueIds.length ? <p>Issues: {selection.issueIds.join(", ")}</p> : null}
            </details>
          </article>
        ))}
      </div>
    ) : (
      <p className="workflow-attention-panel__empty">Relevant prior context will appear after workflow memory has enough history.</p>
    )}
  </article>
);

const WorkflowActivityMiniFeed = ({
  events
}: {
  events: WorkflowActivityEvent[];
}) => (
  <article className="workflow-activity-mini">
    <SectionTitle eyebrow="Recent activity" title="Workflow feed" meta={<span className="badge">{events.length}</span>} />
    {events.length ? (
      <div className="workflow-activity-mini__list">
        {events.slice(0, 8).map((event) => (
          <div key={event.id} className="workflow-activity-mini__row">
            <span>{formatClockTime(event.timestamp)}</span>
            <strong>{workflowActivitySourceLabel(event.source)}</strong>
            <p>{event.title}{event.detail ? ` - ${summarizeText(event.detail, "", 120)}` : ""}</p>
            <span className={`badge workflow-transcript__badge workflow-transcript__badge--${event.status}`}>{workflowEventStatusLabel(event.status)}</span>
          </div>
        ))}
      </div>
    ) : (
      <p className="workflow-attention-panel__empty">Workflow activity will appear once work starts.</p>
    )}
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
                  <StatusChip {...agentLifecycleStatusChip(agent.status)} />
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

const RuntimeReadinessPanel = ({
  report,
  onRunChecks,
  onOpenSettings,
  busy = false,
  compact = false
}: {
  report: RuntimeReadinessReport;
  onRunChecks: () => void;
  onOpenSettings?: () => void;
  busy?: boolean;
  compact?: boolean;
}) => {
  const statusChip = runtimeReadinessStatusChip(report);
  const failedOrCheckingCommands = report.checks
    .filter((check) => check.manualCommand && (check.status === "failed" || check.status === "checking"))
    .map((check) => check.manualCommand as string);

  return (
    <section className={`runtime-readiness-panel ${report.blockAgentActions ? "runtime-readiness-panel--blocked" : "runtime-readiness-panel--ready"} ${compact ? "runtime-readiness-panel--compact" : ""}`}>
      <div className="candidate-card__title-row">
        <strong>Runtime readiness</strong>
        <StatusChip {...statusChip} />
      </div>
      <p>{report.summary}</p>
      {report.checkedAt ? <div className="agent-card__subtle">Last checked {formatDateTime(report.checkedAt)}</div> : null}
      <div className="runtime-readiness-grid">
        {report.checks.map((check) => {
          const checkChip = runtimeDependencyStatusChip(check.status);
          return (
            <div key={check.id} className={`runtime-readiness-check runtime-readiness-check--${check.status}`}>
              <div className="candidate-card__title-row">
                <strong>{check.label}</strong>
                <StatusChip {...checkChip} />
              </div>
              <p>{check.message}</p>
              {check.fixInApp && check.status !== "passed" ? <div className="lane-note"><strong>App fix</strong><span>{check.fixInApp}</span></div> : null}
              {!compact && check.manualCommand && check.status !== "passed" ? (
                <pre className="runtime-readiness-command"><code>{check.manualCommand}</code></pre>
              ) : null}
            </div>
          );
        })}
      </div>
      {failedOrCheckingCommands.length > 0 && compact ? (
        <pre className="runtime-readiness-command runtime-readiness-command--summary"><code>{failedOrCheckingCommands[0]}</code></pre>
      ) : null}
      <div className="actions-row">
        <button className="primary-button" disabled={busy || report.status === "checking"} onClick={onRunChecks}>
          {busy || report.status === "checking" ? "Checking..." : "Run Readiness Checks"}
        </button>
        {onOpenSettings ? <button className="secondary-button" onClick={onOpenSettings}>Open Settings</button> : null}
      </div>
    </section>
  );
};

const CodexReadinessPanel = ({
  state,
  busy,
  onRefreshReadiness,
  onCheckUpdate,
  onRunUpdate
}: {
  state: WorkbenchState;
  busy: boolean;
  onRefreshReadiness: () => void;
  onCheckUpdate: () => void;
  onRunUpdate: (approvedCommand: string) => void;
}) => {
  const report = state.codexReadiness;
  const update = state.codexUpdate;
  const statusChip = codexReadinessStatusChip(report.status);
  const updateCommand = update?.updateCommand ?? report.updateCommand;
  const updateAvailable = update?.updateAvailable ?? report.updateAvailable;
  const warnings = report.warnings ?? [];
  const errors = report.errors ?? [];
  const approveUpdate = () => {
    if (!updateCommand) {
      return;
    }
    const approved = window.confirm(`Update Codex CLI by running this command?\n\n${updateCommand}`);
    if (approved) {
      onRunUpdate(updateCommand);
    }
  };

  return (
    <section className="runtime-readiness-panel codex-readiness-panel">
      <div className="candidate-card__title-row">
        <strong>Codex readiness</strong>
        <StatusChip {...statusChip} />
      </div>
      <p>{update?.message ?? report.message}</p>
      <div className="repository-coverage-grid">
        <div>
          <span>Codex CLI</span>
          <strong>{report.codexVersion ?? update?.currentVersion ?? "Not detected"}</strong>
        </div>
        <div>
          <span>Latest available</span>
          <strong>{report.latestCodexVersion ?? update?.latestVersion ?? "Unknown"}</strong>
        </div>
        <div>
          <span>CLI exists</span>
          <strong>{report.codexCliExists === undefined ? "Unknown" : report.codexCliExists ? "Yes" : "No"}</strong>
        </div>
        <div>
          <span>Execution mode</span>
          <strong>{report.executionMode}</strong>
        </div>
        <div>
          <span>WSL distro</span>
          <strong>{report.distroName || "Not used"}</strong>
        </div>
        <div>
          <span>Codex path</span>
          <strong>{report.codexPath ?? report.codexBinaryPath}</strong>
        </div>
        <div>
          <span>Node path</span>
          <strong>{report.nodePath ?? "Not detected"}</strong>
        </div>
      </div>
      {report.checkedAt ? <div className="agent-card__subtle">Last checked {formatDateTime(report.checkedAt)}</div> : null}
      {warnings.length > 0 ? (
        <div className="notice">
          {warnings.map((warning) => <div key={warning}>{warning}</div>)}
        </div>
      ) : null}
      {errors.length > 0 ? (
        <div className="notice notice--error">
          {errors.map((error) => <div key={error}>{error}</div>)}
        </div>
      ) : null}
      {updateCommand ? (
        <div className="lane-note">
          <strong>Update command preview</strong>
          <span><code>{updateCommand}</code></span>
        </div>
      ) : null}
      <div className="actions-row">
        <button className="secondary-button" type="button" disabled={busy || report.status === "checking"} onClick={onRefreshReadiness}>
          {report.status === "checking" ? "Refreshing..." : "Refresh Codex Readiness"}
        </button>
        <button className="secondary-button" type="button" disabled={busy || report.status === "checking"} onClick={onCheckUpdate}>
          {busy ? "Checking..." : "Check Codex Update"}
        </button>
        <button className="primary-button" type="button" disabled={busy || !updateAvailable || !updateCommand} onClick={approveUpdate}>
          {busy ? "Updating..." : "Update Codex CLI"}
        </button>
      </div>
    </section>
  );
};

const GoalCharterOverviewCard = ({
  workflow,
  presets,
  onEditStrategy,
  onOpenWorkflow,
  onDetectGoal,
  onAcceptDetectedGoal,
  onRejectDetectedGoal,
  onAcceptGoalProposal,
  onRejectGoalProposal
}: {
  workflow?: ProjectWorkflowState;
  presets: AutopilotPreset[];
  onEditStrategy: () => void;
  onOpenWorkflow: () => void;
  onDetectGoal: () => void;
  onAcceptDetectedGoal: () => void;
  onRejectDetectedGoal: () => void;
  onAcceptGoalProposal: (proposalId: string) => void;
  onRejectGoalProposal: (proposalId: string) => void;
}) => {
  const charter = workflow?.goalCharter;
  const originalGoal = charter?.originalUltimateGoal;
  const currentGoal = charter?.currentEffectiveGoal?.summary ? charter.currentEffectiveGoal : workflow?.ultimateGoal;
  const strategy = charter?.autopilotStrategy ?? createDefaultAutopilotStrategy();
  const pendingProposal = charter?.proposedGoalChanges[0];
  const hasAcceptedGoal = Boolean(currentGoal?.confirmedAt || charter?.currentEffectiveGoal.confirmedAt);
  return (
    <article className="goal-charter-card">
      <SectionTitle eyebrow="Goal Charter" title="Baseline and effective goal" meta={<span className="badge">{strategyPresetLabel(strategy, presets)}</span>} />
      <div className="goal-charter-card__goals">
        <div>
          <span>Original Ultimate Goal</span>
          <strong>{summarizeText(originalGoal?.summary, "No accepted original goal yet.", 180)}</strong>
        </div>
        <div>
          <span>Current Effective Goal</span>
          <strong>{summarizeText(currentGoal?.summary, "No effective goal accepted yet.", 180)}</strong>
        </div>
      </div>
      <div className="goal-charter-card__strategy">
        <div>
          <span>Goal fidelity</span>
          <strong>{strategy.goalRestrictiveness} · {goalRestrictivenessLabel(strategy.goalRestrictiveness)}</strong>
        </div>
        <div>
          <span>Planning</span>
          <strong>{enumLabel(strategy.planningHorizon)} horizon · {enumLabel(strategy.taskBatchingAggressiveness)} batching</strong>
        </div>
        <div>
          <span>Validation</span>
          <strong>{enumLabel(strategy.validationStrictness)} · {enumLabel(strategy.approvalSensitivity)} approvals</strong>
        </div>
      </div>
      <div className="goal-charter-card__lists">
        <div>
          <span>Non-negotiable</span>
          <p>{summarizeText(charter?.nonNegotiableRequirements.slice(0, 3).join("; "), "Not specified.", 180)}</p>
        </div>
        <div>
          <span>Definition of done</span>
          <p>{summarizeText(charter?.definitionOfDone.slice(0, 3).join("; "), "Not specified.", 180)}</p>
        </div>
      </div>
      {pendingProposal ? (
        <div className="goal-charter-card__proposal">
          <strong>Goal proposal awaiting approval</strong>
          <span>{summarizeText(pendingProposal.summary || pendingProposal.toGoalSummary, "A proposed goal change is ready.", 180)}</span>
          <div className="actions-row">
            <button className="primary-button" type="button" onClick={() => onAcceptGoalProposal(pendingProposal.id)}>Accept proposal</button>
            <button className="secondary-button" type="button" onClick={() => onRejectGoalProposal(pendingProposal.id)}>Reject proposal</button>
          </div>
        </div>
      ) : null}
      <div className="actions-row">
        <button className="secondary-button" type="button" onClick={onEditStrategy}>Edit Strategy</button>
        <button className="secondary-button" type="button" onClick={onOpenWorkflow}>Edit Goal</button>
        {!hasAcceptedGoal ? (
          <button className="secondary-button" type="button" onClick={onDetectGoal}>Auto-detect Ultimate Goal</button>
        ) : null}
        {workflow?.ultimateGoalDraft ? (
          <>
            <button className="primary-button" type="button" onClick={onAcceptDetectedGoal}>Accept detected goal</button>
            <button className="secondary-button" type="button" onClick={onRejectDetectedGoal}>Reject detected goal</button>
          </>
        ) : null}
      </div>
    </article>
  );
};

const WandIcon = () => (
  <svg className="button-icon" aria-hidden="true" viewBox="0 0 24 24" focusable="false">
    <path d="M15 4l1.1 2.4L18.5 7.5l-2.4 1.1L15 11l-1.1-2.4-2.4-1.1 2.4-1.1L15 4z" />
    <path d="M6 14l1.1 2.4 2.4 1.1-2.4 1.1L6 21l-1.1-2.4-2.4-1.1 2.4-1.1L6 14z" />
    <path d="M14.5 13.5l6 6" />
    <path d="M12.5 15.5l2-2" />
  </svg>
);

const GoalCharterDraftField = ({
  field,
  label,
  value,
  onChange,
  onPolish,
  busy,
  disabled = false,
  multiline = true
}: {
  field: GoalCharterDraftTextField;
  label: string;
  value: string;
  onChange: (value: string) => void;
  onPolish: (field: GoalCharterDraftTextField) => void;
  busy?: GoalCharterAiBusyState;
  disabled?: boolean;
  multiline?: boolean;
}) => {
  const polishBusy = busy?.kind === "polish" && busy.field === field;
  const polishDisabled = disabled || Boolean(busy) || !value.trim();
  return (
    <label className="form-field goal-charter-draft-field">
      <span className="goal-charter-draft-field__header">
        <span>{label}</span>
        <button
          className="secondary-button secondary-button--compact goal-charter-draft-field__polish"
          type="button"
          title={`Pollish ${label}`}
          onClick={(event) => {
            event.preventDefault();
            onPolish(field);
          }}
          disabled={polishDisabled}
        >
          <WandIcon />
          {polishBusy ? "Pollishing..." : "Pollish"}
        </button>
      </span>
      {multiline ? (
        <textarea className="textarea" value={value} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <input className="input" value={value} onChange={(event) => onChange(event.target.value)} />
      )}
    </label>
  );
};

const GoalCharterSettingsPanel = ({
  project,
  draft,
  presets,
  availableModels,
  aiModel,
  aiReasoningEffort,
  generatePrompt,
  aiBusy,
  onChange,
  onSave,
  onApplyPreset,
  onDetectGoal,
  onRejectDetectedGoal,
  onPolishField,
  onGeneratePromptChange,
  onAiModelChange,
  onAiReasoningEffortChange,
  onGenerateDraft,
  onDownloadFormat
}: {
  project?: LoadedProjectView;
  draft: GoalCharterDraftState;
  presets: AutopilotPreset[];
  availableModels: DiscoveredModel[];
  aiModel: string;
  aiReasoningEffort: InterfaceReasoningEffort;
  generatePrompt: string;
  aiBusy?: GoalCharterAiBusyState;
  onChange: (next: GoalCharterDraftUpdate) => void;
  onSave: () => void;
  onApplyPreset: (preset: AutopilotPreset) => void;
  onDetectGoal: () => void;
  onRejectDetectedGoal: () => void;
  onPolishField: (field: GoalCharterDraftTextField) => void;
  onGeneratePromptChange: (value: string) => void;
  onAiModelChange: (model: string) => void;
  onAiReasoningEffortChange: (effort: InterfaceReasoningEffort) => void;
  onGenerateDraft: () => void;
  onDownloadFormat: () => void;
}) => {
  if (!project) {
    return null;
  }
  const charter = project.record.workflow.goalCharter;
  const strategy = draft.autopilotStrategy;
  const selectedAiModel = availableModels.find((model) => model.model === aiModel);
  const aiReasoningEfforts = selectedAiModel?.supportedReasoningEfforts.length
    ? selectedAiModel.supportedReasoningEfforts
    : INTERFACE_REASONING_EFFORTS;
  const updateStrategy = (patch: Partial<AutopilotStrategy>) =>
    onChange({
      autopilotStrategy: {
        ...strategy,
        ...patch,
        presetId: patch.presetId ?? "custom",
        visualPreferences: {
          ...strategy.visualPreferences,
          ...patch.visualPreferences
        },
        autonomyBudget: {
          ...strategy.autonomyBudget,
          ...patch.autonomyBudget
        }
      }
    });
  const updateVisualPreferences = (patch: Partial<AutopilotStrategy["visualPreferences"]>) =>
    updateStrategy({ visualPreferences: { ...strategy.visualPreferences, ...patch } });
  const updateBudget = (patch: Partial<AutopilotStrategy["autonomyBudget"]>) =>
    updateStrategy({ autonomyBudget: { ...strategy.autonomyBudget, ...patch } });
  const pendingDetectedGoal = project.record.workflow.ultimateGoalDraft;
  return (
    <div className="settings-section goal-charter-settings">
      <div className="settings-section__heading">
        <strong>Goal Charter and Autopilot Strategy</strong>
        <span className="badge">{strategyPresetLabel(strategy, presets)}</span>
      </div>
      <p className="settings-card__copy">
        The Original Ultimate Goal is preserved as the baseline charter. The Current Effective Goal is the accepted version the workflow uses now. Lower fidelity means more creative latitude, not lower engineering quality.
      </p>
      <div className="settings-section settings-section--split">
        <div className="settings-card">
          <div className="settings-section__heading">
            <strong>Goal Charter</strong>
            <span className="badge">Project-scoped</span>
          </div>
          <div className="goal-charter-original">
            <span>Original Ultimate Goal</span>
            <strong>{summarizeText(charter.originalUltimateGoal.summary, "Not accepted yet.", 220)}</strong>
          </div>
          {pendingDetectedGoal ? (
            <div className="lane-note">
              <strong>Detected goal awaiting approval</strong>
              <span>{summarizeText(pendingDetectedGoal.summary, "Detected draft ready for review.", 180)}</span>
              <div className="actions-row">
                <button className="secondary-button" type="button" onClick={onRejectDetectedGoal}>Reject detected goal</button>
              </div>
            </div>
          ) : null}
          {!project.record.workflow.ultimateGoal.confirmedAt ? (
            <div className="actions-row">
              <button className="secondary-button" type="button" onClick={onDetectGoal}>Auto-detect Ultimate Goal</button>
            </div>
          ) : null}
          <div className="goal-charter-ai-panel">
            <div className="settings-section__heading">
              <strong>Generate Goal Charter</strong>
              <span className="badge">AI draft</span>
            </div>
            <p className="settings-card__copy">
              Type the project you want, choose a model and effort, then generate a full draft. Review it before saving.
            </p>
            <label className="form-field">
              <span>Project prompt</span>
              <textarea
                className="textarea"
                value={generatePrompt}
                onChange={(event) => onGeneratePromptChange(event.target.value)}
                placeholder="Example: Create a new super mario-style platform game with polished controls, levels, enemies, audio, and a complete validation path."
              />
            </label>
            <div className="strategy-field-grid">
              <label className="form-field">
                <span>Model</span>
                <select
                  className="input"
                  value={aiModel}
                  onChange={(event) => onAiModelChange(event.target.value)}
                  disabled={!availableModels.length || Boolean(aiBusy)}
                >
                  {availableModels.map((model) => (
                    <option key={model.id} value={model.model}>{model.displayName || model.model}</option>
                  ))}
                </select>
              </label>
              <label className="form-field">
                <span>Effort</span>
                <select
                  className="input"
                  value={aiReasoningEffort}
                  onChange={(event) => onAiReasoningEffortChange(event.target.value as InterfaceReasoningEffort)}
                  disabled={!availableModels.length || Boolean(aiBusy)}
                >
                  {aiReasoningEfforts.map((effort) => (
                    <option key={effort} value={effort}>{reasoningEffortLabel(effort)}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="actions-row">
              <button
                className="primary-button"
                type="button"
                onClick={onGenerateDraft}
                disabled={!generatePrompt.trim() || !aiModel || Boolean(aiBusy)}
              >
                {aiBusy?.kind === "generate" ? "Generating..." : "Generate full charter"}
              </button>
              <button className="secondary-button" type="button" onClick={onDownloadFormat}>
                Download Ultimate Goal format
              </button>
            </div>
          </div>
          <GoalCharterDraftField
            field="currentSummary"
            label="Current Effective Goal"
            value={draft.currentSummary}
            onChange={(value) => onChange({ currentSummary: value })}
            onPolish={onPolishField}
            busy={aiBusy}
            disabled={!availableModels.length}
            multiline={false}
          />
          <GoalCharterDraftField
            field="currentDetailedIntent"
            label="Detailed intent"
            value={draft.currentDetailedIntent}
            onChange={(value) => onChange({ currentDetailedIntent: value })}
            onPolish={onPolishField}
            busy={aiBusy}
            disabled={!availableModels.length}
          />
          <div className="workflow-two-column">
            <GoalCharterDraftField
              field="currentSuccessCriteria"
              label="Success criteria"
              value={draft.currentSuccessCriteria}
              onChange={(value) => onChange({ currentSuccessCriteria: value })}
              onPolish={onPolishField}
              busy={aiBusy}
              disabled={!availableModels.length}
            />
            <GoalCharterDraftField
              field="currentConstraints"
              label="Constraints"
              value={draft.currentConstraints}
              onChange={(value) => onChange({ currentConstraints: value })}
              onPolish={onPolishField}
              busy={aiBusy}
              disabled={!availableModels.length}
            />
          </div>
          <div className="workflow-two-column">
            <GoalCharterDraftField
              field="currentNonGoals"
              label="Explicit non-goals"
              value={draft.currentNonGoals}
              onChange={(value) => onChange({ currentNonGoals: value })}
              onPolish={onPolishField}
              busy={aiBusy}
              disabled={!availableModels.length}
            />
            <GoalCharterDraftField
              field="definitionOfDone"
              label="Definition of done"
              value={draft.definitionOfDone}
              onChange={(value) => onChange({ definitionOfDone: value })}
              onPolish={onPolishField}
              busy={aiBusy}
              disabled={!availableModels.length}
            />
          </div>
          <div className="workflow-two-column">
            <GoalCharterDraftField
              field="currentTargetAudience"
              label="Target audience"
              value={draft.currentTargetAudience}
              onChange={(value) => onChange({ currentTargetAudience: value })}
              onPolish={onPolishField}
              busy={aiBusy}
              disabled={!availableModels.length}
              multiline={false}
            />
            <GoalCharterDraftField
              field="currentQualityBar"
              label="Quality bar"
              value={draft.currentQualityBar}
              onChange={(value) => onChange({ currentQualityBar: value })}
              onPolish={onPolishField}
              busy={aiBusy}
              disabled={!availableModels.length}
              multiline={false}
            />
          </div>
          <GoalCharterDraftField
            field="nonNegotiableRequirements"
            label="Non-negotiable requirements"
            value={draft.nonNegotiableRequirements}
            onChange={(value) => onChange({ nonNegotiableRequirements: value })}
            onPolish={onPolishField}
            busy={aiBusy}
            disabled={!availableModels.length}
          />
          <GoalCharterDraftField
            field="explicitNonGoals"
            label="Charter non-goals"
            value={draft.explicitNonGoals}
            onChange={(value) => onChange({ explicitNonGoals: value })}
            onPolish={onPolishField}
            busy={aiBusy}
            disabled={!availableModels.length}
          />
          <div className="workflow-two-column">
            <GoalCharterDraftField
              field="flexibleRequirements"
              label="Flexible requirements"
              value={draft.flexibleRequirements}
              onChange={(value) => onChange({ flexibleRequirements: value })}
              onPolish={onPolishField}
              busy={aiBusy}
              disabled={!availableModels.length}
            />
            <GoalCharterDraftField
              field="niceToHaveIdeas"
              label="Nice-to-have ideas"
              value={draft.niceToHaveIdeas}
              onChange={(value) => onChange({ niceToHaveIdeas: value })}
              onPolish={onPolishField}
              busy={aiBusy}
              disabled={!availableModels.length}
            />
          </div>
          <div className="workflow-two-column">
            <GoalCharterDraftField
              field="userConstraints"
              label="User constraints"
              value={draft.userConstraints}
              onChange={(value) => onChange({ userConstraints: value })}
              onPolish={onPolishField}
              busy={aiBusy}
              disabled={!availableModels.length}
            />
            <GoalCharterDraftField
              field="technicalPreferences"
              label="Technical preferences"
              value={draft.technicalPreferences}
              onChange={(value) => onChange({ technicalPreferences: value })}
              onPolish={onPolishField}
              busy={aiBusy}
              disabled={!availableModels.length}
            />
          </div>
          <GoalCharterDraftField
            field="aestheticPreferences"
            label="Aesthetic preferences"
            value={draft.aestheticPreferences}
            onChange={(value) => onChange({ aestheticPreferences: value })}
            onPolish={onPolishField}
            busy={aiBusy}
            disabled={!availableModels.length}
          />
        </div>
        <div className="settings-card">
          <div className="settings-section__heading">
            <strong>Autopilot Strategy</strong>
            <span className="badge">Planner-ready</span>
          </div>
          <label className="form-field">
            <span>Preset</span>
            <select
              className="input"
              value={strategy.presetId}
              onChange={(event) => {
                const preset = presets.find((entry) => entry.id === event.target.value);
                if (preset) {
                  onApplyPreset(preset);
                } else {
                  updateStrategy({ presetId: "custom" });
                }
              }}
            >
              {presets.map((preset) => (
                <option key={preset.id} value={preset.id}>{preset.label}</option>
              ))}
              <option value="custom">Custom</option>
            </select>
          </label>
          <label className="form-field strategy-slider-field">
            <span>Goal Restrictiveness / Goal Fidelity: {strategy.goalRestrictiveness}</span>
            <input type="range" min={0} max={100} value={strategy.goalRestrictiveness} onChange={(event) => updateStrategy({ goalRestrictiveness: Number(event.target.value) })} />
            <strong>{goalRestrictivenessLabel(strategy.goalRestrictiveness)}</strong>
            <small>{goalRestrictivenessDescription(strategy.goalRestrictiveness)}</small>
          </label>
          <div className="strategy-field-grid">
            <label className="form-field">
              <span>Planning Horizon</span>
              <select className="input" value={strategy.planningHorizon} onChange={(event) => updateStrategy({ planningHorizon: event.target.value as AutopilotStrategy["planningHorizon"] })}>
                <option value="short">Short: next small safe step</option>
                <option value="medium">Medium: several cycles ahead</option>
                <option value="long">Long: multi-phase roadmap</option>
              </select>
            </label>
            <label className="form-field">
              <span>Task Batching</span>
              <select className="input" value={strategy.taskBatchingAggressiveness} onChange={(event) => updateStrategy({ taskBatchingAggressiveness: event.target.value as AutopilotStrategy["taskBatchingAggressiveness"] })}>
                <option value="low">Low: narrow task per cycle</option>
                <option value="medium">Medium: group related items when safe</option>
                <option value="high">High: packages satisfy multiple items</option>
                <option value="very_high">Very High: larger feature batches</option>
              </select>
            </label>
            <label className="form-field">
              <span>Innovation / Creativity Latitude</span>
              <input className="input" type="number" min={0} max={100} value={strategy.innovationLatitude} onChange={(event) => updateStrategy({ innovationLatitude: Number(event.target.value) })} />
            </label>
            <label className="form-field">
              <span>Risk Tolerance</span>
              <select className="input" value={strategy.riskTolerance} onChange={(event) => updateStrategy({ riskTolerance: event.target.value as AutopilotStrategy["riskTolerance"] })}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </label>
            <label className="form-field">
              <span>Refactor Appetite</span>
              <select className="input" value={strategy.refactorAppetite} onChange={(event) => updateStrategy({ refactorAppetite: event.target.value as AutopilotStrategy["refactorAppetite"] })}>
                <option value="low">Low: avoid broad refactors</option>
                <option value="medium">Medium: refactor for current task</option>
                <option value="high">High: improve maintainability</option>
                <option value="very_high">Very High: major restructuring when justified</option>
              </select>
            </label>
            <label className="form-field">
              <span>Validation Strictness</span>
              <select className="input" value={strategy.validationStrictness} onChange={(event) => updateStrategy({ validationStrictness: event.target.value as AutopilotStrategy["validationStrictness"] })}>
                <option value="low">Low: basic checks</option>
                <option value="medium">Medium: relevant tests/lint/build</option>
                <option value="high">High: full validation after meaningful change</option>
                <option value="very_high">Very High: tests/evidence where possible</option>
              </select>
            </label>
            <label className="form-field">
              <span>Approval Sensitivity</span>
              <select className="input" value={strategy.approvalSensitivity} onChange={(event) => updateStrategy({ approvalSensitivity: event.target.value as AutopilotStrategy["approvalSensitivity"] })}>
                <option value="strict">Strict: ask before every code change</option>
                <option value="normal">Normal: ask before risky changes</option>
                <option value="relaxed">Relaxed: auto-run safe/medium tasks</option>
                <option value="autonomous">Autonomous: continue to budget/risk boundary</option>
              </select>
            </label>
            <label className="form-field">
              <span>Visual / Aesthetic Priority</span>
              <select className="input" value={strategy.visualPriority} onChange={(event) => updateStrategy({ visualPriority: event.target.value as AutopilotStrategy["visualPriority"] })}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="very_high">Very High</option>
              </select>
            </label>
          </div>
          <div className="strategy-field-grid">
            <label className="form-field">
              <span>Theme</span>
              <select className="input" value={strategy.visualPreferences.theme} onChange={(event) => updateVisualPreferences({ theme: event.target.value as AutopilotStrategy["visualPreferences"]["theme"] })}>
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
                <option value="custom">Custom</option>
              </select>
            </label>
            <label className="form-field">
              <span>Density</span>
              <select className="input" value={strategy.visualPreferences.density} onChange={(event) => updateVisualPreferences({ density: event.target.value as AutopilotStrategy["visualPreferences"]["density"] })}>
                <option value="compact">Compact</option>
                <option value="balanced">Balanced</option>
                <option value="spacious">Spacious</option>
              </select>
            </label>
            <label className="form-field">
              <span>Feel</span>
              <select className="input" value={strategy.visualPreferences.feel} onChange={(event) => updateVisualPreferences({ feel: event.target.value as AutopilotStrategy["visualPreferences"]["feel"] })}>
                {["professional", "modern", "playful", "minimal", "premium", "technical", "futuristic", "cozy"].map((value) => <option key={value} value={value}>{enumLabel(value)}</option>)}
              </select>
            </label>
            <label className="form-field">
              <span>Layout priority</span>
              <select className="input" value={strategy.visualPreferences.layoutPriority} onChange={(event) => updateVisualPreferences({ layoutPriority: event.target.value as AutopilotStrategy["visualPreferences"]["layoutPriority"] })}>
                {["dashboard", "document_editor", "command_center", "kanban", "terminal_like", "data_heavy", "visual_first"].map((value) => <option key={value} value={value}>{enumLabel(value)}</option>)}
              </select>
            </label>
            <label className="form-field">
              <span>Primary color</span>
              <div className="color-input-row">
                <span className="color-swatch" style={{ backgroundColor: strategy.visualPreferences.primaryColor }} aria-hidden="true" />
                <input className="input" value={strategy.visualPreferences.primaryColor} onChange={(event) => updateVisualPreferences({ primaryColor: event.target.value })} />
              </div>
            </label>
            <label className="form-field">
              <span>Accent color</span>
              <div className="color-input-row">
                <span className="color-swatch" style={{ backgroundColor: strategy.visualPreferences.accentColor }} aria-hidden="true" />
                <input className="input" value={strategy.visualPreferences.accentColor} onChange={(event) => updateVisualPreferences({ accentColor: event.target.value })} />
              </div>
            </label>
            <label className="form-field">
              <span>Motion</span>
              <select className="input" value={strategy.visualPreferences.motionPreference} onChange={(event) => updateVisualPreferences({ motionPreference: event.target.value as AutopilotStrategy["visualPreferences"]["motionPreference"] })}>
                <option value="none">None</option>
                <option value="subtle">Subtle</option>
                <option value="polished">Polished</option>
              </select>
            </label>
            <label className="form-field">
              <span>Accessibility</span>
              <select className="input" value={strategy.visualPreferences.accessibilityPriority} onChange={(event) => updateVisualPreferences({ accessibilityPriority: event.target.value as AutopilotStrategy["visualPreferences"]["accessibilityPriority"] })}>
                <option value="normal">Normal</option>
                <option value="high_contrast">High contrast</option>
                <option value="keyboard_first">Keyboard-first</option>
                <option value="screen_reader_conscious">Screen-reader-conscious</option>
              </select>
            </label>
            <label className="form-field">
              <span>Design strictness</span>
              <select className="input" value={strategy.visualPreferences.designStrictness} onChange={(event) => updateVisualPreferences({ designStrictness: event.target.value as AutopilotStrategy["visualPreferences"]["designStrictness"] })}>
                <option value="follow_user_exactly">Follow user aesthetic exactly</option>
                <option value="allow_model_improvement">Allow model improvement</option>
              </select>
            </label>
          </div>
          <div className="strategy-budget-grid">
            <label className="form-field">
              <span>Max cycles before pause</span>
              <input className="input" type="number" min={1} max={24} value={strategy.autonomyBudget.maxCyclesBeforePause} onChange={(event) => updateBudget({ maxCyclesBeforePause: Number(event.target.value) })} />
            </label>
            <label className="form-field">
              <span>Max minutes before pause</span>
              <input className="input" type="number" min={1} max={480} value={strategy.autonomyBudget.maxMinutesBeforePause} onChange={(event) => updateBudget({ maxMinutesBeforePause: Number(event.target.value) })} />
            </label>
            <label className="form-field">
              <span>Max failed repair attempts</span>
              <input className="input" type="number" min={0} max={10} value={strategy.autonomyBudget.maxFailedRepairAttempts} onChange={(event) => updateBudget({ maxFailedRepairAttempts: Number(event.target.value) })} />
            </label>
            <label className="form-field">
              <span>Max tasks without review</span>
              <input className="input" type="number" min={1} max={24} value={strategy.autonomyBudget.maxConsecutiveTasksWithoutUserReview} onChange={(event) => updateBudget({ maxConsecutiveTasksWithoutUserReview: Number(event.target.value) })} />
            </label>
          </div>
          <div className="strategy-stop-grid">
            {([
              ["stopWhenGoalComplete", "Stop when goal is complete"],
              ["stopWhenNoSafeNextTaskExists", "Stop when no safe next task exists"],
              ["stopWhenPlannerWantsToChangeUltimateGoal", "Stop when planner wants to change Ultimate Goal"],
              ["stopWhenValidationFailsRepeatedly", "Stop when validation fails repeatedly"]
            ] as const).map(([key, label]) => (
              <label key={key} className="checkbox-field">
                <input
                  type="checkbox"
                  checked={strategy.autonomyBudget[key]}
                  onChange={(event) => updateBudget({ [key]: event.target.checked } as Partial<AutopilotStrategy["autonomyBudget"]>)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
          <div className="lane-note">
            <strong>Always explicit</strong>
            <span>Destructive actions, secrets, credentials, data loss, major dependency changes, and unclear intent still require a pause unless explicitly allowed later.</span>
          </div>
        </div>
      </div>
      <div className="actions-row">
        <button className="primary-button" type="button" onClick={onSave}>Save Goal Charter and Strategy</button>
      </div>
    </div>
  );
};

const SettingsDialog = ({
  state,
  activeProject,
  settingsDraft,
  goalCharterDraft,
  goalCharterAiModel,
  goalCharterAiReasoningEffort,
  goalCharterGeneratePrompt,
  goalCharterAiBusy,
  autopilotPresets,
  github,
  onChange,
  onGoalCharterChange,
  onGoalCharterAiModelChange,
  onGoalCharterAiReasoningEffortChange,
  onGoalCharterGeneratePromptChange,
  onPolishGoalCharterField,
  onGenerateGoalCharterDraft,
  onSave,
  onSaveGoalCharter,
  onApplyAutopilotPreset,
  onDetectGoal,
  onRejectDetectedGoal,
  onDownloadUltimateGoalFormat,
  onClose,
  onOpenDevTools,
  onRefreshGitHubStatus,
  onCheckRuntimeReadiness,
  onRefreshCodexReadiness,
  onCheckCodexUpdate,
  onRunCodexUpdate,
  runtimeCheckBusy = false,
  codexUpdateBusy = false,
  mode = "modal"
}: {
  state: WorkbenchState;
  activeProject?: LoadedProjectView;
  settingsDraft: SettingsDraftState;
  goalCharterDraft: GoalCharterDraftState;
  goalCharterAiModel: string;
  goalCharterAiReasoningEffort: InterfaceReasoningEffort;
  goalCharterGeneratePrompt: string;
  goalCharterAiBusy?: GoalCharterAiBusyState;
  autopilotPresets: AutopilotPreset[];
  github: GitHubStatus;
  onChange: (next: SettingsDraftUpdate) => void;
  onGoalCharterChange: (next: GoalCharterDraftUpdate) => void;
  onGoalCharterAiModelChange: (model: string) => void;
  onGoalCharterAiReasoningEffortChange: (effort: InterfaceReasoningEffort) => void;
  onGoalCharterGeneratePromptChange: (prompt: string) => void;
  onPolishGoalCharterField: (field: GoalCharterDraftTextField) => void;
  onGenerateGoalCharterDraft: () => void;
  onSave: () => void;
  onSaveGoalCharter: () => void;
  onApplyAutopilotPreset: (preset: AutopilotPreset) => void;
  onDetectGoal: () => void;
  onRejectDetectedGoal: () => void;
  onDownloadUltimateGoalFormat: () => void;
  onClose: () => void;
  onOpenDevTools: () => void;
  onRefreshGitHubStatus: () => void;
  onCheckRuntimeReadiness: () => void;
  onRefreshCodexReadiness: () => void;
  onCheckCodexUpdate: () => void;
  onRunCodexUpdate: (approvedCommand: string) => void;
  runtimeCheckBusy?: boolean;
  codexUpdateBusy?: boolean;
  mode?: "modal" | "page";
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

  const panel = (
      <div className={`settings-panel ${mode === "page" ? "settings-panel--page" : ""}`}>
        <SectionTitle eyebrow="Preferences" title="Settings" meta={<img className="settings-panel__icon" src={interfaceIconUrl} alt="" />} />
        <p className="settings-panel__copy">
          Tune agent run defaults and open diagnostics only when you need them. Developer Tools no longer open automatically on launch.
        </p>
        <div className="notice">{availabilityMessage(state)}</div>
        <GoalCharterSettingsPanel
          project={activeProject}
          draft={goalCharterDraft}
          presets={autopilotPresets}
          availableModels={state.availableModels}
          aiModel={goalCharterAiModel}
          aiReasoningEffort={goalCharterAiReasoningEffort}
          generatePrompt={goalCharterGeneratePrompt}
          aiBusy={goalCharterAiBusy}
          onChange={onGoalCharterChange}
          onSave={onSaveGoalCharter}
          onApplyPreset={onApplyAutopilotPreset}
          onDetectGoal={onDetectGoal}
          onRejectDetectedGoal={onRejectDetectedGoal}
          onPolishField={onPolishGoalCharterField}
          onGeneratePromptChange={onGoalCharterGeneratePromptChange}
          onAiModelChange={onGoalCharterAiModelChange}
          onAiReasoningEffortChange={onGoalCharterAiReasoningEffortChange}
          onGenerateDraft={onGenerateGoalCharterDraft}
          onDownloadFormat={onDownloadUltimateGoalFormat}
        />
        <RuntimeReadinessPanel
          report={state.runtimeReadiness}
          onRunChecks={onCheckRuntimeReadiness}
          busy={runtimeCheckBusy}
          compact={mode === "modal"}
        />
        <CodexReadinessPanel
          state={state}
          busy={codexUpdateBusy}
          onRefreshReadiness={onRefreshCodexReadiness}
          onCheckUpdate={onCheckCodexUpdate}
          onRunUpdate={onRunCodexUpdate}
        />
        <div className="settings-section">
          <div className="settings-card">
            <div className="settings-section__heading">
              <strong>GitHub access</strong>
              <span className="badge">Repository actions</span>
            </div>
            <p className="settings-card__copy">
              GitHub-backed repository actions need a linked account. New workspaces can either initialize a GitHub SSH repository or use the selected folder as-is.
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
              <button className="secondary-button" disabled={runtimeCheckBusy || state.runtimeReadiness.status === "checking"} onClick={onCheckRuntimeReadiness}>
                {runtimeCheckBusy || state.runtimeReadiness.status === "checking" ? "Checking..." : "Run Readiness Checks"}
              </button>
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
            )) : (
              <div className="overview-card">
                <p>No models are currently available.</p>
                <div className="actions-row">
                  <button className="secondary-button" disabled={runtimeCheckBusy || state.runtimeReadiness.status === "checking"} onClick={onCheckRuntimeReadiness}>
                    {runtimeCheckBusy || state.runtimeReadiness.status === "checking" ? "Checking..." : "Check Model Discovery"}
                  </button>
                </div>
              </div>
            )}
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
  );

  return mode === "modal" ? <div className="settings-modal">{panel}</div> : panel;
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

const StatusChip = ({ label, tone }: { label: string; tone: StatusChipTone }) => (
  <span className={`status-chip status-chip--${tone}`}>{label}</span>
);

const TopBar = ({
  projectName,
  projectContext,
  statusLabel,
  statusTone,
  primaryAction,
  utilityActions
}: {
  projectName: string;
  projectContext: string;
  statusLabel: string;
  statusTone: ShellStatusTone;
  primaryAction?: ShellAction;
  utilityActions: ShellAction[];
}) => (
  <header className="top-app-bar">
    <div className="top-app-bar__identity">
      <img className="top-app-bar__icon" src={interfaceIconUrl} alt="" />
      <div className="top-app-bar__titles">
        <div className="top-app-bar__app">{APP_NAME}</div>
        <div className="top-app-bar__project">
          <strong>{projectName}</strong>
          <span>{projectContext}</span>
        </div>
      </div>
    </div>
    <div className="top-app-bar__actions">
      <StatusChip label={statusLabel} tone={statusTone} />
      {primaryAction ? (
        <button className="primary-button top-app-bar__primary" disabled={primaryAction.disabled} onClick={primaryAction.onClick}>
          {primaryAction.label}
        </button>
      ) : null}
      <details className="utility-menu">
        <summary aria-label="Open utility actions">Utilities</summary>
        <div className="utility-menu__content">
          {utilityActions.map((action) => (
            <button key={action.label} className="utility-menu__item" disabled={action.disabled} onClick={action.onClick} type="button">
              {action.label}
            </button>
          ))}
        </div>
      </details>
    </div>
  </header>
);

const ProjectStatusStrip = ({ items }: { items: Array<string | JSX.Element> }) => (
  <section className="project-status-strip" aria-label="Project status">
    {items.map((item, index) => (
      <span key={typeof item === "string" ? item : index} className="project-status-strip__item">{item}</span>
    ))}
  </section>
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

type RepositoryPathChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  status?: AgentLifecycleStatus | "pending";
  agentId?: string;
  updatedAt?: string;
};

const repositoryPathChatParams = (): {
  enabled: boolean;
  projectId: string;
  relativePath: string;
  initialQuestion: string;
} => {
  const params = new URLSearchParams(window.location.search);
  return {
    enabled: params.get("view") === "repositoryPathChat",
    projectId: params.get("projectId") ?? "",
    relativePath: params.get("repositoryPath") ?? "",
    initialQuestion: params.get("initialQuestion") ?? ""
  };
};

const repositoryChatMessageId = (): string =>
  `chat-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const isRepositoryChatTerminalStatus = (status: AgentLifecycleStatus): boolean =>
  status === "completed" || status === "failed" || status === "conflicted" || status === "disconnected";

const parseJsonCandidate = (value: string): Record<string, unknown> | undefined => {
  const trimmed = value.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1]?.trim();
  const candidates = [
    fenced,
    trimmed,
    trimmed.includes("{") && trimmed.includes("}")
      ? trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1)
      : undefined
  ].filter((candidate): candidate is string => Boolean(candidate?.trim()));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      continue;
    }
  }
  return undefined;
};

const humanizeStructuredAgentPayload = (value?: Record<string, unknown>): string | undefined => {
  if (!value) {
    return undefined;
  }
  const record = value;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const purpose = typeof record.purpose === "string" ? record.purpose.trim() : "";
  const summary = typeof record.summary === "string" ? record.summary.trim() : "";
  const answer = typeof record.answer === "string" ? record.answer.trim() : "";
  const keySymbols = Array.isArray(record.keySymbols)
    ? record.keySymbols.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).slice(0, 8)
    : [];
  const relatedFiles = Array.isArray(record.relatedFiles)
    ? record.relatedFiles.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).slice(0, 6)
    : [];
  const confidence = typeof record.confidence === "number" && Number.isFinite(record.confidence)
    ? `Confidence: ${Math.round(Math.max(0, Math.min(1, record.confidence)) * 100)}%.`
    : "";
  const sections = [
    title,
    answer,
    purpose ? `Purpose: ${purpose}` : "",
    summary ? `Summary: ${summary}` : "",
    keySymbols.length ? `Important symbols: ${keySymbols.join(", ")}.` : "",
    relatedFiles.length ? `Related files: ${relatedFiles.join(", ")}.` : "",
    confidence
  ].filter((entry) => entry.trim().length > 0);
  return sections.length ? sections.join("\n\n") : undefined;
};

const cleanAgentAnswerText = (value: string): string => value
  .replace(/^\[[^\]]+\]\s+[A-Z_ -]+$/gm, "")
  .replace(/^\[[^\]]+\]\s+[A-Z_ -]+\s*$/gm, "")
  .replace(/^MESSAGE\s+-\s+Agent output\s*$/gim, "")
  .replace(/^Agent output\s*$/gim, "")
  .replace(/```(?:json)?/gi, "")
  .replace(/```/g, "")
  .trim();

const formatRepositoryChatAnswer = (
  agent: AgentState,
  transcript?: AgentTranscriptResponse,
  output?: AgentFullOutputResponse
): string => {
  const transcriptMessages = (transcript?.entries ?? [])
    .filter((entry) => entry.kind === "message" && entry.text?.trim())
    .map((entry) => entry.text?.trim() ?? "");
  const transcriptText = transcriptMessages.length ? transcriptMessages[transcriptMessages.length - 1] : "";
  const rawText = transcriptText || output?.output || agent.lastMessageSnippet || agent.currentPhase || "";
  const cleaned = cleanAgentAnswerText(rawText);
  const structured = humanizeStructuredAgentPayload(parseJsonCandidate(cleaned));
  return redactSensitiveText(structured ?? cleaned) || "The agent finished, but no readable answer was captured.";
};

const buildRepositoryChatQuestion = (messages: RepositoryPathChatMessage[], question: string): string => {
  const conversation = messages
    .filter((message) => message.role === "user" || (message.role === "assistant" && message.status === "completed"))
    .slice(-8)
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.text}`)
    .join("\n\n");
  return conversation
    ? `Previous conversation about this repository path:\n\n${conversation}\n\nCurrent question: ${question}`
    : question;
};

const FormattedSummaryText = ({ value }: { value?: string }) => {
  const safeValue = redactSensitiveText(value);
  const paragraphs = safeValue
    .split(/\n{2,}/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return (
    <div className="formatted-summary-text">
      {paragraphs.length ? paragraphs.map((paragraph, index) => <p key={`${index}:${paragraph.slice(0, 32)}`}>{paragraph}</p>) : <p>No summary is available yet.</p>}
    </div>
  );
};

const RepositoryPathChatApp = () => {
  const params = useMemo(repositoryPathChatParams, []);
  const [state, setState] = useState<WorkbenchState | null>(null);
  const [initialStateLoading, setInitialStateLoading] = useState(true);
  const [fileSummary, setFileSummary] = useState<FileSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [messages, setMessages] = useState<RepositoryPathChatMessage[]>([]);
  const [draft, setDraft] = useState(params.initialQuestion);
  const [busyAgentId, setBusyAgentId] = useState<string>();
  const [error, setError] = useState<string>();
  const [summaryModel, setSummaryModel] = useState("");
  const [reasoningMode, setReasoningMode] = useState<AgentReasoningMode>("auto");
  const [reasoningEffort, setReasoningEffort] = useState<InterfaceReasoningEffort>(DEFAULT_AGENT_REASONING_EFFORTS.manual);
  const autoQuestionSentRef = useRef(false);
  const mountedRef = useRef(true);
  const submitQuestionRef = useRef<(questionOverride?: string) => Promise<void>>(() => Promise.resolve());
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    void window.workbench.getState()
      .then((result) => {
        if (mountedRef.current) {
          setState(result);
        }
      })
      .finally(() => {
        if (mountedRef.current) {
          setInitialStateLoading(false);
        }
      });
    const unsubscribe = window.workbench.onStateUpdated((nextState) => {
      if (mountedRef.current) {
        setState(nextState);
      }
    });
    return () => {
      mountedRef.current = false;
      unsubscribe();
    };
  }, []);

  const activeProject = state?.projects.find((project) => project.record.id === params.projectId);
  const availableModels = useMemo(() => state?.availableModels ?? [], [state?.availableModels]);
  const recommendedModel = useMemo(
    () => availableModels.find((model) => model.recommendedForInterfaceCreation)?.model ?? availableModels[0]?.model ?? "",
    [availableModels]
  );
  const modelOptionsByName = useMemo(() => new Map(availableModels.map((model) => [model.model, model])), [availableModels]);
  const agentActionsBlocked = Boolean(state?.runtimeReadiness.blockAgentActions);

  useEffect(() => {
    if (!state || !params.projectId || state.activeProjectId === params.projectId || activeProject) {
      return;
    }
    void window.workbench.openProject(params.projectId)
      .then(() => window.workbench.getState())
      .then(setState)
      .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
  }, [activeProject, params.projectId, state]);

  useEffect(() => {
    if (!recommendedModel) {
      return;
    }
    setSummaryModel((current) => current && availableModels.some((model) => model.model === current) ? current : recommendedModel);
  }, [availableModels, recommendedModel]);

  useEffect(() => {
    setReasoningEffort((current) =>
      resolveAgentReasoningEffort(
        modelOptionsByName.get(summaryModel || recommendedModel),
        "manual",
        `Repository path chat: ${params.relativePath}`,
        "manual",
        current
      )
    );
  }, [modelOptionsByName, params.relativePath, recommendedModel, summaryModel]);

  useEffect(() => {
    if (!activeProject || !params.relativePath) {
      return;
    }
    let cancelled = false;
    setSummaryLoading(true);
    setError(undefined);
    void window.workbench.getFileSummary(activeProject.record.id, params.relativePath)
      .then((summary) => {
        if (!cancelled) {
          setFileSummary(summary);
        }
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setSummaryLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeProject, params.relativePath]);

  const updateChatMessage = (messageId: string, patch: Partial<RepositoryPathChatMessage>) => {
    setMessages((current) => current.map((message) => message.id === messageId ? { ...message, ...patch } : message));
  };

  const pollRepositoryChatAgent = async (agentId: string, messageId: string): Promise<void> => {
    for (let attempt = 0; attempt < 180 && mountedRef.current; attempt += 1) {
      await delay(attempt < 8 ? 1_250 : 2_000);
      const agent = await window.workbench.getAgent(params.projectId, agentId);
      if (!mountedRef.current) {
        return;
      }
      updateChatMessage(messageId, {
        status: agent.status,
        updatedAt: agent.lastActivityAt ?? agent.completedAt ?? agent.startedAt,
        text: agent.status === "completed"
          ? "Finishing answer..."
          : agent.status === "failed" || agent.status === "conflicted" || agent.status === "disconnected"
            ? agent.disconnectedReason ?? agent.currentPhase ?? "The agent could not finish cleanly."
            : agent.currentSubtask ?? agent.currentPhase ?? agent.lastMessageSnippet ?? "Thinking about this path..."
      });
      if (!isRepositoryChatTerminalStatus(agent.status)) {
        continue;
      }
      const [transcriptResult, outputResult] = await Promise.allSettled([
        window.workbench.getAgentTranscript(params.projectId, agentId),
        window.workbench.getAgentFullOutput(params.projectId, agentId)
      ]);
      const transcript = transcriptResult.status === "fulfilled" ? transcriptResult.value : undefined;
      const output = outputResult.status === "fulfilled" ? outputResult.value : undefined;
      const answer = agent.status === "completed"
        ? formatRepositoryChatAnswer(agent, transcript, output)
        : redactSensitiveText(agent.disconnectedReason ?? agent.currentPhase ?? "The agent could not finish cleanly.");
      updateChatMessage(messageId, {
        text: answer,
        status: agent.status,
        updatedAt: agent.completedAt ?? agent.lastActivityAt ?? agent.startedAt
      });
      setBusyAgentId((current) => current === agentId ? undefined : current);
      return;
    }
    updateChatMessage(messageId, {
      status: "disconnected",
      text: "The agent is still running or stopped reporting progress. You can ask again or inspect the run from the main History tab."
    });
    setBusyAgentId((current) => current === agentId ? undefined : current);
  };

  const submitQuestion = async (questionOverride?: string): Promise<void> => {
    const question = (questionOverride ?? draft).trim();
    if (!activeProject || !params.relativePath || !question || !summaryModel || busyAgentId || agentActionsBlocked) {
      return;
    }
    setDraft("");
    setError(undefined);
    const userMessage: RepositoryPathChatMessage = {
      id: repositoryChatMessageId(),
      role: "user",
      text: question,
      status: "completed",
      updatedAt: new Date().toISOString()
    };
    const assistantMessage: RepositoryPathChatMessage = {
      id: repositoryChatMessageId(),
      role: "assistant",
      text: "Starting a path-scoped agent...",
      status: "pending",
      updatedAt: new Date().toISOString()
    };
    const contextQuestion = buildRepositoryChatQuestion(messages, question);
    setMessages((current) => [...current, userMessage, assistantMessage]);
    try {
      const agent = await window.workbench.askRepositoryPath(
        activeProject.record.id,
        params.relativePath,
        contextQuestion,
        summaryModel,
        reasoningMode,
        reasoningEffort
      );
      setBusyAgentId(agent.id);
      updateChatMessage(assistantMessage.id, {
        agentId: agent.id,
        status: agent.status,
        text: agent.currentPhase ?? "Reading the selected path and preparing an answer...",
        updatedAt: agent.startedAt ?? agent.createdAt
      });
      void pollRepositoryChatAgent(agent.id, assistantMessage.id).catch((caught) => {
        updateChatMessage(assistantMessage.id, {
          status: "failed",
          text: caught instanceof Error ? caught.message : String(caught)
        });
        setBusyAgentId((current) => current === agent.id ? undefined : current);
      });
    } catch (caught) {
      setBusyAgentId(undefined);
      updateChatMessage(assistantMessage.id, {
        status: "failed",
        text: caught instanceof Error ? caught.message : String(caught)
      });
    }
  };
  submitQuestionRef.current = submitQuestion;

  useEffect(() => {
    if (autoQuestionSentRef.current || !params.initialQuestion.trim() || !activeProject || !summaryModel || summaryLoading) {
      return;
    }
    autoQuestionSentRef.current = true;
    void submitQuestionRef.current(params.initialQuestion);
  }, [activeProject, params.initialQuestion, summaryLoading, summaryModel]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const chatBusy = Boolean(busyAgentId);
  const title = fileSummary?.title || params.relativePath.split("/").pop() || params.relativePath || "Repository path";
  const selectedModel = modelOptionsByName.get(summaryModel);
  const selectedModelLabel = selectedModel?.displayName ?? (summaryModel || "Select model");

  return (
    <main className="repository-chat-shell">
      <header className="repository-chat-header">
        <div>
          <div className="eyebrow">Repository path chat</div>
          <h1>{title}</h1>
          <p>{params.relativePath || "No repository path provided."}</p>
        </div>
        <div className="repository-chat-header__status">
          {fileSummary ? <SourceBadge source={fileSummary.source} /> : null}
          {chatBusy ? <LoadingIndicator label="Agent thinking" compact /> : <span className="badge">Ready</span>}
        </div>
      </header>

      <section className="repository-chat-summary" aria-label="Path summary">
        <div className="candidate-card__title-row">
          <strong>Summary</strong>
          {fileSummary ? <span className="badge">{fileSummary.pathKind}</span> : null}
        </div>
        {summaryLoading ? <LoadingIndicator label="Loading path summary" compact /> : <FormattedSummaryText value={fileSummary?.summary} />}
      </section>

      <section className="repository-chat-messages" aria-label="Conversation">
        {initialStateLoading ? <LoadingIndicator label="Loading repository chat" /> : null}
        {error ? <div className="notice notice--error">{error}</div> : null}
        {!messages.length && !initialStateLoading ? (
          <div className="repository-chat-empty">
            <strong>Ask about this file or folder.</strong>
            <p>Questions stay scoped to the selected repository path and use the stored summary plus fresh path evidence.</p>
          </div>
        ) : null}
        {messages.map((message) => {
          const status = message.status && message.status !== "pending" ? agentLifecycleStatusChip(message.status) : undefined;
          return (
            <article key={message.id} className={`repository-chat-message repository-chat-message--${message.role}`}>
              <div className="repository-chat-message__meta">
                <strong>{message.role === "user" ? "You" : "Agent"}</strong>
                {status ? <StatusChip label={status.label} tone={status.tone} /> : message.status === "pending" ? <span className="badge">Starting</span> : null}
                {message.updatedAt ? <span>{formatClockTime(message.updatedAt)}</span> : null}
              </div>
              <div className="repository-chat-message__text">
                {message.status && message.status !== "completed" && message.role === "assistant" ? <LoadingIndicator label={message.text} compact /> : <FormattedSummaryText value={message.text} />}
              </div>
            </article>
          );
        })}
        <div ref={messagesEndRef} aria-hidden="true" />
      </section>

      <footer className="repository-chat-composer">
        <details className="repository-chat-options">
          <summary>
            <span>Model</span>
            <strong>{selectedModelLabel}</strong>
            <em>{reasoningMode === "auto" ? "Automatic reasoning" : `${reasoningEffortLabel(reasoningEffort)} reasoning`}</em>
          </summary>
          <div className="repository-chat-model-bar">
            <label className="form-field">
              <span>Model</span>
              <select className="input" value={summaryModel} onChange={(event) => setSummaryModel(event.target.value)} disabled={agentActionsBlocked || !availableModels.length || chatBusy}>
                {availableModels.map((model) => <option key={model.id} value={model.model}>{model.displayName} ({model.model})</option>)}
              </select>
            </label>
            <AgentReasoningPicker
              category="manual"
              model={selectedModel}
              taskPrompt={`Repository path chat: ${params.relativePath}`}
              mode={reasoningMode}
              effort={reasoningEffort}
              onModeChange={setReasoningMode}
              onEffortChange={setReasoningEffort}
            />
          </div>
        </details>
        <textarea
          className="textarea repository-chat-input"
          placeholder="Ask a question about this file or folder"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={agentActionsBlocked || chatBusy || !activeProject}
        />
        <div className="actions-row">
          <button className="primary-button" type="button" disabled={agentActionsBlocked || chatBusy || !draft.trim() || !activeProject || !summaryModel} onClick={() => void submitQuestion()}>
            {chatBusy ? "Thinking..." : "Ask"}
          </button>
          <button className="secondary-button" type="button" onClick={() => window.close()}>Close</button>
        </div>
      </footer>
    </main>
  );
};

const WorkbenchApp = () => {
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
  const [repositorySummaryModel, setRepositorySummaryModel] = useState("");
  const [repositorySummaryReasoningMode, setRepositorySummaryReasoningMode] = useState<AgentReasoningMode>("auto");
  const [repositorySummaryReasoningEffort, setRepositorySummaryReasoningEffort] = useState<InterfaceReasoningEffort>(DEFAULT_AGENT_REASONING_EFFORTS.manual);
  const [repositoryQuestionDraft, setRepositoryQuestionDraft] = useState("");
  const [repositoryPathActionBusy, setRepositoryPathActionBusy] = useState<{ path: string; action: "summary" | "question" | "window" }>();
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
  const [launchIntent, setLaunchIntent] = useState<ProjectLoadIntent>("open");
  const [projectCreationMode, setProjectCreationMode] = useState<ProjectCreationMode>("initialize_github");
  const [treeFilterDraft, setTreeFilterDraft] = useState("");
  const [repositorySearchResultIndex, setRepositorySearchResultIndex] = useState(0);
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
  const [goalCharterDraft, setGoalCharterDraft] = useState<GoalCharterDraftState>(() => goalCharterDraftFromWorkflow());
  const [goalCharterAiModel, setGoalCharterAiModel] = useState("");
  const [goalCharterAiReasoningEffort, setGoalCharterAiReasoningEffort] = useState<InterfaceReasoningEffort>("medium");
  const [goalCharterGeneratePrompt, setGoalCharterGeneratePrompt] = useState("");
  const [goalCharterAiBusy, setGoalCharterAiBusy] = useState<GoalCharterAiBusyState>();
  const [autopilotPresets, setAutopilotPresets] = useState<AutopilotPreset[]>(() => defaultAutopilotPresets());
  const [ultimateGoalImportPreview, setUltimateGoalImportPreview] = useState<UltimateGoalImportPreview | null>(null);
  const [interventionNotes, setInterventionNotes] = useState<Record<string, string>>({});
  const [userInputDrafts, setUserInputDrafts] = useState<Record<string, Record<string, string>>>({});
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [shellLaunchBusy, setShellLaunchBusy] = useState(false);
  const [repairAgentLaunchBusy, setRepairAgentLaunchBusy] = useState(false);
  const [workflowCommandBusyKey, setWorkflowCommandBusyKey] = useState<string>();
  const [runtimeCheckBusy, setRuntimeCheckBusy] = useState(false);
  const [codexUpdateBusy, setCodexUpdateBusy] = useState(false);
  const [overviewRefreshBusy, setOverviewRefreshBusy] = useState(false);
  const [visualExtractBusy, setVisualExtractBusy] = useState(false);
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
  const [activeWorkspaceTabOverride, setActiveWorkspaceTabOverride] = useState<WorkspaceVisualTabId>();
  const tabLayoutPersistTimerRef = useRef<number | undefined>(undefined);
  const tabLayoutPersistRequestRef = useRef<{ projectId: string; tab: WorkspaceVisualTabId } | undefined>(undefined);
  const promptedCodexUpdateCommandsRef = useRef<Set<string>>(new Set());
  const runCodexUpdateRef = useRef<(approvedCommand?: string) => Promise<void>>(() => Promise.resolve());
  const [repositoryData, setRepositoryData] = useState<RepositoryDataView>(() => emptyRepositoryData());
  const revealRepositoryPathRef = useRef<(relativePath: string) => Promise<void>>(() => Promise.resolve());
  const [repositoryScanStatus, setRepositoryScanStatus] = useState<RepositoryScanStatus | null>(null);
  const [repositoryScanLimits, setRepositoryScanLimits] = useState<RepositoryScanLimitsResponse | null>(null);
  const [repositoryRescanBusy, setRepositoryRescanBusy] = useState<"normal" | "deep">();
  const [historyData, setHistoryData] = useState<HistoryCycleView>(() => emptyHistoryData());
  const [agentOutputViewer, setAgentOutputViewer] = useState<AgentOutputViewerState>();
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
  const [workflowDetailsMounted, setWorkflowDetailsMounted] = useState(false);
  const workflowCommandBusyRef = useRef<string | undefined>(undefined);
  const repositoryLaunchRef = useRef<{
    projectId?: string;
    path?: string;
    openingProject: boolean;
    pathApplied: boolean;
  }>((() => {
    const params = new URLSearchParams(window.location.search);
    return {
      projectId: params.get("projectId") ?? undefined,
      path: params.get("repositoryPath") ?? undefined,
      openingProject: false,
      pathApplied: false
    };
  })());
  const visualExportReadinessRef = useRef<VisualExportReadiness>({
    activeProjectId: undefined,
    activeWorkspaceTab: "overview",
    logFeedProjectId: "",
    logFeedLoading: false,
    repositoryProjectId: "",
    repositoryLoading: false,
    historyProjectId: "",
    historyLoading: false,
    workflowAgentPageLoading: false,
    manualAgentPageLoading: false
  });

  useEffect(() => {
    void window.workbench.getState()
      .then((result) => startTransition(() => setState(result)))
      .finally(() => setInitialStateLoading(false));
    void window.workbench.listAutopilotPresets()
      .then((presets) => setAutopilotPresets(presets))
      .catch(() => setAutopilotPresets(defaultAutopilotPresets()));
    return window.workbench.onStateUpdated((nextState) => {
      startTransition(() => setState(nextState));
    });
  }, []);

  useEffect(() => () => {
    if (tabLayoutPersistTimerRef.current !== undefined) {
      window.clearTimeout(tabLayoutPersistTimerRef.current);
    }
  }, []);

  useEffect(() => {
    const favicon = document.querySelector("link[rel='icon']") ?? document.createElement("link");
    favicon.setAttribute("rel", "icon");
    favicon.setAttribute("href", interfaceIconUrl);
    document.head.appendChild(favicon);
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      if (!document.hidden) {
        setClockNow(Date.now());
      }
    }, 60_000);

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
  const createWorkspaceUsesGitHub = projectCreationMode === "initialize_github";
  const createWorkspaceLocked = createWorkspaceUsesGitHub && !githubSshReady;
  const activeProjectId = activeProject?.record.id;
  const runtimeReadiness = state?.runtimeReadiness;
  const agentActionsBlocked = Boolean(runtimeReadiness?.blockAgentActions);
  const activeWorkflowCommandBusy = Boolean(activeProjectId && workflowCommandBusyKey?.startsWith(`${activeProjectId}:`));
  const workflowCommandBusy = activeWorkflowCommandBusy || agentActionsBlocked;
  const workflowCommandBusyReason = activeWorkflowCommandBusy
    ? "Workflow command is already running."
    : agentActionsBlocked
      ? runtimeReadiness?.summary ?? "Runtime checks are required before agent-backed workflow actions can run."
      : undefined;
  const selectedFileFromState = activeProject?.record.localState.selectedFile;
  const storedTreeFilter = activeProject?.record.localState.treeFilter ?? "";
  const storedActiveAgentId = activeProject?.record.localState.activeAgentId;
  const workflowObjective = activeProject?.record.localState.workflowObjective ?? "deliver";
  const optimizeModeEnabled = workflowObjective === "optimize";
  const workflowPauseRequested = activeProject?.record.localState.workflowPauseRequested ?? false;
  const recommendedModel = useMemo(
    () => state?.availableModels.find((model) => model.recommendedForInterfaceCreation)?.model ?? state?.availableModels[0]?.model ?? "",
    [state?.availableModels]
  );
  const modelOptionsByName = useMemo(() => new Map(availableModels.map((model) => [model.model, model])), [availableModels]);
  useEffect(() => {
    if (!availableModels.length) {
      return;
    }
    if (!goalCharterAiModel || !availableModels.some((model) => model.model === goalCharterAiModel)) {
      setGoalCharterAiModel(recommendedModel || availableModels[0].model);
    }
  }, [availableModels, goalCharterAiModel, recommendedModel]);
  useEffect(() => {
    const modelRecord = modelOptionsByName.get(goalCharterAiModel);
    if (modelRecord?.supportedReasoningEfforts.length && !modelRecord.supportedReasoningEfforts.includes(goalCharterAiReasoningEffort)) {
      setGoalCharterAiReasoningEffort(modelRecord.defaultReasoningEffort ?? modelRecord.supportedReasoningEfforts[0]);
    }
  }, [goalCharterAiModel, goalCharterAiReasoningEffort, modelOptionsByName]);
  const deferredTreeFilter = useDeferredValue(treeFilterDraft);
  const workflow = activeProject?.record.workflow;
  const ultimateGoalMissing = !workflow?.ultimateGoal.confirmedAt;
  const autopilotPolicy = workflow?.autopilotPolicy;
  const autopilotStatus = workflow?.autopilotStatus;
  const currentPlannerDecision = useMemo(() => {
    if (!workflow?.plannerDecisions.length) {
      return undefined;
    }
    return workflow.plannerDecisions.find((decision) => decision.cycleNumber === workflow.workflowCycle.cycleNumber) ?? workflow.plannerDecisions[0];
  }, [workflow]);
  const currentStrategicPlan = useMemo(() =>
    currentPlannerDecision && workflow
      ? workflow.strategicPlans.find((plan) => plan.id === currentPlannerDecision.planId)
      : undefined,
  [currentPlannerDecision, workflow]);
  const currentPlannerTargets = useMemo(() => {
    if (!workflow || !currentPlannerDecision?.targetedChecklistIds.length) {
      return [];
    }
    const byId = new Map(workflow.goalChecklist.map((check) => [check.id, check.title]));
    return currentPlannerDecision.targetedChecklistIds.map((id) => byId.get(id) ?? id);
  }, [currentPlannerDecision, workflow]);
  const autopilotEnabled = autopilotPolicy?.enabled ?? activeProject?.record.localState.autopilotEnabled ?? false;
  const autopilotProfile = autopilotPolicy?.profile ?? "balanced";
  const workflowMode = workflow?.workflowMode ?? "normal";
  const previewRequest = workflow?.previewRequest;
  const previewStatus = previewRequest?.status ?? "none";
  const previewDisabledReason = workflow && !workflow.ultimateGoal.confirmedAt
    ? "Confirm the Ultimate Goal first."
    : undefined;
  const fastModeEnabled = workflowMode === "fast";
  const allAgents = useMemo(() => activeProject ? sortAgentsByActivity(activeProject.record.agents) : [], [activeProject]);
  const runsPageAgents = useMemo(
    () => sortAgentsByActivity([...workflowAgentPage.agents, ...manualAgentPage.agents]),
    [manualAgentPage.agents, workflowAgentPage.agents]
  );
  const totalRunsCount = workflowAgentPage.total + manualAgentPage.total;
  const agentHistoryVersion = useMemo(
    () => allAgents.map((agent) => `${agent.id}:${agent.status}:${agent.lastActivityAt ?? ""}:${agent.approvals.length}:${agent.changedFiles.length}`).join("|"),
    [allAgents]
  );
  const workflowAgents = useMemo(() => allAgents.filter((agent) => agent.category !== "manual"), [allAgents]);
  const workflowHasActiveAgent = useMemo(() => workflowAgents.some(isWorkflowAutomationBlockingAgent), [workflowAgents]);
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
  const workflowRuntimeStatus = useMemo(
    () => workflow
      ? deriveWorkflowRuntimeStatus(workflow, workflowAgents, {
        projectKind: activeProject?.record.identity.kind,
        nowMs: clockNow,
        staleMs: WORKFLOW_AGENT_STALE_MS,
        workflowPauseRequested,
        autopilotEnabled,
        workflowObjective
      })
      : null,
    [activeProject?.record.identity.kind, autopilotEnabled, clockNow, workflow, workflowAgents, workflowObjective, workflowPauseRequested]
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
    if (workflowRuntimeStatus?.status === "stale-running" && workflowPendingApprovals.length === 0) {
      const recoveryCandidate = workflowRuntimeStatus.recoveryCandidate ?? workflowRecoveryCandidate;
      return {
        kind: "recover_workflow",
        title: recoveryCandidate?.kind === "disconnected"
          ? "Workflow was interrupted"
          : recoveryCandidate?.kind === "startup_stalled"
            ? "Agent startup may be stalled"
            : "Workflow may be stalled",
        description: recoveryCandidate?.kind === "disconnected"
          ? `${recoveryCandidate.agent.name} lost its Codex connection. Continue from the last saved workflow decision.`
          : recoveryCandidate?.kind === "startup_stalled"
            ? `${recoveryCandidate.agent.name} has not received a Codex thread yet. Continue from the saved workflow state to restart the step.`
          : recoveryCandidate
            ? `${recoveryCandidate.agent.name} has not reported progress recently. Continue from the last saved workflow decision if it stopped responding.`
            : "A saved workflow step is marked running, but no active agent process is attached. Continue from the saved workflow state to restart the step.",
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
    if (workflow.autopilotStatus?.pausedReason) {
      return {
        kind: "none",
        title: workflow.autopilotStatus.pausedReason === "high_risk_package_requires_approval"
          ? "Approve the workflow checkpoint"
          : "Workflow checkpoint paused",
        description: workflow.autopilotStatus.pausedDetail ?? "Autopilot is paused until you continue."
      };
    }
    return workflowActionGuide(workflow, workflowPendingApprovals.length > 0, autopilotEnabled, workflowObjective);
  }, [autopilotEnabled, workflow, workflowHasActiveAgent, workflowObjective, workflowPauseRequested, workflowPendingApprovals.length, workflowRecoveryCandidate, workflowRuntimeStatus]);
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

    return workflowAgents.find((agent) => isCurrentCycleAgent(agent) && isWorkflowAutomationBlockingAgent(agent))
      ?? workflowAgents.find((agent) => isCurrentCycleAgent(agent) && isWorkflowAgentActive(agent))
      ?? workflowAgents.find(isCurrentCycleAgent)
      ?? workflowAgents[0];
  }, [workflow, workflowAgents]);
  const latestValidationLedger = useMemo(() => {
    if (!workflow) {
      return undefined;
    }
    return workflow.validationLedgers
      .filter((ledger) => ledger.cycleNumber === workflow.workflowCycle.cycleNumber)
      .slice()
      .sort((left, right) => toTime(right.updatedAt) - toTime(left.updatedAt))[0];
  }, [workflow]);
  const latestRepoHygieneReport = useMemo(() => {
    if (!workflow) {
      return undefined;
    }
    return workflow.repoHygieneReports
      .slice()
      .sort((left, right) => toTime(right.scannedAt) - toTime(left.scannedAt))[0];
  }, [workflow]);
  const userFacingWorkflowStatus = useMemo(() =>
    workflow
      ? deriveUserFacingWorkflowStatus(workflow, {
        agents: workflowAgents,
        validationLedger: latestValidationLedger,
        repoHygieneReport: latestRepoHygieneReport,
        workflowPauseRequested
      })
      : undefined,
  [latestRepoHygieneReport, latestValidationLedger, workflow, workflowAgents, workflowPauseRequested]);
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
  const workflowLastUpdatedAt = useMemo(
    () => getWorkflowLastUpdatedAt(workflow, workflowAgents),
    [workflow, workflowAgents]
  );
  const workflowChecklistOverview = useMemo(
    () => buildWorkflowChecklistOverview(workflow),
    [workflow]
  );
  const currentWorkflowChangedFiles = useMemo(
    () => getCurrentCycleChangedFiles(workflow, workflowAgents),
    [workflow, workflowAgents]
  );
  const operatorWorkflowView = useMemo(
    () => buildOperatorWorkflowViewModel({
      workflow,
      agents: workflowAgents,
      projectName: activeProject?.record.identity.projectName,
      branch: activeProject?.record.validation.branch ?? activeProject?.record.displayPath,
      lastUpdated: workflowLastUpdatedAt ?? activeProject?.record.localState.lastOpenedAt,
      workflowPauseRequested,
      approvalCount: workflowPendingApprovals.length,
      repositoryScanStatus,
      repositorySummary: repositoryData.projectId === activeProject?.record.id ? repositoryData : null,
      validationLedger: latestValidationLedger,
      repoHygieneReport: latestRepoHygieneReport,
      runtimeReady: state?.runtimeReadiness.status === "ready"
    }),
    [
      activeProject?.record.displayPath,
      activeProject?.record.id,
      activeProject?.record.identity.projectName,
      activeProject?.record.localState.lastOpenedAt,
      activeProject?.record.validation.branch,
      latestRepoHygieneReport,
      latestValidationLedger,
      repositoryData,
      repositoryScanStatus,
      state?.runtimeReadiness.status,
      workflow,
      workflowAgents,
      workflowLastUpdatedAt,
      workflowPauseRequested,
      workflowPendingApprovals.length
    ]
  );
  const workflowCredentialRequests = useMemo(
    () => activeProject?.record.credentials.requests.filter((request) => request.status === "pending") ?? [],
    [activeProject]
  );
  const workflowAttentionItems = useMemo(
    () => buildWorkflowAttentionItems({
      workflow,
      approvals: workflowPendingApprovals,
      userInputRequests: pendingUserInputRequests,
      humanInterventions: pendingHumanInterventions,
      credentialRequests: workflowCredentialRequests,
      timeline: workflowTimeline,
      agents: workflowAgents
    }),
    [
      pendingHumanInterventions,
      pendingUserInputRequests,
      workflow,
      workflowAgents,
      workflowCredentialRequests,
      workflowPendingApprovals,
      workflowTimeline
    ]
  );
  const activeAgent = useMemo(
    () => allAgents.find((agent) => agent.id === focusedAgentId) ?? allAgents[0],
    [allAgents, focusedAgentId]
  );
  const activeAgentForDetail = agentDetail?.id === activeAgent?.id ? agentDetail : activeAgent;
  const selectedRunAgent = agentDetail
    ?? runsPageAgents.find((agent) => agent.id === focusedAgentId)
    ?? activeAgentForDetail;
  const selectedRepositorySummaryAgent = useMemo(
    () => selectedFile
      ? sortAgentsByActivity(allAgents.filter((agent) => agent.repositorySummaryTarget?.relativePath === selectedFile))[0]
      : undefined,
    [allAgents, selectedFile]
  );
  const selectedWorkspaceTab: WorkspaceVisualTabId = activeWorkspaceTabOverride ?? normalizeWorkspaceTab(activeProject?.record.layout.activeCenterTab);
  const activeWorkspaceTab = useDeferredValue(selectedWorkspaceTab);
  const workflowRunState = workflow && activeProject
    ? workflowRuntimeStatus?.status === "running"
      ? "Running"
      : workflowRuntimeStatus?.status === "recovering"
        ? "Recovering"
        : workflowRuntimeStatus?.status === "starting-agent"
          ? "Starting agent"
      : workflowRuntimeStatus?.status === "stale-running"
        ? "Needs recovery"
        : workflowRuntimeStatus?.status === "awaiting-approval"
          ? "Awaiting approval"
          : workflowRuntimeStatus?.status === "paused"
            ? "Paused"
            : workflowRuntimeStatus?.status === "blocked"
              ? "Blocked"
              : workflowRuntimeStatus?.status === "completed"
                ? "Completed"
                : workflowRunStateLabel(workflow, activeProject.record.identity.kind, workflowPendingApprovals.length > 0, autopilotEnabled, workflowObjective)
    : "Running automatically";
  const activeStageGuidance = workflow ? workflowStageGuidance(workflow.workflowStage) : null;
  const workflowLead = workflow
    ? workflowRuntimeStatus?.status === "recovering"
      ? "Workflow recovery is running in the background."
      : workflowRuntimeStatus?.status === "starting-agent"
        ? "The next workflow agent is starting in the background."
      : workflowRuntimeStatus?.status === "stale-running"
      ? "Previous workflow run is detached. Continue from saved state or clear the stale running lock."
      : workflowPauseRequested
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
  const repositoryTreeBusy = repositoryData.loading ||
    repositoryData.searchLoading ||
    Object.values(repositoryData.loadingParents).some(Boolean);

  const scheduleWorkspaceTabPersist = (projectId: string, tab: WorkspaceVisualTabId) => {
    tabLayoutPersistRequestRef.current = { projectId, tab };
    if (tabLayoutPersistTimerRef.current !== undefined) {
      window.clearTimeout(tabLayoutPersistTimerRef.current);
    }

    tabLayoutPersistTimerRef.current = window.setTimeout(() => {
      tabLayoutPersistTimerRef.current = undefined;
      const request = tabLayoutPersistRequestRef.current;
      tabLayoutPersistRequestRef.current = undefined;
      if (!request) {
        return;
      }

      void window.workbench.updateLayout(request.projectId, { activeCenterTab: request.tab }).catch(handleError);
    }, 750);
  };

  const setWorkspaceTab = (tab: WorkspaceVisualTabId) => {
    if (!activeProject) {
      return;
    }

    setActiveWorkspaceTabOverride(tab);
    scheduleWorkspaceTabPersist(activeProject.record.id, tab);
  };

  useEffect(() => {
    visualExportReadinessRef.current = {
      activeProjectId,
      activeWorkspaceTab,
      logFeedProjectId: logFeed.projectId,
      logFeedLoading: logFeed.loading,
      repositoryProjectId: repositoryData.projectId,
      repositoryLoading: repositoryTreeBusy,
      historyProjectId: historyData.projectId,
      historyLoading: historyData.loading,
      workflowAgentPageLoading: workflowAgentPage.loading,
      manualAgentPageLoading: manualAgentPage.loading
    };
  }, [
    activeProjectId,
    activeWorkspaceTab,
    historyData.loading,
    historyData.projectId,
    logFeed.loading,
    logFeed.projectId,
    repositoryData.projectId,
    repositoryTreeBusy,
    manualAgentPage.loading,
    workflowAgentPage.loading
  ]);

  useEffect(() => {
    if (selectedWorkspaceTab !== "workflow") {
      setWorkflowDetailsMounted(false);
    }
  }, [selectedWorkspaceTab]);

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
    setGoalCharterDraft(goalCharterDraftFromWorkflow(activeProject?.record.workflow));
  }, [activeProject?.record.id, activeProject?.record.workflow]);

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
    setRepositorySummaryModel((current) => current && availableModels.some((model) => model.model === current) ? current : recommendedModel);
    setRepositorySummaryReasoningEffort((current) =>
      resolveAgentReasoningEffort(
        modelOptionsByName.get(repositorySummaryModel || recommendedModel),
        "manual",
        selectedFile ? `Repository path summary: ${selectedFile}` : "Repository path summary",
        "manual",
        current
      )
    );
    if (!interfaceCreationConfiguredAt) {
      setShowSettings(true);
    }
  }, [
    availableModels,
    interfaceCreationConfiguredAt,
    manualAgentModel,
    manualAgentPrompt,
    modelOptionsByName,
    recommendedModel,
    repositorySummaryModel,
    selectedFile,
    stateLoaded
  ]);

  useEffect(() => {
    setManualAgentPrompt("");
    setCustomRecommendationPrompt("");
    setRepositoryQuestionDraft("");
  }, [activeProject?.record.id]);

  useEffect(() => {
    setRepositoryQuestionDraft("");
  }, [selectedFile]);

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
      setActiveWorkspaceTabOverride(undefined);
      setRepositoryData(emptyRepositoryData());
      setRepositoryScanStatus(null);
      setRepositoryScanLimits(null);
      setHistoryData(emptyHistoryData());
      setAgentOutputViewer(undefined);
      return;
    }

    setTreeFilterDraft(storedTreeFilter);
    setFocusedAgentId(storedActiveAgentId);
  }, [activeProjectId, storedActiveAgentId, storedTreeFilter]);

  useEffect(() => {
    if (tabLayoutPersistTimerRef.current !== undefined) {
      window.clearTimeout(tabLayoutPersistTimerRef.current);
      tabLayoutPersistTimerRef.current = undefined;
    }
    tabLayoutPersistRequestRef.current = undefined;
    setWorkflowAgentPageIndex(0);
    setManualAgentPageIndex(0);
    setActivityLogPageIndex(0);
    setCommandLogPageIndex(0);
    setAgentDetail(undefined);
    setActiveWorkspaceTabOverride(activeProjectId ? "overview" : undefined);
    setRepositoryData(emptyRepositoryData());
    setRepositoryScanStatus(null);
    setRepositoryScanLimits(null);
    setHistoryData(emptyHistoryData());
    setAgentOutputViewer(undefined);
  }, [activeProjectId]);

  useEffect(() => {
    if (!activeProjectId || activeWorkspaceTab !== "runs") {
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
    if (!activeProjectId || activeWorkspaceTab !== "runs") {
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
    const agentId = focusedAgentId ?? runsPageAgents[0]?.id ?? activeAgent?.id;
    if (!activeProjectId || activeWorkspaceTab !== "runs" || !agentId) {
      setAgentDetail(undefined);
      return;
    }

    let cancelled = false;
    void window.workbench.getAgent(activeProjectId, agentId)
      .then((agent) => {
        if (!cancelled) {
          setAgentDetail(agent);
        }
      })
      .catch(handleError);

    return () => {
      cancelled = true;
    };
  }, [activeAgent?.id, activeProjectId, activeWorkspaceTab, agentHistoryVersion, focusedAgentId, runsPageAgents]);

  useEffect(() => {
    if (!activeProjectId) {
      return;
    }
    if (repositoryData.projectId === activeProjectId) {
      return;
    }

    let cancelled = false;
    setRepositoryData((current) => ({
      ...emptyRepositoryData(),
      projectId: activeProjectId,
      childrenByParent: current.projectId === activeProjectId ? current.childrenByParent : {},
      expandedPaths: current.projectId === activeProjectId ? current.expandedPaths : [],
      loading: true
    }));
    void window.workbench.getRepositorySummary(activeProjectId)
      .then((summary) => {
        if (!cancelled) {
          setRepositoryData({
            ...summary,
            childrenByParent: {
              [REPOSITORY_ROOT_PARENT]: summary.rootChildren
            },
            expandedPaths: [],
            loadingParents: {},
            searchResults: null,
            searchLoading: false,
            treeError: undefined,
            loading: false
          });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setRepositoryData((current) => ({ ...current, loading: false, treeError: error instanceof Error ? error.message : String(error) }));
        }
        handleError(error);
      });

    return () => {
      cancelled = true;
    };
  }, [activeProjectId, repositoryData.projectId]);

  useEffect(() => {
    if (!activeProjectId) {
      return;
    }

    let cancelled = false;
    void Promise.all([
      window.workbench.getRepositoryScanStatus(activeProjectId),
      window.workbench.getRepositoryScanLimits(activeProjectId)
    ])
      .then(([status, limits]) => {
        if (!cancelled) {
          setRepositoryScanStatus(status);
          setRepositoryScanLimits(limits);
        }
      })
      .catch(handleError);

    return () => {
      cancelled = true;
    };
  }, [activeProjectId, repositoryData.projectId]);

  useEffect(() => {
    const launch = repositoryLaunchRef.current;
    if (!stateLoaded || !launch.projectId || activeProjectId === launch.projectId || launch.openingProject) {
      return;
    }

    launch.openingProject = true;
    void window.workbench.openProject(launch.projectId)
      .catch(handleError)
      .finally(() => {
        launch.openingProject = false;
      });
  }, [activeProjectId, stateLoaded]);

  useEffect(() => {
    const launch = repositoryLaunchRef.current;
    if (
      !launch.projectId ||
      !launch.path ||
      launch.pathApplied ||
      activeProjectId !== launch.projectId ||
      repositoryData.projectId !== activeProjectId ||
      repositoryData.loading
    ) {
      return;
    }

    launch.pathApplied = true;
    setActiveWorkspaceTabOverride("repository");
    void revealRepositoryPathRef.current(launch.path);
  }, [activeProjectId, repositoryData.loading, repositoryData.projectId]);

  useEffect(() => {
    if (!activeProject || repositoryData.projectId !== activeProject.record.id) {
      return;
    }

    setRepositoryData((current) => {
      if (
        current.projectId !== activeProject.record.id ||
        (current.summaryCache === activeProject.record.summaryCache && current.summaryCacheTotal === activeProject.record.summaryCache.length)
      ) {
        return current;
      }
      return {
        ...current,
        summaryCache: activeProject.record.summaryCache,
        summaryCacheTotal: activeProject.record.summaryCache.length
      };
    });
  }, [activeProject, repositoryData.projectId]);

  useEffect(() => {
    if (!activeProject || !selectedFile) {
      return;
    }
    const cachedSummary = activeProject.record.summaryCache.find((summary) => summary.relativePath === selectedFile);
    if (cachedSummary && cachedSummary.generatedAt !== fileSummary?.generatedAt) {
      setFileSummary(cachedSummary);
    }
  }, [activeProject, fileSummary?.generatedAt, selectedFile]);

  const loadRepositoryChildren = (parentPath: string, cursor?: string) => {
    if (!activeProjectId) {
      return Promise.resolve();
    }
    const projectId = activeProjectId;
    setRepositoryData((current) => ({
      ...current,
      loadingParents: {
        ...current.loadingParents,
        [parentPath]: true
      },
      treeError: undefined
    }));
    return window.workbench.listRepositoryChildren(projectId, parentPath, { cursor, limit: REPOSITORY_TREE_PAGE_SIZE })
      .then((page) => {
        setRepositoryData((current) =>
          current.projectId === projectId
            ? mergeRepositoryChildrenPage(current, page, Boolean(cursor))
            : current
        );
      })
      .catch((error) => {
        setRepositoryData((current) => ({
          ...current,
          loadingParents: {
            ...current.loadingParents,
            [parentPath]: false
          },
          treeError: error instanceof Error ? error.message : String(error)
        }));
        handleError(error);
      });
  };

  const toggleRepositoryDirectory = (relativePath: string) => {
    const isExpanded = repositoryData.expandedPaths.includes(relativePath);
    setRepositoryData((current) => ({
      ...current,
      expandedPaths: isExpanded
        ? current.expandedPaths.filter((pathName) => pathName !== relativePath)
        : [...current.expandedPaths, relativePath]
    }));
    if (!isExpanded && !repositoryData.childrenByParent[relativePath] && !repositoryData.loadingParents[relativePath]) {
      void loadRepositoryChildren(relativePath);
    }
  };

  const loadMoreRepositoryChildren = (relativePath: string) => {
    const page = repositoryData.childrenByParent[relativePath];
    if (!page?.nextCursor || repositoryData.loadingParents[relativePath]) {
      return;
    }
    void loadRepositoryChildren(relativePath, page.nextCursor);
  };

  const revealRepositoryPath = async (relativePath: string) => {
    const parentDirectories = repositoryPathParentDirectories(relativePath);
    setRepositoryData((current) => ({
      ...current,
      expandedPaths: [...new Set([...current.expandedPaths, ...parentDirectories])]
    }));

    for (const parentPath of parentDirectories) {
      if (!repositoryData.childrenByParent[parentPath] && !repositoryData.loadingParents[parentPath]) {
        await loadRepositoryChildren(parentPath);
      }
    }

    await loadSummary(relativePath);
  };
  revealRepositoryPathRef.current = revealRepositoryPath;

  const selectRepositorySearchResult = (requestedIndex: number) => {
    const results = repositoryData.searchResults?.results ?? [];
    if (!results.length) {
      return;
    }
    const nextIndex = ((requestedIndex % results.length) + results.length) % results.length;
    setRepositorySearchResultIndex(nextIndex);
    void revealRepositoryPath(results[nextIndex].path);
  };

  useEffect(() => {
    if (!activeProjectId || activeWorkspaceTab !== "repository") {
      return;
    }

    const query = deferredTreeFilter.trim();
    if (!query) {
      setRepositorySearchResultIndex(0);
      setRepositoryData((current) => ({
        ...current,
        searchResults: null,
        searchLoading: false
      }));
      return;
    }

    const projectId = activeProjectId;
    let cancelled = false;
    setRepositoryData((current) => ({
      ...current,
      searchLoading: true,
      searchResults: current.searchResults?.query === query ? current.searchResults : null,
      treeError: undefined
    }));
    const timeoutId = window.setTimeout(() => {
      void window.workbench.searchRepositoryFiles(projectId, query, { limit: REPOSITORY_SEARCH_RESULT_LIMIT })
        .then((results) => {
          if (!cancelled) {
            setRepositorySearchResultIndex(0);
            setRepositoryData((current) => current.projectId === projectId
              ? { ...current, searchResults: results, searchLoading: false }
              : current);
            if (results.results[0]) {
              void revealRepositoryPathRef.current(results.results[0].path);
            }
          }
        })
        .catch((error) => {
          if (!cancelled) {
            setRepositoryData((current) => ({
              ...current,
              searchLoading: false,
              treeError: error instanceof Error ? error.message : String(error)
            }));
          }
          handleError(error);
        });
    }, 220);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [activeProjectId, activeWorkspaceTab, deferredTreeFilter]);

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
    if (!activeProjectId || activeWorkspaceTab !== "history") {
      return;
    }

    const projectId = activeProjectId;
    let cancelled = false;
    setHistoryData((current) => ({
      ...(current.projectId === projectId ? current : emptyHistoryData()),
      projectId,
      loading: true,
      error: undefined
    }));
    void window.workbench.listWorkflowCycles(projectId, { limit: HISTORY_RECENT_CYCLE_LIMIT })
      .then((page) => {
        if (!cancelled) {
          setHistoryData((current) => ({
            ...current,
            ...page,
            loading: false,
            error: undefined,
            expandedCycleIds: current.projectId === projectId ? current.expandedCycleIds.filter((cycleId) => page.cycles.some((cycle) => cycle.id === cycleId)) : [],
            detailsByCycleId: current.projectId === projectId ? current.detailsByCycleId : {},
            agentsByCycleId: current.projectId === projectId ? current.agentsByCycleId : {}
          }));
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setHistoryData((current) => ({
            ...current,
            projectId,
            loading: false,
            error: error instanceof Error ? error.message : String(error)
          }));
        }
        handleError(error);
      });

    return () => {
      cancelled = true;
    };
  }, [activeProjectId, activeWorkspaceTab, agentHistoryVersion]);

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
      repositoryData.summaryCache
        .slice()
        .sort((left, right) => {
          if (left.source === right.source) {
            return left.relativePath.localeCompare(right.relativePath);
          }
          return left.source === "hybrid" || left.source === "codex" ? -1 : 1;
        })
        .slice(0, 10),
    [repositoryData.summaryCache]
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

  const loadMoreHistoryCycles = () => {
    if (!activeProjectId || !historyData.nextCursor || historyData.loading) {
      return;
    }

    const projectId = activeProjectId;
    const cursor = historyData.nextCursor;
    setHistoryData((current) => ({ ...current, loading: true, error: undefined }));
    void window.workbench.listWorkflowCycles(projectId, { cursor, limit: HISTORY_OLDER_CYCLE_PAGE_SIZE })
      .then((page) => {
        setHistoryData((current) => current.projectId === projectId
          ? {
            ...current,
            cursor: page.cursor,
            nextCursor: page.nextCursor,
            limit: page.limit,
            total: page.total,
            recentPreloaded: page.recentPreloaded,
            cycles: [...current.cycles, ...page.cycles.filter((cycle) => !current.cycles.some((existing) => existing.id === cycle.id))],
            loading: false,
            error: undefined
          }
          : current);
      })
      .catch((error) => {
        setHistoryData((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : String(error) }));
        handleError(error);
      });
  };

  const toggleHistoryCycle = (cycle: WorkflowCycleSummaryView) => {
    if (!activeProjectId) {
      return;
    }

    const projectId = activeProjectId;
    const isExpanded = historyData.expandedCycleIds.includes(cycle.id);
    setHistoryData((current) => ({
      ...current,
      expandedCycleIds: isExpanded
        ? current.expandedCycleIds.filter((cycleId) => cycleId !== cycle.id)
        : [...current.expandedCycleIds, cycle.id],
      agentsByCycleId: isExpanded || current.agentsByCycleId[cycle.id]
        ? current.agentsByCycleId
        : {
          ...current.agentsByCycleId,
          [cycle.id]: { loading: true, total: 0, agents: [] }
        }
    }));

    if (isExpanded || (historyData.detailsByCycleId[cycle.id] && historyData.agentsByCycleId[cycle.id])) {
      return;
    }

    void Promise.all([
      window.workbench.getWorkflowCycle(projectId, cycle.id),
      window.workbench.listCycleAgents(projectId, cycle.id)
    ])
      .then(([detail, agents]) => {
        setHistoryData((current) => current.projectId === projectId
          ? {
            ...current,
            detailsByCycleId: {
              ...current.detailsByCycleId,
              [cycle.id]: detail
            },
            agentsByCycleId: {
              ...current.agentsByCycleId,
              [cycle.id]: {
                loading: false,
                total: agents.total,
                agents: agents.agents
              }
            }
          }
          : current);
      })
      .catch((error) => {
        setHistoryData((current) => ({
          ...current,
          agentsByCycleId: {
            ...current.agentsByCycleId,
            [cycle.id]: {
              loading: false,
              total: current.agentsByCycleId[cycle.id]?.total ?? 0,
              agents: current.agentsByCycleId[cycle.id]?.agents ?? [],
              error: error instanceof Error ? error.message : String(error)
            }
          }
        }));
        handleError(error);
      });
  };

  const loadAgentTranscript = () => {
    if (!agentOutputViewer || agentOutputViewer.transcript || agentOutputViewer.transcriptLoading) {
      return;
    }

    const { projectId, agentId } = agentOutputViewer;
    setAgentOutputViewer((current) => current?.projectId === projectId && current.agentId === agentId
      ? { ...current, transcriptLoading: true, error: undefined }
      : current);
    void window.workbench.getAgentTranscript(projectId, agentId)
      .then((transcript) => {
        setAgentOutputViewer((current) => current?.projectId === projectId && current.agentId === agentId
          ? {
            ...current,
            transcript,
            transcriptLoading: false,
            error: undefined
          }
          : current);
      })
      .catch((error) => {
        setAgentOutputViewer((current) => current?.projectId === projectId && current.agentId === agentId
          ? {
            ...current,
            transcriptLoading: false,
            error: error instanceof Error ? error.message : String(error)
          }
          : current);
        handleError(error);
      });
  };

  const openAgentOutputById = (agent: Pick<AgentState, "id" | "name">, options: { loadTranscript?: boolean } = {}) => {
    if (!activeProjectId) {
      return;
    }

    const projectId = activeProjectId;
    setAgentOutputViewer({
      projectId,
      agentId: agent.id,
      agentName: agent.name,
      loading: true,
      transcriptLoading: Boolean(options.loadTranscript),
      query: "",
      wrap: true,
      viewMode: "preformatted"
    });
    void window.workbench.getAgentFullOutput(projectId, agent.id)
      .then((output) => {
        setAgentOutputViewer((current) => current?.projectId === projectId && current.agentId === agent.id
          ? {
            ...current,
            loading: false,
            output,
            error: undefined
          }
          : current);
      })
      .catch((error) => {
        setAgentOutputViewer((current) => current?.projectId === projectId && current.agentId === agent.id
          ? {
            ...current,
            loading: false,
            error: error instanceof Error ? error.message : String(error)
          }
          : current);
        handleError(error);
      });
    if (options.loadTranscript) {
      void window.workbench.getAgentTranscript(projectId, agent.id)
        .then((transcript) => {
          setAgentOutputViewer((current) => current?.projectId === projectId && current.agentId === agent.id
            ? {
              ...current,
              transcript,
              transcriptLoading: false,
              error: undefined
            }
            : current);
        })
        .catch((error) => {
          setAgentOutputViewer((current) => current?.projectId === projectId && current.agentId === agent.id
            ? {
              ...current,
              transcriptLoading: false,
              error: error instanceof Error ? error.message : String(error)
            }
            : current);
          handleError(error);
        });
    }
  };

  const openAgentOutput = (agent: AgentHistorySummary, options: { loadTranscript?: boolean } = {}) => {
    openAgentOutputById(agent, options);
  };

  const rescanRepository = async (mode: "normal" | "deep", settings?: RepositoryScanSettings) => {
    if (!activeProject) {
      return;
    }

    const projectId = activeProject.record.id;
    try {
      setRepositoryRescanBusy(mode);
      setNotice(undefined);
      if (mode === "deep" && settings) {
        setRepositoryScanLimits(await window.workbench.updateRepositoryScanSettings(projectId, settings));
      }
      const summary = await window.workbench.rescanRepository(projectId, { mode, settings });
      setRepositoryData({
        ...summary,
        childrenByParent: {
          [REPOSITORY_ROOT_PARENT]: summary.rootChildren
        },
        expandedPaths: [],
        loadingParents: {},
        searchResults: null,
        searchLoading: false,
        treeError: undefined,
        loading: false
      });
      setRepositoryScanStatus(await window.workbench.getRepositoryScanStatus(projectId));
      setRepositoryScanLimits(await window.workbench.getRepositoryScanLimits(projectId));
      showInfoNotice(mode === "deep" ? "Deep repository scan completed." : "Repository rescan completed.");
    } catch (error) {
      handleError(error);
    } finally {
      setRepositoryRescanBusy(undefined);
    }
  };

  const checkCodexUpdate = async () => {
    try {
      setCodexUpdateBusy(true);
      setNotice(undefined);
      const result = await window.workbench.checkCodexUpdate();
      setNotice({
        message: result.message,
        tone: result.status === "unavailable" ? "error" : "info"
      });
    } catch (error) {
      handleError(error);
    } finally {
      setCodexUpdateBusy(false);
    }
  };

  const refreshCodexReadiness = async () => {
    try {
      setCodexUpdateBusy(true);
      setNotice(undefined);
      const result = await window.workbench.refreshCodexReadiness();
      setNotice({
        message: result.message,
        tone: result.status === "unavailable" ? "error" : "info"
      });
    } catch (error) {
      handleError(error);
    } finally {
      setCodexUpdateBusy(false);
    }
  };

  const runCodexUpdate = async (approvedCommand?: string) => {
    try {
      setCodexUpdateBusy(true);
      setNotice(undefined);
      const result = await window.workbench.runCodexUpdate(approvedCommand);
      setNotice({
        message: result.message,
        tone: result.status === "failed" ? "error" : "info"
      });
    } catch (error) {
      handleError(error);
    } finally {
      setCodexUpdateBusy(false);
    }
  };

  const codexUpdateForPrompt = state?.codexUpdate;
  runCodexUpdateRef.current = runCodexUpdate;

  useEffect(() => {
    const update = codexUpdateForPrompt;
    const updateCommand = update?.updateCommand;
    if (!update?.updateAvailable || !updateCommand || codexUpdateBusy) {
      return;
    }
    if (promptedCodexUpdateCommandsRef.current.has(updateCommand)) {
      return;
    }
    promptedCodexUpdateCommandsRef.current.add(updateCommand);

    const versionLabel = update.latestVersion ? ` to ${update.latestVersion}` : "";
    const currentLabel = update.currentVersion ? ` from ${update.currentVersion}` : "";
    const approved = window.confirm(`A Codex CLI update${versionLabel} is available${currentLabel}.\n\nRun this command now?\n\n${updateCommand}`);
    if (approved) {
      void runCodexUpdateRef.current(updateCommand);
    }
  }, [
    codexUpdateBusy,
    codexUpdateForPrompt
  ]);

  const refreshGitHubStatus = async () => {
    try {
      setNotice(undefined);
      await window.workbench.refreshGitHubStatus();
      showInfoNotice("GitHub status refreshed.");
    } catch (error) {
      handleError(error);
    }
  };

  const openFolder = async (
    intent: ProjectLoadIntent = "open",
    creationMode: ProjectCreationMode = projectCreationMode
  ) => {
    try {
      const folder = await window.workbench.chooseFolder(
        intent === "create"
          ? {
            title: "Select the folder to use for this workspace",
            buttonLabel: creationMode === "initialize_github" ? "Create workspace here" : "Use this folder",
            message: creationMode === "initialize_github"
              ? "Choose the project folder. The workbench will initialize a GitHub SSH repository there if needed."
              : "Choose the project folder. The workbench will scan and use it without creating a GitHub repository."
          }
          : {
            title: "Select a GitHub repository folder",
            buttonLabel: "Open repository",
            message: "Choose an existing GitHub-backed repository folder to open in this window."
          }
      );
      if (!folder) {
        return;
      }
      setProjectLoadBusy(intent);
      setLaunchIntent(intent);
      setNotice(undefined);
      setShowExistingChoice(false);
      setFileSummary(null);
      setSelectedFile(undefined);
      setPendingLoad(await window.workbench.loadProject(folder, intent, creationMode));
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
      showInfoNotice(`Saved review logs to ${exportPath}. Paths and common secret-looking values were redacted.`);
    } catch (error) {
      handleError(error);
    }
  };

  const waitForVisualTabReady = async (projectId: string, tab: VisualExportTab) => {
    await waitForVisualCondition(
      () => {
        const readiness = visualExportReadinessRef.current;
        return readiness.activeProjectId === projectId && readiness.activeWorkspaceTab === tab.id;
      },
      `${tab.label} tab to render`
    );
    await waitForVisualRender();

    if (tab.id === "history" || tab.id === "logs" || tab.id === "runs" || tab.id === "repository") {
      await delay(250);
      await waitForVisualCondition(
        () => {
          const readiness = visualExportReadinessRef.current;
          if (readiness.activeProjectId !== projectId || readiness.activeWorkspaceTab !== tab.id) {
            return false;
          }
          if (tab.id === "logs") {
            return !readiness.logFeedLoading && readiness.logFeedProjectId === projectId;
          }
          if (tab.id === "repository") {
            return !readiness.repositoryLoading && readiness.repositoryProjectId === projectId;
          }
          if (tab.id === "history") {
            return !readiness.historyLoading && readiness.historyProjectId === projectId;
          }
          return !readiness.workflowAgentPageLoading && !readiness.manualAgentPageLoading;
        },
        `${tab.label} tab data to load`
      );
    }

    window.scrollTo(0, 0);
    await waitForVisualRender();
  };

  const extractVisuals = async () => {
    if (!activeProject || visualExtractBusy) {
      return;
    }

    const projectId = activeProject.record.id;
    const originalTab = selectedWorkspaceTab;
    const originalScrollY = window.scrollY;
    let exportId: string | undefined;

    try {
      setVisualExtractBusy(true);
      setNotice(undefined);
      const session = await window.workbench.startVisualExport(projectId, WORKSPACE_VISUAL_TABS);
      if (!session) {
        return;
      }
      exportId = session.exportId;

      for (const tab of WORKSPACE_VISUAL_TABS) {
        setActiveWorkspaceTabOverride(tab.id);
        await window.workbench.updateLayout(projectId, { activeCenterTab: tab.id });
        await waitForVisualTabReady(projectId, tab);
        const captureTargets = buildVisualExportCaptureTargets(tab, getVisualExportScrollMetrics());
        for (const target of captureTargets) {
          window.scrollTo(0, target.scrollY);
          await waitForVisualRender();
          await window.workbench.captureVisualExportPage(exportId, target);
        }
      }

      const exportPath = await window.workbench.finishVisualExport(exportId);
      exportId = undefined;
      showInfoNotice(`Saved interface visuals PDF to ${exportPath}.`);
    } catch (error) {
      if (exportId) {
        await window.workbench.cancelVisualExport(exportId).catch(() => undefined);
      }
      handleError(error);
    } finally {
      setVisualExtractBusy(false);
      if (visualExportReadinessRef.current.activeProjectId === projectId) {
        setActiveWorkspaceTabOverride(originalTab);
        await window.workbench.updateLayout(projectId, { activeCenterTab: originalTab }).catch(() => undefined);
        await waitForVisualRender();
        window.scrollTo(0, originalScrollY);
      }
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

  const generateRepositoryPathSummary = async () => {
    if (!activeProject || !selectedFile || !repositorySummaryModel) {
      return;
    }

    try {
      setNotice(undefined);
      setRepositoryPathActionBusy({ path: selectedFile, action: "summary" });
      const agent = await window.workbench.summarizeRepositoryPath(
        activeProject.record.id,
        selectedFile,
        repositorySummaryModel,
        repositorySummaryReasoningMode,
        repositorySummaryReasoningEffort
      );
      setFocusedAgentId(agent.id);
      showInfoNotice(`Summary agent started for ${selectedFile}.`);
    } catch (error) {
      handleError(error);
    } finally {
      setRepositoryPathActionBusy((current) => current?.path === selectedFile && current.action === "summary" ? undefined : current);
    }
  };

  const askRepositoryPathQuestion = async () => {
    if (!activeProject || !selectedFile || !repositorySummaryModel || !repositoryQuestionDraft.trim()) {
      return;
    }

    try {
      setNotice(undefined);
      setRepositoryPathActionBusy({ path: selectedFile, action: "question" });
      await window.workbench.openRepositoryPathWindow(activeProject.record.id, selectedFile, repositoryQuestionDraft.trim());
      setRepositoryQuestionDraft("");
      showInfoNotice(`Opened chat for ${selectedFile}.`);
    } catch (error) {
      handleError(error);
    } finally {
      setRepositoryPathActionBusy((current) => current?.path === selectedFile && current.action === "question" ? undefined : current);
    }
  };

  const openRepositoryPathWindow = async () => {
    if (!activeProject || !selectedFile) {
      return;
    }

    try {
      setNotice(undefined);
      setRepositoryPathActionBusy({ path: selectedFile, action: "window" });
      await window.workbench.openRepositoryPathWindow(activeProject.record.id, selectedFile);
    } catch (error) {
      handleError(error);
    } finally {
      setRepositoryPathActionBusy((current) => current?.path === selectedFile && current.action === "window" ? undefined : current);
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

    if (state?.runtimeReadiness.blockAgentActions) {
      setNotice({ message: state.runtimeReadiness.summary, tone: "error" });
      setWorkspaceTab("settings");
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

    if (state?.runtimeReadiness.blockAgentActions) {
      setNotice({ message: state.runtimeReadiness.summary, tone: "error" });
      setWorkspaceTab("settings");
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

  const runWorkflowCommand = async (command: string, task: () => Promise<void>): Promise<boolean> => {
    const projectId = activeProject?.record.id;
    if (!projectId) {
      return false;
    }

    if (workflowCommandBusyRef.current?.startsWith(`${projectId}:`)) {
      return false;
    }

    if (AGENT_BACKED_WORKFLOW_COMMANDS.has(command) && state?.runtimeReadiness.blockAgentActions) {
      setNotice({ message: state.runtimeReadiness.summary, tone: "error" });
      setWorkspaceTab("settings");
      return false;
    }

    const busyKey = `${projectId}:${command}`;
    workflowCommandBusyRef.current = busyKey;
    setWorkflowCommandBusyKey(busyKey);
    try {
      await task();
      return true;
    } catch (error) {
      handleError(error);
      return false;
    } finally {
      if (workflowCommandBusyRef.current === busyKey) {
        workflowCommandBusyRef.current = undefined;
        setWorkflowCommandBusyKey(undefined);
      }
    }
  };

  const runRecommendation = async (customFocus?: string) => {
    if (!activeProject) {
      return;
    }

    await runWorkflowCommand("run-recommendation", async () => {
      setNotice(undefined);
      await window.workbench.runRecommendation(activeProject.record.id, customFocus?.trim() || undefined);
    });
  };

  const toggleAutopilot = async () => {
    if (!activeProject) {
      return;
    }

    try {
      setNotice(undefined);
      await window.workbench.setAutopilotPolicy(activeProject.record.id, {
        enabled: !autopilotEnabled
      });
      showInfoNotice(!autopilotEnabled ? "Autopilot enabled." : "Autopilot disabled.");
    } catch (error) {
      handleError(error);
    }
  };

  const setAutopilotProfile = async (profile: AutopilotProfile) => {
    if (!activeProject) {
      return;
    }

    try {
      setNotice(undefined);
      await window.workbench.setAutopilotPolicy(activeProject.record.id, {
        profile
      });
      showInfoNotice(`Autopilot profile set to ${autopilotProfileLabel(profile)}.`);
    } catch (error) {
      handleError(error);
    }
  };

  const updateAutopilotPolicy = async (patch: Partial<AutopilotPolicy>) => {
    if (!activeProject) {
      return;
    }

    try {
      setNotice(undefined);
      await window.workbench.setAutopilotPolicy(activeProject.record.id, patch);
      if (patch.profile === "custom") {
        showInfoNotice("Custom autopilot settings saved.");
      }
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

  const toggleWorkflowMode = async () => {
    if (!activeProject) {
      return;
    }

    try {
      const nextMode = fastModeEnabled ? "normal" : "fast";
      setNotice(undefined);
      await window.workbench.setWorkflowMode(activeProject.record.id, nextMode);
      showInfoNotice(
        nextMode === "fast"
          ? "Fast Mode enabled. Future safe workflow transitions will prefer larger coherent work packages."
          : "Normal Mode enabled. Future safe workflow transitions will use review-oriented scoping."
      );
    } catch (error) {
      handleError(error);
    }
  };

  const requestWorkflowPreview = async () => {
    if (!activeProject) {
      return;
    }

    try {
      setNotice(undefined);
      await window.workbench.requestWorkflowPreview(activeProject.record.id);
      showInfoNotice("Preview generation queued.");
    } catch (error) {
      handleError(error);
    }
  };

  const cancelWorkflowPreview = async () => {
    if (!activeProject) {
      return;
    }

    try {
      setNotice(undefined);
      await window.workbench.cancelWorkflowPreview(activeProject.record.id);
      showInfoNotice("Preview request cancelled.");
    } catch (error) {
      handleError(error);
    }
  };

  const completeWorkflowPreview = async () => {
    if (!activeProject) {
      return;
    }

    await runWorkflowCommand("complete-preview", async () => {
      setNotice(undefined);
      await window.workbench.completeWorkflowPreview(activeProject.record.id);
      showInfoNotice("Preview checkpoint completed. Workflow resumed.");
    });
  };

  const continueWorkflow = async () => {
    if (!activeProject) {
      return;
    }

    await runWorkflowCommand("continue", async () => {
      setNotice(undefined);
      if (previewStatus === "ready") {
        await window.workbench.completeWorkflowPreview(activeProject.record.id);
        showInfoNotice("Preview checkpoint completed. Workflow resumed.");
        return;
      }
      if (workflowRecoveryAvailable) {
        await window.workbench.recoverWorkflow(activeProject.record.id);
        showInfoNotice("Workflow recovery started from the saved state.");
        return;
      }
      if (autopilotStatus?.pausedReason) {
        if (
          autopilotStatus.pausedReason === "high_risk_package_requires_approval" &&
          autopilotStatus.currentRecommendationId
        ) {
          await window.workbench.advanceWorkflowStage(activeProject.record.id);
          showInfoNotice("Approved or refreshed the checkpointed package. Workflow automation continued.");
          return;
        }
        await window.workbench.updateUiState(activeProject.record.id, {
          workflowPauseRequested: false
        });
        showInfoNotice("Workflow automation continued from the saved state.");
        return;
      }
      if (workflowRuntimeStatus?.canContinue && workflowRuntimeStatus.status === "idle") {
        await window.workbench.advanceWorkflowStage(activeProject.record.id);
        showInfoNotice("Workflow automation continued from the saved state.");
        return;
      }
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
    });
  };

  const toggleWorkflowPause = async () => {
    if (!activeProject) {
      return;
    }

    await runWorkflowCommand("toggle-pause", async () => {
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
    });
  };

  const recoverWorkflow = async () => {
    if (!activeProject) {
      return;
    }

    await runWorkflowCommand("recover", async () => {
      setNotice(undefined);
      await window.workbench.recoverWorkflow(activeProject.record.id);
      showInfoNotice("Workflow recovery started from the saved state.");
    });
  };

  const clearStaleWorkflowLock = async () => {
    if (!activeProject) {
      return;
    }

    await runWorkflowCommand("clear-stale-lock", async () => {
      setNotice(undefined);
      await window.workbench.clearStaleWorkflowLock(activeProject.record.id);
      showInfoNotice("Stale workflow lock cleared. The saved workflow is paused and ready to continue.");
    });
  };

  const retryWorkflowGoal = async () => {
    if (!activeProject) {
      return;
    }

    const retryingMerge = isMergeConflictHandoff(activeProject.record.workflow);
    const retryingValidation = isEnvironmentRepairHandoff(activeProject.record.workflow);
    await runWorkflowCommand("retry-goal", async () => {
      setNotice(undefined);
      await window.workbench.retryWorkflowGoal(activeProject.record.id);
      showInfoNotice(
        retryingMerge
          ? "Retrying the merge after conflict resolution."
          : retryingValidation
          ? "Retrying validation after the environment fix."
          : "Retrying the current scoped goal."
      );
    });
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

  const updateGoalCharterDraft = (next: GoalCharterDraftUpdate) => setGoalCharterDraft((current) => ({
    ...current,
    ...next,
    autopilotStrategy: next.autopilotStrategy ? cloneStrategy(next.autopilotStrategy) : current.autopilotStrategy
  }));

  const applyAutopilotPreset = (preset: AutopilotPreset) => {
    setGoalCharterDraft((current) => ({
      ...current,
      autopilotStrategy: cloneStrategy(preset.strategy)
    }));
  };

  const polishGoalCharterField = async (field: GoalCharterDraftTextField) => {
    if (!activeProject || goalCharterAiBusy) {
      return;
    }
    const value = goalCharterDraft[field].trim();
    if (!value) {
      return;
    }
    if (!goalCharterAiModel) {
      setNotice({ message: "Choose an available model before using Pollish.", tone: "error" });
      setWorkspaceTab("settings");
      return;
    }

    try {
      setNotice(undefined);
      setGoalCharterAiBusy({ kind: "polish", field });
      const result = await window.workbench.polishGoalCharterField(activeProject.record.id, {
        field,
        value,
        currentDraft: goalCharterDraftAiPayload(goalCharterDraft),
        model: goalCharterAiModel,
        reasoningEffort: goalCharterAiReasoningEffort
      });
      setGoalCharterDraft((current) => ({
        ...current,
        [result.field]: result.value
      }));
      showInfoNotice("Pollished the Goal Charter field. Review before saving.");
    } catch (error) {
      handleError(error);
    } finally {
      setGoalCharterAiBusy(undefined);
    }
  };

  const generateGoalCharterDraft = async () => {
    if (!activeProject || goalCharterAiBusy) {
      return;
    }
    const prompt = goalCharterGeneratePrompt.trim();
    if (!prompt) {
      return;
    }
    if (!goalCharterAiModel) {
      setNotice({ message: "Choose an available model before generating a Goal Charter.", tone: "error" });
      setWorkspaceTab("settings");
      return;
    }

    try {
      setNotice(undefined);
      setGoalCharterAiBusy({ kind: "generate" });
      const result = await window.workbench.generateGoalCharterDraft(activeProject.record.id, {
        prompt,
        currentDraft: goalCharterDraftAiPayload(goalCharterDraft),
        model: goalCharterAiModel,
        reasoningEffort: goalCharterAiReasoningEffort
      });
      setGoalCharterDraft((current) => ({
        ...current,
        ...goalCharterDraftUpdateFromAi(result.draft)
      }));
      showInfoNotice("Generated a Goal Charter draft. Review and save it when it matches your intent.");
    } catch (error) {
      handleError(error);
    } finally {
      setGoalCharterAiBusy(undefined);
    }
  };

  const saveGoalCharter = async () => {
    if (!activeProject) {
      return;
    }

    const projectId = activeProject.record.id;
    const draft = goalCharterDraft;
    const goalSummary = draft.currentSummary.trim();
    try {
      setNotice(undefined);
      if (goalSummary) {
        await window.workbench.updateUltimateGoal(
          projectId,
          {
            summary: goalSummary,
            detailedIntent: draft.currentDetailedIntent.trim(),
            successCriteria: toLineList(draft.currentSuccessCriteria),
            constraints: toLineList(draft.currentConstraints),
            nonGoals: toLineList(draft.currentNonGoals),
            targetAudience: draft.currentTargetAudience.trim(),
            qualityBar: draft.currentQualityBar.trim(),
            source: "user"
          },
          true
        );
      }
      await window.workbench.updateGoalCharter(projectId, {
        nonNegotiableRequirements: toLineList(draft.nonNegotiableRequirements),
        flexibleRequirements: toLineList(draft.flexibleRequirements),
        niceToHaveIdeas: toLineList(draft.niceToHaveIdeas),
        explicitNonGoals: toLineList(draft.explicitNonGoals),
        userConstraints: toLineList(draft.userConstraints),
        aestheticPreferences: toLineList(draft.aestheticPreferences),
        technicalPreferences: toLineList(draft.technicalPreferences),
        definitionOfDone: toLineList(draft.definitionOfDone),
        autopilotStrategy: draft.autopilotStrategy
      });
      setUltimateGoalImportPreview(null);
      showInfoNotice("Goal Charter and Autopilot Strategy saved.");
    } catch (error) {
      handleError(error);
    }
  };

  const acceptGoalProposal = async (proposalId: string) => {
    if (!activeProject) {
      return;
    }

    try {
      setNotice(undefined);
      await window.workbench.acceptGoalChange(activeProject.record.id, proposalId);
      setUltimateGoalImportPreview(null);
      showInfoNotice("Goal proposal accepted.");
    } catch (error) {
      handleError(error);
    }
  };

  const rejectGoalProposal = async (proposalId: string) => {
    if (!activeProject) {
      return;
    }

    try {
      setNotice(undefined);
      await window.workbench.rejectGoalChange(activeProject.record.id, proposalId, "Rejected by the user.");
      setUltimateGoalImportPreview(null);
      showInfoNotice("Goal proposal rejected.");
    } catch (error) {
      handleError(error);
    }
  };

  const rejectDetectedGoal = async () => {
    if (!activeProject) {
      return;
    }

    const workflowState = activeProject.record.workflow;
    const draft = workflowState.ultimateGoalDraft;
    const charter = workflowState.goalCharter;
    const detectedProposal = charter.proposedGoalChanges.find((change) => change.source === "detected");
    if (!draft && !detectedProposal) {
      return;
    }

    const now = new Date().toISOString();
    const rejected: GoalChangeRecord = detectedProposal
      ? {
        ...detectedProposal,
        decidedAt: now,
        decisionNotes: "Rejected by the user."
      }
      : {
        id: `detected-goal-rejected-${Date.now()}`,
        title: "Rejected detected Ultimate Goal",
        summary: draft?.summary ?? "Detected Ultimate Goal rejected",
        rationale: "Auto-detected from repository evidence and rejected before confirmation.",
        source: "detected",
        proposedGoal: draft,
        toGoalSummary: draft?.summary,
        createdAt: draft?.lastUpdatedAt ?? now,
        decidedAt: now,
        decisionNotes: "Rejected by the user."
      };

    try {
      await window.workbench.updateGoalCharter(activeProject.record.id, {
        proposedGoalChanges: charter.proposedGoalChanges.filter((change) => change.id !== detectedProposal?.id && change.source !== "detected"),
        rejectedGoalChanges: [rejected, ...charter.rejectedGoalChanges].slice(0, 50)
      });
      setUltimateGoalImportPreview(null);
      showInfoNotice("Detected Ultimate Goal rejected.");
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

    await runWorkflowCommand("approve-recommendation", async () => {
      setNotice(undefined);
      await window.workbench.approveRecommendation(activeProject.record.id, recommendationId);
    });
  };

  const createScopedGoal = async () => {
    if (!activeProject) {
      return;
    }

    await runWorkflowCommand("create-scoped-goal", async () => {
      setNotice(undefined);
      await window.workbench.createScopedGoal(activeProject.record.id);
    });
  };

  const advanceWorkflowStage = async () => {
    if (!activeProject) {
      return;
    }

    await runWorkflowCommand("advance-stage", async () => {
      setNotice(undefined);
      await window.workbench.advanceWorkflowStage(activeProject.record.id);
    });
  };

  const runWorkflowIntegrity = async () => {
    if (!activeProject) {
      return;
    }

    await runWorkflowCommand("run-integrity", async () => {
      setNotice(undefined);
      await window.workbench.runIntegrity(activeProject.record.id);
    });
  };

  const runWorkflowMerge = async () => {
    if (!activeProject) {
      return;
    }

    await runWorkflowCommand("run-merge", async () => {
      setNotice(undefined);
      await window.workbench.runMerge(activeProject.record.id);
    });
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

  const openWorkflowRepairAgent = async () => {
    if (!activeProject) {
      return;
    }

    try {
      setRepairAgentLaunchBusy(true);
      setNotice(undefined);
      const result = await window.workbench.openWorkflowRepairAgent(activeProject.record.id);
      setNotice({ message: result.message, tone: result.launched ? "info" : "error" });
    } catch (error) {
      handleError(error);
    } finally {
      setRepairAgentLaunchBusy(false);
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

  const checkRuntimeReadiness = async () => {
    try {
      setRuntimeCheckBusy(true);
      setNotice(undefined);
      const report = await window.workbench.checkRuntimeReadiness();
      setNotice({
        message: report.summary,
        tone: report.blockAgentActions ? "error" : "info"
      });
    } catch (error) {
      handleError(error);
    } finally {
      setRuntimeCheckBusy(false);
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

  const updateSettingsDraft = (next: SettingsDraftUpdate) => setSettingsDraft((current) => {
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
  });

  const settingsDialog = showSettings && state ? (
    <SettingsDialog
      state={state}
      activeProject={activeProject}
      github={state.github}
      settingsDraft={settingsDraft}
      goalCharterDraft={goalCharterDraft}
      goalCharterAiModel={goalCharterAiModel}
      goalCharterAiReasoningEffort={goalCharterAiReasoningEffort}
      goalCharterGeneratePrompt={goalCharterGeneratePrompt}
      goalCharterAiBusy={goalCharterAiBusy}
      autopilotPresets={autopilotPresets}
      onChange={updateSettingsDraft}
      onGoalCharterChange={updateGoalCharterDraft}
      onGoalCharterAiModelChange={setGoalCharterAiModel}
      onGoalCharterAiReasoningEffortChange={setGoalCharterAiReasoningEffort}
      onGoalCharterGeneratePromptChange={setGoalCharterGeneratePrompt}
      onPolishGoalCharterField={(field) => void polishGoalCharterField(field)}
      onGenerateGoalCharterDraft={() => void generateGoalCharterDraft()}
      onSave={saveSettings}
      onSaveGoalCharter={() => void saveGoalCharter()}
      onApplyAutopilotPreset={applyAutopilotPreset}
      onDetectGoal={() => void detectUltimateGoal()}
      onRejectDetectedGoal={() => void rejectDetectedGoal()}
      onDownloadUltimateGoalFormat={downloadUltimateGoalFormat}
      onClose={() => setShowSettings(false)}
      onOpenDevTools={() => void openDevTools()}
      onRefreshGitHubStatus={() => void refreshGitHubStatus()}
      onCheckRuntimeReadiness={() => void checkRuntimeReadiness()}
      onRefreshCodexReadiness={() => void refreshCodexReadiness()}
      onCheckCodexUpdate={() => void checkCodexUpdate()}
      onRunCodexUpdate={(approvedCommand) => void runCodexUpdate(approvedCommand)}
      runtimeCheckBusy={runtimeCheckBusy}
      codexUpdateBusy={codexUpdateBusy}
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
          {state.runtimeReadiness.blockAgentActions ? (
            <RuntimeReadinessPanel
              report={state.runtimeReadiness}
              onRunChecks={() => void checkRuntimeReadiness()}
              onOpenSettings={() => setShowSettings(true)}
              busy={runtimeCheckBusy}
              compact
            />
          ) : null}
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
    const createModeTitle = createWorkspaceUsesGitHub ? "Initialize new GitHub repo" : "Use folder as-is";
    const createModeCopy = createWorkspaceUsesGitHub
      ? "Select a project folder and prepare it as an SSH-backed GitHub repository when needed."
      : "Select a project folder, scan it, and keep it local without creating or pushing a GitHub repository.";
    const createActionLabel = createWorkspaceUsesGitHub ? "Select Folder & Initialize GitHub" : "Select Folder & Use As-Is";

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
              <h2>Open a repository, create a workspace, or resume a recent project.</h2>
              <p className="hero-card__lead">
                Choose whether a new workspace should create a GitHub repository or use the selected folder exactly as it is.
              </p>
              <div className="workspace-create-mode" aria-label="New workspace creation mode">
                <div className="workspace-create-mode__header">
                  <span>New workspace mode</span>
                  <strong>{createModeTitle}</strong>
                </div>
                <div className="segmented-control">
                  <button
                    className={createWorkspaceUsesGitHub ? "segmented-control__button segmented-control__button--active" : "segmented-control__button"}
                    type="button"
                    onClick={() => setProjectCreationMode("initialize_github")}
                  >
                    Initialize GitHub Repo
                  </button>
                  <button
                    className={!createWorkspaceUsesGitHub ? "segmented-control__button segmented-control__button--active" : "segmented-control__button"}
                    type="button"
                    onClick={() => setProjectCreationMode("use_folder_as_is")}
                  >
                    Use Folder As-Is
                  </button>
                </div>
                <p>{createModeCopy}</p>
              </div>
              <div className="actions-row">
                <button className="primary-button" disabled={launcherActionsLocked || Boolean(projectLoadBusy)} onClick={() => void openFolder("open")}>
                  {projectLoadBusy === "open" ? <LoadingIndicator label="Opening" compact /> : "Open GitHub Repo"}
                </button>
                <button className="secondary-button" disabled={createWorkspaceLocked || Boolean(projectLoadBusy)} onClick={() => void openFolder("create")}>
                  {projectLoadBusy === "create" ? <LoadingIndicator label={createWorkspaceUsesGitHub ? "Initializing" : "Scanning"} compact /> : createActionLabel}
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
              {state.runtimeReadiness.blockAgentActions ? (
                <RuntimeReadinessPanel
                  report={state.runtimeReadiness}
                  onRunChecks={() => void checkRuntimeReadiness()}
                  onOpenSettings={() => setShowSettings(true)}
                  busy={runtimeCheckBusy}
                  compact
                />
              ) : null}
            </div>
          </section>
          {notice ? <div className={notice.tone === "error" ? "notice notice--error" : "notice"}>{notice.message}</div> : null}
          {projectLoadBusy ? (
            <div className="notice notice--status notice--running">
              <LoadingIndicator
                label={
                  projectLoadBusy === "create"
                    ? createWorkspaceUsesGitHub
                      ? "Preparing GitHub repository and scanning workspace"
                      : "Scanning selected folder without creating a GitHub repository"
                    : projectLoadBusy === "import"
                      ? "Importing portable interface"
                      : "Opening project and scanning repository"
                }
              />
            </div>
          ) : null}
          {!githubLinked && githubStatus ? (
            <div className={createWorkspaceUsesGitHub ? "notice notice--error" : "notice"}>
              {createWorkspaceUsesGitHub
                ? githubStatus.message
                : "GitHub is not linked. Local-only workspace creation is still available; GitHub-backed opening, imports, and initialization remain disabled."}
            </div>
          ) : null}
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
                title="New Workspace"
                copy={createModeCopy}
                actionLabel={createActionLabel}
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

  const latestProjectUpdate =
    allAgents[0]?.lastActivityAt ??
    allAgents[0]?.completedAt ??
    recentActivity[0]?.timestamp ??
    activeProject.record.overview?.generatedAt ??
    activeProject.record.localState.lastOpenedAt;
  const projectBranchOrPath = activeProject.record.validation.branch ?? activeProject.record.displayPath;
  const workflowRecoveryAvailable = Boolean(workflowRuntimeStatus?.status === "stale-running" && workflowPendingApprovals.length === 0);
  const workflowContinueActionLabel = autopilotStatus?.pausedReason === "high_risk_package_requires_approval"
    ? "Approve package"
    : "Continue workflow";
  const workflowShellStatus: { label: string; tone: ShellStatusTone } = activeProject.record.interfaceCreation?.status === "running"
    ? { label: "Running", tone: "running" }
    : workflowRuntimeStatus
      ? { label: workflowRuntimeStatus.label, tone: workflowRuntimeStatus.tone }
      : { label: "Idle", tone: "idle" };
  const topBarPrimaryAction: ShellAction | undefined = workflowAction?.kind === "resume_workflow"
    ? {
      label: workflowContinueActionLabel,
      disabled: workflowCommandBusy,
      onClick: () => void continueWorkflow()
    }
    : workflowAction?.kind === "recover_workflow"
      ? {
        label: workflowContinueActionLabel,
        disabled: workflowCommandBusy,
        onClick: () => void recoverWorkflow()
      }
      : workflowAction?.kind === "manual_takeover" && workflowAction.actionLabel
        ? {
          label: workflowAction.actionLabel,
          disabled: shellLaunchBusy || !workflow?.manualHandoff?.shellSupported,
          onClick: () => void openProjectShell()
        }
        : workflowAction?.kind === "confirm_goal"
          ? {
            label: "Set Ultimate Goal",
            onClick: () => void setWorkspaceTab("settings")
          }
        : workflowAction?.kind === "choose_recommendation" || workflowAction?.kind === "resolve_blocker"
          ? {
            label: workflowAction.actionLabel ?? "Review workflow",
            onClick: () => void setWorkspaceTab("workflow")
          }
          : autopilotStatus?.pausedReason
            ? {
              label: workflowContinueActionLabel,
              disabled: workflowCommandBusy,
              onClick: () => void continueWorkflow()
            }
          : workflow && !workflowHasActiveAgent && !recommendationRegenerationLocked
            ? {
              label: "Run recommendation",
              disabled: workflowCommandBusy,
              onClick: () => void runRecommendation()
            }
            : undefined;
  const utilityActions: ShellAction[] = [
    { label: "Home", onClick: () => void showLauncher() },
    { label: "Settings", onClick: () => void setWorkspaceTab("settings") },
    { label: "Open Another Folder", disabled: !githubLinked, onClick: () => void openFolder("open") },
    { label: "Export to Project", onClick: () => void exportInterfaceToProject() },
    { label: "Download Interface", onClick: () => void downloadInterface() },
    { label: "Download Logs", onClick: () => void downloadLogs() },
    { label: visualExtractBusy ? "Extracting..." : "Extract Visuals", disabled: visualExtractBusy, onClick: () => void extractVisuals() },
    { label: overviewRefreshRunning ? "Refreshing..." : "Refresh Overview", disabled: overviewRefreshRunning, onClick: () => void refreshOverview() },
    { label: "Revalidate", onClick: () => void window.workbench.revalidate(activeProject.record.id).catch(handleError) },
    { label: "Exit App", onClick: () => void quitApp() }
  ];
  const projectStatusItems: Array<string | JSX.Element> = [
    activeProject.record.identity.projectName,
    projectBranchOrPath,
    `last updated ${formatClockTime(latestProjectUpdate)}`,
    `workflow ${workflowShellStatus.label.toLowerCase()}`,
    `${pendingApprovals.length} approvals pending`
  ];
  const scrollWorkflowSectionIntoView = (elementId: string) => {
    setWorkspaceTab("workflow");
    const tryScroll = (attempt = 0) => {
      const target = document.getElementById(elementId);
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      if (attempt < 12) {
        window.requestAnimationFrame(() => tryScroll(attempt + 1));
      }
    };
    window.requestAnimationFrame(() => tryScroll());
  };
  const openWorkflowDetailsAndScroll = (elementId: string) => {
    setWorkspaceTab("workflow");
    setWorkflowDetailsMounted(true);
    const tryOpenAndScroll = (attempt = 0) => {
      const details = document.getElementById("workflow-detail-disclosure");
      if (details instanceof HTMLDetailsElement) {
        details.open = true;
      }
      const target = document.getElementById(elementId);
      if (!target && attempt < 16) {
        window.requestAnimationFrame(() => tryOpenAndScroll(attempt + 1));
        return;
      }
      const scrollTarget = target ?? details;
      if (target instanceof HTMLDetailsElement) {
        target.open = true;
      }
      window.requestAnimationFrame(() => scrollTarget?.scrollIntoView({ behavior: "smooth", block: "start" }));
    };
    window.requestAnimationFrame(() => tryOpenAndScroll());
  };
  const workflowHeaderPrimaryAction: ShellAction | undefined = workflowAction?.kind === "resume_workflow"
    ? {
      label: workflowContinueActionLabel,
      disabled: workflowCommandBusy,
      onClick: () => void toggleWorkflowPause()
    }
    : workflowAction?.kind === "recover_workflow"
      ? {
        label: workflowContinueActionLabel,
        disabled: workflowCommandBusy,
        onClick: () => void recoverWorkflow()
      }
      : workflowAction?.kind === "confirm_goal"
        ? {
          label: "Set Ultimate Goal in Settings",
          onClick: () => void setWorkspaceTab("settings")
        }
        : workflowAction?.kind === "choose_recommendation"
        ? {
          label: workflowAction.actionLabel ?? "Choose recommendation",
          onClick: () => openWorkflowDetailsAndScroll("workflow-recommendations")
        }
            : workflowShellStatus.tone === "blocked"
            ? {
              label: workflowPendingApprovals.length > 0 ? "Resolve approval" : "View blocker",
              onClick: () => scrollWorkflowSectionIntoView("workflow-needs-attention")
            }
            : autopilotStatus?.pausedReason
              ? {
                label: workflowContinueActionLabel,
                disabled: workflowCommandBusy,
                onClick: () => void continueWorkflow()
              }
            : workflowAction?.kind === "manual_takeover" && workflowAction.actionLabel
              ? {
                label: workflowAction.actionLabel,
                disabled: shellLaunchBusy || !workflow?.manualHandoff?.shellSupported,
                onClick: () => void openProjectShell()
              }
              : workflowShellStatus.tone === "running" && !workflowPauseRequested
                ? {
                  label: "Pause workflow",
                  disabled: workflowCommandBusy,
                  onClick: () => void toggleWorkflowPause()
                }
                : workflow && !workflowHasActiveAgent && !recommendationRegenerationLocked
                  ? {
                    label: "Run recommendation",
                    disabled: workflowCommandBusy,
                    onClick: () => void runRecommendation()
                  }
                  : undefined;
  const workflowSecondaryActions: ShellAction[] = [
    ...(workflow?.workflowCycle.status === "completed" || workflow?.workflowCycle.status === "merged" ? [{
      label: "Open cycle history",
      onClick: () => void setWorkspaceTab("history")
    }] : []),
    {
      label: "Create scoped goal",
      disabled: workflowCommandBusy || !workflow?.approvedRecommendation,
      onClick: () => void createScopedGoal()
    },
    {
      label: "Run recommendation",
      disabled: workflowCommandBusy || recommendationRegenerationLocked,
      onClick: () => void runRecommendation()
    },
    {
      label: "Run integrity",
      disabled: workflowCommandBusy,
      onClick: () => void runWorkflowIntegrity()
    },
    {
      label: "Run merge",
      disabled: workflowCommandBusy,
      onClick: () => void runWorkflowMerge()
    },
    {
      label: "Advance workflow stage",
      disabled: workflowCommandBusy,
      onClick: () => void advanceWorkflowStage()
    }
  ];
  const workflowStageText = userFacingWorkflowStatus?.label ?? (workflow ? workflowStageLabel(workflow.workflowStage) : "Workflow unavailable");
  const workflowAgentLabel = currentWorkflowAgent?.name ?? "Waiting for next workflow agent";
  const workflowCurrentFocus = summarizeText(
    operatorWorkflowView.currentStatus.primaryLabel,
    "Waiting for workflow activity.",
    180
  );
  const workflowCurrentRunSummary = currentWorkflowAgent
    ? operatorWorkflowView.currentStatus.secondaryExplanation
    : operatorWorkflowView.currentStatus.secondaryExplanation || workflowLead;
  const workflowCurrentPhase = summarizeText(
    operatorWorkflowView.currentStatus.technicalStage,
    "No active phase",
    120
  );
  const workflowChecksStatus = operatorWorkflowView.currentCycle.validationSummary.finalStatusLabel;
  const workflowValidationBlocking = latestValidationLedger
    ? latestValidationLedger.finalValidationStatus !== "passed" || latestValidationLedger.unresolvedValidationFailures.length > 0
    : false;
  const workflowHygieneBlocking = latestRepoHygieneReport
    ? latestRepoHygieneReport.status !== "passed"
    : false;
  const workflowRepairAgentAvailable = Boolean(
    workflow &&
    !ultimateGoalMissing &&
    (
      workflowValidationBlocking ||
      workflowHygieneBlocking ||
      operatorWorkflowView.currentStatus.severity === "danger"
    )
  );
  const commandCenterFocusChips: CommandCenterHealthItem[] = [
    operatorWorkflowView.currentCycle.cycleNumber ? { label: `Cycle ${operatorWorkflowView.currentCycle.cycleNumber}`, tone: "pending" } : undefined,
    operatorWorkflowView.currentStatus.lastCompletedAction !== "None" ? { label: operatorWorkflowView.currentStatus.lastCompletedAction, tone: "success" } : undefined,
    {
      label: operatorWorkflowView.currentCycle.validationSummary.finalStatusLabel,
      tone: operatorWorkflowView.currentCycle.validationSummary.finalStatus === "passed"
        ? "success"
        : operatorWorkflowView.currentCycle.validationSummary.finalStatus === "failed"
          ? "blocked"
          : operatorWorkflowView.currentCycle.validationSummary.finalStatus === "partial"
            ? "warning"
            : "pending"
    },
    operatorWorkflowView.planner.fallbackWarning ? { label: "Planner fallback used", tone: "warning" } : undefined,
    operatorWorkflowView.repositoryHealth.suspiciousPaths.length || operatorWorkflowView.repositoryHealth.hygieneStatus === "failed" || operatorWorkflowView.repositoryHealth.hygieneStatus === "unknown"
      ? { label: "Hygiene warning", tone: "blocked" }
      : undefined
  ].filter((item): item is CommandCenterHealthItem => Boolean(item));
  const commandCenterPhaseDetails: CommandCenterItem[] = [
    { label: "Technical stage", value: operatorWorkflowView.currentStatus.technicalStage },
    { label: "Active agent", value: operatorWorkflowView.currentStatus.activeAgent },
    { label: "Last completed", value: operatorWorkflowView.currentStatus.lastCompletedAction },
    { label: "Next step", value: operatorWorkflowView.currentStatus.nextOperatorAction },
    ...(operatorWorkflowView.currentStatus.pauseReason ? [{ label: "Pause reason", value: operatorWorkflowView.currentStatus.pauseReason }] : [])
  ];
  const commandCenterProgress: CommandCenterItem[] = [
    {
      label: "Cycle",
      value: operatorWorkflowView.currentCycle.cycleNumber ? `Cycle ${operatorWorkflowView.currentCycle.cycleNumber}` : "No active cycle",
      detail: operatorWorkflowView.currentCycle.cycleProgress
    },
    {
      label: "Goal progress",
      value: typeof operatorWorkflowView.goalProgress.percent === "number"
        ? `${operatorWorkflowView.goalProgress.percent}%`
        : workflowChecklistSummary,
      detail: operatorWorkflowView.goalProgress.requiredTotal
        ? `${operatorWorkflowView.goalProgress.requiredMet}/${operatorWorkflowView.goalProgress.requiredTotal} required checks met`
        : "Goal checklist not generated yet."
    },
    {
      label: "Checklist this cycle",
      value: operatorWorkflowView.currentCycle.checklistDeltaSummary.didGoalProgressChange ? "Advanced" : "No delta yet",
      detail: operatorWorkflowView.currentCycle.checklistDeltaSummary.summary,
      tone: operatorWorkflowView.currentCycle.checklistDeltaSummary.didGoalProgressChange ? "success" : "warning"
    },
    {
      label: "Validation",
      value: operatorWorkflowView.currentCycle.validationSummary.finalStatusLabel,
      detail: operatorWorkflowView.currentCycle.validationLedger?.summaryForHumans ?? operatorWorkflowView.emptyStates.validationLedger,
      tone: operatorWorkflowView.currentCycle.validationSummary.finalStatus === "passed" ? "success" : operatorWorkflowView.currentCycle.validationSummary.finalStatus === "failed" ? "error" : "warning"
    }
  ];
  const changedGroupDetail = operatorWorkflowView.currentCycle.changedFilesSummary
    .map((group) => `${group.label}: ${group.files.length}`)
    .join(" · ");
  const commandCenterChanges: CommandCenterItem[] = [
    {
      label: "Files changed",
      value: String(operatorWorkflowView.currentCycle.changedFiles.length),
      detail: changedGroupDetail || "No file changes recorded in the current cycle.",
      tone: operatorWorkflowView.repositoryHealth.suspiciousPaths.length ? "error" : undefined
    },
    {
      label: "Validation ledger",
      value: `${operatorWorkflowView.currentCycle.validationSummary.attempted.length} attempted / ${operatorWorkflowView.currentCycle.validationSummary.failedAttempts} failed`,
      detail: `${operatorWorkflowView.currentCycle.validationSummary.repaired.length} repaired. Final: ${operatorWorkflowView.currentCycle.validationSummary.finalStatusLabel}.`,
      tone: operatorWorkflowView.currentCycle.validationSummary.finalStatus === "failed" ? "error" : operatorWorkflowView.currentCycle.validationSummary.finalStatus === "passed" ? "success" : "warning"
    },
    {
      label: "Checklist delta",
      value: `${operatorWorkflowView.currentCycle.checklistDeltaSummary.newlyMet.length} newly met`,
      detail: `${operatorWorkflowView.currentCycle.checklistDeltaSummary.stillUnknown.length} still unknown · ${operatorWorkflowView.currentCycle.checklistDeltaSummary.evidenceConsumed}/${operatorWorkflowView.currentCycle.checklistDeltaSummary.evidenceObserved} evidence consumed`
    },
    {
      label: "Repo hygiene",
      value: operatorWorkflowView.repositoryHealth.hygieneLabel,
      detail: operatorWorkflowView.currentCycle.repoHygiene?.summaryForHumans ?? "No hygiene scan has completed for this cycle.",
      tone: operatorWorkflowView.repositoryHealth.hygieneStatus === "failed" || operatorWorkflowView.repositoryHealth.hygieneStatus === "unknown" ? "error" : operatorWorkflowView.repositoryHealth.hygieneStatus === "warning" ? "warning" : "success"
    }
  ];
  const operatorActionNeedsAttention = !/^Continue monitoring; no validation, hygiene, checklist, or planner blocker is currently recorded\.$/i.test(operatorWorkflowView.currentStatus.nextOperatorAction);
  const commandCenterAttention: CommandCenterItem[] = [
    ...(operatorActionNeedsAttention ? [{
      label: "Operator action",
      value: operatorWorkflowView.currentStatus.nextOperatorAction,
      detail: operatorWorkflowView.currentStatus.secondaryExplanation,
      tone: operatorWorkflowView.currentStatus.severity === "danger" ? "error" : operatorWorkflowView.currentStatus.severity === "paused" ? "warning" : operatorWorkflowView.currentStatus.severity
    } satisfies CommandCenterItem] : []),
    ...workflowAttentionItems.slice(0, 4).map((item) => ({
      label: workflowAttentionKindLabel(item.kind),
      value: item.title,
      detail: item.detail,
      tone: item.tone === "danger" ? "error" : item.tone === "neutral" ? "pending" : item.tone
    } satisfies CommandCenterItem))
  ];
  const latestRun = allAgents[0];
  const commandCenterLastResult = latestRun
    ? `${latestRun.name}: ${runResultSummary(latestRun, workflow)}`
    : recentActivity[0]
      ? `${recentActivity[0].title}${recentActivity[0].detail ? `: ${summarizeText(recentActivity[0].detail, "", 160)}` : ""}`
      : "No completed workflow result has been recorded yet.";
  const commandCenterWhy = summarizeText(
    [
      operatorWorkflowView.planner.whySelectedNow,
      operatorWorkflowView.planner.repeatedWorkWarning,
      operatorWorkflowView.planner.fallbackWarning
    ].filter(Boolean).join(" "),
    "The current workflow step is selected to advance the confirmed project goal.",
    420
  );
  const commandCenterWhyDetails: CommandCenterItem[] = [
    ...(operatorWorkflowView.currentCycle.cycleContract?.targetedChecklistItems ?? []).map((item) => ({
      label: item.checkId,
      value: item.title,
      detail: `${item.fullDescription}\nWhy targeted: ${item.whyTargeted}\nExpected evidence: ${item.acceptanceHint}`,
      tone: item.currentStatus === "met" ? "success" : "warning"
    } satisfies CommandCenterItem)),
    ...(operatorWorkflowView.planner.repeatedWorkWarning ? [{
      label: "Repetition",
      value: "Repetition risk",
      detail: operatorWorkflowView.planner.repeatedWorkWarning,
      tone: "warning" as CommandCenterTone
    }] : [])
  ];
  const commandCenterNextStep = summarizeText(
    operatorWorkflowView.currentStatus.nextOperatorAction,
    "No validation, hygiene, checklist, or planner blocker is currently recorded.",
    280
  );
  const repositoryHealth = repositoryScanStatus?.status === "failed"
    ? { label: "Repository scan failed", tone: "error" as CommandCenterTone }
    : repositoryScanStatus?.status === "truncated" || repositoryScanStatus?.status === "partially_indexed"
      ? { label: "Repository partially indexed", tone: "warning" as CommandCenterTone }
      : repositoryScanStatus?.status === "scanning"
        ? { label: "Repository scanning", tone: "running" as CommandCenterTone }
        : repositoryScanStatus?.status === "indexed"
          ? { label: "Repository indexed", tone: "success" as CommandCenterTone }
          : { label: "Repository scan pending", tone: "pending" as CommandCenterTone };
  const validationHealth = validationStatusChip(activeProject.validationStatus);
  const ledgerValidationHealth: CommandCenterHealthItem = latestValidationLedger
    ? latestValidationLedger.finalValidationStatus === "passed" && latestValidationLedger.unresolvedValidationFailures.length === 0
      ? { label: "Validation passed", tone: "success" }
      : latestValidationLedger.finalValidationStatus === "not_run"
        ? { label: "Validation not run", tone: "pending" }
        : latestValidationLedger.finalValidationStatus === "partial"
          ? { label: "Validation partial", tone: "warning" }
          : { label: "Validation blocked", tone: "blocked" }
    : { label: `Validation ${validationHealth.label.toLowerCase()}`, tone: validationHealth.tone as CommandCenterTone };
  const repoHygieneHealth: CommandCenterHealthItem = latestRepoHygieneReport
    ? latestRepoHygieneReport.status === "failed"
      ? { label: "Hygiene blocked", tone: "blocked" }
      : latestRepoHygieneReport.status === "warnings"
        ? { label: "Hygiene warnings", tone: "warning" }
        : latestRepoHygieneReport.status === "unknown"
          ? { label: "Hygiene not scanned", tone: "blocked" }
          : { label: "Hygiene passed", tone: "success" }
    : { label: "Hygiene pending", tone: "pending" };
  const checklistHealth: CommandCenterHealthItem = operatorWorkflowView.currentCycle.checklistDelta
    ? operatorWorkflowView.currentCycle.checklistDeltaSummary.didGoalProgressChange
      ? { label: "Checklist advanced", tone: "success" }
      : { label: "Checklist no delta", tone: "warning" }
    : { label: "Checklist unknown", tone: "pending" };
  const plannerHealth: CommandCenterHealthItem = operatorWorkflowView.planner.fallbackWarning
    ? { label: "Planner fallback warning", tone: "warning" }
    : { label: "Planner structured", tone: "success" };
  const codexHealth = codexReadinessStatusChip(state.codexReadiness.status);
  const runtimeHealth: CommandCenterHealthItem = state.runtimeReadiness.status === "blocked"
    ? { label: "Needs validation", tone: "blocked" }
    : state.runtimeReadiness.status === "checking"
      ? { label: "Validation running", tone: "running" }
      : { label: "Runtime ready", tone: "success" };
  const diagnosticHealth: CommandCenterHealthItem | undefined = state.diagnostics.some((entry) => /\b(repair|repaired|quarantine|compacted)\b/i.test(entry))
    ? { label: "State repaired", tone: "warning" }
    : undefined;
  const commandCenterHealth: CommandCenterHealthItem[] = [
    { label: workflowShellStatus.label, tone: workflowShellStatus.tone as CommandCenterTone },
    ledgerValidationHealth,
    checklistHealth,
    plannerHealth,
    repoHygieneHealth,
    runtimeHealth,
    repositoryHealth,
    { label: codexHealth.label === "Update available" ? "Codex outdated" : `Codex ${codexHealth.label.toLowerCase()}`, tone: codexHealth.tone as CommandCenterTone },
    ...(diagnosticHealth ? [diagnosticHealth] : [])
  ];
  const commandCenterPrimaryAction = topBarPrimaryAction ? (
    <button className="primary-button" type="button" disabled={topBarPrimaryAction.disabled} onClick={topBarPrimaryAction.onClick}>
      {topBarPrimaryAction.label}
    </button>
  ) : (
    <button className="secondary-button" type="button" onClick={() => void setWorkspaceTab("workflow")}>
      Open Workflow
    </button>
  );

  return (
    <div className="shell shell--workspace">
      <TopBar
        projectName={activeProject.record.identity.projectName}
        projectContext={projectBranchOrPath}
        statusLabel={workflowShellStatus.label}
        statusTone={workflowShellStatus.tone}
        primaryAction={topBarPrimaryAction}
        utilityActions={utilityActions}
      />

      <ProjectStatusStrip items={projectStatusItems} />

      {notice ? <div className={notice.tone === "error" ? "notice notice--error" : "notice"}>{notice.message}</div> : null}
      {state.runtimeReadiness.blockAgentActions ? (
        <RuntimeReadinessPanel
          report={state.runtimeReadiness}
          onRunChecks={() => void checkRuntimeReadiness()}
          onOpenSettings={() => void setWorkspaceTab("settings")}
          busy={runtimeCheckBusy}
        />
      ) : null}
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
            <StatusChip {...interfaceCreationStatusChip(activeProject.record.interfaceCreation)} />
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
      {ultimateGoalMissing ? (
        <section className="notice notice--status notice--pending">
          <div className="candidate-card__title-row">
            <strong>Recommended next step: set the Ultimate Goal</strong>
            <span className="badge">Required before workflow automation</span>
          </div>
          <p>Open Settings, write or generate the Goal Charter, then save it so Workflow has a durable target.</p>
          <div className="actions-row">
            <button className="primary-button" type="button" onClick={() => void setWorkspaceTab("settings")}>Open Settings</button>
            <button className="secondary-button" type="button" onClick={downloadUltimateGoalFormat}>Download format file</button>
            <button className="secondary-button" type="button" onClick={() => void detectUltimateGoal()}>Auto-detect draft</button>
          </div>
        </section>
      ) : null}

      <main className="project-workbench">
        <div className="workspace-tabs">
          <WorkspaceTabButton
            label="Overview"
            active={selectedWorkspaceTab === "overview"}
            onClick={() => void setWorkspaceTab("overview")}
          />
          <WorkspaceTabButton
            label="Workflow"
            active={selectedWorkspaceTab === "workflow"}
            count={pendingUserInputRequests.length + pendingHumanInterventions.length}
            onClick={() => void setWorkspaceTab("workflow")}
          />
          <WorkspaceTabButton
            label="History"
            active={selectedWorkspaceTab === "history"}
            count={historyData.total || allAgents.length}
            onClick={() => void setWorkspaceTab("history")}
          />
          <WorkspaceTabButton
            label="Repository"
            active={selectedWorkspaceTab === "repository"}
            count={activeProject.record.stats?.includedFiles}
            onClick={() => void setWorkspaceTab("repository")}
          />
          <WorkspaceTabButton
            label="Settings"
            active={selectedWorkspaceTab === "settings"}
            count={(activeProject.record.credentials?.requests ?? []).filter((request) => request.status === "pending").length}
            onClick={() => void setWorkspaceTab("settings")}
          />
        </div>

        {activeWorkspaceTab === "overview" ? (
          <section className="overview-page">
            <CommandCenter
              projectName={activeProject.record.identity.projectName}
              projectContext={projectBranchOrPath}
              currentFocus={workflowCurrentFocus}
              focusSummary={operatorWorkflowView.currentStatus.secondaryExplanation}
              focusChips={commandCenterFocusChips}
              phaseDetails={commandCenterPhaseDetails}
              currentPhase={workflowCurrentPhase}
              activeAgent={workflowAgentLabel}
              statusLabel={workflowShellStatus.label}
              statusTone={workflowShellStatus.tone as CommandCenterTone}
              whyThisMatters={commandCenterWhy}
              whyDetails={commandCenterWhyDetails}
              progress={commandCenterProgress}
              changes={commandCenterChanges}
              attention={commandCenterAttention}
              attentionEmpty="No validation, hygiene, checklist, or planner blocker is currently recorded."
              lastResult={commandCenterLastResult}
              nextStep={commandCenterNextStep}
              health={commandCenterHealth}
              primaryAction={commandCenterPrimaryAction}
              onOpenWorkflow={() => void setWorkspaceTab("workflow")}
              onOpenHistory={() => void setWorkspaceTab("history")}
              onOpenRepository={() => void setWorkspaceTab("repository")}
              onOpenSettings={() => void setWorkspaceTab("settings")}
            />

            <section className="overview-executive-header">
              <div className="overview-executive-header__main">
                <div className="eyebrow">Home</div>
                <h2>{activeProject.record.identity.projectName}</h2>
                <p>{summarizeText(activeProject.record.overview?.summary ?? activeProject.record.overview?.whatProjectDoes ?? activeProject.record.stats?.explanation, "Interface creation is still in progress for this project.", 240)}</p>
                <div className="overview-executive-header__meta">
                  <span>{projectBranchOrPath}</span>
                  <span>Updated {formatDateTime(workflowLastUpdatedAt ?? latestProjectUpdate)}</span>
                  <span>{workflowStageText}</span>
                  <span>{workflow ? `Cycle ${workflow.workflowCycle.cycleNumber}` : "No cycle"}</span>
                </div>
              </div>
              <div className="overview-executive-header__status">
                <StatusChip label={workflowShellStatus.label} tone={workflowShellStatus.tone} />
                {latestValidationLedger ? (
                  <StatusChip
                    label={ledgerValidationHealth.label}
                    tone={ledgerValidationHealth.tone === "blocked" ? "error" : ledgerValidationHealth.tone as StatusChipTone}
                  />
                ) : null}
                <ValidationBadge status={activeProject.validationStatus} />
                {activeProject.record.overview ? <SourceBadge source={activeProject.record.overview.source} /> : <span className="badge">Overview pending</span>}
              </div>
            </section>

            {ultimateGoalMissing ? (
              <section className="overview-goal-empty-state">
                <div>
                  <strong>No Ultimate Goal is set</strong>
                  <p>Open Settings to write, generate, import, or save the Goal Charter. Nothing runs automatically until you confirm the goal.</p>
                </div>
                <div className="actions-row">
                  <button className="primary-button" type="button" onClick={() => void setWorkspaceTab("settings")}>Open Settings</button>
                  <button className="secondary-button" type="button" onClick={downloadUltimateGoalFormat}>Download format file</button>
                  <button className="secondary-button" type="button" onClick={() => void detectUltimateGoal()}>Auto-detect draft</button>
                </div>
              </section>
            ) : null}

            <GoalCharterOverviewCard
              workflow={workflow}
              presets={autopilotPresets}
              onEditStrategy={() => void setWorkspaceTab("settings")}
              onOpenWorkflow={() => void setWorkspaceTab("workflow")}
              onDetectGoal={() => void detectUltimateGoal()}
              onAcceptDetectedGoal={() => void saveUltimateGoal()}
              onRejectDetectedGoal={() => void rejectDetectedGoal()}
              onAcceptGoalProposal={(proposalId) => void acceptGoalProposal(proposalId)}
              onRejectGoalProposal={(proposalId) => void rejectGoalProposal(proposalId)}
            />

            <section className="overview-health-grid" aria-label="Health snapshot">
              <OverviewMetricCard
                label="Workflow status"
                value={workflowShellStatus.label}
                detail={summarizeText(workflowRunState, "Workflow status unavailable.", 96)}
                tone={workflowShellStatus.tone === "blocked" ? "danger" : workflowShellStatus.tone === "completed" ? "good" : undefined}
              />
              <OverviewMetricCard
                label="Current stage"
                value={workflowStageText}
                detail={summarizeText(workflowCurrentPhase, "No active phase.", 96)}
              />
              <OverviewMetricCard
                label="Approvals pending"
                value={pendingApprovals.length}
                detail={pendingApprovals.length ? "Explicit review is required." : "No approvals waiting."}
                tone={pendingApprovals.length ? "warning" : "good"}
              />
              <OverviewMetricCard
                label="Blockers / warnings"
                value={workflowAttentionItems.length}
                detail={workflowAttentionItems.length ? "Review attention items below." : "No blocking attention item is currently recorded."}
                tone={workflowAttentionItems.some((item) => item.tone === "danger") ? "danger" : workflowAttentionItems.length ? "warning" : "good"}
              />
              <OverviewMetricCard
                label="Repo hygiene"
                value={latestRepoHygieneReport?.status ?? "pending"}
                detail={summarizeText(latestRepoHygieneReport?.summaryForHumans, "No hygiene scan has completed for this cycle.", 96)}
                tone={latestRepoHygieneReport?.status === "failed" || latestRepoHygieneReport?.status === "unknown" ? "danger" : latestRepoHygieneReport?.status === "passed" ? "good" : latestRepoHygieneReport?.status === "warnings" ? "warning" : undefined}
              />
              <OverviewMetricCard
                label="Last run status"
                value={allAgents[0]?.status ?? "No runs"}
                detail={allAgents[0] ? summarizeText(allAgents[0].name, "Latest run", 96) : "Start from Workflow or run a recommendation."}
                tone={allAgents[0]?.status === "completed" ? "good" : allAgents[0]?.status === "failed" || allAgents[0]?.status === "conflicted" || allAgents[0]?.status === "disconnected" ? "danger" : undefined}
              />
              <OverviewMetricCard
                label="Goal progress"
                value={typeof workflowChecklistOverview.percentComplete === "number" ? `${workflowChecklistOverview.percentComplete}%` : workflowChecklistSummary}
                detail={workflowChecklistOverview.requiredTotal ? `${workflowChecklistOverview.requiredMet}/${workflowChecklistOverview.requiredTotal} required checks met` : "Goal checklist not generated yet."}
                tone={workflowChecklistOverview.openRequired === 0 && workflowChecklistOverview.requiredTotal > 0 ? "good" : undefined}
              />
            </section>

            <section className="overview-main-grid">
              <OverviewAttentionSummary
                items={workflowAttentionItems}
                onOpenWorkflow={() => void setWorkspaceTab("workflow")}
                onOpenLogs={() => void setWorkspaceTab("history")}
                onOpenCredentials={() => void setWorkspaceTab("settings")}
              />
              <article className="overview-current-work-card">
                <SectionTitle eyebrow="Current work" title="Active workflow snapshot" />
                <div className="overview-current-work-card__goal">
                  <span className="workflow-option__label">Current goal</span>
                  <strong>{summarizeText(workflowGlanceGoal, "Set the Ultimate Goal.", 150)}</strong>
                </div>
                <div className="overview-current-work-card__facts">
                  <div>
                    <span>Agent/stage</span>
                    <strong>{workflowAgentLabel}</strong>
                  </div>
                  <div>
                    <span>Status</span>
                    <strong>{workflowStageText}</strong>
                  </div>
                </div>
                <div>
                  <span className="workflow-option__label">Next recommended action</span>
                  <p>{summarizeText(operatorWorkflowView.currentStatus.nextOperatorAction, "No validation, hygiene, checklist, or planner blocker is currently recorded.", 160)}</p>
                </div>
                <div className="actions-row">
                  <button className="primary-button" type="button" onClick={() => void setWorkspaceTab("workflow")}>Open Workflow</button>
                  {!workflow?.ultimateGoal.confirmedAt ? (
                    <button className="secondary-button" type="button" onClick={() => void detectUltimateGoal()}>
                      Auto-detect Ultimate Goal
                    </button>
                  ) : null}
                </div>
              </article>
            </section>

            <section className="overview-secondary-grid">
              <OverviewActivitySnapshot events={recentActivity} />
              <article className="overview-quick-nav-card">
                <SectionTitle eyebrow="Next" title="Quick navigation" />
                <div className="overview-quick-nav-grid">
                  <QuickNavigationCard title="Open Workflow" detail="Operate the active cycle and resolve workflow decisions." meta={workflowStageText} onClick={() => void setWorkspaceTab("workflow")} />
                  <QuickNavigationCard title="Open History" detail="Understand completed cycles and inspect full agent output." meta={`${historyData.total || allAgents.length} runs`} onClick={() => void setWorkspaceTab("history")} />
                  <QuickNavigationCard title="View Repository" detail="Open repository scan details, files, and summaries." meta={`${activeProject.record.stats?.includedFiles ?? 0} files`} onClick={() => void setWorkspaceTab("repository")} />
                  <QuickNavigationCard title="Open Settings" detail="Runtime readiness, Codex updates, credentials, and model defaults." meta={`${workflowCredentialRequests.length} credential requests`} onClick={() => void setWorkspaceTab("settings")} />
                </div>
              </article>
            </section>

            <section className="overview-repo-health">
              <div>
                <span className="workflow-option__label">Repository health</span>
                <p>
                  {activeProject.record.stats?.testsPresent ? "Tests detected" : "No tests detected"} · {activeProject.record.stats?.primaryManagers?.join(", ") || "Unknown toolchain"} · {activeProject.record.validation.branch ?? activeProject.record.validation.projectKind}
                </p>
              </div>
              <button className="secondary-button" type="button" onClick={() => void setWorkspaceTab("repository")}>Repository details</button>
            </section>
          </section>
        ) : null}

        {activeWorkspaceTab === "repository" ? (
          <RepositoryPanel
            project={activeProject}
            repositoryData={repositoryData}
            repositoryScanStatus={repositoryScanStatus}
            repositoryScanLimits={repositoryScanLimits}
            repositoryRescanBusy={repositoryRescanBusy}
            treeFilterDraft={treeFilterDraft}
            deferredTreeFilter={deferredTreeFilter}
            selectedFile={selectedFile}
            fileSummary={fileSummary}
            importantPathSummaries={importantPathSummaries}
            availableModels={state.availableModels}
            modelOptionsByName={modelOptionsByName}
            summaryModel={repositorySummaryModel}
            summaryReasoningMode={repositorySummaryReasoningMode}
            summaryReasoningEffort={repositorySummaryReasoningEffort}
            summaryAgent={selectedRepositorySummaryAgent}
            summaryActionBusy={repositoryPathActionBusy}
            questionDraft={repositoryQuestionDraft}
            agentActionsBlocked={agentActionsBlocked}
            operatorView={operatorWorkflowView}
            onRescanRepository={() => void rescanRepository("normal")}
            onDeepScanRepository={(settings) => void rescanRepository("deep", settings)}
            onTreeFilterChange={setTreeFilterDraft}
            onSelectFile={(relativePath) => void loadSummary(relativePath)}
            onToggleDirectory={toggleRepositoryDirectory}
            onLoadMoreRepositoryChildren={loadMoreRepositoryChildren}
            onSummaryModelChange={setRepositorySummaryModel}
            onSummaryReasoningModeChange={setRepositorySummaryReasoningMode}
            onSummaryReasoningEffortChange={setRepositorySummaryReasoningEffort}
            onGenerateSummary={() => void generateRepositoryPathSummary()}
            onQuestionDraftChange={setRepositoryQuestionDraft}
            onAskQuestion={() => void askRepositoryPathQuestion()}
            onOpenPathWindow={() => void openRepositoryPathWindow()}
            searchResultIndex={repositorySearchResultIndex}
            onSelectSearchResult={selectRepositorySearchResult}
          />
        ) : null}

        {activeWorkspaceTab === "history" ? (
          <HistoryPage
            history={historyData}
            onLoadMore={loadMoreHistoryCycles}
            onToggleCycle={toggleHistoryCycle}
            onOpenOutput={openAgentOutput}
            onOpenTranscript={(agent) => openAgentOutput(agent, { loadTranscript: true })}
          />
        ) : null}

        {activeWorkspaceTab === "workflow" ? (
          <section className="workflow-control-center panel workflow-operator-console">
            <WorkflowControlHeader
              projectName={activeProject.record.identity.projectName}
              statusLabel={workflowShellStatus.label}
              statusTone={workflowShellStatus.tone}
              cycleLabel={workflow ? `Cycle ${workflow.workflowCycle.cycleNumber}` : "No cycle"}
              stageLabel={workflowStageText}
              agentLabel={workflowAgentLabel}
              lastUpdatedAt={workflowLastUpdatedAt ?? latestProjectUpdate}
              approvalsPending={workflowPendingApprovals.length}
              primaryAction={workflowHeaderPrimaryAction}
              secondaryActions={workflowSecondaryActions}
            />

            {ultimateGoalMissing ? (
              <section className="notice notice--status notice--pending workflow-goal-setup-notice">
                <div className="candidate-card__title-row">
                  <strong>Set the Ultimate Goal in Settings first</strong>
                  <span className="badge">Workflow prerequisite</span>
                </div>
                <p>The workflow needs a saved Goal Charter before recommendations, coding, integrity, or merge steps can run.</p>
                <div className="actions-row">
                  <button className="primary-button" type="button" onClick={() => void setWorkspaceTab("settings")}>Open Settings</button>
                  <button className="secondary-button" type="button" onClick={downloadUltimateGoalFormat}>Download format file</button>
                  <button className="secondary-button" type="button" onClick={() => void detectUltimateGoal()}>Auto-detect draft</button>
                </div>
              </section>
            ) : null}

            <WorkflowStageTimeline steps={workflowTimeline} nowTime={clockNow} />

            <section className="workflow-operator-grid workflow-operator-grid--top">
              <WorkflowCurrentActionCard
                stageLabel={workflowStageText}
                agentName={workflowAgentLabel}
                agentStatus={currentWorkflowAgent?.status}
                focus={workflowCurrentFocus}
                runSummary={workflowCurrentRunSummary}
                changedFilesCount={currentWorkflowChangedFiles.length}
                checksStatus={workflowChecksStatus}
                approvalsPending={workflowPendingApprovals.length}
                nextAction={summarizeText(operatorWorkflowView.currentStatus.nextOperatorAction, "No validation, hygiene, checklist, or planner blocker is currently recorded.", 160)}
                phase={workflowCurrentPhase}
                repairAction={workflowRepairAgentAvailable ? {
                  label: "Repair in Codex",
                  busy: repairAgentLaunchBusy,
                  disabled: shellLaunchBusy,
                  onClick: () => void openWorkflowRepairAgent()
                } : undefined}
              />
              <WorkflowCurrentAgentMessages
                agent={currentWorkflowAgent}
                workflow={workflow}
                recoveryAvailable={workflowRecoveryAvailable}
                onRecover={() => void recoverWorkflow()}
              />
              {workflowRecoveryAvailable ? (
                <WorkflowStaleRecoveryPanel
                  recoveryCandidate={workflowRuntimeStatus?.recoveryCandidate ?? workflowRecoveryCandidate}
                  onContinue={() => void recoverWorkflow()}
                  onClearLock={() => void clearStaleWorkflowLock()}
                />
              ) : null}
              <WorkflowNeedsAttentionPanel
                items={workflowAttentionItems}
                onApprove={(approval) => void window.workbench.approve(activeProject.record.id, approval.agentId, approval.id, "accept")}
                onReject={(approval) => void window.workbench.approve(activeProject.record.id, approval.agentId, approval.id, "decline")}
                onOpenCredentials={() => void setWorkspaceTab("settings")}
                onViewDetails={(target) => {
                  if (target === "user-input") {
                    openWorkflowDetailsAndScroll("workflow-user-input-requests");
                    return;
                  }
                  if (target === "manual-handoff") {
                    openWorkflowDetailsAndScroll("workflow-manual-handoff");
                    return;
                  }
                  openWorkflowDetailsAndScroll("workflow-attention-details");
                }}
                onRetryManualHandoff={() => void retryWorkflowGoal()}
                onOpenProjectShell={() => void openProjectShell()}
                onDownloadRepairReport={downloadRepairReport}
                shellLaunchBusy={shellLaunchBusy}
                repairReportAvailable={repairAttemptReports.length > 0}
              />
            </section>

            <section className="workflow-operator-grid workflow-operator-grid--plan">
              <WorkflowCycleContractCard view={operatorWorkflowView} />
              <WorkflowChecklistProgressCard view={operatorWorkflowView} />
              <WorkflowValidationLedgerCard view={operatorWorkflowView} />
            </section>

            <WorkflowStatusStrip
              items={[
                { label: "Stage", value: workflowStageText },
                { label: "Cycle", value: workflow ? String(workflow.workflowCycle.cycleNumber) : "None" },
                { label: "Mode", value: workflowModeLabel(workflowMode), tone: workflowMode === "fast" ? "success" : "normal" },
                { label: "Autopilot", value: `${autopilotEnabled ? "On" : "Off"} · ${autopilotProfileLabel(autopilotProfile)}` },
                { label: "Preview", value: previewStatusLabel(previewStatus), tone: previewStatus === "ready" ? "warning" : previewStatus === "completed" ? "success" : "normal" },
                { label: "Package", value: autopilotStatus?.currentRecommendationTitle ?? workflow?.approvedRecommendation?.title ?? "None" },
                { label: "Last", value: autopilotStatus?.lastCompletedAction?.replace(/_/g, " ") ?? "None" },
                { label: "Next", value: autopilotStatus?.nextPlannedAction?.replace(/_/g, " ") ?? workflowAction?.actionLabel ?? "None" },
                { label: "Paused", value: autopilotPauseReasonLabel(autopilotStatus?.pausedReason), tone: autopilotStatus?.pausedReason ? "warning" : "normal" }
              ]}
            />

            <WorkflowAutopilotPanel
              autopilotEnabled={autopilotEnabled}
              autopilotProfile={autopilotProfile}
              autopilotPolicy={autopilotPolicy}
              autopilotPausedReason={autopilotStatus?.pausedReason}
              highRiskPackageRequiresApproval={autopilotStatus?.highRiskPackageRequiresApproval ?? false}
              currentRecommendationTitle={autopilotStatus?.currentRecommendationTitle}
              lastCompletedAction={autopilotStatus?.lastCompletedAction}
              objectiveLabel={workflowObjectiveLabel(workflowObjective)}
              nextAction={summarizeText(workflowNextGuidance ?? workflowAction?.description, "Continue from the current workflow state.", 140)}
              workflowPauseRequested={workflowPauseRequested}
              workflowHasActiveAgent={workflowHasActiveAgent}
              recoveryAvailable={workflowRecoveryAvailable}
              optimizeModeEnabled={optimizeModeEnabled}
              workflowMode={workflowMode}
              previewStatus={previewStatus}
              previewDisabledReason={previewDisabledReason}
              commandBusy={workflowCommandBusy}
              onToggleAutopilot={() => void toggleAutopilot()}
              onProfileChange={(profile) => void setAutopilotProfile(profile)}
              onPolicyChange={(patch) => void updateAutopilotPolicy(patch)}
              onToggleOptimizeMode={() => void toggleOptimizeMode()}
              onToggleWorkflowMode={() => void toggleWorkflowMode()}
              onRequestPreview={() => void requestWorkflowPreview()}
              onCancelPreview={() => void cancelWorkflowPreview()}
              onCompletePreview={() => void completeWorkflowPreview()}
              onContinueWorkflow={() => void continueWorkflow()}
              continueActionLabel={workflowContinueActionLabel}
              canContinueWorkflow={!workflowCommandBusy && (workflowRuntimeStatus?.canContinue ?? false)}
              continueDisabledReason={workflowCommandBusyReason ?? workflowRuntimeStatus?.continueDisabledReason}
            />

            {currentPlannerDecision ? (
              <article className="workflow-planner-card card-surface">
                <SectionTitle
                  eyebrow="Strategic planner"
                  title={currentPlannerDecision.selectedTaskTitle ?? "Planner decision"}
                  meta={<span className="badge">{currentStrategicPlan?.mode?.replace(/_/g, " ") ?? "strategy"}</span>}
                />
                <HistoryNarrativeField label="Why this task?" value={currentPlannerDecision.whySelected} />
                <div className="history-cycle-card__lists">
                  <HistoryMiniList label="Strategy highlights" items={currentPlannerDecision.strategySettingsUsed} empty="No strategy snapshot recorded." limit={6} />
                  <HistoryMiniList label="Checklist items targeted" items={currentPlannerTargets} empty="No checklist targets recorded." limit={8} />
                  <HistoryMiniList label="Expected files/areas" items={currentPlannerDecision.expectedFiles} empty="No expected files recorded." limit={8} />
                  <HistoryMiniList label="Expected validations" items={currentPlannerDecision.expectedValidationCommands} empty="No expected validations recorded." limit={6} />
                </div>
              </article>
            ) : null}

            <section className="workflow-operator-grid workflow-operator-grid--history">
              <WorkflowContextCards selections={workflow?.memory.lastRelevantContext ?? []} />
              <WorkflowActivityMiniFeed events={recentActivity} />
            </section>

            <details
              id="workflow-detail-disclosure"
              className="workflow-secondary__details workflow-noisy-detail"
              onToggle={(event) => {
                setWorkflowDetailsMounted(event.currentTarget.open);
              }}
            >
              <summary>
                <span>View workflow details</span>
                <span className="badge">Full controls</span>
              </summary>
              {workflowDetailsMounted ? (
              <div className="workflow-secondary__content">
                <UltimateGoalProgressCard
                  progress={workflow?.ultimateGoalProgress}
                  completion={workflow?.ultimateGoalCompletion}
                  checklist={workflow?.goalChecklist}
                  taskMap={workflow?.taskMap}
                  objective={workflowObjective}
                  appeal={workflow?.appeal}
                />

                <div className="workflow-minimal-layout workflow-minimal-layout--legacy">
              <div className="workflow-minimal-layout__main">
                <article className={`workflow-primary-action ${workflowAction?.kind === "resolve_blocker" ? "workflow-primary-action--blocked" : ""}`}>
                  <div>
                    <div className="eyebrow">What needs your attention</div>
                    <h3>{workflowAction?.title ?? "Nothing right now; the system is working"}</h3>
                    <p>{workflowAction?.description ?? "The workflow is progressing automatically; monitor validation, hygiene, and checklist status."}</p>
                    {workflowNextGuidance ? <p className="workflow-primary-action__next">{workflowNextGuidance}</p> : null}
                  </div>
                  {workflowAction?.kind === "confirm_goal" ? (
                    <button className="primary-button" onClick={() => void setWorkspaceTab("settings")}>
                      Set Ultimate Goal in Settings
                    </button>
                  ) : workflowAction?.kind === "resume_workflow" ? (
                    <button className="primary-button" disabled={workflowCommandBusy} onClick={() => void toggleWorkflowPause()}>
                      {workflowAction.actionLabel}
                    </button>
                  ) : workflowAction?.kind === "recover_workflow" ? (
                    <button className="primary-button" disabled={workflowCommandBusy} onClick={() => void recoverWorkflow()}>
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
                        <div className="candidate-card__title-row">
                          <span className="workflow-option__label">Workflow mode</span>
                          <strong>{workflowModeLabel(workflowMode)}</strong>
                        </div>
                        <div className="candidate-card__title-row">
                          <span className="workflow-option__label">Autopilot profile</span>
                          <strong>{autopilotProfileLabel(autopilotProfile)}</strong>
                        </div>
                        <label className="form-field">
                          <span>Profile</span>
                          <select className="input" value={autopilotProfile} onChange={(event) => void setAutopilotProfile(event.target.value as AutopilotProfile)}>
                            <option value="balanced">Balanced</option>
                            <option value="conservative">Conservative</option>
                            <option value="aggressive">Aggressive</option>
                            <option value="custom">Custom</option>
                          </select>
                        </label>
                        <p className="agent-card__subtle">
                          {optimizeModeEnabled
                            ? "Optimize mode keeps the cycle running after the base goal is satisfied and looks for bounded improvements in UX, correctness, efficiency, resource use, and overall polish."
                            : "Deliver-goal mode runs one final appeal pass for visual projects, then stops once the current Ultimate Goal looks satisfied."}
                        </p>
                        {autopilotStatus && (autopilotStatus.pausedReason || autopilotStatus.highRiskPackageRequiresApproval) ? (
                          <div className="lane-note">
                            <strong>{autopilotStatus.highRiskPackageRequiresApproval ? "High-risk checkpoint" : "Autopilot checkpoint"}</strong>
                            <span>
                              {autopilotStatus.highRiskPackageRequiresApproval
                                ? "The selected package needs explicit approval before autopilot can continue."
                                : autopilotPauseReasonLabel(autopilotStatus.pausedReason)}
                            </span>
                          </div>
                        ) : null}
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
                          <button className={workflowMode === "fast" ? "primary-button" : "secondary-button"} onClick={() => void toggleWorkflowMode()}>
                            {workflowMode === "fast" ? "Switch to Normal Mode" : "Switch to Fast Mode"}
                          </button>
                          <button className="secondary-button" disabled={workflowCommandBusy} onClick={() => void toggleWorkflowPause()}>
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
                  <article id="workflow-manual-handoff" className="overview-card workflow-panel workflow-manual-handoff">
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
                    {workflow.manualHandoff.involvedPaths.length ? (
                      <div className="workflow-goal-panel__criteria">
                        <span className="workflow-option__label">Conflict paths</span>
                        <div className="tag-row">
                          {workflow.manualHandoff.involvedPaths.map((involvedPath) => (
                            <span key={involvedPath} className="tag">{involvedPath}</span>
                          ))}
                        </div>
                      </div>
                    ) : null}
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
                  <details id="workflow-recommendations" className={`workflow-secondary__details ${workflowProminence.recommendations ? "workflow-panel--prominent" : "workflow-panel--secondary"}`} open={workflowProminence.recommendations}>
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
                          disabled={workflowCommandBusy || !customRecommendationPrompt.trim() || recommendationRegenerationLocked}
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
                            workflowCommandBusy ||
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
                    <select className="input" value={manualAgentModel} onChange={(event) => setManualAgentModel(event.target.value)} disabled={agentActionsBlocked}>
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
                      <button className="primary-button" disabled={agentActionsBlocked || !manualAgentPrompt.trim() || !manualAgentModel} onClick={() => void createManualAgent()}>
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
                  <article id="workflow-user-input-requests" className="overview-card workflow-panel workflow-user-input-panel workflow-panel--prominent">
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
                  <article id="workflow-attention-details" className={`overview-card workflow-panel ${workflowProminence.humanIntervention ? "workflow-panel--prominent" : "workflow-panel--secondary"}`}>
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
                          onOpenOutput={(agent) => openAgentOutputById(agent)}
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
                          onOpenOutput={(agent) => openAgentOutputById(agent)}
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
                          onOpenOutput={(agent) => openAgentOutputById(agent)}
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
                          onOpenOutput={(agent) => openAgentOutputById(agent)}
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
                          onOpenOutput={(agent) => openAgentOutputById(agent)}
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
                    <button className="secondary-button" disabled={workflowCommandBusy || !activeProject.record.workflow.approvedRecommendation} onClick={() => void createScopedGoal()}>
                      Create scoped goal
                    </button>
                    <button className="secondary-button" disabled={workflowCommandBusy || recommendationRegenerationLocked} onClick={() => void runRecommendation()}>
                      Run recommendation
                    </button>
                    <button className="secondary-button" disabled={workflowCommandBusy} onClick={() => void runWorkflowIntegrity()}>
                      Run integrity
                    </button>
                    <button className="secondary-button" disabled={workflowCommandBusy} onClick={() => void runWorkflowMerge()}>
                      Run merge
                    </button>
                    <button className="secondary-button" disabled={workflowCommandBusy} onClick={() => void advanceWorkflowStage()}>
                      Advance workflow stage
                    </button>
                  </div>
                  <div className="agent-form card-surface">
                    <input className="input" value={codingAgentForm.name} onChange={(event) => setCodingAgentForm({ ...codingAgentForm, name: event.target.value })} />
                    <textarea className="textarea" placeholder="Describe the coding task" value={codingAgentForm.prompt} onChange={(event) => setCodingAgentForm({ ...codingAgentForm, prompt: event.target.value })} />
                    <select className="input" value={codingAgentForm.model} onChange={(event) => setCodingAgentForm({ ...codingAgentForm, model: event.target.value })} disabled={agentActionsBlocked}>
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
                    <button className="primary-button" disabled={agentActionsBlocked || !codingAgentForm.prompt.trim() || !codingAgentForm.model} onClick={() => void createCodingAgent()}>
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
                  <SectionTitle eyebrow="Current run" title="Current saved agent" meta={<span className="badge">{currentWorkflowAgent?.status ?? "idle"}</span>} />
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
              </div>
              ) : (
                <div className="workflow-secondary__content">
                  <div className="empty-copy">Open details to load advanced workflow controls and traces.</div>
                </div>
              )}
            </details>
          </section>
        ) : null}

        {activeWorkspaceTab === "logs" ? (
          <LogsPanel
            logFeed={logFeed}
            agents={allAgents}
            pendingApprovals={pendingApprovals}
            activityLogPageIndex={activityLogPageIndex}
            commandLogPageIndex={commandLogPageIndex}
            onActivityPageChange={setActivityLogPageIndex}
            onCommandPageChange={setCommandLogPageIndex}
            onApprove={(approval) => void window.workbench.approve(activeProject.record.id, approval.agentId, approval.id, "accept")}
            onReject={(approval) => void window.workbench.approve(activeProject.record.id, approval.agentId, approval.id, "decline")}
          />
        ) : null}

        {activeWorkspaceTab === "runs" ? (
          <section className="workflow-control-center panel agent-history-workspace">
            <RunsReviewPage
              agents={runsPageAgents}
              totalAgents={totalRunsCount}
              workflowPage={workflowAgentPage}
              manualPage={manualAgentPage}
              workflowPageIndex={workflowAgentPageIndex}
              manualPageIndex={manualAgentPageIndex}
              workflow={workflow}
              selectedAgent={selectedRunAgent}
              loading={workflowAgentPage.loading || manualAgentPage.loading}
              manualAgentPrompt={manualAgentPrompt}
              manualAgentModel={manualAgentModel}
              manualAgentReasoningMode={manualAgentReasoningMode}
              manualAgentReasoningEffort={manualAgentReasoningEffort}
              availableModels={state.availableModels}
              modelOptionsByName={modelOptionsByName}
              manualPendingApprovalCount={manualPendingApprovalCount}
              agentActionsBlocked={agentActionsBlocked}
              onSelectAgent={(agentId) => void selectAgent(agentId)}
              onWorkflowPageChange={setWorkflowAgentPageIndex}
              onManualPageChange={setManualAgentPageIndex}
              onOpenWorkflow={() => void setWorkspaceTab("workflow")}
              onOpenLogs={() => void setWorkspaceTab("history")}
              onOpenOutput={(agent) => openAgentOutputById(agent)}
              onManualPromptChange={setManualAgentPrompt}
              onManualModelChange={setManualAgentModel}
              onManualReasoningModeChange={setManualAgentReasoningMode}
              onManualReasoningEffortChange={setManualAgentReasoningEffort}
              onCreateManualAgent={() => void createManualAgent()}
            />
          </section>
        ) : null}

        {activeWorkspaceTab === "credentials" ? (
          <CredentialsPanel project={activeProject} onSaved={showInfoNotice} onError={handleError} />
        ) : null}

        {activeWorkspaceTab === "settings" ? (
          <div className="settings-page-stack">
            <SettingsDialog
              mode="page"
              state={state}
              activeProject={activeProject}
              github={state.github}
              settingsDraft={settingsDraft}
              goalCharterDraft={goalCharterDraft}
              goalCharterAiModel={goalCharterAiModel}
              goalCharterAiReasoningEffort={goalCharterAiReasoningEffort}
              goalCharterGeneratePrompt={goalCharterGeneratePrompt}
              goalCharterAiBusy={goalCharterAiBusy}
              autopilotPresets={autopilotPresets}
              onChange={updateSettingsDraft}
              onGoalCharterChange={updateGoalCharterDraft}
              onGoalCharterAiModelChange={setGoalCharterAiModel}
              onGoalCharterAiReasoningEffortChange={setGoalCharterAiReasoningEffort}
              onGoalCharterGeneratePromptChange={setGoalCharterGeneratePrompt}
              onPolishGoalCharterField={(field) => void polishGoalCharterField(field)}
              onGenerateGoalCharterDraft={() => void generateGoalCharterDraft()}
              onSave={saveSettings}
              onSaveGoalCharter={() => void saveGoalCharter()}
              onApplyAutopilotPreset={applyAutopilotPreset}
              onDetectGoal={() => void detectUltimateGoal()}
              onRejectDetectedGoal={() => void rejectDetectedGoal()}
              onDownloadUltimateGoalFormat={downloadUltimateGoalFormat}
              onClose={() => void setWorkspaceTab("overview")}
              onOpenDevTools={() => void openDevTools()}
              onRefreshGitHubStatus={() => void refreshGitHubStatus()}
              onCheckRuntimeReadiness={() => void checkRuntimeReadiness()}
              onRefreshCodexReadiness={() => void refreshCodexReadiness()}
              onCheckCodexUpdate={() => void checkCodexUpdate()}
              onRunCodexUpdate={(approvedCommand) => void runCodexUpdate(approvedCommand)}
              runtimeCheckBusy={runtimeCheckBusy}
              codexUpdateBusy={codexUpdateBusy}
            />
            <CredentialsPanel project={activeProject} onSaved={showInfoNotice} onError={handleError} />
          </div>
        ) : null}
      </main>

      <AgentOutputViewer
        viewer={agentOutputViewer}
        onClose={() => setAgentOutputViewer(undefined)}
        onQueryChange={(query) => setAgentOutputViewer((current) => current ? { ...current, query } : current)}
        onWrapChange={(wrap) => setAgentOutputViewer((current) => current ? { ...current, wrap } : current)}
        onViewModeChange={(viewMode) => setAgentOutputViewer((current) => current ? { ...current, viewMode } : current)}
        onLoadTranscript={loadAgentTranscript}
      />

      {settingsDialog}
    </div>
  );
};

export const App = () => {
  const params = useMemo(repositoryPathChatParams, []);
  return params.enabled ? <RepositoryPathChatApp /> : <WorkbenchApp />;
};
