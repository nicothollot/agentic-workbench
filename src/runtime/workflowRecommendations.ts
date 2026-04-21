import path from "node:path";
import { nanoid } from "nanoid";
import type {
  AgentState,
  GoalAttainmentCheck,
  GoalCheckSource,
  GoalCheckStatus,
  ProjectOverview,
  ProjectWorkflowState,
  UltimateGoal,
  UltimateGoalCompletionState,
  WorkflowObjective,
  UltimateGoalProgressEstimate,
  WorkflowRecommendationOption
} from "@shared/types";
import { nowIso } from "@shared/utils";
import type { RepoScanResult } from "./repoScanner";
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

const statusRank: Record<GoalCheckStatus, number> = {
  unknown: 0,
  unmet: 1,
  not_applicable: 2,
  met: 3
};

const requiredUserGoalCheckSources = new Set<GoalCheckSource>(["success_criterion", "quality_bar", "constraint"]);

const isRequiredForCompletion = (check: GoalAttainmentCheck): boolean =>
  check.required && check.status !== "not_applicable";

const isMetForCompletion = (check: GoalAttainmentCheck): boolean => check.status === "met";

export interface GoalCheckUpdateInput {
  action?: "add" | "update" | "remove";
  id?: string;
  title: string;
  description?: string;
  required?: boolean;
  status?: GoalCheckStatus;
  confidence?: number;
  evidence?: string;
  relatedPaths?: string[];
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
    return {
      ...found,
      id,
      title: normalizedTitle,
      description: description.trim() || found.description,
      required,
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
    required,
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
      checks.push({
        ...check,
        relatedPaths: check.relatedPaths ?? [],
        createdAt: check.createdAt || timestamp,
        updatedAt: check.updatedAt || timestamp
      });
      usedIds.add(check.id);
    }
  }

  return checks;
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

  return checks;
};

export const applyGoalChecklistUpdates = (
  checklist: GoalAttainmentCheck[],
  updates: GoalCheckUpdateInput[],
  options: {
    timestamp?: string;
    ownerAgentId?: string;
  } = {}
): GoalAttainmentCheck[] => {
  const timestamp = options.timestamp ?? nowIso();
  const next = checklist.map((check) => ({ ...check, relatedPaths: [...(check.relatedPaths ?? [])] }));

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
          evidence: update.evidence?.trim() || "An agent marked this user-derived check as not applicable.",
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
    let evidence = update.evidence?.trim() ?? existing?.evidence ?? "";
    if (status === "met" && !evidence) {
      status = "unknown";
      evidence = "An agent tried to mark this met without evidence, so the check remains unknown.";
    }

    const merged: GoalAttainmentCheck = {
      id: existing?.id ?? id,
      title: existing?.title ?? title,
      description: update.description?.trim() ?? existing?.description ?? "",
      required: update.required ?? existing?.required ?? true,
      status,
      confidence: update.confidence ?? existing?.confidence,
      evidence,
      source: existing?.source ?? "agent",
      relatedPaths: unique([...(existing?.relatedPaths ?? []), ...(update.relatedPaths ?? [])]).slice(0, 8),
      ownerAgentId: options.ownerAgentId ?? existing?.ownerAgentId,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt:
        existing &&
        existing.status === status &&
        existing.evidence === evidence &&
        existing.required === (update.required ?? existing.required)
          ? existing.updatedAt
          : timestamp
    };

    if (index >= 0) {
      next[index] = merged;
    } else {
      next.push(merged);
    }
  }

  return next.sort((left, right) => {
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
  preferredPaths: string[]
): string[] => {
  const keywords = topGoalKeywords(context);
  const entryPoints = new Set(context.scan.stats.entryPoints);
  const preferred = new Set(preferredPaths);

  return context.scan.files
    .map((file) => {
      let score = 0;
      if (preferred.has(file.relativePath)) {
        score += 8;
      }
      if (entryPoints.has(file.relativePath)) {
        score += 3;
      }
      if (/\.(test|spec)\./.test(file.relativePath)) {
        score += 1;
      }
      for (const keyword of keywords) {
        if (file.relativePath.toLowerCase().includes(keyword)) {
          score += 3;
        } else if (path.basename(file.relativePath).toLowerCase().includes(keyword)) {
          score += 2;
        }
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
  const unmetPreview = checklistProgress.unmet.slice(0, 4).map((check) => check.title);
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

const firstUnmetRequiredGoalCheck = (context: WorkflowRecommendationContext): GoalAttainmentCheck | undefined => {
  const checklist = buildGoalChecklistForAssessment(context);
  return checklist
    .filter((check) => isRequiredForCompletion(check) && !isMetForCompletion(check))
    .sort((left, right) => statusRank[left.status] - statusRank[right.status] || left.title.localeCompare(right.title))[0];
};

const goalCheckRecommendationSummary = (check: GoalAttainmentCheck): string => {
  const basis = check.description || check.title;
  return check.status === "unknown"
    ? `Gather implementation and validation evidence for this required check: ${basis}`
    : `Fix the unmet required check and update the goal checklist with evidence: ${basis}`;
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
      relatedPaths: draft.relatedPaths
    }))
    .map((entry) => sanitizeRecommendationForCycle(entry))
    .filter((entry): entry is WorkflowRecommendationOption => Boolean(entry))
    .slice(0, Math.max(1, Math.min(context.maxOptions, 3)))
    .map((entry, index) => ({
      ...entry,
      rank: index + 1
    }));
};

export const buildWorkflowRecommendations = (context: WorkflowRecommendationContext): WorkflowRecommendationOption[] => {
  const recentChangedFiles = collectRecentChangedFiles(context.agents);
  const openIssues = context.workflow.memory.knownOpenIssues.filter((issue) => issue.status === "open");
  const pendingInterventions = context.workflow.humanInterventions.filter((intervention) => intervention.status === "pending");
  const relevantPaths = rankRelevantPaths(context, recentChangedFiles);
  const focusArea = toAreaLabel(relevantPaths[0] ?? recentChangedFiles[0] ?? context.scan.stats.entryPoints[0]);
  const latestCycleSummary = context.workflow.memory.perCycleSummaries[0];
  const lastDecision = context.workflow.memory.lastAcceptedDecisions[0];
  const customFocus = normalizeCustomFocus(context.customFocus);
  const unmetGoalCheck = firstUnmetRequiredGoalCheck(context);
  const drafts: RecommendationDraft[] = [];

  if (customFocus) {
    pushDraft(drafts, {
      key: `custom:implement:${customFocus}`,
      score: 110,
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
      score: 106,
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
      score: 102,
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
      score: 100,
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
      score: 94,
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

  if (unmetGoalCheck) {
    pushDraft(drafts, {
      key: `goal-check:${unmetGoalCheck.id}`,
      score: 92,
      title: `Satisfy goal check: ${truncate(unmetGoalCheck.title, 72)}`,
      summary: goalCheckRecommendationSummary(unmetGoalCheck),
      rationale: goalCheckRecommendationRationale(unmetGoalCheck),
      expectedImpact: "This moves the Ultimate Goal percentage by converting an explicit required check into evidenced completion.",
      priority: "high",
      confidence: unmetGoalCheck.status === "unmet" ? 0.92 : 0.84,
      estimatedScope: "small",
      riskLevel: unmetGoalCheck.status === "unmet" ? "medium" : "low",
      relatedPaths: unmetGoalCheck.relatedPaths.length > 0 ? unmetGoalCheck.relatedPaths.slice(0, 4) : relevantPaths.slice(0, 4)
    });
  }

  if (recentChangedFiles.length > 0) {
    pushDraft(drafts, {
      key: `changes:${recentChangedFiles.slice(0, 3).join(",")}`,
      score: 88,
      title: `Stabilize recent work in ${focusArea}`,
      summary: `Review the latest agent changes and close the loop around ${recentChangedFiles.slice(0, 3).join(", ")}.`,
      rationale: "The repository already has fresh changes, so the highest-leverage next step is usually to validate and tighten what is already in motion.",
      expectedImpact: "This converts partial progress into durable progress instead of letting recent work sprawl across multiple cycles.",
      priority: "high",
      confidence: 0.9,
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
      relatedPaths: draft.relatedPaths
    }))
    .map((entry) => sanitizeRecommendationForCycle(entry))
    .filter((entry): entry is WorkflowRecommendationOption => Boolean(entry))
    .slice(0, Math.max(1, Math.min(context.maxOptions, 5)))
    .map((entry, index) => ({
      ...entry,
      rank: index + 1
    }));
};
