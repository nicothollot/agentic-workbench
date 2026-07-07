import type {
  AgentState,
  ProjectKind,
  ProjectWorkflowState,
  RepoHygieneReport,
  ValidationLedger,
  WorkflowDerivedStatus,
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
  getWorkflowPreviewRequest,
  hasBlockingHumanIntervention,
  hasConfirmedUltimateGoal,
  hasPendingAgentApprovals,
  hasUnfinishedWorkflowAppeal,
  isWorkflowAutomationBlockingAgent,
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
  kind: "disconnected" | "stale" | "startup_stalled";
  agent: AgentState;
}

export type WorkflowRuntimeStatus =
  | "running"
  | "recovering"
  | "starting-agent"
  | "paused"
  | "idle"
  | "blocked"
  | "awaiting-approval"
  | "stale-running"
  | "completed"
  | "error";

export interface WorkflowRuntimeStatusView {
  status: WorkflowRuntimeStatus;
  label: string;
  tone: "idle" | "running" | "paused" | "blocked" | "completed";
  canContinue: boolean;
  continueDisabledReason?: string;
  recoveryCandidate?: WorkflowRecoveryCandidate;
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
        kind: activeAgent.status === "starting" && !activeAgent.threadId ? "startup_stalled" : "stale",
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

const hasCurrentCycleActiveAgentForStep = (
  workflow: ProjectWorkflowState,
  agents: AgentState[],
  stepId: WorkflowStepId
): boolean =>
  agents.some((agent) =>
    agent.category !== "manual" &&
    isAgentActive(agent) &&
    workflowStepIdForRecoveryAgent(agent) === stepId &&
    (agent.workflowCycleNumber === undefined || agent.workflowCycleNumber === workflow.workflowCycle.cycleNumber)
  );

const getStaleRunningStepId = (
  workflow: ProjectWorkflowState,
  agents: AgentState[],
  nowMs: number,
  staleMs: number
): WorkflowStepId | undefined => {
  const stepProgress = ensureWorkflowStepProgressState(workflow);
  return (Object.keys(stepProgress) as WorkflowStepId[]).find((stepId) => {
    const progress = stepProgress[stepId];
    if (hasCurrentCycleActiveAgentForStep(workflow, agents, stepId)) {
      return false;
    }
    if (progress.status === "running") {
      return true;
    }
    if (progress.status !== "recovering" && progress.status !== "starting") {
      return false;
    }
    const updatedAt = new Date(progress.updatedAt ?? progress.startedAt ?? 0).getTime();
    return Number.isFinite(updatedAt) && nowMs - updatedAt >= staleMs;
  });
};

export const deriveWorkflowRuntimeStatus = (
  workflow: ProjectWorkflowState,
  agents: AgentState[],
  options: {
    projectKind?: ProjectKind;
    nowMs?: number;
    staleMs?: number;
    workflowPauseRequested?: boolean;
    autopilotEnabled?: boolean;
    workflowObjective?: WorkflowObjective;
  } = {}
): WorkflowRuntimeStatusView => {
  const projectKind = options.projectKind ?? "folder";
  const workflowObjective = options.workflowObjective ?? "deliver";
  const nowMs = options.nowMs ?? Date.now();
  const staleMs = options.staleMs ?? 10 * 60 * 1000;
  const workflowPauseRequested = options.workflowPauseRequested ?? false;
  const recoveryCandidate = getWorkflowRecoveryCandidate(workflow, agents, nowMs, staleMs);
  const stepProgress = ensureWorkflowStepProgressState(workflow);
  const staleRunningStepId = getStaleRunningStepId(workflow, agents, nowMs, staleMs);
  const pendingApproval = hasPendingAgentApprovals(agents);
  const blockingHuman = hasBlockingHumanIntervention(workflow);
  const activeAgent = agents.some((agent) =>
    isWorkflowAutomationBlockingAgent(agent) &&
    (agent.workflowCycleNumber === undefined || agent.workflowCycleNumber === workflow.workflowCycle.cycleNumber)
  );

  if (pendingApproval) {
    return {
      status: "awaiting-approval",
      label: "Awaiting approval",
      tone: "blocked",
      canContinue: false,
      continueDisabledReason: "Resolve the pending approval before continuing."
    };
  }

  if (blockingHuman || workflow.workflowStage === "blocked_human") {
    return {
      status: "blocked",
      label: "Blocked",
      tone: "blocked",
      canContinue: false,
      continueDisabledReason: "Resolve the human intervention blocker before continuing."
    };
  }

  if (recoveryCandidate || staleRunningStepId) {
    return {
      status: "stale-running",
      label: "Needs recovery",
      tone: "blocked",
      canContinue: true,
      recoveryCandidate: recoveryCandidate ?? undefined
    };
  }

  if (Object.values(stepProgress).some((progress) => progress.status === "recovering")) {
    return {
      status: "recovering",
      label: "Recovering",
      tone: "running",
      canContinue: false,
      continueDisabledReason: "Workflow recovery is already in progress."
    };
  }

  if (Object.values(stepProgress).some((progress) => progress.status === "starting")) {
    return {
      status: "starting-agent",
      label: "Starting agent",
      tone: "running",
      canContinue: false,
      continueDisabledReason: "A workflow agent is already starting."
    };
  }

  if (activeAgent) {
    return {
      status: "running",
      label: "Running",
      tone: "running",
      canContinue: false,
      continueDisabledReason: "A live workflow agent is currently running."
    };
  }

  if (
    workflow.repair.status === "exhausted" ||
    workflow.repair.status === "merge_conflicts" ||
    workflow.workflowStopReason === "merge_conflicts"
  ) {
    return {
      status: "blocked",
      label: "Blocked",
      tone: "blocked",
      canContinue: false,
      continueDisabledReason: "Use the manual recovery controls for the current workflow blocker."
    };
  }

  if (
    workflowPauseRequested ||
    workflow.autopilotStatus?.pausedReason ||
    getWorkflowPreviewRequest(workflow).status === "ready"
  ) {
    return {
      status: "paused",
      label: "Paused",
      tone: "paused",
      canContinue: true
    };
  }

  if (
    workflow.workflowStopReason === "ultimate_goal_satisfied" &&
    workflowObjective === "deliver" &&
    isWorkflowAppealFinished(workflow)
  ) {
    return {
      status: "completed",
      label: "Completed",
      tone: "completed",
      canContinue: false,
      continueDisabledReason: "The Ultimate Goal is satisfied. Enable Optimize to continue looking for improvements."
    };
  }

  const nextAction = getNextWorkflowAutomationAction(
    workflow,
    agents,
    projectKind,
    options.autopilotEnabled ?? false,
    false,
    workflowObjective
  );
  if (nextAction) {
    return {
      status: "idle",
      label: "Idle",
      tone: "idle",
      canContinue: true
    };
  }

  return {
    status: "idle",
    label: "Idle",
    tone: "idle",
    canContinue: false,
    continueDisabledReason: "No runnable workflow step is available from the current state."
  };
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

const latestWorkflowAgent = (agents: AgentState[], category: AgentState["category"]): AgentState | undefined =>
  agents
    .filter((agent) => agent.category === category)
    .sort((left, right) =>
      Date.parse(right.completedAt ?? right.lastActivityAt ?? right.startedAt ?? right.createdAt) -
      Date.parse(left.completedAt ?? left.lastActivityAt ?? left.startedAt ?? left.createdAt)
    )[0];

const latestValidationLedger = (workflow: ProjectWorkflowState, explicit?: ValidationLedger): ValidationLedger | undefined =>
  explicit ?? workflow.validationLedgers
    .filter((ledger) => ledger.cycleNumber === workflow.workflowCycle.cycleNumber)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];

const latestRepoHygieneReport = (workflow: ProjectWorkflowState, explicit?: RepoHygieneReport): RepoHygieneReport | undefined =>
  explicit ?? workflow.repoHygieneReports
    .slice()
    .sort((left, right) => Date.parse(right.scannedAt) - Date.parse(left.scannedAt))[0];

export const deriveUserFacingWorkflowStatus = (
  workflow: ProjectWorkflowState,
  options: {
    agents?: AgentState[];
    validationLedger?: ValidationLedger;
    repoHygieneReport?: RepoHygieneReport;
    workflowPauseRequested?: boolean;
    pushed?: boolean;
  } = {}
): WorkflowDerivedStatus => {
  const agents = options.agents ?? [];
  const ledger = latestValidationLedger(workflow, options.validationLedger);
  const hygiene = latestRepoHygieneReport(workflow, options.repoHygieneReport);
  const codingAgent = latestWorkflowAgent(agents, "coding");
  const integrityAgent = latestWorkflowAgent(agents, "integrity");
  const mergeAgent = latestWorkflowAgent(agents, "merge");
  const pausePrefix = options.workflowPauseRequested || workflow.autopilotStatus?.pausedReason === "manual_pause_requested"
    ? "Paused by operator, "
    : "";
  const codingCheckpointed = Boolean(
    codingAgent?.status === "completed" &&
    /checkpointed worktree changes for merge|changes ready for merge/i.test(`${codingAgent.currentPhase ?? ""} ${codingAgent.lastMessageSnippet ?? ""}`)
  );
  const legacyCodingCheckpointed = Boolean(
    workflow.workflowStage === "goal_ready" &&
    workflow.autopilotStatus?.pausedReason &&
    /start_coding|coding|checkpoint/i.test(workflow.autopilotStatus.lastCompletedAction ?? "")
  );
  const cycleMatches = (agent: AgentState): boolean =>
    agent.workflowCycleNumber === undefined || agent.workflowCycleNumber === workflow.workflowCycle.cycleNumber;
  const validationReachedByProgress = (
    workflow.stepProgress.coding.status === "completed" ||
    workflow.stepProgress.coding.runCount > 0 ||
    workflow.stepProgress.integrity.status !== "not_started" ||
    workflow.stepProgress.integrity.runCount > 0 ||
    workflow.stepProgress.merge.status !== "not_started" ||
    workflow.stepProgress.merge.runCount > 0 ||
    workflow.workflowStage === "ready_to_merge" ||
    workflow.workflowStage === "repair_loop"
  );
  const validationReachedByAgent = agents.some((agent) =>
    cycleMatches(agent) &&
    (agent.category === "integrity" || agent.category === "merge") &&
    (agent.status !== "idle" || Boolean(agent.integrityReport) || Boolean(agent.mergeReport))
  );

  if (hygiene?.mergeBlockingFindings.length) {
    return {
      label: "Merge blocked by repository hygiene",
      explanation: hygiene.summaryForHumans,
      tone: "danger"
    };
  }
  if (ledger?.unresolvedValidationFailures.length || ledger?.finalValidationStatus === "failed" || ledger?.finalValidationStatus === "partial") {
    return {
      label: "Merge blocked by validation failure",
      explanation: ledger.summaryForHumans,
      tone: ledger.finalValidationStatus === "partial" ? "warning" : "danger"
    };
  }
  if (workflow.workflowStage === "coding_running" || agents.some((agent) => agent.category === "coding" && isWorkflowAutomationBlockingAgent(agent))) {
    return {
      label: "Running coding pass",
      explanation: codingAgent?.currentPhase ?? workflow.stepProgress.coding.message ?? "Implementation work is underway.",
      tone: "running"
    };
  }
  if (workflow.workflowStage === "integrity_running" || agents.some((agent) => agent.category === "integrity" && isWorkflowAutomationBlockingAgent(agent))) {
    return {
      label: "Integrity validation running",
      explanation: integrityAgent?.currentPhase ?? workflow.stepProgress.integrity.message ?? "Deterministic validation is running.",
      tone: "running"
    };
  }
  if (
    mergeAgent?.status === "completed" &&
    (options.pushed || /pushed\s+\S+\s+to\s+origin/i.test(mergeAgent.mergeReport?.summary ?? ""))
  ) {
    return {
      label: "Merged and pushed",
      explanation: mergeAgent.mergeReport?.summary ?? "Integration completed and the branch was pushed.",
      tone: "success"
    };
  }
  if ((codingCheckpointed || legacyCodingCheckpointed) && (options.workflowPauseRequested || workflow.autopilotStatus?.pausedReason || workflow.workflowStage === "goal_ready" || workflow.stepProgress.integrity.status === "not_started")) {
    return {
      label: `${pausePrefix}Paused after coding checkpoint; awaiting integrity/merge`,
      explanation: codingAgent?.currentPhase ?? "Coding changes were checkpointed and validation or merge has not completed yet.",
      tone: "paused"
    };
  }
  if ((!ledger || ledger.finalValidationStatus === "not_run") && (codingCheckpointed || legacyCodingCheckpointed || validationReachedByProgress || validationReachedByAgent)) {
    return {
      label: "Awaiting validation",
      explanation: ledger?.summaryForHumans ?? "No validation ledger has been recorded for this cycle.",
      tone: "warning"
    };
  }
  if (workflow.workflowStage === "ready_to_merge" && ledger) {
    return {
      label: "Ready to merge",
      explanation: ledger.summaryForHumans,
      tone: "success"
    };
  }
  if (workflow.workflowStage === "merged") {
    return {
      label: "Merge complete",
      explanation: mergeAgent?.mergeReport?.summary ?? "Integration finished.",
      tone: "success"
    };
  }
  return {
    label: workflowStageLabel(workflow.workflowStage),
    explanation: workflowStatusSummary(workflow),
    tone: workflow.workflowStage === "blocked_human" ? "danger" : "running"
  };
};

export const workflowStepStatusLabel = (status: WorkflowStepStatus): string =>
  ({
    not_started: "Not started",
    waiting: "Waiting",
    recovering: "Recovering",
    starting: "Starting",
    running: "Running",
    blocked: "Blocked",
    completed: "Completed",
    failed: "Failed"
  })[status];

export const workflowDisplayStatusLabel = (status: WorkflowTimelineDisplayState): string =>
  ({
    not_started: "Not started",
    waiting: "Waiting",
    recovering: "Recovering",
    starting: "Starting",
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
      userAction: "Monitor for approvals, validation blockers, or paused workflow state.",
      next: "Once the plan is ready, coding will start automatically."
    },
    goal_ready: {
      meaning: "A scoped execution plan is ready.",
      systemAction: "The workflow is preparing the implementation pass.",
      userAction: "Monitor for approvals, validation blockers, or paused workflow state.",
      next: "Coding will begin automatically."
    },
    coding_running: {
      meaning: "Implementation work is underway for the current execution plan.",
      systemAction: "The workflow is running the coding step.",
      userAction: "Monitor the coding pass and any approval requests.",
      next: "When coding finishes, validation will run automatically."
    },
    integrity_running: {
      meaning: "The system is checking whether the implementation satisfies the current plan and still aligns with the Ultimate Goal.",
      systemAction: "Deterministic validation is in progress.",
      userAction: "Review failures if validation reports a blocker.",
      next: "If checks pass, merge will begin automatically. If not, the workflow may enter a repair loop."
    },
    repair_loop: {
      meaning: "The system found issues and is attempting another fix cycle.",
      systemAction: "The workflow is preparing or running repair work.",
      userAction: "Watch for blockers or exhausted automatic repair.",
      next: "A repair pass will be followed by validation again."
    },
    ready_to_merge: {
      meaning: "Validation passed and the work is ready to integrate.",
      systemAction: "The workflow is preparing merge or finalization.",
      userAction: "Confirm merge remains allowed by validation and repository hygiene.",
      next: "The cycle will close after integration completes."
    },
    merged: {
      meaning: "Integration finished successfully.",
      systemAction: "The workflow is closing the current cycle.",
      userAction: "Review the cycle summary if you need audit details.",
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
      userAction: "Review the completed cycle if you need audit details.",
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
        ? "Optimize mode is choosing the highest-impact improvement"
        : "Autopilot is choosing the highest-impact next step"
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

export const canRevalidateExternalRepair = (workflow?: ProjectWorkflowState | null): boolean => {
  if (!workflow) {
    return false;
  }
  if (
    workflow.repair.status === "merge_conflicts" ||
    workflow.workflowStopReason === "merge_conflicts" ||
    workflow.manualHandoff?.reason === "merge_conflicts"
  ) {
    return false;
  }

  return Boolean(
    workflow.manualHandoff ||
    workflow.repair.status === "exhausted" ||
    workflow.workflowStopReason === "repair_budget_exhausted" ||
    workflow.workflowStopReason === "repair_stopped_early"
  );
};

const hasVisibleManualHandoff = (workflow: ProjectWorkflowState): boolean =>
  Boolean(
    workflow.manualHandoff &&
    (
      workflow.repair.status === "merge_conflicts" ||
      workflow.workflowStopReason === "merge_conflicts" ||
      workflow.manualHandoff.reason === "merge_conflicts" ||
      canRevalidateExternalRepair(workflow)
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
      title: "Set the Ultimate Goal in Settings",
      description: workflow.ultimateGoalDraft?.summary
        ? "A detected draft is ready. Open Settings to confirm, edit, or generate the Goal Charter."
        : "Open Settings to define the Goal Charter before running workflow automation.",
      actionLabel: "Open Settings"
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
      actionLabel: canRevalidateExternalRepair(workflow)
        ? "Revalidate repair"
        : workflow.manualHandoff.shellSupported
          ? "Open Codex terminal"
          : undefined
    };
  }

  if (canRevalidateExternalRepair(workflow)) {
    return {
      kind: "manual_takeover",
      title: "Revalidate repair before merge",
      description: workflow.repair.latestFailureReason ?? workflow.repair.latestIssueSummary ?? "A repair was completed outside the workflow and needs validation before integration can continue.",
      actionLabel: "Revalidate repair"
    };
  }

  if (workflow.workflowStage === "appeal_pending") {
    if (recommendationsAwaitingChoice) {
      if (autopilotEnabled) {
        return {
          kind: "none",
          title: "Autopilot is choosing the final appeal pass",
          description: "The base goal appears complete, so the workflow will approve the highest-impact polish recommendation automatically."
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
          ? "Autopilot is on, so optimize mode will approve the highest-impact improvement automatically."
          : "Autopilot is on, so the workflow will approve the highest-impact checklist-aligned recommendation automatically."
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
      : "The workflow is progressing automatically; continue monitoring validation, hygiene, and checklist status."
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
