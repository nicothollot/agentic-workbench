import { nanoid } from "nanoid";
import type {
  AgentState,
  ProjectWorkflowState,
  WorkflowExecutionState,
  WorkflowIncident,
  WorkflowIncidentAction,
  WorkflowIncidentKind,
  WorkflowIncidentSeverity,
  WorkflowJournalEvent,
  WorkflowJournalEventKind,
  WorkflowStepId,
  WorkflowValidationKind
} from "./types";
import { WORKFLOW_SCHEMA_VERSION } from "./types";
import { nowIso, unique } from "./utils";

const activeAgentStatuses = new Set<AgentState["status"]>(["starting", "running", "waiting_approval"]);

const toTime = (value?: string): number => value ? Date.parse(value) || 0 : 0;

const stepForAgentCategory = (category: AgentState["category"], agentName?: string): WorkflowStepId | undefined => {
  switch (category) {
    case "recommendation": return "recommendation";
    case "coding": return "coding";
    case "integrity": return "integrity";
    case "merge": return "merge";
    case "goal": return agentName === "Ultimate Goal Agent" ? "ultimate_goal" : "goal_plan";
    case "bootstrap": return "ultimate_goal";
    case "manual": return "coding";
  }
};

const stepForAgent = (agent: AgentState): WorkflowStepId | undefined =>
  agent.category === "bootstrap" || agent.category === "manual"
    ? undefined
    : stepForAgentCategory(agent.category, agent.name);

const tagForStep = (stepId: WorkflowStepId): NonNullable<WorkflowExecutionState["resumeTag"]> => {
  switch (stepId) {
    case "ultimate_goal": return "needs_goal";
    case "recommendation": return "recommending";
    case "goal_plan": return "planning";
    case "coding": return "coding";
    case "integrity": return "validating";
    case "merge": return "merging";
  }
};

const activeCycleAgent = (workflow: ProjectWorkflowState, agents: AgentState[]): AgentState | undefined =>
  agents
    .filter((agent) =>
      agent.category !== "manual" &&
      agent.category !== "bootstrap" &&
      activeAgentStatuses.has(agent.status) &&
      (agent.workflowCycleNumber === undefined || agent.workflowCycleNumber === workflow.workflowCycle.cycleNumber)
    )
    .sort((left, right) => toTime(right.lastActivityAt ?? right.startedAt ?? right.createdAt) - toTime(left.lastActivityAt ?? left.startedAt ?? left.createdAt))[0];

export interface WorkflowExecutionProjectionOptions {
  workflowPauseRequested?: boolean;
  now?: string;
}

export const projectWorkflowExecution = (
  workflow: ProjectWorkflowState,
  agents: AgentState[],
  options: WorkflowExecutionProjectionOptions = {}
): Omit<WorkflowExecutionState, "schemaVersion" | "revision" | "enteredAt" | "updatedAt"> => {
  const cycleNumber = workflow.workflowCycle.cycleNumber;
  const activeIncident = (workflow.incidents ?? []).find((incident) =>
    incident.cycleNumber === cycleNumber && (incident.status === "open" || incident.status === "resolving")
  );
  const activeAgent = activeCycleAgent(workflow, agents);
  const activeStep = activeAgent ? stepForAgent(activeAgent) : undefined;
  const pendingApprovalAgent = agents.find((agent) =>
    (agent.workflowCycleNumber === undefined || agent.workflowCycleNumber === cycleNumber) &&
    agent.approvals.some((approval) => approval.status === "pending")
  );

  if (pendingApprovalAgent) {
    const stepId = stepForAgent(pendingApprovalAgent) ?? "coding";
    return {
      cycleNumber,
      tag: "awaiting_approval",
      stepId,
      activeAgentId: pendingApprovalAgent.id,
      activeRunId: pendingApprovalAgent.threadId,
      incidentId: activeIncident?.id,
      resumeTag: tagForStep(stepId)
    };
  }

  const blockingIntervention = workflow.humanInterventions.find((entry) => entry.blocking && entry.status === "pending");
  if (blockingIntervention) {
    const stepId = stepForAgentCategory(blockingIntervention.requestedByAgentCategory) ?? activeStep ?? "coding";
    return {
      cycleNumber,
      tag: "awaiting_human",
      stepId,
      activeAgentId: activeAgent?.id,
      activeRunId: activeAgent?.threadId,
      repairAttempt: workflow.repair.attemptCount || undefined,
      maxRepairAttempts: workflow.repair.maxAttempts,
      incidentId: activeIncident?.id,
      resumeTag: tagForStep(stepId)
    };
  }

  if (activeAgent && activeStep) {
    const tag = workflow.repair.status === "repairing" && activeStep === "coding"
      ? "repairing"
      : workflow.repair.status === "retrying_validation" && activeStep === "integrity"
        ? "validating"
        : tagForStep(activeStep);
    return {
      cycleNumber,
      tag,
      stepId: activeStep,
      activeAgentId: activeAgent.id,
      activeRunId: activeAgent.threadId,
      repairAttempt: workflow.repair.attemptCount || undefined,
      maxRepairAttempts: workflow.repair.maxAttempts,
      validationKind: tag === "validating" && workflow.repair.status === "retrying_validation" ? "repair" : tag === "validating" ? "initial" : undefined,
      incidentId: activeIncident?.id
    };
  }

  if (workflow.manualHandoff || workflow.repair.status === "exhausted" || workflow.repair.status === "merge_conflicts") {
    const stepId: WorkflowStepId = workflow.repair.status === "merge_conflicts" || workflow.manualHandoff?.reason === "merge_conflicts"
      ? "merge"
      : "integrity";
    return {
      cycleNumber,
      tag: "awaiting_human",
      stepId,
      repairAttempt: workflow.repair.attemptCount || undefined,
      maxRepairAttempts: workflow.repair.maxAttempts,
      incidentId: activeIncident?.id,
      resumeTag: tagForStep(stepId)
    };
  }

  if (options.workflowPauseRequested || workflow.autopilotStatus?.pausedReason) {
    const stepId = workflow.workflowStage === "ready_to_merge" || workflow.workflowStage === "merged" ? "merge"
      : workflow.workflowStage === "integrity_running" ? "integrity"
      : workflow.scopedGoal ? "coding"
      : workflow.approvedRecommendation ? "goal_plan"
      : workflow.ultimateGoal.confirmedAt ? "recommendation"
      : "ultimate_goal";
    return { cycleNumber, tag: "paused", stepId, incidentId: activeIncident?.id, resumeTag: tagForStep(stepId) };
  }

  if (workflow.repair.status === "repairing") {
    return { cycleNumber, tag: "repairing", stepId: "coding", repairAttempt: workflow.repair.attemptCount, maxRepairAttempts: workflow.repair.maxAttempts, incidentId: activeIncident?.id };
  }
  if (workflow.repair.status === "retrying_validation") {
    const external = workflow.repair.latestFailureReason?.startsWith("External repair completed") ?? false;
    return {
      cycleNumber,
      tag: "validating",
      stepId: "integrity",
      repairAttempt: workflow.repair.attemptCount,
      maxRepairAttempts: workflow.repair.maxAttempts,
      validationKind: external ? "external_repair" : "repair",
      incidentId: activeIncident?.id
    };
  }

  switch (workflow.workflowStage) {
    case "charter_needed": return { cycleNumber, tag: "needs_goal", stepId: "ultimate_goal" };
    case "recommendation_pending": return { cycleNumber, tag: workflow.recommendations.length ? "awaiting_recommendation" : "recommending", stepId: "recommendation" };
    case "recommendation_approved": return { cycleNumber, tag: "planning", stepId: "goal_plan" };
    case "goal_ready": return { cycleNumber, tag: "coding", stepId: "coding" };
    case "coding_running": return { cycleNumber, tag: "coding", stepId: "coding" };
    case "integrity_running": return { cycleNumber, tag: "validating", stepId: "integrity", validationKind: "initial" };
    case "repair_loop": return { cycleNumber, tag: "repairing", stepId: "coding", repairAttempt: workflow.repair.attemptCount, maxRepairAttempts: workflow.repair.maxAttempts };
    case "ready_to_merge": return { cycleNumber, tag: "merging", stepId: "merge" };
    case "merged": return { cycleNumber, tag: "cycle_complete", stepId: "merge" };
    case "appeal_pending": return { cycleNumber, tag: "awaiting_recommendation", stepId: "recommendation" };
    case "blocked_human": return { cycleNumber, tag: "awaiting_human", stepId: "coding" };
    case "cycle_complete": return {
      cycleNumber,
      tag: workflow.ultimateGoalCompletion?.state === "goal_satisfied" ? "goal_complete" : "cycle_complete",
      stepId: "merge"
    };
  }
};

const executionComparable = (value: Omit<WorkflowExecutionState, "schemaVersion" | "revision" | "enteredAt" | "updatedAt">): string =>
  JSON.stringify(value);

export const synchronizeWorkflowExecution = (
  workflow: ProjectWorkflowState,
  agents: AgentState[],
  options: WorkflowExecutionProjectionOptions = {}
): WorkflowExecutionState => {
  const now = options.now ?? nowIso();
  const projected = projectWorkflowExecution(workflow, agents, options);
  const current = workflow.execution;
  const currentProjected = current ? {
    cycleNumber: current.cycleNumber,
    tag: current.tag,
    stepId: current.stepId,
    activeAgentId: current.activeAgentId,
    activeRunId: current.activeRunId,
    repairAttempt: current.repairAttempt,
    maxRepairAttempts: current.maxRepairAttempts,
    validationKind: current.validationKind,
    resumeTag: current.resumeTag,
    incidentId: current.incidentId,
    effectKey: current.effectKey
  } : undefined;
  if (current && executionComparable(currentProjected!) === executionComparable(projected)) {
    return current;
  }
  workflow.execution = {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    revision: (current?.revision ?? 0) + 1,
    ...projected,
    enteredAt: now,
    updatedAt: now
  };
  workflow.journal ??= [];
  appendWorkflowJournalEvent(workflow, {
    kind: "transition",
    status: projected.tag === "cycle_complete" || projected.tag === "goal_complete"
      ? "completed"
      : projected.tag === "awaiting_approval" || projected.tag === "awaiting_human" || projected.tag === "paused"
        ? "waiting"
        : "running",
    stepId: projected.stepId,
    title: current ? `${current.tag} → ${projected.tag}` : `Workflow entered ${projected.tag}`,
    summary: projected.incidentId
      ? `Execution is linked to incident ${projected.incidentId}.`
      : `Canonical workflow execution revision ${workflow.execution.revision}.`,
    incidentId: projected.incidentId,
    occurredAt: now
  });
  return workflow.execution;
};

const normalizeFingerprintPart = (value: string): string =>
  value.toLowerCase().replace(/\b[0-9a-f]{7,}\b/g, "sha").replace(/\d+/g, "n").replace(/[^a-z0-9/_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 140);

export const workflowIncidentFingerprint = (
  cycleNumber: number,
  kind: WorkflowIncidentKind,
  rootCause: string,
  involvedPaths: string[] = []
): string => [cycleNumber, kind, normalizeFingerprintPart(rootCause), ...involvedPaths.map(normalizeFingerprintPart).sort().slice(0, 4)].join(":");

export interface UpsertWorkflowIncidentInput {
  kind: WorkflowIncidentKind;
  severity: WorkflowIncidentSeverity;
  sourceStep: WorkflowStepId;
  title: string;
  summary: string;
  rootCause: string;
  evidenceRefs?: string[];
  involvedPaths?: string[];
  automaticActions?: string[];
  nextSystemAction?: string;
  userActionRequired?: string;
  primaryAction?: WorkflowIncidentAction;
  secondaryActions?: WorkflowIncidentAction[];
  status?: WorkflowIncident["status"];
  now?: string;
}

export const upsertWorkflowIncident = (
  workflow: ProjectWorkflowState,
  input: UpsertWorkflowIncidentInput
): WorkflowIncident => {
  const now = input.now ?? nowIso();
  const involvedPaths = unique(input.involvedPaths ?? []).slice(0, 24);
  const fingerprint = workflowIncidentFingerprint(workflow.workflowCycle.cycleNumber, input.kind, input.rootCause, involvedPaths);
  const existing = workflow.incidents.find((incident) => incident.fingerprint === fingerprint && (incident.status === "open" || incident.status === "resolving"));
  if (existing) {
    Object.assign(existing, {
      severity: input.severity,
      status: input.status ?? existing.status,
      title: input.title,
      summary: input.summary,
      rootCause: input.rootCause,
      evidenceRefs: unique([...existing.evidenceRefs, ...(input.evidenceRefs ?? [])]).slice(0, 40),
      involvedPaths,
      automaticActions: unique([...existing.automaticActions, ...(input.automaticActions ?? [])]).slice(0, 20),
      nextSystemAction: input.nextSystemAction,
      userActionRequired: input.userActionRequired,
      primaryAction: input.primaryAction,
      secondaryActions: input.secondaryActions ?? existing.secondaryActions,
      occurrenceCount: existing.occurrenceCount + 1,
      updatedAt: now
    });
    return existing;
  }
  const incident: WorkflowIncident = {
    id: nanoid(),
    fingerprint,
    cycleNumber: workflow.workflowCycle.cycleNumber,
    kind: input.kind,
    severity: input.severity,
    status: input.status ?? "open",
    sourceStep: input.sourceStep,
    title: input.title,
    summary: input.summary,
    rootCause: input.rootCause,
    evidenceRefs: unique(input.evidenceRefs ?? []).slice(0, 40),
    involvedPaths,
    automaticActions: unique(input.automaticActions ?? []).slice(0, 20),
    nextSystemAction: input.nextSystemAction,
    userActionRequired: input.userActionRequired,
    primaryAction: input.primaryAction,
    secondaryActions: input.secondaryActions ?? [],
    occurrenceCount: 1,
    openedAt: now,
    updatedAt: now
  };
  workflow.incidents.unshift(incident);
  workflow.incidents = workflow.incidents.slice(0, 200);
  return incident;
};

export const resolveWorkflowIncidents = (
  workflow: ProjectWorkflowState,
  predicate: (incident: WorkflowIncident) => boolean,
  status: "resolved" | "superseded" = "resolved",
  now = nowIso()
): WorkflowIncident[] => {
  const resolved: WorkflowIncident[] = [];
  for (const incident of workflow.incidents) {
    if ((incident.status === "open" || incident.status === "resolving") && predicate(incident)) {
      incident.status = status;
      incident.updatedAt = now;
      incident.resolvedAt = now;
      resolved.push(incident);
    }
  }
  return resolved;
};

export const markWorkflowIncidentsResolving = (
  workflow: ProjectWorkflowState,
  predicate: (incident: WorkflowIncident) => boolean,
  nextSystemAction: string,
  now = nowIso()
): WorkflowIncident[] => {
  const resolving: WorkflowIncident[] = [];
  for (const incident of workflow.incidents) {
    if ((incident.status === "open" || incident.status === "resolving") && predicate(incident)) {
      incident.status = "resolving";
      incident.userActionRequired = undefined;
      incident.primaryAction = undefined;
      incident.nextSystemAction = nextSystemAction;
      incident.updatedAt = now;
      incident.resolvedAt = undefined;
      resolving.push(incident);
    }
  }
  return resolving;
};

export const appendWorkflowJournalEvent = (
  workflow: ProjectWorkflowState,
  input: {
    kind: WorkflowJournalEventKind;
    status: WorkflowJournalEvent["status"];
    stepId: WorkflowStepId;
    title: string;
    summary?: string;
    agentId?: string;
    incidentId?: string;
    evidenceRefs?: string[];
    occurredAt?: string;
  }
): WorkflowJournalEvent => {
  const latest = workflow.journal[0];
  if (
    latest && latest.kind === input.kind && latest.status === input.status && latest.stepId === input.stepId &&
    latest.title === input.title && latest.summary === input.summary && latest.agentId === input.agentId && latest.incidentId === input.incidentId
  ) {
    return latest;
  }
  const event: WorkflowJournalEvent = {
    id: nanoid(),
    sequence: (workflow.journal[0]?.sequence ?? 0) + 1,
    cycleNumber: workflow.workflowCycle.cycleNumber,
    kind: input.kind,
    status: input.status,
    stepId: input.stepId,
    title: input.title,
    summary: input.summary,
    agentId: input.agentId,
    incidentId: input.incidentId,
    evidenceRefs: unique(input.evidenceRefs ?? []).slice(0, 30),
    occurredAt: input.occurredAt ?? nowIso()
  };
  workflow.journal.unshift(event);
  workflow.journal = workflow.journal.slice(0, 1_000);
  return event;
};

export const ensureWorkflowV2State = (
  workflow: ProjectWorkflowState,
  agents: AgentState[] = [],
  options: WorkflowExecutionProjectionOptions = {}
): ProjectWorkflowState => {
  const now = options.now ?? nowIso();
  workflow.schemaVersion = WORKFLOW_SCHEMA_VERSION;
  workflow.incidents ??= [];
  workflow.journal ??= [];
  workflow.metrics ??= {
    totalInputTokens: 0,
    totalCachedInputTokens: 0,
    totalOutputTokens: 0,
    totalReasoningTokens: 0,
    totalTokens: 0
  };
  if (workflow.journal.length === 0 && workflow.activityLog.length > 0) {
    for (const entry of [...workflow.activityLog].reverse()) {
      appendWorkflowJournalEvent(workflow, {
        kind: entry.source === "validation" ? "validation" : entry.source === "approval" ? "approval" : entry.source === "agent" ? "agent" : "system",
        status: entry.status,
        stepId: entry.stepId ?? "recommendation",
        title: entry.title,
        summary: entry.detail,
        agentId: entry.agentId,
        occurredAt: entry.timestamp
      });
    }
    appendWorkflowJournalEvent(workflow, {
      kind: "migration",
      status: "completed",
      stepId: workflow.execution?.stepId ?? "recommendation",
      title: "Workflow state upgraded to v2",
      summary: "Legacy activity and execution state were migrated without discarding history.",
      occurredAt: now
    });
  }
  synchronizeWorkflowExecution(workflow, agents, { ...options, now });
  return workflow;
};

export const workflowValidationKindForRepair = (workflow: ProjectWorkflowState): WorkflowValidationKind =>
  workflow.repair.latestFailureReason?.startsWith("External repair completed") ? "external_repair" : "repair";
