import type {
  AutopilotPreset,
  AutopilotPresetId,
  AutopilotStrategy,
  GoalCharter,
  GoalRestrictivenessMode,
  UltimateGoal,
  VisualPreferenceProfile
} from "./types";

const emptyUltimateGoal = (source: UltimateGoal["source"] = "user"): UltimateGoal => ({
  summary: "",
  detailedIntent: "",
  successCriteria: [],
  constraints: [],
  nonGoals: [],
  targetAudience: "",
  qualityBar: "",
  source
});

export const hasMeaningfulGoalText = (goal?: Pick<UltimateGoal, "summary" | "detailedIntent"> | null): boolean =>
  Boolean(goal?.summary?.trim() || goal?.detailedIntent?.trim());

export const goalRestrictivenessMode = (value: number): GoalRestrictivenessMode => {
  if (value >= 90) {
    return "very_strict";
  }
  if (value >= 70) {
    return "goal_first";
  }
  if (value >= 50) {
    return "balanced";
  }
  if (value >= 25) {
    return "exploratory";
  }
  return "highly_creative";
};

export const defaultVisualPreferenceProfile = (): VisualPreferenceProfile => ({
  theme: "system",
  primaryColor: "#102747",
  accentColor: "#b56f3f",
  density: "balanced",
  feel: "professional",
  layoutPriority: "command_center",
  motionPreference: "subtle",
  accessibilityPriority: "normal",
  designStrictness: "allow_model_improvement"
});

const strategy = (
  presetId: AutopilotPresetId,
  overrides: Partial<AutopilotStrategy>
): AutopilotStrategy => {
  const base: AutopilotStrategy = {
    presetId,
    goalRestrictiveness: 60,
    planningHorizon: "medium",
    taskBatchingAggressiveness: "medium",
    innovationLatitude: 50,
    riskTolerance: "medium",
    refactorAppetite: "medium",
    visualPriority: "high",
    visualPreferences: defaultVisualPreferenceProfile(),
    validationStrictness: "high",
    autonomyBudget: {
      maxCyclesBeforePause: 3,
      maxMinutesBeforePause: 45,
      maxFailedRepairAttempts: 2,
      maxConsecutiveTasksWithoutUserReview: 3,
      stopWhenGoalComplete: true,
      stopWhenNoSafeNextTaskExists: true,
      stopWhenPlannerWantsToChangeUltimateGoal: true,
      stopWhenValidationFailsRepeatedly: true
    },
    approvalSensitivity: "normal"
  };
  return {
    ...base,
    ...overrides,
    visualPreferences: {
      ...base.visualPreferences,
      ...overrides.visualPreferences
    },
    autonomyBudget: {
      ...base.autonomyBudget,
      ...overrides.autonomyBudget
    }
  };
};

export const listAutopilotPresets = (): AutopilotPreset[] => [
  {
    id: "exact_builder",
    label: "Exact Builder",
    description: "Tight scope, short plans, explicit approvals, and minimal creative additions.",
    strategy: strategy("exact_builder", {
      goalRestrictiveness: 95,
      planningHorizon: "short",
      taskBatchingAggressiveness: "low",
      innovationLatitude: 15,
      riskTolerance: "low",
      refactorAppetite: "low",
      visualPriority: "medium",
      validationStrictness: "very_high",
      approvalSensitivity: "strict",
      autonomyBudget: {
        maxCyclesBeforePause: 1,
        maxMinutesBeforePause: 20,
        maxFailedRepairAttempts: 1,
        maxConsecutiveTasksWithoutUserReview: 1,
        stopWhenGoalComplete: true,
        stopWhenNoSafeNextTaskExists: true,
        stopWhenPlannerWantsToChangeUltimateGoal: true,
        stopWhenValidationFailsRepeatedly: true
      }
    })
  },
  {
    id: "goal_focused",
    label: "Goal-Focused",
    description: "Treat the goal as mostly fixed while allowing small improvements that clearly support it.",
    strategy: strategy("goal_focused", {
      goalRestrictiveness: 80,
      planningHorizon: "medium",
      taskBatchingAggressiveness: "medium",
      innovationLatitude: 30,
      riskTolerance: "low",
      refactorAppetite: "medium",
      validationStrictness: "high",
      autonomyBudget: {
        maxCyclesBeforePause: 2,
        maxMinutesBeforePause: 35,
        maxFailedRepairAttempts: 2,
        maxConsecutiveTasksWithoutUserReview: 2,
        stopWhenGoalComplete: true,
        stopWhenNoSafeNextTaskExists: true,
        stopWhenPlannerWantsToChangeUltimateGoal: true,
        stopWhenValidationFailsRepeatedly: true
      }
    })
  },
  {
    id: "balanced_autopilot",
    label: "Balanced Autopilot",
    description: "Use the goal as the destination while allowing smarter routing and useful improvements.",
    strategy: strategy("balanced_autopilot", {})
  },
  {
    id: "creative_builder",
    label: "Creative Builder",
    description: "Use the goal as a strong theme and propose meaningful product and UX improvements.",
    strategy: strategy("creative_builder", {
      goalRestrictiveness: 35,
      planningHorizon: "long",
      taskBatchingAggressiveness: "high",
      innovationLatitude: 75,
      riskTolerance: "medium",
      refactorAppetite: "high",
      visualPriority: "very_high",
      validationStrictness: "high",
      approvalSensitivity: "relaxed",
      autonomyBudget: {
        maxCyclesBeforePause: 5,
        maxMinutesBeforePause: 75,
        maxFailedRepairAttempts: 3,
        maxConsecutiveTasksWithoutUserReview: 4,
        stopWhenGoalComplete: true,
        stopWhenNoSafeNextTaskExists: true,
        stopWhenPlannerWantsToChangeUltimateGoal: true,
        stopWhenValidationFailsRepeatedly: true
      }
    })
  },
  {
    id: "experimental_moonshot",
    label: "Experimental / Moonshot",
    description: "Treat the goal as inspiration and allow divergent proposals without silently applying major changes.",
    strategy: strategy("experimental_moonshot", {
      goalRestrictiveness: 15,
      planningHorizon: "long",
      taskBatchingAggressiveness: "very_high",
      innovationLatitude: 95,
      riskTolerance: "high",
      refactorAppetite: "very_high",
      visualPriority: "very_high",
      validationStrictness: "high",
      approvalSensitivity: "relaxed",
      autonomyBudget: {
        maxCyclesBeforePause: 6,
        maxMinutesBeforePause: 90,
        maxFailedRepairAttempts: 3,
        maxConsecutiveTasksWithoutUserReview: 5,
        stopWhenGoalComplete: true,
        stopWhenNoSafeNextTaskExists: true,
        stopWhenPlannerWantsToChangeUltimateGoal: true,
        stopWhenValidationFailsRepeatedly: true
      }
    })
  }
];

export const getAutopilotPreset = (presetId: AutopilotPresetId): AutopilotPreset =>
  listAutopilotPresets().find((preset) => preset.id === presetId) ?? listAutopilotPresets()[2];

export const createDefaultAutopilotStrategy = (): AutopilotStrategy => ({
  ...getAutopilotPreset("balanced_autopilot").strategy,
  visualPreferences: {
    ...getAutopilotPreset("balanced_autopilot").strategy.visualPreferences
  },
  autonomyBudget: {
    ...getAutopilotPreset("balanced_autopilot").strategy.autonomyBudget
  }
});

export const createDefaultGoalCharter = (goal?: UltimateGoal, timestamp = new Date(0).toISOString()): GoalCharter => {
  const baseGoal: UltimateGoal = goal && hasMeaningfulGoalText(goal) ? goal : emptyUltimateGoal();
  return {
    originalUltimateGoal: { ...baseGoal },
    currentEffectiveGoal: { ...baseGoal },
    nonNegotiableRequirements: [...baseGoal.successCriteria],
    flexibleRequirements: [],
    niceToHaveIdeas: [],
    explicitNonGoals: [...baseGoal.nonGoals],
    userConstraints: [...baseGoal.constraints],
    aestheticPreferences: [],
    technicalPreferences: [],
    definitionOfDone: [...baseGoal.successCriteria],
    autopilotStrategy: createDefaultAutopilotStrategy(),
    acceptedGoalChanges: [],
    rejectedGoalChanges: [],
    proposedGoalChanges: [],
    createdAt: timestamp,
    updatedAt: timestamp
  };
};
