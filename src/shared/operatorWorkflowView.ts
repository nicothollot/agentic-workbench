import type {
  AgentState,
  ChecklistDelta,
  CycleContract,
  ProjectEvidenceCommand,
  ProjectRepositorySummary,
  ProjectWorkflowState,
  RecommendationHealth,
  RepoHygieneReport,
  RepositoryScanStatus,
  ValidationFinalStatus,
  ValidationLedger,
  WorkflowDerivedStatus
} from "./types";
import { unique } from "./utils";
import { buildCycleContract } from "./workflowEvidence";
import { deriveUserFacingWorkflowStatus, workflowStageLabel } from "./workflowView";

export type OperatorSeverity = "idle" | "running" | "success" | "warning" | "danger" | "paused";
export type OperatorHealthStatus = "passed" | "failed" | "partial" | "warning" | "not_run" | "unknown" | "running";
export type OperatorChangedFileGroupKind = "product" | "docs" | "tests" | "generated" | "suspicious" | "other";

export interface OperatorChangedFileGroup {
  kind: OperatorChangedFileGroupKind;
  label: string;
  files: string[];
  warning?: string;
}

export interface OperatorValidationSummary {
  planned: string[];
  attempted: string[];
  failedAttempts: number;
  repaired: string[];
  finalStatus: ValidationFinalStatus | "unknown";
  finalStatusLabel: string;
  mergeAllowed: boolean;
  mergeBlockedReasons: string[];
  warnings: string[];
  failedCommands: Array<{
    command: string;
    status: string;
    exitCode?: number | null;
    classifiedFailure?: string;
    repairedByCommandId?: string;
  }>;
}

export interface OperatorChecklistDeltaSummary {
  newlyMet: string[];
  stillUnknown: string[];
  needsAttention: string[];
  evidenceObserved: number;
  evidenceConsumed: number;
  evidenceNotConsumed: number;
  evidenceNotConsumedReasons: string[];
  whyStillUnknownByCheckId: Record<string, string>;
  didGoalProgressChange: boolean;
  summary: string;
  emptyReason?: string;
}

export interface OperatorRepositoryHealth {
  indexedStatus: OperatorHealthStatus;
  indexedLabel: string;
  validationStatus: OperatorHealthStatus;
  validationLabel: string;
  hygieneStatus: OperatorHealthStatus;
  hygieneLabel: string;
  runtimeStatus: OperatorHealthStatus;
  runtimeLabel: string;
  detectedProjectType: string;
  testCommandCandidates: string[];
  evidenceCommandCandidates: string[];
  commandAvailability: Array<{ label: string; available: boolean | "unknown"; detail: string }>;
  suspiciousPaths: string[];
  cleanedGeneratedArtifacts: string[];
  changedFileGroups: OperatorChangedFileGroup[];
}

export interface OperatorWorkflowViewModel {
  projectHeader: {
    projectName: string;
    branch: string;
    lastUpdated: string;
    status: "paused" | "running" | "blocked" | "completed" | "idle";
    approvalCount: number;
  };
  currentStatus: {
    primaryLabel: string;
    secondaryExplanation: string;
    technicalStage: string;
    activeAgent: string;
    lastCompletedAction: string;
    pauseReason?: string;
    nextOperatorAction: string;
    severity: OperatorSeverity;
  };
  currentCycle: {
    cycleNumber?: number;
    cycleContract?: CycleContract;
    cycleProgress: string;
    checklistDelta?: ChecklistDelta;
    checklistDeltaSummary: OperatorChecklistDeltaSummary;
    validationLedger?: ValidationLedger;
    validationSummary: OperatorValidationSummary;
    recommendationHealth?: RecommendationHealth;
    repoHygiene?: RepoHygieneReport;
    changedFiles: string[];
    changedFilesSummary: OperatorChangedFileGroup[];
    currentAgentMessages: string[];
  };
  goalProgress: {
    percent?: number;
    requiredMet: number;
    requiredTotal: number;
    newlyMetThisCycle: string[];
    stillUnknown: string[];
    needsAttention: string[];
    sourceOfTruthExplanation: string;
  };
  planner: {
    selectedTask?: string;
    whySelectedNow: string;
    scoreBreakdown: Array<{ key: string; label: string; value: number }>;
    alternatives: Array<{ title: string; score: number; targetedCheckIds: string[]; whyNext: string }>;
    repeatedWorkWarning?: string;
    fallbackWarning?: string;
  };
  historySummary: {
    recentCycles: Array<{ cycleNumber: number; attempted: string; outcome: string; nextRecommendation?: string }>;
    repeatedWorkGroups: Array<{ title: string; count: number; checkIds: string[] }>;
    validationTrend: string;
    checklistProgressTrend: string;
  };
  repositoryHealth: OperatorRepositoryHealth;
  emptyStates: {
    cycleContract?: string;
    checklistDelta?: string;
    validationLedger?: string;
    evidenceCommands?: string;
    recommendationHealth?: string;
  };
}

export interface BuildOperatorWorkflowViewModelOptions {
  workflow?: ProjectWorkflowState | null;
  agents?: AgentState[];
  projectName?: string;
  branch?: string;
  lastUpdated?: string;
  workflowPauseRequested?: boolean;
  approvalCount?: number;
  repositoryScanStatus?: RepositoryScanStatus | null;
  repositorySummary?: ProjectRepositorySummary | null;
  repoHygieneReport?: RepoHygieneReport;
  validationLedger?: ValidationLedger;
  runtimeReady?: boolean;
}

const toTime = (value?: string): number => value ? Date.parse(value) || 0 : 0;

const latestValidationLedger = (workflow: ProjectWorkflowState, explicit?: ValidationLedger): ValidationLedger | undefined =>
  explicit ?? workflow.validationLedgers
    .filter((ledger) => ledger.cycleNumber === workflow.workflowCycle.cycleNumber)
    .sort((left, right) => toTime(right.updatedAt) - toTime(left.updatedAt))[0];

const latestRepoHygieneReport = (workflow: ProjectWorkflowState, explicit?: RepoHygieneReport): RepoHygieneReport | undefined =>
  explicit ?? workflow.repoHygieneReports
    .slice()
    .sort((left, right) => toTime(right.scannedAt) - toTime(left.scannedAt))[0];

const latestChecklistDelta = (workflow: ProjectWorkflowState): ChecklistDelta | undefined =>
  workflow.checklistDeltas
    .filter((delta) => delta.cycleNumber === workflow.workflowCycle.cycleNumber)
    .sort((left, right) => toTime(right.createdAt) - toTime(left.createdAt))[0];

const latestCycleAgents = (workflow: ProjectWorkflowState, agents: AgentState[]): AgentState[] =>
  agents.filter((agent) =>
    agent.workflowCycleNumber === undefined || agent.workflowCycleNumber === workflow.workflowCycle.cycleNumber
  );

const latestActiveAgent = (agents: AgentState[]): AgentState | undefined =>
  [...agents]
    .sort((left, right) =>
      toTime(right.lastActivityAt ?? right.completedAt ?? right.startedAt ?? right.createdAt) -
      toTime(left.lastActivityAt ?? left.completedAt ?? left.startedAt ?? left.createdAt)
    )[0];

const completedActionFromAgents = (agents: AgentState[]): string | undefined =>
  [...agents]
    .filter((agent) => agent.status === "completed")
    .sort((left, right) => toTime(right.completedAt ?? right.lastActivityAt) - toTime(left.completedAt ?? left.lastActivityAt))[0]
    ?.currentPhase;

const normalizeText = (value: string): string => value.trim().replace(/\s+/g, " ");

const validationStatusLabel = (status: OperatorValidationSummary["finalStatus"]): string => {
  switch (status) {
    case "passed":
      return "Final validation passed";
    case "failed":
      return "Final validation failed";
    case "partial":
      return "Validation partial";
    case "skipped":
      return "Validation skipped";
    case "not_run":
      return "Validation not run";
    default:
      return "Validation unknown";
  }
};

const buildValidationSummary = (ledger?: ValidationLedger): OperatorValidationSummary => {
  if (!ledger) {
    return {
      planned: [],
      attempted: [],
      failedAttempts: 0,
      repaired: [],
      finalStatus: "unknown",
      finalStatusLabel: "Validation unknown",
      mergeAllowed: false,
      mergeBlockedReasons: ["No validation ledger is recorded for this cycle."],
      warnings: [],
      failedCommands: []
    };
  }
  const failedResults = ledger.commandResults.filter((result) => result.status !== "passed" && result.status !== "skipped");
  return {
    planned: ledger.plannedCommands,
    attempted: ledger.attemptedCommands,
    failedAttempts: failedResults.length,
    repaired: ledger.repairedFailures,
    finalStatus: ledger.finalValidationStatus,
    finalStatusLabel: validationStatusLabel(ledger.finalValidationStatus),
    mergeAllowed: ledger.mergeAllowed,
    mergeBlockedReasons: ledger.mergeBlockedReasons,
    warnings: ledger.warnings,
    failedCommands: failedResults.map((result) => ({
      command: result.command,
      status: result.status,
      exitCode: result.exitCode,
      classifiedFailure: result.classifiedFailure?.summary,
      repairedByCommandId: result.classifiedFailure?.repairedByCommandId
    }))
  };
};

const buildChecklistDeltaSummary = (
  workflow: ProjectWorkflowState,
  contract?: CycleContract,
  delta?: ChecklistDelta
): OperatorChecklistDeltaSummary => {
  if (!delta) {
    const reason = "No checklist delta recorded yet because integrity/reconciliation has not run.";
    return {
      newlyMet: [],
      stillUnknown: contract?.targetedChecklistItems
        .filter((item) => item.currentStatus === "unknown")
        .map((item) => item.checkId) ?? [],
      needsAttention: [],
      evidenceObserved: workflow.evidenceObservations.filter((observation) => observation.cycleNumber === workflow.workflowCycle.cycleNumber).length,
      evidenceConsumed: 0,
      evidenceNotConsumed: 0,
      evidenceNotConsumedReasons: [],
      whyStillUnknownByCheckId: {},
      didGoalProgressChange: false,
      summary: reason,
      emptyReason: reason
    };
  }
  return {
    newlyMet: delta.targetedNewlyMet,
    stillUnknown: delta.targetedStillUnknown,
    needsAttention: delta.targetedNeedsAttention,
    evidenceObserved: delta.evidenceObservedCount,
    evidenceConsumed: delta.evidenceConsumedCount,
    evidenceNotConsumed: delta.evidenceNotConsumedCount,
    evidenceNotConsumedReasons: Object.entries(delta.evidenceNotConsumedReasons).map(([reason, count]) => `${reason.replace(/_/g, " ")}: ${count}`),
    whyStillUnknownByCheckId: delta.whyStillUnknownByCheckId,
    didGoalProgressChange: delta.didGoalProgressChange,
    summary: delta.summaryForHumans
  };
};

const isGeneratedPath = (path: string): boolean =>
  /(?:^|\/)(?:__pycache__|node_modules|dist|build|out|release|coverage|\.pytest_cache|\.vite|\.next)(?:\/|$)/i.test(path) ||
  /\.(?:pyc|pyo|map)$/i.test(path);

export const suspiciousPathReason = (path: string): string | undefined => {
  if (/(?:^|\/)EADME\.md$/i.test(path)) {
    return "Looks like README.md with the leading R missing.";
  }
  if (/^ocs(?:\/|$)/i.test(path) || /\/ocs(?:\/|$)/i.test(path)) {
    return "Looks like docs/ with the leading d missing.";
  }
  return undefined;
};

const groupChangedFiles = (files: string[]): OperatorChangedFileGroup[] => {
  const groups: Record<OperatorChangedFileGroupKind, string[]> = {
    product: [],
    docs: [],
    tests: [],
    generated: [],
    suspicious: [],
    other: []
  };
  for (const file of unique(files)) {
    if (suspiciousPathReason(file)) {
      groups.suspicious.push(file);
      continue;
    }
    if (isGeneratedPath(file)) {
      groups.generated.push(file);
      continue;
    }
    if (/^(?:docs?|documentation)\//i.test(file) || /(?:^|\/)README(?:\.[a-z0-9]+)?$/i.test(file) || /\.(?:md|mdx|rst|txt)$/i.test(file)) {
      groups.docs.push(file);
      continue;
    }
    if (/^(?:tests?|spec|cypress|playwright)\//i.test(file) || /(?:^|\/)(?:test|spec)[_.-][^/]+/i.test(file) || /\.(?:test|spec)\.[tj]sx?$/i.test(file)) {
      groups.tests.push(file);
      continue;
    }
    if (/^(?:src|app|lib|packages|electron|runtime)\//i.test(file) || /\.(?:ts|tsx|js|jsx|py|go|rs|java|cs|cpp|c|css|scss)$/i.test(file)) {
      groups.product.push(file);
      continue;
    }
    groups.other.push(file);
  }
  const metadata: Record<OperatorChangedFileGroupKind, { label: string; warning?: string }> = {
    product: { label: "Product code" },
    docs: { label: "Docs" },
    tests: { label: "Tests" },
    generated: { label: "Generated/ignored" },
    suspicious: { label: "Suspicious paths", warning: "Review or repair these paths before merge." },
    other: { label: "Other" }
  };
  return (Object.keys(groups) as OperatorChangedFileGroupKind[])
    .filter((kind) => groups[kind].length > 0)
    .map((kind) => ({ kind, label: metadata[kind].label, files: groups[kind], warning: metadata[kind].warning }));
};

const scoreLabels: Record<string, string> = {
  currentGoalAlignment: "Current goal alignment",
  originalGoalAlignment: "Original goal alignment",
  checklistImpact: "Checklist impact",
  batchingLeverage: "Batching leverage",
  risk: "Risk",
  validationAvailability: "Validation availability",
  strategyFit: "Strategy fit",
  probabilityOfSuccess: "Probability of success",
  repetition: "Repetition penalty",
  coherentProductIncrement: "Coherent product increment"
};

const buildPlannerAlternatives = (workflow: ProjectWorkflowState, contract?: CycleContract) => {
  const selected = contract?.selectedTaskId;
  return workflow.strategicPlans
    .filter((plan) => plan.cycleNumber === workflow.workflowCycle.cycleNumber)
    .flatMap((plan) => plan.candidateTasks)
    .filter((task) => task.id !== selected)
    .sort((left, right) => right.score - left.score)
    .slice(0, 6)
    .map((task) => ({
      title: task.title,
      score: task.score,
      targetedCheckIds: task.targetedCheckIds,
      whyNext: task.whyNext
    }));
};

const buildHistorySummary = (workflow: ProjectWorkflowState, contract?: CycleContract): OperatorWorkflowViewModel["historySummary"] => {
  const recentCycles = workflow.cycleRetrospectives
    .slice()
    .sort((left, right) => right.cycleNumber - left.cycleNumber)
    .slice(0, 6)
    .map((entry) => ({
      cycleNumber: entry.cycleNumber,
      attempted: entry.cycleContract?.selectedTaskTitle ?? entry.triedToDo,
      outcome: entry.checklistDelta?.summaryForHumans ?? entry.goalChecklistChangeRecommendation,
      nextRecommendation: entry.nextRecommendedTasks[0]
    }));
  const repeated = new Map<string, { title: string; count: number; checkIds: string[] }>();
  for (const attempt of contract?.priorSimilarAttempts ?? []) {
    const key = normalizeText(attempt.attemptedTaskTitle.toLowerCase());
    const current = repeated.get(key) ?? { title: attempt.attemptedTaskTitle, count: 0, checkIds: [] };
    repeated.set(key, { ...current, count: current.count + 1, checkIds: contract?.sourceDataRefs.targetedCheckIds as string[] ?? [] });
  }
  const deltas = workflow.checklistDeltas.slice().sort((left, right) => left.cycleNumber - right.cycleNumber);
  const validationTrend = workflow.validationLedgers.length
    ? workflow.validationLedgers
      .slice(-6)
      .map((ledger) => `Cycle ${ledger.cycleNumber}: ${ledger.finalValidationStatus}`)
      .join(" | ")
    : "No validation trend recorded yet.";
  const checklistProgressTrend = deltas.length
    ? deltas.slice(-6).map((delta) => `Cycle ${delta.cycleNumber}: ${delta.targetedNewlyMet.length} newly met`).join(" | ")
    : "No checklist reconciliation trend recorded yet.";
  return {
    recentCycles,
    repeatedWorkGroups: [...repeated.values()].filter((entry) => entry.count > 1 || contract?.priorSimilarAttempts.length),
    validationTrend,
    checklistProgressTrend
  };
};

const repositoryIndexedStatus = (status?: RepositoryScanStatus["status"]): { status: OperatorHealthStatus; label: string } => {
  switch (status) {
    case "indexed":
      return { status: "passed", label: "Repository indexed" };
    case "scanning":
      return { status: "running", label: "Repository scanning" };
    case "partially_indexed":
    case "truncated":
      return { status: "warning", label: "Repository partially indexed" };
    case "failed":
      return { status: "failed", label: "Repository scan failed" };
    case "not_scanned":
      return { status: "not_run", label: "Repository not scanned" };
    default:
      return { status: "unknown", label: "Repository scan unknown" };
  }
};

const validationHealth = (ledger?: ValidationLedger): { status: OperatorHealthStatus; label: string } => {
  if (!ledger) {
    return { status: "unknown", label: "Validation ledger missing" };
  }
  switch (ledger.finalValidationStatus) {
    case "passed":
      return ledger.unresolvedValidationFailures.length
        ? { status: "warning", label: "Validation passed with unresolved warnings" }
        : { status: "passed", label: "Validation passed" };
    case "failed":
      return { status: "failed", label: "Validation failed" };
    case "partial":
      return { status: "partial", label: "Validation partial" };
    case "skipped":
      return { status: "warning", label: "Validation skipped" };
    case "not_run":
      return { status: "not_run", label: "Validation not run" };
  }
};

const hygieneHealth = (report?: RepoHygieneReport): { status: OperatorHealthStatus; label: string } => {
  if (!report) {
    return { status: "unknown", label: "Hygiene scan missing" };
  }
  switch (report.status) {
    case "passed":
      return { status: "passed", label: "Hygiene passed" };
    case "warnings":
      return { status: "warning", label: "Hygiene warnings" };
    case "failed":
      return { status: "failed", label: "Hygiene failed" };
    case "unknown":
      return { status: "unknown", label: "Hygiene not scanned" };
  }
};

const inferCommandAvailability = (
  workflow: ProjectWorkflowState,
  summary?: ProjectRepositorySummary | null
): OperatorRepositoryHealth["commandAvailability"] => {
  const managers = new Set(summary?.stats?.primaryManagers ?? []);
  const manifests = new Set(summary?.stats?.manifestFiles ?? []);
  const hasNode = managers.has("npm") || manifests.has("package.json");
  const hasPython = [...managers, ...manifests].some((entry) => /python|pip|poetry|pyproject|requirements/i.test(entry));
  const hasTests = Boolean(summary?.stats?.testsPresent);
  return [
    { label: "python", available: hasPython ? "unknown" : false, detail: hasPython ? "Python project markers detected; executable availability is runtime-specific." : "No Python project markers detected." },
    { label: "python3", available: hasPython ? "unknown" : false, detail: hasPython ? "Python project markers detected; executable availability is runtime-specific." : "No Python project markers detected." },
    { label: "pytest", available: workflow.evidenceCommands.some((command) => /pytest/i.test(command.command)) ? "unknown" : false, detail: "Only project-declared evidence/validation commands are trusted here." },
    { label: "unittest", available: workflow.evidenceCommands.some((command) => /unittest/i.test(command.command)) ? "unknown" : hasPython ? "unknown" : false, detail: hasPython ? "Python project markers detected; check runtime before auto-running." : "No unittest candidate discovered." },
    { label: "node/npm", available: hasNode ? "unknown" : false, detail: hasNode ? "package.json/npm project markers detected." : "No Node package manifest detected." },
    { label: "project tests", available: hasTests ? "unknown" : false, detail: hasTests ? "Tests are present in the repository scan." : "No test files were detected by the scan." }
  ];
};

const buildRepositoryHealth = (
  workflow: ProjectWorkflowState,
  contract: CycleContract | undefined,
  ledger: ValidationLedger | undefined,
  hygiene: RepoHygieneReport | undefined,
  changedFileGroups: OperatorChangedFileGroup[],
  options: BuildOperatorWorkflowViewModelOptions
): OperatorRepositoryHealth => {
  const indexed = repositoryIndexedStatus(options.repositoryScanStatus?.status);
  const validation = validationHealth(ledger);
  const hygieneStatus = hygieneHealth(hygiene);
  const suspiciousPaths = unique([
    ...changedFileGroups.find((group) => group.kind === "suspicious")?.files ?? [],
    ...(hygiene?.forbiddenFiles ?? []).filter((path) => suspiciousPathReason(path))
  ]);
  const evidenceCommandCandidates = unique([
    ...(contract?.expectedEvidenceCommands ?? []),
    ...workflow.evidenceCommands.map((command) => command.command)
  ]);
  return {
    indexedStatus: indexed.status,
    indexedLabel: indexed.label,
    validationStatus: validation.status,
    validationLabel: validation.label,
    hygieneStatus: hygieneStatus.status,
    hygieneLabel: hygieneStatus.label,
    runtimeStatus: options.runtimeReady === false ? "failed" : options.runtimeReady === true ? "passed" : "unknown",
    runtimeLabel: options.runtimeReady === false ? "Runtime blocked" : options.runtimeReady === true ? "Runtime ready" : "Runtime unknown",
    detectedProjectType: options.repositorySummary?.stats?.primaryManagers?.join(", ") || options.repositoryScanStatus?.searchScope || "Unknown",
    testCommandCandidates: contract?.expectedValidationCommands ?? [],
    evidenceCommandCandidates,
    commandAvailability: inferCommandAvailability(workflow, options.repositorySummary),
    suspiciousPaths,
    cleanedGeneratedArtifacts: hygiene?.cleanedFiles ?? [],
    changedFileGroups
  };
};

const buildNextOperatorAction = (
  status: WorkflowDerivedStatus,
  ledger: ValidationLedger | undefined,
  hygiene: RepoHygieneReport | undefined,
  delta: ChecklistDelta | undefined,
  health: RecommendationHealth,
  contract: CycleContract | undefined,
  workflowPauseRequested?: boolean
): string => {
  if (hygiene?.mergeBlockingFindings.length || hygiene?.forbiddenFiles.length) {
    return "Remove or repair forbidden changed paths before merge.";
  }
  if (ledger && ledger.finalValidationStatus === "failed") {
    return "Fix validation failure before merge.";
  }
  if (ledger && ledger.finalValidationStatus === "partial") {
    return "Review partial validation and unresolved evidence before merge.";
  }
  if (!ledger || ledger.finalValidationStatus === "not_run") {
    return workflowPauseRequested
      ? "Continue workflow to run integrity validation and checklist reconciliation."
      : "Run integrity validation and checklist reconciliation before merge.";
  }
  if (health.fallbackUsedForCurrentRecommendation && health.consecutiveStructuredFailures >= 2) {
    return "Review planner fallback health before another implementation pass.";
  }
  if (contract?.repetitionPenalty && contract.repetitionPenalty < 0 && delta && !delta.didGoalProgressChange) {
    return "Review evidence-gap task before repeating this work package.";
  }
  if (delta && delta.evidenceObservedCount > delta.evidenceConsumedCount) {
    return "Review why emitted evidence was not consumed into checklist status.";
  }
  if (/paused/i.test(status.label)) {
    return "Continue workflow from the saved cycle checkpoint.";
  }
  return "Continue monitoring; no validation, hygiene, checklist, or planner blocker is currently recorded.";
};

export const buildOperatorWorkflowViewModel = (
  options: BuildOperatorWorkflowViewModelOptions
): OperatorWorkflowViewModel => {
  const workflow = options.workflow;
  if (!workflow) {
    const validationSummary = buildValidationSummary(undefined);
    return {
      projectHeader: {
        projectName: options.projectName ?? "No project",
        branch: options.branch ?? "No branch",
        lastUpdated: options.lastUpdated ?? "",
        status: "idle",
        approvalCount: options.approvalCount ?? 0
      },
      currentStatus: {
        primaryLabel: "Workflow unavailable",
        secondaryExplanation: "No workflow state is loaded.",
        technicalStage: "Unavailable",
        activeAgent: "No active agent",
        lastCompletedAction: "None",
        nextOperatorAction: "Load a project to inspect workflow status.",
        severity: "idle"
      },
      currentCycle: {
        cycleProgress: "No cycle loaded.",
        checklistDeltaSummary: {
          newlyMet: [],
          stillUnknown: [],
          needsAttention: [],
          evidenceObserved: 0,
          evidenceConsumed: 0,
          evidenceNotConsumed: 0,
          evidenceNotConsumedReasons: [],
          whyStillUnknownByCheckId: {},
          didGoalProgressChange: false,
          summary: "No workflow state is loaded."
        },
        validationSummary,
        changedFiles: [],
        changedFilesSummary: [],
        currentAgentMessages: []
      },
      goalProgress: {
        requiredMet: 0,
        requiredTotal: 0,
        newlyMetThisCycle: [],
        stillUnknown: [],
        needsAttention: [],
        sourceOfTruthExplanation: "No workflow state is loaded."
      },
      planner: {
        whySelectedNow: "No workflow state is loaded.",
        scoreBreakdown: [],
        alternatives: []
      },
      historySummary: {
        recentCycles: [],
        repeatedWorkGroups: [],
        validationTrend: "No validation trend recorded yet.",
        checklistProgressTrend: "No checklist reconciliation trend recorded yet."
      },
      repositoryHealth: {
        indexedStatus: "unknown",
        indexedLabel: "Repository scan unknown",
        validationStatus: "unknown",
        validationLabel: "Validation ledger missing",
        hygieneStatus: "unknown",
        hygieneLabel: "Hygiene scan missing",
        runtimeStatus: "unknown",
        runtimeLabel: "Runtime unknown",
        detectedProjectType: "Unknown",
        testCommandCandidates: [],
        evidenceCommandCandidates: [],
        commandAvailability: [],
        suspiciousPaths: [],
        cleanedGeneratedArtifacts: [],
        changedFileGroups: []
      },
      emptyStates: {
        cycleContract: "No workflow state is loaded.",
        checklistDelta: "No workflow state is loaded.",
        validationLedger: "No workflow state is loaded.",
        evidenceCommands: "No workflow state is loaded.",
        recommendationHealth: "No workflow state is loaded."
      }
    };
  }

  const cycleAgents = latestCycleAgents(workflow, options.agents ?? []);
  const activeAgent = latestActiveAgent(cycleAgents);
  const ledger = latestValidationLedger(workflow, options.validationLedger);
  const hygiene = latestRepoHygieneReport(workflow, options.repoHygieneReport);
  const contract = workflow.cycleContract?.cycleNumber === workflow.workflowCycle.cycleNumber
    ? workflow.cycleContract
    : buildCycleContract(workflow);
  const delta = latestChecklistDelta(workflow);
  const status = deriveUserFacingWorkflowStatus(workflow, {
    agents: cycleAgents,
    validationLedger: ledger,
    repoHygieneReport: hygiene,
    workflowPauseRequested: options.workflowPauseRequested
  });
  const primaryStatusLabel = status.label.replace(/^Paused by operator,\s*/i, "");
  const changedFiles = unique(cycleAgents.flatMap((agent) => agent.changedFiles));
  const changedFileGroups = groupChangedFiles(unique([
    ...changedFiles,
    ...(hygiene?.forbiddenFiles ?? []),
    ...(hygiene?.cleanedFiles ?? [])
  ]));
  const requiredChecks = workflow.goalChecklist.filter((check) => check.required && check.status !== "not_applicable");
  const requiredMet = requiredChecks.filter((check) => check.status === "met").length;
  const requiredTotal = requiredChecks.length;
  const checklistDeltaSummary = buildChecklistDeltaSummary(workflow, contract, delta);
  const validationSummary = buildValidationSummary(ledger);
  const goalPercent = workflow.ultimateGoalProgress?.percentComplete ??
    (requiredTotal ? Math.round((requiredMet / requiredTotal) * 100) : undefined);
  const scoreBreakdown = Object.entries(contract.scoreBreakdown).map(([key, value]) => ({
    key,
    label: scoreLabels[key] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " "),
    value
  }));
  const fallbackWarning = contract.fallbackOrHealthWarnings.find((warning) => /fallback|structured recommendation/i.test(warning)) ??
    (workflow.recommendationHealth.fallbackUsedForCurrentRecommendation
      ? workflow.recommendationHealth.fallbackReason ?? "Planner fallback used because structured recommendation output failed."
      : undefined);
  const repeatedWorkWarning = contract.repetitionPenalty < 0 || contract.priorSimilarAttempts.length
    ? `This package has repetition risk: score includes repetition penalty ${contract.repetitionPenalty}; ${contract.priorSimilarAttempts.length} prior similar attempt${contract.priorSimilarAttempts.length === 1 ? "" : "s"} are recorded.`
    : undefined;
  const nextOperatorAction = buildNextOperatorAction(
    status,
    ledger,
    hygiene,
    delta,
    workflow.recommendationHealth,
    contract,
    options.workflowPauseRequested
  );
  const repoHealth = buildRepositoryHealth(workflow, contract, ledger, hygiene, changedFileGroups, options);

  return {
    projectHeader: {
      projectName: options.projectName ?? "Project",
      branch: options.branch ?? "Branch not recorded",
      lastUpdated: options.lastUpdated ?? contract.updatedAt,
      status: status.tone === "paused"
        ? "paused"
        : status.tone === "danger"
          ? "blocked"
          : status.tone === "success"
            ? "completed"
            : status.tone === "running"
              ? "running"
              : "idle",
      approvalCount: options.approvalCount ?? 0
    },
    currentStatus: {
      primaryLabel: primaryStatusLabel,
      secondaryExplanation: contract.concreteGoalForThisCycle || status.explanation,
      technicalStage: workflowStageLabel(workflow.workflowStage),
      activeAgent: activeAgent?.name ?? "Waiting for next workflow agent",
      lastCompletedAction: workflow.autopilotStatus?.lastCompletedAction?.replace(/_/g, " ") ?? completedActionFromAgents(cycleAgents) ?? "None",
      pauseReason: options.workflowPauseRequested ? "Manual pause requested" : workflow.autopilotStatus?.pausedReason?.replace(/_/g, " "),
      nextOperatorAction,
      severity: status.tone
    },
    currentCycle: {
      cycleNumber: workflow.workflowCycle.cycleNumber,
      cycleContract: contract,
      cycleProgress: `Cycle ${workflow.workflowCycle.cycleNumber}: ${contract.targetedChecklistItems.length} targeted check${contract.targetedChecklistItems.length === 1 ? "" : "s"}.`,
      checklistDelta: delta,
      checklistDeltaSummary,
      validationLedger: ledger,
      validationSummary,
      recommendationHealth: workflow.recommendationHealth,
      repoHygiene: hygiene,
      changedFiles,
      changedFilesSummary: changedFileGroups,
      currentAgentMessages: cycleAgents
        .map((agent) => agent.lastMessageSnippet ?? agent.currentSubtask ?? agent.currentPhase)
        .filter((entry): entry is string => Boolean(entry?.trim()))
    },
    goalProgress: {
      percent: goalPercent,
      requiredMet,
      requiredTotal,
      newlyMetThisCycle: checklistDeltaSummary.newlyMet,
      stillUnknown: checklistDeltaSummary.stillUnknown,
      needsAttention: checklistDeltaSummary.needsAttention,
      sourceOfTruthExplanation: workflow.ultimateGoalProgress
        ? `Source of truth: ${workflow.ultimateGoalProgress.source} progress estimate plus checklist status.`
        : "Source of truth: current required checklist item statuses."
    },
    planner: {
      selectedTask: contract.selectedTaskTitle,
      whySelectedNow: contract.whySelectedNow,
      scoreBreakdown,
      alternatives: buildPlannerAlternatives(workflow, contract),
      repeatedWorkWarning,
      fallbackWarning
    },
    historySummary: buildHistorySummary(workflow, contract),
    repositoryHealth: repoHealth,
    emptyStates: {
      cycleContract: contract ? undefined : "No cycle contract has been recorded yet.",
      checklistDelta: delta ? undefined : "No checklist delta recorded yet because integrity/reconciliation has not run.",
      validationLedger: ledger ? undefined : "Validation ledger is not recorded for this cycle; success cannot be reported.",
      evidenceCommands: workflow.evidenceCommands.length ? undefined : "No evidence commands discovered for this project.",
      recommendationHealth: workflow.recommendationHealth.totalStructuredAttempts ? undefined : "No structured recommendation health events recorded yet."
    }
  };
};

export const operatorEvidenceCommands = (commands: ProjectEvidenceCommand[]): string[] =>
  commands.map((command) => command.command);
