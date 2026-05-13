import path from "node:path";
import { nanoid } from "nanoid";
import type {
  AgentState,
  GoalAttainmentCheck,
  GoalCheckAuditFlag,
  GoalCheckItemKind,
  GoalCheckSource,
  GoalCheckStatus,
  ProjectOverview,
  ProjectWorkflowState,
  WorkPackage,
  WorkflowTaskMap,
  UltimateGoal,
  UltimateGoalCompletionState,
  WorkflowObjective,
  UltimateGoalProgressEstimate,
  WorkflowRecommendationOption
} from "@shared/types";
import { nowIso } from "@shared/utils";
import { getWorkflowModeConfig, getWorkflowPreviewRequest, resolveEffectiveAutopilotPolicy } from "@shared/workflow";
import type { RepoScanResult } from "./repoScanner";
import {
  sanitizeChecklistEvidenceText,
  sanitizeGoalAttainmentCheck,
  sanitizeGoalCheckEvidenceHistory
} from "./stateSanitizer";
import { sanitizeRecommendationForCycle } from "./workflowGuardrails";

const STOPWORDS = new Set([
  "about",
  "after",
  "agent",
  "agents",
  "align",
  "allow",
  "also",
  "before",
  "build",
  "change",
  "changes",
  "clear",
  "current",
  "cycle",
  "feature",
  "goal",
  "goals",
  "have",
  "improve",
  "into",
  "keep",
  "make",
  "more",
  "next",
  "part",
  "project",
  "safe",
  "ship",
  "should",
  "step",
  "steps",
  "system",
  "that",
  "their",
  "there",
  "this",
  "toward",
  "user",
  "using",
  "with",
  "workflow",
  "workflows"
]);

interface RecommendationDraft {
  key: string;
  score: number;
  title: string;
  summary: string;
  rationale: string;
  expectedImpact: string;
  priority: WorkflowRecommendationOption["priority"];
  confidence: number;
  estimatedScope: WorkflowRecommendationOption["estimatedScope"];
  riskLevel: WorkflowRecommendationOption["riskLevel"];
  relatedPaths: string[];
  sourceWorkPackageId?: string;
  targetedCheckIds?: string[];
}

export interface WorkflowRecommendationContext {
  workflow: ProjectWorkflowState;
  agents: AgentState[];
  scan: Pick<RepoScanResult, "files" | "stats" | "dependencies" | "kind">;
  overview?: ProjectOverview;
  customFocus?: string;
  objective: WorkflowObjective;
  maxOptions: number;
}

const tokenize = (value: string): string[] =>
  (value.toLowerCase().match(/[a-z0-9_/-]+/g) ?? [])
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !STOPWORDS.has(token));

const unique = <T>(values: T[]): T[] => [...new Set(values)];

const normalizeSpace = (value: string): string => value.trim().replace(/\s+/g, " ");

const truncate = (value: string, maxLength: number): string =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength - 1).trimEnd()}…`;

const stableHash = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

const buildGoalCheckId = (source: GoalCheckSource, value: string): string =>
  `${source}:${stableHash(normalizeSpace(value).toLowerCase())}`;

const normalizedGoalCheckTitle = (value: string): string => normalizeSpace(value).toLowerCase();

const normalizeGoalCheckSemanticText = (value: string): string =>
  normalizeSpace(value)
    .toLowerCase()
    .replace(/\be\*trade\b/g, "e trade")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const goalCheckSemanticPatterns: Array<{ key: string; pattern: RegExp }> = [
  {
    key: "constraint:no-secrets",
    pattern: /\b(secret|secrets|credential|credentials|api key|oauth|token|private)\b.*\b(source code|committed|logs?|fixtures?|artifacts?)\b/
  },
  {
    key: "constraint:brokerage-read-only",
    pattern: /\b(power e trade|brokerage|broker|trading|trades?|orders?)\b.*\b(read only|no live trades?|not place live trades?|order execution|broker writes?)\b/
  },
  {
    key: "constraint:layer-separation",
    pattern: /\b(clean separation|separation|separate|separated)\b.*\b(data connectors?|connectors?|normalized data schemas?|schemas?|analytics engines?|analytics|recommendation logic|ui components?|components?)\b/
  },
  {
    key: "constraint:typed-ingestion-validation",
    pattern: /\btyped\b.*\b(data models?|models?|validation|ingestion|boundaries?|schemas?|auditable)\b/
  },
  {
    key: "constraint:demo-before-live-credentials",
    pattern: /\b(mock|demo|offline|local)\b.*\b(live|credentials?|adapter|provider|api)\b|\blive adapters?\b.*\b(credentials?|credential gated|missing credential)\b/
  },
  {
    key: "constraint:external-source-provenance",
    pattern: /\b(source|sources|provenance|externally sourced)\b.*\b(timestamp|timestamps|refresh|freshness|failure|failed|stale|unavailable|limitation|metadata)\b/
  },
  {
    key: "constraint:source-access-compliance",
    pattern: /\b(avoid scraping|scraping|scrape|terms|tos|official|permitted|open|free tier)\b.*\b(source|sources|api|apis|provider|providers|access|data)\b/
  },
  {
    key: "constraint:cash-flow-performance",
    pattern: /\b(historical performance|performance calculations?|returns?|position histories?)\b.*\b(deposits?|withdrawals?|dividends?|fees?|cash movements?|cash flows?)\b/
  },
  {
    key: "constraint:large-data-responsive-ui",
    pattern: /\b(ui|interface|render|rendering|responsive|view models?)\b.*\b(large transactions?|transaction histories|many holdings|frequent refresh|large data|scale|bounded)\b/
  },
  {
    key: "constraint:security-runtime-boundary",
    pattern: /\b(security sensitive|privileged|server side|runtime side|main process|node apis?)\b/
  },
  {
    key: "constraint:deterministic-local-fixtures",
    pattern: /\b(testability|deterministic|local fixtures?|fixtures?)\b.*\b(analytics|local|tests?|validation|run)\b/
  }
];

const goalCheckSemanticKeyFromParts = (title: string, description = ""): string => {
  const semanticText = normalizeGoalCheckSemanticText(`${title} ${description}`);
  const semanticMatch = goalCheckSemanticPatterns.find((entry) => entry.pattern.test(semanticText));
  return semanticMatch?.key ?? `title:${normalizeGoalCheckSemanticText(title)}`;
};

const goalCheckSemanticKey = (check: GoalAttainmentCheck): string =>
  goalCheckSemanticKeyFromParts(check.title, check.description);

const statusRank: Record<GoalCheckStatus, number> = {
  unknown: 0,
  unmet: 1,
  not_applicable: 2,
  met: 3
};

const requiredUserGoalCheckSources = new Set<GoalCheckSource>(["success_criterion", "quality_bar", "constraint"]);
const requiredSystemGoalCheckSources = new Set<GoalCheckSource>(["success_criterion", "quality_bar", "constraint", "deterministic"]);

const getGoalCheckItemKind = (check: Pick<GoalAttainmentCheck, "required"> & { itemKind?: GoalCheckItemKind }): GoalCheckItemKind =>
  check.itemKind ?? (check.required ? "required" : "backlog");

const isGoalCheckBacklogOrObservation = (check: Pick<GoalAttainmentCheck, "required"> & { itemKind?: GoalCheckItemKind }): boolean =>
  getGoalCheckItemKind(check) !== "required";

const normalizeGoalCheckKind = (
  itemKind: GoalCheckItemKind,
  status: GoalCheckStatus
): { itemKind: GoalCheckItemKind; required: boolean } => {
  if (status === "not_applicable") {
    return { itemKind, required: false };
  }
  return {
    itemKind,
    required: itemKind === "required"
  };
};

const toGoalCheckPathArea = (value: string): string => {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (!normalized) {
    return "";
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) {
    return "";
  }
  if (parts[0] === "src" && parts[1]) {
    return `src/${parts[1]}`;
  }
  return parts.length > 1 && !path.extname(normalized) ? parts.slice(0, 2).join("/") : normalized;
};

const pathAreas = (paths: string[] = []): string[] =>
  unique(paths.map(toGoalCheckPathArea).filter(Boolean)).sort();

const stemChecklistToken = (token: string): string => {
  if (token.length > 5 && token.endsWith("ing")) {
    return token.slice(0, -3);
  }
  if (token.length > 4 && token.endsWith("ed")) {
    return token.slice(0, -2);
  }
  if (token.length > 4 && token.endsWith("es")) {
    return token.slice(0, -2);
  }
  if (token.length > 3 && token.endsWith("s")) {
    return token.slice(0, -1);
  }
  return token;
};

const checklistTokenSet = (value: string): Set<string> =>
  new Set(tokenize(normalizeGoalCheckSemanticText(value)).map(stemChecklistToken));

const tokenOverlapRatio = (left: Set<string>, right: Set<string>): number => {
  const [smaller, larger] = left.size < right.size ? [left, right] : [right, left];
  if (smaller.size === 0 || larger.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const token of smaller) {
    if (larger.has(token)) {
      shared += 1;
    }
  }
  return shared / smaller.size;
};

const tokenJaccardScore = (left: Set<string>, right: Set<string>): number => {
  const union = new Set([...left, ...right]);
  if (union.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) {
      shared += 1;
    }
  }
  return shared / union.size;
};

const setsIntersect = <T>(left: T[], right: T[]): boolean => {
  const rightSet = new Set(right);
  return left.some((entry) => rightSet.has(entry));
};

const inferGoalCheckPrimaryTopic = (check: GoalAttainmentCheck): string => buildGoalCheckBatchLabel([check]);

const buildGoalCheckCanonicalKey = (check: GoalAttainmentCheck): string => {
  const normalizedTitle = normalizeGoalCheckSemanticText(check.title);
  const tokens = [...checklistTokenSet(`${check.title} ${check.description}`)].sort().slice(0, 10);
  const paths = pathAreas(check.relatedPaths ?? []).slice(0, 4);
  const topic = normalizeGoalCheckSemanticText(inferGoalCheckPrimaryTopic(check));
  const sourceFamily = requiredUserGoalCheckSources.has(check.source)
    ? "goal"
    : check.source === "deterministic"
      ? "deterministic"
      : getGoalCheckItemKind(check);
  return [
    `source:${sourceFamily}`,
    `topic:${topic}`,
    paths.length ? `paths:${paths.join(",")}` : "",
    `intent:${tokens.join("-") || normalizedTitle}`
  ].filter(Boolean).join("|");
};

const goalCheckHistoryEntry = (check: GoalAttainmentCheck): NonNullable<GoalAttainmentCheck["evidenceHistory"]>[number] => ({
  checkId: check.id,
  title: check.title,
  source: check.source,
  status: check.status,
  evidence: sanitizeChecklistEvidenceText(check.evidence),
  ownerAgentId: check.ownerAgentId,
  createdAt: check.createdAt,
  updatedAt: check.updatedAt
});

const collectGoalCheckEvidenceHistory = (checks: GoalAttainmentCheck[]): NonNullable<GoalAttainmentCheck["evidenceHistory"]> => {
  const seen = new Set<string>();
  const entries = checks
    .flatMap((check) => [
      goalCheckHistoryEntry(check),
      ...(check.evidenceHistory ?? [])
    ])
    .filter((entry) => {
      const key = `${entry.checkId}:${entry.status}:${entry.evidence}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  return sanitizeGoalCheckEvidenceHistory(entries);
};

const goalCheckSourceRank: Record<GoalCheckSource, number> = {
  success_criterion: 5,
  quality_bar: 5,
  constraint: 4,
  agent: 2,
  deterministic: 1
};

const weakChecklistEvidencePatterns = [
  /\bprevious generic completion evidence\b/i,
  /\bgeneric completion evidence did not directly support\b/i,
  /\bworkflow source of truth\b/i,
  /\bsupplied workflow source of truth\b/i,
  /\bcurrent source of truth\b/i,
  /\bstill lists? this as (?:an )?open\b/i,
  /\btried to mark this met without evidence\b/i
];

const isWeakChecklistEvidence = (evidence: string): boolean =>
  !evidence.trim() || weakChecklistEvidencePatterns.some((pattern) => pattern.test(evidence));

const goalCheckTime = (value?: string): number => value ? new Date(value).getTime() : 0;

const chooseRepresentativeGoalCheck = (checks: GoalAttainmentCheck[]): GoalAttainmentCheck =>
  [...checks].sort((left, right) => {
    const sourceDelta = goalCheckSourceRank[right.source] - goalCheckSourceRank[left.source];
    if (sourceDelta !== 0) {
      return sourceDelta;
    }
    const leftTruncated = left.title.includes("…") || left.title.includes("...");
    const rightTruncated = right.title.includes("…") || right.title.includes("...");
    if (leftTruncated !== rightTruncated) {
      return leftTruncated ? 1 : -1;
    }
    return right.title.length - left.title.length || goalCheckTime(left.createdAt) - goalCheckTime(right.createdAt);
  })[0] ?? checks[0];

const chooseMergedGoalCheckStatus = (checks: GoalAttainmentCheck[]): GoalCheckStatus => {
  const activeChecks = checks.filter((check) => getGoalCheckItemKind(check) === "required");
  const representative = chooseRepresentativeGoalCheck(checks);
  if (activeChecks.length === 0) {
    return "not_applicable";
  }
  if (representative.status === "not_applicable" && representative.evidence.trim()) {
    return "not_applicable";
  }
  if (activeChecks.every((check) => check.status === "not_applicable")) {
    return "not_applicable";
  }
  const activeNonNotApplicable = activeChecks.filter((check) => check.status !== "not_applicable");
  if (activeNonNotApplicable.some((check) => check.status === "unmet")) {
    return "unmet";
  }
  if (activeNonNotApplicable.some((check) => check.status === "unknown")) {
    return "unknown";
  }
  if (activeNonNotApplicable.length > 0 && activeNonNotApplicable.every((check) => check.status === "met")) {
    return "met";
  }
  return "unknown";
};

const chooseMergedGoalCheckEvidence = (checks: GoalAttainmentCheck[]): string => {
  const stripConsolidationNotes = (value: string): string =>
    normalizeSpace(value.replace(/\bConsolidated \d+ semantically equivalent checklist entries\./gi, " "));
  const evidenceChecks = checks
    .filter((check) => check.evidence.trim())
    .sort((left, right) => {
      const leftStrong = isWeakChecklistEvidence(left.evidence) ? 0 : 1;
      const rightStrong = isWeakChecklistEvidence(right.evidence) ? 0 : 1;
      return rightStrong - leftStrong || goalCheckTime(right.updatedAt) - goalCheckTime(left.updatedAt);
    });
  const primaryEvidence = stripConsolidationNotes(evidenceChecks[0]?.evidence.trim() ?? "");
  if (checks.length <= 1) {
    return sanitizeChecklistEvidenceText(primaryEvidence);
  }
  const consolidationNote = `Consolidated ${checks.length} semantically equivalent checklist entries.`;
  return sanitizeChecklistEvidenceText(primaryEvidence ? `${primaryEvidence}\n${consolidationNote}` : consolidationNote);
};

const normalizedCheckComparableText = (check: GoalAttainmentCheck): string =>
  normalizeGoalCheckSemanticText(`${check.title} ${check.description}`);

const hasSharedAcceptancePhrase = (left: GoalAttainmentCheck, right: GoalAttainmentCheck): boolean => {
  const leftEvidence = normalizeGoalCheckSemanticText(left.evidence);
  const rightEvidence = normalizeGoalCheckSemanticText(right.evidence);
  if (!leftEvidence || !rightEvidence) {
    return false;
  }
  const leftTokens = checklistTokenSet(leftEvidence);
  const rightTokens = checklistTokenSet(rightEvidence);
  return tokenOverlapRatio(leftTokens, rightTokens) >= 0.62 && tokenJaccardScore(leftTokens, rightTokens) >= 0.33;
};

const areDuplicateGoalChecks = (left: GoalAttainmentCheck, right: GoalAttainmentCheck): boolean => {
  const leftTitle = normalizeGoalCheckSemanticText(left.title);
  const rightTitle = normalizeGoalCheckSemanticText(right.title);
  if (leftTitle && leftTitle === rightTitle) {
    return true;
  }
  const leftNumbers = left.title.match(/\d+/g) ?? [];
  const rightNumbers = right.title.match(/\d+/g) ?? [];
  if (leftNumbers.length > 0 && rightNumbers.length > 0 && leftNumbers.join(".") !== rightNumbers.join(".")) {
    return false;
  }

  const leftText = normalizedCheckComparableText(left);
  const rightText = normalizedCheckComparableText(right);
  if (leftText && rightText && (leftText.includes(rightText) || rightText.includes(leftText)) && Math.min(leftText.length, rightText.length) >= 28) {
    return true;
  }

  if (goalCheckSemanticKey(left) === goalCheckSemanticKey(right) && goalCheckSemanticKey(left).startsWith("constraint:")) {
    return true;
  }

  const leftTokens = checklistTokenSet(leftText);
  const rightTokens = checklistTokenSet(rightText);
  const overlap = tokenOverlapRatio(leftTokens, rightTokens);
  const jaccard = tokenJaccardScore(leftTokens, rightTokens);
  const sharedPathArea = setsIntersect(pathAreas(left.relatedPaths ?? []), pathAreas(right.relatedPaths ?? []));
  const sharedTopic = inferGoalCheckPrimaryTopic(left) === inferGoalCheckPrimaryTopic(right);
  const sharedRequiredSource = left.source === right.source && left.source !== "agent";
  const sharedSourceHistory = Boolean(left.sourceCheckIds?.some((id) => right.sourceCheckIds?.includes(id) || id === right.id));

  if (sharedSourceHistory) {
    return true;
  }
  if (overlap >= 0.9 || jaccard >= 0.78) {
    return true;
  }
  if (overlap >= 0.74 && (sharedTopic || sharedPathArea || sharedRequiredSource || hasSharedAcceptancePhrase(left, right))) {
    return true;
  }
  if (overlap >= 0.7 && jaccard >= 0.42 && (hasSharedAcceptancePhrase(left, right) || sharedPathArea)) {
    return true;
  }
  if (sharedPathArea && left.source !== right.source && overlap >= 0.55 && jaccard >= 0.28) {
    return true;
  }
  if (overlap >= 0.62 && jaccard >= 0.45 && sharedTopic && (sharedPathArea || sharedRequiredSource)) {
    return true;
  }
  return false;
};

const addAuditFlag = (flags: Set<GoalCheckAuditFlag>, flag: GoalCheckAuditFlag): void => {
  flags.add(flag);
};

const vagueChecklistPatterns = [
  /\bimprove\b/i,
  /\bbetter\b/i,
  /\bnice\b/i,
  /\bpolish\b/i,
  /\brobust\b/i,
  /\bclean up\b/i,
  /\boptimi[sz]e\b/i,
  /\benhance\b/i
];

const taskLikeChecklistPattern = /^\s*(?:add|build|create|fix|implement|investigate|refactor|remove|rename|update|wire)\b/i;
const observableChecklistPattern = /\b(?:assert|block|display|emit|fail|hide|include|load|persist|prevent|record|render|return|show|store|validate|verify|visible|without|with)\b/i;
const concreteChecklistPattern = /\b(?:test|spec|validation|command|file|path|screen|button|dialog|ipc|schema|state|error|empty|loading|security|credential|secret|runtime|renderer|preload|main process|src\/|tests?\/|\.tsx?\b|\.jsx?\b|\.css\b)\b/i;

const hasConcreteAcceptanceSignal = (check: GoalAttainmentCheck): boolean => {
  const text = `${check.title} ${check.description} ${check.evidence} ${(check.relatedPaths ?? []).join(" ")}`;
  return check.relatedPaths.length > 0 ||
    Boolean(check.evidence.trim() && !isWeakChecklistEvidence(check.evidence)) ||
    observableChecklistPattern.test(text) ||
    concreteChecklistPattern.test(text);
};

const goalTiesCheck = (check: GoalAttainmentCheck, goal?: UltimateGoal): boolean => {
  if (!goal || requiredSystemGoalCheckSources.has(check.source)) {
    return true;
  }
  const goalText = [
    goal.summary,
    goal.detailedIntent,
    goal.qualityBar,
    ...goal.successCriteria,
    ...goal.constraints
  ].join(" ");
  const goalTokens = checklistTokenSet(goalText);
  const checkTokens = checklistTokenSet(`${check.title} ${check.description}`);
  return tokenOverlapRatio(checkTokens, goalTokens) >= 0.42 || tokenJaccardScore(checkTokens, goalTokens) >= 0.24;
};

export const auditGoalChecklist = (checklist: GoalAttainmentCheck[], goal?: UltimateGoal): GoalAttainmentCheck[] =>
  checklist.map((check) => {
    const flags = new Set<GoalCheckAuditFlag>(check.auditFlags ?? []);
    const text = normalizeSpace(`${check.title} ${check.description}`);
    const concrete = hasConcreteAcceptanceSignal(check);
    const itemKind = getGoalCheckItemKind(check);

    if (vagueChecklistPatterns.some((pattern) => pattern.test(text)) && !concrete) {
      addAuditFlag(flags, "vague");
    }
    if (!concrete && check.status !== "not_applicable") {
      addAuditFlag(flags, "not_observable");
    }
    if (text.length > 220 || text.split(/\b(?:and|or)\b|[,;]/i).filter((entry) => entry.trim().length > 0).length >= 5) {
      addAuditFlag(flags, "too_broad");
    }
    if (taskLikeChecklistPattern.test(check.title) && !/\bmust\b|\bshould\b|\brequires?\b|\bacceptance\b/i.test(check.title)) {
      addAuditFlag(flags, "task_not_requirement");
    }
    if (/\b(?:nice to have|optional|polish|fit and finish|cleanup|clean up)\b/i.test(text) && !requiredUserGoalCheckSources.has(check.source)) {
      addAuditFlag(flags, "polish_not_required");
    }
    if (/\b(?:impossible to validate|cannot validate|not observable|unverifiable)\b/i.test(text)) {
      addAuditFlag(flags, "impossible_to_validate");
    }
    if (!goalTiesCheck(check, goal) && !/\b(?:block|blocked|credential|secret|security|validation|integrity|merge conflict|runtime safety)\b/i.test(text)) {
      addAuditFlag(flags, "not_tied_to_goal");
    }

    const normalizedKind = normalizeGoalCheckKind(itemKind, check.status);
    return {
      ...check,
      ...normalizedKind,
      auditFlags: [...flags].sort(),
      needsRefinement: flags.has("vague") || flags.has("not_observable") || flags.has("too_broad") || flags.has("impossible_to_validate") || undefined,
      classificationReason: check.classificationReason
    };
  });

export const consolidateGoalChecklist = (checklist: GoalAttainmentCheck[]): GoalAttainmentCheck[] => {
  const groups: GoalAttainmentCheck[][] = [];
  for (const rawCheck of checklist) {
    const itemKind = getGoalCheckItemKind(rawCheck);
    const normalizedKind = normalizeGoalCheckKind(itemKind, rawCheck.status);
    const check: GoalAttainmentCheck = sanitizeGoalAttainmentCheck({
      ...rawCheck,
      ...normalizedKind,
      relatedPaths: [...(rawCheck.relatedPaths ?? [])],
      sourceCheckIds: rawCheck.sourceCheckIds ?? [rawCheck.id],
      relatedCheckIds: rawCheck.relatedCheckIds ?? [],
      evidenceHistory: rawCheck.evidenceHistory ?? []
    });
    const matchingGroup = groups.find((group) => group.some((entry) => areDuplicateGoalChecks(entry, check)));
    if (matchingGroup) {
      matchingGroup.push(check);
    } else {
      groups.push([check]);
    }
  }

  return groups
    .map((group) => {
      if (group.length === 1) {
        const [check] = group;
        const canonicalKey = buildGoalCheckCanonicalKey(check);
        return sanitizeGoalAttainmentCheck({
          ...check,
          canonicalKey,
          groupId: check.groupId ?? `goal-check:${stableHash(canonicalKey)}`,
          sourceCheckIds: unique(check.sourceCheckIds ?? [check.id]),
          relatedCheckIds: unique(check.relatedCheckIds ?? []),
          evidenceHistory: collectGoalCheckEvidenceHistory([check])
        });
      }

      const representative = chooseRepresentativeGoalCheck(group);
      const status = chooseMergedGoalCheckStatus(group);
      const itemKind: GoalCheckItemKind = group.some((check) => getGoalCheckItemKind(check) === "required" && check.status !== "not_applicable")
        ? "required"
        : group.some((check) => getGoalCheckItemKind(check) === "backlog")
          ? "backlog"
          : "observation";
      const { required } = normalizeGoalCheckKind(itemKind, status);
      const description = [...group]
        .sort((left, right) => right.description.length - left.description.length)[0]?.description ?? representative.description;
      const confidence = Math.max(...group.map((check) => check.confidence ?? 0));
      const ownerAgent = [...group]
        .sort((left, right) => goalCheckTime(right.updatedAt) - goalCheckTime(left.updatedAt))
        .find((check) => check.ownerAgentId)?.ownerAgentId;
      const canonicalKey = buildGoalCheckCanonicalKey(representative);
      const groupId = representative.groupId ?? `goal-check:${stableHash(canonicalKey)}`;
      const relatedCheckIds = unique(group.flatMap((check) => [check.id, ...(check.relatedCheckIds ?? [])]).filter((id) => id !== representative.id));
      const auditFlags = unique([...group.flatMap((check) => check.auditFlags ?? []), "duplicate" as const]).sort();

      return sanitizeGoalAttainmentCheck({
        ...representative,
        title: representative.title,
        description,
        required,
        itemKind,
        canonicalKey,
        groupId,
        sourceCheckIds: unique(group.flatMap((check) => check.sourceCheckIds ?? [check.id])),
        relatedCheckIds,
        auditFlags,
        needsRefinement: auditFlags.some((flag) => flag !== "duplicate") || undefined,
        status,
        confidence: confidence > 0 ? confidence : representative.confidence,
        evidence: chooseMergedGoalCheckEvidence(group),
        evidenceHistory: collectGoalCheckEvidenceHistory(group),
        relatedPaths: unique(group.flatMap((check) => check.relatedPaths ?? [])).slice(0, 8),
        ownerAgentId: ownerAgent ?? representative.ownerAgentId,
        createdAt: [...group].sort((left, right) => goalCheckTime(left.createdAt) - goalCheckTime(right.createdAt))[0]?.createdAt ?? representative.createdAt,
        updatedAt: [...group].sort((left, right) => goalCheckTime(right.updatedAt) - goalCheckTime(left.updatedAt))[0]?.updatedAt ?? representative.updatedAt
      });
    })
    .sort((left, right) => {
      if (left.required !== right.required) {
        return left.required ? -1 : 1;
      }
      if (statusRank[left.status] !== statusRank[right.status]) {
        return statusRank[left.status] - statusRank[right.status];
      }
      return left.title.localeCompare(right.title);
    });
};

const isRequiredForCompletion = (check: GoalAttainmentCheck): boolean =>
  check.required && getGoalCheckItemKind(check) === "required" && check.status !== "not_applicable";

const isMetForCompletion = (check: GoalAttainmentCheck): boolean => check.status === "met";

const goalCheckSourceImpactScore: Record<GoalCheckSource, number> = {
  success_criterion: 100,
  quality_bar: 86,
  constraint: 72,
  deterministic: 64,
  agent: 58
};

const goalCheckStatusImpactScore: Record<GoalCheckStatus, number> = {
  unmet: 18,
  unknown: 10,
  not_applicable: -80,
  met: -120
};

const goalCheckCompletionImpactScore = (check: GoalAttainmentCheck): number =>
  goalCheckSourceImpactScore[check.source] +
  goalCheckStatusImpactScore[check.status] +
  (check.required ? 12 : 0) -
  (isGoalCheckBacklogOrObservation(check) ? 120 : 0);

const rankGoalChecksByCompletionImpact = (checks: GoalAttainmentCheck[]): GoalAttainmentCheck[] =>
  checks
    .map((check, index) => ({ check, index, score: goalCheckCompletionImpactScore(check) }))
    .sort((left, right) =>
      right.score - left.score ||
      left.index - right.index ||
      left.check.title.localeCompare(right.check.title)
    )
    .map((entry) => entry.check);

const batchableGoalCheckSources = new Set<GoalCheckSource>(["success_criterion", "quality_bar", "constraint", "agent"]);

const goalCheckBatchTopicPatterns: Array<[string, RegExp]> = [
  ["core portfolio analytics", /\b(portfolio|holding|holdings|market value|cash|weight|weights|sector|industry|theme|concentration|driver|p&l|cost basis)\b/i],
  ["performance analytics", /\b(transaction|performance|return|irr|time-weighted|money-weighted|cash flow|deposit|withdrawal|dividend|fee|drawdown|sharpe|volatility|benchmark|window|alpha|beta)\b/i],
  ["risk and rebalance intelligence", /\b(risk|factor|exposure|variance|stress|rebalance|overweight|underweight|drift|allocation|recommendation|decision support|advice)\b/i],
  ["research intelligence", /\b(news|social|reddit|twitter|filing|earnings|analyst|comparable|peer|valuation|consumer trend|sentiment|company-specific|watchlist)\b/i],
  ["local data and persistence", /\b(demo|mock|offline|local|persistent|cache|reproducible|fixture|deterministic|storage|indexeddb|localstorage)\b/i],
  ["source provenance and access policy", /\b(source|timestamp|freshness|refresh|provenance|scraping|terms|official api|external|provider|credential|missing-credential)\b/i],
  ["security and brokerage safety", /\b(secret|credential|api key|oauth|token|brokerage|power e\*trade|read-only|trade|order|security-sensitive|runtime-side)\b/i],
  ["architecture and typed boundaries", /\b(separation|connector|schema|analytics engine|ui component|typed|validation|ingestion|boundary|model)\b/i],
  ["ui resilience and scale", /\b(ui|responsive|loading|empty|error|degraded|rate limit|missing data|large transaction|many holdings|frequent refresh|performance)\b/i],
  ["settings and auditability", /\b(settings|configuration|assumption|threshold|target weight|alert|cadence|audit|formula|limitation|assumption)\b/i]
];

const goalCheckBatchTopicIndex = new Map(goalCheckBatchTopicPatterns.map(([label], index) => [label, index]));

interface GoalCheckBatch {
  label: string;
  checks: GoalAttainmentCheck[];
  relatedPaths: string[];
}

interface GoalCheckTaskGroup extends GoalCheckBatch {
  score: number;
}

const goalCheckSearchText = (check: GoalAttainmentCheck): string =>
  `${check.title} ${check.description} ${(check.relatedPaths ?? []).join(" ")}`;

const goalCheckBatchTopics = (check: GoalAttainmentCheck): string[] => {
  const text = goalCheckSearchText(check);
  const matched = goalCheckBatchTopicPatterns
    .filter(([, pattern]) => pattern.test(text))
    .map(([label]) => label);
  if (matched.length > 0) {
    return matched;
  }

  const pathTopics = (check.relatedPaths ?? [])
    .map((entry) => entry.replace(/\\/g, "/").split("/").filter(Boolean))
    .filter((parts) => parts.length >= 2 && parts[0] !== "docs")
    .map((parts) => parts.slice(0, 2).join("/"))
    .filter((entry) => entry.length > 0);
  return unique(pathTopics.length > 0 ? pathTopics : tokenize(text).slice(0, 2));
};

const goalCheckTopicPriority = (check: GoalAttainmentCheck, topic: string): number => {
  const normalizedTopic = normalizeGoalCheckSemanticText(topic);
  const normalizedText = normalizeGoalCheckSemanticText(goalCheckSearchText(check));
  const topicIndex = goalCheckBatchTopicIndex.get(topic) ?? goalCheckBatchTopicPatterns.length;
  if (normalizedText.startsWith(normalizedTopic) || normalizedText.includes(` ${normalizedTopic} `)) {
    return -100 + topicIndex;
  }
  if (
    topic === "security and brokerage safety" &&
    /\b(secret|secrets|credential|credentials|api key|api keys|oauth|token|brokerage|broker|read-only|trade|trades|orders?|security-sensitive|runtime-side)\b/i.test(goalCheckSearchText(check))
  ) {
    return -80 + topicIndex;
  }
  return topicIndex;
};

const rankGoalCheckBatch = (checks: GoalAttainmentCheck[]): number =>
  checks.reduce((sum, check) => sum + goalCheckCompletionImpactScore(check), 0) +
  Math.min(checks.length, 4) * 22;

const buildGoalCheckBatchLabel = (checks: GoalAttainmentCheck[]): string => {
  const topicStats = new Map<string, { count: number; priority: number }>();
  for (const check of checks) {
    for (const topic of goalCheckBatchTopics(check)) {
      const existing = topicStats.get(topic);
      topicStats.set(topic, {
        count: (existing?.count ?? 0) + 1,
        priority: Math.min(existing?.priority ?? Number.POSITIVE_INFINITY, goalCheckTopicPriority(check, topic))
      });
    }
  }
  const [topic] = [...topicStats.entries()]
    .sort((left, right) =>
      right[1].count - left[1].count ||
      left[1].priority - right[1].priority ||
      left[0].localeCompare(right[0])
    )[0] ?? [];
  return topic ?? "related goal checks";
};

const collectGoalCheckBatchPaths = (context: WorkflowRecommendationContext, checks: GoalAttainmentCheck[]): string[] => {
  const keywords = unique(checks.flatMap((check) => tokenize(goalCheckSearchText(check)))).slice(0, 20);
  return unique([
    ...checks.flatMap((check) => check.relatedPaths ?? []),
    ...rankRelevantPaths(context, checks.flatMap((check) => check.relatedPaths ?? []), keywords)
  ]).slice(0, 4);
};

const buildGoalCheckTaskGroups = (
  context: WorkflowRecommendationContext,
  rankedChecks: GoalAttainmentCheck[]
): GoalCheckTaskGroup[] => {
  const groups = new Map<string, GoalAttainmentCheck[]>();
  const candidates = rankedChecks.filter((check) => batchableGoalCheckSources.has(check.source));

  for (const check of candidates) {
    const label = buildGoalCheckBatchLabel([check]);
    groups.set(label, [...(groups.get(label) ?? []), check]);
  }

  return [...groups.entries()]
    .map(([label, checks]) => ({
      label,
      checks: rankGoalChecksByCompletionImpact(checks),
      relatedPaths: collectGoalCheckBatchPaths(context, checks),
      score: rankGoalCheckBatch(checks)
    }))
    .sort((left, right) =>
      right.score - left.score ||
      right.checks.length - left.checks.length ||
      left.label.localeCompare(right.label)
    );
};

const buildPathCoherentGoalCheckTaskGroups = (
  context: WorkflowRecommendationContext,
  rankedChecks: GoalAttainmentCheck[]
): GoalCheckTaskGroup[] => {
  const groups = new Map<string, GoalAttainmentCheck[]>();
  const candidates = rankedChecks.filter((check) => batchableGoalCheckSources.has(check.source));

  for (const check of candidates) {
    const likelyPaths = collectGoalCheckBatchPaths(context, [check]);
    const areas = pathAreas(likelyPaths.length ? likelyPaths : check.relatedPaths ?? []);
    for (const area of areas.slice(0, 2)) {
      groups.set(area, [...(groups.get(area) ?? []), check]);
    }
  }

  return [...groups.entries()]
    .filter(([, checks]) => checks.length >= 2)
    .map(([area, checks]) => {
      const ranked = rankGoalChecksByCompletionImpact(checks);
      return {
        label: `${area} required checks`,
        checks: ranked,
        relatedPaths: collectGoalCheckBatchPaths(context, ranked),
        score: rankGoalCheckBatch(ranked) + ranked.length * 14
      };
    })
    .sort((left, right) =>
      right.score - left.score ||
      right.checks.length - left.checks.length ||
      left.label.localeCompare(right.label)
    );
};

const buildGoalCheckBatches = (
  context: WorkflowRecommendationContext,
  rankedChecks: GoalAttainmentCheck[]
): GoalCheckBatch[] =>
  buildGoalCheckTaskGroups(context, rankedChecks)
    .filter((batch) => batch.checks.length >= 2)
    .map(({ label, checks, relatedPaths }) => ({ label, checks, relatedPaths }));

export interface ChecklistWorkPackageOptions {
  maxPackages?: number;
  minChecksPerPackage?: number;
  maxChecksPerPackage?: number;
}

const safetyCriticalPackagePattern =
  /\b(?:credential|credentials|secret|secrets|api key|token|oauth|approval|sandbox|node api|contextisolation|nodeintegration|renderer\/main|renderer-main|main process|runtime safety|brokerage|trade|order|security|privileged|merge conflict|integrity|validation)\b/i;

const isSafetyCriticalPackage = (checks: GoalAttainmentCheck[], likelyPaths: string[] = []): boolean =>
  safetyCriticalPackagePattern.test([
    ...checks.flatMap((check) => [check.title, check.description, check.evidence, ...check.relatedPaths]),
    ...likelyPaths
  ].join(" "));

const estimatePackageBreadth = (
  checks: GoalAttainmentCheck[],
  likelyPaths: string[],
  maxChecksPerPackage: number
): WorkPackage["estimatedBreadth"] => {
  const areaCount = pathAreas(likelyPaths).length;
  if (checks.length <= 1 && areaCount <= 1) {
    return "small";
  }
  if (checks.length <= 4 && areaCount <= 3) {
    return "medium";
  }
  if (checks.length <= maxChecksPerPackage && areaCount <= 2) {
    return "medium";
  }
  return "large";
};

const estimatePackageRisk = (
  checks: GoalAttainmentCheck[],
  likelyPaths: string[],
  maxChecksPerPackage: number
): WorkPackage["riskLevel"] => {
  const text = checks.map(goalCheckSearchText).join(" ");
  if (
    checks.length > maxChecksPerPackage ||
    pathAreas(likelyPaths).length > 4 ||
    /\b(?:credential|secret|token|brokerage|trade|order|runtime safety|security)\b/i.test(text)
  ) {
    return "high";
  }
  if (checks.length >= 3 || pathAreas(likelyPaths).length >= 2 || /\b(?:schema|migration|ipc|preload|main process|validation|integrity)\b/i.test(text)) {
    return "medium";
  }
  return "low";
};

const packageCoherenceScore = (checks: GoalAttainmentCheck[]): number => {
  if (checks.length <= 1) {
    return 0.62;
  }
  const pairs: number[] = [];
  for (let leftIndex = 0; leftIndex < checks.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < checks.length; rightIndex += 1) {
      const left = checks[leftIndex];
      const right = checks[rightIndex];
      const tokenScore = tokenJaccardScore(
        checklistTokenSet(goalCheckSearchText(left)),
        checklistTokenSet(goalCheckSearchText(right))
      );
      const topicScore = inferGoalCheckPrimaryTopic(left) === inferGoalCheckPrimaryTopic(right) ? 0.22 : 0;
      const pathScore = setsIntersect(pathAreas(left.relatedPaths ?? []), pathAreas(right.relatedPaths ?? [])) ? 0.18 : 0;
      const sourceScore = left.source === right.source ? 0.08 : 0;
      pairs.push(Math.min(1, tokenScore + topicScore + pathScore + sourceScore));
    }
  }
  return pairs.length ? pairs.reduce((sum, score) => sum + score, 0) / pairs.length : 0.62;
};

const buildWorkPackageTitle = (topic: string, checks: GoalAttainmentCheck[]): string => {
  const normalizedTopic = normalizeSpace(topic);
  if (checks.length > 1) {
    return `${normalizedTopic} work package`;
  }
  return truncate(checks[0]?.title ?? normalizedTopic, 90);
};

const buildPackageAcceptanceHints = (checks: GoalAttainmentCheck[]): string[] =>
  unique(checks.flatMap((check) => {
    const hints = [
      check.status === "unmet"
        ? `Show repository evidence that "${check.title}" is no longer unmet.`
        : `Gather direct evidence for "${check.title}".`,
      check.evidence && !isWeakChecklistEvidence(check.evidence) ? `Current evidence to address: ${truncate(normalizeSpace(check.evidence), 150)}` : "",
      check.relatedPaths.length ? `Verify relevant paths: ${check.relatedPaths.slice(0, 3).join(", ")}.` : ""
    ];
    return hints.filter((entry) => entry.length > 0);
  })).slice(0, 6);

export const buildChecklistWorkPackages = (
  workflowOrContext: ProjectWorkflowState | WorkflowRecommendationContext,
  options: ChecklistWorkPackageOptions = {}
): WorkPackage[] => {
  const context = "workflow" in workflowOrContext ? workflowOrContext : undefined;
  const workflow = context?.workflow ?? (workflowOrContext as ProjectWorkflowState);
  const modeConfig = getWorkflowModeConfig(workflow.workflowMode, resolveEffectiveAutopilotPolicy(workflow));
  const maxPackages = options.maxPackages ?? 6;
  const minChecksPerPackage = options.minChecksPerPackage ?? 1;
  const maxChecksPerPackage = options.maxChecksPerPackage ?? modeConfig.maxChecksPerPackage;
  const checklist = context
    ? buildGoalChecklistForAssessment(context)
    : auditGoalChecklist(consolidateGoalChecklist(workflow.goalChecklist ?? []), workflow.ultimateGoal);
  const openRequiredChecks = rankGoalChecksByCompletionImpact(
    checklist.filter((check) => isRequiredForCompletion(check) && !isMetForCompletion(check))
  );
  if (openRequiredChecks.length === 0) {
    return [];
  }

  const topicGroups = context
    ? buildGoalCheckTaskGroups(context, openRequiredChecks)
    : [...openRequiredChecks.reduce((map, check) => {
      const topic = buildGoalCheckBatchLabel([check]);
      map.set(topic, [...(map.get(topic) ?? []), check]);
      return map;
    }, new Map<string, GoalAttainmentCheck[]>()).entries()].map(([label, checks]) => ({
      label,
      checks: rankGoalChecksByCompletionImpact(checks),
      relatedPaths: unique(checks.flatMap((check) => check.relatedPaths ?? [])).slice(0, 4),
      score: rankGoalCheckBatch(checks)
    }));
  const pathGroups = context && modeConfig.mode === "fast"
    ? buildPathCoherentGoalCheckTaskGroups(context, openRequiredChecks)
    : [];
  const seenGroupKeys = new Set<string>();
  const groups = [...topicGroups, ...pathGroups].filter((group) => {
    const key = group.checks.map((check) => check.id).sort().join("|");
    if (seenGroupKeys.has(key)) {
      return false;
    }
    seenGroupKeys.add(key);
    return true;
  });

  return groups
    .flatMap((group) => {
      const sortedChecks = rankGoalChecksByCompletionImpact(group.checks);
      const chunks: GoalAttainmentCheck[][] = [];
      for (let index = 0; index < sortedChecks.length; index += maxChecksPerPackage) {
        chunks.push(sortedChecks.slice(index, index + maxChecksPerPackage));
      }
      return chunks
        .filter((checks) => checks.length >= minChecksPerPackage)
        .map((checks) => {
          const likelyPaths = context ? collectGoalCheckBatchPaths(context, checks) : unique([
            ...group.relatedPaths,
            ...checks.flatMap((check) => check.relatedPaths ?? [])
          ]).slice(0, 4);
          const coherence = packageCoherenceScore(checks);
          const coverageScore = checks.reduce((sum, check) => sum + goalCheckCompletionImpactScore(check), 0);
          const breadth = estimatePackageBreadth(checks, likelyPaths, maxChecksPerPackage);
          const riskLevel = estimatePackageRisk(checks, likelyPaths, maxChecksPerPackage);
          const safetyCritical = isSafetyCriticalPackage(checks, likelyPaths);
          const sharedPathBonus = likelyPaths.length > 0 && pathAreas(likelyPaths).length <= 3 ? 24 : 0;
          const sharedPathConfidenceBonus = sharedPathBonus > 0 ? 0.07 : 0;
          const acceptanceBonus = checks.some((check) => hasConcreteAcceptanceSignal(check)) ? 18 : 0;
          const fastGroupedBonus = modeConfig.mode === "fast"
            ? Math.max(0, checks.length - 1) * modeConfig.groupedRequiredCheckBonus
            : Math.max(0, checks.length - 1) * 18;
          const score = Math.round(
            coverageScore +
            checks.length * (modeConfig.mode === "fast" ? 54 : 36) +
            fastGroupedBonus +
            sharedPathBonus +
            acceptanceBonus +
            coherence * (modeConfig.mode === "fast" ? 118 : 90) -
            (breadth === "large" ? modeConfig.mode === "fast" ? 18 : 38 : 0) -
            (riskLevel === "high" && !safetyCritical ? 30 : riskLevel === "medium" ? 8 : 0)
          );
          const impact: WorkPackage["estimatedImpact"] = score >= 260 || checks.length >= 3 ? "high" : score >= 150 ? "medium" : "low";
          const title = buildWorkPackageTitle(group.label, checks);
          return {
            id: `work-package:${stableHash(checks.map((check) => check.id).sort().join("|"))}`,
            title,
            summary: `Close ${checks.length} related required check${checks.length === 1 ? "" : "s"} without changing checklist granularity.`,
            checkIds: checks.map((check) => check.id),
            primaryTopic: group.label,
            likelyPaths,
            estimatedBreadth: breadth,
            estimatedImpact: impact,
            confidence: Math.max(0.45, Math.min(0.96, 0.54 + coherence * 0.34 + Math.min(checks.length, 4) * 0.03 + sharedPathConfidenceBonus)),
            riskLevel,
            reason: `Grouped by ${group.label} plus shared checklist semantics${likelyPaths.length ? ` and likely paths ${likelyPaths.join(", ")}` : ""}.`,
            acceptanceHints: buildPackageAcceptanceHints(checks),
            score
          } satisfies WorkPackage;
        });
    })
    .sort((left, right) =>
      right.score - left.score ||
      right.checkIds.length - left.checkIds.length ||
      left.riskLevel.localeCompare(right.riskLevel) ||
      left.title.localeCompare(right.title)
    )
    .slice(0, maxPackages);
};

export interface GoalCheckUpdateInput {
  action?: "add" | "update" | "remove";
  id?: string;
  title: string;
  description?: string;
  required?: boolean;
  itemKind?: GoalCheckItemKind;
  status?: GoalCheckStatus;
  confidence?: number;
  evidence?: string;
  relatedPaths?: string[];
  promotionReason?: string;
}

const findExistingGoalCheck = (
  existing: GoalAttainmentCheck[],
  id: string,
  title: string
): GoalAttainmentCheck | undefined => {
  const byId = existing.find((check) => check.id === id);
  if (byId) {
    return byId;
  }
  const titleKey = normalizedGoalCheckTitle(title);
  return existing.find((check) => normalizedGoalCheckTitle(check.title) === titleKey);
};

const createOrPreserveGoalCheck = (
  existing: GoalAttainmentCheck[],
  source: GoalCheckSource,
  title: string,
  description: string,
  required: boolean,
  timestamp: string
): GoalAttainmentCheck => {
  const normalizedTitle = normalizeSpace(title);
  const id = buildGoalCheckId(source, `${source}:${normalizedTitle}`);
  const found = findExistingGoalCheck(existing, id, normalizedTitle);
  if (found) {
    const itemKind = required ? "required" : getGoalCheckItemKind(found);
    const normalizedKind = normalizeGoalCheckKind(itemKind, found.status);
    return {
      ...found,
      id,
      title: normalizedTitle,
      description: description.trim() || found.description,
      ...normalizedKind,
      source,
      relatedPaths: found.relatedPaths ?? [],
      createdAt: found.createdAt || timestamp,
      updatedAt: found.updatedAt || timestamp
    };
  }

  return {
    id,
    title: normalizedTitle,
    description: description.trim(),
    ...normalizeGoalCheckKind(required ? "required" : "backlog", "unknown"),
    status: "unknown",
    evidence: "",
    source,
    relatedPaths: [],
    createdAt: timestamp,
    updatedAt: timestamp
  };
};

export const buildGoalChecklistFromUltimateGoal = (
  goal: UltimateGoal,
  existing: GoalAttainmentCheck[] = [],
  timestamp = nowIso()
): GoalAttainmentCheck[] => {
  const checks: GoalAttainmentCheck[] = [];
  const usedIds = new Set<string>();

  const addCheck = (check: GoalAttainmentCheck): void => {
    if (usedIds.has(check.id)) {
      return;
    }
    checks.push(check);
    usedIds.add(check.id);
  };

  for (const criterion of goal.successCriteria.map(normalizeSpace).filter(Boolean)) {
    addCheck(createOrPreserveGoalCheck(existing, "success_criterion", criterion, criterion, true, timestamp));
  }

  if (goal.qualityBar.trim()) {
    addCheck(createOrPreserveGoalCheck(existing, "quality_bar", "Quality bar satisfied", goal.qualityBar, true, timestamp));
  }

  for (const constraint of goal.constraints.map(normalizeSpace).filter(Boolean)) {
    addCheck(
      createOrPreserveGoalCheck(
        existing,
        "constraint",
        `Constraint preserved: ${truncate(constraint, 88)}`,
        constraint,
        true,
        timestamp
      )
    );
  }

  if (checks.length === 0 && goal.summary.trim()) {
    addCheck(
      createOrPreserveGoalCheck(
        existing,
        "success_criterion",
        `Ultimate Goal delivered: ${truncate(goal.summary, 88)}`,
        goal.summary,
        true,
        timestamp
      )
    );
  }

  for (const check of existing) {
    if (usedIds.has(check.id)) {
      continue;
    }
    if (check.source === "agent" || check.source === "deterministic" || !check.required) {
      const itemKind = getGoalCheckItemKind(check);
      const normalizedKind = normalizeGoalCheckKind(itemKind, check.status);
      checks.push({
        ...check,
        ...normalizedKind,
        relatedPaths: check.relatedPaths ?? [],
        createdAt: check.createdAt || timestamp,
        updatedAt: check.updatedAt || timestamp
      });
      usedIds.add(check.id);
    }
  }

  return auditGoalChecklist(consolidateGoalChecklist(checks), goal);
};

const toTime = (value?: string): number => value ? new Date(value).getTime() : 0;

const latestAgentTimestamp = (agent: AgentState): string =>
  agent.completedAt ?? agent.lastActivityAt ?? agent.startedAt ?? agent.createdAt;

const incompleteSignalPatterns = [
  /\bplaceholder(?:-grade| shell| data|s)?\b/i,
  /\bno live (?:market )?data\b/i,
  /\bnot implemented\b/i,
  /\bnot yet implemented\b/i,
  /\bmock data\b/i,
  /\bsample data\b/i,
  /\bsynthetic data\b/i,
  /\bstatic (?:dashboard|shell|mockup)\b/i,
  /\bempty metric\b/i,
  /\bTODO\b/
];

const detectAdmittedIncompleteSignals = (agents: AgentState[]): Array<{ timestamp: string; detail: string }> =>
  agents.flatMap((agent) => {
    const fragments = [
      agent.currentPhase,
      agent.lastMessageSnippet,
      agent.recommendationReport?.summary,
      agent.integrityReport?.summary,
      ...(agent.integrityReport?.risks ?? [])
    ].filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
    return fragments
      .filter((fragment) => incompleteSignalPatterns.some((pattern) => pattern.test(fragment)))
      .map((fragment) => ({
        timestamp: latestAgentTimestamp(agent),
        detail: `${agent.name}: ${truncate(normalizeSpace(fragment), 220)}`
      }));
  })
    .sort((left, right) => toTime(right.timestamp) - toTime(left.timestamp));

const latestIntegrityAgent = (agents: AgentState[]): AgentState | undefined =>
  [...agents]
    .filter((agent) => agent.category === "integrity")
    .sort((left, right) => toTime(latestAgentTimestamp(right)) - toTime(latestAgentTimestamp(left)))[0];

const upsertDeterministicCheck = (
  checks: GoalAttainmentCheck[],
  input: {
    id: string;
    title: string;
    description: string;
    status: GoalCheckStatus;
    evidence: string;
    timestamp: string;
  }
): GoalAttainmentCheck[] => {
  const index = checks.findIndex((check) => check.id === input.id);
  const existing = index >= 0 ? checks[index] : undefined;
  const next: GoalAttainmentCheck = {
    id: input.id,
    title: input.title,
    description: input.description,
    required: true,
    itemKind: "required",
    promotionReason: "Deterministic workflow blocker or validation state is required for completion.",
    status: input.status,
    evidence: input.evidence,
    source: "deterministic",
    relatedPaths: existing?.relatedPaths ?? [],
    ownerAgentId: existing?.ownerAgentId,
    createdAt: existing?.createdAt ?? input.timestamp,
    updatedAt:
      existing && existing.status === input.status && existing.evidence === input.evidence
        ? existing.updatedAt
        : input.timestamp
  };
  if (index >= 0) {
    return checks.map((check, entryIndex) => entryIndex === index ? next : check);
  }
  return [...checks, next];
};

export const buildGoalChecklistForAssessment = (
  context: Pick<WorkflowRecommendationContext, "workflow" | "agents">,
  timestamp = nowIso()
): GoalAttainmentCheck[] => {
  let checks = buildGoalChecklistFromUltimateGoal(
    context.workflow.ultimateGoal,
    context.workflow.goalChecklist ?? [],
    timestamp
  );

  const openIssues = context.workflow.memory.knownOpenIssues.filter((issue) => issue.status === "open");
  const pendingInterventions = context.workflow.humanInterventions.filter((intervention) => intervention.status === "pending");
  checks = upsertDeterministicCheck(checks, {
    id: "deterministic:workflow-blockers",
    title: "No open workflow issues or pending blockers",
    description: "The workflow must have no unresolved integrity, merge, system, or human-intervention blockers.",
    status: openIssues.length === 0 && pendingInterventions.length === 0 ? "met" : "unmet",
    evidence: openIssues.length === 0 && pendingInterventions.length === 0
      ? "No open workflow issues or pending interventions are recorded."
      : `${openIssues.length} open issue(s) and ${pendingInterventions.length} pending intervention(s) remain.`,
    timestamp
  });

  const integrityAgent = latestIntegrityAgent(context.agents);
  const integrityPassed = Boolean(
    integrityAgent?.status === "completed" &&
    integrityAgent.integrityReport &&
    integrityAgent.integrityReport.checks.every((check) => check.status === "passed") &&
    integrityAgent.integrityReport.risks.length === 0
  );
  checks = upsertDeterministicCheck(checks, {
    id: "deterministic:latest-validation",
    title: "Latest deterministic validation passed",
    description: "The latest integrity run must pass the repository's deterministic checks for the implemented work.",
    status: integrityAgent ? integrityPassed ? "met" : "unmet" : "unknown",
    evidence: integrityAgent
      ? integrityPassed
        ? `Latest integrity report passed ${integrityAgent.integrityReport?.checks.length ?? 0} check(s).`
        : integrityAgent.integrityReport?.summary ?? "The latest integrity run did not pass."
      : "No integrity validation run has completed yet.",
    timestamp
  });

  const incompleteSignal = detectAdmittedIncompleteSignals(context.agents)[0];
  const existingIncompleteCheck = checks.find((check) => check.id === "deterministic:no-admitted-incomplete-work");
  const existingMetAfterSignal = Boolean(
    incompleteSignal &&
    existingIncompleteCheck?.status === "met" &&
    toTime(existingIncompleteCheck.updatedAt) > toTime(incompleteSignal.timestamp)
  );
  checks = upsertDeterministicCheck(checks, {
    id: "deterministic:no-admitted-incomplete-work",
    title: "No admitted placeholder or incomplete implementation remains",
    description: "Agent reports must not contain unresolved admissions that the shipped surface is placeholder-only, mock-only, or missing core data/behavior.",
    status: incompleteSignal && !existingMetAfterSignal ? "unmet" : "met",
    evidence: incompleteSignal && !existingMetAfterSignal
      ? incompleteSignal.detail
      : existingIncompleteCheck?.evidence && existingIncompleteCheck.status === "met"
        ? existingIncompleteCheck.evidence
        : "No unresolved placeholder or incomplete-implementation admission is present in the latest workflow evidence.",
    timestamp
  });

  return auditGoalChecklist(consolidateGoalChecklist(checks), context.workflow.ultimateGoal);
};

const hardBlockerPromotionPattern = /\b(?:hard blocker|blocks?|blocked|blocking|cannot complete|prevents? completion|required before completion|must resolve|merge conflict|integrity failed|validation failed|typecheck failed|lint failed|test failed|build failed)\b/i;
const validationPromotionPattern = /\b(?:validation|integrity|typecheck|lint|test|build|schema|migration|corrupt|invalid|incompatible|broken|failing|failed)\b/i;
const securityPromotionPattern = /\b(?:secret|credential|api key|token|oauth|private key|security|sandbox|node api|contextisolation|nodeintegration|runtime safety|approval|privileged)\b/i;

const textMatchesUltimateGoal = (input: {
  title: string;
  description?: string;
  evidence?: string;
  ultimateGoal?: UltimateGoal;
}): boolean => {
  const goal = input.ultimateGoal;
  if (!goal) {
    return false;
  }
  const checkTokens = checklistTokenSet(`${input.title} ${input.description ?? ""} ${input.evidence ?? ""}`);
  const goalTokens = checklistTokenSet([
    goal.summary,
    goal.detailedIntent,
    goal.qualityBar,
    ...goal.successCriteria,
    ...goal.constraints
  ].join(" "));
  return tokenOverlapRatio(checkTokens, goalTokens) >= 0.5 || tokenJaccardScore(checkTokens, goalTokens) >= 0.28;
};

const determineGoalCheckPromotion = (
  update: GoalCheckUpdateInput,
  options: {
    ultimateGoal?: UltimateGoal;
    operatorFeedback?: boolean;
  }
): { itemKind: GoalCheckItemKind; required: boolean; reason?: string; capExempt: boolean } => {
  if (update.itemKind === "observation") {
    return {
      itemKind: "observation",
      required: false,
      reason: "Agent supplied this checklist item as a non-blocking observation.",
      capExempt: false
    };
  }
  if (update.itemKind === "backlog" || update.required === false) {
    return {
      itemKind: "backlog",
      required: false,
      reason: "Agent supplied this checklist item as backlog, so it does not gate Ultimate Goal completion.",
      capExempt: false
    };
  }

  const text = `${update.title} ${update.description ?? ""} ${update.evidence ?? ""}`;
  if (options.operatorFeedback) {
    return {
      itemKind: "required",
      required: true,
      reason: update.promotionReason ?? "Promoted because the item came from explicit operator feedback.",
      capExempt: false
    };
  }
  if (securityPromotionPattern.test(text)) {
    return {
      itemKind: "required",
      required: true,
      reason: update.promotionReason ?? "Promoted because the item describes a security, credential, approval, or runtime-safety issue.",
      capExempt: true
    };
  }
  if (hardBlockerPromotionPattern.test(text)) {
    return {
      itemKind: "required",
      required: true,
      reason: update.promotionReason ?? "Promoted because the item describes a hard blocker that prevents completion.",
      capExempt: true
    };
  }
  if (validationPromotionPattern.test(text) && /\b(?:fail|failed|failing|broken|invalid|corrupt|incompatible|prevents?|blocks?)\b/i.test(text)) {
    return {
      itemKind: "required",
      required: true,
      reason: update.promotionReason ?? "Promoted because the item describes a validation or integrity failure that prevents completion.",
      capExempt: true
    };
  }
  if (textMatchesUltimateGoal({
    title: update.title,
    description: update.description,
    evidence: update.evidence,
    ultimateGoal: options.ultimateGoal
  })) {
    return {
      itemKind: "required",
      required: true,
      reason: update.promotionReason ?? "Promoted because the item is derived from the confirmed Ultimate Goal.",
      capExempt: false
    };
  }

  return {
    itemKind: "backlog",
    required: false,
    reason: "Agent-suggested item stayed in backlog because it was not derived from the Ultimate Goal, a hard blocker, explicit operator feedback, a validation failure, or a safety issue.",
    capExempt: false
  };
};

export const applyGoalChecklistUpdates = (
  checklist: GoalAttainmentCheck[],
  updates: GoalCheckUpdateInput[],
  options: {
    timestamp?: string;
    ownerAgentId?: string;
    ultimateGoal?: UltimateGoal;
    cycleNumber?: number;
    maxNewRequiredChecks?: number;
    operatorFeedback?: boolean;
  } = {}
): GoalAttainmentCheck[] => {
  const timestamp = options.timestamp ?? nowIso();
  const next = checklist.map((check) => ({ ...check, relatedPaths: [...(check.relatedPaths ?? [])] }));
  const maxNewRequiredChecks = options.maxNewRequiredChecks ?? 2;
  let newRequiredChecksIntroduced = 0;

  for (const update of updates) {
    const title = normalizeSpace(update.title);
    if (!title) {
      continue;
    }
    const id = update.id?.trim() || buildGoalCheckId("agent", title);
    const index = next.findIndex((check) =>
      check.id === id || normalizedGoalCheckTitle(check.title) === normalizedGoalCheckTitle(title)
    );

    if (update.action === "remove") {
      if (index < 0) {
        continue;
      }
      const existing = next[index];
      if (requiredUserGoalCheckSources.has(existing.source)) {
        next[index] = {
          ...existing,
          status: "not_applicable",
          required: false,
          evidence: sanitizeChecklistEvidenceText(update.evidence?.trim() || "An agent marked this user-derived check as not applicable."),
          confidence: update.confidence ?? existing.confidence,
          updatedAt: timestamp,
          ownerAgentId: options.ownerAgentId ?? existing.ownerAgentId
        };
      } else {
        next.splice(index, 1);
      }
      continue;
    }

    const existing = index >= 0 ? next[index] : undefined;
    let status = update.status ?? existing?.status ?? "unknown";
    let evidence = sanitizeChecklistEvidenceText(update.evidence?.trim() ?? existing?.evidence ?? "");
    if (status === "met" && !evidence) {
      status = "unknown";
      evidence = "An agent tried to mark this met without evidence, so the check remains unknown.";
    }
    const promotion = existing
      ? {
        itemKind: update.itemKind ?? (update.required === false ? "backlog" as const : update.required === true ? "required" as const : getGoalCheckItemKind(existing)),
        required: update.required ?? existing.required,
        reason: update.promotionReason ?? existing.promotionReason,
        capExempt: false
      }
      : determineGoalCheckPromotion(update, {
        ultimateGoal: options.ultimateGoal,
        operatorFeedback: options.operatorFeedback
      });
    const isNewRequired = !existing && promotion.required && promotion.itemKind === "required";
    const cappedPromotion =
      isNewRequired &&
      !promotion.capExempt &&
      newRequiredChecksIntroduced >= maxNewRequiredChecks;
    const itemKind = cappedPromotion ? "backlog" : promotion.itemKind;
    const normalizedKind = normalizeGoalCheckKind(itemKind, status);
    if (isNewRequired && !cappedPromotion && !promotion.capExempt) {
      newRequiredChecksIntroduced += 1;
    }
    const classificationReason = cappedPromotion
      ? `Kept as backlog because the normal cap of ${maxNewRequiredChecks} new required checks for this cycle was already reached.`
      : promotion.capExempt && newRequiredChecksIntroduced >= maxNewRequiredChecks
        ? `Promoted outside the normal cap because ${promotion.reason ?? "the item is a safety or hard blocker."}`
        : promotion.reason;

    const merged: GoalAttainmentCheck = sanitizeGoalAttainmentCheck({
      id: existing?.id ?? id,
      title: existing?.title ?? title,
      description: update.description?.trim() ?? existing?.description ?? "",
      required: normalizedKind.required,
      itemKind: normalizedKind.itemKind,
      canonicalKey: existing?.canonicalKey,
      groupId: existing?.groupId,
      sourceCheckIds: existing?.sourceCheckIds ?? (existing ? [existing.id] : [id]),
      relatedCheckIds: existing?.relatedCheckIds ?? [],
      auditFlags: existing?.auditFlags ?? [],
      needsRefinement: existing?.needsRefinement,
      classificationReason,
      promotionReason: normalizedKind.itemKind === "required" ? classificationReason : existing?.promotionReason,
      introducedCycleNumber: existing?.introducedCycleNumber ?? (normalizedKind.itemKind === "required" ? options.cycleNumber : undefined),
      status,
      confidence: update.confidence ?? existing?.confidence,
      evidence,
      evidenceHistory: existing?.evidenceHistory ?? [],
      source: existing?.source ?? "agent",
      relatedPaths: unique([...(existing?.relatedPaths ?? []), ...(update.relatedPaths ?? [])]).slice(0, 8),
      ownerAgentId: options.ownerAgentId ?? existing?.ownerAgentId,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt:
        existing &&
        existing.status === status &&
        existing.evidence === evidence &&
        existing.required === normalizedKind.required
          ? existing.updatedAt
          : timestamp
    });

    if (index >= 0) {
      next[index] = merged;
    } else {
      next.push(merged);
    }
  }

  return auditGoalChecklist(consolidateGoalChecklist(next), options.ultimateGoal).sort((left, right) => {
    if (left.required !== right.required) {
      return left.required ? -1 : 1;
    }
    if (statusRank[left.status] !== statusRank[right.status]) {
      return statusRank[left.status] - statusRank[right.status];
    }
    return left.title.localeCompare(right.title);
  });
};

const summarizeChecklistProgress = (checklist: GoalAttainmentCheck[]): {
  required: GoalAttainmentCheck[];
  met: GoalAttainmentCheck[];
  unmet: GoalAttainmentCheck[];
  percentComplete: number;
} => {
  const required = checklist.filter(isRequiredForCompletion);
  const met = required.filter(isMetForCompletion);
  const unmet = required.filter((check) => !isMetForCompletion(check));
  const percentComplete = required.length > 0 ? Math.round((met.length / required.length) * 100) : 0;
  return {
    required,
    met,
    unmet,
    percentComplete
  };
};

export interface ChecklistTaskMapBriefOptions {
  maxGroups?: number;
  maxRepresentativeChecks?: number;
}

export const buildChecklistTaskMap = (
  context: WorkflowRecommendationContext,
  timestamp = nowIso()
): WorkflowTaskMap => {
  const checklist = buildGoalChecklistForAssessment(context, timestamp);
  const required = checklist.filter(isRequiredForCompletion);
  const groups = buildGoalCheckTaskGroups(context, rankGoalChecksByCompletionImpact(required));

  return {
    groups: groups.map((group) => {
      const openChecks = group.checks.filter((check) => !isMetForCompletion(check));
      const metChecks = group.checks.filter(isMetForCompletion);
      const representativeChecks = rankGoalChecksByCompletionImpact(
        openChecks.length ? openChecks : group.checks
      ).slice(0, 5).map((check) => check.title);
      return {
        id: `task:${stableHash(group.label)}`,
        title: group.label,
        rationale: `Grouped by shared checklist semantics, likely implementation paths, tests, or validation evidence for ${group.label}.`,
        checkIds: group.checks.map((check) => check.id),
        representativeChecks,
        relatedPaths: group.relatedPaths,
        openCheckCount: openChecks.length,
        metCheckCount: metChecks.length,
        status: openChecks.length === 0 ? "complete" : "open",
        priority: group.score
      };
    }),
    totalRequiredChecks: required.length,
    openRequiredChecks: required.filter((check) => !isMetForCompletion(check)).length,
    updatedAt: timestamp
  };
};

export const buildChecklistTaskMapBrief = (
  context: WorkflowRecommendationContext,
  options: ChecklistTaskMapBriefOptions = {}
): string => {
  const maxGroups = options.maxGroups ?? 8;
  const maxRepresentativeChecks = options.maxRepresentativeChecks ?? 4;
  const taskMap = buildChecklistTaskMap(context);
  const groups = taskMap.groups.filter((group) => group.status !== "complete");
  const visibleGroups = groups.slice(0, maxGroups);
  const hiddenGroups = Math.max(0, groups.length - visibleGroups.length);

  return [
    "Checklist task map:",
    `- Required checklist size: ${taskMap.totalRequiredChecks}. Open required checks: ${taskMap.openRequiredChecks}.`,
    groups.length
      ? `- Estimated task groups from checklist semantics: ${groups.length}. Each group is a candidate cycle/task area; do not treat individual checklist items as separate cycles when they belong to the same group.`
      : "- Estimated task groups from checklist semantics: none open.",
    ...visibleGroups.map((group) => {
      const representatives = group.representativeChecks.slice(0, maxRepresentativeChecks);
      const hiddenChecks = Math.max(0, group.openCheckCount - representatives.length);
      return `- ${group.title}: ${group.openCheckCount} open required check${group.openCheckCount === 1 ? "" : "s"}; representative checks: ${formatOutcomeBriefList(representatives, representatives.length, "none")}${hiddenChecks > 0 ? `; plus ${hiddenChecks} related check${hiddenChecks === 1 ? "" : "s"}` : ""}${group.relatedPaths.length ? `; likely paths: ${group.relatedPaths.join(", ")}` : ""}.`;
    }),
    hiddenGroups > 0
      ? `- ${hiddenGroups} additional task group${hiddenGroups === 1 ? "" : "s"} exist beyond this prompt excerpt; use the group counts, repository evidence, and checklist updates to keep the task plan adaptive.`
      : ""
  ]
    .filter((line) => line.trim().length > 0)
    .join("\n");
};

const topGoalKeywords = (context: WorkflowRecommendationContext): string[] =>
  unique(
    [
      ...tokenize(context.workflow.ultimateGoal.summary),
      ...tokenize(context.workflow.ultimateGoal.detailedIntent),
      ...tokenize(context.workflow.approvedRecommendation?.title ?? ""),
      ...tokenize(context.workflow.scopedGoal?.summary ?? "")
    ]
  ).slice(0, 10);

const collectRecentChangedFiles = (agents: AgentState[]): string[] =>
  unique(
    [...agents]
      .sort((left, right) => {
        const leftTime = left.lastActivityAt ? new Date(left.lastActivityAt).getTime() : 0;
        const rightTime = right.lastActivityAt ? new Date(right.lastActivityAt).getTime() : 0;
        return rightTime - leftTime;
      })
      .flatMap((agent) => agent.changedFiles)
  ).slice(0, 8);

const toAreaLabel = (relativePath?: string): string => {
  if (!relativePath) {
    return "the next high-leverage area";
  }

  const normalized = relativePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts.length > 1 ? parts.slice(0, 2).join("/") : normalized;
};

const rankRelevantPaths = (
  context: WorkflowRecommendationContext,
  preferredPaths: string[],
  extraKeywords: string[] = []
): string[] => {
  const keywords = unique([...extraKeywords, ...topGoalKeywords(context)]).slice(0, 16);
  const entryPoints = new Set(context.scan.stats.entryPoints);
  const preferred = new Set(preferredPaths);
  const preferredDirectories = preferredPaths
    .map((entry) => entry.replace(/\\/g, "/").replace(/\/+$/, ""))
    .filter((entry) => entry.includes("/") && !path.extname(entry));

  return context.scan.files
    .map((file) => {
      let score = 0;
      if (preferred.has(file.relativePath)) {
        score += 8;
      }
      if (preferredDirectories.some((directory) => file.relativePath === directory || file.relativePath.startsWith(`${directory}/`))) {
        score += 4;
      }
      if (entryPoints.has(file.relativePath)) {
        score += 3;
      }
      for (const keyword of keywords) {
        if (file.relativePath.toLowerCase().includes(keyword)) {
          score += 3;
        } else if (path.basename(file.relativePath).toLowerCase().includes(keyword)) {
          score += 2;
        }
      }
      if (score > 0 && /\.(test|spec)\./.test(file.relativePath)) {
        score += 1;
      }
      return {
        path: file.relativePath,
        score
      };
    })
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .filter((entry) => entry.score > 0)
    .slice(0, 6)
    .map((entry) => entry.path);
};

export interface OutcomeStrategyBriefOptions {
  maxOpenChecks?: number;
  maxBlockers?: number;
  maxConstraints?: number;
  maxNonGoals?: number;
  maxFocusPaths?: number;
}

const formatOutcomeBriefList = (values: string[], maxItems: number, emptyLabel: string): string =>
  values.length
    ? values.slice(0, maxItems).map((entry) => truncate(normalizeSpace(entry), 150)).join("; ")
    : emptyLabel;

const goalCheckBriefLine = (check: GoalAttainmentCheck): string =>
  `${check.title}${check.evidence ? ` (${truncate(normalizeSpace(check.evidence), 96)})` : ""}`;

export const buildOutcomeStrategyBrief = (
  context: WorkflowRecommendationContext,
  options: OutcomeStrategyBriefOptions = {}
): string => {
  const maxOpenChecks = options.maxOpenChecks ?? 5;
  const maxBlockers = options.maxBlockers ?? 4;
  const maxConstraints = options.maxConstraints ?? 4;
  const maxNonGoals = options.maxNonGoals ?? 3;
  const maxFocusPaths = options.maxFocusPaths ?? 5;
  const checklist = buildGoalChecklistForAssessment(context);
  const checklistProgress = summarizeChecklistProgress(checklist);
  const openChecks = rankGoalChecksByCompletionImpact(checklistProgress.unmet).slice(0, maxOpenChecks);
  const batchingOpportunity = buildGoalCheckBatches(context, rankGoalChecksByCompletionImpact(checklistProgress.unmet))[0];
  const openIssues = context.workflow.memory.knownOpenIssues
    .filter((issue) => issue.status === "open")
    .map((issue) => `${issue.title}: ${issue.detail}`);
  const pendingInterventions = context.workflow.humanInterventions
    .filter((intervention) => intervention.status === "pending")
    .map((intervention) => `${intervention.title}: ${intervention.description}`);
  const blockers = [...pendingInterventions, ...openIssues];
  const recentChangedFiles = collectRecentChangedFiles(context.agents);
  const focusPaths = rankRelevantPaths(
    context,
    recentChangedFiles,
    openChecks.flatMap((check) => tokenize(`${check.title} ${check.description}`))
  ).slice(0, maxFocusPaths);
  const primaryMove = pendingInterventions.length > 0
    ? "Resolve the pending human intervention before asking agents to guess."
      : openIssues.length > 0
        ? "Resolve the highest-severity open workflow issue before starting unrelated improvements."
      : batchingOpportunity
        ? "Satisfy the highest-impact coherent batch of related goal checks with direct repository evidence."
        : openChecks.length > 0
          ? "Satisfy the highest-impact open goal check with direct repository evidence."
        : context.objective === "optimize"
          ? "The base goal is complete; choose the next bounded improvement with the best quality payoff."
          : "No required goal check is currently open; stop new deliver-mode cycles unless a final appeal pass is queued.";

  return [
    "Outcome strategy:",
    `- Ultimate target: ${context.workflow.ultimateGoal.summary || "No confirmed summary is available."}`,
    `- Completion source of truth: ${checklistProgress.met.length}/${checklistProgress.required.length} required goal checks met (${checklistProgress.percentComplete}%).`,
    `- Primary next move: ${primaryMove}`,
    openChecks.length
      ? `- Highest-impact open checks: ${formatOutcomeBriefList(openChecks.map(goalCheckBriefLine), maxOpenChecks, "none")}.`
      : "- Highest-impact open checks: none.",
    batchingOpportunity
      ? `- Efficient batching opportunity: ${batchingOpportunity.label}: ${formatOutcomeBriefList(batchingOpportunity.checks.map(goalCheckBriefLine), Math.min(4, batchingOpportunity.checks.length), "none")}.`
      : "",
    blockers.length
      ? `- Current blockers: ${formatOutcomeBriefList(blockers, maxBlockers, "none")}.`
      : "- Current blockers: none.",
    context.workflow.ultimateGoal.qualityBar.trim()
      ? `- Quality bar: ${truncate(normalizeSpace(context.workflow.ultimateGoal.qualityBar), 220)}`
      : "",
    context.workflow.ultimateGoal.constraints.length
      ? `- Preserve constraints: ${formatOutcomeBriefList(context.workflow.ultimateGoal.constraints, maxConstraints, "none")}.`
      : "",
    context.workflow.ultimateGoal.nonGoals.length
      ? `- Avoid non-goals: ${formatOutcomeBriefList(context.workflow.ultimateGoal.nonGoals, maxNonGoals, "none")}.`
      : "",
    focusPaths.length
      ? `- Likely focus paths: ${focusPaths.join(", ")}.`
      : ""
  ]
    .filter((line) => line.trim().length > 0)
    .join("\n");
};

const pushDraft = (drafts: RecommendationDraft[], next: RecommendationDraft): void => {
  if (!next.title.trim() || drafts.some((draft) => draft.key === next.key || draft.title === next.title)) {
    return;
  }
  drafts.push(next);
};

const normalizeCustomFocus = (value?: string): string | undefined => {
  const normalized = value?.trim().replace(/\s+/g, " ").replace(/[.?!]+$/, "");
  return normalized ? truncate(normalized, 72) : undefined;
};

export const estimateUltimateGoalProgress = (
  context: WorkflowRecommendationContext
): Pick<UltimateGoalProgressEstimate, "percentComplete" | "rationale"> => {
  const checklist = buildGoalChecklistForAssessment(context);
  const checklistProgress = summarizeChecklistProgress(checklist);
  const acceptedDecisions = context.workflow.memory.lastAcceptedDecisions.length;
  const openIssues = context.workflow.memory.knownOpenIssues.filter((issue) => issue.status === "open");
  const pendingInterventions = context.workflow.humanInterventions.filter((intervention) => intervention.status === "pending");
  const unmetPreview = rankGoalChecksByCompletionImpact(checklistProgress.unmet).slice(0, 4).map((check) => check.title);
  const rationale = [
    checklistProgress.required.length > 0
      ? `${checklistProgress.met.length} of ${checklistProgress.required.length} required goal checks are met.`
      : "No required goal checks have been established yet.",
    unmetPreview.length > 0
      ? `Still open: ${unmetPreview.join("; ")}${checklistProgress.unmet.length > unmetPreview.length ? "; ..." : ""}.`
      : "All required goal checks are currently marked met.",
    openIssues.length > 0
      ? `${openIssues.length} open workflow issue${openIssues.length === 1 ? "" : "s"} still blocks completion.`
      : "No open workflow issues are currently recorded.",
    pendingInterventions.length > 0
      ? `${pendingInterventions.length} pending human intervention${pendingInterventions.length === 1 ? "" : "s"} still blocks completion.`
      : "No pending human intervention is recorded.",
    acceptedDecisions > 0
      ? `${acceptedDecisions} accepted workflow decision${acceptedDecisions === 1 ? "" : "s"} are retained as history, but checklist status is the completion source of truth.`
      : "Accepted workflow decisions are history only; they do not count as completed goal checks by themselves."
  ].join(" ");

  return {
    percentComplete: checklistProgress.percentComplete,
    rationale
  };
};

export const assessUltimateGoalCompletion = (
  context: WorkflowRecommendationContext,
  progress = estimateUltimateGoalProgress(context)
): {
  state: UltimateGoalCompletionState;
  rationale: string;
} => {
  const checklist = buildGoalChecklistForAssessment(context);
  const checklistProgress = summarizeChecklistProgress(checklist);
  const openIssues = context.workflow.memory.knownOpenIssues.filter((issue) => issue.status === "open");
  const pendingInterventions = context.workflow.humanInterventions.filter((intervention) => intervention.status === "pending");
  const latestCycleComplete = context.workflow.workflowCycle.status === "completed" || context.workflow.workflowCycle.status === "merged";

  if (!latestCycleComplete) {
    return {
      state: "needs_more_work",
      rationale: "The current cycle has not finished yet, so the workflow should not declare the Ultimate Goal satisfied."
    };
  }

  if (pendingInterventions.length > 0) {
    return {
      state: "needs_more_work",
      rationale: "There is still a pending blocker, so the workflow cannot treat the Ultimate Goal as complete."
    };
  }

  if (openIssues.length > 0) {
    return {
      state: "needs_more_work",
      rationale: `${openIssues.length} open workflow issue${openIssues.length === 1 ? "" : "s"} still need attention before the Ultimate Goal can be treated as complete.`
    };
  }

  if (checklistProgress.required.length === 0) {
    return {
      state: "needs_more_work",
      rationale: "No required goal checks exist yet, so the workflow cannot prove the Ultimate Goal is complete."
    };
  }

  if (checklistProgress.unmet.length > 0 || progress.percentComplete < 100) {
    const preview = checklistProgress.unmet.slice(0, 4).map((check) => check.title).join("; ");
    return {
      state: "needs_more_work",
      rationale: `${checklistProgress.unmet.length} required goal check${checklistProgress.unmet.length === 1 ? "" : "s"} still need evidence before completion: ${preview}.`
    };
  }

  return {
    state: "goal_satisfied",
    rationale: `All ${checklistProgress.required.length} required goal checks are marked met, the latest cycle is complete, and there are no recorded blockers or open issues.`
  };
};

const rankedUnmetRequiredGoalChecks = (context: WorkflowRecommendationContext): GoalAttainmentCheck[] => {
  const checklist = buildGoalChecklistForAssessment(context);
  return rankGoalChecksByCompletionImpact(
    checklist.filter((check) => isRequiredForCompletion(check) && !isMetForCompletion(check))
  );
};

const goalCheckRecommendationSummary = (check: GoalAttainmentCheck): string => {
  return check.status === "unknown"
    ? "Gather direct implementation and validation evidence for this required check."
    : "Fix this required check and update the goal checklist with direct evidence.";
};

const goalCheckRecommendationRationale = (check: GoalAttainmentCheck): string => {
  if (check.evidence) {
    return `The goal checklist blocks completion here. Current evidence: ${check.evidence}`;
  }

  return "The workflow cannot declare the Ultimate Goal complete until every required checklist item is backed by evidence.";
};

const visualDependencyNames = new Set([
  "@vitejs/plugin-react",
  "electron",
  "next",
  "react",
  "react-dom",
  "svelte",
  "vite",
  "vue"
]);

export const isVisualProject = (context: WorkflowRecommendationContext): boolean =>
  context.scan.dependencies.some((dependency) => visualDependencyNames.has(dependency.name)) ||
  context.scan.files.some((file) =>
    /(^|\/)(app|renderer|components|pages|views)(\/|$)/.test(file.relativePath) ||
    /\.(css|scss|sass|less|html|tsx|jsx|vue|svelte)$/.test(file.relativePath)
  );

export const buildAppealRecommendations = (context: WorkflowRecommendationContext): WorkflowRecommendationOption[] => {
  const modeConfig = getWorkflowModeConfig(context.workflow.workflowMode, resolveEffectiveAutopilotPolicy(context.workflow));
  if (!modeConfig.finalAppealEnabled) {
    return [];
  }
  if (!isVisualProject(context)) {
    return [];
  }

  const recentChangedFiles = collectRecentChangedFiles(context.agents);
  const relevantPaths = rankRelevantPaths(context, recentChangedFiles);
  const focusArea = toAreaLabel(
    relevantPaths[0] ??
    recentChangedFiles[0] ??
    context.scan.files.find((file) => /\.(css|scss|sass|less|html|tsx|jsx|vue|svelte)$/.test(file.relativePath))?.relativePath ??
    context.scan.stats.entryPoints[0]
  );
  const drafts: RecommendationDraft[] = [];

  pushDraft(drafts, {
    key: `appeal:visual:${focusArea}`,
    score: 120,
    title: `Polish the visible experience in ${focusArea}`,
    summary: "Run one final bounded pass focused on visual hierarchy, spacing, interaction clarity, and presentation quality.",
    rationale: "The base Ultimate Goal appears satisfied, so the next best deliver-mode step is an appeal pass that makes the app or site feel more intentional before stopping.",
    expectedImpact: "The finished project should look and feel more credible to users, friends, and collaborators without turning into a broad redesign.",
    priority: "high",
    confidence: 0.94,
    estimatedScope: "small",
    riskLevel: "low",
    relatedPaths: relevantPaths.slice(0, 4)
  });

  pushDraft(drafts, {
    key: `appeal:ux:${focusArea}`,
    score: 112,
    title: `Improve final user-facing clarity in ${focusArea}`,
    summary: "Tighten labels, empty states, feedback, responsive behavior, or affordances in one user-visible area.",
    rationale: "A completed visual product benefits from one final usability sweep that makes the experience easier to understand at first glance.",
    expectedImpact: "Users should be able to read the state of the app faster and make the next action with less hesitation.",
    priority: "high",
    confidence: 0.9,
    estimatedScope: "small",
    riskLevel: "low",
    relatedPaths: relevantPaths.slice(0, 4)
  });

  pushDraft(drafts, {
    key: `appeal:responsive:${focusArea}`,
    score: 106,
    title: `Tighten responsive polish in ${focusArea}`,
    summary: "Use the final pass to reduce layout rough edges across common desktop and mobile widths.",
    rationale: "Visual work is only persuasive if it holds up across normal viewports, especially for apps and websites shared with collaborators.",
    expectedImpact: "The result should feel more robust when opened on different screens without widening the implementation scope.",
    priority: "medium",
    confidence: 0.84,
    estimatedScope: "small",
    riskLevel: "medium",
    relatedPaths: relevantPaths.slice(0, 4)
  });

  return drafts
    .sort((left, right) => right.score - left.score || right.confidence - left.confidence || left.title.localeCompare(right.title))
    .map((draft, index) => ({
      id: nanoid(),
      rank: index + 1,
      title: draft.title,
      summary: draft.summary,
      rationale: draft.rationale,
      expectedImpact: draft.expectedImpact,
      priority: draft.priority,
      confidence: draft.confidence,
      estimatedScope: draft.estimatedScope,
      riskLevel: draft.riskLevel,
      relatedPaths: draft.relatedPaths,
      sourceWorkPackageId: draft.sourceWorkPackageId,
      targetedCheckIds: draft.targetedCheckIds
    }))
    .map((entry) => sanitizeRecommendationForCycle(entry, { breadthLimit: modeConfig.breadthLimit }))
    .filter((entry): entry is WorkflowRecommendationOption => Boolean(entry))
    .slice(0, Math.max(1, Math.min(context.maxOptions, 3)))
    .map((entry, index) => ({
      ...entry,
      rank: index + 1
    }));
};

export const buildWorkflowRecommendations = (context: WorkflowRecommendationContext): WorkflowRecommendationOption[] => {
  const modeConfig = getWorkflowModeConfig(context.workflow.workflowMode, resolveEffectiveAutopilotPolicy(context.workflow));
  const recentChangedFiles = collectRecentChangedFiles(context.agents);
  const openIssues = context.workflow.memory.knownOpenIssues.filter((issue) => issue.status === "open");
  const pendingInterventions = context.workflow.humanInterventions.filter((intervention) => intervention.status === "pending");
  const relevantPaths = rankRelevantPaths(context, recentChangedFiles);
  const focusArea = toAreaLabel(relevantPaths[0] ?? recentChangedFiles[0] ?? context.scan.stats.entryPoints[0]);
  const latestCycleSummary = context.workflow.memory.perCycleSummaries[0];
  const lastDecision = context.workflow.memory.lastAcceptedDecisions[0];
  const customFocus = normalizeCustomFocus(context.customFocus);
  const unmetGoalChecks = rankedUnmetRequiredGoalChecks(context);
  const checklistWorkPackages = buildChecklistWorkPackages(context, {
    maxChecksPerPackage: modeConfig.maxChecksPerPackage
  })
    .filter((workPackage) =>
      workPackage.checkIds.length > 1 &&
      (modeConfig.mode === "fast" || workPackage.estimatedBreadth !== "large" || workPackage.riskLevel === "high")
    )
    .sort((left, right) =>
      (left.riskLevel === "high" && !/security|credential|approval|runtime|integrity|validation|brokerage|safety/i.test(left.primaryTopic) ? 1 : 0) -
      (right.riskLevel === "high" && !/security|credential|approval|runtime|integrity|validation|brokerage|safety/i.test(right.primaryTopic) ? 1 : 0) ||
      right.score - left.score ||
      right.checkIds.length - left.checkIds.length ||
      left.title.localeCompare(right.title)
    );
  const packagedCheckIds = new Set(checklistWorkPackages.flatMap((workPackage) => workPackage.checkIds));
  const drafts: RecommendationDraft[] = [];
  const previewRequest = getWorkflowPreviewRequest(context.workflow);
  const previewMode = previewRequest.status === "queued" || previewRequest.status === "active";

  if (previewMode) {
    const previewPathHints = unique([
      ...context.scan.files
        .filter((file) =>
          /\b(?:app|page|route|screen|workflow|dashboard|index|main)\b/i.test(file.relativePath) &&
          /\.(tsx?|jsx?|svelte|vue|html|css)$/i.test(file.relativePath)
        )
        .map((file) => file.relativePath),
      ...context.scan.stats.entryPoints,
      ...relevantPaths
    ]).slice(0, 5);
    pushDraft(drafts, {
      key: `preview:${previewRequest.requestedAt ?? context.workflow.workflowCycle.cycleNumber}`,
      score: 260,
      title: "Generate runnable preview checkpoint",
      summary: "Make the current product structure visible and locally inspectable without presenting it as final completion.",
      rationale: "The operator requested a preview checkpoint, so the next bounded cycle should expose the UI shell, routes, empty/demo states, and integration boundaries before normal workflow resumes.",
      expectedImpact: "The project can be inspected in its current state while preserving honest missing-credential, offline/demo, loading, and incomplete-state labels.",
      priority: "high",
      confidence: 0.96,
      estimatedScope: "small",
      riskLevel: "low",
      relatedPaths: previewPathHints
    });
  }

  if (customFocus) {
    pushDraft(drafts, {
      key: `custom:implement:${customFocus}`,
      score: 132,
      title: `Implement a bounded slice of ${customFocus}`,
      summary: "Turn the operator's custom direction into one concrete repo change that can complete in a single cycle.",
      rationale: "The operator explicitly asked for this direction, so the recommendation set should stay anchored to it instead of drifting into unrelated repo work.",
      expectedImpact: "This makes the next cycle immediately useful because the workflow explores the requested idea directly.",
      priority: "high",
      confidence: 0.97,
      estimatedScope: "small",
      riskLevel: "low",
      relatedPaths: relevantPaths.slice(0, 4)
    });
    pushDraft(drafts, {
      key: `custom:validate:${customFocus}`,
      score: 128,
      title: `Validate the repo impact of ${customFocus}`,
      summary: "Pair the custom direction with a tightly scoped verification step so the resulting change is easy to review.",
      rationale: "Closely related recommendations should help the user compare implementation versus validation-oriented variants of the same idea.",
      expectedImpact: "This reduces churn by making the custom direction easier for integrity to confirm in the same cycle.",
      priority: "high",
      confidence: 0.91,
      estimatedScope: "small",
      riskLevel: "low",
      relatedPaths: relevantPaths.slice(0, 4)
    });
    pushDraft(drafts, {
      key: `custom:refine:${customFocus}`,
      score: 124,
      title: `Tighten the edges around ${customFocus}`,
      summary: "Generate a near-neighbor follow-up task that stays strongly related to the custom direction while remaining cycle-sized.",
      rationale: "The operator asked for related options, so the recommendation set should include a refinement path rather than only one literal restatement.",
      expectedImpact: "This gives the workflow a small cluster of reworded, closely related next steps to choose from.",
      priority: "medium",
      confidence: 0.87,
      estimatedScope: "small",
      riskLevel: "low",
      relatedPaths: relevantPaths.slice(0, 3)
    });
  }

  if (pendingInterventions.length > 0) {
    const intervention = pendingInterventions[0];
    pushDraft(drafts, {
      key: `intervention:${intervention.id}`,
      score: 150,
      title: `Unblock ${intervention.title}`,
      summary: intervention.description,
      rationale: "The workflow cannot continue safely until the required human step is resolved.",
      expectedImpact: "This clears the current blocker and lets the next automated cycle continue without guessing.",
      priority: "high",
      confidence: 0.98,
      estimatedScope: "small",
      riskLevel: intervention.severity === "critical" ? "high" : intervention.severity === "high" ? "medium" : "low",
      relatedPaths: relevantPaths.slice(0, 3)
    });
  }

  if (openIssues.length > 0) {
    const issue = openIssues[0];
    pushDraft(drafts, {
      key: `issue:${issue.id}`,
      score: 140,
      title: `Resolve ${issue.title}`,
      summary: issue.detail,
      rationale: "This issue is still open in workflow memory, so fixing it would burn down explicit project debt instead of starting a fresh thread.",
      expectedImpact: "It removes a known source of churn and improves the odds that the next validation pass will stay green.",
      priority: issue.source === "integrity" || issue.source === "merge" ? "high" : "medium",
      confidence: issue.source === "integrity" || issue.source === "merge" ? 0.93 : 0.86,
      estimatedScope: "small",
      riskLevel: issue.source === "merge" ? "high" : "medium",
      relatedPaths: relevantPaths.slice(0, 4)
    });
  }

  for (const [index, workPackage] of checklistWorkPackages.entries()) {
    const packageChecks = workPackage.checkIds
      .map((checkId) => unmetGoalChecks.find((check) => check.id === checkId))
      .filter((check): check is GoalAttainmentCheck => Boolean(check));
    const representativeChecks = packageChecks.slice(0, 3).map((check) => check.title).join("; ");
    const safetyCritical = /security|credential|approval|runtime|integrity|validation|brokerage|safety/i.test(workPackage.primaryTopic);
    pushDraft(drafts, {
      key: `work-package:${workPackage.checkIds.slice().sort().join("|")}`,
      score: 150 +
        Math.round(workPackage.score / (modeConfig.mode === "fast" ? 10 : 18)) +
        (modeConfig.mode === "fast" ? workPackage.checkIds.length * 24 : 0) -
        index * 5 -
        (workPackage.riskLevel === "high" && !safetyCritical ? 28 : 0),
      title: `Satisfy work package: ${truncate(workPackage.primaryTopic, 72)}`,
      summary: `Use this coherent work package to close ${workPackage.checkIds.length} related required checks.`,
      rationale: `${workPackage.reason} Representative checks: ${truncate(representativeChecks, 150)}.`,
      expectedImpact: "This moves the Ultimate Goal percentage by producing shared repository evidence for multiple required checks.",
      priority: "high",
      confidence: Math.max(0.55, workPackage.confidence - index * 0.03),
      estimatedScope: workPackage.estimatedBreadth === "small" ? "small" : "medium",
      riskLevel: workPackage.riskLevel,
      relatedPaths: workPackage.likelyPaths,
      sourceWorkPackageId: workPackage.id,
      targetedCheckIds: workPackage.checkIds
    });
  }

  const singleGoalChecks = unmetGoalChecks.filter((check) => !packagedCheckIds.has(check.id));
  for (const [index, unmetGoalCheck] of singleGoalChecks.slice(0, 3).entries()) {
    const goalCheckKeywords = tokenize(`${unmetGoalCheck.title} ${unmetGoalCheck.description}`);
    const checkRelevantPaths = rankRelevantPaths(
      context,
      unmetGoalCheck.relatedPaths,
      goalCheckKeywords
    );
    pushDraft(drafts, {
      key: `goal-check:${unmetGoalCheck.id}`,
      score: 118 - index * 4,
      title: `Satisfy goal check: ${truncate(unmetGoalCheck.title, 72)}`,
      summary: goalCheckRecommendationSummary(unmetGoalCheck),
      rationale: goalCheckRecommendationRationale(unmetGoalCheck),
      expectedImpact: "This moves the Ultimate Goal percentage by converting an explicit required check into evidenced completion.",
      priority: "high",
      confidence: unmetGoalCheck.status === "unmet" ? 0.96 : 0.93,
      estimatedScope: "small",
      riskLevel: unmetGoalCheck.status === "unmet" ? "medium" : "low",
      relatedPaths: checkRelevantPaths.slice(0, 4)
    });
  }

  if (recentChangedFiles.length > 0) {
    const explicitChecklistWorkAvailable = unmetGoalChecks.length > 0 && pendingInterventions.length === 0 && openIssues.length === 0;
    pushDraft(drafts, {
      key: `changes:${recentChangedFiles.slice(0, 3).join(",")}`,
      score: explicitChecklistWorkAvailable ? Math.max(10, 88 - modeConfig.genericStabilizationPenalty) : 88,
      title: `Stabilize recent work in ${focusArea}`,
      summary: `Review the latest agent changes and close the loop around ${recentChangedFiles.slice(0, 3).join(", ")}.`,
      rationale: explicitChecklistWorkAvailable
        ? "Recent changes are worth validating, but explicit unmet required goal checks should stay ahead of generic stabilization while there is no open blocker."
        : "The repository already has fresh changes, so the highest-leverage next step is usually to validate and tighten what is already in motion.",
      expectedImpact: explicitChecklistWorkAvailable
        ? "This is a fallback safety task; it should not displace checklist-completion work that can move the Ultimate Goal percentage."
        : "This converts partial progress into durable progress instead of letting recent work sprawl across multiple cycles.",
      priority: explicitChecklistWorkAvailable ? "low" : "high",
      confidence: explicitChecklistWorkAvailable ? (modeConfig.mode === "fast" ? 0.52 : 0.68) : 0.9,
      estimatedScope: "small",
      riskLevel: "medium",
      relatedPaths: recentChangedFiles.slice(0, 4)
    });
  }

  if (!context.scan.stats.testsPresent || openIssues.some((issue) => issue.source === "integrity")) {
    pushDraft(drafts, {
      key: `tests:${focusArea}`,
      score: 82,
      title: `Add regression coverage around ${focusArea}`,
      summary: context.scan.stats.testsPresent
        ? "Strengthen the tests around the areas that just failed validation."
        : "Introduce targeted regression coverage before the project accumulates more unchecked behavior.",
      rationale: context.scan.stats.testsPresent
        ? "Recent integrity failures suggest the current safety net is too thin around the active area."
        : "The repository currently lacks obvious test coverage, so each automated cycle is taking on extra risk.",
      expectedImpact: "Better coverage reduces repair churn and makes recommendation quality stronger because the repo has clearer feedback loops.",
      priority: context.scan.stats.testsPresent ? "medium" : "high",
      confidence: context.scan.stats.testsPresent ? 0.82 : 0.89,
      estimatedScope: "small",
      riskLevel: context.scan.stats.testsPresent ? "medium" : "high",
      relatedPaths: relevantPaths.slice(0, 4)
    });
  }

  if (context.objective === "optimize") {
    if (isVisualProject(context)) {
      pushDraft(drafts, {
        key: `optimize:ui:${focusArea}`,
        score: 108,
        title: `Polish the visible interface in ${focusArea}`,
        summary: "Improve usability, clarity, and visual fit-and-finish in one bounded pass without turning the task into a redesign.",
        rationale: "Optimize mode should keep looking for improvements after the core product works, and UI polish is often one of the highest-leverage follow-ups in an interface-heavy project.",
        expectedImpact: "The project feels more intentional and easier to use without widening the cycle beyond one reviewable change.",
        priority: "high",
        confidence: 0.91,
        estimatedScope: "small",
        riskLevel: "low",
        relatedPaths: relevantPaths.slice(0, 4)
      });
    }

    pushDraft(drafts, {
      key: `optimize:reliability:${focusArea}`,
      score: 104,
      title: `Harden edge cases and bug-prone paths in ${focusArea}`,
      summary: "Use the next cycle to tighten correctness, reduce obvious failure modes, and improve regression resistance.",
      rationale: "Optimization should include bug recognition and reliability work, not just visible features.",
      expectedImpact: "This lowers the chance that the project regresses once more improvements start landing.",
      priority: "high",
      confidence: 0.89,
      estimatedScope: "small",
      riskLevel: "medium",
      relatedPaths: relevantPaths.slice(0, 4)
    });

    pushDraft(drafts, {
      key: `optimize:efficiency:${focusArea}`,
      score: 100,
      title: `Trim avoidable work and resource use in ${focusArea}`,
      summary: "Look for one concrete optimization to runtime cost, unnecessary rendering, redundant computation, or excess file/system work.",
      rationale: "Optimize mode should actively search for computational and resource improvements when they can be made in one bounded cycle.",
      expectedImpact: "This improves responsiveness or efficiency without forcing a broad refactor.",
      priority: "medium",
      confidence: 0.84,
      estimatedScope: "small",
      riskLevel: "medium",
      relatedPaths: relevantPaths.slice(0, 4)
    });
  }

  pushDraft(drafts, {
    key: `goal:${focusArea}`,
    score: 78,
    title: `Ship one bounded slice in ${focusArea}`,
    summary: context.workflow.ultimateGoal.summary
      ? `Deliver one small, reviewable slice in ${focusArea} so the repo moves closer to: ${context.workflow.ultimateGoal.summary}`
      : `Pick a bounded slice in ${focusArea} and turn it into the next implementation pass.`,
    rationale: lastDecision?.title
      ? `The latest accepted decision was "${lastDecision.title}", so the next recommendation should build on that momentum instead of resetting context.`
      : "The repository scan points to this area as one of the most relevant places to keep making visible progress.",
    expectedImpact: "This gives the next cycle a concrete focus area that is grounded in the repo, not just the charter text.",
    priority: "medium",
    confidence: 0.8,
    estimatedScope: "small",
    riskLevel: "medium",
    relatedPaths: relevantPaths.slice(0, 4)
  });

  pushDraft(drafts, {
    key: `ops:${focusArea}`,
    score: 70,
    title: `Tighten operator feedback in ${focusArea}`,
    summary: context.overview?.importantToKnowFirst
      ? `Use the current repository understanding to make the next cycle easier to observe and reason about.`
      : `Improve the repo's feedback surface so future cycles reveal intent, risk, and progress more clearly.`,
    rationale: latestCycleSummary?.summary
      ? `The last completed cycle was "${latestCycleSummary.summary}", so this is a good point to preserve what was learned and reduce repeat confusion.`
      : "Workflow memory is most useful when the repo keeps reflecting what just changed and why it mattered.",
    expectedImpact: "This raises recommendation quality over time because the system and the user both get a clearer view of the repo's state.",
    priority: "low",
    confidence: 0.73,
    estimatedScope: "small",
    riskLevel: "low",
    relatedPaths: relevantPaths.slice(0, 3)
  });

  return drafts
    .sort((left, right) => right.score - left.score || right.confidence - left.confidence || left.title.localeCompare(right.title))
    .map((draft, index) => ({
      id: nanoid(),
      rank: index + 1,
      title: draft.title,
      summary: draft.summary,
      rationale: draft.rationale,
      expectedImpact: draft.expectedImpact,
      priority: draft.priority,
      confidence: draft.confidence,
      estimatedScope: draft.estimatedScope,
      riskLevel: draft.riskLevel,
      relatedPaths: draft.relatedPaths,
      sourceWorkPackageId: draft.sourceWorkPackageId,
      targetedCheckIds: draft.targetedCheckIds
    }))
    .map((entry) => sanitizeRecommendationForCycle(entry, { breadthLimit: modeConfig.breadthLimit }))
    .filter((entry): entry is WorkflowRecommendationOption => Boolean(entry))
    .slice(0, Math.max(1, Math.min(context.maxOptions, 5)))
    .map((entry, index) => ({
      ...entry,
      rank: index + 1
    }));
};
