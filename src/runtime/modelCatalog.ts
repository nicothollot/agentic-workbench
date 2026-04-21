import { isInterfaceReasoningEffort, normalizeSupportedReasoningEfforts } from "@shared/modelConfig";
import type { Model } from "@generated/app-server/v2";
import type { DiscoveredModel } from "@shared/types";

const lowerText = (model: Model): string =>
  `${model.model} ${model.displayName} ${model.description}`.toLowerCase();

const deriveLabels = (model: Model): string[] => {
  const labels = new Set<string>();
  const text = lowerText(model);

  if (/(mini|small|fast|spark|economy)/.test(text)) {
    labels.add("cost-conscious");
  }
  if (model.defaultReasoningEffort === "low") {
    labels.add("fast");
  }
  if (model.defaultReasoningEffort === "medium") {
    labels.add("balanced");
  }
  if (model.supportedReasoningEfforts.some((option) => option.reasoningEffort === "xhigh")) {
    labels.add("deep reasoning");
  }
  if (model.isDefault) {
    labels.add("default");
  }

  return [...labels];
};

const interfaceCreationScore = (model: Model): number => {
  const text = lowerText(model);
  let score = 0;

  if (/(mini|small|fast|spark|economy)/.test(text)) {
    score += 50;
  }
  if (model.defaultReasoningEffort === "low") {
    score += 18;
  } else if (model.defaultReasoningEffort === "medium") {
    score += 12;
  } else if (model.defaultReasoningEffort === "high") {
    score += 6;
  }
  if (model.isDefault) {
    score += 8;
  }
  if (model.supportedReasoningEfforts.some((option) => option.reasoningEffort === "xhigh")) {
    score -= 4;
  }

  return score;
};

export const buildDiscoveredModels = (models: Model[]): DiscoveredModel[] => {
  const visible = models.filter((model) => !model.hidden);
  const recommendedModel = [...visible].sort((left, right) => interfaceCreationScore(right) - interfaceCreationScore(left))[0]?.model;

  return visible.map((model) => {
    const supportedReasoningEfforts = normalizeSupportedReasoningEfforts(
      model.supportedReasoningEfforts.map((option) => option.reasoningEffort)
    );
    const defaultReasoningEffort = isInterfaceReasoningEffort(model.defaultReasoningEffort) && supportedReasoningEfforts.includes(model.defaultReasoningEffort)
      ? model.defaultReasoningEffort
      : undefined;

    return {
      id: model.id,
      model: model.model,
      displayName: model.displayName,
      description: model.description,
      supportedReasoningEfforts,
      defaultReasoningEffort,
      supportsPersonality: model.supportsPersonality,
      isDefault: model.isDefault,
      labels: deriveLabels(model),
      recommendedForInterfaceCreation: model.model === recommendedModel
    };
  });
};

export const getRecommendedInterfaceCreationModel = (models: DiscoveredModel[]): DiscoveredModel | undefined =>
  models.find((model) => model.recommendedForInterfaceCreation) ?? models[0];
