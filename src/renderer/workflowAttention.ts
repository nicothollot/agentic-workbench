import type {
  AgentState,
  ApprovalRequestRecord,
  CredentialRequestRecord,
  HumanInterventionRecord,
  ProjectWorkflowState,
  UserInputRequestRecord
} from "@shared/types";
import { canRevalidateExternalRepair } from "@shared/workflowView";

type WorkflowTimelineWarning = {
  id: string;
  title: string;
  warning?: string;
  updatedAt?: string;
  lastEventAt?: string;
};

export type WorkflowAttentionItem = {
  id: string;
  kind: "approval" | "blocker" | "credential" | "integrity" | "warning";
  title: string;
  detail: string;
  tone: "neutral" | "warning" | "danger";
  createdAt?: string;
  approval?: ApprovalRequestRecord;
  manualHandoff?: NonNullable<ProjectWorkflowState["manualHandoff"]>;
  target?: "credentials" | "user-input" | "blocker" | "manual-handoff";
};

const summarizeAttentionText = (value?: string, fallback = "Not available", maxLength = 180): string => {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return fallback;
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }

  const prefix = normalized.slice(0, maxLength);
  const sentenceEnd = prefix.lastIndexOf(". ");
  const cutIndex = sentenceEnd > 80 ? sentenceEnd + 1 : prefix.lastIndexOf(" ");
  const safeCut = cutIndex > 80 ? cutIndex : maxLength;
  return `${prefix.slice(0, safeCut).trim().replace(/[.,;:]+$/, "")}...`;
};

const attentionTime = (value?: string): number => {
  if (!value) {
    return 0;
  }

  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
};

const attentionFingerprint = (item: WorkflowAttentionItem): string =>
  `${item.title}\n${item.detail}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const agentAttentionTime = (agent: AgentState): number =>
  attentionTime(
    agent.integrityReport?.generatedAt ??
    agent.completedAt ??
    agent.lastActivityAt ??
    agent.startedAt ??
    agent.createdAt
  );

const activeAgentStatuses = new Set<AgentState["status"]>(["starting", "running", "waiting_approval"]);

const workflowStopReasonAttentionLabel = (reason?: string): string =>
  ({
    none: "No blocker",
    charter_missing: "Open Settings to set the Ultimate Goal",
    recommendation_missing: "Run recommendations for the next cycle",
    awaiting_recommendation_approval: "Approve one recommended next step",
    goal_not_scoped: "Turn the approved recommendation into a scoped goal",
    human_intervention_required: "A blocking human intervention is pending",
    integrity_failed: "Integrity validation found follow-up work",
    repair_stopped_early: "Automatic repair stopped early",
    repair_budget_exhausted: "Automatic repair limit reached",
    merge_conflicts: "Merge conflicts require follow-up",
    appeal_missing: "Prepare final appeal pass",
    awaiting_appeal_approval: "Approve one appeal improvement",
    ultimate_goal_satisfied: "Ultimate Goal satisfied",
    cycle_completed: "Cycle complete"
  })[reason ?? "none"] ?? reason ?? "No blocker";

export const buildWorkflowAttentionItems = ({
  workflow,
  approvals,
  userInputRequests,
  humanInterventions,
  credentialRequests,
  timeline,
  agents
}: {
  workflow?: ProjectWorkflowState;
  approvals: ApprovalRequestRecord[];
  userInputRequests: UserInputRequestRecord[];
  humanInterventions: HumanInterventionRecord[];
  credentialRequests: CredentialRequestRecord[];
  timeline: WorkflowTimelineWarning[];
  agents: AgentState[];
}): WorkflowAttentionItem[] => {
  const items: WorkflowAttentionItem[] = [];
  const credentialLinkedUserInputIds = new Set(
    credentialRequests.map((request) => request.userInputRequestId).filter((id): id is string => Boolean(id))
  );
  const linkedHumanInterventionIds = new Set([
    ...userInputRequests.map((request) => request.humanInterventionId).filter((id): id is string => Boolean(id)),
    ...credentialRequests.map((request) => request.humanInterventionId).filter((id): id is string => Boolean(id))
  ]);
  const currentCycleIncidents = (workflow?.incidents ?? []).filter((incident) =>
    incident.cycleNumber === workflow?.workflowCycle.cycleNumber &&
    (incident.status === "open" || (incident.status === "resolving" && Boolean(incident.userActionRequired)))
  );
  const incidentEvidenceRefs = new Set(currentCycleIncidents.flatMap((incident) => incident.evidenceRefs));
  const incidentKinds = new Set(currentCycleIncidents.map((incident) => incident.kind));

  for (const incident of currentCycleIncidents) {
    const approvalId = incident.evidenceRefs.find((reference) => reference.startsWith("approval:"))?.slice("approval:".length);
    const approval = approvalId ? approvals.find((entry) => entry.id === approvalId) : undefined;
    items.push({
      id: `incident:${incident.id}`,
      kind: incident.kind === "approval"
        ? "approval"
        : incident.kind === "credential"
          ? "credential"
          : incident.kind === "validation" || incident.kind === "environment" || incident.kind === "hygiene"
            ? "integrity"
            : "blocker",
      title: incident.title,
      detail: summarizeAttentionText(
        incident.userActionRequired ?? incident.nextSystemAction ?? incident.rootCause ?? incident.summary,
        "Review the incident evidence before continuing.",
        160
      ),
      tone: incident.severity === "critical" || incident.severity === "high"
        ? "danger"
        : incident.severity === "warning"
          ? "warning"
          : "neutral",
      createdAt: incident.openedAt,
      approval,
      manualHandoff: incident.kind === "merge_conflict" || incident.kind === "validation" || incident.kind === "environment"
        ? workflow?.manualHandoff
        : undefined,
      target: incident.kind === "credential"
        ? "credentials"
        : incident.kind === "user_input"
          ? "user-input"
          : incident.kind === "merge_conflict" || incident.kind === "validation" || incident.kind === "environment"
            ? workflow?.manualHandoff ? "manual-handoff" : "blocker"
            : "blocker"
    });
  }

  for (const approval of approvals) {
    if (incidentEvidenceRefs.has(`approval:${approval.id}`)) {
      continue;
    }
    items.push({
      id: `approval:${approval.id}`,
      kind: "approval",
      title: approval.summary,
      detail: summarizeAttentionText(approval.reason ?? approval.command ?? "Approval required before the workflow can continue.", "Approval required.", 130),
      tone: "warning",
      createdAt: approval.createdAt,
      approval
    });
  }

  for (const intervention of humanInterventions) {
    if (linkedHumanInterventionIds.has(intervention.id) || incidentEvidenceRefs.has(`intervention:${intervention.id}`)) {
      continue;
    }
    items.push({
      id: `intervention:${intervention.id}`,
      kind: "blocker",
      title: intervention.title,
      detail: summarizeAttentionText(intervention.description || intervention.reason, "Human intervention is required.", 140),
      tone: intervention.blocking ? "danger" : "warning",
      createdAt: intervention.createdAt,
      target: "blocker"
    });
  }

  for (const request of userInputRequests) {
    if (
      credentialLinkedUserInputIds.has(request.id) ||
      Boolean(request.humanInterventionId && incidentEvidenceRefs.has(`intervention:${request.humanInterventionId}`))
    ) {
      continue;
    }
    items.push({
      id: `user-input:${request.id}`,
      kind: "blocker",
      title: request.title,
      detail: summarizeAttentionText(request.description, "External action is required.", 140),
      tone: "danger",
      createdAt: request.createdAt,
      target: "user-input"
    });
  }

  for (const request of credentialRequests) {
    if (request.humanInterventionId && incidentEvidenceRefs.has(`intervention:${request.humanInterventionId}`)) {
      continue;
    }
    items.push({
      id: `credential:${request.id}`,
      kind: "credential",
      title: `${request.providerName} ${request.keyLabel}`,
      detail: summarizeAttentionText(request.description, "Credential is required.", 140),
      tone: "warning",
      createdAt: request.createdAt,
      target: "credentials"
    });
  }

  const repairNeedsRevalidation = !workflow?.manualHandoff && canRevalidateExternalRepair(workflow);
  if (workflow?.manualHandoff && !incidentKinds.has("merge_conflict") && !incidentKinds.has("validation") && !incidentKinds.has("environment") && !incidentKinds.has("hygiene")) {
    items.push({
      id: `manual-handoff:${workflow.manualHandoff.reason}`,
      kind: "blocker",
      title: workflow.manualHandoff.title,
      detail: summarizeAttentionText(workflow.manualHandoff.latestFailureReason, "Manual handoff is required.", 150),
      tone: "danger",
      createdAt: workflow.manualHandoff.createdAt,
      manualHandoff: workflow.manualHandoff,
      target: "manual-handoff"
    });
  } else if (repairNeedsRevalidation) {
    items.push({
      id: "repair:revalidate",
      kind: "integrity",
      title: "Repair needs revalidation",
      detail: summarizeAttentionText(
        workflow?.repair.latestFailureReason ?? workflow?.repair.latestIssueSummary,
        "Run repair revalidation before merge can continue.",
        150
      ),
      tone: "danger",
      createdAt: workflow?.repair.lastUpdatedAt
    });
  } else if (workflow?.workflowStage === "blocked_human" && humanInterventions.length === 0 && userInputRequests.length === 0) {
    items.push({
      id: "workflow:blocker",
      kind: "blocker",
      title: "Workflow is blocked",
      detail: workflowStopReasonAttentionLabel(workflow.workflowStopReason),
      tone: "danger"
    });
  }

  const currentCycleIntegrityAgents = agents
    .filter((agent) =>
      agent.category === "integrity" &&
      Boolean(agent.integrityReport) &&
      (!workflow || agent.workflowCycleNumber === undefined || agent.workflowCycleNumber === workflow.workflowCycle.cycleNumber)
    )
    .sort((left, right) => agentAttentionTime(right) - agentAttentionTime(left));
  const latestIntegrityAgent = currentCycleIntegrityAgents[0];
  const failedIntegrityAgent = latestIntegrityAgent?.integrityReport?.checks.some((check) => check.status === "failed")
    ? latestIntegrityAgent
    : undefined;
  const latestValidationLedger = workflow?.validationLedgers
    .filter((ledger) => ledger.cycleNumber === workflow.workflowCycle.cycleNumber)
    .sort((left, right) => attentionTime(right.updatedAt) - attentionTime(left.updatedAt))[0];
  const repairOrValidationInFlight = Boolean(
    workflow && (
      workflow.repair.status === "repairing" ||
      workflow.repair.status === "retrying_validation" ||
      workflow.workflowStage === "integrity_running" ||
      agents.some((agent) =>
        activeAgentStatuses.has(agent.status) &&
        (agent.workflowCycleNumber === undefined || agent.workflowCycleNumber === workflow.workflowCycle.cycleNumber) &&
        (agent.category === "integrity" || (workflow.workflowStage === "repair_loop" && agent.category === "coding"))
      )
    )
  );
  const integrityFailureResolved = Boolean(
    workflow && (
      workflow.repair.status === "fixed" ||
      workflow.workflowStage === "ready_to_merge" ||
      workflow.workflowStage === "merged" ||
      workflow.workflowStage === "cycle_complete" ||
      (latestIntegrityAgent?.status === "completed" && latestIntegrityAgent.integrityReport && !latestIntegrityAgent.integrityReport.checks.some((check) => check.status === "failed")) ||
      latestValidationLedger?.finalValidationStatus === "passed"
    )
  );
  const hasPrimaryRepairBlocker = Boolean(workflow?.manualHandoff || repairNeedsRevalidation);

  if (!repairOrValidationInFlight && !integrityFailureResolved && !hasPrimaryRepairBlocker && failedIntegrityAgent?.integrityReport) {
    const failedCount = failedIntegrityAgent.integrityReport.checks.filter((check) => check.status === "failed").length;
    items.push({
      id: `integrity-agent:${failedIntegrityAgent.id}`,
      kind: "integrity",
      title: `${failedCount} integrity check${failedCount === 1 ? "" : "s"} failed`,
      detail: summarizeAttentionText(failedIntegrityAgent.integrityReport.summary, "Integrity validation failed.", 150),
      tone: "danger",
      createdAt: failedIntegrityAgent.completedAt ?? failedIntegrityAgent.lastActivityAt
    });
  } else if (
    !repairOrValidationInFlight &&
    !integrityFailureResolved &&
    !hasPrimaryRepairBlocker &&
    (workflow?.stepProgress.integrity.status === "failed" || workflow?.workflowStopReason === "integrity_failed")
  ) {
    items.push({
      id: "integrity:failed",
      kind: "integrity",
      title: "Integrity needs repair",
      detail: summarizeAttentionText(workflow.repair.latestFailureReason ?? workflow.repair.latestIssueSummary, workflowStopReasonAttentionLabel(workflow.workflowStopReason), 150),
      tone: "warning",
      createdAt: workflow.repair.lastUpdatedAt
    });
  }

  const representedWarningSteps = new Set<string>();
  if (workflow?.manualHandoff?.reason === "merge_conflicts") {
    representedWarningSteps.add("merge");
  }
  if (hasPrimaryRepairBlocker || items.some((item) => item.kind === "integrity")) {
    representedWarningSteps.add("integrity");
  }
  if (repairOrValidationInFlight) {
    representedWarningSteps.add("coding");
    representedWarningSteps.add("integrity");
  }
  if (integrityFailureResolved) {
    representedWarningSteps.add("integrity");
  }

  for (const step of timeline.filter((step) => step.warning && !representedWarningSteps.has(step.id)).slice(0, 3)) {
    items.push({
      id: `warning:${step.id}`,
      kind: "warning",
      title: `${step.title} warning`,
      detail: summarizeAttentionText(step.warning, "Workflow warning.", 150),
      tone: "warning",
      createdAt: step.updatedAt ?? step.lastEventAt
    });
  }

  const seenFingerprints = new Set<string>();
  return items.filter((item) => {
    const fingerprint = attentionFingerprint(item);
    if (seenFingerprints.has(fingerprint)) {
      return false;
    }
    seenFingerprints.add(fingerprint);
    return true;
  }).sort((left, right) => {
    const toneScore = { danger: 0, warning: 1, neutral: 2 } as const;
    const toneDelta = toneScore[left.tone] - toneScore[right.tone];
    return toneDelta !== 0 ? toneDelta : attentionTime(right.createdAt) - attentionTime(left.createdAt);
  });
};
