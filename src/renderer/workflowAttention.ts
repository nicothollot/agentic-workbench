import type {
  AgentState,
  ApprovalRequestRecord,
  CredentialRequestRecord,
  HumanInterventionRecord,
  ProjectWorkflowState,
  UserInputRequestRecord
} from "@shared/types";

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

  for (const approval of approvals) {
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

  if (workflow?.manualHandoff) {
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
  } else if (workflow?.workflowStage === "blocked_human" && humanInterventions.length === 0 && userInputRequests.length === 0) {
    items.push({
      id: "workflow:blocker",
      kind: "blocker",
      title: "Workflow is blocked",
      detail: workflowStopReasonAttentionLabel(workflow.workflowStopReason),
      tone: "danger"
    });
  }

  const failedIntegrityAgent = agents.find((agent) => agent.integrityReport?.checks.some((check) => check.status === "failed"));
  if (failedIntegrityAgent?.integrityReport) {
    const failedCount = failedIntegrityAgent.integrityReport.checks.filter((check) => check.status === "failed").length;
    items.push({
      id: `integrity-agent:${failedIntegrityAgent.id}`,
      kind: "integrity",
      title: `${failedCount} integrity check${failedCount === 1 ? "" : "s"} failed`,
      detail: summarizeAttentionText(failedIntegrityAgent.integrityReport.summary, "Integrity validation failed.", 150),
      tone: "danger",
      createdAt: failedIntegrityAgent.completedAt ?? failedIntegrityAgent.lastActivityAt
    });
  } else if (workflow?.stepProgress.integrity.status === "failed" || workflow?.workflowStopReason === "integrity_failed") {
    items.push({
      id: "integrity:failed",
      kind: "integrity",
      title: "Integrity needs repair",
      detail: summarizeAttentionText(workflow.repair.latestFailureReason ?? workflow.repair.latestIssueSummary, workflowStopReasonAttentionLabel(workflow.workflowStopReason), 150),
      tone: "warning",
      createdAt: workflow.repair.lastUpdatedAt
    });
  }

  for (const step of timeline.filter((step) => step.warning).slice(0, 3)) {
    items.push({
      id: `warning:${step.id}`,
      kind: "warning",
      title: `${step.title} warning`,
      detail: summarizeAttentionText(step.warning, "Workflow warning.", 150),
      tone: "warning",
      createdAt: step.updatedAt ?? step.lastEventAt
    });
  }

  return items.sort((left, right) => {
    const toneScore = { danger: 0, warning: 1, neutral: 2 } as const;
    const toneDelta = toneScore[left.tone] - toneScore[right.tone];
    return toneDelta !== 0 ? toneDelta : attentionTime(right.createdAt) - attentionTime(left.createdAt);
  });
};
