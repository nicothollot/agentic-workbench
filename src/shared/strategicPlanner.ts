import { nanoid } from "nanoid";
import { createDefaultAutopilotStrategy, goalRestrictivenessMode } from "./goalCharter";
import type {
  AgentState,
  AutopilotPolicy,
  AutopilotStrategy,
  CandidateTask,
  CandidateTaskKind,
  ChecklistChange,
  CycleRetrospective,
  GoalAttainmentCheck,
  GoalChangeProposal,
  PlannerDecision,
  ProjectWorkflowState,
  RecommendationRiskLevel,
  StrategicAutopilotMode,
  StrategicPlan,
  UltimateGoal,
  WorkflowRecommendationOption,
  WorkPackage
} from "./types";
import { nowIso, unique } from "./utils";

export interface StrategicPlannerInput {
  projectId: string;
  workflow: ProjectWorkflowState;
  recommendations: WorkflowRecommendationOption[];
  workPackages?: WorkPackage[];
  isVisualProject?: boolean;
  repoScanStatus?: string;
  validationCommands?: string[];
  failedCommands?: string[];
  changedFiles?: string[];
  openBlockers?: string[];
  userFeedback?: string[];
  recentAgentOutputs?: string[];
  architectureNotes?: string[];
  sourceAgentId?: string;
  autopilotPolicy?: AutopilotPolicy;
  autopilotEnabled?: boolean;
  now?: string;
}

export interface CycleRetrospectiveInput {
  workflow: ProjectWorkflowState;
  cycleNumber: number;
  agents: AgentState[];
  plannerDecision?: PlannerDecision;
  nextRecommendedTasks?: string[];
  shouldContinue: boolean;
  pauseReason?: string;
  now?: string;
}

const DEFAULT_VALIDATION_COMMANDS = ["npm run typecheck", "npm test", "npm run build"];

const STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "against",
  "also",
  "build",
  "check",
  "code",
  "current",
  "goal",
  "implementation",
  "make",
  "next",
  "project",
  "required",
  "should",
  "task",
  "that",
  "this",
  "toward",
  "ultimate",
  "with",
  "workflow"
]);

const riskRank = (risk: RecommendationRiskLevel): number =>
  risk === "low" ? 0 : risk === "medium" ? 1 : 2;

const priorityScore = (priority: WorkflowRecommendationOption["priority"]): number =>
  priority === "high" ? 24 : priority === "medium" ? 12 : 0;

const uniqueList = (values: Array<string | undefined>, limit: number): string[] =>
  unique(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))).slice(0, limit);

const normalizeText = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();

const tokenize = (value: string): string[] =>
  (normalizeText(value).match(/[a-z0-9]+/g) ?? [])
    .filter((token) => token.length >= 4 && !STOPWORDS.has(token));

const tokenOverlapScore = (left: string, right: string): number => {
  const leftTokens = new Set(tokenize(left));
  const rightTokens = new Set(tokenize(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }
  let matches = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      matches += 1;
    }
  }
  return Math.min(1, matches / Math.max(3, Math.min(leftTokens.size, rightTokens.size)));
};

const goalText = (goal?: UltimateGoal): string =>
  [
    goal?.summary,
    goal?.detailedIntent,
    ...(goal?.successCriteria ?? []),
    ...(goal?.constraints ?? []),
    goal?.qualityBar,
    goal?.targetAudience
  ].filter((entry): entry is string => Boolean(entry?.trim())).join(" ");

const checkMap = (checks: GoalAttainmentCheck[]): Map<string, GoalAttainmentCheck> =>
  new Map(checks.map((check) => [check.id, check]));

const targetedCheckText = (workflow: ProjectWorkflowState, targetedCheckIds: string[]): string => {
  const byId = checkMap(workflow.goalChecklist);
  return targetedCheckIds
    .map((id) => byId.get(id))
    .filter((check): check is GoalAttainmentCheck => Boolean(check))
    .map((check) => `${check.title} ${check.description} ${check.evidence}`)
    .join(" ");
};

const strategy = (workflow: ProjectWorkflowState): AutopilotStrategy =>
  workflow.goalCharter?.autopilotStrategy ?? createDefaultAutopilotStrategy();

const currentEffectiveGoal = (workflow: ProjectWorkflowState): UltimateGoal =>
  workflow.goalCharter?.currentEffectiveGoal?.summary
    ? workflow.goalCharter.currentEffectiveGoal
    : workflow.ultimateGoal;

const originalUltimateGoal = (workflow: ProjectWorkflowState): UltimateGoal =>
  workflow.goalCharter?.originalUltimateGoal?.summary
    ? workflow.goalCharter.originalUltimateGoal
    : workflow.ultimateGoal;

export const resolveStrategicAutopilotMode = (
  currentStrategy: AutopilotStrategy,
  options: { autopilotEnabled?: boolean; policy?: AutopilotPolicy } = {}
): StrategicAutopilotMode => {
  if (!options.autopilotEnabled && !options.policy?.enabled) {
    return "manual";
  }
  if (
    currentStrategy.approvalSensitivity === "strict" ||
    currentStrategy.autonomyBudget.maxConsecutiveTasksWithoutUserReview <= 1 ||
    currentStrategy.autonomyBudget.maxCyclesBeforePause <= 1
  ) {
    return currentStrategy.goalRestrictiveness >= 90 ? "guided" : "autopilot_safe";
  }
  if (
    options.policy?.profile === "aggressive" ||
    currentStrategy.taskBatchingAggressiveness === "very_high" ||
    (currentStrategy.riskTolerance === "high" && currentStrategy.autonomyBudget.maxCyclesBeforePause >= 6)
  ) {
    return "autopilot_aggressive";
  }
  if (currentStrategy.goalRestrictiveness < 50 || currentStrategy.innovationLatitude >= 70) {
    return "autopilot_creative";
  }
  return "autopilot_balanced";
};

export const buildStrategyHighlights = (currentStrategy: AutopilotStrategy): string[] => [
  `Mode preset ${currentStrategy.presetId}`,
  `Goal restrictiveness ${currentStrategy.goalRestrictiveness} (${goalRestrictivenessMode(currentStrategy.goalRestrictiveness)})`,
  `${currentStrategy.planningHorizon} horizon`,
  `${currentStrategy.taskBatchingAggressiveness} batching`,
  `${currentStrategy.riskTolerance} risk tolerance`,
  `${currentStrategy.refactorAppetite} refactor appetite`,
  `${currentStrategy.visualPriority} visual priority`,
  `Visual preferences ${buildVisualPreferenceBrief(currentStrategy)}`,
  `${currentStrategy.validationStrictness} validation strictness`,
  `${currentStrategy.approvalSensitivity} approvals`
];

const humanizeStrategyValue = (value: string): string => value.replace(/_/g, " ");

export const buildVisualPreferenceBrief = (currentStrategy: AutopilotStrategy): string => {
  const preferences = currentStrategy.visualPreferences;
  const accessibility = preferences.accessibilityPriority === "high_contrast"
    ? "high-contrast accessibility with non-color status cues and clear focus rings"
    : preferences.accessibilityPriority === "keyboard_first"
      ? "keyboard-first accessibility with visible focus and reachable controls"
      : preferences.accessibilityPriority === "screen_reader_conscious"
        ? "screen-reader-conscious labels, hierarchy, and state text"
        : "readable contrast and visible focus by default";
  const strictness = preferences.designStrictness === "follow_user_exactly"
    ? "follow the stated aesthetic closely"
    : "improve the design where it materially helps clarity";
  return [
    `${humanizeStrategyValue(preferences.theme)} theme`,
    `${humanizeStrategyValue(preferences.density)} density`,
    `${humanizeStrategyValue(preferences.feel)} feel`,
    `${humanizeStrategyValue(preferences.layoutPriority)} layout priority`,
    `primary ${preferences.primaryColor}`,
    `accent ${preferences.accentColor}`,
    `${humanizeStrategyValue(preferences.motionPreference)} motion`,
    accessibility,
    strictness
  ].join("; ");
};

const validationCommandsFor = (
  recommendation: Pick<WorkflowRecommendationOption, "title" | "summary" | "riskLevel">,
  currentStrategy: AutopilotStrategy,
  availableCommands: string[] = DEFAULT_VALIDATION_COMMANDS
): string[] => {
  const commands = availableCommands.length ? availableCommands : DEFAULT_VALIDATION_COMMANDS;
  const text = `${recommendation.title} ${recommendation.summary}`;
  if (/\b(test|coverage|regression)\b/i.test(text)) {
    return uniqueList(["npm test", ...commands], 4);
  }
  if (/\b(type|schema|ipc|typescript)\b/i.test(text)) {
    return uniqueList(["npm run typecheck", ...commands], 4);
  }
  if (recommendation.riskLevel === "high" || currentStrategy.validationStrictness === "very_high") {
    return commands.slice(0, 4);
  }
  if (currentStrategy.validationStrictness === "high") {
    return commands.slice(0, 3);
  }
  if (currentStrategy.validationStrictness === "medium") {
    return commands.slice(0, 2);
  }
  return commands.slice(0, 1);
};

const isPreviewCheckpoint = (
  recommendation: Pick<WorkflowRecommendationOption, "title" | "summary">
): boolean =>
  /\bpreview\b/i.test(`${recommendation.title} ${recommendation.summary}`) &&
  /\b(?:generate|runnable|visible|checkpoint|inspect)\b/i.test(`${recommendation.title} ${recommendation.summary}`);

const classifyRecommendation = (recommendation: WorkflowRecommendationOption): CandidateTaskKind => {
  const text = `${recommendation.title} ${recommendation.summary}`;
  if (isPreviewCheckpoint(recommendation)) {
    return "validation";
  }
  if (/^Satisfy work package:/i.test(recommendation.title)) {
    return "work_package";
  }
  if (/^Satisfy goal check:/i.test(recommendation.title)) {
    return "goal_check";
  }
  if (/\b(unblock|resolve|blocker|human intervention|merge conflict)\b/i.test(text)) {
    return "blocker";
  }
  if (/\b(test|coverage|regression|validation)\b/i.test(text)) {
    return "validation";
  }
  if (/\b(visual|ui|ux|layout|contrast|readability|responsive|hierarchy|polish|dashboard|spacing|theme)\b/i.test(text)) {
    return "visual_polish";
  }
  if (/\b(stabilize|harden|edge case|repair)\b/i.test(text)) {
    return "stabilization";
  }
  if (/\b(goal|direction|feature|slice|product)\b/i.test(text)) {
    return "goal_evolution";
  }
  return "custom";
};

const hasVisualImpact = (
  recommendation: Pick<WorkflowRecommendationOption, "title" | "summary" | "relatedPaths">,
  isVisualProject?: boolean
): boolean => {
  const text = `${recommendation.title} ${recommendation.summary} ${recommendation.relatedPaths.join(" ")}`;
  return Boolean(isVisualProject) && /\b(visual|ui|ux|layout|contrast|readability|responsive|hierarchy|polish|dashboard|spacing|theme|renderer|css|tsx|jsx)\b/i.test(text);
};

const batchingLimit = (currentStrategy: AutopilotStrategy): number => {
  switch (currentStrategy.taskBatchingAggressiveness) {
    case "low":
      return 1;
    case "medium":
      return 2;
    case "high":
      return 4;
    case "very_high":
      return 7;
  }
};

const repetitionPenalty = (
  recommendation: WorkflowRecommendationOption,
  workflow: ProjectWorkflowState,
  failedCommands: string[]
): number => {
  const title = normalizeText(recommendation.title);
  const repeatedDecision = workflow.memory.lastAcceptedDecisions
    .slice(0, 6)
    .some((decision) => {
      const previous = normalizeText(decision.title);
      return previous === title || previous.includes(title) || title.includes(previous);
    });
  const repeatedFailure = failedCommands.some((command) =>
    tokenOverlapScore(command, `${recommendation.title} ${recommendation.summary}`) >= 0.45
  );
  return (repeatedDecision ? 70 : 0) + (repeatedFailure ? 45 : 0);
};

const riskPenalty = (risk: RecommendationRiskLevel, currentStrategy: AutopilotStrategy): number => {
  const rank = riskRank(risk);
  if (rank === 0) {
    return 0;
  }
  if (currentStrategy.riskTolerance === "low") {
    return rank * 46;
  }
  if (currentStrategy.riskTolerance === "medium") {
    return rank * 27;
  }
  return rank * 11;
};

const batchingScore = (targetedCount: number, recommendation: WorkflowRecommendationOption, currentStrategy: AutopilotStrategy): number => {
  const scopePenalty = recommendation.estimatedScope === "large" ? 35 : recommendation.estimatedScope === "medium" ? 8 : 0;
  switch (currentStrategy.taskBatchingAggressiveness) {
    case "low":
      return targetedCount <= 1 ? 28 - scopePenalty : -Math.min(80, (targetedCount - 1) * 28 + scopePenalty);
    case "medium":
      return Math.min(targetedCount, 2) * 20 - scopePenalty;
    case "high":
      return Math.min(targetedCount, 5) * 24 - Math.round(scopePenalty / 2);
    case "very_high":
      return Math.min(targetedCount, 8) * 27 - Math.round(scopePenalty / 3);
  }
};

const restrictivenessScore = (
  candidateKind: CandidateTaskKind,
  strictAligned: boolean,
  smallSupportive: boolean,
  currentStrategy: AutopilotStrategy
): number => {
  const value = currentStrategy.goalRestrictiveness;
  if (value >= 90) {
    return strictAligned ? 70 : -160;
  }
  if (value >= 70) {
    return strictAligned ? 45 : smallSupportive ? 8 : -62;
  }
  if (value >= 50) {
    return strictAligned ? 28 : smallSupportive ? 26 : -10;
  }
  if (value >= 25) {
    return candidateKind === "goal_evolution" ? 44 : strictAligned ? 24 : smallSupportive ? 25 : 4;
  }
  return candidateKind === "goal_evolution" ? 72 : strictAligned ? 18 : smallSupportive ? 20 : 12;
};

const approvalRequiredFor = (
  recommendation: WorkflowRecommendationOption,
  currentStrategy: AutopilotStrategy,
  goalChangeProposalIds: string[]
): boolean => {
  if (goalChangeProposalIds.length > 0) {
    return true;
  }
  if (recommendation.riskLevel === "high") {
    return currentStrategy.approvalSensitivity !== "autonomous" || currentStrategy.riskTolerance !== "high";
  }
  if (currentStrategy.goalRestrictiveness < 25 && /\b(direction|goal|major|architecture|feature expansion)\b/i.test(`${recommendation.title} ${recommendation.summary}`)) {
    return true;
  }
  return false;
};

const recommendationCandidate = (
  input: StrategicPlannerInput,
  recommendation: WorkflowRecommendationOption
): CandidateTask => {
  const currentStrategy = strategy(input.workflow);
  const currentGoal = currentEffectiveGoal(input.workflow);
  const originalGoal = originalUltimateGoal(input.workflow);
  const targetedCheckIds = recommendation.targetedCheckIds ?? [];
  const checkText = targetedCheckText(input.workflow, targetedCheckIds);
  const candidateText = `${recommendation.title} ${recommendation.summary} ${recommendation.rationale} ${checkText}`;
  const currentAlignment = Math.max(tokenOverlapScore(candidateText, goalText(currentGoal)), targetedCheckIds.length ? 0.82 : 0);
  const originalAlignment = Math.max(tokenOverlapScore(candidateText, goalText(originalGoal)), targetedCheckIds.length ? 0.72 : 0);
  const kind = classifyRecommendation(recommendation);
  const previewCheckpoint = isPreviewCheckpoint(recommendation);
  const visualDesignImpact = hasVisualImpact(recommendation, input.isVisualProject);
  const visualPreferenceBrief = visualDesignImpact ? buildVisualPreferenceBrief(currentStrategy) : "";
  const smallSupportive = kind === "validation" || kind === "stabilization" || (kind === "visual_polish" && visualDesignImpact);
  const strictAligned = previewCheckpoint || targetedCheckIds.length > 0 || /^Satisfy (?:work package|goal check):/i.test(recommendation.title) || currentAlignment >= 0.35;
  const checklistImpact = targetedCheckIds.length > 0
    ? Math.min(120, targetedCheckIds.length * 34 + priorityScore(recommendation.priority))
    : kind === "blocker"
      ? 38
      : 0;
  const visualScore = visualDesignImpact
    ? currentStrategy.visualPriority === "very_high" ? 52 : currentStrategy.visualPriority === "high" ? 36 : currentStrategy.visualPriority === "medium" ? 16 : 0
    : 0;
  const unblockScore = kind === "blocker" ? 72 : 0;
  const validationCommands = validationCommandsFor(recommendation, currentStrategy, input.validationCommands);
  const validationScore = validationCommands.length * (currentStrategy.validationStrictness === "very_high" ? 13 : 10);
  const repeatPenalty = repetitionPenalty(recommendation, input.workflow, input.failedCommands ?? []);
  const risk = -riskPenalty(recommendation.riskLevel, currentStrategy);
  const scoreBreakdown = {
    currentGoalAlignment: Math.round(currentAlignment * 96),
    originalGoalAlignment: Math.round(originalAlignment * (currentStrategy.goalRestrictiveness >= 70 ? 82 : 52)),
    checklistImpact,
    batchingLeverage: batchingScore(targetedCheckIds.length, recommendation, currentStrategy),
    risk,
    validationAvailability: validationScore,
    strategyFit: restrictivenessScore(kind, strictAligned, smallSupportive, currentStrategy),
    visualPriority: visualScore,
    unblockPotential: unblockScore,
    previewCheckpoint: previewCheckpoint ? 180 : 0,
    probabilityOfSuccess: Math.round(recommendation.confidence * 54),
    repetition: -repeatPenalty,
    coherentProductIncrement: strictAligned || visualDesignImpact || kind === "blocker" ? 38 : 12,
    recommendationPriority: priorityScore(recommendation.priority)
  };
  const score = Object.values(scoreBreakdown).reduce((sum, value) => sum + value, 0);
  const shouldSplit =
    recommendation.estimatedScope === "large" ||
    targetedCheckIds.length > batchingLimit(currentStrategy) ||
    (recommendation.riskLevel === "high" && currentStrategy.riskTolerance === "low");
  const approvalRequired = approvalRequiredFor(recommendation, currentStrategy, []);

  return {
    id: `candidate:${recommendation.id}`,
    kind,
    title: recommendation.title,
    summary: recommendation.summary,
    recommendationId: recommendation.id,
    sourceWorkPackageId: recommendation.sourceWorkPackageId,
    targetedCheckIds,
    expectedChecklistImpact: targetedCheckIds.length
      ? `Advances ${targetedCheckIds.length} targeted checklist item${targetedCheckIds.length === 1 ? "" : "s"}.`
      : smallSupportive
        ? "Improves validation, stability, or visible product quality without adding required checklist scope."
        : "Moves a bounded product slice that should be reconciled with the checklist after validation.",
    expectedFiles: recommendation.relatedPaths.slice(0, 8),
    expectedValidationCommands: validationCommands,
    riskLevel: recommendation.riskLevel,
    whyNext: [
      strictAligned ? "It is aligned with the Current Effective Goal." : "It is adjacent to the current product direction.",
      previewCheckpoint ? "The operator requested a preview checkpoint, so it takes priority before normal checklist execution." : "",
      targetedCheckIds.length ? `It can advance ${targetedCheckIds.length} checklist target${targetedCheckIds.length === 1 ? "" : "s"}.` : "",
      visualDesignImpact ? "Visual quality is part of the strategy for this GUI project." : "",
      visualPreferenceBrief ? `Use the stored visual preferences: ${visualPreferenceBrief}.` : "",
      repeatPenalty ? "It was penalized because similar work or failures appeared recently." : ""
    ].filter(Boolean).join(" "),
    approvalRequired,
    goalChangeProposalIds: [],
    checklistChangeIds: [],
    visualDesignImpact,
    shouldSplit,
    score,
    scoreBreakdown,
    confidence: recommendation.confidence
  };
};

const buildVisualCandidate = (input: StrategicPlannerInput, timestamp: string): CandidateTask | undefined => {
  const currentStrategy = strategy(input.workflow);
  if (!input.isVisualProject || (currentStrategy.visualPriority !== "high" && currentStrategy.visualPriority !== "very_high")) {
    return undefined;
  }
  const hasVisualRecommendation = input.recommendations.some((recommendation) =>
    hasVisualImpact(recommendation, true)
  );
  if (hasVisualRecommendation) {
    return undefined;
  }
  const uiPaths = uniqueList([
    ...(input.changedFiles ?? []),
    ...(input.architectureNotes ?? [])
  ], 8).filter((entry) => /\.(tsx?|jsx?|css|scss|html)$/i.test(entry) || /\b(renderer|app|page|component|dashboard|style)\b/i.test(entry));
  const riskLevel: RecommendationRiskLevel = "low";
  const visualPreferenceBrief = buildVisualPreferenceBrief(currentStrategy);
  const syntheticRecommendation: WorkflowRecommendationOption = {
    id: `visual:${timestamp}`,
    rank: 999,
    title: "Improve visible interface quality",
    summary: `Tighten contrast, readability, hierarchy, responsive behavior, dashboard feel, and comfortable card/table/transcript inspection in one bounded pass. Visual preferences: ${visualPreferenceBrief}.`,
    rationale: "The strategy gives visual quality explicit weight for GUI projects, so polish is product progress rather than optional cleanup.",
    expectedImpact: "The current product becomes easier to scan, inspect, and trust without changing the Original Ultimate Goal. Include empty/loading/error/recovery states when the touched surface exposes them.",
    priority: "high",
    confidence: 0.84,
    estimatedScope: currentStrategy.taskBatchingAggressiveness === "low" ? "small" : "medium",
    riskLevel,
    relatedPaths: uiPaths.slice(0, 6)
  };
  return {
    ...recommendationCandidate({ ...input, recommendations: [syntheticRecommendation] }, syntheticRecommendation),
    id: syntheticRecommendation.id,
    kind: "visual_polish",
    visualDesignImpact: true,
    whyNext: `The project has a visual interface and the strategy marks visual quality as a high-priority part of the final product. Use the stored visual preferences: ${visualPreferenceBrief}.`
  };
};

const buildExpansionCandidates = (
  input: StrategicPlannerInput,
  timestamp: string
): {
  candidates: CandidateTask[];
  proposedChecklistChanges: ChecklistChange[];
  proposedGoalChanges: GoalChangeProposal[];
} => {
  const currentStrategy = strategy(input.workflow);
  if (currentStrategy.goalRestrictiveness >= 50) {
    return { candidates: [], proposedChecklistChanges: [], proposedGoalChanges: [] };
  }

  const cycleNumber = input.workflow.workflowCycle.cycleNumber;
  const currentGoal = currentEffectiveGoal(input.workflow);
  const originalGoal = originalUltimateGoal(input.workflow);
  const affectedGoalArea = currentGoal.summary || originalGoal.summary || "Current Effective Goal";
  const checklistChange: ChecklistChange = {
    id: nanoid(),
    action: "add",
    checklistItemIds: [],
    title: currentStrategy.goalRestrictiveness < 25
      ? "Explore a divergent but related product direction"
      : "Expand checklist for a meaningful product improvement",
    rationale: currentStrategy.goalRestrictiveness < 25
      ? "Goal restrictiveness is very low, so the planner may propose divergent related directions, but it must not apply them without explicit approval."
      : "Goal restrictiveness allows meaningful checklist expansion when the route still supports the Current Effective Goal.",
    sourceCycle: cycleNumber,
    sourceAgent: input.sourceAgentId,
    userApprovalStatus: "pending",
    confidence: currentStrategy.goalRestrictiveness < 25 ? 0.58 : 0.68,
    risk: currentStrategy.goalRestrictiveness < 25 ? "high" : "medium",
    affectedGoalArea,
    linkedEvidence: [currentGoal.summary || originalGoal.summary].filter(Boolean),
    linkedChangedFiles: input.changedFiles ?? [],
    linkedValidationCommands: validationCommandsFor({
      title: "Proposed goal expansion",
      summary: affectedGoalArea,
      riskLevel: "medium"
    }, currentStrategy, input.validationCommands),
    linkedCycleIds: [cycleNumber],
    linkedAgentIds: input.sourceAgentId ? [input.sourceAgentId] : [],
    createdAt: timestamp
  };

  const proposedGoalChanges: GoalChangeProposal[] = [];
  const goalChangeIds: string[] = [];
  if (currentStrategy.goalRestrictiveness < 25) {
    const proposedGoal: UltimateGoal = {
      ...currentGoal,
      summary: currentGoal.summary
        ? `${currentGoal.summary} with an explicitly approved exploratory extension`
        : "Exploratory extension of the Current Effective Goal",
      detailedIntent: [
        currentGoal.detailedIntent,
        "Planner proposal only: consider a divergent but related direction if the user accepts or edits this goal change."
      ].filter(Boolean).join("\n\n"),
      lastUpdatedAt: timestamp
    };
    const proposal: GoalChangeProposal = {
      id: nanoid(),
      title: "Planner-proposed exploratory goal evolution",
      summary: proposedGoal.summary,
      rationale: "The strategy allows divergent related proposals at very low restrictiveness, but the Original Ultimate Goal remains unchanged unless the user explicitly accepts an edited Current Effective Goal.",
      source: "planner",
      proposedGoal,
      fromGoalSummary: currentGoal.summary,
      toGoalSummary: proposedGoal.summary,
      createdAt: timestamp,
      approvalStatus: "pending",
      requiredByStrategy: true,
      risk: "high",
      affectedGoalArea
    };
    proposedGoalChanges.push(proposal);
    goalChangeIds.push(proposal.id);
  }

  const candidate: CandidateTask = {
    id: `candidate:goal-evolution:${timestamp}`,
    kind: "goal_evolution",
    title: currentStrategy.goalRestrictiveness < 25
      ? "Propose a divergent related goal direction"
      : "Propose a meaningful checklist expansion",
    summary: currentStrategy.goalRestrictiveness < 25
      ? "Create an explicit reviewable proposal for a divergent but related product direction before any implementation."
      : "Add or reprioritize checklist coverage for a meaningful product improvement that still supports the Current Effective Goal.",
    targetedCheckIds: [],
    expectedChecklistImpact: "Creates reviewable checklist or goal-change proposals instead of silently expanding scope.",
    expectedFiles: [],
    expectedValidationCommands: checklistChange.linkedValidationCommands,
    riskLevel: checklistChange.risk,
    whyNext: currentStrategy.goalRestrictiveness < 25
      ? "The strategy permits divergent related proposals, but approval is required before the goal changes."
      : "The strategy permits meaningful product-direction proposals and checklist expansion when they can improve the route to the goal.",
    approvalRequired: true,
    goalChangeProposalIds: goalChangeIds,
    checklistChangeIds: [checklistChange.id],
    visualDesignImpact: Boolean(input.isVisualProject && currentStrategy.visualPriority !== "low"),
    shouldSplit: true,
    score: currentStrategy.goalRestrictiveness < 25 ? 210 : 190,
    scoreBreakdown: {
      currentGoalAlignment: currentStrategy.goalRestrictiveness < 25 ? 20 : 44,
      originalGoalAlignment: currentStrategy.goalRestrictiveness < 25 ? 12 : 32,
      checklistImpact: 24,
      batchingLeverage: 0,
      risk: -riskPenalty(checklistChange.risk, currentStrategy),
      validationAvailability: checklistChange.linkedValidationCommands.length * 8,
      strategyFit: currentStrategy.goalRestrictiveness < 25 ? 88 : 62,
      visualPriority: input.isVisualProject ? 16 : 0,
      unblockPotential: 0,
      probabilityOfSuccess: Math.round(checklistChange.confidence * 40),
      repetition: 0,
      coherentProductIncrement: 22,
      recommendationPriority: 0
    },
    confidence: checklistChange.confidence
  };
  candidate.score = Object.values(candidate.scoreBreakdown).reduce((sum, value) => sum + value, 0);

  return {
    candidates: [candidate],
    proposedChecklistChanges: [checklistChange],
    proposedGoalChanges
  };
};

const sortCandidates = (candidates: CandidateTask[]): CandidateTask[] =>
  [...candidates].sort((left, right) =>
    right.score - left.score ||
    Number(left.approvalRequired) - Number(right.approvalRequired) ||
    riskRank(left.riskLevel) - riskRank(right.riskLevel) ||
    right.confidence - left.confidence ||
    left.title.localeCompare(right.title)
  );

export const buildStrategicPlan = (input: StrategicPlannerInput): StrategicPlan => {
  const timestamp = input.now ?? nowIso();
  const currentStrategy = strategy(input.workflow);
  const expansion = buildExpansionCandidates(input, timestamp);
  const candidates = input.recommendations.map((recommendation) => recommendationCandidate(input, recommendation));
  const visualCandidate = buildVisualCandidate(input, timestamp);
  const rankedCandidates = sortCandidates([
    ...candidates,
    ...(visualCandidate ? [visualCandidate] : []),
    ...expansion.candidates
  ]);
  const selected = rankedCandidates.find((candidate) => !candidate.shouldSplit || currentStrategy.taskBatchingAggressiveness !== "low")
    ?? rankedCandidates[0];
  const pendingProposalIds = new Set([
    ...expansion.proposedGoalChanges.map((proposal) => proposal.id),
    ...expansion.proposedChecklistChanges.map((change) => change.id)
  ]);
  const requiresApproval = Boolean(
    selected?.approvalRequired ||
    (selected && [...selected.goalChangeProposalIds, ...selected.checklistChangeIds].some((id) => pendingProposalIds.has(id)))
  );
  const mode = resolveStrategicAutopilotMode(currentStrategy, {
    autopilotEnabled: input.autopilotEnabled,
    policy: input.autopilotPolicy
  });
  const continueRecommendation: StrategicPlan["continueRecommendation"] = rankedCandidates.length === 0
    ? "pause"
    : requiresApproval
      ? "ask_user"
      : "continue";

  return {
    id: nanoid(),
    projectId: input.projectId,
    cycleNumber: input.workflow.workflowCycle.cycleNumber,
    createdAt: timestamp,
    originalGoalSummary: originalUltimateGoal(input.workflow).summary,
    currentEffectiveGoalSummary: currentEffectiveGoal(input.workflow).summary,
    mode,
    strategySnapshot: {
      ...currentStrategy,
      visualPreferences: { ...currentStrategy.visualPreferences },
      autonomyBudget: { ...currentStrategy.autonomyBudget }
    },
    strategyHighlights: buildStrategyHighlights(currentStrategy),
    repoScanStatus: input.repoScanStatus ?? "Repo scan available for strategic planning.",
    previousCycleOutcomes: input.workflow.memory.perCycleSummaries.slice(0, 4).map((summary) => summary.summary),
    failedCommands: (input.failedCommands ?? []).slice(0, 8),
    changedFiles: (input.changedFiles ?? []).slice(0, 20),
    openBlockers: (input.openBlockers ?? input.workflow.memory.knownOpenIssues.filter((issue) => issue.status === "open").map((issue) => issue.title)).slice(0, 12),
    userFeedback: (input.userFeedback ?? []).slice(0, 8),
    recentAgentOutputs: (input.recentAgentOutputs ?? []).slice(0, 8),
    architectureNotes: (input.architectureNotes ?? []).slice(0, 8),
    candidateTasks: rankedCandidates,
    candidateWorkPackages: (input.workPackages ?? input.workflow.workPackages ?? []).slice(0, 8),
    proposedGoalChanges: expansion.proposedGoalChanges,
    proposedChecklistChanges: expansion.proposedChecklistChanges,
    recommendedTaskId: selected?.id,
    requiresApproval,
    plannerSummary: selected
      ? `${selected.title} is ranked next because ${selected.whyNext}`
      : "No safe candidate task is available.",
    continueRecommendation,
    pauseReason: rankedCandidates.length === 0
      ? "No safe candidate task is available."
      : requiresApproval
        ? "The selected plan proposes a goal/checklist change or risky work that needs approval."
        : undefined
  };
};

export const decisionFromStrategicPlan = (plan: StrategicPlan): PlannerDecision => {
  const selected = plan.candidateTasks.find((candidate) => candidate.id === plan.recommendedTaskId) ?? plan.candidateTasks[0];
  return {
    id: nanoid(),
    planId: plan.id,
    cycleNumber: plan.cycleNumber,
    selectedTaskId: selected?.id,
    selectedRecommendationId: selected?.recommendationId,
    selectedTaskTitle: selected?.title,
    whySelected: selected
      ? `${selected.whyNext} Score ${Math.round(selected.score)} using ${plan.strategyHighlights.join("; ")}.`
      : plan.pauseReason ?? "No task selected.",
    score: selected?.score ?? 0,
    scoreBreakdown: selected?.scoreBreakdown ?? {},
    strategySettingsUsed: plan.strategyHighlights,
    targetedChecklistIds: selected?.targetedCheckIds ?? [],
    expectedFiles: selected?.expectedFiles ?? [],
    expectedValidationCommands: selected?.expectedValidationCommands ?? [],
    approvalRequired: Boolean(selected?.approvalRequired || plan.requiresApproval),
    goalChangeProposalIds: selected?.goalChangeProposalIds ?? [],
    checklistChangeIds: selected?.checklistChangeIds ?? [],
    visualDesignImpact: Boolean(selected?.visualDesignImpact),
    createdAt: plan.createdAt
  };
};

export const selectNextWorkPackage = (input: StrategicPlannerInput): PlannerDecision =>
  decisionFromStrategicPlan(buildStrategicPlan(input));

export const rankRecommendationsByStrategicPlan = (
  recommendations: WorkflowRecommendationOption[],
  plan: StrategicPlan
): WorkflowRecommendationOption[] => {
  const rankByRecommendationId = new Map<string, number>();
  plan.candidateTasks.forEach((candidate, index) => {
    if (candidate.recommendationId && !rankByRecommendationId.has(candidate.recommendationId)) {
      rankByRecommendationId.set(candidate.recommendationId, index);
    }
  });
  return [...recommendations]
    .sort((left, right) =>
      (rankByRecommendationId.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
      (rankByRecommendationId.get(right.id) ?? Number.MAX_SAFE_INTEGER) ||
      left.rank - right.rank ||
      right.confidence - left.confidence
    )
    .map((recommendation, index) => ({
      ...recommendation,
      rank: index + 1
    }));
};

export const buildCycleRetrospective = (input: CycleRetrospectiveInput): CycleRetrospective => {
  const timestamp = input.now ?? nowIso();
  const changedFiles = uniqueList(input.agents.flatMap((agent) => agent.changedFiles), 40);
  const commandsRun = uniqueList(input.agents.flatMap((agent) => agent.commandLog.map((command) => command.command)), 40);
  const integrityChecks = input.agents.flatMap((agent) => agent.integrityReport?.checks ?? []);
  const passed = uniqueList([
    ...integrityChecks.filter((check) => check.status === "passed").map((check) => check.command || check.name),
    ...input.agents.flatMap((agent) => agent.commandLog.filter((command) => command.exitCode === 0).map((command) => command.command))
  ], 20);
  const failed = uniqueList([
    ...integrityChecks.filter((check) => check.status === "failed").map((check) => `${check.command || check.name}: ${check.outputSnippet}`),
    ...input.agents.flatMap((agent) => agent.commandLog.filter((command) => typeof command.exitCode === "number" && command.exitCode !== 0).map((command) => `${command.command}: exit ${command.exitCode}`)),
    ...input.agents.filter((agent) => agent.status === "failed" || agent.status === "conflicted" || agent.status === "disconnected").map((agent) => `${agent.name}: ${agent.disconnectedReason ?? agent.status}`)
  ], 20);
  const checklistItemsAdvanced = uniqueList([
    ...(input.plannerDecision?.targetedChecklistIds ?? []),
    ...input.workflow.goalChecklist
      .filter((check) =>
        check.introducedCycleNumber === input.cycleNumber ||
        (check.evidenceHistory ?? []).some((entry) => input.agents.some((agent) => agent.id === entry.ownerAgentId))
      )
      .map((check) => `${check.status}: ${check.title}`)
  ], 20);
  const learned = uniqueList([
    input.workflow.ultimateGoalCompletion?.rationale,
    ...input.agents.map((agent) => agent.integrityReport?.summary),
    ...input.agents.map((agent) => agent.mergeReport?.summary),
    ...input.agents.map((agent) => agent.lastMessageSnippet)
  ], 8);

  return {
    id: nanoid(),
    cycleNumber: input.cycleNumber,
    createdAt: timestamp,
    triedToDo: input.workflow.scopedGoal?.summary ?? input.workflow.approvedRecommendation?.title ?? input.plannerDecision?.selectedTaskTitle ?? `Cycle ${input.cycleNumber}`,
    whyChosen: input.plannerDecision?.whySelected ?? input.workflow.approvedRecommendation?.rationale ?? "No planner decision was retained for this cycle.",
    changedFiles,
    commandsRun,
    passed,
    failed,
    learned,
    checklistItemsAdvanced,
    goalChecklistChangeRecommendation: input.workflow.goalCharter.proposedGoalChanges.length > 0
      ? "Goal/checklist proposals are pending review before they change the effective goal."
      : checklistItemsAdvanced.length > 0
        ? "Update checklist evidence for the advanced items and replan from the remaining open checks."
        : "No checklist evidence moved; replan around the next highest-impact open check.",
    nextRecommendedTasks: input.nextRecommendedTasks?.slice(0, 6) ?? input.workflow.recommendations.slice(0, 3).map((recommendation) => recommendation.title),
    shouldContinue: input.shouldContinue,
    pauseReason: input.pauseReason
  };
};
