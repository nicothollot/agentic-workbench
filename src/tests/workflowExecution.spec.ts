import { describe, expect, it } from "vitest";
import { createAgentSkeleton, defaultProjectWorkflowState } from "@shared/defaults";
import {
  appendWorkflowJournalEvent,
  ensureWorkflowV2State,
  markWorkflowIncidentsResolving,
  projectWorkflowExecution,
  resolveWorkflowIncidents,
  synchronizeWorkflowExecution,
  upsertWorkflowIncident,
  workflowIncidentFingerprint,
  workflowValidationKindForRepair
} from "@shared/workflowExecution";
import { WORKFLOW_SCHEMA_VERSION } from "@shared/types";
import type { AgentState, ProjectWorkflowState } from "@shared/types";

const agentForCycle = (
  id: string,
  category: AgentState["category"],
  cycleNumber: number,
  status: AgentState["status"] = "running",
  lastActivityAt = "2026-07-09T12:00:00.000Z"
): AgentState => ({
  ...createAgentSkeleton(category, `${category} agent`, "Continue the active workflow.", "gpt-test"),
  id,
  workflowCycleNumber: cycleNumber,
  status,
  createdAt: "2026-07-09T11:59:00.000Z",
  startedAt: "2026-07-09T11:59:30.000Z",
  lastActivityAt,
  threadId: `${id}-thread`
});

const incidentInput = (overrides: Partial<Parameters<typeof upsertWorkflowIncident>[1]> = {}) => ({
  kind: "validation" as const,
  severity: "high" as const,
  sourceStep: "integrity" as const,
  title: "Validation failed",
  summary: "The test command failed and automatic repair will run.",
  rootCause: "Test run 101 failed at commit abcdef123",
  evidenceRefs: ["validation:run-101"],
  involvedPaths: ["src/Foo.ts"],
  automaticActions: ["Queued coding repair"],
  nextSystemAction: "Run repair, then revalidate.",
  ...overrides
});

describe("workflow execution v2", () => {
  it("keeps a default v2 workflow stable when migration is applied repeatedly", () => {
    const workflow = defaultProjectWorkflowState();
    const originalExecution = workflow.execution;

    ensureWorkflowV2State(workflow, [], { now: "2026-07-09T12:00:00.000Z" });
    ensureWorkflowV2State(workflow, [], { now: "2026-07-09T12:01:00.000Z" });

    expect(workflow.schemaVersion).toBe(WORKFLOW_SCHEMA_VERSION);
    expect(workflow.execution).toBe(originalExecution);
    expect(workflow.execution).toMatchObject({
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      revision: 1,
      cycleNumber: 1,
      tag: "needs_goal",
      stepId: "ultimate_goal"
    });
    expect(workflow.incidents).toEqual([]);
    expect(workflow.journal).toEqual([]);
    expect(workflow.metrics).toEqual({
      totalInputTokens: 0,
      totalCachedInputTokens: 0,
      totalOutputTokens: 0,
      totalReasoningTokens: 0,
      totalTokens: 0
    });
  });

  it("migrates legacy activity into a deduplicated journal and canonical execution", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.activityLog = [
      {
        id: "activity-new",
        timestamp: "2026-07-09T11:02:00.000Z",
        source: "validation",
        status: "failed",
        stepId: "integrity",
        title: "Integrity failed",
        detail: "One assertion failed."
      },
      {
        id: "activity-old",
        timestamp: "2026-07-09T11:00:00.000Z",
        source: "agent",
        status: "completed",
        stepId: "coding",
        title: "Coding checkpoint created"
      }
    ];
    const legacy = workflow as Partial<ProjectWorkflowState>;
    delete legacy.schemaVersion;
    delete legacy.execution;
    delete legacy.incidents;
    delete legacy.journal;
    delete legacy.metrics;

    ensureWorkflowV2State(workflow, [], { now: "2026-07-09T12:00:00.000Z" });

    expect(workflow.schemaVersion).toBe(WORKFLOW_SCHEMA_VERSION);
    expect(workflow.execution).toMatchObject({
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      revision: 1,
      cycleNumber: 1,
      tag: "needs_goal",
      stepId: "ultimate_goal"
    });
    expect(workflow.metrics.totalTokens).toBe(0);
    expect(workflow.journal.map((event) => event.title)).toEqual([
      "Workflow entered needs_goal",
      "Workflow state upgraded to v2",
      "Integrity failed",
      "Coding checkpoint created"
    ]);
    expect(workflow.journal.map((event) => event.sequence)).toEqual([4, 3, 2, 1]);

    const journalLength = workflow.journal.length;
    ensureWorkflowV2State(workflow, [], { now: "2026-07-09T12:05:00.000Z" });
    expect(workflow.journal).toHaveLength(journalLength);
    expect(workflow.execution.revision).toBe(1);
  });

  it("increments canonical revisions only for real transitions and deduplicates journal events", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal.confirmedAt = "2026-07-09T11:00:00.000Z";
    workflow.workflowStage = "recommendation_pending";

    const recommending = synchronizeWorkflowExecution(workflow, [], { now: "2026-07-09T12:00:00.000Z" });
    expect(recommending).toMatchObject({ revision: 2, tag: "recommending", stepId: "recommendation" });
    expect(workflow.journal).toHaveLength(1);
    expect(workflow.journal[0]).toMatchObject({
      sequence: 1,
      kind: "transition",
      title: "needs_goal → recommending"
    });

    const unchanged = synchronizeWorkflowExecution(workflow, [], { now: "2026-07-09T12:01:00.000Z" });
    expect(unchanged).toBe(recommending);
    expect(unchanged.revision).toBe(2);
    expect(workflow.journal).toHaveLength(1);

    const duplicate = appendWorkflowJournalEvent(workflow, {
      kind: "transition",
      status: "running",
      stepId: "recommendation",
      title: "needs_goal → recommending",
      summary: "Canonical workflow execution revision 2.",
      occurredAt: "2026-07-09T12:02:00.000Z"
    });
    expect(duplicate).toBe(workflow.journal[0]);
    expect(workflow.journal).toHaveLength(1);

    workflow.workflowStage = "goal_ready";
    const coding = synchronizeWorkflowExecution(workflow, [], { now: "2026-07-09T12:03:00.000Z" });
    expect(coding).toMatchObject({ revision: 3, tag: "coding", stepId: "coding" });
    expect(workflow.journal).toHaveLength(2);
    expect(workflow.journal[0]).toMatchObject({
      sequence: 2,
      title: "recommending → coding"
    });
  });

  it("gives active repair and revalidation agents precedence over stale handoff state", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.workflowCycle.cycleNumber = 7;
    workflow.workflowStage = "repair_loop";
    workflow.workflowStopReason = "repair_budget_exhausted";
    workflow.manualHandoff = {
      reason: "repair_exhausted",
      title: "Old handoff",
      whatSystemWasTryingToDo: "Repair validation",
      validationIssue: "A previous attempt failed.",
      latestFailureReason: "Previous assertion",
      involvedPaths: ["src/old.ts"],
      shellSupported: true,
      createdAt: "2026-07-09T10:00:00.000Z"
    };
    workflow.repair = {
      status: "repairing",
      attemptCount: 2,
      maxAttempts: 3,
      latestFailureReason: "Previous assertion"
    };
    const repairAgent = agentForCycle("repair-agent", "coding", 7);

    expect(projectWorkflowExecution(workflow, [repairAgent])).toMatchObject({
      cycleNumber: 7,
      tag: "repairing",
      stepId: "coding",
      activeAgentId: "repair-agent",
      activeRunId: "repair-agent-thread",
      repairAttempt: 2,
      maxRepairAttempts: 3
    });

    repairAgent.status = "completed";
    workflow.repair.status = "retrying_validation";
    const integrityAgent = agentForCycle("integrity-agent", "integrity", 7);
    const revalidation = projectWorkflowExecution(workflow, [repairAgent, integrityAgent]);

    expect(revalidation).toMatchObject({
      cycleNumber: 7,
      tag: "validating",
      stepId: "integrity",
      activeAgentId: "integrity-agent",
      validationKind: "repair",
      repairAttempt: 2
    });
    expect(workflowValidationKindForRepair(workflow)).toBe("repair");

    workflow.repair.latestFailureReason = "External repair completed in the coding worktree.";
    expect(workflowValidationKindForRepair(workflow)).toBe("external_repair");

    workflow.manualHandoff = undefined;
    integrityAgent.status = "completed";
    const bootstrapAgent = agentForCycle("bootstrap-agent", "bootstrap", 7);
    expect(projectWorkflowExecution(workflow, [bootstrapAgent])).toMatchObject({
      tag: "validating",
      stepId: "integrity",
      validationKind: "external_repair"
    });
    expect(projectWorkflowExecution(workflow, [bootstrapAgent]).activeAgentId).toBeUndefined();
  });

  it("projects blocking input ahead of a still-running agent and keeps the source step", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.workflowCycle.cycleNumber = 4;
    workflow.workflowStage = "coding_running";
    workflow.humanInterventions.push({
      id: "input-needed",
      kind: "external_setup",
      title: "Provide deployment details",
      description: "The coding agent needs an operator answer.",
      reason: "A required target is not available in the repository.",
      requestedByAgentCategory: "coding",
      severity: "medium",
      blocking: true,
      status: "pending",
      createdAt: "2026-07-09T12:00:00.000Z"
    });
    const codingAgent = agentForCycle("coding-waiting-input", "coding", 4);

    expect(projectWorkflowExecution(workflow, [codingAgent])).toMatchObject({
      cycleNumber: 4,
      tag: "awaiting_human",
      stepId: "coding",
      activeAgentId: codingAgent.id,
      activeRunId: codingAgent.threadId,
      resumeTag: "coding"
    });

    workflow.humanInterventions[0].requestedByAgentCategory = "merge";
    expect(projectWorkflowExecution(workflow, [])).toMatchObject({
      tag: "awaiting_human",
      stepId: "merge",
      resumeTag: "merging"
    });
  });

  it("normalizes incident fingerprints and deduplicates recurring open incidents", () => {
    const workflow = defaultProjectWorkflowState();
    const firstFingerprint = workflowIncidentFingerprint(
      1,
      "validation",
      "Test run 101 failed at commit abcdef123",
      ["src/Foo.ts"]
    );
    const equivalentFingerprint = workflowIncidentFingerprint(
      1,
      "validation",
      "Test run 202 failed at commit deadbeef9",
      ["SRC/foo.ts"]
    );
    expect(equivalentFingerprint).toBe(firstFingerprint);
    expect(workflowIncidentFingerprint(2, "validation", "Test run 202 failed at commit deadbeef9", ["src/foo.ts"]))
      .not.toBe(firstFingerprint);

    const first = upsertWorkflowIncident(workflow, incidentInput({ now: "2026-07-09T12:00:00.000Z" }));
    const recurring = upsertWorkflowIncident(workflow, incidentInput({
      rootCause: "Test run 202 failed at commit deadbeef9",
      evidenceRefs: ["validation:run-202"],
      automaticActions: ["Queued coding repair", "Collected failure evidence"],
      status: "resolving",
      now: "2026-07-09T12:02:00.000Z"
    }));

    expect(recurring).toBe(first);
    expect(workflow.incidents).toHaveLength(1);
    expect(recurring).toMatchObject({
      status: "resolving",
      occurrenceCount: 2,
      updatedAt: "2026-07-09T12:02:00.000Z"
    });
    expect(recurring.evidenceRefs).toEqual(["validation:run-101", "validation:run-202"]);
    expect(recurring.automaticActions).toEqual(["Queued coding repair", "Collected failure evidence"]);

    recurring.userActionRequired = "Retry validation.";
    recurring.primaryAction = { kind: "retry", label: "Retry" };
    const resolving = markWorkflowIncidentsResolving(
      workflow,
      (incident) => incident.kind === "validation",
      "Validation retry is running.",
      "2026-07-09T12:02:30.000Z"
    );
    expect(resolving).toEqual([first]);
    expect(first).toMatchObject({
      status: "resolving",
      nextSystemAction: "Validation retry is running.",
      updatedAt: "2026-07-09T12:02:30.000Z"
    });
    expect(first.userActionRequired).toBeUndefined();
    expect(first.primaryAction).toBeUndefined();

    const resolved = resolveWorkflowIncidents(
      workflow,
      (incident) => incident.kind === "validation",
      "resolved",
      "2026-07-09T12:03:00.000Z"
    );
    expect(resolved).toEqual([first]);
    expect(first).toMatchObject({
      status: "resolved",
      resolvedAt: "2026-07-09T12:03:00.000Z",
      updatedAt: "2026-07-09T12:03:00.000Z"
    });

    const reopened = upsertWorkflowIncident(workflow, incidentInput({ now: "2026-07-09T12:04:00.000Z" }));
    expect(reopened.id).not.toBe(first.id);
    expect(reopened.fingerprint).toBe(first.fingerprint);
    expect(reopened.occurrenceCount).toBe(1);
    expect(workflow.incidents).toHaveLength(2);
  });

  it("links execution only to incidents and active agents from the current cycle", () => {
    const workflow = defaultProjectWorkflowState();
    const previousIncident = upsertWorkflowIncident(workflow, incidentInput({
      title: "Previous-cycle validation failed",
      now: "2026-07-09T10:00:00.000Z"
    }));
    workflow.workflowCycle.cycleNumber = 2;
    workflow.workflowCycle.status = "coding";
    workflow.workflowStage = "coding_running";
    const currentIncident = upsertWorkflowIncident(workflow, incidentInput({
      title: "Current-cycle validation failed",
      rootCause: "Current test run 303 failed at commit 1234567abc",
      now: "2026-07-09T11:00:00.000Z"
    }));
    const staleAgent = agentForCycle("stale-agent", "integrity", 1, "running", "2026-07-09T12:10:00.000Z");
    const currentAgent = agentForCycle("current-agent", "coding", 2, "running", "2026-07-09T12:00:00.000Z");

    const execution = synchronizeWorkflowExecution(workflow, [staleAgent, currentAgent], {
      now: "2026-07-09T12:15:00.000Z"
    });

    expect(execution).toMatchObject({
      cycleNumber: 2,
      tag: "coding",
      stepId: "coding",
      activeAgentId: "current-agent",
      incidentId: currentIncident.id
    });
    expect(execution.activeAgentId).not.toBe(staleAgent.id);
    expect(execution.incidentId).not.toBe(previousIncident.id);
    expect(workflow.journal[0]).toMatchObject({
      cycleNumber: 2,
      kind: "transition",
      incidentId: currentIncident.id
    });
  });
});
