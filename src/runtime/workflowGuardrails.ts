import type { IntegrityReport, ScopedGoal, WorkflowRecommendationOption } from "@shared/types";

export type IntegrityFailureKind = "repairable" | "environment_blocker" | "scope_mismatch" | "repeated_failure";

export interface IntegrityFailureAssessment {
  kind: IntegrityFailureKind;
  signature: string;
  shouldRetry: boolean;
  latestFailureReason: string;
  retryableRisks: string[];
}

const ENVIRONMENT_BLOCKER_PATTERNS = [
  /\bcommand not found\b/i,
  /\bis not recognized as an internal or external command\b/i,
  /\bexecutable file not found\b/i,
  /\b(?:npm|pnpm|yarn|bun|node|tsc|eslint|vitest|vite|jest|tsx)\b: not found\b/i,
  /\bnode_modules\b.*\bmissing\b/i,
  /\bmissing dependencies?\b/i,
  /\binstall dependencies?\b/i,
  /\bpackage manager\b.*\bmissing\b/i,
  /\bpermission denied\b/i,
  /\bread-only file system\b/i,
  /\b(?:eacces|eperm|erofs|enospc)\b/i,
  /\bgetaddrinfo\b.*\b(?:enotfound|eai_again)\b/i,
  /\bnetwork is unreachable\b/i,
  /\bunable to resolve host\b/i,
  /\bconnection (?:timed out|refused|reset)\b/i,
  /\bself-signed certificate\b/i,
  /\bcertificate\b.*\b(?:expired|invalid|verify failed)\b/i
];

const SCOPE_MISMATCH_PATTERNS = [
  /\bultimate goal\b.*\bnot met\b/i,
  /\bphase\s*\d+\b.*\bnot (?:met|implemented|complete)\b/i,
  /\bno scoped goal was defined\b/i,
  /\bscoped goal\b.*\bnot defined\b/i,
  /\bultimate goal is not confirmed\b/i,
  /\brepo is far short\b/i,
  /\bnot implemented yet\b/i,
  /\bfar short of\b/i,
  /\bmissing\b.*\b(?:sqlite|watchlists|charting|offline behavior|csv import|persistence)\b/i
];

const GENERIC_INTEGRITY_RISK_PATTERNS = [
  /^\s*Investigate failing command:/i,
  /^\s*Get .+ passing again\./i
];

const TOOLING_DEPENDENCY_PATTERNS = [
  /["'`](?:typescript|ts-node|tsx|eslint|vitest|vite|jest|ts-jest)["'`]/i,
  /["'`]@types\/[a-z0-9._-]+["'`]/i,
  /\bnode_modules\b/i,
  /\b(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)\b/i
];

const RECOMMENDATION_BREADTH_STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "align",
  "around",
  "before",
  "being",
  "bounded",
  "change",
  "changes",
  "close",
  "cycle",
  "deliver",
  "finish",
  "focus",
  "goal",
  "goals",
  "high",
  "impact",
  "implement",
  "improve",
  "into",
  "just",
  "keep",
  "latest",
  "lever",
  "likely",
  "make",
  "moves",
  "next",
  "pass",
  "review",
  "scoped",
  "single",
  "slice",
  "small",
  "step",
  "steps",
  "still",
  "system",
  "targeted",
  "tighten",
  "turn",
  "update",
  "validate",
  "work",
  "workflow"
]);

const normalizeWhitespace = (value: string): string => value.trim().replace(/\s+/g, " ");

const normalizeForSignature = (value: string): string =>
  normalizeWhitespace(value)
    .toLowerCase()
    .replace(/["'`]/g, "")
    .replace(/\bfile:\/\/\/[^\s)]+/g, "file-url")
    .replace(/\b\/[a-z0-9._/-]+\b/g, "path")
    .replace(/\b[a-f0-9]{7,}\b/g, "sha")
    .replace(/\d+/g, "n");

const truncate = (value: string, maxLength: number): string =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength - 1).trimEnd()}…`;

const unique = <T>(values: T[]): T[] => [...new Set(values)];

const toPathArea = (value: string): string => {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  const parts = normalized.split("/").filter((entry) => entry.length > 0);
  if (parts.length === 0) {
    return "";
  }
  if (parts[0] === "src" && parts[1]) {
    return `src/${parts[1]}`;
  }
  return parts.length > 1 ? parts.slice(0, 2).join("/") : parts[0];
};

const countRecommendationAreas = (relatedPaths: string[]): number =>
  unique(relatedPaths.map((entry) => toPathArea(entry)).filter((entry) => entry.length > 0)).length;

const tokenizeRecommendationConcepts = (value: string): string[] =>
  unique(
    (normalizeWhitespace(value).toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) ?? [])
      .filter((token) => token.length >= 4 && !RECOMMENDATION_BREADTH_STOPWORDS.has(token))
  );

const countStructuralClauses = (value: string): number =>
  normalizeWhitespace(value)
    .split(/[,:;()[\]]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0).length;

const estimateRecommendationBreadth = (
  recommendation: Pick<WorkflowRecommendationOption, "title" | "summary" | "estimatedScope" | "relatedPaths">
): number => {
  const title = normalizeWhitespace(recommendation.title);
  const summary = normalizeWhitespace(recommendation.summary);
  const combined = `${title} ${summary}`;
  const areaCount = countRecommendationAreas(recommendation.relatedPaths);
  const conceptCount = tokenizeRecommendationConcepts(combined).length;
  const clauseCount = countStructuralClauses(summary);
  const scopePressure = recommendation.estimatedScope === "large" ? 2.4 : recommendation.estimatedScope === "medium" ? 0.8 : 0;
  const pathPressure = Math.max(0, recommendation.relatedPaths.length - 5) * 0.55;
  const areaPressure = Math.max(0, areaCount - 4) * 0.8;
  const conceptPressure = Math.max(0, conceptCount - 10) * 0.18;
  const clausePressure = Math.max(0, clauseCount - 2) * 0.45;
  const titlePressure = Math.max(0, title.length - 72) / 36;
  const summaryPressure = Math.max(0, summary.length - 150) / 70;

  return scopePressure +
    pathPressure +
    areaPressure +
    conceptPressure +
    clausePressure +
    titlePressure +
    summaryPressure;
};

export const isBoundedRecommendation = (
  recommendation: Pick<WorkflowRecommendationOption, "title" | "summary" | "estimatedScope" | "relatedPaths">
): boolean => estimateRecommendationBreadth(recommendation) < 2;

export const sanitizeRecommendationForCycle = (
  recommendation: WorkflowRecommendationOption
): WorkflowRecommendationOption | undefined => {
  const normalized: WorkflowRecommendationOption = {
    ...recommendation,
    title: normalizeWhitespace(truncate(recommendation.title, 96)),
    summary: normalizeWhitespace(truncate(recommendation.summary, 220)),
    rationale: normalizeWhitespace(truncate(recommendation.rationale, 280)),
    expectedImpact: normalizeWhitespace(truncate(recommendation.expectedImpact, 220)),
    estimatedScope: recommendation.estimatedScope,
    relatedPaths: unique(recommendation.relatedPaths.map((entry) => normalizeWhitespace(entry)).filter((entry) => entry.length > 0)).slice(0, 4)
  };

  return isBoundedRecommendation(normalized) ? normalized : undefined;
};

const normalizeScopedList = (values: string[], limit: number): string[] =>
  unique(
    values
      .map((entry) => normalizeWhitespace(entry))
      .filter((entry) => entry.length > 0)
  ).slice(0, limit);

export const sanitizeScopedGoalForSingleAgent = (scopedGoal: ScopedGoal): ScopedGoal => {
  const summary = normalizeWhitespace(truncate(scopedGoal.summary, 110));
  const executionBrief = normalizeWhitespace(scopedGoal.executionBrief)
    ? `${normalizeWhitespace(scopedGoal.executionBrief)}\n\nKeep the work scoped to one coding agent pass. If the recommendation still feels broad, implement the smallest viable slice that advances it cleanly. Do not start unrelated follow-up work.`
    : "Implement the smallest viable slice of the approved recommendation in one coding agent pass. Do not start unrelated follow-up work.";
  const constraints = normalizeScopedList(
    [
      ...scopedGoal.constraints,
      "Keep this work scoped to one coding agent pass.",
      "Do not expand the task into a broader multi-phase workflow."
    ],
    4
  );
  const testStrategy = normalizeScopedList(
    [
      ...scopedGoal.testStrategy,
      "Run only the smallest relevant deterministic checks for this slice before declaring success."
    ],
    3
  );

  return {
    ...scopedGoal,
    summary,
    executionBrief,
    acceptanceCriteria: normalizeScopedList(scopedGoal.acceptanceCriteria, 4),
    constraints,
    testStrategy
  };
};

const isEnvironmentBlocker = (text: string): boolean =>
  ENVIRONMENT_BLOCKER_PATTERNS.some((pattern) => pattern.test(text)) || isMissingDependencyBlocker(text);

const isScopeMismatch = (text: string): boolean =>
  SCOPE_MISMATCH_PATTERNS.some((pattern) => pattern.test(text));

const isGenericIntegrityRisk = (text: string): boolean =>
  GENERIC_INTEGRITY_RISK_PATTERNS.some((pattern) => pattern.test(text));

const extractMissingModuleSpecifier = (text: string): string | undefined =>
  text.match(/\b(?:cannot find module|cannot find package|err_module_not_found)\b(?:[:\s]+)?["'`]([^"'`]+)["'`]/i)?.[1];

const isLikelyProjectModuleSpecifier = (value: string): boolean => {
  const normalized = value.replace(/\\/g, "/");
  return normalized.startsWith(".") ||
    normalized.startsWith("/") ||
    normalized.startsWith("@/") ||
    normalized.startsWith("~/") ||
    normalized.startsWith("src/") ||
    normalized.startsWith("app/") ||
    normalized.startsWith("test/") ||
    normalized.startsWith("tests/");
};

const isMissingDependencyBlocker = (text: string): boolean => {
  if (!/\b(?:cannot find module|cannot find package|err_module_not_found)\b/i.test(text)) {
    return false;
  }

  if (TOOLING_DEPENDENCY_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }

  const specifier = extractMissingModuleSpecifier(text);
  if (!specifier || isLikelyProjectModuleSpecifier(specifier)) {
    return false;
  }

  return !specifier.includes("/");
};

const buildFailedCheckLines = (report: IntegrityReport): string[] =>
  report.checks
    .filter((check) => check.status === "failed")
    .map((check) => `${check.command} ${check.outputSnippet}`.trim());

const buildFailedCheckSignature = (report: IntegrityReport): string =>
  unique(
    report.checks
      .filter((check) => check.status === "failed")
      .map((check) => normalizeForSignature(`${check.command} ${check.outputSnippet}`))
      .filter((entry) => entry.length > 0)
  ).sort().join(" | ");

export const buildIntegrityFailureSignature = (report: IntegrityReport): string => {
  const signatureParts = [
    ...report.risks
      .map((risk) => normalizeWhitespace(risk))
      .filter((risk) => risk.length > 0 && !isGenericIntegrityRisk(risk))
      .map((risk) => normalizeForSignature(risk)),
    ...buildFailedCheckSignature(report).split(" | ")
  ].filter((entry) => entry.length > 0);

  return unique(signatureParts).sort().join(" | ");
};

export const collectRetryableIntegrityRisks = (report: IntegrityReport): string[] => {
  const retryableRisks = report.risks.filter((risk) => {
    const normalized = normalizeWhitespace(risk);
    return normalized.length > 0 && !isEnvironmentBlocker(normalized) && !isScopeMismatch(normalized) && !isGenericIntegrityRisk(normalized);
  });

  if (retryableRisks.length > 0) {
    return retryableRisks.slice(0, 3);
  }

  return report.checks
    .filter((check) => check.status === "failed")
    .slice(0, 2)
    .map((check) => {
      const output = normalizeWhitespace(check.outputSnippet);
      return output ? truncate(`${check.command}: ${output}`, 180) : `Get ${check.command} passing again.`;
    });
};

export const assessIntegrityFailure = (
  report: IntegrityReport,
  previousReports: IntegrityReport[] = []
): IntegrityFailureAssessment => {
  const failureText = normalizeWhitespace(
    [
      report.summary,
      ...report.risks,
      ...buildFailedCheckLines(report)
    ].join(" ")
  );
  const signature = buildIntegrityFailureSignature(report);
  const checkSignature = buildFailedCheckSignature(report);
  const priorSignatures = new Set(previousReports.map((entry) => buildIntegrityFailureSignature(entry)).filter((entry) => entry.length > 0));
  const priorCheckSignatures = new Set(previousReports.map((entry) => buildFailedCheckSignature(entry)).filter((entry) => entry.length > 0));

  if (isEnvironmentBlocker(failureText)) {
    return {
      kind: "environment_blocker",
      signature,
      shouldRetry: false,
      latestFailureReason: "Integrity hit an environment or dependency blocker that a repair coding pass is unlikely to fix. Stop retrying and resolve the validation environment first.",
      retryableRisks: []
    };
  }

  if (isScopeMismatch(failureText)) {
    return {
      kind: "scope_mismatch",
      signature,
      shouldRetry: false,
      latestFailureReason: "Integrity reported a scope mismatch against a larger project milestone, not a repairable single-pass defect. Stop retrying and choose a smaller next step.",
      retryableRisks: []
    };
  }

  if ((signature && priorSignatures.has(signature)) || (checkSignature && priorCheckSignatures.has(checkSignature))) {
    return {
      kind: "repeated_failure",
      signature,
      shouldRetry: true,
      latestFailureReason:
        "The latest repair pass produced the same validation failure as the previous one. Continue repairing, but change strategy explicitly and target the unresolved root cause instead of repeating the same edit pattern.",
      retryableRisks: collectRetryableIntegrityRisks(report)
    };
  }

  return {
    kind: "repairable",
    signature,
    shouldRetry: true,
    latestFailureReason: report.risks[0] ?? "Deterministic validation failed.",
    retryableRisks: collectRetryableIntegrityRisks(report)
  };
};
