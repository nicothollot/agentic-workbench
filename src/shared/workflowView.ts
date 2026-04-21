import type {
  AgentState,
  ProjectKind,
  ProjectWorkflowState,
  WorkflowObjective,
  WorkflowStage,
  WorkflowStepId,
  WorkflowStepProgress,
  WorkflowStepStatus
} from "./types";
import {
  ensureWorkflowStepProgressState,
  getLatestPendingHumanIntervention,
  getNextWorkflowAutomationAction,
  getWorkflowActiveStepId,
  hasBlockingHumanIntervention,
  hasConfirmedUltimateGoal,
  hasUnfinishedWorkflowAppeal,
  isWorkflowAppealFinished
} from "./workflow";

export interface WorkflowStageGuidance {
  meaning: string;
  systemAction: string;
  userAction: string;
  next: string;
}

export interface WorkflowActionGuide {
  kind: "confirm_goal" | "choose_recommendation" | "resolve_blocker" | "manual_takeover" | "none";
  title: string;
  description: string;
  actionLabel?: string;
}

export type WorkflowTimelineDisplayState = WorkflowStepStatus | "repairing" | "retrying_validation" | "fixed";

export interface WorkflowTimelineStepView {
  id: WorkflowStepId;
  title: string;
  description: string;
  status: WorkflowStepStatus;
  statusLabel: string;
  displayStatus: WorkflowTimelineDisplayState;
  displayStatusLabel: string;
  requiresUserInput: boolean;
  isCurrent: boolean;
  isBlocked: boolean;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  lastEventAt?: string;
  currentActivity?: string;
  currentSubstep?: string;
  latestProgressNote?: string;
  blockedReason?: string;
  message?: string;
  warning?: string;
  runCount: number;
  attemptCount: number;
  agentCategory?: WorkflowStepProgress["agentCategory"];
  repairAttemptLabel?: string;
}

export interface WorkflowGoalView {
  currentGoal: string;
  whyThisMatters: string;
  chosenNextStep: string;
  executionPlan: string;
  currentFocus: string;
  acceptanceCriteria: string[];
}

export interface WorkflowRepairCounterView {
  label: string;
  attemptCount: number;
  maxAttempts: number;
  isFinalAttempt: boolean;
  status: ProjectWorkflowState["repair"]["status"];
}

export interface WorkflowRecoveryCandidate {
  kind: "disconnected" | "stale";
  agent: AgentState;
}

const stepMetadata: Record<WorkflowStepId, { title: string; description: string }> = {
  ultimate_goal: {
    title: "Ultimate Goal",
    description: "Define the durable project goal the workflow should optimize for."
  },
  recommendation: {
    title: "Recommendation",
    description: "Generate and choose the next highest-value step for this cycle."
  },
  goal_plan: {
    title: "Goal Plan",
    description: "Turn the chosen next step into a scoped, testable execution plan."
  },
  coding: {
    title: "Coding",
    description: "Implement or repair the current execution plan."
  },
  integrity: {
    title: "Integrity",
    description: "Run deterministic checks and confirm the work still matches the goal."
  },
  merge: {
    title: "Merge",
    description: "Integrate validated work, or finalize in place for a non-Git project."
  }
};

const activeAgentStatuses = new Set<AgentState["status"]>(["starting", "running", "waiting_approval"]);

const isAgentActive = (agent: AgentState): boolean => activeAgentStatuses.has(agent.status);

const toTime = (value?: string): number => value ? new Date(value).getTime() : 0;

const latestAgentTime = (agent: AgentState): number =>
  Math.max(
    toTime(agent.lastActivityAt),
    toTime(agent.completedAt),
    toTime(agent.startedAt),
    toTime(agent.createdAt)
  );

const interruptedAgentTime = (agent: AgentState): number =>
  toTime(agent.completedAt ?? agent.lastActivityAt ?? agent.startedAt ?? agent.createdAt);

const workflowStepIdForRecoveryAgent = (agent: AgentState): WorkflowStepId | undefined => {
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
};

export const getWorkflowRecoveryCandidate = (
  workflow: ProjectWorkflowState,
  agents: AgentState[],
  nowMs: number,
  staleMs: number
): WorkflowRecoveryCandidate | null => {
  const isCurrentCycleAgent = (agent: AgentState): boolean =>
    agent.workflowCycleNumber === undefined || agent.workflowCycleNumber === workflow.workflowCycle.cycleNumber;
  const currentCycleAgents = agents.filter((agent) => agent.category !== "manual" && isCurrentCycleAgent(agent));
  const activeAgent = currentCycleAgents.find(isAgentActive);
  if (activeAgent) {
    const lastActivity = toTime(activeAgent.lastActivityAt ?? activeAgent.startedAt ?? activeAgent.createdAt);
    return lastActivity > 0 && nowMs - lastActivity > staleMs
      ? {
        kind: "stale",
        agent: activeAgent
      }
      : null;
  }

  const hasNewerSameStepAgent = (agent: AgentState): boolean => {
    const stepId = workflowStepIdForRecoveryAgent(agent);
    if (!stepId) {
      return false;
    }
    const disconnectedAt = interruptedAgentTime(agent);
    return currentCycleAgents.some((candidate) =>
      candidate.id !== agent.id &&
      candidate.status !== "disconnected" &&
      workflowStepIdForRecoveryAgent(candidate) === stepId &&
      latestAgentTime(candidate) > disconnectedAt
    );
  };

  const disconnectedAgent = currentCycleAgents.find((agent) =>
    agent.status === "disconnected" &&
    !agent.recoveryHandledAt &&
    !hasNewerSameStepAgent(agent)
  );
  return disconnectedAgent
    ? {
      kind: "disconnected",
      agent: disconnectedAgent
    }
    : null;
};

export const workflowStageLabel = (stage: WorkflowStage): string =>
  ({
    charter_needed: "Ultimate Goal Needed",
    recommendation_pending: "Recommendation Decision",
    recommendation_approved: "Preparing Goal Plan",
    goal_ready: "Preparing Coding",
    coding_running: "Coding In Progress",
    integrity_running: "Validation In Progress",
    repair_loop: "Repair Loop",
    ready_to_merge: "Ready To Merge",
    merged: "Merge Complete",
    appeal_pending: "Final Appeal Pass",
    blocked_human: "Blocked: Human Action Needed",
    cycle_complete: "Cycle Complete"
  })[stage];

export const workflowStepStatusLabel = (status: WorkflowStepStatus): string =>
  ({
    not_started: "Not started",
    waiting: "Waiting",
    running: "Running",
    blocked: "Blocked",
    completed: "Completed",
    failed: "Failed"
  })[status];

export const workflowDisplayStatusLabel = (status: WorkflowTimelineDisplayState): string =>
  ({
    not_started: "Not started",
    waiting: "Waiting",
    running: "Running",
    blocked: "Blocked",
    completed: "Completed",
    failed: "Failed",
    repairing: "Repairing",
    retrying_validation: "Retrying validation",
    fixed: "Fixed"
  })[status];

export const workflowStageGuidance = (stage: WorkflowStage): WorkflowStageGuidance =>
  ({
    charter_needed: {
      meaning: "The project needs an Ultimate Goal before the workflow can start.",
      systemAction: "The workflow is waiting for a confirmed goal.",
      userAction: "Confirm the Ultimate Goal to begin.",
      next: "Once it is confirmed, the system will prepare recommendations automatically."
    },
    recommendation_pending: {
      meaning: "The system has prepared possible next steps.",
      systemAction: "Recommendation options are ready for review.",
      userAction: "Choose one recommendation to continue the cycle.",
      next: "After that, the system will scope the work and move into coding automatically."
    },
    recommendation_approved: {
      meaning: "The chosen next step is being converted into a scoped plan.",
      systemAction: "The workflow is preparing a bounded execution plan.",
      userAction: "No action is needed right now.",
      next: "Once the plan is ready, coding will start automatically."
    },
    goal_ready: {
      meaning: "A scoped execution plan is ready.",
      systemAction: "The workflow is preparing the implementation pass.",
      userAction: "No action is needed right now.",
      next: "Coding will begin automatically."
    },
    coding_running: {
      meaning: "Implementation work is underway for the current execution plan.",
      systemAction: "The workflow is running the coding step.",
      userAction: "No action is needed right now.",
      next: "When coding finishes, validation will run automatically."
    },
    integrity_running: {
      meaning: "The system is checking whether the implementation satisfies the current plan and still aligns with the Ultimate Goal.",
      systemAction: "Deterministic validation is in progress.",
      userAction: "No action is needed right now.",
      next: "If checks pass, merge will begin automatically. If not, the workflow may enter a repair loop."
    },
    repair_loop: {
      meaning: "The system found issues and is attempting another fix cycle.",
      systemAction: "The workflow is preparing or running repair work.",
      userAction: "No action is needed unless a blocker is raised or automatic repair is exhausted.",
      next: "A repair pass will be followed by validation again."
    },
    ready_to_merge: {
      meaning: "Validation passed and the work is ready to integrate.",
      systemAction: "The workflow is preparing merge or finalization.",
      userAction: "No action is needed right now.",
      next: "The cycle will close after integration completes."
    },
    merged: {
      meaning: "Integration finished successfully.",
      systemAction: "The workflow is closing the current cycle.",
      userAction: "No action is needed right now.",
      next: "The next recommendation set will be prepared automatically."
    },
    appeal_pending: {
      meaning: "The base goal appears complete, and the workflow is preparing one final user-facing polish pass.",
      systemAction: "The workflow is looking for a bounded appeal improvement before it stops.",
      userAction: "Choose an appeal recommendation if autopilot is off.",
      next: "After the appeal pass is implemented, validated, and integrated, deliver-goal mode will stop."
    },
    blocked_human: {
      meaning: "The workflow is paused because an external action or decision is required from you.",
      systemAction: "Work is paused until the blocker is resolved.",
      userAction: "Resolve the blocking item to continue.",
      next: "The workflow will resume automatically once the blocker is cleared."
    },
    cycle_complete: {
      meaning: "This cycle is done.",
      systemAction: "The workflow is preparing the next recommendation.",
      userAction: "No action is needed right now.",
      next: "You will be asked to choose the next recommendation when it is ready."
    }
  })[stage];

export const workflowStatusSummary = (
  workflow: ProjectWorkflowState,
  autopilotEnabled = false,
  workflowObjective: WorkflowObjective = "deliver"
): string => {
  if (workflow.repair.status === "repairing") {
    return `Repair attempt ${workflow.repair.attemptCount} of ${workflow.repair.maxAttempts} is underway`;
  }
  if (workflow.repair.status === "retrying_validation") {
    return `Validation retry ${workflow.repair.attemptCount} of ${workflow.repair.maxAttempts} is running`;
  }
  if (workflow.repair.status === "fixed") {
    return "The last validation issue was fixed and the workflow is preparing integration";
  }
  if (workflow.repair.status === "merge_conflicts" || workflow.workflowStopReason === "merge_conflicts") {
    return "Merge conflicts require manual resolution before integration can continue";
  }
  if (workflow.repair.status === "exhausted") {
    return workflow.workflowStopReason === "repair_stopped_early" || workflow.manualHandoff?.reason === "repair_stopped_early"
      ? "Automatic repair stopped early and manual intervention is needed"
      : "Automatic repair attempts were exhausted and manual intervention is needed";
  }
  if (!hasConfirmedUltimateGoal(workflow.ultimateGoal)) {
    return "Set the project goal to begin";
  }
  if (workflow.workflowStage === "blocked_human") {
    return "Blocked: human action required";
  }
  if (workflow.workflowStage === "appeal_pending") {
    if (workflow.recommendations.length > 0) {
      return autopilotEnabled
        ? "Autopilot is choosing a final appeal improvement"
        : "Review and choose the final appeal improvement";
    }
    return "Base goal satisfied; preparing the final appeal pass";
  }
  if (workflow.workflowStopReason === "ultimate_goal_satisfied" && workflowObjective === "deliver" && isWorkflowAppealFinished(workflow)) {
    return "Ultimate Goal satisfied; automatic cycles stopped";
  }
  if (workflow.workflowStage === "recommendation_pending" && workflow.recommendations.length > 0) {
    return autopilotEnabled
      ? workflowObjective === "optimize"
        ? "Optimize mode is choosing the highest-confidence improvement"
        : "Autopilot is choosing the highest-confidence next step"
      : workflowObjective === "optimize"
        ? "Review and choose the next improvement"
        : "Review and choose the next recommended step";
  }
  if (workflow.workflowStage === "recommendation_pending") {
    return workflow.workflowCycle.status === "completed"
      ? workflowObjective === "optimize"
        ? "The system is preparing the next improvement options"
        : "The system is checking whether more work is still needed"
      : "The system is preparing recommendations";
  }
  if (workflow.workflowStage === "recommendation_approved" || workflow.workflowStage === "goal_ready") {
    return "The system is preparing a scoped goal";
  }
  if (workflow.workflowStage === "coding_running") {
    return "Coding is in progress";
  }
  if (workflow.workflowStage === "integrity_running") {
    return "Validation is running";
  }
  if (workflow.workflowStage === "repair_loop") {
    return workflow.workflowStopReason === "repair_budget_exhausted"
      ? "Automatic repair reached its limit and the workflow is paused"
      : workflow.workflowStopReason === "repair_stopped_early"
        ? "Automatic repair stopped early and the workflow is paused"
      : "A repair loop is in progress";
  }
  if (workflow.workflowStage === "ready_to_merge" || workflow.workflowStage === "merged") {
    return "Merge and integration are in progress";
  }
  if (workflow.workflowStage === "cycle_complete") {
    return workflowObjective === "optimize"
      ? "Cycle complete; preparing the next improvement options"
      : "Cycle complete";
  }
  return "The workflow is progressing automatically";
};

const hasVisibleManualHandoff = (workflow: ProjectWorkflowState): boolean =>
  Boolean(
    workflow.manualHandoff &&
    (
      workflow.repair.status === "exhausted" ||
      workflow.repair.status === "merge_conflicts" ||
      workflow.workflowStopReason === "merge_conflicts" ||
      workflow.manualHandoff.reason === "merge_conflicts"
    )
  );

export const workflowActionGuide = (
  workflow: ProjectWorkflowState,
  agentsPendingApproval = false,
  autopilotEnabled = false,
  workflowObjective: WorkflowObjective = "deliver"
): WorkflowActionGuide => {
  const recommendationsAwaitingChoice = workflow.recommendations.length > 0 && (!workflow.approvedRecommendation || workflow.workflowCycle.status === "completed");

  if (!hasConfirmedUltimateGoal(workflow.ultimateGoal)) {
    return {
      kind: "confirm_goal",
      title: "Enter or confirm the Ultimate Goal",
      description: workflow.ultimateGoalDraft?.summary
        ? "A detected draft is ready. Confirm or edit it so the workflow can rely on it."
        : "Start by defining the Ultimate Goal for this project.",
      actionLabel: "Confirm Ultimate Goal"
    };
  }

  if (workflow.workflowStage === "blocked_human" || hasBlockingHumanIntervention(workflow)) {
    return {
      kind: "resolve_blocker",
      title: "Resolve a human intervention blocker",
      description: getLatestPendingHumanIntervention(workflow)?.description ?? "A blocker needs your help before work can continue.",
      actionLabel: "Resolve blocker"
    };
  }

  if (workflow.manualHandoff && hasVisibleManualHandoff(workflow)) {
    return {
      kind: "manual_takeover",
      title: workflow.manualHandoff.title,
      description: workflow.manualHandoff.latestFailureReason,
      actionLabel: workflow.manualHandoff.shellSupported ? "Open Codex terminal" : undefined
    };
  }

  if (workflow.workflowStage === "appeal_pending") {
    if (recommendationsAwaitingChoice) {
      if (autopilotEnabled) {
        return {
          kind: "none",
          title: "Autopilot is choosing the final appeal pass",
          description: "The base goal appears complete, so the workflow will approve the highest-confidence polish recommendation automatically."
        };
      }
      return {
        kind: "choose_recommendation",
        title: "Choose the final appeal pass",
        description: "Pick one bounded user-facing improvement before the workflow stops.",
        actionLabel: "Choose appeal pass"
      };
    }

    return {
      kind: "none",
      title: "Preparing the final appeal pass",
      description: "The base goal appears complete. The workflow is checking for one bounded polish improvement before it stops."
    };
  }

  if (workflow.workflowStopReason === "ultimate_goal_satisfied" && workflowObjective === "deliver" && isWorkflowAppealFinished(workflow)) {
    return {
      kind: "none",
      title: "Ultimate Goal satisfied",
      description: workflow.appeal.status === "completed"
        ? "The workflow stopped after the requested goal and the final appeal pass were completed. Enable Optimize to keep looking for improvements."
        : "The workflow stopped at the end of the last successful cycle because the requested goal appears complete. Enable Optimize to keep looking for improvements."
    };
  }

  if (recommendationsAwaitingChoice) {
    if (autopilotEnabled) {
      return {
        kind: "none",
        title: workflowObjective === "optimize" ? "Optimize mode is choosing the next improvement" : "Autopilot is choosing the next step",
        description: workflowObjective === "optimize"
          ? "Autopilot is on, so optimize mode will approve the highest-confidence improvement automatically."
          : "Autopilot is on, so the workflow will approve the highest-confidence recommendation automatically."
      };
    }
    return {
      kind: "choose_recommendation",
      title: workflowObjective === "optimize" ? "Choose one improvement" : "Choose one recommendation",
      description: workflowObjective === "optimize"
        ? "Choose the next bounded improvement the system should execute."
        : "Choose the next step the system should execute.",
      actionLabel: workflowObjective === "optimize" ? "Choose improvement" : "Choose next step"
    };
  }

  return {
    kind: "none",
    title: "Nothing right now; the system is working",
    description: agentsPendingApproval
      ? "The workflow is paused on an agent approval request in the details section."
      : "No action is needed. The workflow is progressing automatically."
  };
};

export const workflowRunStateLabel = (
  workflow: ProjectWorkflowState,
  projectKind: ProjectKind,
  agentsPendingApproval = false,
  autopilotEnabled = false,
  workflowObjective: WorkflowObjective = "deliver"
): "Waiting on you" | "Running automatically" | "Paused" => {
  const recommendationsAwaitingChoice = workflow.recommendations.length > 0 && (!workflow.approvedRecommendation || workflow.workflowCycle.status === "completed");
  if (
    !hasConfirmedUltimateGoal(workflow.ultimateGoal) ||
    workflow.workflowStage === "blocked_human" ||
    workflow.repair.status === "exhausted" ||
    workflow.repair.status === "merge_conflicts" ||
    workflow.workflowStopReason === "merge_conflicts" ||
    (workflow.workflowStopReason === "ultimate_goal_satisfied" && workflowObjective === "deliver" && isWorkflowAppealFinished(workflow))
  ) {
    return "Waiting on you";
  }
  if (
    agentsPendingApproval ||
    getNextWorkflowAutomationAction(workflow, [], projectKind, false, false, workflowObjective) === null &&
      workflow.workflowStage === "repair_loop" &&
      workflow.workflowStopReason !== "integrity_failed"
  ) {
    return "Paused";
  }
  if (recommendationsAwaitingChoice) {
    return autopilotEnabled ? "Running automatically" : "Waiting on you";
  }
  return "Running automatically";
};

export const workflowSectionProminence = (workflow: ProjectWorkflowState) => ({
  recommendations: workflow.recommendations.length > 0 && (
    !workflow.approvedRecommendation ||
    workflow.workflowCycle.status === "completed" ||
    workflow.workflowStage === "appeal_pending"
  ),
  humanIntervention: workflow.workflowStage === "blocked_human" || hasBlockingHumanIntervention(workflow),
  manualHandoff: hasVisibleManualHandoff(workflow)
});

export const getWorkflowRepairCounterView = (workflow: ProjectWorkflowState): WorkflowRepairCounterView => ({
  label: workflow.repair.attemptCount > 0
    ? `Repair attempt ${workflow.repair.attemptCount} of ${workflow.repair.maxAttempts}`
    : `Repair attempt 0 of ${workflow.repair.maxAttempts}`,
  attemptCount: workflow.repair.attemptCount,
  maxAttempts: workflow.repair.maxAttempts,
  isFinalAttempt: workflow.repair.attemptCount >= workflow.repair.maxAttempts,
  status: workflow.repair.status
});

export const buildWorkflowGoalView = (workflow: ProjectWorkflowState): WorkflowGoalView => {
  const chosenNextStep = workflow.approvedRecommendation?.title ??
    (hasUnfinishedWorkflowAppeal(workflow) ? "Choose the final appeal pass" : "Choose the next recommendation");
  const executionPlan = workflow.scopedGoal?.summary ?? workflow.approvedRecommendation?.summary ?? "A scoped execution plan has not been prepared yet.";
  const openGoalChecks = workflow.goalChecklist
    .filter((check) => check.required && check.status !== "met" && check.status !== "not_applicable")
    .map((check) => `${check.title}${check.evidence ? ` - ${check.evidence}` : ""}`);
  const acceptanceCriteria = (openGoalChecks.length
    ? openGoalChecks
    : workflow.scopedGoal?.acceptanceCriteria.length
    ? workflow.scopedGoal.acceptanceCriteria
    : workflow.workflowCycle.acceptanceCriteria.length
      ? workflow.workflowCycle.acceptanceCriteria
      : workflow.ultimateGoal.successCriteria
  ).slice(0, 4);

  return {
    currentGoal: (
      workflow.scopedGoal?.summary ??
      workflow.approvedRecommendation?.title ??
      workflow.ultimateGoal.summary
    ) || "Set the Ultimate Goal",
    whyThisMatters: workflow.ultimateGoal.summary
      ? `This advances the Ultimate Goal: ${workflow.ultimateGoal.summary}`
      : "The workflow needs a confirmed Ultimate Goal before it can optimize the next step.",
    chosenNextStep,
    executionPlan,
    currentFocus: workflow.stepProgress[getWorkflowActiveStepId({
      workflowStage: workflow.workflowStage,
      humanInterventions: workflow.humanInterventions,
      approvedRecommendation: workflow.approvedRecommendation,
      scopedGoal: workflow.scopedGoal,
      ultimateGoal: workflow.ultimateGoal,
      stepProgress: workflow.stepProgress,
      repair: workflow.repair
    })].currentActivity ?? workflowStatusSummary(workflow),
    acceptanceCriteria
  };
};

export const buildWorkflowTimelineSteps = (workflow: ProjectWorkflowState): WorkflowTimelineStepView[] => {
  const stepProgress = ensureWorkflowStepProgressState(workflow);
  const activeStepId = getWorkflowActiveStepId({
    workflowStage: workflow.workflowStage,
    humanInterventions: workflow.humanInterventions,
    approvedRecommendation: workflow.approvedRecommendation,
    scopedGoal: workflow.scopedGoal,
    ultimateGoal: workflow.ultimateGoal,
    stepProgress,
    repair: workflow.repair
  });
  const blockedReason = getLatestPendingHumanIntervention(workflow)?.description;
  const repairAttemptLabel = workflow.repair.attemptCount > 0
    ? `Repair attempt ${workflow.repair.attemptCount} of ${workflow.repair.maxAttempts}`
    : undefined;

  return (Object.keys(stepMetadata) as WorkflowStepId[]).map((stepId) => {
    const progress = stepProgress[stepId];
    const isBlocked = workflow.workflowStage === "blocked_human" && stepId === activeStepId;
    const displayStatus: WorkflowTimelineDisplayState = isBlocked
      ? "blocked"
      : stepId === "coding" && workflow.repair.status === "repairing"
        ? "repairing"
        : stepId === "integrity" && workflow.repair.status === "retrying_validation"
          ? "retrying_validation"
          : stepId === "integrity" && workflow.repair.status === "fixed"
            ? "fixed"
            : progress.status;
    return {
      id: stepId,
      title: stepMetadata[stepId].title,
      description: stepMetadata[stepId].description,
      status: isBlocked ? "blocked" : progress.status,
      statusLabel: workflowStepStatusLabel(isBlocked ? "blocked" : progress.status),
      displayStatus,
      displayStatusLabel: workflowDisplayStatusLabel(displayStatus),
      requiresUserInput: isBlocked ? true : progress.requiresUserInput,
      isCurrent: stepId === activeStepId,
      isBlocked,
      startedAt: progress.startedAt,
      updatedAt: progress.updatedAt,
      completedAt: progress.completedAt,
      lastEventAt: progress.lastEventAt,
      currentActivity: progress.currentActivity,
      currentSubstep: progress.currentSubstep,
      latestProgressNote: progress.latestProgressNote,
      blockedReason: isBlocked ? (progress.blockedReason ?? blockedReason) : progress.blockedReason,
      message: progress.message,
      warning: progress.warning,
      runCount: progress.runCount,
      attemptCount: progress.attemptCount,
      agentCategory: progress.agentCategory,
      repairAttemptLabel:
        workflow.repair.attemptCount > 0 && (stepId === "coding" || stepId === "integrity")
          ? repairAttemptLabel
          : undefined
    };
  });
};
