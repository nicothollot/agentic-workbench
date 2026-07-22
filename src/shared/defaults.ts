import { nanoid } from "nanoid";
import { APP_VERSION, DEFAULT_CODEX_BINARY, DEFAULT_DISTRO_NAME, DEFAULT_WORKTREE_BASE_DIR, PORTABLE_INTERFACE_VERSION } from "./constants";
import { DEFAULT_AGENT_REASONING_EFFORTS, DEFAULT_AGENT_REASONING_MODE } from "./modelConfig";
import { createDefaultAutopilotPolicy } from "./autopilotPolicy";
import { createDefaultGoalCharter } from "./goalCharter";
import { WORKFLOW_SCHEMA_VERSION } from "./types";
import type {
  AgentCategory,
  AgentFreshnessMarker,
  AgentState,
  AppSettings,
  LayoutConfig,
  LocalProjectRecord,
  LocalProjectState,
  ProjectCredentialsState,
  PortableProjectInterface,
  ProjectIdentity,
  ProjectWorkflowState,
  UltimateGoal,
  ValidationSnapshot,
  WorkflowBudgets,
  WorkflowCycle,
  WorkflowAppealState,
  WorkflowMemory,
  RecommendationHealth,
  WorkflowStepId,
  WorkflowStepProgress
} from "./types";
import { nowIso } from "./utils";

export const defaultSettings = (): AppSettings => ({
  executionMode: process.platform === "win32" ? "wsl" : "local",
  distroName: DEFAULT_DISTRO_NAME,
  codexBinaryPath: DEFAULT_CODEX_BINARY,
  worktreeBaseDir: DEFAULT_WORKTREE_BASE_DIR,
  warnOnMntMount: true,
  mockMode: false,
  maxRepairCycles: 3,
  agentModelMode: "auto",
  interfaceCreationReasoningEffort: "medium",
  agentReasoningMode: DEFAULT_AGENT_REASONING_MODE,
  agentReasoningEfforts: { ...DEFAULT_AGENT_REASONING_EFFORTS },
  autoApproveCommands: false,
  autoApproveGitCommits: false,
  autoApproveGitPushes: false,
  considerPaidServices: false,
  appearanceTheme: "catc-dark",
  appearanceDensity: "comfortable",
  motionMode: "system"
});

export const defaultLayout = (): LayoutConfig => ({
  leftPanelWidth: 300,
  rightPanelWidth: 360,
  bottomPanelHeight: 240,
  activeCenterTab: "overview"
});

export const defaultLocalState = (): LocalProjectState => ({
  treeFilter: "",
  autopilotEnabled: false,
  workflowObjective: "deliver",
  workflowPauseRequested: false,
  lastOpenedAt: nowIso()
});

export const emptyUltimateGoal = (source: UltimateGoal["source"] = "user"): UltimateGoal => ({
  summary: "",
  detailedIntent: "",
  successCriteria: [],
  constraints: [],
  nonGoals: [],
  targetAudience: "",
  qualityBar: "",
  source
});

export const defaultWorkflowCycle = (): WorkflowCycle => ({
  cycleNumber: 1,
  acceptanceCriteria: [],
  status: "idle"
});

export const defaultWorkflowBudgets = (): WorkflowBudgets => ({
  maxRepairLoops: 3,
  maxRecommendationOptions: 5,
  maxCycleSummaries: 12,
  maxAcceptedDecisions: 24,
  maxOpenIssues: 24,
  maxAgentRestartsPerCategory: 3,
  maxCodingIterationsPerCycle: 4,
  maxIntegrityRunsPerCycle: 3
});

export const defaultWorkflowRepairState = () => ({
  attemptCount: 0,
  maxAttempts: defaultWorkflowBudgets().maxRepairLoops,
  status: "idle" as const
});

export const defaultWorkflowAppealState = (): WorkflowAppealState => ({
  status: "not_started"
});

export const defaultRecommendationHealth = (): RecommendationHealth => ({
  totalStructuredAttempts: 0,
  totalStructuredFailures: 0,
  consecutiveStructuredFailures: 0,
  fallbackUsedForCurrentRecommendation: false,
  selectedTaskSource: "derived_from_legacy_state",
  modelRecommendationAccepted: false,
  deterministicFallbackCandidateCount: 0,
  visibleWarningLevel: "none"
});

const defaultAgentFreshnessMarker = (): AgentFreshnessMarker => ({
  restartCount: 0,
  freshnessToken: 0
});

export const defaultWorkflowMemory = (): WorkflowMemory => {
  const categories: AgentCategory[] = ["bootstrap", "goal", "coding", "integrity", "merge", "recommendation", "manual"];
  return {
    canonicalSummary: "",
    canonicalFacts: [],
    perCycleSummaries: [],
    lastAcceptedDecisions: [],
    knownOpenIssues: [],
    agentFreshness: Object.fromEntries(categories.map((category) => [category, defaultAgentFreshnessMarker()])) as Record<
      AgentCategory,
      AgentFreshnessMarker
    >,
    contextDescriptors: [],
    lastRelevantContext: []
  };
};

export const defaultProjectCredentialsState = (): ProjectCredentialsState => ({
  entries: [],
  requests: []
});

export const workflowStepOrder: WorkflowStepId[] = [
  "ultimate_goal",
  "recommendation",
  "goal_plan",
  "coding",
  "integrity",
  "merge"
];

export const defaultWorkflowStepProgress = (stepId: WorkflowStepId): WorkflowStepProgress => ({
  stepId,
  status: stepId === "ultimate_goal" ? "waiting" : "not_started",
  requiresUserInput: stepId === "ultimate_goal",
  runCount: 0,
  attemptCount: 0
});

export const defaultWorkflowStepProgressState = (): Record<WorkflowStepId, WorkflowStepProgress> =>
  Object.fromEntries(
    workflowStepOrder.map((stepId) => [stepId, defaultWorkflowStepProgress(stepId)])
  ) as Record<WorkflowStepId, WorkflowStepProgress>;

export const defaultProjectWorkflowState = (): ProjectWorkflowState => {
  const createdAt = nowIso();
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    execution: {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      revision: 1,
      cycleNumber: 1,
      tag: "needs_goal",
      stepId: "ultimate_goal",
      enteredAt: createdAt,
      updatedAt: createdAt
    },
    incidents: [],
    journal: [],
    metrics: {
      totalInputTokens: 0,
      totalCachedInputTokens: 0,
      totalOutputTokens: 0,
      totalReasoningTokens: 0,
      totalTokens: 0
    },
    ultimateGoal: emptyUltimateGoal(),
    goalCharter: createDefaultGoalCharter(),
    workflowMode: "normal",
    previewRequest: {
      status: "none",
      remainingCycles: 1
    },
    autopilotPolicy: createDefaultAutopilotPolicy(false),
    goalChecklist: [],
    taskMap: {
      groups: [],
      totalRequiredChecks: 0,
      openRequiredChecks: 0,
      updatedAt: new Date(0).toISOString()
    },
    workPackages: [],
    strategicPlans: [],
    plannerDecisions: [],
    checklistChanges: [],
    cycleRetrospectives: [],
    evidenceObservations: [],
    checklistDeltas: [],
    recommendationHealth: defaultRecommendationHealth(),
    evidenceCommands: [],
    validationLedgers: [],
    repoHygieneReports: [],
    workflowCycle: defaultWorkflowCycle(),
    workflowStage: "charter_needed",
    repairLoopCount: 0,
    appeal: defaultWorkflowAppealState(),
    repair: defaultWorkflowRepairState(),
    workflowBudgets: defaultWorkflowBudgets(),
    workflowStopReason: "charter_missing",
    humanInterventions: [],
    recommendations: [],
    stepProgress: defaultWorkflowStepProgressState(),
    memory: defaultWorkflowMemory(),
    activityLog: []
  };
};

export const emptyValidationSnapshot = (projectKind: ValidationSnapshot["projectKind"]): ValidationSnapshot => ({
  interfaceSchemaVersion: PORTABLE_INTERFACE_VERSION,
  appMinVersion: APP_VERSION,
  projectKind
});

export const createAgentSkeleton = (category: AgentState["category"], name: string, taskPrompt: string, model: string): AgentState => ({
  id: nanoid(),
  category,
  name,
  taskPrompt,
  model,
  workflowCycleNumber: undefined,
  createdAt: nowIso(),
  status: "idle",
  changedFiles: [],
  approvals: [],
  commandLog: [],
  events: []
});

export const createLocalProjectRecord = (
  id: string,
  displayPath: string,
  wslPath: string,
  projectRoot: string,
  hostPath: string,
  identity: ProjectIdentity,
  validation: ValidationSnapshot,
  distroName?: string
): LocalProjectRecord => ({
  id,
  displayPath,
  wslPath,
  projectRoot,
  hostPath,
  distroName,
  identity,
  validation,
  layout: defaultLayout(),
  localState: defaultLocalState(),
  workflow: defaultProjectWorkflowState(),
  dependencies: [],
  summaryCache: [],
  agents: [],
  userInputRequests: [],
  credentials: defaultProjectCredentialsState()
});

export const createPortableInterface = (record: LocalProjectRecord): PortableProjectInterface => {
  const identity = { ...record.identity };
  const validation = { ...record.validation };
  delete identity.gitRoot;
  delete validation.projectAccess;
  return {
    schemaVersion: PORTABLE_INTERFACE_VERSION,
    appMinVersion: APP_VERSION,
    exportedAt: nowIso(),
    checksum: "",
    identity,
    validation: {
      ...validation,
      interfaceSchemaVersion: PORTABLE_INTERFACE_VERSION,
      appMinVersion: APP_VERSION
    },
    layout: record.layout,
    localStateDefaults: {
      ...record.localState,
      selectedFile: undefined,
      treeFilter: "",
      activeAgentId: undefined,
      workflowPauseRequested: false,
      lastOpenedAt: undefined
    },
    workflow: record.workflow,
    overview: record.overview,
    stats: record.stats ? { ...record.stats, projectRoot: "." } : undefined,
    dependencies: record.dependencies,
    summaryCache: record.summaryCache,
    agents: record.agents
  };
};
