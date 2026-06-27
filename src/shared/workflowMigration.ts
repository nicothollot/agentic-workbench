import type {
  AgentCommandExecution,
  AgentState,
  ChecklistDelta,
  ChecklistEvidenceNotConsumedReason,
  CycleContract,
  GoalAttainmentCheck,
  ProjectWorkflowState,
  RecommendationHealth,
  RepoHygieneReport,
  ValidationCommandPhase,
  ValidationCommandResult
} from "./types";
import { nowIso, unique } from "./utils";
import {
  buildCycleContract,
  CHECKLIST_DELTA_SCHEMA_VERSION,
  recordRecommendationFallbackUsed,
  recordStructuredRecommendationFailure
} from "./workflowEvidence";
import {
  buildValidationCommandResult,
  createValidationLedger,
  finalizeValidationLedger
} from "./validationLedger";

export interface LegacyWorkflowDiagnosticsOptions {
  agents?: AgentState[];
  now?: string;
  deriveChecklistDelta?: boolean;
  deriveValidationLedger?: boolean;
  deriveRepoHygiene?: boolean;
}

export interface LegacyWorkflowDiagnosticsReport {
  cycleContractDerived: boolean;
  checklistDeltaDerived: boolean;
  validationLedgerDerived: boolean;
  recommendationHealthDerived: boolean;
  repoHygieneDerived: boolean;
}

export interface WorkflowCycleTaskSeparation {
  cycleNumber: number;
  cycleStartedWithTask?: string;
  completedTask?: string;
  nextRecommendedTask?: string;
}

const normalizeSpace = (value: string): string => value.trim().replace(/\s+/g, " ");

const toTime = (value?: string): number => value ? Date.parse(value) || 0 : 0;

const percentRequiredMet = (checklist: GoalAttainmentCheck[]): number => {
  const required = checklist.filter((check) => check.required && check.status !== "not_applicable");
  return required.length ? Math.round((required.filter((check) => check.status === "met").length / required.length) * 100) : 0;
};

const latestPlannerDecision = (workflow: ProjectWorkflowState) =>
  workflow.plannerDecisions
    .filter((decision) => decision.cycleNumber === workflow.workflowCycle.cycleNumber)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];

export const currentCycleTargetedCheckIds = (workflow: ProjectWorkflowState): string[] => {
  const decision = latestPlannerDecision(workflow);
  const recommendation = workflow.recommendations.find((entry) => entry.id === decision?.selectedRecommendationId) ?? workflow.recommendations[0];
  const explicit = unique([
    ...(workflow.cycleContract?.targetedChecklistItems.map((item) => item.checkId) ?? []),
    ...(workflow.scopedGoal?.targetedCheckIds ?? []),
    ...(workflow.approvedRecommendation?.targetedCheckIds ?? []),
    ...(decision?.targetedChecklistIds ?? []),
    ...(recommendation?.targetedCheckIds ?? [])
  ]).filter((entry) => entry.trim().length > 0);
  if (explicit.length > 0) {
    return explicit;
  }

  const title = workflow.approvedRecommendation?.title ?? recommendation?.title ?? workflow.autopilotStatus?.currentRecommendationTitle ?? "";
  const topic = title.match(/^Satisfy work package:\s*(.+)$/i)?.[1]?.trim().toLowerCase();
  const packageMatch = topic
    ? workflow.workPackages.find((workPackage) =>
      workPackage.primaryTopic.toLowerCase() === topic ||
      workPackage.title.toLowerCase().includes(topic)
    )
    : undefined;
  return packageMatch?.checkIds ?? [];
};

const deriveNotRecordedChecklistDelta = (workflow: ProjectWorkflowState, timestamp: string): ChecklistDelta => {
  const targetedCheckIds = currentCycleTargetedCheckIds(workflow);
  const byId = new Map(workflow.goalChecklist.map((check) => [check.id, check]));
  const targeted = targetedCheckIds.map((checkId) => byId.get(checkId)).filter((check): check is GoalAttainmentCheck => Boolean(check));
  const observations = workflow.evidenceObservations.filter((observation) => observation.cycleNumber === workflow.workflowCycle.cycleNumber);
  const evidenceNotConsumedReasons = observations.reduce((map, observation) => {
    if (observation.notConsumedReason) {
      map[observation.notConsumedReason] = (map[observation.notConsumedReason] ?? 0) + 1;
    }
    return map;
  }, {} as Partial<Record<ChecklistEvidenceNotConsumedReason, number>>);
  const targetedStillUnknown = targeted.filter((check) => check.status === "unknown").map((check) => check.id);
  const progress = workflow.ultimateGoalProgress?.percentComplete ?? percentRequiredMet(workflow.goalChecklist);
  return {
    schemaVersion: CHECKLIST_DELTA_SCHEMA_VERSION,
    cycleNumber: workflow.workflowCycle.cycleNumber,
    targetedTotal: targeted.length,
    targetedMetBefore: targeted.filter((check) => check.status === "met").length,
    targetedMetAfter: targeted.filter((check) => check.status === "met").length,
    targetedNewlyMet: [],
    targetedStillUnknown,
    targetedNeedsAttention: targeted.filter((check) => check.status === "unmet").map((check) => check.id),
    targetedNotApplicable: targeted.filter((check) => check.status === "not_applicable").map((check) => check.id),
    nonTargetedChanges: [],
    evidenceObservedCount: observations.length,
    evidenceConsumedCount: observations.filter((observation) => observation.consumedByChecklist).length,
    evidenceNotConsumedCount: observations.filter((observation) => !observation.consumedByChecklist).length,
    evidenceNotConsumedReasons,
    summaryForHumans: "Checklist delta was not recorded in the saved state; no checklist movement is inferred from legacy data.",
    didGoalProgressChange: false,
    goalProgressBefore: progress,
    goalProgressAfter: progress,
    whyStillUnknownByCheckId: Object.fromEntries(targetedStillUnknown.map((checkId) => [checkId, "not recorded in legacy state"])),
    createdAt: timestamp
  };
};

const commandPhase = (command: string): ValidationCommandPhase =>
  /\b(?:source-audit|evidence|audit|status|refresh|portfolio-analytics)\b/i.test(command) ? "evidence" : "integrity";

const commandStatus = (command: AgentCommandExecution): "passed" | "failed" | "skipped" | undefined => {
  if (command.exitCode === 0) {
    return "passed";
  }
  if (typeof command.exitCode === "number" && command.exitCode !== 0) {
    return "failed";
  }
  if (/pass|success|completed/i.test(command.status)) {
    return "passed";
  }
  if (/fail|error|cancel/i.test(command.status)) {
    return "failed";
  }
  if (/skip/i.test(command.status)) {
    return "skipped";
  }
  return undefined;
};

const commandResultFromLegacyCommand = (
  agent: AgentState,
  command: AgentCommandExecution,
  index: number
): ValidationCommandResult | undefined => {
  const status = commandStatus(command);
  if (!status) {
    return undefined;
  }
  const startedAt = command.startedAt;
  const endedAt = command.completedAt ?? command.startedAt;
  return buildValidationCommandResult({
    commandId: `${agent.id}:legacy-command:${command.itemId ?? index}`,
    command: command.command,
    phase: commandPhase(command.command),
    startedAt,
    endedAt,
    status,
    exitCode: command.exitCode,
    stdout: command.output,
    stderr: status === "failed" ? command.output : "",
    cwdKind: "unknown",
    fullOutputRef: agent.outputReference?.fullOutputAvailable ? `agent:${agent.id}:full-output` : undefined
  });
};

const commandResultFromIntegrityCheck = (
  agent: AgentState,
  check: NonNullable<AgentState["integrityReport"]>["checks"][number],
  index: number
): ValidationCommandResult =>
  buildValidationCommandResult({
    commandId: `${agent.id}:legacy-integrity:${index}`,
    command: check.command || check.name,
    phase: "integrity",
    startedAt: agent.integrityReport?.generatedAt ?? agent.completedAt ?? agent.lastActivityAt ?? agent.createdAt,
    endedAt: agent.integrityReport?.generatedAt ?? agent.completedAt ?? agent.lastActivityAt ?? agent.createdAt,
    status: check.status,
    stdout: check.status === "passed" ? check.outputSnippet : "",
    stderr: check.status === "failed" ? check.outputSnippet : "",
    cwdKind: "unknown"
  });

const latestCycleAgents = (workflow: ProjectWorkflowState, agents: AgentState[]): AgentState[] =>
  agents.filter((agent) =>
    agent.workflowCycleNumber === undefined || agent.workflowCycleNumber === workflow.workflowCycle.cycleNumber
  );

const deriveLegacyValidationLedger = (
  workflow: ProjectWorkflowState,
  agents: AgentState[],
  timestamp: string
) => {
  const currentAgents = latestCycleAgents(workflow, agents);
  const commandResults = currentAgents.flatMap((agent) =>
    agent.commandLog.flatMap((command, index) => commandResultFromLegacyCommand(agent, command, index) ?? [])
  );
  const integrityResults = currentAgents.flatMap((agent) =>
    (agent.integrityReport?.checks ?? []).map((check, index) => commandResultFromIntegrityCheck(agent, check, index))
  );
  const seenCommands = new Set(commandResults.map((result) => normalizeSpace(result.command).toLowerCase()));
  const dedupedIntegrityResults = integrityResults.filter((result) => !seenCommands.has(normalizeSpace(result.command).toLowerCase()));
  const planFailedCommands = workflow.strategicPlans
    .filter((plan) => plan.cycleNumber === workflow.workflowCycle.cycleNumber)
    .flatMap((plan) => plan.failedCommands);
  const retainedFailedCommands = planFailedCommands
    .filter((command) => command.trim())
    .filter((command) => ![...seenCommands].includes(normalizeSpace(command).toLowerCase()))
    .map((command, index) => buildValidationCommandResult({
      commandId: `legacy-failed-command:${workflow.workflowCycle.cycleNumber}:${index + 1}`,
      command,
      phase: commandPhase(command),
      startedAt: timestamp,
      endedAt: timestamp,
      status: "failed",
      stderr: "Legacy strategic plan recorded this command as failed, but full command output was not retained.",
      cwdKind: "unknown"
    }));
  const results = [...commandResults, ...dedupedIntegrityResults, ...retainedFailedCommands]
    .sort((left, right) => toTime(left.startedAt) - toTime(right.startedAt));
  const plannedCommands = unique([
    ...(workflow.cycleContract?.expectedValidationCommands ?? []),
    ...(workflow.cycleContract?.expectedEvidenceCommands ?? []),
    ...(workflow.scopedGoal?.testStrategy ?? []),
    ...workflow.evidenceCommands.map((command) => command.command),
    ...results.map((result) => result.command)
  ]);
  const ledger = createValidationLedger({
    cycleNumber: workflow.workflowCycle.cycleNumber,
    plannedCommands,
    testCommands: unique(plannedCommands.filter((command) => commandPhase(command) === "integrity")),
    evidenceCommands: unique(plannedCommands.filter((command) => commandPhase(command) === "evidence")),
    createdAt: timestamp
  });
  ledger.commandResults = results;
  ledger.warnings = [
    "Validation ledger was derived from legacy retained command data.",
    ...(results.length === 0 ? ["No command results were retained; validation remains not run."] : [])
  ];
  return finalizeValidationLedger(ledger, { updatedAt: timestamp });
};

const recentFallbackOutput = (workflow: ProjectWorkflowState, agents: AgentState[]): string | undefined => {
  const planOutputs = workflow.strategicPlans.flatMap((plan) => plan.recentAgentOutputs);
  const agentOutputs = agents.flatMap((agent) => [
    agent.lastMessageSnippet,
    agent.recommendationReport?.summary,
    ...agent.events.map((event) => event.detail)
  ]);
  return [...planOutputs, ...agentOutputs]
    .filter((entry): entry is string => Boolean(entry?.trim()))
    .find((entry) => /Structured recommendation output was invalid/i.test(entry));
};

const deriveRecommendationHealth = (
  health: RecommendationHealth,
  workflow: ProjectWorkflowState,
  agents: AgentState[],
  timestamp: string
): { health: RecommendationHealth; derived: boolean } => {
  if (health.fallbackUsedForCurrentRecommendation || health.totalStructuredAttempts > 0) {
    return { health, derived: false };
  }
  const fallbackOutput = recentFallbackOutput(workflow, agents);
  if (!fallbackOutput) {
    return { health, derived: false };
  }
  const failed = recordStructuredRecommendationFailure(health, {
    category: "schema_mismatch",
    message: fallbackOutput,
    at: timestamp
  });
  return {
    health: recordRecommendationFallbackUsed(failed, {
      reason: "Structured recommendation output was invalid in retained legacy output, so deterministic fallback was used.",
      candidateCount: workflow.recommendations.length || workflow.workPackages.length || 1,
      confidence: 0.5
    }),
    derived: true
  };
};

const deriveUnknownRepoHygiene = (workflow: ProjectWorkflowState, timestamp: string): RepoHygieneReport => ({
  status: "unknown",
  scannedAt: timestamp,
  scannedRef: `legacy:${workflow.workflowCycle.cycleNumber}:not-scanned`,
  forbiddenFiles: [],
  cleanedFiles: [],
  warnings: ["Repository hygiene was not scanned in the retained legacy state."],
  mergeBlockingFindings: [],
  summaryForHumans: "Repository hygiene is unknown because no scan was retained; merge remains blocked until hygiene passes."
});

export const workflowCycleTaskSeparation = (
  workflow: ProjectWorkflowState,
  cycleNumber: number
): WorkflowCycleTaskSeparation => {
  const retrospective = workflow.cycleRetrospectives.find((entry) => entry.cycleNumber === cycleNumber);
  if (retrospective) {
    return {
      cycleNumber,
      cycleStartedWithTask: retrospective.cycleContract?.selectedTaskTitle ?? retrospective.triedToDo,
      completedTask: retrospective.triedToDo || undefined,
      nextRecommendedTask: retrospective.nextRecommendedTasks[0]
    };
  }
  if (cycleNumber === workflow.workflowCycle.cycleNumber) {
    return {
      cycleNumber,
      cycleStartedWithTask: workflow.cycleContract?.selectedTaskTitle ??
        workflow.scopedGoal?.summary ??
        workflow.approvedRecommendation?.title ??
        workflow.autopilotStatus?.currentRecommendationTitle,
      completedTask: workflow.workflowCycle.completedAt ? workflow.scopedGoal?.summary ?? workflow.cycleContract?.selectedTaskTitle : undefined,
      nextRecommendedTask: workflow.recommendations[0]?.title
    };
  }
  const decision = workflow.memory.lastAcceptedDecisions.find((entry) => entry.cycleNumber === cycleNumber && entry.kind !== "merge") ??
    workflow.memory.lastAcceptedDecisions.find((entry) => entry.cycleNumber === cycleNumber);
  return {
    cycleNumber,
    cycleStartedWithTask: decision?.title
  };
};

export const deriveLegacyWorkflowDiagnostics = (
  workflow: ProjectWorkflowState,
  options: LegacyWorkflowDiagnosticsOptions = {}
): LegacyWorkflowDiagnosticsReport => {
  const timestamp = options.now ?? nowIso();
  const agents = options.agents ?? [];
  const report: LegacyWorkflowDiagnosticsReport = {
    cycleContractDerived: false,
    checklistDeltaDerived: false,
    validationLedgerDerived: false,
    recommendationHealthDerived: false,
    repoHygieneDerived: false
  };

  const health = deriveRecommendationHealth(workflow.recommendationHealth, workflow, agents, timestamp);
  if (health.derived) {
    workflow.recommendationHealth = health.health;
    report.recommendationHealthDerived = true;
  }

  if (!workflow.cycleContract || workflow.cycleContract.cycleNumber !== workflow.workflowCycle.cycleNumber) {
    const hasCycleContext = Boolean(
      workflow.approvedRecommendation ||
      workflow.scopedGoal ||
      workflow.plannerDecisions.some((decision) => decision.cycleNumber === workflow.workflowCycle.cycleNumber) ||
      workflow.recommendations.length > 0 ||
      workflow.workPackages.length > 0 ||
      workflow.goalChecklist.length > 0
    );
    if (hasCycleContext) {
      workflow.cycleContract = buildCycleContract(workflow, {
        now: timestamp,
        selectedTaskSource: "derived_from_legacy_state"
      });
      report.cycleContractDerived = true;
    }
  }

  if (
    options.deriveChecklistDelta !== false &&
    !workflow.checklistDeltas.some((delta) => delta.cycleNumber === workflow.workflowCycle.cycleNumber)
  ) {
    workflow.checklistDeltas = [
      deriveNotRecordedChecklistDelta(workflow, timestamp),
      ...workflow.checklistDeltas
    ].slice(0, 100);
    report.checklistDeltaDerived = true;
  }

  if (
    options.deriveValidationLedger !== false &&
    !workflow.validationLedgers.some((ledger) => ledger.cycleNumber === workflow.workflowCycle.cycleNumber)
  ) {
    workflow.validationLedgers = [
      deriveLegacyValidationLedger(workflow, agents, timestamp),
      ...workflow.validationLedgers
    ].slice(0, 40);
    report.validationLedgerDerived = true;
  }

  if (
    options.deriveRepoHygiene !== false &&
    !workflow.repoHygieneReports.some((reportEntry) => reportEntry.scannedRef.includes(`:${workflow.workflowCycle.cycleNumber}`))
  ) {
    workflow.repoHygieneReports = [
      deriveUnknownRepoHygiene(workflow, timestamp),
      ...workflow.repoHygieneReports
    ].slice(0, 60);
    report.repoHygieneDerived = true;
  }

  return report;
};

export const cycleContractForCycle = (workflow: ProjectWorkflowState, cycleNumber: number): CycleContract | undefined =>
  cycleNumber === workflow.workflowCycle.cycleNumber
    ? workflow.cycleContract
    : workflow.cycleRetrospectives.find((entry) => entry.cycleNumber === cycleNumber)?.cycleContract;
