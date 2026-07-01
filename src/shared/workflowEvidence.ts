import type {
  CandidateTask,
  ChecklistDelta,
  ChecklistEvidenceNotConsumedReason,
  ChecklistEvidenceObservation,
  ChecklistEvidenceSourceType,
  ChecklistEvidenceStatus,
  CycleContract,
  CycleContractTaskSource,
  GoalAttainmentCheck,
  GoalCheckStatus,
  ProjectEvidenceCommand,
  ProjectWorkflowState,
  RecommendationHealth,
  StructuredRecommendationFailureCategory,
  WorkflowRecommendationOption,
  WorkPackage
} from "./types";
import { nowIso, stableStringify, unique } from "./utils";

export const CYCLE_CONTRACT_SCHEMA_VERSION = 1;
export const CHECKLIST_DELTA_SCHEMA_VERSION = 1;

const GENERIC_WORK_PACKAGE_SUMMARY = /^Use this coherent work package to close \d+ related required checks\.?$/i;
const OBJECTIVE_GENERIC_PATTERN = /^(?:Objective:\s*)?(?:Deliver goal|Use this coherent work package|Gather direct implementation and validation evidence)/i;
const SECRET_PATTERN = /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b|\b(?:ghp|github_pat)_[A-Za-z0-9_]{16,}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi;
const ABSOLUTE_PATH_PATTERN = /\b(?:[A-Za-z]:\\[^\s"'`]+|\/(?:home|Users|mnt|var|tmp|private|Volumes)\/[^\s"'`]+)/g;

const evidenceObjectKeys = new Set([
  "targeted_check_satisfaction",
  "targeted_check_evidence_map",
  "direct_evidence_summary",
  "checklist_semantics",
  "ranking_factor_coverage",
  "recommendation_evidence",
  "validation_flow_evidence",
  "dashboard_surface_evidence",
  "databank_refresh_evidence",
  "status_by_check",
  "all_targeted_checks_satisfied",
  "all_targeted_check_ids_observed",
  "required_check_ids",
  "relevant_paths",
  "review_commands",
  "source_review_cards",
  "provider_profile_evidence",
  "access_policy_evidence_matrix",
  "refresh_evidence",
  "comparison_evidence",
  "search_quality_evidence"
]);

const stableHash = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

const normalizeSpace = (value: string): string => value.trim().replace(/\s+/g, " ");

const truncate = (value: string, maxLength: number): string => {
  const normalized = normalizeSpace(value);
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
};

const uniqueStrings = (values: Array<string | undefined | null>, limit = 40): string[] =>
  unique(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))).slice(0, limit);

const toStringList = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => typeof entry === "string" ? [entry.trim()] : []).filter(Boolean);
  }
  return typeof value === "string" && value.trim() ? [value.trim()] : [];
};

export const redactEvidenceSnippet = (value: string, maxLength = 900): string =>
  truncate(value, maxLength)
    .replace(SECRET_PATTERN, "[redacted-secret]")
    .replace(ABSOLUTE_PATH_PATTERN, "<local-path>");

const percentRequiredMet = (checklist: GoalAttainmentCheck[]): number => {
  const required = checklist.filter((check) => check.required && check.status !== "not_applicable");
  if (required.length === 0) {
    return 0;
  }
  return Math.round((required.filter((check) => check.status === "met").length / required.length) * 100);
};

const checkMap = (checks: GoalAttainmentCheck[]): Map<string, GoalAttainmentCheck> =>
  new Map(checks.map((check) => [check.id, check]));

const latestPlannerDecision = (workflow: ProjectWorkflowState) =>
  workflow.plannerDecisions
    .filter((decision) => decision.cycleNumber === workflow.workflowCycle.cycleNumber)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];

const findPlanCandidate = (
  workflow: ProjectWorkflowState,
  selectedTaskId?: string
): { candidate?: CandidateTask; planId?: string } => {
  if (!selectedTaskId) {
    return {};
  }
  for (const plan of workflow.strategicPlans) {
    const candidate = plan.candidateTasks.find((entry) => entry.id === selectedTaskId);
    if (candidate) {
      return { candidate, planId: plan.id };
    }
  }
  return {};
};

const sameCheckSet = (left: string[], right: string[]): boolean => {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((entry) => rightSet.has(entry));
};

const findWorkPackage = (
  workflow: ProjectWorkflowState,
  options: {
    sourceWorkPackageId?: string;
    targetedCheckIds: string[];
    title?: string;
  }
): WorkPackage | undefined => {
  if (options.sourceWorkPackageId) {
    const byId = workflow.workPackages.find((workPackage) => workPackage.id === options.sourceWorkPackageId);
    if (byId) {
      return byId;
    }
  }
  if (options.targetedCheckIds.length > 0) {
    const byChecks = workflow.workPackages.find((workPackage) => sameCheckSet(workPackage.checkIds, options.targetedCheckIds));
    if (byChecks) {
      return byChecks;
    }
  }
  const topic = options.title?.match(/^Satisfy work package:\s*(.+)$/i)?.[1]?.trim().toLowerCase();
  return topic
    ? workflow.workPackages.find((workPackage) =>
      workPackage.primaryTopic.toLowerCase() === topic ||
      workPackage.title.toLowerCase() === topic
    )
    : undefined;
};

const isGenericObjective = (value: string): boolean =>
  !value.trim() || GENERIC_WORK_PACKAGE_SUMMARY.test(value.trim()) || OBJECTIVE_GENERIC_PATTERN.test(value.trim());

const signalPhraseForCheck = (check: GoalAttainmentCheck): string => {
  const text = `${check.title} ${check.description}`.toLowerCase();
  if (/\branking|ranked|rank\b/.test(text)) {
    return "ranking factors";
  }
  if (/\bvalidation|validate|validator|flow\b/.test(text)) {
    return "validation flows";
  }
  if (/\bdashboard|warning|comparison|compare\b/.test(text)) {
    return "dashboard warnings/comparisons";
  }
  if (/\bdatabank|refresh|change history|history|staleness|freshness\b/.test(text)) {
    return "databank refresh/change history";
  }
  if (/\bprovider|profile|source|provenance|access policy|policy\b/.test(text)) {
    return "source/provider policy evidence";
  }
  if (/\bsearch|quality|result\b/.test(text)) {
    return "search quality evidence";
  }
  return truncate(check.title.toLowerCase(), 80);
};

const buildConcreteObjective = (
  selectedTitle: string,
  selectedSummary: string,
  workPackage: WorkPackage | undefined,
  targetedChecks: GoalAttainmentCheck[]
): string => {
  const topic = workPackage?.primaryTopic || selectedTitle.replace(/^Satisfy work package:\s*/i, "");
  const signals = uniqueStrings(targetedChecks.map(signalPhraseForCheck), 6);
  if (targetedChecks.length > 0 && (workPackage || isGenericObjective(selectedSummary))) {
    return `Prove the ${topic} slice by producing machine-checkable evidence for ${signals.join(", ")}.`;
  }
  if (!isGenericObjective(selectedSummary)) {
    return selectedSummary;
  }
  if (!isGenericObjective(selectedTitle)) {
    return selectedTitle;
  }
  return targetedChecks.length
    ? `Produce direct, machine-checkable evidence for ${signals.join(", ")}.`
    : "Deliver the current cycle with explicit evidence for what changed and how it was validated.";
};

const acceptanceHintForCheck = (check: GoalAttainmentCheck, workPackage?: WorkPackage): string => {
  const title = check.title.toLowerCase();
  return workPackage?.acceptanceHints.find((hint) => hint.toLowerCase().includes(title.slice(0, 28))) ??
    workPackage?.acceptanceHints.find((hint) => hint.toLowerCase().includes(check.id.toLowerCase())) ??
    (check.evidence ? `Replace current evidence: ${check.evidence}` : `Emit direct evidence that names ${check.id} and explains observable behavior.`);
};

const commandLooksRunnable = (value: string): boolean =>
  /\b(?:npm|pnpm|yarn|node|python3?|pytest|unittest|cargo|go test|make|bash|sh|uv|ruff|mypy)\b/.test(value);

const validationCommandsFromScopedGoal = (workflow: ProjectWorkflowState): string[] =>
  uniqueStrings([
    ...(workflow.scopedGoal?.testStrategy ?? []).filter(commandLooksRunnable),
    ...workflow.workflowCycle.acceptanceCriteria.filter(commandLooksRunnable)
  ], 8);

const evidenceCommandsForTargets = (
  commands: ProjectEvidenceCommand[],
  targetIds: string[],
  workPackage?: WorkPackage
): string[] => {
  const targets = new Set(targetIds);
  const groupLabels = new Set([workPackage?.id, workPackage?.primaryTopic, workPackage?.title].filter((entry): entry is string => Boolean(entry)));
  return commands
    .filter((command) =>
      command.safeDefault &&
      !command.requiresCredentials &&
      !command.requiresNetwork &&
      (
        command.mapsToCheckIds.some((checkId) => targets.has(checkId)) ||
        command.mapsToChecklistGroups.some((group) => groupLabels.has(group)) ||
        command.mapsToCheckIds.length === 0 && command.mapsToChecklistGroups.length === 0
      )
    )
    .map((command) => command.command)
    .slice(0, 8);
};

const buildTargetedContractItems = (
  checks: GoalAttainmentCheck[],
  previousById: Map<string, GoalAttainmentCheck>,
  workPackage?: WorkPackage
): CycleContract["targetedChecklistItems"] =>
  checks.map((check) => ({
    checkId: check.id,
    title: check.title,
    fullDescription: check.description,
    required: check.required,
    itemKind: check.itemKind,
    groupId: check.groupId,
    previousStatus: previousById.get(check.id)?.status ?? check.status,
    currentStatus: check.status,
    currentEvidence: check.evidence,
    evidenceHistoryCount: check.evidenceHistory?.length ?? 0,
    whyTargeted: workPackage?.reason || `Selected because this required checklist item is still ${check.status}.`,
    acceptanceHint: acceptanceHintForCheck(check, workPackage),
    relatedPaths: uniqueStrings([...(check.relatedPaths ?? []), ...(workPackage?.likelyPaths ?? [])], 12),
    observableSignalsExpected: uniqueStrings([signalPhraseForCheck(check), check.evidence ? `current evidence: ${check.evidence}` : undefined], 4)
  }));

const fallbackWarnings = (health?: RecommendationHealth, repetitionPenalty = 0): string[] => {
  const warnings: string[] = [];
  if (health?.fallbackUsedForCurrentRecommendation) {
    warnings.push(health.fallbackReason || "Planner fallback used for the current recommendation.");
  }
  if ((health?.consecutiveStructuredFailures ?? 0) >= 2) {
    warnings.push(`${health?.consecutiveStructuredFailures} consecutive structured recommendation failures.`);
  }
  if (repetitionPenalty < 0) {
    warnings.push(`Planner score includes repetition penalty ${repetitionPenalty}.`);
  }
  return warnings;
};

const priorSimilarAttempts = (
  workflow: ProjectWorkflowState,
  targetIds: string[],
  topic: string
): CycleContract["priorSimilarAttempts"] => {
  const targetSet = new Set(targetIds);
  const deltasByCycle = new Map(workflow.checklistDeltas.map((delta) => [delta.cycleNumber, delta]));
  return workflow.cycleRetrospectives
    .filter((entry) => entry.cycleNumber !== workflow.workflowCycle.cycleNumber)
    .filter((entry) => {
      const retrospectiveIds = new Set(entry.cycleContract?.targetedChecklistItems.map((item) => item.checkId) ?? []);
      const overlap = [...targetSet].some((checkId) => retrospectiveIds.has(checkId));
      return overlap || Boolean(topic && entry.triedToDo.toLowerCase().includes(topic.toLowerCase()));
    })
    .sort((left, right) => right.cycleNumber - left.cycleNumber)
    .slice(0, 6)
    .map((entry) => {
      const delta = entry.checklistDelta ?? deltasByCycle.get(entry.cycleNumber);
      const failed = entry.failed.length > 0;
      const moved = Boolean(delta?.didGoalProgressChange || delta?.targetedNewlyMet.length);
      return {
        cycleNumber: entry.cycleNumber,
        attemptedTaskTitle: entry.cycleContract?.selectedTaskTitle ?? entry.triedToDo,
        completedTaskTitle: entry.triedToDo,
        nextRecommendedTaskTitle: entry.nextRecommendedTasks[0],
        filesChanged: entry.changedFiles,
        commandCount: entry.commandsRun.length,
        validationSummary: failed ? entry.failed.slice(0, 2).join("; ") : entry.passed.slice(0, 2).join("; ") || "No validation summary recorded.",
        checklistDeltaSummary: delta?.summaryForHumans ?? entry.goalChecklistChangeRecommendation,
        structuredFallbackUsed: entry.learned.some((item) => /deterministic fallback|structured recommendation output was invalid/i.test(item)),
        outcome: moved ? "checklist_moved" as const : failed ? "failed" as const : delta ? "no_delta" as const : "unknown" as const
      };
    });
};

export const buildCycleContract = (
  workflow: ProjectWorkflowState,
  options: {
    now?: string;
    selectedTaskSource?: CycleContractTaskSource;
    previousChecklist?: GoalAttainmentCheck[];
    evidenceCommands?: ProjectEvidenceCommand[];
  } = {}
): CycleContract => {
  const timestamp = options.now ?? nowIso();
  const decision = latestPlannerDecision(workflow);
  const { candidate, planId } = findPlanCandidate(workflow, decision?.selectedTaskId);
  const approved = workflow.approvedRecommendation;
  const recommendation = approved
    ? workflow.recommendations.find((entry) => entry.id === approved.recommendationId)
    : decision?.selectedRecommendationId
      ? workflow.recommendations.find((entry) => entry.id === decision.selectedRecommendationId)
      : workflow.recommendations[0];
  const targetIds = uniqueStrings([
    ...(candidate?.targetedCheckIds ?? []),
    ...(decision?.targetedChecklistIds ?? []),
    ...(approved?.targetedCheckIds ?? []),
    ...(recommendation?.targetedCheckIds ?? [])
  ], 80);
  const workPackage = findWorkPackage(workflow, {
    sourceWorkPackageId: candidate?.sourceWorkPackageId ?? approved?.sourceWorkPackageId ?? recommendation?.sourceWorkPackageId,
    targetedCheckIds: targetIds,
    title: candidate?.title ?? approved?.title ?? recommendation?.title
  });
  const effectiveTargetIds = targetIds.length ? targetIds : workPackage?.checkIds ?? [];
  const checksById = checkMap(workflow.goalChecklist);
  const previousById = checkMap(options.previousChecklist ?? workflow.goalChecklist);
  const targetedChecks = effectiveTargetIds.map((checkId) => checksById.get(checkId)).filter((check): check is GoalAttainmentCheck => Boolean(check));
  const selectedTaskTitle = candidate?.title ?? approved?.title ?? recommendation?.title ?? workflow.scopedGoal?.summary ?? "Objective: Deliver goal";
  const selectedSummary = candidate?.summary ?? approved?.summary ?? recommendation?.summary ?? workflow.scopedGoal?.executionBrief ?? "";
  const objective = buildConcreteObjective(selectedTaskTitle, selectedSummary, workPackage, targetedChecks);
  const scoreBreakdown = decision?.scoreBreakdown ?? candidate?.scoreBreakdown ?? {};
  const repetitionPenalty = scoreBreakdown.repetition ?? 0;
  const expectedFiles = uniqueStrings([
    ...(candidate?.expectedFiles ?? []),
    ...(decision?.expectedFiles ?? []),
    ...(approved?.relatedPaths ?? []),
    ...(recommendation?.relatedPaths ?? []),
    ...(workPackage?.likelyPaths ?? []),
    ...targetedChecks.flatMap((check) => check.relatedPaths)
  ], 24);
  const expectedValidationCommands = uniqueStrings([
    ...(candidate?.expectedValidationCommands ?? []),
    ...(decision?.expectedValidationCommands ?? []),
    ...validationCommandsFromScopedGoal(workflow)
  ], 12);
  const evidenceCommands = options.evidenceCommands ?? workflow.evidenceCommands ?? [];
  const expectedEvidenceCommands = evidenceCommandsForTargets(evidenceCommands, effectiveTargetIds, workPackage);
  const targetedItems = buildTargetedContractItems(targetedChecks, previousById, workPackage);
  const selectedSource = options.selectedTaskSource ??
    workflow.recommendationHealth.selectedTaskSource ??
    (approved ? "manual" : "derived_from_legacy_state");

  return {
    schemaVersion: CYCLE_CONTRACT_SCHEMA_VERSION,
    cycleNumber: workflow.workflowCycle.cycleNumber,
    createdAt: workflow.cycleContract?.cycleNumber === workflow.workflowCycle.cycleNumber
      ? workflow.cycleContract.createdAt
      : timestamp,
    updatedAt: timestamp,
    selectedTaskId: candidate?.id ?? approved?.recommendationId ?? recommendation?.id,
    selectedTaskTitle,
    selectedTaskKind: candidate?.kind ?? (workPackage ? "work_package" : "custom"),
    selectedTaskSource: selectedSource,
    plainEnglishObjective: objective,
    concreteGoalForThisCycle: objective,
    targetedChecklistItems: targetedItems,
    expectedFilesOrAreas: expectedFiles,
    expectedValidationCommands,
    expectedEvidenceCommands,
    acceptanceCriteria: uniqueStrings([
      ...(workflow.scopedGoal?.acceptanceCriteria ?? []),
      ...(candidate?.expectedChecklistImpact ? [candidate.expectedChecklistImpact] : []),
      ...(workPackage?.acceptanceHints ?? []),
      ...targetedItems.map((item) => item.acceptanceHint)
    ], 12),
    nonGoalsForThisCycle: uniqueStrings([
      ...(workflow.scopedGoal?.constraints ?? []).filter((entry) => /non-goal|do not/i.test(entry)),
      ...workflow.ultimateGoal.nonGoals.map((entry) => `Do not spend this cycle on non-goal: ${entry}`)
    ], 8),
    constraintsForThisCycle: uniqueStrings([
      ...(workflow.scopedGoal?.constraints ?? []),
      ...workflow.ultimateGoal.constraints,
      "Keep privileged repository operations in the approved runtime/main-process boundaries.",
      "Keep checklist status tied to direct evidence, not merely to passing tests."
    ], 12),
    whySelectedNow: decision?.whySelected ?? candidate?.whyNext ?? approved?.rationale ?? recommendation?.rationale ?? workPackage?.reason ?? "Derived from the current saved workflow state.",
    plannerScore: decision?.score ?? candidate?.score,
    scoreBreakdown,
    repetitionPenalty,
    priorSimilarAttempts: priorSimilarAttempts(workflow, effectiveTargetIds, workPackage?.primaryTopic ?? selectedTaskTitle),
    currentKnownBlockers: uniqueStrings([
      ...workflow.memory.knownOpenIssues.filter((issue) => issue.status === "open").map((issue) => `${issue.title}: ${issue.detail}`),
      ...workflow.humanInterventions.filter((entry) => entry.status === "pending").map((entry) => `${entry.title}: ${entry.description}`)
    ], 12),
    fallbackOrHealthWarnings: fallbackWarnings(workflow.recommendationHealth, repetitionPenalty),
    doneWhen: uniqueStrings([
      targetedItems.length ? `All ${targetedItems.length} targeted checklist item(s) are met, not applicable, or have a recorded concrete reason for remaining unknown.` : undefined,
      expectedEvidenceCommands.length ? "Expected evidence commands emit parseable evidence tied to targeted check IDs." : "Evidence references name the targeted check IDs directly.",
      "ChecklistDelta shows whether goal progress moved, and why any targeted check is still unknown.",
      expectedValidationCommands.length ? "Expected validation commands pass or failures are recorded as evidence." : undefined
    ], 8),
    failureModes: [
      "Validation passes but targeted checklist status does not change.",
      "Evidence output omits check IDs or maps to unknown check IDs.",
      "Evidence only restates the goal or implementation intent without observable behavior.",
      "Artifact paths are missing, stale, or cannot be read safely.",
      "Structured recommendation output fails and deterministic fallback repeats the same work package."
    ],
    sourceDataRefs: {
      plannerDecisionId: decision?.id,
      strategicPlanId: planId ?? decision?.planId,
      recommendationId: recommendation?.id ?? approved?.recommendationId,
      approvedRecommendationId: approved?.id,
      workPackageId: workPackage?.id,
      sourceWorkPackageId: candidate?.sourceWorkPackageId ?? approved?.sourceWorkPackageId ?? recommendation?.sourceWorkPackageId,
      targetedCheckIds: effectiveTargetIds,
      scopedGoalId: workflow.scopedGoal?.id,
      recommendationHealthSelectedSource: workflow.recommendationHealth.selectedTaskSource
    }
  };
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const extractBalancedJsonSnippets = (text: string): string[] => {
  const snippets: string[] = [];
  for (let start = 0; start < text.length; start += 1) {
    const opener = text[start];
    if (opener !== "{" && opener !== "[") {
      continue;
    }
    const closer = opener === "{" ? "}" : "]";
    const stack: string[] = [];
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = !inString;
        continue;
      }
      if (inString) {
        continue;
      }
      if (char === "{" || char === "[") {
        stack.push(char);
      } else if (char === "}" || char === "]") {
        const expected = stack[stack.length - 1] === "{" ? "}" : "]";
        if (char !== expected) {
          break;
        }
        stack.pop();
        if (stack.length === 0 && char === closer) {
          snippets.push(text.slice(start, index + 1));
          start = index;
          break;
        }
      }
    }
  }
  return snippets;
};

export const extractJsonValuesFromText = (text: string): unknown[] => {
  const values: unknown[] = [];
  const parseCandidate = (candidate: string): void => {
    try {
      values.push(JSON.parse(candidate));
    } catch {
      // Ignore malformed snippets and continue scanning.
    }
  };
  parseCandidate(text.trim());
  for (const snippet of extractBalancedJsonSnippets(text).slice(0, 30)) {
    parseCandidate(snippet);
  }
  return values;
};

const findKnownEvidenceKeys = (value: unknown): string[] => {
  const keys: string[] = [];
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      entry.forEach(visit);
      return;
    }
    if (!isPlainObject(entry)) {
      return;
    }
    for (const [key, child] of Object.entries(entry)) {
      if (evidenceObjectKeys.has(key)) {
        keys.push(key);
      }
      visit(child);
    }
  };
  visit(value);
  return uniqueStrings(keys, 40);
};

const rowCheckId = (row: Record<string, unknown>, fallbackKey?: string): string | undefined => {
  const explicit = [
    row.checkId,
    row.check_id,
    row.checkID,
    row.targetedCheckId,
    row.targeted_check_id,
    row.requiredCheckId,
    row.required_check_id,
    row.id
  ].find((value) => typeof value === "string" && value.trim());
  return typeof explicit === "string" ? explicit.trim() : fallbackKey;
};

const isLikelyCheckIdKey = (key: string): boolean =>
  /[:]/.test(key) ||
  /^(?:check|criterion|requirement|success|goal|item|sc)[-_:.]?[A-Za-z0-9_-]+$/i.test(key) ||
  /^[A-Za-z]+[_-](?:check|criterion|requirement|success|goal|item)[_-][A-Za-z0-9_-]+$/i.test(key);

const parseEvidenceStatus = (value: unknown, row: Record<string, unknown>): ChecklistEvidenceStatus => {
  if (typeof value === "boolean") {
    return value ? "met" : "needs_attention";
  }
  const status = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (/\b(?:met|satisfied|satisfy|passed|pass|covered|true|ok|yes)\b/.test(status)) {
    return "met";
  }
  if (/\b(?:need|attention|failed|fail|unmet|false|missing|blocked|error)\b/.test(status)) {
    return "needs_attention";
  }
  if (/\b(?:not[_ -]?applicable|n\/a|skipped)\b/.test(status)) {
    return "not_applicable";
  }
  if (typeof row.satisfied === "boolean") {
    return row.satisfied ? "met" : "needs_attention";
  }
  if (typeof row.all_targeted_checks_satisfied === "boolean") {
    return row.all_targeted_checks_satisfied ? "met" : "needs_attention";
  }
  return "unknown";
};

const evidenceTextFromRow = (row: Record<string, unknown>, sourceKey: string): string => {
  const fields = [
    row.evidenceText,
    row.evidence_text,
    row.evidence,
    row.directEvidence,
    row.direct_evidence,
    row.summary,
    row.details,
    row.detail,
    row.reason,
    row.assertion,
    row.result
  ];
  const text = fields.find((value) => typeof value === "string" && value.trim());
  if (typeof text === "string") {
    return redactEvidenceSnippet(text);
  }
  return redactEvidenceSnippet(`${sourceKey}: ${stableStringify(row)}`, 900);
};

const weakEvidenceText = (value: string): boolean => {
  const text = value.trim().toLowerCase();
  return /^(?:implemented|done|complete|completed|satisfied|evidence implemented|all good)[.! ]*$/.test(text) ||
    (text.length < 24 && /\b(?:implemented|done|complete|satisfied)\b/.test(text));
};

const confidenceFromRow = (row: Record<string, unknown>, checkId: string | undefined, status: ChecklistEvidenceStatus, evidenceText: string): number => {
  const confidence = row.confidence;
  if (typeof confidence === "number" && Number.isFinite(confidence)) {
    return Math.max(0, Math.min(1, confidence));
  }
  if (!checkId || status === "unknown" || weakEvidenceText(evidenceText)) {
    return 0.45;
  }
  return 0.9;
};

const observationId = (cycleNumber: number, sourceKey: string, checkId: string | undefined, evidenceText: string): string =>
  `evidence:${cycleNumber}:${stableHash(`${sourceKey}:${checkId ?? "unknown"}:${evidenceText}`)}`;

const consumeReasonForObservation = (
  observation: Pick<ChecklistEvidenceObservation, "checkId" | "status" | "confidence" | "evidenceText">,
  targetedIds: Set<string>,
  knownIds: Set<string>
): ChecklistEvidenceNotConsumedReason | undefined => {
  if (!observation.checkId || observation.checkId === "unknown") {
    return "missing_check_id";
  }
  if (!knownIds.has(observation.checkId)) {
    return "unknown_check_id";
  }
  if (!targetedIds.has(observation.checkId)) {
    return "not_targeted_this_cycle";
  }
  if (observation.status === "unknown") {
    return "ambiguous_status";
  }
  if (observation.confidence < 0.65 || weakEvidenceText(observation.evidenceText)) {
    return "low_confidence";
  }
  return undefined;
};

const rowRelevantPaths = (row: Record<string, unknown>): string[] =>
  uniqueStrings([
    ...toStringList(row.relevantPaths),
    ...toStringList(row.relevant_paths),
    ...toStringList(row.paths),
    ...toStringList(row.files),
    ...toStringList(row.file),
    ...toStringList(row.artifactPath),
    ...toStringList(row.artifact_path)
  ], 16);

const rowValidationCommands = (row: Record<string, unknown>): string[] =>
  uniqueStrings([
    ...toStringList(row.validationCommands),
    ...toStringList(row.validation_commands),
    ...toStringList(row.reviewCommands),
    ...toStringList(row.review_commands),
    ...toStringList(row.commands)
  ], 12);

const createObservation = (
  row: Record<string, unknown>,
  sourceKey: string,
  options: ExtractChecklistEvidenceOptions,
  fallbackCheckId?: string
): ChecklistEvidenceObservation => {
  const checkId = rowCheckId(row, fallbackCheckId) ?? "unknown";
  const status = parseEvidenceStatus(row.status ?? row.state ?? row.result ?? row.satisfied, row);
  const evidenceText = evidenceTextFromRow(row, sourceKey);
  const confidence = confidenceFromRow(row, checkId === "unknown" ? undefined : checkId, status, evidenceText);
  const observation = {
    observationId: observationId(options.cycleNumber, sourceKey, checkId, evidenceText),
    cycleNumber: options.cycleNumber,
    checkId,
    status,
    evidenceText,
    evidenceSourceType: options.evidenceSourceType,
    sourceRef: {
      ...options.sourceRef,
      sourceKey
    },
    relevantPaths: rowRelevantPaths(row),
    validationCommands: rowValidationCommands(row),
    confidence,
    observedAt: options.observedAt ?? nowIso(),
    consumedByChecklist: false
  } satisfies ChecklistEvidenceObservation;
  const reason = consumeReasonForObservation(observation, new Set(options.targetedCheckIds), new Set(options.knownCheckIds));
  return {
    ...observation,
    consumedByChecklist: reason === undefined,
    notConsumedReason: reason
  };
};

const rowsFromEvidencePayload = (payload: unknown): Array<{ row: Record<string, unknown>; fallbackCheckId?: string }> => {
  if (Array.isArray(payload)) {
    return payload.flatMap((entry) => isPlainObject(entry) ? [{ row: entry }] : []);
  }
  if (!isPlainObject(payload)) {
    return [];
  }
  const directCheckId = rowCheckId(payload);
  if (directCheckId || "status" in payload || "satisfied" in payload || "evidence" in payload) {
    return [{ row: payload }];
  }
  return Object.entries(payload).flatMap(([key, value]) => {
    const fallbackCheckId = isLikelyCheckIdKey(key) ? key : undefined;
    if (isPlainObject(value)) {
      return [{ row: value, fallbackCheckId }];
    }
    if (typeof value === "string" || typeof value === "boolean") {
      return [{
        row: typeof value === "boolean"
          ? { status: value, evidence: `${key} satisfaction ${value ? "reported true" : "reported false"}` }
          : { evidence: value, status: "met" },
        fallbackCheckId
      }];
    }
    return [];
  });
};

const collectEvidenceRows = (
  value: unknown,
  sourceKey = "root"
): Array<{ row: Record<string, unknown>; sourceKey: string; fallbackCheckId?: string }> => {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => collectEvidenceRows(entry, `${sourceKey}[${index}]`));
  }
  if (!isPlainObject(value)) {
    return [];
  }
  const rows: Array<{ row: Record<string, unknown>; sourceKey: string; fallbackCheckId?: string }> = [];
  for (const [key, child] of Object.entries(value)) {
    const childSource = sourceKey === "root" ? key : `${sourceKey}.${key}`;
    if (evidenceObjectKeys.has(key) && key !== "required_check_ids" && key !== "all_targeted_checks_satisfied" && key !== "all_targeted_check_ids_observed") {
      rows.push(...rowsFromEvidencePayload(child).map((entry) => ({ ...entry, sourceKey: childSource })));
      continue;
    }
    rows.push(...collectEvidenceRows(child, childSource));
  }
  return rows;
};

export interface ExtractChecklistEvidenceOptions {
  cycleNumber: number;
  targetedCheckIds: string[];
  knownCheckIds: string[];
  evidenceSourceType: ChecklistEvidenceSourceType;
  sourceRef?: ChecklistEvidenceObservation["sourceRef"];
  observedAt?: string;
}

export const extractChecklistEvidenceObservations = (
  text: string,
  options: ExtractChecklistEvidenceOptions
): ChecklistEvidenceObservation[] => {
  const jsonValues = extractJsonValuesFromText(text);
  if (jsonValues.length === 0) {
    return [];
  }
  const observations: ChecklistEvidenceObservation[] = [];
  for (const value of jsonValues) {
    const evidenceKeys = findKnownEvidenceKeys(value);
    if (evidenceKeys.length === 0) {
      continue;
    }
    const rows = collectEvidenceRows(value);
    if (rows.length === 0) {
      observations.push(createObservation({
        evidence: `Evidence fields were present (${evidenceKeys.join(", ")}) but did not include check-specific rows.`,
        status: "unknown"
      }, evidenceKeys[0] ?? "unknown_evidence", options));
      continue;
    }
    for (const entry of rows) {
      observations.push(createObservation(entry.row, entry.sourceKey, options, entry.fallbackCheckId));
    }
  }
  const byId = new Map<string, ChecklistEvidenceObservation>();
  for (const observation of observations) {
    byId.set(observation.observationId, observation);
  }
  return [...byId.values()];
};

const canConsumeObservation = (
  observation: ChecklistEvidenceObservation,
  targetedIds: Set<string>,
  knownIds: Set<string>
): ChecklistEvidenceNotConsumedReason | undefined =>
  consumeReasonForObservation(observation, targetedIds, knownIds);

export const applyChecklistEvidenceObservations = (
  checklist: GoalAttainmentCheck[],
  observations: ChecklistEvidenceObservation[],
  options: {
    targetedCheckIds: string[];
    timestamp?: string;
  }
): { checklist: GoalAttainmentCheck[]; observations: ChecklistEvidenceObservation[] } => {
  const timestamp = options.timestamp ?? nowIso();
  const targetedIds = new Set(options.targetedCheckIds);
  const knownIds = new Set(checklist.map((check) => check.id));
  const next = checklist.map((check) => ({
    ...check,
    relatedPaths: [...(check.relatedPaths ?? [])],
    evidenceHistory: [...(check.evidenceHistory ?? [])]
  }));
  const nextById = new Map(next.map((check) => [check.id, check]));
  const reconciled = observations.map((observation) => {
    const reason = canConsumeObservation(observation, targetedIds, knownIds);
    if (reason) {
      return {
        ...observation,
        consumedByChecklist: false,
        notConsumedReason: reason
      };
    }
    const check = nextById.get(observation.checkId);
    if (!check) {
      return {
        ...observation,
        consumedByChecklist: false,
        notConsumedReason: "unknown_check_id" as const
      };
    }
    const nextStatus: GoalCheckStatus = observation.status === "needs_attention"
      ? "unmet"
      : observation.status === "met"
        ? "met"
        : observation.status;
    check.status = nextStatus;
    check.evidence = observation.evidenceText;
    check.confidence = Math.max(check.confidence ?? 0, observation.confidence);
    check.relatedPaths = uniqueStrings([...check.relatedPaths, ...observation.relevantPaths], 12);
    check.ownerAgentId = observation.sourceRef.agentRunId ?? check.ownerAgentId;
    check.updatedAt = timestamp;
    check.evidenceHistory = [
      {
        checkId: check.id,
        title: check.title,
        source: check.source,
        status: check.status,
        evidence: observation.evidenceText,
        ownerAgentId: observation.sourceRef.agentRunId,
        createdAt: observation.observedAt,
        updatedAt: timestamp
      },
      ...(check.evidenceHistory ?? [])
    ].slice(0, 6);
    return {
      ...observation,
      consumedByChecklist: true,
      notConsumedReason: undefined
    };
  });
  return { checklist: next, observations: reconciled };
};

const reasonText = (reason: ChecklistEvidenceNotConsumedReason): string =>
  ({
    missing_check_id: "evidence emitted but missing check ID",
    unknown_check_id: "evidence emitted for an unknown check ID",
    ambiguous_status: "evidence emitted but ambiguous",
    assertion_failed: "evidence emitted but assertion failed",
    validation_failed: "validation command failed",
    artifact_missing: "artifact not found",
    stale_or_superseded: "evidence was stale or from a previous cycle",
    not_targeted_this_cycle: "evidence was not targeted this cycle",
    low_confidence: "evidence describes implementation but not observable user behavior",
    parse_error: "evidence could not be parsed"
  })[reason];

export const computeChecklistDelta = (
  before: GoalAttainmentCheck[],
  after: GoalAttainmentCheck[],
  observations: ChecklistEvidenceObservation[],
  options: {
    cycleNumber: number;
    targetedCheckIds: string[];
    timestamp?: string;
  }
): ChecklistDelta => {
  const timestamp = options.timestamp ?? nowIso();
  const beforeById = checkMap(before);
  const afterById = checkMap(after);
  const targetedIds = uniqueStrings(options.targetedCheckIds, 80);
  const targetedBefore = targetedIds.map((id) => beforeById.get(id)).filter((check): check is GoalAttainmentCheck => Boolean(check));
  const targetedAfter = targetedIds.map((id) => afterById.get(id)).filter((check): check is GoalAttainmentCheck => Boolean(check));
  const targetedNewlyMet = targetedIds.filter((id) => beforeById.get(id)?.status !== "met" && afterById.get(id)?.status === "met");
  const targetedStillUnknown = targetedIds.filter((id) => afterById.get(id)?.status === "unknown");
  const targetedNeedsAttention = targetedIds.filter((id) => afterById.get(id)?.status === "unmet");
  const targetedNotApplicable = targetedIds.filter((id) => afterById.get(id)?.status === "not_applicable");
  const nonTargetedChanges = [...afterById.values()]
    .filter((check) => !targetedIds.includes(check.id) && beforeById.get(check.id)?.status !== check.status)
    .map((check) => `${check.title}: ${beforeById.get(check.id)?.status ?? "missing"} -> ${check.status}`);
  const evidenceNotConsumedReasons = observations.reduce((map, observation) => {
    if (observation.notConsumedReason) {
      map[observation.notConsumedReason] = (map[observation.notConsumedReason] ?? 0) + 1;
    }
    return map;
  }, {} as Record<ChecklistEvidenceNotConsumedReason, number>);
  const byCheckObservations = new Map<string, ChecklistEvidenceObservation[]>();
  for (const observation of observations) {
    byCheckObservations.set(observation.checkId, [...(byCheckObservations.get(observation.checkId) ?? []), observation]);
  }
  const unknownGlobalObservation = observations.find((observation) => observation.notConsumedReason === "missing_check_id");
  const whyStillUnknownByCheckId = Object.fromEntries(targetedStillUnknown.map((checkId) => {
    const checkObservations = byCheckObservations.get(checkId) ?? [];
    const rejected = checkObservations.find((observation) => observation.notConsumedReason);
    if (rejected?.notConsumedReason) {
      return [checkId, reasonText(rejected.notConsumedReason)];
    }
    if (unknownGlobalObservation?.notConsumedReason) {
      return [checkId, reasonText(unknownGlobalObservation.notConsumedReason)];
    }
    return [checkId, "no evidence emitted"];
  }));
  const goalProgressBefore = percentRequiredMet(before);
  const goalProgressAfter = percentRequiredMet(after);
  const evidenceConsumedCount = observations.filter((observation) => observation.consumedByChecklist).length;
  const evidenceNotConsumedCount = observations.filter((observation) => !observation.consumedByChecklist).length;
  const summaryForHumans = targetedNewlyMet.length > 0
    ? `${targetedNewlyMet.length} targeted checklist item${targetedNewlyMet.length === 1 ? "" : "s"} moved to met.`
    : observations.length > 0
      ? `Evidence was observed (${evidenceConsumedCount} consumed, ${evidenceNotConsumedCount} not consumed), but no targeted checklist item became met.`
      : "No checklist evidence was emitted for the targeted checks.";

  return {
    schemaVersion: CHECKLIST_DELTA_SCHEMA_VERSION,
    cycleNumber: options.cycleNumber,
    targetedTotal: targetedIds.length,
    targetedMetBefore: targetedBefore.filter((check) => check.status === "met").length,
    targetedMetAfter: targetedAfter.filter((check) => check.status === "met").length,
    targetedNewlyMet,
    targetedStillUnknown,
    targetedNeedsAttention,
    targetedNotApplicable,
    nonTargetedChanges,
    evidenceObservedCount: observations.length,
    evidenceConsumedCount,
    evidenceNotConsumedCount,
    evidenceNotConsumedReasons,
    summaryForHumans,
    didGoalProgressChange: goalProgressAfter !== goalProgressBefore || targetedNewlyMet.length > 0,
    goalProgressBefore,
    goalProgressAfter,
    whyStillUnknownByCheckId,
    createdAt: timestamp
  };
};

export const createRecommendationHealth = (): RecommendationHealth => ({
  totalStructuredAttempts: 0,
  totalStructuredFailures: 0,
  consecutiveStructuredFailures: 0,
  fallbackUsedForCurrentRecommendation: false,
  selectedTaskSource: "derived_from_legacy_state",
  modelRecommendationAccepted: false,
  deterministicFallbackCandidateCount: 0,
  visibleWarningLevel: "none"
});

const warningLevelForFailures = (consecutiveFailures: number, fallbackUsed: boolean): RecommendationHealth["visibleWarningLevel"] => {
  if (consecutiveFailures >= 3) {
    return "critical";
  }
  if (consecutiveFailures >= 2) {
    return "warning";
  }
  return fallbackUsed ? "info" : "none";
};

export const recordStructuredRecommendationSuccess = (health: RecommendationHealth | undefined): RecommendationHealth => ({
  ...(health ?? createRecommendationHealth()),
  totalStructuredAttempts: (health?.totalStructuredAttempts ?? 0) + 1,
  consecutiveStructuredFailures: 0,
  fallbackUsedForCurrentRecommendation: false,
  fallbackReason: undefined,
  selectedTaskSource: "structured_recommendation",
  modelRecommendationAccepted: true,
  visibleWarningLevel: "none"
});

export const recordStructuredRecommendationFailure = (
  health: RecommendationHealth | undefined,
  failure: {
    category: StructuredRecommendationFailureCategory;
    message: string;
    at?: string;
  }
): RecommendationHealth => {
  const nextFailures = (health?.consecutiveStructuredFailures ?? 0) + 1;
  return {
    ...(health ?? createRecommendationHealth()),
    totalStructuredAttempts: (health?.totalStructuredAttempts ?? 0) + 1,
    totalStructuredFailures: (health?.totalStructuredFailures ?? 0) + 1,
    consecutiveStructuredFailures: nextFailures,
    lastStructuredFailureAt: failure.at ?? nowIso(),
    lastStructuredFailureCategory: failure.category,
    lastStructuredFailureMessage: failure.message,
    fallbackUsedForCurrentRecommendation: false,
    modelRecommendationAccepted: false,
    visibleWarningLevel: warningLevelForFailures(nextFailures, false)
  };
};

export const recordRecommendationFallbackUsed = (
  health: RecommendationHealth | undefined,
  details: {
    reason: string;
    candidateCount: number;
    confidence?: number;
  }
): RecommendationHealth => {
  const consecutiveFailures = health?.consecutiveStructuredFailures ?? 0;
  return {
    ...(health ?? createRecommendationHealth()),
    fallbackUsedForCurrentRecommendation: true,
    fallbackReason: details.reason,
    selectedTaskSource: "deterministic_fallback",
    fallbackConfidence: details.confidence,
    modelRecommendationAccepted: false,
    deterministicFallbackCandidateCount: details.candidateCount,
    visibleWarningLevel: warningLevelForFailures(consecutiveFailures, true)
  };
};

const safeCommand = (command: string): boolean =>
  !/\b(?:--live-http|--live-http-validation|api[_-]?key|token|secret|credential|login|browser|paid|billing)\b/i.test(command);

const commandRequiresNetwork = (command: string): boolean =>
  /\b(?:--live-http|curl|wget|playwright|browser|login|oauth|remote|deploy)\b/i.test(command);

const commandRequiresCredentials = (command: string): boolean =>
  /\b(?:api[_-]?key|token|secret|credential|oauth|login|broker|account)\b/i.test(command);

const commandExpectedOutput = (command: string): ProjectEvidenceCommand["expectedOutput"] => {
  const normalized = command.trim();
  if (/\b(?:--json|--format(?:=|\s+)json|--output(?:=|\s+)json|json-output|jsonl?)\b/i.test(normalized)) {
    return "json";
  }
  if (/\bsource-audit\b/i.test(normalized)) {
    return "json";
  }
  if (/\bpython3?\s+-m\s+[A-Za-z_][\w.]*\.app\s+(?:status|refresh|portfolio-analytics)\b/i.test(normalized)) {
    return "json";
  }
  return "text";
};

const buildCommand = (
  command: string,
  discoveredFrom: ProjectEvidenceCommand["discoveredFrom"],
  purpose: string,
  confidence: number,
  mapsToCheckIds: string[] = [],
  mapsToChecklistGroups: string[] = []
): ProjectEvidenceCommand => {
  const requiresNetwork = commandRequiresNetwork(command);
  const requiresCredentials = commandRequiresCredentials(command);
  return {
    name: truncate(command.replace(/^npm run /, ""), 80),
    command,
    purpose,
    expectedOutput: commandExpectedOutput(command),
    mapsToChecklistGroups,
    mapsToCheckIds,
    safeDefault: safeCommand(command) && !requiresNetwork && !requiresCredentials,
    requiresNetwork,
    requiresCredentials,
    discoveredFrom,
    confidence
  };
};

export interface EvidenceCommandDiscoveryInput {
  files?: Array<{ relativePath: string; content?: string }>;
  packageJson?: { scripts?: Record<string, string> };
  packageJsonText?: string;
  pyprojectText?: string;
  readmeText?: string;
  previousSuccessfulCommands?: string[];
  codingAgentCommands?: string[];
  checklist?: GoalAttainmentCheck[];
  workPackages?: WorkPackage[];
}

const parsePackageJsonScripts = (input: EvidenceCommandDiscoveryInput): Record<string, string> => {
  if (input.packageJson?.scripts) {
    return input.packageJson.scripts;
  }
  if (!input.packageJsonText) {
    return {};
  }
  try {
    const parsed = JSON.parse(input.packageJsonText) as { scripts?: Record<string, string> };
    return parsed.scripts ?? {};
  } catch {
    return {};
  }
};

const commandsFromReadme = (readmeText?: string): string[] => {
  if (!readmeText) {
    return [];
  }
  const commands: string[] = [];
  const fenced = [...readmeText.matchAll(/```(?:bash|sh|shell|console)?\n([\s\S]*?)```/gi)].map((match) => match[1] ?? "");
  for (const block of fenced) {
    for (const line of block.split(/\r?\n/)) {
      const command = line.trim().replace(/^\$\s*/, "");
      if (/^(?:PYTHONPATH=|python3?\b|npm\b|pytest\b|unittest\b|node\b)/.test(command)) {
        commands.push(command);
      }
    }
  }
  return commands;
};

const packageNameFromSrcApp = (files: Array<{ relativePath: string }>): string | undefined => {
  const appPath = files.find((file) => /^src\/[a-zA-Z_][a-zA-Z0-9_]*\/app\.py$/.test(file.relativePath))?.relativePath;
  return appPath?.split("/")[1];
};

const checklistIdsForTopic = (checks: GoalAttainmentCheck[] = [], pattern: RegExp): string[] =>
  checks
    .filter((check) => pattern.test(`${check.title} ${check.description}`))
    .map((check) => check.id);

export const discoverProjectEvidenceCommands = (input: EvidenceCommandDiscoveryInput): ProjectEvidenceCommand[] => {
  const files = input.files ?? [];
  const checklist = input.checklist ?? [];
  const commands: ProjectEvidenceCommand[] = [];
  const scripts = parsePackageJsonScripts(input);
  for (const [name, script] of Object.entries(scripts)) {
    if (/\b(?:test|check|typecheck|lint|build|audit|evidence|status|validate|refresh)\b/i.test(`${name} ${script}`)) {
      commands.push(buildCommand(`npm run ${name}`, "package_json", `Package script for ${name}.`, 0.72));
    }
  }
  for (const command of commandsFromReadme(input.readmeText)) {
    commands.push(buildCommand(command, "README", "Command documented in README.", 0.76));
  }
  if (input.pyprojectText && /\bpytest\b|\[tool\.pytest/i.test(input.pyprojectText)) {
    commands.push(buildCommand("python3 -m unittest discover -s tests -q", "pyproject", "Offline Python test discovery.", 0.62));
  }
  const packageName = packageNameFromSrcApp(files);
  if (packageName) {
    commands.push(buildCommand(`PYTHONPATH=src python3 -m ${packageName}.app status`, "known_adapter", "Inspect offline application status output.", 0.68));
    if (packageName === "aw_trends") {
      const sourcePolicyIds = checklistIdsForTopic(checklist, /\b(source|provenance|access policy|ranking|validation|dashboard|databank|refresh|comparison)\b/i);
      commands.push(buildCommand(
        `PYTHONPATH=src python3 -m ${packageName}.app source-audit "market data quotes corporate actions" --limit 6`,
        "known_adapter",
        "Emit JSON source-provenance/access-policy evidence for targeted checks.",
        0.9,
        sourcePolicyIds,
        ["source provenance and access policy"]
      ));
      commands.push(buildCommand(
        `PYTHONPATH=src python3 -m ${packageName}.app portfolio-analytics --search-limit 3 --limit-per-category 3`,
        "known_adapter",
        "Emit offline portfolio analytics evidence.",
        0.78
      ));
      commands.push(buildCommand(
        `PYTHONPATH=src python3 -m ${packageName}.app refresh --trigger manual`,
        "known_adapter",
        "Emit databank refresh/change-history evidence without live credentials.",
        0.8,
        checklistIdsForTopic(checklist, /\b(databank|refresh|change history|freshness)\b/i)
      ));
    }
  }
  for (const command of uniqueStrings([...(input.previousSuccessfulCommands ?? []), ...(input.codingAgentCommands ?? [])], 30)) {
    if (safeCommand(command)) {
      commands.push(buildCommand(command, "previous_successful_command", "Previously successful command used by workflow agents.", 0.7));
    }
  }
  if (files.some((file) => /^tests\//.test(file.relativePath)) && !commands.some((command) => /unittest discover|pytest|npm test/.test(command.command))) {
    commands.push(buildCommand("python3 -m unittest discover -s tests -q", "known_adapter", "Safe offline Python unit tests.", 0.58));
  }
  const byCommand = new Map<string, ProjectEvidenceCommand>();
  for (const command of commands) {
    const existing = byCommand.get(command.command);
    if (!existing || command.confidence > existing.confidence) {
      byCommand.set(command.command, command);
    }
  }
  return [...byCommand.values()]
    .sort((left, right) =>
      Number(right.safeDefault) - Number(left.safeDefault) ||
      right.confidence - left.confidence ||
      left.command.localeCompare(right.command)
    )
    .slice(0, 30);
};

const noProgressKey = (delta: ChecklistDelta): string =>
  [...delta.targetedStillUnknown, ...delta.targetedNeedsAttention, ...delta.targetedNotApplicable, ...delta.targetedNewlyMet]
    .sort()
    .join("|") || `${delta.cycleNumber}:${delta.targetedTotal}`;

const isNoProgressDelta = (delta: ChecklistDelta): boolean =>
  delta.targetedTotal > 0 &&
  delta.targetedNewlyMet.length === 0 &&
  delta.evidenceConsumedCount === 0 &&
  !delta.didGoalProgressChange;

export const detectRepeatedNoProgressLoop = (
  workflow: ProjectWorkflowState
): { repeated: boolean; matchingDeltas: ChecklistDelta[]; topic: string; targetedCheckIds: string[] } => {
  const recent = [...workflow.checklistDeltas]
    .sort((left, right) => right.cycleNumber - left.cycleNumber)
    .filter(isNoProgressDelta)
    .slice(0, 6);
  for (const delta of recent) {
    const key = noProgressKey(delta);
    const matches = recent.filter((candidate) => candidate.cycleNumber !== delta.cycleNumber && noProgressKey(candidate) === key);
    if (matches.length >= 1) {
      const targetedCheckIds = uniqueStrings([...delta.targetedStillUnknown, ...delta.targetedNeedsAttention, ...delta.targetedNotApplicable], 40);
      const topic = workflow.cycleContract?.targetedChecklistItems.some((item) => targetedCheckIds.includes(item.checkId))
        ? workflow.cycleContract.selectedTaskTitle.replace(/^Satisfy work package:\s*/i, "")
        : "the repeated checklist target";
      return { repeated: true, matchingDeltas: [delta, ...matches], topic, targetedCheckIds };
    }
  }
  return { repeated: false, matchingDeltas: [], topic: "", targetedCheckIds: [] };
};

export const buildNoProgressReconciliationRecommendation = (
  workflow: ProjectWorkflowState
): WorkflowRecommendationOption | undefined => {
  const loop = detectRepeatedNoProgressLoop(workflow);
  if (!loop.repeated) {
    return undefined;
  }
  const contract = workflow.cycleContract;
  const targetedIds = loop.targetedCheckIds.length
    ? loop.targetedCheckIds
    : contract?.targetedChecklistItems.map((item) => item.checkId) ?? [];
  const topic = contract?.sourceDataRefs.workPackageId
    ? (workflow.workPackages.find((workPackage) => workPackage.id === contract.sourceDataRefs.workPackageId)?.primaryTopic ?? loop.topic)
    : loop.topic || contract?.selectedTaskTitle.replace(/^Satisfy work package:\s*/i, "") || "evidence reconciliation";
  const observed = workflow.evidenceObservations
    .filter((observation) => observation.cycleNumber >= Math.min(...loop.matchingDeltas.map((delta) => delta.cycleNumber)))
    .filter((observation) => targetedIds.includes(observation.checkId) || observation.notConsumedReason === "missing_check_id");
  const observedSummary = observed.length
    ? `${observed.length} evidence observation${observed.length === 1 ? "" : "s"} were emitted but ${observed.filter((item) => !item.consumedByChecklist).length} were not consumed`
    : "validation passed but no check-specific evidence was consumed";
  const notConsumedReasons = uniqueStrings(observed.map((observation) => observation.notConsumedReason ? reasonText(observation.notConsumedReason) : undefined), 5);
  const sourceAuditMentioned = observed.some((observation) => /targeted_check_satisfaction|source-audit/i.test(`${observation.sourceRef.sourceKey ?? ""} ${observation.evidenceText}`));
  const summary = sourceAuditMentioned
    ? "source-audit emitted targeted_check_satisfaction rows, but Agentic Workbench did not reconcile them into goal checklist status."
    : `${observedSummary}; ${notConsumedReasons.length ? notConsumedReasons.join("; ") : "the checklist remained unknown"}.`;
  return {
    id: `reconcile:${stableHash(`${workflow.workflowCycle.cycleNumber}:${topic}:${targetedIds.join("|")}`)}`,
    rank: 1,
    title: `Debug checklist evidence ingestion for ${topic}`,
    summary,
    rationale: `Repeated cycles targeted the same checklist set without consumed evidence or status movement. Fix the workbench reconciliation/extractor path before another generic implementation pass.`,
    expectedImpact: "Turns repeated validation-without-progress into an explainable checklist delta by showing expected evidence, observed evidence, and why it was not consumed.",
    priority: "high",
    confidence: 0.92,
    estimatedScope: "small",
    riskLevel: "medium",
    relatedPaths: uniqueStrings([
      ...(contract?.expectedFilesOrAreas ?? []),
      "src/shared/workflowEvidence.ts",
      "src/runtime/appService.ts"
    ], 8),
    sourceWorkPackageId: typeof contract?.sourceDataRefs.workPackageId === "string" ? contract.sourceDataRefs.workPackageId : undefined,
    targetedCheckIds: targetedIds
  };
};
