import { nanoid } from "nanoid";
import type {
  AgentCategory,
  AgentState,
  ProjectWorkflowState,
  WorkflowContextDescriptor,
  WorkflowRelevantContextSelection,
  WorkflowStage
} from "@shared/types";
import { nowIso, unique } from "@shared/utils";

const STOPWORDS = new Set([
  "about",
  "after",
  "agent",
  "agents",
  "before",
  "build",
  "change",
  "changes",
  "check",
  "code",
  "current",
  "cycle",
  "goal",
  "goals",
  "have",
  "into",
  "make",
  "more",
  "next",
  "plan",
  "project",
  "should",
  "step",
  "task",
  "that",
  "this",
  "with",
  "work",
  "workflow"
]);

const WORK_TYPE_PATTERNS: Array<[string, RegExp]> = [
  ["api", /\b(api|endpoint|http|rest|graphql|fetch|provider|adapter)\b/i],
  ["credentials", /\b(secret|credential|api key|token|auth|oauth|login|alpaca|polygon|twelve data)\b/i],
  ["live-data", /\b(live data|market data|external data|real[- ]time|stream|provider)\b/i],
  ["trading", /\b(trading|market|ticker|portfolio|brokerage|alpaca|polygon|twelve data|ohlc|candlestick)\b/i],
  ["ui", /\b(ui|ux|renderer|component|screen|layout|visual|css|responsive)\b/i],
  ["testing", /\b(test|spec|vitest|playwright|validation|lint|typecheck)\b/i],
  ["build", /\b(build|vite|electron|package|bundle|dist)\b/i],
  ["state", /\b(state|persist|storage|schema|migration|reducer)\b/i],
  ["performance", /\b(performance|lag|virtual|scroll|render|windowing|latency)\b/i],
  ["accessibility", /\b(accessibility|a11y|label|reduced motion|keyboard)\b/i]
];

export interface WorkflowContextDescriptorInput {
  workflow: ProjectWorkflowState;
  agentCategory: AgentCategory;
  summary: string;
  changedPaths?: string[];
  relatedPaths?: string[];
  workflowStage?: WorkflowStage;
  cycleNumber?: number;
  now?: string;
}

export interface RelevantContextQueryInput {
  workflow: ProjectWorkflowState;
  agentCategory: AgentCategory;
  taskText: string;
  relatedPaths?: string[];
  workflowStage?: WorkflowStage;
}

export interface RelevantContextOptions {
  maxEntries?: number;
  maxChars?: number;
}

const normalizeToken = (token: string): string => token.toLowerCase().replace(/^[-_/]+|[-_/]+$/g, "");

export const tokenizeContextText = (value: string): string[] =>
  unique((value.toLowerCase().match(/[a-z0-9][a-z0-9_/-]*/g) ?? [])
    .flatMap((token) => token.split(/[/_-]+/))
    .map(normalizeToken)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token)))
    .slice(0, 80);

const pathFeatureTokens = (relativePath: string): string[] => {
  const normalized = relativePath.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized) {
    return [];
  }

  const parts = normalized.split("/").filter(Boolean);
  const basename = parts.at(-1) ?? normalized;
  const extension = basename.includes(".") ? basename.split(".").at(-1) : undefined;
  return unique([
    normalized.toLowerCase(),
    ...parts.flatMap((part) => tokenizeContextText(part)),
    ...(extension ? [`ext:${extension.toLowerCase()}`] : [])
  ]);
};

const deriveWorkTypeTags = (text: string, paths: string[]): string[] => {
  const haystack = `${text}\n${paths.join("\n")}`;
  return WORK_TYPE_PATTERNS
    .filter(([, pattern]) => pattern.test(haystack))
    .map(([tag]) => tag);
};

const addWeight = (weights: Record<string, number>, key: string, amount: number): void => {
  weights[key] = Number(((weights[key] ?? 0) + amount).toFixed(4));
};

const uniqueLimited = (values: string[], limit: number): string[] =>
  unique(values.map((entry) => entry.trim()).filter(Boolean)).slice(0, limit);

export const buildContextFeatureWeights = (input: {
  text: string;
  agentCategory: AgentCategory;
  workflowStage: WorkflowStage;
  cycleNumber: number;
  paths: string[];
  workTypeTags?: string[];
  decisionIds?: string[];
  issueIds?: string[];
}): Record<string, number> => {
  const weights: Record<string, number> = {};
  for (const token of tokenizeContextText(input.text)) {
    addWeight(weights, `token:${token}`, 1);
  }
  for (const pathToken of input.paths.flatMap(pathFeatureTokens)) {
    addWeight(weights, pathToken.includes("/") ? `path:${pathToken}` : `path-token:${pathToken}`, 2);
  }
  for (const tag of input.workTypeTags ?? deriveWorkTypeTags(input.text, input.paths)) {
    addWeight(weights, `tag:${tag}`, 3);
  }
  for (const decisionId of input.decisionIds ?? []) {
    addWeight(weights, `decision:${decisionId}`, 2.5);
  }
  for (const issueId of input.issueIds ?? []) {
    addWeight(weights, `issue:${issueId}`, 2.5);
  }
  addWeight(weights, `category:${input.agentCategory}`, 1.8);
  addWeight(weights, `stage:${input.workflowStage}`, 1.4);
  addWeight(weights, `cycle:${input.cycleNumber}`, 0.2);
  return weights;
};

export const createWorkflowContextDescriptor = (input: WorkflowContextDescriptorInput): WorkflowContextDescriptor => {
  const workflow = input.workflow;
  const createdAt = input.now ?? nowIso();
  const relatedPaths = uniqueLimited(input.relatedPaths ?? [], 16);
  const changedPaths = uniqueLimited(input.changedPaths ?? [], 16);
  const acceptedDecisionIds = workflow.memory.lastAcceptedDecisions.slice(0, 8).map((decision) => decision.id);
  const openIssueIds = workflow.memory.knownOpenIssues.filter((issue) => issue.status === "open").slice(0, 8).map((issue) => issue.id);
  const resolvedIssueIds = workflow.memory.knownOpenIssues.filter((issue) => issue.status === "resolved").slice(0, 8).map((issue) => issue.id);
  const sourceText = [
    input.summary,
    workflow.ultimateGoal.summary,
    workflow.approvedRecommendation?.title,
    workflow.scopedGoal?.summary,
    workflow.memory.canonicalFacts.join(" ")
  ].filter(Boolean).join("\n");
  const workTypeTags = deriveWorkTypeTags(sourceText, [...relatedPaths, ...changedPaths]);
  const goalTokens = uniqueLimited(tokenizeContextText([
    workflow.ultimateGoal.summary,
    workflow.ultimateGoal.detailedIntent,
    workflow.approvedRecommendation?.title ?? "",
    workflow.scopedGoal?.summary ?? ""
  ].join(" ")), 24);
  const featureWeights = buildContextFeatureWeights({
    text: sourceText,
    agentCategory: input.agentCategory,
    workflowStage: input.workflowStage ?? workflow.workflowStage,
    cycleNumber: input.cycleNumber ?? workflow.workflowCycle.cycleNumber,
    paths: [...relatedPaths, ...changedPaths],
    workTypeTags,
    decisionIds: acceptedDecisionIds,
    issueIds: [...openIssueIds, ...resolvedIssueIds]
  });

  return {
    id: nanoid(),
    cycleNumber: input.cycleNumber ?? workflow.workflowCycle.cycleNumber,
    agentCategory: input.agentCategory,
    workflowStage: input.workflowStage ?? workflow.workflowStage,
    goalTokens,
    workTypeTags,
    changedPaths,
    relatedPaths,
    acceptedDecisionIds,
    openIssueIds,
    resolvedIssueIds,
    summary: input.summary.trim().slice(0, 900),
    featureWeights,
    createdAt,
    updatedAt: createdAt
  };
};

const dotProduct = (left: Record<string, number>, right: Record<string, number>): number => {
  let score = 0;
  const [smaller, larger] = Object.keys(left).length < Object.keys(right).length ? [left, right] : [right, left];
  for (const [key, value] of Object.entries(smaller)) {
    score += value * (larger[key] ?? 0);
  }
  return score;
};

const magnitude = (weights: Record<string, number>): number =>
  Math.sqrt(Object.values(weights).reduce((sum, value) => sum + value * value, 0));

const similarityScore = (left: Record<string, number>, right: Record<string, number>): number => {
  const denominator = magnitude(left) * magnitude(right);
  return denominator > 0 ? dotProduct(left, right) / denominator : 0;
};

const explainSelection = (
  descriptor: WorkflowContextDescriptor,
  queryWeights: Record<string, number>
): string[] => {
  const reasons: string[] = [];
  const shared = Object.keys(descriptor.featureWeights).filter((key) => queryWeights[key] !== undefined);
  const pathMatches = shared.filter((key) => key.startsWith("path:") || key.startsWith("path-token:")).slice(0, 3);
  const tagMatches = shared.filter((key) => key.startsWith("tag:")).slice(0, 3);
  const tokenMatches = shared.filter((key) => key.startsWith("token:")).slice(0, 4);
  if (pathMatches.length) {
    reasons.push(`shared paths: ${pathMatches.map((key) => key.replace(/^path(?:-token)?:/, "")).join(", ")}`);
  }
  if (tagMatches.length) {
    reasons.push(`shared work type: ${tagMatches.map((key) => key.replace("tag:", "")).join(", ")}`);
  }
  if (tokenMatches.length) {
    reasons.push(`shared terms: ${tokenMatches.map((key) => key.replace("token:", "")).join(", ")}`);
  }
  if (queryWeights[`category:${descriptor.agentCategory}`]) {
    reasons.push(`same agent category: ${descriptor.agentCategory}`);
  }
  return reasons.slice(0, 4);
};

const scrubHistoricalProgressClaims = (value: string): string =>
  value
    .replace(/\b(?:completion\s+(?:remains|is|now)\s*)?\d+\/\d+(?:\s+required goal checks met)?(?:\s+\(\d+%\))?/gi, "[historical progress count omitted]")
    .replace(/\bestimated completion is \d+\/\d+\b/gi, "estimated completion is [historical progress count omitted]");

export const buildRelevantContextQueryWeights = (input: RelevantContextQueryInput): Record<string, number> => {
  const workflow = input.workflow;
  const text = [
    input.taskText,
    workflow.ultimateGoal.summary,
    workflow.approvedRecommendation?.title,
    workflow.scopedGoal?.summary,
    workflow.memory.knownOpenIssues.filter((issue) => issue.status === "open").map((issue) => issue.title).join(" ")
  ].filter(Boolean).join("\n");

  return buildContextFeatureWeights({
    text,
    agentCategory: input.agentCategory,
    workflowStage: input.workflowStage ?? workflow.workflowStage,
    cycleNumber: workflow.workflowCycle.cycleNumber,
    paths: input.relatedPaths ?? [],
    workTypeTags: deriveWorkTypeTags(text, input.relatedPaths ?? []),
    decisionIds: workflow.memory.lastAcceptedDecisions.slice(0, 6).map((decision) => decision.id),
    issueIds: workflow.memory.knownOpenIssues.filter((issue) => issue.status === "open").slice(0, 6).map((issue) => issue.id)
  });
};

export const selectRelevantWorkflowContext = (
  descriptors: WorkflowContextDescriptor[],
  input: RelevantContextQueryInput,
  options: RelevantContextOptions = {}
): WorkflowRelevantContextSelection[] => {
  const maxEntries = options.maxEntries ?? 5;
  const maxChars = options.maxChars ?? 2400;
  const queryWeights = buildRelevantContextQueryWeights(input);
  let usedChars = 0;

  return descriptors
    .map((descriptor) => {
      const score = similarityScore(queryWeights, descriptor.featureWeights);
      return {
        descriptor,
        score,
        reasons: explainSelection(descriptor, queryWeights)
      };
    })
    .filter((entry) => entry.score > 0.05)
    .sort((left, right) =>
      right.score - left.score ||
      right.descriptor.updatedAt.localeCompare(left.descriptor.updatedAt) ||
      left.descriptor.id.localeCompare(right.descriptor.id)
    )
    .flatMap((entry): WorkflowRelevantContextSelection[] => {
      if (usedChars >= maxChars) {
        return [];
      }
      const summaryBudget = Math.max(120, Math.min(520, maxChars - usedChars));
      const summary = entry.descriptor.summary.length <= summaryBudget
        ? entry.descriptor.summary
        : `${entry.descriptor.summary.slice(0, summaryBudget - 3).trimEnd()}...`;
      usedChars += summary.length + entry.reasons.join("; ").length + 80;
      return [{
        descriptorId: entry.descriptor.id,
        cycleNumber: entry.descriptor.cycleNumber,
        agentCategory: entry.descriptor.agentCategory,
        score: Number(entry.score.toFixed(4)),
        reasons: entry.reasons,
        summary,
        paths: uniqueLimited([...entry.descriptor.changedPaths, ...entry.descriptor.relatedPaths], 8),
        decisionIds: entry.descriptor.acceptedDecisionIds.slice(0, 5),
        issueIds: uniqueLimited([...entry.descriptor.openIssueIds, ...entry.descriptor.resolvedIssueIds], 6)
      }];
    })
    .slice(0, maxEntries);
};

export const pruneWorkflowContextDescriptors = (
  descriptors: WorkflowContextDescriptor[],
  maxDescriptors = 80
): WorkflowContextDescriptor[] =>
  [...descriptors]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt))
    .slice(0, maxDescriptors);

export const createAgentContextDescriptor = (
  workflow: ProjectWorkflowState,
  agent: AgentState,
  now = nowIso()
): WorkflowContextDescriptor => {
  const summary = [
    agent.name,
    agent.currentPhase,
    agent.currentSubtask,
    agent.recommendationReport?.summary,
    agent.integrityReport?.summary,
    agent.mergeReport?.summary,
    agent.lastMessageSnippet
  ].filter((entry): entry is string => Boolean(entry?.trim())).join(" | ") || agent.taskPrompt;
  return createWorkflowContextDescriptor({
    workflow,
    agentCategory: agent.category,
    summary,
    changedPaths: agent.changedFiles,
    relatedPaths: agent.recommendationReport?.nextSteps.flatMap((step) => step.relatedPaths) ?? [],
    cycleNumber: agent.workflowCycleNumber ?? workflow.workflowCycle.cycleNumber,
    now
  });
};

export const formatRelevantContextForPrompt = (selections: WorkflowRelevantContextSelection[]): string => {
  if (selections.length === 0) {
    return "Relevant prior context: none selected.";
  }

  return [
    "Relevant prior context selected by deterministic similarity:",
    ...selections.map((selection) => [
      `- Cycle ${selection.cycleNumber} ${selection.agentCategory} (score ${selection.score.toFixed(2)}): ${scrubHistoricalProgressClaims(selection.summary)}`,
      selection.paths.length ? `  Paths: ${selection.paths.join(", ")}` : "",
      selection.reasons.length ? `  Why selected: ${selection.reasons.join("; ")}` : ""
    ].filter(Boolean).join("\n"))
  ].join("\n");
};
