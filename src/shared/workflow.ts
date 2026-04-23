import { nanoid } from "nanoid";
import { defaultWorkflowStepProgressState } from "./defaults";
import type {
  AgentState,
  ProjectKind,
  ProjectWorkflowState,
  ScopedGoal,
  UltimateGoal,
  WorkflowObjective,
  WorkflowRecommendationOption,
  WorkflowStage,
  WorkflowStepId,
  WorkflowStepProgress,
  WorkflowStopReason
} from "./types";
import { nowIso } from "./utils";

const activeAgentStatuses = new Set(["starting", "running", "waiting_approval"]);

const isAgentActive = (agent: AgentState): boolean => activeAgentStatuses.has(agent.status);

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
  const scopedAcceptanceCriteria = [
    recommendation.summary,
    `Deliver the change in a way that advances the ultimate goal: ${ultimateGoal.summary || "project charter alignment required"}.`,
    ...inheritedCriteria.map((criterion) => `Maintain or improve: ${criterion}`),
    ultimateGoal.qualityBar ? `Satisfy the quality bar for this slice: ${ultimateGoal.qualityBar}` : ""
  ].filter((entry) => entry.trim().length > 0);

  return {
    id: nanoid(),
    sourceRecommendationId: recommendation.id,
    summary: recommendation.title,
    executionBrief: [
      `Implement the approved next step: ${recommendation.title}.`,
      recommendation.rationale ? `Why now: ${recommendation.rationale}` : "",
      recommendation.expectedImpact ? `Expected impact: ${recommendation.expectedImpact}` : "",
      recommendation.relatedPaths.length ? `Likely files or areas: ${recommendation.relatedPaths.join(", ")}` : "",
      ultimateGoal.detailedIntent ? `Project intent: ${ultimateGoal.detailedIntent}` : ""
    ]
      .filter((entry) => entry.length > 0)
      .join("\n\n"),
    acceptanceCriteria: scopedAcceptanceCriteria,
    constraints: [
      ...inheritedConstraints,
      ...ultimateGoal.nonGoals.slice(0, 2).map((nonGoal) => `Do not spend this cycle on non-goal: ${nonGoal}`)
    ],
    testStrategy: [
      "Run the relevant deterministic verification commands before considering the task complete.",
      "Verify the implementation satisfies the scoped goal and still aligns with the ultimate goal."
    ],
    createdAt: nowIso()
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

  if (
    mergeHasCurrentProgress &&
    (workflow.stepProgress.merge.status === "failed" || latestMergeAgent?.mergeReport?.conflicts.length)
  ) {
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
  workflow?: Pick<ProjectWorkflowState, "goalChecklist">
): number => {
  const text = recommendationText(recommendation);
  const title = recommendation.title.trim();
  const openChecks = openRequiredGoalChecks(workflow);
  let score = 0;

  if (/^satisfy goal check:/i.test(title)) {
    score += 100;
  }
  if (/\b(?:goal checklist|required check|checklist item)\b/i.test(`${recommendation.summary} ${recommendation.rationale}`)) {
    score += 34;
  }
  if (/\bUltimate Goal percentage\b/i.test(recommendation.expectedImpact)) {
    score += 28;
  }

  for (const check of openChecks) {
    const candidates = [check.title, check.description]
      .map(normalizeRecommendationMatchText)
      .filter((entry) => entry.length >= 8);
    if (candidates.some((candidate) => text.includes(candidate) || candidate.includes(text))) {
      score += goalCheckSourceScore(check.source) + goalCheckStatusScore(check.status);
      break;
    }
  }

  if (openChecks.length > 0 && /\b(?:stabilize recent work|operator feedback|package\/startup|startup-readiness|test-harness)\b/i.test(title)) {
    score -= 70;
  }

  return score;
};

export const pickAutopilotRecommendation = (
  recommendations: WorkflowRecommendationOption[],
  workflow?: Pick<ProjectWorkflowState, "goalChecklist">
): WorkflowRecommendationOption | undefined =>
  [...recommendations]
    .sort((left, right) =>
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
  autopilotEnabled = false,
  workflowPauseRequested = false,
  workflowObjective: WorkflowObjective = "deliver"
): WorkflowAutomationAction | null => {
  const recommendationAgentActive = agents.some((agent) => agent.category === "recommendation" && isAgentActive(agent));
  const goalAgentActive = agents.some((agent) => agent.category === "goal" && isAgentActive(agent));
  const codingAgentActive = agents.some((agent) => agent.category === "coding" && isAgentActive(agent));
  const integrityAgentActive = agents.some((agent) => agent.category === "integrity" && isAgentActive(agent));
  const mergeAgentActive = agents.some((agent) => agent.category === "merge" && isAgentActive(agent));

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
