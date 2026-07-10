import type {
  AgentState,
  AutopilotPauseReason,
  AutopilotPolicy,
  AutopilotProfile,
  ProjectKind,
  ProjectWorkflowState,
  RecommendationRiskLevel,
  WorkflowMode,
  WorkflowObjective,
  WorkflowRecommendationOption
} from "./types";

export const DEFAULT_AUTOPILOT_HIGH_RISK_AREAS = [
  "credential handling",
  "approval policy",
  "renderer/main privilege boundary",
  "runtime command execution",
  "sandbox/network policy",
  "merge logic",
  "workflow state machine",
  "persistent storage migrations",
  "secrets/local credential storage",
  "git push/commit automation"
];

const profileBase = (
  profile: AutopilotProfile,
  overrides: Partial<AutopilotPolicy> = {}
): AutopilotPolicy => ({
  enabled: false,
  profile,
  maxAutomaticActionsPerPass: 5,
  maxConsecutiveCycles: undefined,
  pauseOnPreviewReady: true,
  pauseOnHumanBlocker: true,
  pauseOnApprovalRequired: true,
  pauseOnIntegrityFailure: "repair",
  pauseOnMergeConflict: true,
  allowDeterministicScoping: true,
  allowAgentRecommendationWhenDeterministicPackageExists: true,
  allowBacklogPromotion: false,
  maxNewRequiredChecksPerCycle: 2,
  preferGroupedChecklistPackages: true,
  maxChecksPerWorkPackageNormal: 4,
  maxChecksPerWorkPackageFast: 8,
  allowFastModeBatching: true,
  requireExplicitApprovalForHighRiskPackages: true,
  highRiskAreas: [...DEFAULT_AUTOPILOT_HIGH_RISK_AREAS],
  stopWhenGoalSatisfied: true,
  stopWhenNoSafeRecommendation: true,
  ...overrides
});

const PROFILE_CONFIGS: Record<Exclude<AutopilotProfile, "custom">, AutopilotPolicy> = {
  balanced: profileBase("balanced"),
  conservative: profileBase("conservative", {
    maxAutomaticActionsPerPass: 3,
    maxConsecutiveCycles: 1,
    pauseOnIntegrityFailure: "pause",
    allowAgentRecommendationWhenDeterministicPackageExists: true,
    maxNewRequiredChecksPerCycle: 1,
    maxChecksPerWorkPackageNormal: 2,
    maxChecksPerWorkPackageFast: 4,
    allowFastModeBatching: false
  }),
  aggressive: profileBase("aggressive", {
    maxAutomaticActionsPerPass: 8,
    pauseOnIntegrityFailure: "repair",
    allowAgentRecommendationWhenDeterministicPackageExists: false,
    maxNewRequiredChecksPerCycle: 3,
    maxChecksPerWorkPackageNormal: 6,
    maxChecksPerWorkPackageFast: 10,
    allowFastModeBatching: true
  })
};

const activeAgentStatuses = new Set(["starting", "running", "waiting_approval"]);

const clampInteger = (value: unknown, fallback: number, min: number, max: number): number => {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.max(min, Math.min(max, numeric));
};

const clampOptionalInteger = (value: unknown, min: number, max: number): number | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  return clampInteger(value, min, min, max);
};

const uniqueNonEmpty = (values: unknown, fallback: string[]): string[] => {
  const entries: unknown[] = Array.isArray(values) ? values : fallback;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of [...entries, ...DEFAULT_AUTOPILOT_HIGH_RISK_AREAS]) {
    if (typeof entry !== "string") {
      continue;
    }
    const normalized = entry.trim().replace(/\s+/g, " ");
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }
  return result.slice(0, 32);
};

const normalizeProfile = (profile: unknown): AutopilotProfile =>
  profile === "conservative" || profile === "aggressive" || profile === "custom" || profile === "balanced"
    ? profile
    : "balanced";

export const getAutopilotPolicyConfig = (profile: AutopilotProfile): AutopilotPolicy => {
  if (profile === "custom") {
    return {
      ...PROFILE_CONFIGS.balanced,
      profile: "custom",
      highRiskAreas: [...PROFILE_CONFIGS.balanced.highRiskAreas]
    };
  }
  const config = PROFILE_CONFIGS[profile];
  return {
    ...config,
    highRiskAreas: [...config.highRiskAreas]
  };
};

export const createDefaultAutopilotPolicy = (enabled = false): AutopilotPolicy => ({
  ...getAutopilotPolicyConfig("balanced"),
  enabled
});

export const validateAutopilotPolicy = (
  policy?: Partial<AutopilotPolicy> | null,
  enabledFallback = false
): AutopilotPolicy => {
  const profile = normalizeProfile(policy?.profile);
  const base = getAutopilotPolicyConfig(profile === "custom" ? "custom" : profile);
  const merged = profile === "custom"
    ? { ...base, ...policy, profile: "custom" as const }
    : {
      ...base,
      enabled: policy?.enabled ?? enabledFallback,
      profile
    };
  const maxNormal = clampInteger(merged.maxChecksPerWorkPackageNormal, base.maxChecksPerWorkPackageNormal, 1, 8);
  const maxFast = clampInteger(merged.maxChecksPerWorkPackageFast, base.maxChecksPerWorkPackageFast, 1, 12);

  return {
    ...merged,
    enabled: Boolean(merged.enabled ?? enabledFallback),
    maxAutomaticActionsPerPass: clampInteger(merged.maxAutomaticActionsPerPass, base.maxAutomaticActionsPerPass, 1, 12),
    maxConsecutiveCycles: clampOptionalInteger(merged.maxConsecutiveCycles, 1, 12),
    pauseOnPreviewReady: Boolean(merged.pauseOnPreviewReady),
    pauseOnHumanBlocker: Boolean(merged.pauseOnHumanBlocker),
    pauseOnApprovalRequired: Boolean(merged.pauseOnApprovalRequired),
    pauseOnIntegrityFailure:
      merged.pauseOnIntegrityFailure === "pause" || merged.pauseOnIntegrityFailure === "policy"
        ? merged.pauseOnIntegrityFailure
        : "repair",
    pauseOnMergeConflict: Boolean(merged.pauseOnMergeConflict),
    allowDeterministicScoping: Boolean(merged.allowDeterministicScoping),
    allowAgentRecommendationWhenDeterministicPackageExists: Boolean(merged.allowAgentRecommendationWhenDeterministicPackageExists),
    allowBacklogPromotion: Boolean(merged.allowBacklogPromotion),
    maxNewRequiredChecksPerCycle: clampInteger(merged.maxNewRequiredChecksPerCycle, base.maxNewRequiredChecksPerCycle, 0, 5),
    preferGroupedChecklistPackages: Boolean(merged.preferGroupedChecklistPackages),
    maxChecksPerWorkPackageNormal: maxNormal,
    maxChecksPerWorkPackageFast: Math.max(maxNormal, maxFast),
    allowFastModeBatching: Boolean(merged.allowFastModeBatching),
    requireExplicitApprovalForHighRiskPackages: Boolean(merged.requireExplicitApprovalForHighRiskPackages),
    highRiskAreas: uniqueNonEmpty(merged.highRiskAreas, base.highRiskAreas),
    stopWhenGoalSatisfied: Boolean(merged.stopWhenGoalSatisfied),
    stopWhenNoSafeRecommendation: Boolean(merged.stopWhenNoSafeRecommendation)
  };
};

export const resolveEffectiveAutopilotPolicy = (
  workflowState?: Partial<Pick<ProjectWorkflowState, "autopilotPolicy">>,
  enabledFallback = false
): AutopilotPolicy => validateAutopilotPolicy(workflowState?.autopilotPolicy, enabledFallback);

export const getAutopilotMaxChecksPerWorkPackage = (policy: AutopilotPolicy, workflowMode: WorkflowMode): number => {
  if (workflowMode === "fast") {
    return policy.allowFastModeBatching
      ? policy.maxChecksPerWorkPackageFast
      : policy.maxChecksPerWorkPackageNormal;
  }
  return policy.maxChecksPerWorkPackageNormal;
};

export const getAutopilotMaxNewRequiredChecksPerCycle = (
  policy: AutopilotPolicy,
  workflowMode: WorkflowMode
): number => {
  if (workflowMode !== "fast") {
    return policy.maxNewRequiredChecksPerCycle;
  }
  return policy.profile === "aggressive"
    ? Math.min(policy.maxNewRequiredChecksPerCycle, 1)
    : 0;
};

export const canUseAgentRecommendationWhenDeterministicPackageExists = (
  policy: AutopilotPolicy,
  workflowMode: WorkflowMode
): boolean => workflowMode === "fast" ? false : policy.allowAgentRecommendationWhenDeterministicPackageExists;

const normalizeRiskText = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();

const highRiskPatterns: Array<{ area: string; pattern: RegExp }> = [
  { area: "credential handling", pattern: /\b(credential|credentials|secret|secrets|api key|token|oauth|password)\b/i },
  { area: "approval policy", pattern: /\bapproval policy|auto approve|auto-approve|approval boundary|approval request\b/i },
  { area: "renderer/main privilege boundary", pattern: /\brenderer\/main|preload|contextisolation|nodeintegration|node api|privilege boundary|main process\b/i },
  { area: "runtime command execution", pattern: /\bruntime command|command execution|exec_command|shell command|spawn process\b/i },
  { area: "sandbox/network policy", pattern: /\bsandbox|network policy|network access|escalat(?:e|ion)|permissions\b/i },
  { area: "merge logic", pattern: /\bmerge logic|merge conflict|git merge|worktree merge|conflict resolution\b/i },
  { area: "workflow state machine", pattern: /\bworkflow state machine|workflow stage|automation loop|autopilot|cycle state\b/i },
  { area: "persistent storage migrations", pattern: /\bpersistent storage|storage migration|schema migration|portable interface|local project record\b/i },
  { area: "secrets/local credential storage", pattern: /\blocal credential storage|safeStorage|secret storage|credential store\b/i },
  { area: "git push/commit automation", pattern: /\bgit push|git commit|commit automation|push automation\b/i }
];

export const isHighRiskAutopilotRecommendation = (
  recommendation: Pick<WorkflowRecommendationOption, "title" | "summary" | "rationale" | "expectedImpact" | "riskLevel" | "relatedPaths">,
  policy: AutopilotPolicy
): boolean => {
  if (recommendation.riskLevel === "high") {
    return true;
  }
  const text = normalizeRiskText([
    recommendation.title,
    recommendation.summary,
    recommendation.rationale,
    recommendation.expectedImpact,
    ...recommendation.relatedPaths
  ].join(" "));
  return highRiskPatterns.some((entry) =>
    policy.highRiskAreas.some((area) => normalizeRiskText(area) === normalizeRiskText(entry.area)) &&
    entry.pattern.test(text)
  );
};

export interface AutopilotPauseState {
  workflow: ProjectWorkflowState;
  agents?: AgentState[];
  projectKind?: ProjectKind;
  workflowObjective?: WorkflowObjective;
  workflowPauseRequested?: boolean;
  projectAccessStatus?: "passed" | "failed" | "unknown";
  nextAction?: string | null;
  recommendation?: WorkflowRecommendationOption;
  previewReady?: boolean;
  repeatedFailure?: boolean;
  goalChangeRequiresApproval?: boolean;
  unsafeScopeBroadening?: boolean;
  promotedRequiredCheckCount?: number;
}

export interface AutopilotPauseDecision {
  shouldPause: boolean;
  reason?: AutopilotPauseReason;
  detail?: string;
  highRiskPackageRequiresApproval: boolean;
}

const isAgentActive = (agent: AgentState): boolean => activeAgentStatuses.has(agent.status);

const isUltimateGoalDetectionAgent = (agent: AgentState): boolean =>
  agent.category === "goal" &&
  (agent.name === "Ultimate Goal Agent" || Boolean(agent.currentPhase?.toLowerCase().includes("ultimate goal")));

const isWorkflowAutomationBlockingAgent = (agent: AgentState): boolean =>
  isAgentActive(agent) &&
  (
    agent.category === "recommendation" ||
    agent.category === "coding" ||
    agent.category === "integrity" ||
    agent.category === "merge" ||
    (agent.category === "goal" && !isUltimateGoalDetectionAgent(agent))
  );

const hasBlockingHumanIntervention = (workflow: ProjectWorkflowState): boolean =>
  workflow.humanInterventions.some((intervention) => intervention.blocking && intervention.status === "pending");

const hasPendingWorkflowAgentApproval = (agents: AgentState[] = []): boolean =>
  agents.some((agent) => agent.category !== "manual" && agent.approvals.some((approval) => approval.status === "pending"));

const hasActiveWorkflowAgent = (agents: AgentState[] = []): boolean =>
  agents.some(isWorkflowAutomationBlockingAgent);

const isWorkflowAppealFinished = (workflow: ProjectWorkflowState): boolean =>
  workflow.appeal.status === "completed" || workflow.appeal.status === "not_applicable";

const failureSignature = (agent: AgentState): string | undefined => {
  const failedEvent = agent.events.find((event) => event.status === "failed");
  const text = [
    agent.category,
    agent.disconnectedReason,
    agent.integrityReport?.summary,
    agent.mergeReport?.summary,
    failedEvent?.title,
    failedEvent?.detail
  ].filter((entry): entry is string => Boolean(entry?.trim())).join(" ");
  const normalized = normalizeRiskText(text).replace(/\b[0-9a-f]{7,}\b/g, "sha").replace(/\d+/g, "n");
  return normalized.length > 8 ? normalized : undefined;
};

const agentOutcomeTime = (agent: AgentState): number => {
  const value =
    agent.integrityReport?.generatedAt ??
    agent.mergeReport?.generatedAt ??
    agent.completedAt ??
    agent.lastActivityAt ??
    agent.startedAt ??
    agent.createdAt;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const hasRepeatedAutopilotFailure = (
  workflow: ProjectWorkflowState,
  agents: AgentState[] = []
): boolean => {
  if (workflow.workflowCycle.status === "completed" || workflow.workflowCycle.status === "merged") {
    return false;
  }

  const cycleAgents = agents.filter((agent) =>
    agent.category !== "manual" &&
    (agent.workflowCycleNumber === undefined || agent.workflowCycleNumber === workflow.workflowCycle.cycleNumber)
  );
  const latestSuccessfulOutcomeByCategory = new Map<AgentState["category"], number>();
  for (const agent of cycleAgents) {
    if (agent.status === "completed") {
      latestSuccessfulOutcomeByCategory.set(
        agent.category,
        Math.max(latestSuccessfulOutcomeByCategory.get(agent.category) ?? 0, agentOutcomeTime(agent))
      );
    }
  }

  const signatures = cycleAgents
    .filter((agent) =>
      agent.category !== "manual" &&
      (agent.status === "failed" || agent.status === "conflicted" || agent.status === "disconnected") &&
      (agent.status !== "disconnected" || !agent.recoveryHandledAt) &&
      (latestSuccessfulOutcomeByCategory.get(agent.category) ?? 0) <= agentOutcomeTime(agent)
    )
    .map(failureSignature)
    .filter((entry): entry is string => Boolean(entry));
  return signatures.some((signature, index) => signatures.indexOf(signature) !== index);
};

const pauseDecision = (
  reason: AutopilotPauseReason,
  detail: string,
  highRiskPackageRequiresApproval = false
): AutopilotPauseDecision => ({
  shouldPause: true,
  reason,
  detail,
  highRiskPackageRequiresApproval
});

export const shouldAutopilotPause = (
  state: AutopilotPauseState,
  policy: AutopilotPolicy
): AutopilotPauseDecision => {
  const workflow = state.workflow;
  const agents = state.agents ?? [];
  const highRiskPackageRequiresApproval = Boolean(
    state.recommendation &&
    policy.requireExplicitApprovalForHighRiskPackages &&
    isHighRiskAutopilotRecommendation(state.recommendation, policy)
  );

  if (!policy.enabled) {
    return {
      shouldPause: false,
      highRiskPackageRequiresApproval
    };
  }
  if (state.previewReady && policy.pauseOnPreviewReady) {
    return pauseDecision("preview_ready", "Preview output is ready for review.", highRiskPackageRequiresApproval);
  }
  if (state.workflowPauseRequested) {
    return pauseDecision("manual_pause_requested", "Workflow automation is paused by the operator.", highRiskPackageRequiresApproval);
  }
  if (state.projectAccessStatus === "failed") {
    return pauseDecision("project_access_validation_failed", "Project access validation failed, so write-enabled automation is blocked.", highRiskPackageRequiresApproval);
  }
  if (policy.stopWhenGoalSatisfied && state.workflowObjective !== "optimize" && workflow.ultimateGoalCompletion?.state === "goal_satisfied" && isWorkflowAppealFinished(workflow)) {
    return pauseDecision("ultimate_goal_satisfied", workflow.ultimateGoalCompletion.rationale, highRiskPackageRequiresApproval);
  }
  if (policy.pauseOnHumanBlocker && hasBlockingHumanIntervention(workflow)) {
    const intervention = workflow.humanInterventions.find((entry) => entry.blocking && entry.status === "pending");
    return pauseDecision("human_blocker", intervention?.reason ?? "A blocking human intervention is pending.", highRiskPackageRequiresApproval);
  }
  if (policy.pauseOnApprovalRequired && hasPendingWorkflowAgentApproval(agents)) {
    return pauseDecision("approval_required", "A workflow agent is waiting on an explicit approval request.", highRiskPackageRequiresApproval);
  }
  if (policy.pauseOnMergeConflict && (workflow.repair.status === "merge_conflicts" || workflow.workflowStopReason === "merge_conflicts")) {
    return pauseDecision("merge_conflict", workflow.repair.latestFailureReason ?? "Merge conflicts require manual review.", highRiskPackageRequiresApproval);
  }
  if (workflow.repair.status === "exhausted" || workflow.workflowStopReason === "repair_budget_exhausted") {
    return pauseDecision("repair_budget_exhausted", workflow.repair.latestFailureReason ?? "The workflow exhausted its repair budget.", highRiskPackageRequiresApproval);
  }
  const boundedRepairStillRunning =
    (workflow.repair.status === "repairing" || workflow.repair.status === "retrying_validation") &&
    workflow.repair.attemptCount <= workflow.repair.maxAttempts;
  if (!boundedRepairStillRunning && (state.repeatedFailure || hasRepeatedAutopilotFailure(workflow, agents))) {
    return pauseDecision("repeated_failure", "The same workflow failure repeated in this cycle.", highRiskPackageRequiresApproval);
  }
  if (state.goalChangeRequiresApproval) {
    return pauseDecision("goal_change_requires_approval", "The planner proposed a goal or checklist change that needs explicit user approval.", highRiskPackageRequiresApproval);
  }
  if (
    workflow.workflowStopReason === "integrity_failed" &&
    (policy.pauseOnIntegrityFailure === "pause" || (policy.pauseOnIntegrityFailure === "policy" && workflow.repair.attemptCount > 0)) &&
    !hasActiveWorkflowAgent(agents)
  ) {
    return pauseDecision("integrity_failure", workflow.repair.latestFailureReason ?? "Integrity failed and policy requires a checkpoint.", highRiskPackageRequiresApproval);
  }
  if (highRiskPackageRequiresApproval) {
    return pauseDecision("high_risk_package_requires_approval", "The selected work package touches a high-risk area and needs explicit approval.", true);
  }
  if (state.unsafeScopeBroadening) {
    return pauseDecision("unsafe_scope_broadening", "Autopilot refused an unsafe attempt to broaden the current scope.", highRiskPackageRequiresApproval);
  }
  if (
    state.promotedRequiredCheckCount !== undefined &&
    state.promotedRequiredCheckCount > getAutopilotMaxNewRequiredChecksPerCycle(policy, workflow.workflowMode)
  ) {
    return pauseDecision("required_check_promotion_cap", "Autopilot refused to promote more required checks than the current policy allows.", highRiskPackageRequiresApproval);
  }
  if (state.nextAction === "approve_recommendation" && !state.recommendation && policy.stopWhenNoSafeRecommendation) {
    return pauseDecision("no_safe_recommendation", "No safe recommendation is available for automatic approval.", highRiskPackageRequiresApproval);
  }

  return {
    shouldPause: false,
    highRiskPackageRequiresApproval
  };
};

export const autopilotRiskRank = (riskLevel: RecommendationRiskLevel): number =>
  riskLevel === "low" ? 0 : riskLevel === "medium" ? 1 : 2;
