import { isInterfaceReasoningEffort, normalizeSupportedReasoningEfforts } from "@shared/modelConfig";
import type { Model } from "@generated/app-server/v2";
import type { AgentCategory, DiscoveredModel } from "@shared/types";

const lowerText = (model: Model): string =>
  `${model.model} ${model.displayName} ${model.description}`.toLowerCase();

const gptVersionRank = (model: Model): number | undefined => {
  const match = lowerText(model).match(/\bgpt-(\d+)(?:\.(\d+))?\b/);
  if (!match) {
    return undefined;
  }

  const major = Number.parseInt(match[1] ?? "", 10);
  const minor = Number.parseInt(match[2] ?? "0", 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) {
    return undefined;
  }

  return major * 100 + minor;
};

const latestGptVersionRank = (models: Model[]): number | undefined => {
  const ranks = models.map(gptVersionRank).filter((rank): rank is number => rank !== undefined);
  return ranks.length ? Math.max(...ranks) : undefined;
};

const shouldShowModel = (model: Model, latestGptRank: number | undefined): boolean =>
  !model.hidden || (latestGptRank !== undefined && gptVersionRank(model) === latestGptRank);

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
  if (model.hidden) {
    labels.add("CLI listed");
  }
  if (/\bterra\b/.test(text)) {
    labels.add("everyday builder");
  }
  if (/\bluna\b/.test(text)) {
    labels.add("repeatable tasks");
  }
  if (/\bsol\b/.test(text)) {
    labels.add("premium");
  }

  return [...labels];
};

const interfaceCreationScore = (model: Model): number => {
  const text = lowerText(model);
  let score = 0;

  if (/\bterra\b/.test(text)) {
    score += 10_000_000;
  } else if (/\bluna\b/.test(text)) {
    score += 8_000_000;
  } else if (/\bsol\b/.test(text)) {
    score -= 10_000_000;
  }

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
  const versionRank = gptVersionRank(model);
  if (versionRank !== undefined) {
    score += versionRank * 100;
  }
  if (model.supportedReasoningEfforts.some((option) => option.reasoningEffort === "xhigh")) {
    score -= 4;
  }

  return score;
};

export const buildDiscoveredModels = (models: Model[]): DiscoveredModel[] => {
  const latestGptRank = latestGptVersionRank(models);
  const visible = models
    .filter((model) => shouldShowModel(model, latestGptRank))
    .sort((left, right) =>
      interfaceCreationScore(right) - interfaceCreationScore(left)
      || left.displayName.localeCompare(right.displayName)
      || left.model.localeCompare(right.model)
    );
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

const discoveredModelText = (model: DiscoveredModel): string =>
  `${model.model} ${model.displayName} ${model.description}`.toLowerCase();

const modelTier = (model: DiscoveredModel): "terra" | "luna" | "sol" | "other" => {
  const text = discoveredModelText(model);
  if (/\bterra\b/.test(text)) return "terra";
  if (/\bluna\b/.test(text)) return "luna";
  if (/\bsol\b/.test(text)) return "sol";
  return "other";
};

/** Automatic routing deliberately excludes Sol. Premium Sol runs remain an explicit user override. */
export const getRecommendedAgentModel = (
  models: DiscoveredModel[],
  category: AgentCategory,
  taskPrompt = ""
): DiscoveredModel | undefined => {
  const isReadOnlyManualTask = category === "manual" &&
    /\b(explain|summari[sz]e|inspect|review|where|what|why|status|classif|extract|route)\b/i.test(taskPrompt) &&
    !/\b(implement|change|edit|write|fix|debug|refactor|test|build|merge|resolve)\b/i.test(taskPrompt);
  const preferredTier = category === "merge" || category === "recommendation" || isReadOnlyManualTask ? "luna" : "terra";
  return models.find((model) => modelTier(model) === preferredTier)
    ?? models.find((model) => modelTier(model) === "terra")
    ?? models.find((model) => modelTier(model) === "luna")
    ?? models.find((model) => modelTier(model) !== "sol")
    ?? models[0];
};
