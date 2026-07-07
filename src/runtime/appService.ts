import { EventEmitter } from "node:events";
import { access, copyFile, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import type { ServerNotification, ServerRequest } from "@generated/app-server";
import type { JsonValue } from "@generated/app-server/serde_json/JsonValue";
import type { SandboxPolicy, ToolRequestUserInputQuestion } from "@generated/app-server/v2";
import { APP_VERSION, PORTABLE_INTERFACE_PATH, USER_INPUT_REQUESTS_PATH } from "@shared/constants";
import { createAgentSkeleton, createLocalProjectRecord, defaultLocalState, defaultProjectCredentialsState, defaultProjectWorkflowState, defaultSettings, defaultWorkflowAppealState } from "@shared/defaults";
import { createDefaultGoalCharter, listAutopilotPresets as buildAutopilotPresets } from "@shared/goalCharter";
import { agentRoles } from "@shared/agentRoles";
import {
  DEFAULT_AGENT_REASONING_EFFORTS,
  DEFAULT_AGENT_REASONING_MODE,
  resolveAgentReasoningEffort,
  resolveInterfaceCreationReasoningEffort
} from "@shared/modelConfig";
import { executionPathToHostPath, resolveProjectPath } from "@shared/pathUtils";
import {
  appSettingsSchema,
  fileSummarySchema,
  autopilotStrategySchema,
  goalCharterSchema,
  portableInterfaceSchema,
  scopedGoalSchema,
  ultimateGoalSchema,
  workflowRecommendationOptionSchema
} from "@shared/schemas";
import { SummaryCache } from "@shared/summaryCache";
import type {
  AgentCategory,
  AgentHistoryScope,
  AgentFullOutputResponse,
  AgentHistorySummary,
  AgentTranscriptEntry,
  AgentTranscriptResponse,
  AgentReasoningMode,
  AgentState,
  AgentListResponse,
  ApprovedRecommendation,
  AppSettings,
  AutopilotPreset,
  AutopilotPauseReason,
  AutopilotPolicy,
  AutopilotStrategy,
  ApprovalDecision,
  ApprovalRequestRecord,
  CodexAvailability,
  CodexReadinessReport,
  CodexUpdateCheckResult,
  CodexUpdateRunResult,
  CycleAgentListResponse,
  CredentialEntryMetadata,
  CredentialEntryStatus,
  CredentialRequestRecord,
  CredentialRequestStatus,
  DiscoveredModel,
  ExecutionEnvironmentStatus,
  FileSummary,
  GitHubStatus,
  ChecklistChange,
  ChecklistEvidenceObservation,
  CycleRetrospective,
  GoalChangeRecord,
  GoalChangeProposal,
  GoalCharter,
  GoalCharterAiDraft,
  GoalCharterDraftTextField,
  GoalCharterGenerateResult,
  GoalCharterPolishResult,
  GoalAttainmentCheck,
  HumanInterventionRecord,
  InterfaceCandidate,
  InterfaceReasoningEffort,
  LoadedProjectView,
  LocalProjectRecord,
  OpenProjectShellResult,
  ProjectCreationMode,
  ProjectAccessProbe,
  ProjectLogFeedResponse,
  ProjectOverview,
  ProjectRepositoryView,
  ProjectRepositorySummary,
  RendererPayloadInfo,
  RepositoryRescanOptions,
  RepositoryExcludedPathsResponse,
  RepositoryScanLimitsResponse,
  RepositoryScanSettings,
  RepositoryScanStatus,
  ProjectWorkflowState,
  ProjectLoadIntent,
  ProjectLoadResult,
  PlannerDecision,
  RepoHygieneReport,
  RepositoryChildrenResponse,
  RepositorySearchResponse,
  RepositoryPathSummaryTarget,
  ProjectStats,
  RepositoryTreeEntry,
  RepoTreeNode,
  RuntimeDependencyCheck,
  RuntimeReadinessReport,
  ScopedGoal,
  UserInputRequestQuestion,
  UserInputRequestRecord,
  UltimateGoalImportPreview,
  UltimateGoalProgressEstimate,
  UltimateGoal,
  ValidationLedger,
  ValidationStatus,
  WorkflowMode,
  WorkflowCycleDetail,
  WorkflowCycleListResponse,
  WorkflowCycleStatus,
  WorkflowCycleSummaryView,
  WorkflowStepId,
  StructuredRecommendationFailureCategory,
  WorkPackage,
  WorkbenchState
} from "@shared/types";
import { nowIso, unique } from "@shared/utils";
import { calculateValidationStatus } from "@shared/validation";
import {
  createScopedGoalFromWorkPackage,
  createScopedGoalFromRecommendation,
  deriveWorkflowProjection,
  ensureWorkflowStepProgressState,
  getWorkflowActiveStepId,
  getWorkflowModeConfig,
  getNextWorkflowAutomationAction,
  getWorkflowPreviewRequest,
  hasConfirmedUltimateGoal,
  hasMeaningfulUltimateGoal,
  isWorkflowAutomationBlockingAgent,
  isPreviewRecommendation,
  latestAgentByCategory,
  normalizeWorkflowPreviewRequest,
  pickAutopilotRecommendation,
  resolveEffectiveAutopilotPolicy,
  shouldAutopilotPause,
  validateAutopilotPolicy,
  workPackageRequiresModelScoping
} from "@shared/workflow";
import { buildOperatorWorkflowViewModel } from "@shared/operatorWorkflowView";
import { deriveUserFacingWorkflowStatus } from "@shared/workflowView";
import {
  applyChecklistEvidenceObservations,
  buildCycleContract,
  computeChecklistDelta,
  discoverProjectEvidenceCommands,
  extractChecklistEvidenceObservations,
  recordRecommendationFallbackUsed,
  recordStructuredRecommendationFailure,
  recordStructuredRecommendationSuccess
} from "@shared/workflowEvidence";
import {
  buildValidationCommandResult,
  createValidationLedger,
  deriveMergeGateDecision,
  finalizeValidationLedger
} from "@shared/validationLedger";
import { deriveLegacyWorkflowDiagnostics } from "@shared/workflowMigration";
import { buildDeterministicDirectorySummary, buildDeterministicFileSummary, buildDeterministicOverview } from "./fileSummary";
import {
  applyBranchToProjectCheckout,
  attemptMerge,
  checkpointWorktreeChanges,
  createWorktreeAssignment,
  determineDefaultBranch,
  getManagedWorktreeBaseDir,
  listBranchesMissingFromHead,
  listUnmergedWorktreeFiles,
  pruneManagedWorktrees,
  pushBranchToOrigin,
  readGitMetadata
} from "./git";
import { shouldAutoApproveApproval } from "./approvalPolicy";
import { CodexAppServerTransport, type CodexTransport } from "./codexTransport";
import {
  assessCodexProtocolCompatibility,
  checkCodexCliUpdate,
  type CodexUpdateCommandRunner,
  readInstalledCodexCliVersion,
  updateCodexCliIfAvailable
} from "./codexUpdate";
import { RuntimeCommandExecutor, resolveExecutionMode } from "./execution";
import { ensureGitHubRepositoryForCreation, getGitHubStatus, isGitHubRemote } from "./github";
import { sha256 } from "./hashUtils";
import {
  buildInterfaceCreationOutputSchema,
  buildInterfaceCreationTurn,
  createQueuedInterfaceCreationState,
  createSkippedInterfaceCreationState,
  getPathContentHash,
  type InterfaceCreationParseResult,
  parseInterfaceCreationOutput,
  toStoredOverview
} from "./interfaceCreation";
import {
  assertSafeArtifactDestination,
  defaultPortableInterfacePath,
  defaultReviewLogPath,
  defaultVisualExportPath,
  resolveArtifactDestination
} from "./artifactPaths";
import { buildDiscoveredModels, getRecommendedInterfaceCreationModel } from "./modelCatalog";
import { MockCodexTransport } from "./mockCodexTransport";
import { createProjectIdentity } from "./projectIdentity";
import {
  assertExecutionPathWithinProjectRoot,
  assertHostPathWithinProjectRoot,
  assertProjectRelativeHostPath,
  resolveExecutionPathWithinProjectRoot
} from "./projectBoundary";
import { DEFAULT_REPOSITORY_SCAN_LIMITS, hasMeaningfulRepositoryContent, scanRepository, type GitMetadata, type RepoScanResult, type RepositoryScanLimits, type ScannedFile } from "./repoScanner";
import { compactRuntimeEventRecord, reduceAgentRuntimeEvent } from "./runtimeEvents";
import { WorkbenchStorage, type CredentialSecretInput, type SecretStorageCodec } from "./storage";
import { sanitizeWorkflowState } from "./stateSanitizer";
import { readUltimateGoalTextImport } from "./ultimateGoalImport";
import { buildProjectShellHandoffPrompt, buildWorkflowRepairAgentPrompt, openProjectShellWindow } from "./projectShell";
import { scanAndCleanRepoHygiene } from "./repoHygiene";
import { resolveTargetProjectCommands, type TargetProjectResolvedCommand } from "./targetProjectCommands";
import {
  createAgentContextDescriptor,
  createWorkflowContextDescriptor,
  formatRelevantContextForPrompt,
  pruneWorkflowContextDescriptors,
  selectRelevantWorkflowContext
} from "./contextSelector";
import {
  assessUltimateGoalCompletion,
  applyGoalChecklistUpdates,
  buildAppealRecommendations,
  buildChecklistWorkPackages,
  buildChecklistTaskMap,
  buildChecklistTaskMapBrief,
  buildGoalChecklistForAssessment,
  buildGoalChecklistFromUltimateGoal,
  buildOutcomeStrategyBrief,
  buildWorkflowRecommendations,
  estimateUltimateGoalProgress,
  isVisualProject,
  type GoalCheckUpdateInput,
  type WorkflowRecommendationContext
} from "./workflowRecommendations";
import {
  assessIntegrityFailure,
  sanitizeRecommendationForCycle,
  sanitizeScopedGoalForSingleAgent
} from "./workflowGuardrails";
import { buildRepairStrategyContext } from "./workflowRepairPlanner";
import {
  buildVisualPreferenceBrief,
  buildCycleRetrospective,
  buildStrategicPlan,
  decisionFromStrategicPlan,
  rankRecommendationsByStrategicPlan,
  type StrategicPlannerInput
} from "@shared/strategicPlanner";

interface LoadedProject {
  record: LocalProjectRecord;
  tree: RepoTreeNode[];
  scan: RepoScanResult;
  gitMetadata: GitMetadata;
  summaryCache: SummaryCache;
  candidates: InterfaceCandidate[];
}

interface PendingLoad {
  loadResult: ProjectLoadResult;
  scan: RepoScanResult;
  gitMetadata: GitMetadata;
}

type AppServiceInitializeOptions = {
  deferStartupWork?: boolean;
  safeMode?: boolean;
};
type CodexUpdateRunOptions = {
  approvedCommand?: string;
  commandRunner?: CodexUpdateCommandRunner;
};
type InterfaceCreationParseFailure = Exclude<InterfaceCreationParseResult, { ok: true }>;
type ProjectSaveMode = "immediate" | "deferred" | false;
type StateEmitMode = "immediate" | "coalesced" | false;
type PersistProjectUpdateOptions = {
  save?: ProjectSaveMode;
  emit?: StateEmitMode;
  automate?: boolean;
  reason?: string;
};
type ProjectSaveOptions = {
  force?: boolean;
  syncWorkflow?: boolean;
};
type ProjectSaveTimer = {
  timer: ReturnType<typeof setTimeout>;
  syncWorkflow: boolean;
};
type WorkflowAutomationTimer = {
  timer: ReturnType<typeof setTimeout>;
  generation: number;
};
type StructuredOutputKind = "recommendation" | "scoped_goal" | "repository_path_summary";
type StructuredOutputGuard = {
  key: string;
  kind: StructuredOutputKind;
  contentHash: string;
  source?: string;
};

const writeEnabledAgentCategories = new Set<AgentCategory>(["coding", "manual"]);
const isWriteEnabledAgentCategory = (category: AgentCategory): boolean => writeEnabledAgentCategories.has(category);
const activeAgentStatuses = new Set<AgentState["status"]>(["starting", "running", "waiting_approval"]);
const isAgentActive = (agent: AgentState): boolean => activeAgentStatuses.has(agent.status);
const EXTERNAL_REPAIR_REVALIDATION_REASON = "External repair completed in the opened checkout; revalidate the current checkout before merge.";
const MAX_WORKFLOW_ACTIVITY_DETAIL_LENGTH = 1_200;
const MAX_PROMPT_DETAIL_LENGTH = 280;
const MAX_RECOMMENDATION_PROMPT_DETAIL_LENGTH = 180;
const MAX_RECOMMENDATION_PROMPT_CHECKLIST_ITEMS = 14;
const RENDERER_AGENT_EVENT_PREVIEW_LIMIT = 3;
const RENDERER_AGENT_COMMAND_PREVIEW_LIMIT = 1;
const RENDERER_RECENT_AGENT_PREVIEW_LIMIT = 30;
const RENDERER_AGENT_DETAIL_EVENT_LIMIT = 40;
const RENDERER_AGENT_DETAIL_COMMAND_LIMIT = 8;
const RENDERER_COMMAND_TEXT_LIMIT = 4_000;
const RENDERER_COMMAND_OUTPUT_LIMIT = 6_000;
const RENDERER_RAW_EVENT_LIMIT = 4_000;
const RENDERER_REPO_TREE_PREVIEW_ROOT_LIMIT = 32;
const RENDERER_REPO_TREE_PREVIEW_CHILD_LIMIT = 8;
const RENDERER_REPOSITORY_DEPENDENCY_LIMIT = 80;
const RENDERER_REPOSITORY_SUMMARY_CACHE_LIMIT = 80;
const RENDERER_PAYLOAD_WARNING_BYTES = 1_000_000;
const RENDERER_PAYLOAD_HARD_LIMIT_BYTES = 1_800_000;
const REPOSITORY_CHILDREN_DEFAULT_LIMIT = 5_000;
const REPOSITORY_CHILDREN_MAX_LIMIT = 20_000;
const REPOSITORY_SEARCH_DEFAULT_LIMIT = 5_000;
const REPOSITORY_SEARCH_MAX_LIMIT = 20_000;
const REPOSITORY_PAYLOAD_WARNING_BYTES = 750_000;
const REPOSITORY_DEEP_SCAN_MULTIPLIER = 4;
const CODEX_READINESS_PROBE_TIMEOUT_MS = 10_000;
const STATE_EMIT_THROTTLE_MS = 350;
const LIVE_PROJECT_SAVE_THROTTLE_MS = 3_000;
const LIVE_DELTA_REDUCE_THROTTLE_MS = 1_500;
const WORKFLOW_PERF_COUNTER_LOG_INTERVAL_MS = 5_000;
const WORKFLOW_AUTOMATION_SCHEDULE_DELAY_MS = 25;
const WORKFLOW_AUTOMATION_NO_PROGRESS_LIMIT = 2;
const WORKFLOW_AUTOMATION_HARD_ACTION_LIMIT = 20;
const STRUCTURED_OUTPUT_HISTORY_LIMIT = 24;
const WSL_WINDOWS_MOUNT_PATH = /^\/mnt\/[a-z](?:\/|$)/i;

const positiveAutonomyLimit = (value: number | undefined): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

const minPositiveLimit = (...values: Array<number | undefined>): number =>
  Math.min(...values.filter((value): value is number => positiveAutonomyLimit(value) !== undefined));

const throttledTransportDeltaMethods = new Set<string>([
  "turn/diff/updated",
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "command/exec/outputDelta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated"
]);
const workflowActivitySuppressedTransportMethods = new Set<string>([
  "thread/tokenUsage/updated",
  "turn/plan/updated",
  "rawResponseItem/completed",
  "item/reasoning/summaryPartAdded",
  ...throttledTransportDeltaMethods
]);
const ignoredRendererUpdateMethods = new Set<string>([
  "thread/tokenUsage/updated",
  "item/reasoning/summaryPartAdded",
  ...throttledTransportDeltaMethods
]);
const immediateTransportFlushMethods = new Set<string>([
  "turn/completed",
  "error"
]);
const workflowAutomationTriggerMethods = new Set<string>([
  "thread/status/changed",
  "turn/completed",
  "error"
]);

const compactText = (value: string, maxLength: number): string => {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxLength - 24)).trimEnd()}...[truncated]`;
};

const toTime = (value?: string): number => {
  if (!value) {
    return 0;
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
};

const formatBytesForStatus = (value: number): string => {
  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (value >= 1024) {
    return `${Math.round(value / 1024)} KB`;
  }
  return `${value} bytes`;
};

const requiredRepositoryScanSettings = (limits: RepositoryScanLimits): Required<RepositoryScanSettings> => ({
  maxIncludedFiles: limits.maxIncludedFiles,
  maxIncludedDirectories: limits.maxIncludedDirectories,
  maxDepth: limits.maxDepth,
  maxManifestFileSizeBytes: limits.maxManifestFileSizeBytes,
  maxScanDurationMs: limits.maxScanDurationMs,
  maxExcludedPathRecords: limits.maxExcludedPathRecords
});

const scaleRepositoryScanSettings = (
  limits: Required<RepositoryScanSettings>,
  multiplier: number,
  overrides: Partial<RepositoryScanSettings> = {}
): Required<RepositoryScanSettings> => ({
  maxIncludedFiles: overrides.maxIncludedFiles ?? limits.maxIncludedFiles * multiplier,
  maxIncludedDirectories: overrides.maxIncludedDirectories ?? limits.maxIncludedDirectories * multiplier,
  maxDepth: overrides.maxDepth ?? limits.maxDepth * multiplier,
  maxManifestFileSizeBytes: overrides.maxManifestFileSizeBytes ?? limits.maxManifestFileSizeBytes * multiplier,
  maxScanDurationMs: overrides.maxScanDurationMs ?? limits.maxScanDurationMs * multiplier,
  maxExcludedPathRecords: overrides.maxExcludedPathRecords ?? limits.maxExcludedPathRecords * multiplier
});

const REPOSITORY_DEFAULT_SCAN_SETTINGS = requiredRepositoryScanSettings(DEFAULT_REPOSITORY_SCAN_LIMITS);
const REPOSITORY_DEEP_SCAN_SETTINGS = scaleRepositoryScanSettings(REPOSITORY_DEFAULT_SCAN_SETTINGS, REPOSITORY_DEEP_SCAN_MULTIPLIER, {
  maxIncludedFiles: 100_000,
  maxIncludedDirectories: 60_000,
  maxDepth: 128,
  maxManifestFileSizeBytes: DEFAULT_REPOSITORY_SCAN_LIMITS.maxManifestFileSizeBytes * 2,
  maxScanDurationMs: 120_000,
  maxExcludedPathRecords: DEFAULT_REPOSITORY_SCAN_LIMITS.maxExcludedPathRecords * 2
});
const REPOSITORY_HARD_SCAN_SETTINGS = scaleRepositoryScanSettings(REPOSITORY_DEFAULT_SCAN_SETTINGS, 8, {
  maxIncludedFiles: 100_000,
  maxIncludedDirectories: 60_000,
  maxDepth: 128,
  maxManifestFileSizeBytes: DEFAULT_REPOSITORY_SCAN_LIMITS.maxManifestFileSizeBytes * 8,
  maxScanDurationMs: 180_000,
  maxExcludedPathRecords: DEFAULT_REPOSITORY_SCAN_LIMITS.maxExcludedPathRecords * 8
});

const clampRepositoryScanSetting = (value: number | undefined, fallback: number, max: number): number =>
  Math.max(1, Math.min(max, Math.floor(value ?? fallback)));

const normalizeRepositoryScanSettings = (
  settings: RepositoryScanSettings | undefined,
  fallback: Required<RepositoryScanSettings> = REPOSITORY_DEEP_SCAN_SETTINGS
): Required<RepositoryScanSettings> => ({
  maxIncludedFiles: clampRepositoryScanSetting(settings?.maxIncludedFiles, fallback.maxIncludedFiles, REPOSITORY_HARD_SCAN_SETTINGS.maxIncludedFiles),
  maxIncludedDirectories: clampRepositoryScanSetting(settings?.maxIncludedDirectories, fallback.maxIncludedDirectories, REPOSITORY_HARD_SCAN_SETTINGS.maxIncludedDirectories),
  maxDepth: clampRepositoryScanSetting(settings?.maxDepth, fallback.maxDepth, REPOSITORY_HARD_SCAN_SETTINGS.maxDepth),
  maxManifestFileSizeBytes: clampRepositoryScanSetting(settings?.maxManifestFileSizeBytes, fallback.maxManifestFileSizeBytes, REPOSITORY_HARD_SCAN_SETTINGS.maxManifestFileSizeBytes),
  maxScanDurationMs: clampRepositoryScanSetting(settings?.maxScanDurationMs, fallback.maxScanDurationMs, REPOSITORY_HARD_SCAN_SETTINGS.maxScanDurationMs),
  maxExcludedPathRecords: clampRepositoryScanSetting(settings?.maxExcludedPathRecords, fallback.maxExcludedPathRecords, REPOSITORY_HARD_SCAN_SETTINGS.maxExcludedPathRecords)
});

const toStoredRepositoryScanSettings = (settings: RepositoryScanSettings): RepositoryScanSettings => {
  const normalized = normalizeRepositoryScanSettings(settings);
  return {
    maxIncludedFiles: normalized.maxIncludedFiles,
    maxIncludedDirectories: normalized.maxIncludedDirectories,
    maxDepth: normalized.maxDepth,
    maxManifestFileSizeBytes: normalized.maxManifestFileSizeBytes,
    maxScanDurationMs: normalized.maxScanDurationMs,
    maxExcludedPathRecords: normalized.maxExcludedPathRecords
  };
};

const compactRawForRenderer = (value: unknown): unknown => {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return compactText(value, RENDERER_RAW_EVENT_LIMIT);
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return compactText(String(value), RENDERER_RAW_EVENT_LIMIT);
  }
  try {
    return compactText(JSON.stringify(value), RENDERER_RAW_EVENT_LIMIT);
  } catch (error) {
    return compactText(error instanceof Error ? error.message : "Unserializable raw event", RENDERER_RAW_EVENT_LIMIT);
  }
};

const compactRepoTreePreview = (nodes: RepoTreeNode[]): RepoTreeNode[] => {
  const compactNode = (node: RepoTreeNode, depth: number): RepoTreeNode => {
    const preview: RepoTreeNode = {
      path: node.path,
      name: node.name,
      type: node.type,
      size: node.size,
      language: node.language,
      childCount: node.type === "directory" ? node.children?.length ?? node.childCount : undefined
    };
    if (node.type === "directory" && node.children && depth === 0) {
      preview.children = node.children
        .slice(0, RENDERER_REPO_TREE_PREVIEW_CHILD_LIMIT)
        .map((child) => compactNode(child, depth + 1));
    }
    return preview;
  };

  return nodes
    .slice(0, RENDERER_REPO_TREE_PREVIEW_ROOT_LIMIT)
    .map((node) => compactNode(node, 0));
};

const compactOverviewForRenderer = (overview: ProjectOverview | undefined): ProjectOverview | undefined => overview
  ? {
    ...overview,
    summary: compactText(overview.summary, 1_200),
    architecture: compactText(overview.architecture, 1_500),
    whatProjectDoes: overview.whatProjectDoes ? compactText(overview.whatProjectDoes, 800) : overview.whatProjectDoes,
    howItIsOrganized: overview.howItIsOrganized ? compactText(overview.howItIsOrganized, 800) : overview.howItIsOrganized,
    importantToKnowFirst: overview.importantToKnowFirst ? compactText(overview.importantToKnowFirst, 800) : overview.importantToKnowFirst,
    importantFiles: overview.importantFiles.slice(0, 24),
    subsystemSummaries: overview.subsystemSummaries.slice(0, 12).map((summary) => ({
      ...summary,
      summary: compactText(summary.summary, 500),
      paths: summary.paths.slice(0, 12)
    })),
    dependencyHighlights: overview.dependencyHighlights.slice(0, 16).map((entry) => compactText(entry, 240)),
    statisticsSummary: overview.statisticsSummary ? compactText(overview.statisticsSummary, 500) : overview.statisticsSummary,
    recommendations: overview.recommendations.slice(0, 12).map((entry) => compactText(entry, 280))
  }
  : undefined;

const countRepoTreeNodes = (nodes: RepoTreeNode[]): number => {
  let count = 0;
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) {
      continue;
    }
    count += 1;
    if (node.children?.length) {
      stack.push(...node.children);
    }
  }
  return count;
};

const isRepoTreePreviewTruncated = (nodes: RepoTreeNode[]): boolean =>
  nodes.length > RENDERER_REPO_TREE_PREVIEW_ROOT_LIMIT ||
  nodes
    .slice(0, RENDERER_REPO_TREE_PREVIEW_ROOT_LIMIT)
    .some((node) => node.type === "directory" && (node.children?.length ?? 0) > RENDERER_REPO_TREE_PREVIEW_CHILD_LIMIT);

interface AgentCredentialCapture {
  providerName: string;
  keyLabel: string;
  apiKey: string;
  secretKey?: string;
  notes?: string;
  freeTier?: boolean;
}

const userDerivedGoalCheckSources = new Set<GoalAttainmentCheck["source"]>(["success_criterion", "quality_bar", "constraint"]);
const weakGoalEvidenceStopwords = new Set([
  "accepted",
  "after",
  "agent",
  "agents",
  "check",
  "checklist",
  "complete",
  "completed",
  "completion",
  "cycle",
  "deterministic",
  "evidence",
  "goal",
  "integration",
  "latest",
  "package",
  "passed",
  "readiness",
  "required",
  "satisfy",
  "scoped",
  "slice",
  "smallest",
  "stabilize",
  "startup",
  "test",
  "tests",
  "validation",
  "viable",
  "work",
  "workflow"
]);
const genericGoalCompletionEvidencePatterns = [
  /\bCycle\s+\d+\s+completed after deterministic validation and integration\b/i,
  /\bcompleted after deterministic validation and integration\b/i
];

export class AppService extends EventEmitter<{ stateChanged: [WorkbenchState] }> {
  private static readonly activeServicesByAppDataDir = new Map<string, AppService>();
  private settings: AppSettings = defaultSettings();
  private githubStatus: GitHubStatus = {
    state: "not_linked",
    sshReady: false,
    message: "Link GitHub before using the workbench."
  };
  private readonly storage: WorkbenchStorage;
  private readonly projects = new Map<string, LoadedProject>();
  private readonly threadToAgent = new Map<string, { projectId: string; agentId: string }>();
  private activeProjectId?: string;
  private pendingLoad?: PendingLoad;
  private transport?: CodexTransport;
  private availableModels: DiscoveredModel[] = [];
  private codexAvailability: CodexAvailability = { source: "unavailable", message: "Codex model discovery has not run yet." };
  private codexReadiness: CodexReadinessReport = {
    executionMode: this.settings.executionMode,
    distroName: this.settings.distroName,
    codexBinaryPath: this.settings.codexBinaryPath,
    updateAvailable: false,
    status: "skipped",
    message: "Codex readiness has not run yet."
  };
  private codexUpdateCheck?: CodexUpdateCheckResult;
  private codexReadinessInFlight?: Promise<CodexReadinessReport>;
  private codexUpdateCheckInFlight?: Promise<CodexUpdateCheckResult>;
  private readonly diagnostics: string[] = [];
  private readonly interfaceCreationRepairAttempts = new Map<string, number>();
  private readonly workflowAutomationInFlight = new Set<string>();
  private readonly workflowAutomationQueued = new Set<string>();
  private readonly workflowAutomationTimers = new Map<string, WorkflowAutomationTimer>();
  private readonly workflowAutomationGenerations = new Map<string, number>();
  private readonly workflowRecoveryInFlight = new Set<string>();
  private readonly workflowMergeInFlight = new Set<string>();
  private readonly workflowMergeRetryInFlight = new Set<string>();
  private readonly liveDeltaLastReducedAt = new Map<string, number>();
  private pendingStateEmitTimer?: ReturnType<typeof setTimeout>;
  private readonly pendingProjectSaveTimers = new Map<string, ProjectSaveTimer>();
  private readonly projectSaveFingerprints = new Map<string, string>();
  private readonly projectSaveInFlight = new Map<string, Promise<void>>();
  private readonly projectSaveQueued = new Map<string, Promise<void>>();
  private readonly projectSaveQueuedOptions = new Map<string, ProjectSaveOptions>();
  private readonly repositoryScanOperations = new Map<string, { startedAt: string; mode: "normal" | "deep"; settings: Required<RepositoryScanSettings> }>();
  private readonly repositoryScanFailures = new Map<string, { failedAt: string; message: string; recoverySteps: string[] }>();
  private readonly registeredProjectIds = new Set<string>();
  private readonly structuredOutputApplicationsInFlight = new Set<string>();
  private lastRecommendationParseFailure?: {
    category: StructuredRecommendationFailureCategory;
    message: string;
  };
  private readonly commandOutputBuffers = new Map<string, {
    command?: string;
    cwd?: string;
    startedAt?: string;
    output: string;
  }>();
  private suppressTransportExitHandling = false;
  private transportInitialization?: Promise<void>;
  private runtimeReadinessChecking = false;
  private runtimeReadinessLastCheckedAt?: string;
  private disposed = false;
  private safeMode = false;
  private disposePromise?: Promise<void>;
  private deferredStartupWork?: Promise<void>;
  private readonly repositoryIndexLoadOperations = new Map<string, Promise<void>>();
  private readonly debugWorkflowPerf = process.env.WORKBENCH_PERF === "1" || process.env.AWB_DEBUG_WORKFLOW_PERF === "1";
  private readonly workflowPerfCounters = new Map<string, { count: number; startedAt: number; lastLoggedAt: number }>();

  constructor(
    private readonly appDataDir: string,
    secretCodec?: SecretStorageCodec
  ) {
    super();
    this.storage = new WorkbenchStorage(appDataDir, secretCodec);
  }

  private logWorkflowPerf(message: string): void {
    if (this.debugWorkflowPerf) {
      console.info(`[workflow-perf] ${message}`);
    }
  }

  private recordWorkflowPerfCounter(name: string, detail?: string): void {
    if (!this.debugWorkflowPerf) {
      return;
    }

    const now = performance.now();
    const counter = this.workflowPerfCounters.get(name) ?? { count: 0, startedAt: now, lastLoggedAt: now };
    counter.count += 1;
    if (now - counter.lastLoggedAt >= WORKFLOW_PERF_COUNTER_LOG_INTERVAL_MS) {
      const elapsedSeconds = Math.max(0.001, (now - counter.startedAt) / 1_000);
      this.logWorkflowPerf(`${name}: ${counter.count} total, ${(counter.count / elapsedSeconds).toFixed(1)}/s${detail ? `, ${detail}` : ""}`);
      counter.lastLoggedAt = now;
    }
    this.workflowPerfCounters.set(name, counter);
  }

  private collectRendererStateStats(state: WorkbenchState): string {
    let agents = 0;
    let events = 0;
    let commands = 0;
    let activity = 0;
    let recommendations = 0;
    for (const project of state.projects) {
      agents += project.record.agents.length;
      activity += project.record.workflow.activityLog.length;
      recommendations += project.record.workflow.recommendations.length;
      for (const agent of project.record.agents) {
        events += agent.events.length;
        commands += agent.commandLog.length;
      }
    }
    return [
      `projects=${state.projects.length}`,
      `agents=${agents}`,
      `events=${events}`,
      `commands=${commands}`,
      `activity=${activity}`,
      `recommendations=${recommendations}`
    ].join(" ");
  }

  private measureRendererPayload(payload: WorkbenchState): RendererPayloadInfo {
    let sizeBytes = 0;
    let activeProjectSizeBytes = 0;
    try {
      sizeBytes = Buffer.byteLength(JSON.stringify({
        ...payload,
        rendererPayload: undefined
      }));
      const activeProject = payload.projects.find((project) => project.record.id === payload.activeProjectId);
      activeProjectSizeBytes = activeProject ? Buffer.byteLength(JSON.stringify(activeProject.record)) : 0;
    } catch {
      sizeBytes = Number.MAX_SAFE_INTEGER;
      activeProjectSizeBytes = Number.MAX_SAFE_INTEGER;
    }
    return {
      sizeBytes,
      activeProjectSizeBytes,
      limitBytes: RENDERER_PAYLOAD_HARD_LIMIT_BYTES,
      truncated: false
    };
  }

  private withRendererPayloadInfo(state: WorkbenchState, info: RendererPayloadInfo): WorkbenchState {
    return {
      ...state,
      rendererPayload: info
    };
  }

  private capRendererStatePayload(state: WorkbenchState, label: string): WorkbenchState {
    const measured = this.measureRendererPayload(state);
    if (measured.sizeBytes <= RENDERER_PAYLOAD_HARD_LIMIT_BYTES) {
      const info: RendererPayloadInfo = {
        ...measured,
        warning: measured.sizeBytes > RENDERER_PAYLOAD_WARNING_BYTES
          ? `Renderer state is ${formatBytesForStatus(measured.sizeBytes)}. Nonessential details will be omitted above ${formatBytesForStatus(RENDERER_PAYLOAD_HARD_LIMIT_BYTES)}.`
          : undefined
      };
      if (this.debugWorkflowPerf) {
        this.logWorkflowPerf(`${label}: renderer payload measured ${measured.sizeBytes} bytes, activeProject=${measured.activeProjectSizeBytes ?? 0} bytes`);
      }
      return this.withRendererPayloadInfo(state, info);
    }

    const degradedProjects = [...this.projects.values()].map((project) => {
      const inactive = project.record.id !== this.activeProjectId;
      return {
        record: this.compactRendererProjectRecord(project.record, { inactive, summaryOnly: true }),
        tree: inactive ? [] : compactRepoTreePreview(project.tree),
        validationStatus: project.record.validation.lastValidatedAt ? "exact" as const : "unvalidated" as const,
        candidates: []
      };
    });
    const degraded: WorkbenchState = {
      ...state,
      projects: degradedProjects,
      diagnostics: [
        `Renderer state exceeded ${formatBytesForStatus(RENDERER_PAYLOAD_HARD_LIMIT_BYTES)}; nonessential project details were omitted from this update.`,
        ...state.diagnostics.slice(0, 100).map((entry) => compactText(entry, 1_000))
      ]
    };
    let cappedState = degraded;
    let after = this.measureRendererPayload(cappedState);
    if (after.sizeBytes > RENDERER_PAYLOAD_HARD_LIMIT_BYTES) {
      const activeProject = degraded.projects.find((project) => project.record.id === this.activeProjectId);
      cappedState = {
        ...degraded,
        projects: activeProject ? [activeProject] : degraded.projects.slice(0, 1),
        diagnostics: [
          `Renderer state remained above ${formatBytesForStatus(RENDERER_PAYLOAD_HARD_LIMIT_BYTES)} after compaction; inactive project details were omitted from this update.`,
          ...degraded.diagnostics.slice(0, 100).map((entry) => compactText(entry, 1_000))
        ]
      };
      after = this.measureRendererPayload(cappedState);
    }
    const info: RendererPayloadInfo = {
      ...after,
      truncated: true,
      warning: `Renderer state was capped from ${formatBytesForStatus(measured.sizeBytes)} to ${formatBytesForStatus(after.sizeBytes)}. Open history/output details on demand.`
    };
    if (this.debugWorkflowPerf) {
      this.logWorkflowPerf(`${label}: renderer payload capped ${measured.sizeBytes} -> ${after.sizeBytes} bytes, ${this.collectRendererStateStats(cappedState)}`);
    }
    return this.withRendererPayloadInfo(cappedState, info);
  }

  private normalizePersistProjectUpdateOptions(
    options?: boolean | PersistProjectUpdateOptions
  ): Required<PersistProjectUpdateOptions> {
    if (typeof options === "boolean" || options === undefined) {
      return {
        save: options ? "immediate" : "deferred",
        emit: "coalesced",
        automate: Boolean(options),
        reason: options ? "project update with automation" : "project update"
      };
    }
    return {
      save: options.save ?? "immediate",
      emit: options.emit ?? "coalesced",
      automate: options.automate ?? false,
      reason: options.reason ?? "project update"
    };
  }

  private structuredOutputContentHash(rawText: string): string {
    return sha256(rawText.trim().replace(/\s+/g, " "));
  }

  private beginStructuredOutputApplication(
    project: LoadedProject,
    agent: AgentState,
    kind: StructuredOutputKind,
    rawText: string,
    source?: string
  ): StructuredOutputGuard | undefined {
    const contentHash = this.structuredOutputContentHash(rawText);
    agent.appliedStructuredOutputs ??= [];
    if (agent.appliedStructuredOutputs.some((entry) => entry.kind === kind && entry.contentHash === contentHash)) {
      return undefined;
    }
    const key = `${project.record.id}:${agent.id}:${kind}:${contentHash}`;
    if (this.structuredOutputApplicationsInFlight.has(key)) {
      return undefined;
    }
    this.structuredOutputApplicationsInFlight.add(key);
    return { key, kind, contentHash, source };
  }

  private finishStructuredOutputApplication(agent: AgentState, guard: StructuredOutputGuard): void {
    this.structuredOutputApplicationsInFlight.delete(guard.key);
    agent.appliedStructuredOutputs ??= [];
    if (!agent.appliedStructuredOutputs.some((entry) => entry.kind === guard.kind && entry.contentHash === guard.contentHash)) {
      agent.appliedStructuredOutputs.unshift({
        kind: guard.kind,
        contentHash: guard.contentHash,
        appliedAt: nowIso(),
        source: guard.source
      });
      agent.appliedStructuredOutputs = agent.appliedStructuredOutputs.slice(0, STRUCTURED_OUTPUT_HISTORY_LIMIT);
    }
  }

  private abortStructuredOutputApplication(guard: StructuredOutputGuard | undefined): void {
    if (guard) {
      this.structuredOutputApplicationsInFlight.delete(guard.key);
    }
  }

  private markProjectDirty(projectId: string): void {
    this.projectSaveFingerprints.delete(projectId);
  }

  private getTransportDeltaItemId(notification: ServerNotification): string {
    if (!("params" in notification) || !notification.params || typeof notification.params !== "object") {
      return "unknown";
    }
    const params = notification.params as { itemId?: unknown; processId?: unknown };
    const rawId = params.itemId ?? params.processId;
    return typeof rawId === "string" || typeof rawId === "number" ? String(rawId) : "unknown";
  }

  private shouldReduceLiveTransportDelta(projectId: string, agentId: string, notification: ServerNotification): boolean {
    if (!throttledTransportDeltaMethods.has(notification.method)) {
      return true;
    }

    const key = `${projectId}:${agentId}:${notification.method}:${this.getTransportDeltaItemId(notification)}`;
    const now = performance.now();
    const lastReducedAt = this.liveDeltaLastReducedAt.get(key);
    if (lastReducedAt !== undefined && now - lastReducedAt < LIVE_DELTA_REDUCE_THROTTLE_MS) {
      return false;
    }
    this.liveDeltaLastReducedAt.set(key, now);
    return true;
  }

  private getRendererStateForEmit(label: string): WorkbenchState {
    const startedAt = performance.now();
    const state = this.getRendererState();
    if (this.debugWorkflowPerf) {
      let payloadSize = 0;
      let activeProjectSize = 0;
      try {
        payloadSize = JSON.stringify(state).length;
        const activeProject = state.projects.find((project) => project.record.id === state.activeProjectId);
        activeProjectSize = activeProject ? JSON.stringify(activeProject.record).length : 0;
      } catch {
        payloadSize = -1;
        activeProjectSize = -1;
      }
      this.logWorkflowPerf(
        `${label}: renderer payload ${payloadSize} bytes, activeProject=${activeProjectSize} bytes, ${this.collectRendererStateStats(state)} in ${Math.round(performance.now() - startedAt)}ms`
      );
    }
    return state;
  }

  private quotePowerShellArgument(value: string): string {
    return `"${value.replace(/`/g, "``").replace(/"/g, "`\"")}"`;
  }

  private quoteBashArgument(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
  }

  private buildCodexDiagnosticCommand(): string {
    const codexCommand = this.settings.codexBinaryPath || "codex";
    if (process.platform === "win32" && this.settings.executionMode === "wsl") {
      const bashCommand = [
        "set -e",
        "echo WSL runtime:",
        "uname -a",
        "echo Node:",
        "command -v node",
        "node --version",
        "echo Codex:",
        `command -v ${this.quoteBashArgument(codexCommand)}`,
        `${this.quoteBashArgument(codexCommand)} --version`
      ].join(" && ");
      return `wsl -d ${this.quotePowerShellArgument(this.settings.distroName)} -- bash -lc ${this.quotePowerShellArgument(bashCommand)}`;
    }

    if (process.platform === "win32") {
      const powerShellCommand = [
        "$ErrorActionPreference = 'Stop'",
        "Write-Host 'Node:'",
        "Get-Command node | Select-Object -ExpandProperty Source",
        "node --version",
        "Write-Host 'Codex:'",
        `Get-Command ${this.quotePowerShellArgument(codexCommand)} | Select-Object -ExpandProperty Source`,
        `& ${this.quotePowerShellArgument(codexCommand)} --version`
      ].join("; ");
      return `powershell -NoProfile -Command ${this.quotePowerShellArgument(powerShellCommand)}`;
    }

    const shellCommand = [
      "command -v node",
      "node --version",
      `command -v ${this.quoteBashArgument(codexCommand)}`,
      `${this.quoteBashArgument(codexCommand)} --version`
    ].join(" && ");
    return `bash -lc ${this.quoteBashArgument(shellCommand)}`;
  }

  private buildCodexInstallCommand(): string | undefined {
    const version = this.codexUpdateCheck?.latestVersion ?? "latest";
    if (process.platform === "win32" && this.settings.executionMode === "wsl") {
      return `wsl -d ${this.quotePowerShellArgument(this.settings.distroName)} -- npm install -g @openai/codex@${version}`;
    }
    return `npm install -g @openai/codex@${version}`;
  }

  private buildRuntimeReadinessReport(project?: LoadedProject): RuntimeReadinessReport {
    const checks: RuntimeDependencyCheck[] = [];
    const addCheck = (check: RuntimeDependencyCheck): void => {
      checks.push(check);
    };

    addCheck({
      id: "github",
      label: "GitHub account",
      status: this.isGitHubLinked() ? "passed" : "failed",
      message: this.githubStatus.message,
      fixInApp: "Open Settings and refresh GitHub status after completing the GitHub link command.",
      manualCommand: "gh auth login --hostname github.com --git-protocol ssh --web"
    });

    const mode = resolveExecutionMode(this.settings, process.platform);
    addCheck({
      id: "runtime-target",
      label: mode === "wsl" ? "Windows to WSL runtime" : "Local runtime",
      status: "passed",
      message: mode === "wsl"
        ? `Workbench is configured to run Codex and project commands through WSL distro "${this.settings.distroName}".`
        : "Workbench is configured to run Codex and project commands in the native process environment.",
      fixInApp: "Open Settings to change execution mode, WSL distro, Codex binary, CODEX_HOME, or worktree base."
    });

    const projectAccess = project?.record.validation.projectAccess;
    if (projectAccess) {
      addCheck({
        id: "project-access",
        label: "Project write access",
        status: projectAccess.status === "passed" ? "passed" : "failed",
        message: projectAccess.status === "passed"
          ? projectAccess.message
          : projectAccess.error ?? projectAccess.message,
        fixInApp: "Reopen the project after fixing filesystem permissions or moving it to a writable WSL/Git checkout."
      });
    }

    if (project && this.isWindowsMountedWslProject(project)) {
      addCheck({
        id: "windows-mounted-wsl-path",
        label: "Project path performance",
        status: "warning",
        message: "This project is under /mnt/*. Windows-mounted WSL paths can make Git, npm, and Codex startup much slower.",
        fixInApp: "Move or clone the project inside the WSL filesystem, then open that WSL path from the launcher."
      });
    }

    if (this.runtimeReadinessChecking) {
      addCheck({
        id: "codex-model-discovery",
        label: "Codex model discovery",
        status: "checking",
        message: "Checking Codex CLI, app-server startup, and model discovery.",
        fixInApp: "Wait for the check to finish, or open Settings to verify the runtime target.",
        manualCommand: this.buildCodexDiagnosticCommand()
      });
    } else if (this.codexAvailability.source !== "unavailable" && this.availableModels.length > 0) {
      addCheck({
        id: "codex-model-discovery",
        label: "Codex model discovery",
        status: "passed",
        message: `Model discovery is available with ${this.availableModels.length} model${this.availableModels.length === 1 ? "" : "s"}.`,
        manualCommand: this.buildCodexDiagnosticCommand()
      });
    } else {
      const installCommand = this.buildCodexInstallCommand();
      addCheck({
        id: "codex-model-discovery",
        label: "Codex model discovery",
        status: "failed",
        message: this.codexAvailability.message ?? "Codex app-server and model discovery are not available.",
        fixInApp: "Open Settings, confirm the execution mode, WSL distro, Codex binary, and CODEX_HOME, save, then run readiness checks again.",
        manualCommand: installCommand
          ? `${this.buildCodexDiagnosticCommand()}\n${installCommand}`
          : this.buildCodexDiagnosticCommand()
      });
    }

    const hasFailure = checks.some((check) => check.status === "failed");
    const checking = checks.some((check) => check.status === "checking");
    const status: RuntimeReadinessReport["status"] = checking ? "checking" : hasFailure ? "blocked" : "ready";
    const failedLabels = checks.filter((check) => check.status === "failed").map((check) => check.label);
    return {
      status,
      checkedAt: this.runtimeReadinessLastCheckedAt,
      summary: status === "ready"
        ? "Runtime checks passed. Agent-backed workflow actions are available."
        : status === "checking"
          ? "Runtime checks are running. Agent-backed workflow actions are blocked until model discovery passes."
          : `Agent-backed workflow actions are blocked: ${failedLabels.join(", ")}.`,
      blockAgentActions: status !== "ready",
      checks
    };
  }

  private getActiveProject(): LoadedProject | undefined {
    return this.activeProjectId ? this.projects.get(this.activeProjectId) : undefined;
  }

  private canRunAgentBackedActions(project?: LoadedProject): boolean {
    const report = this.buildRuntimeReadinessReport(project ?? this.getActiveProject());
    return !report.blockAgentActions;
  }

  private hasNonCodexRuntimeFailure(project?: LoadedProject): boolean {
    return this.buildRuntimeReadinessReport(project ?? this.getActiveProject()).checks.some((check) =>
      check.status === "failed" && check.id !== "codex-model-discovery"
    );
  }

  private runtimeReadinessErrorMessage(project?: LoadedProject): string {
    const report = this.buildRuntimeReadinessReport(project ?? this.getActiveProject());
    const detail = report.checks
      .filter((check) => check.status === "failed")
      .map((check) => `${check.label}: ${check.message}`)
      .join(" ");
    return `${report.summary}${detail ? ` ${detail}` : ""}`;
  }

  private async ensureAgentBackedRuntimeReady(project: LoadedProject, reason: string): Promise<void> {
    if (this.hasNonCodexRuntimeFailure(project)) {
      throw new Error(this.runtimeReadinessErrorMessage(project));
    }
    if (!this.canRunAgentBackedActions(project)) {
      await this.refreshRuntimeReadiness(reason);
    }
    if (!this.canRunAgentBackedActions(project)) {
      throw new Error(this.runtimeReadinessErrorMessage(project));
    }
  }

  async refreshRuntimeReadiness(reason = "runtime readiness check"): Promise<RuntimeReadinessReport> {
    if (this.runtimeReadinessChecking) {
      if (this.transportInitialization) {
        await this.transportInitialization;
      }
      return this.buildRuntimeReadinessReport(this.getActiveProject());
    }

    const reusableTransport = this.transport;
    const hasReusableTransport = Boolean(reusableTransport && this.codexAvailability.source !== "unavailable");
    this.runtimeReadinessChecking = true;
    this.codexAvailability = {
      ...this.codexAvailability,
      message: "Checking Codex CLI, app-server startup, and model discovery."
    };
    this.emitStateNow(`${reason} started`);
    try {
      if (hasReusableTransport && reusableTransport && this.transport === reusableTransport) {
        this.availableModels = buildDiscoveredModels((await reusableTransport.listModels()).data);
        if (this.availableModels.length === 0) {
          this.codexAvailability = {
            source: "unavailable",
            message: "Codex app-server started, but model discovery returned no available models."
          };
        }
      } else {
        await this.initializeTransport();
        if (this.codexAvailability.source !== "unavailable" && this.availableModels.length === 0) {
          this.codexAvailability = {
            source: "unavailable",
            message: "Codex app-server started, but model discovery returned no available models."
          };
        }
      }
    } catch (error) {
      this.transport = undefined;
      this.availableModels = [];
      this.codexAvailability = {
        source: "unavailable",
        message: error instanceof Error ? error.message : String(error)
      };
      this.diagnostics.unshift(`Runtime readiness check failed. ${this.codexAvailability.message}`);
    } finally {
      this.runtimeReadinessChecking = false;
      this.runtimeReadinessLastCheckedAt = nowIso();
    }

    const report = this.buildRuntimeReadinessReport(this.getActiveProject());
    this.emitStateNow(`${reason} completed`);
    if (!report.blockAgentActions) {
      this.resumeAgentBackedWorkForActiveProject(reason);
    }
    return report;
  }

  getCodexReadiness(): CodexReadinessReport {
    return this.codexReadiness;
  }

  async checkCodexUpdate(): Promise<CodexUpdateCheckResult> {
    if (this.codexUpdateCheckInFlight) {
      return this.codexUpdateCheckInFlight;
    }

    this.codexUpdateCheckInFlight = this.checkCodexUpdateInternal()
      .finally(() => {
        this.codexUpdateCheckInFlight = undefined;
      });
    return this.codexUpdateCheckInFlight;
  }

  private async checkCodexUpdateInternal(): Promise<CodexUpdateCheckResult> {
    if (this.settings.mockMode) {
      const skipped: CodexUpdateCheckResult = {
        checkedAt: nowIso(),
        updateAvailable: false,
        status: "skipped",
        message: "Mock mode is enabled, so Codex CLI update checks are skipped."
      };
      this.codexUpdateCheck = skipped;
      this.codexReadiness = {
        ...this.codexReadiness,
        checkedAt: skipped.checkedAt,
        codexCliExists: undefined,
        codexVersion: undefined,
        latestCodexVersion: undefined,
        updateAvailable: false,
        updateCommand: undefined,
        status: "skipped",
        message: skipped.message,
        warnings: ["Mock mode skips Codex CLI, WSL, Node.js, and npm update detection."],
        errors: []
      };
      this.emitState();
      return skipped;
    }

    const result = await checkCodexCliUpdate(this.settings, process.platform);
    const checked: CodexUpdateCheckResult = {
      checkedAt: nowIso(),
      currentVersion: result.currentVersion,
      latestVersion: result.latestVersion,
      targetVersion: result.targetVersion,
      updateAvailable: result.updateAvailable,
      updateCommand: result.updateCommand,
      status: result.status,
      message: result.message
    };
    const updateWarnings = result.status === "unavailable" && result.currentVersion ? [result.message] : [];
    const updateErrors = result.status === "unavailable" && !result.currentVersion ? [result.message] : [];
    const codexCliMissing = result.status === "unavailable" && !result.currentVersion;
    this.codexUpdateCheck = checked;
    this.codexReadiness = {
      ...this.codexReadiness,
      checkedAt: checked.checkedAt,
      codexCliExists: codexCliMissing ? false : Boolean(checked.currentVersion) || this.codexReadiness.codexCliExists,
      codexVersion: codexCliMissing ? undefined : checked.currentVersion ?? this.codexReadiness.codexVersion,
      latestCodexVersion: checked.latestVersion,
      updateAvailable: checked.updateAvailable,
      updateCommand: checked.updateCommand,
      status: checked.updateAvailable
        ? "outdated"
        : checked.status === "unavailable" && !checked.currentVersion
          ? "unavailable"
          : checked.status === "skipped"
            ? "skipped"
            : this.codexReadiness.status === "unavailable" && !checked.currentVersion
              ? "unavailable"
              : "ready",
      message: checked.message,
      warnings: updateWarnings,
      errors: updateErrors
    };
    this.emitState();
    return checked;
  }

  async runCodexUpdate(options: CodexUpdateRunOptions = {}): Promise<CodexUpdateRunResult> {
    if (this.settings.mockMode) {
      const skipped: CodexUpdateRunResult = {
        checkedAt: nowIso(),
        status: "skipped",
        message: "Mock mode is enabled, so Codex CLI updates are skipped."
      };
      return skipped;
    }

    const before = this.codexUpdateCheck ?? await this.checkCodexUpdate();
    if (!before.updateAvailable) {
      return {
        checkedAt: nowIso(),
        status: before.status === "skipped" ? "skipped" : "up-to-date",
        previousVersion: before.currentVersion,
        currentVersion: before.currentVersion,
        latestVersion: before.latestVersion,
        command: before.updateCommand,
        message: before.message
      };
    }
    if (!before.updateCommand) {
      return {
        checkedAt: nowIso(),
        status: "failed",
        previousVersion: before.currentVersion,
        currentVersion: before.currentVersion,
        latestVersion: before.latestVersion,
        message: "Codex CLI update is available, but Workbench could not build a safe update command preview."
      };
    }
    if (options.approvedCommand !== before.updateCommand) {
      return {
        checkedAt: nowIso(),
        status: "failed",
        previousVersion: before.currentVersion,
        currentVersion: before.currentVersion,
        latestVersion: before.latestVersion,
        command: before.updateCommand,
        message: "Codex CLI update was not approved. Review and approve the displayed command before updating."
      };
    }

    const result = await updateCodexCliIfAvailable(this.settings, process.platform, {
      targetVersion: before.targetVersion ?? before.latestVersion,
      commandRunner: options.commandRunner
    });
    const updateResult: CodexUpdateRunResult = {
      checkedAt: nowIso(),
      status: result.status === "updated" ? "updated" : result.status === "up-to-date" ? "up-to-date" : result.status === "skipped" ? "skipped" : "failed",
      previousVersion: result.currentVersion,
      currentVersion: result.updatedVersion ?? result.currentVersion,
      latestVersion: result.latestVersion,
      command: before.updateCommand,
      message: result.message
    };
    if (updateResult.status === "updated") {
      await this.restartTransportAfterCodexUpdate();
    }
    await this.refreshCodexReadiness("Codex CLI update completed");
    await this.checkCodexUpdate();
    return updateResult;
  }

  async refreshCodexReadiness(reason = "Codex readiness check"): Promise<CodexReadinessReport> {
    if (this.codexReadinessInFlight) {
      return this.codexReadinessInFlight;
    }

    this.codexReadinessInFlight = this.refreshCodexReadinessInternal(reason)
      .finally(() => {
        this.codexReadinessInFlight = undefined;
      });
    return this.codexReadinessInFlight;
  }

  private async refreshCodexReadinessInternal(reason = "Codex readiness check"): Promise<CodexReadinessReport> {
    const checkedAt = nowIso();
    const mode = resolveExecutionMode(this.settings, process.platform);
    if (this.settings.mockMode) {
      this.codexReadiness = {
        checkedAt,
        executionMode: this.settings.executionMode,
        distroName: this.settings.distroName,
        codexBinaryPath: this.settings.codexBinaryPath,
        codexPath: this.settings.codexBinaryPath,
        codexCliExists: undefined,
        nodePath: process.execPath,
        updateAvailable: false,
        updateCommand: undefined,
        status: "skipped",
        message: "Mock mode is enabled. Codex detection is skipped until a live agent-backed action needs it.",
        warnings: ["Mock mode skips Codex CLI, WSL, Node.js, and npm update detection."],
        errors: []
      };
      this.emitState();
      return this.codexReadiness;
    }

    this.codexReadiness = {
      checkedAt,
      executionMode: this.settings.executionMode,
      distroName: this.settings.distroName,
      codexBinaryPath: this.settings.codexBinaryPath,
      updateAvailable: this.codexUpdateCheck?.updateAvailable ?? false,
      updateCommand: this.codexUpdateCheck?.updateCommand,
      status: "checking",
      message: "Checking Codex CLI, Node.js, runtime path, and available update.",
      warnings: [],
      errors: []
    };
    this.emitState();

    try {
      const executor = new RuntimeCommandExecutor(this.settings, process.platform);
      let codexPath = this.settings.codexBinaryPath;
      let nodePath = process.execPath;
      if (mode === "wsl") {
        const runtime = await executor.resolveWslCodexRuntime({
          command: this.settings.codexBinaryPath,
          timeoutMs: CODEX_READINESS_PROBE_TIMEOUT_MS
        });
        codexPath = runtime.resolvedCodexCommand ?? this.settings.codexBinaryPath;
        nodePath = runtime.resolvedNodeCommand ?? nodePath;
      } else {
        const resolverCommand = process.platform === "win32" ? "where" : "which";
        const resolveLocalPath = async (command: string, fallback: string): Promise<string> => {
          try {
            const result = await executor.execStructuredCommand({
              command: resolverCommand,
              args: [command],
              timeoutMs: CODEX_READINESS_PROBE_TIMEOUT_MS
            });
            return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? fallback;
          } catch {
            return fallback;
          }
        };
        codexPath = await resolveLocalPath(this.settings.codexBinaryPath, this.settings.codexBinaryPath);
        nodePath = await resolveLocalPath("node", process.execPath);
      }

      const codexVersion = await readInstalledCodexCliVersion(this.settings);
      const update = await this.checkCodexUpdate();
      const updateWarning = update.status === "unavailable" && update.currentVersion
        ? [`Latest Codex CLI version could not be determined. ${update.message}`]
        : [];
      const versionErrors = codexVersion ? [] : [update.message || "Codex CLI version command returned no parsable version."];
      this.codexReadiness = {
        checkedAt: nowIso(),
        executionMode: this.settings.executionMode,
        distroName: mode === "wsl" ? this.settings.distroName : undefined,
        codexBinaryPath: this.settings.codexBinaryPath,
        codexCliExists: Boolean(codexVersion),
        codexPath,
        nodePath,
        codexVersion,
        latestCodexVersion: update.latestVersion,
        updateAvailable: update.updateAvailable,
        updateCommand: update.updateCommand,
        status: update.updateAvailable ? "outdated" : codexVersion ? "ready" : "unavailable",
        message: update.updateAvailable
          ? update.message
          : update.status === "unavailable" && codexVersion
            ? `Codex CLI ${codexVersion} is available at ${codexPath}. ${update.message}`
            : codexVersion
              ? `Codex CLI ${codexVersion} is available at ${codexPath}.`
              : "Codex CLI existence could not be verified.",
        warnings: updateWarning,
        errors: versionErrors
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const message = `${reason} failed. ${detail}`;
      this.codexReadiness = {
        checkedAt: nowIso(),
        executionMode: this.settings.executionMode,
        distroName: mode === "wsl" ? this.settings.distroName : undefined,
        codexBinaryPath: this.settings.codexBinaryPath,
        codexCliExists: false,
        nodePath: mode === "wsl" ? undefined : process.execPath,
        updateAvailable: false,
        status: "unavailable",
        message: `${message} Verify the Codex CLI is installed, confirm the configured binary path, and rerun readiness from Settings.`,
        warnings: mode === "wsl"
          ? [`WSL detection is timeout-bounded at ${CODEX_READINESS_PROBE_TIMEOUT_MS}ms. Confirm the distro is running and named "${this.settings.distroName}".`]
          : [],
        errors: [detail]
      };
      this.diagnostics.unshift(this.codexReadiness.message);
    }

    this.emitState();
    return this.codexReadiness;
  }

  getExecutionEnvironmentStatus(): ExecutionEnvironmentStatus {
    const mode = resolveExecutionMode(this.settings, process.platform);
    return {
      checkedAt: this.codexReadiness.checkedAt ?? this.runtimeReadinessLastCheckedAt ?? nowIso(),
      executionMode: this.settings.executionMode,
      distroName: mode === "wsl" ? this.settings.distroName : undefined,
      platform: process.platform,
      mockMode: this.settings.mockMode,
      safeMode: this.safeMode,
      codexReadiness: this.codexReadiness
    };
  }

  private startRuntimeReadinessCheck(reason: string): void {
    void this.refreshRuntimeReadiness(reason).catch((error) => {
      this.diagnostics.unshift(`Runtime readiness check failed. ${error instanceof Error ? error.message : String(error)}`);
      this.runtimeReadinessChecking = false;
      this.runtimeReadinessLastCheckedAt = nowIso();
      this.emitState();
    });
  }

  private resumeAgentBackedWorkForActiveProject(reason: string): void {
    const project = this.getActiveProject();
    if (!project || !this.canRunAgentBackedActions(project)) {
      return;
    }
    this.logWorkflowPerf(`agent-backed work resumed for ${project.record.identity.projectName}: ${reason}`);
    void this.runBootstrapIfNeeded(project);
    if (this.shouldScheduleWorkflowAutomation(project)) {
      this.scheduleWorkflowAutomation(project.record.id, reason);
    }
  }

  private emitStateNow(label = "state emit"): void {
    if (this.disposed) {
      return;
    }
    if (this.pendingStateEmitTimer) {
      clearTimeout(this.pendingStateEmitTimer);
      this.pendingStateEmitTimer = undefined;
    }
    this.recordWorkflowPerfCounter("state emits");
    this.emit("stateChanged", this.getRendererStateForEmit(label));
  }

  private emitState(): void {
    if (this.disposed) {
      return;
    }
    if (this.pendingStateEmitTimer) {
      return;
    }

    this.pendingStateEmitTimer = setTimeout(() => {
      this.pendingStateEmitTimer = undefined;
      this.recordWorkflowPerfCounter("state emits");
      this.emit("stateChanged", this.getRendererStateForEmit("coalesced state emit"));
    }, STATE_EMIT_THROTTLE_MS);
    this.pendingStateEmitTimer.unref?.();
  }

  private mergeProjectSaveOptions(existing?: ProjectSaveOptions, incoming?: ProjectSaveOptions): ProjectSaveOptions {
    const existingSyncWorkflow = existing ? existing.syncWorkflow !== false : false;
    const incomingSyncWorkflow = incoming ? incoming.syncWorkflow !== false : true;
    return {
      force: Boolean(existing?.force || incoming?.force),
      syncWorkflow: existingSyncWorkflow || incomingSyncWorkflow
    };
  }

  private scheduleProjectSave(project: LoadedProject, options?: ProjectSaveOptions): void {
    if (this.disposed) {
      return;
    }
    const projectId = project.record.id;
    const syncWorkflow = options?.syncWorkflow !== false;
    const queuedSaveOptions = this.projectSaveQueuedOptions.get(projectId);
    if (this.projectSaveInFlight.has(projectId) && this.projectSaveQueued.has(projectId)) {
      this.projectSaveQueuedOptions.set(projectId, this.mergeProjectSaveOptions(queuedSaveOptions, options));
      this.recordWorkflowPerfCounter("project save coalesces", project.record.identity.projectName);
      return;
    }

    const pending = this.pendingProjectSaveTimers.get(projectId);
    if (pending) {
      pending.syncWorkflow = pending.syncWorkflow || syncWorkflow;
      this.recordWorkflowPerfCounter("project save coalesces", project.record.identity.projectName);
      return;
    }

    const scheduled: ProjectSaveTimer = {
      syncWorkflow,
      timer: setTimeout(() => {
        const current = this.pendingProjectSaveTimers.get(projectId);
        this.pendingProjectSaveTimers.delete(projectId);
        void this.saveProject(project, {
          syncWorkflow: current?.syncWorkflow ?? syncWorkflow
        }).catch((error) => {
          this.diagnostics.unshift(
            `Failed to save live project state for ${project.record.identity.projectName}. ${error instanceof Error ? error.message : String(error)}`
          );
        });
      }, LIVE_PROJECT_SAVE_THROTTLE_MS)
    };
    scheduled.timer.unref?.();
    this.pendingProjectSaveTimers.set(projectId, scheduled);
    this.recordWorkflowPerfCounter("project save schedules", project.record.identity.projectName);
  }

  private cancelScheduledProjectSave(projectId: string): ProjectSaveTimer | undefined {
    const scheduled = this.pendingProjectSaveTimers.get(projectId);
    if (scheduled) {
      clearTimeout(scheduled.timer);
      this.pendingProjectSaveTimers.delete(projectId);
    }
    return scheduled;
  }

  private flushProjectSaveNow(project: LoadedProject, reason: string): void {
    if (this.disposed) {
      return;
    }
    const projectId = project.record.id;
    this.cancelScheduledProjectSave(projectId);
    const startedAt = performance.now();
    void this.saveProject(project)
      .then(() => {
        this.logWorkflowPerf(`${reason}: saved ${project.record.identity.projectName} in ${Math.round(performance.now() - startedAt)}ms`);
      })
      .catch((error) => {
        this.diagnostics.unshift(
          `Failed to save project checkpoint for ${project.record.identity.projectName}. ${error instanceof Error ? error.message : String(error)}`
        );
      });
  }

  private async flushScheduledProjectSaves(force = false): Promise<void> {
    const pendingProjectIds = [...this.pendingProjectSaveTimers.keys()];
    for (const projectId of pendingProjectIds) {
      const scheduled = this.cancelScheduledProjectSave(projectId);
      const project = this.projects.get(projectId);
      if (project) {
        await this.saveProject(project, { force, syncWorkflow: scheduled?.syncWorkflow ?? true });
      }
    }
  }

  private getRuntimeSettings(distroName = this.settings.distroName): Pick<AppSettings, "executionMode" | "distroName"> {
    return {
      executionMode: this.settings.executionMode,
      distroName
    };
  }

  private async cleanupCompletedManagedWorktrees(
    project: LoadedProject,
    retiringWorktreePaths: string[] = []
  ): Promise<void> {
    if (project.scan.kind !== "git") {
      return;
    }

    const retiringWorktreeSet = new Set(retiringWorktreePaths);
    const activeWorktreePaths = project.record.agents.flatMap((agent) =>
      agent.worktree?.worktreePath &&
        agent.status !== "completed" &&
        !retiringWorktreeSet.has(agent.worktree.worktreePath)
        ? [agent.worktree.worktreePath]
        : []
    );

    try {
      await pruneManagedWorktrees(
        project.record.projectRoot,
        getManagedWorktreeBaseDir(project.record.projectRoot),
        activeWorktreePaths,
        this.getRuntimeSettings(project.record.distroName)
      );
    } catch (error) {
      this.diagnostics.unshift(
        `Failed to clean completed agent worktrees for ${project.record.identity.projectName}. ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private assertResolvedPathCompatible(distroName?: string): void {
    if (
      process.platform === "win32" &&
      this.settings.executionMode === "wsl" &&
      distroName &&
      distroName !== this.settings.distroName
    ) {
      throw new Error(
        `The selected project is in WSL distro "${distroName}", but the app runtime target is "${this.settings.distroName}". Update the WSL distro setting or choose a project from the configured distro.`
      );
    }
  }

  private normalizeStoredProjectRecord(record: LocalProjectRecord): LocalProjectRecord {
    const distroName = record.distroName ?? (this.settings.executionMode === "wsl" ? this.settings.distroName : undefined);
    const hostPath = record.hostPath || executionPathToHostPath(record.projectRoot, this.getRuntimeSettings(distroName), distroName);
    return {
      ...record,
      workflow: {
        ...defaultProjectWorkflowState(),
        ...record.workflow
      },
      localState: {
        ...defaultLocalState(),
        ...record.localState
      },
      userInputRequests: record.userInputRequests ?? [],
      credentials: {
        ...defaultProjectCredentialsState(),
        ...record.credentials,
        entries: record.credentials?.entries ?? [],
        requests: record.credentials?.requests ?? []
      },
      hostPath,
      distroName
    };
  }

  private ensureWorkflowState(record: LocalProjectRecord): ProjectWorkflowState {
    const defaults = defaultProjectWorkflowState();
    const workflow = record.workflow ?? defaults;
    workflow.ultimateGoal = {
      ...defaults.ultimateGoal,
      ...workflow.ultimateGoal
    };
    this.ensureGoalCharterForWorkflow(workflow);
    workflow.workflowCycle = {
      ...defaults.workflowCycle,
      ...workflow.workflowCycle
    };
    workflow.repair = {
      ...defaults.repair,
      ...workflow.repair
    };
    workflow.appeal = {
      ...defaults.appeal,
      ...workflow.appeal
    };
    workflow.workflowBudgets = {
      ...defaults.workflowBudgets,
      ...workflow.workflowBudgets
    };
    workflow.workflowMode = workflow.workflowMode === "fast" ? "fast" : defaults.workflowMode;
    workflow.previewRequest = normalizeWorkflowPreviewRequest(workflow.previewRequest ?? defaults.previewRequest);
    workflow.autopilotPolicy = validateAutopilotPolicy({
      ...workflow.autopilotPolicy,
      enabled: Boolean(workflow.autopilotPolicy?.enabled || record.localState.autopilotEnabled)
    }, record.localState.autopilotEnabled);
    record.localState.autopilotEnabled = workflow.autopilotPolicy.enabled;
    workflow.memory = {
      ...defaults.memory,
      ...workflow.memory,
      perCycleSummaries: workflow.memory?.perCycleSummaries ?? defaults.memory.perCycleSummaries,
      lastAcceptedDecisions: workflow.memory?.lastAcceptedDecisions ?? defaults.memory.lastAcceptedDecisions,
      knownOpenIssues: workflow.memory?.knownOpenIssues ?? defaults.memory.knownOpenIssues,
      contextDescriptors: workflow.memory?.contextDescriptors ?? defaults.memory.contextDescriptors,
      lastRelevantContext: workflow.memory?.lastRelevantContext ?? defaults.memory.lastRelevantContext,
      agentFreshness: {
        ...defaults.memory.agentFreshness,
        ...workflow.memory?.agentFreshness
      }
    };
    workflow.humanInterventions ??= [];
    workflow.recommendations ??= [];
    workflow.activityLog ??= [];
    workflow.activityLog = workflow.activityLog.slice(0, 400).map((event) => ({
      ...event,
      detail: event.detail ? compactText(event.detail, MAX_WORKFLOW_ACTIVITY_DETAIL_LENGTH) : event.detail
    }));
    workflow.goalChecklist = hasMeaningfulUltimateGoal(workflow.ultimateGoal)
      ? buildGoalChecklistFromUltimateGoal(workflow.ultimateGoal, workflow.goalChecklist ?? [])
      : workflow.goalChecklist ?? [];
    workflow.taskMap ??= defaults.taskMap;
    workflow.workPackages ??= defaults.workPackages;
    workflow.strategicPlans ??= defaults.strategicPlans;
    workflow.plannerDecisions ??= defaults.plannerDecisions;
    workflow.checklistChanges ??= defaults.checklistChanges;
    workflow.cycleRetrospectives ??= defaults.cycleRetrospectives;
    workflow.evidenceObservations ??= defaults.evidenceObservations;
    workflow.checklistDeltas ??= defaults.checklistDeltas;
    workflow.recommendationHealth = {
      ...defaults.recommendationHealth,
      ...workflow.recommendationHealth
    };
    workflow.evidenceCommands ??= defaults.evidenceCommands;
    workflow.validationLedgers ??= defaults.validationLedgers;
    workflow.repoHygieneReports ??= defaults.repoHygieneReports;
    const currentCycleAgents = (record.agents ?? []).filter((agent) =>
      agent.workflowCycleNumber === undefined || agent.workflowCycleNumber === workflow.workflowCycle.cycleNumber
    );
    const shouldDeriveLegacyCycleDiagnostics = Boolean(
      workflow.approvedRecommendation ||
      workflow.scopedGoal ||
      workflow.plannerDecisions.some((decision) => decision.cycleNumber === workflow.workflowCycle.cycleNumber) ||
      workflow.recommendations.length > 0 ||
      workflow.workPackages.length > 0 ||
      currentCycleAgents.some((agent) => agent.commandLog.length > 0 || (agent.integrityReport?.checks.length ?? 0) > 0)
    );
    deriveLegacyWorkflowDiagnostics(workflow, {
      agents: record.agents ?? [],
      deriveChecklistDelta: shouldDeriveLegacyCycleDiagnostics,
      deriveValidationLedger: shouldDeriveLegacyCycleDiagnostics,
      deriveRepoHygiene: shouldDeriveLegacyCycleDiagnostics
    });
    record.userInputRequests ??= [];
    record.credentials = {
      ...defaultProjectCredentialsState(),
      ...record.credentials,
      entries: record.credentials?.entries ?? [],
      requests: record.credentials?.requests ?? []
    };
    this.syncWorkflowSettings(workflow);
    workflow.stepProgress = ensureWorkflowStepProgressState({
      stepProgress: workflow.stepProgress,
      workflowStage: workflow.workflowStage,
      humanInterventions: workflow.humanInterventions,
      ultimateGoal: workflow.ultimateGoal,
      recommendations: workflow.recommendations,
      approvedRecommendation: workflow.approvedRecommendation,
      scopedGoal: workflow.scopedGoal,
      repair: workflow.repair
    });
    record.workflow = workflow;
    return workflow;
  }

  private ensureGoalCharterForWorkflow(workflow: ProjectWorkflowState): GoalCharter {
    const acceptedGoal = hasConfirmedUltimateGoal(workflow.ultimateGoal) ? workflow.ultimateGoal : undefined;
    const defaults = createDefaultGoalCharter(
      acceptedGoal,
      workflow.goalCharter?.createdAt ?? acceptedGoal?.confirmedAt ?? new Date(0).toISOString()
    );
    const existingStrategy = workflow.goalCharter?.autopilotStrategy;
    const normalized = goalCharterSchema.parse({
      ...defaults,
      ...workflow.goalCharter,
      originalUltimateGoal: {
        ...defaults.originalUltimateGoal,
        ...workflow.goalCharter?.originalUltimateGoal
      },
      currentEffectiveGoal: {
        ...defaults.currentEffectiveGoal,
        ...workflow.goalCharter?.currentEffectiveGoal
      },
      autopilotStrategy: {
        ...defaults.autopilotStrategy,
        ...existingStrategy,
        visualPreferences: {
          ...defaults.autopilotStrategy.visualPreferences,
          ...existingStrategy?.visualPreferences
        },
        autonomyBudget: {
          ...defaults.autopilotStrategy.autonomyBudget,
          ...existingStrategy?.autonomyBudget
        }
      },
      createdAt: workflow.goalCharter?.createdAt ?? defaults.createdAt,
      updatedAt: workflow.goalCharter?.updatedAt ?? defaults.updatedAt
    });

    if (acceptedGoal && !hasMeaningfulUltimateGoal(normalized.originalUltimateGoal)) {
      normalized.originalUltimateGoal = { ...acceptedGoal };
    }
    if (acceptedGoal && !hasMeaningfulUltimateGoal(normalized.currentEffectiveGoal)) {
      normalized.currentEffectiveGoal = { ...acceptedGoal };
    }
    if (
      hasConfirmedUltimateGoal(normalized.currentEffectiveGoal) &&
      (!hasConfirmedUltimateGoal(workflow.ultimateGoal) || workflow.ultimateGoal.summary !== normalized.currentEffectiveGoal.summary)
    ) {
      workflow.ultimateGoal = { ...normalized.currentEffectiveGoal };
    }

    workflow.goalCharter = normalized;
    return normalized;
  }

  private syncWorkflowSettings(workflow: ProjectWorkflowState): void {
    workflow.workflowBudgets.maxRepairLoops = this.settings.maxRepairCycles;
    workflow.repair.maxAttempts = this.settings.maxRepairCycles;
    workflow.repairLoopCount = workflow.repair.attemptCount;
  }

  private buildExternalServiceCostPolicyInstructions(): string {
    if (this.settings.considerPaidServices) {
      return [
        "External service policy: free/no-card APIs and API keys are allowed when they materially improve required functionality.",
        "When a credential is needed, implement the provider adapter plus demo/mock and missing-credential states, then request the credential through the user-input/Credentials flow with the secret field marked secret.",
        "Paid services may be considered, but mark them clearly and keep a free/demo/mock path available when practical. Never create billing commitments automatically. Any paid account, billing, or credit-card step must become an explicit user-visible request."
      ].join(" ");
    }

    return [
      "External service policy: free/no-card APIs and API keys are allowed when they materially improve required functionality.",
      "Prefer no-key, unauthenticated, open-data, demo, or free-tier providers when they fit, but do not avoid a real API solely because it needs a free/no-card key.",
      "If a free/no-card credential is needed, implement the provider adapter plus demo/mock and missing-credential states, then request the credential through the user-input/Credentials flow with the secret field marked secret.",
      "Do not require paid API services, subscription plans, billing setup, or credit-card-backed keys."
    ].join(" ");
  }

  private resetWorkflowRepairState(workflow: ProjectWorkflowState): void {
    workflow.repair = {
      attemptCount: 0,
      maxAttempts: this.settings.maxRepairCycles,
      status: "idle",
      lastUpdatedAt: nowIso()
    };
    workflow.repairLoopCount = 0;
    workflow.manualHandoff = undefined;
  }

  private async readProjectHeadRef(project: LoadedProject): Promise<string | undefined> {
    if (project.scan.kind !== "git") {
      return undefined;
    }
    try {
      const executor = new RuntimeCommandExecutor(this.getRuntimeSettings(project.record.distroName));
      const result = await executor.execStructuredCommand({
        command: "git",
        args: ["rev-parse", "--verify", "HEAD"],
        cwd: project.record.projectRoot
      });
      return result.stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private async ensureWorkflowCycleStartGitRef(project: LoadedProject, workflow: ProjectWorkflowState): Promise<string | undefined> {
    if (workflow.workflowCycle.startGitRef) {
      return workflow.workflowCycle.startGitRef;
    }
    const startGitRef = await this.readProjectHeadRef(project);
    if (startGitRef) {
      workflow.workflowCycle.startGitRef = startGitRef;
    }
    return startGitRef;
  }

  private safeCycleResetCleanPaths(project: LoadedProject, cycleNumber: number): string[] {
    const normalize = (value: string): string | undefined => {
      const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").trim();
      if (
        !normalized ||
        normalized === "." ||
        normalized.startsWith("/") ||
        /^[A-Za-z]:\//.test(normalized) ||
        normalized.startsWith("../") ||
        normalized.includes("/../") ||
        normalized === ".git" ||
        normalized.startsWith(".git/")
      ) {
        return undefined;
      }
      return normalized;
    };
    const workflow = this.ensureWorkflowState(project.record);
    const cycleAgents = project.record.agents.filter((agent) => agent.workflowCycleNumber === cycleNumber);
    const currentCycleHygienePaths = workflow.repoHygieneReports
      .filter((report) => report.scannedRef.includes(`:${cycleNumber}`))
      .flatMap((report) => [...report.forbiddenFiles, ...report.cleanedFiles]);
    return unique([
      ...cycleAgents.flatMap((agent) => agent.changedFiles),
      ...currentCycleHygienePaths
    ].flatMap((entry) => normalize(entry) ?? []));
  }

  private async resetProjectCheckoutToCycleStart(project: LoadedProject, workflow: ProjectWorkflowState): Promise<string> {
    if (project.scan.kind !== "git") {
      return "Project is not a Git checkout; workflow state was reset but project files were not changed.";
    }

    const executor = new RuntimeCommandExecutor(this.getRuntimeSettings(project.record.distroName));
    const startGitRef = workflow.workflowCycle.startGitRef;
    if (startGitRef) {
      try {
        await executor.execStructuredCommand({
          command: "git",
          args: ["rev-parse", "--verify", `${startGitRef}^{commit}`],
          cwd: project.record.projectRoot
        });
      } catch {
        throw new Error(`The cycle start commit ${startGitRef.slice(0, 12)} is no longer available, so Workbench cannot safely reset project files.`);
      }
      await executor.execStructuredCommand({
        command: "git",
        args: ["reset", "--hard", startGitRef],
        cwd: project.record.projectRoot
      });
      const cleanPaths = this.safeCycleResetCleanPaths(project, workflow.workflowCycle.cycleNumber);
      for (let index = 0; index < cleanPaths.length; index += 50) {
        await executor.execStructuredCommand({
          command: "git",
          args: ["clean", "-fd", "--", ...cleanPaths.slice(index, index + 50)],
          cwd: project.record.projectRoot
        });
      }
      return `Project checkout reset to cycle start commit ${startGitRef.slice(0, 12)}.`;
    }

    const cleanPaths = this.safeCycleResetCleanPaths(project, workflow.workflowCycle.cycleNumber);
    const trackedPaths = cleanPaths.length > 0
      ? unique((await executor.execStructuredCommand({
        command: "git",
        args: ["ls-files", "--", ...cleanPaths],
        cwd: project.record.projectRoot
      })).stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean))
      : [];
    for (let index = 0; index < trackedPaths.length; index += 50) {
      await executor.execStructuredCommand({
        command: "git",
        args: ["restore", "--source", "HEAD", "--", ...trackedPaths.slice(index, index + 50)],
        cwd: project.record.projectRoot
      });
    }
    for (let index = 0; index < cleanPaths.length; index += 50) {
      await executor.execStructuredCommand({
        command: "git",
        args: ["clean", "-fd", "--", ...cleanPaths.slice(index, index + 50)],
        cwd: project.record.projectRoot
      });
    }
    return "This saved cycle did not record a start commit. Recorded current-cycle paths were restored from HEAD; committed changes and unrelated files were left in place.";
  }

  private updateWorkflowRepairState(
    workflow: ProjectWorkflowState,
    patch: Partial<ProjectWorkflowState["repair"]>
  ): void {
    workflow.repair = {
      ...workflow.repair,
      ...patch,
      maxAttempts: this.settings.maxRepairCycles,
      lastUpdatedAt: nowIso()
    };
    workflow.repairLoopCount = workflow.repair.attemptCount;
    if (workflow.repair.status !== "exhausted" && workflow.repair.status !== "merge_conflicts") {
      workflow.manualHandoff = undefined;
    }
  }

  private recordWorkflowActivity(
    workflow: ProjectWorkflowState,
    entry: Omit<ProjectWorkflowState["activityLog"][number], "id" | "timestamp">
  ): void {
    const timestamp = nowIso();
    const detail = entry.detail ? compactText(entry.detail, MAX_WORKFLOW_ACTIVITY_DETAIL_LENGTH) : entry.detail;
    const previous = workflow.activityLog[0];
    if (
      previous?.source === entry.source &&
      previous.status === entry.status &&
      previous.title === entry.title &&
      previous.detail === detail &&
      previous.stepId === entry.stepId &&
      previous.agentId === entry.agentId &&
      previous.agentCategory === entry.agentCategory
    ) {
      previous.timestamp = timestamp;
      return;
    }

    workflow.activityLog.unshift({
      id: nanoid(),
      timestamp,
      ...entry,
      detail
    });
    if (workflow.activityLog.length > 400) {
      workflow.activityLog.length = 400;
    }
  }

  private updateAutopilotRuntimeStatus(
    project: LoadedProject,
    patch: {
      nextPlannedAction?: string;
      lastCompletedAction?: string;
      recommendation?: ProjectWorkflowState["recommendations"][number];
      pause?: {
        reason?: AutopilotPauseReason;
        detail?: string;
        highRiskPackageRequiresApproval: boolean;
      };
    } = {}
  ): boolean {
    const workflow = this.ensureWorkflowState(project.record);
    const policy = resolveEffectiveAutopilotPolicy(workflow, project.record.localState.autopilotEnabled);
    const recommendation = patch.recommendation ?? workflow.approvedRecommendation;
    const recommendationId = recommendation
      ? "recommendationId" in recommendation && typeof recommendation.recommendationId === "string"
        ? recommendation.recommendationId
        : recommendation.id
      : undefined;
    const nextStatus = {
      enabled: policy.enabled,
      profile: policy.profile,
      workflowMode: workflow.workflowMode,
      stage: workflow.workflowStage,
      cycleNumber: workflow.workflowCycle.cycleNumber,
      currentRecommendationId: recommendationId,
      currentRecommendationTitle: recommendation?.title,
      lastCompletedAction: patch.lastCompletedAction ?? workflow.autopilotStatus?.lastCompletedAction,
      nextPlannedAction: patch.nextPlannedAction,
      pausedReason: patch.pause?.reason,
      pausedDetail: patch.pause?.detail,
      highRiskPackageRequiresApproval: patch.pause?.highRiskPackageRequiresApproval ?? false,
      updatedAt: workflow.autopilotStatus?.updatedAt ?? nowIso()
    } satisfies NonNullable<ProjectWorkflowState["autopilotStatus"]>;
    const previousComparable = workflow.autopilotStatus ? {
      ...workflow.autopilotStatus,
      updatedAt: ""
    } : undefined;
    const nextComparable = {
      ...nextStatus,
      updatedAt: ""
    };
    if (JSON.stringify(previousComparable) === JSON.stringify(nextComparable)) {
      return false;
    }
    workflow.autopilotStatus = {
      ...nextStatus,
      updatedAt: nowIso()
    };
    return true;
  }

  private recordAutopilotPause(
    workflow: ProjectWorkflowState,
    reason: AutopilotPauseReason | undefined,
    detail?: string
  ): void {
    if (!reason || reason === "disabled" || reason === "manual_pause_requested") {
      return;
    }
    const previous = workflow.activityLog[0];
    const title = "Autopilot paused";
    if (previous?.title === title && previous.detail === detail) {
      return;
    }
    this.recordWorkflowActivity(workflow, {
      source: "workflow",
      status: "waiting",
      title,
      detail: detail ?? reason.replace(/_/g, " "),
      stepId: getWorkflowActiveStepId(workflow)
    });
  }

  private isAutopilotEnabledForProject(project: LoadedProject): boolean {
    return resolveEffectiveAutopilotPolicy(
      this.ensureWorkflowState(project.record),
      project.record.localState.autopilotEnabled
    ).enabled && !project.record.localState.workflowPauseRequested;
  }

  private disableAutopilotForUnrepairableIssue(
    project: LoadedProject,
    detail: string,
    stepId: WorkflowStepId,
    reason: AutopilotPauseReason = "repair_budget_exhausted"
  ): void {
    const workflow = this.ensureWorkflowState(project.record);
    project.record.localState.autopilotEnabled = false;
    project.record.localState.workflowPauseRequested = true;
    workflow.autopilotPolicy = validateAutopilotPolicy({
      ...resolveEffectiveAutopilotPolicy(workflow, true),
      enabled: false
    }, false);
    this.updateAutopilotRuntimeStatus(project, {
      pause: {
        reason,
        detail,
        highRiskPackageRequiresApproval: false
      }
    });
    this.recordWorkflowActivity(workflow, {
      source: "workflow",
      status: "waiting",
      title: "Autopilot turned off for manual repair",
      detail,
      stepId
    });
    this.updateWorkflowStepProgress(workflow, stepId, {
      requiresUserInput: true,
      currentActivity: "Manual repair required",
      latestProgressNote: detail,
      message: "Autopilot stopped because the blocker is not likely to be repairable by another coding agent.",
      warning: detail
    });
  }

  private queueAutomaticWorkflowRepair(
    project: LoadedProject,
    input: {
      sourceStep: WorkflowStepId;
      issueSummary: string;
      latestFailureReason: string;
      involvedPaths?: string[];
      repairable?: boolean;
      automate: boolean;
    }
  ): boolean {
    if (!input.automate || !this.isAutopilotEnabledForProject(project)) {
      return false;
    }
    const workflow = this.ensureWorkflowState(project.record);
    if (!workflow.scopedGoal || workflow.repair.status === "merge_conflicts" || workflow.repair.status === "exhausted") {
      return false;
    }
    if (input.repairable === false) {
      workflow.manualHandoff = this.buildRepairManualHandoff(
        project,
        input.issueSummary,
        input.latestFailureReason,
        "repair_stopped_early",
        input.involvedPaths
      );
      this.updateWorkflowRepairState(workflow, {
        status: "exhausted",
        latestIssueSummary: input.issueSummary,
        latestFailureReason: input.latestFailureReason
      });
      this.disableAutopilotForUnrepairableIssue(project, input.latestFailureReason, input.sourceStep);
      return false;
    }

    const failedCurrentRepairCodingPass =
      workflow.repair.status === "repairing" &&
      input.sourceStep === "coding" &&
      workflow.stepProgress.coding.status === "failed";
    const nextAttemptNumber = workflow.repair.status === "repairing" && !failedCurrentRepairCodingPass
      ? Math.max(1, workflow.repair.attemptCount)
      : workflow.repair.attemptCount + 1;
    if (nextAttemptNumber > workflow.repair.maxAttempts) {
      workflow.manualHandoff = this.buildRepairManualHandoff(
        project,
        input.issueSummary,
        input.latestFailureReason,
        "repair_exhausted",
        input.involvedPaths
      );
      this.updateWorkflowRepairState(workflow, {
        status: "exhausted",
        latestIssueSummary: input.issueSummary,
        latestFailureReason: input.latestFailureReason
      });
      this.disableAutopilotForUnrepairableIssue(
        project,
        `Automatic repair reached the configured limit. ${input.latestFailureReason}`,
        input.sourceStep
      );
      return false;
    }

    this.updateWorkflowRepairState(workflow, {
      attemptCount: nextAttemptNumber,
      status: "repairing",
      latestIssueSummary: input.issueSummary,
      latestFailureReason: input.latestFailureReason
    });
    const issueSource: ProjectWorkflowState["memory"]["knownOpenIssues"][number]["source"] =
      input.sourceStep === "recommendation" ? "recommendation"
      : input.sourceStep === "goal_plan" ? "goal"
      : input.sourceStep === "coding" ? "coding"
      : input.sourceStep === "integrity" ? "integrity"
      : input.sourceStep === "merge" ? "merge"
      : "system";
    this.recordWorkflowOpenIssue(workflow, "Automatic repair queued", input.latestFailureReason, issueSource);
    this.recordWorkflowActivity(workflow, {
      source: "workflow",
      status: "waiting",
      title: `Automatic repair attempt ${nextAttemptNumber} of ${workflow.repair.maxAttempts} queued`,
      detail: input.latestFailureReason,
      stepId: "coding"
    });
    this.resetWorkflowStepProgress(workflow, "coding", {
      status: "waiting",
      requiresUserInput: false,
      currentActivity: "Queued for automatic repair",
      currentSubstep: `Repair attempt ${nextAttemptNumber} of ${workflow.repair.maxAttempts}`,
      latestProgressNote: input.latestFailureReason,
      message: "Autopilot will start a tracked repair coding agent, then rerun validation, hygiene, and merge gates.",
      warning: undefined
    });
    this.resetWorkflowStepProgress(workflow, "integrity", {
      status: "waiting",
      requiresUserInput: false,
      currentActivity: "Waiting for repair output",
      message: "Validation will run after the repair agent finishes."
    });
    return true;
  }

  private mirrorLatestAgentEventToWorkflow(workflow: ProjectWorkflowState, agent: AgentState): void {
    const latestEvent = agent.events[0];
    if (!latestEvent) {
      return;
    }

    const previous = workflow.activityLog[0];
    if (latestEvent.type === "message" && latestEvent.status === "running") {
      const existingIndex = workflow.activityLog.findIndex((entry) =>
        entry.source === "agent" &&
        entry.agentId === agent.id &&
        entry.title === latestEvent.title &&
        entry.status === latestEvent.status
      );
      if (existingIndex >= 0) {
        const [existing] = workflow.activityLog.splice(existingIndex, 1);
        workflow.activityLog.unshift({
          ...existing,
          timestamp: latestEvent.timestamp,
          detail: latestEvent.detail ? compactText(latestEvent.detail, MAX_WORKFLOW_ACTIVITY_DETAIL_LENGTH) : latestEvent.detail,
          stepId: latestEvent.stepId,
          agentCategory: agent.category
        });
        return;
      }
    }

    if (
      previous?.agentId === agent.id &&
      previous.title === latestEvent.title &&
      previous.status === (latestEvent.status ?? "info") &&
      latestEvent.status === "running"
    ) {
      previous.timestamp = latestEvent.timestamp;
      previous.detail = latestEvent.detail ? compactText(latestEvent.detail, MAX_WORKFLOW_ACTIVITY_DETAIL_LENGTH) : latestEvent.detail;
      previous.stepId = latestEvent.stepId;
      previous.agentCategory = agent.category;
      return;
    }

    if (
      previous?.agentId === agent.id &&
      previous.timestamp === latestEvent.timestamp &&
      previous.title === latestEvent.title &&
      previous.detail === latestEvent.detail
    ) {
      return;
    }

    this.recordWorkflowActivity(workflow, {
      source: "agent",
      status: latestEvent.status ?? "info",
      title: latestEvent.title,
      detail: latestEvent.detail,
      stepId: latestEvent.stepId,
      agentId: agent.id,
      agentCategory: agent.category
    });
  }

  private getManualHandoffPaths(project: LoadedProject): string[] {
    const workflow = this.ensureWorkflowState(project.record);
    const latestCodingAgent = latestAgentByCategory(project.record.agents, "coding");
    return [...new Set([
      ...(latestCodingAgent?.changedFiles ?? []),
      ...(workflow.approvedRecommendation?.relatedPaths ?? [])
    ])].slice(0, 8);
  }

  private getMergeConflictHandoffPaths(conflicts: string[]): string[] {
    return [...new Set(
      conflicts
        .map((entry) => {
          const trimmed = entry.trim();
          const mergeConflictMatch = trimmed.match(/\bMerge conflict in (.+)$/);
          if (mergeConflictMatch?.[1]) {
            return mergeConflictMatch[1].trim();
          }

          const modifyDeleteMatch = trimmed.match(/^\s*CONFLICT \([^)]+\): (.+?) (?:deleted|modified|renamed) in /);
          if (modifyDeleteMatch?.[1]) {
            return modifyDeleteMatch[1].trim();
          }

          return trimmed;
        })
        .filter((entry) => entry.length > 0)
    )].slice(0, 8);
  }

  private getMeaningfulCheckoutStatusPaths(statusOutput: string): string[] {
    return statusOutput
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => {
        const candidate = line.slice(3).trim();
        const renameMarker = " -> ";
        return candidate.includes(renameMarker)
          ? candidate.slice(candidate.lastIndexOf(renameMarker) + renameMarker.length).trim()
          : candidate;
      })
      .filter((entry) =>
        entry.length > 0 &&
        entry !== ".agent-workbench" &&
        !entry.startsWith(".agent-workbench/") &&
        entry !== "node_modules" &&
        !entry.startsWith("node_modules/")
      );
  }

  private getAgentSortTime(agent: AgentState): number {
    const candidate = agent.lastActivityAt ?? agent.completedAt ?? agent.startedAt ?? agent.createdAt;
    return candidate ? new Date(candidate).getTime() : 0;
  }

  private getMergeCandidateCodingBranches(project: LoadedProject): string[] {
    return [...new Set(
      project.record.agents.flatMap((agent) =>
        agent.category === "coding" && agent.worktree?.branch ? [agent.worktree.branch] : []
      )
    )];
  }

  private getLatestConflictedMergeAgent(project: LoadedProject): AgentState | undefined {
    const workflow = this.ensureWorkflowState(project.record);
    return [...project.record.agents]
      .filter((agent) =>
        agent.category === "merge" &&
        agent.status === "conflicted" &&
        Boolean(agent.worktree?.worktreePath) &&
        Boolean(agent.worktree?.branch) &&
        (agent.workflowCycleNumber === undefined || agent.workflowCycleNumber === workflow.workflowCycle.cycleNumber)
      )
      .sort((left, right) => this.getAgentSortTime(right) - this.getAgentSortTime(left))[0];
  }

  private getRetiredMergeWorktreePaths(project: LoadedProject, activeMergeAgentId?: string): string[] {
    const workflow = this.ensureWorkflowState(project.record);
    return [...new Set(
      project.record.agents.flatMap((agent) =>
        agent.category === "merge" &&
          agent.id !== activeMergeAgentId &&
          agent.worktree?.worktreePath &&
          (agent.status === "conflicted" || agent.status === "failed") &&
          (agent.workflowCycleNumber === undefined || agent.workflowCycleNumber === workflow.workflowCycle.cycleNumber)
          ? [agent.worktree.worktreePath]
          : []
      )
    )];
  }

  private getLatestCompletedWorkflowCodingAgent(project: LoadedProject): AgentState | undefined {
    const workflow = this.ensureWorkflowState(project.record);
    return [...project.record.agents]
      .filter((agent) =>
        agent.category === "coding" &&
        agent.workflowCycleNumber === workflow.workflowCycle.cycleNumber &&
        agent.status === "completed" &&
        Boolean(agent.worktree?.branch)
      )
      .sort((left, right) => this.getAgentSortTime(right) - this.getAgentSortTime(left))[0];
  }

  private getLatestCompletedWorkflowCodingBranch(project: LoadedProject): string | undefined {
    return this.getLatestCompletedWorkflowCodingAgent(project)?.worktree?.branch;
  }

  private isNonRetryableRepairFailureReason(reason?: string): boolean {
    return this.isEnvironmentRepairFailureReason(reason) || this.isScopeMismatchRepairFailureReason(reason);
  }

  private isEnvironmentRepairFailureReason(reason?: string): boolean {
    return (reason?.trim() ?? "").startsWith("Integrity hit an environment or dependency blocker");
  }

  private isExternalRepairRevalidationReason(reason?: string): boolean {
    return (reason?.trim() ?? "").startsWith(EXTERNAL_REPAIR_REVALIDATION_REASON);
  }

  private isScopeMismatchRepairFailureReason(reason?: string): boolean {
    return (reason?.trim() ?? "").startsWith("Integrity reported a scope mismatch");
  }

  private buildRepairManualHandoff(
    project: LoadedProject,
    validationIssue: string,
    latestFailureReason: string,
    reason: NonNullable<ProjectWorkflowState["manualHandoff"]>["reason"] = "repair_exhausted",
    involvedPaths = this.getManualHandoffPaths(project)
  ): NonNullable<ProjectWorkflowState["manualHandoff"]> {
    const workflow = this.ensureWorkflowState(project.record);
    const title =
      reason === "repair_stopped_early"
        ? "Automatic repair stopped early"
        : reason === "merge_conflicts"
          ? "Merge conflicts detected"
          : "Automatic repair reached its limit";
    return {
      reason,
      title,
      whatSystemWasTryingToDo:
        reason === "merge_conflicts"
          ? "Integrate validated coding-agent branches into the opened project checkout"
          : (
            workflow.scopedGoal?.summary ??
            workflow.approvedRecommendation?.title ??
            workflow.ultimateGoal.summary
          ) ||
          "Continue the current workflow cycle",
      validationIssue,
      latestFailureReason,
      involvedPaths: [...new Set(involvedPaths)].slice(0, 8),
      shellSupported: process.platform === "win32",
      createdAt: nowIso()
    };
  }

  private getWorkflowStepProgress<TStepId extends keyof ProjectWorkflowState["stepProgress"]>(
    workflow: ProjectWorkflowState,
    stepId: TStepId
  ): ProjectWorkflowState["stepProgress"][TStepId] {
    workflow.stepProgress = ensureWorkflowStepProgressState(workflow);
    return workflow.stepProgress[stepId];
  }

  private updateWorkflowStepProgress<TStepId extends keyof ProjectWorkflowState["stepProgress"]>(
    workflow: ProjectWorkflowState,
    stepId: TStepId,
    patch: Partial<ProjectWorkflowState["stepProgress"][TStepId]>,
    options?: {
      status?: ProjectWorkflowState["stepProgress"][TStepId]["status"];
      incrementRunCount?: boolean;
      incrementAttemptCount?: boolean;
    }
  ): void {
    const step = this.getWorkflowStepProgress(workflow, stepId);
    const timestamp = nowIso();
    const nextStatus = options?.status ?? patch.status ?? step.status;
    const enteringRunning = nextStatus === "running" && step.status !== "running";
    const enteringStartup =
      (nextStatus === "recovering" || nextStatus === "starting") &&
      step.status !== "recovering" &&
      step.status !== "starting";

    Object.assign(step, patch);
    step.status = nextStatus;
    step.updatedAt = timestamp;
    step.lastEventAt = timestamp;

    if (nextStatus === "running") {
      step.startedAt ??= timestamp;
      step.completedAt = undefined;
      if (enteringRunning && options?.incrementRunCount) {
        step.runCount += 1;
      }
      if (enteringRunning && options?.incrementAttemptCount) {
        step.attemptCount += 1;
      }
    }

    if (nextStatus === "recovering" || nextStatus === "starting") {
      step.startedAt ??= timestamp;
      step.completedAt = undefined;
      if (enteringStartup && options?.incrementAttemptCount) {
        step.attemptCount += 1;
      }
    }

    if (nextStatus === "completed" || nextStatus === "failed" || nextStatus === "blocked") {
      step.startedAt ??= timestamp;
      if (nextStatus !== "blocked") {
        step.completedAt = timestamp;
      }
    }

    if (nextStatus === "waiting" || nextStatus === "not_started") {
      step.completedAt = nextStatus === "not_started" ? undefined : step.completedAt;
    }
  }

  private resetWorkflowStepProgress<TStepId extends keyof ProjectWorkflowState["stepProgress"]>(
    workflow: ProjectWorkflowState,
    stepId: TStepId,
    patch?: Partial<ProjectWorkflowState["stepProgress"][TStepId]>
  ): void {
    const defaults = defaultProjectWorkflowState().stepProgress[stepId];
    workflow.stepProgress[stepId] = {
      ...defaults,
      ...patch,
      stepId
    };
  }

  private touchAgentFreshness(workflow: ProjectWorkflowState, category: AgentCategory, restarted = false): void {
    const marker = workflow.memory.agentFreshness[category] ?? {
      restartCount: 0,
      freshnessToken: 0
    };
    marker.freshnessToken += 1;
    marker.lastSummarizedAt = nowIso();
    if (restarted) {
      marker.restartCount += 1;
      marker.lastRestartedAt = marker.lastSummarizedAt;
    }
    workflow.memory.agentFreshness[category] = marker;
  }

  private pruneWorkflowMemory(workflow: ProjectWorkflowState): void {
    workflow.memory.perCycleSummaries = workflow.memory.perCycleSummaries.slice(0, workflow.workflowBudgets.maxCycleSummaries);
    workflow.memory.lastAcceptedDecisions = workflow.memory.lastAcceptedDecisions.slice(0, workflow.workflowBudgets.maxAcceptedDecisions);
    workflow.memory.knownOpenIssues = workflow.memory.knownOpenIssues.slice(0, workflow.workflowBudgets.maxOpenIssues);
    workflow.memory.contextDescriptors = pruneWorkflowContextDescriptors(workflow.memory.contextDescriptors, 80);
    workflow.memory.lastRelevantContext = workflow.memory.lastRelevantContext.slice(0, 8);
    workflow.recommendations = workflow.recommendations.slice(0, workflow.workflowBudgets.maxRecommendationOptions);
  }

  private refreshWorkflowMemory(workflow: ProjectWorkflowState): void {
    workflow.memory.canonicalSummary = [
      workflow.ultimateGoal.summary,
      workflow.approvedRecommendation?.title ? `Approved next step: ${workflow.approvedRecommendation.title}` : "",
      workflow.scopedGoal?.summary ? `Scoped goal: ${workflow.scopedGoal.summary}` : ""
    ]
      .filter((entry) => entry.length > 0)
      .join(" | ");

    workflow.memory.canonicalFacts = [
      ...workflow.ultimateGoal.successCriteria.slice(0, 3),
      ...workflow.ultimateGoal.constraints.slice(0, 3),
      ...(workflow.scopedGoal?.acceptanceCriteria.slice(0, 3) ?? []),
      ...workflow.memory.knownOpenIssues.filter((issue) => issue.status === "open").slice(0, 3).map((issue) => issue.title)
    ].filter((entry, index, list) => entry.trim().length > 0 && list.indexOf(entry) === index);

    this.pruneWorkflowMemory(workflow);
  }

  private recordWorkflowContextDescriptor(
    workflow: ProjectWorkflowState,
    input: {
      agentCategory: AgentCategory;
      summary: string;
      changedPaths?: string[];
      relatedPaths?: string[];
    }
  ): void {
    const descriptor = createWorkflowContextDescriptor({
      workflow,
      agentCategory: input.agentCategory,
      summary: input.summary,
      changedPaths: input.changedPaths,
      relatedPaths: input.relatedPaths
    });
    workflow.memory.contextDescriptors = pruneWorkflowContextDescriptors([
      descriptor,
      ...workflow.memory.contextDescriptors.filter((entry) => entry.id !== descriptor.id)
    ], 80);
  }

  private recordAgentContextDescriptor(project: LoadedProject, agent: AgentState): void {
    if (agent.status !== "completed" && agent.status !== "failed" && agent.status !== "conflicted") {
      return;
    }

    const workflow = this.ensureWorkflowState(project.record);
    if (workflow.memory.contextDescriptors.some((entry) => entry.id === `agent:${agent.id}`)) {
      return;
    }

    const descriptor = {
      ...createAgentContextDescriptor(workflow, agent),
      id: `agent:${agent.id}`
    };
    workflow.memory.contextDescriptors = pruneWorkflowContextDescriptors([
      descriptor,
      ...workflow.memory.contextDescriptors.filter((entry) => entry.id !== descriptor.id)
    ], 80);
  }

  private selectAndRememberRelevantContext(
    project: LoadedProject,
    agentCategory: AgentCategory,
    taskText: string,
    relatedPaths: string[] = []
  ): string {
    const workflow = this.ensureWorkflowState(project.record);
    const modeConfig = getWorkflowModeConfig(workflow.workflowMode, resolveEffectiveAutopilotPolicy(workflow, project.record.localState.autopilotEnabled));
    const selections = selectRelevantWorkflowContext(workflow.memory.contextDescriptors, {
      workflow,
      agentCategory,
      taskText,
      relatedPaths
    }, {
      maxEntries: modeConfig.contextEntries,
      maxChars: modeConfig.contextCharBudget
    });
    workflow.memory.lastRelevantContext = selections;
    return formatRelevantContextForPrompt(selections);
  }

  private recordAcceptedDecision(
    workflow: ProjectWorkflowState,
    decision: Omit<ProjectWorkflowState["memory"]["lastAcceptedDecisions"][number], "id" | "decidedAt">
  ): void {
    workflow.memory.lastAcceptedDecisions.unshift({
      id: nanoid(),
      decidedAt: nowIso(),
      ...decision
    });
    this.refreshWorkflowMemory(workflow);
  }

  private recordWorkflowOpenIssue(
    workflow: ProjectWorkflowState,
    title: string,
    detail: string,
    source: ProjectWorkflowState["memory"]["knownOpenIssues"][number]["source"]
  ): void {
    const existing = workflow.memory.knownOpenIssues.find(
      (issue) => issue.title === title && issue.source === source && issue.status === "open"
    );
    if (existing) {
      existing.detail = detail;
      return;
    }

    workflow.memory.knownOpenIssues.unshift({
      id: nanoid(),
      title,
      detail,
      source,
      status: "open",
      recordedAt: nowIso()
    });
    this.refreshWorkflowMemory(workflow);
  }

  private resolveWorkflowOpenIssues(
    workflow: ProjectWorkflowState,
    predicate: (issue: ProjectWorkflowState["memory"]["knownOpenIssues"][number]) => boolean
  ): void {
    const resolvedAt = nowIso();
    for (const issue of workflow.memory.knownOpenIssues) {
      if (issue.status === "open" && predicate(issue)) {
        issue.status = "resolved";
        issue.resolvedAt = resolvedAt;
      }
    }
    this.refreshWorkflowMemory(workflow);
  }

  private resolveWorkflowHumanInterventions(
    workflow: ProjectWorkflowState,
    predicate: (intervention: ProjectWorkflowState["humanInterventions"][number]) => boolean,
    resolutionNotes: string
  ): void {
    const resolvedAt = nowIso();
    const resolvedTitles = new Set<string>();
    for (const intervention of workflow.humanInterventions) {
      if (intervention.status === "pending" && predicate(intervention)) {
        intervention.status = "resolved";
        intervention.resolvedAt = resolvedAt;
        intervention.resolutionNotes = resolutionNotes;
        resolvedTitles.add(intervention.title);
      }
    }
    if (resolvedTitles.size > 0) {
      this.resolveWorkflowOpenIssues(workflow, (issue) => issue.source === "human" && resolvedTitles.has(issue.title));
    }
  }

  private syncWorkflowState(project: LoadedProject): void {
    const startedAt = performance.now();
    const workflow = this.ensureWorkflowState(project.record);
    const projection = deriveWorkflowProjection(workflow, project.record.agents);
    workflow.workflowStage = projection.stage;
    workflow.workflowStopReason = projection.stopReason;
    workflow.workflowCycle.status = projection.cycleStatus;
    workflow.stepProgress = ensureWorkflowStepProgressState(workflow);

    if (workflow.workflowStopReason === "merge_conflicts" && !workflow.manualHandoff) {
      const latestMergeAgent = latestAgentByCategory(project.record.agents, "merge");
      const conflicts = latestMergeAgent?.mergeReport?.conflicts ?? [];
      const latestFailureReason =
        workflow.repair.latestFailureReason ??
        conflicts[0] ??
        "Deterministic merge reported conflicts.";
      workflow.manualHandoff = this.buildRepairManualHandoff(
        project,
        workflow.repair.latestIssueSummary ??
          latestMergeAgent?.mergeReport?.summary ??
          "Merge conflicts were detected and require follow-up.",
        latestFailureReason,
        "merge_conflicts",
        this.getMergeConflictHandoffPaths(conflicts.length > 0 ? conflicts : [latestFailureReason])
      );
    }
    if (workflow.workflowStopReason !== "merge_conflicts" && workflow.manualHandoff?.reason === "merge_conflicts") {
      workflow.manualHandoff = undefined;
    }

    if (hasConfirmedUltimateGoal(workflow.ultimateGoal)) {
      this.updateWorkflowStepProgress(workflow, "ultimate_goal", {
        requiresUserInput: false,
        message: "The Ultimate Goal is confirmed."
      }, { status: "completed" });
    }

    if (
      (workflow.workflowStage === "recommendation_pending" || workflow.workflowStage === "appeal_pending") &&
      workflow.recommendations.length > 0
    ) {
      this.updateWorkflowStepProgress(workflow, "recommendation", {
        requiresUserInput: true,
        currentActivity: workflow.workflowStage === "appeal_pending"
          ? "Waiting for one appeal recommendation to be chosen"
          : "Waiting for one recommendation to be chosen",
        message: workflow.workflowStage === "appeal_pending"
          ? "Final appeal recommendations are ready."
          : "Recommendations are ready."
      }, { status: "waiting" });
    }

    if (workflow.workflowStage === "blocked_human") {
      const intervention = workflow.humanInterventions.find((entry) => entry.status === "pending");
      const stepId = getWorkflowActiveStepId(workflow);
      this.updateWorkflowStepProgress(workflow, stepId, {
        requiresUserInput: true,
        blockedReason: intervention?.description ?? intervention?.reason,
        message: intervention?.title ?? "Human action is required before the workflow can continue."
      }, { status: "blocked" });
    }
    const autopilotPolicy = resolveEffectiveAutopilotPolicy(workflow, project.record.localState.autopilotEnabled);
    const nextAutopilotAction = getNextWorkflowAutomationAction(
      workflow,
      project.record.agents,
      project.scan.kind,
      autopilotPolicy,
      project.record.localState.workflowPauseRequested,
      project.record.localState.workflowObjective
    );
    const autopilotRecommendation = nextAutopilotAction === "approve_recommendation"
      ? this.selectAutopilotRecommendation(project)
      : undefined;
    const autopilotPause = shouldAutopilotPause({
      workflow,
      agents: project.record.agents,
      projectKind: project.scan.kind,
      workflowObjective: project.record.localState.workflowObjective,
      workflowPauseRequested: project.record.localState.workflowPauseRequested,
      projectAccessStatus: project.record.validation.projectAccess?.status ?? "unknown",
      nextAction: nextAutopilotAction,
      recommendation: autopilotRecommendation,
      goalChangeRequiresApproval: this.plannerRequiresGoalApproval(workflow),
      previewReady: getWorkflowPreviewRequest(workflow).status === "ready"
    }, autopilotPolicy);
    const preserveNoProgressPause =
      project.record.localState.workflowPauseRequested &&
      workflow.autopilotStatus?.pausedReason === "automation_no_progress"
        ? workflow.autopilotStatus
        : undefined;
    this.updateAutopilotRuntimeStatus(project, {
      nextPlannedAction: nextAutopilotAction ?? undefined,
      recommendation: autopilotRecommendation,
      pause: preserveNoProgressPause
        ? {
          reason: "automation_no_progress",
          detail: preserveNoProgressPause.pausedDetail,
          highRiskPackageRequiresApproval: false
        }
        : autopilotPause.shouldPause
        ? {
          reason: autopilotPause.reason,
          detail: autopilotPause.detail,
          highRiskPackageRequiresApproval: autopilotPause.highRiskPackageRequiresApproval
        }
        : {
          highRiskPackageRequiresApproval: autopilotPause.highRiskPackageRequiresApproval
        }
    });
    this.refreshWorkflowMemory(workflow);
    this.logWorkflowPerf(`syncWorkflowState ${project.record.identity.projectName}: ${Math.round(performance.now() - startedAt)}ms`);
  }

  private prepareWorkflowForNextRecommendationCycle(project: LoadedProject): void {
    const workflow = this.ensureWorkflowState(project.record);
    if (workflow.workflowCycle.status !== "completed" && workflow.workflowCycle.status !== "merged") {
      return;
    }

    workflow.workflowCycle = {
      cycleNumber: workflow.workflowCycle.cycleNumber + 1,
      acceptanceCriteria: [],
      status: "idle"
    };
    workflow.approvedRecommendation = undefined;
    workflow.scopedGoal = undefined;
    this.resetWorkflowRepairState(workflow);
    workflow.workflowStopReason = "recommendation_missing";
    workflow.manualHandoff = undefined;
    workflow.recommendations = [];
    workflow.recommendationsGeneratedAt = undefined;
    workflow.cycleContract = undefined;
    workflow.recommendationHealth = {
      ...workflow.recommendationHealth,
      fallbackUsedForCurrentRecommendation: false,
      fallbackReason: undefined,
      selectedTaskSource: "derived_from_legacy_state",
      fallbackConfidence: undefined,
      modelRecommendationAccepted: false,
      deterministicFallbackCandidateCount: 0,
      visibleWarningLevel: workflow.recommendationHealth.consecutiveStructuredFailures >= 3
        ? "critical"
        : workflow.recommendationHealth.consecutiveStructuredFailures >= 2
          ? "warning"
          : "none"
    };
    this.recordWorkflowActivity(workflow, {
      source: "workflow",
      status: "waiting",
      title: "Prepared the next recommendation cycle",
      detail: `Cycle ${workflow.workflowCycle.cycleNumber} is queued for new recommendations.`,
      stepId: "recommendation"
    });
    this.resetWorkflowStepProgress(workflow, "recommendation", {
      status: "waiting",
      requiresUserInput: false,
      currentActivity: "Queued for recommendation generation",
      message: "Preparing the next cycle."
    });
    this.resetWorkflowStepProgress(workflow, "goal_plan");
    this.resetWorkflowStepProgress(workflow, "coding");
    this.resetWorkflowStepProgress(workflow, "integrity");
    this.resetWorkflowStepProgress(workflow, "merge");
    this.refreshWorkflowMemory(workflow);
  }

  private normalizeGoalCheckMatchText(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  }

  private normalizeGoalEvidenceToken(token: string): string {
    if (token.length > 5 && token.endsWith("ing")) {
      return token.slice(0, -3);
    }
    if (token.length > 4 && token.endsWith("ed")) {
      return token.slice(0, -2);
    }
    if (token.length > 4 && token.endsWith("es")) {
      return token.slice(0, -2);
    }
    if (token.length > 3 && token.endsWith("s")) {
      return token.slice(0, -1);
    }
    return token;
  }

  private tokenizeGoalEvidence(value: string): string[] {
    return [...new Set(
      (value.toLowerCase().match(/[a-z0-9]+/g) ?? [])
        .map((token) => this.normalizeGoalEvidenceToken(token))
        .filter((token) => token.length >= 4 && !weakGoalEvidenceStopwords.has(token))
    )];
  }

  private isGenericGoalCompletionEvidence(evidence?: string): boolean {
    return Boolean(evidence && genericGoalCompletionEvidencePatterns.some((pattern) => pattern.test(evidence)));
  }

  private goalCheckEvidenceDirectlyMentionsCheck(
    check: Pick<GoalAttainmentCheck, "title" | "description">,
    evidence?: string,
    relatedPaths: string[] = []
  ): boolean {
    const checkTokens = this.tokenizeGoalEvidence(`${check.title} ${check.description}`);
    if (checkTokens.length === 0) {
      return Boolean(evidence?.trim());
    }

    const evidenceTokens = new Set(this.tokenizeGoalEvidence([evidence ?? "", ...relatedPaths].join(" ")));
    const overlapCount = checkTokens.filter((token) => evidenceTokens.has(token)).length;
    return checkTokens.length <= 2 ? overlapCount >= 1 : overlapCount >= 2;
  }

  private shouldDowngradeGenericMetGoalCheckEvidence(
    check: Pick<GoalAttainmentCheck, "title" | "description" | "source">,
    evidence?: string,
    relatedPaths: string[] = []
  ): boolean {
    return check.source !== "deterministic" &&
      this.isGenericGoalCompletionEvidence(evidence) &&
      !this.goalCheckEvidenceDirectlyMentionsCheck(check, evidence, relatedPaths);
  }

  private findGoalCheckForUpdate(project: LoadedProject, id: string | undefined, title: string): GoalAttainmentCheck | undefined {
    const workflow = this.ensureWorkflowState(project.record);
    const normalizedTitle = this.normalizeGoalCheckMatchText(title);
    return buildGoalChecklistForAssessment({
      workflow,
      agents: project.record.agents
    }).find((check) =>
      (id && check.id === id) ||
      this.normalizeGoalCheckMatchText(check.title) === normalizedTitle
    );
  }

  private goalCheckMatchesTargetText(check: GoalAttainmentCheck, targetText: string): boolean {
    const target = this.normalizeGoalCheckMatchText(targetText);
    if (target.length < 8) {
      return false;
    }

    return [check.title, check.description]
      .map((value) => this.normalizeGoalCheckMatchText(value))
      .filter((value) => value.length >= 8)
      .some((value) => value === target || value.includes(target) || target.includes(value));
  }

  private scopedGoalTargetsGoalCheck(workflow: ProjectWorkflowState, check: GoalAttainmentCheck): boolean {
    const scopedGoal = workflow.scopedGoal;
    if (!scopedGoal) {
      return false;
    }

    const scopedGoalText = [
      scopedGoal.summary,
      scopedGoal.executionBrief,
      ...scopedGoal.acceptanceCriteria
    ]
      .map((value) => this.normalizeGoalCheckMatchText(value))
      .join(" ");
    if (!scopedGoalText) {
      return false;
    }

    return [check.title, check.description]
      .map((value) => this.normalizeGoalCheckMatchText(value))
      .filter((value) => value.length >= 12)
      .some((value) => scopedGoalText.includes(value));
  }

  private findCompletedCycleTargetGoalCheck(project: LoadedProject, timestamp: string): GoalAttainmentCheck | undefined {
    const workflow = this.ensureWorkflowState(project.record);
    const approvedRecommendation = workflow.approvedRecommendation;
    if (!approvedRecommendation) {
      return undefined;
    }

    const candidates = buildGoalChecklistForAssessment({
      workflow,
      agents: project.record.agents
    }, timestamp).filter((check) =>
      check.required &&
      check.status !== "met" &&
      check.status !== "not_applicable" &&
      check.source !== "deterministic"
    );
    if (candidates.length === 0) {
      return undefined;
    }

    const explicitTarget = approvedRecommendation.title.match(/^Satisfy goal check:\s*(.+)$/i)?.[1]?.trim();
    if (explicitTarget) {
      const explicitMatch = candidates.find((check) => this.goalCheckMatchesTargetText(check, explicitTarget));
      if (explicitMatch && this.scopedGoalTargetsGoalCheck(workflow, explicitMatch)) {
        return explicitMatch;
      }
    }

    const haystack = [
      approvedRecommendation.title,
      approvedRecommendation.summary,
      approvedRecommendation.rationale,
      approvedRecommendation.expectedImpact,
      workflow.scopedGoal?.summary,
      workflow.scopedGoal?.executionBrief,
      ...(workflow.scopedGoal?.acceptanceCriteria ?? [])
    ]
      .filter((value): value is string => Boolean(value?.trim()))
      .map((value) => this.normalizeGoalCheckMatchText(value))
      .join(" ");
    if (!haystack) {
      return undefined;
    }

    const matches = candidates.filter((check) =>
      [check.title, check.description]
        .map((value) => this.normalizeGoalCheckMatchText(value))
        .filter((value) => value.length >= 12)
        .some((value) => haystack.includes(value))
    );
    const scopedGoalMatches = matches.filter((check) => this.scopedGoalTargetsGoalCheck(workflow, check));
    return scopedGoalMatches.length === 1 ? scopedGoalMatches[0] : undefined;
  }

  private markCompletedCycleGoalCheckEvidence(project: LoadedProject, timestamp: string): void {
    const workflow = this.ensureWorkflowState(project.record);
    if (getWorkflowPreviewRequest(workflow).status === "active" && isPreviewRecommendation(workflow.approvedRecommendation)) {
      return;
    }
    const targetCheck = this.findCompletedCycleTargetGoalCheck(project, timestamp);
    if (!targetCheck) {
      return;
    }

    const evidence = [
      `Cycle ${workflow.workflowCycle.cycleNumber} completed after deterministic validation and integration.`,
      workflow.scopedGoal?.summary ? `Scoped goal: ${workflow.scopedGoal.summary}.` : undefined
    ].filter((entry): entry is string => Boolean(entry)).join(" ");
    workflow.goalChecklist = applyGoalChecklistUpdates(
      buildGoalChecklistForAssessment({
        workflow,
        agents: project.record.agents
      }, timestamp),
      [{
        id: targetCheck.id,
        title: targetCheck.title,
        status: "met",
        confidence: Math.max(targetCheck.confidence ?? 0, 0.86),
        evidence,
        relatedPaths: workflow.approvedRecommendation?.relatedPaths ?? []
      }],
      { timestamp, ultimateGoal: workflow.ultimateGoal, cycleNumber: workflow.workflowCycle.cycleNumber }
    );
    const cycleAgents = this.cycleAgents(project, workflow.workflowCycle.cycleNumber);
    const completionChecklistChange: ChecklistChange = {
      id: nanoid(),
      action: "mark_complete",
      checklistItemIds: [targetCheck.id],
      title: targetCheck.title,
      rationale: "The workflow cycle completed after validation/integration and produced direct evidence for the targeted goal check.",
      sourceCycle: workflow.workflowCycle.cycleNumber,
      sourceAgent: cycleAgents[0]?.id,
      userApprovalStatus: "not_required",
      confidence: 0.86,
      risk: "low",
      affectedGoalArea: workflow.ultimateGoal.summary,
      linkedEvidence: [evidence],
      linkedChangedFiles: workflow.approvedRecommendation?.relatedPaths ?? [],
      linkedValidationCommands: unique(cycleAgents.flatMap((agent) => agent.commandLog.map((command) => command.command))).slice(0, 12),
      linkedCycleIds: [workflow.workflowCycle.cycleNumber],
      linkedAgentIds: cycleAgents.map((agent) => agent.id),
      createdAt: timestamp
    };
    workflow.checklistChanges = [completionChecklistChange, ...workflow.checklistChanges].slice(0, 100);
    this.refreshWorkflowTaskMap(project, timestamp);
    this.recordWorkflowActivity(workflow, {
      source: "workflow",
      status: "completed",
      title: "Goal check marked met",
      detail: targetCheck.title,
      stepId: "merge"
    });
  }

  private currentCycleTargetedCheckIds(workflow: ProjectWorkflowState): string[] {
    return unique([
      ...(workflow.cycleContract?.targetedChecklistItems.map((item) => item.checkId) ?? []),
      ...(workflow.scopedGoal?.targetedCheckIds ?? []),
      ...(workflow.approvedRecommendation?.targetedCheckIds ?? []),
      ...(this.plannerDecisionForCycle(workflow)?.targetedChecklistIds ?? [])
    ]);
  }

  private collectCycleChecklistEvidenceObservations(
    project: LoadedProject,
    timestamp: string
  ): ChecklistEvidenceObservation[] {
    const workflow = this.ensureWorkflowState(project.record);
    const cycleNumber = workflow.workflowCycle.cycleNumber;
    const targetedCheckIds = this.currentCycleTargetedCheckIds(workflow);
    const deterministicTargetCheck = getWorkflowPreviewRequest(workflow).status === "active" && isPreviewRecommendation(workflow.approvedRecommendation)
      ? undefined
      : this.findCompletedCycleTargetGoalCheck(project, timestamp);
    const deterministicTargetedCheckIds = deterministicTargetCheck ? [deterministicTargetCheck.id] : [];
    const effectiveTargetedCheckIds = unique([...targetedCheckIds, ...deterministicTargetedCheckIds]);
    if (effectiveTargetedCheckIds.length === 0) {
      return [];
    }
    const knownCheckIds = workflow.goalChecklist.map((check) => check.id);
    const cycleAgents = this.cycleAgents(project, cycleNumber);
    const retainedCommandEvidence = workflow.evidenceObservations.filter((observation) =>
      observation.cycleNumber === cycleNumber &&
      observation.evidenceSourceType === "command_output" &&
      observation.sourceRef.commandId
    );
    const observations = [
      ...retainedCommandEvidence,
      ...cycleAgents.flatMap((agent) => {
        const commandObservations = agent.commandLog.flatMap((command) => {
          const output = command.output.trim();
          if (!output) {
            return [];
          }
          return extractChecklistEvidenceObservations(output, {
            cycleNumber,
            targetedCheckIds: effectiveTargetedCheckIds,
            knownCheckIds,
            evidenceSourceType: "command_output",
            sourceRef: {
              commandId: command.itemId ?? command.command,
              agentRunId: agent.id
            },
            observedAt: command.completedAt ?? timestamp
          });
        });
        const integrityObservations = (agent.integrityReport?.checks ?? []).flatMap((check) =>
          extractChecklistEvidenceObservations(check.outputSnippet, {
            cycleNumber,
            targetedCheckIds: effectiveTargetedCheckIds,
            knownCheckIds,
            evidenceSourceType: "deterministic_validator",
            sourceRef: {
              commandId: check.command || check.name,
              agentRunId: agent.id
            },
            observedAt: agent.integrityReport?.generatedAt ?? timestamp
          })
        );
        const messageObservations = agent.events
          .filter((event) => (event.type === "message" || event.type === "raw" || event.type === "report") && event.detail?.trim())
          .flatMap((event) =>
            extractChecklistEvidenceObservations(event.detail ?? "", {
              cycleNumber,
              targetedCheckIds: effectiveTargetedCheckIds,
              knownCheckIds,
              evidenceSourceType: "agent_message",
              sourceRef: {
                eventId: event.id,
                agentRunId: agent.id
              },
              observedAt: event.timestamp
            })
          );
        return [...commandObservations, ...integrityObservations, ...messageObservations];
      })
    ];
    if (deterministicTargetCheck) {
      const validationCommands = unique(cycleAgents.flatMap((agent) => agent.commandLog.map((command) => command.command))).slice(0, 12);
      const evidence = [
        `Cycle ${workflow.workflowCycle.cycleNumber} completed after deterministic validation and integration.`,
        workflow.scopedGoal?.summary ? `Scoped goal: ${workflow.scopedGoal.summary}.` : undefined
      ].filter((entry): entry is string => Boolean(entry)).join(" ");
      observations.push({
        observationId: `evidence:${cycleNumber}:deterministic-validator:${deterministicTargetCheck.id}`,
        cycleNumber,
        checkId: deterministicTargetCheck.id,
        status: "met",
        evidenceText: evidence,
        evidenceSourceType: "deterministic_validator",
        sourceRef: {
          commandId: validationCommands[0] ?? "workflow-cycle-validation",
          agentRunId: cycleAgents[0]?.id,
          sourceKey: "completed_cycle_target_check"
        },
        relevantPaths: workflow.approvedRecommendation?.relatedPaths ?? [],
        validationCommands,
        confidence: Math.max(deterministicTargetCheck.confidence ?? 0, 0.86),
        observedAt: timestamp,
        consumedByChecklist: true
      });
    }
    const byObservationId = new Map(observations.map((observation) => [observation.observationId, observation]));
    return [...byObservationId.values()];
  }

  private reconcileCycleChecklistEvidence(
    project: LoadedProject,
    timestamp: string,
    checklistBefore: GoalAttainmentCheck[]
  ): ChecklistEvidenceObservation[] {
    const workflow = this.ensureWorkflowState(project.record);
    const targetedCheckIds = this.currentCycleTargetedCheckIds(workflow);
    const observations = this.collectCycleChecklistEvidenceObservations(project, timestamp);
    const knownCheckIds = new Set(workflow.goalChecklist.map((check) => check.id));
    const effectiveTargetedCheckIds = unique([
      ...targetedCheckIds,
      ...observations
        .filter((observation) => observation.evidenceSourceType === "deterministic_validator" && knownCheckIds.has(observation.checkId))
        .map((observation) => observation.checkId)
    ]);
    if (effectiveTargetedCheckIds.length === 0) {
      return observations;
    }
    const applied = applyChecklistEvidenceObservations(workflow.goalChecklist, observations, {
      targetedCheckIds: effectiveTargetedCheckIds,
      timestamp
    });
    workflow.goalChecklist = applied.checklist;
    workflow.evidenceObservations = [
      ...applied.observations,
      ...workflow.evidenceObservations.filter((observation) => observation.cycleNumber !== workflow.workflowCycle.cycleNumber)
    ].slice(0, 500);
    if (applied.observations.length > 0) {
      this.recordWorkflowActivity(workflow, {
        source: "workflow",
        status: applied.observations.some((observation) => observation.consumedByChecklist) ? "completed" : "waiting",
        title: "Checklist evidence reconciled",
        detail: `${applied.observations.filter((observation) => observation.consumedByChecklist).length}/${applied.observations.length} evidence observation(s) consumed for targeted checks.`,
        stepId: "merge"
      });
    }
    const delta = computeChecklistDelta(checklistBefore, workflow.goalChecklist, applied.observations, {
      cycleNumber: workflow.workflowCycle.cycleNumber,
      targetedCheckIds: effectiveTargetedCheckIds,
      timestamp
    });
    workflow.checklistDeltas = [
      delta,
      ...workflow.checklistDeltas.filter((entry) => entry.cycleNumber !== delta.cycleNumber)
    ].slice(0, 100);
    workflow.cycleContract = buildCycleContract(workflow, {
      now: timestamp,
      selectedTaskSource: workflow.cycleContract?.selectedTaskSource ?? workflow.recommendationHealth.selectedTaskSource,
      previousChecklist: checklistBefore
    });
    return applied.observations;
  }

  private refreshWorkflowTaskMap(project: LoadedProject, timestamp = nowIso()): void {
    const workflow = this.ensureWorkflowState(project.record);
    const context = this.buildWorkflowRecommendationContext(project);
    workflow.taskMap = buildChecklistTaskMap(context, timestamp);
    workflow.workPackages = buildChecklistWorkPackages(context);
    this.refreshEvidenceCommands(project);
    workflow.cycleContract = buildCycleContract(workflow, {
      now: timestamp,
      selectedTaskSource: workflow.cycleContract?.selectedTaskSource ?? workflow.recommendationHealth.selectedTaskSource
    });
  }

  private refreshEvidenceCommands(project: LoadedProject): void {
    const workflow = this.ensureWorkflowState(project.record);
    const previousSuccessfulCommands = unique(project.record.agents.flatMap((agent) =>
      agent.commandLog
        .filter((command) => command.exitCode === 0)
        .map((command) => command.command)
    ));
    const codingAgentCommands = unique(project.record.agents.flatMap((agent) =>
      agent.category === "coding" ? agent.commandLog.map((command) => command.command) : []
    ));
    workflow.evidenceCommands = discoverProjectEvidenceCommands({
      files: project.scan.files.map((file) => ({ relativePath: file.relativePath })),
      previousSuccessfulCommands,
      codingAgentCommands,
      checklist: workflow.goalChecklist,
      workPackages: workflow.workPackages
    });
  }

  private upsertValidationLedger(workflow: ProjectWorkflowState, ledger: ValidationLedger): void {
    workflow.validationLedgers = [
      ledger,
      ...workflow.validationLedgers.filter((entry) => entry.cycleNumber !== ledger.cycleNumber)
    ].slice(0, 40);
  }

  private latestCycleValidationLedger(workflow: ProjectWorkflowState): ValidationLedger | undefined {
    return workflow.validationLedgers
      .filter((ledger) => ledger.cycleNumber === workflow.workflowCycle.cycleNumber)
      .sort((left, right) => toTime(right.updatedAt) - toTime(left.updatedAt))[0];
  }

  private validationLedgerIsMissingEquivalent(ledger?: ValidationLedger): boolean {
    return !ledger || (
      ledger.finalValidationStatus === "not_run" &&
      ledger.commandResults.length === 0 &&
      ledger.attemptedCommands.length === 0
    );
  }

  private mergeGateReasonIsOnlyMissingValidationLedger(reason?: string): boolean {
    return Boolean(reason && /No validation ledger|Validation did not run|Validation status is not_run/i.test(reason));
  }

  private upsertRepoHygieneReport(workflow: ProjectWorkflowState, report: RepoHygieneReport): void {
    workflow.repoHygieneReports = [
      report,
      ...workflow.repoHygieneReports.filter((entry) => entry.scannedRef !== report.scannedRef)
    ].slice(0, 60);
  }

  private latestRepoHygieneReport(workflow: ProjectWorkflowState): RepoHygieneReport | undefined {
    return workflow.repoHygieneReports
      .slice()
      .sort((left, right) => toTime(right.scannedAt) - toTime(left.scannedAt))[0];
  }

  private async scanWorkflowRepoHygiene(
    project: LoadedProject,
    scannedRef: string,
    clean = true,
    rootOverride?: string,
    diffBaseRef?: string
  ): Promise<RepoHygieneReport> {
    const scanRoot = rootOverride ?? project.record.projectRoot;
    const report = await scanAndCleanRepoHygiene({
      projectRoot: scanRoot,
      hostRoot: rootOverride ?? project.record.hostPath ?? project.record.projectRoot,
      projectKind: project.scan.kind,
      runtimeSettings: this.getRuntimeSettings(project.record.distroName),
      scannedRef,
      clean,
      diffBaseRef
    });
    const workflow = this.ensureWorkflowState(project.record);
    this.upsertRepoHygieneReport(workflow, report);
    if (report.cleanedFiles.length > 0 || report.mergeBlockingFindings.length > 0) {
      this.recordWorkflowActivity(workflow, {
        source: "validation",
        status: report.mergeBlockingFindings.length > 0 ? "failed" : "completed",
        title: report.mergeBlockingFindings.length > 0 ? "Repository hygiene blocked merge" : "Repository hygiene cleaned generated artifacts",
        detail: report.summaryForHumans,
        stepId: report.mergeBlockingFindings.length > 0 ? "merge" : "integrity"
      });
    }
    return report;
  }

  private mergeGateBlockedReasons(workflow: ProjectWorkflowState, repoHygieneReport?: RepoHygieneReport): string[] {
    const ledger = this.latestCycleValidationLedger(workflow);
    const hygiene = repoHygieneReport ?? this.latestRepoHygieneReport(workflow);
    const decision = deriveMergeGateDecision({ ledger, repoHygieneReport: hygiene });
    return unique(decision.blockedReasons.map((reason) =>
      reason === "No validation ledger has passed." ? "No validation ledger has passed for this cycle." : reason
    ));
  }

  private refreshUltimateGoalAssessment(project: LoadedProject, timestamp = nowIso()): void {
    const workflow = this.ensureWorkflowState(project.record);
    workflow.goalChecklist = buildGoalChecklistForAssessment({
      workflow,
      agents: project.record.agents
    }, timestamp);
    this.refreshWorkflowTaskMap(project, timestamp);
    const context = this.buildWorkflowRecommendationContext(project);
    const progressEstimate = estimateUltimateGoalProgress(context);
    workflow.ultimateGoalProgress = {
      ...progressEstimate,
      source: "deterministic",
      updatedAt: timestamp
    };
    workflow.ultimateGoalCompletion = {
      ...assessUltimateGoalCompletion(context, progressEstimate),
      source: "deterministic",
      updatedAt: timestamp
    };
  }

  private refreshUltimateGoalAssessmentIfChanged(project: LoadedProject, timestamp = nowIso()): boolean {
    const workflow = this.ensureWorkflowState(project.record);
    const previousChecklist = JSON.stringify(workflow.goalChecklist);
    workflow.goalChecklist = buildGoalChecklistForAssessment({
      workflow,
      agents: project.record.agents
    }, timestamp);
    let changed = JSON.stringify(workflow.goalChecklist) !== previousChecklist;
    const previousTaskMap = JSON.stringify(workflow.taskMap);
    this.refreshWorkflowTaskMap(project, timestamp);
    changed = JSON.stringify(workflow.taskMap) !== previousTaskMap || changed;
    const context = this.buildWorkflowRecommendationContext(project);
    const progressEstimate = estimateUltimateGoalProgress(context);
    const currentProgress = workflow.ultimateGoalProgress;
    if (
      !currentProgress ||
      currentProgress.source !== "deterministic" ||
      currentProgress.percentComplete !== progressEstimate.percentComplete ||
      currentProgress.rationale !== progressEstimate.rationale
    ) {
      workflow.ultimateGoalProgress = {
        ...progressEstimate,
        source: "deterministic",
        updatedAt: timestamp
      };
      changed = true;
    }

    const completionAssessment = assessUltimateGoalCompletion(context, progressEstimate);
    const currentCompletion = workflow.ultimateGoalCompletion;
    if (
      !currentCompletion ||
      currentCompletion.source !== "deterministic" ||
      currentCompletion.state !== completionAssessment.state ||
      currentCompletion.rationale !== completionAssessment.rationale
    ) {
      workflow.ultimateGoalCompletion = {
        ...completionAssessment,
        source: "deterministic",
        updatedAt: timestamp
      };
      changed = true;
    }

    return changed;
  }

  private reconcileStaleGoalChecklistEvidence(project: LoadedProject, timestamp = nowIso()): boolean {
    const workflow = this.ensureWorkflowState(project.record);
    let changed = false;
    workflow.goalChecklist = workflow.goalChecklist.map((check) => {
      if (
        !check.required ||
        check.status !== "met" ||
        !userDerivedGoalCheckSources.has(check.source) ||
        !this.shouldDowngradeGenericMetGoalCheckEvidence(check, check.evidence, check.relatedPaths)
      ) {
        return check;
      }

      changed = true;
      return {
        ...check,
        status: "unknown" as const,
        confidence: Math.min(check.confidence ?? 0.5, 0.55),
        evidence: "Previous generic completion evidence did not directly support this checklist item after resume reconciliation.",
        updatedAt: timestamp
      };
    });

    if (changed) {
      this.refreshWorkflowTaskMap(project, timestamp);
      this.recordWorkflowActivity(workflow, {
        source: "system",
        status: "waiting",
        title: "Goal checklist evidence refreshed",
        detail: "Generic completion evidence was rechecked against the saved Ultimate Goal so unfinished checklist items can receive recommendations.",
        stepId: "recommendation"
      });
    }

    return changed;
  }

  private hasActiveWorkflowAgentForStep(project: LoadedProject, stepId: WorkflowStepId): boolean {
    const workflow = this.ensureWorkflowState(project.record);
    return project.record.agents.some((agent) =>
      agent.category !== "manual" &&
      isAgentActive(agent) &&
      this.getWorkflowStepIdForAgent(agent) === stepId &&
      (agent.workflowCycleNumber === undefined || agent.workflowCycleNumber === workflow.workflowCycle.cycleNumber)
    );
  }

  private requeueStaleRunningWorkflowSteps(project: LoadedProject): boolean {
    const workflow = this.ensureWorkflowState(project.record);
    let changed = false;
    const requeue = (
      stepId: WorkflowStepId,
      patch: Partial<ProjectWorkflowState["stepProgress"][WorkflowStepId]>
    ): void => {
      const status = workflow.stepProgress[stepId].status;
      if (
        (status !== "running" && status !== "recovering" && status !== "starting") ||
        this.hasActiveWorkflowAgentForStep(project, stepId)
      ) {
        return;
      }
      this.resetWorkflowStepProgress(workflow, stepId, {
        status: "waiting",
        requiresUserInput: false,
        warning: undefined,
        ...patch
      });
      changed = true;
    };

    requeue("ultimate_goal", {
      requiresUserInput: true,
      currentActivity: workflow.ultimateGoalDraft ? "Draft ready for review" : "Queued to redetect the Ultimate Goal",
      message: workflow.ultimateGoalDraft
        ? "Review and confirm the saved Ultimate Goal draft."
        : "Ultimate Goal detection can restart from the saved project state."
    });
    requeue("recommendation", {
      requiresUserInput: workflow.recommendations.length > 0 && !workflow.approvedRecommendation,
      currentActivity: workflow.recommendations.length > 0 && !workflow.approvedRecommendation
        ? "Waiting for a recommendation choice"
        : "Queued to regenerate recommendations",
      latestProgressNote: workflow.recommendations[0]?.title,
      message: workflow.recommendations.length > 0 && !workflow.approvedRecommendation
        ? "Saved recommendations are still available. Choose one to continue."
        : "Recommendation generation will restart from the saved project state."
    });
    if (workflow.approvedRecommendation && !workflow.scopedGoal) {
      requeue("goal_plan", {
        currentActivity: "Queued to recreate the scoped plan",
        latestProgressNote: workflow.approvedRecommendation.title,
        message: "The approved recommendation was saved; goal planning will restart from that decision."
      });
    }
    if (workflow.scopedGoal) {
      requeue("coding", {
        currentActivity: workflow.repair.status === "repairing" ? "Queued to restart the repair pass" : "Queued to restart coding",
        latestProgressNote: workflow.scopedGoal.summary,
        message: "The scoped goal was saved; coding will restart from that plan."
      });
      requeue("integrity", {
        currentActivity: workflow.repair.status === "retrying_validation"
          ? "Queued to retry validation after repair"
          : "Queued to retry validation",
        message: "Validation will restart from the saved workflow state."
      });
    }
    requeue("merge", {
      currentActivity: "Queued to retry integration",
      message: "Merge will restart from the saved validation result."
    });

    return changed;
  }

  private reconcileWorkflowResumeState(project: LoadedProject): boolean {
    const workflow = this.ensureWorkflowState(project.record);
    const timestamp = nowIso();
    let changed = this.reconcileStaleGoalChecklistEvidence(project, timestamp);
    if (
      hasConfirmedUltimateGoal(workflow.ultimateGoal) &&
      (
        changed ||
        !workflow.ultimateGoalProgress ||
        !workflow.ultimateGoalCompletion ||
        workflow.workflowCycle.status === "completed" ||
        workflow.workflowCycle.status === "merged"
      )
    ) {
      changed = this.refreshUltimateGoalAssessmentIfChanged(project, timestamp) || changed;
    }
    changed = this.requeueStaleRunningWorkflowSteps(project) || changed;
    if (changed) {
      this.refreshWorkflowMemory(workflow);
    }
    return changed;
  }

  private finalizeWorkflowCycle(project: LoadedProject): void {
    const workflow = this.ensureWorkflowState(project.record);
    if (workflow.workflowCycle.status === "completed") {
      return;
    }

    const completedAt = nowIso();
    workflow.workflowCycle.status = "completed";
    workflow.workflowCycle.completedAt = completedAt;
    workflow.memory.perCycleSummaries.unshift({
      cycleNumber: workflow.workflowCycle.cycleNumber,
      summary:
        workflow.scopedGoal?.summary ??
        workflow.approvedRecommendation?.title ??
        `Cycle ${workflow.workflowCycle.cycleNumber} completed.`,
      openIssueIds: workflow.memory.knownOpenIssues.filter((issue) => issue.status === "open").map((issue) => issue.id),
      createdAt: nowIso()
    });
    this.recordWorkflowContextDescriptor(workflow, {
      agentCategory: "merge",
      summary: [
        workflow.scopedGoal?.summary,
        workflow.approvedRecommendation?.title,
        `Cycle ${workflow.workflowCycle.cycleNumber} completed.`
      ].filter(Boolean).join(" "),
      changedPaths: project.record.agents
        .filter((agent) => agent.workflowCycleNumber === workflow.workflowCycle.cycleNumber)
        .flatMap((agent) => agent.changedFiles),
      relatedPaths: [
        ...(workflow.approvedRecommendation?.relatedPaths ?? []),
        ...(workflow.scopedGoal?.acceptanceCriteria ?? [])
      ]
    });
    if (workflow.appeal.status === "running") {
      workflow.appeal = {
        ...workflow.appeal,
        status: "completed",
        completedAt,
        cycleNumber: workflow.appeal.cycleNumber ?? workflow.workflowCycle.cycleNumber
      };
      this.recordWorkflowActivity(workflow, {
        source: "workflow",
        status: "completed",
        title: "Final appeal pass completed",
        detail: workflow.scopedGoal?.summary ?? workflow.approvedRecommendation?.title ?? "Final appeal pass completed.",
        stepId: "merge"
      });
    }
    this.recordAcceptedDecision(workflow, {
      kind: "merge",
      title: `Cycle ${workflow.workflowCycle.cycleNumber} completed`,
      summary: workflow.scopedGoal?.summary ?? workflow.approvedRecommendation?.title ?? "",
      cycleNumber: workflow.workflowCycle.cycleNumber
    });
    const checklistBeforeEvidence = workflow.goalChecklist.map((check) => ({
      ...check,
      relatedPaths: [...(check.relatedPaths ?? [])],
      evidenceHistory: [...(check.evidenceHistory ?? [])]
    }));
    this.reconcileCycleChecklistEvidence(project, completedAt, checklistBeforeEvidence);
    this.refreshUltimateGoalAssessment(project, completedAt);
    const latestDelta = workflow.checklistDeltas.find((entry) => entry.cycleNumber === workflow.workflowCycle.cycleNumber);
    if (latestDelta) {
      workflow.checklistDeltas = [
        computeChecklistDelta(checklistBeforeEvidence, workflow.goalChecklist, workflow.evidenceObservations.filter((entry) => entry.cycleNumber === workflow.workflowCycle.cycleNumber), {
          cycleNumber: workflow.workflowCycle.cycleNumber,
          targetedCheckIds: this.currentCycleTargetedCheckIds(workflow),
          timestamp: completedAt
        }),
        ...workflow.checklistDeltas.filter((entry) => entry.cycleNumber !== workflow.workflowCycle.cycleNumber)
      ].slice(0, 100);
    }
    workflow.cycleContract = buildCycleContract(workflow, {
      now: completedAt,
      selectedTaskSource: workflow.cycleContract?.selectedTaskSource ?? workflow.recommendationHealth.selectedTaskSource,
      previousChecklist: checklistBeforeEvidence
    });
    this.markWorkflowPreviewReady(project, completedAt);
    const retrospective = buildCycleRetrospective({
      workflow,
      cycleNumber: workflow.workflowCycle.cycleNumber,
      agents: this.cycleAgents(project, workflow.workflowCycle.cycleNumber),
      plannerDecision: this.plannerDecisionForCycle(workflow, workflow.workflowCycle.cycleNumber),
      nextRecommendedTasks: workflow.recommendations.slice(0, 4).map((recommendation) => recommendation.title),
      shouldContinue: workflow.ultimateGoalCompletion?.state !== "goal_satisfied" && workflow.memory.knownOpenIssues.every((issue) => issue.status !== "open"),
      now: completedAt
    });
    retrospective.cycleContract = workflow.cycleContract;
    retrospective.checklistDelta = workflow.checklistDeltas.find((entry) => entry.cycleNumber === workflow.workflowCycle.cycleNumber);
    workflow.cycleRetrospectives = [
      retrospective,
      ...workflow.cycleRetrospectives.filter((entry) => entry.cycleNumber !== retrospective.cycleNumber)
    ].slice(0, 50);
    const latestSummary = workflow.memory.perCycleSummaries.find((summary) => summary.cycleNumber === workflow.workflowCycle.cycleNumber);
    if (latestSummary) {
      latestSummary.summary = compactText(
        [
          `Tried: ${retrospective.triedToDo}`,
          retrospective.changedFiles.length ? `Changed ${retrospective.changedFiles.length} file${retrospective.changedFiles.length === 1 ? "" : "s"}` : "",
          retrospective.passed.length ? `${retrospective.passed.length} validation signal${retrospective.passed.length === 1 ? "" : "s"} passed` : "",
          retrospective.failed.length ? `${retrospective.failed.length} failure signal${retrospective.failed.length === 1 ? "" : "s"} recorded` : ""
        ].filter(Boolean).join(". "),
        700
      );
    }
    this.updateWorkflowStepProgress(workflow, "merge", {
      requiresUserInput: false,
      currentActivity: "Cycle complete",
      message: "The current workflow cycle finished successfully."
    }, { status: "completed" });
    this.recordWorkflowActivity(workflow, {
      source: "workflow",
      status: "completed",
      title: "Workflow cycle completed",
      detail: workflow.scopedGoal?.summary ?? workflow.approvedRecommendation?.title ?? `Cycle ${workflow.workflowCycle.cycleNumber} completed.`,
      stepId: "merge"
    });
    this.syncWorkflowState(project);
  }

  private async persistProjectUpdate(project: LoadedProject, options?: boolean | PersistProjectUpdateOptions): Promise<void> {
    if (this.disposed) {
      return;
    }
    const normalized = this.normalizePersistProjectUpdateOptions(options);
    const startedAt = performance.now();
    if (normalized.save === "immediate") {
      await this.saveProject(project);
    } else if (normalized.save === "deferred") {
      this.scheduleProjectSave(project);
    }
    if (normalized.emit === "immediate") {
      this.emitStateNow(normalized.reason);
    } else if (normalized.emit === "coalesced") {
      this.emitState();
    }
    this.logWorkflowPerf(
      `${normalized.reason}: persist save=${normalized.save || "none"} emit=${normalized.emit || "none"} automate=${normalized.automate} in ${Math.round(performance.now() - startedAt)}ms`
    );
    if (normalized.automate && this.shouldScheduleWorkflowAutomation(project)) {
      this.scheduleWorkflowAutomation(project.record.id, normalized.reason);
    }
  }

  private nextWorkflowAutomationGeneration(projectId: string): number {
    const nextGeneration = (this.workflowAutomationGenerations.get(projectId) ?? 0) + 1;
    this.workflowAutomationGenerations.set(projectId, nextGeneration);
    return nextGeneration;
  }

  private scheduleWorkflowAutomation(projectId: string, reason = "workflow update"): void {
    if (this.disposed) {
      return;
    }
    const project = this.projects.get(projectId);
    if (!project || !this.shouldScheduleWorkflowAutomation(project)) {
      return;
    }
    if (this.workflowAutomationInFlight.has(projectId)) {
      this.workflowAutomationQueued.add(projectId);
      this.logWorkflowPerf(`automation queued for ${project.record.identity.projectName}: ${reason}`);
      return;
    }
    if (this.workflowAutomationTimers.has(projectId)) {
      this.workflowAutomationQueued.add(projectId);
      this.logWorkflowPerf(`automation timer coalesced for ${project.record.identity.projectName}: ${reason}`);
      return;
    }

    const generation = this.nextWorkflowAutomationGeneration(projectId);
    const timer = setTimeout(() => {
      const scheduled = this.workflowAutomationTimers.get(projectId);
      if (!scheduled || scheduled.generation !== generation) {
        return;
      }
      this.workflowAutomationTimers.delete(projectId);
      const latestProject = this.projects.get(projectId);
      if (!latestProject || !this.shouldScheduleWorkflowAutomation(latestProject)) {
        this.workflowAutomationQueued.delete(projectId);
        this.logWorkflowPerf(`stale automation skipped for ${latestProject?.record.identity.projectName ?? projectId}: ${reason}`);
        return;
      }
      this.logWorkflowPerf(`automation started for ${latestProject.record.identity.projectName}: ${reason}`);
      void this.runWorkflowAutomation(projectId);
    }, WORKFLOW_AUTOMATION_SCHEDULE_DELAY_MS);
    this.workflowAutomationTimers.set(projectId, { timer, generation });
    timer.unref?.();
  }

  private cancelScheduledWorkflowAutomation(projectId: string): void {
    const scheduled = this.workflowAutomationTimers.get(projectId);
    if (scheduled) {
      clearTimeout(scheduled.timer);
      this.workflowAutomationTimers.delete(projectId);
    }
    this.nextWorkflowAutomationGeneration(projectId);
    this.workflowAutomationQueued.delete(projectId);
  }

  private resolveRuntimeAutopilotPolicy(project: LoadedProject, workflow = this.ensureWorkflowState(project.record)): AutopilotPolicy {
    const budget = workflow.goalCharter.autopilotStrategy.autonomyBudget;
    return {
      ...resolveEffectiveAutopilotPolicy(workflow, project.record.localState.autopilotEnabled),
      stopWhenGoalSatisfied: budget.stopWhenGoalComplete,
      stopWhenNoSafeRecommendation: budget.stopWhenNoSafeNextTaskExists
    };
  }

  private getNextAutomationActionForProject(project: LoadedProject): ReturnType<typeof getNextWorkflowAutomationAction> {
    const workflow = this.ensureWorkflowState(project.record);
    const autopilotPolicy = this.resolveRuntimeAutopilotPolicy(project, workflow);
    return getNextWorkflowAutomationAction(
      workflow,
      project.record.agents,
      project.scan.kind,
      autopilotPolicy,
      project.record.localState.workflowPauseRequested,
      autopilotPolicy.stopWhenGoalSatisfied ? project.record.localState.workflowObjective : "optimize"
    );
  }

  private shouldScheduleWorkflowAutomation(project: LoadedProject): boolean {
    if (!this.canRunAgentBackedActions(project)) {
      this.logWorkflowPerf(`automation blocked for ${project.record.identity.projectName}: ${this.runtimeReadinessErrorMessage(project)}`);
      return false;
    }

    const workflow = this.ensureWorkflowState(project.record);
    const autopilotPolicy = resolveEffectiveAutopilotPolicy(workflow, project.record.localState.autopilotEnabled);
    const action = getNextWorkflowAutomationAction(
      workflow,
      project.record.agents,
      project.scan.kind,
      autopilotPolicy,
      project.record.localState.workflowPauseRequested,
      project.record.localState.workflowObjective
    );
    if (!action) {
      return false;
    }

    const recommendation = action === "approve_recommendation"
      ? this.selectAutopilotRecommendation(project)
      : undefined;
    const pauseDecision = shouldAutopilotPause({
      workflow,
      agents: project.record.agents,
      projectKind: project.scan.kind,
      workflowObjective: project.record.localState.workflowObjective,
      workflowPauseRequested: project.record.localState.workflowPauseRequested,
      projectAccessStatus: project.record.validation.projectAccess?.status ?? "unknown",
      nextAction: action,
      recommendation,
      goalChangeRequiresApproval: this.plannerRequiresGoalApproval(workflow),
      previewReady: getWorkflowPreviewRequest(workflow).status === "ready"
    }, autopilotPolicy);
    return !pauseDecision.shouldPause;
  }

  private getWorkflowStepIdForAutomationAction(action: ReturnType<typeof getNextWorkflowAutomationAction>): WorkflowStepId | undefined {
    switch (action) {
      case "generate_recommendations":
      case "approve_recommendation":
        return "recommendation";
      case "create_scoped_goal":
        return "goal_plan";
      case "start_coding":
      case "repair_coding":
        return "coding";
      case "run_integrity":
        return "integrity";
      case "run_merge":
      case "finalize_cycle":
        return "merge";
      default:
        return undefined;
    }
  }

  private workflowStartupMessageForAction(action: ReturnType<typeof getNextWorkflowAutomationAction>): string {
    switch (action) {
      case "generate_recommendations":
        return "Preparing the recommendation agent.";
      case "approve_recommendation":
        return "Preparing the saved recommendation decision.";
      case "create_scoped_goal":
        return "Preparing the goal planning agent.";
      case "start_coding":
        return "Preparing the coding agent and worktree.";
      case "repair_coding":
        return "Preparing the repair coding agent and worktree.";
      case "run_integrity":
        return "Preparing deterministic validation.";
      case "run_merge":
        return "Preparing merge and integration.";
      case "finalize_cycle":
        return "Preparing cycle finalization.";
      default:
        return "Preparing the next workflow step.";
    }
  }

  private markWorkflowStartupProgress(
    project: LoadedProject,
    status: "recovering" | "starting",
    message: string,
    stepIdOverride?: WorkflowStepId
  ): void {
    const workflow = this.ensureWorkflowState(project.record);
    const action = this.getNextAutomationActionForProject(project);
    const stepId = stepIdOverride ?? this.getWorkflowStepIdForAutomationAction(action) ?? getWorkflowActiveStepId(workflow);
    if (status === "starting") {
      for (const [candidateStepId, progress] of Object.entries(workflow.stepProgress) as Array<[WorkflowStepId, ProjectWorkflowState["stepProgress"][WorkflowStepId]]>) {
        if (progress.status === "recovering") {
          this.updateWorkflowStepProgress(workflow, candidateStepId, {
            currentActivity: "Recovery complete",
            message: "The next workflow step is starting.",
            warning: undefined
          }, { status: "waiting" });
        }
      }
    }
    this.updateWorkflowStepProgress(workflow, stepId, {
      requiresUserInput: false,
      currentActivity: status === "recovering" ? "Recovering workflow state" : "Starting workflow agent",
      currentSubstep: this.workflowStartupMessageForAction(action),
      message,
      warning: undefined
    }, { status });
  }

  private isWindowsMountedWslProject(project: LoadedProject): boolean {
    return this.settings.executionMode === "wsl" && WSL_WINDOWS_MOUNT_PATH.test(project.record.projectRoot);
  }

  private recordWindowsMountWarningIfNeeded(project: LoadedProject): void {
    if (!this.isWindowsMountedWslProject(project)) {
      return;
    }
    const workflow = this.ensureWorkflowState(project.record);
    if (workflow.activityLog.some((event) => event.title === "Windows-mounted WSL project path detected")) {
      return;
    }
    this.recordWorkflowActivity(workflow, {
      source: "system",
      status: "waiting",
      title: "Windows-mounted WSL project path detected",
      detail: "This workflow is running from /mnt/*. WSL Git and file IO can be much slower there; startup may take longer.",
      stepId: getWorkflowActiveStepId(workflow)
    });
  }

  private buildWorkflowAutomationProgressSignature(
    project: LoadedProject,
    action: ReturnType<typeof getNextWorkflowAutomationAction>
  ): string {
    const workflow = this.ensureWorkflowState(project.record);
    const activeAgents = project.record.agents
      .filter((agent) => agent.category !== "manual" && isAgentActive(agent))
      .map((agent) => `${agent.category}:${agent.id}:${agent.status}:${agent.threadId ?? ""}`)
      .sort();
    const stepProgress = Object.fromEntries(
      Object.entries(workflow.stepProgress).map(([stepId, progress]) => [
        stepId,
        [
          progress.status,
          progress.requiresUserInput,
          progress.runCount,
          progress.attemptCount,
          progress.currentActivity ?? "",
          progress.latestProgressNote ?? ""
        ].join(":")
      ])
    );
    return JSON.stringify({
      action,
      stage: workflow.workflowStage,
      stopReason: workflow.workflowStopReason,
      cycleNumber: workflow.workflowCycle.cycleNumber,
      cycleStatus: workflow.workflowCycle.status,
      approvedRecommendationId: workflow.approvedRecommendation?.recommendationId,
      scopedGoalId: workflow.scopedGoal?.id,
      recommendations: workflow.recommendations.map((recommendation) => recommendation.id).join(","),
      recommendationGeneratedAt: workflow.recommendationsGeneratedAt,
      plannerDecision: this.plannerDecisionForCycle(workflow)?.id,
      proposedGoalChanges: workflow.goalCharter.proposedGoalChanges.length,
      checklistChanges: workflow.checklistChanges.length,
      repairStatus: workflow.repair.status,
      repairAttempts: workflow.repair.attemptCount,
      mergeStatus: workflow.stepProgress.merge.status,
      previewStatus: getWorkflowPreviewRequest(workflow).status,
      pauseRequested: project.record.localState.workflowPauseRequested,
      pausedReason: workflow.autopilotStatus?.pausedReason,
      activeAgents,
      stepProgress
    });
  }

  private async yieldWorkflowAutomationLoop(): Promise<void> {
    await new Promise<void>((resolve) => {
      const immediate = setImmediate(resolve);
      immediate.unref?.();
    });
  }

  private pauseWorkflowAutomationForNoProgress(
    project: LoadedProject,
    action: ReturnType<typeof getNextWorkflowAutomationAction>
  ): void {
    const workflow = this.ensureWorkflowState(project.record);
    const detail = `The next automation action stayed at ${action ?? "none"} without changing workflow progress, so automation was paused to avoid a loop.`;
    project.record.localState.workflowPauseRequested = true;
    this.updateAutopilotRuntimeStatus(project, {
      nextPlannedAction: action ?? undefined,
      pause: {
        reason: "automation_no_progress",
        detail,
        highRiskPackageRequiresApproval: false
      }
    });
    this.recordWorkflowActivity(workflow, {
      source: "workflow",
      status: "waiting",
      title: "Workflow automation paused to avoid a loop",
      detail,
      stepId: getWorkflowActiveStepId(workflow)
    });
    this.updateWorkflowStepProgress(workflow, getWorkflowActiveStepId(workflow), {
      warning: detail,
      message: detail
    });
    this.syncWorkflowState(project);
  }

  private async runWorkflowAutomation(projectId: string): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.workflowAutomationInFlight.has(projectId)) {
      this.workflowAutomationQueued.add(projectId);
      return;
    }

    this.workflowAutomationInFlight.add(projectId);
    this.workflowAutomationQueued.delete(projectId);
    try {
      const automationPassStartedAt = performance.now();
      let automaticActionsThisPass = 0;
      let completedCyclesThisPass = 0;
      let repeatedNoProgressCount = 0;
      let repeatedNoProgressSignature = "";
      for (;;) {
        if (this.disposed) {
          return;
        }
        const iterationStartedAt = performance.now();
        const project = this.projects.get(projectId);
        if (!project) {
          return;
        }

        this.syncWorkflowState(project);
        if (this.prepareQueuedWorkflowPreviewForRecommendation(project)) {
          await this.persistProjectUpdate(project, {
            save: "immediate",
            emit: "coalesced",
            reason: "workflow preview prepared"
          });
        }
        const workflow = this.ensureWorkflowState(project.record);
        const autopilotPolicy = this.resolveRuntimeAutopilotPolicy(project, workflow);
        const autonomyBudget = workflow.goalCharter.autopilotStrategy.autonomyBudget;
        const maxActionsThisPass = minPositiveLimit(
          autopilotPolicy.maxAutomaticActionsPerPass,
          positiveAutonomyLimit(autonomyBudget.maxConsecutiveTasksWithoutUserReview),
          WORKFLOW_AUTOMATION_HARD_ACTION_LIMIT
        );
        if (automaticActionsThisPass >= maxActionsThisPass) {
          this.updateAutopilotRuntimeStatus(project);
          await this.persistProjectUpdate(project, {
            save: "immediate",
            emit: "coalesced",
            reason: "workflow automation action limit"
          });
          this.workflowAutomationQueued.add(projectId);
          break;
        }
        const maxMinutesBeforePause = positiveAutonomyLimit(autonomyBudget.maxMinutesBeforePause);
        if (maxMinutesBeforePause !== undefined && performance.now() - automationPassStartedAt >= maxMinutesBeforePause * 60_000) {
          project.record.localState.workflowPauseRequested = true;
          const pause = {
            reason: "max_consecutive_cycles" as const,
            detail: `Autopilot reached the ${maxMinutesBeforePause} minute strategy budget checkpoint.`,
            highRiskPackageRequiresApproval: false
          };
          this.updateAutopilotRuntimeStatus(project, { pause });
          this.recordAutopilotPause(workflow, pause.reason, pause.detail);
          await this.persistProjectUpdate(project, {
            save: "immediate",
            emit: "coalesced",
            reason: "workflow automation time budget"
          });
          break;
        }
        const maxCyclesBeforePause = positiveAutonomyLimit(autonomyBudget.maxCyclesBeforePause);
        if (
          (maxCyclesBeforePause !== undefined && completedCyclesThisPass >= maxCyclesBeforePause) ||
          (
            autopilotPolicy.maxConsecutiveCycles !== undefined &&
            completedCyclesThisPass >= autopilotPolicy.maxConsecutiveCycles
          )
        ) {
          project.record.localState.workflowPauseRequested = true;
          const maxCycleCheckpoint = minPositiveLimit(
            maxCyclesBeforePause,
            autopilotPolicy.maxConsecutiveCycles ?? autonomyBudget.maxCyclesBeforePause
          );
          const pause = {
            reason: "max_consecutive_cycles" as const,
            detail: `Autopilot reached the ${maxCycleCheckpoint} cycle strategy checkpoint.`,
            highRiskPackageRequiresApproval: false
          };
          this.updateAutopilotRuntimeStatus(project, { pause });
          this.recordAutopilotPause(workflow, pause.reason, pause.detail);
          await this.persistProjectUpdate(project, {
            save: "immediate",
            emit: "coalesced",
            reason: "workflow automation cycle limit"
          });
          break;
        }
        const maxFailedRepairAttempts = positiveAutonomyLimit(autonomyBudget.maxFailedRepairAttempts);
        if (
          autonomyBudget.stopWhenValidationFailsRepeatedly &&
          maxFailedRepairAttempts !== undefined &&
          workflow.repair.attemptCount > maxFailedRepairAttempts
        ) {
          project.record.localState.workflowPauseRequested = true;
          const pause = {
            reason: "repeated_failure" as const,
            detail: `Autopilot reached the ${maxFailedRepairAttempts} failed repair attempt strategy budget.`,
            highRiskPackageRequiresApproval: false
          };
          this.updateAutopilotRuntimeStatus(project, { pause });
          this.recordAutopilotPause(workflow, pause.reason, pause.detail);
          await this.persistProjectUpdate(project, {
            save: "immediate",
            emit: "coalesced",
            reason: "workflow automation repair budget"
          });
          break;
        }
        const action = getNextWorkflowAutomationAction(
          workflow,
          project.record.agents,
          project.scan.kind,
          autopilotPolicy,
          project.record.localState.workflowPauseRequested,
          autopilotPolicy.stopWhenGoalSatisfied ? project.record.localState.workflowObjective : "optimize"
        );
        const recommendation = action === "approve_recommendation"
          ? this.selectAutopilotRecommendation(project)
          : undefined;
        const pauseDecision = shouldAutopilotPause({
          workflow,
          agents: project.record.agents,
          projectKind: project.scan.kind,
          workflowObjective: project.record.localState.workflowObjective,
          workflowPauseRequested: project.record.localState.workflowPauseRequested,
          projectAccessStatus: project.record.validation.projectAccess?.status ?? "unknown",
          nextAction: action,
          recommendation,
          goalChangeRequiresApproval: this.plannerRequiresGoalApproval(workflow),
          previewReady: getWorkflowPreviewRequest(workflow).status === "ready"
        }, autopilotPolicy);
        this.updateAutopilotRuntimeStatus(project, {
          nextPlannedAction: action ?? undefined,
          recommendation,
          pause: pauseDecision.shouldPause
            ? {
              reason: pauseDecision.reason,
              detail: pauseDecision.detail,
              highRiskPackageRequiresApproval: pauseDecision.highRiskPackageRequiresApproval
            }
            : {
              highRiskPackageRequiresApproval: pauseDecision.highRiskPackageRequiresApproval
            }
        });
        if (pauseDecision.shouldPause) {
          this.recordAutopilotPause(workflow, pauseDecision.reason, pauseDecision.detail);
          await this.persistProjectUpdate(project, {
            save: "immediate",
            emit: "coalesced",
            reason: "workflow automation paused"
          });
          break;
        }
        if (!action) {
          break;
        }

        const beforeSignature = this.buildWorkflowAutomationProgressSignature(project, action);
        this.logWorkflowPerf(`automation action ${action} for ${project.record.identity.projectName}`);
        switch (action) {
          case "generate_recommendations":
            await this.runRecommendation(projectId, true);
            break;
          case "approve_recommendation": {
            if (!recommendation) {
              break;
            }
            await this.approveRecommendation(projectId, recommendation.id, "autopilot");
            break;
          }
          case "create_scoped_goal":
            await this.createScopedGoal(projectId, true);
            break;
          case "start_coding":
          case "repair_coding":
            await this.startWorkflowCodingPass(projectId, action === "repair_coding");
            break;
          case "run_integrity":
            await this.runIntegrity(projectId, true);
            break;
          case "run_merge":
            await this.runMerge(projectId, true);
            break;
          case "finalize_cycle": {
            this.finalizeWorkflowCycle(project);
            await this.persistProjectUpdate(project, {
              save: "deferred",
              emit: "coalesced",
              automate: true,
              reason: "workflow cycle finalized"
            });
            break;
          }
        }
        automaticActionsThisPass += 1;
        if (action === "finalize_cycle") {
          completedCyclesThisPass += 1;
        }
        const updatedProject = this.projects.get(projectId);
        if (updatedProject) {
          this.updateAutopilotRuntimeStatus(updatedProject, { lastCompletedAction: action });
          this.syncWorkflowState(updatedProject);
          const afterAction = this.getNextAutomationActionForProject(updatedProject);
          const afterSignature = this.buildWorkflowAutomationProgressSignature(updatedProject, afterAction);
          if (beforeSignature === afterSignature) {
            const noProgressKey = `${action}:${beforeSignature}`;
            repeatedNoProgressCount = noProgressKey === repeatedNoProgressSignature ? repeatedNoProgressCount + 1 : 1;
            repeatedNoProgressSignature = noProgressKey;
          } else {
            repeatedNoProgressCount = 0;
            repeatedNoProgressSignature = "";
          }
          if (repeatedNoProgressCount >= WORKFLOW_AUTOMATION_NO_PROGRESS_LIMIT) {
            this.pauseWorkflowAutomationForNoProgress(updatedProject, action);
            await this.persistProjectUpdate(updatedProject, {
              save: "immediate",
              emit: "immediate",
              reason: "workflow automation no progress"
            });
            break;
          }
          await this.persistProjectUpdate(updatedProject, {
            save: false,
            emit: "coalesced",
            reason: `workflow automation completed ${action}`
          });
        }

        this.logWorkflowPerf(
          `automation iteration ${action} for ${project.record.identity.projectName}: ${Math.round(performance.now() - iterationStartedAt)}ms`
        );
        await this.yieldWorkflowAutomationLoop();
      }
    } catch (error) {
      this.diagnostics.unshift(
        `Workflow automation paused. ${error instanceof Error ? error.message : String(error)}`
      );
      await this.recoverWorkflowAutomationError(projectId, error);
      this.emitState();
    } finally {
      this.workflowAutomationInFlight.delete(projectId);
      const rerunCurrentProject = this.workflowAutomationQueued.delete(projectId);
      const nextQueuedProjectId = rerunCurrentProject
        ? projectId
        : this.workflowAutomationQueued.values().next().value;
      if (nextQueuedProjectId) {
        this.workflowAutomationQueued.delete(nextQueuedProjectId);
        this.scheduleWorkflowAutomation(nextQueuedProjectId, "coalesced automation rerun");
      }
    }
  }

  private async recoverWorkflowAutomationError(projectId: string, error: unknown): Promise<void> {
    const project = this.projects.get(projectId);
    if (!project) {
      return;
    }

    const workflow = this.ensureWorkflowState(project.record);
    const detail = error instanceof Error ? error.message : String(error);
    const approvedRecommendation = workflow.approvedRecommendation;
    if (approvedRecommendation && !workflow.scopedGoal && this.isRecoverableAgentLaunchError(error)) {
      this.recordWorkflowActivity(workflow, {
        source: "workflow",
        status: "failed",
        title: "Goal planning recovered with fallback",
        detail,
        stepId: "goal_plan"
      });
      await this.applyFallbackScopedGoal(project, approvedRecommendation, undefined, true);
      return;
    }

    const activeInterruptedAgents = project.record.agents.filter((agent) =>
      isWorkflowAutomationBlockingAgent(agent) &&
      (agent.workflowCycleNumber === undefined || agent.workflowCycleNumber === workflow.workflowCycle.cycleNumber)
    );
    if (activeInterruptedAgents.length > 0 && this.isRecoverableAgentLaunchError(error)) {
      for (const agent of activeInterruptedAgents) {
        this.markAgentDisconnected(project, agent, `Agent startup or transport request failed. ${detail}`);
      }
      project.record.localState.workflowPauseRequested = true;
      this.resetWorkflowAfterInterruptedAgents(project, activeInterruptedAgents, { markRecoveryHandled: true });
      this.recordWorkflowActivity(workflow, {
        source: "system",
        status: "waiting",
        title: "Workflow automation paused after agent startup failed",
        detail,
        stepId: getWorkflowActiveStepId(workflow)
      });
      await this.persistProjectUpdate(project, false);
      return;
    }

    if (this.requeueStaleRunningWorkflowSteps(project)) {
      this.recordWorkflowActivity(workflow, {
        source: "workflow",
        status: "waiting",
        title: "Automation step requeued after runtime error",
        detail,
        stepId: getWorkflowActiveStepId(workflow)
      });
      await this.persistProjectUpdate(project, true);
    }
  }

  private buildFallbackUltimateGoalDraft(project: LoadedProject): UltimateGoal {
    return {
      summary: project.record.overview?.whatProjectDoes ?? `Advance ${project.record.identity.projectName} toward a clearer, production-ready implementation.`,
      detailedIntent:
        project.record.overview?.summary ??
        project.scan.stats.explanation ??
        "Inspect the repository, preserve its existing boundaries, and move the implementation toward a more complete state.",
      successCriteria: [
        "The project remains buildable, testable, and aligned with the repository conventions.",
        "New work stays within the typed IPC and renderer sandbox boundaries.",
        "Changes can be validated with deterministic checks before merge."
      ],
      constraints: [
        "Do not bypass typed IPC.",
        "Do not expose Node APIs in the renderer.",
        "Keep privileged repository operations in runtime or the main process."
      ],
      nonGoals: [
        "Do not replace the Codex app-server stdio transport.",
        "Do not accumulate unbounded agent context without summaries."
      ],
      targetAudience: "Developers maintaining and extending this codebase.",
      qualityBar: "Production-grade, explicit, test-backed changes that preserve the existing security and architecture boundaries.",
      source: "detected",
      lastUpdatedAt: nowIso()
    };
  }

  private applyDetectedUltimateGoalDraft(project: LoadedProject, draft: UltimateGoal): UltimateGoal {
    const workflow = this.ensureWorkflowState(project.record);
    const normalizedDraft = ultimateGoalSchema.parse({
      ...draft,
      source: "detected",
      confirmedAt: undefined,
      lastUpdatedAt: nowIso()
    });
    workflow.ultimateGoalDraft = normalizedDraft;
    if (!workflow.ultimateGoal.confirmedAt || workflow.ultimateGoal.source === "detected" || !hasMeaningfulUltimateGoal(workflow.ultimateGoal)) {
      workflow.ultimateGoal = normalizedDraft;
      workflow.goalChecklist = buildGoalChecklistFromUltimateGoal(normalizedDraft, workflow.goalChecklist);
      this.refreshWorkflowTaskMap(project);
    }
    this.syncWorkflowState(project);
    const charter = this.ensureGoalCharterForWorkflow(workflow);
    const proposal: GoalChangeRecord = {
      id: charter.proposedGoalChanges.find((change) => change.source === "detected")?.id ?? nanoid(),
      title: "Detected Ultimate Goal",
      summary: normalizedDraft.summary,
      rationale: "Auto-detected from repository overview, scan evidence, and existing project boundaries. It is a proposal until accepted.",
      source: "detected",
      proposedGoal: normalizedDraft,
      fromGoalSummary: charter.currentEffectiveGoal.summary,
      toGoalSummary: normalizedDraft.summary,
      createdAt: nowIso()
    };
    charter.proposedGoalChanges = [
      proposal,
      ...charter.proposedGoalChanges.filter((change) => change.id !== proposal.id && change.source !== "detected")
    ].slice(0, 20);
    charter.updatedAt = nowIso();
    workflow.goalCharter = charter;
    return normalizedDraft;
  }

  private buildUltimateGoalDetectionOutputSchema(): JsonValue {
    return {
      type: "object",
      additionalProperties: false,
      required: [
        "summary",
        "detailedIntent",
        "successCriteria",
        "constraints",
        "nonGoals",
        "targetAudience",
        "qualityBar"
      ],
      properties: {
        summary: { type: "string", maxLength: 520 },
        detailedIntent: { type: "string" },
        successCriteria: { type: "array", items: { type: "string" } },
        constraints: { type: "array", items: { type: "string" } },
        nonGoals: { type: "array", items: { type: "string" } },
        targetAudience: { type: "string" },
        qualityBar: { type: "string" }
      }
    } satisfies JsonValue;
  }

  private buildUltimateGoalDetectionPrompt(project: LoadedProject): string {
    return [
      "Inspect this repository and draft a persistent project charter.",
      "Focus on the long-lived ultimate goal rather than the next implementation step.",
      "Be explicit about success criteria, constraints, and non-goals.",
      "Write success criteria as observable end-state outcomes that later agents can satisfy one bounded cycle at a time.",
      "Merge near-duplicates instead of listing every possible implementation detail as a separate criterion.",
      "Use the quality bar to describe what makes the final project excellent, not just technically complete.",
      "Use non-goals to prevent the autonomous cycle from chasing tempting but unnecessary work.",
      "",
      `Project: ${project.record.identity.projectName}`,
      `Overview: ${project.record.overview?.summary ?? project.scan.stats.explanation}`,
      `Entry points: ${project.scan.stats.entryPoints.slice(0, 6).join(", ") || "None detected"}`,
      `Primary managers: ${project.scan.stats.primaryManagers.join(", ") || "None detected"}`
    ].join("\n");
  }

  private extractJsonObjects(rawText: string): Array<Record<string, unknown>> {
    const candidate = rawText.trim();
    const parsedObjects: Array<Record<string, unknown>> = [];
    let objectStart = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = 0; index < candidate.length; index += 1) {
      const char = candidate[index];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = inString;
        continue;
      }

      if (char === "\"") {
        inString = !inString;
        continue;
      }

      if (inString && (char === "\n" || char === "\r")) {
        objectStart = -1;
        depth = 0;
        inString = false;
        escaped = false;
        continue;
      }

      if (inString) {
        continue;
      }

      if (char === "{") {
        if (depth === 0) {
          objectStart = index;
        }
        depth += 1;
        continue;
      }

      if (char === "}" && depth > 0) {
        depth -= 1;
        if (depth === 0 && objectStart >= 0) {
          try {
            const parsed = JSON.parse(candidate.slice(objectStart, index + 1)) as unknown;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              parsedObjects.push(parsed as Record<string, unknown>);
            }
          } catch {
            // Keep scanning; app-server messages can contain partial or diagnostic JSON fragments.
          }
          objectStart = -1;
        }
      }
    }

    return parsedObjects;
  }

  private buildRestrictedSandboxPolicy(
    project: LoadedProject,
    sandbox: "workspace-write" | "read-only"
  ): SandboxPolicy {
    if (sandbox === "read-only") {
      return {
        type: "readOnly",
        networkAccess: false
      };
    }

    return {
      type: "workspaceWrite",
      writableRoots: [project.record.projectRoot],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    };
  }

  private buildProjectBoundaryDeveloperInstructions(
    project: LoadedProject,
    cwd: string,
    sandbox: "workspace-write" | "read-only"
  ): string {
    return [
      "Project boundary rules:",
      `- The active project root is: ${project.record.projectRoot}`,
      `- The working directory for this thread is: ${cwd}`,
      "- Treat the active project root shown above as allowed, even if it lives under /mnt, Downloads, Desktop, or another home-directory location.",
      "- Only inspect, mention, or modify files inside the active project root.",
      "- Do not use parent folders, sibling folders, or path traversal such as ../ to escape the active project root.",
      "- Prefer project-relative paths in all explanations and reports.",
      sandbox === "workspace-write"
        ? "- Any edits, generated files, and command side effects must remain inside the active project root."
        : "- This is a read-only thread. Do not request write access or permissions for anything outside the active project root.",
      `- ${this.buildExternalServiceCostPolicyInstructions()}`,
      "- If you independently obtain a legitimate free/no-card credential for this project, do not write it into files. Report it once as AGENT_WORKBENCH_CREDENTIAL {\"providerName\":\"Provider\",\"keyLabel\":\"API key\",\"apiKey\":\"value\",\"secretKey\":\"optional\",\"freeTier\":true,\"notes\":\"where it came from\"}. Do not use this for paid, invented, scraped, or unrelated secrets.",
      "- If the information you want appears to live outside the project root, stop and explain that the workflow boundary forbids it."
    ].join("\n");
  }

  private trimTrailingPathPunctuation(candidate: string): string {
    if (!(/[\\/]/.test(candidate) || /^[A-Za-z]:[\\/]/.test(candidate) || candidate.startsWith("\\\\"))) {
      return candidate;
    }
    return candidate.replace(/[.!?]+$/, "");
  }

  private tokenizeShellLikeText(value: string): string[] {
    return value.match(/"[^"]*"|'[^']*'|`[^`]*`|\S+/g) ?? [];
  }

  private normalizeShellToken(token: string): string {
    return token
      .replace(/^[("'`]+/, "")
      .replace(/[)"'`,;:]+$/, "")
      .trim();
  }

  private isAbsolutePathReference(candidate: string): boolean {
    const normalized = candidate.replace(/\\/g, "/");
    return (
      normalized.startsWith("~/") ||
      normalized.startsWith("$HOME/") ||
      normalized.startsWith("${HOME}/") ||
      normalized.startsWith("/") ||
      /^[A-Za-z]:[\\/]/.test(candidate) ||
      candidate.startsWith("\\\\")
    );
  }

  private findLeadingExecutableTokenIndex(tokens: string[]): number | undefined {
    for (const [index, token] of tokens.entries()) {
      const candidate = this.normalizeShellToken(token);
      if (!candidate) {
        continue;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(candidate)) {
        continue;
      }
      if (candidate === "env" || candidate === "command") {
        continue;
      }
      if (candidate.startsWith("-")) {
        continue;
      }
      return index;
    }

    return undefined;
  }

  private normalizePotentialPathToken(token: string): string | undefined {
    const withoutAssignment = token.includes("=") && !token.startsWith("=")
      ? token.slice(token.indexOf("=") + 1)
      : token;
    const candidate = this.normalizeShellToken(withoutAssignment);
    const normalizedCandidate = this.trimTrailingPathPunctuation(candidate);

    if (!normalizedCandidate || normalizedCandidate.includes("://")) {
      return undefined;
    }

    const normalized = normalizedCandidate.replace(/\\/g, "/");
    if (
      this.isAbsolutePathReference(normalizedCandidate) ||
      normalized.startsWith("./") ||
      normalized.startsWith("../")
    ) {
      return normalizedCandidate;
    }

    if (normalized.includes("/") && !normalizedCandidate.startsWith("-")) {
      return normalizedCandidate;
    }

    return undefined;
  }

  private textReferencesOutsideProject(project: LoadedProject, value?: string, cwd?: string): string | undefined {
    if (!value?.trim()) {
      return undefined;
    }

    const executionCwd = cwd ?? project.record.projectRoot;
    const tokens = this.tokenizeShellLikeText(value);
    const leadingExecutableIndex = this.findLeadingExecutableTokenIndex(tokens);
    for (const [index, token] of tokens.entries()) {
      const candidate = this.normalizePotentialPathToken(token);
      if (!candidate) {
        continue;
      }
      if (index === leadingExecutableIndex && this.isAbsolutePathReference(candidate)) {
        continue;
      }
      if (candidate.startsWith("~/") || candidate.startsWith("$HOME/") || candidate.startsWith("${HOME}/")) {
        return candidate;
      }

      try {
        resolveExecutionPathWithinProjectRoot(
          project.record.projectRoot,
          this.getExecutionPath(project, executionCwd, candidate),
          project.record.hostPath,
          "Project boundary"
        );
      } catch {
        return candidate;
      }
    }

    return undefined;
  }

  private getExecutionPath(project: LoadedProject, cwd: string, candidate: string): string {
    const pathModule = project.record.projectRoot.includes("\\") ? path.win32 : path.posix;
    return pathModule.isAbsolute(candidate) ? pathModule.normalize(candidate) : pathModule.normalize(pathModule.join(cwd, candidate));
  }

  private sanitizeTextToProjectBoundary(project: LoadedProject, value?: string, cwd?: string): string | undefined {
    if (!value?.trim()) {
      return value;
    }

    const executionCwd = cwd ?? project.record.projectRoot;
    const tokens = this.tokenizeShellLikeText(value);
    const leadingExecutableIndex = this.findLeadingExecutableTokenIndex(tokens);
    return tokens
      .map((token, index) => {
        const candidate = this.normalizePotentialPathToken(token);
        if (!candidate) {
          return token;
        }
        if (index === leadingExecutableIndex && this.isAbsolutePathReference(candidate)) {
          return token;
        }

        return this.textReferencesOutsideProject(project, candidate, executionCwd)
          ? "[outside-project path blocked]"
          : token;
      })
      .join(" ");
  }

  private getKnownProjectRelativePaths(project: LoadedProject): Set<string> {
    const knownPaths = new Set<string>();
    for (const file of project.scan.files) {
      knownPaths.add(file.relativePath);
      const segments = file.relativePath.split("/");
      let current = "";
      for (let index = 0; index < segments.length - 1; index += 1) {
        current = current ? `${current}/${segments[index]}` : segments[index];
        knownPaths.add(current);
      }
    }
    return knownPaths;
  }

  private sanitizeRelatedPaths(project: LoadedProject, paths: unknown): string[] {
    if (!Array.isArray(paths)) {
      return [];
    }

    const knownPaths = this.getKnownProjectRelativePaths(project);
    return [...new Set(
      paths
        .map((entry) => typeof entry === "string" ? this.normalizeProjectRelativePath(entry) : null)
        .filter((entry): entry is string => typeof entry === "string" && knownPaths.has(entry))
    )].slice(0, 8);
  }

  private parseUltimateGoalDetectionOutput(rawText: string): UltimateGoal | undefined {
    for (const parsed of this.extractJsonObjects(rawText).reverse()) {
      try {
        return ultimateGoalSchema.parse({
          ...parsed,
          source: "detected",
          confirmedAt: undefined,
          lastUpdatedAt: nowIso()
        });
      } catch {
        // Try the next complete object in the message.
      }
    }

    return undefined;
  }

  private async applyUltimateGoalDetectionOutput(project: LoadedProject, agent: AgentState, rawText: string): Promise<boolean> {
    const parsed = this.parseUltimateGoalDetectionOutput(rawText);
    if (!parsed) {
      reduceAgentRuntimeEvent(agent, {
        kind: "raw",
        title: "Ultimate goal draft rejected",
        detail: rawText.slice(0, 240),
        raw: rawText
      });
      return false;
    }

    this.applyDetectedUltimateGoalDraft(project, parsed);
    const workflow = this.ensureWorkflowState(project.record);
    this.updateWorkflowStepProgress(workflow, "ultimate_goal", {
      requiresUserInput: true,
      currentActivity: "Draft ready for review",
      latestProgressNote: parsed.summary,
      message: "Review and confirm the detected Ultimate Goal draft."
    }, { status: "waiting" });
    agent.status = "completed";
    agent.currentPhase = "Ultimate goal draft ready";
    agent.lastMessageSnippet = parsed.summary.slice(0, 240);
    await this.persistProjectUpdate(project);
    return true;
  }

  private async startUltimateGoalDetectionAgent(project: LoadedProject): Promise<void> {
    if (!this.transport || this.codexAvailability.source === "unavailable") {
      return;
    }

    const agent = createAgentSkeleton(
      "goal",
      "Ultimate Goal Agent",
      "Inspect the repository and draft the persistent project charter using structured output.",
      this.getDefaultAgentModel()
    );
    const reasoningConfig = this.resolveAgentReasoningEffortForTask("goal", agent.model, `${agent.name}\n\n${agent.taskPrompt}`);
    agent.reasoningEffort = reasoningConfig.effort;
    agent.reasoningEffortSource = reasoningConfig.source;
    agent.taskPrompt = `${agentRoles.goal.instructions}\n\n${agent.taskPrompt}`;
    agent.status = "starting";
    agent.currentPhase = "Detecting ultimate goal";
    project.record.agents.unshift(agent);
    const workflow = this.ensureWorkflowState(project.record);
    this.touchAgentFreshness(workflow, "goal");
    this.updateWorkflowStepProgress(workflow, "ultimate_goal", {
      requiresUserInput: true,
      currentActivity: "Analyzing the repository to draft the Ultimate Goal",
      latestProgressNote: "Repository scan ready",
      message: "A draft is being prepared.",
      agentCategory: "goal"
    }, { status: "running", incrementRunCount: true, incrementAttemptCount: true });
    await this.persistProjectUpdate(project);

    await this.startAgentThread(project, agent, {
      sandbox: "read-only",
      prompt: this.buildUltimateGoalDetectionPrompt(project),
      outputSchema: this.buildUltimateGoalDetectionOutputSchema()
    });
  }

  private async restartTransportIfNeeded(previousSettings: AppSettings, nextSettings: AppSettings): Promise<void> {
    const runtimeSettingsChanged =
      previousSettings.mockMode !== nextSettings.mockMode ||
      previousSettings.executionMode !== nextSettings.executionMode ||
      previousSettings.distroName !== nextSettings.distroName ||
      previousSettings.codexBinaryPath !== nextSettings.codexBinaryPath ||
      previousSettings.codexHome !== nextSettings.codexHome;

    if (!runtimeSettingsChanged) {
      return;
    }

    this.threadToAgent.clear();
    if (this.transport) {
      const transport = this.transport;
      this.transport = undefined;
      try {
        this.suppressTransportExitHandling = true;
        await transport.dispose();
      } catch (error) {
        this.diagnostics.unshift(`Failed to restart Codex app-server cleanly. ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        this.suppressTransportExitHandling = false;
      }
    }

    this.availableModels = [];
    this.codexAvailability = { source: "unavailable", message: "Reconnecting to Codex app-server." };
    await this.initializeTransport();
    for (const project of this.projects.values()) {
      await this.resumeSavedAgents(project);
    }
  }

  private async restartTransportAfterCodexUpdate(): Promise<void> {
    this.threadToAgent.clear();
    if (this.transport) {
      const transport = this.transport;
      this.transport = undefined;
      try {
        this.suppressTransportExitHandling = true;
        await transport.dispose();
      } catch (error) {
        this.diagnostics.unshift(`Failed to restart Codex app-server after updating Codex CLI. ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        this.suppressTransportExitHandling = false;
      }
    }

    this.availableModels = [];
    this.codexAvailability = { source: "unavailable", message: "Restarting Codex app-server after Codex CLI update." };
    await this.initializeTransport();
    for (const project of this.projects.values()) {
      await this.resumeSavedAgents(project);
    }
  }

  private compactRendererAgent(agent: AgentState, options?: { detail?: boolean; summaryOnly?: boolean }): AgentState {
    const eventLimit = options?.summaryOnly
      ? 0
      : options?.detail
        ? RENDERER_AGENT_DETAIL_EVENT_LIMIT
        : RENDERER_AGENT_EVENT_PREVIEW_LIMIT;
    const commandLimit = options?.summaryOnly
      ? 0
      : options?.detail
        ? RENDERER_AGENT_DETAIL_COMMAND_LIMIT
        : RENDERER_AGENT_COMMAND_PREVIEW_LIMIT;

    return {
      ...agent,
      taskPrompt: options?.summaryOnly
        ? compactText(agent.taskPrompt, 240)
        : options?.detail
          ? compactText(agent.taskPrompt, 12_000)
          : compactText(agent.taskPrompt, 1_200),
      changedFiles: agent.changedFiles.slice(0, options?.summaryOnly ? 12 : 80),
      approvals: agent.approvals.slice(0, options?.summaryOnly ? 3 : 12).map((approval) => ({
        ...approval,
        summary: compactText(approval.summary, 300),
        reason: approval.reason ? compactText(approval.reason, 400) : approval.reason,
        command: approval.command ? compactText(approval.command, 1_000) : approval.command,
        filePaths: approval.filePaths.slice(0, 20)
      })),
      integrityReport: agent.integrityReport
        ? {
          ...agent.integrityReport,
          summary: compactText(agent.integrityReport.summary, 700),
          checks: agent.integrityReport.checks.slice(0, 12).map((check) => ({
            ...check,
            command: compactText(check.command, 500),
            outputSnippet: compactText(check.outputSnippet, 500)
          })),
          risks: agent.integrityReport.risks.slice(0, 12).map((risk) => compactText(risk, 400))
        }
        : agent.integrityReport,
      mergeReport: agent.mergeReport
        ? {
          ...agent.mergeReport,
          summary: compactText(agent.mergeReport.summary, 700),
          mergedBranches: agent.mergeReport.mergedBranches.slice(0, 24),
          conflicts: agent.mergeReport.conflicts.slice(0, 24).map((conflict) => compactText(conflict, 400))
        }
        : agent.mergeReport,
      recommendationReport: agent.recommendationReport
        ? {
          ...agent.recommendationReport,
          summary: compactText(agent.recommendationReport.summary, 700),
          nextSteps: agent.recommendationReport.nextSteps.slice(0, 5).map((step) => ({
            ...step,
            title: compactText(step.title, 180),
            summary: compactText(step.summary, 300),
            rationale: compactText(step.rationale, 300),
            expectedImpact: compactText(step.expectedImpact, 300),
            relatedPaths: step.relatedPaths.slice(0, 12)
          }))
        }
        : agent.recommendationReport,
      commandLog: agent.commandLog.slice(0, commandLimit).map((command) => ({
        ...command,
        command: command.command.length > RENDERER_COMMAND_TEXT_LIMIT
          ? `${command.command.slice(0, RENDERER_COMMAND_TEXT_LIMIT).trimEnd()}...[truncated ${command.command.length - RENDERER_COMMAND_TEXT_LIMIT} chars]`
          : command.command,
        output: options?.detail
          ? command.output.slice(-RENDERER_COMMAND_OUTPUT_LIMIT)
          : ""
      })),
      events: agent.events.slice(0, eventLimit).map((event) => ({
        ...event,
        detail: event.detail ? compactText(event.detail, options?.detail ? 8_000 : 800) : event.detail,
        raw: options?.detail ? compactRawForRenderer(event.raw) : undefined
      }))
    };
  }

  private compactRendererProjectRecord(record: LocalProjectRecord, options?: { inactive?: boolean; summaryOnly?: boolean }): LocalProjectRecord {
    if (options?.inactive || options?.summaryOnly) {
      const workflow = sanitizeWorkflowState(record.workflow, undefined, { renderer: true });
      return {
        ...record,
        localState: {
          ...record.localState,
          selectedFile: record.localState.selectedFile ? compactText(record.localState.selectedFile, 500) : record.localState.selectedFile,
          treeFilter: compactText(record.localState.treeFilter, 300)
        },
        interfaceCreation: record.interfaceCreation
          ? {
            ...record.interfaceCreation,
            phase: compactText(record.interfaceCreation.phase, 300),
            message: compactText(record.interfaceCreation.message, 600),
            lastError: record.interfaceCreation.lastError ? compactText(record.interfaceCreation.lastError, 600) : record.interfaceCreation.lastError
          }
          : record.interfaceCreation,
        overview: compactOverviewForRenderer(record.overview),
        agents: options?.inactive
          ? []
          : this.sortAgentsForHistory(record.agents).slice(0, RENDERER_RECENT_AGENT_PREVIEW_LIMIT).map((agent) =>
            this.compactRendererAgent(agent, { summaryOnly: true })
          ),
        summaryCache: [],
        dependencies: [],
        credentials: {
          ...record.credentials,
          entries: [],
          requests: record.credentials.requests.filter((request) => request.status === "pending").slice(0, 3)
        },
        userInputRequests: record.userInputRequests.filter((request) => request.status === "pending").slice(0, 3),
        workflow: {
          ...workflow,
          recommendations: options?.inactive ? [] : workflow.recommendations.slice(0, 3),
          goalChecklist: options?.inactive ? [] : workflow.goalChecklist.slice(0, 12),
          activityLog: [],
          memory: {
            ...workflow.memory,
            perCycleSummaries: [],
            lastAcceptedDecisions: [],
            knownOpenIssues: [],
            contextDescriptors: [],
            lastRelevantContext: []
          }
        }
      };
    }

    const previewAgents = this.sortAgentsForHistory(record.agents)
      .filter((agent, index) =>
        index < RENDERER_RECENT_AGENT_PREVIEW_LIMIT ||
        isAgentActive(agent) ||
        agent.approvals.some((approval) => approval.status === "pending")
      );
    const previewAgentIds = new Set(previewAgents.map((agent) => agent.id));

    return {
      ...record,
      localState: {
        ...record.localState,
        selectedFile: record.localState.selectedFile ? compactText(record.localState.selectedFile, 500) : record.localState.selectedFile,
        treeFilter: compactText(record.localState.treeFilter, 300)
      },
      interfaceCreation: record.interfaceCreation
        ? {
          ...record.interfaceCreation,
          phase: compactText(record.interfaceCreation.phase, 300),
          message: compactText(record.interfaceCreation.message, 600),
          lastError: record.interfaceCreation.lastError ? compactText(record.interfaceCreation.lastError, 600) : record.interfaceCreation.lastError
        }
        : record.interfaceCreation,
      overview: compactOverviewForRenderer(record.overview),
      dependencies: record.dependencies.slice(0, RENDERER_REPOSITORY_DEPENDENCY_LIMIT),
      summaryCache: record.summaryCache.slice(0, RENDERER_REPOSITORY_SUMMARY_CACHE_LIMIT),
      agents: previewAgents.map((agent) => this.compactRendererAgent(agent, {
        summaryOnly: !previewAgentIds.has(agent.id)
      })),
      workflow: sanitizeWorkflowState({
        ...record.workflow,
        activityLog: record.workflow.activityLog.slice(0, 80).map((event) => ({
          ...event,
          detail: event.detail ? compactText(event.detail, MAX_WORKFLOW_ACTIVITY_DETAIL_LENGTH) : event.detail
        }))
      }, undefined, { renderer: true })
    };
  }

  private toRendererLoadedProjectView(project: LoadedProject): LoadedProjectView {
    const inactive = project.record.id !== this.activeProjectId;
    return {
      record: this.compactRendererProjectRecord(project.record, { inactive }),
      tree: compactRepoTreePreview(project.tree),
      validationStatus: project.record.validation.lastValidatedAt ? "exact" : "unvalidated",
      candidates: []
    };
  }

  private sortAgentsForHistory(agents: AgentState[]): AgentState[] {
    return [...agents].sort((left, right) => {
      const leftTime = new Date(left.lastActivityAt ?? left.startedAt ?? left.completedAt ?? left.createdAt).getTime();
      const rightTime = new Date(right.lastActivityAt ?? right.startedAt ?? right.completedAt ?? right.createdAt).getTime();
      const timeDelta = (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
      return timeDelta !== 0 ? timeDelta : left.name.localeCompare(right.name);
    });
  }

  getRendererState(): WorkbenchState {
    const state: WorkbenchState = {
      settings: this.settings,
      github: this.githubStatus,
      projects: [...this.projects.values()].map((project) => this.toRendererLoadedProjectView(project)),
      activeProjectId: this.activeProjectId,
      availableModels: this.availableModels,
      codexAvailability: this.codexAvailability,
      codexReadiness: this.codexReadiness,
      codexUpdate: this.codexUpdateCheck,
      runtimeReadiness: this.buildRuntimeReadinessReport(this.getActiveProject()),
      diagnostics: this.diagnostics.slice(0, 200).map((entry) => compactText(entry, 1_000))
    };
    return this.capRendererStatePayload(state, "getRendererState");
  }

  getState(): WorkbenchState {
    return {
      settings: this.settings,
      github: this.githubStatus,
      projects: [...this.projects.values()].map<LoadedProjectView>((project) => ({
        record: project.record,
        tree: project.tree,
        validationStatus: project.record.validation.lastValidatedAt ? "exact" : "unvalidated",
        candidates: project.candidates
      })),
      activeProjectId: this.activeProjectId,
      availableModels: this.availableModels,
      codexAvailability: this.codexAvailability,
      codexReadiness: this.codexReadiness,
      codexUpdate: this.codexUpdateCheck,
      runtimeReadiness: this.buildRuntimeReadinessReport(this.getActiveProject()),
      diagnostics: [...this.diagnostics]
    };
  }

  async initialize(options: AppServiceInitializeOptions = {}): Promise<void> {
    const existingService = AppService.activeServicesByAppDataDir.get(this.appDataDir);
    if (existingService && existingService !== this) {
      await existingService.dispose();
    }
    AppService.activeServicesByAppDataDir.set(this.appDataDir, this);
    this.disposed = false;
    await this.storage.ensureBaseDirs();
    const persistedSettings = await this.storage.loadSettings();
    if (persistedSettings) {
      this.settings = {
        ...this.settings,
        ...persistedSettings
      };
    }
    this.codexReadiness = {
      ...this.codexReadiness,
      executionMode: this.settings.executionMode,
      distroName: this.settings.distroName,
      codexBinaryPath: this.settings.codexBinaryPath
    };
    this.safeMode = Boolean(
      options.safeMode ||
      process.env.AWB_SAFE_MODE === "1" ||
      process.argv.includes("--safe-mode")
    );

    if (this.safeMode) {
      this.codexAvailability = {
        source: "unavailable",
        message: "Safe mode is active. Saved projects, Codex detection, bootstrap, resume, and workflow automation were skipped."
      };
      this.codexReadiness = {
        checkedAt: nowIso(),
        executionMode: this.settings.executionMode,
        distroName: this.settings.distroName,
        codexBinaryPath: this.settings.codexBinaryPath,
        updateAvailable: false,
        status: "skipped",
        message: "Safe mode is active. Codex readiness checks were skipped."
      };
      this.diagnostics.unshift("Safe mode startup active. Saved projects and workflow automation were not loaded.");
      return;
    }

    if (options.deferStartupWork) {
      this.codexAvailability = {
        source: "unavailable",
        message: "Codex app-server will start when an agent-backed action runs."
      };
      return;
    }

    await this.runStartupWork({ emitState: false });
  }

  async runDeferredStartupWork(): Promise<void> {
    if (this.deferredStartupWork) {
      return this.deferredStartupWork;
    }
    this.deferredStartupWork = this.runStartupWork({ emitState: true })
      .catch((error) => {
        this.diagnostics.unshift(`Startup background initialization failed. ${error instanceof Error ? error.message : String(error)}`);
        this.emitState();
      })
      .finally(() => {
        this.deferredStartupWork = undefined;
      });
    return this.deferredStartupWork;
  }

  private async runStartupWork(options: { emitState: boolean }): Promise<void> {
    if (this.safeMode) {
      return;
    }
    await this.refreshGitHubStatus(false);
    if (this.settings.mockMode) {
      await this.initializeTransport();
    } else {
      await this.updateCodexCliOnStartup();
      this.codexAvailability = {
        source: "unavailable",
        message: "Codex app-server will start when an agent-backed action runs."
      };
    }

    await this.loadStoredProjects();
    await this.refreshRuntimeReadiness("startup runtime readiness check");
    if (options.emitState) {
      this.emitState();
    }
  }

  private async loadStoredProjects(): Promise<void> {
    const records = await this.storage.loadAllProjects();
    const loadIssues = this.storage.consumeLoadIssues();
    const quarantinedIssues = loadIssues.filter((issue) => issue.action === "quarantined");
    if (quarantinedIssues.length > 0) {
      this.diagnostics.unshift(
        `${quarantinedIssues.length} saved project state file${quarantinedIssues.length === 1 ? "" : "s"} could not be loaded and ${quarantinedIssues.length === 1 ? "was" : "were"} quarantined. The app started with the remaining safe state; run npm run repair:state for a detailed repair report.`
      );
    }
    for (const issue of loadIssues) {
      const destination = issue.quarantinePath ? ` -> ${issue.quarantinePath}` : "";
      this.diagnostics.unshift(`Saved state ${issue.action}: ${issue.statePath}${destination}. ${issue.message}`);
    }
    for (const storedRecord of records) {
      const record = this.normalizeStoredProjectRecord(storedRecord);
      this.registeredProjectIds.add(record.id);
      const tree = record.stats ? [] : [];
      const summaryCache = new SummaryCache(record.summaryCache);
      const project: LoadedProject = {
        record,
        tree,
        scan: {
          kind: record.validation.projectKind,
          tree: [],
          files: [],
          stats:
            record.stats ??
            ({
              projectRoot: record.projectRoot,
              kind: record.validation.projectKind,
              totalFiles: 0,
              totalFolders: 0,
              totalSizeBytes: 0,
              includedFiles: 0,
              includedFolders: 0,
              includedSizeBytes: 0,
              excludedFiles: 0,
              excludedFolders: 0,
              excludedSizeBytes: 0,
              excludedPaths: [],
              fileTypeBreakdown: {},
              languageBreakdown: {},
              entryPoints: [],
              manifestFiles: [],
              testsPresent: false,
              primaryManagers: [],
              explanation: "Project metadata will be refreshed after the project is reopened."
            } as RepoScanResult["stats"]),
          dependencies: record.dependencies,
          manifestHash: record.validation.manifestHash ?? "",
          treeHash: record.validation.treeHash ?? ""
        },
        gitMetadata: {
          isGit: record.validation.projectKind === "git",
          normalizedRemotes: record.identity.normalizedRemotes,
          branch: record.validation.branch,
          head: record.validation.gitHead,
          rootCommit: record.identity.rootCommit,
          gitRoot: record.identity.gitRoot
        },
        summaryCache,
        candidates: []
      };
      this.projects.set(record.id, project);
    }
  }

  private async updateCodexCliOnStartup(): Promise<void> {
    if (this.settings.mockMode) {
      return;
    }

    const result = await this.checkCodexUpdate();
    if (result.updateAvailable) {
      this.diagnostics.unshift(`${result.message} Workbench will ask before running ${result.updateCommand ?? "the update command"}.`);
      return;
    }
    if (result.status === "unavailable") {
      this.diagnostics.unshift(`${result.message} Continuing with the installed Codex CLI.`);
    }
  }

  async dispose(options?: { flush?: boolean }): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise;
    }
    this.disposePromise = this.disposeInternal(options);
    return this.disposePromise;
  }

  private async disposeInternal(options?: { flush?: boolean }): Promise<void> {
    this.disposed = true;
    if (AppService.activeServicesByAppDataDir.get(this.appDataDir) === this) {
      AppService.activeServicesByAppDataDir.delete(this.appDataDir);
    }
    this.threadToAgent.clear();
    this.interfaceCreationRepairAttempts.clear();
    this.workflowRecoveryInFlight.clear();
    this.workflowAutomationQueued.clear();
    for (const scheduled of this.workflowAutomationTimers.values()) {
      clearTimeout(scheduled.timer);
    }
    this.workflowAutomationTimers.clear();
    this.structuredOutputApplicationsInFlight.clear();
    this.projectSaveQueued.clear();
    this.projectSaveQueuedOptions.clear();
    if (this.pendingStateEmitTimer) {
      clearTimeout(this.pendingStateEmitTimer);
      this.pendingStateEmitTimer = undefined;
    }
    if (options?.flush === false) {
      for (const scheduled of this.pendingProjectSaveTimers.values()) {
        clearTimeout(scheduled.timer);
      }
      this.pendingProjectSaveTimers.clear();
    } else {
      await this.flushScheduledProjectSaves(true);
      for (const project of this.projects.values()) {
        await this.saveProject(project, { force: true });
      }
    }
    if (!this.transport) {
      return;
    }

    const transport = this.transport;
    this.transport = undefined;
    try {
      this.suppressTransportExitHandling = true;
      await transport.dispose();
    } catch (error) {
      this.diagnostics.unshift(`Failed to dispose Codex app-server cleanly. ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.suppressTransportExitHandling = false;
    }
  }

  private async initializeTransport(): Promise<void> {
    if (this.transport && this.codexAvailability.source !== "unavailable") {
      return;
    }
    if (this.transportInitialization) {
      await this.transportInitialization;
      return;
    }

    this.transportInitialization = this.initializeTransportNow();
    try {
      await this.transportInitialization;
    } finally {
      this.transportInitialization = undefined;
    }
  }

  private async initializeTransportNow(): Promise<void> {
    if (this.settings.mockMode) {
      this.transport = new MockCodexTransport();
      this.attachTransportListeners(this.transport);
      await this.transport.initialize();
      this.availableModels = buildDiscoveredModels((await this.transport.listModels()).data);
      if (this.availableModels.length === 0) {
        const transport = this.transport;
        this.transport = undefined;
        this.suppressTransportExitHandling = true;
        try {
          await transport.dispose();
        } catch {
          // The zero-model readiness failure is reported below; dispose failures do not change the operator fix.
        } finally {
          this.suppressTransportExitHandling = false;
        }
        this.codexAvailability = {
          source: "unavailable",
          message: "Mock transport started, but model discovery returned no available models."
        };
        return;
      }
      this.codexAvailability = { source: "mock", message: "Mock mode is enabled, so interface creation uses mock model metadata and outputs." };
      return;
    }

    try {
      const installedCodexVersion = await readInstalledCodexCliVersion(this.settings);
      const compatibility = assessCodexProtocolCompatibility(installedCodexVersion);
      if (!compatibility.compatible) {
        this.codexAvailability = {
          source: "unavailable",
          message: compatibility.message,
          installedCodexVersion: compatibility.installedVersion,
          generatedProtocolVersion: compatibility.generatedProtocolVersion,
          protocolCompatibility: compatibility.status
        };
        this.availableModels = [];
        this.diagnostics.unshift(compatibility.message);
        return;
      }

      const launchPlan = await CodexAppServerTransport.resolveLaunchPlan(this.settings);
      this.transport = new CodexAppServerTransport(this.settings, launchPlan);
      this.attachTransportListeners(this.transport);
      await this.transport.initialize();
      this.availableModels = buildDiscoveredModels((await this.transport.listModels()).data);
      if (this.availableModels.length === 0) {
        const transport = this.transport;
        this.transport = undefined;
        this.suppressTransportExitHandling = true;
        try {
          await transport.dispose();
        } catch {
          // The zero-model readiness failure is reported below; dispose failures do not change the operator fix.
        } finally {
          this.suppressTransportExitHandling = false;
        }
        this.codexAvailability = {
          source: "unavailable",
          message: "Codex app-server started, but model discovery returned no available models.",
          installedCodexVersion: compatibility.installedVersion,
          generatedProtocolVersion: compatibility.generatedProtocolVersion,
          protocolCompatibility: compatibility.status
        };
        return;
      }
      this.codexAvailability = {
        source: "live",
        installedCodexVersion: compatibility.installedVersion,
        generatedProtocolVersion: compatibility.generatedProtocolVersion,
        protocolCompatibility: compatibility.status
      };
    } catch (error) {
      this.transport = undefined;
      this.availableModels = [];
      this.codexAvailability = {
        source: "unavailable",
        message: error instanceof Error ? error.message : String(error)
      };
      this.diagnostics.unshift(
        `Codex transport unavailable. Agent-backed interface creation is disabled until Codex app-server and model discovery are reachable. ${this.codexAvailability.message}`
      );
    }
  }

  private attachTransportListeners(transport: CodexTransport): void {
    transport.on("notification", (notification) => this.handleTransportNotification(notification));
    transport.on("request", (request) => this.handleTransportRequest(request));
    transport.on("exit", () => {
      void this.handleTransportExit(transport);
    });
  }

  private async handleTransportExit(transport: CodexTransport): Promise<void> {
    if (this.suppressTransportExitHandling) {
      return;
    }

    if (this.transport === transport) {
      this.transport = undefined;
    }
    this.threadToAgent.clear();
    this.diagnostics.unshift("Codex app-server disconnected.");
    this.codexAvailability = {
      source: "unavailable",
      message: "Codex app-server disconnected."
    };

    const reason = "Codex app-server disconnected while this agent was active. Use workflow recovery to continue from the last saved decision.";
    for (const project of this.projects.values()) {
      const interruptedAgents = this.markActiveAgentsDisconnected(project, reason);
      if (interruptedAgents.length > 0) {
        this.resetWorkflowAfterInterruptedAgents(project, interruptedAgents);
        await this.saveProject(project);
      }
    }
    this.emitState();
  }

  async updateSettings(partial: Partial<AppSettings>): Promise<AppSettings> {
    const previousSettings = this.settings;
    const agentReasoningEfforts = {
      ...DEFAULT_AGENT_REASONING_EFFORTS,
      ...(this.settings.agentReasoningEfforts ?? {}),
      ...(partial.agentReasoningEfforts ?? {})
    };
    const nextSettings = {
      ...this.settings,
      ...partial,
      agentReasoningMode: partial.agentReasoningMode ?? this.settings.agentReasoningMode ?? DEFAULT_AGENT_REASONING_MODE,
      agentReasoningEfforts,
      interfaceCreationConfiguredAt:
        partial.interfaceCreationModel !== undefined ||
        partial.interfaceCreationReasoningEffort !== undefined ||
        partial.agentReasoningMode !== undefined ||
        partial.agentReasoningEfforts !== undefined
          ? partial.interfaceCreationConfiguredAt ?? this.settings.interfaceCreationConfiguredAt ?? nowIso()
          : this.settings.interfaceCreationConfiguredAt
    };
    this.settings = nextSettings;
    await this.storage.saveSettings(appSettingsSchema.parse(this.settings) as unknown as Record<string, unknown>);
    if (
      previousSettings.executionMode !== nextSettings.executionMode ||
      previousSettings.distroName !== nextSettings.distroName ||
      previousSettings.mockMode !== nextSettings.mockMode
    ) {
      await this.refreshGitHubStatus(false);
    }
    await this.restartTransportIfNeeded(previousSettings, nextSettings);
    const repairLimitChanged = previousSettings.maxRepairCycles !== nextSettings.maxRepairCycles;
    const reasoningChanged = previousSettings.interfaceCreationReasoningEffort !== nextSettings.interfaceCreationReasoningEffort;
    const agentReasoningChanged =
      (previousSettings.agentReasoningMode ?? DEFAULT_AGENT_REASONING_MODE) !== (nextSettings.agentReasoningMode ?? DEFAULT_AGENT_REASONING_MODE) ||
      JSON.stringify(previousSettings.agentReasoningEfforts ?? {}) !== JSON.stringify(nextSettings.agentReasoningEfforts ?? {});
    const modelChanged = previousSettings.interfaceCreationModel !== nextSettings.interfaceCreationModel;
    if (repairLimitChanged || reasoningChanged || agentReasoningChanged || modelChanged) {
      const interfaceConfig = this.resolveInterfaceCreationConfig();
      for (const project of this.projects.values()) {
        if (project.record.id !== this.activeProjectId) {
          continue;
        }
        const workflow = this.ensureWorkflowState(project.record);
        this.syncWorkflowSettings(workflow);
        if (project.record.interfaceCreation && project.record.interfaceCreation.status !== "running") {
          project.record.interfaceCreation.model = interfaceConfig.model;
          project.record.interfaceCreation.reasoningEffort = interfaceConfig.reasoningEffort;
          project.record.interfaceCreation.selectedModelSource = interfaceConfig.source;
        }
        const bootstrapAgent = project.record.agents.find((agent) => agent.category === "bootstrap" && !agent.threadId);
        if (bootstrapAgent) {
          bootstrapAgent.model = interfaceConfig.model ?? bootstrapAgent.model;
          bootstrapAgent.reasoningEffort = interfaceConfig.reasoningEffort;
          bootstrapAgent.reasoningEffortSource = interfaceConfig.reasoningMode;
        }
        if (repairLimitChanged && this.resumeRepairIfLimitExpanded(project, previousSettings.maxRepairCycles)) {
          await this.persistProjectUpdate(project, true);
          continue;
        }
        await this.saveProject(project);
      }
    }
    this.emitState();
    return this.settings;
  }

  private isGitHubLinked(): boolean {
    return Boolean(this.settings.githubAccount) && (this.githubStatus.state === "linked" || this.githubStatus.state === "needs_ssh");
  }

  private assertGitHubLinked(requiresSsh = false): NonNullable<AppSettings["githubAccount"]> {
    if (!this.settings.githubAccount || !this.isGitHubLinked()) {
      throw new Error(this.githubStatus.message);
    }
    if (requiresSsh && !this.githubStatus.sshReady) {
      throw new Error(this.githubStatus.message);
    }
    return this.settings.githubAccount;
  }

  private async persistSettings(): Promise<void> {
    await this.storage.saveSettings(appSettingsSchema.parse(this.settings) as unknown as Record<string, unknown>);
  }

  async refreshGitHubStatus(emit = true): Promise<GitHubStatus> {
    const nextStatus = await getGitHubStatus(
      {
        executionMode: this.settings.executionMode,
        distroName: this.settings.distroName,
        mockMode: this.settings.mockMode
      },
      this.settings.githubAccount
    );
    this.githubStatus = nextStatus;

    const isLinkedState = nextStatus.state === "linked" || nextStatus.state === "needs_ssh";
    if (isLinkedState && nextStatus.username) {
      const existing = this.settings.githubAccount;
      const nextLinkedAt = existing?.username === nextStatus.username ? existing.linkedAt : nowIso();
      if (!existing || existing.username !== nextStatus.username || existing.linkedAt !== nextLinkedAt) {
        this.settings = {
          ...this.settings,
          githubAccount: {
            username: nextStatus.username,
            linkedAt: nextLinkedAt
          }
        };
        await this.persistSettings();
      }
    } else if ((nextStatus.state === "not_linked" || nextStatus.state === "cli_missing") && this.settings.githubAccount) {
      this.settings = {
        ...this.settings,
        githubAccount: undefined
      };
      await this.persistSettings();
    }

    if (emit) {
      this.emitState();
    }
    return nextStatus;
  }

  private quoteForPosixShell(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
  }

  private async verifyProjectWriteAccess(
    projectRoot: string,
    projectHostPath: string,
    runtimeSettings: Pick<AppSettings, "executionMode" | "distroName">
  ): Promise<ProjectAccessProbe> {
    const checkedAt = nowIso();
    const probeFileName = `.awb-write-probe-${nanoid(8).toLowerCase()}.txt`;
    const executionPath = (projectRoot.includes("\\") ? path.win32 : path.posix).join(projectRoot, probeFileName);
    const hostPath = await assertProjectRelativeHostPath(projectHostPath, probeFileName, "Project write verification");
    const message = `Able to write to ${projectHostPath} using ${probeFileName}.`;
    const executor = new RuntimeCommandExecutor(runtimeSettings);
    const cleanupHostProbe = async (): Promise<void> => {
      await unlink(hostPath).catch(() => undefined);
    };
    const fail = async (error: string): Promise<ProjectAccessProbe> => {
      await cleanupHostProbe();
      return {
        status: "failed",
        checkedAt,
        probeFileName,
        executionPath,
        hostPath,
        message: `Write access verification failed for ${projectHostPath} using ${probeFileName}.`,
        error
      };
    };

    try {
      const executionMode = resolveExecutionMode(runtimeSettings, process.platform);
      if (executionMode === "wsl" || process.platform !== "win32") {
        const writeResult = await executor.runShellCommand({
          command: `printf '%s\\n' ${this.quoteForPosixShell(message)} > ${this.quoteForPosixShell(probeFileName)}`,
          cwd: projectRoot
        });
        if (writeResult.exitCode !== 0) {
          return await fail(writeResult.stderr.trim() || "The execution environment could not create the probe file.");
        }
      } else {
        await writeFile(hostPath, `${message}\n`, "utf8");
      }

      const observedContent = await readFile(hostPath, "utf8").catch(async (error) =>
        await Promise.reject(new Error(`The probe file was not visible from the host path. ${error instanceof Error ? error.message : String(error)}`))
      );
      if (!observedContent.includes(message)) {
        return await fail("The probe file was created, but its contents did not match the expected verification message.");
      }

      if (executionMode === "wsl" || process.platform !== "win32") {
        const deleteResult = await executor.runShellCommand({
          command: `rm -f ${this.quoteForPosixShell(probeFileName)}`,
          cwd: projectRoot
        });
        if (deleteResult.exitCode !== 0) {
          return await fail(deleteResult.stderr.trim() || "The execution environment could not remove the probe file.");
        }
      } else {
        await unlink(hostPath);
      }

      try {
        await access(hostPath);
        return await fail("The probe file still existed after the cleanup step.");
      } catch {
        return {
          status: "passed",
          checkedAt,
          probeFileName,
          executionPath,
          hostPath,
          message
        };
      }
    } catch (error) {
      return await fail(error instanceof Error ? error.message : String(error));
    }
  }

  private buildValidationSnapshot(scan: RepoScanResult, gitMetadata: GitMetadata, projectAccess?: ProjectAccessProbe) {
    return {
      interfaceSchemaVersion: 1,
      appMinVersion: APP_VERSION,
      lastValidatedAt: nowIso(),
      gitHead: gitMetadata.head,
      branch: gitMetadata.branch,
      manifestHash: scan.manifestHash,
      treeHash: scan.treeHash,
      projectAccess,
      projectKind: scan.kind
    } as const;
  }

  private getEffectiveRepositoryScanSettings(
    project: Pick<LoadedProject, "record">,
    mode: "normal" | "deep" = "normal",
    settings?: RepositoryScanSettings
  ): Required<RepositoryScanSettings> {
    if (mode === "normal") {
      return normalizeRepositoryScanSettings(undefined, REPOSITORY_DEFAULT_SCAN_SETTINGS);
    }
    return normalizeRepositoryScanSettings(settings ?? project.record.repositoryScanSettings, REPOSITORY_DEEP_SCAN_SETTINGS);
  }

  private buildRepositoryScanLimitsResponse(projectId: string, settings: RepositoryScanSettings): RepositoryScanLimitsResponse {
    return {
      projectId,
      defaults: REPOSITORY_DEFAULT_SCAN_SETTINGS,
      deepDefaults: REPOSITORY_DEEP_SCAN_SETTINGS,
      hardMaximums: REPOSITORY_HARD_SCAN_SETTINGS,
      settings,
      effective: normalizeRepositoryScanSettings(settings, REPOSITORY_DEEP_SCAN_SETTINGS)
    };
  }

  private annotateRepositoryScan(scan: RepoScanResult, mode: "normal" | "deep"): RepoScanResult {
    scan.stats.scanMode = mode;
    return scan;
  }

  private repositorySearchScope(stats?: ProjectStats): RepositorySearchResponse["searchScope"] {
    return stats?.scanMode === "deep" ? "full_deep_index" : "indexed_files";
  }

  private repositoryScanRecoverySteps(errorMessage: string): string[] {
    const steps = [
      "Verify the repository folder still exists and is readable from the configured runtime.",
      "Run Rescan Repository after closing tools that may be locking files.",
      "Use Deep Scan only after the normal scan succeeds if the repository is very large."
    ];
    if (/\b(EACCES|EPERM|permission|access)\b/i.test(errorMessage)) {
      steps.unshift("Check file permissions for the repository and excluded cache/build directories.");
    }
    if (/\b(ENOENT|not found|no such file)\b/i.test(errorMessage)) {
      steps.unshift("Confirm the saved project path still points at the repository checkout.");
    }
    return steps;
  }

  private limitValueForTruncationReason(
    stats: ProjectStats,
    reason: NonNullable<ProjectStats["truncationReasons"]>[number]
  ): number | undefined {
    switch (reason) {
      case "included_file_limit":
        return stats.includedFileLimit;
      case "included_directory_limit":
        return stats.includedDirectoryLimit;
      case "depth_limit":
        return stats.maxDepth;
      case "scan_duration_limit":
        return stats.maxScanDurationMs;
      case "manifest_file_size":
        return stats.maxManifestFileSizeBytes;
      case "excluded_path_record_limit":
        return stats.excludedPathLimit;
    }
  }

  private repositoryTruncationReasonLabel(reason: NonNullable<ProjectStats["truncationReasons"]>[number]): string {
    switch (reason) {
      case "included_file_limit":
        return "Included file limit";
      case "included_directory_limit":
        return "Included folder limit";
      case "depth_limit":
        return "Maximum depth";
      case "scan_duration_limit":
        return "Scan duration";
      case "manifest_file_size":
        return "Manifest file size";
      case "excluded_path_record_limit":
        return "Excluded-path record limit";
    }
  }

  private async scanCurrentProject(project: Pick<LoadedProject, "record">): Promise<{
    projectRoot: string;
    projectHostPath: string;
    gitMetadata: GitMetadata;
    scan: RepoScanResult;
    identity: LocalProjectRecord["identity"];
    validation: LocalProjectRecord["validation"];
  }> {
    this.assertResolvedPathCompatible(project.record.distroName);
    const runtimeSettings = this.getRuntimeSettings(project.record.distroName);
    const gitMetadata = await readGitMetadata(project.record.projectRoot, runtimeSettings);
    const projectRoot = gitMetadata.gitRoot ?? project.record.projectRoot;
    const projectHostPath = gitMetadata.gitRoot
      ? executionPathToHostPath(gitMetadata.gitRoot, runtimeSettings, project.record.distroName)
      : project.record.hostPath;
    const scan = this.annotateRepositoryScan(await scanRepository(projectHostPath, gitMetadata, projectRoot), "normal");
    const projectAccess = await this.verifyProjectWriteAccess(projectRoot, projectHostPath, runtimeSettings);
    const identity = createProjectIdentity({
      kind: scan.kind,
      projectRoot,
      projectName: path.basename(projectRoot),
      repositoryName: path.basename(gitMetadata.gitRoot ?? projectRoot),
      gitRoot: gitMetadata.gitRoot,
      normalizedRemotes: gitMetadata.normalizedRemotes,
      rootCommit: gitMetadata.rootCommit,
      manifestSignature: scan.manifestHash,
      treeSignature: scan.treeHash
    });

    return {
      projectRoot,
      projectHostPath,
      gitMetadata,
      scan,
      identity,
      validation: this.buildValidationSnapshot(scan, gitMetadata, projectAccess)
    };
  }

  private applyScannedProjectState(
    project: LoadedProject,
    scannedProject: Awaited<ReturnType<AppService["scanCurrentProject"]>>
  ): void {
    project.record.projectRoot = scannedProject.projectRoot;
    project.record.hostPath = scannedProject.projectHostPath;
    project.record.identity = scannedProject.identity;
    project.record.validation = scannedProject.validation;
    project.record.stats = scannedProject.scan.stats;
    project.record.dependencies = scannedProject.scan.dependencies;
    project.scan = scannedProject.scan;
    project.tree = scannedProject.scan.tree;
    project.gitMetadata = scannedProject.gitMetadata;
  }

  private repositoryIndexHostPath(project: LoadedProject): string {
    return project.record.hostPath || project.record.projectRoot;
  }

  private repositoryIndexAbsoluteFilePath(project: LoadedProject, relativePath: string): string {
    return path.join(this.repositoryIndexHostPath(project), ...relativePath.split("/"));
  }

  private async saveRepositoryIndex(project: LoadedProject): Promise<void> {
    if (project.scan.files.length === 0) {
      return;
    }
    await this.storage.saveRepositoryIndex({
      projectId: project.record.id,
      projectRoot: project.record.projectRoot,
      treeHash: project.scan.treeHash,
      scanMode: project.scan.stats.scanMode,
      files: project.scan.files.map((file) => ({
        relativePath: file.relativePath,
        size: file.size,
        language: file.language
      }))
    });
  }

  private async hydrateRepositoryIndex(projectId: string): Promise<void> {
    const project = this.findProject(projectId);
    if (project.scan.files.length > 0) {
      return;
    }

    const index = await this.storage.loadRepositoryIndex(projectId);
    if (index?.files.length) {
      const files: ScannedFile[] = index.files.map((file) => ({
        absolutePath: this.repositoryIndexAbsoluteFilePath(project, file.relativePath),
        relativePath: file.relativePath,
        size: file.size,
        language: file.language
      }));
      project.scan = {
        ...project.scan,
        files,
        treeHash: index.treeHash ?? project.scan.treeHash,
        stats: {
          ...project.scan.stats,
          scanMode: index.scanMode ?? project.scan.stats.scanMode
        }
      };
      return;
    }

    if ((project.record.stats?.includedFiles ?? 0) > 0) {
      await this.rescanRepository(projectId, {
        mode: project.record.stats?.scanMode === "deep" ? "deep" : "normal"
      });
    }
  }

  private async ensureRepositoryIndexLoaded(projectId: string): Promise<void> {
    const project = this.findProject(projectId);
    if (project.scan.files.length > 0) {
      return;
    }
    const existingLoad = this.repositoryIndexLoadOperations.get(projectId);
    if (existingLoad) {
      await existingLoad;
      return;
    }

    const load = this.hydrateRepositoryIndex(projectId)
      .catch((error) => {
        this.repositoryScanFailures.set(projectId, {
          failedAt: nowIso(),
          message: error instanceof Error ? error.message : String(error),
          recoverySteps: this.repositoryScanRecoverySteps(error instanceof Error ? error.message : String(error))
        });
        throw error;
      })
      .finally(() => {
        if (this.repositoryIndexLoadOperations.get(projectId) === load) {
          this.repositoryIndexLoadOperations.delete(projectId);
        }
      });
    this.repositoryIndexLoadOperations.set(projectId, load);
    await load;
  }

  private normalizeRepositoryRelativePath(input: string): string {
    const trimmed = input.trim().replace(/\\/g, "/");
    if (!trimmed) {
      return "";
    }
    const normalized = path.posix.normalize(trimmed);
    if (normalized === ".") {
      return "";
    }
    if (path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
      throw new Error("Repository path must stay inside the project.");
    }
    return normalized;
  }

  private repositoryPageOffset(cursor?: string): number {
    if (!cursor) {
      return 0;
    }
    const offset = Number.parseInt(cursor, 10);
    return Number.isFinite(offset) && offset > 0 ? offset : 0;
  }

  private capRepositoryLimit(limit: number | undefined, fallback: number, max: number): number {
    return Math.max(1, Math.min(max, Math.floor(limit ?? fallback)));
  }

  private sortRepositoryEntries(entries: RepositoryTreeEntry[]): RepositoryTreeEntry[] {
    return entries.sort((left, right) =>
      left.type === right.type ? left.name.localeCompare(right.name) : left.type === "directory" ? -1 : 1
    );
  }

  private logRepositoryPayload(apiName: string, payload: unknown, details: string): void {
    if (!this.debugWorkflowPerf) {
      return;
    }
    let payloadSize = 0;
    try {
      payloadSize = JSON.stringify(payload).length;
    } catch {
      payloadSize = -1;
    }
    const warning = payloadSize > REPOSITORY_PAYLOAD_WARNING_BYTES ? " WARNING payload exceeds repository threshold" : "";
    this.logWorkflowPerf(`repo ${apiName}: payload ${payloadSize} bytes, ${details}${warning}`);
  }

  getRepositoryScanStatus(projectId: string): RepositoryScanStatus {
    const project = this.findProject(projectId);
    const stats = project.record.stats;
    const operation = this.repositoryScanOperations.get(projectId);
    const failure = this.repositoryScanFailures.get(projectId);
    const skippedReasons = [
      stats?.excludedFiles || stats?.excludedFolders
        ? {
          reason: "Excluded by scanner rules",
          count: (stats.excludedFiles ?? 0) + (stats.excludedFolders ?? 0),
          detail: "Built-in excludes and project .gitignore rules."
        }
        : undefined,
      stats?.skippedManifestFiles
        ? {
          reason: "Oversized manifest skipped",
          count: stats.skippedManifestFiles,
          detail: `Manifest size limit ${formatBytesForStatus(stats.maxManifestFileSizeBytes ?? DEFAULT_REPOSITORY_SCAN_LIMITS.maxManifestFileSizeBytes)}.`
        }
        : undefined,
      stats?.omittedFilesEstimate || stats?.omittedDirectoriesEstimate
        ? {
          reason: stats.truncationReason ?? "Scan limit reached",
          count: (stats.omittedFilesEstimate ?? 0) + (stats.omittedDirectoriesEstimate ?? 0),
          detail: "Use Deep Scan to raise limits for this project."
        }
        : undefined
    ].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    const truncated = Boolean(stats?.truncated);
    const hasExclusions = Boolean((stats?.excludedFiles ?? 0) + (stats?.excludedFolders ?? 0) + (stats?.skippedManifestFiles ?? 0));
    const truncationReasons = stats?.truncationReasons ?? [];
    const limitHits = truncationReasons.map((reason) => ({
      code: reason,
      label: this.repositoryTruncationReasonLabel(reason),
      limit: stats ? this.limitValueForTruncationReason(stats, reason) : undefined,
      omittedFilesEstimate: stats?.omittedFilesEstimate,
      omittedDirectoriesEstimate: stats?.omittedDirectoriesEstimate
    }));
    const status: RepositoryScanStatus["status"] = operation
      ? "scanning"
      : failure
        ? "failed"
        : !stats
          ? "not_scanned"
          : truncated
            ? "truncated"
            : hasExclusions || project.scan.files.length < (stats.includedFiles ?? 0)
              ? "partially_indexed"
              : "indexed";
    return {
      projectId,
      status,
      lastScanAt: stats ? stats.scanCompletedAt ?? project.record.validation.lastValidatedAt ?? project.record.overview?.generatedAt ?? project.record.localState.lastOpenedAt : undefined,
      scanStartedAt: operation?.startedAt ?? stats?.scanStartedAt,
      scanDurationMs: stats?.scanDurationMs,
      lastError: failure?.message,
      recoverySteps: failure?.recoverySteps ?? [],
      filesIndexed: stats?.includedFiles ?? project.scan.files.length,
      foldersIndexed: stats?.includedFolders ?? 0,
      filesTotal: stats?.totalFiles ?? project.scan.files.length,
      foldersTotal: stats?.totalFolders ?? 0,
      includedFiles: stats?.includedFiles ?? project.scan.files.length,
      includedFolders: stats?.includedFolders ?? 0,
      excludedFiles: stats?.excludedFiles ?? 0,
      excludedFolders: stats?.excludedFolders ?? 0,
      indexedSizeBytes: stats?.includedSizeBytes ?? 0,
      excludedSizeBytes: stats?.excludedSizeBytes,
      skippedCount: skippedReasons.reduce((sum, entry) => sum + entry.count, 0),
      skippedReasons,
      truncated,
      truncationReason: stats?.truncationReason,
      truncationReasons,
      limitHits,
      limits: {
        includedFileLimit: stats?.includedFileLimit,
        includedDirectoryLimit: stats?.includedDirectoryLimit,
        maxDepth: stats?.maxDepth,
        maxScanDurationMs: stats?.maxScanDurationMs,
        maxManifestFileSizeBytes: stats?.maxManifestFileSizeBytes,
        excludedPathLimit: stats?.excludedPathLimit
      },
      searchScope: this.repositorySearchScope(stats),
      excludedPaths: stats?.excludedPaths ?? [],
      deepScanAvailable: true
    };
  }

  getRepositoryScanLimits(projectId: string): RepositoryScanLimitsResponse {
    const project = this.findProject(projectId);
    return this.buildRepositoryScanLimitsResponse(projectId, project.record.repositoryScanSettings ?? {});
  }

  async updateRepositoryScanSettings(projectId: string, settings: RepositoryScanSettings): Promise<RepositoryScanLimitsResponse> {
    const project = this.findProject(projectId);
    project.record.repositoryScanSettings = toStoredRepositoryScanSettings(settings);
    await this.saveProject(project);
    this.emitState();
    return this.buildRepositoryScanLimitsResponse(projectId, project.record.repositoryScanSettings);
  }

  listExcludedPaths(
    projectId: string,
    options: { cursor?: string; limit?: number } = {}
  ): RepositoryExcludedPathsResponse {
    const project = this.findProject(projectId);
    const stats = project.record.stats;
    const limit = this.capRepositoryLimit(options.limit, REPOSITORY_CHILDREN_DEFAULT_LIMIT, REPOSITORY_CHILDREN_MAX_LIMIT);
    const offset = this.repositoryPageOffset(options.cursor);
    const paths = (stats?.excludedPaths ?? []).slice(offset, offset + limit);
    const response: RepositoryExcludedPathsResponse = {
      projectId,
      total: stats?.excludedPaths.length ?? 0,
      paths,
      truncated: offset + limit < (stats?.excludedPaths.length ?? 0) || Boolean(stats?.excludedPathRecordsTruncated),
      excludedFiles: stats?.excludedFiles ?? 0,
      excludedFolders: stats?.excludedFolders ?? 0,
      excludedSizeBytes: stats?.excludedSizeBytes
    };
    this.logRepositoryPayload("listExcludedPaths", response, `returned=${paths.length}, total=${response.total}`);
    return response;
  }

  async rescanRepository(projectId: string, options: RepositoryRescanOptions = {}): Promise<ProjectRepositorySummary> {
    const existing = this.findProject(projectId);
    const mode = options.mode === "deep" ? "deep" : "normal";
    const effectiveSettings = this.getEffectiveRepositoryScanSettings(existing, mode, options.settings);
    this.repositoryScanFailures.delete(projectId);
    this.repositoryScanOperations.set(projectId, {
      startedAt: nowIso(),
      mode,
      settings: effectiveSettings
    });
    this.emitState();
    const runtimeSettings = this.getRuntimeSettings(existing.record.distroName);
    try {
      const gitMetadata = await readGitMetadata(existing.record.projectRoot, runtimeSettings);
      const projectRoot = gitMetadata.gitRoot ?? existing.record.projectRoot;
      const projectHostPath = gitMetadata.gitRoot
        ? executionPathToHostPath(gitMetadata.gitRoot, runtimeSettings, existing.record.distroName)
        : existing.record.hostPath ?? existing.record.projectRoot;
      const scan = this.annotateRepositoryScan(
        await scanRepository(
          projectHostPath,
          gitMetadata,
          projectRoot,
          mode === "deep" ? effectiveSettings : undefined,
          { ignoreMode: mode === "deep" ? "none" : "standard" }
        ),
        mode
      );
      const projectAccess = await this.verifyProjectWriteAccess(projectRoot, projectHostPath, runtimeSettings);
      existing.scan = scan;
      existing.tree = scan.tree;
      existing.gitMetadata = gitMetadata;
      existing.record.projectRoot = projectRoot;
      existing.record.hostPath = projectHostPath;
      existing.record.identity = createProjectIdentity({
        kind: scan.kind,
        projectRoot,
        projectName: path.basename(projectRoot),
        repositoryName: path.basename(gitMetadata.gitRoot ?? projectRoot),
        gitRoot: gitMetadata.gitRoot,
        normalizedRemotes: gitMetadata.normalizedRemotes,
        rootCommit: gitMetadata.rootCommit,
        manifestSignature: scan.manifestHash,
        treeSignature: scan.treeHash
      });
      existing.record.validation = this.buildValidationSnapshot(scan, gitMetadata, projectAccess);
      existing.record.stats = scan.stats;
      existing.record.dependencies = scan.dependencies;
      if (mode === "deep") {
        existing.record.repositoryScanSettings = toStoredRepositoryScanSettings(effectiveSettings);
      }
      existing.record.overview = buildDeterministicOverview({
        projectName: existing.record.identity.projectName,
        explanation: hasMeaningfulRepositoryContent(scan)
          ? scan.stats.explanation
          : "This project folder is effectively empty and ready for initial setup.",
        entryPoints: scan.stats.entryPoints,
        manifestFiles: scan.stats.manifestFiles,
        primaryManagers: scan.stats.primaryManagers
      });
      this.repositoryScanFailures.delete(projectId);
      await this.saveRepositoryIndex(existing);
      await this.saveProject(existing);
      return this.buildRepositorySummary(projectId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.repositoryScanFailures.set(projectId, {
        failedAt: nowIso(),
        message,
        recoverySteps: this.repositoryScanRecoverySteps(message)
      });
      throw error;
    } finally {
      this.repositoryScanOperations.delete(projectId);
      this.emitState();
    }
  }

  getRepositoryView(projectId: string): ProjectRepositoryView {
    const project = this.findProject(projectId);
    const tree = compactRepoTreePreview(project.tree);
    const view: ProjectRepositoryView = {
      projectId,
      tree,
      dependencies: project.record.dependencies.slice(0, RENDERER_REPOSITORY_DEPENDENCY_LIMIT),
      summaryCache: project.record.summaryCache.slice(0, RENDERER_REPOSITORY_SUMMARY_CACHE_LIMIT),
      treeTruncated: isRepoTreePreviewTruncated(project.tree) || Boolean(project.record.stats?.truncated),
      dependencyTotal: project.record.dependencies.length,
      summaryCacheTotal: project.record.summaryCache.length
    };
    this.logRepositoryPayload("getRepositoryView", view, `treeNodes=${countRepoTreeNodes(tree)}`);
    return view;
  }

  private buildRepositorySummary(projectId: string): ProjectRepositorySummary {
    const project = this.findProject(projectId);
    const rootChildren = this.buildRepositoryChildren(projectId, "", { limit: REPOSITORY_CHILDREN_DEFAULT_LIMIT });
    const summary: ProjectRepositorySummary = {
      projectId,
      stats: project.record.stats,
      dependencies: project.record.dependencies.slice(0, RENDERER_REPOSITORY_DEPENDENCY_LIMIT),
      dependencyTotal: project.record.dependencies.length,
      summaryCache: project.record.summaryCache.slice(0, RENDERER_REPOSITORY_SUMMARY_CACHE_LIMIT),
      summaryCacheTotal: project.record.summaryCache.length,
      rootChildren,
      scanTruncated: project.record.stats?.truncated,
      scanTruncationReason: project.record.stats?.truncationReason
    };
    this.logRepositoryPayload(
      "getRepositorySummary",
      summary,
      `rootChildren=${rootChildren.children.length}, dependencies=${summary.dependencies.length}, summaries=${summary.summaryCache.length}`
    );
    return summary;
  }

  async getRepositorySummary(projectId: string): Promise<ProjectRepositorySummary> {
    await this.ensureRepositoryIndexLoaded(projectId);
    return this.buildRepositorySummary(projectId);
  }

  private buildRepositoryChildren(
    projectId: string,
    parentPath = "",
    options: { cursor?: string; limit?: number } = {}
  ): RepositoryChildrenResponse {
    const project = this.findProject(projectId);
    const safeParentPath = this.normalizeRepositoryRelativePath(parentPath);
    const prefix = safeParentPath ? `${safeParentPath}/` : "";
    const childEntries = new Map<string, { entry: RepositoryTreeEntry; childNames: Set<string> }>();

    for (const file of project.scan.files) {
      if (safeParentPath && !file.relativePath.startsWith(prefix)) {
        continue;
      }
      const remainder = safeParentPath ? file.relativePath.slice(prefix.length) : file.relativePath;
      if (!remainder) {
        continue;
      }
      const parts = remainder.split("/");
      const childName = parts[0];
      if (!childName) {
        continue;
      }
      const childPath = safeParentPath ? `${safeParentPath}/${childName}` : childName;
      const isDirectFile = parts.length === 1;
      let bucket = childEntries.get(childPath);
      if (!bucket) {
        bucket = {
          entry: {
            path: childPath,
            name: childName,
            type: isDirectFile ? "file" : "directory"
          },
          childNames: new Set<string>()
        };
        childEntries.set(childPath, bucket);
      }

      if (isDirectFile) {
        bucket.entry.size = file.size;
        bucket.entry.language = file.language;
        continue;
      }

      bucket.entry.type = "directory";
      bucket.entry.size = undefined;
      bucket.entry.language = undefined;
      const directChildName = parts[1];
      if (directChildName) {
        bucket.childNames.add(directChildName);
      }
    }

    const children = this.sortRepositoryEntries([...childEntries.values()].map(({ entry, childNames }) => ({
      ...entry,
      childCount: entry.type === "directory" ? childNames.size : undefined
    })));
    const limit = this.capRepositoryLimit(options.limit, REPOSITORY_CHILDREN_DEFAULT_LIMIT, REPOSITORY_CHILDREN_MAX_LIMIT);
    const offset = this.repositoryPageOffset(options.cursor);
    const page = children.slice(offset, offset + limit);
    const response: RepositoryChildrenResponse = {
      projectId,
      parentPath: safeParentPath,
      cursor: options.cursor,
      nextCursor: offset + limit < children.length ? String(offset + limit) : undefined,
      limit,
      total: children.length,
      children: page,
      truncated: offset + limit < children.length,
      scanTruncated: project.record.stats?.truncated,
      scanTruncationReason: project.record.stats?.truncationReason
    };
    this.logRepositoryPayload(
      "listRepositoryChildren",
      response,
      `parent=${safeParentPath || "."}, returned=${page.length}, total=${children.length}`
    );
    return response;
  }

  async listRepositoryChildren(
    projectId: string,
    parentPath = "",
    options: { cursor?: string; limit?: number } = {}
  ): Promise<RepositoryChildrenResponse> {
    await this.ensureRepositoryIndexLoaded(projectId);
    return this.buildRepositoryChildren(projectId, parentPath, options);
  }

  private buildRepositorySearchResults(
    projectId: string,
    query: string,
    options: { limit?: number } = {}
  ): RepositorySearchResponse {
    const project = this.findProject(projectId);
    const normalizedQuery = query.trim().toLowerCase();
    const limit = this.capRepositoryLimit(options.limit, REPOSITORY_SEARCH_DEFAULT_LIMIT, REPOSITORY_SEARCH_MAX_LIMIT);
    const matchedFiles = normalizedQuery
      ? project.scan.files
        .filter((file) => file.relativePath.toLowerCase().includes(normalizedQuery))
        .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
      : [];
    const results: RepositoryTreeEntry[] = matchedFiles.slice(0, limit).map((file) => ({
      path: file.relativePath,
      name: path.posix.basename(file.relativePath),
      type: "file",
      size: file.size,
      language: file.language
    }));
    const response: RepositorySearchResponse = {
      projectId,
      query,
      limit,
      total: matchedFiles.length,
      results,
      truncated: matchedFiles.length > results.length,
      searchScope: this.repositorySearchScope(project.record.stats),
      resultCap: limit,
      scanTruncated: project.record.stats?.truncated,
      scanTruncationReason: project.record.stats?.truncationReason
    };
    this.logRepositoryPayload("searchRepositoryFiles", response, `query=${normalizedQuery}, returned=${results.length}, total=${matchedFiles.length}`);
    return response;
  }

  async searchRepositoryFiles(
    projectId: string,
    query: string,
    options: { limit?: number } = {}
  ): Promise<RepositorySearchResponse> {
    await this.ensureRepositoryIndexLoaded(projectId);
    return this.buildRepositorySearchResults(projectId, query, options);
  }

  private agentApprovalSummaries(agent: AgentState): string[] {
    return agent.approvals
      .slice(0, 8)
      .map((approval) => compactText(
        [
          approval.status,
          approval.summary,
          approval.reason,
          approval.command
        ].filter(Boolean).join(": "),
        260
      ));
  }

  private agentErrorSummaries(agent: AgentState): string[] {
    const lifecycleError = agent.status === "failed" || agent.status === "conflicted" || agent.status === "disconnected"
      ? `${agent.name} ended as ${agent.status.replace(/_/g, " ")}${agent.disconnectedReason ? `: ${agent.disconnectedReason}` : ""}`
      : undefined;
    return unique([
      lifecycleError,
      ...agent.events
        .filter((event) => event.status === "failed")
        .map((event) => `${event.title}${event.detail ? `: ${event.detail}` : ""}`),
      ...(agent.integrityReport?.checks
        .filter((check) => check.status === "failed")
        .map((check) => `${check.name} failed: ${check.command}`) ?? []),
      ...(agent.integrityReport?.risks ?? []),
      ...(agent.mergeReport?.conflicts.map((conflict) => `Merge conflict: ${conflict}`) ?? [])
    ].filter((entry): entry is string => Boolean(entry?.trim())))
      .slice(0, 10)
      .map((entry) => compactText(entry, 300));
  }

  private agentErrorCount(agent: AgentState): number {
    return [
      agent.status === "failed" || agent.status === "conflicted" || agent.status === "disconnected" ? 1 : 0,
      agent.events.filter((event) => event.status === "failed").length,
      agent.integrityReport?.checks.filter((check) => check.status === "failed").length ?? 0,
      agent.integrityReport?.risks.length ?? 0,
      agent.mergeReport?.conflicts.length ?? 0
    ].reduce((sum, value) => sum + value, 0);
  }

  private agentHistorySummary(agent: AgentState): AgentHistorySummary {
    const errorSummaries = this.agentErrorSummaries(agent);
    const approvalSummaries = this.agentApprovalSummaries(agent);
    const commands = agent.commandLog
      .slice(0, 6)
      .map((command) => command.command);
    const preview = agent.recommendationReport?.summary
      ?? agent.integrityReport?.summary
      ?? agent.mergeReport?.summary
      ?? agent.lastMessageSnippet
      ?? agent.currentSubtask
      ?? agent.currentPhase
      ?? "No output summary captured yet.";

    return {
      id: agent.id,
      name: agent.name,
      category: agent.category,
      status: agent.status,
      model: agent.model,
      reasoningEffort: agent.reasoningEffort,
      reasoningEffortSource: agent.reasoningEffortSource,
      taskPrompt: compactText(agent.taskPrompt, 700),
      workflowCycleNumber: agent.workflowCycleNumber,
      createdAt: agent.createdAt,
      startedAt: agent.startedAt,
      completedAt: agent.completedAt,
      lastActivityAt: agent.lastActivityAt,
      currentPhase: agent.currentPhase,
      currentSubtask: agent.currentSubtask,
      preview: compactText(preview, 1_200),
      changedFiles: agent.changedFiles.slice(0, 80),
      commandCount: agent.commandLog.length,
      commands,
      approvalCount: agent.approvals.length,
      pendingApprovalCount: agent.approvals.filter((approval) => approval.status === "pending").length,
      approvalSummaries,
      errorCount: this.agentErrorCount(agent),
      errorSummaries,
      tokenUsage: this.extractTokenUsage(agent),
      transcriptAvailable: agent.outputReference?.transcriptAvailable ?? (agent.events.length > 0 || agent.commandLog.length > 0 || agent.approvals.length > 0),
      fullOutputAvailable: agent.outputReference?.fullOutputAvailable ?? (agent.events.length > 0 || agent.commandLog.length > 0 || agent.approvals.length > 0)
    };
  }

  private extractTokenUsage(agent: AgentState): string | undefined {
    const tokenEvent = agent.events.find((event) => {
      const raw = typeof event.raw === "string" ? event.raw : event.raw ? JSON.stringify(event.raw) : "";
      return /token/i.test(`${event.title} ${event.detail ?? ""} ${raw}`);
    });
    if (!tokenEvent) {
      return undefined;
    }
    return compactText(tokenEvent.detail ?? tokenEvent.title, 160);
  }

  private cycleAgents(project: LoadedProject, cycleNumber: number): AgentState[] {
    return project.record.agents.filter((agent) => {
      if (agent.category === "manual") {
        return false;
      }
      return (agent.workflowCycleNumber ?? project.record.workflow.workflowCycle.cycleNumber) === cycleNumber;
    });
  }

  private knownWorkflowCycleNumbers(project: LoadedProject): number[] {
    const numbers = new Set<number>();
    numbers.add(project.record.workflow.workflowCycle.cycleNumber);
    for (const agent of project.record.agents) {
      if (agent.category !== "manual" && agent.workflowCycleNumber) {
        numbers.add(agent.workflowCycleNumber);
      }
    }
    for (const summary of project.record.workflow.memory.perCycleSummaries) {
      numbers.add(summary.cycleNumber);
    }
    for (const decision of project.record.workflow.memory.lastAcceptedDecisions) {
      if (decision.cycleNumber) {
        numbers.add(decision.cycleNumber);
      }
    }
    for (const decision of project.record.workflow.plannerDecisions ?? []) {
      numbers.add(decision.cycleNumber);
    }
    for (const retrospective of project.record.workflow.cycleRetrospectives ?? []) {
      numbers.add(retrospective.cycleNumber);
    }
    for (const change of project.record.workflow.checklistChanges ?? []) {
      numbers.add(change.sourceCycle);
    }
    return [...numbers].filter((value) => Number.isFinite(value) && value > 0).sort((left, right) => right - left);
  }

  private summarizeCycleStatus(project: LoadedProject, cycleNumber: number, agents: AgentState[]): WorkflowCycleStatus | "manual" {
    if (cycleNumber === project.record.workflow.workflowCycle.cycleNumber) {
      return project.record.workflow.workflowCycle.status;
    }
    if (agents.some((agent) => agent.status === "failed" || agent.status === "conflicted" || agent.status === "disconnected")) {
      return "blocked_human";
    }
    if (agents.some((agent) => isAgentActive(agent))) {
      return "coding";
    }
    return "completed";
  }

  private buildCycleHumanSummary(project: LoadedProject, cycleNumber: number, agents: AgentState[], status: WorkflowCycleStatus | "manual"): string {
    const memorySummary = project.record.workflow.memory.perCycleSummaries.find((summary) => summary.cycleNumber === cycleNumber)?.summary;
    if (memorySummary) {
      return compactText(memorySummary, 600);
    }
    const completedAgents = agents.filter((agent) => agent.status === "completed").length;
    const failedAgents = agents.filter((agent) => agent.status === "failed" || agent.status === "conflicted" || agent.status === "disconnected").length;
    const changedFiles = unique(agents.flatMap((agent) => agent.changedFiles)).length;
    const commandCount = agents.reduce((sum, agent) => sum + agent.commandLog.length, 0);
    if (agents.length === 0) {
      return status === "completed"
        ? "The cycle is recorded as complete, but no retained agent summaries are attached to it."
        : "The current cycle has not started any retained agent run yet.";
    }
    if (failedAgents > 0) {
      return `${agents.length} agent run${agents.length === 1 ? "" : "s"} participated; ${failedAgents} need review. ${changedFiles} file${changedFiles === 1 ? "" : "s"} changed and ${commandCount} command${commandCount === 1 ? "" : "s"} were recorded.`;
    }
    return `${completedAgents} of ${agents.length} agent run${agents.length === 1 ? "" : "s"} completed. The cycle touched ${changedFiles} file${changedFiles === 1 ? "" : "s"} and recorded ${commandCount} command${commandCount === 1 ? "" : "s"}.`;
  }

  private cycleChecklistTargets(project: LoadedProject, cycleNumber: number, agents: AgentState[]): string[] {
    const workflow = project.record.workflow;
    const agentIds = new Set(agents.map((agent) => agent.id));
    const targetedIds = new Set<string>();
    if (cycleNumber === workflow.workflowCycle.cycleNumber) {
      for (const checkId of workflow.scopedGoal?.targetedCheckIds ?? []) {
        targetedIds.add(checkId);
      }
      for (const checkId of workflow.approvedRecommendation?.targetedCheckIds ?? []) {
        targetedIds.add(checkId);
      }
    }
    return workflow.goalChecklist
      .filter((check) =>
        targetedIds.has(check.id) ||
        check.introducedCycleNumber === cycleNumber ||
        (check.ownerAgentId ? agentIds.has(check.ownerAgentId) : false) ||
        (check.evidenceHistory ?? []).some((entry) => entry.ownerAgentId ? agentIds.has(entry.ownerAgentId) : false)
      )
      .slice(0, 12)
      .map((check) => compactText(`${check.status.replace(/_/g, " ")}: ${check.title}`, 220));
  }

  private cycleValidationOutcome(agents: AgentState[], status: WorkflowCycleStatus | "manual"): string {
    const integrityAgent = [...agents]
      .filter((agent) => agent.integrityReport)
      .sort((left, right) => toTime(right.completedAt ?? right.lastActivityAt ?? right.createdAt) - toTime(left.completedAt ?? left.lastActivityAt ?? left.createdAt))[0];
    if (integrityAgent?.integrityReport) {
      const checks = integrityAgent.integrityReport.checks;
      const passed = checks.filter((check) => check.status === "passed").length;
      const failed = checks.filter((check) => check.status === "failed").length;
      const skipped = checks.filter((check) => check.status === "skipped").length;
      const counts = checks.length ? ` (${passed} passed, ${failed} failed, ${skipped} skipped)` : "";
      return compactText(`${integrityAgent.integrityReport.summary}${counts}`, 500);
    }
    const commands = agents.flatMap((agent) => agent.commandLog);
    const failedCommands = commands.filter((command) =>
      (typeof command.exitCode === "number" && command.exitCode !== 0) ||
      /fail|error|timed|cancel/i.test(command.status)
    );
    if (failedCommands.length > 0) {
      return compactText(`${failedCommands.length} command attempt${failedCommands.length === 1 ? "" : "s"} failed, but no validation ledger was retained. Latest: ${failedCommands[0]?.command ?? "unknown command"}.`, 500);
    }
    if (commands.length > 0) {
      return compactText(`${commands.length} command${commands.length === 1 ? "" : "s"} recorded, but no final validation ledger is attached.`, 500);
    }
    if (status === "completed" || status === "merged") {
      return "Cycle completed; no retained validation report is attached.";
    }
    if (agents.some((agent) => agent.status === "failed" || agent.status === "conflicted" || agent.status === "disconnected")) {
      return "Validation outcome needs review because at least one agent did not complete cleanly.";
    }
    return "Validation has not run for this cycle.";
  }

  private cyclePlannerDecision(project: LoadedProject, cycleNumber: number): PlannerDecision | undefined {
    return project.record.workflow.plannerDecisions
      .filter((decision) => decision.cycleNumber === cycleNumber)
      .sort((left, right) => toTime(right.createdAt) - toTime(left.createdAt))[0];
  }

  private cycleChecklistChangeRecords(project: LoadedProject, cycleNumber: number): ChecklistChange[] {
    return project.record.workflow.checklistChanges
      .filter((change) => change.sourceCycle === cycleNumber)
      .sort((left, right) => toTime(right.createdAt) - toTime(left.createdAt))
      .slice(0, 24);
  }

  private cycleGoalChangeProposalRecords(project: LoadedProject, cycleNumber: number): GoalChangeProposal[] {
    const workflow = project.record.workflow;
    const cycleDecision = this.cyclePlannerDecision(project, cycleNumber);
    const proposalIds = new Set(cycleDecision?.goalChangeProposalIds ?? []);
    return [
      ...workflow.strategicPlans
        .filter((plan) => plan.cycleNumber === cycleNumber)
        .flatMap((plan) => plan.proposedGoalChanges),
      ...workflow.goalCharter.proposedGoalChanges.filter((proposal) => proposalIds.has(proposal.id)).map((proposal) => ({
        ...proposal,
        approvalStatus: "pending" as const,
        requiredByStrategy: true,
        risk: "high" as const,
        affectedGoalArea: proposal.toGoalSummary ?? proposal.summary
      }))
    ]
      .filter((proposal, index, list) => list.findIndex((entry) => entry.id === proposal.id) === index)
      .slice(0, 12);
  }

  private cycleRetrospective(project: LoadedProject, cycleNumber: number, agents: AgentState[]): string | undefined {
    const retained = project.record.workflow.cycleRetrospectives.find((entry) => entry.cycleNumber === cycleNumber);
    if (retained) {
      return compactText([
        `Tried: ${retained.triedToDo}`,
        `Why: ${retained.whyChosen}`,
        retained.changedFiles.length ? `Changed files: ${retained.changedFiles.slice(0, 8).join(", ")}` : "",
        retained.commandsRun.length ? `Commands/tests: ${retained.commandsRun.slice(0, 6).join("; ")}` : "",
        retained.passed.length ? `Passed: ${retained.passed.slice(0, 4).join("; ")}` : "",
        retained.failed.length ? `Failed: ${retained.failed.slice(0, 4).join("; ")}` : "",
        retained.learned.length ? `Learned: ${retained.learned.slice(0, 4).join("; ")}` : "",
        retained.checklistItemsAdvanced.length ? `Checklist advanced: ${retained.checklistItemsAdvanced.slice(0, 6).join("; ")}` : "",
        retained.goalChecklistChangeRecommendation ? `Goal/checklist: ${retained.goalChecklistChangeRecommendation}` : "",
        retained.nextRecommendedTasks.length ? `Next: ${retained.nextRecommendedTasks.slice(0, 4).join("; ")}` : "",
        retained.shouldContinue ? "Autopilot recommendation: continue." : `Autopilot recommendation: pause${retained.pauseReason ? ` (${retained.pauseReason})` : ""}.`
      ].filter(Boolean).join("\n"), 1_800);
    }
    const mergeSummary = [...agents]
      .filter((agent) => agent.mergeReport?.summary)
      .sort((left, right) => toTime(right.completedAt ?? right.lastActivityAt ?? right.createdAt) - toTime(left.completedAt ?? left.lastActivityAt ?? left.createdAt))[0]
      ?.mergeReport?.summary;
    if (mergeSummary) {
      return compactText(mergeSummary, 500);
    }
    const memorySummary = project.record.workflow.memory.perCycleSummaries.find((summary) => summary.cycleNumber === cycleNumber)?.summary;
    return memorySummary ? compactText(memorySummary, 500) : undefined;
  }

  private cycleNextStepRecommendation(project: LoadedProject, cycleNumber: number, agents: AgentState[]): string | undefined {
    const workflow = project.record.workflow;
    if (cycleNumber === workflow.workflowCycle.cycleNumber) {
      const currentRecommendation = workflow.recommendations[0] ?? workflow.approvedRecommendation;
      if (currentRecommendation) {
        return compactText(`${currentRecommendation.title}: ${currentRecommendation.summary}`, 500);
      }
      if (workflow.ultimateGoalCompletion?.state === "goal_satisfied") {
        return compactText(workflow.ultimateGoalCompletion.rationale, 500);
      }
    }
    const retrospective = workflow.cycleRetrospectives.find((entry) => entry.cycleNumber === cycleNumber);
    if (retrospective?.nextRecommendedTasks[0]) {
      return compactText(retrospective.nextRecommendedTasks[0], 500);
    }
    const recommendation = [...agents]
      .filter((agent) => agent.recommendationReport?.nextSteps.length)
      .sort((left, right) => toTime(right.completedAt ?? right.lastActivityAt ?? right.createdAt) - toTime(left.completedAt ?? left.lastActivityAt ?? left.createdAt))[0]
      ?.recommendationReport?.nextSteps[0];
    if (recommendation) {
      return compactText(`${recommendation.title}: ${recommendation.summary}`, 500);
    }
    const openIssue = workflow.memory.knownOpenIssues.find((issue) => issue.status === "open");
    return openIssue ? compactText(`${openIssue.title}: ${openIssue.detail}`, 500) : undefined;
  }

  private cycleSelectedTask(project: LoadedProject, cycleNumber: number, agents: AgentState[]): { selectedTask?: string; selectionReason?: string } {
    const workflow = project.record.workflow;
    const retrospective = workflow.cycleRetrospectives.find((entry) => entry.cycleNumber === cycleNumber);
    if (retrospective?.cycleContract?.selectedTaskTitle || retrospective?.triedToDo) {
      return {
        selectedTask: compactText(retrospective.cycleContract?.selectedTaskTitle ?? retrospective.triedToDo, 500),
        selectionReason: compactText(retrospective.cycleContract?.whySelectedNow ?? retrospective.whyChosen, 900)
      };
    }
    const plannerDecision = this.cyclePlannerDecision(project, cycleNumber);
    if (plannerDecision?.selectedTaskTitle || plannerDecision?.whySelected) {
      return {
        selectedTask: plannerDecision.selectedTaskTitle ? compactText(plannerDecision.selectedTaskTitle, 500) : undefined,
        selectionReason: plannerDecision.whySelected ? compactText(plannerDecision.whySelected, 900) : undefined
      };
    }
    if (cycleNumber === workflow.workflowCycle.cycleNumber) {
      const task = workflow.scopedGoal?.summary ?? workflow.approvedRecommendation?.title;
      const reason = workflow.approvedRecommendation?.rationale;
      return {
        selectedTask: task ? compactText(task, 500) : undefined,
        selectionReason: reason ? compactText(reason, 700) : undefined
      };
    }
    const decision = workflow.memory.lastAcceptedDecisions.find((entry) => entry.cycleNumber === cycleNumber && entry.kind !== "merge")
      ?? workflow.memory.lastAcceptedDecisions.find((entry) => entry.cycleNumber === cycleNumber);
    if (decision) {
      return {
        selectedTask: compactText(decision.title, 500),
        selectionReason: compactText(decision.summary, 700)
      };
    }
    const goalAgent = agents.find((agent) => agent.category === "goal" && agent.lastMessageSnippet);
    if (goalAgent?.lastMessageSnippet) {
      return {
        selectedTask: compactText(goalAgent.lastMessageSnippet, 500),
        selectionReason: undefined
      };
    }
    return {};
  }

  private workflowCycleSummary(project: LoadedProject, cycleNumber: number): WorkflowCycleSummaryView {
    const workflow = project.record.workflow;
    const agents = this.cycleAgents(project, cycleNumber);
    const cycle = cycleNumber === workflow.workflowCycle.cycleNumber ? workflow.workflowCycle : undefined;
    const agentTimes = agents.flatMap((agent) => [agent.startedAt, agent.createdAt, agent.lastActivityAt, agent.completedAt].filter((value): value is string => Boolean(value)));
    const startedAt = cycle?.startedAt ?? agentTimes.sort((left, right) => toTime(left) - toTime(right))[0];
    const completedAt = cycle?.completedAt ?? agents
      .map((agent) => agent.completedAt)
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => toTime(right) - toTime(left))[0];
    const status = this.summarizeCycleStatus(project, cycleNumber, agents);
    const validationLedger = workflow.validationLedgers
      .filter((ledger) => ledger.cycleNumber === cycleNumber)
      .sort((left, right) => toTime(right.updatedAt) - toTime(left.updatedAt))[0];
    const repoHygieneReport = workflow.repoHygieneReports
      .filter((report) => report.scannedRef.includes(`:${cycleNumber}`))
      .sort((left, right) => toTime(right.scannedAt) - toTime(left.scannedAt))[0];
    const commandsRun = unique([
      ...agents.flatMap((agent) => agent.commandLog.map((command) => command.command)),
      ...(validationLedger?.commandResults.map((result) => result.command) ?? [])
    ]).slice(0, 16);
    const filesChanged = unique(agents.flatMap((agent) => agent.changedFiles)).slice(0, 80);
    const approvals = agents.flatMap((agent) => agent.approvals);
    const userInputRequests = project.record.userInputRequests.filter((request) =>
      agents.some((agent) => agent.id === request.agentId)
    );
    const errorSummaries = unique(agents.flatMap((agent) => this.agentErrorSummaries(agent)))
      .slice(0, 12)
      .map((entry) => compactText(entry, 300));
    const approvalSummaries = approvals
      .slice(0, 12)
      .map((approval) => compactText([approval.status, approval.summary, approval.reason, approval.command].filter(Boolean).join(": "), 260));
    const userInputRequestSummaries = userInputRequests
      .slice(0, 8)
      .map((request) => compactText([request.status, request.title, request.description].filter(Boolean).join(": "), 260));
    const selected = this.cycleSelectedTask(project, cycleNumber, agents);
    const plannerDecision = this.cyclePlannerDecision(project, cycleNumber);
    const checklistChangeRecords = this.cycleChecklistChangeRecords(project, cycleNumber);
    const goalChangeProposalRecords = this.cycleGoalChangeProposalRecords(project, cycleNumber);
    const goalPrompt = cycle?.scopedGoalSummary
      ?? cycle?.approvedRecommendationTitle
      ?? workflow.memory.lastAcceptedDecisions.find((decision) => decision.cycleNumber === cycleNumber)?.title
      ?? agents.find((agent) => agent.taskPrompt.trim())?.taskPrompt
      ?? workflow.ultimateGoal.summary
      ?? `Cycle ${cycleNumber}`;
    const durationMs = startedAt
      ? Math.max(0, (completedAt ? toTime(completedAt) : Date.now()) - toTime(startedAt))
      : undefined;

    return {
      id: String(cycleNumber),
      projectId: project.record.id,
      cycleNumber,
      goalPrompt: compactText(goalPrompt, 700),
      status,
      startedAt,
      completedAt,
      durationMs,
      modelsUsed: unique(agents.map((agent) => agent.model)).slice(0, 12),
      filesChanged,
      commandsRun,
      hasErrors: agents.some((agent) =>
        agent.status === "failed" ||
        agent.status === "conflicted" ||
        agent.status === "disconnected" ||
        agent.events.some((event) => event.status === "failed")
      ) || Boolean(validationLedger?.unresolvedValidationFailures.length) || Boolean(repoHygieneReport?.mergeBlockingFindings.length),
      hasApprovals: approvals.length > 0,
      hasUserInputRequests: userInputRequests.length > 0,
      errorSummaries,
      approvalSummaries,
      userInputRequestSummaries,
      agentCount: agents.length,
      summary: this.buildCycleHumanSummary(project, cycleNumber, agents, status),
      selectedTask: selected.selectedTask,
      selectionReason: selected.selectionReason,
      strategySettingsUsed: plannerDecision?.strategySettingsUsed.slice(0, 12) ?? [],
      checklistTargets: this.cycleChecklistTargets(project, cycleNumber, agents),
      checklistChanges: checklistChangeRecords.map((change) =>
        compactText(`${change.action.replace(/_/g, " ")}: ${change.title ?? change.affectedGoalArea}${change.userApprovalStatus !== "not_required" ? ` (${change.userApprovalStatus})` : ""}`, 260)
      ),
      goalChangeProposals: goalChangeProposalRecords.map((proposal) =>
        compactText(`${proposal.approvalStatus}: ${proposal.title}: ${proposal.summary || proposal.toGoalSummary || ""}`, 260)
      ),
      validationOutcome: validationLedger?.summaryForHumans ?? this.cycleValidationOutcome(agents, status),
      validationLedger,
      repoHygieneReport,
      derivedStatus: cycleNumber === workflow.workflowCycle.cycleNumber
        ? deriveUserFacingWorkflowStatus(workflow, {
          agents,
          validationLedger,
          repoHygieneReport,
          workflowPauseRequested: project.record.localState.workflowPauseRequested
        })
        : undefined,
      retrospective: this.cycleRetrospective(project, cycleNumber, agents),
      nextStepRecommendation: this.cycleNextStepRecommendation(project, cycleNumber, agents)
    };
  }

  listWorkflowCycles(projectId: string, options: { cursor?: string; limit?: number } = {}): WorkflowCycleListResponse {
    const project = this.findProject(projectId);
    const cycleNumbers = this.knownWorkflowCycleNumbers(project);
    const offset = this.repositoryPageOffset(options.cursor);
    const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 20)));
    const page = cycleNumbers.slice(offset, offset + limit).map((cycleNumber) => this.workflowCycleSummary(project, cycleNumber));
    return {
      projectId,
      cursor: options.cursor,
      nextCursor: offset + limit < cycleNumbers.length ? String(offset + limit) : undefined,
      limit,
      total: cycleNumbers.length,
      cycles: page,
      recentPreloaded: Math.min(5, cycleNumbers.length)
    };
  }

  getWorkflowCycle(projectId: string, cycleId: string): WorkflowCycleDetail {
    const project = this.findProject(projectId);
    const cycleNumber = Number.parseInt(cycleId, 10);
    if (!Number.isFinite(cycleNumber) || cycleNumber <= 0) {
      throw new Error(`Unknown workflow cycle: ${cycleId}`);
    }
    const summary = this.workflowCycleSummary(project, cycleNumber);
    const agents = this.cycleAgents(project, cycleNumber);
    const agentIds = new Set(agents.map((agent) => agent.id));
    const plannerDecision = this.cyclePlannerDecision(project, cycleNumber);
    const retrospectiveRecord = project.record.workflow.cycleRetrospectives.find((entry) => entry.cycleNumber === cycleNumber);
    return {
      ...summary,
      activity: project.record.workflow.activityLog
        .filter((event) => event.agentId ? agentIds.has(event.agentId) : event.title.includes(`Cycle ${cycleNumber}`))
        .slice(0, 80),
      openIssues: project.record.workflow.memory.knownOpenIssues
        .filter((issue) => issue.status === "open")
        .slice(0, 24),
      decisions: project.record.workflow.memory.lastAcceptedDecisions
        .filter((decision) => decision.cycleNumber === cycleNumber)
        .slice(0, 24),
      plannerDecision,
      retrospectiveRecord,
      checklistChangeRecords: this.cycleChecklistChangeRecords(project, cycleNumber),
      goalChangeProposalRecords: this.cycleGoalChangeProposalRecords(project, cycleNumber)
    };
  }

  listCycleAgents(projectId: string, cycleId: string): CycleAgentListResponse {
    const project = this.findProject(projectId);
    const cycleNumber = Number.parseInt(cycleId, 10);
    if (!Number.isFinite(cycleNumber) || cycleNumber <= 0) {
      throw new Error(`Unknown workflow cycle: ${cycleId}`);
    }
    const agents = this.sortAgentsForHistory(this.cycleAgents(project, cycleNumber));
    return {
      projectId,
      cycleId,
      cycleNumber,
      total: agents.length,
      agents: agents.map((agent) => this.agentHistorySummary(agent))
    };
  }

  private fallbackTranscriptEntries(projectId: string, agent: AgentState): AgentTranscriptEntry[] {
    const commandEntries: AgentTranscriptEntry[] = agent.commandLog.map((command, index) => ({
      id: `${agent.id}:command:${command.itemId ?? index}`,
      timestamp: command.completedAt ?? command.startedAt,
      kind: "command",
      itemId: command.itemId,
      title: command.command,
      text: command.output,
      metadata: {
        status: command.status,
        exitCode: command.exitCode ?? null,
        cwd: command.cwd ?? null
      }
    }));
    const approvalEntries: AgentTranscriptEntry[] = agent.approvals.map((approval) => ({
      id: `${agent.id}:approval:${approval.id}`,
      timestamp: approval.createdAt,
      kind: "approval",
      itemId: approval.itemId,
      title: "Approval requested",
      text: [approval.summary, approval.reason, approval.command].filter(Boolean).join("\n\n"),
      metadata: {
        status: approval.status,
        kind: approval.kind
      }
    }));
    const eventEntries: AgentTranscriptEntry[] = agent.events.map((event) => ({
      id: `${agent.id}:event:${event.id}`,
      timestamp: event.timestamp,
      kind: event.type === "message" ? "message" : event.type === "raw" ? "raw" : "event",
      itemId: event.itemId,
      title: event.title,
      text: event.detail,
      raw: event.raw,
      metadata: {
        status: event.status ?? null,
        type: event.type,
        projectId
      }
    }));
    return [...eventEntries, ...commandEntries, ...approvalEntries]
      .filter((entry) => entry.text?.trim() || entry.raw !== undefined || entry.title.trim())
      .sort((left, right) => toTime(left.timestamp) - toTime(right.timestamp));
  }

  async getAgentTranscript(projectId: string, agentId: string): Promise<AgentTranscriptResponse> {
    const project = this.findProject(projectId);
    const agent = project.record.agents.find((entry) => entry.id === agentId);
    if (!agent) {
      throw new Error(`Unknown agent: ${agentId}`);
    }
    const sidecar = await this.storage.readAgentTranscript(projectId, agentId);
    const entries = sidecar ?? this.fallbackTranscriptEntries(projectId, agent);
    return {
      projectId,
      agentId,
      agentName: agent.name,
      generatedAt: nowIso(),
      entries,
      fromSidecar: Boolean(sidecar)
    };
  }

  async getAgentFullOutput(projectId: string, agentId: string): Promise<AgentFullOutputResponse> {
    const project = this.findProject(projectId);
    const agent = project.record.agents.find((entry) => entry.id === agentId);
    if (!agent) {
      throw new Error(`Unknown agent: ${agentId}`);
    }
    const storedOutput = await this.storage.getAgentFullOutput(projectId, agentId);
    if (storedOutput !== null) {
      return {
        projectId,
        agentId,
        agentName: agent.name,
        generatedAt: nowIso(),
        output: storedOutput,
        fromSidecar: true
      };
    }
    const transcript = await this.getAgentTranscript(projectId, agentId);
    const output = transcript.entries
      .map((entry) => {
        const heading = `[${entry.timestamp}] ${entry.kind.toUpperCase()} - ${entry.title}`;
        const body = entry.text?.trim()
          ? entry.text
          : entry.raw !== undefined
            ? JSON.stringify(entry.raw, null, 2)
            : "";
        return body ? `${heading}\n${body}` : heading;
      })
      .join("\n\n");
    return {
      projectId,
      agentId,
      agentName: transcript.agentName,
      generatedAt: transcript.generatedAt,
      output,
      fromSidecar: transcript.fromSidecar
    };
  }

  listAgents(
    projectId: string,
    scope: AgentHistoryScope = "all",
    offset = 0,
    limit = 20
  ): AgentListResponse {
    const project = this.findProject(projectId);
    const scopedAgents = project.record.agents.filter((agent) => {
      if (scope === "manual") {
        return agent.category === "manual";
      }
      if (scope === "workflow") {
        return agent.category !== "manual";
      }
      return true;
    });
    const sortedAgents = this.sortAgentsForHistory(scopedAgents);
    const safeOffset = Math.max(0, offset);
    const safeLimit = Math.max(1, Math.min(100, limit));

    return {
      projectId,
      scope,
      offset: safeOffset,
      limit: safeLimit,
      total: sortedAgents.length,
      agents: sortedAgents.slice(safeOffset, safeOffset + safeLimit).map((agent) => this.compactRendererAgent(agent))
    };
  }

  getAgent(projectId: string, agentId: string): AgentState {
    const project = this.findProject(projectId);
    const agent = project.record.agents.find((entry) => entry.id === agentId);
    if (!agent) {
      throw new Error(`Unknown agent: ${agentId}`);
    }
    return this.compactRendererAgent(agent, { detail: true });
  }

  getProjectLogFeed(
    projectId: string,
    options: {
      activityOffset?: number;
      activityLimit?: number;
      commandOffset?: number;
      commandLimit?: number;
    } = {}
  ): ProjectLogFeedResponse {
    const project = this.findProject(projectId);
    const activityOffset = Math.max(0, options.activityOffset ?? 0);
    const activityLimit = Math.max(1, Math.min(200, options.activityLimit ?? 80));
    const commandOffset = Math.max(0, options.commandOffset ?? 0);
    const commandLimit = Math.max(1, Math.min(120, options.commandLimit ?? 50));

    const activityEntries = [...project.record.workflow.activityLog]
      .sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime())
      .map((event) => ({
        ...event,
        detail: event.detail ? compactText(event.detail, MAX_WORKFLOW_ACTIVITY_DETAIL_LENGTH) : event.detail
      }));

    const commandEntries = project.record.agents.flatMap((agent) =>
      agent.commandLog.map((command, index) => ({
        id: `${agent.id}:${command.itemId ?? command.startedAt}:${index}`,
        agentId: agent.id,
        agentName: agent.name,
        agentCategory: agent.category,
        itemId: command.itemId,
        command: command.command.length > RENDERER_COMMAND_TEXT_LIMIT
          ? `${command.command.slice(0, RENDERER_COMMAND_TEXT_LIMIT).trimEnd()}...[truncated ${command.command.length - RENDERER_COMMAND_TEXT_LIMIT} chars]`
          : command.command,
        cwd: command.cwd,
        status: command.status,
        startedAt: command.startedAt,
        completedAt: command.completedAt,
        exitCode: command.exitCode
      }))
    ).sort((left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime());

    return {
      projectId,
      activity: {
        offset: activityOffset,
        limit: activityLimit,
        total: activityEntries.length,
        entries: activityEntries.slice(activityOffset, activityOffset + activityLimit)
      },
      commands: {
        offset: commandOffset,
        limit: commandLimit,
        total: commandEntries.length,
        entries: commandEntries.slice(commandOffset, commandOffset + commandLimit)
      }
    };
  }

  async loadProject(
    inputPath: string,
    intent: ProjectLoadIntent = "open",
    creationMode: ProjectCreationMode = "initialize_github"
  ): Promise<ProjectLoadResult> {
    const resolvedPath = resolveProjectPath(inputPath, this.settings);
    this.assertResolvedPathCompatible(resolvedPath.distroName);
    const runtimeSettings = this.getRuntimeSettings(resolvedPath.distroName);
    let gitMetadata = await readGitMetadata(resolvedPath.wslPath, runtimeSettings);

    const hasGitHubRemote = gitMetadata.normalizedRemotes.some(isGitHubRemote);
    const shouldInitializeGitHub = intent === "create" && creationMode === "initialize_github";
    const shouldUseFolderAsIs = intent === "create" && creationMode === "use_folder_as_is";
    if (!hasGitHubRemote && shouldInitializeGitHub) {
      const linkedAccount = this.assertGitHubLinked(true);
      await ensureGitHubRepositoryForCreation(
        resolvedPath.wslPath,
        linkedAccount,
        {
          ...runtimeSettings,
          mockMode: this.settings.mockMode
        }
      );
      gitMetadata = await readGitMetadata(resolvedPath.wslPath, runtimeSettings);
      if (!gitMetadata.normalizedRemotes.some(isGitHubRemote)) {
        throw new Error("The selected folder could not be prepared as a GitHub-backed repository.");
      }
    } else if (!hasGitHubRemote && !shouldUseFolderAsIs) {
      this.assertGitHubLinked();
      throw new Error("This platform only opens GitHub-backed repositories. Use Create New Workspace to initialize a folder as a GitHub SSH repository.");
    } else if (intent === "open" || creationMode === "initialize_github") {
      this.assertGitHubLinked();
    }

    const projectRoot = gitMetadata.gitRoot ?? resolvedPath.wslPath;
    const projectHostPath = gitMetadata.gitRoot
      ? executionPathToHostPath(gitMetadata.gitRoot, runtimeSettings, resolvedPath.distroName)
      : resolvedPath.hostPath;
    const scan = this.annotateRepositoryScan(await scanRepository(projectHostPath, gitMetadata, projectRoot), "normal");
    const projectAccess = await this.verifyProjectWriteAccess(projectRoot, projectHostPath, runtimeSettings);
    const identity = createProjectIdentity({
      kind: scan.kind,
      projectRoot,
      projectName: path.basename(projectRoot),
      repositoryName: path.basename(gitMetadata.gitRoot ?? projectRoot),
      gitRoot: gitMetadata.gitRoot,
      normalizedRemotes: gitMetadata.normalizedRemotes,
      rootCommit: gitMetadata.rootCommit,
      manifestSignature: scan.manifestHash,
      treeSignature: scan.treeHash
    });
    const validation = this.buildValidationSnapshot(scan, gitMetadata, projectAccess);

    const candidates = await this.findInterfaceCandidates(projectRoot, projectHostPath, identity, validation);
    const overview = buildDeterministicOverview({
      projectName: identity.projectName,
      explanation: hasMeaningfulRepositoryContent(scan)
        ? scan.stats.explanation
        : "This project folder is effectively empty and ready for initial setup.",
      entryPoints: scan.stats.entryPoints,
      manifestFiles: scan.stats.manifestFiles,
      primaryManagers: scan.stats.primaryManagers
    });

    const result: ProjectLoadResult = {
      resolvedPath,
      projectRoot,
      projectHostPath,
      identity,
      validation,
      stats: scan.stats,
      dependencies: scan.dependencies,
      tree: scan.tree,
      overview,
      interfaceCandidates: candidates
    };

    this.pendingLoad = {
      loadResult: result,
      scan,
      gitMetadata
    };

    return {
      ...result,
      dependencies: result.dependencies.slice(0, RENDERER_REPOSITORY_DEPENDENCY_LIMIT),
      tree: compactRepoTreePreview(result.tree)
    };
  }

  showLauncher(): void {
    this.activeProjectId = undefined;
    this.emitState();
  }

  async openProject(projectId: string): Promise<LoadedProjectView> {
    const existing = this.findProject(projectId);
    const savedAsGitHubBacked = existing.record.identity.normalizedRemotes.some(isGitHubRemote);
    if (savedAsGitHubBacked) {
      this.assertGitHubLinked();
    }
    this.activeProjectId = projectId;
    existing.record.localState.lastOpenedAt = nowIso();
    this.emitState();
    this.assertResolvedPathCompatible(existing.record.distroName);
    const runtimeSettings = this.getRuntimeSettings(existing.record.distroName);
    const gitMetadata = await readGitMetadata(existing.record.projectRoot, runtimeSettings);
    if (savedAsGitHubBacked && !gitMetadata.normalizedRemotes.some(isGitHubRemote)) {
      throw new Error("This saved workspace no longer points at a GitHub-backed repository.");
    }
    const projectRoot = gitMetadata.gitRoot ?? existing.record.projectRoot;
    const projectHostPath = gitMetadata.gitRoot
      ? executionPathToHostPath(gitMetadata.gitRoot, runtimeSettings, existing.record.distroName)
      : existing.record.hostPath;
    const scan = this.annotateRepositoryScan(await scanRepository(projectHostPath, gitMetadata, projectRoot), "normal");
    const projectAccess = await this.verifyProjectWriteAccess(projectRoot, projectHostPath, runtimeSettings);
    const identity = createProjectIdentity({
      kind: scan.kind,
      projectRoot,
      projectName: path.basename(projectRoot),
      repositoryName: path.basename(gitMetadata.gitRoot ?? projectRoot),
      gitRoot: gitMetadata.gitRoot,
      normalizedRemotes: gitMetadata.normalizedRemotes,
      rootCommit: gitMetadata.rootCommit,
      manifestSignature: scan.manifestHash,
      treeSignature: scan.treeHash
    });
    const validation = this.buildValidationSnapshot(scan, gitMetadata, projectAccess);
    const updatedRecord: LocalProjectRecord = {
      ...existing.record,
      projectRoot,
      hostPath: projectHostPath,
      identity,
      validation,
      stats: scan.stats,
      dependencies: scan.dependencies,
      layout: {
        ...existing.record.layout,
        activeCenterTab: "overview"
      },
      localState: {
        ...existing.record.localState,
        lastOpenedAt: nowIso()
      }
    };
    const project: LoadedProject = {
      record: updatedRecord,
      tree: scan.tree,
      scan,
      gitMetadata,
      summaryCache: new SummaryCache(updatedRecord.summaryCache),
      candidates: await this.findInterfaceCandidates(projectRoot, projectHostPath, identity, validation)
    };

    const interfaceConfig = this.resolveInterfaceCreationConfig();
    if (this.isProjectMeaningfullyEmpty(project)) {
      this.prepareSkippedInterfaceCreation(project, interfaceConfig.model, interfaceConfig.reasoningEffort, interfaceConfig.source);
    }
    if (!this.isProjectMeaningfullyEmpty(project) && !project.record.agents.some((agent) => agent.category === "bootstrap")) {
      const bootstrapAgent = createAgentSkeleton(
        "bootstrap",
        "Interface Creation Agent",
        "Analyze the repository in read-only mode and generate the initial project interface.",
        interfaceConfig.model ?? "unavailable"
      );
      bootstrapAgent.reasoningEffort = interfaceConfig.reasoningEffort;
      bootstrapAgent.reasoningEffortSource = interfaceConfig.reasoningMode;
      project.record.agents.unshift(bootstrapAgent);
    }

    this.reconcileWorkflowResumeState(project);
    this.syncWorkflowState(project);
    this.projects.set(projectId, project);
    await this.cleanupCompletedManagedWorktrees(project);
    await this.saveRepositoryIndex(project);
    await this.saveProject(project);
    this.activeProjectId = projectId;
    await this.resumeSavedAgents(project);
    this.emitState();
    this.startRuntimeReadinessCheck("project reopened");
    return this.toRendererLoadedProjectView(project);
  }

  private hasMeaningfulInterfaceContent(record: Pick<LocalProjectRecord, "overview" | "summaryCache" | "workflow">): boolean {
    const hasMeaningfulOverview = Boolean(
      record.overview &&
      (
        record.overview.summary.trim().length > 0 ||
        record.overview.whatProjectDoes?.trim().length ||
        record.overview.howItIsOrganized?.trim().length ||
        record.overview.importantToKnowFirst?.trim().length ||
        record.overview.subsystemSummaries.length > 0
      )
    );
    const hasMeaningfulSummaryCache = record.summaryCache.some(
      (entry) => entry.summary.trim().length > 0 && entry.purpose.trim().length > 0
    );
    const hasMeaningfulWorkflow = hasMeaningfulUltimateGoal(record.workflow?.ultimateGoal) || record.workflow?.recommendations.length > 0;
    return hasMeaningfulOverview || hasMeaningfulSummaryCache || hasMeaningfulWorkflow;
  }

  private isProjectMeaningfullyEmpty(project: Pick<LoadedProject, "scan">): boolean {
    return !hasMeaningfulRepositoryContent(project.scan);
  }

  private buildCandidatePreview(
    sourceLabel: string,
    candidate: Pick<LocalProjectRecord, "overview" | "stats" | "summaryCache" | "agents" | "localState" | "identity" | "validation" | "dependencies">
  ): InterfaceCandidate["preview"] {
    return {
      projectName: candidate.identity.projectName,
      summarySnippet: candidate.overview?.summary ?? candidate.stats?.explanation ?? `${sourceLabel} interface`,
      agentPanelCount: candidate.agents.length,
      repoTreeReady: Boolean(candidate.stats),
      overviewReady: Boolean(candidate.overview),
      versionSummary: candidate.validation.gitHead ?? candidate.validation.treeHash ?? "Unvalidated",
      lastOpenedAt: candidate.localState.lastOpenedAt,
      validationStatus: candidate.validation.lastValidatedAt ? "exact" : "unvalidated",
      subsystemCount: candidate.overview?.subsystemSummaries.length ?? 0,
      pathSummaryCount: candidate.summaryCache.length,
      dependencyCount: candidate.dependencies.length,
      contentSource: candidate.overview?.source ?? "deterministic"
    };
  }

  private resolveInterfaceCreationModel(): { model?: string; source: "user" | "recommended" } {
    if (this.settings.interfaceCreationModel && this.availableModels.some((entry) => entry.model === this.settings.interfaceCreationModel)) {
      return {
        model: this.settings.interfaceCreationModel,
        source: "user"
      };
    }

    return {
      model: getRecommendedInterfaceCreationModel(this.availableModels)?.model,
      source: "recommended"
    };
  }

  private resolveReasoningEffortForModel(model?: string): "low" | "medium" | "high" | "xhigh" | undefined {
    const modelRecord = this.availableModels.find((entry) => entry.model === model);
    return resolveInterfaceCreationReasoningEffort(modelRecord, this.settings.interfaceCreationReasoningEffort);
  }

  private resolveAgentReasoningEffortForTask(
    category: AgentCategory,
    model: string | undefined,
    taskPrompt: string,
    mode = this.settings.agentReasoningMode ?? DEFAULT_AGENT_REASONING_MODE,
    manualEffort?: InterfaceReasoningEffort
  ): { effort: InterfaceReasoningEffort; source: AgentReasoningMode } {
    const modelRecord = this.availableModels.find((entry) => entry.model === model);
    const resolvedMode = mode ?? DEFAULT_AGENT_REASONING_MODE;
    const configuredManualEffort =
      manualEffort ??
      this.settings.agentReasoningEfforts?.[category] ??
      (category === "bootstrap" ? this.settings.interfaceCreationReasoningEffort : undefined) ??
      DEFAULT_AGENT_REASONING_EFFORTS[category];
    return {
      effort: resolveAgentReasoningEffort(modelRecord, category, taskPrompt, resolvedMode, configuredManualEffort),
      source: resolvedMode
    };
  }

  private resolveInterfaceCreationConfig(): {
    model?: string;
    reasoningEffort?: InterfaceReasoningEffort;
    reasoningMode: AgentReasoningMode;
    source: "user" | "recommended";
  } {
    const selectedModel = this.resolveInterfaceCreationModel();
    const modelRecord = this.availableModels.find((entry) => entry.model === selectedModel.model);
    const reasoningConfig = this.resolveAgentReasoningEffortForTask(
      "bootstrap",
      selectedModel.model,
      "Create a repository interface with architecture, important paths, and onboarding context."
    );
    return {
      ...selectedModel,
      reasoningMode: reasoningConfig.source,
      reasoningEffort: modelRecord
        ? reasoningConfig.effort
        : resolveInterfaceCreationReasoningEffort(modelRecord, this.settings.interfaceCreationReasoningEffort)
    };
  }

  private getDefaultAgentModel(): string {
    return this.resolveInterfaceCreationConfig().model ?? this.availableModels[0]?.model ?? "gpt-5.4-mini";
  }

  private prepareSkippedInterfaceCreation(
    project: LoadedProject,
    model?: string,
    reasoningEffort?: "low" | "medium" | "high" | "xhigh",
    selectedModelSource: "user" | "recommended" = "recommended"
  ): void {
    project.record.overview = buildDeterministicOverview({
      projectName: project.record.identity.projectName,
      explanation: this.isProjectMeaningfullyEmpty(project)
        ? "This project folder is effectively empty and ready for initial setup."
        : project.scan.stats.explanation,
      entryPoints: project.scan.stats.entryPoints,
      manifestFiles: project.scan.stats.manifestFiles,
      primaryManagers: project.scan.stats.primaryManagers
    });
    project.record.interfaceCreation = createSkippedInterfaceCreationState(
      model,
      reasoningEffort,
      selectedModelSource
    );
  }

  private resumeRepairIfLimitExpanded(project: LoadedProject, previousMaxRepairCycles: number): boolean {
    const workflow = this.ensureWorkflowState(project.record);
    if (
      this.settings.maxRepairCycles <= previousMaxRepairCycles ||
      workflow.repair.status !== "exhausted" ||
      workflow.repair.attemptCount >= workflow.repair.maxAttempts ||
      (
        workflow.workflowStopReason !== "repair_budget_exhausted" &&
        workflow.workflowStopReason !== "integrity_failed" &&
        workflow.manualHandoff?.reason !== "repair_exhausted"
      ) ||
      this.isNonRetryableRepairFailureReason(workflow.manualHandoff?.latestFailureReason ?? workflow.repair.latestFailureReason)
    ) {
      return false;
    }

    const nextAttemptCount = Math.min(workflow.repair.maxAttempts, workflow.repair.attemptCount + 1);
    this.updateWorkflowRepairState(workflow, {
      attemptCount: nextAttemptCount,
      status: "repairing"
    });
    workflow.manualHandoff = undefined;
    this.recordWorkflowActivity(workflow, {
      source: "workflow",
      status: "waiting",
      title: "Automatic repair resumed",
      detail: `The repair limit increased to ${workflow.repair.maxAttempts}, so repair attempt ${workflow.repair.attemptCount} is now queued.`,
      stepId: "coding"
    });
    this.updateWorkflowStepProgress(workflow, "integrity", {
      currentActivity: "Validation found issues",
      latestProgressNote: workflow.repair.latestFailureReason ?? "Deterministic validation failed.",
      warning: `Automatic repair limit increased to ${workflow.repair.maxAttempts}.`
    }, { status: "failed" });
    this.resetWorkflowStepProgress(workflow, "coding", {
      status: "waiting",
      requiresUserInput: false,
      currentActivity: "Queued for repair",
      currentSubstep: `Repair attempt ${workflow.repair.attemptCount} of ${workflow.repair.maxAttempts}`,
      message: "Preparing another coding pass to address integrity findings.",
      warning: undefined
    });
    return true;
  }

  private rankCandidate(candidate: InterfaceCandidate): number {
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
  }

  private getPreferredExistingCandidate(candidates: InterfaceCandidate[]): InterfaceCandidate | undefined {
    return [...candidates].sort((left, right) => this.rankCandidate(left) - this.rankCandidate(right))[0];
  }

  private getPreferredLocalCandidate(candidates: InterfaceCandidate[]): InterfaceCandidate | undefined {
    return this.getPreferredExistingCandidate(candidates.filter((candidate) => candidate.source === "local"));
  }

  private async findInterfaceCandidates(
    projectRoot: string,
    projectHostPath: string,
    identity: ProjectLoadResult["identity"],
    validation: ProjectLoadResult["validation"]
  ): Promise<InterfaceCandidate[]> {
    const candidates: InterfaceCandidate[] = [];

    const localProjects = [...this.projects.values()]
      .map((project) => project.record)
      .filter((entry) => entry.identity.fingerprint === identity.fingerprint && this.hasMeaningfulInterfaceContent(entry));
    for (const project of localProjects) {
      const status = calculateValidationStatus(identity, project.identity, validation, project.validation);
      candidates.push({
        source: "local",
        label: "Local registry",
        path: project.projectRoot,
        validationStatus: status,
        preview: { ...this.buildCandidatePreview("Saved project", project), validationStatus: status },
        data: project
      });
    }

    const portableInterfacePath = path.join(projectHostPath, PORTABLE_INTERFACE_PATH);
    const portable = await this.storage.readPortableInterface(portableInterfacePath);
    if (portable && this.hasMeaningfulInterfaceContent(portable)) {
      const status = calculateValidationStatus(identity, portable.identity, validation, portable.validation);
      candidates.push({
        source: "portable",
        label: "Portable interface",
        path: portableInterfacePath,
        validationStatus: status,
        preview: {
          ...this.buildCandidatePreview("Portable project", {
            ...portable,
            localState: portable.localStateDefaults
          }),
          validationStatus: status
        },
        data: portable
      });
    }

    return candidates;
  }

  async selectPendingInterface(
    source: "portable" | "local" | "fresh",
    candidatePath?: string,
    freshBehavior?: "replace" | "duplicate"
  ): Promise<LoadedProjectView> {
    if (!this.pendingLoad) {
      throw new Error("No project is pending selection.");
    }

    const { loadResult, scan, gitMetadata } = this.pendingLoad;
    this.pendingLoad = undefined;
    const selectedConfig = this.resolveInterfaceCreationConfig();
    const existingCandidates = loadResult.interfaceCandidates;
    let loadedRepairMaxAttempts: number | undefined;
    let projectId = nanoid();
    let record = createLocalProjectRecord(
      projectId,
      loadResult.resolvedPath.displayPath,
      loadResult.resolvedPath.wslPath,
      loadResult.projectRoot,
      loadResult.projectHostPath,
      loadResult.identity,
      loadResult.validation,
      loadResult.resolvedPath.distroName
    );

    record.stats = loadResult.stats;
    record.dependencies = loadResult.dependencies;

    if (source !== "fresh") {
      const candidate = loadResult.interfaceCandidates.find((entry) => entry.source === source && (!candidatePath || entry.path === candidatePath));
      if (!candidate) {
        throw new Error(`Could not find ${source} interface candidate.`);
      }

      if (candidate.source === "local") {
        const local = candidate.data as LocalProjectRecord;
        projectId = local.id;
        loadedRepairMaxAttempts = local.workflow?.repair?.maxAttempts;
        record = {
          ...local,
          id: local.id,
          displayPath: loadResult.resolvedPath.displayPath,
          wslPath: loadResult.resolvedPath.wslPath,
          projectRoot: loadResult.projectRoot,
          hostPath: loadResult.projectHostPath,
          distroName: loadResult.resolvedPath.distroName,
          identity: loadResult.identity,
          validation: loadResult.validation,
          stats: loadResult.stats,
          dependencies: loadResult.dependencies,
          localState: {
            ...local.localState,
            lastOpenedAt: nowIso()
          }
        };
      } else {
        const portable = portableInterfaceSchema.parse(candidate.data);
        loadedRepairMaxAttempts = portable.workflow?.repair?.maxAttempts;
        record.layout = portable.layout;
        record.localState = {
          ...portable.localStateDefaults,
          lastOpenedAt: nowIso()
        };
        record.summaryCache = portable.summaryCache;
        record.agents = portable.agents;
        record.overview = portable.overview;
      }
    } else {
      if (existingCandidates.length > 0 && !freshBehavior) {
        throw new Error("An interface already exists for this project. Choose whether to use it, replace it, or create a duplicate.");
      }

      const replaceTarget = freshBehavior === "replace" ? this.getPreferredLocalCandidate(existingCandidates) : undefined;
      if (replaceTarget?.source === "local") {
        const local = replaceTarget.data as LocalProjectRecord;
        projectId = local.id;
        record = createLocalProjectRecord(
          local.id,
          loadResult.resolvedPath.displayPath,
          loadResult.resolvedPath.wslPath,
          loadResult.projectRoot,
          loadResult.projectHostPath,
          loadResult.identity,
          loadResult.validation,
          loadResult.resolvedPath.distroName
        );
        record.layout = local.layout;
        record.localState = {
          ...local.localState,
          selectedFile: undefined,
          activeAgentId: undefined,
          treeFilter: local.localState.treeFilter ?? "",
          lastOpenedAt: nowIso()
        };
        record.interfacePath = local.interfacePath;
      } else {
        record.localState.lastOpenedAt = nowIso();
      }

      record.stats = loadResult.stats;
      record.dependencies = loadResult.dependencies;
      record.interfaceCreation = hasMeaningfulRepositoryContent(scan)
        ? createQueuedInterfaceCreationState(
          selectedConfig.model,
          selectedConfig.reasoningEffort,
          selectedConfig.source
        )
        : createSkippedInterfaceCreationState(
          selectedConfig.model,
          selectedConfig.reasoningEffort,
          selectedConfig.source
        );
    }

    if (record.interfaceCreation) {
      record.interfaceCreation.model ??= selectedConfig.model;
      record.interfaceCreation.reasoningEffort ??= selectedConfig.reasoningEffort;
    }

    if (!record.interfaceCreation && (record.overview || record.summaryCache.length > 0)) {
      record.interfaceCreation = {
        status: "completed",
        phase: "Available",
        message: "Saved interface content was loaded for this project.",
        model: selectedConfig.model,
        reasoningEffort: selectedConfig.reasoningEffort,
        selectedModelSource: selectedConfig.source,
        deterministicScanReady: true,
        agentAnalysisReady: record.overview?.source === "codex" || record.overview?.source === "hybrid" || record.summaryCache.some((entry) => entry.source !== "deterministic"),
        outputSource: record.overview?.source ?? "deterministic",
        completedAt: nowIso()
      };
    }

    if (hasMeaningfulRepositoryContent(scan) && !record.agents.some((agent) => agent.category === "bootstrap")) {
      const bootstrapAgent = createAgentSkeleton(
        "bootstrap",
        "Interface Creation Agent",
        "Analyze the repository in read-only mode and generate the initial project interface.",
        selectedConfig.model ?? "unavailable"
      );
      bootstrapAgent.reasoningEffort = selectedConfig.reasoningEffort;
      bootstrapAgent.reasoningEffortSource = selectedConfig.reasoningMode;
      record.agents.unshift(bootstrapAgent);
    }

    record.layout = {
      ...record.layout,
      activeCenterTab: "overview"
    };

    const project: LoadedProject = {
      record,
      tree: loadResult.tree,
      scan,
      gitMetadata,
      summaryCache: new SummaryCache(record.summaryCache),
      candidates: loadResult.interfaceCandidates
    };

    if (this.isProjectMeaningfullyEmpty(project)) {
      this.prepareSkippedInterfaceCreation(project, selectedConfig.model, selectedConfig.reasoningEffort, selectedConfig.source);
    }

    if (loadedRepairMaxAttempts !== undefined) {
      this.resumeRepairIfLimitExpanded(project, loadedRepairMaxAttempts);
    }
    this.reconcileWorkflowResumeState(project);
    this.syncWorkflowState(project);
    this.projects.set(projectId, project);
    if (source === "local") {
      await this.cleanupCompletedManagedWorktrees(project);
    }
    await this.saveRepositoryIndex(project);
    await this.saveProject(project);
    this.activeProjectId = projectId;
    if (source !== "fresh") {
      await this.resumeSavedAgents(project);
    }
    this.emitState();
    this.startRuntimeReadinessCheck("project opened");
    return this.toRendererLoadedProjectView(project);
  }

  private async saveProject(project: LoadedProject, options?: ProjectSaveOptions): Promise<void> {
    if (this.disposed && !options?.force) {
      return;
    }
    const projectId = project.record.id;
    const inFlight = this.projectSaveInFlight.get(projectId);
    if (inFlight) {
      this.projectSaveQueuedOptions.set(
        projectId,
        this.mergeProjectSaveOptions(this.projectSaveQueuedOptions.get(projectId), options)
      );
      const existingQueued = this.projectSaveQueued.get(projectId);
      if (existingQueued) {
        await existingQueued;
        return;
      }

      const queuedPromise = inFlight
        .catch(() => undefined)
        .then(async () => {
          if (this.projectSaveQueued.get(projectId) !== queuedPromise) {
            return;
          }
          const queuedOptions = this.projectSaveQueuedOptions.get(projectId);
          this.projectSaveQueued.delete(projectId);
          this.projectSaveQueuedOptions.delete(projectId);
          await this.saveProject(project, queuedOptions);
        });
      this.projectSaveQueued.set(projectId, queuedPromise);
      await queuedPromise;
      return;
    }

    const savePromise = this.writeProjectToStorage(project, options).finally(() => {
      if (this.projectSaveInFlight.get(projectId) === savePromise) {
        this.projectSaveInFlight.delete(projectId);
      }
    });
    this.projectSaveInFlight.set(projectId, savePromise);
    await savePromise;
  }

  private async writeProjectToStorage(project: LoadedProject, options?: ProjectSaveOptions): Promise<void> {
    const startedAt = performance.now();
    let payloadSize: number | undefined;
    this.compactProjectRuntimeHistory(project);
    for (const agent of project.record.agents) {
      this.recordAgentContextDescriptor(project, agent);
    }
    if (options?.syncWorkflow !== false) {
      const syncStartedAt = performance.now();
      this.syncWorkflowState(project);
      this.logWorkflowPerf(`syncWorkflowState before save ${project.record.identity.projectName}: ${Math.round(performance.now() - syncStartedAt)}ms`);
    }
    project.record.summaryCache = project.summaryCache.list();
    let serializedRecord: string | undefined;
    try {
      serializedRecord = JSON.stringify(project.record);
      payloadSize = serializedRecord.length;
    } catch {
      payloadSize = undefined;
      serializedRecord = undefined;
    }
    if (serializedRecord) {
      const fingerprint = sha256(serializedRecord);
      if (this.projectSaveFingerprints.get(project.record.id) === fingerprint) {
        this.recordWorkflowPerfCounter("project save skips", `${payloadSize} bytes`);
        this.logWorkflowPerf(`save skipped ${project.record.identity.projectName}: unchanged ${payloadSize} bytes`);
        return;
      }
    }
    await this.storage.saveProject(project.record);
    if (serializedRecord) {
      this.projectSaveFingerprints.set(project.record.id, sha256(serializedRecord));
    }
    this.recordWorkflowPerfCounter("project saves", payloadSize === undefined ? undefined : `${payloadSize} bytes`);
    this.logWorkflowPerf(`save ${project.record.identity.projectName}: ${payloadSize ?? "unknown"} bytes in ${Math.round(performance.now() - startedAt)}ms`);
    if (!this.registeredProjectIds.has(project.record.id)) {
      const registry = await this.storage.loadRegistry();
      for (const projectId of registry) {
        this.registeredProjectIds.add(projectId);
      }
      if (this.registeredProjectIds.has(project.record.id)) {
        return;
      }
      registry.push(project.record.id);
      await this.storage.saveRegistry(registry);
      this.registeredProjectIds.add(project.record.id);
    }
  }

  private compactProjectRuntimeHistory(project: LoadedProject): void {
    for (const agent of project.record.agents) {
      agent.events = agent.events.slice(0, 250).map(compactRuntimeEventRecord);
      agent.commandLog = agent.commandLog.map((entry) => ({
        ...entry,
        command: entry.command.length > 8_000
          ? `${entry.command.slice(0, 8_000).trimEnd()}...[truncated ${entry.command.length - 8_000} chars]`
          : entry.command,
        output: entry.output.length > 2_000 ? entry.output.slice(-2_000) : entry.output
      }));
    }
  }

  private findProject(projectId: string): LoadedProject {
    const project = this.projects.get(projectId);
    if (!project) {
      throw new Error(`Unknown project: ${projectId}`);
    }
    return project;
  }

  async exportInterface(projectId: string, destinationPath?: string): Promise<string> {
    const project = this.findProject(projectId);
    const resolvedDestinationPath = assertSafeArtifactDestination({
      projectRoot: project.record.hostPath,
      destinationPath: resolveArtifactDestination(
        project.record.hostPath,
        destinationPath,
        defaultPortableInterfacePath(project.record.hostPath)
      ),
      artifactKind: "portable-interface"
    });
    await assertHostPathWithinProjectRoot(project.record.hostPath, resolvedDestinationPath, "Portable interface export");
    const exportPath = await this.storage.writePortableInterface(project.record.hostPath, project.record, resolvedDestinationPath);
    project.record.interfacePath = exportPath;
    await this.persistProjectUpdate(project, {
      save: "immediate",
      emit: "coalesced",
      reason: "interface exported"
    });
    return exportPath;
  }

  async downloadInterface(projectId: string, destinationPath?: string): Promise<string> {
    const project = this.findProject(projectId);
    const outputPath = assertSafeArtifactDestination({
      projectRoot: project.record.hostPath,
      destinationPath: resolveArtifactDestination(
        project.record.hostPath,
        destinationPath,
        defaultPortableInterfacePath(project.record.hostPath)
      ),
      artifactKind: "portable-interface"
    });
    return await this.storage.writePortableInterfaceToFile(project.record, outputPath);
  }

  async downloadLogs(projectId: string, destinationPath?: string): Promise<string> {
    const project = this.findProject(projectId);
    const outputPath = assertSafeArtifactDestination({
      projectRoot: project.record.hostPath,
      destinationPath: resolveArtifactDestination(
        project.record.hostPath,
        destinationPath,
        defaultReviewLogPath(project.record.hostPath, project.record.identity.projectName)
      ),
      artifactKind: "review-log"
    });
    return await this.storage.writeReviewLogBundleToFile(project.record, this.settings, this.diagnostics, outputPath);
  }

  createVisualExportDestination(projectId: string): string {
    const project = this.findProject(projectId);
    return assertSafeArtifactDestination({
      projectRoot: project.record.hostPath,
      destinationPath: defaultVisualExportPath(project.record.hostPath, project.record.identity.projectName),
      artifactKind: "visual-export"
    });
  }

  private async importInterfaceInternal(
    projectRootPath: string,
    importPath: string,
    allowMismatch: boolean,
    enforceProjectBoundary: boolean
  ): Promise<LoadedProjectView> {
    const loadResult = await this.loadProject(projectRootPath);
    const resolvedImportPath = path.isAbsolute(importPath) ? importPath : path.join(loadResult.projectHostPath, importPath);
    const validatedImportPath = enforceProjectBoundary
      ? await assertHostPathWithinProjectRoot(loadResult.projectHostPath, resolvedImportPath, "Portable interface import")
      : resolvedImportPath;
    const portable = await this.storage.readPortableInterface(validatedImportPath);
    if (!portable) {
      throw new Error("Portable interface file is invalid.");
    }

    const status = calculateValidationStatus(loadResult.identity, portable.identity, loadResult.validation, portable.validation);
    if (status === "incompatible" && !allowMismatch) {
      throw new Error("Imported interface does not match this project.");
    }

    this.pendingLoad = {
      loadResult: {
        ...loadResult,
        interfaceCandidates: [
          ...loadResult.interfaceCandidates,
          {
            source: "portable",
            label: "Imported interface",
            path: validatedImportPath,
            preview: {
              ...this.buildCandidatePreview("Imported", {
                ...portable,
                localState: portable.localStateDefaults
              }),
              validationStatus: status
            },
            validationStatus: status,
            data: portable
          }
        ]
      },
      scan:
        this.pendingLoad?.scan ??
        this.annotateRepositoryScan(
          await scanRepository(
            loadResult.projectHostPath,
            await readGitMetadata(loadResult.projectRoot, this.getRuntimeSettings(loadResult.resolvedPath.distroName)),
            loadResult.projectRoot
          ),
          "normal"
        ),
      gitMetadata:
        this.pendingLoad?.gitMetadata ??
        (await readGitMetadata(loadResult.projectRoot, this.getRuntimeSettings(loadResult.resolvedPath.distroName)))
    };

    return await this.selectPendingInterface("portable", validatedImportPath);
  }

  async importInterface(projectRootPath: string, importPath: string, allowMismatch = false): Promise<LoadedProjectView> {
    return await this.importInterfaceInternal(projectRootPath, importPath, allowMismatch, true);
  }

  async importInterfaceFromExternalPath(projectRootPath: string, importPath: string, allowMismatch = false): Promise<LoadedProjectView> {
    return await this.importInterfaceInternal(projectRootPath, importPath, allowMismatch, false);
  }

  private resetAgentForFreshRun(agent: AgentState, queuedPhase: string): void {
    if (agent.threadId) {
      this.threadToAgent.delete(agent.threadId);
      this.interfaceCreationRepairAttempts.delete(agent.threadId);
    }

    agent.createdAt = nowIso();
    agent.startedAt = undefined;
    agent.completedAt = undefined;
    agent.threadId = undefined;
    agent.status = "idle";
    agent.currentPhase = queuedPhase;
    agent.currentSubtask = undefined;
    agent.lastActivityAt = undefined;
    agent.lastMessageSnippet = undefined;
    agent.changedFiles = [];
    agent.approvals = [];
    agent.commandLog = [];
    agent.events = [];
    agent.disconnectedReason = undefined;
    agent.recoveryHandledAt = undefined;
  }

  async refreshOverview(projectId: string): Promise<void> {
    const project = this.findProject(projectId);
    if (project.record.interfaceCreation?.status === "running") {
      throw new Error("Overview refresh is already running.");
    }

    const scannedProject = await this.scanCurrentProject(project);
    this.applyScannedProjectState(project, scannedProject);
    project.record.overview = buildDeterministicOverview({
      projectName: project.record.identity.projectName,
      explanation: this.isProjectMeaningfullyEmpty(project)
        ? "This project folder is effectively empty and ready for initial setup."
        : project.scan.stats.explanation,
      entryPoints: project.scan.stats.entryPoints,
      manifestFiles: project.scan.stats.manifestFiles,
      primaryManagers: project.scan.stats.primaryManagers
    });
    project.summaryCache = new SummaryCache();
    project.record.summaryCache = [];

    const interfaceConfig = this.resolveInterfaceCreationConfig();
    const bootstrapAgent =
      latestAgentByCategory(project.record.agents, "bootstrap") ??
      createAgentSkeleton(
        "bootstrap",
        "Interface Creation Agent",
        "Analyze the repository in read-only mode and generate the initial project interface.",
        interfaceConfig.model ?? "unavailable"
      );
    bootstrapAgent.model = interfaceConfig.model ?? bootstrapAgent.model;
    bootstrapAgent.reasoningEffort = interfaceConfig.reasoningEffort;
    bootstrapAgent.reasoningEffortSource = interfaceConfig.reasoningMode;
    this.resetAgentForFreshRun(bootstrapAgent, "Queued for repository refresh");
    if (!project.record.agents.some((agent) => agent.id === bootstrapAgent.id)) {
      project.record.agents.unshift(bootstrapAgent);
    }

    project.record.interfaceCreation = createQueuedInterfaceCreationState(
      bootstrapAgent.model,
      interfaceConfig.reasoningEffort,
      interfaceConfig.source
    );
    project.record.interfaceCreation.phase = "Queued";
    project.record.interfaceCreation.message = "Repository rescan complete. Preparing a fresh overview analysis run.";
    await this.saveRepositoryIndex(project);
    await this.saveProject(project);
    this.emitState();
    void this.runBootstrapIfNeeded(project);
  }

  async revalidateProject(projectId: string): Promise<ValidationStatus> {
    const project = this.findProject(projectId);
    const scannedProject = await this.scanCurrentProject(project);
    const status = calculateValidationStatus(
      scannedProject.identity,
      project.record.identity,
      scannedProject.validation,
      project.record.validation
    );
    this.applyScannedProjectState(project, scannedProject);
    await this.saveRepositoryIndex(project);
    await this.saveProject(project);
    this.emitState();
    return status;
  }

  private async buildRepositoryPathSummaryTarget(project: LoadedProject, relativePath: string): Promise<RepositoryPathSummaryTarget> {
    const normalizedPath = this.normalizeProjectRelativePath(relativePath);
    if (!normalizedPath) {
      throw new Error(`Invalid repository path: ${relativePath}`);
    }

    const file = project.scan.files.find((entry) => entry.relativePath === normalizedPath);
    if (file) {
      const safeFilePath = await assertProjectRelativeHostPath(project.record.hostPath, file.relativePath, "Repository path summary read");
      return {
        relativePath: file.relativePath,
        pathKind: "file",
        contentHash: sha256(await readFile(safeFilePath, "utf8"))
      };
    }

    if (project.scan.files.some((entry) => entry.relativePath.startsWith(`${normalizedPath}/`))) {
      return {
        relativePath: normalizedPath,
        pathKind: "directory",
        contentHash: getPathContentHash(project.scan, normalizedPath, "directory")
      };
    }

    throw new Error(`Unknown repository path: ${relativePath}`);
  }

  private repositoryPathFiles(project: LoadedProject, target: RepositoryPathSummaryTarget) {
    return target.pathKind === "file"
      ? project.scan.files.filter((entry) => entry.relativePath === target.relativePath)
      : project.scan.files.filter((entry) => entry.relativePath.startsWith(`${target.relativePath}/`));
  }

  private compactRepositorySnippet(value: string, maxLength: number): string {
    const normalized = value
      .replaceAll("\u0000", "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .trim();
    return normalized.length <= maxLength
      ? normalized
      : `${normalized.slice(0, Math.max(0, maxLength - 24)).trimEnd()}\n...[truncated]`;
  }

  private async readRepositoryFileSnippet(project: LoadedProject, relativePath: string, maxLength: number): Promise<string | undefined> {
    try {
      const hostPath = await assertProjectRelativeHostPath(project.record.hostPath, relativePath, "Repository path context read");
      return this.compactRepositorySnippet(await readFile(hostPath, "utf8"), maxLength);
    } catch {
      return undefined;
    }
  }

  private async buildRepositoryPathEvidence(project: LoadedProject, target: RepositoryPathSummaryTarget): Promise<string> {
    const files = this.repositoryPathFiles(project, target);
    const languageCounts = new Map<string, number>();
    for (const file of files) {
      languageCounts.set(file.language, (languageCounts.get(file.language) ?? 0) + 1);
    }
    const languageSummary = [...languageCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 8)
      .map(([language, count]) => `${language}: ${count}`)
      .join(", ");
    const entryPointSet = new Set(project.scan.stats.entryPoints);
    const sortedFiles = files
      .slice()
      .sort((left, right) =>
        Number(entryPointSet.has(right.relativePath)) - Number(entryPointSet.has(left.relativePath))
        || left.relativePath.localeCompare(right.relativePath)
      );
    const outline = sortedFiles
      .slice(0, 120)
      .map((file) => `- ${file.relativePath} (${file.language}, ${file.size} bytes)`)
      .join("\n");
    const snippetFiles = target.pathKind === "file"
      ? sortedFiles.slice(0, 1)
      : sortedFiles
        .filter((file) => file.size <= 250_000)
        .slice(0, 10);
    const snippets: string[] = [];
    let remainingSnippetBudget = target.pathKind === "file" ? 24_000 : 18_000;
    for (const file of snippetFiles) {
      if (remainingSnippetBudget <= 0) {
        break;
      }
      const snippet = await this.readRepositoryFileSnippet(project, file.relativePath, Math.min(3_600, remainingSnippetBudget));
      if (!snippet) {
        continue;
      }
      snippets.push(`--- ${file.relativePath} ---\n${snippet}`);
      remainingSnippetBudget -= snippet.length;
    }

    const cachedSummary = project.summaryCache.get(target.relativePath, target.contentHash);
    return [
      `Project: ${project.record.identity.projectName}`,
      `Repository overview: ${project.record.overview?.summary ?? project.scan.stats.explanation}`,
      `Selected ${target.pathKind}: ${target.relativePath}`,
      `Indexed files under selection: ${files.length}`,
      languageSummary ? `Languages: ${languageSummary}` : "",
      cachedSummary ? `Existing stored summary: ${cachedSummary.summary}` : "",
      outline ? `Path outline:\n${outline}${sortedFiles.length > 120 ? "\n- ...[truncated]" : ""}` : "",
      snippets.length ? `Content excerpts:\n${snippets.join("\n\n")}` : "No readable text excerpts were available from the selected path."
    ].filter((entry) => entry.trim().length > 0).join("\n\n");
  }

  private buildRepositoryPathSummaryOutputSchema(): JsonValue {
    return {
      type: "object",
      additionalProperties: false,
      required: ["title", "purpose", "summary", "keySymbols", "relatedFiles", "confidence"],
      properties: {
        title: { type: "string", maxLength: 120 },
        purpose: { type: "string", maxLength: 420 },
        summary: { type: "string", maxLength: 1_800 },
        keySymbols: { type: "array", maxItems: 12, items: { type: "string", maxLength: 120 } },
        relatedFiles: { type: "array", maxItems: 8, items: { type: "string", maxLength: 500 } },
        confidence: { type: "number", minimum: 0, maximum: 1 }
      }
    } satisfies JsonValue;
  }

  private buildRepositoryPathSummaryPrompt(project: LoadedProject, target: RepositoryPathSummaryTarget, evidence: string): string {
    return [
      "Generate a durable repository memory summary for exactly the selected file or folder.",
      "Use only the provided repository evidence. Do not invent behavior or mention files outside the selected path except in relatedFiles.",
      "Do not include raw secrets, API keys, tokens, passwords, or private credential values in any field.",
      "Return only valid JSON matching the supplied schema.",
      evidence
    ].join("\n\n");
  }

  private buildRepositoryPathQuestionPrompt(target: RepositoryPathSummaryTarget, evidence: string, question: string): string {
    return [
      `Answer the user's question about the selected ${target.pathKind}: ${target.relativePath}.`,
      "Stay scoped to this path unless the answer needs a directly related file. Cite concrete paths and symbols when useful.",
      "If the evidence is insufficient, say what is missing instead of guessing.",
      "Do not expose raw secrets, API keys, tokens, passwords, or private credential values.",
      `Question: ${question}`,
      evidence
    ].join("\n\n");
  }

  private repositoryKnownPathSet(project: LoadedProject): Set<string> {
    const known = new Set(project.scan.files.map((entry) => entry.relativePath));
    for (const file of project.scan.files) {
      const segments = file.relativePath.split("/");
      let current = "";
      for (let index = 0; index < segments.length - 1; index += 1) {
        current = current ? `${current}/${segments[index]}` : segments[index];
        known.add(current);
      }
    }
    return known;
  }

  private normalizeRepositorySummaryStrings(value: unknown, maxItems: number): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .map((entry) => compactText(entry, 160))
      .slice(0, maxItems);
  }

  private parseRepositoryPathSummaryOutput(rawText: string): Omit<FileSummary, "relativePath" | "pathKind" | "contentHash" | "source" | "generatedAt"> | undefined {
    for (const parsed of this.extractJsonObjects(rawText).reverse()) {
      const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
      const purpose = typeof parsed.purpose === "string" ? parsed.purpose.trim() : "";
      const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
      if (!title || !purpose || !summary) {
        continue;
      }
      const confidence = typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
        ? Math.min(1, Math.max(0, parsed.confidence))
        : 0.72;
      return {
        title: compactText(title, 120),
        purpose: compactText(purpose, 420),
        summary: compactText(summary, 1_800),
        keySymbols: this.normalizeRepositorySummaryStrings(parsed.keySymbols, 12),
        relatedFiles: this.normalizeRepositorySummaryStrings(parsed.relatedFiles, 8),
        confidence
      };
    }
    return undefined;
  }

  private async applyRepositoryPathSummaryOutput(project: LoadedProject, agent: AgentState, rawText: string, source: string): Promise<void> {
    const target = agent.repositorySummaryTarget;
    if (!target) {
      return;
    }
    const guard = this.beginStructuredOutputApplication(project, agent, "repository_path_summary", rawText, source);
    if (!guard) {
      return;
    }
    const parsed = this.parseRepositoryPathSummaryOutput(rawText);
    if (!parsed) {
      reduceAgentRuntimeEvent(agent, {
        kind: "raw",
        title: "Repository path summary rejected",
        detail: "The model response did not include a valid path summary JSON object.",
        raw: { source }
      });
      this.abortStructuredOutputApplication(guard);
      await this.persistProjectUpdate(project, { reason: "repository path summary rejected" });
      return;
    }

    const knownPaths = this.repositoryKnownPathSet(project);
    const relatedFiles = parsed.relatedFiles
      .map((entry) => this.normalizeProjectRelativePath(entry))
      .filter((entry): entry is string => Boolean(entry && knownPaths.has(entry)))
      .slice(0, 8);
    const summary = fileSummarySchema.parse({
      ...parsed,
      relativePath: target.relativePath,
      pathKind: target.pathKind,
      contentHash: target.contentHash,
      relatedFiles,
      source: "codex",
      generatedAt: nowIso()
    });
    project.summaryCache.upsert(summary);
    agent.currentPhase = "Repository summary saved";
    agent.lastMessageSnippet = summary.summary.slice(0, 240);
    this.finishStructuredOutputApplication(agent, guard);
    await this.persistProjectUpdate(project, { reason: "repository path summary saved" });
  }

  async summarizeRepositoryPath(
    projectId: string,
    relativePath: string,
    model: string,
    options?: {
      reasoningMode?: AgentReasoningMode;
      reasoningEffort?: InterfaceReasoningEffort;
    }
  ): Promise<AgentState> {
    await this.ensureRepositoryIndexLoaded(projectId);
    const project = this.findProject(projectId);
    const target = await this.buildRepositoryPathSummaryTarget(project, relativePath);
    const evidence = await this.buildRepositoryPathEvidence(project, target);
    const agentName = `Summarize ${target.pathKind}: ${path.posix.basename(target.relativePath)}`;
    return await this.createAgent(projectId, "manual", agentName, this.buildRepositoryPathSummaryPrompt(project, target, evidence), model || this.getDefaultAgentModel(), {
      sandbox: "read-only",
      outputSchema: this.buildRepositoryPathSummaryOutputSchema(),
      reasoningMode: options?.reasoningMode,
      effort: options?.reasoningEffort,
      initialPhase: `Summarizing ${target.pathKind}`,
      repositorySummaryTarget: target
    });
  }

  async askRepositoryPath(
    projectId: string,
    relativePath: string,
    question: string,
    model: string,
    options?: {
      reasoningMode?: AgentReasoningMode;
      reasoningEffort?: InterfaceReasoningEffort;
    }
  ): Promise<AgentState> {
    await this.ensureRepositoryIndexLoaded(projectId);
    const project = this.findProject(projectId);
    const target = await this.buildRepositoryPathSummaryTarget(project, relativePath);
    const evidence = await this.buildRepositoryPathEvidence(project, target);
    const agentName = `Ask ${target.pathKind}: ${path.posix.basename(target.relativePath)}`;
    return await this.createAgent(projectId, "manual", agentName, this.buildRepositoryPathQuestionPrompt(target, evidence, question), model || this.getDefaultAgentModel(), {
      sandbox: "read-only",
      reasoningMode: options?.reasoningMode,
      effort: options?.reasoningEffort,
      initialPhase: `Answering question about ${target.pathKind}`
    });
  }

  async getFileSummary(projectId: string, relativePath: string) {
    await this.ensureRepositoryIndexLoaded(projectId);
    const project = this.findProject(projectId);
    const target = await this.buildRepositoryPathSummaryTarget(project, relativePath);
    const cached = project.summaryCache.get(target.relativePath, target.contentHash);
    if (cached) {
      return cached;
    }

    const summary = target.pathKind === "file"
      ? fileSummarySchema.parse(await buildDeterministicFileSummary(
        project.record.hostPath,
        project.scan.files.find((entry) => entry.relativePath === target.relativePath)!,
        project.scan.files
          .filter((entry) => path.dirname(entry.relativePath) === path.dirname(target.relativePath) && entry.relativePath !== target.relativePath)
          .map((entry) => entry.relativePath)
      ))
      : fileSummarySchema.parse(buildDeterministicDirectorySummary(
        target.relativePath,
        project.scan.files,
        target.contentHash
      ));
    project.summaryCache.upsert(summary);
    await this.persistProjectUpdate(project);
    return summary;
  }

  updateLayout(projectId: string, partial: Partial<LocalProjectRecord["layout"]>): void {
    const project = this.findProject(projectId);
    const layoutPatch = {
      ...partial
    } as Partial<LocalProjectRecord["layout"]> & { projectId?: string };
    delete layoutPatch.projectId;
    project.record.layout = {
      ...project.record.layout,
      ...layoutPatch
    };
    const layoutKeys = Object.keys(layoutPatch);
    const tabOnly = layoutKeys.length === 1 && layoutKeys[0] === "activeCenterTab";
    if (!tabOnly) {
      this.scheduleProjectSave(project);
      this.emitState();
    }
  }

  private hasActiveWorkflowAgent(project: LoadedProject, categories?: AgentCategory[]): boolean {
    const categorySet = categories ? new Set<AgentCategory>(categories) : undefined;
    return project.record.agents.some((agent) =>
      categorySet
        ? categorySet.has(agent.category) && isAgentActive(agent)
        : isWorkflowAutomationBlockingAgent(agent)
    );
  }

  private prepareQueuedWorkflowPreviewForRecommendation(project: LoadedProject): boolean {
    const workflow = this.ensureWorkflowState(project.record);
    const previewRequest = getWorkflowPreviewRequest(workflow);
    if (previewRequest.status !== "queued" || this.hasActiveWorkflowAgent(project)) {
      return false;
    }

    const safeRecommendationBoundary = workflow.workflowCycle.status === "completed" || !workflow.approvedRecommendation;
    if (safeRecommendationBoundary && workflow.recommendations.length > 0) {
      workflow.recommendations = [];
      workflow.recommendationsGeneratedAt = undefined;
      this.resetWorkflowStepProgress(workflow, "recommendation", {
        status: "waiting",
        requiresUserInput: false,
        currentActivity: "Queued to generate preview recommendations",
        message: "The next recommendation set will focus on a visible/runnable preview checkpoint."
      });
      this.recordWorkflowActivity(workflow, {
        source: "workflow",
        status: "waiting",
        title: "Preview request replaced pending recommendations",
        detail: "Existing unapproved recommendations were cleared so the next safe recommendation pass can focus on preview generation.",
        stepId: "recommendation"
      });
      this.syncWorkflowState(project);
      return true;
    }

    return false;
  }

  private activateWorkflowPreviewRequest(project: LoadedProject): void {
    const workflow = this.ensureWorkflowState(project.record);
    const previewRequest = getWorkflowPreviewRequest(workflow);
    if (previewRequest.status !== "queued") {
      return;
    }

    workflow.previewRequest = {
      ...previewRequest,
      status: "active",
      startedAt: previewRequest.startedAt ?? nowIso(),
      remainingCycles: Math.max(1, previewRequest.remainingCycles ?? 1)
    };
    this.recordWorkflowActivity(workflow, {
      source: "workflow",
      status: "running",
      title: "Preview generation started",
      detail: "The next bounded cycle is steering toward a visible/runnable inspection checkpoint.",
      stepId: "recommendation"
    });
  }

  private markWorkflowPreviewReady(project: LoadedProject, completedAt = nowIso()): void {
    const workflow = this.ensureWorkflowState(project.record);
    const previewRequest = getWorkflowPreviewRequest(workflow);
    if (previewRequest.status !== "active") {
      return;
    }

    const evidence = [
      `Cycle ${workflow.workflowCycle.cycleNumber} completed after deterministic validation and integration.`,
      workflow.scopedGoal?.summary ? `Preview scoped goal: ${workflow.scopedGoal.summary}.` : undefined,
      workflow.approvedRecommendation?.relatedPaths.length
        ? `Preview paths: ${workflow.approvedRecommendation.relatedPaths.slice(0, 5).join(", ")}.`
        : undefined
    ].filter((entry): entry is string => Boolean(entry));
    workflow.previewRequest = {
      ...previewRequest,
      status: "ready",
      completedAt,
      remainingCycles: 0,
      evidence
    };
    const autopilotPolicy = resolveEffectiveAutopilotPolicy(workflow, project.record.localState.autopilotEnabled);
    if (autopilotPolicy.enabled && autopilotPolicy.pauseOnPreviewReady) {
      project.record.localState.workflowPauseRequested = true;
    }
    this.recordWorkflowActivity(workflow, {
      source: "workflow",
      status: "waiting",
      title: "Preview is ready for inspection",
      detail: evidence.join(" "),
      stepId: "merge"
    });
  }

  private completeWorkflowPreviewCheckpoint(project: LoadedProject, detail = "Preview checkpoint dismissed."): boolean {
    const workflow = this.ensureWorkflowState(project.record);
    const previewRequest = getWorkflowPreviewRequest(workflow);
    if (previewRequest.status !== "ready") {
      return false;
    }

    workflow.previewRequest = {
      ...previewRequest,
      status: "completed",
      completedAt: nowIso()
    };
    this.recordWorkflowActivity(workflow, {
      source: "workflow",
      status: "completed",
      title: "Preview checkpoint completed",
      detail,
      stepId: getWorkflowActiveStepId(workflow)
    });
    return true;
  }

  async requestWorkflowPreview(projectId: string, reason?: string, remainingCycles = 1): Promise<ProjectWorkflowState> {
    const project = this.findProject(projectId);
    const workflow = this.ensureWorkflowState(project.record);
    if (!hasConfirmedUltimateGoal(workflow.ultimateGoal)) {
      throw new Error("Confirm the Ultimate Goal before generating a preview.");
    }

    const existing = getWorkflowPreviewRequest(workflow);
    if (existing.status === "queued" || existing.status === "active" || existing.status === "ready") {
      return workflow;
    }

    const requestedAt = nowIso();
    const autopilotPolicy = resolveEffectiveAutopilotPolicy(workflow, project.record.localState.autopilotEnabled);
    workflow.previewRequest = {
      status: "queued",
      requestedAt,
      remainingCycles: Math.max(1, Math.min(3, Math.round(remainingCycles))),
      modeBeforePreview: workflow.workflowMode,
      autopilotWasEnabled: autopilotPolicy.enabled,
      reason: reason?.trim() || "Operator requested a visible/runnable preview checkpoint.",
      evidence: []
    };
    this.recordWorkflowActivity(workflow, {
      source: "workflow",
      status: this.hasActiveWorkflowAgent(project, ["coding", "integrity", "merge"]) ? "waiting" : "running",
      title: "Preview generation queued",
      detail: this.hasActiveWorkflowAgent(project, ["coding", "integrity", "merge"])
        ? "The current coding, integrity, or merge step will finish before preview generation starts."
        : "The next safe workflow transition will steer toward a visible/runnable preview checkpoint.",
      stepId: getWorkflowActiveStepId(workflow)
    });
    this.prepareQueuedWorkflowPreviewForRecommendation(project);
    this.syncWorkflowState(project);
    await this.persistProjectUpdate(project, !this.hasActiveWorkflowAgent(project));
    return project.record.workflow;
  }

  async cancelWorkflowPreview(projectId: string): Promise<ProjectWorkflowState> {
    const project = this.findProject(projectId);
    const workflow = this.ensureWorkflowState(project.record);
    const previewRequest = getWorkflowPreviewRequest(workflow);
    const canCancel =
      previewRequest.status === "queued" ||
      (
        previewRequest.status === "active" &&
        !workflow.approvedRecommendation &&
        !workflow.scopedGoal &&
        !this.hasActiveWorkflowAgent(project)
      );
    if (!canCancel) {
      throw new Error("Preview can only be cancelled before preview implementation starts.");
    }

    workflow.previewRequest = {
      ...previewRequest,
      status: "cancelled",
      completedAt: nowIso()
    };
    this.recordWorkflowActivity(workflow, {
      source: "workflow",
      status: "completed",
      title: "Preview request cancelled",
      detail: "The workflow will continue with normal recommendation selection.",
      stepId: getWorkflowActiveStepId(workflow)
    });
    this.syncWorkflowState(project);
    await this.persistProjectUpdate(project, project.record.localState.autopilotEnabled && !project.record.localState.workflowPauseRequested);
    return project.record.workflow;
  }

  async completeWorkflowPreview(projectId: string): Promise<ProjectWorkflowState> {
    const project = this.findProject(projectId);
    const completed = this.completeWorkflowPreviewCheckpoint(project, "The operator dismissed the preview checkpoint and resumed normal workflow progression.");
    if (!completed) {
      return project.record.workflow;
    }

    project.record.localState.workflowPauseRequested = false;
    this.reconcileWorkflowResumeState(project);
    this.syncWorkflowState(project);
    await this.persistProjectUpdate(project, project.record.localState.autopilotEnabled);
    return project.record.workflow;
  }

  async updateUiState(projectId: string, partial: Partial<LocalProjectRecord["localState"]>): Promise<void> {
    const project = this.findProject(projectId);
    const localStatePatch = {
      ...partial
    } as Partial<LocalProjectRecord["localState"]> & { projectId?: string };
    delete localStatePatch.projectId;
    if (Object.keys(localStatePatch).length === 0) {
      await this.saveProject(project);
      return;
    }
    const projectMutation =
      partial.autopilotEnabled !== undefined ||
      partial.workflowObjective !== undefined ||
      partial.workflowPauseRequested !== undefined;
    const previousPauseRequested = project.record.localState.workflowPauseRequested;
    project.record.localState = {
      ...project.record.localState,
      ...localStatePatch,
      lastOpenedAt: projectMutation ? nowIso() : project.record.localState.lastOpenedAt
    };
    const workflow = this.ensureWorkflowState(project.record);
    if (partial.autopilotEnabled !== undefined) {
      workflow.autopilotPolicy = validateAutopilotPolicy({
        ...workflow.autopilotPolicy,
        enabled: partial.autopilotEnabled
      }, partial.autopilotEnabled);
      project.record.localState.autopilotEnabled = workflow.autopilotPolicy.enabled;
    }
    const previousAutopilotPauseReason = workflow.autopilotStatus?.pausedReason;
    const nextPauseRequested = project.record.localState.workflowPauseRequested;
    const acknowledgedAutopilotCheckpoint =
      partial.workflowPauseRequested !== undefined &&
      !previousPauseRequested &&
      !nextPauseRequested &&
      Boolean(previousAutopilotPauseReason);
    if (
      partial.workflowPauseRequested !== undefined &&
      (previousPauseRequested !== nextPauseRequested || acknowledgedAutopilotCheckpoint)
    ) {
      if (!nextPauseRequested) {
        this.completeWorkflowPreviewCheckpoint(project, "Workflow resumed after preview inspection");
        this.reconcileWorkflowResumeState(project);
      }
      this.recordWorkflowActivity(workflow, {
        source: "workflow",
        status: nextPauseRequested ? "waiting" : "running",
        title: nextPauseRequested
          ? "Automation pause requested"
          : acknowledgedAutopilotCheckpoint
            ? "Autopilot checkpoint acknowledged"
            : "Workflow automation resumed",
        detail: nextPauseRequested
          ? "The current workflow agent can finish, but no new automatic step will start until you continue."
          : acknowledgedAutopilotCheckpoint
            ? "The saved autopilot checkpoint was acknowledged; automatic workflow progression can start again."
            : "Automatic workflow progression can start again.",
        stepId: getWorkflowActiveStepId(workflow)
      });
    }
    if (!projectMutation) {
      return;
    }

    this.syncWorkflowState(project);
    await this.persistProjectUpdate(project, {
      save: "deferred",
      emit: "coalesced",
      automate:
        partial.autopilotEnabled !== undefined ||
        partial.workflowObjective !== undefined ||
        (partial.workflowPauseRequested !== undefined && !nextPauseRequested),
      reason: "ui workflow state updated"
    });
  }

  async setWorkflowMode(projectId: string, workflowMode: WorkflowMode): Promise<ProjectWorkflowState> {
    const project = this.findProject(projectId);
    const workflow = this.ensureWorkflowState(project.record);
    const nextMode: WorkflowMode = workflowMode === "fast" ? "fast" : "normal";
    const previousMode = workflow.workflowMode;
    workflow.workflowMode = nextMode;

    if (previousMode !== nextMode) {
      this.recordWorkflowActivity(workflow, {
        source: "workflow",
        status: this.hasActiveWorkflowAgent(project)
          ? "waiting"
          : "completed",
        title: nextMode === "fast" ? "Fast Mode enabled" : "Normal Mode enabled",
        detail: nextMode === "fast"
          ? "Future safe workflow transitions will prefer larger coherent work packages and deterministic scoping when clear."
          : "Future safe workflow transitions will use the normal review-oriented recommendation policy.",
        stepId: getWorkflowActiveStepId(workflow)
      });
    }

    this.syncWorkflowState(project);
    const hasActiveWorkflowAgent = this.hasActiveWorkflowAgent(project);
    const shouldContinueAutomation =
      !hasActiveWorkflowAgent &&
      project.record.localState.autopilotEnabled &&
      !project.record.localState.workflowPauseRequested;
    await this.persistProjectUpdate(project, {
      save: "immediate",
      emit: "coalesced",
      automate: shouldContinueAutomation,
      reason: "workflow mode changed"
    });
    return project.record.workflow;
  }

  async setAutopilotPolicy(projectId: string, policyPatch: Partial<AutopilotPolicy>): Promise<ProjectWorkflowState> {
    const project = this.findProject(projectId);
    const workflow = this.ensureWorkflowState(project.record);
    const previousPolicy = resolveEffectiveAutopilotPolicy(workflow, project.record.localState.autopilotEnabled);
    workflow.autopilotPolicy = validateAutopilotPolicy({
      ...previousPolicy,
      ...policyPatch
    }, project.record.localState.autopilotEnabled);
    project.record.localState.autopilotEnabled = workflow.autopilotPolicy.enabled;

    if (
      previousPolicy.enabled !== workflow.autopilotPolicy.enabled ||
      previousPolicy.profile !== workflow.autopilotPolicy.profile ||
      JSON.stringify(previousPolicy) !== JSON.stringify(workflow.autopilotPolicy)
    ) {
      this.recordWorkflowActivity(workflow, {
        source: "workflow",
        status: workflow.autopilotPolicy.enabled ? "running" : "waiting",
        title: "Autopilot policy updated",
        detail: `${workflow.autopilotPolicy.profile} profile is ${workflow.autopilotPolicy.enabled ? "enabled" : "disabled"}.`,
        stepId: getWorkflowActiveStepId(workflow)
      });
    }

    this.syncWorkflowState(project);
    const hasActiveWorkflowAgent = this.hasActiveWorkflowAgent(project);
    const shouldContinueAutomation =
      !hasActiveWorkflowAgent &&
      workflow.autopilotPolicy.enabled &&
      !project.record.localState.workflowPauseRequested;
    await this.persistProjectUpdate(project, {
      save: "immediate",
      emit: "coalesced",
      automate: shouldContinueAutomation,
      reason: "autopilot policy changed"
    });
    return project.record.workflow;
  }

  async openWorkflowRepairAgent(projectId: string): Promise<OpenProjectShellResult> {
    const project = this.findProject(projectId);
    const workflow = this.ensureWorkflowState(project.record);
    const prompt = this.buildWorkflowRepairAgentPrompt(project);
    const result = await openProjectShellWindow(
      {
        projectName: `${project.record.identity.projectName} Repair`,
        projectRoot: project.record.projectRoot,
        projectHostPath: project.record.hostPath,
        prompt,
        settings: {
          executionMode: this.settings.executionMode,
          distroName: project.record.distroName ?? this.settings.distroName,
          codexBinaryPath: this.settings.codexBinaryPath,
          codexHome: this.settings.codexHome
        }
      },
      process.platform
    );
    const activeStepId = getWorkflowActiveStepId(workflow);
    this.recordWorkflowActivity(workflow, {
      source: "system",
      status: result.launched ? "completed" : "failed",
      title: result.launched ? "Opened Codex repair agent" : "Codex repair agent launch failed",
      detail: result.message,
      stepId: activeStepId
    });
    this.updateWorkflowStepProgress(workflow, activeStepId, {
      latestProgressNote: result.launched
        ? "Opened an external Codex repair agent with current validation, hygiene, checklist, and cycle-contract context."
        : result.message,
      message: result.launched
        ? "A separate Codex CLI repair session is working from the current diagnostic context."
        : "The external Codex repair session could not be opened.",
      warning: result.launched ? undefined : result.message
    });
    await this.persistProjectUpdate(project);
    return result;
  }

  private buildWorkflowRepairAgentPrompt(project: LoadedProject, agentRoleIntro?: string): string {
    const workflow = this.ensureWorkflowState(project.record);
    const cycleAgents = this.cycleAgents(project, workflow.workflowCycle.cycleNumber);
    const sortedCycleAgents = this.sortAgentsForHistory(cycleAgents);
    const latestAgent = sortedCycleAgents[0];
    const ledger = this.latestCycleValidationLedger(workflow);
    const hygiene = this.latestRepoHygieneReport(workflow);
    const activeStepId = getWorkflowActiveStepId(workflow);
    const activeStep = workflow.stepProgress[activeStepId];
    const operatorView = buildOperatorWorkflowViewModel({
      workflow,
      agents: cycleAgents,
      validationLedger: ledger,
      repoHygieneReport: hygiene,
      workflowPauseRequested: project.record.localState.workflowPauseRequested,
      projectName: project.record.identity.projectName,
      branch: project.record.validation.branch ?? project.record.displayPath,
      approvalCount: project.record.agents.flatMap((agent) => agent.approvals).filter((approval) => approval.status === "pending").length
    });
    const sanitize = (value?: string, maxLength = 900): string | undefined => {
      if (!value?.trim()) {
        return undefined;
      }
      return compactText(this.sanitizeTextToProjectBoundary(project, value, project.record.projectRoot) ?? value, maxLength);
    };
    const sanitizeList = (values: string[] | undefined, maxItems = 24, maxLength = 240): string[] =>
      unique((values ?? []).flatMap((value) => sanitize(value, maxLength) ?? [])).slice(0, maxItems);
    const contract = operatorView.currentCycle.cycleContract;
    const sanitizedContract = contract
      ? {
        ...contract,
        selectedTaskTitle: sanitize(contract.selectedTaskTitle, 500) ?? contract.selectedTaskTitle,
        plainEnglishObjective: sanitize(contract.plainEnglishObjective, 800) ?? contract.plainEnglishObjective,
        concreteGoalForThisCycle: sanitize(contract.concreteGoalForThisCycle, 800) ?? contract.concreteGoalForThisCycle,
        targetedChecklistItems: contract.targetedChecklistItems.map((item) => ({
          ...item,
          title: sanitize(item.title, 240) ?? item.title,
          fullDescription: sanitize(item.fullDescription, 700) ?? item.fullDescription,
          currentEvidence: sanitize(item.currentEvidence, 500) ?? item.currentEvidence,
          whyTargeted: sanitize(item.whyTargeted, 500) ?? item.whyTargeted,
          acceptanceHint: sanitize(item.acceptanceHint, 500) ?? item.acceptanceHint,
          relatedPaths: sanitizeList(item.relatedPaths, 8),
          observableSignalsExpected: sanitizeList(item.observableSignalsExpected, 8, 320)
        })),
        expectedFilesOrAreas: sanitizeList(contract.expectedFilesOrAreas, 18),
        expectedValidationCommands: sanitizeList(contract.expectedValidationCommands, 10, 500),
        expectedEvidenceCommands: sanitizeList(contract.expectedEvidenceCommands, 10, 500),
        acceptanceCriteria: sanitizeList(contract.acceptanceCriteria, 12, 500),
        nonGoalsForThisCycle: sanitizeList(contract.nonGoalsForThisCycle, 10, 500),
        constraintsForThisCycle: sanitizeList(contract.constraintsForThisCycle, 10, 500),
        whySelectedNow: sanitize(contract.whySelectedNow, 700) ?? contract.whySelectedNow,
        currentKnownBlockers: sanitizeList(contract.currentKnownBlockers, 10, 500),
        fallbackOrHealthWarnings: sanitizeList(contract.fallbackOrHealthWarnings, 10, 500),
        doneWhen: sanitizeList(contract.doneWhen, 12, 500),
        failureModes: sanitizeList(contract.failureModes, 12, 500),
        priorSimilarAttempts: contract.priorSimilarAttempts.slice(0, 6).map((attempt) => ({
          ...attempt,
          attemptedTaskTitle: sanitize(attempt.attemptedTaskTitle, 300) ?? attempt.attemptedTaskTitle,
          completedTaskTitle: sanitize(attempt.completedTaskTitle, 300),
          nextRecommendedTaskTitle: sanitize(attempt.nextRecommendedTaskTitle, 300),
          filesChanged: sanitizeList(attempt.filesChanged, 10),
          validationSummary: sanitize(attempt.validationSummary, 400) ?? attempt.validationSummary,
          checklistDeltaSummary: sanitize(attempt.checklistDeltaSummary, 400) ?? attempt.checklistDeltaSummary
        })),
        sourceDataRefs: {}
      }
      : undefined;
    const sanitizedLedger = ledger
      ? {
        ...ledger,
        plannedCommands: sanitizeList(ledger.plannedCommands, 14, 500),
        attemptedCommands: sanitizeList(ledger.attemptedCommands, 14, 500),
        evidenceCommands: sanitizeList(ledger.evidenceCommands, 10, 500),
        testCommands: sanitizeList(ledger.testCommands, 10, 500),
        commandResults: ledger.commandResults.slice(0, 16).map((result) => ({
          ...result,
          command: sanitize(result.command, 500) ?? result.command,
          normalizedCommand: sanitize(result.normalizedCommand, 500) ?? result.normalizedCommand,
          stdoutSummary: sanitize(result.stdoutSummary, 500) ?? result.stdoutSummary,
          stderrSummary: sanitize(result.stderrSummary, 500) ?? result.stderrSummary,
          fullOutputRef: undefined,
          parsedJsonRef: undefined,
          classifiedFailure: result.classifiedFailure
            ? {
              ...result.classifiedFailure,
              summary: sanitize(result.classifiedFailure.summary, 500) ?? result.classifiedFailure.summary
            }
            : undefined,
          relatedFiles: sanitizeList(result.relatedFiles, 10)
        })),
        environmentFailures: sanitizeList(ledger.environmentFailures, 10, 500),
        commandConstructionFailures: sanitizeList(ledger.commandConstructionFailures, 10, 500),
        productFailures: sanitizeList(ledger.productFailures, 10, 500),
        evidenceFailures: sanitizeList(ledger.evidenceFailures, 10, 500),
        hygieneFailures: sanitizeList(ledger.hygieneFailures, 10, 500),
        repairedFailures: sanitizeList(ledger.repairedFailures, 10, 500),
        warnings: sanitizeList(ledger.warnings, 10, 500),
        finalValidationBasis: sanitize(ledger.finalValidationBasis, 600) ?? ledger.finalValidationBasis,
        unresolvedValidationFailures: sanitizeList(ledger.unresolvedValidationFailures, 12, 500),
        mergeBlockedReasons: sanitizeList(ledger.mergeBlockedReasons, 12, 500),
        summaryForHumans: sanitize(ledger.summaryForHumans, 600) ?? ledger.summaryForHumans
      }
      : undefined;
    const sanitizedHygiene = hygiene
      ? {
        ...hygiene,
        scannedRef: sanitize(hygiene.scannedRef, 240) ?? hygiene.scannedRef,
        forbiddenFiles: sanitizeList(hygiene.forbiddenFiles, 18),
        cleanedFiles: sanitizeList(hygiene.cleanedFiles, 18),
        warnings: sanitizeList(hygiene.warnings, 12, 500),
        mergeBlockingFindings: sanitizeList(hygiene.mergeBlockingFindings, 18, 500),
        summaryForHumans: sanitize(hygiene.summaryForHumans, 600) ?? hygiene.summaryForHumans
      }
      : undefined;
    const delta = operatorView.currentCycle.checklistDelta;
    const sanitizedDelta = delta
      ? {
        ...delta,
        targetedNewlyMet: sanitizeList(delta.targetedNewlyMet, 16),
        targetedStillUnknown: sanitizeList(delta.targetedStillUnknown, 16),
        targetedNeedsAttention: sanitizeList(delta.targetedNeedsAttention, 16),
        targetedNotApplicable: sanitizeList(delta.targetedNotApplicable, 16),
        nonTargetedChanges: sanitizeList(delta.nonTargetedChanges, 16, 500),
        summaryForHumans: sanitize(delta.summaryForHumans, 600) ?? delta.summaryForHumans,
        whyStillUnknownByCheckId: Object.fromEntries(
          Object.entries(delta.whyStillUnknownByCheckId).map(([checkId, reason]) => [
            sanitize(checkId, 160) ?? checkId,
            sanitize(reason, 500) ?? reason
          ])
        )
      }
      : undefined;
    const recentAgentMessages = sortedCycleAgents.flatMap((agent) => [
      `${agent.name}: ${agent.currentPhase ?? agent.lastMessageSnippet ?? agent.status}`,
      ...agent.events.slice(-2).map((event) => `${agent.name}: ${event.title}${event.detail ? ` - ${event.detail}` : ""}`)
    ]);

    return buildWorkflowRepairAgentPrompt({
      agentRoleIntro,
      projectName: project.record.identity.projectName,
      projectRoot: project.record.projectRoot,
      branchOrPath: project.record.validation.branch ?? project.record.displayPath,
      statusLabel: operatorView.currentStatus.primaryLabel,
      technicalStage: operatorView.currentStatus.technicalStage,
      activeAgent: operatorView.currentStatus.activeAgent,
      currentPhase: sanitize(latestAgent?.currentPhase ?? activeStep.currentActivity ?? activeStep.message, 240) ?? "No active phase recorded",
      currentFocus: operatorView.currentStatus.secondaryExplanation,
      nextOperatorAction: operatorView.currentStatus.nextOperatorAction,
      cycleNumber: workflow.workflowCycle.cycleNumber,
      cycleContract: sanitizedContract,
      checklistDelta: sanitizedDelta,
      validationLedger: sanitizedLedger,
      repoHygieneReport: sanitizedHygiene,
      changedFiles: sanitizeList([
        ...operatorView.currentCycle.changedFiles,
        ...(hygiene?.forbiddenFiles ?? []),
        ...(hygiene?.cleanedFiles ?? [])
      ], 32),
      recentAgentMessages: sanitizeList(recentAgentMessages, 10, 500),
      pendingApprovals: project.record.agents.flatMap((agent) => agent.approvals).filter((approval) => approval.status === "pending").length
    });
  }

  async openProjectShell(projectId: string): Promise<OpenProjectShellResult> {
    const project = this.findProject(projectId);
    const workflow = this.ensureWorkflowState(project.record);
    const prompt = this.buildProjectShellPrompt(project);
    const result = await openProjectShellWindow(
      {
        projectName: project.record.identity.projectName,
        projectRoot: project.record.projectRoot,
        projectHostPath: project.record.hostPath,
        prompt,
        settings: {
          executionMode: this.settings.executionMode,
          distroName: project.record.distroName ?? this.settings.distroName,
          codexBinaryPath: this.settings.codexBinaryPath,
          codexHome: this.settings.codexHome
        }
      },
      process.platform
    );

    if (workflow.manualHandoff) {
      if (result.launched) {
        workflow.manualHandoff.lastOpenedAt = nowIso();
        workflow.manualHandoff.lastOpenError = undefined;
      } else {
        workflow.manualHandoff.lastOpenError = result.message;
      }
    }

    this.recordWorkflowActivity(workflow, {
      source: "system",
      status: result.launched ? "completed" : "failed",
      title: result.launched ? "Opened Codex terminal" : "Codex terminal launch failed",
      detail: result.message,
      stepId: workflow.workflowStage === "repair_loop" ? getWorkflowActiveStepId(workflow) : undefined
    });
    await this.persistProjectUpdate(project);
    return result;
  }

  private buildProjectShellPrompt(project: LoadedProject): string {
    const workflow = this.ensureWorkflowState(project.record);
    const pendingUserInputRequests = project.record.userInputRequests
      .filter((request) => request.status === "pending")
      .map((request) => ({
        title: this.sanitizeTextToProjectBoundary(project, request.title) ?? request.title,
        description: this.sanitizeTextToProjectBoundary(project, request.description) ?? request.description,
        attachmentInboxRelativePath: request.attachmentInboxRelativePath,
        attachments: request.attachments.map((attachment) => ({
          relativePath: attachment.relativePath
        })),
        questions: request.questions.map((question) => ({
          header: this.sanitizeTextToProjectBoundary(project, question.header) ?? question.header,
          question: this.sanitizeTextToProjectBoundary(project, question.question) ?? question.question,
          isSecret: question.isSecret
        }))
      }));
    const pendingRequestIds = new Set(
      project.record.userInputRequests
        .filter((request) => request.status === "pending")
        .map((request) => request.humanInterventionId)
        .filter((id): id is string => Boolean(id))
    );
    const pendingHumanInterventions = workflow.humanInterventions
      .filter((entry) => entry.status === "pending" && !pendingRequestIds.has(entry.id))
      .map((entry) => ({
        title: this.sanitizeTextToProjectBoundary(project, entry.title) ?? entry.title,
        description: this.sanitizeTextToProjectBoundary(project, entry.description) ?? entry.description,
        severity: entry.severity
      }));

    return buildProjectShellHandoffPrompt({
      projectName: project.record.identity.projectName,
      projectRoot: project.record.projectRoot,
      manualHandoff: workflow.manualHandoff
        ? {
            reason: workflow.manualHandoff.reason,
            title: this.sanitizeTextToProjectBoundary(project, workflow.manualHandoff.title) ?? workflow.manualHandoff.title,
            whatSystemWasTryingToDo:
              this.sanitizeTextToProjectBoundary(project, workflow.manualHandoff.whatSystemWasTryingToDo)
              ?? workflow.manualHandoff.whatSystemWasTryingToDo,
            validationIssue:
              this.sanitizeTextToProjectBoundary(project, workflow.manualHandoff.validationIssue)
              ?? workflow.manualHandoff.validationIssue,
            latestFailureReason:
              this.sanitizeTextToProjectBoundary(project, workflow.manualHandoff.latestFailureReason)
              ?? workflow.manualHandoff.latestFailureReason,
            involvedPaths: workflow.manualHandoff.involvedPaths.map((entry) =>
              this.sanitizeTextToProjectBoundary(project, entry) ?? entry
            )
          }
        : undefined,
      pendingUserInputRequests,
      pendingHumanInterventions
    });
  }

  private goalCharterFieldLabel(field: GoalCharterDraftTextField): string {
    const labels: Record<GoalCharterDraftTextField, string> = {
      currentSummary: "Current Effective Goal",
      currentDetailedIntent: "Detailed intent",
      currentSuccessCriteria: "Success criteria",
      currentConstraints: "Constraints",
      currentNonGoals: "Explicit non-goals",
      currentTargetAudience: "Target audience",
      currentQualityBar: "Quality bar",
      nonNegotiableRequirements: "Non-negotiable requirements",
      flexibleRequirements: "Flexible requirements",
      niceToHaveIdeas: "Nice-to-have ideas",
      explicitNonGoals: "Charter non-goals",
      userConstraints: "User constraints",
      aestheticPreferences: "Aesthetic preferences",
      technicalPreferences: "Technical preferences",
      definitionOfDone: "Definition of done"
    };
    return labels[field];
  }

  private buildGoalCharterPolishOutputSchema(): JsonValue {
    return {
      type: "object",
      additionalProperties: false,
      required: ["value"],
      properties: {
        value: { type: "string", maxLength: 8_000 }
      }
    } satisfies JsonValue;
  }

  private buildGoalCharterDraftOutputSchema(): JsonValue {
    const list = { type: "array", items: { type: "string", maxLength: 500 }, maxItems: 12 };
    return {
      type: "object",
      additionalProperties: false,
      required: [
        "summary",
        "detailedIntent",
        "successCriteria",
        "constraints",
        "nonGoals",
        "targetAudience",
        "qualityBar",
        "nonNegotiableRequirements",
        "flexibleRequirements",
        "niceToHaveIdeas",
        "explicitNonGoals",
        "userConstraints",
        "aestheticPreferences",
        "technicalPreferences",
        "definitionOfDone"
      ],
      properties: {
        summary: { type: "string", maxLength: 520 },
        detailedIntent: { type: "string", maxLength: 2_500 },
        successCriteria: list,
        constraints: list,
        nonGoals: list,
        targetAudience: { type: "string", maxLength: 500 },
        qualityBar: { type: "string", maxLength: 1_200 },
        nonNegotiableRequirements: list,
        flexibleRequirements: list,
        niceToHaveIdeas: list,
        explicitNonGoals: list,
        userConstraints: list,
        aestheticPreferences: list,
        technicalPreferences: list,
        definitionOfDone: list
      }
    } satisfies JsonValue;
  }

  private goalCharterDraftContext(currentDraft?: Partial<Record<GoalCharterDraftTextField, string>>): string {
    if (!currentDraft) {
      return "No existing draft field values were supplied.";
    }
    const entries = (Object.entries(currentDraft) as Array<[GoalCharterDraftTextField, string]>)
      .map(([field, value]) => [this.goalCharterFieldLabel(field), value.trim()] as const)
      .filter(([, value]) => value.length > 0)
      .map(([label, value]) => `${label}:\n${compactText(value, 1_200)}`);
    return entries.length ? entries.join("\n\n") : "No existing draft field values were supplied.";
  }

  private buildGoalCharterPolishPrompt(
    project: LoadedProject,
    field: GoalCharterDraftTextField,
    value: string,
    currentDraft?: Partial<Record<GoalCharterDraftTextField, string>>
  ): string {
    const listLike = [
      "currentSuccessCriteria",
      "currentConstraints",
      "currentNonGoals",
      "nonNegotiableRequirements",
      "flexibleRequirements",
      "niceToHaveIdeas",
      "explicitNonGoals",
      "userConstraints",
      "aestheticPreferences",
      "technicalPreferences",
      "definitionOfDone"
    ].includes(field);
    return [
      "Improve one Goal Charter field for Codex Agent Workbench.",
      "Preserve the user's intent. Do not add unrelated scope, secrets, credentials, local machine paths, or unverifiable promises.",
      listLike
        ? "Return one item per line. Use concrete, observable phrasing where possible."
        : "Return polished prose for the same field. Keep it concise and directly usable.",
      "Make success criteria and definition-of-done items testable or inspectable. Put hard rules in constraints, and excluded work in non-goals.",
      "",
      `Project: ${project.record.identity.projectName}`,
      `Repository overview: ${project.record.overview?.summary ?? project.scan.stats.explanation}`,
      `Field: ${this.goalCharterFieldLabel(field)}`,
      `Existing draft context:\n${this.goalCharterDraftContext(currentDraft)}`,
      `Text to polish:\n${value.trim()}`
    ].join("\n\n");
  }

  private buildGoalCharterGeneratePrompt(
    project: LoadedProject,
    prompt: string,
    currentDraft?: Partial<Record<GoalCharterDraftTextField, string>>
  ): string {
    return [
      "Generate a complete Goal Charter draft for Codex Agent Workbench from the user's project prompt.",
      "The draft is used to guide repeated recommendation, scoped planning, coding, integrity validation, and merge cycles.",
      "Write an ambitious but bounded ultimate goal. Criteria must describe observable end states, not tiny implementation chores.",
      "Keep hard rules in constraints, excluded work in non-goals, and excellent-outcome standards in the quality bar and definition of done.",
      "Do not include secrets, credentials, account-specific details, local machine paths, or paid-service assumptions unless the prompt explicitly requires them.",
      "If the user asks for a game, app, site, or tool, make the charter concrete about the user-facing finished experience and validation expectations.",
      "",
      `Project: ${project.record.identity.projectName}`,
      `Repository overview: ${project.record.overview?.summary ?? project.scan.stats.explanation}`,
      `Entry points: ${project.scan.stats.entryPoints.slice(0, 6).join(", ") || "None detected"}`,
      `Primary managers: ${project.scan.stats.primaryManagers.join(", ") || "None detected"}`,
      `Existing draft context:\n${this.goalCharterDraftContext(currentDraft)}`,
      `User project prompt:\n${prompt.trim()}`
    ].join("\n\n");
  }

  private normalizeGoalCharterList(value: unknown, fallback: string[] = []): string[] {
    if (Array.isArray(value)) {
      return value
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .map((entry) => compactText(entry, 500))
        .slice(0, 12);
    }
    if (typeof value === "string") {
      return value
        .split(/\r?\n/)
        .map((entry) => entry.replace(/^[-*]\s*/, "").trim())
        .filter((entry) => entry.length > 0)
        .map((entry) => compactText(entry, 500))
        .slice(0, 12);
    }
    return fallback.slice(0, 12);
  }

  private normalizeGoalCharterString(value: unknown, fallback = "", maxLength = 2_500): string {
    return typeof value === "string" && value.trim().length > 0
      ? compactText(value, maxLength)
      : fallback;
  }

  private parseGoalCharterPolishOutput(rawText: string): string | undefined {
    for (const parsed of this.extractJsonObjects(rawText).reverse()) {
      const value = typeof parsed.value === "string" ? parsed.value.trim() : "";
      if (value) {
        return compactText(value, 8_000);
      }
    }
    const fallback = rawText.trim();
    return fallback ? compactText(fallback, 8_000) : undefined;
  }

  private parseGoalCharterDraftOutput(rawText: string, prompt: string): GoalCharterAiDraft | undefined {
    for (const parsed of this.extractJsonObjects(rawText).reverse()) {
      const currentSummary = this.normalizeGoalCharterString(
        parsed.summary ?? parsed.currentSummary,
        compactText(prompt, 520),
        520
      );
      const currentDetailedIntent = this.normalizeGoalCharterString(
        parsed.detailedIntent ?? parsed.currentDetailedIntent,
        "",
        2_500
      );
      const currentSuccessCriteria = this.normalizeGoalCharterList(parsed.successCriteria ?? parsed.currentSuccessCriteria);
      const currentConstraints = this.normalizeGoalCharterList(parsed.constraints ?? parsed.currentConstraints);
      const currentNonGoals = this.normalizeGoalCharterList(parsed.nonGoals ?? parsed.currentNonGoals);
      const currentQualityBar = this.normalizeGoalCharterString(parsed.qualityBar ?? parsed.currentQualityBar, "", 1_200);
      if (!currentSummary || !currentDetailedIntent || currentSuccessCriteria.length === 0 || !currentQualityBar) {
        continue;
      }
      return {
        currentSummary,
        currentDetailedIntent,
        currentSuccessCriteria,
        currentConstraints,
        currentNonGoals,
        currentTargetAudience: this.normalizeGoalCharterString(parsed.targetAudience ?? parsed.currentTargetAudience, "", 500),
        currentQualityBar,
        nonNegotiableRequirements: this.normalizeGoalCharterList(parsed.nonNegotiableRequirements, currentSuccessCriteria),
        flexibleRequirements: this.normalizeGoalCharterList(parsed.flexibleRequirements),
        niceToHaveIdeas: this.normalizeGoalCharterList(parsed.niceToHaveIdeas),
        explicitNonGoals: this.normalizeGoalCharterList(parsed.explicitNonGoals, currentNonGoals),
        userConstraints: this.normalizeGoalCharterList(parsed.userConstraints, currentConstraints),
        aestheticPreferences: this.normalizeGoalCharterList(parsed.aestheticPreferences),
        technicalPreferences: this.normalizeGoalCharterList(parsed.technicalPreferences, currentConstraints),
        definitionOfDone: this.normalizeGoalCharterList(parsed.definitionOfDone, currentSuccessCriteria)
      };
    }
    return undefined;
  }

  private async runGoalCharterStructuredTurn(
    project: LoadedProject,
    options: {
      prompt: string;
      model: string;
      reasoningEffort?: InterfaceReasoningEffort;
      outputSchema: JsonValue;
    }
  ): Promise<string> {
    await this.ensureAgentBackedRuntimeReady(project, "goal charter AI drafting runtime check");
    if (!this.transport) {
      throw new Error("Codex transport is not initialized.");
    }
    if (!this.availableModels.some((entry) => entry.model === options.model)) {
      throw new Error(`Model is not available: ${options.model}`);
    }
    const modelRecord = this.availableModels.find((entry) => entry.model === options.model);
    const effort = resolveInterfaceCreationReasoningEffort(modelRecord, options.reasoningEffort);
    const cwd = project.record.projectRoot;
    await assertExecutionPathWithinProjectRoot(
      project.record.projectRoot,
      cwd,
      project.record.hostPath,
      this.getRuntimeSettings(project.record.distroName),
      project.record.distroName,
      "Goal Charter AI drafting"
    );

    const thread = await this.transport.startThread({
      cwd,
      model: options.model,
      approvalPolicy: "on-request",
      sandbox: "read-only",
      baseInstructions: [
        "You improve project goal charters for Codex Agent Workbench.",
        "When an output schema is supplied, return only valid JSON matching that schema exactly.",
        "Do not include markdown fences, commentary, greetings, or raw chain-of-thought."
      ].join("\n"),
      developerInstructions: this.buildProjectBoundaryDeveloperInstructions(project, cwd, "read-only"),
      personality: "pragmatic",
      ephemeral: true,
      experimentalRawEvents: false
    });

    const threadId = thread.thread.id;
    const sandboxPolicy = this.buildRestrictedSandboxPolicy(project, "read-only");
    let capturedText = "";
    let turnId: string | undefined;

    return await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Goal Charter AI drafting timed out before the model returned a result."));
      }, 240_000);
      timeout.unref();

      const cleanup = (): void => {
        clearTimeout(timeout);
        this.transport?.off("notification", onNotification);
      };

      const finishFromThread = async (): Promise<void> => {
        try {
          if (capturedText.trim()) {
            cleanup();
            resolve(capturedText);
            return;
          }
          const threadRead = await this.transport?.readThread(threadId, true);
          const turns = [...(threadRead?.thread.turns ?? [])].reverse();
          for (const turn of turns) {
            for (const item of [...turn.items].reverse()) {
              if (item.type === "agentMessage" && item.text.trim()) {
                cleanup();
                resolve(item.text);
                return;
              }
            }
          }
          cleanup();
          reject(new Error("Goal Charter AI drafting completed without a model message."));
        } catch (error) {
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };

      const onNotification = (notification: ServerNotification): void => {
        const params = "params" in notification ? notification.params as { threadId?: string; turnId?: string } : undefined;
        if (!params || params.threadId !== threadId) {
          return;
        }
        switch (notification.method) {
          case "turn/started":
            turnId = notification.params.turn.id;
            break;
          case "item/agentMessage/delta":
            if (!turnId || notification.params.turnId === turnId) {
              capturedText += notification.params.delta;
            }
            break;
          case "item/completed":
            if (notification.params.item.type === "agentMessage" && (!turnId || notification.params.turnId === turnId)) {
              capturedText = notification.params.item.text;
            }
            break;
          case "rawResponseItem/completed": {
            const rawResponseText = this.extractTextFromRawResponseItem(notification.params.item);
            if (rawResponseText && (!turnId || notification.params.turnId === turnId)) {
              capturedText = rawResponseText;
            }
            break;
          }
          case "turn/completed":
            if (!turnId || notification.params.turn.id === turnId) {
              void finishFromThread();
            }
            break;
          case "error":
            cleanup();
            reject(new Error(notification.params.error.message || "Goal Charter AI drafting failed."));
            break;
          default:
            break;
        }
      };

      this.transport?.on("notification", onNotification);
      this.transport?.startTurn({
        threadId,
        input: [
          {
            type: "text",
            text: options.prompt,
            text_elements: []
          }
        ],
        cwd,
        sandboxPolicy,
        model: options.model,
        effort,
        outputSchema: options.outputSchema
      }).then((turnResponse) => {
        turnId = turnResponse.turn.id;
      }).catch((error) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async polishGoalCharterField(
    projectId: string,
    input: {
      field: GoalCharterDraftTextField;
      value: string;
      currentDraft?: Partial<Record<GoalCharterDraftTextField, string>>;
      model: string;
      reasoningEffort?: InterfaceReasoningEffort;
    }
  ): Promise<GoalCharterPolishResult> {
    const project = this.findProject(projectId);
    const rawText = await this.runGoalCharterStructuredTurn(project, {
      prompt: this.buildGoalCharterPolishPrompt(project, input.field, input.value, input.currentDraft),
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      outputSchema: this.buildGoalCharterPolishOutputSchema()
    });
    const value = this.parseGoalCharterPolishOutput(rawText);
    if (!value) {
      throw new Error("The model did not return polished Goal Charter text.");
    }
    return {
      field: input.field,
      value,
      model: input.model,
      reasoningEffort: input.reasoningEffort
    };
  }

  async generateGoalCharterDraft(
    projectId: string,
    input: {
      prompt: string;
      currentDraft?: Partial<Record<GoalCharterDraftTextField, string>>;
      model: string;
      reasoningEffort?: InterfaceReasoningEffort;
    }
  ): Promise<GoalCharterGenerateResult> {
    const project = this.findProject(projectId);
    const rawText = await this.runGoalCharterStructuredTurn(project, {
      prompt: this.buildGoalCharterGeneratePrompt(project, input.prompt, input.currentDraft),
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      outputSchema: this.buildGoalCharterDraftOutputSchema()
    });
    const draft = this.parseGoalCharterDraftOutput(rawText, input.prompt);
    if (!draft) {
      throw new Error("The model did not return a usable Goal Charter draft.");
    }
    return {
      draft,
      model: input.model,
      reasoningEffort: input.reasoningEffort
    };
  }

  getGoalCharter(projectId: string): GoalCharter {
    const project = this.findProject(projectId);
    const workflow = this.ensureWorkflowState(project.record);
    return workflow.goalCharter;
  }

  async updateGoalCharter(projectId: string, patch: Partial<GoalCharter>): Promise<GoalCharter> {
    const project = this.findProject(projectId);
    const workflow = this.ensureWorkflowState(project.record);
    const previousCharter = this.ensureGoalCharterForWorkflow(workflow);
    const previousCurrentGoal = previousCharter.currentEffectiveGoal;
    const originalGoal = hasMeaningfulUltimateGoal(previousCharter.originalUltimateGoal)
      ? previousCharter.originalUltimateGoal
      : patch.originalUltimateGoal;
    const currentEffectiveGoal = patch.currentEffectiveGoal
      ? ultimateGoalSchema.parse({
        ...previousCharter.currentEffectiveGoal,
        ...patch.currentEffectiveGoal,
        source: patch.currentEffectiveGoal.source ?? "user",
        confirmedAt: patch.currentEffectiveGoal.confirmedAt ?? previousCharter.currentEffectiveGoal.confirmedAt ?? nowIso(),
        lastUpdatedAt: nowIso()
      })
      : previousCharter.currentEffectiveGoal;
    const merged = goalCharterSchema.parse({
      ...previousCharter,
      ...patch,
      originalUltimateGoal: originalGoal
        ? {
          ...previousCharter.originalUltimateGoal,
          ...originalGoal
        }
        : previousCharter.originalUltimateGoal,
      currentEffectiveGoal,
      autopilotStrategy: patch.autopilotStrategy
        ? autopilotStrategySchema.parse({
          ...previousCharter.autopilotStrategy,
          ...patch.autopilotStrategy,
          visualPreferences: {
            ...previousCharter.autopilotStrategy.visualPreferences,
            ...patch.autopilotStrategy.visualPreferences
          },
          autonomyBudget: {
            ...previousCharter.autopilotStrategy.autonomyBudget,
            ...patch.autopilotStrategy.autonomyBudget
          }
        })
        : previousCharter.autopilotStrategy,
      updatedAt: nowIso()
    });

    if (hasMeaningfulUltimateGoal(previousCharter.originalUltimateGoal)) {
      merged.originalUltimateGoal = previousCharter.originalUltimateGoal;
    } else if (hasMeaningfulUltimateGoal(currentEffectiveGoal)) {
      merged.originalUltimateGoal = currentEffectiveGoal;
    }

    if (patch.currentEffectiveGoal && this.goalChanged(previousCurrentGoal, currentEffectiveGoal)) {
      workflow.ultimateGoal = currentEffectiveGoal;
      merged.acceptedGoalChanges = this.addGoalChangeRecord(merged.acceptedGoalChanges, {
        title: "Updated Current Effective Goal",
        summary: currentEffectiveGoal.summary,
        rationale: "The user edited and saved the Current Effective Goal.",
        source: "user",
        proposedGoal: currentEffectiveGoal,
        fromGoalSummary: previousCurrentGoal.summary,
        toGoalSummary: currentEffectiveGoal.summary,
        decisionNotes: "Accepted by direct user edit."
      });
      workflow.goalChecklist = buildGoalChecklistFromUltimateGoal(currentEffectiveGoal, workflow.goalChecklist);
      this.refreshWorkflowTaskMap(project);
      workflow.ultimateGoalProgress = undefined;
      workflow.ultimateGoalCompletion = undefined;
    }

    if (
      patch.proposedGoalChanges !== undefined &&
      !merged.proposedGoalChanges.some((change) => change.source === "detected" && change.proposedGoal)
    ) {
      workflow.ultimateGoalDraft = undefined;
      if (!workflow.ultimateGoal.confirmedAt && workflow.ultimateGoal.source === "detected") {
        workflow.ultimateGoal = defaultProjectWorkflowState().ultimateGoal;
      }
    }

    workflow.goalCharter = merged;
    this.syncWorkflowState(project);
    await this.persistProjectUpdate(project, {
      save: "immediate",
      emit: "coalesced",
      automate: false,
      reason: "goal charter updated"
    });
    return workflow.goalCharter;
  }

  getAutopilotStrategy(projectId: string): AutopilotStrategy {
    const project = this.findProject(projectId);
    const workflow = this.ensureWorkflowState(project.record);
    return workflow.goalCharter.autopilotStrategy;
  }

  async updateAutopilotStrategy(projectId: string, strategy: AutopilotStrategy): Promise<AutopilotStrategy> {
    const project = this.findProject(projectId);
    const workflow = this.ensureWorkflowState(project.record);
    workflow.goalCharter.autopilotStrategy = autopilotStrategySchema.parse(strategy);
    workflow.goalCharter.updatedAt = nowIso();
    this.recordWorkflowActivity(workflow, {
      source: "workflow",
      status: "completed",
      title: "Autopilot strategy updated",
      detail: `${workflow.goalCharter.autopilotStrategy.presetId} · fidelity ${workflow.goalCharter.autopilotStrategy.goalRestrictiveness}`,
      stepId: getWorkflowActiveStepId(workflow)
    });
    await this.persistProjectUpdate(project, {
      save: "immediate",
      emit: "coalesced",
      automate: false,
      reason: "autopilot strategy updated"
    });
    return workflow.goalCharter.autopilotStrategy;
  }

  listAutopilotPresets(): AutopilotPreset[] {
    return buildAutopilotPresets();
  }

  generateStrategicPlan(projectId: string) {
    const project = this.findProject(projectId);
    this.refreshUltimateGoalAssessmentIfChanged(project);
    const workflow = this.ensureWorkflowState(project.record);
    this.refreshWorkflowTaskMap(project);
    const context = this.buildWorkflowRecommendationContext(project);
    const modeConfig = getWorkflowModeConfig(workflow.workflowMode, resolveEffectiveAutopilotPolicy(workflow, project.record.localState.autopilotEnabled));
    const recommendations = (workflow.recommendations.length
      ? workflow.recommendations
      : buildWorkflowRecommendations(context)
        .map((entry) => sanitizeRecommendationForCycle(entry, { breadthLimit: modeConfig.breadthLimit }))
        .filter((entry): entry is ProjectWorkflowState["recommendations"][number] => Boolean(entry))
        .map((entry, index) => ({ ...entry, rank: index + 1 }))
    );
    const plan = buildStrategicPlan(this.collectStrategicPlannerInput(project, recommendations, context));
    const decision = decisionFromStrategicPlan(plan);
    workflow.strategicPlans = [plan, ...workflow.strategicPlans].slice(0, 30);
    workflow.plannerDecisions = [decision, ...workflow.plannerDecisions].slice(0, 50);
    workflow.checklistChanges = [
      ...plan.proposedChecklistChanges,
      ...workflow.checklistChanges.filter((change) => !plan.proposedChecklistChanges.some((entry) => entry.id === change.id))
    ].slice(0, 100);
    if (plan.proposedGoalChanges.length > 0) {
      const charter = this.ensureGoalCharterForWorkflow(workflow);
      charter.proposedGoalChanges = [
        ...plan.proposedGoalChanges,
        ...charter.proposedGoalChanges.filter((proposal) => !plan.proposedGoalChanges.some((entry) => entry.id === proposal.id))
      ].slice(0, 50);
      charter.updatedAt = nowIso();
    }
    this.recordWorkflowActivity(workflow, {
      source: "workflow",
      status: plan.continueRecommendation === "continue" ? "completed" : "waiting",
      title: "Strategic plan generated",
      detail: plan.plannerSummary,
      stepId: "recommendation"
    });
    this.syncWorkflowState(project);
    void this.persistProjectUpdate(project, {
      save: "deferred",
      emit: "coalesced",
      automate: false,
      reason: "strategic plan generated"
    });
    return plan;
  }

  selectNextWorkPackage(projectId: string): PlannerDecision {
    const project = this.findProject(projectId);
    const workflow = this.ensureWorkflowState(project.record);
    const existing = this.plannerDecisionForCycle(workflow);
    if (existing) {
      return existing;
    }
    this.generateStrategicPlan(projectId);
    return this.plannerDecisionForCycle(workflow) ?? {
      id: nanoid(),
      planId: "none",
      cycleNumber: workflow.workflowCycle.cycleNumber,
      whySelected: "No planner decision is available.",
      score: 0,
      scoreBreakdown: {},
      strategySettingsUsed: [],
      targetedChecklistIds: [],
      expectedFiles: [],
      expectedValidationCommands: [],
      approvalRequired: false,
      goalChangeProposalIds: [],
      checklistChangeIds: [],
      visualDesignImpact: false,
      createdAt: nowIso()
    };
  }

  async proposeGoalChange(projectId: string, proposal: GoalChangeRecord): Promise<GoalCharter> {
    const project = this.findProject(projectId);
    const workflow = this.ensureWorkflowState(project.record);
    const charter = this.ensureGoalCharterForWorkflow(workflow);
    const normalized: GoalChangeRecord = {
      ...proposal,
      id: proposal.id || nanoid(),
      source: proposal.source ?? "planner",
      fromGoalSummary: proposal.fromGoalSummary ?? charter.currentEffectiveGoal.summary,
      toGoalSummary: proposal.toGoalSummary ?? proposal.proposedGoal?.summary ?? proposal.summary,
      createdAt: proposal.createdAt ?? nowIso()
    };
    charter.proposedGoalChanges = [
      normalized,
      ...charter.proposedGoalChanges.filter((entry) => entry.id !== normalized.id)
    ].slice(0, 50);
    charter.updatedAt = nowIso();
    this.recordWorkflowActivity(workflow, {
      source: "workflow",
      status: "waiting",
      title: "Goal change proposed",
      detail: normalized.title,
      stepId: "recommendation"
    });
    await this.persistProjectUpdate(project, {
      save: "immediate",
      emit: "coalesced",
      automate: false,
      reason: "goal change proposed"
    });
    return charter;
  }

  async acceptGoalChange(projectId: string, proposalId: string): Promise<GoalCharter> {
    const project = this.findProject(projectId);
    const workflow = this.ensureWorkflowState(project.record);
    const charter = this.ensureGoalCharterForWorkflow(workflow);
    const proposal = charter.proposedGoalChanges.find((entry) => entry.id === proposalId);
    if (!proposal) {
      throw new Error(`Unknown goal change proposal: ${proposalId}`);
    }
    if (proposal.proposedGoal) {
      await this.updateUltimateGoal(projectId, proposal.proposedGoal, true);
      return this.getGoalCharter(projectId);
    }
    charter.acceptedGoalChanges = [
      {
        ...proposal,
        decidedAt: nowIso(),
        decisionNotes: "Accepted without changing the Current Effective Goal text."
      },
      ...charter.acceptedGoalChanges
    ].slice(0, 50);
    charter.proposedGoalChanges = charter.proposedGoalChanges.filter((entry) => entry.id !== proposalId);
    charter.updatedAt = nowIso();
    await this.persistProjectUpdate(project, {
      save: "immediate",
      emit: "coalesced",
      automate: false,
      reason: "goal change accepted"
    });
    return charter;
  }

  async rejectGoalChange(projectId: string, proposalId: string, decisionNotes?: string): Promise<GoalCharter> {
    const project = this.findProject(projectId);
    const workflow = this.ensureWorkflowState(project.record);
    const charter = this.ensureGoalCharterForWorkflow(workflow);
    const proposal = charter.proposedGoalChanges.find((entry) => entry.id === proposalId);
    if (!proposal) {
      throw new Error(`Unknown goal change proposal: ${proposalId}`);
    }
    charter.rejectedGoalChanges = [
      {
        ...proposal,
        decidedAt: nowIso(),
        decisionNotes: decisionNotes ?? "Rejected by the user."
      },
      ...charter.rejectedGoalChanges
    ].slice(0, 50);
    charter.proposedGoalChanges = charter.proposedGoalChanges.filter((entry) => entry.id !== proposalId);
    charter.updatedAt = nowIso();
    this.recordWorkflowActivity(workflow, {
      source: "workflow",
      status: "completed",
      title: "Goal change rejected",
      detail: proposal.title,
      stepId: "recommendation"
    });
    await this.persistProjectUpdate(project, {
      save: "immediate",
      emit: "coalesced",
      automate: false,
      reason: "goal change rejected"
    });
    return charter;
  }

  listChecklistChanges(projectId: string): ChecklistChange[] {
    return this.ensureWorkflowState(this.findProject(projectId).record).checklistChanges;
  }

  getPlannerDecision(projectId: string, cycleId: string): PlannerDecision | undefined {
    const project = this.findProject(projectId);
    const cycleNumber = Number.parseInt(cycleId, 10);
    if (!Number.isFinite(cycleNumber) || cycleNumber <= 0) {
      throw new Error(`Unknown workflow cycle: ${cycleId}`);
    }
    return this.cyclePlannerDecision(project, cycleNumber);
  }

  getCycleRetrospective(projectId: string, cycleId: string): CycleRetrospective | undefined {
    const project = this.findProject(projectId);
    const cycleNumber = Number.parseInt(cycleId, 10);
    if (!Number.isFinite(cycleNumber) || cycleNumber <= 0) {
      throw new Error(`Unknown workflow cycle: ${cycleId}`);
    }
    return project.record.workflow.cycleRetrospectives.find((entry) => entry.cycleNumber === cycleNumber);
  }

  private goalChanged(left: UltimateGoal, right: UltimateGoal): boolean {
    return JSON.stringify({
      summary: left.summary,
      detailedIntent: left.detailedIntent,
      successCriteria: left.successCriteria,
      constraints: left.constraints,
      nonGoals: left.nonGoals,
      targetAudience: left.targetAudience,
      qualityBar: left.qualityBar
    }) !== JSON.stringify({
      summary: right.summary,
      detailedIntent: right.detailedIntent,
      successCriteria: right.successCriteria,
      constraints: right.constraints,
      nonGoals: right.nonGoals,
      targetAudience: right.targetAudience,
      qualityBar: right.qualityBar
    });
  }

  private addGoalChangeRecord(
    records: GoalChangeRecord[],
    input: Omit<GoalChangeRecord, "id" | "createdAt" | "decidedAt">
  ): GoalChangeRecord[] {
    const now = nowIso();
    return [
      {
        id: nanoid(),
        createdAt: now,
        decidedAt: now,
        ...input
      },
      ...records
    ].slice(0, 50);
  }

  private applyConfirmedGoalToCharter(workflow: ProjectWorkflowState, goal: UltimateGoal): void {
    const charter = this.ensureGoalCharterForWorkflow(workflow);
    const previousCurrent = charter.currentEffectiveGoal;
    const originalWasSet = hasMeaningfulUltimateGoal(charter.originalUltimateGoal);
    const matchingProposal = charter.proposedGoalChanges.find((change) =>
      change.proposedGoal && this.goalChanged(change.proposedGoal, goal) === false
    );

    if (!originalWasSet) {
      charter.originalUltimateGoal = goal;
      charter.createdAt = charter.createdAt === new Date(0).toISOString() ? nowIso() : charter.createdAt;
    }
    charter.currentEffectiveGoal = goal;
    charter.nonNegotiableRequirements = charter.nonNegotiableRequirements.length
      ? charter.nonNegotiableRequirements
      : [...goal.successCriteria];
    charter.userConstraints = charter.userConstraints.length ? charter.userConstraints : [...goal.constraints];
    charter.explicitNonGoals = charter.explicitNonGoals.length ? charter.explicitNonGoals : [...goal.nonGoals];
    charter.definitionOfDone = charter.definitionOfDone.length ? charter.definitionOfDone : [...goal.successCriteria];

    if (matchingProposal) {
      charter.acceptedGoalChanges = [
        {
          ...matchingProposal,
          decidedAt: nowIso(),
          decisionNotes: "Accepted as the Current Effective Goal."
        },
        ...charter.acceptedGoalChanges
      ].slice(0, 50);
      charter.proposedGoalChanges = charter.proposedGoalChanges.filter((change) => change.id !== matchingProposal.id);
    } else if (originalWasSet && this.goalChanged(previousCurrent, goal)) {
      charter.acceptedGoalChanges = this.addGoalChangeRecord(charter.acceptedGoalChanges, {
        title: "Updated Current Effective Goal",
        summary: goal.summary,
        rationale: "The user confirmed an updated Ultimate Goal.",
        source: "user",
        proposedGoal: goal,
        fromGoalSummary: previousCurrent.summary,
        toGoalSummary: goal.summary,
        decisionNotes: "Accepted by direct user confirmation."
      });
    }
    charter.updatedAt = nowIso();
  }

  async updateUltimateGoal(
    projectId: string,
    goal: Omit<UltimateGoal, "confirmedAt" | "lastUpdatedAt">,
    confirm = true
  ): Promise<UltimateGoal> {
    const project = this.findProject(projectId);
    const workflow = this.ensureWorkflowState(project.record);
    const updatedGoal = ultimateGoalSchema.parse({
      ...goal,
      source: confirm ? "user" : goal.source,
      confirmedAt: confirm ? workflow.ultimateGoal.confirmedAt ?? nowIso() : undefined,
      lastUpdatedAt: nowIso()
    });

    workflow.ultimateGoal = updatedGoal;
    if (confirm) {
      this.applyConfirmedGoalToCharter(workflow, updatedGoal);
    } else {
      workflow.goalCharter = this.ensureGoalCharterForWorkflow(workflow);
      workflow.goalCharter.updatedAt = nowIso();
    }
    workflow.goalChecklist = buildGoalChecklistFromUltimateGoal(updatedGoal, workflow.goalChecklist);
    this.refreshWorkflowTaskMap(project);
    workflow.ultimateGoalProgress = undefined;
    workflow.ultimateGoalCompletion = undefined;
    workflow.appeal = defaultWorkflowAppealState();
    if (confirm) {
      workflow.ultimateGoalDraft = undefined;
      this.resetWorkflowRepairState(workflow);
      this.updateWorkflowStepProgress(workflow, "ultimate_goal", {
        requiresUserInput: false,
        currentActivity: "Ultimate Goal confirmed",
        message: "The workflow can now continue automatically.",
        latestProgressNote: updatedGoal.summary
      }, { status: "completed" });
      this.resetWorkflowStepProgress(workflow, "recommendation", {
        status: "waiting",
        requiresUserInput: false,
        currentActivity: "Queued for recommendation generation",
        message: "Preparing recommendation options."
      });
      this.resetWorkflowStepProgress(workflow, "goal_plan");
      this.resetWorkflowStepProgress(workflow, "coding");
      this.resetWorkflowStepProgress(workflow, "integrity");
      this.resetWorkflowStepProgress(workflow, "merge");
      this.recordAcceptedDecision(workflow, {
        kind: "ultimate_goal",
        title: updatedGoal.summary || "Ultimate goal updated",
        summary: updatedGoal.detailedIntent,
        cycleNumber: workflow.workflowCycle.cycleNumber
      });
      this.recordWorkflowActivity(workflow, {
        source: "workflow",
        status: "completed",
        title: "Confirmed the Ultimate Goal",
        detail: updatedGoal.summary,
        stepId: "ultimate_goal"
      });
    } else {
      this.updateWorkflowStepProgress(workflow, "ultimate_goal", {
        requiresUserInput: true,
        currentActivity: "Ultimate Goal draft saved",
        message: "Confirm the draft before the workflow relies on it."
      }, { status: "waiting" });
      this.recordWorkflowActivity(workflow, {
        source: "workflow",
        status: "waiting",
        title: "Saved an Ultimate Goal draft",
        detail: updatedGoal.summary,
        stepId: "ultimate_goal"
      });
    }
    this.syncWorkflowState(project);
    await this.persistProjectUpdate(project, {
      save: "immediate",
      emit: "coalesced",
      automate: confirm,
      reason: confirm ? "ultimate goal confirmed" : "ultimate goal draft saved"
    });
    return updatedGoal;
  }

  async detectUltimateGoal(projectId: string): Promise<UltimateGoal> {
    const project = this.findProject(projectId);
    const draft = this.applyDetectedUltimateGoalDraft(project, this.buildFallbackUltimateGoalDraft(project));
    const workflow = this.ensureWorkflowState(project.record);
    this.updateWorkflowStepProgress(workflow, "ultimate_goal", {
      requiresUserInput: true,
      currentActivity: "Drafting the Ultimate Goal",
      message: "A detected draft is ready for confirmation.",
      latestProgressNote: draft.summary
    }, { status: "waiting" });
    this.recordWorkflowActivity(workflow, {
      source: "workflow",
      status: "waiting",
      title: "Detected an Ultimate Goal draft",
      detail: draft.summary,
      stepId: "ultimate_goal"
    });
    await this.persistProjectUpdate(project);

    if (!this.isProjectMeaningfullyEmpty(project) && this.transport && this.codexAvailability.source !== "unavailable") {
      void this.startUltimateGoalDetectionAgent(project).catch((error) => {
        this.diagnostics.unshift(`Ultimate goal detection agent failed to start. ${error instanceof Error ? error.message : String(error)}`);
        this.emitState();
      });
    }

    return draft;
  }

  async importUltimateGoalText(projectId: string, filePath: string): Promise<UltimateGoalImportPreview> {
    this.findProject(projectId);
    return await readUltimateGoalTextImport(filePath);
  }

  private buildRecommendationOutputSchema(): JsonValue {
    return {
      type: "object",
      additionalProperties: false,
      required: ["summary", "ultimateGoalProgress", "ultimateGoalCompletion", "recommendations", "goalCheckUpdates"],
      properties: {
        summary: { type: "string" },
        ultimateGoalProgress: {
          type: "object",
          additionalProperties: false,
          required: ["percentComplete", "rationale"],
          properties: {
            percentComplete: { type: "integer", minimum: 0, maximum: 100 },
            rationale: { type: "string", maxLength: 300 }
          }
        },
        ultimateGoalCompletion: {
          type: "object",
          additionalProperties: false,
          required: ["state", "rationale"],
          properties: {
            state: {
              type: "string",
              enum: ["needs_more_work", "goal_satisfied"]
            },
            rationale: { type: "string", maxLength: 260 }
          }
        },
        recommendations: {
          type: "array",
          minItems: 0,
          maxItems: 5,
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "title",
              "summary",
              "rationale",
              "expectedImpact",
              "priority",
              "confidence",
              "estimatedScope",
              "riskLevel",
              "relatedPaths"
            ],
            properties: {
              title: { type: "string", maxLength: 140 },
              summary: { type: "string", maxLength: 280 },
              rationale: { type: "string", maxLength: 280 },
              expectedImpact: { type: "string", maxLength: 220 },
              priority: { type: "string", enum: ["high", "medium", "low"] },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              estimatedScope: { type: "string", enum: ["small", "medium", "large"] },
              riskLevel: { type: "string", enum: ["low", "medium", "high"] },
              relatedPaths: {
                type: "array",
                maxItems: 5,
                items: { type: "string", maxLength: 180 }
              }
            }
          }
        },
        goalCheckUpdates: {
          type: "array",
          minItems: 0,
          maxItems: 30,
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "action",
              "id",
              "title",
              "description",
              "required",
              "itemKind",
              "status",
              "confidence",
              "evidence",
              "relatedPaths"
            ],
            properties: {
              action: { type: ["string", "null"], enum: ["add", "update", "remove", null] },
              id: { type: ["string", "null"] },
              title: { type: "string", maxLength: 180 },
              description: { type: ["string", "null"], maxLength: 240 },
              required: { type: ["boolean", "null"] },
              itemKind: { type: ["string", "null"], enum: ["required", "backlog", "observation", null] },
              status: { type: "string", enum: ["unknown", "unmet", "met", "not_applicable"] },
              confidence: { type: ["number", "null"], minimum: 0, maximum: 1 },
              evidence: { type: "string", maxLength: 260 },
              promotionReason: { type: ["string", "null"], maxLength: 220 },
              relatedPaths: {
                type: "array",
                maxItems: 5,
                items: { type: "string", maxLength: 180 }
              }
            }
          }
        }
      }
    } satisfies JsonValue;
  }

  private buildWorkflowRecommendationContext(
    project: LoadedProject,
    customFocus?: string
  ): WorkflowRecommendationContext {
    const workflow = this.ensureWorkflowState(project.record);
    return {
      workflow,
      agents: project.record.agents,
      scan: project.scan,
      overview: project.record.overview,
      customFocus,
      objective: project.record.localState.workflowObjective,
      maxOptions: workflow.workflowBudgets.maxRecommendationOptions
    };
  }

  private shouldQueueAppealPass(
    context: WorkflowRecommendationContext,
    goalCompletion: Pick<NonNullable<ProjectWorkflowState["ultimateGoalCompletion"]>, "state">
  ): boolean {
    const modeConfig = getWorkflowModeConfig(context.workflow.workflowMode, resolveEffectiveAutopilotPolicy(context.workflow));
    return context.objective === "deliver" &&
      modeConfig.finalAppealEnabled &&
      goalCompletion.state === "goal_satisfied" &&
      context.workflow.appeal.status !== "completed" &&
      context.workflow.appeal.status !== "not_applicable" &&
      isVisualProject(context);
  }

  private buildRecommendationCycleAim(context: WorkflowRecommendationContext): {
    currentSubstep: string;
    latestProgressNote: string;
  } {
    const checklist = buildGoalChecklistForAssessment(context);
    const requiredChecks = checklist.filter((check) => check.required && check.status !== "not_applicable");
    const openChecks = requiredChecks
      .filter((check) => check.status !== "met")
      .slice(0, 4)
      .map((check) => check.title);

    if (openChecks.length > 0) {
      return {
        currentSubstep: `Aiming to choose the next coherent task group; priority checks include: ${openChecks.join("; ")}`,
        latestProgressNote: `${openChecks.length} representative open check${openChecks.length === 1 ? "" : "s"} in view for task grouping`
      };
    }

    return {
      currentSubstep: requiredChecks.length > 0
        ? "Aiming to verify whether all required checks are evidenced enough to stop"
        : "Aiming to establish the minimal required checklist and next bounded step",
      latestProgressNote: requiredChecks.length > 0
        ? `${requiredChecks.length} required check${requiredChecks.length === 1 ? "" : "s"} currently have no open checklist item in the prompt excerpt`
        : "No required checklist has been established yet"
    };
  }

  private buildRecommendationPrompt(project: LoadedProject, customFocus?: string): string {
    this.refreshUltimateGoalAssessmentIfChanged(project);
    const workflow = this.ensureWorkflowState(project.record);
    const workflowObjective = project.record.localState.workflowObjective;
    const recommendationContext = this.buildWorkflowRecommendationContext(project, customFocus);
    const previewRequest = getWorkflowPreviewRequest(workflow);
    const previewMode = !customFocus && (previewRequest.status === "queued" || previewRequest.status === "active");
    const appealPassPending =
      workflowObjective === "deliver" &&
      workflow.ultimateGoalCompletion?.state === "goal_satisfied" &&
      workflow.appeal.status !== "completed" &&
      workflow.appeal.status !== "not_applicable" &&
      isVisualProject(recommendationContext);
    const openIssues = workflow.memory.knownOpenIssues
      .filter((issue) => issue.status === "open")
      .slice(0, 3)
      .map((issue) => `- ${issue.title}: ${compactText(issue.detail, MAX_RECOMMENDATION_PROMPT_DETAIL_LENGTH)}`);
    const recentActivity = workflow.activityLog
      .slice(0, 4)
      .map((event) => `- [${event.source}] ${event.title}${event.detail ? `: ${compactText(event.detail, MAX_RECOMMENDATION_PROMPT_DETAIL_LENGTH)}` : ""}`);
    const recentChangedFiles = [...new Set(
      project.record.agents
        .slice()
        .sort((left, right) => {
          const leftTime = left.lastActivityAt ? new Date(left.lastActivityAt).getTime() : 0;
          const rightTime = right.lastActivityAt ? new Date(right.lastActivityAt).getTime() : 0;
          return rightTime - leftTime;
        })
        .flatMap((agent) => agent.changedFiles)
    )].slice(0, 8);
    const allGoalChecklist = buildGoalChecklistForAssessment(recommendationContext);
    const requiredGoalChecklist = allGoalChecklist.filter((check) => check.required && check.status !== "not_applicable");
    const goalChecklist = requiredGoalChecklist
      .slice(0, MAX_RECOMMENDATION_PROMPT_CHECKLIST_ITEMS)
      .map((check) => {
        const evidence = check.status === "unknown" ? "" : check.evidence;
        return `- [${check.status}] ${compactText(check.title, 180)}${evidence ? ` -- ${compactText(evidence, MAX_RECOMMENDATION_PROMPT_DETAIL_LENGTH)}` : ""}`;
      });
    const outcomeStrategyBrief = buildOutcomeStrategyBrief(recommendationContext);
    const checklistTaskMapBrief = buildChecklistTaskMapBrief(recommendationContext);
    const relevantPriorContext = this.selectAndRememberRelevantContext(
      project,
      "recommendation",
      [
        customFocus ?? "",
        workflow.ultimateGoal.summary,
        workflow.ultimateGoal.detailedIntent,
        workflow.approvedRecommendation?.title ?? "",
        workflow.scopedGoal?.summary ?? "",
        goalChecklist.join("\n"),
        openIssues.join("\n")
      ].join("\n"),
      recentChangedFiles
    );

    return [
      workflowObjective === "optimize"
        ? "Inspect the active project and recommend the next bounded optimization tasks for the workflow."
        : previewMode
          ? "Inspect the active project and recommend the next bounded preview checkpoint for the workflow."
        : appealPassPending
          ? "Inspect the active project and recommend the final bounded appeal pass for the workflow."
        : "Inspect the active project and recommend the next bounded tasks for the workflow.",
      workflowObjective === "optimize"
        ? "The project is in optimize mode. Treat the current product as a working baseline and look for the next small improvement in correctness, UX, aesthetics for visual surfaces, performance/resource use, maintainability, or test coverage."
        : previewMode
          ? "Preview mode is active. Recommend work that makes the current app/project structure visible or runnable for inspection, then stops at a checkpoint. This is not final completion."
        : appealPassPending
          ? "The base Ultimate Goal appears satisfied and this looks like an app, website, platform, or other visual experience. Return one to three small recommendations focused on visual appeal, user-facing polish, clarity, responsive behavior, or interaction quality. This is a final appeal pass before deliver-goal mode stops."
        : "First decide whether the Ultimate Goal is already satisfied strongly enough that the workflow should stop opening new cycles. If it is, mark the goal as satisfied and return zero recommendations.",
      workflowObjective === "optimize"
        ? "Return 1 to 5 recommendations."
        : previewMode
          ? "Return 1 to 3 preview-oriented recommendations. Prefer the generated runnable preview checkpoint if it fits the repo."
        : appealPassPending
          ? "Return 1 to 3 recommendations for the final appeal pass."
        : "Return 0 to 5 recommendations.",
      "Output terse JSON only. No greetings, markdown, filler, or restating unchanged logs/checklists.",
      "Return exactly one JSON object with top-level fields summary, ultimateGoalProgress, ultimateGoalCompletion, recommendations, and goalCheckUpdates. ultimateGoalProgress has percentComplete and rationale. ultimateGoalCompletion has state and rationale. Each recommendation has title, summary, rationale, expectedImpact, priority, confidence, estimatedScope, riskLevel, and relatedPaths. Each goalCheckUpdate has action, id, title, description, required, itemKind, status, confidence, evidence, relatedPaths, and optional promotionReason; use null for nullable fields when absent. Do not include ids, ranks, or other properties on recommendations.",
      "Plan like a small SWE team. Checklist items are acceptance checks; a cycle is the next coherent task group based on shared paths, tests, evidence, user value, and blocking order.",
      "Recommendations must be concrete single-cycle tasks. Use medium scope for cohesive batches, small only for isolated checks, and split unrelated or umbrella work.",
      "If required checks are unmet/unknown, rank the next coherent required-check group ahead of generic stabilization unless a real blocker exists. Do not claim met without repository evidence or validation output.",
      "For live-data, trading, brokerage, market-data, analytics, or finance interfaces, prefer a provider abstraction with offline demo/mock mode, credentialed live adapter mode, and loading/error/empty states. Paid credentials require operator choice.",
      previewMode
        ? "Preview behavior: favor UI shell, route/page/screen structure, visible Workflow tab or current product state, explicit empty states, demo/offline states, mock-provider labels, loading/error/missing-credential states, visible integration points, and a buildable preview path. Do not require paid services, add secrets, fake live data, or claim final completion."
        : "",
      "Checklist governance: return goalCheckUpdates only for changed items. Add required checks only when indispensable, set itemKind to backlog or observation for suggestions/polish, consolidate duplicates, mark redundant/non-goal/user-derived removals as not_applicable, and keep evidence concise.",
      "Promotion rule: a new agent-suggested item becomes itemKind required only when it derives from the Ultimate Goal, explicit operator feedback, a hard blocker, a validation/integrity failure that prevents completion, or a security/credential/runtime-safety issue.",
      "Completion: percentComplete is met required checks divided by total required checks. goal_satisfied requires every required check met and no open blocker.",
      workflowObjective === "optimize"
        ? "If the Ultimate Goal already looks satisfied, say so in the goal-completion assessment and still recommend the next bounded improvement instead of stopping."
        : previewMode
          ? "Keep preview evidence separate from checklist completion unless repository evidence truly satisfies a required check. Do not set goal_satisfied just because a preview exists."
        : appealPassPending
          ? "Keep the goal-completion assessment set to goal_satisfied, but do not return an empty recommendations array for this appeal pass."
        : "If the Ultimate Goal is satisfied, set the goal-completion assessment to goal_satisfied and leave the recommendations array empty.",
      "Use only relative project paths in relatedPaths.",
      customFocus
        ? "Stay tightly anchored to the custom recommendation focus from the operator. Reword it into bounded alternatives and closely related next steps instead of drifting into unrelated repo work."
        : "",
      "Use the deterministic outcome strategy below as the decision frame. It is guidance, not a license to ignore concrete repository evidence.",
      outcomeStrategyBrief,
      "Use the checklist task map below to decompose large goals into coherent task cycles without putting the whole checklist into the agent context.",
      checklistTaskMapBrief,
      "Use the relevant prior context below when it is directly applicable. Do not replay old logs; carry forward only the selected summaries, decisions, paths, and unresolved issues. Current checklist counts in this prompt override any historical progress counts.",
      relevantPriorContext,
      "",
      `Project: ${project.record.identity.projectName}`,
      `Project kind: ${project.scan.kind}`,
      `Workflow objective: ${workflowObjective === "optimize"
        ? "Optimize the current project after the base goal is working."
        : appealPassPending
          ? "Run one final appeal pass before stopping because the base goal is satisfied."
          : "Stop once the stated Ultimate Goal is satisfied."}`,
      `Ultimate Goal: ${compactText(workflow.ultimateGoal.summary, 520)}`,
      customFocus ? `Custom recommendation focus from the operator: ${compactText(customFocus, 360)}` : "",
      workflow.ultimateGoal.detailedIntent ? `Detailed intent: ${compactText(workflow.ultimateGoal.detailedIntent, 650)}` : "",
      workflow.workflowCycle.cycleNumber > 1 ? `Current cycle: ${workflow.workflowCycle.cycleNumber}` : "",
      workflow.memory.perCycleSummaries[0]?.summary ? `Most recent completed cycle: ${workflow.memory.perCycleSummaries[0].summary}` : "",
      workflow.approvedRecommendation?.title ? `Previous approved recommendation: ${workflow.approvedRecommendation.title}` : "",
      workflow.scopedGoal?.summary ? `Previous scoped goal: ${workflow.scopedGoal.summary}` : "",
      project.record.overview?.summary ? `Repository overview: ${compactText(project.record.overview.summary, 520)}` : "",
      project.record.overview?.importantToKnowFirst ? `Important to know first: ${compactText(project.record.overview.importantToKnowFirst, 360)}` : "",
      project.scan.stats.entryPoints.length ? `Entry points: ${project.scan.stats.entryPoints.slice(0, 6).join(", ")}` : "",
      recentChangedFiles.length ? `Recently changed files: ${recentChangedFiles.join(", ")}` : "",
      `Goal checklist size: ${requiredGoalChecklist.length} required, ${allGoalChecklist.length} total. The list below is a prioritized prompt excerpt, not permission to ignore hidden required checks.`,
      goalChecklist.length ? `Goal checklist:\n${goalChecklist.join("\n")}` : "Goal checklist: none established yet",
      openIssues.length ? `Open issues:\n${openIssues.join("\n")}` : "Open issues: none",
      recentActivity.length ? `Recent activity:\n${recentActivity.join("\n")}` : ""
    ]
      .filter((entry) => entry.trim().length > 0)
      .join("\n\n");
  }

  private extractCustomRecommendationFocus(agent: AgentState): string | undefined {
    const match = agent.taskPrompt.match(/Custom recommendation focus from the operator:\s*(.+)/);
    return match?.[1]?.trim();
  }

  private parseRecommendationProgress(
    value: unknown
  ): Pick<UltimateGoalProgressEstimate, "percentComplete" | "rationale"> | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }

    const percentComplete = (value as { percentComplete?: unknown }).percentComplete;
    const rationale = typeof (value as { rationale?: unknown }).rationale === "string"
      ? (value as { rationale: string }).rationale.trim()
      : "";
    if (typeof percentComplete !== "number" || !Number.isFinite(percentComplete) || !rationale) {
      return undefined;
    }

    return {
      percentComplete: Math.max(0, Math.min(100, Math.round(percentComplete))),
      rationale
    };
  }

  private parseRecommendationCompletionAssessment(
    value: unknown
  ): Pick<NonNullable<ProjectWorkflowState["ultimateGoalCompletion"]>, "state" | "rationale"> | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }

    const state = (value as { state?: unknown }).state;
    const rationale = typeof (value as { rationale?: unknown }).rationale === "string"
      ? (value as { rationale: string }).rationale.trim()
      : "";
    if ((state !== "needs_more_work" && state !== "goal_satisfied") || !rationale) {
      return undefined;
    }

    return {
      state,
      rationale
    };
  }

  private parseGoalCheckUpdates(project: LoadedProject, value: unknown): GoalCheckUpdateInput[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.flatMap((entry): GoalCheckUpdateInput[] => {
      if (!entry || typeof entry !== "object") {
        return [];
      }
      const record = entry as Record<string, unknown>;
      const title = typeof record.title === "string" ? record.title.trim() : "";
      if (!title) {
        return [];
      }
      const status = record.status;
      if (status !== "unknown" && status !== "unmet" && status !== "met" && status !== "not_applicable") {
        return [];
      }
      const action = record.action;
      const normalizedAction = action === "add" || action === "update" || action === "remove" ? action : undefined;
      const itemKind = record.itemKind === "required" || record.itemKind === "backlog" || record.itemKind === "observation"
        ? record.itemKind
        : undefined;
      const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : undefined;
      let normalizedStatus: NonNullable<GoalCheckUpdateInput["status"]> = status;
      let evidence = typeof record.evidence === "string" ? record.evidence.trim() : "";
      const relatedPaths = this.sanitizeRelatedPaths(project, record.relatedPaths);
      const existingCheck = this.findGoalCheckForUpdate(project, id, title);
      const checkForEvidence = existingCheck ?? {
        title,
        description: typeof record.description === "string" ? record.description.trim() : "",
        source: "agent" as const
      };
      if (
        normalizedStatus === "met" &&
        this.shouldDowngradeGenericMetGoalCheckEvidence(checkForEvidence, evidence, relatedPaths)
      ) {
        normalizedStatus = "unknown";
        evidence = "Generic completion evidence did not directly support this checklist item, so it remains unknown after resume-safe validation.";
      }
      return [
        {
          action: normalizedAction,
          id,
          title,
          description: typeof record.description === "string" ? record.description.trim() : undefined,
          required: typeof record.required === "boolean" ? record.required : undefined,
          itemKind,
          status: normalizedStatus,
          confidence: typeof record.confidence === "number" && Number.isFinite(record.confidence)
            ? Math.max(0, Math.min(1, record.confidence))
            : undefined,
          evidence,
          relatedPaths,
          promotionReason: typeof record.promotionReason === "string" ? record.promotionReason.trim() : undefined
        }
      ];
    }).slice(0, 30);
  }

  private classifyStructuredRecommendationFailure(message: string): StructuredRecommendationFailureCategory {
    if (/invalid enum|received ['"]?[^'"]+['"]?/i.test(message)) {
      return "unknown_enum";
    }
    if (/required|missing|required/i.test(message)) {
      return "missing_required_field";
    }
    if (/expected|received|type/i.test(message)) {
      return "wrong_type";
    }
    if (/recommendations.*empty|empty recommendations/i.test(message)) {
      return "empty_recommendations";
    }
    if (/schema|parse/i.test(message)) {
      return "schema_mismatch";
    }
    return "other";
  }

  private rememberRecommendationParseFailure(
    category: StructuredRecommendationFailureCategory,
    message: string
  ): void {
    this.lastRecommendationParseFailure = {
      category,
      message: compactText(message, 700)
    };
  }

  private parseRecommendationOutput(
    project: LoadedProject,
    rawText: string
  ): {
    summary: string;
    ultimateGoalProgress?: Pick<UltimateGoalProgressEstimate, "percentComplete" | "rationale">;
    ultimateGoalCompletion?: Pick<NonNullable<ProjectWorkflowState["ultimateGoalCompletion"]>, "state" | "rationale">;
    goalCheckUpdates: GoalCheckUpdateInput[];
    recommendations: ProjectWorkflowState["recommendations"];
  } | undefined {
    this.lastRecommendationParseFailure = undefined;
    const workflow = this.ensureWorkflowState(project.record);
    const modeConfig = getWorkflowModeConfig(workflow.workflowMode, resolveEffectiveAutopilotPolicy(workflow, project.record.localState.autopilotEnabled));
    const parsedObjects = this.extractJsonObjects(rawText).reverse();
    if (parsedObjects.length === 0) {
      this.rememberRecommendationParseFailure("invalid_json", "No complete JSON object was found in the recommendation output.");
      return undefined;
    }
    const failures: string[] = [];
    for (const parsed of parsedObjects) {
      if (typeof parsed.summary !== "string" || !Array.isArray(parsed.recommendations)) {
        failures.push("Missing or invalid top-level summary/recommendations fields.");
        continue;
      }

      try {
        const ultimateGoalProgress = this.parseRecommendationProgress((parsed as { ultimateGoalProgress?: unknown }).ultimateGoalProgress);
        const ultimateGoalCompletion = this.parseRecommendationCompletionAssessment(
          (parsed as { ultimateGoalCompletion?: unknown }).ultimateGoalCompletion
        );
        const goalCheckUpdatesPayload = (parsed as { goalCheckUpdates?: unknown }).goalCheckUpdates;
        if (!ultimateGoalProgress || !ultimateGoalCompletion) {
          failures.push("Missing or invalid ultimateGoalProgress/ultimateGoalCompletion fields.");
          continue;
        }
        const recommendations = parsed.recommendations
          .slice(0, 5)
          .map((entry, index) => workflowRecommendationOptionSchema.parse({
            ...(entry as Record<string, unknown>),
            id: nanoid(),
            rank: index + 1,
            estimatedScope: (entry as { estimatedScope?: unknown }).estimatedScope ?? "small",
            relatedPaths: this.sanitizeRelatedPaths(project, (entry as { relatedPaths?: unknown }).relatedPaths)
          }))
          .map((entry) => sanitizeRecommendationForCycle(entry, { breadthLimit: modeConfig.breadthLimit }))
          .filter((entry): entry is ProjectWorkflowState["recommendations"][number] => Boolean(entry))
          .map((entry, index) => ({
            ...entry,
            rank: index + 1
          }));
        const goalCheckUpdates = this.parseGoalCheckUpdates(project, goalCheckUpdatesPayload);

        return {
          summary: parsed.summary.trim(),
          ultimateGoalProgress,
          ultimateGoalCompletion,
          goalCheckUpdates,
          recommendations
        };
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
        // Try the next complete object in the message.
      }
    }

    const failureMessage = failures[0] ?? "Recommendation JSON did not match the expected schema.";
    this.rememberRecommendationParseFailure(this.classifyStructuredRecommendationFailure(failureMessage), failureMessage);
    return undefined;
  }

  private recommendationDeduplicationKey(recommendation: ProjectWorkflowState["recommendations"][number]): string {
    const explicitGoalCheckTarget = recommendation.title.match(/^Satisfy (?:goal (?:check|batch)|work package):\s*(.+)$/i)?.[1]?.trim();
    return explicitGoalCheckTarget
      ? `goal:${this.normalizeGoalCheckMatchText(explicitGoalCheckTarget)}`
      : `title:${this.normalizeGoalCheckMatchText(recommendation.title)}`;
  }

  private ensureChecklistRecommendationsLead(
    context: WorkflowRecommendationContext,
    recommendations: ProjectWorkflowState["recommendations"],
    deterministicRecommendations: ProjectWorkflowState["recommendations"]
  ): ProjectWorkflowState["recommendations"] {
    const previewRequest = getWorkflowPreviewRequest(context.workflow);
    if (previewRequest.status === "queued" || previewRequest.status === "active") {
      const previewRecommendations = [...deterministicRecommendations, ...recommendations].filter(isPreviewRecommendation);
      if (previewRecommendations.length > 0) {
        const seen = new Set<string>();
        return [...previewRecommendations, ...recommendations, ...deterministicRecommendations]
          .filter((recommendation) => {
            const key = this.recommendationDeduplicationKey(recommendation);
            if (seen.has(key)) {
              return false;
            }
            seen.add(key);
            return true;
          })
          .slice(0, Math.max(1, Math.min(context.maxOptions, 5)))
          .map((recommendation, index) => ({
            ...recommendation,
            rank: index + 1
          }));
      }
    }

    if (context.customFocus?.trim()) {
      return recommendations.map((recommendation, index) => ({ ...recommendation, rank: index + 1 }));
    }

    const checklistRecommendations = deterministicRecommendations.filter((recommendation) =>
      /^Satisfy (?:goal (?:check|batch)|work package):/i.test(recommendation.title)
    );
    if (checklistRecommendations.length === 0) {
      return recommendations.map((recommendation, index) => ({ ...recommendation, rank: index + 1 }));
    }

    const seen = new Set<string>();
    return [...checklistRecommendations, ...recommendations]
      .filter((recommendation) => {
        const key = this.recommendationDeduplicationKey(recommendation);
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      })
      .slice(0, Math.max(1, Math.min(context.maxOptions, 5)))
      .map((recommendation, index) => ({
        ...recommendation,
        rank: index + 1
      }));
  }

  private strategicValidationCommands(project: LoadedProject): string[] {
    const managers = project.scan.stats.primaryManagers.map((manager) => manager.toLowerCase());
    if (managers.includes("npm") || project.scan.stats.manifestFiles.some((file) => file.endsWith("package.json"))) {
      return ["npm run typecheck", "npm run lint", "npm test", "npm run build"];
    }
    if (managers.includes("python") || project.scan.stats.manifestFiles.some((file) => /pyproject\.toml|requirements\.txt$/i.test(file))) {
      const hasPytestManifest = project.scan.stats.manifestFiles.some((file) => /requirements.*\.txt|pyproject\.toml|setup\.cfg|tox\.ini/i.test(file)) &&
        project.record.dependencies.some((dependency) => dependency.name.toLowerCase() === "pytest");
      return hasPytestManifest
        ? ["PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m pytest"]
        : ["PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m unittest discover -s tests -q"];
    }
    return ["Run the project-supported deterministic verification commands"];
  }

  private collectStrategicPlannerInput(
    project: LoadedProject,
    recommendations: ProjectWorkflowState["recommendations"],
    context: WorkflowRecommendationContext,
    options: { timestamp?: string; sourceAgentId?: string } = {}
  ): StrategicPlannerInput {
    const workflow = this.ensureWorkflowState(project.record);
    const recentAgents = project.record.agents
      .filter((agent) => agent.category !== "manual")
      .slice()
      .sort((left, right) => toTime(right.lastActivityAt ?? right.completedAt ?? right.createdAt) - toTime(left.lastActivityAt ?? left.completedAt ?? left.createdAt))
      .slice(0, 8);
    const failedCommands = unique(recentAgents.flatMap((agent) =>
      agent.commandLog
        .filter((command) => command.status === "failed" || (typeof command.exitCode === "number" && command.exitCode !== 0))
        .map((command) => command.command)
    ));
    const changedFiles = unique(recentAgents.flatMap((agent) => agent.changedFiles));
    const recentAgentOutputs = unique(recentAgents.map((agent) =>
      agent.recommendationReport?.summary ??
      agent.integrityReport?.summary ??
      agent.mergeReport?.summary ??
      agent.lastMessageSnippet
    ).filter((entry): entry is string => Boolean(entry?.trim()))).map((entry) => compactText(entry, 300));
    const architectureNotes = unique([
      project.record.overview?.architecture,
      project.scan.stats.explanation,
      ...project.scan.stats.entryPoints.slice(0, 6),
      ...(project.record.overview?.importantFiles.slice(0, 6) ?? [])
    ].filter((entry): entry is string => Boolean(entry?.trim()))).map((entry) => compactText(entry, 300));
    return {
      projectId: project.record.id,
      workflow,
      recommendations,
      workPackages: workflow.workPackages,
      isVisualProject: isVisualProject(context),
      repoScanStatus: `${project.scan.kind} scan with ${project.scan.files.length} indexed file${project.scan.files.length === 1 ? "" : "s"} and entry points ${project.scan.stats.entryPoints.slice(0, 4).join(", ") || "none"}.`,
      validationCommands: this.strategicValidationCommands(project),
      failedCommands,
      changedFiles,
      openBlockers: workflow.memory.knownOpenIssues.filter((issue) => issue.status === "open").map((issue) => issue.title),
      userFeedback: workflow.activityLog
        .filter((event) => event.source === "approval" || event.source === "workflow")
        .slice(0, 6)
        .map((event) => compactText(`${event.title}${event.detail ? `: ${event.detail}` : ""}`, 240)),
      recentAgentOutputs,
      architectureNotes,
      sourceAgentId: options.sourceAgentId,
      autopilotPolicy: resolveEffectiveAutopilotPolicy(workflow, project.record.localState.autopilotEnabled),
      autopilotEnabled: project.record.localState.autopilotEnabled,
      now: options.timestamp
    };
  }

  private applyStrategicPlannerToRecommendations(
    project: LoadedProject,
    recommendations: ProjectWorkflowState["recommendations"],
    context: WorkflowRecommendationContext,
    options: { timestamp?: string; sourceAgentId?: string } = {}
  ): ProjectWorkflowState["recommendations"] {
    const workflow = this.ensureWorkflowState(project.record);
    if (recommendations.length === 0) {
      return recommendations;
    }
    const plan = buildStrategicPlan(this.collectStrategicPlannerInput(project, recommendations, context, options));
    const decision = decisionFromStrategicPlan(plan);
    const recommendationIds = new Set(recommendations.map((recommendation) => recommendation.id));
    const plannerGeneratedRecommendations: ProjectWorkflowState["recommendations"] = plan.candidateTasks
      .filter((candidate) =>
        candidate.recommendationId &&
        !recommendationIds.has(candidate.recommendationId) &&
        candidate.kind === "visual_polish"
      )
      .map((candidate, index) => ({
        id: candidate.recommendationId ?? candidate.id,
        rank: recommendations.length + index + 1,
        title: candidate.title,
        summary: candidate.summary,
        rationale: candidate.whyNext,
        expectedImpact: candidate.expectedChecklistImpact,
        priority: "high" as const,
        confidence: candidate.confidence,
        estimatedScope: candidate.shouldSplit ? "medium" as const : "small" as const,
        riskLevel: candidate.riskLevel,
        relatedPaths: candidate.expectedFiles,
        targetedCheckIds: candidate.targetedCheckIds.length ? candidate.targetedCheckIds : undefined
      }));
    const rankedRecommendations = rankRecommendationsByStrategicPlan([...recommendations, ...plannerGeneratedRecommendations], plan);
    const existingPlanIds = new Set(workflow.strategicPlans.map((entry) => entry.id));
    if (!existingPlanIds.has(plan.id)) {
      workflow.strategicPlans = [plan, ...workflow.strategicPlans].slice(0, 30);
    }
    workflow.plannerDecisions = [
      decision,
      ...workflow.plannerDecisions.filter((entry) => !(entry.cycleNumber === decision.cycleNumber && entry.planId === decision.planId))
    ].slice(0, 50);
    if (plan.proposedChecklistChanges.length > 0) {
      const existingChangeIds = new Set(workflow.checklistChanges.map((change) => change.id));
      workflow.checklistChanges = [
        ...plan.proposedChecklistChanges.filter((change) => !existingChangeIds.has(change.id)),
        ...workflow.checklistChanges
      ].slice(0, 100);
    }
    if (plan.proposedGoalChanges.length > 0) {
      const charter = this.ensureGoalCharterForWorkflow(workflow);
      const existingProposalIds = new Set(charter.proposedGoalChanges.map((proposal) => proposal.id));
      charter.proposedGoalChanges = [
        ...plan.proposedGoalChanges.filter((proposal) => !existingProposalIds.has(proposal.id)),
        ...charter.proposedGoalChanges
      ].slice(0, 50);
      charter.updatedAt = options.timestamp ?? nowIso();
      workflow.goalCharter = charter;
    }
    this.recordWorkflowActivity(workflow, {
      source: "workflow",
      status: plan.continueRecommendation === "continue" ? "completed" : "waiting",
      title: "Strategic planner selected next task",
      detail: `${decision.selectedTaskTitle ?? "No task selected"} — ${compactText(decision.whySelected, 600)}`,
      stepId: "recommendation"
    });
    return rankedRecommendations;
  }

  private plannerDecisionForCycle(workflow: ProjectWorkflowState, cycleNumber = workflow.workflowCycle.cycleNumber): PlannerDecision | undefined {
    return workflow.plannerDecisions
      .filter((decision) => decision.cycleNumber === cycleNumber)
      .sort((left, right) => toTime(right.createdAt) - toTime(left.createdAt))[0];
  }

  private selectAutopilotRecommendation(project: LoadedProject): ProjectWorkflowState["recommendations"][number] | undefined {
    const workflow = this.ensureWorkflowState(project.record);
    const decision = this.plannerDecisionForCycle(workflow);
    if (decision?.selectedRecommendationId) {
      const selected = workflow.recommendations.find((recommendation) => recommendation.id === decision.selectedRecommendationId);
      if (selected) {
        return selected;
      }
    }
    return pickAutopilotRecommendation(workflow.recommendations, workflow);
  }

  private plannerRequiresGoalApproval(workflow: ProjectWorkflowState): boolean {
    const decision = this.plannerDecisionForCycle(workflow);
    if (!decision?.approvalRequired) {
      return false;
    }
    if (decision.goalChangeProposalIds.length > 0) {
      return true;
    }
    if (!workflow.goalCharter.autopilotStrategy.autonomyBudget.stopWhenPlannerWantsToChangeUltimateGoal) {
      return false;
    }
    return decision.checklistChangeIds.length > 0 &&
      decision.checklistChangeIds.some((changeId) =>
        workflow.checklistChanges.some((change) => change.id === changeId && change.userApprovalStatus === "pending")
      );
  }

  private async applyRecommendationSet(
    project: LoadedProject,
    agent: AgentState | undefined,
    summary: string,
    recommendations: ProjectWorkflowState["recommendations"],
    progressEstimate: Omit<UltimateGoalProgressEstimate, "updatedAt">,
    proposedGoalCompletion: Omit<NonNullable<ProjectWorkflowState["ultimateGoalCompletion"]>, "updatedAt">,
    automate = false,
    goalCheckUpdates: GoalCheckUpdateInput[] = [],
    customFocus?: string
  ): Promise<void> {
    const workflow = this.ensureWorkflowState(project.record);
    const modeConfig = getWorkflowModeConfig(workflow.workflowMode, resolveEffectiveAutopilotPolicy(workflow, project.record.localState.autopilotEnabled));
    const generatedAt = nowIso();
    const baseRecommendationContext = this.buildWorkflowRecommendationContext(project);
    workflow.goalChecklist = applyGoalChecklistUpdates(
      buildGoalChecklistForAssessment(baseRecommendationContext, generatedAt),
      goalCheckUpdates,
      {
        timestamp: generatedAt,
        ownerAgentId: agent?.id,
        ultimateGoal: workflow.ultimateGoal,
        cycleNumber: workflow.workflowCycle.cycleNumber,
        maxNewRequiredChecks: modeConfig.maxNewRequiredChecksPerCycle,
        operatorFeedback: Boolean(customFocus?.trim())
      }
    );
    this.refreshWorkflowTaskMap(project, generatedAt);
    const recommendationContext = this.buildWorkflowRecommendationContext(project, customFocus);
    const progressSource = goalCheckUpdates.length > 0 ||
      progressEstimate.source === "recommendation" ||
      proposedGoalCompletion.source === "recommendation"
      ? "recommendation"
      : "deterministic";
    const checklistProgressEstimate: Omit<UltimateGoalProgressEstimate, "updatedAt"> = {
      ...estimateUltimateGoalProgress(recommendationContext),
      source: progressSource
    };
    const checklistGoalCompletion: Omit<NonNullable<ProjectWorkflowState["ultimateGoalCompletion"]>, "updatedAt"> = {
      ...assessUltimateGoalCompletion(recommendationContext, checklistProgressEstimate),
      source: progressSource
    };
    const deterministicRecommendations = buildWorkflowRecommendations(recommendationContext)
      .map((entry) => sanitizeRecommendationForCycle(entry, { breadthLimit: modeConfig.breadthLimit }))
      .filter((entry): entry is ProjectWorkflowState["recommendations"][number] => Boolean(entry))
      .map((entry, index) => ({
        ...entry,
        rank: index + 1
      }));
    const candidateRecommendations = recommendations.length > 0 || checklistGoalCompletion.state === "goal_satisfied"
      ? recommendations
      : deterministicRecommendations;
    const effectiveRecommendations = checklistGoalCompletion.state === "goal_satisfied"
      ? candidateRecommendations
      : this.ensureChecklistRecommendationsLead(recommendationContext, candidateRecommendations, deterministicRecommendations);
    const plannedRecommendations = this.applyStrategicPlannerToRecommendations(
      project,
      effectiveRecommendations,
      recommendationContext,
      { timestamp: generatedAt, sourceAgentId: agent?.id }
    );
    const appealPassQueued = this.shouldQueueAppealPass(recommendationContext, checklistGoalCompletion) && effectiveRecommendations.length > 0;
    const normalizedProgressEstimate = checklistGoalCompletion.state === "goal_satisfied"
      ? {
        ...checklistProgressEstimate,
        percentComplete: 100
      }
      : checklistProgressEstimate;
    workflow.recommendations = plannedRecommendations;
    workflow.recommendationsGeneratedAt = generatedAt;
    workflow.ultimateGoalProgress = {
      ...normalizedProgressEstimate,
      updatedAt: generatedAt
    };
    workflow.ultimateGoalCompletion = {
      ...checklistGoalCompletion,
      updatedAt: generatedAt
    };
    workflow.cycleContract = plannedRecommendations.length > 0 || workflow.approvedRecommendation || workflow.scopedGoal
      ? buildCycleContract(workflow, {
        now: generatedAt,
        selectedTaskSource: workflow.recommendationHealth.selectedTaskSource
      })
      : undefined;
    if (checklistGoalCompletion.state === "goal_satisfied" && project.record.localState.workflowObjective === "deliver") {
      if (appealPassQueued) {
        workflow.appeal = {
          ...workflow.appeal,
          status: "pending",
          reason: "The base goal is satisfied and this visual project is queued for one final appeal pass.",
          startedAt: workflow.appeal.startedAt,
          completedAt: undefined
        };
      } else if (workflow.appeal.status === "not_started") {
        workflow.appeal = {
          status: "not_applicable",
          reason: isVisualProject(recommendationContext)
            ? "No bounded final appeal recommendation could be produced."
            : "No visual app, website, or platform surface was detected for a final appeal pass.",
          completedAt: generatedAt
        };
      }
    }
    if (agent) {
      agent.recommendationReport = {
        summary,
        ultimateGoalProgress: {
          percentComplete: normalizedProgressEstimate.percentComplete,
          rationale: normalizedProgressEstimate.rationale
        },
        nextSteps: plannedRecommendations.map((recommendation) => ({
          rank: recommendation.rank,
          title: recommendation.title,
          summary: recommendation.summary,
          rationale: recommendation.rationale,
          expectedImpact: recommendation.expectedImpact,
          priority: recommendation.priority,
          confidence: recommendation.confidence,
          estimatedScope: recommendation.estimatedScope,
          riskLevel: recommendation.riskLevel,
          relatedPaths: recommendation.relatedPaths
        })),
        generatedAt
      };
      agent.status = "completed";
      agent.completedAt = nowIso();
      agent.currentPhase = appealPassQueued
        ? "Appeal recommendations ready"
        : effectiveRecommendations.length > 0
          ? "Recommendations ready"
          : "Ultimate Goal satisfied";
      agent.lastMessageSnippet = summary.slice(0, 240);
    }
    if (plannedRecommendations.length > 0) {
      this.recordWorkflowActivity(workflow, {
        source: "workflow",
        status: "waiting",
        title: appealPassQueued ? "Appeal recommendations are ready" : "Recommendations are ready",
        detail: plannedRecommendations[0]?.title ?? "Choose one recommendation to continue.",
        stepId: "recommendation"
      });
      this.updateWorkflowStepProgress(workflow, "recommendation", {
        requiresUserInput: true,
        currentActivity: appealPassQueued ? "Waiting for the final appeal choice" : "Waiting for a recommendation choice",
        currentSubstep: plannedRecommendations[0]
          ? `Recommended next cycle target: ${plannedRecommendations[0].title}`
          : undefined,
        latestProgressNote: plannedRecommendations[0]?.title ?? "Recommendations are ready.",
        message: summary || (appealPassQueued ? "Choose one final appeal pass to continue." : "Choose exactly one recommendation to continue."),
        warning: undefined
      }, { status: "waiting" });
    } else {
      this.recordWorkflowActivity(workflow, {
        source: "workflow",
        status: "completed",
        title: "Ultimate Goal assessment completed",
        detail: checklistGoalCompletion.rationale,
        stepId: "recommendation"
      });
      this.updateWorkflowStepProgress(workflow, "recommendation", {
        requiresUserInput: false,
        currentActivity: "No next cycle required",
        latestProgressNote: "The Ultimate Goal appears satisfied.",
        message: checklistGoalCompletion.rationale,
        warning: undefined
      }, { status: "completed" });
    }
    this.syncWorkflowState(project);
    await this.persistProjectUpdate(project, {
      save: "immediate",
      emit: "coalesced",
      automate,
      reason: "recommendations finalized"
    });
  }

  private async applyFallbackRecommendations(
    project: LoadedProject,
    agent?: AgentState,
    automate = false,
    customFocus?: string
  ): Promise<void> {
    this.refreshUltimateGoalAssessmentIfChanged(project);
    const objective = project.record.localState.workflowObjective;
    const recommendationContext = this.buildWorkflowRecommendationContext(project, customFocus);
    const modeConfig = getWorkflowModeConfig(recommendationContext.workflow.workflowMode, resolveEffectiveAutopilotPolicy(recommendationContext.workflow, project.record.localState.autopilotEnabled));
    const progressEstimate: Omit<UltimateGoalProgressEstimate, "updatedAt"> = {
      ...estimateUltimateGoalProgress(recommendationContext),
      source: "deterministic"
    };
    const goalCompletion: Omit<NonNullable<ProjectWorkflowState["ultimateGoalCompletion"]>, "updatedAt"> = {
      ...assessUltimateGoalCompletion(recommendationContext, progressEstimate),
      source: "deterministic"
    };
    const shouldQueueAppeal = this.shouldQueueAppealPass(recommendationContext, goalCompletion);
    const recommendations = (
      objective === "deliver" && goalCompletion.state === "goal_satisfied"
        ? shouldQueueAppeal
          ? buildAppealRecommendations(recommendationContext)
          : []
        : buildWorkflowRecommendations(recommendationContext)
    ).map((entry) => sanitizeRecommendationForCycle(entry, { breadthLimit: modeConfig.breadthLimit }))
      .filter((entry): entry is ProjectWorkflowState["recommendations"][number] => Boolean(entry))
      .map((entry, index) => ({
        ...entry,
        rank: index + 1
      }));
    const selectedFallback = recommendations[0];
    const failureDetail = recommendationContext.workflow.recommendationHealth.lastStructuredFailureMessage
      ? `structured recommendation JSON failed ${recommendationContext.workflow.recommendationHealth.lastStructuredFailureCategory ?? "validation"}: ${recommendationContext.workflow.recommendationHealth.lastStructuredFailureMessage}`
      : "structured recommendation output was unavailable or invalid";
    const targetedCount = selectedFallback?.targetedCheckIds?.length ?? 0;
    const fallbackReason = selectedFallback
      ? `Planner fallback used: ${failureDetail}. Selected deterministic ${selectedFallback.sourceWorkPackageId ? "work package" : "candidate"} because it targeted ${targetedCount} unknown required check${targetedCount === 1 ? "" : "s"}.`
      : `Planner fallback used: ${failureDetail}. No deterministic follow-up was needed.`;
    recommendationContext.workflow.recommendationHealth = recordRecommendationFallbackUsed(
      recommendationContext.workflow.recommendationHealth,
      {
        reason: fallbackReason,
        candidateCount: recommendations.length,
        confidence: selectedFallback?.confidence
      }
    );
    if (agent) {
      agent.currentPhase = "Used fallback recommendations";
      agent.lastMessageSnippet = fallbackReason;
    }
    await this.applyRecommendationSet(
      project,
      agent,
      recommendations.length > 0
        ? shouldQueueAppeal
          ? "The base Ultimate Goal appears satisfied. A final appeal recommendation set was prepared so the visual experience can receive one bounded polish pass before deliver-goal mode stops."
          : customFocus
          ? `Recommendations were regenerated around the custom direction "${customFocus}". Each option stays tightly related to that request while remaining bounded to one cycle.`
          : objective === "optimize"
            ? "Optimization recommendations were prepared from the current repository state, workflow memory, and recent activity. Each option is intended to fit in one bounded improvement cycle."
            : "Recommendations were prepared from the current repository state, workflow memory, and recent activity. Each option is intended to fit in one bounded cycle."
        : "The fallback assessment concluded that the current Ultimate Goal is satisfied, so no further cycle was queued automatically.",
      recommendations,
      progressEstimate,
      goalCompletion,
      automate,
      [],
      customFocus
    );
  }

  private async applyRecommendationOutput(
    project: LoadedProject,
    agent: AgentState,
    rawText: string,
    automate = false,
    source = "agentMessage"
  ): Promise<boolean> {
    if (agent.recommendationReport && project.record.workflow.recommendations.length > 0) {
      return true;
    }
    const outputGuard = this.beginStructuredOutputApplication(project, agent, "recommendation", rawText, source);
    if (!outputGuard) {
      return true;
    }

    const parsed = this.parseRecommendationOutput(project, rawText);
    if (!parsed) {
      this.abortStructuredOutputApplication(outputGuard);
      const workflow = this.ensureWorkflowState(project.record);
      const failure = this.lastRecommendationParseFailure ?? {
        category: "schema_mismatch" as const,
        message: "Structured recommendation output did not match the expected schema."
      };
      workflow.recommendationHealth = recordStructuredRecommendationFailure(workflow.recommendationHealth, {
        category: failure.category,
        message: failure.message
      });
      reduceAgentRuntimeEvent(agent, {
        kind: "raw",
        title: "Recommendation output rejected",
        detail: `${failure.category}: ${failure.message}`,
        raw: rawText
      });
      return false;
    }

    const objective = project.record.localState.workflowObjective;
    const recommendationContext = this.buildWorkflowRecommendationContext(project, this.extractCustomRecommendationFocus(agent));
    const progressEstimate: Omit<UltimateGoalProgressEstimate, "updatedAt"> = parsed.ultimateGoalProgress
      ? {
        ...parsed.ultimateGoalProgress,
        source: "recommendation"
      }
      : {
        ...estimateUltimateGoalProgress(recommendationContext),
        source: "deterministic"
      };
    const goalCompletion: Omit<NonNullable<ProjectWorkflowState["ultimateGoalCompletion"]>, "updatedAt"> = parsed.ultimateGoalCompletion
      ? {
        ...parsed.ultimateGoalCompletion,
        source: "recommendation"
      }
      : {
        ...assessUltimateGoalCompletion(recommendationContext, progressEstimate),
        source: "deterministic"
      };
    const shouldQueueAppeal = this.shouldQueueAppealPass(recommendationContext, goalCompletion);
    const recommendations = objective === "deliver" && goalCompletion.state === "goal_satisfied"
      ? shouldQueueAppeal
        ? parsed.recommendations.length > 0
          ? parsed.recommendations
          : buildAppealRecommendations(recommendationContext)
        : []
      : parsed.recommendations;
    if (objective === "optimize" && recommendations.length === 0) {
      this.abortStructuredOutputApplication(outputGuard);
      const workflow = this.ensureWorkflowState(project.record);
      workflow.recommendationHealth = recordStructuredRecommendationFailure(workflow.recommendationHealth, {
        category: "empty_recommendations",
        message: "Optimize mode requires at least one recommendation, but the structured response returned none."
      });
      return false;
    }

    try {
      const workflow = this.ensureWorkflowState(project.record);
      workflow.recommendationHealth = recordStructuredRecommendationSuccess(workflow.recommendationHealth);
      await this.applyRecommendationSet(
        project,
        agent,
        parsed.summary,
        recommendations,
        progressEstimate,
        goalCompletion,
        automate,
        parsed.goalCheckUpdates,
        this.extractCustomRecommendationFocus(agent)
      );
      this.finishStructuredOutputApplication(agent, outputGuard);
    } catch (error) {
      this.abortStructuredOutputApplication(outputGuard);
      throw error;
    }
    return true;
  }

  private async finalizeRecommendationFromThread(project: LoadedProject, agent: AgentState, automate = false): Promise<void> {
    const customFocus = this.extractCustomRecommendationFocus(agent);
    if (!this.transport || !agent.threadId) {
      await this.applyFallbackRecommendations(project, agent, automate, customFocus);
      return;
    }

    const thread = await this.transport.readThread(agent.threadId, true);
    const turns = [...thread.thread.turns].reverse();
    for (const turn of turns) {
      for (const item of [...turn.items].reverse()) {
        if (item.type !== "agentMessage" || !item.text.trim()) {
          continue;
        }

        if (await this.applyRecommendationOutput(project, agent, item.text, automate, "thread/read")) {
          return;
        }
      }
    }

    await this.applyFallbackRecommendations(project, agent, automate, customFocus);
  }

  private buildScopedGoalOutputSchema(): JsonValue {
    return {
      type: "object",
      additionalProperties: false,
      required: ["summary", "executionBrief", "acceptanceCriteria", "constraints", "testStrategy"],
      properties: {
        summary: { type: "string" },
        executionBrief: { type: "string" },
        acceptanceCriteria: {
          type: "array",
          items: { type: "string" }
        },
        constraints: {
          type: "array",
          items: { type: "string" }
        },
        testStrategy: {
          type: "array",
          items: { type: "string" }
        }
      }
    } satisfies JsonValue;
  }

  private buildScopedGoalPrompt(project: LoadedProject, approvedRecommendation: ApprovedRecommendation): string {
    const workflow = this.ensureWorkflowState(project.record);
    const previewRecommendation = isPreviewRecommendation(approvedRecommendation);
    const recentOpenIssues = workflow.memory.knownOpenIssues
      .filter((issue) => issue.status === "open")
      .slice(0, 5)
      .map((issue) => `- ${issue.title}: ${compactText(issue.detail, MAX_PROMPT_DETAIL_LENGTH)}`);
    const goalChecklist = buildGoalChecklistForAssessment({
      workflow,
      agents: project.record.agents
    })
      .filter((check) => check.required)
      .slice(0, 16)
      .map((check) => {
        const evidence = check.status === "unknown" ? "" : check.evidence;
        return `- [${check.status}] ${check.title}${evidence ? ` -- ${compactText(evidence, MAX_PROMPT_DETAIL_LENGTH)}` : ""}`;
      });
    const recommendationContext = this.buildWorkflowRecommendationContext(project);
    const outcomeStrategyBrief = buildOutcomeStrategyBrief(recommendationContext, {
      maxOpenChecks: 4,
      maxFocusPaths: 4
    });
    const currentStrategy = workflow.goalCharter.autopilotStrategy;
    const visualPromptRelevant = currentStrategy.visualPriority !== "low" && (
      isVisualProject(recommendationContext) ||
      /\b(visual|ui|ux|layout|contrast|readability|responsive|hierarchy|polish|dashboard|spacing|theme|renderer|css|tsx|jsx|transcript|card|table)\b/i.test([
        approvedRecommendation.title,
        approvedRecommendation.summary,
        approvedRecommendation.rationale,
        approvedRecommendation.expectedImpact,
        approvedRecommendation.relatedPaths.join(" ")
      ].join(" "))
    );
    const visualPreferenceBrief = visualPromptRelevant ? buildVisualPreferenceBrief(currentStrategy) : "";
    const relevantPriorContext = this.selectAndRememberRelevantContext(
      project,
      "goal",
      [
        approvedRecommendation.title,
        approvedRecommendation.summary,
        approvedRecommendation.rationale,
        workflow.ultimateGoal.summary,
        workflow.ultimateGoal.detailedIntent,
        goalChecklist.join("\n"),
        recentOpenIssues.join("\n")
      ].join("\n"),
      approvedRecommendation.relatedPaths
    );

    return [
      "Turn the approved recommendation into a scoped goal for the next coding pass.",
      "The output must represent one bounded task for a single cycle, not a broad multi-phase project.",
      "The result must be executable by one coding agent in one pass. If related checks share implementation paths, tests, or evidence, plan the largest coherent reviewable batch instead of narrowing to a tiny evidence-only slice.",
      previewRecommendation
        ? "This is a preview checkpoint. Scope the pass toward making the current product structure visible/runnable for inspection, not toward declaring the Ultimate Goal finished."
        : "",
      previewRecommendation
        ? "Preview plans should expose UI shell, routes/screens, explicit empty/loading/error/missing-credential states, demo/offline labels, and build/run instructions when the repo supports them. Do not fake live data, add secrets, or require paid services."
        : "",
      "Do not scope another coding pass just to re-prove a semantically identical checklist batch that already has direct evidence. If the approved recommendation is about checklist cleanup, focus the brief on the concrete missing evidence or redundant checks named in the recommendation.",
      "`executionBrief` should be a full prompt for the coding agent: what to change, where to focus, what to avoid, and how to know the task is done.",
      "Make acceptanceCriteria concrete and testable.",
      "Keep acceptanceCriteria to at most 6 bullets and testStrategy to at most 4 focused checks.",
      "Use the Goal checklist as the completion source of truth. Prefer a scoped plan that turns a coherent group of unmet or unknown required checks into met checks with evidence.",
      "Keep constraints aligned with the Ultimate Goal and the repository boundaries.",
      visualPreferenceBrief
        ? `For GUI or visual work, reflect these Goal Charter / Autopilot Strategy visual preferences in the scoped task: ${visualPreferenceBrief}. Include contrast, visual hierarchy, spacing, responsive behavior, empty/loading/error states, and comfortable card/table/transcript readability when relevant.`
        : "",
      "Use the outcome strategy below to keep the scoped plan pointed at the best finished project outcome.",
      outcomeStrategyBrief,
      "Use the relevant prior context below when it is directly applicable. Keep the scoped goal compact and do not include unrelated historical notes. Current checklist counts override historical progress counts in prior context.",
      relevantPriorContext,
      "",
      `Project: ${project.record.identity.projectName}`,
      `Ultimate Goal: ${compactText(workflow.ultimateGoal.summary, 800)}`,
      workflow.ultimateGoal.detailedIntent ? `Detailed intent: ${compactText(workflow.ultimateGoal.detailedIntent, 1_200)}` : "",
      `Approved recommendation: ${approvedRecommendation.title}`,
      `Recommendation summary: ${compactText(approvedRecommendation.summary, 500)}`,
      `Why now: ${compactText(approvedRecommendation.rationale, 700)}`,
      `Expected impact: ${compactText(approvedRecommendation.expectedImpact, 500)}`,
      approvedRecommendation.relatedPaths.length ? `Likely paths: ${approvedRecommendation.relatedPaths.join(", ")}` : "",
      workflow.ultimateGoal.successCriteria.length
        ? `Ultimate-goal success criteria:\n- ${workflow.ultimateGoal.successCriteria.slice(0, 8).map((entry) => compactText(entry, 260)).join("\n- ")}`
        : "",
      workflow.ultimateGoal.constraints.length
        ? `Project constraints:\n- ${workflow.ultimateGoal.constraints.slice(0, 8).map((entry) => compactText(entry, 260)).join("\n- ")}`
        : "",
      goalChecklist.length ? `Current Goal checklist:\n${goalChecklist.join("\n")}` : "",
      recentOpenIssues.length ? `Open issues to account for:\n${recentOpenIssues.join("\n")}` : ""
    ]
      .filter((entry) => entry.trim().length > 0)
      .join("\n\n");
  }

  private parseScopedGoalOutput(
    approvedRecommendation: ApprovedRecommendation,
    rawText: string
  ): ScopedGoal | undefined {
    for (const parsed of this.extractJsonObjects(rawText).reverse()) {
      try {
        return sanitizeScopedGoalForSingleAgent(scopedGoalSchema.parse({
          ...parsed,
          id: nanoid(),
          sourceRecommendationId: approvedRecommendation.recommendationId,
          sourceWorkPackageId: (parsed as { sourceWorkPackageId?: unknown }).sourceWorkPackageId ?? approvedRecommendation.sourceWorkPackageId,
          targetedCheckIds: (parsed as { targetedCheckIds?: unknown }).targetedCheckIds ?? approvedRecommendation.targetedCheckIds,
          likelyPaths: (parsed as { likelyPaths?: unknown }).likelyPaths ?? approvedRecommendation.relatedPaths,
          createdAt: nowIso()
        }));
      } catch {
        // Try the next complete object in the message.
      }
    }

    return undefined;
  }

  private async applyScopedGoalState(
    project: LoadedProject,
    scopedGoal: ScopedGoal,
    agent?: AgentState,
    automate = false
  ): Promise<void> {
    const workflow = this.ensureWorkflowState(project.record);
    const boundedScopedGoal = sanitizeScopedGoalForSingleAgent(scopedGoal);
    await this.ensureWorkflowCycleStartGitRef(project, workflow);
    workflow.scopedGoal = boundedScopedGoal;
    workflow.workflowCycle = {
      ...workflow.workflowCycle,
      scopedGoalSummary: boundedScopedGoal.summary,
      acceptanceCriteria: boundedScopedGoal.acceptanceCriteria,
      status: "goal_ready"
    };
    workflow.cycleContract = buildCycleContract(workflow, {
      now: boundedScopedGoal.createdAt,
      selectedTaskSource: workflow.cycleContract?.selectedTaskSource ?? workflow.recommendationHealth.selectedTaskSource
    });
    if (agent) {
      agent.status = "completed";
      agent.completedAt = nowIso();
      agent.currentPhase = "Scoped goal ready";
      agent.lastMessageSnippet = scopedGoal.summary;
    }
    this.updateWorkflowStepProgress(workflow, "goal_plan", {
      requiresUserInput: false,
      currentActivity: "Scoped plan ready",
      latestProgressNote: boundedScopedGoal.summary,
      message: boundedScopedGoal.executionBrief
    }, { status: "completed" });
    this.resetWorkflowStepProgress(workflow, "coding", {
      status: "waiting",
      requiresUserInput: false,
      currentActivity: "Queued for implementation",
      message: "Coding will start automatically."
    });
    this.resetWorkflowStepProgress(workflow, "integrity");
    this.resetWorkflowStepProgress(workflow, "merge");
    this.recordAcceptedDecision(workflow, {
      kind: "scoped_goal",
      title: boundedScopedGoal.summary,
      summary: boundedScopedGoal.executionBrief,
      cycleNumber: workflow.workflowCycle.cycleNumber,
      sourceAgentCategory: "goal"
    });
    this.recordWorkflowActivity(workflow, {
      source: "workflow",
      status: "completed",
      title: "Created a scoped execution plan",
      detail: boundedScopedGoal.summary,
      stepId: "goal_plan"
    });
    this.syncWorkflowState(project);
    await this.persistProjectUpdate(project, {
      save: "immediate",
      emit: "coalesced",
      automate,
      reason: "scoped goal finalized"
    });
  }

  private findWorkPackageForApprovedRecommendation(
    workflow: ProjectWorkflowState,
    approvedRecommendation: ApprovedRecommendation
  ): WorkPackage | undefined {
    const workPackages = workflow.workPackages ?? [];
    if (approvedRecommendation.sourceWorkPackageId) {
      const byId = workPackages.find((workPackage) => workPackage.id === approvedRecommendation.sourceWorkPackageId);
      if (byId) {
        return byId;
      }
    }

    const targetedCheckIds = new Set(approvedRecommendation.targetedCheckIds ?? []);
    if (targetedCheckIds.size > 0) {
      const byChecks = workPackages.find((workPackage) =>
        workPackage.checkIds.length === targetedCheckIds.size &&
        workPackage.checkIds.every((checkId) => targetedCheckIds.has(checkId))
      );
      if (byChecks) {
        return byChecks;
      }
    }

    const titleTopic = approvedRecommendation.title.match(/^Satisfy work package:\s*(.+)$/i)?.[1]?.trim().toLowerCase();
    if (!titleTopic) {
      return undefined;
    }

    return workPackages.find((workPackage) =>
      workPackage.primaryTopic.toLowerCase() === titleTopic ||
      workPackage.title.toLowerCase() === titleTopic ||
      approvedRecommendation.relatedPaths.some((relatedPath) => workPackage.likelyPaths.includes(relatedPath))
    );
  }

  private createDeterministicScopedGoalForApprovedRecommendation(
    project: LoadedProject,
    approvedRecommendation: ApprovedRecommendation
  ): ScopedGoal | undefined {
    const workflow = this.ensureWorkflowState(project.record);
    const recommendation = workflow.recommendations.find((entry) => entry.id === approvedRecommendation.recommendationId);
    if (recommendation && isPreviewRecommendation(recommendation)) {
      return sanitizeScopedGoalForSingleAgent(createScopedGoalFromRecommendation(recommendation, workflow.ultimateGoal));
    }

    const autopilotPolicy = resolveEffectiveAutopilotPolicy(workflow, project.record.localState.autopilotEnabled);
    const modeConfig = getWorkflowModeConfig(workflow.workflowMode, autopilotPolicy);
    if (!modeConfig.useDeterministicScopingWhenClear) {
      return undefined;
    }

    this.refreshWorkflowTaskMap(project);
    const workPackage = this.findWorkPackageForApprovedRecommendation(workflow, approvedRecommendation);
    if (!workPackage || workPackageRequiresModelScoping(workPackage, workflow)) {
      return undefined;
    }

    return createScopedGoalFromWorkPackage(workPackage, workflow, {
      mode: workflow.workflowMode,
      autopilotPolicy,
      sourceRecommendationId: approvedRecommendation.recommendationId
    });
  }

  private async applyFallbackScopedGoal(project: LoadedProject, approvedRecommendation: ApprovedRecommendation, agent?: AgentState, automate = false): Promise<void> {
    const workflow = this.ensureWorkflowState(project.record);
    const recommendation = workflow.recommendations.find((entry) => entry.id === approvedRecommendation.recommendationId) ?? {
      id: approvedRecommendation.recommendationId,
      rank: approvedRecommendation.rank,
      title: approvedRecommendation.title,
      summary: approvedRecommendation.summary,
      rationale: approvedRecommendation.rationale,
      expectedImpact: approvedRecommendation.expectedImpact,
      priority: approvedRecommendation.priority,
      confidence: approvedRecommendation.confidence,
      estimatedScope: approvedRecommendation.estimatedScope,
      riskLevel: approvedRecommendation.riskLevel,
      relatedPaths: approvedRecommendation.relatedPaths,
      sourceWorkPackageId: approvedRecommendation.sourceWorkPackageId,
      targetedCheckIds: approvedRecommendation.targetedCheckIds
    };
    if (agent) {
      agent.currentPhase = "Used fallback scoped plan";
      agent.lastMessageSnippet = "Structured goal-planning output was invalid, so the workflow used the deterministic fallback.";
    }
    await this.applyScopedGoalState(project, sanitizeScopedGoalForSingleAgent(createScopedGoalFromRecommendation(recommendation, workflow.ultimateGoal)), agent, automate);
  }

  private async applyScopedGoalOutput(
    project: LoadedProject,
    agent: AgentState,
    approvedRecommendation: ApprovedRecommendation,
    rawText: string,
    automate = false,
    source = "agentMessage"
  ): Promise<boolean> {
    if (project.record.workflow.scopedGoal?.sourceRecommendationId === approvedRecommendation.recommendationId) {
      return true;
    }
    const outputGuard = this.beginStructuredOutputApplication(project, agent, "scoped_goal", rawText, source);
    if (!outputGuard) {
      return true;
    }

    const parsed = this.parseScopedGoalOutput(approvedRecommendation, rawText);
    if (!parsed) {
      this.abortStructuredOutputApplication(outputGuard);
      reduceAgentRuntimeEvent(agent, {
        kind: "raw",
        title: "Scoped goal output rejected",
        detail: rawText.slice(0, 240),
        raw: rawText
      });
      return false;
    }

    try {
      await this.applyScopedGoalState(project, parsed, agent, automate);
      this.finishStructuredOutputApplication(agent, outputGuard);
    } catch (error) {
      this.abortStructuredOutputApplication(outputGuard);
      throw error;
    }
    return true;
  }

  private async finalizeScopedGoalFromThread(
    project: LoadedProject,
    agent: AgentState,
    approvedRecommendation: ApprovedRecommendation,
    automate = false
  ): Promise<void> {
    if (!this.transport || !agent.threadId) {
      await this.applyFallbackScopedGoal(project, approvedRecommendation, agent, automate);
      return;
    }

    const thread = await this.transport.readThread(agent.threadId, true);
    const turns = [...thread.thread.turns].reverse();
    for (const turn of turns) {
      for (const item of [...turn.items].reverse()) {
        if (item.type !== "agentMessage" || !item.text.trim()) {
          continue;
        }

        if (await this.applyScopedGoalOutput(project, agent, approvedRecommendation, item.text, automate, "thread/read")) {
          return;
        }
      }
    }

    await this.applyFallbackScopedGoal(project, approvedRecommendation, agent, automate);
  }

  private isRecoverableAgentLaunchError(error: unknown): boolean {
    const detail = error instanceof Error ? error.message : String(error);
    return /array buffer allocation failed|codex app-server|transport|model|invalid[_ ]json[_ ]schema|invalid schema|response_format|request failed|request timed out|timed out|timeout|systemerror|unavailable/i.test(detail);
  }

  private resolveRecommendationForApproval(
    workflow: ProjectWorkflowState,
    recommendationId: string | undefined
  ): ProjectWorkflowState["recommendations"][number] | undefined {
    if (!recommendationId) {
      return undefined;
    }

    const exactMatch = workflow.recommendations.find((entry) => entry.id === recommendationId);
    if (exactMatch) {
      return exactMatch;
    }

    const canRecoverAutopilotCheckpoint =
      workflow.autopilotStatus?.pausedReason === "high_risk_package_requires_approval" &&
      workflow.autopilotStatus.currentRecommendationId === recommendationId;
    if (!canRecoverAutopilotCheckpoint) {
      return undefined;
    }

    const checkpointTitle = workflow.autopilotStatus?.currentRecommendationTitle;
    return checkpointTitle
      ? workflow.recommendations.find((entry) => entry.title === checkpointTitle) ?? pickAutopilotRecommendation(workflow.recommendations, workflow)
      : pickAutopilotRecommendation(workflow.recommendations, workflow);
  }

  async approveRecommendation(
    projectId: string,
    recommendationId: string,
    decisionSource: "manual" | "autopilot" = "manual"
  ): Promise<ApprovedRecommendation> {
    const project = this.findProject(projectId);
    const existingWorkflow = this.ensureWorkflowState(project.record);
    const recommendation = this.resolveRecommendationForApproval(existingWorkflow, recommendationId);
    if (!recommendation) {
      throw new Error(`Unknown recommendation: ${recommendationId}`);
    }
    await this.ensureAgentBackedRuntimeReady(project, "recommendation approval runtime check");
    this.prepareWorkflowForNextRecommendationCycle(project);
    const workflow = this.ensureWorkflowState(project.record);

    const approvedRecommendation: ApprovedRecommendation = {
      id: nanoid(),
      recommendationId: recommendation.id,
      rank: recommendation.rank,
      title: recommendation.title,
      summary: recommendation.summary,
      rationale: recommendation.rationale,
      expectedImpact: recommendation.expectedImpact,
      priority: recommendation.priority,
      confidence: recommendation.confidence,
      estimatedScope: recommendation.estimatedScope,
      riskLevel: recommendation.riskLevel,
      relatedPaths: recommendation.relatedPaths,
      sourceWorkPackageId: recommendation.sourceWorkPackageId,
      targetedCheckIds: recommendation.targetedCheckIds,
      approvedAt: nowIso()
    };

    workflow.approvedRecommendation = approvedRecommendation;
    if (isPreviewRecommendation(recommendation) && getWorkflowPreviewRequest(workflow).status === "queued") {
      this.activateWorkflowPreviewRequest(project);
    }
    workflow.scopedGoal = undefined;
    this.resetWorkflowRepairState(workflow);
    if (workflow.appeal.status === "pending") {
      workflow.appeal = {
        ...workflow.appeal,
        status: "running",
        startedAt: workflow.appeal.startedAt ?? nowIso(),
        completedAt: undefined,
        cycleNumber: workflow.workflowCycle.cycleNumber
      };
      this.recordWorkflowActivity(workflow, {
        source: "workflow",
        status: "running",
        title: "Final appeal pass started",
        detail: recommendation.title,
        stepId: "recommendation"
      });
    }
    const startGitRef = await this.ensureWorkflowCycleStartGitRef(project, workflow);
    workflow.workflowCycle = {
      ...workflow.workflowCycle,
      approvedRecommendationId: recommendation.id,
      approvedRecommendationTitle: recommendation.title,
      scopedGoalSummary: undefined,
      acceptanceCriteria: [],
      startedAt: workflow.workflowCycle.startedAt ?? nowIso(),
      startGitRef,
      completedAt: undefined,
      status: "recommendation_approved"
    };
    this.updateWorkflowStepProgress(workflow, "recommendation", {
      requiresUserInput: false,
      currentActivity: decisionSource === "autopilot" ? "Autopilot approved the next step" : "Recommendation approved",
      latestProgressNote: recommendation.title,
      message: decisionSource === "autopilot"
        ? "Autopilot chose the strategic planner's top-ranked recommendation and is preparing the scoped execution plan."
        : "Preparing the scoped execution plan."
    }, { status: "completed" });
    this.resetWorkflowStepProgress(workflow, "goal_plan", {
      status: "waiting",
      requiresUserInput: false,
      currentActivity: "Queued for scoping",
      message: "Turning the chosen recommendation into a scoped plan."
    });
    this.resetWorkflowStepProgress(workflow, "coding");
    this.resetWorkflowStepProgress(workflow, "integrity");
    this.resetWorkflowStepProgress(workflow, "merge");
    const plannerDecision = this.plannerDecisionForCycle(workflow);
    this.recordAcceptedDecision(workflow, {
      kind: "recommendation",
      title: recommendation.title,
      summary: plannerDecision?.whySelected ?? recommendation.summary,
      cycleNumber: workflow.workflowCycle.cycleNumber,
      sourceAgentCategory: "recommendation"
    });
    this.recordWorkflowActivity(workflow, {
      source: "workflow",
      status: "completed",
      title: decisionSource === "autopilot" ? "Autopilot selected a recommendation" : "Approved a recommendation",
      detail: recommendation.title,
      stepId: "recommendation"
    });
    workflow.cycleContract = buildCycleContract(workflow, {
      now: nowIso(),
      selectedTaskSource: workflow.recommendationHealth.selectedTaskSource === "derived_from_legacy_state"
        ? decisionSource === "manual" ? "manual" : workflow.recommendationHealth.selectedTaskSource
        : workflow.recommendationHealth.selectedTaskSource
    });
    this.syncWorkflowState(project);
    await this.persistProjectUpdate(project, {
      save: "immediate",
      emit: "coalesced",
      automate: true,
      reason: decisionSource === "autopilot" ? "autopilot recommendation approved" : "recommendation approved"
    });
    return approvedRecommendation;
  }

  async createScopedGoal(projectId: string, automate = true) {
    const project = this.findProject(projectId);
    const workflow = this.ensureWorkflowState(project.record);
    const approvedRecommendation = workflow.approvedRecommendation;
    if (!approvedRecommendation) {
      throw new Error("Approve a recommendation before creating a scoped goal.");
    }

    await this.ensureAgentBackedRuntimeReady(project, "goal planning runtime check");

    const deterministicScopedGoal = this.createDeterministicScopedGoalForApprovedRecommendation(project, approvedRecommendation);
    if (deterministicScopedGoal) {
      this.recordWorkflowActivity(workflow, {
        source: "workflow",
        status: "running",
        title: "Deterministic scoped plan selected",
        detail: deterministicScopedGoal.summary,
        stepId: "goal_plan"
      });
      await this.applyScopedGoalState(project, deterministicScopedGoal, undefined, automate);
      return project.record.workflow.scopedGoal;
    }

    this.updateWorkflowStepProgress(workflow, "goal_plan", {
      requiresUserInput: false,
      currentActivity: "Drafting a scoped plan for the coding agent",
      latestProgressNote: approvedRecommendation.title,
      message: "The goal agent is turning the approved recommendation into a bounded coding brief.",
      agentCategory: "goal"
    }, { status: "running", incrementRunCount: true, incrementAttemptCount: true });
    this.resetWorkflowStepProgress(workflow, "coding");
    this.resetWorkflowStepProgress(workflow, "integrity");
    this.resetWorkflowStepProgress(workflow, "merge");
    this.recordWorkflowActivity(workflow, {
      source: "workflow",
      status: "running",
      title: "Goal planning started",
      detail: approvedRecommendation.title,
      stepId: "goal_plan"
    });
    this.syncWorkflowState(project);
    await this.persistProjectUpdate(project);

    try {
      await this.createAgent(
        projectId,
        "goal",
        "Goal Agent",
        this.buildScopedGoalPrompt(project, approvedRecommendation),
        this.getDefaultAgentModel(),
        {
          sandbox: "read-only",
          outputSchema: this.buildScopedGoalOutputSchema(),
          initialPhase: "Drafting scoped goal plan"
        }
      );
    } catch (error) {
      if (!this.isRecoverableAgentLaunchError(error)) {
        throw error;
      }
      const detail = error instanceof Error ? error.message : String(error);
      const failedAgent = project.record.agents.find((entry) =>
        entry.category === "goal" &&
        entry.name === "Goal Agent" &&
        entry.status !== "completed" &&
        (entry.workflowCycleNumber === undefined || entry.workflowCycleNumber === workflow.workflowCycle.cycleNumber)
      );
      if (failedAgent) {
        failedAgent.status = "failed";
        failedAgent.completedAt = nowIso();
        failedAgent.currentPhase = "Goal agent launch failed";
        failedAgent.lastMessageSnippet = detail.slice(0, 240);
        reduceAgentRuntimeEvent(failedAgent, {
          kind: "raw",
          title: "Goal agent launch failed",
          detail
        });
      }
      this.diagnostics.unshift(`Goal planning used the deterministic fallback after the goal agent could not start. ${detail}`);
      this.recordWorkflowActivity(workflow, {
        source: "workflow",
        status: "failed",
        title: "Goal agent launch failed; using fallback scoped plan",
        detail,
        stepId: "goal_plan",
        agentId: failedAgent?.id,
        agentCategory: failedAgent ? "goal" : undefined
      });
      await this.applyFallbackScopedGoal(project, approvedRecommendation, failedAgent, automate);
    }
    return project.record.workflow.scopedGoal;
  }

  private isWaitingForMergeConflictResolution(workflow: ProjectWorkflowState): boolean {
    return workflow.repair.status === "merge_conflicts" || workflow.manualHandoff?.reason === "merge_conflicts";
  }

  private queueManualMergeRetry(projectId: string, latestFailureReason: string): boolean {
    if (this.workflowMergeRetryInFlight.has(projectId)) {
      return false;
    }
    this.workflowMergeRetryInFlight.add(projectId);
    const immediate = setImmediate(() => {
      void this.runQueuedManualMergeRetry(projectId, latestFailureReason);
    });
    immediate.unref?.();
    return true;
  }

  private async runQueuedManualMergeRetry(projectId: string, latestFailureReason: string): Promise<void> {
    try {
      await this.yieldWorkflowAutomationLoop();
      if (this.disposed) {
        return;
      }
      let project = this.projects.get(projectId);
      if (!project) {
        return;
      }
      let workflow = this.ensureWorkflowState(project.record);
      if (!this.isWaitingForMergeConflictResolution(workflow)) {
        this.logWorkflowPerf(`manual merge retry skipped for ${project.record.identity.projectName}: conflict state already changed`);
        return;
      }

      if (await this.tryFinalizeResolvedMergeConflictWorktree(project)) {
        return;
      }

      project = this.projects.get(projectId);
      if (!project) {
        return;
      }
      workflow = this.ensureWorkflowState(project.record);
      if (!this.isWaitingForMergeConflictResolution(workflow)) {
        this.logWorkflowPerf(`manual merge retry skipped for ${project.record.identity.projectName}: conflict state already resolved`);
        return;
      }

      this.resetWorkflowRepairState(workflow);
      this.resolveWorkflowOpenIssues(workflow, (issue) => issue.source === "merge");
      this.resetWorkflowStepProgress(workflow, "merge", {
        status: "not_started",
        requiresUserInput: false,
        currentActivity: "Queued to retry integration",
        latestProgressNote: latestFailureReason,
        message: "Merge will rerun after the conflicts are resolved.",
        warning: undefined
      });
      this.syncWorkflowState(project);
      await this.persistProjectUpdate(project, {
        save: false,
        emit: "coalesced",
        reason: "manual merge retry starting"
      });
      await this.runMerge(projectId, true);
    } catch (error) {
      await this.recordManualMergeRetryFailure(projectId, error);
    } finally {
      this.workflowMergeRetryInFlight.delete(projectId);
    }
  }

  private async recordManualMergeRetryFailure(projectId: string, error: unknown): Promise<void> {
    const project = this.projects.get(projectId);
    if (!project || this.disposed) {
      return;
    }
    const workflow = this.ensureWorkflowState(project.record);
    const detail = error instanceof Error ? error.message : String(error);
    this.updateWorkflowRepairState(workflow, {
      status: "merge_conflicts",
      latestIssueSummary: "Merge retry failed before integration could complete.",
      latestFailureReason: detail
    });
    workflow.manualHandoff ??= this.buildRepairManualHandoff(
      project,
      "Merge retry failed before integration could complete.",
      detail,
      "merge_conflicts",
      this.getMergeConflictHandoffPaths([detail])
    );
    this.recordWorkflowActivity(workflow, {
      source: "workflow",
      status: "failed",
      title: "Manual merge retry failed",
      detail,
      stepId: "merge"
    });
    this.updateWorkflowStepProgress(workflow, "merge", {
      status: "failed",
      requiresUserInput: true,
      currentActivity: "Merge retry failed",
      latestProgressNote: detail,
      message: "Review the merge conflict details and retry after resolving the blocker.",
      warning: detail
    });
    this.syncWorkflowState(project);
    await this.persistProjectUpdate(project, {
      save: "deferred",
      emit: "coalesced",
      reason: "manual merge retry failed"
    });
  }

  async retryWorkflowGoal(projectId: string): Promise<void> {
    const project = this.findProject(projectId);
    const workflow = this.ensureWorkflowState(project.record);

    this.cancelScheduledWorkflowAutomation(projectId);
    project.record.localState.workflowPauseRequested = false;
    if (this.workflowMergeRetryInFlight.has(projectId)) {
      const latestFailureReason =
        workflow.manualHandoff?.latestFailureReason ??
        workflow.repair.latestFailureReason ??
        "A merge retry is already running for this project.";
      this.updateWorkflowStepProgress(workflow, "merge", {
        requiresUserInput: false,
        currentActivity: "Merge retry already queued",
        latestProgressNote: latestFailureReason,
        message: "A merge retry is already running for this project.",
        warning: undefined
      });
      this.recordWorkflowActivity(workflow, {
        source: "workflow",
        status: "waiting",
        title: "Manual merge retry already running",
        detail: latestFailureReason,
        stepId: "merge"
      });
      this.syncWorkflowState(project);
      await this.persistProjectUpdate(project, {
        save: false,
        emit: "immediate",
        reason: "manual merge retry coalesced"
      });
      return;
    }
    if (this.isWaitingForMergeConflictResolution(workflow)) {
      const latestFailureReason =
        workflow.manualHandoff?.latestFailureReason ??
        workflow.repair.latestFailureReason ??
        "Deterministic merge reported conflicts.";
      const queued = this.queueManualMergeRetry(projectId, latestFailureReason);
      this.resetWorkflowStepProgress(workflow, "merge", {
        status: "waiting",
        requiresUserInput: false,
        currentActivity: queued ? "Queued to check resolved integration worktree" : "Merge retry already queued",
        latestProgressNote: latestFailureReason,
        message: queued
          ? "Merge retry will use a resolved conflict worktree when one is ready, otherwise it will rerun integration."
          : "A merge retry is already running for this project.",
        warning: undefined
      });
      this.recordWorkflowActivity(workflow, {
        source: "workflow",
        status: "waiting",
        title: queued ? "Manual merge retry requested" : "Manual merge retry already running",
        detail: latestFailureReason,
        stepId: "merge"
      });
      this.syncWorkflowState(project);
      await this.persistProjectUpdate(project, {
        save: false,
        emit: "immediate",
        reason: queued ? "manual merge retry requested" : "manual merge retry coalesced"
      });
      return;
    }

    if (!workflow.scopedGoal) {
      throw new Error("A scoped goal is required before the current workflow goal can be retried.");
    }

    if (workflow.repair.status !== "exhausted") {
      throw new Error("Retry current goal is only available after automatic repair has been exhausted.");
    }

    if (workflow.manualHandoff?.reason === "repair_stopped_early") {
      const latestFailureReason = workflow.manualHandoff.latestFailureReason || workflow.repair.latestFailureReason;
      if (!this.isEnvironmentRepairFailureReason(latestFailureReason)) {
        throw new Error("Retry current goal is not available for this early stop. Choose a smaller next step or revise the scoped goal before continuing.");
      }

      this.updateWorkflowRepairState(workflow, {
        status: "retrying_validation",
        latestIssueSummary: workflow.manualHandoff.validationIssue,
        latestFailureReason
      });
      this.resetWorkflowStepProgress(workflow, "integrity", {
        status: "waiting",
        requiresUserInput: false,
        currentActivity: "Queued to retry validation after the environment fix",
        currentSubstep: workflow.repair.attemptCount > 0
          ? `Validation retry ${workflow.repair.attemptCount} of ${workflow.repair.maxAttempts}`
          : undefined,
        latestProgressNote: latestFailureReason,
        message: "Validation will rerun against the current saved implementation.",
        warning: undefined
      });
      this.resetWorkflowStepProgress(workflow, "merge");
      this.recordWorkflowActivity(workflow, {
        source: "workflow",
        status: "waiting",
        title: "Manual validation retry requested",
        detail: latestFailureReason ?? "Retrying validation after resolving the environment blocker.",
        stepId: "integrity"
      });
      this.syncWorkflowState(project);
      await this.persistProjectUpdate(project);
      await this.runIntegrity(projectId, false);
      return;
    }

    this.resetWorkflowRepairState(workflow);
    this.resetWorkflowStepProgress(workflow, "coding", {
      status: "waiting",
      requiresUserInput: false,
      currentActivity: "Queued to retry the current scoped goal",
      latestProgressNote: workflow.scopedGoal.summary,
      message: "Preparing a fresh coding pass for the same scoped goal.",
      warning: undefined
    });
    this.resetWorkflowStepProgress(workflow, "integrity");
    this.resetWorkflowStepProgress(workflow, "merge");
    this.recordWorkflowActivity(workflow, {
      source: "workflow",
      status: "waiting",
      title: "Manual retry requested",
      detail: `Restarting the current scoped goal: ${workflow.scopedGoal.summary}`,
      stepId: "coding"
    });
    this.syncWorkflowState(project);
    await this.persistProjectUpdate(project, true);
  }

  async revalidateWorkflowRepair(projectId: string): Promise<void> {
    const project = this.findProject(projectId);
    const workflow = this.ensureWorkflowState(project.record);

    if (this.hasActiveWorkflowAgent(project)) {
      throw new Error("Wait for the active workflow agent to finish before revalidating the repair.");
    }

    if (this.isWaitingForMergeConflictResolution(workflow)) {
      await this.retryWorkflowGoal(projectId);
      return;
    }

    if (!workflow.scopedGoal) {
      throw new Error("A scoped goal is required before a repair can be revalidated.");
    }

    const priorFailure =
      workflow.manualHandoff?.latestFailureReason ??
      workflow.repair.latestFailureReason ??
      "External repair is ready for validation.";
    const priorIssue =
      workflow.manualHandoff?.validationIssue ??
      workflow.repair.latestIssueSummary ??
      "External repair is ready for validation.";

    this.cancelScheduledWorkflowAutomation(projectId);
    project.record.localState.workflowPauseRequested = false;
    workflow.workflowStopReason = "none";
    workflow.manualHandoff = undefined;
    this.updateWorkflowRepairState(workflow, {
      status: "retrying_validation",
      latestIssueSummary: priorIssue,
      latestFailureReason: EXTERNAL_REPAIR_REVALIDATION_REASON
    });
    this.updateWorkflowStepProgress(workflow, "coding", {
      requiresUserInput: false,
      currentActivity: "External repair completed",
      latestProgressNote: priorFailure,
      message: "Workbench will validate the repaired checkout before integration.",
      warning: undefined
    }, { status: "completed" });
    this.resetWorkflowStepProgress(workflow, "integrity", {
      status: "waiting",
      requiresUserInput: false,
      currentActivity: "Queued to revalidate external repair",
      currentSubstep: workflow.repair.attemptCount > 0
        ? `Validation retry ${workflow.repair.attemptCount} of ${workflow.repair.maxAttempts}`
        : undefined,
      latestProgressNote: priorFailure,
      message: "Validation will run against the currently opened checkout."
    });
    this.resetWorkflowStepProgress(workflow, "merge", {
      status: "waiting",
      requiresUserInput: false,
      currentActivity: "Waiting for repair validation",
      message: "Merge will run only after validation and repository hygiene pass."
    });
    this.recordWorkflowActivity(workflow, {
      source: "workflow",
      status: "waiting",
      title: "External repair revalidation requested",
      detail: priorFailure,
      stepId: "integrity"
    });
    this.syncWorkflowState(project);
    await this.persistProjectUpdate(project, {
      save: "immediate",
      emit: "coalesced",
      reason: "external repair revalidation requested"
    });

    await this.runIntegrity(projectId, false, { continueAfterPass: false });

    const refreshed = this.findProject(projectId);
    const refreshedWorkflow = this.ensureWorkflowState(refreshed.record);
    const latestLedger = this.latestCycleValidationLedger(refreshedWorkflow);
    if (
      refreshedWorkflow.repair.status === "fixed" &&
      latestLedger?.finalValidationStatus === "passed" &&
      refreshedWorkflow.stepProgress.integrity.status === "completed"
    ) {
      await this.finalizeExternalRepairCheckout(projectId);
    }
  }

  async resetWorkflowCycle(projectId: string): Promise<ProjectWorkflowState> {
    const project = this.findProject(projectId);
    const workflow = this.ensureWorkflowState(project.record);

    if (this.hasActiveWorkflowAgent(project)) {
      throw new Error("Wait for the active workflow agent to finish before resetting the cycle.");
    }

    this.cancelScheduledWorkflowAutomation(projectId);
    const cycleNumber = workflow.workflowCycle.cycleNumber;
    const checkoutResetSummary = await this.resetProjectCheckoutToCycleStart(project, workflow);
    const approvedRecommendation = workflow.approvedRecommendation;
    const startGitRef = workflow.workflowCycle.startGitRef;
    const startedAt = workflow.workflowCycle.startedAt ?? nowIso();

    project.record.agents = project.record.agents.filter((agent) => agent.workflowCycleNumber !== cycleNumber);
    project.record.localState.workflowPauseRequested = true;

    workflow.scopedGoal = undefined;
    workflow.previewRequest = defaultProjectWorkflowState().previewRequest;
    this.resetWorkflowRepairState(workflow);
    workflow.workflowCycle = {
      cycleNumber,
      approvedRecommendationId: approvedRecommendation?.recommendationId,
      approvedRecommendationTitle: approvedRecommendation?.title,
      acceptanceCriteria: [],
      status: approvedRecommendation ? "recommendation_approved" : "idle",
      startedAt,
      startGitRef
    };
    workflow.workflowStopReason = approvedRecommendation
      ? "goal_not_scoped"
      : workflow.recommendations.length > 0
        ? "awaiting_recommendation_approval"
        : "recommendation_missing";
    workflow.evidenceObservations = workflow.evidenceObservations.filter((entry) => entry.cycleNumber !== cycleNumber);
    workflow.checklistDeltas = workflow.checklistDeltas.filter((entry) => entry.cycleNumber !== cycleNumber);
    workflow.validationLedgers = workflow.validationLedgers.filter((entry) => entry.cycleNumber !== cycleNumber);
    workflow.repoHygieneReports = workflow.repoHygieneReports.filter((entry) => !entry.scannedRef.includes(`:${cycleNumber}`));
    workflow.cycleRetrospectives = workflow.cycleRetrospectives.filter((entry) => entry.cycleNumber !== cycleNumber);
    workflow.memory.perCycleSummaries = workflow.memory.perCycleSummaries.filter((entry) => entry.cycleNumber !== cycleNumber);
    workflow.memory.contextDescriptors = workflow.memory.contextDescriptors.filter((entry) => entry.cycleNumber !== cycleNumber);
    workflow.memory.lastRelevantContext = workflow.memory.lastRelevantContext.filter((entry) => entry.cycleNumber !== cycleNumber);
    workflow.memory.lastAcceptedDecisions = workflow.memory.lastAcceptedDecisions.filter((entry) =>
      entry.cycleNumber !== cycleNumber || entry.kind === "recommendation"
    );
    workflow.memory.knownOpenIssues = workflow.memory.knownOpenIssues.map((issue) =>
      issue.status === "open" && (issue.source === "coding" || issue.source === "integrity" || issue.source === "merge")
        ? { ...issue, status: "resolved" as const, resolvedAt: nowIso() }
        : issue
    );
    workflow.cycleContract = approvedRecommendation
      ? buildCycleContract(workflow, {
        now: nowIso(),
        selectedTaskSource: workflow.cycleContract?.selectedTaskSource ?? workflow.recommendationHealth.selectedTaskSource
      })
      : undefined;

    if (approvedRecommendation) {
      this.updateWorkflowStepProgress(workflow, "recommendation", {
        requiresUserInput: false,
        currentActivity: "Recommendation approved",
        latestProgressNote: approvedRecommendation.title,
        message: "Cycle was reset. The approved recommendation is preserved and ready to be scoped again.",
        warning: undefined
      }, { status: "completed" });
      this.resetWorkflowStepProgress(workflow, "goal_plan", {
        status: "waiting",
        requiresUserInput: false,
        currentActivity: "Queued for scoping",
        message: "Reset returned this cycle to the start. Continue workflow to rebuild the scoped plan."
      });
    } else {
      this.resetWorkflowStepProgress(workflow, "recommendation", {
        status: workflow.recommendations.length > 0 ? "waiting" : "not_started",
        requiresUserInput: workflow.recommendations.length > 0,
        currentActivity: workflow.recommendations.length > 0 ? "Waiting for a recommendation choice" : "Queued for recommendation generation",
        message: workflow.recommendations.length > 0
          ? "Cycle was reset before a recommendation was approved."
          : "Cycle was reset and recommendations can be generated again."
      });
      this.resetWorkflowStepProgress(workflow, "goal_plan");
    }
    this.resetWorkflowStepProgress(workflow, "coding");
    this.resetWorkflowStepProgress(workflow, "integrity");
    this.resetWorkflowStepProgress(workflow, "merge");
    this.recordWorkflowActivity(workflow, {
      source: "system",
      status: "waiting",
      title: "Current workflow cycle reset",
      detail: `${checkoutResetSummary} Workflow is paused at the start of cycle ${cycleNumber}.`,
      stepId: approvedRecommendation ? "goal_plan" : "recommendation"
    });
    this.syncWorkflowState(project);
    await this.persistProjectUpdate(project, {
      save: "immediate",
      emit: "coalesced",
      reason: "workflow cycle reset"
    });
    return project.record.workflow;
  }

  private async finalizeExternalRepairCheckout(projectId: string): Promise<void> {
    const project = this.findProject(projectId);
    const workflow = this.ensureWorkflowState(project.record);
    const mergeModel = this.getDefaultAgentModel();
    const mergeAgent = await this.createAgent(
      projectId,
      "merge",
      "External Repair Merge",
      "Finalize a repair that was completed in the opened checkout.",
      mergeModel,
      { launchThread: false, persistOnCreate: false }
    );
    mergeAgent.currentPhase = "Finalizing externally repaired checkout";
    this.recordWorkflowActivity(workflow, {
      source: "workflow",
      status: "running",
      title: "External repair finalization started",
      detail: "Validation passed. Checking repository hygiene before finalizing the repaired checkout.",
      stepId: "merge",
      agentId: mergeAgent.id,
      agentCategory: "merge"
    });
    this.updateWorkflowStepProgress(workflow, "merge", {
      requiresUserInput: false,
      currentActivity: "Finalizing external repair",
      latestProgressNote: "Validation passed after repair.",
      message: "Repository hygiene will be checked before the repaired checkout is checkpointed.",
      agentCategory: "merge"
    }, { status: "running", incrementRunCount: true, incrementAttemptCount: true });
    this.syncWorkflowState(project);
    await this.persistProjectUpdate(project, {
      save: false,
      emit: "coalesced",
      reason: "external repair finalization started"
    });

    const runtimeSettings = this.getRuntimeSettings(project.record.distroName);
    const targetBranch = project.scan.kind === "git"
      ? await determineDefaultBranch(project.record.projectRoot, runtimeSettings)
      : project.record.validation.branch ?? project.record.displayPath;
    const hygieneReport = await this.scanWorkflowRepoHygiene(
      project,
      `merge:${workflow.workflowCycle.cycleNumber}:external-repair`,
      true,
      project.record.projectRoot
    );
    mergeAgent.repoHygieneReport = hygieneReport;

    const blockedReasons = this.mergeGateBlockedReasons(workflow, hygieneReport);
    if (blockedReasons.length > 0) {
      const detail = blockedReasons.join(" ");
      mergeAgent.mergeReport = {
        summary: `External repair was validated, but finalization is blocked. ${detail}`,
        targetBranch,
        mergedBranches: [],
        conflicts: [],
        conflictCycleCount: 0,
        generatedAt: nowIso()
      };
      mergeAgent.status = "failed";
      mergeAgent.completedAt = nowIso();
      mergeAgent.currentPhase = "External repair finalization blocked";
      mergeAgent.lastMessageSnippet = mergeAgent.mergeReport.summary.slice(0, 240);
      this.updateWorkflowRepairState(workflow, {
        status: "exhausted",
        latestIssueSummary: mergeAgent.mergeReport.summary,
        latestFailureReason: detail
      });
      workflow.manualHandoff = this.buildRepairManualHandoff(
        project,
        mergeAgent.mergeReport.summary,
        detail,
        "repair_exhausted",
        [
          ...hygieneReport.forbiddenFiles,
          ...hygieneReport.cleanedFiles
        ]
      );
      this.recordWorkflowOpenIssue(workflow, "External repair finalization blocked", detail, "merge");
      this.recordWorkflowActivity(workflow, {
        source: "workflow",
        status: "failed",
        title: "External repair finalization blocked",
        detail,
        stepId: "merge",
        agentId: mergeAgent.id,
        agentCategory: "merge"
      });
      this.updateWorkflowStepProgress(workflow, "merge", {
        requiresUserInput: true,
        currentActivity: "Finalization blocked",
        latestProgressNote: detail,
        message: mergeAgent.mergeReport.summary,
        warning: "Validation and repository hygiene gates must pass before merge or push."
      }, { status: "failed" });
      this.syncWorkflowState(project);
      await this.persistProjectUpdate(project, false);
      return;
    }

    let changedFiles: string[] = [];
    let checkpointCreated = false;
    if (project.scan.kind === "git") {
      const checkpoint = await checkpointWorktreeChanges(
        project.record.projectRoot,
        targetBranch,
        targetBranch,
        "AWB checkpoint: external repair",
        runtimeSettings
      );
      changedFiles = checkpoint.changedFiles;
      checkpointCreated = checkpoint.createdCommit;
      mergeAgent.changedFiles = changedFiles;
      try {
        const refreshedProject = await this.scanCurrentProject(project);
        this.applyScannedProjectState(project, refreshedProject);
        await this.saveRepositoryIndex(project);
      } catch (error) {
        this.diagnostics.unshift(
          `External repair finalization checkpointed ${targetBranch}, but the project overview refresh failed. ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    mergeAgent.mergeReport = {
      summary: project.scan.kind === "git"
        ? checkpointCreated
          ? `Externally repaired checkout was validated, hygiene checked, and checkpointed on ${targetBranch}.`
          : `Externally repaired checkout was validated and hygiene checked on ${targetBranch}; no pending checkout changes needed a new checkpoint.`
        : "Externally repaired project folder was validated and hygiene checked in place.",
      targetBranch,
      mergedBranches: [],
      conflicts: [],
      conflictCycleCount: 0,
      generatedAt: nowIso()
    };

    const published = project.scan.kind === "git"
      ? await this.publishMergedCheckoutToOrigin(project, mergeAgent, workflow, targetBranch, "External repair finalization")
      : true;
    if (!published) {
      this.syncWorkflowState(project);
      await this.persistProjectUpdate(project, false);
      return;
    }

    this.resetWorkflowRepairState(workflow);
    workflow.manualHandoff = undefined;
    this.resolveWorkflowOpenIssues(workflow, (issue) => issue.source === "integrity" || issue.source === "merge" || issue.source === "coding");
    this.resolveWorkflowHumanInterventions(
      workflow,
      (intervention) => intervention.requestedByAgentCategory === "merge",
      "Resolved automatically after external repair finalization completed."
    );
    workflow.workflowCycle.status = "merged";
    mergeAgent.status = "completed";
    mergeAgent.completedAt = nowIso();
    mergeAgent.currentPhase = "External repair finalized";
    mergeAgent.lastMessageSnippet = mergeAgent.mergeReport.summary.slice(0, 240);
    this.recordWorkflowActivity(workflow, {
      source: "workflow",
      status: "completed",
      title: "External repair integrated",
      detail: mergeAgent.mergeReport.summary,
      stepId: "merge",
      agentId: mergeAgent.id,
      agentCategory: "merge"
    });
    this.updateWorkflowStepProgress(workflow, "merge", {
      requiresUserInput: false,
      currentActivity: "Integration complete",
      latestProgressNote: changedFiles.length
        ? `Finalized ${changedFiles.length} repaired file${changedFiles.length === 1 ? "" : "s"}.`
        : "No pending repaired files needed checkpointing.",
      message: mergeAgent.mergeReport.summary,
      warning: undefined,
      agentCategory: "merge"
    }, { status: "completed" });
    this.syncWorkflowState(project);
    await this.persistProjectUpdate(project, {
      save: "deferred",
      emit: "coalesced",
      automate: true,
      reason: "external repair finalized"
    });
  }

  private async createHumanInterventionRecord(
    project: LoadedProject,
    request: Omit<HumanInterventionRecord, "id" | "status" | "createdAt" | "resolvedAt" | "resolutionNotes">,
    options?: {
      persist?: boolean;
      stepId?: ProjectWorkflowState["stepProgress"][keyof ProjectWorkflowState["stepProgress"]]["stepId"];
    }
  ): Promise<HumanInterventionRecord> {
    const workflow = this.ensureWorkflowState(project.record);
    const intervention: HumanInterventionRecord = {
      id: nanoid(),
      status: "pending",
      createdAt: nowIso(),
      ...request
    };
    workflow.humanInterventions.unshift(intervention);
    this.recordWorkflowOpenIssue(workflow, intervention.title, intervention.description, "human");
    this.recordWorkflowActivity(workflow, {
      source: "workflow",
      status: "waiting",
      title: "Requested human intervention",
      detail: intervention.title,
      stepId: options?.stepId ?? getWorkflowActiveStepId(workflow)
    });
    this.syncWorkflowState(project);
    if (options?.persist !== false) {
      await this.persistProjectUpdate(project);
    }
    return intervention;
  }

  private async resolveHumanInterventionRecord(
    project: LoadedProject,
    interventionId: string,
    status: "resolved" | "dismissed" = "resolved",
    resolutionNotes = "",
    options?: {
      persist?: boolean;
    }
  ): Promise<HumanInterventionRecord> {
    const workflow = this.ensureWorkflowState(project.record);
    const intervention = workflow.humanInterventions.find((entry) => entry.id === interventionId);
    if (!intervention) {
      throw new Error(`Unknown human intervention: ${interventionId}`);
    }

    intervention.status = status;
    intervention.resolutionNotes = resolutionNotes || undefined;
    intervention.resolvedAt = nowIso();
    this.resolveWorkflowOpenIssues(workflow, (issue) => issue.source === "human" && issue.title === intervention.title);
    this.recordAcceptedDecision(workflow, {
      kind: "human_intervention",
      title: intervention.title,
      summary: resolutionNotes,
      cycleNumber: workflow.workflowCycle.cycleNumber,
      sourceAgentCategory: intervention.requestedByAgentCategory
    });
    this.recordWorkflowActivity(workflow, {
      source: "workflow",
      status: "completed",
      title: "Resolved human intervention",
      detail: intervention.title,
      stepId: getWorkflowActiveStepId(workflow)
    });
    this.syncWorkflowState(project);
    if (options?.persist !== false) {
      await this.persistProjectUpdate(project, true);
    }
    return intervention;
  }

  private getUserInputRequestInboxRelativePath(requestId: string): string {
    return path.posix.join(USER_INPUT_REQUESTS_PATH, requestId);
  }

  private resolveUserInputRequestInboxHostPath(project: LoadedProject, requestId: string): string {
    return path.join(project.record.hostPath, ...this.getUserInputRequestInboxRelativePath(requestId).split("/"));
  }

  private getUserInputRequestInboxPath(project: LoadedProject, requestId: string): string {
    return path.posix.join(project.record.projectRoot, this.getUserInputRequestInboxRelativePath(requestId));
  }

  private normalizeUserInputRequestQuestions(
    project: LoadedProject,
    questions: ToolRequestUserInputQuestion[]
  ): UserInputRequestQuestion[] {
    const normalized = questions.map((question, index) => ({
      id: question.id?.trim() || `question-${index + 1}`,
      header:
        this.sanitizeTextToProjectBoundary(project, question.header?.trim() || `Step ${index + 1}`, project.record.projectRoot)
        ?? `Step ${index + 1}`,
      question:
        this.sanitizeTextToProjectBoundary(
          project,
          question.question?.trim() || "Describe what you completed so the agent can continue.",
          project.record.projectRoot
        )
        ?? "Describe what you completed so the agent can continue.",
      isOther: question.isOther,
      isSecret: question.isSecret,
      options: (question.options ?? []).map((option) => ({
        label: option.label,
        description: option.description
      }))
    }));

    if (normalized.length > 0) {
      return normalized;
    }

    return [{
      id: "details",
      header: "Details",
      question: "Describe what you completed so the agent can continue.",
      isOther: true,
      isSecret: false,
      options: []
    }];
  }

  private buildUserInputRequestTitle(questions: UserInputRequestQuestion[]): string {
    return questions[0]?.header.trim() || "Provide external input";
  }

  private buildUserInputRequestDescription(questions: UserInputRequestQuestion[]): string {
    if (questions.length === 1) {
      return questions[0].question;
    }
    return "The agent paused and needs the requested setup or answers below before it can continue.";
  }

  private inferCredentialRequestText(questions: UserInputRequestQuestion[]): string {
    return questions.map((question) => `${question.header} ${question.question}`).join(" ").trim();
  }

  private looksLikeCredentialRequest(questions: UserInputRequestQuestion[]): boolean {
    const text = this.inferCredentialRequestText(questions);
    return questions.some((question) => question.isSecret) ||
      /\b(api key|secret key|access key|token|credential|client secret|bearer|oauth|alpaca|polygon|twelve data)\b/i.test(text);
  }

  private looksLikePaidCredentialRequest(questions: UserInputRequestQuestion[]): boolean {
    const text = this.inferCredentialRequestText(questions);
    const explicitlyFree = /\b(free|free-tier|free tier|no cost|no-cost|no credit card|without payment|unpaid|demo key|public key)\b/i.test(text);
    if (explicitlyFree) {
      return false;
    }
    return /\b(paid|billing|subscription|credit card|card required|paid tier|premium plan|upgrade plan|invoice|usage charge|metered billing)\b/i.test(text);
  }

  private inferCredentialProviderName(questions: UserInputRequestQuestion[]): string {
    const text = this.inferCredentialRequestText(questions);
    const knownProvider = [
      "Polygon.io",
      "Alpaca",
      "Twelve Data",
      "Alpha Vantage",
      "IEX Cloud",
      "Finnhub",
      "Binance",
      "Coinbase"
    ].find((provider) => new RegExp(provider.replace(".", "\\."), "i").test(text));
    if (knownProvider) {
      return knownProvider;
    }

    const apiKeyMatch = text.match(/\b([A-Z][A-Za-z0-9 ._-]{2,40})\s+(?:api\s+key|key\s+\+\s+secret|credentials?|token)\b/);
    if (apiKeyMatch?.[1]) {
      return apiKeyMatch[1].replace(/\s+/g, " ").trim();
    }

    return "External provider";
  }

  private inferCredentialKeyLabel(questions: UserInputRequestQuestion[]): string {
    const text = this.inferCredentialRequestText(questions);
    if (/\bkey\s*\+\s*secret\b/i.test(text) || /\bsecret key\b/i.test(text)) {
      return "API key + secret";
    }
    if (/\btoken\b/i.test(text)) {
      return "Access token";
    }
    return "API key";
  }

  private addCredentialRequestForUserInput(
    project: LoadedProject,
    agent: AgentState,
    userInputRequest: UserInputRequestRecord,
    intervention?: HumanInterventionRecord
  ): void {
    if (!this.looksLikeCredentialRequest(userInputRequest.questions)) {
      return;
    }

    project.record.credentials = {
      ...defaultProjectCredentialsState(),
      ...project.record.credentials,
      entries: project.record.credentials?.entries ?? [],
      requests: project.record.credentials?.requests ?? []
    };

    if (project.record.credentials.requests.some((request) => request.userInputRequestId === userInputRequest.id)) {
      project.record.layout.activeCenterTab = "credentials";
      return;
    }

    const providerName = this.inferCredentialProviderName(userInputRequest.questions);
    const keyLabel = this.inferCredentialKeyLabel(userInputRequest.questions);
    const existing = project.record.credentials.requests.find((request) =>
      request.status === "pending" &&
      request.providerName.toLowerCase() === providerName.toLowerCase() &&
      request.keyLabel.toLowerCase() === keyLabel.toLowerCase()
    );
    if (existing) {
      existing.userInputRequestId ??= userInputRequest.id;
      existing.humanInterventionId ??= intervention?.id;
      existing.agentId ??= agent.id;
      existing.freeOnly ??= !this.settings.considerPaidServices;
      project.record.layout.activeCenterTab = "credentials";
      return;
    }

    project.record.credentials.requests.unshift({
      id: nanoid(),
      providerName,
      keyLabel,
      description: userInputRequest.description,
      status: "pending",
      requestedByAgentCategory: agent.category,
      agentId: agent.id,
      userInputRequestId: userInputRequest.id,
      humanInterventionId: intervention?.id,
      freeOnly: !this.settings.considerPaidServices,
      createdAt: userInputRequest.createdAt
    });
    project.record.layout.activeCenterTab = "credentials";
  }

  private findUserInputRequest(project: LoadedProject, requestId: string): UserInputRequestRecord {
    const request = project.record.userInputRequests.find((entry) => entry.id === requestId);
    if (!request) {
      throw new Error(`Unknown user input request: ${requestId}`);
    }
    return request;
  }

  private async resolveUniqueAttachmentName(directoryPath: string, baseName: string): Promise<string> {
    const parsed = path.parse(baseName || "attachment");
    const safeBaseName = (parsed.base || "attachment").trim() || "attachment";
    let candidate = safeBaseName;
    let suffix = 2;
    while (true) {
      try {
        await access(path.join(directoryPath, candidate));
        candidate = `${parsed.name || "attachment"}-${suffix}${parsed.ext}`;
        suffix += 1;
      } catch {
        return candidate;
      }
    }
  }

  async requestHumanIntervention(
    projectId: string,
    request: Omit<HumanInterventionRecord, "id" | "status" | "createdAt" | "resolvedAt" | "resolutionNotes">
  ): Promise<HumanInterventionRecord> {
    const project = this.findProject(projectId);
    return await this.createHumanInterventionRecord(project, request);
  }

  async resolveHumanIntervention(
    projectId: string,
    interventionId: string,
    status: "resolved" | "dismissed" = "resolved",
    resolutionNotes = ""
  ): Promise<HumanInterventionRecord> {
    const project = this.findProject(projectId);
    return await this.resolveHumanInterventionRecord(project, interventionId, status, resolutionNotes);
  }

  async getUserInputRequestInboxHostPath(projectId: string, requestId: string): Promise<string> {
    const project = this.findProject(projectId);
    const request = this.findUserInputRequest(project, requestId);
    const hostPath = this.resolveUserInputRequestInboxHostPath(project, request.id);
    await mkdir(hostPath, { recursive: true });
    return hostPath;
  }

  async addUserInputRequestAttachments(projectId: string, requestId: string, sourcePaths: string[]): Promise<UserInputRequestRecord> {
    const project = this.findProject(projectId);
    const request = this.findUserInputRequest(project, requestId);
    if (request.status !== "pending") {
      throw new Error("Attachments can only be added while the request is still pending.");
    }

    const hostDirectoryPath = await this.getUserInputRequestInboxHostPath(projectId, requestId);
    for (const sourcePath of sourcePaths) {
      const fileStats = await stat(sourcePath);
      if (!fileStats.isFile()) {
        throw new Error("Only files can be attached right now.");
      }

      const targetName = await this.resolveUniqueAttachmentName(hostDirectoryPath, path.basename(sourcePath));
      const targetHostPath = path.join(hostDirectoryPath, targetName);
      await copyFile(sourcePath, targetHostPath);
      request.attachments.unshift({
        id: nanoid(),
        name: targetName,
        relativePath: path.posix.join(request.attachmentInboxRelativePath, targetName),
        sizeBytes: fileStats.size,
        addedAt: nowIso()
      });
    }

    await this.persistProjectUpdate(project);
    return request;
  }

  async submitUserInputRequest(projectId: string, requestId: string, answers: string[]): Promise<UserInputRequestRecord> {
    const project = this.findProject(projectId);
    const request = this.findUserInputRequest(project, requestId);
    if (request.status !== "pending") {
      throw new Error("This request was already submitted.");
    }

    const normalizedAnswers = request.questions.map((question, index) => {
      const answer = answers[index]?.trim() ?? "";
      if (!answer) {
        throw new Error(`Answer required for "${question.header}".`);
      }
      return answer;
    });

    const attachmentNote = request.attachments.length
      ? [
        "",
        "User-added files are available inside the project at:",
        ...request.attachments.map((attachment) => `- ${attachment.relativePath}`),
        "Treat these as user-provided inputs unless the user explicitly asks for them to become project files."
      ].join("\n")
      : "";
    if (attachmentNote) {
      const preferredIndex = request.questions.findIndex((question) => !question.isSecret);
      const answerIndex = preferredIndex >= 0 ? preferredIndex : Math.max(0, normalizedAnswers.length - 1);
      normalizedAnswers[answerIndex] = `${normalizedAnswers[answerIndex]}${attachmentNote}`;
    }

    if (this.transport) {
      await this.transport.respond(request.serverRequestId, { answers: normalizedAnswers });
    }

    request.status = "submitted";
    request.submittedAt = nowIso();

    const agent = project.record.agents.find((entry) => entry.id === request.agentId);
    if (agent) {
      reduceAgentRuntimeEvent(agent, {
        kind: "raw",
        title: "User input submitted",
        detail: request.title,
        raw: {
          answerCount: normalizedAnswers.length,
          attachments: request.attachments.map((attachment) => attachment.relativePath)
        }
      });
      this.mirrorLatestAgentEventToWorkflow(this.ensureWorkflowState(project.record), agent);
    }

    if (request.humanInterventionId) {
      const notes = request.attachments.length
        ? `Submitted external input and ${request.attachments.length} attachment(s) to the agent.`
        : "Submitted external input to the agent.";
      await this.resolveHumanInterventionRecord(project, request.humanInterventionId, "resolved", notes, { persist: false });
    }

    await this.persistProjectUpdate(project, true);
    return request;
  }

  private autoLinkMatchingCredentialRequests(
    project: LoadedProject,
    providerName: string,
    keyLabel: string,
    explicitRequestIds: string[]
  ): string[] {
    const explicit = new Set(explicitRequestIds);
    for (const request of project.record.credentials.requests) {
      if (
        request.status === "pending" &&
        request.providerName.toLowerCase() === providerName.toLowerCase() &&
        request.keyLabel.toLowerCase() === keyLabel.toLowerCase()
      ) {
        explicit.add(request.id);
      }
    }
    return [...explicit];
  }

  async saveCredentialEntry(
    projectId: string,
    input: {
      entryId?: string;
      providerName: string;
      keyLabel: string;
      apiKey: string;
      secretKey?: string;
      notes?: string;
      status?: CredentialEntryStatus;
      linkedRequestIds?: string[];
    }
  ): Promise<CredentialEntryMetadata> {
    const project = this.findProject(projectId);
    project.record.credentials = {
      ...defaultProjectCredentialsState(),
      ...project.record.credentials,
      entries: project.record.credentials?.entries ?? [],
      requests: project.record.credentials?.requests ?? []
    };

    const providerName = input.providerName.trim();
    const keyLabel = input.keyLabel.trim();
    const apiKey = input.apiKey.trim();
    const secretKey = input.secretKey?.trim();
    if (!providerName || !keyLabel || !apiKey) {
      throw new Error("Provider name, key label, and API key are required.");
    }

    const now = nowIso();
    const existing = input.entryId
      ? project.record.credentials.entries.find((entry) => entry.id === input.entryId)
      : undefined;
    const linkedRequestIds = this.autoLinkMatchingCredentialRequests(
      project,
      providerName,
      keyLabel,
      input.linkedRequestIds ?? existing?.linkedRequestIds ?? []
    );
    const entry: CredentialEntryMetadata = {
      id: existing?.id ?? nanoid(),
      providerName,
      keyLabel,
      hasApiKey: true,
      hasSecretKey: Boolean(secretKey),
      status: input.status ?? existing?.status ?? "active",
      source: existing?.source ?? "user",
      freeTier: existing?.freeTier,
      notes: input.notes?.trim() || undefined,
      linkedRequestIds,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };

    await this.storage.saveCredentialSecret(project.record.id, entry.id, {
      apiKey,
      secretKey
    } satisfies CredentialSecretInput);

    project.record.credentials.entries = [
      entry,
      ...project.record.credentials.entries.filter((candidate) => candidate.id !== entry.id)
    ];

    for (const request of project.record.credentials.requests) {
      if (!linkedRequestIds.includes(request.id)) {
        continue;
      }
      const linkedUserInput = request.userInputRequestId
        ? project.record.userInputRequests.find((entry) => entry.id === request.userInputRequestId)
        : undefined;
      if (linkedUserInput?.status === "pending") {
        request.status = "pending";
        request.resolvedAt = undefined;
        request.notes = "Credential metadata was stored locally. Use Send to waiting agent for explicit approval before any secret is shared.";
      } else {
        request.status = "fulfilled";
        request.resolvedAt = now;
        request.notes = request.notes ?? "Credential metadata was stored locally. Secret values were not sent to agents automatically.";
      }
    }

    this.recordWorkflowActivity(this.ensureWorkflowState(project.record), {
      source: "system",
      status: "completed",
      title: "Stored local credential metadata",
      detail: `${providerName} ${keyLabel}`,
      stepId: "recommendation"
    });
    await this.persistProjectUpdate(project);
    return entry;
  }

  async deleteCredentialEntry(projectId: string, entryId: string): Promise<void> {
    const project = this.findProject(projectId);
    const existing = project.record.credentials?.entries.find((entry) => entry.id === entryId);
    if (!existing) {
      throw new Error(`Unknown credential entry: ${entryId}`);
    }

    await this.storage.deleteCredentialSecret(project.record.id, entryId);
    project.record.credentials.entries = project.record.credentials.entries.filter((entry) => entry.id !== entryId);
    this.recordWorkflowActivity(this.ensureWorkflowState(project.record), {
      source: "system",
      status: "completed",
      title: "Removed local credential metadata",
      detail: `${existing.providerName} ${existing.keyLabel}`,
      stepId: "recommendation"
    });
    await this.persistProjectUpdate(project);
  }

  async updateCredentialRequest(
    projectId: string,
    requestId: string,
    status: CredentialRequestStatus,
    notes = ""
  ): Promise<CredentialRequestRecord> {
    const project = this.findProject(projectId);
    const request = project.record.credentials?.requests.find((entry) => entry.id === requestId);
    if (!request) {
      throw new Error(`Unknown credential request: ${requestId}`);
    }

    request.status = status;
    request.notes = notes.trim() || undefined;
    request.resolvedAt = status === "pending" ? undefined : nowIso();
    await this.persistProjectUpdate(project);
    return request;
  }

  private credentialAnswerForQuestion(
    question: UserInputRequestQuestion,
    secrets: CredentialSecretInput,
    entry: CredentialEntryMetadata
  ): string {
    const text = `${question.header} ${question.question}`;
    if (question.isSecret) {
      if (/\b(secret|private|client secret)\b/i.test(text)) {
        if (!secrets.secretKey?.trim()) {
          throw new Error(`The stored credential for ${entry.providerName} does not include a secret key.`);
        }
        return secrets.secretKey;
      }
      if (!secrets.apiKey.trim()) {
        throw new Error(`The stored credential for ${entry.providerName} does not include an API key.`);
      }
      return secrets.apiKey;
    }

    return [
      `Credential approved from the local Credentials section: ${entry.providerName} (${entry.keyLabel}).`,
      "Use it only for this run, do not write it into project files, logs, portable interface data, or prompts, and preserve demo/mock or missing-credential states."
    ].join(" ");
  }

  async submitCredentialRequestToAgent(projectId: string, requestId: string): Promise<CredentialRequestRecord> {
    const project = this.findProject(projectId);
    const credentialRequest = project.record.credentials?.requests.find((entry) => entry.id === requestId);
    if (!credentialRequest) {
      throw new Error(`Unknown credential request: ${requestId}`);
    }
    if (!credentialRequest.userInputRequestId) {
      throw new Error("This credential request is not linked to a waiting agent input request.");
    }

    const userInputRequest = this.findUserInputRequest(project, credentialRequest.userInputRequestId);
    if (userInputRequest.status !== "pending") {
      throw new Error("The linked agent input request is no longer pending.");
    }

    const entry = project.record.credentials.entries.find((candidate) =>
      candidate.status === "active" &&
      candidate.linkedRequestIds.includes(credentialRequest.id)
    ) ?? project.record.credentials.entries.find((candidate) =>
      candidate.status === "active" &&
      candidate.providerName.toLowerCase() === credentialRequest.providerName.toLowerCase() &&
      candidate.keyLabel.toLowerCase() === credentialRequest.keyLabel.toLowerCase()
    );
    if (!entry) {
      throw new Error("Store an active credential for this request before sending it to the agent.");
    }

    const secrets = await this.storage.readCredentialSecret(project.record.id, entry.id);
    if (!secrets?.apiKey.trim()) {
      throw new Error("The stored credential secret could not be read.");
    }

    const answers = userInputRequest.questions.map((question) => this.credentialAnswerForQuestion(question, secrets, entry));
    await this.submitUserInputRequest(projectId, userInputRequest.id, answers);

    credentialRequest.status = "fulfilled";
    credentialRequest.resolvedAt = nowIso();
    credentialRequest.submittedToAgentAt = credentialRequest.resolvedAt;
    credentialRequest.notes = "Credential was sent to the waiting agent after explicit user approval from the Credentials section.";

    const agent = project.record.agents.find((candidate) => candidate.id === userInputRequest.agentId);
    if (agent) {
      reduceAgentRuntimeEvent(agent, {
        kind: "raw",
        title: "Credential approved for agent",
        detail: `${entry.providerName} ${entry.keyLabel}`
      });
      this.mirrorLatestAgentEventToWorkflow(this.ensureWorkflowState(project.record), agent);
    }

    this.recordWorkflowActivity(this.ensureWorkflowState(project.record), {
      source: "system",
      status: "completed",
      title: "Credential sent to waiting agent",
      detail: `${entry.providerName} ${entry.keyLabel}`,
      stepId: getWorkflowActiveStepId(this.ensureWorkflowState(project.record)),
      agentId: userInputRequest.agentId,
      agentCategory: userInputRequest.requestedByAgentCategory
    });
    await this.persistProjectUpdate(project, true);
    return credentialRequest;
  }

  async advanceWorkflowStage(projectId: string): Promise<ProjectWorkflowState["workflowStage"]> {
    const project = this.findProject(projectId);
    this.syncWorkflowState(project);
    await this.ensureAgentBackedRuntimeReady(project, "workflow advance runtime check");
    if (!this.hasActiveWorkflowAgent(project) && this.requeueStaleRunningWorkflowSteps(project)) {
      this.recordWorkflowActivity(this.ensureWorkflowState(project.record), {
        source: "system",
        status: "waiting",
        title: "Stale workflow active step requeued",
        detail: "The saved active step had no live agent attached, so it was returned to a queued state before continuing.",
        stepId: getWorkflowActiveStepId(this.ensureWorkflowState(project.record))
      });
      this.syncWorkflowState(project);
    }
    const workflow = this.ensureWorkflowState(project.record);
    if (workflow.autopilotStatus?.pausedReason === "high_risk_package_requires_approval") {
      const recommendation = this.resolveRecommendationForApproval(workflow, workflow.autopilotStatus.currentRecommendationId);
      if (recommendation) {
        await this.approveRecommendation(projectId, recommendation.id, "manual");
        return this.findProject(projectId).record.workflow.workflowStage;
      }

      this.recordWorkflowActivity(workflow, {
        source: "workflow",
        status: "waiting",
        title: "Stale recommendation checkpoint refreshed",
        detail: "The selected checkpoint no longer exists in the saved recommendation list. Regenerate recommendations, then choose the next package.",
        stepId: "recommendation"
      });
      workflow.approvedRecommendation = undefined;
      workflow.scopedGoal = undefined;
      workflow.recommendations = [];
      workflow.recommendationsGeneratedAt = undefined;
      this.resetWorkflowStepProgress(workflow, "recommendation", {
        status: "waiting",
        requiresUserInput: false,
        currentActivity: "Queued for recommendation refresh",
        message: "The previous checkpoint was stale, so recommendations will be generated again."
      });
      this.syncWorkflowState(project);
      await this.persistProjectUpdate(project, {
        save: "deferred",
        emit: "coalesced",
        automate: true,
        reason: "stale recommendation checkpoint refreshed"
      });
      return project.record.workflow.workflowStage;
    }
    if (this.workflowAutomationInFlight.has(projectId) || this.workflowAutomationTimers.has(projectId)) {
      this.workflowAutomationQueued.add(projectId);
      this.logWorkflowPerf(`advanceWorkflowStage coalesced for ${project.record.identity.projectName}`);
      return project.record.workflow.workflowStage;
    }
    if (project.record.workflow.workflowStage === "merged") {
      this.finalizeWorkflowCycle(project);
    } else {
      this.syncWorkflowState(project);
    }
    await this.persistProjectUpdate(project, {
      save: "deferred",
      emit: "coalesced",
      automate: true,
      reason: "advance workflow stage"
    });
    return project.record.workflow.workflowStage;
  }

  recoverWorkflow(projectId: string): ProjectWorkflowState["workflowStage"] {
    const project = this.findProject(projectId);
    if (this.workflowRecoveryInFlight.has(projectId)) {
      return project.record.workflow.workflowStage;
    }

    const workflow = this.ensureWorkflowState(project.record);
    const reason = "Recovery was requested after the previous agent run stopped responding or lost its app-server connection.";
    const disconnectedAgents = project.record.agents.filter((agent) =>
      agent.category !== "manual" &&
      agent.status === "disconnected" &&
      !agent.recoveryHandledAt &&
      (agent.workflowCycleNumber === undefined || agent.workflowCycleNumber === workflow.workflowCycle.cycleNumber)
    );
    for (const agent of disconnectedAgents) {
      this.cancelPendingApprovalsForInterruptedAgent(agent);
    }
    const interruptedAgents = [...new Map(
      [...disconnectedAgents, ...this.markActiveAgentsDisconnected(project, reason)].map((agent) => [agent.id, agent])
    ).values()];
    const recoveryStepId = interruptedAgents
      .map((agent) => this.getWorkflowStepIdForAgent(agent))
      .find((stepId): stepId is WorkflowStepId => Boolean(stepId));

    project.record.localState.workflowPauseRequested = false;
    this.resetWorkflowAfterInterruptedAgents(project, interruptedAgents, { markRecoveryHandled: true });
    this.reconcileWorkflowResumeState(project);
    this.recordWindowsMountWarningIfNeeded(project);
    this.markWorkflowStartupProgress(
      project,
      "recovering",
      "Continue was acknowledged. Recovery, Codex startup, and the next workflow step will continue in the background.",
      recoveryStepId
    );

    this.syncWorkflowState(project);
    this.scheduleProjectSave(project);
    this.emitStateNow("workflow recovery acknowledged");
    this.workflowRecoveryInFlight.add(projectId);
    void this.runWorkflowRecoveryStartup(projectId).catch((error) => {
      this.diagnostics.unshift(
        `Workflow recovery failed. ${error instanceof Error ? error.message : String(error)}`
      );
    });
    return project.record.workflow.workflowStage;
  }

  private async runWorkflowRecoveryStartup(projectId: string): Promise<void> {
    const startedAt = performance.now();
    try {
      let project = this.findProject(projectId);
      this.logWorkflowPerf(`workflow recovery entered for ${project.record.identity.projectName}`);
      const transportStartedAt = performance.now();
      await this.ensureAgentBackedRuntimeReady(project, "workflow recovery runtime check");
      this.logWorkflowPerf(`runtime readiness check ${Math.round(performance.now() - transportStartedAt)}ms`);

      project = this.findProject(projectId);
      this.markWorkflowStartupProgress(
        project,
        "starting",
        "Recovery is complete. The next workflow step is starting in the background."
      );
      this.syncWorkflowState(project);
      await this.persistProjectUpdate(project, true);
      this.logWorkflowPerf(`workflow recovery scheduled next step in ${Math.round(performance.now() - startedAt)}ms`);
    } catch (error) {
      const project = this.projects.get(projectId);
      if (project) {
        const workflow = this.ensureWorkflowState(project.record);
        this.recordWorkflowActivity(workflow, {
          source: "system",
          status: "failed",
          title: "Workflow recovery failed",
          detail: error instanceof Error ? error.message : String(error),
          stepId: getWorkflowActiveStepId(workflow)
        });
        const stepId = getWorkflowActiveStepId(workflow);
        this.updateWorkflowStepProgress(workflow, stepId, {
          message: error instanceof Error ? error.message : String(error),
          warning: error instanceof Error ? error.message : String(error)
        }, { status: "failed" });
        await this.persistProjectUpdate(project);
      }
      throw error;
    } finally {
      this.workflowRecoveryInFlight.delete(projectId);
    }
  }

  async clearStaleWorkflowLock(projectId: string): Promise<ProjectWorkflowState["workflowStage"]> {
    const project = this.findProject(projectId);
    const workflow = this.ensureWorkflowState(project.record);
    const reason = "The stale running lock was cleared by the operator. No active Codex process was attached to this saved run.";
    const interruptedAgents = this.markActiveAgentsDisconnected(project, reason);
    this.resetWorkflowAfterInterruptedAgents(project, interruptedAgents, { markRecoveryHandled: true });
    const requeued = this.requeueStaleRunningWorkflowSteps(project);
    project.record.localState.workflowPauseRequested = true;
    if (interruptedAgents.length > 0 || requeued) {
      this.recordWorkflowActivity(workflow, {
        source: "system",
        status: "waiting",
        title: "Stale workflow lock cleared",
        detail: "The saved running state was marked interrupted. The current goal, checklist, and stage decisions were preserved.",
        stepId: getWorkflowActiveStepId(workflow)
      });
    }
    this.reconcileWorkflowResumeState(project);
    this.syncWorkflowState(project);
    await this.saveProject(project);
    this.emitState();
    return project.record.workflow.workflowStage;
  }

  async createAgent(
    projectId: string,
    category: AgentCategory,
    name: string,
    prompt: string,
    model: string,
    options?: {
      sandbox?: "workspace-write" | "read-only";
      outputSchema?: JsonValue;
      reasoningMode?: AgentReasoningMode;
      effort?: InterfaceReasoningEffort;
      initialPhase?: string;
      turnPrompt?: string;
      launchThread?: boolean;
      targetBranch?: string;
      persistOnCreate?: boolean;
      repositorySummaryTarget?: RepositoryPathSummaryTarget;
    }
  ): Promise<AgentState> {
    const project = this.findProject(projectId);
    const launchThread = options?.launchThread !== false;
    const writeEnabled = isWriteEnabledAgentCategory(category) && options?.sandbox !== "read-only";
    if (launchThread) {
      this.assertGitHubLinked();
      await this.ensureAgentBackedRuntimeReady(project, "agent creation runtime check");
    }

    const accessProbe = project.record.validation.projectAccess;
    if (writeEnabled && accessProbe?.status === "failed") {
      throw new Error(
        accessProbe.error
          ? `Write-enabled agents are blocked until project access is fixed. ${accessProbe.error}`
          : "Write-enabled agents are blocked until the project access check succeeds."
      );
    }

    if (project.scan.kind === "folder" && writeEnabled) {
      const writeAgents = project.record.agents.filter(
        (agent) => isWriteEnabledAgentCategory(agent.category) && agent.status !== "completed" && agent.status !== "disconnected"
      );
      if (writeAgents.length >= 1) {
        throw new Error("Non-Git projects only allow one write-enabled coding or manual agent at a time.");
      }
    }

    const workflow = this.ensureWorkflowState(project.record);
    const agent = createAgentSkeleton(category, name, prompt, model || this.getDefaultAgentModel());
    const reasoningConfig = this.resolveAgentReasoningEffortForTask(
      category,
      agent.model,
      `${name}\n\n${prompt}`,
      options?.reasoningMode ?? (options?.effort ? "manual" : undefined),
      options?.effort
    );
    agent.reasoningEffort = reasoningConfig.effort;
    agent.reasoningEffortSource = reasoningConfig.source;
    agent.workflowCycleNumber = category === "manual" ? undefined : workflow.workflowCycle.cycleNumber;
    agent.taskPrompt = `${agentRoles[category].instructions}\n\n${prompt}`;
    agent.repositorySummaryTarget = options?.repositorySummaryTarget;
    agent.status = launchThread ? "starting" : "running";
    agent.startedAt = launchThread ? undefined : nowIso();
    agent.currentPhase = options?.initialPhase ?? (category === "manual" ? "Handling manual request" : undefined);
    this.assertResolvedPathCompatible(project.record.distroName);
    const runtimeSettings = this.getRuntimeSettings(project.record.distroName);

    if (writeEnabled && project.scan.kind === "git") {
      const targetBranch = options?.targetBranch ?? (await determineDefaultBranch(project.record.projectRoot, runtimeSettings));
      const worktreeStartedAt = performance.now();
      agent.worktree = await createWorktreeAssignment(
        project.record.projectRoot,
        this.settings.worktreeBaseDir,
        project.record.identity.projectName,
        name,
        targetBranch,
        runtimeSettings
      );
      await assertExecutionPathWithinProjectRoot(
        project.record.projectRoot,
        agent.worktree.worktreePath,
        project.record.hostPath,
        runtimeSettings,
        project.record.distroName,
        `${agentRoles[category].name} worktree creation`
      );
      this.logWorkflowPerf(`worktree setup for ${name}: ${Math.round(performance.now() - worktreeStartedAt)}ms`);
    }

    project.record.agents.unshift(agent);
    if (category !== "manual") {
      this.touchAgentFreshness(workflow, category);
    }
    if (category === "coding") {
      const repairAttemptLabel = workflow.repair.status === "repairing"
        ? `Repair attempt ${workflow.repair.attemptCount} of ${workflow.repair.maxAttempts}`
        : undefined;
      this.updateWorkflowStepProgress(workflow, "coding", {
        requiresUserInput: false,
        currentActivity: workflow.repair.status === "repairing" ? "Repairing the current execution plan" : "Implementing the current execution plan",
        latestProgressNote: name,
        message: prompt,
        currentSubstep: repairAttemptLabel,
        agentCategory: "coding"
      }, {
        status: "running",
        incrementRunCount: true,
        incrementAttemptCount: true
      });
      if (workflow.repair.status === "repairing") {
        this.recordWorkflowActivity(workflow, {
          source: "workflow",
          status: "running",
          title: repairAttemptLabel ?? "Repair pass started",
          detail: name,
          stepId: "coding",
          agentId: agent.id,
          agentCategory: "coding"
        });
      } else {
        this.recordWorkflowActivity(workflow, {
          source: "workflow",
          status: "running",
          title: "Coding pass started",
          detail: name,
          stepId: "coding",
          agentId: agent.id,
          agentCategory: "coding"
        });
      }
      this.resetWorkflowStepProgress(workflow, "integrity");
      this.resetWorkflowStepProgress(workflow, "merge");
    } else if (category === "goal" && name === "Ultimate Goal Agent") {
      this.updateWorkflowStepProgress(workflow, "ultimate_goal", {
        requiresUserInput: true,
        currentActivity: "Analyzing the project to draft the Ultimate Goal",
        latestProgressNote: "Inspecting repository context",
        message: "A draft is being prepared.",
        agentCategory: "goal"
      }, { status: "running", incrementRunCount: true, incrementAttemptCount: true });
      this.recordWorkflowActivity(workflow, {
        source: "workflow",
        status: "running",
        title: "Ultimate Goal detection started",
        detail: name,
        stepId: "ultimate_goal",
        agentId: agent.id,
        agentCategory: "goal"
      });
    }
    this.syncWorkflowState(project);
    if (options?.persistOnCreate === false) {
      this.emitState();
    } else {
      await this.persistProjectUpdate(project);
    }

    if (!launchThread) {
      return agent;
    }

    await this.startAgentThread(project, agent, {
      sandbox: options?.sandbox ?? (writeEnabled ? "workspace-write" : "read-only"),
      prompt: options?.turnPrompt ?? prompt,
      outputSchema: options?.outputSchema,
      effort: options?.effort
    });
    return agent;
  }

  private async startAgentThread(
    project: LoadedProject,
    agent: AgentState,
    options?: {
      sandbox?: "workspace-write" | "read-only";
      prompt?: string;
      outputSchema?: JsonValue;
      effort?: InterfaceReasoningEffort;
    }
  ): Promise<void> {
    if (!this.transport) {
      throw new Error("Codex transport is not initialized.");
    }

    const turnPrompt = options?.prompt ?? agent.taskPrompt;
    const roleInstructions = agentRoles[agent.category].instructions;
    const baseInstructions = options?.outputSchema
      ? `${roleInstructions}\nWhen an output schema is supplied, return only valid JSON matching that schema exactly. Keep string fields concise. Do not add greetings, commentary, markdown fences, or filler.`
      : roleInstructions;
    const cwd = agent.worktree?.worktreePath ?? project.record.projectRoot;
    await assertExecutionPathWithinProjectRoot(
      project.record.projectRoot,
      cwd,
      project.record.hostPath,
      this.getRuntimeSettings(project.record.distroName),
      project.record.distroName,
      "Agent execution"
    );
    if (options?.effort) {
      agent.reasoningEffort = this.resolveAgentReasoningEffortForTask(
        agent.category,
        agent.model,
        `${agent.name}\n\n${turnPrompt}`,
        "manual",
        options.effort
      ).effort;
      agent.reasoningEffortSource = "manual";
    } else if (!agent.reasoningEffort) {
      const reasoningConfig = this.resolveAgentReasoningEffortForTask(agent.category, agent.model, `${agent.name}\n\n${turnPrompt}`);
      agent.reasoningEffort = reasoningConfig.effort;
      agent.reasoningEffortSource = reasoningConfig.source;
    }
    const sandbox = options?.sandbox ?? "read-only";
    const sandboxPolicy = this.buildRestrictedSandboxPolicy(project, sandbox);
    const threadStartedAt = performance.now();
    const threadResponse = await this.transport.startThread({
      cwd,
      model: agent.model,
      approvalPolicy: "on-request",
      sandbox,
      baseInstructions,
      developerInstructions: this.buildProjectBoundaryDeveloperInstructions(project, cwd, sandbox),
      personality: "pragmatic",
      experimentalRawEvents: false
    });
    this.logWorkflowPerf(`app-server thread started for ${agent.name}: ${Math.round(performance.now() - threadStartedAt)}ms`);
    agent.threadId = threadResponse.thread.id;
    agent.startedAt ??= nowIso();
    this.threadToAgent.set(agent.threadId, { projectId: project.record.id, agentId: agent.id });
    const turnStartedAt = performance.now();
    await this.transport.startTurn({
      threadId: threadResponse.thread.id,
      input: [
        {
          type: "text",
          text: turnPrompt,
          text_elements: []
        }
      ],
      cwd,
      sandboxPolicy,
      model: agent.model,
      effort: agent.reasoningEffort ?? null,
      outputSchema: options?.outputSchema ?? null
    });
    this.logWorkflowPerf(`app-server turn started for ${agent.name}: ${Math.round(performance.now() - turnStartedAt)}ms`);
    await this.saveProject(project);
    this.emitState();
  }

  async approve(agentProjectId: string, agentId: string, approvalId: string, decision: ApprovalDecision): Promise<void> {
    const project = this.findProject(agentProjectId);
    const agent = project.record.agents.find((entry) => entry.id === agentId);
    if (!agent) {
      throw new Error(`Unknown agent: ${agentId}`);
    }

    const approval = agent.approvals.find((entry) => entry.id === approvalId);
    if (!approval) {
      throw new Error(`Unknown approval: ${approvalId}`);
    }

    approval.status = decision === "decline" || decision === "cancel" ? "rejected" : "approved";

    if (this.transport && approval.serverRequestId !== undefined) {
      let result: unknown = { decision };
      if (approval.kind === "permissions") {
        result = {
          permissions: {},
          scope: decision === "acceptForSession" ? "session" : "turn"
        };
      }
      await this.transport.respond(approval.serverRequestId, result);
    }

    reduceAgentRuntimeEvent(agent, { kind: "approval-resolved", approvalId, decision });
    this.mirrorLatestAgentEventToWorkflow(this.ensureWorkflowState(project.record), agent);
    await this.persistProjectUpdate(project, true);
  }

  private buildWorkflowCodingPrompt(project: LoadedProject, repair = false): string {
    const workflow = this.ensureWorkflowState(project.record);
    const repairStrategy = repair ? buildRepairStrategyContext(workflow, project.record.agents) : undefined;
    const repairDiagnosticPrompt = repair
      ? this.buildWorkflowRepairAgentPrompt(
        project,
        "You are the tracked Agentic Workbench repair coding agent for this workflow cycle."
      )
      : "";
    const previewRequest = getWorkflowPreviewRequest(workflow);
    const previewMode = previewRequest.status === "active" && isPreviewRecommendation(workflow.approvedRecommendation);
    const outcomeStrategyBrief = buildOutcomeStrategyBrief(this.buildWorkflowRecommendationContext(project), {
      maxOpenChecks: 4,
      maxFocusPaths: 4
    });
    const activeGoalChecks = buildGoalChecklistForAssessment({
      workflow,
      agents: project.record.agents
    })
      .filter((check) => check.required && check.status !== "met")
      .slice(0, 8)
      .map((check) => `- [${check.status}] ${check.title}${check.evidence ? ` -- ${check.evidence}` : ""}`);
    const repairContext = repair
      ? [
          "This is a repair pass. Address only the most recent validation failure before adding anything new.",
          "Do not broaden the task or start a follow-up workflow during this pass.",
          workflow.repair.latestFailureReason ? `Latest failure reason: ${workflow.repair.latestFailureReason}` : "",
          ...(repairStrategy?.retryableRisks ?? []).map((risk) => `Repair target: ${risk}`),
          repairStrategy?.recentAttemptSummaries.length
            ? `Repair history:\n- ${repairStrategy.recentAttemptSummaries.join("\n- ")}`
            : "",
          repairStrategy?.focusHints.length
            ? `Repair strategy for this attempt:\n- ${repairStrategy.focusHints.join("\n- ")}`
            : "",
          repairStrategy && repairStrategy.recurringFailureCount >= 2
            ? "Form a new root-cause hypothesis before editing. Do not just retry the same patch shape."
            : "",
          repairDiagnosticPrompt
            ? `Current Workbench repair diagnostics:\n${repairDiagnosticPrompt}`
            : ""
        ]
      : [];
    const relevantPriorContext = this.selectAndRememberRelevantContext(
      project,
      "coding",
      [
        workflow.scopedGoal?.summary ?? "",
        workflow.scopedGoal?.executionBrief ?? "",
        workflow.approvedRecommendation?.title ?? "",
        workflow.ultimateGoal.summary,
        activeGoalChecks.join("\n"),
        repairContext.join("\n")
      ].join("\n"),
      workflow.approvedRecommendation?.relatedPaths ?? []
    );

    return [
      `Scoped goal from the goal agent: ${workflow.scopedGoal?.summary ?? "No scoped plan available."}`,
      workflow.scopedGoal?.executionBrief ?? "",
      workflow.scopedGoal?.acceptanceCriteria.length
        ? `Acceptance criteria:\n- ${workflow.scopedGoal.acceptanceCriteria.join("\n- ")}`
        : "",
      workflow.scopedGoal?.testStrategy.length
        ? `Integrity will verify with:\n- ${workflow.scopedGoal.testStrategy.join("\n- ")}`
        : "",
      workflow.ultimateGoal.summary ? `Ultimate Goal: ${workflow.ultimateGoal.summary}` : "",
      previewMode
        ? "Generate Preview is active. Make the current product structure visible or runnable for inspection, preserve honest incomplete states, and stop at a preview checkpoint. Do not claim final completion just because the preview exists."
        : "",
      previewMode
        ? "Preview-specific requirements: label demo/mock data clearly, keep offline/demo behavior available, expose missing credentials as explicit UI/state, avoid paid-service requirements, do not embed secrets, and run the repo-supported build/render validation path."
        : "",
      "If this implementation needs live external data, build a provider layer instead of hardcoding local-only mock data. Include demo/mock mode for offline development, a live adapter mode that activates only when local credentials are configured, and explicit missing-credential/error/loading states.",
      "For trading-style work, keep provider choice generic unless the user selected a provider. Free/no-card APIs are allowed. Use credential requests and explicit user-visible approval/input flow for API keys or secrets; do not embed or infer secrets.",
      "If a free/no-card API credential is required to validate live behavior, request it through the project credential flow rather than downgrading to mock-only behavior, embedding a secret, or inventing one.",
      outcomeStrategyBrief,
      "Use the relevant prior context below only when it helps this scoped implementation. Do not include secrets or ask for credentials unless the task genuinely needs them.",
      relevantPriorContext,
      activeGoalChecks.length ? `Relevant unmet Goal checks:\n${activeGoalChecks.join("\n")}` : "",
      repairContext.join("\n"),
      "Stay inside the active project folder, run the most relevant checks for this coherent batch, and summarize what changed. If the work proves adjacent open checks are satisfied by the same files and validation, document that evidence instead of deferring an evidence-only follow-up cycle."
    ]
      .filter((entry) => entry.trim().length > 0)
      .join("\n\n");
  }

  private normalizeChangedFilePath(project: LoadedProject, agent: AgentState, candidate: string): string {
    const pathApi = project.record.projectRoot.includes("\\") ? path.win32 : path.posix;
    const trimmed = candidate.trim();
    if (!trimmed) {
      return trimmed;
    }

    let normalized = trimmed.replace(/^[.][/\\]+/, "");
    if (pathApi.isAbsolute(trimmed)) {
      const baseRoot = agent.worktree?.worktreePath && trimmed.startsWith(agent.worktree.worktreePath)
        ? agent.worktree.worktreePath
        : project.record.projectRoot;
      normalized = pathApi.relative(baseRoot, trimmed);
    }

    return pathApi.normalize(normalized).replace(/\\/g, "/").replace(/^\.\/+/, "");
  }

  private updateAgentChangedFiles(project: LoadedProject, agent: AgentState, paths: string[]): void {
    const next = [...new Set(
      paths
        .map((entry) => this.normalizeChangedFilePath(project, agent, entry))
        .filter((entry) => entry.length > 0 && !entry.startsWith(".."))
    )];
    agent.changedFiles = next;
  }

  private mergeAgentChangedFiles(project: LoadedProject, agent: AgentState, paths: string[]): void {
    this.updateAgentChangedFiles(project, agent, [...agent.changedFiles, ...paths]);
  }

  private async finalizeGitWriteAgent(project: LoadedProject, agent: AgentState): Promise<void> {
    if (!agent.worktree?.worktreePath || !agent.worktree.branch) {
      agent.status = "completed";
      agent.completedAt ??= nowIso();
      this.syncWorkflowStepProgressFromAgent(project, agent);
      this.mirrorLatestAgentEventToWorkflow(this.ensureWorkflowState(project.record), agent);
      await this.persistProjectUpdate(project, agent.category === "coding");
      return;
    }

    const runtimeSettings = this.getRuntimeSettings(project.record.distroName);
    const targetBranch = agent.worktree.targetBranch ?? (await determineDefaultBranch(project.record.projectRoot, runtimeSettings));
    const finalizedWorktreePath = agent.worktree.worktreePath;

    try {
      const hygieneReport = await this.scanWorkflowRepoHygiene(
        project,
        `checkpoint:${agent.id}`,
        true,
        finalizedWorktreePath,
        targetBranch
      );
      agent.repoHygieneReport = hygieneReport;
      if (hygieneReport.status !== "passed") {
        const detail = hygieneReport.summaryForHumans;
        agent.status = "failed";
        agent.completedAt = nowIso();
        agent.currentPhase = "Repository hygiene blocked worktree checkpoint";
        agent.lastMessageSnippet = detail.slice(0, 240);
        this.recordWorkflowOpenIssue(
          this.ensureWorkflowState(project.record),
          "Repository hygiene blocked checkpoint",
          detail,
          agent.category === "coding" ? "coding" : "system"
        );
        reduceAgentRuntimeEvent(agent, {
          kind: "raw",
          title: "Repository hygiene blocked checkpoint",
          detail
        });
        this.syncWorkflowStepProgressFromAgent(project, agent);
        this.mirrorLatestAgentEventToWorkflow(this.ensureWorkflowState(project.record), agent);
        const queuedAutomaticRepair = agent.category === "coding" && this.queueAutomaticWorkflowRepair(project, {
          sourceStep: "coding",
          issueSummary: "Repository hygiene blocked the coding worktree checkpoint.",
          latestFailureReason: detail,
          involvedPaths: [
            ...hygieneReport.forbiddenFiles,
            ...hygieneReport.cleanedFiles
          ],
          automate: true
        });
        await this.persistProjectUpdate(project, queuedAutomaticRepair
          ? {
            save: "immediate",
            emit: "coalesced",
            automate: true,
            reason: "checkpoint hygiene blocked; automatic repair queued"
          }
          : undefined);
        return;
      }
      const checkpoint = await checkpointWorktreeChanges(
        finalizedWorktreePath,
        targetBranch,
        agent.worktree.branch,
        `AWB checkpoint: ${agent.name}`,
        runtimeSettings
      );

      this.updateAgentChangedFiles(project, agent, checkpoint.changedFiles);
      if (checkpoint.createdCommit) {
        reduceAgentRuntimeEvent(agent, {
          kind: "raw",
          title: "Worktree checkpoint created",
          detail: checkpoint.commitSha
            ? `Committed ${agent.changedFiles.length} changed file(s) on ${agent.worktree.branch} at ${checkpoint.commitSha.slice(0, 12)}.`
            : `Committed ${agent.changedFiles.length} changed file(s) on ${agent.worktree.branch}.`
        });
      }

      if (agent.changedFiles.length === 0) {
        agent.currentPhase = agent.category === "manual" ? "No manual changes detected" : "No project changes detected";
        await this.cleanupCompletedManagedWorktrees(project, [finalizedWorktreePath]);
        agent.status = "completed";
        agent.completedAt = nowIso();
        this.syncWorkflowStepProgressFromAgent(project, agent);
        this.mirrorLatestAgentEventToWorkflow(this.ensureWorkflowState(project.record), agent);
        await this.persistProjectUpdate(project, agent.category === "coding");
        return;
      }

      if (agent.category === "manual") {
        const appliedBranch = await this.applyGitBranchToProjectCheckout(project, agent.worktree.branch, "Manual agent finalization");
        agent.currentPhase = "Manual changes applied to the opened checkout";
        agent.lastMessageSnippet = `Applied ${agent.worktree.branch} to ${appliedBranch}.`.slice(0, 240);
        reduceAgentRuntimeEvent(agent, {
          kind: "raw",
          title: "Manual changes applied",
          detail: `Applied ${agent.worktree.branch} to the opened checkout on ${appliedBranch}.`
        });
        await this.cleanupCompletedManagedWorktrees(project, [finalizedWorktreePath]);
        agent.status = "completed";
        agent.completedAt = nowIso();
        this.syncWorkflowStepProgressFromAgent(project, agent);
        this.mirrorLatestAgentEventToWorkflow(this.ensureWorkflowState(project.record), agent);
        await this.persistProjectUpdate(project);
        return;
      }

      agent.currentPhase = checkpoint.createdCommit
        ? "Checkpointed worktree changes for merge"
        : "Committed changes ready for merge";
      await this.cleanupCompletedManagedWorktrees(project, [finalizedWorktreePath]);
      agent.status = "completed";
      agent.completedAt = nowIso();
      this.syncWorkflowStepProgressFromAgent(project, agent);
      this.mirrorLatestAgentEventToWorkflow(this.ensureWorkflowState(project.record), agent);
      await this.persistProjectUpdate(project, true);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      agent.status = "failed";
      agent.completedAt = nowIso();
      agent.currentPhase = agent.category === "manual" ? "Manual worktree finalization failed" : "Coding worktree finalization failed";
      agent.lastMessageSnippet = detail.slice(0, 240);
      reduceAgentRuntimeEvent(agent, {
        kind: "raw",
        title: "Worktree finalization failed",
        detail
      });
      this.syncWorkflowStepProgressFromAgent(project, agent);
      this.mirrorLatestAgentEventToWorkflow(this.ensureWorkflowState(project.record), agent);
      await this.persistProjectUpdate(project);
    }
  }

  private async startWorkflowCodingPass(projectId: string, repair = false): Promise<void> {
    const project = this.findProject(projectId);
    const workflow = this.ensureWorkflowState(project.record);
    if (!workflow.scopedGoal) {
      throw new Error("A scoped execution plan is required before coding can begin.");
    }
    if (repair && (workflow.repair.status === "retrying_validation" || workflow.repair.status === "fixed")) {
      return;
    }
    if (!repair && workflow.repair.status === "retrying_validation") {
      return;
    }

    this.markWorkflowStartupProgress(
      project,
      "starting",
      repair ? "Starting the repair coding agent and preparing its worktree." : "Starting the coding agent and preparing its worktree."
    );
    await this.ensureWorkflowCycleStartGitRef(project, workflow);
    this.scheduleProjectSave(project);
    this.emitState();

    const passNumber = workflow.stepProgress.coding.runCount + 1;
    const agentName = repair ? `Repair Coding Pass ${passNumber}` : `Coding Pass ${passNumber}`;
    await this.createAgent(projectId, "coding", agentName, this.buildWorkflowCodingPrompt(project, repair), this.getDefaultAgentModel(), {
      targetBranch: this.getLatestCompletedWorkflowCodingBranch(project)
    });
  }

  private async prepareIntegrityReviewWorkspace(project: LoadedProject, agent: AgentState): Promise<string> {
    if (project.scan.kind !== "git") {
      return project.record.projectRoot;
    }

    const reviewBaseBranch = this.getLatestCompletedWorkflowCodingBranch(project);
    if (!reviewBaseBranch) {
      return project.record.projectRoot;
    }

    if (await this.shouldValidateOpenedCheckoutForExternalRepair(project, reviewBaseBranch)) {
      return project.record.projectRoot;
    }

    const runtimeSettings = this.getRuntimeSettings(project.record.distroName);
    agent.worktree = await createWorktreeAssignment(
      project.record.projectRoot,
      this.settings.worktreeBaseDir,
      project.record.identity.projectName,
      `${agent.name} Review`,
      reviewBaseBranch,
      runtimeSettings
    );
    await assertExecutionPathWithinProjectRoot(
      project.record.projectRoot,
      agent.worktree.worktreePath,
      project.record.hostPath,
      runtimeSettings,
      project.record.distroName,
      "Integrity review worktree"
    );
    return agent.worktree.worktreePath;
  }

  private async shouldValidateOpenedCheckoutForExternalRepair(
    project: LoadedProject,
    reviewBaseBranch: string
  ): Promise<boolean> {
    const workflow = this.ensureWorkflowState(project.record);
    if (
      workflow.repair.status !== "retrying_validation" ||
      (
        !this.isEnvironmentRepairFailureReason(workflow.repair.latestFailureReason) &&
        !this.isExternalRepairRevalidationReason(workflow.repair.latestFailureReason)
      )
    ) {
      return false;
    }

    if (this.isExternalRepairRevalidationReason(workflow.repair.latestFailureReason)) {
      return true;
    }

    const executor = new RuntimeCommandExecutor(this.getRuntimeSettings(project.record.distroName));
    try {
      const status = await executor.execStructuredCommand({
        command: "git",
        args: ["status", "--porcelain=1", "--untracked-files=all"],
        cwd: project.record.projectRoot
      });
      if (this.getMeaningfulCheckoutStatusPaths(status.stdout).length > 0) {
        return true;
      }
    } catch {
      return false;
    }

    try {
      await executor.execStructuredCommand({
        command: "git",
        args: ["merge-base", "--is-ancestor", reviewBaseBranch, "HEAD"],
        cwd: project.record.projectRoot
      });
      return true;
    } catch {
      // Fall through and compare the checked-out branch against the review branch.
    }

    try {
      await executor.execStructuredCommand({
        command: "git",
        args: ["diff", "--quiet", `${reviewBaseBranch}...HEAD`],
        cwd: project.record.projectRoot
      });
      return false;
    } catch {
      return true;
    }
  }

  private async resolveValidationRuntimePathDirs(project: LoadedProject): Promise<string[]> {
    const runtimeSettings = this.getRuntimeSettings(project.record.distroName);
    if (resolveExecutionMode(runtimeSettings, process.platform) !== "wsl") {
      return [];
    }

    try {
      const runtime = await new RuntimeCommandExecutor(runtimeSettings).resolveWslCodexRuntime({
        command: this.settings.codexBinaryPath,
        cwd: project.record.projectRoot
      });
      return runtime.runtimePathDirs;
    } catch (error) {
      const workflow = this.ensureWorkflowState(project.record);
      this.recordWorkflowActivity(workflow, {
        source: "validation",
        status: "failed",
        title: "Validation runtime path resolution failed",
        detail: error instanceof Error ? error.message : String(error),
        stepId: "integrity"
      });
      return [];
    }
  }

  async runIntegrity(
    projectId: string,
    automate = false,
    options: { continueAfterPass?: boolean } = {}
  ): Promise<void> {
    const project = this.findProject(projectId);
    await this.ensureAgentBackedRuntimeReady(project, "integrity runtime check");
    this.assertResolvedPathCompatible(project.record.distroName);
    const runner = new RuntimeCommandExecutor(this.getRuntimeSettings(project.record.distroName));
    const integrityModel = this.getDefaultAgentModel();
    const workflow = this.ensureWorkflowState(project.record);
    const retryingAfterRepair = workflow.repair.status === "repairing" || workflow.repair.status === "retrying_validation";
    const retryingExternalEnvironmentValidation =
      workflow.repair.status === "retrying_validation" &&
      this.isEnvironmentRepairFailureReason(workflow.repair.latestFailureReason);
    if (retryingAfterRepair) {
      this.updateWorkflowRepairState(workflow, {
        status: "retrying_validation"
      });
      this.recordWorkflowActivity(workflow, {
        source: "workflow",
        status: "running",
        title: `Validation retry ${workflow.repair.attemptCount} of ${workflow.repair.maxAttempts} started`,
        detail: workflow.repair.latestFailureReason,
        stepId: "integrity"
      });
    } else {
      this.recordWorkflowActivity(workflow, {
        source: "workflow",
        status: "running",
        title: "Integrity validation started",
        detail: "Preparing deterministic validation for the current execution plan.",
        stepId: "integrity"
      });
    }
    this.updateWorkflowStepProgress(workflow, "integrity", {
      requiresUserInput: false,
      currentActivity: retryingAfterRepair ? "Retrying validation after a repair pass" : "Preparing deterministic validation",
      currentSubstep: retryingAfterRepair ? `Validation retry ${workflow.repair.attemptCount} of ${workflow.repair.maxAttempts}` : undefined,
      message: retryingAfterRepair ? "Re-running deterministic checks after the latest repair pass." : "Selecting the commands to run next.",
      agentCategory: "integrity"
    }, { status: "running", incrementRunCount: true, incrementAttemptCount: true });
    this.syncWorkflowState(project);
    await this.persistProjectUpdate(project);
    const agent = await this.createAgent(
      projectId,
      "integrity",
      "Integrity Agent",
      "Run deterministic validation and summarize risks.",
      integrityModel,
      { launchThread: false }
    );
    const cwd = await this.prepareIntegrityReviewWorkspace(project, agent);
    await this.persistProjectUpdate(project);
    await assertExecutionPathWithinProjectRoot(
      project.record.projectRoot,
      cwd,
      project.record.hostPath,
      this.getRuntimeSettings(project.record.distroName),
      project.record.distroName,
      "Integrity validation"
    );

    this.refreshEvidenceCommands(project);
    const previousCommandResults = workflow.validationLedgers.flatMap((ledger) => ledger.commandResults);
    const commandResolution = await resolveTargetProjectCommands({
      projectRoot: project.record.hostPath ?? project.record.projectRoot,
      projectKind: project.scan.kind,
      evidenceCommands: workflow.evidenceCommands,
      previousCommandResults
    });
    const validationRuntimePathDirs = await this.resolveValidationRuntimePathDirs(project);
    let ledger = createValidationLedger({
      cycleNumber: workflow.workflowCycle.cycleNumber,
      testCommands: commandResolution.testCommands.map((command) => command.command),
      evidenceCommands: [
        ...commandResolution.evidenceCommands.map((command) => command.command),
        ...commandResolution.skippedEvidenceCommands.map((command) => command.command)
      ]
    });
    ledger.warnings = [...ledger.warnings, ...commandResolution.warnings];
    for (const command of commandResolution.skippedEvidenceCommands) {
      const timestamp = nowIso();
      ledger.commandResults.push(buildValidationCommandResult({
        commandId: `${agent.id}:evidence:${ledger.commandResults.length + 1}`,
        command: command.command,
        phase: "evidence",
        startedAt: timestamp,
        endedAt: timestamp,
        status: "skipped",
        stdout: "",
        stderr: command.skipReason ?? "Evidence command skipped.",
        cwdKind: agent.worktree?.worktreePath === cwd ? "integration_worktree" : "project_root",
        relatedCheckIds: command.mapsToCheckIds,
        relatedFiles: command.relatedFiles
      }));
    }
    const checks: Array<{
      name: string;
      command: string;
      status: "passed" | "failed" | "skipped";
      outputSnippet: string;
    }> = [];
    const commands: TargetProjectResolvedCommand[] = [...commandResolution.evidenceCommands, ...commandResolution.testCommands];
    for (const command of commands) {
      this.recordWorkflowActivity(workflow, {
        source: "validation",
        status: "running",
        title: `Running ${command.name}`,
        detail: command.command,
        stepId: "integrity",
        agentId: agent.id,
        agentCategory: "integrity"
      });
      this.updateWorkflowStepProgress(workflow, "integrity", {
        currentActivity: command.kind === "evidence" ? "Running evidence command" : "Running deterministic validation",
        currentSubstep: command.name,
        latestProgressNote: command.command,
        message: `Running ${command.command}`
      }, { status: "running" });
      await this.persistProjectUpdate(project);
      const startedAt = nowIso();
      const result = await runner.runShellCommand({
        command: command.command,
        cwd,
        runtimePathDirs: validationRuntimePathDirs
      });
      const endedAt = nowIso();
      let status: "passed" | "failed" = result.exitCode === 0 ? "passed" : "failed";
      let stderr = result.stderr;
      let parsedJsonRef: string | undefined;
      if (command.kind === "evidence" && command.expectedOutput === "json" && result.exitCode === 0) {
        const output = `${result.stdout}\n${result.stderr}`.trim();
        const parsedObjects = this.extractJsonObjects(output);
        let parsedEvidence: unknown;
        try {
          parsedEvidence = JSON.parse(output);
        } catch {
          parsedEvidence = parsedObjects[0];
        }
        if (parsedEvidence === undefined) {
          status = "failed";
          stderr = `${stderr}\nJSON parse failure: evidence command did not emit a parseable JSON object.`.trim();
        } else {
          parsedJsonRef = `validation-ledger:${workflow.workflowCycle.cycleNumber}:${agent.id}:${ledger.commandResults.length + 1}:json`;
          const targetedCheckIds = this.currentCycleTargetedCheckIds(workflow);
          const knownCheckIds = workflow.goalChecklist.map((check) => check.id);
          const observations = extractChecklistEvidenceObservations(JSON.stringify(parsedEvidence), {
            cycleNumber: workflow.workflowCycle.cycleNumber,
            targetedCheckIds,
            knownCheckIds,
            evidenceSourceType: "command_output",
            sourceRef: {
              commandId: `${agent.id}:evidence:${ledger.commandResults.length + 1}`,
              agentRunId: agent.id,
              sourceKey: command.name
            },
            observedAt: endedAt
          });
          if (observations.length > 0) {
            const byObservationId = new Map([
              ...observations,
              ...workflow.evidenceObservations
            ].map((observation) => [observation.observationId, observation]));
            workflow.evidenceObservations = [...byObservationId.values()].slice(0, 500);
          }
        }
      }
      const commandResult = buildValidationCommandResult({
        commandId: `${agent.id}:${command.kind}:${ledger.commandResults.length + 1}`,
        command: command.command,
        phase: command.phase,
        startedAt,
        endedAt,
        exitCode: result.exitCode,
        status,
        stdout: result.stdout,
        stderr,
        cwdKind: agent.worktree?.worktreePath === cwd ? "integration_worktree" : "project_root",
        parsedJsonRef,
        fullOutputRef: `agent:${agent.id}:command:${ledger.commandResults.length + 1}`,
        relatedCheckIds: command.mapsToCheckIds,
        relatedFiles: command.relatedFiles
      });
      ledger.commandResults.push(commandResult);
      this.recordWorkflowActivity(workflow, {
        source: "validation",
        status: commandResult.status === "passed" ? "completed" : "failed",
        title: `${command.name} ${commandResult.status === "passed" ? "passed" : "failed"}`,
        detail: command.command,
        stepId: "integrity",
        agentId: agent.id,
        agentCategory: "integrity"
      });
      if (command.kind === "test") {
        checks.push({
          name: command.name,
          command: command.command,
          status: commandResult.status === "passed" ? "passed" : "failed",
          outputSnippet: `${commandResult.stdoutSummary}\n${commandResult.stderrSummary}`.trim().slice(0, 500)
        });
      }
    }
    const hygieneReport = await this.scanWorkflowRepoHygiene(project, `integrity:${workflow.workflowCycle.cycleNumber}`, true, cwd);
    ledger = finalizeValidationLedger(ledger, { repoHygieneReport: hygieneReport });
    this.upsertValidationLedger(workflow, ledger);
    agent.validationLedger = ledger;
    agent.repoHygieneReport = hygieneReport;

    const contextualRisks = [
      !workflow.scopedGoal?.summary.trim() ? "No scoped goal was defined before integrity validation." : undefined,
      !workflow.ultimateGoal.confirmedAt ? "The ultimate goal is not confirmed, so integrity cannot validate final alignment confidently." : undefined
    ].filter((entry): entry is string => Boolean(entry));
    const commandRisks = ledger.unresolvedValidationFailures;
    const risks = [...contextualRisks, ...commandRisks];
    const passed = ledger.finalValidationStatus === "passed" && risks.length === 0;

    agent.integrityReport = {
      summary: passed
        ? ledger.summaryForHumans
        : ledger.summaryForHumans,
      checks,
      risks,
      generatedAt: nowIso()
    };
    agent.status = passed ? "completed" : "failed";
    agent.completedAt = nowIso();
    if (passed) {
      this.resolveWorkflowOpenIssues(workflow, (issue) => issue.source === "integrity");
      if (workflow.repair.attemptCount > 0) {
        this.updateWorkflowRepairState(workflow, {
          status: "fixed",
          latestIssueSummary: agent.integrityReport.summary,
          latestFailureReason: undefined
        });
        this.recordWorkflowActivity(workflow, {
          source: "workflow",
          status: "completed",
          title: "Repair validated successfully",
          detail: `Repair attempt ${workflow.repair.attemptCount} of ${workflow.repair.maxAttempts} fixed the latest validation issue.`,
          stepId: "integrity"
        });
      } else {
        this.resetWorkflowRepairState(workflow);
      }
      this.updateWorkflowStepProgress(workflow, "integrity", {
        currentActivity: "Validation complete",
        currentSubstep: undefined,
        latestProgressNote: workflow.repair.status === "fixed" ? "Validation passed after repair." : "All deterministic checks passed.",
        message: agent.integrityReport.summary,
        warning: undefined
      }, { status: "completed" });
      this.resetWorkflowStepProgress(workflow, "merge", {
        status: "waiting",
        requiresUserInput: false,
        currentActivity: "Queued for integration",
        message: "Validation passed. Preparing merge."
      });
    } else {
      const previousFailedIntegrityReports = project.record.agents
        .filter((entry) =>
          entry.id !== agent.id &&
          entry.category === "integrity" &&
          entry.workflowCycleNumber === workflow.workflowCycle.cycleNumber &&
          entry.status === "failed" &&
          entry.integrityReport
        )
        .map((entry) => entry.integrityReport!)
        .filter((entry) => entry.generatedAt < (agent.integrityReport?.generatedAt ?? nowIso()));
      const failureAssessment = assessIntegrityFailure(agent.integrityReport, previousFailedIntegrityReports);
      const completedRepairAttempts = retryingAfterRepair ? workflow.repair.attemptCount : 0;
      const nextRepairAttemptNumber = completedRepairAttempts + 1;
      const reachedConfiguredLimit = nextRepairAttemptNumber > workflow.repair.maxAttempts;
      const canQueueAnotherRepair = failureAssessment.shouldRetry && !reachedConfiguredLimit;
      const nextAttemptCount = canQueueAnotherRepair
        ? nextRepairAttemptNumber
        : completedRepairAttempts;
      const exhausted = !canQueueAnotherRepair;
      const stoppedEarly = exhausted && !reachedConfiguredLimit;
      this.updateWorkflowRepairState(workflow, {
        attemptCount: nextAttemptCount,
        status: exhausted ? "exhausted" : "repairing",
        latestIssueSummary: agent.integrityReport.summary,
        latestFailureReason: failureAssessment.latestFailureReason
      });
      for (const risk of risks) {
        this.recordWorkflowOpenIssue(workflow, "Integrity follow-up required", risk, "integrity");
      }
      if (exhausted) {
        workflow.manualHandoff = this.buildRepairManualHandoff(
          project,
          agent.integrityReport.summary,
          failureAssessment.latestFailureReason,
          stoppedEarly ? "repair_stopped_early" : "repair_exhausted"
        );
        if (stoppedEarly) {
          this.disableAutopilotForUnrepairableIssue(
            project,
            failureAssessment.latestFailureReason,
            "integrity"
          );
        }
        this.recordWorkflowActivity(workflow, {
          source: "workflow",
          status: "failed",
          title: stoppedEarly ? "Automatic repair stopped early" : "Automatic repair exhausted",
          detail: workflow.manualHandoff.latestFailureReason,
          stepId: "integrity"
        });
      } else {
        this.recordWorkflowActivity(workflow, {
          source: "workflow",
          status: "waiting",
          title: `Repair attempt ${workflow.repair.attemptCount} of ${workflow.repair.maxAttempts} queued`,
          detail: failureAssessment.latestFailureReason,
          stepId: "coding"
        });
      }
      this.updateWorkflowStepProgress(workflow, "integrity", {
        currentActivity: "Validation found issues",
        currentSubstep: undefined,
        latestProgressNote: failureAssessment.latestFailureReason,
        message: agent.integrityReport.summary,
        warning: exhausted
          ? failureAssessment.shouldRetry
            ? "Automatic repair reached the configured limit."
            : "Automatic repair stopped early before the configured limit because the failure is not worth retrying from another coding pass."
          : `The workflow will start repair attempt ${workflow.repair.attemptCount} of ${workflow.repair.maxAttempts} automatically.`
      }, { status: "failed" });
      if (!exhausted) {
        this.resetWorkflowStepProgress(workflow, "coding", {
          status: "waiting",
          requiresUserInput: false,
          currentActivity: "Queued for repair",
          currentSubstep: `Repair attempt ${workflow.repair.attemptCount} of ${workflow.repair.maxAttempts}`,
          message: "Preparing another coding pass to address integrity findings.",
          warning: undefined
        });
      }
    }
    this.syncWorkflowState(project);
    const shouldContinueAutomation =
      workflow.repair.status === "repairing" ||
      (
        options.continueAfterPass !== false &&
        (automate || (passed && !retryingExternalEnvironmentValidation))
      );
    await this.persistProjectUpdate(project, {
      save: "immediate",
      emit: "coalesced",
      automate: shouldContinueAutomation,
      reason: "integrity completed"
    });
  }

  private async detectVerificationCommands(
    projectRoot: string,
    projectKind: LoadedProject["scan"]["kind"]
  ): Promise<Array<{ name: string; command: string }>> {
    const packageJsonPath = await assertHostPathWithinProjectRoot(projectRoot, path.join(projectRoot, "package.json"), "Verification command discovery");
    try {
      const packageJson = JSON.parse(await (await import("node:fs/promises")).readFile(packageJsonPath, "utf8")) as {
        scripts?: Record<string, string>;
      };
      const commands = [];
      if (packageJson.scripts?.lint) {
        commands.push({ name: "lint", command: "npm run lint" });
      }
      if (packageJson.scripts?.typecheck) {
        commands.push({ name: "typecheck", command: "npm run typecheck" });
      }
      if (packageJson.scripts?.test) {
        commands.push({ name: "test", command: "npm run test" });
      }
      if (packageJson.scripts?.build) {
        commands.push({ name: "build", command: "npm run build" });
      }
      if (commands.length > 0) {
        return commands;
      }
      return projectKind === "git" ? [{ name: "git status", command: "git status --short" }] : [];
    } catch {
      return projectKind === "git" ? [{ name: "git status", command: "git status --short" }] : [];
    }
  }

  private async applyGitBranchToProjectCheckout(
    project: LoadedProject,
    sourceBranch: string,
    operation: string
  ): Promise<string> {
    this.assertResolvedPathCompatible(project.record.distroName);
    const runtimeSettings = this.getRuntimeSettings(project.record.distroName);
    let appliedBranch: string;
    try {
      appliedBranch = await applyBranchToProjectCheckout(project.record.projectRoot, sourceBranch, runtimeSettings);
    } catch (error) {
      throw new Error(
        `${operation} could not update the opened project checkout. ${error instanceof Error ? error.message : String(error)}`
      );
    }

    try {
      const refreshedProject = await this.scanCurrentProject(project);
      this.applyScannedProjectState(project, refreshedProject);
      await this.saveRepositoryIndex(project);
    } catch (error) {
      this.diagnostics.unshift(
        `${operation} updated the opened checkout on ${appliedBranch}, but the project overview refresh failed. ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return appliedBranch;
  }

  private async publishMergedCheckoutToOrigin(
    project: LoadedProject,
    mergeAgent: AgentState,
    workflow: ProjectWorkflowState,
    branch: string,
    operation: string,
    manualValidationOverride = false
  ): Promise<boolean> {
    if (this.settings.mockMode) {
      return true;
    }
    const baseReport = mergeAgent.mergeReport ?? {
      summary: operation,
      mergedBranches: [],
      conflicts: [],
      conflictCycleCount: 0,
      generatedAt: nowIso()
    };
    const pushBlockedReasons = this.mergeGateBlockedReasons(workflow, mergeAgent.repoHygieneReport);
    const onlyMissingLedger = this.validationLedgerIsMissingEquivalent(this.latestCycleValidationLedger(workflow)) &&
      pushBlockedReasons.length === 1 &&
      this.mergeGateReasonIsOnlyMissingValidationLedger(pushBlockedReasons[0]);
    if (pushBlockedReasons.length > 0 && !(manualValidationOverride && onlyMissingLedger)) {
      const detail = pushBlockedReasons.join(" ");
      mergeAgent.mergeReport = {
        ...baseReport,
        summary: `${baseReport.summary} Push blocked by validation or repository hygiene gates. ${detail}`,
        targetBranch: branch
      };
      mergeAgent.status = "failed";
      mergeAgent.completedAt = nowIso();
      mergeAgent.currentPhase = "GitHub push blocked";
      mergeAgent.lastMessageSnippet = mergeAgent.mergeReport.summary.slice(0, 240);
      this.recordWorkflowOpenIssue(workflow, "GitHub push blocked", detail, "merge");
      this.recordWorkflowActivity(workflow, {
        source: "workflow",
        status: "failed",
        title: "GitHub push blocked",
        detail,
        stepId: "merge",
        agentId: mergeAgent.id,
        agentCategory: "merge"
      });
      this.updateWorkflowStepProgress(workflow, "merge", {
        currentActivity: "GitHub push blocked",
        latestProgressNote: detail,
        message: mergeAgent.mergeReport.summary,
        warning: "Auto-approve push settings do not bypass validation or hygiene gates.",
        agentCategory: "merge"
      }, { status: "failed" });
      return false;
    }

    try {
      const runtimeSettings = this.getRuntimeSettings(project.record.distroName);
      const result = await pushBranchToOrigin(project.record.projectRoot, branch, runtimeSettings);
      mergeAgent.mergeReport = {
        ...baseReport,
        summary: `${baseReport.summary} Pushed ${result.branch} to ${result.remote}.`,
        targetBranch: result.branch
      };
      this.recordWorkflowActivity(workflow, {
        source: "workflow",
        status: "completed",
        title: "GitHub push completed",
        detail: `Pushed ${result.branch} to ${result.remote}.`,
        stepId: "merge",
        agentId: mergeAgent.id,
        agentCategory: "merge"
      });
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      mergeAgent.mergeReport = {
        ...baseReport,
        summary: `${baseReport.summary} GitHub push failed. ${detail}`,
        targetBranch: branch
      };
      mergeAgent.status = "failed";
      mergeAgent.completedAt = nowIso();
      mergeAgent.currentPhase = "GitHub push failed";
      mergeAgent.lastMessageSnippet = mergeAgent.mergeReport.summary.slice(0, 240);
      this.recordWorkflowOpenIssue(workflow, "GitHub push failed", detail, "merge");
      if (!workflow.humanInterventions.some((entry) => entry.status === "pending" && entry.title === "GitHub publish failed")) {
        await this.createHumanInterventionRecord(project, {
          kind: "external_setup",
          title: "GitHub publish failed",
          description: `The local merge completed, but Codex Agent Workbench could not push ${branch} to origin.`,
          reason: detail,
          requestedByAgentCategory: "merge",
          severity: "high",
          blocking: true
        }, { persist: false, stepId: "merge" });
      }
      this.recordWorkflowActivity(workflow, {
        source: "workflow",
        status: "failed",
        title: "GitHub push failed",
        detail,
        stepId: "merge",
        agentId: mergeAgent.id,
        agentCategory: "merge"
      });
      this.updateWorkflowStepProgress(workflow, "merge", {
        currentActivity: "GitHub push failed",
        latestProgressNote: detail,
        message: mergeAgent.mergeReport.summary,
        warning: "The opened checkout was updated locally, but the merged branch was not pushed to GitHub.",
        agentCategory: "merge"
      }, { status: "failed" });
      return false;
    }
  }

  private async tryFinalizeResolvedMergeConflictWorktree(project: LoadedProject): Promise<boolean> {
    if (project.scan.kind !== "git") {
      return false;
    }

    const mergeAgent = this.getLatestConflictedMergeAgent(project);
    if (!mergeAgent?.worktree?.worktreePath || !mergeAgent.worktree.branch) {
      return false;
    }

    try {
      await access(mergeAgent.worktree.worktreePath);
    } catch {
      return false;
    }

    const runtimeSettings = this.getRuntimeSettings(project.record.distroName);
    await assertExecutionPathWithinProjectRoot(
      project.record.projectRoot,
      mergeAgent.worktree.worktreePath,
      project.record.hostPath,
      runtimeSettings,
      project.record.distroName,
      "Resolved merge-conflict worktree"
    );

    const unmergedFiles = await listUnmergedWorktreeFiles(mergeAgent.worktree.worktreePath, runtimeSettings);
    if (unmergedFiles.length > 0) {
      return false;
    }

    const targetBranch =
      mergeAgent.worktree.targetBranch ?? (await determineDefaultBranch(project.record.projectRoot, runtimeSettings));
    const checkpoint = await checkpointWorktreeChanges(
      mergeAgent.worktree.worktreePath,
      targetBranch,
      mergeAgent.worktree.branch,
      "Resolve merge conflicts",
      runtimeSettings
    );
    const codingBranches = this.getMergeCandidateCodingBranches(project);
    const missingBranches = await listBranchesMissingFromHead(
      mergeAgent.worktree.worktreePath,
      codingBranches,
      runtimeSettings
    );
    if (missingBranches.length > 0) {
      return false;
    }

    const workflow = this.ensureWorkflowState(project.record);
    const hygieneReport = await this.scanWorkflowRepoHygiene(
      project,
      `merge:${workflow.workflowCycle.cycleNumber}:resolved-conflict`,
      true,
      mergeAgent.worktree.worktreePath,
      targetBranch
    );
    mergeAgent.repoHygieneReport = hygieneReport;
    if (hygieneReport.status !== "passed") {
      const detail = hygieneReport.mergeBlockingFindings.join(" ") || hygieneReport.summaryForHumans;
      mergeAgent.mergeReport = {
        summary: `Resolved merge-conflict worktree was not applied because repository hygiene failed. ${detail}`,
        targetBranch,
        mergedBranches: codingBranches,
        conflicts: [],
        conflictCycleCount: mergeAgent.mergeReport?.conflictCycleCount ?? 1,
        generatedAt: nowIso()
      };
      mergeAgent.status = "failed";
      mergeAgent.completedAt = nowIso();
      mergeAgent.currentPhase = "Repository hygiene blocked resolved merge";
      this.recordWorkflowOpenIssue(workflow, "Repository hygiene blocked resolved merge", detail, "merge");
      this.updateWorkflowStepProgress(workflow, "merge", {
        currentActivity: "Merge blocked by repository hygiene",
        latestProgressNote: detail,
        message: mergeAgent.mergeReport.summary,
        warning: "Forbidden files must be removed before merge can continue."
      }, { status: "failed" });
      this.syncWorkflowState(project);
      await this.persistProjectUpdate(project, false);
      return true;
    }

    const appliedCheckoutBranch = await this.applyGitBranchToProjectCheckout(
      project,
      mergeAgent.worktree.branch,
      "Merge conflict retry"
    );
    mergeAgent.mergeReport = {
      summary: appliedCheckoutBranch
        ? `Resolved merge-conflict worktree was applied to the opened checkout on ${appliedCheckoutBranch}.`
        : "Resolved merge-conflict worktree was applied to the opened checkout.",
      targetBranch: appliedCheckoutBranch || targetBranch,
      mergedBranches: codingBranches,
      conflicts: [],
      conflictCycleCount: mergeAgent.mergeReport?.conflictCycleCount ?? 1,
      generatedAt: nowIso()
    };
    mergeAgent.status = "completed";
    mergeAgent.completedAt = nowIso();
    mergeAgent.currentPhase = "Resolved merge conflicts applied";
    mergeAgent.changedFiles = checkpoint.changedFiles;
    mergeAgent.lastMessageSnippet = mergeAgent.mergeReport.summary.slice(0, 240);

    const published = await this.publishMergedCheckoutToOrigin(
      project,
      mergeAgent,
      workflow,
      appliedCheckoutBranch || targetBranch,
      "Merge conflict retry",
      !this.latestCycleValidationLedger(workflow)
    );
    if (!published) {
      this.syncWorkflowState(project);
      await this.persistProjectUpdate(project, false);
      return true;
    }

    this.resetWorkflowRepairState(workflow);
    this.resolveWorkflowOpenIssues(workflow, (issue) => issue.source === "merge");
    this.resolveWorkflowHumanInterventions(
      workflow,
      (intervention) => intervention.requestedByAgentCategory === "merge",
      "Resolved automatically after merge completed."
    );
    workflow.workflowCycle.status = "merged";
    this.recordWorkflowActivity(workflow, {
      source: "workflow",
      status: "completed",
      title: "Merge completed",
      detail: mergeAgent.mergeReport.summary,
      stepId: "merge",
      agentId: mergeAgent.id,
      agentCategory: "merge"
    });
    this.updateWorkflowStepProgress(workflow, "merge", {
      requiresUserInput: false,
      currentActivity: "Integration complete",
      latestProgressNote: checkpoint.createdCommit
        ? "Committed the resolved integration worktree before updating the opened checkout."
        : "Used the resolved integration worktree to update the opened checkout.",
      message: mergeAgent.mergeReport.summary,
      warning: undefined,
      agentCategory: "merge"
    }, { status: "completed" });
    await this.cleanupCompletedManagedWorktrees(project, [mergeAgent.worktree.worktreePath]);
    this.syncWorkflowState(project);
    await this.persistProjectUpdate(project, {
      save: "deferred",
      emit: "coalesced",
      automate: true,
      reason: "resolved merge-conflict worktree applied"
    });
    return true;
  }

  async runMerge(projectId: string, automate = false): Promise<void> {
    if (this.workflowMergeInFlight.has(projectId)) {
      const project = this.findProject(projectId);
      const workflow = this.ensureWorkflowState(project.record);
      this.recordWorkflowActivity(workflow, {
        source: "workflow",
        status: "waiting",
        title: "Merge already running",
        detail: "A merge is already in progress for this project, so the duplicate request was ignored.",
        stepId: "merge"
      });
      this.updateWorkflowStepProgress(workflow, "merge", {
        requiresUserInput: false,
        currentActivity: "Merge already running",
        message: "A merge is already in progress for this project."
      });
      this.syncWorkflowState(project);
      await this.persistProjectUpdate(project, {
        save: false,
        emit: "coalesced",
        reason: "merge request coalesced"
      });
      return;
    }

    this.workflowMergeInFlight.add(projectId);
    try {
      const project = this.findProject(projectId);
      await this.ensureAgentBackedRuntimeReady(project, "merge runtime check");
      await this.runMergeInternal(projectId, automate);
    } finally {
      this.workflowMergeInFlight.delete(projectId);
    }
  }

  private async runMergeInternal(projectId: string, automate = false): Promise<void> {
    const project = this.findProject(projectId);
    this.assertResolvedPathCompatible(project.record.distroName);
    const runtimeSettings = this.getRuntimeSettings(project.record.distroName);
    const workflow = this.ensureWorkflowState(project.record);
    this.recordWorkflowActivity(workflow, {
      source: "workflow",
      status: "running",
      title: "Merge started",
      detail: project.scan.kind === "git" ? "Preparing deterministic integration worktree." : "Finalizing validated changes in place.",
      stepId: "merge"
    });
    this.updateWorkflowStepProgress(workflow, "merge", {
      requiresUserInput: false,
      currentActivity: project.scan.kind === "git" ? "Preparing integration" : "Finalizing in-place changes",
      message: project.scan.kind === "git"
        ? "Preparing a safe integration worktree inside the project boundary."
        : "No separate branch merge is needed for a non-Git project.",
      agentCategory: "merge"
    }, { status: "running", incrementRunCount: true, incrementAttemptCount: true });
    this.syncWorkflowState(project);
    await this.persistProjectUpdate(project, {
      save: false,
      emit: "coalesced",
      reason: "merge started"
    });

    const mergeModel = this.getDefaultAgentModel();
    const mergeAgent = await this.createAgent(
      projectId,
      "merge",
      "Merge Agent",
      "Integrate validated work deterministically.",
      mergeModel,
      { launchThread: false, persistOnCreate: false }
    );
    const preMergeHygieneReport = await this.scanWorkflowRepoHygiene(project, `merge:${workflow.workflowCycle.cycleNumber}:pre`, true);
    mergeAgent.repoHygieneReport = preMergeHygieneReport;
    const mergeBlockedReasons = this.mergeGateBlockedReasons(workflow, preMergeHygieneReport);
    const onlyMissingLedger = this.validationLedgerIsMissingEquivalent(this.latestCycleValidationLedger(workflow)) &&
      mergeBlockedReasons.length === 1 &&
      this.mergeGateReasonIsOnlyMissingValidationLedger(mergeBlockedReasons[0]);
    const allowMissingLedgerOverride = onlyMissingLedger && (!automate || this.workflowMergeRetryInFlight.has(projectId));
    if (mergeBlockedReasons.length > 0 && !allowMissingLedgerOverride) {
      const detail = mergeBlockedReasons.join(" ");
      const latestLedger = this.latestCycleValidationLedger(workflow);
      mergeAgent.mergeReport = {
        summary: `Merge blocked before integration. ${detail}`,
        mergedBranches: [],
        conflicts: [],
        conflictCycleCount: 0,
        generatedAt: nowIso()
      };
      mergeAgent.status = "failed";
      mergeAgent.completedAt = nowIso();
      mergeAgent.currentPhase = "Merge blocked by validation or repository hygiene";
      mergeAgent.lastMessageSnippet = mergeAgent.mergeReport.summary.slice(0, 240);
      this.recordWorkflowOpenIssue(workflow, "Merge blocked", detail, "merge");
      this.recordWorkflowActivity(workflow, {
        source: "workflow",
        status: "failed",
        title: preMergeHygieneReport.mergeBlockingFindings.length > 0 ? "Merge blocked by repository hygiene" : "Merge blocked by validation",
        detail,
        stepId: "merge",
        agentId: mergeAgent.id,
        agentCategory: "merge"
      });
      this.updateWorkflowStepProgress(workflow, "merge", {
        currentActivity: "Merge blocked",
        latestProgressNote: detail,
        message: mergeAgent.mergeReport.summary,
        warning: "Validation and repository hygiene gates must pass before merge or push."
      }, { status: "failed" });
      if (automate && onlyMissingLedger) {
        this.updateWorkflowRepairState(workflow, {
          status: "retrying_validation",
          latestIssueSummary: "Merge needs a current validation ledger before integration.",
          latestFailureReason: detail
        });
        this.resetWorkflowStepProgress(workflow, "integrity", {
          status: "waiting",
          requiresUserInput: false,
          currentActivity: "Queued to rebuild validation ledger",
          latestProgressNote: detail,
          message: "Autopilot will rerun validation before trying merge again."
        });
        this.recordWorkflowActivity(workflow, {
          source: "workflow",
          status: "waiting",
          title: "Validation rerun queued before merge",
          detail,
          stepId: "integrity"
        });
        this.syncWorkflowState(project);
        await this.persistProjectUpdate(project, {
          save: "immediate",
          emit: "coalesced",
          automate: true,
          reason: "merge blocked by missing validation ledger"
        });
        return;
      }
      const environmentOnlyValidationBlocker = latestLedger
        ? latestLedger.finalValidationStatus !== "passed" &&
          latestLedger.environmentFailures.length > 0 &&
          latestLedger.productFailures.length === 0 &&
          latestLedger.evidenceFailures.length === 0 &&
          latestLedger.hygieneFailures.length === 0
        : false;
      const queuedAutomaticRepair = this.queueAutomaticWorkflowRepair(project, {
        sourceStep: "merge",
        issueSummary: mergeAgent.mergeReport.summary,
        latestFailureReason: detail,
        involvedPaths: [
          ...preMergeHygieneReport.forbiddenFiles,
          ...preMergeHygieneReport.cleanedFiles
        ],
        repairable: !environmentOnlyValidationBlocker,
        automate
      });
      this.syncWorkflowState(project);
      await this.persistProjectUpdate(project, queuedAutomaticRepair
        ? {
          save: "immediate",
          emit: "coalesced",
          automate: true,
          reason: "merge blocked; automatic repair queued"
        }
        : false);
      return;
    }
    if (allowMissingLedgerOverride) {
      this.recordWorkflowActivity(workflow, {
        source: "workflow",
        status: "waiting",
        title: "Manual merge proceeding without retained validation ledger",
        detail: this.workflowMergeRetryInFlight.has(projectId)
          ? "The operator retried a resolved merge-conflict workflow. Future automated merge paths still require a passing validation ledger."
          : "The operator invoked merge directly. Future automated merge paths still require a passing validation ledger.",
        stepId: "merge",
        agentId: mergeAgent.id,
        agentCategory: "merge"
      });
    }

    if (project.scan.kind !== "git") {
      mergeAgent.mergeReport = {
        summary: "This project is not a Git repository, so validated changes remain applied in place.",
        mergedBranches: [],
        conflicts: [],
        conflictCycleCount: 0,
        generatedAt: nowIso()
      };
      mergeAgent.status = "completed";
      mergeAgent.completedAt = nowIso();
      workflow.workflowCycle.status = "merged";
      if (workflow.repair.status === "fixed") {
        this.recordWorkflowActivity(workflow, {
          source: "workflow",
          status: "completed",
          title: "Repair cycle closed successfully",
          detail: "Validation passed after repair and the work was finalized in place.",
          stepId: "merge"
        });
      }
      this.resolveWorkflowOpenIssues(workflow, (issue) => issue.source === "merge");
      this.resolveWorkflowHumanInterventions(
        workflow,
        (intervention) => intervention.requestedByAgentCategory === "merge",
        "Resolved automatically after in-place integration completed."
      );
      this.updateWorkflowStepProgress(workflow, "merge", {
        currentActivity: "In-place integration complete",
        latestProgressNote: "No Git merge step was required.",
        message: mergeAgent.mergeReport.summary,
        warning: undefined
      }, { status: "completed" });
      this.syncWorkflowState(project);
      await this.persistProjectUpdate(project, true);
      return;
    }

    const codingBranches = this.getMergeCandidateCodingBranches(project);
    const integrationWorktree = mergeAgent.worktree ?? (await createWorktreeAssignment(
      project.record.projectRoot,
      this.settings.worktreeBaseDir,
      project.record.identity.projectName,
      "integration",
      await determineDefaultBranch(project.record.projectRoot, runtimeSettings),
      runtimeSettings
    ));
    mergeAgent.worktree = integrationWorktree;
    await assertExecutionPathWithinProjectRoot(
      project.record.projectRoot,
      integrationWorktree.worktreePath,
      project.record.hostPath,
      runtimeSettings,
      project.record.distroName,
      "Merge integration worktree"
    );
    const targetBranch = integrationWorktree.targetBranch ?? (await determineDefaultBranch(project.record.projectRoot, runtimeSettings));
    const mergeResult = await attemptMerge(
      integrationWorktree.worktreePath,
      targetBranch,
      codingBranches,
      runtimeSettings
    );
    const integrationBranch = integrationWorktree.branch;
    let appliedCheckoutBranch: string | undefined;

    mergeAgent.mergeReport = {
      summary:
        mergeResult.conflicts.length === 0
          ? "All selected coding-agent branches merged cleanly in the integration worktree."
          : "Merge conflicts were detected and require follow-up.",
      targetBranch,
      mergedBranches: mergeResult.mergedBranches,
      conflicts: mergeResult.conflicts,
      conflictCycleCount: mergeResult.conflicts.length > 0 ? 1 : 0,
      generatedAt: nowIso()
    };
    if (mergeResult.conflicts.length > 0) {
      mergeAgent.status = "conflicted";
      mergeAgent.completedAt = nowIso();
      const latestFailureReason = mergeResult.conflicts[0] ?? "Deterministic merge reported conflicts.";
      this.updateWorkflowRepairState(workflow, {
        attemptCount: workflow.repair.attemptCount + 1,
        status: "merge_conflicts",
        latestIssueSummary: mergeAgent.mergeReport.summary,
        latestFailureReason
      });
      workflow.manualHandoff = this.buildRepairManualHandoff(
        project,
        mergeAgent.mergeReport.summary,
        latestFailureReason,
        "merge_conflicts",
        this.getMergeConflictHandoffPaths(mergeResult.conflicts)
      );
      this.recordWorkflowOpenIssue(
        workflow,
        "Merge conflicts require follow-up",
        mergeResult.conflicts.join(", ") || "Deterministic merge reported conflicts.",
        "merge"
      );
      this.recordWorkflowActivity(workflow, {
        source: "workflow",
        status: "failed",
        title: "Merge conflicts detected",
        detail: latestFailureReason,
        stepId: "merge"
      });
      this.updateWorkflowStepProgress(workflow, "merge", {
        currentActivity: "Merge conflicts detected",
        latestProgressNote: latestFailureReason,
        message: mergeAgent.mergeReport.summary,
        warning: "Automatic merge repair is not available for these conflicts."
      }, { status: "failed" });
    } else {
      mergeAgent.status = "running";
      mergeAgent.completedAt = undefined;
      const integrationHygieneReport = await this.scanWorkflowRepoHygiene(
        project,
        `merge:${workflow.workflowCycle.cycleNumber}:integration`,
        true,
        integrationWorktree.worktreePath,
        targetBranch
      );
      mergeAgent.repoHygieneReport = integrationHygieneReport;
      if (integrationHygieneReport.status !== "passed") {
        const detail = integrationHygieneReport.mergeBlockingFindings.join(" ") || integrationHygieneReport.summaryForHumans;
        mergeAgent.mergeReport.summary = `Merged cleanly in the integration worktree, but repository hygiene blocked finalization. ${detail}`;
        mergeAgent.status = "failed";
        mergeAgent.completedAt = nowIso();
        this.recordWorkflowOpenIssue(workflow, "Repository hygiene blocked merge", detail, "merge");
        this.recordWorkflowActivity(workflow, {
          source: "workflow",
          status: "failed",
          title: "Merge blocked by repository hygiene",
          detail,
          stepId: "merge",
          agentId: mergeAgent.id,
          agentCategory: "merge"
        });
        this.updateWorkflowStepProgress(workflow, "merge", {
          currentActivity: "Merge blocked by repository hygiene",
          latestProgressNote: detail,
          message: mergeAgent.mergeReport.summary,
          warning: "Forbidden files must be removed before merge can continue."
        }, { status: "failed" });
        const queuedAutomaticRepair = this.queueAutomaticWorkflowRepair(project, {
          sourceStep: "merge",
          issueSummary: mergeAgent.mergeReport.summary,
          latestFailureReason: detail,
          involvedPaths: [
            ...integrationHygieneReport.forbiddenFiles,
            ...integrationHygieneReport.cleanedFiles
          ],
          automate
        });
        this.syncWorkflowState(project);
        await this.persistProjectUpdate(project, queuedAutomaticRepair
          ? {
            save: "immediate",
            emit: "coalesced",
            automate: true,
            reason: "integration hygiene blocked; automatic repair queued"
          }
          : false);
        return;
      }
      try {
        appliedCheckoutBranch = integrationBranch
          ? await this.applyGitBranchToProjectCheckout(project, integrationBranch, "Merge finalization")
          : undefined;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        mergeAgent.mergeReport.summary = `Merged cleanly in the integration worktree, but the opened checkout was not updated. ${detail}`;
        mergeAgent.status = "failed";
        mergeAgent.completedAt = nowIso();
        this.recordWorkflowOpenIssue(workflow, "Opened checkout was not updated", detail, "merge");
        if (!workflow.humanInterventions.some((entry) => entry.status === "pending" && entry.title === "Opened checkout update blocked")) {
          await this.createHumanInterventionRecord(project, {
            kind: "other",
            title: "Opened checkout update blocked",
            description: "Validated changes merged cleanly in the integration worktree, but Git could not apply them to the opened project checkout.",
            reason: detail,
            requestedByAgentCategory: "merge",
            severity: "high",
            blocking: true
          }, { persist: false, stepId: "merge" });
        }
        this.recordWorkflowActivity(workflow, {
          source: "workflow",
          status: "failed",
          title: "Checkout update failed",
          detail,
          stepId: "merge"
        });
        this.updateWorkflowStepProgress(workflow, "merge", {
          currentActivity: "Checkout update failed",
          latestProgressNote: detail,
          message: mergeAgent.mergeReport.summary,
          warning: "Validated changes were not applied to the opened project folder."
        }, { status: "failed" });
        this.syncWorkflowState(project);
        await this.persistProjectUpdate(project, false);
        return;
      }

      mergeAgent.mergeReport.summary = appliedCheckoutBranch
        ? `All selected coding-agent branches merged cleanly and the opened checkout on ${appliedCheckoutBranch} was updated.`
        : "All selected coding-agent branches merged cleanly and the opened checkout was updated.";
      if (appliedCheckoutBranch) {
        mergeAgent.mergeReport.targetBranch = appliedCheckoutBranch;
      }
      const published = await this.publishMergedCheckoutToOrigin(
        project,
        mergeAgent,
        workflow,
        appliedCheckoutBranch ?? targetBranch,
        "Merge finalization",
        allowMissingLedgerOverride
      );
      if (!published) {
        this.syncWorkflowState(project);
        await this.persistProjectUpdate(project, false);
        return;
      }
      this.resolveWorkflowOpenIssues(workflow, (issue) => issue.source === "merge");
      this.resolveWorkflowHumanInterventions(
        workflow,
        (intervention) => intervention.requestedByAgentCategory === "merge",
        "Resolved automatically after merge finalization completed."
      );
      workflow.workflowCycle.status = "merged";
      await this.cleanupCompletedManagedWorktrees(project, this.getRetiredMergeWorktreePaths(project, mergeAgent.id));
      mergeAgent.status = "completed";
      mergeAgent.completedAt = nowIso();
      this.recordWorkflowActivity(workflow, {
        source: "workflow",
        status: "completed",
        title: "Merge completed",
        detail: mergeAgent.mergeReport.summary,
        stepId: "merge"
      });
      this.updateWorkflowStepProgress(workflow, "merge", {
        currentActivity: "Integration complete",
        latestProgressNote: mergeResult.mergedBranches.length
          ? `Merged ${mergeResult.mergedBranches.length} branch${mergeResult.mergedBranches.length === 1 ? "" : "es"}.`
          : "Nothing new needed merging.",
        message: mergeAgent.mergeReport.summary,
        warning: undefined
      }, { status: "completed" });
    }
    this.syncWorkflowState(project);
    await this.persistProjectUpdate(project, {
      save: "deferred",
      emit: "coalesced",
      automate: automate || mergeResult.conflicts.length === 0,
      reason: mergeResult.conflicts.length > 0 ? "merge conflicts recorded" : "merge completed"
    });
  }

  private findHighConfidenceDeterministicWorkPackage(context: WorkflowRecommendationContext): WorkPackage | undefined {
    const modeConfig = getWorkflowModeConfig(context.workflow.workflowMode, resolveEffectiveAutopilotPolicy(context.workflow));
    const preferredMinimum = Math.min(
      Math.max(2, context.workflow.taskMap.openRequiredChecks || 2),
      modeConfig.preferredMinChecksPerPackage
    );
    const packages = buildChecklistWorkPackages(context, {
      maxChecksPerPackage: modeConfig.maxChecksPerPackage
    });
    return packages.find((workPackage) =>
      workPackage.checkIds.length >= preferredMinimum &&
      workPackage.confidence >= modeConfig.highConfidencePackageThreshold &&
      workPackage.acceptanceHints.length > 0 &&
      workPackage.estimatedBreadth !== "large"
    ) ?? packages.find((workPackage) =>
      workPackage.checkIds.length >= 2 &&
      workPackage.confidence >= modeConfig.highConfidencePackageThreshold + 0.05 &&
      workPackage.acceptanceHints.length > 0 &&
      workPackage.estimatedBreadth !== "large"
    );
  }

  async runRecommendation(projectId: string, automate = false, customFocus?: string): Promise<void> {
    const project = this.findProject(projectId);
    const workflow = this.ensureWorkflowState(project.record);
    const objective = project.record.localState.workflowObjective;
    const normalizedCustomFocus = customFocus?.trim() || undefined;
    if (!workflow.ultimateGoal.confirmedAt) {
      throw new Error("Confirm the Ultimate Goal before generating recommendations.");
    }
    if (workflow.approvedRecommendation && workflow.workflowCycle.status !== "completed" && workflow.workflowCycle.status !== "merged") {
      throw new Error("This cycle already has an approved recommendation. Create a scoped goal or finish the cycle before re-running recommendations.");
    }
    const activeRecommendationAgents = project.record.agents.filter((agent) =>
        agent.category === "recommendation" &&
        isAgentActive(agent) &&
        (agent.workflowCycleNumber === undefined || agent.workflowCycleNumber === workflow.workflowCycle.cycleNumber)
    );
    if (normalizedCustomFocus) {
      if (activeRecommendationAgents.some((agent) => this.extractCustomRecommendationFocus(agent) === normalizedCustomFocus)) {
        return;
      }
      for (const agent of activeRecommendationAgents) {
        agent.status = "disconnected";
        agent.currentPhase = "Superseded by custom recommendation focus";
        agent.disconnectedReason = `Superseded by custom recommendation focus: ${normalizedCustomFocus}`;
        agent.completedAt ??= nowIso();
        if (agent.threadId) {
          this.threadToAgent.delete(agent.threadId);
        }
      }
    }
    if (
      !normalizedCustomFocus &&
      activeRecommendationAgents.some((agent) => isAgentActive(agent))
    ) {
      return;
    }
    if (automate && !normalizedCustomFocus && workflow.recommendations.length > 0 && !workflow.approvedRecommendation) {
      return;
    }

    await this.ensureAgentBackedRuntimeReady(project, "recommendation runtime check");

    if (normalizedCustomFocus && !workflow.approvedRecommendation && workflow.recommendations.length > 0) {
      workflow.recommendations = [];
    }
    const previewMode = !normalizedCustomFocus && getWorkflowPreviewRequest(workflow).status === "queued";
    if (previewMode) {
      this.activateWorkflowPreviewRequest(project);
    }
    const cycleAim = this.buildRecommendationCycleAim(this.buildWorkflowRecommendationContext(project, normalizedCustomFocus));
    this.recordWorkflowActivity(workflow, {
      source: "workflow",
      status: "running",
      title: previewMode
        ? "Preview recommendation generation started"
        : objective === "optimize" ? "Optimization recommendation generation started" : "Recommendation generation started",
      detail: previewMode
        ? "Inspecting repo state for the smallest visible/runnable checkpoint that keeps incomplete areas explicit."
        : normalizedCustomFocus
        ? `Inspecting repo state, workflow memory, recent activity, and the custom focus "${normalizedCustomFocus}".`
        : objective === "optimize"
          ? "Inspecting repo state, workflow memory, and recent activity for the next bounded improvement."
          : "Inspecting repo state, workflow memory, and recent activity.",
      stepId: "recommendation"
    });
    this.updateWorkflowStepProgress(workflow, "recommendation", {
      requiresUserInput: false,
      currentActivity: previewMode
        ? "Generating preview checkpoint candidates"
        : objective === "optimize" ? "Generating optimization candidates" : "Generating recommendation candidates",
      currentSubstep: cycleAim.currentSubstep,
      latestProgressNote: normalizedCustomFocus
        ? `Centering recommendations around: ${normalizedCustomFocus}`
        : previewMode
          ? "Preview mode is prioritizing visible/runnable inspection paths"
        : objective === "optimize"
          ? "Inspecting project state for the next improvement opportunity"
          : cycleAim.latestProgressNote,
      message: previewMode
        ? `Preview recommendation generation is running. ${cycleAim.currentSubstep}`
        : objective === "optimize"
        ? `Optimization recommendation generation is running. ${cycleAim.currentSubstep}`
        : `Recommendation generation is running. ${cycleAim.currentSubstep}`,
      agentCategory: "recommendation"
    }, { status: "running", incrementRunCount: true, incrementAttemptCount: true });
    this.syncWorkflowState(project);
    await this.persistProjectUpdate(project);

    if (previewMode) {
      await this.applyFallbackRecommendations(project, undefined, automate, normalizedCustomFocus);
      return;
    }

    const modeConfig = getWorkflowModeConfig(workflow.workflowMode, resolveEffectiveAutopilotPolicy(workflow, project.record.localState.autopilotEnabled));
    if (
      !previewMode &&
      !normalizedCustomFocus &&
      modeConfig.deterministicRecommendationFirst &&
      modeConfig.useRecommendationAgent === "when_no_high_confidence_package"
    ) {
      this.refreshUltimateGoalAssessmentIfChanged(project);
      const deterministicContext = this.buildWorkflowRecommendationContext(project);
      const deterministicPackage = this.findHighConfidenceDeterministicWorkPackage(deterministicContext);
      if (deterministicPackage) {
        this.recordWorkflowActivity(workflow, {
          source: "workflow",
          status: "running",
          title: "Fast Mode selected a deterministic work package",
          detail: `${deterministicPackage.title}: ${deterministicPackage.checkIds.length} required checks.`,
          stepId: "recommendation"
        });
        await this.applyFallbackRecommendations(project, undefined, automate, normalizedCustomFocus);
        return;
      }
    }

    await this.createAgent(
      projectId,
      "recommendation",
      "Recommendation Agent",
      this.buildRecommendationPrompt(project, normalizedCustomFocus),
      this.getDefaultAgentModel(),
      {
        sandbox: "read-only",
        outputSchema: this.buildRecommendationOutputSchema(),
        initialPhase: cycleAim.currentSubstep
      }
    );
  }

  private async runBootstrapIfNeeded(project: LoadedProject): Promise<void> {
    const bootstrapAgent = project.record.agents.find((agent) => agent.category === "bootstrap");
    if (!bootstrapAgent) {
      return;
    }

    if (!this.canRunAgentBackedActions(project)) {
      const report = this.buildRuntimeReadinessReport(project);
      project.record.interfaceCreation ??= createQueuedInterfaceCreationState(
        bootstrapAgent.model,
        bootstrapAgent.reasoningEffort,
        bootstrapAgent.reasoningEffortSource === "manual" ? "user" : "recommended"
      );
      project.record.interfaceCreation.status = "queued";
      project.record.interfaceCreation.phase = "Runtime checks required";
      project.record.interfaceCreation.message = report.summary;
      project.record.interfaceCreation.lastError = undefined;
      bootstrapAgent.status = "idle";
      bootstrapAgent.currentPhase = "Waiting for runtime readiness checks";
      await this.saveProject(project);
      this.emitState();
      return;
    }

    await this.ensureAgentBackedRuntimeReady(project, "interface creation runtime check");

    const interfaceConfig = this.resolveInterfaceCreationConfig();
    bootstrapAgent.model = interfaceConfig.model ?? bootstrapAgent.model;
    if (this.isProjectMeaningfullyEmpty(project)) {
      bootstrapAgent.reasoningEffort = interfaceConfig.reasoningEffort;
      bootstrapAgent.reasoningEffortSource = interfaceConfig.reasoningMode;
      bootstrapAgent.status = "completed";
      bootstrapAgent.currentPhase = "Skipped for empty project";
      bootstrapAgent.completedAt ??= nowIso();
      this.prepareSkippedInterfaceCreation(project, bootstrapAgent.model, interfaceConfig.reasoningEffort, interfaceConfig.source);
      await this.saveProject(project);
      this.emitState();
      return;
    }

    if (project.record.overview && project.summaryCache.list().length > 0) {
      project.record.interfaceCreation ??= createQueuedInterfaceCreationState(
        bootstrapAgent.model,
        interfaceConfig.reasoningEffort,
        interfaceConfig.source
      );
      project.record.interfaceCreation.reasoningEffort ??= interfaceConfig.reasoningEffort;
      project.record.interfaceCreation.status = "completed";
      project.record.interfaceCreation.phase = "Available";
      project.record.interfaceCreation.message = "Saved interface content is ready.";
      project.record.interfaceCreation.agentAnalysisReady =
        project.record.overview.source === "codex" ||
        project.record.overview.source === "hybrid" ||
        project.summaryCache.list().some((entry) => entry.source !== "deterministic");
      project.record.interfaceCreation.outputSource = project.record.overview.source;
      project.record.interfaceCreation.completedAt ??= nowIso();
      await this.saveProject(project);
      this.emitState();
      return;
    }

    bootstrapAgent.model = interfaceConfig.model ?? bootstrapAgent.model;
    bootstrapAgent.reasoningEffort = interfaceConfig.reasoningEffort;
    bootstrapAgent.reasoningEffortSource = interfaceConfig.reasoningMode;
    bootstrapAgent.status = "running";
    bootstrapAgent.currentPhase = "Preparing repository scan for interface creation";
    project.record.interfaceCreation = createQueuedInterfaceCreationState(
      bootstrapAgent.model,
      interfaceConfig.reasoningEffort,
      interfaceConfig.source
    );
    project.record.interfaceCreation.status = "running";
    project.record.interfaceCreation.phase = "Preparing scan";
    project.record.interfaceCreation.message = "Deterministic scan data is ready. Preparing agent input.";
    await this.saveProject(project);
    this.emitState();

    if (!this.transport || !bootstrapAgent.model || this.availableModels.length === 0 || this.codexAvailability.source === "unavailable") {
      bootstrapAgent.status = "idle";
      bootstrapAgent.currentPhase = "Waiting for runtime readiness checks";
      project.record.interfaceCreation.status = "queued";
      project.record.interfaceCreation.phase = "Runtime checks required";
      project.record.interfaceCreation.message = this.runtimeReadinessErrorMessage(project);
      project.record.interfaceCreation.lastError = this.codexAvailability.message ?? "Model discovery failed.";
      await this.saveProject(project);
      this.emitState();
      return;
    }

    try {
      const turn = await buildInterfaceCreationTurn({
        projectRoot: project.record.projectRoot,
        projectHostPath: project.record.hostPath,
        identity: project.record.identity,
        validation: project.record.validation,
        scan: project.scan,
        considerPaidServices: this.settings.considerPaidServices
      });

      project.record.interfaceCreation.phase = "Running analysis";
      project.record.interfaceCreation.message = "The interface-creation agent is generating the project overview and important path summaries.";
      bootstrapAgent.currentPhase = "Running interface analysis";
      await this.saveProject(project);
      this.emitState();

      await this.startAgentThread(project, bootstrapAgent, {
        sandbox: "read-only",
        prompt: turn.prompt,
        outputSchema: turn.outputSchema,
        effort: interfaceConfig.reasoningEffort
      });
    } catch (error) {
      bootstrapAgent.status = "failed";
      bootstrapAgent.currentPhase = "Interface creation failed";
      project.record.overview = buildDeterministicOverview({
        projectName: project.record.identity.projectName,
        explanation: project.scan.stats.explanation,
        entryPoints: project.scan.stats.entryPoints,
        manifestFiles: project.scan.stats.manifestFiles,
        primaryManagers: project.scan.stats.primaryManagers
      });
      project.record.interfaceCreation.status = "failed";
      project.record.interfaceCreation.phase = "Failed";
      project.record.interfaceCreation.message = "Interface creation failed before the agent could return a structured result.";
      project.record.interfaceCreation.lastError = error instanceof Error ? error.message : String(error);
      project.record.interfaceCreation.completedAt = nowIso();
      project.record.interfaceCreation.outputSource = "deterministic";
      await this.saveProject(project);
      this.emitState();
    }
  }

  private ensureDeterministicOverview(project: LoadedProject): void {
    project.record.overview ??= buildDeterministicOverview({
      projectName: project.record.identity.projectName,
      explanation: project.scan.stats.explanation,
      entryPoints: project.scan.stats.entryPoints,
      manifestFiles: project.scan.stats.manifestFiles,
      primaryManagers: project.scan.stats.primaryManagers
    });
  }

  private logInterfaceCreationPayload(agent: AgentState, source: string, rawText: string): void {
    const payload = rawText.trim();
    if (this.debugWorkflowPerf) {
      console.info(`[interfaceCreation] raw payload (${source}) ${payload.length} bytes`);
    }
    reduceAgentRuntimeEvent(agent, {
      kind: "raw",
      title: "Interface payload received",
      detail: `${source}: ${payload.slice(0, 240)}`,
      raw: {
        source,
        payload
      }
    });
  }

  private normalizeProjectRelativePath(relativePath: string): string | null {
    const normalized = path.posix.normalize(relativePath).replace(/^(\.\/)+/, "");
    if (!normalized || normalized === "." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
      return null;
    }
    return normalized;
  }

  private async failInterfaceCreation(
    project: LoadedProject,
    agent: AgentState,
    phase: string,
    message: string,
    lastError: string
  ): Promise<void> {
    this.ensureDeterministicOverview(project);
    const interfaceConfig = this.resolveInterfaceCreationConfig();
    project.record.interfaceCreation ??= createQueuedInterfaceCreationState(
      agent.model,
      interfaceConfig.reasoningEffort,
      interfaceConfig.source
    );
    project.record.interfaceCreation.status = "failed";
    project.record.interfaceCreation.reasoningEffort = interfaceConfig.reasoningEffort;
    project.record.interfaceCreation.phase = phase;
    project.record.interfaceCreation.message = message;
    project.record.interfaceCreation.lastError = lastError;
    project.record.interfaceCreation.completedAt = nowIso();
    project.record.interfaceCreation.outputSource = "deterministic";
    project.record.interfaceCreation.agentAnalysisReady = false;
    agent.status = "failed";
    agent.currentPhase = phase;
    await this.saveProject(project);
    this.emitState();
  }

  private buildInterfaceCreationRepairPrompt(failure: InterfaceCreationParseFailure): string {
    const parts = [
      "Your previous interface-creation reply could not be applied.",
      "Return exactly one JSON object that matches the output schema.",
      "Do not include markdown fences or any commentary.",
      `Failure kind: ${failure.kind}.`,
      `Failure detail: ${failure.message}.`
    ];

    if (failure.extractedText) {
      parts.push(`Previous extracted JSON candidate:\n${failure.extractedText.slice(0, 4000)}`);
    } else if (failure.rawText.trim()) {
      parts.push(`Previous raw reply:\n${failure.rawText.trim().slice(0, 4000)}`);
    }

    return parts.join("\n\n");
  }

  private async requestInterfaceCreationRepair(
    project: LoadedProject,
    agent: AgentState,
    failure: InterfaceCreationParseFailure
  ): Promise<boolean> {
    if (!this.transport || !agent.threadId) {
      return false;
    }

    const attempts = this.interfaceCreationRepairAttempts.get(agent.threadId) ?? 0;
    if (attempts >= 1) {
      return false;
    }

    this.interfaceCreationRepairAttempts.set(agent.threadId, attempts + 1);
    const interfaceConfig = this.resolveInterfaceCreationConfig();
    project.record.interfaceCreation ??= createQueuedInterfaceCreationState(
      agent.model,
      interfaceConfig.reasoningEffort,
      interfaceConfig.source
    );
    project.record.interfaceCreation.reasoningEffort = interfaceConfig.reasoningEffort;
    project.record.interfaceCreation.status = "running";
    project.record.interfaceCreation.phase = "Repairing result";
    project.record.interfaceCreation.message = "The first structured response was invalid. Requesting one strict JSON retry.";
    project.record.interfaceCreation.lastError = failure.message;
    agent.status = "running";
    agent.currentPhase = "Retrying invalid interface output";
    await this.saveProject(project);
    this.emitState();

    await this.transport.startTurn({
      threadId: agent.threadId,
      input: [
        {
          type: "text",
          text: this.buildInterfaceCreationRepairPrompt(failure),
          text_elements: []
        }
      ],
      model: agent.model,
      effort: interfaceConfig.reasoningEffort,
      outputSchema: buildInterfaceCreationOutputSchema()
    });
    return true;
  }

  private async applyInterfaceCreationOutput(
    project: LoadedProject,
    agent: AgentState,
    rawText: string,
    source = "agentMessage"
  ): Promise<{ applied: true } | { applied: false; failure: InterfaceCreationParseFailure }> {
    this.logInterfaceCreationPayload(agent, source, rawText);
    const parsed = parseInterfaceCreationOutput(rawText);
    if (!parsed.ok) {
      reduceAgentRuntimeEvent(agent, {
        kind: "raw",
        title: "Interface payload rejected",
        detail: parsed.message,
        raw: parsed
      });
      return {
        applied: false,
        failure: parsed
      };
    }

    const knownFiles = new Set(project.scan.files.map((entry) => entry.relativePath));
    const knownDirectories = new Set<string>();
    for (const file of project.scan.files) {
      const segments = file.relativePath.split("/");
      let current = "";
      for (let index = 0; index < segments.length - 1; index += 1) {
        current = current ? `${current}/${segments[index]}` : segments[index];
        knownDirectories.add(current);
      }
    }

    const existingByPath = new Map(project.summaryCache.list().map((entry) => [entry.relativePath, entry]));
    const repairNotes: string[] = [];
    if (parsed.repaired) {
      repairNotes.push("normalized partial structured output");
    }

    let skippedPathSummaries = 0;
    for (const summary of parsed.output.pathSummaries) {
      const normalizedPath = this.normalizeProjectRelativePath(summary.relativePath);
      const actualPathKind = normalizedPath
        ? knownFiles.has(normalizedPath)
          ? "file"
          : knownDirectories.has(normalizedPath)
            ? "directory"
            : null
        : null;

      if (!normalizedPath || !actualPathKind) {
        skippedPathSummaries += 1;
        continue;
      }

      const normalizedRelatedFiles = summary.relatedFiles
        .map((entry) => this.normalizeProjectRelativePath(entry))
        .filter((entry): entry is string => entry !== null && (knownFiles.has(entry) || knownDirectories.has(entry)))
        .slice(0, 6);

      try {
        const contentHash =
          actualPathKind === "file"
            ? sha256(
              await (await import("node:fs/promises")).readFile(
                await assertProjectRelativeHostPath(project.record.hostPath, normalizedPath, "Interface path summary read"),
                "utf8"
              )
            )
            : getPathContentHash(project.scan, normalizedPath, actualPathKind);
        project.summaryCache.upsert({
          relativePath: normalizedPath,
          pathKind: actualPathKind,
          contentHash,
          title: summary.title,
          purpose: summary.purpose,
          summary: summary.summary,
          keySymbols: summary.keySymbols,
          relatedFiles: normalizedRelatedFiles,
          confidence: summary.confidence,
          source: actualPathKind === "file" && existingByPath.get(normalizedPath)?.source === "deterministic" ? "hybrid" : "codex",
          generatedAt: nowIso()
        });
      } catch {
        skippedPathSummaries += 1;
      }
    }

    if (skippedPathSummaries > 0) {
      repairNotes.push(`skipped ${skippedPathSummaries} invalid path ${skippedPathSummaries === 1 ? "summary" : "summaries"}`);
    }

    project.record.overview = toStoredOverview(parsed.output.overview, "hybrid");
    const interfaceConfig = this.resolveInterfaceCreationConfig();
    project.record.interfaceCreation ??= createQueuedInterfaceCreationState(
      agent.model,
      interfaceConfig.reasoningEffort,
      interfaceConfig.source
    );
    project.record.interfaceCreation.reasoningEffort = interfaceConfig.reasoningEffort;
    project.record.interfaceCreation.status = "completed";
    project.record.interfaceCreation.phase = "Complete";
    project.record.interfaceCreation.message = repairNotes.length > 0
      ? `Agent analysis was applied with repairs: ${repairNotes.join("; ")}.`
      : "Agent analysis and deterministic scan data have been combined into the project interface.";
    project.record.interfaceCreation.agentAnalysisReady = true;
    project.record.interfaceCreation.outputSource = "hybrid";
    project.record.interfaceCreation.completedAt = nowIso();
    project.record.interfaceCreation.lastError = undefined;
    agent.status = "completed";
    agent.currentPhase = repairNotes.length > 0 ? "Interface creation complete with repairs" : "Interface creation complete";
    if (agent.threadId) {
      this.interfaceCreationRepairAttempts.delete(agent.threadId);
    }
    await this.saveProject(project);
    this.emitState();
    return { applied: true };
  }

  private extractTextFromRawResponseItem(item: unknown): string | undefined {
    const responseItem = item as {
      type?: string;
      role?: string;
      content?: Array<{ type?: string; text?: string }>;
    };
    if (responseItem.type !== "message" || responseItem.role !== "assistant" || !Array.isArray(responseItem.content)) {
      return undefined;
    }

    const text = responseItem.content
      .filter((entry) => entry.type === "output_text" && typeof entry.text === "string")
      .map((entry) => entry.text ?? "")
      .join("");
    return text.trim() ? text : undefined;
  }

  private extractAgentCredentialCaptures(text?: string): AgentCredentialCapture[] {
    if (!text) {
      return [];
    }

    const captures: AgentCredentialCapture[] = [];
    const blockPattern = /AGENT_WORKBENCH_CREDENTIAL\s+({[^\r\n]+})/g;
    for (const match of text.matchAll(blockPattern)) {
      try {
        const parsed = JSON.parse(match[1]) as Partial<AgentCredentialCapture>;
        const providerName = parsed.providerName?.trim();
        const keyLabel = parsed.keyLabel?.trim() || "API key";
        const apiKey = parsed.apiKey?.trim();
        const secretKey = parsed.secretKey?.trim();
        if (!providerName || !apiKey) {
          continue;
        }
        captures.push({
          providerName,
          keyLabel,
          apiKey,
          secretKey: secretKey || undefined,
          notes: parsed.notes?.trim() || undefined,
          freeTier: parsed.freeTier
        });
      } catch {
        continue;
      }
    }
    return captures;
  }

  private redactAgentCredentialCaptures(text?: string): string | undefined {
    if (!text) {
      return text;
    }
    return text.replace(/AGENT_WORKBENCH_CREDENTIAL\s+({[^\r\n]+})/g, (_full, rawJson: string) => {
      try {
        const parsed = JSON.parse(rawJson) as Partial<AgentCredentialCapture>;
        return `AGENT_WORKBENCH_CREDENTIAL ${JSON.stringify({
          providerName: parsed.providerName ?? "Provider",
          keyLabel: parsed.keyLabel ?? "API key",
          apiKey: "[stored locally]",
          secretKey: parsed.secretKey ? "[stored locally]" : undefined,
          freeTier: parsed.freeTier === true,
          notes: parsed.notes ?? undefined
        })}`;
      } catch {
        return "AGENT_WORKBENCH_CREDENTIAL [redacted]";
      }
    });
  }

  private redactAgentCredentialCapturesFromValue(value: unknown): unknown {
    if (typeof value === "string") {
      return this.redactAgentCredentialCaptures(value);
    }
    if (Array.isArray(value)) {
      return value.map((entry) => this.redactAgentCredentialCapturesFromValue(entry));
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, this.redactAgentCredentialCapturesFromValue(entry)])
      );
    }
    return value;
  }

  private async storeAgentCredentialCaptures(
    project: LoadedProject,
    agent: AgentState,
    text?: string
  ): Promise<void> {
    const captures = this.extractAgentCredentialCaptures(text);
    if (captures.length === 0) {
      return;
    }

    project.record.credentials = {
      ...defaultProjectCredentialsState(),
      ...project.record.credentials,
      entries: project.record.credentials?.entries ?? [],
      requests: project.record.credentials?.requests ?? []
    };

    const now = nowIso();
    for (const capture of captures) {
      if (!this.settings.considerPaidServices && capture.freeTier !== true) {
        this.recordWorkflowActivity(this.ensureWorkflowState(project.record), {
          source: "system",
          status: "waiting",
          title: "Ignored unverified credential capture",
          detail: `${capture.providerName} was not stored because Consider Paid Services is off and the agent did not mark it free.`,
          stepId: getWorkflowActiveStepId(this.ensureWorkflowState(project.record)),
          agentId: agent.id,
          agentCategory: agent.category
        });
        continue;
      }

      const linkedRequestIds = this.autoLinkMatchingCredentialRequests(project, capture.providerName, capture.keyLabel, []);
      const existing = project.record.credentials.entries.find((entry) =>
        entry.providerName.toLowerCase() === capture.providerName.toLowerCase() &&
        entry.keyLabel.toLowerCase() === capture.keyLabel.toLowerCase()
      );
      const entry: CredentialEntryMetadata = {
        id: existing?.id ?? nanoid(),
        providerName: capture.providerName,
        keyLabel: capture.keyLabel,
        hasApiKey: true,
        hasSecretKey: Boolean(capture.secretKey),
        status: "active",
        source: "agent_auto",
        freeTier: capture.freeTier === true,
        notes: [
          capture.notes,
          capture.freeTier === true
            ? "Captured automatically from agent output; agent declared it free/no-card."
            : "Captured automatically from agent output while paid services were allowed."
        ].filter(Boolean).join(" "),
        linkedRequestIds,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };

      await this.storage.saveCredentialSecret(project.record.id, entry.id, {
        apiKey: capture.apiKey,
        secretKey: capture.secretKey
      });
      project.record.credentials.entries = [
        entry,
        ...project.record.credentials.entries.filter((candidate) => candidate.id !== entry.id)
      ];
      for (const request of project.record.credentials.requests) {
        if (linkedRequestIds.includes(request.id) && !request.userInputRequestId) {
          request.status = "fulfilled";
          request.resolvedAt = now;
          request.notes = "Credential was captured automatically from agent output and stored locally.";
        }
      }
      this.recordWorkflowActivity(this.ensureWorkflowState(project.record), {
        source: "system",
        status: "completed",
        title: "Captured free credential locally",
        detail: `${entry.providerName} ${entry.keyLabel}`,
        stepId: getWorkflowActiveStepId(this.ensureWorkflowState(project.record)),
        agentId: agent.id,
        agentCategory: agent.category
      });
    }
  }

  private async finalizeInterfaceCreationFromThread(project: LoadedProject, agent: AgentState): Promise<void> {
    if (!this.transport || !agent.threadId) {
      return;
    }

    const thread = await this.transport.readThread(agent.threadId, true);
    const turns = [...thread.thread.turns].reverse();
    let lastFailure: InterfaceCreationParseFailure | undefined;

    for (const turn of turns) {
      for (const item of [...turn.items].reverse()) {
        if (item.type !== "agentMessage" || !item.text.trim()) {
          continue;
        }

        const result = await this.applyInterfaceCreationOutput(project, agent, item.text, "thread/read");
        if (result.applied) {
          return;
        }
        lastFailure = result.failure ?? lastFailure;
      }
    }

    if (lastFailure && (await this.requestInterfaceCreationRepair(project, agent, lastFailure))) {
      return;
    }

    await this.failInterfaceCreation(
      project,
      agent,
      "Invalid result",
      "The interface-creation agent finished, but its response could not be applied.",
      lastFailure?.message ?? "No structured interface output was returned."
    );
  }

  private async finalizeUltimateGoalDetectionFromThread(project: LoadedProject, agent: AgentState): Promise<void> {
    if (!this.transport || !agent.threadId) {
      return;
    }

    const thread = await this.transport.readThread(agent.threadId, true);
    const turns = [...thread.thread.turns].reverse();
    for (const turn of turns) {
      for (const item of [...turn.items].reverse()) {
        if (item.type !== "agentMessage" || !item.text.trim()) {
          continue;
        }

        if (await this.applyUltimateGoalDetectionOutput(project, agent, item.text)) {
          return;
        }
      }
    }

    agent.status = "completed";
    agent.currentPhase = "Using scaffolded ultimate goal draft";
    await this.saveProject(project);
    this.emitState();
  }

  private async resumeSavedAgents(project: LoadedProject): Promise<void> {
    const interruptedAgents: AgentState[] = [];
    for (const agent of project.record.agents) {
      if (agent.category !== "manual" && isAgentActive(agent)) {
        this.markAgentDisconnected(
          project,
          agent,
          "This agent was still active when the previous app session ended. Continue from the saved workflow state to restart the interrupted step."
        );
        interruptedAgents.push(agent);
        continue;
      }

      if (!agent.threadId) {
        continue;
      }

      if (agent.status === "completed" || agent.status === "failed" || agent.status === "conflicted" || agent.status === "disconnected") {
        continue;
      }

      this.markAgentDisconnected(
        project,
        agent,
        "Saved Codex threads are not resumed automatically on project open. Continue from the saved workflow state to restart the interrupted step."
      );
      interruptedAgents.push(agent);
    }

    let changed = false;
    if (interruptedAgents.length > 0) {
      this.resetWorkflowAfterInterruptedAgents(project, interruptedAgents, { markRecoveryHandled: true });
      changed = true;
    }
    changed = this.reconcileWorkflowResumeState(project) || changed;
    if (changed) {
      await this.saveProject(project);
    }
  }

  private getWorkflowStepIdForAgent(agent: AgentState): "ultimate_goal" | "recommendation" | "goal_plan" | "coding" | "integrity" | "merge" | undefined {
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
  }

  private syncWorkflowStepProgressFromAgent(project: LoadedProject, agent: AgentState): void {
    const stepId = this.getWorkflowStepIdForAgent(agent);
    if (!stepId) {
      return;
    }

    const workflow = this.ensureWorkflowState(project.record);
    if (agent.workflowCycleNumber !== undefined && agent.workflowCycleNumber !== workflow.workflowCycle.cycleNumber) {
      return;
    }
    const sharedPatch = {
      latestProgressNote: agent.lastMessageSnippet ?? agent.currentPhase,
      currentActivity: agent.currentPhase ?? workflow.stepProgress[stepId].currentActivity,
      currentSubstep: agent.currentSubtask ?? workflow.stepProgress[stepId].currentSubstep,
      agentCategory: agent.category,
      warning: agent.disconnectedReason
    };

    if (agent.status === "starting" || agent.status === "running") {
      this.updateWorkflowStepProgress(workflow, stepId, sharedPatch, { status: "running" });
      return;
    }

    if (agent.status === "waiting_approval") {
      this.updateWorkflowStepProgress(workflow, stepId, {
        ...sharedPatch,
        message: "Waiting on an approval request before this step can continue."
      }, { status: "running" });
      return;
    }

    if (agent.status === "completed") {
      if (stepId === "recommendation" && workflow.recommendations.length > 0 && !workflow.approvedRecommendation) {
        this.updateWorkflowStepProgress(workflow, stepId, {
          ...sharedPatch,
          requiresUserInput: true,
          currentActivity: "Waiting for a recommendation choice",
          message: "Choose exactly one recommendation to continue."
        }, { status: "waiting" });
        return;
      }

      if (stepId === "recommendation" && workflow.recommendations.length === 0 && !workflow.approvedRecommendation) {
        this.updateWorkflowStepProgress(workflow, stepId, {
          ...sharedPatch,
          requiresUserInput: false,
          currentActivity: "Applying recommendation output",
          message: "The recommendation output is being applied."
        }, { status: "running" });
        return;
      }

      if (stepId === "ultimate_goal") {
        this.updateWorkflowStepProgress(workflow, stepId, {
          ...sharedPatch,
          requiresUserInput: true,
          currentActivity: "Draft ready for review",
          message: "Review and confirm the detected Ultimate Goal draft."
        }, { status: "waiting" });
        return;
      }

      if (stepId === "goal_plan" && !workflow.scopedGoal) {
        this.updateWorkflowStepProgress(workflow, stepId, {
          ...sharedPatch,
          requiresUserInput: false,
          currentActivity: "Applying scoped goal output",
          message: "The goal plan output is being applied."
        }, { status: "running" });
        return;
      }

      if (stepId === "coding" && workflow.repair.status === "repairing") {
        this.updateWorkflowStepProgress(workflow, stepId, {
          ...sharedPatch,
          requiresUserInput: false,
          currentActivity: "Repair pass complete",
          message: "Retrying validation next."
        }, { status: "completed" });
        return;
      }

      this.updateWorkflowStepProgress(workflow, stepId, {
        ...sharedPatch,
        requiresUserInput: false
      }, { status: "completed" });
      return;
    }

    if (agent.status === "failed" || agent.status === "conflicted" || agent.status === "disconnected") {
      this.updateWorkflowStepProgress(workflow, stepId, {
        ...sharedPatch,
        message: agent.disconnectedReason ?? agent.currentPhase ?? "This step failed.",
        warning: agent.disconnectedReason
      }, { status: "failed" });
    }
  }

  private cancelPendingApprovalsForInterruptedAgent(agent: AgentState): void {
    for (const approval of agent.approvals) {
      if (approval.status === "pending") {
        approval.status = "cancelled";
      }
    }
  }

  private markAgentDisconnected(project: LoadedProject, agent: AgentState, reason: string): void {
    if (agent.threadId) {
      this.threadToAgent.delete(agent.threadId);
      this.interfaceCreationRepairAttempts.delete(agent.threadId);
    }

    this.cancelPendingApprovalsForInterruptedAgent(agent);
    agent.status = "disconnected";
    agent.completedAt = nowIso();
    agent.currentPhase = "Interrupted; recovery available";
    agent.disconnectedReason = reason;
    agent.recoveryHandledAt = undefined;
    reduceAgentRuntimeEvent(agent, {
      kind: "raw",
      title: "Agent interrupted",
      detail: reason
    });
    this.syncWorkflowStepProgressFromAgent(project, agent);
    this.mirrorLatestAgentEventToWorkflow(this.ensureWorkflowState(project.record), agent);
  }

  private markActiveAgentsDisconnected(project: LoadedProject, reason: string): AgentState[] {
    const interruptedAgents = project.record.agents.filter((agent) => agent.category !== "manual" && isAgentActive(agent));
    for (const agent of interruptedAgents) {
      this.markAgentDisconnected(project, agent, reason);
    }
    return interruptedAgents;
  }

  private resetWorkflowAfterInterruptedAgents(
    project: LoadedProject,
    interruptedAgents: AgentState[],
    options: {
      markRecoveryHandled?: boolean;
    } = {}
  ): void {
    if (interruptedAgents.length === 0) {
      return;
    }

    const workflow = this.ensureWorkflowState(project.record);
    const recoveryHandledAt = options.markRecoveryHandled ? nowIso() : undefined;
    const interruptedStepIds = new Set<WorkflowStepId>();
    for (const agent of interruptedAgents) {
      if (recoveryHandledAt) {
        agent.recoveryHandledAt = recoveryHandledAt;
      }
      const stepId = this.getWorkflowStepIdForAgent(agent);
      if (stepId) {
        interruptedStepIds.add(stepId);
      }
    }

    if (interruptedStepIds.has("recommendation")) {
      this.resetWorkflowStepProgress(workflow, "recommendation", {
        status: "waiting",
        requiresUserInput: workflow.recommendations.length > 0 && !workflow.approvedRecommendation,
        currentActivity: workflow.recommendations.length > 0 && !workflow.approvedRecommendation
          ? "Waiting for a recommendation choice"
          : "Queued to regenerate recommendations",
        message: workflow.recommendations.length > 0 && !workflow.approvedRecommendation
          ? "Saved recommendations are still available. Choose one to continue."
          : "Recommendation generation will restart from the saved project state.",
        warning: undefined
      });
    }

    if (interruptedStepIds.has("goal_plan") && workflow.approvedRecommendation && !workflow.scopedGoal) {
      this.resetWorkflowStepProgress(workflow, "goal_plan", {
        status: "waiting",
        requiresUserInput: false,
        currentActivity: "Queued to recreate the scoped plan",
        latestProgressNote: workflow.approvedRecommendation.title,
        message: "The approved recommendation was saved; goal planning will restart from that decision.",
        warning: undefined
      });
      this.resetWorkflowStepProgress(workflow, "coding");
      this.resetWorkflowStepProgress(workflow, "integrity");
      this.resetWorkflowStepProgress(workflow, "merge");
    }

    if (interruptedStepIds.has("coding") && workflow.scopedGoal) {
      this.resetWorkflowStepProgress(workflow, "coding", {
        status: "waiting",
        requiresUserInput: false,
        currentActivity: workflow.repair.status === "repairing" ? "Queued to restart the repair pass" : "Queued to restart coding",
        currentSubstep: workflow.repair.status === "repairing"
          ? `Repair attempt ${workflow.repair.attemptCount} of ${workflow.repair.maxAttempts}`
          : undefined,
        latestProgressNote: workflow.scopedGoal.summary,
        message: "The scoped goal was saved; coding will restart from that plan.",
        warning: undefined
      });
      this.resetWorkflowStepProgress(workflow, "integrity");
      this.resetWorkflowStepProgress(workflow, "merge");
    }

    if (interruptedStepIds.has("integrity") && workflow.scopedGoal) {
      if (workflow.repair.status !== "retrying_validation") {
        this.resetWorkflowRepairState(workflow);
      }
      this.resetWorkflowStepProgress(workflow, "integrity", {
        status: "waiting",
        requiresUserInput: false,
        currentActivity: workflow.repair.status === "retrying_validation"
          ? "Queued to retry validation after repair"
          : "Queued to retry validation",
        currentSubstep: workflow.repair.status === "retrying_validation"
          ? `Validation retry ${workflow.repair.attemptCount} of ${workflow.repair.maxAttempts}`
          : undefined,
        message: "Validation will restart from the saved coding result.",
        warning: undefined
      });
      this.resetWorkflowStepProgress(workflow, "merge");
    }

    if (interruptedStepIds.has("merge")) {
      if (workflow.repair.status === "merge_conflicts") {
        this.resetWorkflowRepairState(workflow);
      }
      this.resetWorkflowStepProgress(workflow, "merge", {
        status: "waiting",
        requiresUserInput: false,
        currentActivity: "Queued to retry integration",
        message: "Merge will restart from the saved validation result.",
        warning: undefined
      });
    }

    this.recordWorkflowActivity(workflow, {
      source: "system",
      status: "waiting",
      title: "Workflow recovery point prepared",
      detail: "Interrupted agents were stopped and the workflow was reset to the last saved decision.",
      stepId: getWorkflowActiveStepId(workflow)
    });
  }

  private transcriptBufferKey(projectId: string, agentId: string, itemId: string): string {
    return `${projectId}:${agentId}:${itemId}`;
  }

  private appendAgentTranscriptEntry(project: LoadedProject, agent: AgentState, entry: AgentTranscriptEntry): void {
    agent.outputReference = {
      agentId: agent.id,
      workflowCycleNumber: agent.workflowCycleNumber,
      transcriptAvailable: true,
      fullOutputAvailable: true,
      updatedAt: nowIso()
    };
    void this.storage.appendAgentTranscriptEntry(project.record.id, agent, entry).catch((error) => {
      this.diagnostics.unshift(
        `Failed to save full output for ${agent.name}. ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }

  private rememberCommandTranscriptStart(project: LoadedProject, agent: AgentState, itemId: string, command: string, cwd?: string): void {
    this.commandOutputBuffers.set(this.transcriptBufferKey(project.record.id, agent.id, itemId), {
      command,
      cwd,
      startedAt: nowIso(),
      output: ""
    });
  }

  private appendCommandTranscriptDelta(project: LoadedProject, agent: AgentState, itemId: string, delta: string): void {
    const key = this.transcriptBufferKey(project.record.id, agent.id, itemId);
    const existing = this.commandOutputBuffers.get(key) ?? {
      startedAt: nowIso(),
      output: ""
    };
    existing.output += delta;
    this.commandOutputBuffers.set(key, existing);
  }

  private flushCommandTranscript(project: LoadedProject, agent: AgentState, itemId: string, status: string, exitCode?: number | null): void {
    const key = this.transcriptBufferKey(project.record.id, agent.id, itemId);
    const existing = this.commandOutputBuffers.get(key);
    if (!existing) {
      return;
    }
    this.commandOutputBuffers.delete(key);
    this.appendAgentTranscriptEntry(project, agent, {
      id: `${agent.id}:command:${itemId}:${Date.now()}`,
      timestamp: nowIso(),
      kind: "command",
      itemId,
      title: existing.command ?? "Command output",
      text: existing.output,
      metadata: {
        status,
        exitCode: exitCode ?? null,
        cwd: existing.cwd ?? null,
        startedAt: existing.startedAt ?? null
      }
    });
  }

  private handleTransportNotification(notification: ServerNotification): void {
    if (this.disposed) {
      return;
    }
    const threadId =
      "params" in notification && notification.params && "threadId" in notification.params
        ? String((notification.params as { threadId?: string }).threadId)
        : undefined;
    if (!threadId) {
      return;
    }

    const mapping = this.threadToAgent.get(threadId);
    if (!mapping) {
      return;
    }

    const project = this.projects.get(mapping.projectId);
    const agent = project?.record.agents.find((entry) => entry.id === mapping.agentId);
    if (!project || !agent) {
      return;
    }

    const previousLifecycle = {
      status: agent.status,
      currentPhase: agent.currentPhase,
      completedAt: agent.completedAt,
      lastMessageSnippet: agent.lastMessageSnippet
    };
    const currentPhase = agent.currentPhase?.toLowerCase() ?? "";
    const writeAgentFinalizationAlreadyStarted =
      isWriteEnabledAgentCategory(agent.category) &&
      (
        currentPhase.startsWith("finalizing ") ||
        currentPhase.includes("worktree changes for merge") ||
        currentPhase.includes("changes ready for merge") ||
        currentPhase.includes("project changes detected") ||
        currentPhase.includes("manual changes applied") ||
        currentPhase.includes("worktree finalization failed") ||
        agent.events.some((event) =>
          event.title === "Worktree checkpoint created" ||
          event.title === "Manual changes applied" ||
          event.title === "Worktree finalization failed"
        )
      );
    const restoreWriteAgentLifecycle = (): void => {
      agent.status = previousLifecycle.status;
      agent.currentPhase = previousLifecycle.currentPhase;
      agent.completedAt = previousLifecycle.completedAt;
      agent.lastMessageSnippet = previousLifecycle.lastMessageSnippet;
    };
    this.recordWorkflowPerfCounter(`app-server event ${notification.method}`, project.record.identity.projectName);
    const shouldMirrorWorkflowActivity = !workflowActivitySuppressedTransportMethods.has(notification.method);
    const shouldPersistProject = !ignoredRendererUpdateMethods.has(notification.method);
    const shouldEmitRendererUpdate = !ignoredRendererUpdateMethods.has(notification.method);
    if (!this.shouldReduceLiveTransportDelta(mapping.projectId, mapping.agentId, notification)) {
      agent.lastActivityAt = nowIso();
      return;
    }

    switch (notification.method) {
      case "thread/tokenUsage/updated":
        agent.lastActivityAt = nowIso();
        break;
      case "turn/plan/updated": {
        const detail = [
          notification.params.explanation ?? undefined,
          ...notification.params.plan.map((step) => `${step.status}: ${step.step}`)
        ].filter((entry): entry is string => Boolean(entry)).join("\n");
        reduceAgentRuntimeEvent(agent, {
          kind: "raw",
          title: "Plan updated",
          detail: compactText(detail, 1_200),
          raw: {
            turnId: notification.params.turnId,
            plan: notification.params.plan.slice(0, 12)
          }
        });
        break;
      }
      case "item/reasoning/summaryPartAdded":
        agent.lastActivityAt = nowIso();
        break;
      case "thread/status/changed":
        reduceAgentRuntimeEvent(agent, {
          kind: "thread-status",
          threadId,
          status: notification.params.status.type
        });
        break;
      case "turn/started":
        reduceAgentRuntimeEvent(agent, {
          kind: "turn-started",
          threadId,
          turnId: notification.params.turn.id
        });
        break;
      case "turn/completed": {
        reduceAgentRuntimeEvent(agent, {
          kind: "turn-completed",
          threadId,
          turnId: notification.params.turn.id,
          status: notification.params.turn.status
        });
        if (writeAgentFinalizationAlreadyStarted) {
          restoreWriteAgentLifecycle();
          break;
        }
        if (
          notification.params.turn.status === "completed" &&
          project.scan.kind === "git" &&
          isWriteEnabledAgentCategory(agent.category)
        ) {
          agent.status = "running";
          agent.currentPhase = agent.category === "manual" ? "Finalizing manual worktree changes" : "Finalizing coding worktree changes";
          void this.finalizeGitWriteAgent(project, agent).catch(() => undefined);
        }
        if (agent.category === "bootstrap" && project.record.interfaceCreation?.status === "running") {
          void this.finalizeInterfaceCreationFromThread(project, agent).catch(() => undefined);
        }
        if (agent.category === "goal" && agent.currentPhase === "Detecting ultimate goal") {
          void this.finalizeUltimateGoalDetectionFromThread(project, agent).catch(() => undefined);
        }
        if (agent.category === "recommendation") {
          void this.finalizeRecommendationFromThread(project, agent, true).catch(() => undefined);
        }
        if (agent.category === "goal" && agent.name === "Goal Agent" && project.record.workflow.approvedRecommendation) {
          void this.finalizeScopedGoalFromThread(project, agent, project.record.workflow.approvedRecommendation, true).catch(() => undefined);
        }
        break;
      }
      case "item/started": {
        const item = notification.params.item;
        if (item.type === "commandExecution") {
          const sanitizedCommand = this.sanitizeTextToProjectBoundary(project, item.command, item.cwd ?? project.record.projectRoot) ?? item.command;
          this.rememberCommandTranscriptStart(project, agent, item.id, sanitizedCommand, item.cwd);
          reduceAgentRuntimeEvent(agent, {
            kind: "item-started",
            threadId,
            itemId: item.id,
            itemType: item.type,
            title: "Command started",
            detail: sanitizedCommand,
            command: sanitizedCommand,
            cwd: item.cwd
          });
        } else if (item.type !== "agentMessage" && item.type !== "plan" && item.type !== "reasoning" && item.type !== "fileChange") {
          reduceAgentRuntimeEvent(agent, {
            kind: "item-started",
            threadId,
            itemId: item.id,
            itemType: item.type,
            title: `${item.type} started`
          });
        }
        break;
      }
      case "item/completed":
        if (notification.params.item.type === "agentMessage") {
          const agentMessageText = notification.params.item.text;
          const redactedMessageText = this.redactAgentCredentialCaptures(agentMessageText) ?? agentMessageText;
          const redactedItem = this.redactAgentCredentialCapturesFromValue(notification.params.item);
          void this.storeAgentCredentialCaptures(project, agent, agentMessageText)
            .then(() => this.persistProjectUpdate(project))
            .catch(() => undefined);
          agent.lastMessageSnippet = redactedMessageText.slice(-240);
          if (agent.category === "bootstrap") {
            void this.applyInterfaceCreationOutput(project, agent, agentMessageText, "item/completed").catch(() => undefined);
          }
          if (agent.category === "goal" && agent.currentPhase === "Detecting ultimate goal") {
            void this.applyUltimateGoalDetectionOutput(project, agent, agentMessageText).catch(() => undefined);
          }
          if (agent.category === "recommendation") {
            void this.applyRecommendationOutput(project, agent, agentMessageText, true, "item/completed").catch(() => undefined);
          }
          if (agent.category === "goal" && agent.name === "Goal Agent" && project.record.workflow.approvedRecommendation) {
            void this.applyScopedGoalOutput(
              project,
              agent,
              project.record.workflow.approvedRecommendation,
              agentMessageText,
              true,
              "item/completed"
            ).catch(() => undefined);
          }
          if (agent.repositorySummaryTarget) {
            void this.applyRepositoryPathSummaryOutput(project, agent, agentMessageText, "item/completed").catch(() => undefined);
          }
          this.appendAgentTranscriptEntry(project, agent, {
            id: `${agent.id}:message:${notification.params.item.id}`,
            timestamp: nowIso(),
            kind: "message",
            itemId: notification.params.item.id,
            title: "Agent output",
            text: this.sanitizeTextToProjectBoundary(project, redactedMessageText) ?? redactedMessageText
          });
          reduceAgentRuntimeEvent(agent, {
            kind: "item-completed",
            threadId,
            itemId: notification.params.item.id,
            itemType: notification.params.item.type,
            title: "Agent message",
            detail: this.sanitizeTextToProjectBoundary(project, redactedMessageText) ?? redactedMessageText,
            raw: redactedItem
          });
        } else if (notification.params.item.type === "commandExecution") {
          const sanitizedCommand = this.sanitizeTextToProjectBoundary(
            project,
            notification.params.item.command,
            notification.params.item.cwd ?? project.record.projectRoot
          ) ?? notification.params.item.command;
          this.flushCommandTranscript(
            project,
            agent,
            notification.params.item.id,
            notification.params.item.status,
            notification.params.item.exitCode
          );
          reduceAgentRuntimeEvent(agent, {
            kind: "item-completed",
            threadId,
            itemId: notification.params.item.id,
            itemType: notification.params.item.type,
            status: notification.params.item.status === "failed" ? "failed" : "completed",
            title: "Command completed",
            detail: sanitizedCommand,
            exitCode: notification.params.item.exitCode,
            raw: notification.params.item
          });
        } else if (notification.params.item.type === "plan") {
          reduceAgentRuntimeEvent(agent, {
            kind: "item-completed",
            threadId,
            itemId: notification.params.item.id,
            itemType: notification.params.item.type,
            title: "Plan completed",
            detail: notification.params.item.text.slice(0, 240),
            raw: notification.params.item
          });
        } else if (notification.params.item.type === "reasoning") {
          reduceAgentRuntimeEvent(agent, {
            kind: "item-completed",
            threadId,
            itemId: notification.params.item.id,
            itemType: notification.params.item.type,
            title: "Reasoning completed",
            detail: notification.params.item.summary.join(" ").slice(0, 240),
            raw: notification.params.item
          });
        } else if (notification.params.item.type === "fileChange") {
          this.mergeAgentChangedFiles(
            project,
            agent,
            notification.params.item.changes.map((change) => change.path)
          );
          reduceAgentRuntimeEvent(agent, {
            kind: "item-completed",
            threadId,
            itemId: notification.params.item.id,
            itemType: notification.params.item.type,
            status: notification.params.item.status === "failed" ? "failed" : "completed",
            title: "File change completed",
            detail: notification.params.item.changes.map((change) => change.path).join(", ").slice(0, 240),
            raw: notification.params.item
          });
        }
        break;
      case "rawResponseItem/completed": {
        const rawResponseText = this.extractTextFromRawResponseItem(notification.params.item);
        const redactedResponseText = this.redactAgentCredentialCaptures(rawResponseText);
        const redactedItem = this.redactAgentCredentialCapturesFromValue(notification.params.item);
        void this.storeAgentCredentialCaptures(project, agent, rawResponseText)
          .then(() => this.persistProjectUpdate(project))
          .catch(() => undefined);
        if (agent.category === "bootstrap" && rawResponseText) {
          void this.applyInterfaceCreationOutput(project, agent, rawResponseText, "rawResponseItem/completed").catch(() => undefined);
        }
        if (agent.category === "goal" && agent.currentPhase === "Detecting ultimate goal" && rawResponseText) {
          void this.applyUltimateGoalDetectionOutput(project, agent, rawResponseText).catch(() => undefined);
        }
        if (agent.category === "recommendation" && rawResponseText) {
          void this.applyRecommendationOutput(project, agent, rawResponseText, true, "rawResponseItem/completed").catch(() => undefined);
        }
        if (agent.category === "goal" && agent.name === "Goal Agent" && rawResponseText && project.record.workflow.approvedRecommendation) {
          void this.applyScopedGoalOutput(
            project,
            agent,
              project.record.workflow.approvedRecommendation,
              rawResponseText,
              true,
              "rawResponseItem/completed"
            ).catch(() => undefined);
        }
        if (agent.repositorySummaryTarget && rawResponseText) {
          void this.applyRepositoryPathSummaryOutput(project, agent, rawResponseText, "rawResponseItem/completed").catch(() => undefined);
        }
        if (rawResponseText) {
          this.appendAgentTranscriptEntry(project, agent, {
            id: `${agent.id}:raw-response:${Date.now()}`,
            timestamp: nowIso(),
            kind: "message",
            title: "Agent output",
            text: this.sanitizeTextToProjectBoundary(project, redactedResponseText ?? rawResponseText) ?? redactedResponseText ?? rawResponseText,
            raw: redactedItem
          });
        }
        reduceAgentRuntimeEvent(agent, {
          kind: "raw",
          title: "rawResponseItem/completed",
          detail: this.sanitizeTextToProjectBoundary(project, redactedResponseText?.slice(0, 240)) ?? redactedResponseText?.slice(0, 240),
          raw: redactedItem
        });
        break;
      }
      case "item/agentMessage/delta":
        reduceAgentRuntimeEvent(agent, {
          kind: "agent-message-delta",
          threadId,
          itemId: notification.params.itemId,
          delta: this.sanitizeTextToProjectBoundary(project, notification.params.delta) ?? notification.params.delta
        });
        break;
      case "item/plan/delta":
        reduceAgentRuntimeEvent(agent, {
          kind: "plan-delta",
          threadId,
          itemId: notification.params.itemId,
          delta: this.sanitizeTextToProjectBoundary(project, notification.params.delta) ?? notification.params.delta
        });
        break;
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        reduceAgentRuntimeEvent(agent, {
          kind: "reasoning-delta",
          threadId,
          itemId: notification.params.itemId,
          delta: this.sanitizeTextToProjectBoundary(project, notification.params.delta) ?? notification.params.delta
        });
        break;
      case "error": {
        const errorMessage =
          [
            typeof notification.params.error.message === "string" ? notification.params.error.message : "",
            "additionalDetails" in notification.params.error && typeof notification.params.error.additionalDetails === "string"
              ? notification.params.error.additionalDetails
              : ""
          ]
            .filter((part) => part.length > 0)
            .join(" ");
        reduceAgentRuntimeEvent(agent, {
          kind: "raw",
          title: "Transport error",
          detail: this.sanitizeTextToProjectBoundary(project, errorMessage) ?? errorMessage,
          raw: notification.params
        });
        if (agent.category === "bootstrap" && project.record.interfaceCreation?.status === "running") {
          void this.failInterfaceCreation(
            project,
            agent,
            "Output schema rejected",
            "Interface creation failed before the model could return a structured result.",
            errorMessage
          ).catch(() => undefined);
        }
        break;
      }
      case "command/exec/outputDelta":
        this.appendCommandTranscriptDelta(
          project,
          agent,
          notification.params.processId,
          this.sanitizeTextToProjectBoundary(
            project,
            Buffer.from(notification.params.deltaBase64, "base64").toString("utf8")
          ) ?? Buffer.from(notification.params.deltaBase64, "base64").toString("utf8")
        );
        reduceAgentRuntimeEvent(agent, {
          kind: "command-output",
          threadId,
          itemId: notification.params.processId,
          delta: this.sanitizeTextToProjectBoundary(
            project,
            Buffer.from(notification.params.deltaBase64, "base64").toString("utf8")
          ) ?? Buffer.from(notification.params.deltaBase64, "base64").toString("utf8")
        });
        break;
      case "item/commandExecution/outputDelta":
        this.appendCommandTranscriptDelta(
          project,
          agent,
          notification.params.itemId,
          this.sanitizeTextToProjectBoundary(project, notification.params.delta) ?? notification.params.delta
        );
        reduceAgentRuntimeEvent(agent, {
          kind: "command-output",
          threadId,
          itemId: notification.params.itemId,
          delta: this.sanitizeTextToProjectBoundary(project, notification.params.delta) ?? notification.params.delta
        });
        break;
      case "item/commandExecution/terminalInteraction":
        reduceAgentRuntimeEvent(agent, {
          kind: "terminal-input",
          threadId,
          itemId: notification.params.itemId,
          input: this.sanitizeTextToProjectBoundary(project, notification.params.stdin) ?? notification.params.stdin
        });
        break;
      case "item/fileChange/outputDelta":
        reduceAgentRuntimeEvent(agent, {
          kind: "file-change",
          threadId,
          itemId: notification.params.itemId,
          delta: this.sanitizeTextToProjectBoundary(project, notification.params.delta) ?? notification.params.delta
        });
        break;
      default:
        reduceAgentRuntimeEvent(agent, {
          kind: "raw",
          title: notification.method,
          raw: notification
        });
        break;
    }

    if (writeAgentFinalizationAlreadyStarted) {
      restoreWriteAgentLifecycle();
    }
    if (shouldPersistProject || shouldEmitRendererUpdate || shouldMirrorWorkflowActivity) {
      this.syncWorkflowStepProgressFromAgent(project, agent);
      if (shouldMirrorWorkflowActivity) {
        this.mirrorLatestAgentEventToWorkflow(this.ensureWorkflowState(project.record), agent);
      }
    }
    if (shouldPersistProject) {
      if (immediateTransportFlushMethods.has(notification.method)) {
        this.flushProjectSaveNow(project, notification.method);
      } else {
        this.scheduleProjectSave(project, { syncWorkflow: false });
      }
    }
    if (shouldEmitRendererUpdate) {
      if (immediateTransportFlushMethods.has(notification.method)) {
        this.emitStateNow(notification.method);
      } else {
        this.emitState();
      }
    }
    if (workflowAutomationTriggerMethods.has(notification.method)) {
      this.scheduleWorkflowAutomation(project.record.id);
    }
  }

  private handleTransportRequest(request: ServerRequest): void {
    void this.processTransportRequest(request);
  }

  private async processTransportRequest(request: ServerRequest): Promise<void> {
    const threadId =
      "params" in request && request.params && "threadId" in request.params ? String((request.params as { threadId?: string }).threadId) : undefined;
    if (!threadId) {
      return;
    }
    const mapping = this.threadToAgent.get(threadId);
    if (!mapping) {
      return;
    }

    const project = this.projects.get(mapping.projectId);
    const agent = project?.record.agents.find((entry) => entry.id === mapping.agentId);
    if (!project || !agent) {
      return;
    }

    if (request.method === "item/tool/requestUserInput") {
      const existingRequest = project.record.userInputRequests.find((entry) => entry.serverRequestId === request.id && entry.status === "pending");
      if (existingRequest) {
        return;
      }

      const normalizedQuestions = this.normalizeUserInputRequestQuestions(project, request.params.questions);
      if (
        this.looksLikeCredentialRequest(normalizedQuestions) &&
        !this.settings.considerPaidServices &&
        this.looksLikePaidCredentialRequest(normalizedQuestions)
      ) {
        const answer = [
          "Paid API services are disabled in Codex Agent Workbench settings.",
          "Use a free/no-card provider, no-key/open-data source, demo/mock mode, or request only a free-tier credential."
        ].join(" ");
        if (this.transport) {
          await this.transport.respond(request.id, { answers: normalizedQuestions.map(() => answer) });
        }
        agent.currentPhase = "Rejected paid credential request";
        agent.lastActivityAt = nowIso();
        agent.lastMessageSnippet = answer;
        reduceAgentRuntimeEvent(agent, {
          kind: "raw",
          title: "Paid credential request rejected",
          detail: answer
        });
        this.recordWorkflowActivity(this.ensureWorkflowState(project.record), {
          source: "system",
          status: "waiting",
          title: "Paid credential request rejected",
          detail: "The agent was told to use a free provider, no-key source, or demo/mock mode because Consider Paid Services is off.",
          stepId: getWorkflowActiveStepId(this.ensureWorkflowState(project.record)),
          agentId: agent.id,
          agentCategory: agent.category
        });
        this.mirrorLatestAgentEventToWorkflow(this.ensureWorkflowState(project.record), agent);
        await this.persistProjectUpdate(project, true);
        return;
      }
      const requestId = nanoid();
      const isCredentialRequest = this.looksLikeCredentialRequest(normalizedQuestions);
      const userInputRequest: UserInputRequestRecord = {
        id: requestId,
        agentId: agent.id,
        requestedByAgentCategory: agent.category,
        threadId: request.params.threadId,
        turnId: request.params.turnId,
        itemId: request.params.itemId,
        serverRequestId: request.id,
        title: this.buildUserInputRequestTitle(normalizedQuestions),
        description: this.buildUserInputRequestDescription(normalizedQuestions),
        questions: normalizedQuestions,
        attachmentInboxPath: this.getUserInputRequestInboxPath(project, requestId),
        attachmentInboxRelativePath: this.getUserInputRequestInboxRelativePath(requestId),
        attachments: [],
        status: "pending",
        createdAt: nowIso()
      };
      await mkdir(this.resolveUserInputRequestInboxHostPath(project, requestId), { recursive: true });

      const intervention = await this.createHumanInterventionRecord(project, {
        kind: isCredentialRequest ? "credentials" : "external_setup",
        title: userInputRequest.title,
        description: userInputRequest.description,
        reason: isCredentialRequest
          ? this.settings.considerPaidServices
            ? "The agent paused for an API credential. Store it in Credentials, then explicitly send it to the waiting agent if you want it used."
            : "The agent paused for an API credential. Only provide a free/no-card key; otherwise dismiss it and let the agent use a free provider or demo mode."
          : "The agent paused and needs your external setup or answers before it can continue.",
        requestedByAgentCategory: agent.category,
        severity: isCredentialRequest ? "high" : "medium",
        blocking: true,
        linkedUserInputRequestId: requestId
      }, { persist: false });
      userInputRequest.humanInterventionId = intervention.id;
      this.addCredentialRequestForUserInput(project, agent, userInputRequest, intervention);
      project.record.userInputRequests.unshift(userInputRequest);

      agent.currentPhase = "Waiting for external input";
      agent.lastActivityAt = nowIso();
      agent.lastMessageSnippet = userInputRequest.description.slice(0, 240);
      reduceAgentRuntimeEvent(agent, {
        kind: "raw",
        title: "User input requested",
        detail: userInputRequest.title,
        raw: request
      });
      this.mirrorLatestAgentEventToWorkflow(this.ensureWorkflowState(project.record), agent);
      await this.persistProjectUpdate(project);
      return;
    }

    const baseApproval: ApprovalRequestRecord = {
      id: nanoid(),
      agentId: agent.id,
      kind: "apply-patch",
      threadId,
      turnId: undefined,
      itemId: undefined,
      serverRequestId: request.id,
      summary: "Patch approval requested",
      reason: undefined,
      command: undefined,
      cwd: undefined,
      filePaths: [],
      createdAt: nowIso(),
      status: "pending",
      availableDecisions: ["accept", "acceptForSession", "decline", "cancel"]
    };

    let approval = baseApproval;
    switch (request.method) {
      case "item/commandExecution/requestApproval":
        approval = {
          ...baseApproval,
          kind: "command",
          turnId: request.params.turnId,
          itemId: request.params.itemId,
          summary: request.params.command ?? "Command approval requested",
          reason: request.params.reason ?? undefined,
          command: request.params.command ?? undefined,
          cwd: request.params.cwd ?? undefined
        };
        break;
      case "item/fileChange/requestApproval":
        approval = {
          ...baseApproval,
          kind: "file-change",
          turnId: request.params.turnId,
          itemId: request.params.itemId,
          summary: request.params.reason ?? "File change approval requested",
          reason: request.params.reason ?? undefined,
          filePaths: request.params.grantRoot ? [request.params.grantRoot] : []
        };
        break;
      case "item/permissions/requestApproval":
        approval = {
          ...baseApproval,
          kind: "permissions",
          turnId: request.params.turnId,
          itemId: request.params.itemId,
          summary: request.params.reason ?? "Permission approval requested",
          reason: request.params.reason ?? undefined
        };
        break;
      case "applyPatchApproval":
      case "execCommandApproval":
      default:
        approval = baseApproval;
        break;
    }

    const approvalForChecks = approval;

    let unsafeReason: string | undefined;
    try {
      if (request.method === "item/permissions/requestApproval") {
        unsafeReason = "Permission escalation outside the active project folder is not allowed.";
      }

      if (!unsafeReason && approvalForChecks.cwd) {
        await assertExecutionPathWithinProjectRoot(
          project.record.projectRoot,
          approvalForChecks.cwd,
          project.record.hostPath,
          this.getRuntimeSettings(project.record.distroName),
          project.record.distroName,
          "Command approval"
        );
      }

      if (!unsafeReason && approvalForChecks.command) {
        const referencedOutsidePath = this.textReferencesOutsideProject(
          project,
          approvalForChecks.command,
          approvalForChecks.cwd ?? project.record.projectRoot
        );
        if (referencedOutsidePath) {
          unsafeReason = `Command approval was rejected because it referenced a path outside the active project folder: ${referencedOutsidePath}`;
        }
      }

      if (!unsafeReason) {
        for (const filePath of approvalForChecks.filePaths) {
          await assertExecutionPathWithinProjectRoot(
            project.record.projectRoot,
            filePath,
            project.record.hostPath,
            this.getRuntimeSettings(project.record.distroName),
            project.record.distroName,
            "File change approval"
          );
        }
      }
    } catch (error) {
      unsafeReason = error instanceof Error ? error.message : String(error);
    }

    approval = {
      ...approval,
      summary: this.sanitizeTextToProjectBoundary(project, approval.summary, approvalForChecks.cwd ?? project.record.projectRoot) ?? approval.summary,
      reason: this.sanitizeTextToProjectBoundary(project, approval.reason, approvalForChecks.cwd ?? project.record.projectRoot),
      command: this.sanitizeTextToProjectBoundary(project, approval.command, approvalForChecks.cwd ?? project.record.projectRoot),
      cwd: this.sanitizeTextToProjectBoundary(project, approval.cwd, approvalForChecks.cwd ?? project.record.projectRoot),
      filePaths: approval.filePaths.map((filePath) => this.sanitizeTextToProjectBoundary(project, filePath, approvalForChecks.cwd ?? project.record.projectRoot) ?? filePath)
    };

    if (unsafeReason) {
      approval.status = "rejected";
      approval.reason = this.sanitizeTextToProjectBoundary(project, unsafeReason, approval.cwd ?? project.record.projectRoot) ?? unsafeReason;
      approval.summary = "Blocked by project boundary";
      agent.approvals.unshift(approval);
      reduceAgentRuntimeEvent(agent, {
        kind: "raw",
        title: "Unsafe approval blocked",
        detail: approval.reason,
        raw: request
      });
      this.mirrorLatestAgentEventToWorkflow(this.ensureWorkflowState(project.record), agent);
      if (this.transport) {
        await this.transport.respond(request.id, { decision: "decline" });
      }
      await this.persistProjectUpdate(project);
      return;
    }

    if (shouldAutoApproveApproval(approval, this.settings)) {
      reduceAgentRuntimeEvent(agent, {
        kind: "approval-request",
        approval
      });
      if (this.transport) {
        await this.transport.respond(request.id, { decision: "accept" });
      }
      reduceAgentRuntimeEvent(agent, {
        kind: "approval-resolved",
        approvalId: approval.id,
        decision: "accept"
      });
      this.mirrorLatestAgentEventToWorkflow(this.ensureWorkflowState(project.record), agent);
      await this.persistProjectUpdate(project, true);
      return;
    }

    reduceAgentRuntimeEvent(agent, {
      kind: "approval-request",
      approval
    });
    this.mirrorLatestAgentEventToWorkflow(this.ensureWorkflowState(project.record), agent);
    await this.persistProjectUpdate(project);
  }
}
