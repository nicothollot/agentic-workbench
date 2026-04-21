import type { DiscoveredModel, InterfaceReasoningEffort } from "./types";

export const INTERFACE_REASONING_EFFORTS: InterfaceReasoningEffort[] = ["low", "medium", "high", "xhigh"];

const fastModelPattern = /(mini|small|fast|spark|economy)/i;

export const isInterfaceReasoningEffort = (value: string): value is InterfaceReasoningEffort =>
  INTERFACE_REASONING_EFFORTS.includes(value as InterfaceReasoningEffort);

export const normalizeSupportedReasoningEfforts = (efforts: string[]): InterfaceReasoningEffort[] =>
  efforts.filter(isInterfaceReasoningEffort);

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
