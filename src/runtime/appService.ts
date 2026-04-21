import { EventEmitter } from "node:events";
import { access, copyFile, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import type { ServerNotification, ServerRequest } from "@generated/app-server";
import type { JsonValue } from "@generated/app-server/serde_json/JsonValue";
import type { SandboxPolicy, ToolRequestUserInputQuestion } from "@generated/app-server/v2";
import { APP_VERSION, PORTABLE_INTERFACE_PATH, USER_INPUT_REQUESTS_PATH } from "@shared/constants";
import { createAgentSkeleton, createLocalProjectRecord, defaultProjectWorkflowState, defaultSettings, defaultWorkflowAppealState } from "@shared/defaults";
import { agentRoles } from "@shared/agentRoles";
import { resolveInterfaceCreationReasoningEffort } from "@shared/modelConfig";
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
  AgentState,
  ApprovedRecommendation,
  AppSettings,
  ApprovalDecision,
  ApprovalRequestRecord,
  CodexAvailability,
  DiscoveredModel,
  GitHubStatus,
  GoalAttainmentCheck,
  HumanInterventionRecord,
  InterfaceCandidate,
  LoadedProjectView,
  LocalProjectRecord,
  OpenProjectShellResult,
  ProjectAccessProbe,
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
  WorkflowStepId,
  WorkbenchState
} from "@shared/types";
import { nowIso } from "@shared/utils";
import { calculateValidationStatus } from "@shared/validation";
import {
  createScopedGoalFromRecommendation,
  deriveWorkflowProjection,
  ensureWorkflowStepProgressState,
  getWorkflowActiveStepId,
  getNextWorkflowAutomationAction,
  hasConfirmedUltimateGoal,
  hasMeaningfulUltimateGoal,
  latestAgentByCategory,
  pickAutopilotRecommendation
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
import { reduceAgentRuntimeEvent } from "./runtimeEvents";
import { WorkbenchStorage } from "./storage";
import { readUltimateGoalTextImport } from "./ultimateGoalImport";
import { buildProjectShellHandoffPrompt, openProjectShellWindow } from "./projectShell";
import {
  assessUltimateGoalCompletion,
  applyGoalChecklistUpdates,
  buildAppealRecommendations,
  buildGoalChecklistForAssessment,
  buildGoalChecklistFromUltimateGoal,
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

const writeEnabledAgentCategories = new Set<AgentCategory>(["coding", "manual"]);
const isWriteEnabledAgentCategory = (category: AgentCategory): boolean => writeEnabledAgentCategories.has(category);
const activeAgentStatuses = new Set<AgentState["status"]>(["starting", "running", "waiting_approval"]);
const isAgentActive = (agent: AgentState): boolean => activeAgentStatuses.has(agent.status);
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
  private pendingStateEmitTimer?: ReturnType<typeof setTimeout>;
  private suppressTransportExitHandling = false;

  constructor(private readonly appDataDir: string) {
    super();
    this.storage = new WorkbenchStorage(appDataDir);
  }

  private emitState(): void {
    if (this.pendingStateEmitTimer) {
      return;
    }

    this.pendingStateEmitTimer = setTimeout(() => {
      this.pendingStateEmitTimer = undefined;
      this.emit("stateChanged", this.getState());
    }, 16);
    this.pendingStateEmitTimer.unref?.();
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
      userInputRequests: record.userInputRequests ?? [],
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
    workflow.memory = {
      ...defaults.memory,
      ...workflow.memory,
      perCycleSummaries: workflow.memory?.perCycleSummaries ?? defaults.memory.perCycleSummaries,
      lastAcceptedDecisions: workflow.memory?.lastAcceptedDecisions ?? defaults.memory.lastAcceptedDecisions,
      knownOpenIssues: workflow.memory?.knownOpenIssues ?? defaults.memory.knownOpenIssues,
      agentFreshness: {
        ...defaults.memory.agentFreshness,
        ...workflow.memory?.agentFreshness
      }
    };
    workflow.humanInterventions ??= [];
    workflow.recommendations ??= [];
    workflow.activityLog ??= [];
    workflow.goalChecklist = hasMeaningfulUltimateGoal(workflow.ultimateGoal)
      ? buildGoalChecklistFromUltimateGoal(workflow.ultimateGoal, workflow.goalChecklist ?? [])
      : workflow.goalChecklist ?? [];
    record.userInputRequests ??= [];
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
    workflow.activityLog.unshift({
      id: nanoid(),
      timestamp: nowIso(),
      ...entry
    });
    if (workflow.activityLog.length > 400) {
      workflow.activityLog.length = 400;
    }
  }

  private mirrorLatestAgentEventToWorkflow(workflow: ProjectWorkflowState, agent: AgentState): void {
    const latestEvent = agent.events[0];
    if (!latestEvent) {
      return;
    }

    const previous = workflow.activityLog[0];
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
    this.refreshWorkflowMemory(workflow);
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
      { timestamp }
    );
    this.recordWorkflowActivity(workflow, {
      source: "workflow",
      status: "completed",
      title: "Goal check marked met",
      detail: targetCheck.title,
      stepId: "merge"
    });
  }

  private refreshUltimateGoalAssessment(project: LoadedProject, timestamp = nowIso()): void {
    const workflow = this.ensureWorkflowState(project.record);
    workflow.goalChecklist = buildGoalChecklistForAssessment({
      workflow,
      agents: project.record.agents
    }, timestamp);
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
      if (workflow.stepProgress[stepId].status !== "running" || this.hasActiveWorkflowAgentForStep(project, stepId)) {
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

  private async persistProjectUpdate(project: LoadedProject, automate = false): Promise<void> {
    await this.saveProject(project);
    this.emitState();
    if (automate) {
      this.scheduleWorkflowAutomation(project.record.id);
    }
  }

  private scheduleWorkflowAutomation(projectId: string): void {
    if (this.workflowAutomationInFlight.has(projectId)) {
      this.workflowAutomationQueued.add(projectId);
      return;
    }

    const timer = setTimeout(() => {
      void this.runWorkflowAutomation(projectId);
    }, 0);
    timer.unref?.();
  }

  private async runWorkflowAutomation(projectId: string): Promise<void> {
    if (this.workflowAutomationInFlight.has(projectId)) {
      this.workflowAutomationQueued.add(projectId);
      return;
    }

    this.workflowAutomationInFlight.add(projectId);
    try {
      for (let guard = 0; guard < 12; guard += 1) {
        const project = this.projects.get(projectId);
        if (!project) {
          return;
        }

        this.syncWorkflowState(project);
        const workflow = this.ensureWorkflowState(project.record);
        const action = getNextWorkflowAutomationAction(
          workflow,
          project.record.agents,
          project.scan.kind,
          project.record.localState.autopilotEnabled,
          project.record.localState.workflowPauseRequested,
          project.record.localState.workflowObjective
        );
        if (!action) {
          break;
        }

        switch (action) {
          case "generate_recommendations":
            await this.runRecommendation(projectId, true);
            break;
          case "approve_recommendation": {
            const recommendation = pickAutopilotRecommendation(workflow.recommendations, workflow);
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
            await this.persistProjectUpdate(project, true);
            break;
          }
        }

        // Yield between automatic steps so UI state transitions remain observable
        // and pause requests can take effect before the next step starts.
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } catch (error) {
      this.diagnostics.unshift(
        `Workflow automation paused. ${error instanceof Error ? error.message : String(error)}`
      );
      this.emitState();
    } finally {
      this.workflowAutomationInFlight.delete(projectId);
      if (this.workflowAutomationQueued.delete(projectId)) {
        this.scheduleWorkflowAutomation(projectId);
      }
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
        summary: { type: "string" },
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
      "",
      `Project: ${project.record.identity.projectName}`,
      `Overview: ${project.record.overview?.summary ?? project.scan.stats.explanation}`,
      `Entry points: ${project.scan.stats.entryPoints.slice(0, 6).join(", ") || "None detected"}`,
      `Primary managers: ${project.scan.stats.primaryManagers.join(", ") || "None detected"}`
    ].join("\n");
  }

  private extractJsonObject(rawText: string): Record<string, unknown> | undefined {
    const candidate = rawText.trim();
    const objectStart = candidate.indexOf("{");
    const objectEnd = candidate.lastIndexOf("}");
    if (objectStart === -1 || objectEnd === -1 || objectEnd <= objectStart) {
      return undefined;
    }

    try {
      return JSON.parse(candidate.slice(objectStart, objectEnd + 1)) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  private buildRestrictedSandboxPolicy(
    project: LoadedProject,
    sandbox: "workspace-write" | "read-only"
  ): SandboxPolicy {
    const readableRoots = [project.record.projectRoot];
    if (sandbox === "read-only") {
      return {
        type: "readOnly",
        access: {
          type: "restricted",
          includePlatformDefaults: true,
          readableRoots
        },
        networkAccess: false
      };
    }

    return {
      type: "workspaceWrite",
      writableRoots: [project.record.projectRoot],
      readOnlyAccess: {
        type: "restricted",
        includePlatformDefaults: true,
        readableRoots
      },
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
    const parsed = this.extractJsonObject(rawText);
    if (!parsed) {
      return undefined;
    }

    try {
      return ultimateGoalSchema.parse({
        ...parsed,
        source: "detected",
        confirmedAt: undefined,
        lastUpdatedAt: nowIso()
      });
    } catch {
      return undefined;
    }
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
    agent.reasoningEffort = this.resolveReasoningEffortForModel(agent.model);
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
    await this.storage.ensureBaseDirs();
    const persistedSettings = await this.storage.loadSettings();
    if (persistedSettings) {
      this.settings = {
        ...this.settings,
        ...persistedSettings
      };
    }

    await this.refreshGitHubStatus(false);
    await this.initializeTransport();

    const records = await this.storage.loadAllProjects();
    for (const storedRecord of records) {
      const record = this.normalizeStoredProjectRecord(storedRecord);
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
      this.syncWorkflowState(project);
      this.projects.set(record.id, project);
    }

    this.emitState();
  }

  async dispose(): Promise<void> {
    this.threadToAgent.clear();
    this.interfaceCreationRepairAttempts.clear();
    if (this.pendingStateEmitTimer) {
      clearTimeout(this.pendingStateEmitTimer);
      this.pendingStateEmitTimer = undefined;
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
    if (this.settings.mockMode) {
      this.transport = new MockCodexTransport();
      this.attachTransportListeners(this.transport);
      await this.transport.initialize();
      this.availableModels = buildDiscoveredModels((await this.transport.listModels()).data);
      this.codexAvailability = { source: "mock", message: "Mock mode is enabled, so interface creation uses mock model metadata and outputs." };
      return;
    }

    try {
      const launchPlan = await CodexAppServerTransport.resolveLaunchPlan(this.settings);
      this.transport = new CodexAppServerTransport(this.settings, launchPlan);
      this.attachTransportListeners(this.transport);
      await this.transport.initialize();
      this.availableModels = buildDiscoveredModels((await this.transport.listModels()).data);
      this.codexAvailability = { source: "live" };
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
    const nextSettings = {
      ...this.settings,
      ...partial,
      interfaceCreationConfiguredAt:
        partial.interfaceCreationModel !== undefined ||
        partial.interfaceCreationReasoningEffort !== undefined
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
    const modelChanged = previousSettings.interfaceCreationModel !== nextSettings.interfaceCreationModel;
    if (repairLimitChanged || reasoningChanged || modelChanged) {
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

  private toLoadedProjectView(project: LoadedProject): LoadedProjectView {
    return {
      record: project.record,
      tree: project.tree,
      validationStatus: project.record.validation.lastValidatedAt ? "exact" : "unvalidated",
      candidates: project.candidates
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

    return result;
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
    void this.runBootstrapIfNeeded(project);
    this.scheduleWorkflowAutomation(projectId);
    return this.toLoadedProjectView(project);
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

  private resolveInterfaceCreationConfig(): {
    model?: string;
    reasoningEffort?: "low" | "medium" | "high" | "xhigh";
    source: "user" | "recommended";
  } {
    const selectedModel = this.resolveInterfaceCreationModel();
    const modelRecord = this.availableModels.find((entry) => entry.model === selectedModel.model);
    return {
      ...selectedModel,
      reasoningEffort: resolveInterfaceCreationReasoningEffort(modelRecord, this.settings.interfaceCreationReasoningEffort)
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
      (workflow.workflowStopReason !== "repair_budget_exhausted" && workflow.manualHandoff?.reason !== "repair_exhausted") ||
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
    this.scheduleWorkflowAutomation(projectId);
    return this.toLoadedProjectView(project);
  }

  private async saveProject(project: LoadedProject): Promise<void> {
    this.syncWorkflowState(project);
    project.record.summaryCache = project.summaryCache.list();
    await this.storage.saveProject(project.record);
    const registry = await this.storage.loadRegistry();
    if (!registry.includes(project.record.id)) {
      registry.push(project.record.id);
      await this.storage.saveRegistry(registry);
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
    await this.persistProjectUpdate(project);
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

  async updateLayout(projectId: string, partial: Partial<LocalProjectRecord["layout"]>): Promise<void> {
    const project = this.findProject(projectId);
    project.record.layout = {
      ...project.record.layout,
      ...partial
    };
    await this.saveProject(project);
    this.emitState();
  }

  async updateUiState(projectId: string, partial: Partial<LocalProjectRecord["localState"]>): Promise<void> {
    const project = this.findProject(projectId);
    const previousPauseRequested = project.record.localState.workflowPauseRequested;
    project.record.localState = {
      ...project.record.localState,
      ...partial,
      lastOpenedAt: nowIso()
    };
    const nextPauseRequested = project.record.localState.workflowPauseRequested;
    if (partial.workflowPauseRequested !== undefined && previousPauseRequested !== nextPauseRequested) {
      if (!nextPauseRequested) {
        this.reconcileWorkflowResumeState(project);
      }
      const workflow = this.ensureWorkflowState(project.record);
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
    await this.saveProject(project);
    this.emitState();
    if (
      partial.autopilotEnabled ||
      partial.workflowObjective !== undefined ||
      (partial.workflowPauseRequested !== undefined && !nextPauseRequested)
    ) {
      this.scheduleWorkflowAutomation(projectId);
    }
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
    await this.persistProjectUpdate(project, confirm);
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
            rationale: { type: "string" }
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
            rationale: { type: "string" }
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
              title: { type: "string" },
              summary: { type: "string" },
              rationale: { type: "string" },
              expectedImpact: { type: "string" },
              priority: { type: "string", enum: ["high", "medium", "low"] },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              estimatedScope: { type: "string", enum: ["small", "medium", "large"] },
              riskLevel: { type: "string", enum: ["low", "medium", "high"] },
              relatedPaths: {
                type: "array",
                items: { type: "string" }
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
              "status",
              "confidence",
              "evidence",
              "relatedPaths"
            ],
            properties: {
              action: { type: ["string", "null"], enum: ["add", "update", "remove", null] },
              id: { type: ["string", "null"] },
              title: { type: "string" },
              description: { type: ["string", "null"] },
              required: { type: ["boolean", "null"] },
              status: { type: "string", enum: ["unknown", "unmet", "met", "not_applicable"] },
              confidence: { type: ["number", "null"], minimum: 0, maximum: 1 },
              evidence: { type: "string" },
              relatedPaths: {
                type: "array",
                items: { type: "string" }
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
    return context.objective === "deliver" &&
      goalCompletion.state === "goal_satisfied" &&
      context.workflow.appeal.status !== "completed" &&
      context.workflow.appeal.status !== "not_applicable" &&
      isVisualProject(context);
  }

  private buildRecommendationPrompt(project: LoadedProject, customFocus?: string): string {
    const workflow = this.ensureWorkflowState(project.record);
    const workflowObjective = project.record.localState.workflowObjective;
    const recommendationContext = this.buildWorkflowRecommendationContext(project, customFocus);
    const appealPassPending =
      workflowObjective === "deliver" &&
      workflow.ultimateGoalCompletion?.state === "goal_satisfied" &&
      workflow.appeal.status !== "completed" &&
      workflow.appeal.status !== "not_applicable" &&
      isVisualProject(recommendationContext);
    const openIssues = workflow.memory.knownOpenIssues
      .filter((issue) => issue.status === "open")
      .slice(0, 5)
      .map((issue) => `- ${issue.title}: ${issue.detail}`);
    const recentActivity = workflow.activityLog
      .slice(0, 8)
      .map((event) => `- [${event.source}] ${event.title}${event.detail ? `: ${event.detail}` : ""}`);
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
    const goalChecklist = buildGoalChecklistForAssessment(recommendationContext)
      .filter((check) => check.required)
      .slice(0, 24)
      .map((check) =>
        `- [${check.status}] ${check.title}${check.evidence ? ` -- ${check.evidence}` : ""}`
      );

    return [
      workflowObjective === "optimize"
        ? "Inspect the active project and recommend the next bounded optimization tasks for the workflow."
        : appealPassPending
          ? "Inspect the active project and recommend the final bounded appeal pass for the workflow."
        : "Inspect the active project and recommend the next bounded tasks for the workflow.",
      workflowObjective === "optimize"
        ? "The project is in optimize mode. Treat the current product as a working baseline and look for the next small improvement in correctness, UX, aesthetics for visual surfaces, performance/resource use, maintainability, or test coverage."
        : appealPassPending
          ? "The base Ultimate Goal appears satisfied and this looks like an app, website, platform, or other visual experience. Return one to three small recommendations focused on visual appeal, user-facing polish, clarity, responsive behavior, or interaction quality. This is a final appeal pass before deliver-goal mode stops."
        : "First decide whether the Ultimate Goal is already satisfied strongly enough that the workflow should stop opening new cycles. If it is, mark the goal as satisfied and return zero recommendations.",
      workflowObjective === "optimize"
        ? "Return 1 to 5 recommendations."
        : appealPassPending
          ? "Return 1 to 3 recommendations for the final appeal pass."
        : "Return 0 to 5 recommendations.",
      "Every recommendation must be a small, concrete, single-cycle task. Break work down. Do not propose a large rewrite, a broad audit, or multiple unrelated actions in one recommendation.",
      "Prefer recommendations that are easy for a coding agent to execute and for an integrity agent to verify in one cycle.",
      "When any required Goal checklist item is unmet or unknown, rank direct work on those checklist items ahead of generic stabilization, package-script cleanup, operator-feedback tweaks, or recently changed file follow-up unless there is an explicit open blocker.",
      "For checklist work, recommend the option that can most directly move one required check from unmet/unknown to met with repository evidence. Avoid claiming a feature check is satisfied through unrelated harness or package-only work.",
      "Default to small scope. Only use medium scope when the task is still clearly doable by one coding agent in one pass.",
      "Do not recommend end-to-end milestones, phase-wide deliverables, or umbrella workflows.",
      "Maintain the Goal checklist. You may add a required check, mark a check unmet/unknown if evidence shows it is not actually done, or mark a check met only when repository evidence or validation output supports it.",
      "Do not mark the Ultimate Goal satisfied unless every required Goal checklist item is met and no open blockers remain. Accepted decisions, completed cycles, and passing tests for a small slice are not enough by themselves.",
      "Return goalCheckUpdates as an array every time, even when it is empty. Return one update for every checklist status you add or change. Each met check must include concrete evidence.",
      "Estimate completion from required Goal checklist items only: percentComplete is met required checks divided by total required checks.",
      workflowObjective === "optimize"
        ? "If the Ultimate Goal already looks satisfied, say so in the goal-completion assessment and still recommend the next bounded improvement instead of stopping."
        : appealPassPending
          ? "Keep the goal-completion assessment set to goal_satisfied, but do not return an empty recommendations array for this appeal pass."
        : "If the Ultimate Goal is satisfied, set the goal-completion assessment to goal_satisfied and leave the recommendations array empty.",
      "Use only relative project paths in relatedPaths.",
      customFocus
        ? "Stay tightly anchored to the custom recommendation focus from the operator. Reword it into bounded alternatives and closely related next steps instead of drifting into unrelated repo work."
        : "",
      "",
      `Project: ${project.record.identity.projectName}`,
      `Project kind: ${project.scan.kind}`,
      `Workflow objective: ${workflowObjective === "optimize"
        ? "Optimize the current project after the base goal is working."
        : appealPassPending
          ? "Run one final appeal pass before stopping because the base goal is satisfied."
          : "Stop once the stated Ultimate Goal is satisfied."}`,
      `Ultimate Goal: ${workflow.ultimateGoal.summary}`,
      customFocus ? `Custom recommendation focus from the operator: ${customFocus}` : "",
      workflow.ultimateGoal.detailedIntent ? `Detailed intent: ${workflow.ultimateGoal.detailedIntent}` : "",
      workflow.workflowCycle.cycleNumber > 1 ? `Current cycle: ${workflow.workflowCycle.cycleNumber}` : "",
      workflow.memory.perCycleSummaries[0]?.summary ? `Most recent completed cycle: ${workflow.memory.perCycleSummaries[0].summary}` : "",
      workflow.approvedRecommendation?.title ? `Previous approved recommendation: ${workflow.approvedRecommendation.title}` : "",
      workflow.scopedGoal?.summary ? `Previous scoped goal: ${workflow.scopedGoal.summary}` : "",
      project.record.overview?.summary ? `Repository overview: ${project.record.overview.summary}` : "",
      project.record.overview?.importantToKnowFirst ? `Important to know first: ${project.record.overview.importantToKnowFirst}` : "",
      project.scan.stats.entryPoints.length ? `Entry points: ${project.scan.stats.entryPoints.slice(0, 6).join(", ")}` : "",
      recentChangedFiles.length ? `Recently changed files: ${recentChangedFiles.join(", ")}` : "",
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
          status: normalizedStatus,
          confidence: typeof record.confidence === "number" && Number.isFinite(record.confidence)
            ? Math.max(0, Math.min(1, record.confidence))
            : undefined,
          evidence,
          relatedPaths
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
    const parsed = this.extractJsonObject(rawText);
    if (!parsed || typeof parsed.summary !== "string" || !Array.isArray(parsed.recommendations)) {
      return undefined;
    }

    try {
      const recommendations = parsed.recommendations
        .slice(0, 5)
        .map((entry, index) => workflowRecommendationOptionSchema.parse({
          ...(entry as Record<string, unknown>),
          id: nanoid(),
          rank: index + 1,
          estimatedScope: (entry as { estimatedScope?: unknown }).estimatedScope ?? "small",
          relatedPaths: this.sanitizeRelatedPaths(project, (entry as { relatedPaths?: unknown }).relatedPaths)
        }))
        .map((entry) => sanitizeRecommendationForCycle(entry))
        .filter((entry): entry is ProjectWorkflowState["recommendations"][number] => Boolean(entry))
        .map((entry, index) => ({
          ...entry,
          rank: index + 1
        }));
      const ultimateGoalCompletion = this.parseRecommendationCompletionAssessment(
        (parsed as { ultimateGoalCompletion?: unknown }).ultimateGoalCompletion
      );
      if (recommendations.length === 0 && ultimateGoalCompletion?.state !== "goal_satisfied") {
        return undefined;
      }

      return {
        summary: parsed.summary.trim(),
        ultimateGoalProgress: this.parseRecommendationProgress((parsed as { ultimateGoalProgress?: unknown }).ultimateGoalProgress),
        ultimateGoalCompletion,
        goalCheckUpdates: this.parseGoalCheckUpdates(project, (parsed as { goalCheckUpdates?: unknown }).goalCheckUpdates),
        recommendations
      };
    } catch {
      return undefined;
    }
  }

  private recommendationDeduplicationKey(recommendation: ProjectWorkflowState["recommendations"][number]): string {
    const explicitGoalCheckTarget = recommendation.title.match(/^Satisfy goal check:\s*(.+)$/i)?.[1]?.trim();
    return explicitGoalCheckTarget
      ? `goal:${this.normalizeGoalCheckMatchText(explicitGoalCheckTarget)}`
      : `title:${this.normalizeGoalCheckMatchText(recommendation.title)}`;
  }

  private ensureChecklistRecommendationsLead(
    context: WorkflowRecommendationContext,
    recommendations: ProjectWorkflowState["recommendations"],
    deterministicRecommendations: ProjectWorkflowState["recommendations"]
  ): ProjectWorkflowState["recommendations"] {
    if (context.customFocus?.trim()) {
      return recommendations.map((recommendation, index) => ({ ...recommendation, rank: index + 1 }));
    }

    const checklistRecommendations = deterministicRecommendations.filter((recommendation) =>
      /^Satisfy goal check:/i.test(recommendation.title)
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
    const generatedAt = nowIso();
    const baseRecommendationContext = this.buildWorkflowRecommendationContext(project);
    workflow.goalChecklist = applyGoalChecklistUpdates(
      buildGoalChecklistForAssessment(baseRecommendationContext, generatedAt),
      goalCheckUpdates,
      {
        timestamp: generatedAt,
        ownerAgentId: agent?.id
      }
    );
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
      .map((entry) => sanitizeRecommendationForCycle(entry))
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
    await this.persistProjectUpdate(project, automate);
  }

  private async applyFallbackRecommendations(
    project: LoadedProject,
    agent?: AgentState,
    automate = false,
    customFocus?: string
  ): Promise<void> {
    const objective = project.record.localState.workflowObjective;
    const recommendationContext = this.buildWorkflowRecommendationContext(project, customFocus);
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
    ).map((entry) => sanitizeRecommendationForCycle(entry))
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

  private async applyRecommendationOutput(project: LoadedProject, agent: AgentState, rawText: string, automate = false): Promise<boolean> {
    if (agent.recommendationReport && project.record.workflow.recommendations.length > 0) {
      return true;
    }

    const parsed = this.parseRecommendationOutput(project, rawText);
    if (!parsed) {
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
      return false;
    }

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

        if (await this.applyRecommendationOutput(project, agent, item.text, automate)) {
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
    const recentOpenIssues = workflow.memory.knownOpenIssues
      .filter((issue) => issue.status === "open")
      .slice(0, 5)
      .map((issue) => `- ${issue.title}: ${issue.detail}`);
    const goalChecklist = buildGoalChecklistForAssessment({
      workflow,
      agents: project.record.agents
    })
      .filter((check) => check.required)
      .slice(0, 16)
      .map((check) =>
        `- [${check.status}] ${check.title}${check.evidence ? ` -- ${check.evidence}` : ""}`
      );

    return [
      "Turn the approved recommendation into a scoped goal for the next coding pass.",
      "The output must represent one bounded task for a single cycle, not a broad multi-phase project.",
      "The result must be executable by one coding agent in one pass. If the recommendation is still broad, narrow it to the smallest viable slice and state that slice explicitly.",
      "`executionBrief` should be a full prompt for the coding agent: what to change, where to focus, what to avoid, and how to know the task is done.",
      "Make acceptanceCriteria concrete and testable.",
      "Keep acceptanceCriteria to at most 4 bullets and testStrategy to at most 3 focused checks.",
      "Use the Goal checklist as the completion source of truth. Prefer a scoped plan that turns one unmet or unknown required check into a met check with evidence.",
      "Keep constraints aligned with the Ultimate Goal and the repository boundaries.",
      "",
      `Project: ${project.record.identity.projectName}`,
      `Ultimate Goal: ${workflow.ultimateGoal.summary}`,
      workflow.ultimateGoal.detailedIntent ? `Detailed intent: ${workflow.ultimateGoal.detailedIntent}` : "",
      `Approved recommendation: ${approvedRecommendation.title}`,
      `Recommendation summary: ${approvedRecommendation.summary}`,
      `Why now: ${approvedRecommendation.rationale}`,
      `Expected impact: ${approvedRecommendation.expectedImpact}`,
      approvedRecommendation.relatedPaths.length ? `Likely paths: ${approvedRecommendation.relatedPaths.join(", ")}` : "",
      workflow.ultimateGoal.successCriteria.length ? `Ultimate-goal success criteria:\n- ${workflow.ultimateGoal.successCriteria.join("\n- ")}` : "",
      workflow.ultimateGoal.constraints.length ? `Project constraints:\n- ${workflow.ultimateGoal.constraints.join("\n- ")}` : "",
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
    const parsed = this.extractJsonObject(rawText);
    if (!parsed) {
      return undefined;
    }

    try {
      return sanitizeScopedGoalForSingleAgent(scopedGoalSchema.parse({
        ...parsed,
        id: nanoid(),
        sourceRecommendationId: approvedRecommendation.recommendationId,
        createdAt: nowIso()
      }));
    } catch {
      return undefined;
    }
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
    await this.persistProjectUpdate(project, automate);
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
      relatedPaths: approvedRecommendation.relatedPaths
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
    automate = false
  ): Promise<boolean> {
    if (project.record.workflow.scopedGoal?.sourceRecommendationId === approvedRecommendation.recommendationId) {
      return true;
    }

    const parsed = this.parseScopedGoalOutput(approvedRecommendation, rawText);
    if (!parsed) {
      reduceAgentRuntimeEvent(agent, {
        kind: "raw",
        title: "Scoped goal output rejected",
        detail: rawText.slice(0, 240),
        raw: rawText
      });
      return false;
    }

    await this.applyScopedGoalState(project, parsed, agent, automate);
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

        if (await this.applyScopedGoalOutput(project, agent, approvedRecommendation, item.text, automate)) {
          return;
        }
      }
    }

    await this.applyFallbackScopedGoal(project, approvedRecommendation, agent, automate);
  }

  async approveRecommendation(
    projectId: string,
    recommendationId: string,
    decisionSource: "manual" | "autopilot" = "manual"
  ): Promise<ApprovedRecommendation> {
    const project = this.findProject(projectId);
    const existingWorkflow = this.ensureWorkflowState(project.record);
    const recommendation = existingWorkflow.recommendations.find((entry) => entry.id === recommendationId);
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
      approvedAt: nowIso()
    };

    workflow.approvedRecommendation = approvedRecommendation;
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
    await this.persistProjectUpdate(project, true);
    return approvedRecommendation;
  }

  async createScopedGoal(projectId: string, automate = false) {
    const project = this.findProject(projectId);
    const workflow = this.ensureWorkflowState(project.record);
    const approvedRecommendation = workflow.approvedRecommendation;
    if (!approvedRecommendation) {
      throw new Error("Approve a recommendation before creating a scoped goal.");
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
    return project.record.workflow.scopedGoal;
  }

  async retryWorkflowGoal(projectId: string): Promise<void> {
    const project = this.findProject(projectId);
    const workflow = this.ensureWorkflowState(project.record);

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
      await this.persistProjectUpdate(project, true);
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

  async advanceWorkflowStage(projectId: string): Promise<ProjectWorkflowState["workflowStage"]> {
    const project = this.findProject(projectId);
    this.syncWorkflowState(project);
    if (project.record.workflow.workflowStage === "merged") {
      this.finalizeWorkflowCycle(project);
    } else {
      this.syncWorkflowState(project);
    }
    await this.persistProjectUpdate(project, true);
    return project.record.workflow.workflowStage;
  }

  async recoverWorkflow(projectId: string): Promise<ProjectWorkflowState["workflowStage"]> {
    const project = this.findProject(projectId);
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

    project.record.localState.workflowPauseRequested = false;
    this.resetWorkflowAfterInterruptedAgents(project, interruptedAgents, { markRecoveryHandled: true });
    this.reconcileWorkflowResumeState(project);

    if (!this.transport || this.codexAvailability.source === "unavailable") {
      await this.initializeTransport();
    }

    this.syncWorkflowState(project);
    await this.persistProjectUpdate(project, true);
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
      effort?: "low" | "medium" | "high" | "xhigh";
      initialPhase?: string;
      turnPrompt?: string;
      launchThread?: boolean;
      targetBranch?: string;
    }
  ): Promise<AgentState> {
    const launchThread = options?.launchThread !== false;
    if (launchThread && !this.transport) {
      throw new Error("Codex app-server is unavailable, so agent creation is currently disabled.");
    }
    if (launchThread) {
      this.assertGitHubLinked();
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
    agent.reasoningEffort = this.resolveReasoningEffortForModel(agent.model);
    agent.workflowCycleNumber = category === "manual" ? undefined : workflow.workflowCycle.cycleNumber;
    agent.taskPrompt = `${agentRoles[category].instructions}\n\n${prompt}`;
    agent.status = launchThread ? "starting" : "running";
    agent.startedAt = launchThread ? undefined : nowIso();
    agent.currentPhase = options?.initialPhase ?? (category === "manual" ? "Handling manual request" : undefined);
    this.assertResolvedPathCompatible(project.record.distroName);
    const runtimeSettings = this.getRuntimeSettings(project.record.distroName);

    if (isWriteEnabledAgentCategory(category) && project.scan.kind === "git") {
      const targetBranch = options?.targetBranch ?? (await determineDefaultBranch(project.record.projectRoot, runtimeSettings));
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
      effort?: "low" | "medium" | "high" | "xhigh";
    }
  ): Promise<void> {
    if (!this.transport) {
      throw new Error("Codex transport is not initialized.");
    }

    const turnPrompt = options?.prompt ?? agent.taskPrompt;
    const baseInstructions = options?.outputSchema
      ? `${agent.taskPrompt}\nWhen an output schema is supplied, return only valid JSON matching that schema exactly. Do not add commentary or markdown fences.`
      : agent.taskPrompt;
    const cwd = agent.worktree?.worktreePath ?? project.record.projectRoot;
    await assertExecutionPathWithinProjectRoot(
      project.record.projectRoot,
      cwd,
      project.record.hostPath,
      this.getRuntimeSettings(project.record.distroName),
      project.record.distroName,
      "Agent execution"
    );
    agent.reasoningEffort = options?.effort ?? agent.reasoningEffort ?? this.resolveReasoningEffortForModel(agent.model);
    const sandbox = options?.sandbox ?? "read-only";
    const sandboxPolicy = this.buildRestrictedSandboxPolicy(project, sandbox);
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
    agent.threadId = threadResponse.thread.id;
    agent.startedAt ??= nowIso();
    this.threadToAgent.set(agent.threadId, { projectId: project.record.id, agentId: agent.id });
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
      activeGoalChecks.length ? `Relevant unmet Goal checks:\n${activeGoalChecks.join("\n")}` : "",
      repairContext.join("\n"),
      "Stay inside the active project folder, run only the most relevant checks for this slice, and summarize what changed."
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
    await this.persistProjectUpdate(project, automate || passed || workflow.repair.status === "repairing");
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
    try {
      const appliedBranch = await applyBranchToProjectCheckout(project.record.projectRoot, sourceBranch, runtimeSettings);
      const refreshedProject = await this.scanCurrentProject(project);
      this.applyScannedProjectState(project, refreshedProject);
      return appliedBranch;
    } catch (error) {
      throw new Error(
        `${operation} could not update the opened project checkout. ${error instanceof Error ? error.message : String(error)}`
      );
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
    await this.persistProjectUpdate(project, automate || mergeResult.conflicts.length === 0);
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
    this.recordWorkflowActivity(workflow, {
      source: "workflow",
      status: "running",
      title: objective === "optimize" ? "Optimization recommendation generation started" : "Recommendation generation started",
      detail: normalizedCustomFocus
        ? `Inspecting repo state, workflow memory, recent activity, and the custom focus "${normalizedCustomFocus}".`
        : objective === "optimize"
          ? "Inspecting repo state, workflow memory, and recent activity for the next bounded improvement."
          : "Inspecting repo state, workflow memory, and recent activity.",
      stepId: "recommendation"
    });
    this.updateWorkflowStepProgress(workflow, "recommendation", {
      requiresUserInput: false,
      currentActivity: objective === "optimize" ? "Generating optimization candidates" : "Generating recommendation candidates",
      latestProgressNote: normalizedCustomFocus
        ? `Centering recommendations around: ${normalizedCustomFocus}`
        : objective === "optimize"
          ? "Inspecting project state for the next improvement opportunity"
          : "Inspecting project state and recent activity",
      message: objective === "optimize" ? "Optimization recommendation generation is running." : "Recommendation generation is running.",
      agentCategory: "recommendation"
    }, { status: "running", incrementRunCount: true, incrementAttemptCount: true });
    this.syncWorkflowState(project);
    await this.persistProjectUpdate(project);

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
        initialPhase: "Generating next-step recommendations"
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
        scan: project.scan
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
    console.info(`[interfaceCreation] raw payload (${source})`, payload);
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

      if (!this.transport) {
        this.markAgentDisconnected(project, agent, "Codex app-server is unavailable, so the saved thread could not be resumed in this session.");
        interruptedAgents.push(agent);
        continue;
      }

      try {
        await this.transport.resumeThread(agent.threadId);
        this.threadToAgent.set(agent.threadId, { projectId: project.record.id, agentId: agent.id });
        agent.disconnectedReason = undefined;
        agent.recoveryHandledAt = undefined;
      } catch {
        this.markAgentDisconnected(project, agent, "The saved Codex thread could not be resumed in this session.");
        interruptedAgents.push(agent);
      }
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

    switch (notification.method) {
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
          agent.lastMessageSnippet = notification.params.item.text.slice(-240);
          if (agent.category === "bootstrap") {
            void this.applyInterfaceCreationOutput(project, agent, notification.params.item.text, "item/completed").catch(() => undefined);
          }
          if (agent.category === "goal" && agent.currentPhase === "Detecting ultimate goal") {
            void this.applyUltimateGoalDetectionOutput(project, agent, notification.params.item.text).catch(() => undefined);
          }
          if (agent.category === "recommendation") {
            void this.applyRecommendationOutput(project, agent, notification.params.item.text, true).catch(() => undefined);
          }
          if (agent.category === "goal" && agent.name === "Goal Agent" && project.record.workflow.approvedRecommendation) {
            void this.applyScopedGoalOutput(
              project,
              agent,
              project.record.workflow.approvedRecommendation,
              notification.params.item.text,
              true
            ).catch(() => undefined);
          }
          reduceAgentRuntimeEvent(agent, {
            kind: "item-completed",
            threadId,
            itemId: notification.params.item.id,
            itemType: notification.params.item.type,
            title: "Agent message",
            detail: this.sanitizeTextToProjectBoundary(project, notification.params.item.text) ?? notification.params.item.text,
            raw: notification.params.item
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
        if (agent.category === "bootstrap" && rawResponseText) {
          void this.applyInterfaceCreationOutput(project, agent, rawResponseText, "rawResponseItem/completed").catch(() => undefined);
        }
        if (agent.category === "goal" && agent.currentPhase === "Detecting ultimate goal" && rawResponseText) {
          void this.applyUltimateGoalDetectionOutput(project, agent, rawResponseText).catch(() => undefined);
        }
        if (agent.category === "recommendation" && rawResponseText) {
          void this.applyRecommendationOutput(project, agent, rawResponseText, true).catch(() => undefined);
        }
        if (agent.category === "goal" && agent.name === "Goal Agent" && rawResponseText && project.record.workflow.approvedRecommendation) {
          void this.applyScopedGoalOutput(
            project,
            agent,
            project.record.workflow.approvedRecommendation,
            rawResponseText,
            true
          ).catch(() => undefined);
        }
        reduceAgentRuntimeEvent(agent, {
          kind: "raw",
          title: "rawResponseItem/completed",
          detail: this.sanitizeTextToProjectBoundary(project, rawResponseText?.slice(0, 240)) ?? rawResponseText?.slice(0, 240),
          raw: notification.params.item
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
    this.syncWorkflowStepProgressFromAgent(project, agent);
    this.mirrorLatestAgentEventToWorkflow(this.ensureWorkflowState(project.record), agent);
    this.saveProject(project).catch(() => undefined);
    this.emitState();
    this.scheduleWorkflowAutomation(project.record.id);
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
      const requestId = nanoid();
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
        kind: normalizedQuestions.some((question) => question.isSecret) ? "credentials" : "external_setup",
        title: userInputRequest.title,
        description: userInputRequest.description,
        reason: "The agent paused and needs your external setup or answers before it can continue.",
        requestedByAgentCategory: agent.category,
        severity: normalizedQuestions.some((question) => question.isSecret) ? "high" : "medium",
        blocking: true,
        linkedUserInputRequestId: requestId
      }, { persist: false });
      userInputRequest.humanInterventionId = intervention.id;
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
