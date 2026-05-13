import { nanoid } from "nanoid";
import { defaultWorkflowStepProgressState } from "./defaults";
import {
  canUseAgentRecommendationWhenDeterministicPackageExists,
  createDefaultAutopilotPolicy,
  getAutopilotMaxChecksPerWorkPackage,
  getAutopilotMaxNewRequiredChecksPerCycle,
  resolveEffectiveAutopilotPolicy,
  validateAutopilotPolicy
} from "./autopilotPolicy";
import type {
  AgentState,
  AutopilotPolicy,
  ProjectKind,
  ProjectWorkflowState,
  ScopedGoal,
  UltimateGoal,
  WorkPackage,
  WorkflowMode,
  WorkflowObjective,
  WorkflowPreviewRequest,
  WorkflowRecommendationOption,
  WorkflowStage,
  WorkflowStepId,
  WorkflowStepProgress,
  WorkflowStopReason
} from "./types";
import { nowIso } from "./utils";

export {
  canUseAgentRecommendationWhenDeterministicPackageExists,
  createDefaultAutopilotPolicy,
  getAutopilotMaxChecksPerWorkPackage,
  getAutopilotMaxNewRequiredChecksPerCycle,
  getAutopilotPolicyConfig,
  hasRepeatedAutopilotFailure,
  isHighRiskAutopilotRecommendation,
  resolveEffectiveAutopilotPolicy,
  shouldAutopilotPause,
  validateAutopilotPolicy
} from "./autopilotPolicy";

const activeAgentStatuses = new Set(["starting", "running", "waiting_approval"]);
const workflowPreviewStatuses = new Set(["none", "queued", "active", "ready", "completed", "cancelled"]);

const isAgentActive = (agent: AgentState): boolean => activeAgentStatuses.has(agent.status);

const normalizePreviewCycleCount = (value: unknown): number => {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 1;
  return Math.max(0, Math.min(3, numeric));
};

export const normalizeWorkflowPreviewRequest = (
  previewRequest?: Partial<WorkflowPreviewRequest> | null
): WorkflowPreviewRequest => {
  const status = workflowPreviewStatuses.has(previewRequest?.status ?? "")
    ? previewRequest?.status
    : "none";
  return {
    status: status ?? "none",
    remainingCycles: normalizePreviewCycleCount(previewRequest?.remainingCycles ?? 1),
    requestedAt: previewRequest?.requestedAt,
    startedAt: previewRequest?.startedAt,
    completedAt: previewRequest?.completedAt,
    modeBeforePreview: previewRequest?.modeBeforePreview === "fast" ? "fast" : previewRequest?.modeBeforePreview === "normal" ? "normal" : undefined,
    autopilotWasEnabled: previewRequest?.autopilotWasEnabled,
    reason: previewRequest?.reason,
    evidence: previewRequest?.evidence?.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).slice(0, 8)
  };
};

export const getWorkflowPreviewRequest = (
  workflow?: Pick<ProjectWorkflowState, "previewRequest"> | null
): WorkflowPreviewRequest => normalizeWorkflowPreviewRequest(workflow?.previewRequest);

export const isWorkflowPreviewPending = (
  workflow?: Pick<ProjectWorkflowState, "previewRequest"> | null
): boolean => {
  const status = getWorkflowPreviewRequest(workflow).status;
  return status === "queued" || status === "active";
};

export const isWorkflowPreviewReady = (
  workflow?: Pick<ProjectWorkflowState, "previewRequest"> | null
): boolean => getWorkflowPreviewRequest(workflow).status === "ready";

export const isPreviewRecommendation = (
  recommendation?: Pick<WorkflowRecommendationOption, "title" | "summary"> | null
): boolean => Boolean(
  recommendation &&
  /\bpreview\b/i.test(`${recommendation.title} ${recommendation.summary}`) &&
  /\b(?:generate|runnable|visible|checkpoint|inspect)\b/i.test(`${recommendation.title} ${recommendation.summary}`)
);

export interface WorkflowModeConfig {
  mode: WorkflowMode;
  maxChecksPerPackage: number;
  preferredMinChecksPerPackage: number;
  breadthLimit: number;
  deterministicRecommendationFirst: boolean;
  useRecommendationAgent: "always" | "when_no_high_confidence_package";
  useDeterministicScopingWhenClear: boolean;
  contextEntries: number;
  contextCharBudget: number;
  maxNewRequiredChecksPerCycle: number;
  finalAppealEnabled: boolean;
  groupedRequiredCheckBonus: number;
  genericStabilizationPenalty: number;
  highConfidencePackageThreshold: number;
}

export const normalizeWorkflowMode = (mode?: string): WorkflowMode =>
  mode === "fast" ? "fast" : "normal";

export const getWorkflowModeConfig = (mode?: string, policy?: AutopilotPolicy): WorkflowModeConfig => {
  const normalizedMode = normalizeWorkflowMode(mode);
  const effectivePolicy = policy ? validateAutopilotPolicy(policy) : undefined;
  const baseConfig: WorkflowModeConfig = normalizedMode === "fast"
    ? {
      mode: "fast",
      maxChecksPerPackage: 8,
      preferredMinChecksPerPackage: 4,
      breadthLimit: 3.5,
      deterministicRecommendationFirst: true,
      useRecommendationAgent: "when_no_high_confidence_package",
      useDeterministicScopingWhenClear: true,
      contextEntries: 3,
      contextCharBudget: 1_700,
      maxNewRequiredChecksPerCycle: 0,
      finalAppealEnabled: false,
      groupedRequiredCheckBonus: 92,
      genericStabilizationPenalty: 130,
      highConfidencePackageThreshold: 0.73
    }
    : {
    mode: "normal",
    maxChecksPerPackage: 4,
    preferredMinChecksPerPackage: 2,
    breadthLimit: 2,
    deterministicRecommendationFirst: false,
    useRecommendationAgent: "always",
    useDeterministicScopingWhenClear: true,
    contextEntries: 5,
    contextCharBudget: 2_600,
    maxNewRequiredChecksPerCycle: 2,
    finalAppealEnabled: true,
    groupedRequiredCheckBonus: 42,
    genericStabilizationPenalty: 70,
    highConfidencePackageThreshold: 0.78
  };

  if (!effectivePolicy) {
    return baseConfig;
  }

  const maxChecksPerPackage = getAutopilotMaxChecksPerWorkPackage(effectivePolicy, normalizedMode);
  return {
    ...baseConfig,
    maxChecksPerPackage,
    preferredMinChecksPerPackage: normalizedMode === "fast"
      ? Math.min(maxChecksPerPackage, Math.max(2, Math.ceil(maxChecksPerPackage / 2)))
      : Math.min(maxChecksPerPackage, Math.max(1, Math.ceil(maxChecksPerPackage / 2))),
    deterministicRecommendationFirst: effectivePolicy.preferGroupedChecklistPackages || baseConfig.deterministicRecommendationFirst,
    useRecommendationAgent: canUseAgentRecommendationWhenDeterministicPackageExists(effectivePolicy, normalizedMode)
      ? "always"
      : "when_no_high_confidence_package",
    useDeterministicScopingWhenClear: effectivePolicy.allowDeterministicScoping,
    maxNewRequiredChecksPerCycle: getAutopilotMaxNewRequiredChecksPerCycle(effectivePolicy, normalizedMode),
    highConfidencePackageThreshold: effectivePolicy.profile === "conservative"
      ? Math.min(0.92, baseConfig.highConfidencePackageThreshold + 0.05)
      : effectivePolicy.profile === "aggressive"
        ? Math.max(0.62, baseConfig.highConfidencePackageThreshold - 0.05)
        : baseConfig.highConfidencePackageThreshold
  };
};

export const latestAgentByCategory = (agents: AgentState[], category: AgentState["category"]): AgentState | undefined =>
  [...agents]
    .filter((agent) => agent.category === category)
    .sort((left, right) => {
      const leftTime = left.lastActivityAt ? new Date(left.lastActivityAt).getTime() : 0;
      const rightTime = right.lastActivityAt ? new Date(right.lastActivityAt).getTime() : 0;
      return rightTime - leftTime;
    })[0];

export const hasMeaningfulUltimateGoal = (goal?: UltimateGoal): boolean =>
  Boolean(
    goal &&
    (
      goal.summary.trim() ||
      goal.detailedIntent.trim() ||
      goal.targetAudience.trim() ||
      goal.qualityBar.trim() ||
      goal.successCriteria.length > 0 ||
      goal.constraints.length > 0 ||
      goal.nonGoals.length > 0
    )
  );

export const hasConfirmedUltimateGoal = (goal?: UltimateGoal): boolean => Boolean(goal?.confirmedAt && goal.summary.trim().length > 0);

export const hasSatisfiedUltimateGoal = (
  workflow: Pick<ProjectWorkflowState, "ultimateGoalCompletion">
): boolean => workflow.ultimateGoalCompletion?.state === "goal_satisfied";

export const isWorkflowAppealFinished = (
  workflow: Pick<ProjectWorkflowState, "appeal">
): boolean => workflow.appeal.status === "completed" || workflow.appeal.status === "not_applicable";

export const hasUnfinishedWorkflowAppeal = (
  workflow: Pick<ProjectWorkflowState, "appeal" | "ultimateGoalCompletion">
): boolean => hasSatisfiedUltimateGoal(workflow) && !isWorkflowAppealFinished(workflow);

export const hasBlockingHumanIntervention = (workflow: Pick<ProjectWorkflowState, "humanInterventions">): boolean =>
  workflow.humanInterventions.some((intervention) => intervention.blocking && intervention.status === "pending");

export const hasPendingAgentApprovals = (agents: AgentState[]): boolean =>
  agents.some((agent) => agent.category !== "manual" && agent.approvals.some((approval) => approval.status === "pending"));

export const getLatestPendingHumanIntervention = (workflow: Pick<ProjectWorkflowState, "humanInterventions">) =>
  workflow.humanInterventions
    .filter((intervention) => intervention.status === "pending")
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())[0];

export const createScopedGoalFromRecommendation = (
  recommendation: WorkflowRecommendationOption,
  ultimateGoal: UltimateGoal
): ScopedGoal => {
  const inheritedCriteria = ultimateGoal.successCriteria.slice(0, 3);
  const inheritedConstraints = ultimateGoal.constraints.slice(0, 3);
  const previewRecommendation = isPreviewRecommendation(recommendation);
  const scopedAcceptanceCriteria = previewRecommendation
    ? [
      "Create or stabilize a visible/runnable preview path for the current product structure.",
      "Show incomplete areas honestly with labeled demo/offline, empty, loading, error, or missing-credential states.",
      "Run the project-supported build or render validation needed to inspect the preview.",
      "Do not mark the Ultimate Goal complete unless its real checklist criteria are actually satisfied."
    ]
    : [
      recommendation.summary,
      `Deliver the change in a way that advances the ultimate goal: ${ultimateGoal.summary || "project charter alignment required"}.`,
      ...inheritedCriteria.map((criterion) => `Maintain or improve: ${criterion}`),
      ultimateGoal.qualityBar ? `Satisfy the quality bar for this slice: ${ultimateGoal.qualityBar}` : ""
    ].filter((entry) => entry.trim().length > 0);

  return {
    id: nanoid(),
    sourceRecommendationId: recommendation.id,
    sourceWorkPackageId: recommendation.sourceWorkPackageId,
    summary: recommendation.title,
    executionBrief: [
      previewRecommendation
        ? `Generate a bounded preview checkpoint: ${recommendation.title}.`
        : `Implement the approved next step: ${recommendation.title}.`,
      recommendation.rationale ? `Why now: ${recommendation.rationale}` : "",
      recommendation.expectedImpact ? `Expected impact: ${recommendation.expectedImpact}` : "",
      recommendation.relatedPaths.length ? `Likely files or areas: ${recommendation.relatedPaths.join(", ")}` : "",
      recommendation.targetedCheckIds?.length ? `Targeted checklist IDs: ${recommendation.targetedCheckIds.join(", ")}` : "",
      ultimateGoal.detailedIntent ? `Project intent: ${ultimateGoal.detailedIntent}` : "",
      previewRecommendation
        ? "Preview checkpoint rules: preserve offline/demo behavior, do not require paid services or secrets, label mock data clearly, and keep live integrations honest with explicit missing-credential states."
        : ""
    ]
      .filter((entry) => entry.length > 0)
      .join("\n\n"),
    acceptanceCriteria: scopedAcceptanceCriteria,
    constraints: [
      ...inheritedConstraints,
      ...ultimateGoal.nonGoals.slice(0, 2).map((nonGoal) => `Do not spend this cycle on non-goal: ${nonGoal}`),
      ...(previewRecommendation
        ? [
          "Do not fake live data or embed secrets.",
          "Do not skip validation, approval, or merge safety.",
          "Do not use preview readiness as final project completion."
        ]
        : [])
    ],
    testStrategy: [
      "Run the relevant deterministic verification commands before considering the task complete.",
      previewRecommendation
        ? "Verify the preview path can be inspected locally or that the relevant UI renders under the repo's supported tooling."
        : "Verify the implementation satisfies the scoped goal and still aligns with the ultimate goal."
    ],
    targetedCheckIds: recommendation.targetedCheckIds,
    likelyPaths: recommendation.relatedPaths,
    createdAt: nowIso()
  };
};

export interface WorkPackageScopedGoalOptions {
  mode?: WorkflowMode;
  now?: string;
  sourceRecommendationId?: string;
  requireModelForHighRisk?: boolean;
  autopilotPolicy?: AutopilotPolicy;
}

const scopedGoalHighRiskPattern =
  /\b(?:credential|credentials|secret|secrets|api key|token|oauth|approval policy|approval|ipc|preload|renderer\/main|main process|node api|contextisolation|nodeintegration|runtime command|command execution|sandbox|network policy|merge logic|workflow state machine|persistent storage|storage migration|migration|local credential|git push|git commit|privileged)\b/i;

const normalizeScopedGoalText = (value: string): string => value.trim().replace(/\s+/g, " ");

const truncateScopedGoalText = (value: string, maxLength: number): string => {
  const normalized = normalizeScopedGoalText(value);
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
};

const uniqueScopedGoalList = (values: string[], limit: number): string[] =>
  [...new Set(values.map(normalizeScopedGoalText).filter(Boolean))].slice(0, limit);

const workflowChecksForPackage = (
  workflow: ProjectWorkflowState,
  workPackage: WorkPackage
): ProjectWorkflowState["goalChecklist"] => {
  const targetIds = new Set(workPackage.checkIds);
  return workflow.goalChecklist.filter((check) => targetIds.has(check.id));
};

export const workPackageRequiresModelScoping = (
  workPackage: WorkPackage,
  workflow: ProjectWorkflowState,
  options: WorkPackageScopedGoalOptions = {}
): boolean => {
  if (options.requireModelForHighRisk !== false && workPackage.riskLevel === "high") {
    return true;
  }
  const checks = workflowChecksForPackage(workflow, workPackage);
  const highRiskText = [
    workPackage.title,
    workPackage.summary,
    workPackage.reason,
    workPackage.primaryTopic,
    ...workPackage.acceptanceHints,
    ...workPackage.likelyPaths,
    ...checks.flatMap((check) => [check.title, check.description, check.evidence, ...check.relatedPaths])
  ].join(" ");
  return scopedGoalHighRiskPattern.test(highRiskText);
};

export const createScopedGoalFromWorkPackage = (
  workPackage: WorkPackage,
  workflow: ProjectWorkflowState,
  options: WorkPackageScopedGoalOptions = {}
): ScopedGoal | undefined => {
  const modeConfig = getWorkflowModeConfig(options.mode ?? workflow.workflowMode, options.autopilotPolicy);
  if (!modeConfig.useDeterministicScopingWhenClear) {
    return undefined;
  }
  if (
    workPackage.checkIds.length === 0 ||
    workPackage.acceptanceHints.length === 0 ||
    workPackage.confidence < (modeConfig.mode === "fast" ? 0.68 : 0.74) ||
    workPackage.estimatedBreadth === "large" ||
    workPackageRequiresModelScoping(workPackage, workflow, options)
  ) {
    return undefined;
  }

  const targetedChecks = workflowChecksForPackage(workflow, workPackage);
  const targetedTitles = targetedChecks.length
    ? targetedChecks.map((check) => truncateScopedGoalText(check.title, 120))
    : workPackage.checkIds;
  const inheritedConstraints = workflow.ultimateGoal.constraints.slice(0, 3);
  const nonGoalConstraints = workflow.ultimateGoal.nonGoals
    .slice(0, 2)
    .map((nonGoal) => `Do not spend this cycle on non-goal: ${nonGoal}`);
  const likelyPathBrief = workPackage.likelyPaths.length
    ? `Likely files or areas: ${workPackage.likelyPaths.join(", ")}.`
    : "Use repository search to keep edits inside the smallest coherent implementation area.";
  const targetedCheckBrief = targetedTitles.length
    ? `Target required checks: ${targetedTitles.join("; ")}.`
    : `Target checklist IDs: ${workPackage.checkIds.join(", ")}.`;

  return {
    id: nanoid(),
    sourceRecommendationId: options.sourceRecommendationId ?? workPackage.id,
    sourceWorkPackageId: workPackage.id,
    summary: `Satisfy ${truncateScopedGoalText(workPackage.primaryTopic || workPackage.title, 82)}`,
    executionBrief: [
      `Implement this deterministic work package: ${workPackage.title}.`,
      workPackage.summary,
      workPackage.reason ? `Why this grouping is safe: ${workPackage.reason}` : "",
      targetedCheckBrief,
      likelyPathBrief,
      workflow.ultimateGoal.summary ? `Ultimate Goal: ${workflow.ultimateGoal.summary}` : ""
    ].filter((entry) => entry.trim().length > 0).join("\n\n"),
    acceptanceCriteria: uniqueScopedGoalList([
      `The targeted required checks are satisfied with direct repository evidence: ${targetedTitles.join("; ")}.`,
      ...workPackage.acceptanceHints,
      "No unrelated backlog, polish, or new required checklist scope is introduced by this pass."
    ], 6),
    constraints: uniqueScopedGoalList([
      ...inheritedConstraints,
      ...nonGoalConstraints,
      "Keep the work scoped to this coherent work package.",
      "Preserve existing approval, credential, merge, IPC, renderer/main, and runtime safety boundaries."
    ], 6),
    testStrategy: uniqueScopedGoalList([
      workPackage.likelyPaths.some((entry) => /\.(test|spec)\./i.test(entry))
        ? `Run or update the targeted tests around: ${workPackage.likelyPaths.filter((entry) => /\.(test|spec)\./i.test(entry)).slice(0, 3).join(", ")}.`
        : "Run focused deterministic checks for the changed files or modules.",
      "Run broader repository validation when shared runtime, state, or integration behavior changes.",
      "Verify the goal checklist evidence directly names the targeted checks and relevant paths."
    ], 4),
    targetedCheckIds: workPackage.checkIds,
    likelyPaths: workPackage.likelyPaths,
    createdAt: options.now ?? nowIso()
  };
};

export const deriveWorkflowProjection = (
  workflow: ProjectWorkflowState,
  agents: AgentState[]
): {
  stage: WorkflowStage;
  stopReason: WorkflowStopReason;
  cycleStatus: ProjectWorkflowState["workflowCycle"]["status"];
} => {
  if (hasBlockingHumanIntervention(workflow)) {
    return {
      stage: "blocked_human",
      stopReason: "human_intervention_required",
      cycleStatus: "blocked_human"
    };
  }

  if (!hasConfirmedUltimateGoal(workflow.ultimateGoal)) {
    return {
      stage: "charter_needed",
      stopReason: "charter_missing",
      cycleStatus: workflow.workflowCycle.status === "completed" ? "completed" : "idle"
    };
  }

  const latestIntegrityAgent = latestAgentByCategory(agents, "integrity");
  const latestMergeAgent = latestAgentByCategory(agents, "merge");
  const recommendationAgentActive = agents.some((agent) => agent.category === "recommendation" && isAgentActive(agent));
  const mergeHasCurrentProgress = workflow.stepProgress.merge.status !== "not_started";
  const integrityHasCurrentProgress = workflow.stepProgress.integrity.status !== "not_started";
  const repairStatus = workflow.repair.status;

  if (workflow.workflowCycle.status === "completed") {
    if (hasUnfinishedWorkflowAppeal(workflow)) {
      if (workflow.stepProgress.recommendation.status === "running" || recommendationAgentActive) {
        return {
          stage: "appeal_pending",
          stopReason: "appeal_missing",
          cycleStatus: "completed"
        };
      }

      return {
        stage: "appeal_pending",
        stopReason: workflow.recommendations.length > 0 ? "awaiting_appeal_approval" : "appeal_missing",
        cycleStatus: "completed"
      };
    }

    if (workflow.stepProgress.recommendation.status === "running" || recommendationAgentActive) {
      return {
        stage: "recommendation_pending",
        stopReason: "recommendation_missing",
        cycleStatus: "completed"
      };
    }

    if (workflow.recommendations.length > 0) {
      return {
        stage: "recommendation_pending",
        stopReason: "awaiting_recommendation_approval",
        cycleStatus: "completed"
      };
    }

    if (hasSatisfiedUltimateGoal(workflow)) {
      return {
        stage: "cycle_complete",
        stopReason: "ultimate_goal_satisfied",
        cycleStatus: "completed"
      };
    }

    return {
      stage: "cycle_complete",
      stopReason: "cycle_completed",
      cycleStatus: "completed"
    };
  }

  if (mergeHasCurrentProgress && latestMergeAgent?.mergeReport?.conflicts.length) {
    return {
      stage: "repair_loop",
      stopReason: "merge_conflicts",
      cycleStatus: "repair_loop"
    };
  }

  if (repairStatus === "merge_conflicts") {
    return {
      stage: "repair_loop",
      stopReason: "merge_conflicts",
      cycleStatus: "repair_loop"
    };
  }

  if (
    workflow.stepProgress.merge.status === "completed" ||
    (mergeHasCurrentProgress && latestMergeAgent?.status === "completed" && latestMergeAgent.mergeReport?.conflicts.length === 0)
  ) {
    return {
      stage: "merged",
      stopReason: "none",
      cycleStatus: "merged"
    };
  }

  if (repairStatus === "exhausted") {
    return {
      stage: "repair_loop",
      stopReason: workflow.repair.attemptCount >= workflow.repair.maxAttempts
        ? "repair_budget_exhausted"
        : "repair_stopped_early",
      cycleStatus: "repair_loop"
    };
  }

  if (repairStatus === "repairing" || repairStatus === "retrying_validation") {
    return {
      stage: "repair_loop",
      stopReason: "integrity_failed",
      cycleStatus: "repair_loop"
    };
  }

  const integrityFailed =
    workflow.stepProgress.integrity.status === "failed" ||
    (integrityHasCurrentProgress &&
      (
        latestIntegrityAgent?.status === "failed" ||
        latestIntegrityAgent?.integrityReport?.checks.some((check) => check.status === "failed")
      ));
  if (integrityFailed) {
    return {
      stage: "repair_loop",
      stopReason:
        workflow.repairLoopCount >= workflow.workflowBudgets.maxRepairLoops ? "repair_budget_exhausted" : "integrity_failed",
      cycleStatus: "repair_loop"
    };
  }

  if (
    workflow.stepProgress.integrity.status === "completed" ||
    (
      integrityHasCurrentProgress &&
      latestIntegrityAgent?.status === "completed" &&
      latestIntegrityAgent.integrityReport?.checks.every((check) => check.status !== "failed")
    )
  ) {
    return {
      stage: "ready_to_merge",
      stopReason: "none",
      cycleStatus: "ready_to_merge"
    };
  }

  if (workflow.stepProgress.integrity.status === "running" || agents.some((agent) => agent.category === "integrity" && isAgentActive(agent))) {
    return {
      stage: "integrity_running",
      stopReason: "none",
      cycleStatus: "integrity"
    };
  }

  if (workflow.stepProgress.coding.status === "running" || agents.some((agent) => agent.category === "coding" && isAgentActive(agent))) {
    return {
      stage: "coding_running",
      stopReason: "none",
      cycleStatus: "coding"
    };
  }

  if (workflow.scopedGoal?.summary.trim()) {
    return {
      stage: "goal_ready",
      stopReason: "none",
      cycleStatus: "goal_ready"
    };
  }

  if (workflow.approvedRecommendation || workflow.workflowCycle.approvedRecommendationId) {
    return {
      stage: "recommendation_approved",
      stopReason: "goal_not_scoped",
      cycleStatus: "recommendation_approved"
    };
  }

  if (workflow.recommendations.length > 0) {
    return {
      stage: "recommendation_pending",
      stopReason: "awaiting_recommendation_approval",
      cycleStatus: "idle"
    };
  }

  return {
    stage: "recommendation_pending",
    stopReason: "recommendation_missing",
    cycleStatus: "idle"
  };
};

export const ensureWorkflowStepProgressState = (
  workflow: Pick<ProjectWorkflowState, "stepProgress" | "workflowStage" | "humanInterventions" | "ultimateGoal" | "recommendations" | "approvedRecommendation" | "scopedGoal" | "repair">
): Record<WorkflowStepId, WorkflowStepProgress> => {
  const defaults = defaultWorkflowStepProgressState();
  const next = Object.fromEntries(
    Object.entries(defaults).map(([stepId, defaultProgress]) => {
      const existing = workflow.stepProgress?.[stepId as WorkflowStepId];
      const normalizedStatus =
        workflow.workflowStage !== "blocked_human" && existing?.status === "blocked"
          ? existing.completedAt
            ? "completed"
            : existing.startedAt
              ? "running"
              : existing.requiresUserInput
                ? "waiting"
                : "not_started"
          : existing?.status;
      return [
        stepId,
        {
          ...defaultProgress,
          ...existing,
          status: normalizedStatus ?? existing?.status ?? defaultProgress.status,
          stepId: stepId as WorkflowStepId
        }
      ];
    })
  ) as Record<WorkflowStepId, WorkflowStepProgress>;

  if (!hasConfirmedUltimateGoal(workflow.ultimateGoal)) {
    next.ultimate_goal.status = "waiting";
    next.ultimate_goal.requiresUserInput = true;
  } else if (next.ultimate_goal.status !== "completed") {
    next.ultimate_goal.status = "completed";
    next.ultimate_goal.requiresUserInput = false;
    next.ultimate_goal.completedAt ??= workflow.ultimateGoal.confirmedAt;
    next.ultimate_goal.updatedAt ??= workflow.ultimateGoal.confirmedAt;
  }

  if (
    workflow.recommendations.length > 0 &&
    (workflow.workflowStage === "recommendation_pending" || !workflow.approvedRecommendation) &&
    next.recommendation.status === "not_started"
  ) {
    next.recommendation.status = "waiting";
    next.recommendation.requiresUserInput = true;
  }

  if (
    workflow.approvedRecommendation &&
    !(workflow.workflowStage === "recommendation_pending" && workflow.recommendations.length > 0) &&
    next.recommendation.status !== "completed"
  ) {
    next.recommendation.status = "completed";
    next.recommendation.requiresUserInput = false;
    next.recommendation.completedAt ??= workflow.approvedRecommendation.approvedAt;
    next.recommendation.updatedAt ??= workflow.approvedRecommendation.approvedAt;
  }

  if (workflow.scopedGoal && next.goal_plan.status !== "completed") {
    next.goal_plan.status = "completed";
    next.goal_plan.requiresUserInput = false;
    next.goal_plan.completedAt ??= workflow.scopedGoal.createdAt;
    next.goal_plan.updatedAt ??= workflow.scopedGoal.createdAt;
  }

  if (workflow.workflowStage === "blocked_human") {
    const blockedStepId = getWorkflowActiveStepId(workflow);
    const pendingIntervention = getLatestPendingHumanIntervention(workflow);
    next[blockedStepId].status = "blocked";
    next[blockedStepId].requiresUserInput = true;
    next[blockedStepId].blockedReason ??= pendingIntervention?.description ?? pendingIntervention?.reason;
  }

  return next;
};

export const getWorkflowActiveStepId = (
  workflow: Pick<ProjectWorkflowState, "workflowStage" | "humanInterventions" | "approvedRecommendation" | "scopedGoal" | "ultimateGoal" | "stepProgress" | "repair">
): WorkflowStepId => {
  switch (workflow.workflowStage) {
    case "charter_needed":
      return "ultimate_goal";
    case "recommendation_pending":
      return "recommendation";
    case "recommendation_approved":
      return "goal_plan";
    case "goal_ready":
    case "coding_running":
      return "coding";
    case "repair_loop":
      if (workflow.stepProgress.merge.status === "running" || workflow.stepProgress.merge.status === "failed" || workflow.repair.status === "merge_conflicts") {
        return "merge";
      }
      if (workflow.stepProgress.integrity.status === "running" || workflow.repair.status === "retrying_validation") {
        return "integrity";
      }
      return "coding";
    case "integrity_running":
      return "integrity";
    case "ready_to_merge":
    case "merged":
    case "cycle_complete":
      return "merge";
    case "appeal_pending":
      return "recommendation";
    case "blocked_human": {
      if (workflow.stepProgress.merge.status === "running" || workflow.stepProgress.merge.status === "failed") {
        return "merge";
      }
      if (workflow.stepProgress.integrity.status === "running" || workflow.stepProgress.integrity.status === "failed") {
        return "integrity";
      }
      if (workflow.stepProgress.coding.status === "running" || workflow.stepProgress.coding.status === "failed" || workflow.scopedGoal) {
        return "coding";
      }
      if (workflow.approvedRecommendation) {
        return "goal_plan";
      }
      if (hasConfirmedUltimateGoal(workflow.ultimateGoal)) {
        return "recommendation";
      }
      return "ultimate_goal";
    }
  }
};

export type WorkflowAutomationAction =
  | "generate_recommendations"
  | "approve_recommendation"
  | "create_scoped_goal"
  | "start_coding"
  | "repair_coding"
  | "run_integrity"
  | "run_merge"
  | "finalize_cycle";

const recommendationPriorityScore = (priority: WorkflowRecommendationOption["priority"]): number =>
  ({
    high: 0,
    medium: 1,
    low: 2
  })[priority];

const normalizeRecommendationMatchText = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();

const recommendationText = (recommendation: WorkflowRecommendationOption): string =>
  [
    recommendation.title,
    recommendation.summary,
    recommendation.rationale,
    recommendation.expectedImpact
  ].map(normalizeRecommendationMatchText).join(" ");

const openRequiredGoalChecks = (
  workflow?: Pick<ProjectWorkflowState, "goalChecklist">
): ProjectWorkflowState["goalChecklist"] =>
  workflow?.goalChecklist.filter((check) =>
    check.required &&
    (check.itemKind ?? (check.required ? "required" : "backlog")) === "required" &&
    check.status !== "met" &&
    check.status !== "not_applicable"
  ) ?? [];

const goalCheckSourceScore = (source: ProjectWorkflowState["goalChecklist"][number]["source"]): number =>
  ({
    success_criterion: 80,
    quality_bar: 70,
    constraint: 58,
    deterministic: 48,
    agent: 42
  })[source] ?? 0;

const goalCheckStatusScore = (status: ProjectWorkflowState["goalChecklist"][number]["status"]): number =>
  status === "unmet" ? 16 : status === "unknown" ? 10 : 0;

const checklistAlignmentScore = (
  recommendation: WorkflowRecommendationOption,
  workflow?: Pick<ProjectWorkflowState, "goalChecklist"> & { workflowMode?: WorkflowMode; autopilotPolicy?: AutopilotPolicy }
): number => {
  const autopilotPolicy = workflow?.autopilotPolicy
    ? resolveEffectiveAutopilotPolicy({ autopilotPolicy: workflow.autopilotPolicy })
    : undefined;
  const modeConfig = getWorkflowModeConfig(workflow?.workflowMode, autopilotPolicy);
  const text = recommendationText(recommendation);
  const title = recommendation.title.trim();
  const openChecks = openRequiredGoalChecks(workflow);
  let score = 0;

  const isGoalCheckRecommendation = /^satisfy goal check:/i.test(title);
  const isGoalBatchRecommendation = /^satisfy goal batch:/i.test(title);
  const isWorkPackageRecommendation = /^satisfy work package:/i.test(title);
  if (isGoalBatchRecommendation || isWorkPackageRecommendation) {
    score += 240 + modeConfig.groupedRequiredCheckBonus;
  } else if (isGoalCheckRecommendation) {
    score += 100;
  }
  if (/\b(?:goal checklist|required check|checklist item|work package)\b/i.test(`${recommendation.summary} ${recommendation.rationale}`)) {
    score += 34;
  }
  if (/\b(?:related required checks|multiple required|coherent batch|coherent work package|shared code|shared implementation)\b/i.test(`${recommendation.summary} ${recommendation.rationale} ${recommendation.expectedImpact}`)) {
    score += 24;
  }
  if (/\bUltimate Goal percentage\b/i.test(recommendation.expectedImpact)) {
    score += 28;
  }

  let matchedChecks = 0;
  const targetedCheckIds = new Set(recommendation.targetedCheckIds ?? []);
  for (const check of openChecks) {
    const candidates = [check.title, check.description]
      .map(normalizeRecommendationMatchText)
      .filter((entry) => entry.length >= 8);
    if (targetedCheckIds.has(check.id) || candidates.some((candidate) => text.includes(candidate) || candidate.includes(text))) {
      score += goalCheckSourceScore(check.source) + goalCheckStatusScore(check.status) + (targetedCheckIds.has(check.id) ? 34 : 0);
      matchedChecks += 1;
      if ((!isGoalBatchRecommendation && !isWorkPackageRecommendation) || matchedChecks >= modeConfig.maxChecksPerPackage) {
        break;
      }
    }
  }

  if ((isGoalBatchRecommendation || isWorkPackageRecommendation) && matchedChecks > 1) {
    score += matchedChecks * (modeConfig.mode === "fast" ? 36 : 18);
  }
  if (openChecks.length > 0 && matchedChecks === 0 && !isGoalBatchRecommendation && !isWorkPackageRecommendation && !isGoalCheckRecommendation) {
    score -= modeConfig.mode === "fast" ? 170 : 115;
  }
  if (recommendation.confidence < 0.68) {
    score -= Math.round((0.68 - recommendation.confidence) * 180);
  }
  if (recommendation.riskLevel === "high" && !/security|credential|approval|runtime|integrity|validation|sandbox|safety/i.test(`${title} ${recommendation.summary}`)) {
    score -= 64;
  } else if (recommendation.riskLevel === "medium") {
    score -= 12;
  }

  if (openChecks.length > 0 && /\b(?:stabilize recent work|operator feedback|package\/startup|startup-readiness|test-harness)\b/i.test(title)) {
    score -= modeConfig.genericStabilizationPenalty;
  }
  if (openChecks.length > 0 && /\b(?:polish|cleanup|clean up|nice to have|fit and finish|optimi[sz]e|generic)\b/i.test(`${title} ${recommendation.summary}`)) {
    score -= Math.round(modeConfig.genericStabilizationPenalty * 0.7);
  }

  return score;
};

const isAutopilotRecommendationCandidate = (
  recommendation: WorkflowRecommendationOption,
  workflow?: Pick<ProjectWorkflowState, "goalChecklist"> & { workflowMode?: WorkflowMode; autopilotPolicy?: AutopilotPolicy }
): boolean => {
  if (recommendation.estimatedScope === "large" || recommendation.confidence < 0.55) {
    return false;
  }
  const openChecks = openRequiredGoalChecks(workflow);
  if (openChecks.length === 0) {
    return true;
  }
  const title = recommendation.title.trim();
  const targetsRequiredChecks = /^Satisfy (?:goal (?:check|batch)|work package):/i.test(title) ||
    (recommendation.targetedCheckIds?.some((checkId) => openChecks.some((check) => check.id === checkId)) ?? false);
  if (targetsRequiredChecks) {
    return true;
  }
  return !/\b(?:backlog|polish|cleanup|clean up|nice to have|fit and finish|generic)\b/i.test(`${title} ${recommendation.summary}`);
};

export const pickAutopilotRecommendation = (
  recommendations: WorkflowRecommendationOption[],
  workflow?: Pick<ProjectWorkflowState, "goalChecklist"> & { workflowMode?: WorkflowMode; autopilotPolicy?: AutopilotPolicy }
): WorkflowRecommendationOption | undefined =>
  [...recommendations]
    .filter((recommendation) => isAutopilotRecommendationCandidate(recommendation, workflow))
    .sort((left, right) =>
      (isPreviewRecommendation(right) ? 1 : 0) - (isPreviewRecommendation(left) ? 1 : 0) ||
      checklistAlignmentScore(right, workflow) - checklistAlignmentScore(left, workflow) ||
      right.confidence - left.confidence ||
      recommendationPriorityScore(left.priority) - recommendationPriorityScore(right.priority) ||
      left.rank - right.rank ||
      left.title.localeCompare(right.title)
    )[0];

export const getNextWorkflowAutomationAction = (
  workflow: ProjectWorkflowState,
  agents: AgentState[],
  projectKind: ProjectKind,
  autopilot: boolean | AutopilotPolicy = false,
  workflowPauseRequested = false,
  workflowObjective: WorkflowObjective = "deliver"
): WorkflowAutomationAction | null => {
  const autopilotPolicy = typeof autopilot === "boolean"
    ? createDefaultAutopilotPolicy(autopilot)
    : validateAutopilotPolicy(autopilot);
  const autopilotEnabled = autopilotPolicy.enabled;
  const recommendationAgentActive = agents.some((agent) => agent.category === "recommendation" && isAgentActive(agent));
  const goalAgentActive = agents.some((agent) => agent.category === "goal" && isAgentActive(agent));
  const codingAgentActive = agents.some((agent) => agent.category === "coding" && isAgentActive(agent));
  const integrityAgentActive = agents.some((agent) => agent.category === "integrity" && isAgentActive(agent));
  const mergeAgentActive = agents.some((agent) => agent.category === "merge" && isAgentActive(agent));

  if (isWorkflowPreviewReady(workflow)) {
    return null;
  }

  if (getWorkflowPreviewRequest(workflow).status === "queued" && (codingAgentActive || integrityAgentActive || mergeAgentActive)) {
    return null;
  }

  if (workflowPauseRequested) {
    return null;
  }

  if (hasBlockingHumanIntervention(workflow) || hasPendingAgentApprovals(agents)) {
    return null;
  }

  if (!hasConfirmedUltimateGoal(workflow.ultimateGoal)) {
    return null;
  }

  if (workflow.repair.status === "exhausted" || workflow.workflowStopReason === "repair_budget_exhausted" || workflow.workflowStopReason === "merge_conflicts") {
    return null;
  }

  if (workflow.workflowCycle.status === "completed") {
    if (workflowObjective === "deliver" && hasSatisfiedUltimateGoal(workflow) && isWorkflowAppealFinished(workflow)) {
      return null;
    }
    if (workflow.recommendations.length > 0) {
      return autopilotEnabled ? "approve_recommendation" : null;
    }
    if (workflow.stepProgress.recommendation.status === "running" || recommendationAgentActive) {
      return null;
    }
    return "generate_recommendations";
  }

  if (!workflow.approvedRecommendation && workflow.recommendations.length === 0) {
    if (workflow.stepProgress.recommendation.status === "running" || recommendationAgentActive) {
      return null;
    }
    return "generate_recommendations";
  }

  if (!workflow.approvedRecommendation && workflow.recommendations.length > 0) {
    return autopilotEnabled ? "approve_recommendation" : null;
  }

  if (workflow.approvedRecommendation && !workflow.scopedGoal) {
    if (workflow.stepProgress.goal_plan.status === "running" || goalAgentActive) {
      return null;
    }
    return "create_scoped_goal";
  }

  if (workflow.repair.status === "repairing") {
    if (workflow.stepProgress.coding.status === "running" || codingAgentActive) {
      return null;
    }
    if (
      workflow.stepProgress.coding.status === "completed" &&
      workflow.stepProgress.integrity.status !== "running" &&
      !integrityAgentActive &&
      workflow.stepProgress.integrity.status !== "completed"
    ) {
      return "run_integrity";
    }
    return "repair_coding";
  }

  if (workflow.repair.status === "retrying_validation") {
    return workflow.stepProgress.integrity.status === "running" || integrityAgentActive ? null : "run_integrity";
  }

  if (workflow.workflowStage === "repair_loop" && workflow.workflowStopReason === "integrity_failed") {
    return workflow.stepProgress.coding.status === "running" || codingAgentActive ? null : "repair_coding";
  }

  if (
    workflow.scopedGoal &&
    workflow.stepProgress.coding.status !== "running" &&
    !codingAgentActive &&
    workflow.stepProgress.coding.status !== "completed"
  ) {
    return "start_coding";
  }

  if (
    workflow.stepProgress.coding.status === "completed" &&
    workflow.stepProgress.integrity.status !== "running" &&
    !integrityAgentActive &&
    workflow.stepProgress.integrity.status !== "completed"
  ) {
    return "run_integrity";
  }

  if (
    workflow.stepProgress.integrity.status === "completed" &&
    workflow.stepProgress.merge.status !== "running" &&
    !mergeAgentActive &&
    workflow.stepProgress.merge.status !== "completed"
  ) {
    return "run_merge";
  }

  if (
    workflow.workflowCycle.status === "merged" ||
    (projectKind === "folder" && workflow.stepProgress.merge.status === "completed" && workflow.workflowStage === "merged")
  ) {
    return "finalize_cycle";
  }

  return null;
};
