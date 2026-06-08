import { EventEmitter } from "node:events";
import { access, copyFile, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import type { ServerNotification, ServerRequest } from "@generated/app-server";
import type { JsonValue } from "@generated/app-server/serde_json/JsonValue";
import type { SandboxPolicy, ToolRequestUserInputQuestion } from "@generated/app-server/v2";
import { APP_VERSION, PORTABLE_INTERFACE_PATH, USER_INPUT_REQUESTS_PATH } from "@shared/constants";
import { createAgentSkeleton, createLocalProjectRecord, defaultLocalState, defaultProjectCredentialsState, defaultProjectWorkflowState, defaultSettings, defaultWorkflowAppealState } from "@shared/defaults";
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
  portableInterfaceSchema,
  scopedGoalSchema,
  ultimateGoalSchema,
  workflowRecommendationOptionSchema
} from "@shared/schemas";
import { SummaryCache } from "@shared/summaryCache";
import type {
  AgentCategory,
  AgentHistoryScope,
  AgentReasoningMode,
  AgentState,
  AgentListResponse,
  ApprovedRecommendation,
  AppSettings,
  AutopilotPauseReason,
  AutopilotPolicy,
  ApprovalDecision,
  ApprovalRequestRecord,
  CodexAvailability,
  CredentialEntryMetadata,
  CredentialEntryStatus,
  CredentialRequestRecord,
  CredentialRequestStatus,
  DiscoveredModel,
  GitHubStatus,
  GoalAttainmentCheck,
  HumanInterventionRecord,
  InterfaceCandidate,
  InterfaceReasoningEffort,
  LoadedProjectView,
  LocalProjectRecord,
  OpenProjectShellResult,
  ProjectAccessProbe,
  ProjectLogFeedResponse,
  ProjectRepositoryView,
  ProjectWorkflowState,
  ProjectLoadResult,
  RepoTreeNode,
  ScopedGoal,
  UserInputRequestQuestion,
  UserInputRequestRecord,
  UltimateGoalImportPreview,
  UltimateGoalProgressEstimate,
  UltimateGoal,
  ValidationStatus,
  WorkflowMode,
  WorkflowStepId,
  WorkPackage,
  WorkbenchState
} from "@shared/types";
import { nowIso } from "@shared/utils";
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
  isPreviewRecommendation,
  latestAgentByCategory,
  normalizeWorkflowPreviewRequest,
  pickAutopilotRecommendation,
  resolveEffectiveAutopilotPolicy,
  shouldAutopilotPause,
  validateAutopilotPolicy,
  workPackageRequiresModelScoping
} from "@shared/workflow";
import { buildDeterministicFileSummary, buildDeterministicOverview } from "./fileSummary";
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
  readGitMetadata
} from "./git";
import { shouldAutoApproveApproval } from "./approvalPolicy";
import { CodexAppServerTransport, type CodexTransport } from "./codexTransport";
import {
  GENERATED_CODEX_APP_SERVER_PROTOCOL_VERSION,
  assessCodexProtocolCompatibility,
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
import { buildDiscoveredModels, getRecommendedInterfaceCreationModel } from "./modelCatalog";
import { MockCodexTransport } from "./mockCodexTransport";
import { createProjectIdentity } from "./projectIdentity";
import {
  assertExecutionPathWithinProjectRoot,
  assertHostPathWithinProjectRoot,
  assertProjectRelativeHostPath,
  resolveExecutionPathWithinProjectRoot
} from "./projectBoundary";
import { hasMeaningfulRepositoryContent, scanRepository, type GitMetadata, type RepoScanResult } from "./repoScanner";
import { compactRuntimeEventRecord, reduceAgentRuntimeEvent } from "./runtimeEvents";
import { WorkbenchStorage, type CredentialSecretInput, type SecretStorageCodec } from "./storage";
import { sanitizeWorkflowState } from "./stateSanitizer";
import { readUltimateGoalTextImport } from "./ultimateGoalImport";
import { buildProjectShellHandoffPrompt, openProjectShellWindow } from "./projectShell";
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

type InterfaceCreationParseFailure = Exclude<InterfaceCreationParseResult, { ok: true }>;
type ProjectSaveMode = "immediate" | "deferred" | false;
type StateEmitMode = "immediate" | "coalesced" | false;
type PersistProjectUpdateOptions = {
  save?: ProjectSaveMode;
  emit?: StateEmitMode;
  automate?: boolean;
  reason?: string;
};
type WorkflowAutomationTimer = {
  timer: ReturnType<typeof setTimeout>;
  generation: number;
};
type StructuredOutputKind = "recommendation" | "scoped_goal";
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
const STATE_EMIT_THROTTLE_MS = 350;
const LIVE_PROJECT_SAVE_THROTTLE_MS = 100;
const LIVE_DELTA_REDUCE_THROTTLE_MS = 1_500;
const WORKFLOW_AUTOMATION_SCHEDULE_DELAY_MS = 25;
const WORKFLOW_AUTOMATION_NO_PROGRESS_LIMIT = 2;
const WORKFLOW_AUTOMATION_HARD_ACTION_LIMIT = 20;
const STRUCTURED_OUTPUT_HISTORY_LIMIT = 24;
const WSL_WINDOWS_MOUNT_PATH = /^\/mnt\/[a-z](?:\/|$)/i;
const liveTransportUpdateMethods = new Set<string>([
  "thread/tokenUsage/updated",
  "turn/plan/updated",
  "rawResponseItem/completed",
  "item/reasoning/summaryPartAdded",
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "command/exec/outputDelta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta"
]);
const throttledTransportDeltaMethods = new Set<string>([
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "command/exec/outputDelta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta"
]);
const workflowActivitySuppressedTransportMethods = new Set<string>([
  "thread/tokenUsage/updated",
  "turn/plan/updated",
  "rawResponseItem/completed",
  "item/reasoning/summaryPartAdded",
  ...[...throttledTransportDeltaMethods].filter((method) => method !== "item/agentMessage/delta")
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

const compactText = (value: string, maxLength: number): string => {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxLength - 24)).trimEnd()}...[truncated]`;
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
      language: node.language
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
  private readonly diagnostics: string[] = [];
  private readonly interfaceCreationRepairAttempts = new Map<string, number>();
  private readonly workflowAutomationInFlight = new Set<string>();
  private readonly workflowAutomationQueued = new Set<string>();
  private readonly workflowAutomationTimers = new Map<string, WorkflowAutomationTimer>();
  private readonly workflowAutomationGenerations = new Map<string, number>();
  private readonly workflowRecoveryInFlight = new Set<string>();
  private readonly liveDeltaLastReducedAt = new Map<string, number>();
  private pendingStateEmitTimer?: ReturnType<typeof setTimeout>;
  private readonly pendingProjectSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly projectSaveFingerprints = new Map<string, string>();
  private readonly projectSaveInFlight = new Map<string, Promise<void>>();
  private readonly projectSaveQueued = new Map<string, Promise<void>>();
  private readonly registeredProjectIds = new Set<string>();
  private readonly structuredOutputApplicationsInFlight = new Set<string>();
  private suppressTransportExitHandling = false;
  private transportInitialization?: Promise<void>;
  private disposed = false;
  private disposePromise?: Promise<void>;
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
    if (now - counter.lastLoggedAt >= 1_000) {
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
    if (notification.method === "item/agentMessage/delta") {
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

  private scheduleProjectSave(project: LoadedProject): void {
    if (this.disposed) {
      return;
    }
    const projectId = project.record.id;
    this.recordWorkflowPerfCounter("project save schedules", project.record.identity.projectName);
    if (this.pendingProjectSaveTimers.has(projectId)) {
      return;
    }

    const timer = setTimeout(() => {
      this.pendingProjectSaveTimers.delete(projectId);
      void this.saveProject(project).catch((error) => {
        this.diagnostics.unshift(
          `Failed to save live project state for ${project.record.identity.projectName}. ${error instanceof Error ? error.message : String(error)}`
        );
      });
    }, LIVE_PROJECT_SAVE_THROTTLE_MS);
    timer.unref?.();
    this.pendingProjectSaveTimers.set(projectId, timer);
  }

  private flushProjectSaveNow(project: LoadedProject, reason: string): void {
    if (this.disposed) {
      return;
    }
    const projectId = project.record.id;
    const timer = this.pendingProjectSaveTimers.get(projectId);
    if (timer) {
      clearTimeout(timer);
      this.pendingProjectSaveTimers.delete(projectId);
    }
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
      const timer = this.pendingProjectSaveTimers.get(projectId);
      if (timer) {
        clearTimeout(timer);
        this.pendingProjectSaveTimers.delete(projectId);
      }
      const project = this.projects.get(projectId);
      if (project) {
        await this.saveProject(project, { force });
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
      const stepId = workflow.scopedGoal
        ? workflow.stepProgress.integrity.status === "running" || workflow.stepProgress.integrity.status === "failed"
          ? "integrity"
          : "coding"
        : workflow.approvedRecommendation
          ? "goal_plan"
          : hasConfirmedUltimateGoal(workflow.ultimateGoal)
            ? "recommendation"
            : "ultimate_goal";
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
      ? pickAutopilotRecommendation(workflow.recommendations, workflow)
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
    this.refreshWorkflowTaskMap(project, timestamp);
    this.recordWorkflowActivity(workflow, {
      source: "workflow",
      status: "completed",
      title: "Goal check marked met",
      detail: targetCheck.title,
      stepId: "merge"
    });
  }

  private refreshWorkflowTaskMap(project: LoadedProject, timestamp = nowIso()): void {
    const workflow = this.ensureWorkflowState(project.record);
    const context = this.buildWorkflowRecommendationContext(project);
    workflow.taskMap = buildChecklistTaskMap(context, timestamp);
    workflow.workPackages = buildChecklistWorkPackages(context);
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
    this.markCompletedCycleGoalCheckEvidence(project, completedAt);
    this.refreshUltimateGoalAssessment(project, completedAt);
    this.markWorkflowPreviewReady(project, completedAt);
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
      this.logWorkflowPerf(`automation not scheduled for ${project?.record.identity.projectName ?? projectId}: ${reason}`);
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

  private getNextAutomationActionForProject(project: LoadedProject): ReturnType<typeof getNextWorkflowAutomationAction> {
    const workflow = this.ensureWorkflowState(project.record);
    return getNextWorkflowAutomationAction(
      workflow,
      project.record.agents,
      project.scan.kind,
      resolveEffectiveAutopilotPolicy(workflow, project.record.localState.autopilotEnabled),
      project.record.localState.workflowPauseRequested,
      project.record.localState.workflowObjective
    );
  }

  private shouldScheduleWorkflowAutomation(project: LoadedProject): boolean {
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
      ? pickAutopilotRecommendation(workflow.recommendations, workflow)
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
        const autopilotPolicy = resolveEffectiveAutopilotPolicy(workflow, project.record.localState.autopilotEnabled);
        const maxActionsThisPass = Math.min(autopilotPolicy.maxAutomaticActionsPerPass, WORKFLOW_AUTOMATION_HARD_ACTION_LIMIT);
        if (automaticActionsThisPass >= maxActionsThisPass) {
          this.updateAutopilotRuntimeStatus(project);
          await this.persistProjectUpdate(project, {
            save: "immediate",
            emit: "coalesced",
            reason: "workflow automation action limit"
          });
          break;
        }
        if (
          autopilotPolicy.maxConsecutiveCycles !== undefined &&
          completedCyclesThisPass >= autopilotPolicy.maxConsecutiveCycles
        ) {
          project.record.localState.workflowPauseRequested = true;
          const pause = {
            reason: "max_consecutive_cycles" as const,
            detail: `Autopilot reached the ${autopilotPolicy.maxConsecutiveCycles} cycle policy checkpoint.`,
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
        const action = getNextWorkflowAutomationAction(
          workflow,
          project.record.agents,
          project.scan.kind,
          autopilotPolicy,
          project.record.localState.workflowPauseRequested,
          project.record.localState.workflowObjective
        );
        const recommendation = action === "approve_recommendation"
          ? pickAutopilotRecommendation(workflow.recommendations, workflow)
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
              save: "immediate",
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
      agent.category !== "manual" &&
      isAgentActive(agent) &&
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

  private compactRendererProjectRecord(record: LocalProjectRecord, options?: { inactive?: boolean }): LocalProjectRecord {
    if (options?.inactive) {
      const workflow = sanitizeWorkflowState(record.workflow, undefined, { renderer: true });
      return {
        ...record,
        agents: [],
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
          recommendations: [],
          goalChecklist: [],
          activityLog: [],
          memory: {
            ...record.workflow.memory,
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
      dependencies: record.dependencies.slice(0, 80),
      summaryCache: record.summaryCache.slice(0, 80),
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
    return {
      settings: this.settings,
      github: this.githubStatus,
      projects: [...this.projects.values()].map((project) => this.toRendererLoadedProjectView(project)),
      activeProjectId: this.activeProjectId,
      availableModels: this.availableModels,
      codexAvailability: this.codexAvailability,
      diagnostics: [...this.diagnostics]
    };
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
      diagnostics: [...this.diagnostics]
    };
  }

  async initialize(): Promise<void> {
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

    await this.refreshGitHubStatus(false);
    if (this.settings.mockMode) {
      await this.initializeTransport();
    } else {
      this.codexAvailability = {
        source: "unavailable",
        message: "Codex app-server will start when an agent-backed action runs."
      };
    }

    const records = await this.storage.loadAllProjects();
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

    this.emitState();
  }

  private async updateCodexCliOnStartup(): Promise<void> {
    if (this.settings.mockMode) {
      return;
    }

    const result = await updateCodexCliIfAvailable(this.settings, process.platform, {
      supportedProtocolVersion: GENERATED_CODEX_APP_SERVER_PROTOCOL_VERSION
    });
    if (result.status === "updated") {
      this.diagnostics.unshift(result.message);
      return;
    }
    if (result.status === "skipped") {
      this.diagnostics.unshift(result.message);
      return;
    }
    if (result.status === "failed") {
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
    if (this.pendingStateEmitTimer) {
      clearTimeout(this.pendingStateEmitTimer);
      this.pendingStateEmitTimer = undefined;
    }
    if (options?.flush === false) {
      for (const timer of this.pendingProjectSaveTimers.values()) {
        clearTimeout(timer);
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
        this.diagnostics.unshift(compatibility.message);
        return;
      }

      const launchPlan = await CodexAppServerTransport.resolveLaunchPlan(this.settings);
      this.transport = new CodexAppServerTransport(this.settings, launchPlan);
      this.attachTransportListeners(this.transport);
      await this.transport.initialize();
      this.availableModels = buildDiscoveredModels((await this.transport.listModels()).data);
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
    const scan = await scanRepository(projectHostPath, gitMetadata, projectRoot);
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

  getRepositoryView(projectId: string): ProjectRepositoryView {
    const project = this.findProject(projectId);
    return {
      projectId,
      tree: project.tree,
      dependencies: project.record.dependencies,
      summaryCache: project.record.summaryCache
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

  async loadProject(inputPath: string, intent: "open" | "create" = "open"): Promise<ProjectLoadResult> {
    const resolvedPath = resolveProjectPath(inputPath, this.settings);
    this.assertResolvedPathCompatible(resolvedPath.distroName);
    const runtimeSettings = this.getRuntimeSettings(resolvedPath.distroName);
    let gitMetadata = await readGitMetadata(resolvedPath.wslPath, runtimeSettings);

    const hasGitHubRemote = gitMetadata.normalizedRemotes.some(isGitHubRemote);
    if (!hasGitHubRemote) {
      if (intent !== "create") {
        this.assertGitHubLinked();
        throw new Error("This platform only opens GitHub-backed repositories. Use Create New Workspace to initialize a folder as a GitHub SSH repository.");
      }

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
    } else {
      this.assertGitHubLinked();
    }

    const projectRoot = gitMetadata.gitRoot ?? resolvedPath.wslPath;
    const projectHostPath = gitMetadata.gitRoot
      ? executionPathToHostPath(gitMetadata.gitRoot, runtimeSettings, resolvedPath.distroName)
      : resolvedPath.hostPath;
    const scan = await scanRepository(projectHostPath, gitMetadata, projectRoot);
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
      dependencies: result.dependencies.slice(0, 80),
      tree: compactRepoTreePreview(result.tree)
    };
  }

  showLauncher(): void {
    this.activeProjectId = undefined;
    this.emitState();
  }

  async openProject(projectId: string): Promise<LoadedProjectView> {
    this.assertGitHubLinked();
    const existing = this.findProject(projectId);
    this.assertResolvedPathCompatible(existing.record.distroName);
    const runtimeSettings = this.getRuntimeSettings(existing.record.distroName);
    const gitMetadata = await readGitMetadata(existing.record.projectRoot, runtimeSettings);
    if (!gitMetadata.normalizedRemotes.some(isGitHubRemote)) {
      throw new Error("This saved workspace no longer points at a GitHub-backed repository.");
    }
    const projectRoot = gitMetadata.gitRoot ?? existing.record.projectRoot;
    const projectHostPath = gitMetadata.gitRoot
      ? executionPathToHostPath(gitMetadata.gitRoot, runtimeSettings, existing.record.distroName)
      : existing.record.hostPath;
    const scan = await scanRepository(projectHostPath, gitMetadata, projectRoot);
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
    await this.saveProject(project);
    this.activeProjectId = projectId;
    await this.resumeSavedAgents(project);
    this.emitState();
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

    const localProjects = await this.storage.loadAllProjects();
    for (const storedProject of localProjects.filter((entry) => entry.identity.fingerprint === identity.fingerprint && this.hasMeaningfulInterfaceContent(entry))) {
      const project = this.normalizeStoredProjectRecord(storedProject);
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
    await this.saveProject(project);
    this.activeProjectId = projectId;
    if (source !== "fresh") {
      await this.resumeSavedAgents(project);
    }
    this.emitState();
    void this.runBootstrapIfNeeded(project);
    if (this.shouldScheduleWorkflowAutomation(project)) {
      this.scheduleWorkflowAutomation(projectId);
    }
    return this.toRendererLoadedProjectView(project);
  }

  private async saveProject(project: LoadedProject, options?: { force?: boolean }): Promise<void> {
    if (this.disposed && !options?.force) {
      return;
    }
    const projectId = project.record.id;
    const inFlight = this.projectSaveInFlight.get(projectId);
    if (inFlight) {
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
          this.projectSaveQueued.delete(projectId);
          await this.saveProject(project, options);
        });
      this.projectSaveQueued.set(projectId, queuedPromise);
      await queuedPromise;
      return;
    }

    const savePromise = this.writeProjectToStorage(project).finally(() => {
      if (this.projectSaveInFlight.get(projectId) === savePromise) {
        this.projectSaveInFlight.delete(projectId);
      }
    });
    this.projectSaveInFlight.set(projectId, savePromise);
    await savePromise;
  }

  private async writeProjectToStorage(project: LoadedProject): Promise<void> {
    const startedAt = performance.now();
    let payloadSize: number | undefined;
    this.compactProjectRuntimeHistory(project);
    for (const agent of project.record.agents) {
      this.recordAgentContextDescriptor(project, agent);
    }
    const syncStartedAt = performance.now();
    this.syncWorkflowState(project);
    this.logWorkflowPerf(`syncWorkflowState before save ${project.record.identity.projectName}: ${Math.round(performance.now() - syncStartedAt)}ms`);
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
        output: entry.output.length > 12_000 ? entry.output.slice(-12_000) : entry.output
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
    if (destinationPath) {
      const resolvedDestinationPath = path.isAbsolute(destinationPath)
        ? destinationPath
        : path.join(project.record.hostPath, destinationPath);
      await assertHostPathWithinProjectRoot(project.record.hostPath, resolvedDestinationPath, "Portable interface export");
    }
    const exportPath = await this.storage.writePortableInterface(project.record.hostPath, project.record, destinationPath);
    project.record.interfacePath = exportPath;
    await this.persistProjectUpdate(project, {
      save: "immediate",
      emit: "coalesced",
      reason: "interface exported"
    });
    return exportPath;
  }

  async downloadInterface(projectId: string, destinationPath: string): Promise<string> {
    const project = this.findProject(projectId);
    return await this.storage.writePortableInterfaceToFile(project.record, destinationPath);
  }

  async downloadLogs(projectId: string, destinationPath: string): Promise<string> {
    const project = this.findProject(projectId);
    return await this.storage.writeReviewLogBundleToFile(project.record, this.settings, this.diagnostics, destinationPath);
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
        (await scanRepository(
          loadResult.projectHostPath,
          await readGitMetadata(loadResult.projectRoot, this.getRuntimeSettings(loadResult.resolvedPath.distroName)),
          loadResult.projectRoot
        )),
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
    await this.saveProject(project);
    this.emitState();
    return status;
  }

  async getFileSummary(projectId: string, relativePath: string) {
    const project = this.findProject(projectId);
    const file = project.scan.files.find((entry) => entry.relativePath === relativePath);
    if (!file) {
      throw new Error(`Unknown file: ${relativePath}`);
    }

    const safeFilePath = await assertProjectRelativeHostPath(project.record.hostPath, file.relativePath, "File summary read");
    const contentHash = sha256(await (await import("node:fs/promises")).readFile(safeFilePath, "utf8"));
    const cached = project.summaryCache.get(relativePath, contentHash);
    if (cached) {
      return cached;
    }

    const siblings = project.scan.files
      .filter((entry) => path.dirname(entry.relativePath) === path.dirname(relativePath) && entry.relativePath !== relativePath)
      .map((entry) => entry.relativePath);
    const summary = fileSummarySchema.parse(await buildDeterministicFileSummary(project.record.hostPath, file, siblings));
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
      agent.category !== "manual" &&
      (!categorySet || categorySet.has(agent.category)) &&
      isAgentActive(agent)
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
    const nextPauseRequested = project.record.localState.workflowPauseRequested;
    if (partial.workflowPauseRequested !== undefined && previousPauseRequested !== nextPauseRequested) {
      if (!nextPauseRequested) {
        this.completeWorkflowPreviewCheckpoint(project, "Workflow resumed after preview inspection");
        this.reconcileWorkflowResumeState(project);
      }
      this.recordWorkflowActivity(workflow, {
        source: "workflow",
        status: nextPauseRequested ? "waiting" : "running",
        title: nextPauseRequested ? "Automation pause requested" : "Workflow automation resumed",
        detail: nextPauseRequested
          ? "The current workflow agent can finish, but no new automatic step will start until you continue."
          : "Automatic workflow progression can start again.",
        stepId: getWorkflowActiveStepId(workflow)
      });
    }
    if (!projectMutation) {
      return;
    }

    await this.saveProject(project);
    this.emitState();
    if (
      partial.autopilotEnabled !== undefined ||
      partial.workflowObjective !== undefined ||
      (partial.workflowPauseRequested !== undefined && !nextPauseRequested)
    ) {
      this.scheduleWorkflowAutomation(projectId);
    }
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
        status: project.record.agents.some((agent) => agent.category !== "manual" && isAgentActive(agent))
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
    const hasActiveWorkflowAgent = project.record.agents.some((agent) => agent.category !== "manual" && isAgentActive(agent));
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
    const hasActiveWorkflowAgent = project.record.agents.some((agent) => agent.category !== "manual" && isAgentActive(agent));
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
    const workflow = this.ensureWorkflowState(project.record);
    const modeConfig = getWorkflowModeConfig(workflow.workflowMode, resolveEffectiveAutopilotPolicy(workflow, project.record.localState.autopilotEnabled));
    for (const parsed of this.extractJsonObjects(rawText).reverse()) {
      if (typeof parsed.summary !== "string" || !Array.isArray(parsed.recommendations)) {
        continue;
      }

      try {
        const ultimateGoalProgress = this.parseRecommendationProgress((parsed as { ultimateGoalProgress?: unknown }).ultimateGoalProgress);
        const ultimateGoalCompletion = this.parseRecommendationCompletionAssessment(
          (parsed as { ultimateGoalCompletion?: unknown }).ultimateGoalCompletion
        );
        const goalCheckUpdatesPayload = (parsed as { goalCheckUpdates?: unknown }).goalCheckUpdates;
        if (!ultimateGoalProgress || !ultimateGoalCompletion) {
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
      } catch {
        // Try the next complete object in the message.
      }
    }

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
    const appealPassQueued = this.shouldQueueAppealPass(recommendationContext, checklistGoalCompletion) && effectiveRecommendations.length > 0;
    const normalizedProgressEstimate = checklistGoalCompletion.state === "goal_satisfied"
      ? {
        ...checklistProgressEstimate,
        percentComplete: 100
      }
      : checklistProgressEstimate;
    workflow.recommendations = effectiveRecommendations;
    workflow.recommendationsGeneratedAt = generatedAt;
    workflow.ultimateGoalProgress = {
      ...normalizedProgressEstimate,
      updatedAt: generatedAt
    };
    workflow.ultimateGoalCompletion = {
      ...checklistGoalCompletion,
      updatedAt: generatedAt
    };
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
        nextSteps: effectiveRecommendations.map((recommendation) => ({
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
    if (effectiveRecommendations.length > 0) {
      this.recordWorkflowActivity(workflow, {
        source: "workflow",
        status: "waiting",
        title: appealPassQueued ? "Appeal recommendations are ready" : "Recommendations are ready",
        detail: effectiveRecommendations[0]?.title ?? "Choose one recommendation to continue.",
        stepId: "recommendation"
      });
      this.updateWorkflowStepProgress(workflow, "recommendation", {
        requiresUserInput: true,
        currentActivity: appealPassQueued ? "Waiting for the final appeal choice" : "Waiting for a recommendation choice",
        currentSubstep: effectiveRecommendations[0]
          ? `Recommended next cycle target: ${effectiveRecommendations[0].title}`
          : undefined,
        latestProgressNote: effectiveRecommendations[0]?.title ?? "Recommendations are ready.",
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
    if (agent) {
      agent.currentPhase = "Used fallback recommendations";
      agent.lastMessageSnippet = "Structured recommendation output was invalid, so the workflow used the deterministic fallback.";
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
      reduceAgentRuntimeEvent(agent, {
        kind: "raw",
        title: "Recommendation output rejected",
        detail: rawText.slice(0, 240),
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
      return false;
    }

    try {
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
    const outcomeStrategyBrief = buildOutcomeStrategyBrief(this.buildWorkflowRecommendationContext(project), {
      maxOpenChecks: 4,
      maxFocusPaths: 4
    });
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
    workflow.scopedGoal = boundedScopedGoal;
    workflow.workflowCycle = {
      ...workflow.workflowCycle,
      scopedGoalSummary: boundedScopedGoal.summary,
      acceptanceCriteria: boundedScopedGoal.acceptanceCriteria,
      status: "goal_ready"
    };
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
    workflow.workflowCycle = {
      ...workflow.workflowCycle,
      approvedRecommendationId: recommendation.id,
      approvedRecommendationTitle: recommendation.title,
      scopedGoalSummary: undefined,
      acceptanceCriteria: [],
      startedAt: workflow.workflowCycle.startedAt ?? nowIso(),
      completedAt: undefined,
      status: "recommendation_approved"
    };
    this.updateWorkflowStepProgress(workflow, "recommendation", {
      requiresUserInput: false,
      currentActivity: decisionSource === "autopilot" ? "Autopilot approved the next step" : "Recommendation approved",
      latestProgressNote: recommendation.title,
      message: decisionSource === "autopilot"
        ? "Autopilot chose the highest-impact checklist-aligned recommendation and is preparing the scoped execution plan."
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
    this.recordAcceptedDecision(workflow, {
      kind: "recommendation",
      title: recommendation.title,
      summary: recommendation.summary,
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

    if (!this.transport || this.codexAvailability.source === "unavailable") {
      await this.applyFallbackScopedGoal(project, approvedRecommendation, undefined, automate);
      return project.record.workflow.scopedGoal;
    }

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

  async retryWorkflowGoal(projectId: string): Promise<void> {
    const project = this.findProject(projectId);
    const workflow = this.ensureWorkflowState(project.record);

    this.cancelScheduledWorkflowAutomation(projectId);
    project.record.localState.workflowPauseRequested = false;
    if (workflow.repair.status === "merge_conflicts" || workflow.manualHandoff?.reason === "merge_conflicts") {
      const latestFailureReason =
        workflow.manualHandoff?.latestFailureReason ??
        workflow.repair.latestFailureReason ??
        "Deterministic merge reported conflicts.";
      this.resetWorkflowStepProgress(workflow, "merge", {
        status: "waiting",
        requiresUserInput: false,
        currentActivity: "Checking resolved integration worktree",
        latestProgressNote: latestFailureReason,
        message: "Merge retry will use a resolved conflict worktree when one is ready, otherwise it will rerun integration.",
        warning: undefined
      });
      this.recordWorkflowActivity(workflow, {
        source: "workflow",
        status: "waiting",
        title: "Manual merge retry requested",
        detail: latestFailureReason,
        stepId: "merge"
      });
      this.syncWorkflowState(project);
      await this.persistProjectUpdate(project);

      if (await this.tryFinalizeResolvedMergeConflictWorktree(project)) {
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
      await this.persistProjectUpdate(project);
      await this.runMerge(projectId, true);
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
      await this.persistProjectUpdate(project, true);
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
      save: "immediate",
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
      if (!this.transport || this.codexAvailability.source === "unavailable") {
        const transportStartedAt = performance.now();
        await this.initializeTransport();
        this.logWorkflowPerf(`app-server/session startup ${Math.round(performance.now() - transportStartedAt)}ms`);
      }

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
    }
  ): Promise<AgentState> {
    const launchThread = options?.launchThread !== false;
    if (launchThread) {
      this.assertGitHubLinked();
    }
    if (launchThread && (!this.transport || this.codexAvailability.source === "unavailable")) {
      await this.initializeTransport();
    }
    if (launchThread && (!this.transport || this.codexAvailability.source === "unavailable")) {
      throw new Error("Codex app-server is unavailable, so agent creation is currently disabled.");
    }

    const project = this.findProject(projectId);
    const accessProbe = project.record.validation.projectAccess;
    if (isWriteEnabledAgentCategory(category) && accessProbe?.status === "failed") {
      throw new Error(
        accessProbe.error
          ? `Write-enabled agents are blocked until project access is fixed. ${accessProbe.error}`
          : "Write-enabled agents are blocked until the project access check succeeds."
      );
    }

    if (project.scan.kind === "folder" && isWriteEnabledAgentCategory(category)) {
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
    agent.status = launchThread ? "starting" : "running";
    agent.startedAt = launchThread ? undefined : nowIso();
    agent.currentPhase = options?.initialPhase ?? (category === "manual" ? "Handling manual request" : undefined);
    this.assertResolvedPathCompatible(project.record.distroName);
    const runtimeSettings = this.getRuntimeSettings(project.record.distroName);

    if (isWriteEnabledAgentCategory(category) && project.scan.kind === "git") {
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
    await this.persistProjectUpdate(project);

    if (!launchThread) {
      return agent;
    }

    await this.startAgentThread(project, agent, {
      sandbox: options?.sandbox ?? (isWriteEnabledAgentCategory(category) ? "workspace-write" : "read-only"),
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
      experimentalRawEvents: false,
      persistExtendedHistory: true
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
      !this.isEnvironmentRepairFailureReason(workflow.repair.latestFailureReason)
    ) {
      return false;
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

  async runIntegrity(projectId: string, automate = false): Promise<void> {
    const project = this.findProject(projectId);
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

    const commands = await this.detectVerificationCommands(project.record.hostPath, project.scan.kind);
    const validationRuntimePathDirs = await this.resolveValidationRuntimePathDirs(project);
    const checks: Array<{
      name: string;
      command: string;
      status: "passed" | "failed" | "skipped";
      outputSnippet: string;
    }> = [];
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
        currentActivity: "Running deterministic validation",
        currentSubstep: command.name,
        latestProgressNote: command.command,
        message: `Running ${command.command}`
      }, { status: "running" });
      await this.persistProjectUpdate(project);
      const result = await runner.runShellCommand({
        command: command.command,
        cwd,
        runtimePathDirs: validationRuntimePathDirs
      });
      this.recordWorkflowActivity(workflow, {
        source: "validation",
        status: result.exitCode === 0 ? "completed" : "failed",
        title: `${command.name} ${result.exitCode === 0 ? "passed" : "failed"}`,
        detail: command.command,
        stepId: "integrity",
        agentId: agent.id,
        agentCategory: "integrity"
      });
      checks.push({
        name: command.name,
        command: command.command,
        status: result.exitCode === 0 ? "passed" : "failed",
        outputSnippet: `${result.stdout}\n${result.stderr}`.trim().slice(0, 500)
      });
    }

    const contextualRisks = [
      !workflow.scopedGoal?.summary.trim() ? "No scoped goal was defined before integrity validation." : undefined,
      !workflow.ultimateGoal.confirmedAt ? "The ultimate goal is not confirmed, so integrity cannot validate final alignment confidently." : undefined
    ].filter((entry): entry is string => Boolean(entry));
    const commandRisks = checks.filter((check) => check.status === "failed").map((check) => `Investigate failing command: ${check.command}`);
    const risks = [...contextualRisks, ...commandRisks];
    const passed = checks.every((check) => check.status === "passed") && risks.length === 0;

    agent.integrityReport = {
      summary: passed
        ? "Deterministic integrity checks passed and the current scoped goal remains aligned with the project charter."
        : "One or more deterministic integrity checks or workflow-alignment checks failed.",
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
    await this.persistProjectUpdate(project, {
      save: "immediate",
      emit: "coalesced",
      automate: automate || (passed && !retryingExternalEnvironmentValidation) || workflow.repair.status === "repairing",
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
    } catch (error) {
      this.diagnostics.unshift(
        `${operation} updated the opened checkout on ${appliedBranch}, but the project overview refresh failed. ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return appliedBranch;
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

    const appliedCheckoutBranch = await this.applyGitBranchToProjectCheckout(
      project,
      mergeAgent.worktree.branch,
      "Merge conflict retry"
    );
    const workflow = this.ensureWorkflowState(project.record);
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

    this.resetWorkflowRepairState(workflow);
    this.resolveWorkflowOpenIssues(workflow, (issue) => issue.source === "merge");
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
    await this.persistProjectUpdate(project, true);
    return true;
  }

  async runMerge(projectId: string, automate = false): Promise<void> {
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
    await this.persistProjectUpdate(project);

    const mergeModel = this.getDefaultAgentModel();
    const mergeAgent = await this.createAgent(
      projectId,
      "merge",
      "Merge Agent",
      "Integrate validated work deterministically.",
      mergeModel,
      { launchThread: false }
    );

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
    mergeAgent.status = mergeResult.conflicts.length === 0 ? "completed" : "conflicted";
    mergeAgent.completedAt = nowIso();
    if (mergeResult.conflicts.length > 0) {
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
      try {
        appliedCheckoutBranch = integrationBranch
          ? await this.applyGitBranchToProjectCheckout(project, integrationBranch, "Merge finalization")
          : undefined;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        mergeAgent.mergeReport.summary = `Merged cleanly in the integration worktree, but the opened checkout was not updated. ${detail}`;
        mergeAgent.status = "failed";
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
      this.resolveWorkflowOpenIssues(workflow, (issue) => issue.source === "merge");
      workflow.workflowCycle.status = "merged";
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
      await this.cleanupCompletedManagedWorktrees(project, this.getRetiredMergeWorktreePaths(project, mergeAgent.id));
    }
    this.syncWorkflowState(project);
    await this.persistProjectUpdate(project, {
      save: "immediate",
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

    if (!this.transport || this.codexAvailability.source === "unavailable") {
      await this.applyFallbackRecommendations(project, undefined, automate, normalizedCustomFocus);
      return;
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

    if (!this.transport || this.codexAvailability.source === "unavailable") {
      await this.initializeTransport();
    }

    if (!this.transport || !bootstrapAgent.model || this.availableModels.length === 0 || this.codexAvailability.source === "unavailable") {
      bootstrapAgent.status = "failed";
      bootstrapAgent.currentPhase = "Codex unavailable";
      project.record.overview = buildDeterministicOverview({
        projectName: project.record.identity.projectName,
        explanation: project.scan.stats.explanation,
        entryPoints: project.scan.stats.entryPoints,
        manifestFiles: project.scan.stats.manifestFiles,
        primaryManagers: project.scan.stats.primaryManagers
      });
      project.record.interfaceCreation.status = "failed";
      project.record.interfaceCreation.phase = "Codex unavailable";
      project.record.interfaceCreation.message =
        "Codex model access is unavailable. The interface is showing deterministic scan data only.";
      project.record.interfaceCreation.lastError = this.codexAvailability.message ?? "Model discovery failed.";
      project.record.interfaceCreation.completedAt = nowIso();
      project.record.interfaceCreation.outputSource = "deterministic";
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
        this.scheduleProjectSave(project);
      }
    }
    if (shouldEmitRendererUpdate) {
      if (immediateTransportFlushMethods.has(notification.method)) {
        this.emitStateNow(notification.method);
      } else {
        this.emitState();
      }
    }
    if (!liveTransportUpdateMethods.has(notification.method)) {
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
