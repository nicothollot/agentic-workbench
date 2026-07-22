import type { AgentCategory, AgentReasoningMode, DiscoveredModel, InterfaceReasoningEffort } from "./types";

export const INTERFACE_REASONING_EFFORTS: InterfaceReasoningEffort[] = ["low", "medium", "high", "xhigh", "max", "ultra"];
export const AUTOMATIC_REASONING_EFFORTS: InterfaceReasoningEffort[] = ["low", "medium", "high", "xhigh"];
export const requiresExplicitReasoningApproval = (effort?: InterfaceReasoningEffort): boolean =>
  effort === "max" || effort === "ultra";

const fastModelPattern = /(mini|small|fast|spark|economy)/i;
const reasoningRank: Record<InterfaceReasoningEffort, number> = {
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
  ultra: 6
};

export const DEFAULT_AGENT_REASONING_MODE: AgentReasoningMode = "auto";
export const DEFAULT_AGENT_REASONING_EFFORTS: Record<AgentCategory, InterfaceReasoningEffort> = {
  bootstrap: "medium",
  goal: "high",
  coding: "high",
  integrity: "medium",
  merge: "low",
  recommendation: "medium",
  manual: "medium"
};

export const isInterfaceReasoningEffort = (value: string): value is InterfaceReasoningEffort =>
  INTERFACE_REASONING_EFFORTS.includes(value as InterfaceReasoningEffort);

export const normalizeSupportedReasoningEfforts = (efforts: string[]): InterfaceReasoningEffort[] =>
  efforts.filter(isInterfaceReasoningEffort);

const supportedEffortsForModel = (
  model?: Pick<DiscoveredModel, "supportedReasoningEfforts">
): InterfaceReasoningEffort[] => {
  if (!model) {
    return INTERFACE_REASONING_EFFORTS;
  }
  return normalizeSupportedReasoningEfforts(model.supportedReasoningEfforts);
};

const pickNearestSupportedReasoningEffort = (
  supported: InterfaceReasoningEffort[],
  requested: InterfaceReasoningEffort
): InterfaceReasoningEffort => {
  if (supported.length === 0) {
    return requested;
  }
  if (supported.includes(requested)) {
    return requested;
  }

  return [...supported].sort((left, right) =>
    Math.abs(reasoningRank[left] - reasoningRank[requested]) - Math.abs(reasoningRank[right] - reasoningRank[requested])
    || reasoningRank[right] - reasoningRank[left]
  )[0];
};

const pickFirstSupportedReasoningEffort = (
  supported: InterfaceReasoningEffort[],
  preferred: InterfaceReasoningEffort[],
  fallbackDirection: "lowest" | "highest" = "highest"
): InterfaceReasoningEffort => {
  if (supported.length === 0) {
    return preferred[0] ?? "medium";
  }

  for (const effort of preferred) {
    if (supported.includes(effort)) {
      return effort;
    }
  }

  return [...supported].sort((left, right) =>
    fallbackDirection === "highest"
      ? reasoningRank[right] - reasoningRank[left]
      : reasoningRank[left] - reasoningRank[right]
  )[0];
};

const taskHas = (taskPrompt: string, pattern: RegExp): boolean => pattern.test(taskPrompt.toLowerCase());

const automaticReasoningPreferenceForTask = (
  category: AgentCategory,
  taskPrompt = ""
): { preferred: InterfaceReasoningEffort[]; fallbackDirection: "lowest" | "highest" } => {
  const complexCoding = taskHas(
    taskPrompt,
    /\b(architecture|auth|authentication|security|concurrency|race|migration|refactor|schema|ipc|electron|workflow|renderer|runtime|debug|bug|fix|failure|failed|regression|performance|multi[- ]?file|cross[- ]?module|test|typecheck|build|lint)\b/
  );
  const deepCoding = taskHas(
    taskPrompt,
    /\b(architecture|auth|authentication|security|concurrency|race|migration|refactor|schema|ipc|electron|workflow|renderer|runtime|failure|failed|regression|performance|multi[- ]?file|cross[- ]?module|test|typecheck|build|lint)\b/
  );
  const lightweightCoding = taskHas(taskPrompt, /\b(copy|docs?|readme|typo|comment|formatting|rename|text|label|small|trivial)\b/);
  const complexMerge = taskHas(taskPrompt, /\b(conflict|conflicted|resolve|rebase|cherry[- ]?pick|release|branches|failed|manual)\b/);
  const complexPlanning = taskHas(taskPrompt, /\b(architecture|strategy|large|monorepo|security|migration|ambiguous|unknown|workflow|roadmap)\b/);
  const complexRecommendation = taskHas(
    taskPrompt,
    /\b(architecture|strategy|security|migration|ambiguous|monorepo|cross[- ]?module|provider|credential|live data|authentication|ipc|electron|concurrency|performance|major|large)\b/
  );
  const manualChange = taskHas(taskPrompt, /\b(implement|change|edit|write|fix|debug|refactor|test|build|merge|resolve|security|architecture)\b/);
  const manualQuestion = taskHas(taskPrompt, /\b(explain|summari[sz]e|where|what|why|status|inspect|review)\b/);

  switch (category) {
    case "coding":
      return {
        preferred: deepCoding || !lightweightCoding ? ["high", "xhigh"] : ["medium", "high"],
        fallbackDirection: "highest"
      };
    case "merge":
      return {
        preferred: complexMerge ? ["medium", "low"] : ["low", "medium"],
        fallbackDirection: "lowest"
      };
    case "integrity":
      return {
        preferred: complexCoding || taskHas(taskPrompt, /\b(repair|risk|flaky|validation|integrity)\b/) ? ["high", "medium"] : ["medium", "low"],
        fallbackDirection: "lowest"
      };
    case "goal":
      return {
        preferred: complexPlanning ? ["high", "xhigh"] : ["medium", "high"],
        fallbackDirection: "highest"
      };
    case "recommendation":
      return {
        preferred: complexRecommendation ? ["high", "medium"] : ["medium", "low"],
        fallbackDirection: "lowest"
      };
    case "bootstrap":
      return {
        preferred: complexPlanning ? ["high", "medium"] : ["medium", "low"],
        fallbackDirection: "lowest"
      };
    case "manual":
      if (manualChange) {
        return {
          preferred: complexCoding ? ["high", "xhigh"] : ["medium", "high"],
          fallbackDirection: "highest"
        };
      }
      if (manualQuestion) {
        return {
          preferred: ["medium", "low"],
          fallbackDirection: "lowest"
        };
      }
      return {
        preferred: ["medium", "high", "low"],
        fallbackDirection: "highest"
      };
  }
};

export const getPreferredInterfaceCreationReasoningEffort = (
  model?: Pick<DiscoveredModel, "model" | "displayName" | "description" | "supportedReasoningEfforts" | "defaultReasoningEffort">
): InterfaceReasoningEffort | undefined => {
  if (!model) {
    return "medium";
  }

  const supported = normalizeSupportedReasoningEfforts(model.supportedReasoningEfforts);
  if (supported.length === 0) {
    return "medium";
  }

  const labelText = `${model.model} ${model.displayName} ${model.description}`;
  if (supported.includes("low") && (model.defaultReasoningEffort === "low" || fastModelPattern.test(labelText))) {
    return "low";
  }
  if (supported.includes("medium")) {
    return "medium";
  }
  if (model.defaultReasoningEffort && supported.includes(model.defaultReasoningEffort)) {
    return model.defaultReasoningEffort;
  }
  if (supported.includes("low")) {
    return "low";
  }
  return supported[0];
};

export const resolveInterfaceCreationReasoningEffort = (
  model: Pick<DiscoveredModel, "model" | "displayName" | "description" | "supportedReasoningEfforts" | "defaultReasoningEffort"> | undefined,
  requested?: InterfaceReasoningEffort
): InterfaceReasoningEffort | undefined => {
  if (!model) {
    return requested ?? "medium";
  }

  const supported = normalizeSupportedReasoningEfforts(model.supportedReasoningEfforts);
  if (requested && supported.includes(requested)) {
    return requested;
  }

  return getPreferredInterfaceCreationReasoningEffort(model);
};

export const getAutomaticAgentReasoningEffort = (
  category: AgentCategory,
  taskPrompt: string,
  model?: Pick<DiscoveredModel, "supportedReasoningEfforts">
): InterfaceReasoningEffort => {
  const supported = supportedEffortsForModel(model).filter((effort) => AUTOMATIC_REASONING_EFFORTS.includes(effort));
  const preference = automaticReasoningPreferenceForTask(category, taskPrompt);
  return pickFirstSupportedReasoningEffort(supported, preference.preferred, preference.fallbackDirection);
};

export const resolveAgentReasoningEffort = (
  model: Pick<DiscoveredModel, "supportedReasoningEfforts"> | undefined,
  category: AgentCategory,
  taskPrompt: string,
  mode: AgentReasoningMode = DEFAULT_AGENT_REASONING_MODE,
  manualEffort = DEFAULT_AGENT_REASONING_EFFORTS[category]
): InterfaceReasoningEffort => {
  const supported = supportedEffortsForModel(model);
  if (mode === "manual") {
    return pickNearestSupportedReasoningEffort(supported, manualEffort);
  }

  return getAutomaticAgentReasoningEffort(category, taskPrompt, model);
};
