import type {
  AgentCommandExecution,
  AgentState,
  CandidateTask,
  ChecklistChange,
  CycleRetrospective,
  GoalChangeRecord,
  GoalChangeProposal,
  GoalCharter,
  GoalAttainmentCheck,
  GoalCheckEvidenceHistoryEntry,
  LocalProjectRecord,
  ProjectWorkflowState,
  RuntimeEventRecord,
  PlannerDecision,
  StrategicPlan,
  UltimateGoal,
  WorkflowActivityEvent,
  WorkflowIncident,
  WorkflowJournalEvent,
  WorkflowMemory,
  WorkflowRecommendationOption,
  WorkflowTaskMap,
  WorkPackage
} from "@shared/types";

export const STATE_SANITIZER_VERSION = 1;

export const CHECKLIST_EVIDENCE_MAX_CHARS = 1_500;
export const CHECKLIST_RENDERER_EVIDENCE_MAX_CHARS = 420;
export const CHECKLIST_EVIDENCE_HISTORY_MAX_ENTRIES = 4;
export const CHECKLIST_EVIDENCE_HISTORY_MAX_CHARS = 750;
export const WORKFLOW_ACTIVITY_MAX_ENTRIES = 1_000;
export const AGENT_EVENTS_MAX_TOTAL = 1_000;
export const AGENT_COMMANDS_MAX_TOTAL = 450;
export const AGENT_EVENTS_MAX_PER_AGENT = 120;
export const AGENT_COMMANDS_MAX_PER_AGENT = 80;
export const FULL_AGENT_DETAILS_MAX = 120;
export const AGENT_COMMAND_OUTPUT_PREVIEW_CHARS = 2_000;
export const AGENT_EVENT_DETAIL_PREVIEW_CHARS = 1_200;
export const AGENT_RAW_EVENT_PREVIEW_CHARS = 1_500;

export interface StateSanitizerReport {
  version: number;
  changed: boolean;
  checklistItemsSanitized: number;
  evidenceFieldsTruncated: number;
  evidenceHistoryEntriesRemoved: number;
  duplicateEvidenceLinesRemoved: number;
  consolidationNotesRemoved: number;
  activityEventsRemoved: number;
  agentEventsRemoved: number;
  commandRecordsRemoved: number;
  agentsCompacted: number;
}

const emptyReport = (): StateSanitizerReport => ({
  version: STATE_SANITIZER_VERSION,
  changed: false,
  checklistItemsSanitized: 0,
  evidenceFieldsTruncated: 0,
  evidenceHistoryEntriesRemoved: 0,
  duplicateEvidenceLinesRemoved: 0,
  consolidationNotesRemoved: 0,
  activityEventsRemoved: 0,
  agentEventsRemoved: 0,
  commandRecordsRemoved: 0,
  agentsCompacted: 0
});

const markChanged = (report: StateSanitizerReport): void => {
  report.changed = true;
};

export const consolidationNotePattern = /^\s*Consolidated\s+\d+\s+semantically equivalent checklist entries\.\s*$/i;
const inlineConsolidationNotePattern = /\bConsolidated\s+\d+\s+semantically equivalent checklist entries\./gi;

const toTime = (value?: string): number => {
  if (!value) {
    return 0;
  }
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
};

const agentSortTime = (agent: Pick<AgentState, "lastActivityAt" | "completedAt" | "startedAt" | "createdAt">): number =>
  Math.max(toTime(agent.lastActivityAt), toTime(agent.completedAt), toTime(agent.startedAt), toTime(agent.createdAt));

const activeAgentStatuses = new Set<AgentState["status"]>(["starting", "running", "waiting_approval"]);

const isAgentActive = (agent: AgentState): boolean => activeAgentStatuses.has(agent.status);

const isReadonlyArray = <T>(value: readonly T[] | undefined | null): value is readonly T[] =>
  Array.isArray(value);

const asArray = <T>(value: readonly T[] | undefined | null): T[] =>
  isReadonlyArray(value) ? [...value] : [];

const truncateText = (value: string, maxChars: number, report?: StateSanitizerReport): string => {
  if (value.length <= maxChars) {
    return value;
  }
  if (report) {
    report.evidenceFieldsTruncated += 1;
    markChanged(report);
  }
  const suffix = ` [truncated from ${value.length} characters]`;
  return `${value.slice(0, Math.max(0, maxChars - suffix.length)).trimEnd()}${suffix}`;
};

const normalizeLine = (value: string): string => value.trim().replace(/\s+/g, " ");

export const sanitizeChecklistEvidenceText = (
  value: string | undefined,
  maxChars = CHECKLIST_EVIDENCE_MAX_CHARS,
  report?: StateSanitizerReport
): string => {
  const source = value ?? "";
  if (!source) {
    return "";
  }

  const lines = source
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n");
  const seenLines = new Set<string>();
  const seenNotes = new Set<string>();
  const kept: string[] = [];
  let localChanged = false;

  for (const rawLine of lines) {
    const normalized = normalizeLine(rawLine);
    if (!normalized) {
      continue;
    }
    if (consolidationNotePattern.test(normalized)) {
      if (seenNotes.has(normalized.toLowerCase())) {
        if (report) {
          report.consolidationNotesRemoved += 1;
        }
        localChanged = true;
        continue;
      }
      seenNotes.add(normalized.toLowerCase());
    }
    const key = normalized.toLowerCase();
    if (seenLines.has(key)) {
      if (report) {
        report.duplicateEvidenceLinesRemoved += 1;
      }
      localChanged = true;
      continue;
    }
    seenLines.add(key);
    kept.push(normalized);
  }

  let next = kept.join("\n");
  const inlineNotes = next.match(inlineConsolidationNotePattern) ?? [];
  if (inlineNotes.length > 1) {
    const firstOffset = next.indexOf(inlineNotes[0] ?? "");
    next = next.replace(inlineConsolidationNotePattern, (match, offset) => offset === firstOffset ? match : "");
    next = next.replace(/\s{2,}/g, " ").trim();
    if (report) {
      report.consolidationNotesRemoved += inlineNotes.length - 1;
    }
    localChanged = true;
  }

  next = truncateText(next, maxChars, report);
  if (next !== source || localChanged) {
    if (report) {
      markChanged(report);
    }
  }
  return next;
};

const sanitizeHistoryEntry = (
  entry: GoalCheckEvidenceHistoryEntry,
  report?: StateSanitizerReport
): GoalCheckEvidenceHistoryEntry => ({
  ...entry,
  title: sanitizeChecklistEvidenceText(entry.title, 240, report),
  evidence: sanitizeChecklistEvidenceText(entry.evidence, CHECKLIST_EVIDENCE_HISTORY_MAX_CHARS, report)
});

export const sanitizeGoalCheckEvidenceHistory = (
  history: GoalAttainmentCheck["evidenceHistory"] | undefined,
  report?: StateSanitizerReport
): GoalCheckEvidenceHistoryEntry[] => {
  const entries = history ?? [];
  const seen = new Set<string>();
  const sanitized = entries
    .map((entry) => sanitizeHistoryEntry(entry, report))
    .filter((entry) => {
      const key = `${entry.checkId}:${entry.status}:${entry.evidence}`.toLowerCase();
      if (seen.has(key)) {
        if (report) {
          report.evidenceHistoryEntriesRemoved += 1;
          markChanged(report);
        }
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort((left, right) => toTime(right.updatedAt ?? right.createdAt) - toTime(left.updatedAt ?? left.createdAt));

  if (sanitized.length > CHECKLIST_EVIDENCE_HISTORY_MAX_ENTRIES) {
    if (report) {
      report.evidenceHistoryEntriesRemoved += sanitized.length - CHECKLIST_EVIDENCE_HISTORY_MAX_ENTRIES;
      markChanged(report);
    }
  }

  return sanitized.slice(0, CHECKLIST_EVIDENCE_HISTORY_MAX_ENTRIES);
};

export const sanitizeGoalAttainmentCheck = (
  check: GoalAttainmentCheck,
  report?: StateSanitizerReport,
  options: { evidenceMaxChars?: number; includeEvidenceHistory?: boolean } = {}
): GoalAttainmentCheck => {
  const evidenceMaxChars = options.evidenceMaxChars ?? CHECKLIST_EVIDENCE_MAX_CHARS;
  const evidence = sanitizeChecklistEvidenceText(check.evidence, evidenceMaxChars, report);
  const evidenceHistory = options.includeEvidenceHistory === false
    ? undefined
    : sanitizeGoalCheckEvidenceHistory(check.evidenceHistory, report);
  const next: GoalAttainmentCheck = {
    ...check,
    title: sanitizeChecklistEvidenceText(check.title, 300, report),
    description: sanitizeChecklistEvidenceText(check.description, 600, report),
    classificationReason: check.classificationReason ? sanitizeChecklistEvidenceText(check.classificationReason, 600, report) : check.classificationReason,
    promotionReason: check.promotionReason ? sanitizeChecklistEvidenceText(check.promotionReason, 600, report) : check.promotionReason,
    evidence,
    evidenceHistory,
    relatedPaths: [...(check.relatedPaths ?? [])].slice(0, 12),
    sourceCheckIds: check.sourceCheckIds ? [...check.sourceCheckIds].slice(0, 32) : check.sourceCheckIds,
    relatedCheckIds: check.relatedCheckIds ? [...check.relatedCheckIds].slice(0, 32) : check.relatedCheckIds
  };

  if (
    next.title !== check.title ||
    next.description !== check.description ||
    next.evidence !== check.evidence ||
    JSON.stringify(next.evidenceHistory ?? []) !== JSON.stringify(check.evidenceHistory ?? []) ||
    next.relatedPaths.length !== (check.relatedPaths ?? []).length
  ) {
    if (report) {
      report.checklistItemsSanitized += 1;
      markChanged(report);
    }
  }

  return next;
};

export const sanitizeGoalChecklist = (
  checklist: GoalAttainmentCheck[] | undefined,
  report?: StateSanitizerReport,
  options: { evidenceMaxChars?: number; includeEvidenceHistory?: boolean } = {}
): GoalAttainmentCheck[] =>
  (checklist ?? []).map((check) => sanitizeGoalAttainmentCheck(check, report, options));

const sanitizeWorkflowMemory = (
  memory: WorkflowMemory,
  report?: StateSanitizerReport,
  options: { renderer?: boolean } = {}
): WorkflowMemory => {
  const previous = JSON.stringify(memory);
  const canonicalFacts = asArray(memory.canonicalFacts);
  const perCycleSummaries = asArray(memory.perCycleSummaries);
  const lastAcceptedDecisions = asArray(memory.lastAcceptedDecisions);
  const knownOpenIssues = asArray(memory.knownOpenIssues);
  const contextDescriptors = asArray(memory.contextDescriptors);
  const lastRelevantContext = asArray(memory.lastRelevantContext);
  const next: WorkflowMemory = {
    ...memory,
    canonicalSummary: sanitizeChecklistEvidenceText(memory.canonicalSummary, options.renderer ? 600 : 1_500, report),
    canonicalFacts: canonicalFacts.slice(0, options.renderer ? 8 : 24).map((fact) => sanitizeChecklistEvidenceText(fact, 300, report)),
    perCycleSummaries: perCycleSummaries.slice(0, options.renderer ? 3 : 12).map((summary) => ({
      ...summary,
      summary: sanitizeChecklistEvidenceText(summary.summary, options.renderer ? 360 : 1_000, report),
      openIssueIds: asArray(summary.openIssueIds).slice(0, 24)
    })),
    lastAcceptedDecisions: lastAcceptedDecisions.slice(0, options.renderer ? 5 : 24).map((decision) => ({
      ...decision,
      title: sanitizeChecklistEvidenceText(decision.title, 240, report),
      summary: sanitizeChecklistEvidenceText(decision.summary, options.renderer ? 280 : 800, report)
    })),
    knownOpenIssues: knownOpenIssues.slice(0, options.renderer ? 8 : 40).map((issue) => ({
      ...issue,
      title: sanitizeChecklistEvidenceText(issue.title, 240, report),
      detail: sanitizeChecklistEvidenceText(issue.detail, options.renderer ? 360 : 1_000, report)
    })),
    contextDescriptors: options.renderer
      ? contextDescriptors.slice(0, 6).map((descriptor) => ({
        ...descriptor,
        goalTokens: asArray(descriptor.goalTokens).slice(0, 12),
        workTypeTags: asArray(descriptor.workTypeTags).slice(0, 12),
        changedPaths: asArray(descriptor.changedPaths).slice(0, 12),
        relatedPaths: asArray(descriptor.relatedPaths).slice(0, 12),
        acceptedDecisionIds: asArray(descriptor.acceptedDecisionIds).slice(0, 12),
        openIssueIds: asArray(descriptor.openIssueIds).slice(0, 12),
        resolvedIssueIds: asArray(descriptor.resolvedIssueIds).slice(0, 12),
        summary: sanitizeChecklistEvidenceText(descriptor.summary, 360, report),
        featureWeights: {}
      }))
      : contextDescriptors.slice(0, 80).map((descriptor) => ({
        ...descriptor,
        summary: sanitizeChecklistEvidenceText(descriptor.summary, 800, report),
        changedPaths: asArray(descriptor.changedPaths).slice(0, 24),
        relatedPaths: asArray(descriptor.relatedPaths).slice(0, 24),
        featureWeights: Object.fromEntries(Object.entries(descriptor.featureWeights ?? {}).slice(0, 80))
      })),
    lastRelevantContext: lastRelevantContext.slice(0, options.renderer ? 6 : 12).map((selection) => ({
      ...selection,
      reasons: asArray(selection.reasons).slice(0, 6).map((reason) => sanitizeChecklistEvidenceText(reason, 240, report)),
      summary: sanitizeChecklistEvidenceText(selection.summary, options.renderer ? 320 : 800, report),
      paths: asArray(selection.paths).slice(0, 12),
      decisionIds: asArray(selection.decisionIds).slice(0, 12),
      issueIds: asArray(selection.issueIds).slice(0, 12)
    }))
  };

  if (previous !== JSON.stringify(next)) {
    if (report) {
      markChanged(report);
    }
  }
  return next;
};

const sanitizeTaskMap = (
  taskMap: WorkflowTaskMap | undefined,
  report?: StateSanitizerReport,
  options: { renderer?: boolean } = {}
): WorkflowTaskMap => taskMap
  ? ({
    ...taskMap,
    groups: asArray(taskMap.groups).slice(0, options.renderer ? 12 : 80).map((group) => ({
    ...group,
    title: sanitizeChecklistEvidenceText(group.title, 240, report),
    rationale: sanitizeChecklistEvidenceText(group.rationale, options.renderer ? 240 : 800, report),
    checkIds: asArray(group.checkIds).slice(0, 80),
    representativeChecks: asArray(group.representativeChecks).slice(0, options.renderer ? 4 : 12).map((check) => sanitizeChecklistEvidenceText(check, 240, report)),
    relatedPaths: asArray(group.relatedPaths).slice(0, 12)
  }))
  })
  : {
    groups: [],
    totalRequiredChecks: 0,
    openRequiredChecks: 0,
    updatedAt: "1970-01-01T00:00:00.000Z"
  };

const sanitizeRecommendation = (
  recommendation: WorkflowRecommendationOption,
  report?: StateSanitizerReport,
  options: { renderer?: boolean } = {}
): WorkflowRecommendationOption => ({
  ...recommendation,
  title: sanitizeChecklistEvidenceText(recommendation.title, 240, report),
  summary: sanitizeChecklistEvidenceText(recommendation.summary, options.renderer ? 360 : 1_000, report),
  rationale: sanitizeChecklistEvidenceText(recommendation.rationale, options.renderer ? 420 : 1_200, report),
  expectedImpact: sanitizeChecklistEvidenceText(recommendation.expectedImpact, options.renderer ? 360 : 1_000, report),
  relatedPaths: asArray(recommendation.relatedPaths).slice(0, 12),
  targetedCheckIds: recommendation.targetedCheckIds ? asArray(recommendation.targetedCheckIds).slice(0, 40) : recommendation.targetedCheckIds
});

const sanitizeWorkPackage = (workPackage: WorkPackage, report?: StateSanitizerReport): WorkPackage => ({
  ...workPackage,
  title: sanitizeChecklistEvidenceText(workPackage.title, 240, report),
  summary: sanitizeChecklistEvidenceText(workPackage.summary, 360, report),
  likelyPaths: asArray(workPackage.likelyPaths).slice(0, 12),
  reason: sanitizeChecklistEvidenceText(workPackage.reason, 500, report),
  acceptanceHints: asArray(workPackage.acceptanceHints).slice(0, 8).map((hint) => sanitizeChecklistEvidenceText(hint, 300, report)),
  checkIds: asArray(workPackage.checkIds).slice(0, 40)
});

const sanitizeChecklistChange = (
  change: ChecklistChange,
  report?: StateSanitizerReport,
  options: { renderer?: boolean } = {}
): ChecklistChange => ({
  ...change,
  checklistItemIds: asArray(change.checklistItemIds).slice(0, 40),
  title: change.title ? sanitizeChecklistEvidenceText(change.title, 240, report) : change.title,
  rationale: sanitizeChecklistEvidenceText(change.rationale, options.renderer ? 360 : 1_000, report),
  affectedGoalArea: sanitizeChecklistEvidenceText(change.affectedGoalArea, 240, report),
  linkedEvidence: asArray(change.linkedEvidence).slice(0, options.renderer ? 4 : 12).map((entry) => sanitizeChecklistEvidenceText(entry, options.renderer ? 240 : 800, report)),
  linkedChangedFiles: asArray(change.linkedChangedFiles).slice(0, 24),
  linkedValidationCommands: asArray(change.linkedValidationCommands).slice(0, 12),
  linkedCycleIds: asArray(change.linkedCycleIds).slice(0, 24),
  linkedAgentIds: asArray(change.linkedAgentIds).slice(0, 24)
});

const sanitizeCandidateTask = (
  candidate: CandidateTask,
  report?: StateSanitizerReport,
  options: { renderer?: boolean } = {}
): CandidateTask => ({
  ...candidate,
  title: sanitizeChecklistEvidenceText(candidate.title, 240, report),
  summary: sanitizeChecklistEvidenceText(candidate.summary, options.renderer ? 360 : 1_000, report),
  targetedCheckIds: asArray(candidate.targetedCheckIds).slice(0, 40),
  expectedChecklistImpact: sanitizeChecklistEvidenceText(candidate.expectedChecklistImpact, options.renderer ? 300 : 800, report),
  expectedFiles: asArray(candidate.expectedFiles).slice(0, 16),
  expectedValidationCommands: asArray(candidate.expectedValidationCommands).slice(0, 12),
  whyNext: sanitizeChecklistEvidenceText(candidate.whyNext, options.renderer ? 420 : 1_200, report),
  goalChangeProposalIds: asArray(candidate.goalChangeProposalIds).slice(0, 24),
  checklistChangeIds: asArray(candidate.checklistChangeIds).slice(0, 24),
  scoreBreakdown: Object.fromEntries(Object.entries(candidate.scoreBreakdown ?? {}).slice(0, 24))
});

const sanitizeUltimateGoal = (
  goal: UltimateGoal | undefined,
  report?: StateSanitizerReport,
  options: { renderer?: boolean } = {}
): UltimateGoal => ({
  summary: sanitizeChecklistEvidenceText(goal?.summary, options.renderer ? 500 : 2_000, report),
  detailedIntent: sanitizeChecklistEvidenceText(goal?.detailedIntent, options.renderer ? 800 : 3_000, report),
  successCriteria: asArray(goal?.successCriteria).slice(0, 40).map((entry) => sanitizeChecklistEvidenceText(entry, options.renderer ? 300 : 1_000, report)),
  constraints: asArray(goal?.constraints).slice(0, 40).map((entry) => sanitizeChecklistEvidenceText(entry, options.renderer ? 300 : 1_000, report)),
  nonGoals: asArray(goal?.nonGoals).slice(0, 40).map((entry) => sanitizeChecklistEvidenceText(entry, options.renderer ? 300 : 1_000, report)),
  qualityBar: sanitizeChecklistEvidenceText(goal?.qualityBar, options.renderer ? 500 : 1_500, report),
  targetAudience: sanitizeChecklistEvidenceText(goal?.targetAudience, 500, report),
  source: goal?.source ?? "user",
  confirmedAt: goal?.confirmedAt,
  lastUpdatedAt: goal?.lastUpdatedAt
});

const sanitizeGoalChangeRecord = (
  change: GoalChangeRecord,
  report?: StateSanitizerReport,
  options: { renderer?: boolean } = {}
): GoalChangeRecord => ({
  ...change,
  title: sanitizeChecklistEvidenceText(change.title, 240, report),
  summary: sanitizeChecklistEvidenceText(change.summary, options.renderer ? 360 : 1_000, report),
  rationale: sanitizeChecklistEvidenceText(change.rationale, options.renderer ? 420 : 1_200, report),
  fromGoalSummary: change.fromGoalSummary ? sanitizeChecklistEvidenceText(change.fromGoalSummary, 300, report) : change.fromGoalSummary,
  toGoalSummary: change.toGoalSummary ? sanitizeChecklistEvidenceText(change.toGoalSummary, 300, report) : change.toGoalSummary,
  decisionNotes: change.decisionNotes ? sanitizeChecklistEvidenceText(change.decisionNotes, 500, report) : change.decisionNotes,
  proposedGoal: change.proposedGoal ? sanitizeUltimateGoal(change.proposedGoal, report, options) : change.proposedGoal
});

const sanitizeGoalChangeProposal = (
  change: GoalChangeProposal,
  report?: StateSanitizerReport,
  options: { renderer?: boolean } = {}
): GoalChangeProposal => ({
  ...sanitizeGoalChangeRecord(change, report, options),
  approvalStatus: change.approvalStatus,
  requiredByStrategy: Boolean(change.requiredByStrategy),
  risk: change.risk,
  affectedGoalArea: sanitizeChecklistEvidenceText(change.affectedGoalArea, 240, report)
});

const sanitizeStrategicPlan = (
  plan: StrategicPlan,
  report?: StateSanitizerReport,
  options: { renderer?: boolean } = {}
): StrategicPlan => ({
  ...plan,
  originalGoalSummary: sanitizeChecklistEvidenceText(plan.originalGoalSummary, options.renderer ? 360 : 1_000, report),
  currentEffectiveGoalSummary: sanitizeChecklistEvidenceText(plan.currentEffectiveGoalSummary, options.renderer ? 360 : 1_000, report),
  strategyHighlights: asArray(plan.strategyHighlights).slice(0, 12).map((entry) => sanitizeChecklistEvidenceText(entry, 200, report)),
  repoScanStatus: sanitizeChecklistEvidenceText(plan.repoScanStatus, 300, report),
  previousCycleOutcomes: asArray(plan.previousCycleOutcomes).slice(0, options.renderer ? 4 : 12).map((entry) => sanitizeChecklistEvidenceText(entry, options.renderer ? 240 : 800, report)),
  failedCommands: asArray(plan.failedCommands).slice(0, 12).map((entry) => sanitizeChecklistEvidenceText(entry, 240, report)),
  changedFiles: asArray(plan.changedFiles).slice(0, 32),
  openBlockers: asArray(plan.openBlockers).slice(0, 16).map((entry) => sanitizeChecklistEvidenceText(entry, 240, report)),
  userFeedback: asArray(plan.userFeedback).slice(0, 8).map((entry) => sanitizeChecklistEvidenceText(entry, options.renderer ? 240 : 800, report)),
  recentAgentOutputs: asArray(plan.recentAgentOutputs).slice(0, 8).map((entry) => sanitizeChecklistEvidenceText(entry, options.renderer ? 240 : 800, report)),
  architectureNotes: asArray(plan.architectureNotes).slice(0, 8).map((entry) => sanitizeChecklistEvidenceText(entry, 300, report)),
  candidateTasks: asArray(plan.candidateTasks).slice(0, options.renderer ? 8 : 30).map((candidate) => sanitizeCandidateTask(candidate, report, options)),
  candidateWorkPackages: asArray(plan.candidateWorkPackages).slice(0, options.renderer ? 4 : 12).map((workPackage) => sanitizeWorkPackage(workPackage, report)),
  proposedGoalChanges: asArray(plan.proposedGoalChanges).slice(0, options.renderer ? 4 : 20).map((change) => sanitizeGoalChangeProposal(change, report, options)),
  proposedChecklistChanges: asArray(plan.proposedChecklistChanges).slice(0, options.renderer ? 8 : 40).map((change) => sanitizeChecklistChange(change, report, options)),
  plannerSummary: sanitizeChecklistEvidenceText(plan.plannerSummary, options.renderer ? 420 : 1_200, report),
  pauseReason: plan.pauseReason ? sanitizeChecklistEvidenceText(plan.pauseReason, 500, report) : plan.pauseReason
});

const sanitizePlannerDecision = (
  decision: PlannerDecision,
  report?: StateSanitizerReport,
  options: { renderer?: boolean } = {}
): PlannerDecision => ({
  ...decision,
  selectedTaskTitle: decision.selectedTaskTitle ? sanitizeChecklistEvidenceText(decision.selectedTaskTitle, 240, report) : decision.selectedTaskTitle,
  whySelected: sanitizeChecklistEvidenceText(decision.whySelected, options.renderer ? 420 : 1_200, report),
  scoreBreakdown: Object.fromEntries(Object.entries(decision.scoreBreakdown ?? {}).slice(0, 24)),
  strategySettingsUsed: asArray(decision.strategySettingsUsed).slice(0, 12).map((entry) => sanitizeChecklistEvidenceText(entry, 200, report)),
  targetedChecklistIds: asArray(decision.targetedChecklistIds).slice(0, 40),
  expectedFiles: asArray(decision.expectedFiles).slice(0, 16),
  expectedValidationCommands: asArray(decision.expectedValidationCommands).slice(0, 12),
  goalChangeProposalIds: asArray(decision.goalChangeProposalIds).slice(0, 24),
  checklistChangeIds: asArray(decision.checklistChangeIds).slice(0, 24)
});

const sanitizeCycleRetrospective = (
  retrospective: CycleRetrospective,
  report?: StateSanitizerReport,
  options: { renderer?: boolean } = {}
): CycleRetrospective => ({
  ...retrospective,
  triedToDo: sanitizeChecklistEvidenceText(retrospective.triedToDo, options.renderer ? 300 : 900, report),
  whyChosen: sanitizeChecklistEvidenceText(retrospective.whyChosen, options.renderer ? 420 : 1_200, report),
  changedFiles: asArray(retrospective.changedFiles).slice(0, 40),
  commandsRun: asArray(retrospective.commandsRun).slice(0, 40).map((entry) => sanitizeChecklistEvidenceText(entry, 240, report)),
  passed: asArray(retrospective.passed).slice(0, 20).map((entry) => sanitizeChecklistEvidenceText(entry, 240, report)),
  failed: asArray(retrospective.failed).slice(0, 20).map((entry) => sanitizeChecklistEvidenceText(entry, options.renderer ? 260 : 800, report)),
  learned: asArray(retrospective.learned).slice(0, 12).map((entry) => sanitizeChecklistEvidenceText(entry, options.renderer ? 260 : 800, report)),
  checklistItemsAdvanced: asArray(retrospective.checklistItemsAdvanced).slice(0, 20).map((entry) => sanitizeChecklistEvidenceText(entry, 240, report)),
  goalChecklistChangeRecommendation: sanitizeChecklistEvidenceText(retrospective.goalChecklistChangeRecommendation, options.renderer ? 300 : 800, report),
  nextRecommendedTasks: asArray(retrospective.nextRecommendedTasks).slice(0, 8).map((entry) => sanitizeChecklistEvidenceText(entry, 240, report)),
  pauseReason: retrospective.pauseReason ? sanitizeChecklistEvidenceText(retrospective.pauseReason, 500, report) : retrospective.pauseReason
});

const sanitizeGoalCharter = (
  charter: GoalCharter | undefined,
  fallbackGoal: UltimateGoal | undefined,
  report?: StateSanitizerReport,
  options: { renderer?: boolean } = {}
): GoalCharter | undefined => {
  if (!charter) {
    return charter;
  }
  const listLimit = options.renderer ? 16 : 80;
  const changeLimit = options.renderer ? 8 : 50;
  const sanitizeList = (entries: string[] | undefined): string[] =>
    asArray(entries).slice(0, listLimit).map((entry) => sanitizeChecklistEvidenceText(entry, options.renderer ? 300 : 1_000, report));
  return {
    ...charter,
    originalUltimateGoal: sanitizeUltimateGoal(charter.originalUltimateGoal ?? fallbackGoal, report, options),
    currentEffectiveGoal: sanitizeUltimateGoal(charter.currentEffectiveGoal ?? fallbackGoal, report, options),
    nonNegotiableRequirements: sanitizeList(charter.nonNegotiableRequirements),
    flexibleRequirements: sanitizeList(charter.flexibleRequirements),
    niceToHaveIdeas: sanitizeList(charter.niceToHaveIdeas),
    explicitNonGoals: sanitizeList(charter.explicitNonGoals),
    userConstraints: sanitizeList(charter.userConstraints),
    aestheticPreferences: sanitizeList(charter.aestheticPreferences),
    technicalPreferences: sanitizeList(charter.technicalPreferences),
    definitionOfDone: sanitizeList(charter.definitionOfDone),
    acceptedGoalChanges: asArray(charter.acceptedGoalChanges).slice(0, changeLimit).map((change) => sanitizeGoalChangeRecord(change, report, options)),
    rejectedGoalChanges: asArray(charter.rejectedGoalChanges).slice(0, changeLimit).map((change) => sanitizeGoalChangeRecord(change, report, options)),
    proposedGoalChanges: asArray(charter.proposedGoalChanges).slice(0, changeLimit).map((change) => sanitizeGoalChangeRecord(change, report, options))
  };
};

const sanitizeWorkflowActivity = (
  activityLog: WorkflowActivityEvent[] | undefined,
  report?: StateSanitizerReport,
  options: { renderer?: boolean } = {}
): WorkflowActivityEvent[] => {
  const maxEntries = options.renderer ? 80 : WORKFLOW_ACTIVITY_MAX_ENTRIES;
  const entries = asArray(activityLog);
  if (entries.length > maxEntries) {
    if (report) {
      report.activityEventsRemoved += entries.length - maxEntries;
      markChanged(report);
    }
  }
  return entries.slice(0, maxEntries).map((event) => ({
    ...event,
    title: sanitizeChecklistEvidenceText(event.title, 240, report),
    detail: event.detail ? sanitizeChecklistEvidenceText(event.detail, options.renderer ? 500 : 1_200, report) : event.detail
  }));
};

const sanitizeWorkflowIncidents = (
  incidents: WorkflowIncident[] | undefined,
  report?: StateSanitizerReport,
  options: { renderer?: boolean } = {}
): WorkflowIncident[] => {
  const maxEntries = options.renderer ? 60 : 200;
  const entries = asArray(incidents);
  if (entries.length > maxEntries && report) {
    markChanged(report);
  }
  return entries.slice(0, maxEntries).map((incident) => ({
    ...incident,
    title: sanitizeChecklistEvidenceText(incident.title, 240, report),
    summary: sanitizeChecklistEvidenceText(incident.summary, options.renderer ? 520 : 1_200, report),
    rootCause: sanitizeChecklistEvidenceText(incident.rootCause, options.renderer ? 620 : 1_500, report),
    evidenceRefs: asArray(incident.evidenceRefs).slice(0, options.renderer ? 16 : 40).map((entry) => sanitizeChecklistEvidenceText(entry, 500, report)),
    involvedPaths: asArray(incident.involvedPaths).slice(0, 24),
    automaticActions: asArray(incident.automaticActions).slice(0, 20).map((entry) => sanitizeChecklistEvidenceText(entry, 500, report)),
    nextSystemAction: incident.nextSystemAction ? sanitizeChecklistEvidenceText(incident.nextSystemAction, 700, report) : incident.nextSystemAction,
    userActionRequired: incident.userActionRequired ? sanitizeChecklistEvidenceText(incident.userActionRequired, 700, report) : incident.userActionRequired,
    primaryAction: incident.primaryAction
      ? { ...incident.primaryAction, label: sanitizeChecklistEvidenceText(incident.primaryAction.label, 120, report) }
      : incident.primaryAction,
    secondaryActions: asArray(incident.secondaryActions).slice(0, 6).map((action) => ({
      ...action,
      label: sanitizeChecklistEvidenceText(action.label, 120, report),
      disabledReason: action.disabledReason ? sanitizeChecklistEvidenceText(action.disabledReason, 300, report) : action.disabledReason
    }))
  }));
};

const sanitizeWorkflowJournal = (
  journal: WorkflowJournalEvent[] | undefined,
  report?: StateSanitizerReport,
  options: { renderer?: boolean } = {}
): WorkflowJournalEvent[] => {
  const maxEntries = options.renderer ? 160 : 1_000;
  const entries = asArray(journal);
  if (entries.length > maxEntries && report) {
    markChanged(report);
  }
  return entries.slice(0, maxEntries).map((event) => ({
    ...event,
    title: sanitizeChecklistEvidenceText(event.title, 240, report),
    summary: event.summary ? sanitizeChecklistEvidenceText(event.summary, options.renderer ? 500 : 1_200, report) : event.summary,
    evidenceRefs: asArray(event.evidenceRefs).slice(0, options.renderer ? 12 : 30).map((entry) => sanitizeChecklistEvidenceText(entry, 500, report))
  }));
};

export const sanitizeWorkflowState = (
  workflow: ProjectWorkflowState,
  report?: StateSanitizerReport,
  options: { renderer?: boolean } = {}
): ProjectWorkflowState => {
  const ultimateGoal = workflow.ultimateGoal;
  const workflowBudgets = workflow.workflowBudgets;
  const recommendationMax = workflowBudgets?.maxRecommendationOptions ?? 5;

  return {
    ...workflow,
    incidents: sanitizeWorkflowIncidents(workflow.incidents, report, options),
    journal: sanitizeWorkflowJournal(workflow.journal, report, options),
    ultimateGoal: sanitizeUltimateGoal(ultimateGoal, report, options),
    goalCharter: sanitizeGoalCharter(workflow.goalCharter, ultimateGoal, report, options) ?? workflow.goalCharter,
  goalChecklist: sanitizeGoalChecklist(workflow.goalChecklist, report, {
    evidenceMaxChars: options.renderer ? CHECKLIST_RENDERER_EVIDENCE_MAX_CHARS : CHECKLIST_EVIDENCE_MAX_CHARS,
    includeEvidenceHistory: !options.renderer
  }),
  taskMap: sanitizeTaskMap(workflow.taskMap, report, options),
  workPackages: asArray(workflow.workPackages).slice(0, options.renderer ? 8 : 30).map((workPackage) => sanitizeWorkPackage(workPackage, report)),
  strategicPlans: asArray(workflow.strategicPlans).slice(0, options.renderer ? 3 : 30).map((plan) => sanitizeStrategicPlan(plan, report, options)),
  plannerDecisions: asArray(workflow.plannerDecisions).slice(0, options.renderer ? 8 : 50).map((decision) => sanitizePlannerDecision(decision, report, options)),
  checklistChanges: asArray(workflow.checklistChanges).slice(0, options.renderer ? 16 : 100).map((change) => sanitizeChecklistChange(change, report, options)),
  cycleRetrospectives: asArray(workflow.cycleRetrospectives).slice(0, options.renderer ? 8 : 50).map((retrospective) => sanitizeCycleRetrospective(retrospective, report, options)),
  approvedRecommendation: workflow.approvedRecommendation
    ? {
      ...sanitizeRecommendation(workflow.approvedRecommendation, report, options),
      approvedAt: workflow.approvedRecommendation.approvedAt,
      recommendationId: workflow.approvedRecommendation.recommendationId
    }
    : workflow.approvedRecommendation,
  scopedGoal: workflow.scopedGoal
    ? {
      ...workflow.scopedGoal,
      summary: sanitizeChecklistEvidenceText(workflow.scopedGoal.summary, options.renderer ? 420 : 1_200, report),
      executionBrief: sanitizeChecklistEvidenceText(workflow.scopedGoal.executionBrief, options.renderer ? 800 : 2_000, report),
      acceptanceCriteria: asArray(workflow.scopedGoal.acceptanceCriteria).slice(0, 16).map((entry) => sanitizeChecklistEvidenceText(entry, options.renderer ? 240 : 800, report)),
      constraints: asArray(workflow.scopedGoal.constraints).slice(0, 16).map((entry) => sanitizeChecklistEvidenceText(entry, options.renderer ? 240 : 800, report)),
      testStrategy: asArray(workflow.scopedGoal.testStrategy).slice(0, 16).map((entry) => sanitizeChecklistEvidenceText(entry, options.renderer ? 240 : 800, report)),
      targetedCheckIds: workflow.scopedGoal.targetedCheckIds ? asArray(workflow.scopedGoal.targetedCheckIds).slice(0, 40) : workflow.scopedGoal.targetedCheckIds,
      likelyPaths: workflow.scopedGoal.likelyPaths ? asArray(workflow.scopedGoal.likelyPaths).slice(0, 12) : workflow.scopedGoal.likelyPaths
    }
    : workflow.scopedGoal,
  recommendations: asArray(workflow.recommendations).slice(0, options.renderer ? 8 : recommendationMax).map((recommendation) =>
    sanitizeRecommendation(recommendation, report, options)
  ),
  memory: sanitizeWorkflowMemory(workflow.memory ?? {
    canonicalSummary: "",
    canonicalFacts: [],
    perCycleSummaries: [],
    lastAcceptedDecisions: [],
    knownOpenIssues: [],
    agentFreshness: {},
    contextDescriptors: [],
    lastRelevantContext: []
  }, report, options),
  activityLog: sanitizeWorkflowActivity(workflow.activityLog, report, options),
  previewRequest: workflow.previewRequest
    ? {
      ...workflow.previewRequest,
      reason: workflow.previewRequest.reason ? sanitizeChecklistEvidenceText(workflow.previewRequest.reason, 500, report) : workflow.previewRequest.reason,
      evidence: workflow.previewRequest.evidence ? asArray(workflow.previewRequest.evidence).slice(0, 6).map((entry) => sanitizeChecklistEvidenceText(entry, options.renderer ? 240 : 800, report)) : workflow.previewRequest.evidence
    }
    : workflow.previewRequest
  };
};

const eventKey = (agent: AgentState, event: RuntimeEventRecord, index: number): string =>
  `${agent.id}:event:${event.id}:${event.timestamp}:${index}`;

const commandKey = (agent: AgentState, command: AgentCommandExecution, index: number): string =>
  `${agent.id}:command:${command.itemId ?? command.startedAt}:${index}`;

const compactRawEventValue = (value: unknown, maxChars: number, report?: StateSanitizerReport): unknown => {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return sanitizeChecklistEvidenceText(value, maxChars, report);
  }
  try {
    const serialized = JSON.stringify(value);
    const compacted = sanitizeChecklistEvidenceText(serialized, maxChars, report);
    if ((typeof value !== "string" || serialized !== compacted) && report) {
      markChanged(report);
    }
    return compacted;
  } catch {
    if (report) {
      markChanged(report);
    }
    return "[unserializable raw event]";
  }
};

const sanitizeAgent = (
  agent: AgentState,
  report: StateSanitizerReport,
  options: {
    compactDetails: boolean;
    allowedEventKeys: Set<string>;
    allowedCommandKeys: Set<string>;
  }
): AgentState => {
  const agentEvents = asArray(agent.events);
  const agentCommandLog = asArray(agent.commandLog);
  const approvals = asArray(agent.approvals);
  const previousEventCount = agentEvents.length;
  const previousCommandCount = agentCommandLog.length;
  const events = options.compactDetails
    ? []
    : agentEvents
      .map((event, index) => ({ event, key: eventKey(agent, event, index) }))
      .filter(({ key }) => options.allowedEventKeys.has(key))
      .slice(0, AGENT_EVENTS_MAX_PER_AGENT)
      .map(({ event }) => ({
        ...event,
        title: sanitizeChecklistEvidenceText(event.title, 240, report),
        detail: event.detail ? sanitizeChecklistEvidenceText(event.detail, AGENT_EVENT_DETAIL_PREVIEW_CHARS, report) : event.detail,
        raw: compactRawEventValue(event.raw, AGENT_RAW_EVENT_PREVIEW_CHARS, report)
      }));
  const commandLog = options.compactDetails
    ? []
    : agentCommandLog
      .map((command, index) => ({ command, key: commandKey(agent, command, index) }))
      .filter(({ key }) => options.allowedCommandKeys.has(key))
      .slice(0, AGENT_COMMANDS_MAX_PER_AGENT)
      .map(({ command }) => {
        const output = command.output.length > AGENT_COMMAND_OUTPUT_PREVIEW_CHARS
          ? `${command.output.slice(-AGENT_COMMAND_OUTPUT_PREVIEW_CHARS).trimStart()} [truncated from ${command.output.length} characters]`
          : command.output;
        if (output !== command.output) {
          markChanged(report);
        }
        return {
          ...command,
          command: sanitizeChecklistEvidenceText(command.command, 4_000, report),
          output
        };
      });

  if (events.length !== previousEventCount) {
    report.agentEventsRemoved += previousEventCount - events.length;
    markChanged(report);
  }
  if (commandLog.length !== previousCommandCount) {
    report.commandRecordsRemoved += previousCommandCount - commandLog.length;
    markChanged(report);
  }
  if (options.compactDetails && (previousEventCount > 0 || previousCommandCount > 0)) {
    report.agentsCompacted += 1;
    markChanged(report);
  }

  return {
    ...agent,
    taskPrompt: sanitizeChecklistEvidenceText(agent.taskPrompt, options.compactDetails ? 400 : 4_000, report),
    currentPhase: agent.currentPhase ? sanitizeChecklistEvidenceText(agent.currentPhase, 500, report) : agent.currentPhase,
    currentSubtask: agent.currentSubtask ? sanitizeChecklistEvidenceText(agent.currentSubtask, 500, report) : agent.currentSubtask,
    lastMessageSnippet: agent.lastMessageSnippet ? sanitizeChecklistEvidenceText(agent.lastMessageSnippet, 600, report) : agent.lastMessageSnippet,
    changedFiles: asArray(agent.changedFiles).slice(0, options.compactDetails ? 24 : 80),
    approvals: approvals.slice(0, options.compactDetails ? 12 : 80).map((approval) => ({
      ...approval,
      summary: sanitizeChecklistEvidenceText(approval.summary, 400, report),
      reason: approval.reason ? sanitizeChecklistEvidenceText(approval.reason, 500, report) : approval.reason,
      command: approval.command ? sanitizeChecklistEvidenceText(approval.command, 2_000, report) : approval.command,
      filePaths: asArray(approval.filePaths).slice(0, 40)
    })),
    commandLog,
    events,
    disconnectedReason: agent.disconnectedReason ? sanitizeChecklistEvidenceText(agent.disconnectedReason, 800, report) : agent.disconnectedReason,
    integrityReport: agent.integrityReport
      ? {
        ...agent.integrityReport,
        summary: sanitizeChecklistEvidenceText(agent.integrityReport.summary, 1_000, report),
        checks: asArray(agent.integrityReport.checks).slice(0, 24).map((check) => ({
          ...check,
          command: sanitizeChecklistEvidenceText(check.command, 1_000, report),
          outputSnippet: sanitizeChecklistEvidenceText(check.outputSnippet, 1_000, report)
        })),
        risks: asArray(agent.integrityReport.risks).slice(0, 24).map((risk) => sanitizeChecklistEvidenceText(risk, 800, report))
      }
      : agent.integrityReport,
    mergeReport: agent.mergeReport
      ? {
        ...agent.mergeReport,
        summary: sanitizeChecklistEvidenceText(agent.mergeReport.summary, 1_000, report),
        mergedBranches: asArray(agent.mergeReport.mergedBranches).slice(0, 40),
        conflicts: asArray(agent.mergeReport.conflicts).slice(0, 80).map((conflict) => sanitizeChecklistEvidenceText(conflict, 500, report))
      }
      : agent.mergeReport,
    recommendationReport: agent.recommendationReport
      ? {
        ...agent.recommendationReport,
        summary: sanitizeChecklistEvidenceText(agent.recommendationReport.summary, 1_000, report),
        nextSteps: asArray(agent.recommendationReport.nextSteps).slice(0, 8).map((step) => sanitizeRecommendation({
          ...step,
          id: `${agent.id}:${step.rank}`,
          sourceWorkPackageId: undefined,
          targetedCheckIds: undefined
        }, report))
      }
      : agent.recommendationReport
  };
};

const sanitizeAgents = (agents: AgentState[], report: StateSanitizerReport): AgentState[] => {
  const sortedAgents = asArray(agents).sort((left, right) => agentSortTime(right) - agentSortTime(left));
  const fullDetailAgentIds = new Set(
    sortedAgents
      .filter((agent, index) =>
        index < FULL_AGENT_DETAILS_MAX ||
        isAgentActive(agent) ||
        asArray(agent.approvals).some((approval) => approval.status === "pending")
      )
      .map((agent) => agent.id)
  );
  const allowedEventKeys = new Set(
    sortedAgents
      .flatMap((agent) =>
        asArray(agent.events).map((event, index) => ({
          key: eventKey(agent, event, index),
          time: toTime(event.timestamp),
          agent
        }))
      )
      .filter(({ agent }) => fullDetailAgentIds.has(agent.id))
      .sort((left, right) => right.time - left.time)
      .slice(0, AGENT_EVENTS_MAX_TOTAL)
      .map((entry) => entry.key)
  );
  const allowedCommandKeys = new Set(
    sortedAgents
      .flatMap((agent) =>
        asArray(agent.commandLog).map((command, index) => ({
          key: commandKey(agent, command, index),
          time: toTime(command.completedAt ?? command.startedAt),
          agent
        }))
      )
      .filter(({ agent }) => fullDetailAgentIds.has(agent.id))
      .sort((left, right) => right.time - left.time)
      .slice(0, AGENT_COMMANDS_MAX_TOTAL)
      .map((entry) => entry.key)
  );

  return asArray(agents).map((agent) =>
    sanitizeAgent(agent, report, {
      compactDetails: !fullDetailAgentIds.has(agent.id),
      allowedEventKeys,
      allowedCommandKeys
    })
  );
};

export const sanitizeProjectRecord = (
  record: LocalProjectRecord,
  options: { renderer?: boolean } = {}
): { record: LocalProjectRecord; report: StateSanitizerReport } => {
  const report = emptyReport();
  const workflow = (record as { workflow?: ProjectWorkflowState }).workflow;
  const next: LocalProjectRecord = {
    ...record,
    workflow: workflow ? sanitizeWorkflowState(workflow, report, options) : (workflow as unknown as ProjectWorkflowState),
    agents: options.renderer ? asArray(record.agents) : sanitizeAgents(record.agents ?? [], report),
    summaryCache: options.renderer ? asArray(record.summaryCache).slice(0, 80) : record.summaryCache,
    dependencies: options.renderer ? asArray(record.dependencies).slice(0, 80) : record.dependencies,
    userInputRequests: (record.userInputRequests ?? []).slice(0, options.renderer ? 40 : 200).map((request) => ({
      ...request,
      title: sanitizeChecklistEvidenceText(request.title, 240, report),
      description: sanitizeChecklistEvidenceText(request.description, 800, report),
      questions: asArray(request.questions).slice(0, 20).map((question) => ({
        ...question,
        question: sanitizeChecklistEvidenceText(question.question, 800, report),
        options: asArray(question.options).slice(0, 8).map((option) => ({
          ...option,
          description: sanitizeChecklistEvidenceText(option.description, 500, report)
        }))
      })),
      attachments: asArray(request.attachments).slice(0, 80)
    })),
    credentials: {
      ...record.credentials,
      entries: (record.credentials?.entries ?? []).slice(0, options.renderer ? 80 : 200).map((entry) => ({
        ...entry,
        notes: entry.notes ? sanitizeChecklistEvidenceText(entry.notes, 500, report) : entry.notes,
        linkedRequestIds: asArray(entry.linkedRequestIds).slice(0, 40)
      })),
      requests: (record.credentials?.requests ?? []).slice(0, options.renderer ? 80 : 200).map((request) => ({
        ...request,
        description: sanitizeChecklistEvidenceText(request.description, 800, report),
        notes: request.notes ? sanitizeChecklistEvidenceText(request.notes, 500, report) : request.notes
      }))
    }
  };

  return { record: next, report };
};
