import { describe, expect, it } from "vitest";
import { createAgentSkeleton, defaultProjectWorkflowState } from "@shared/defaults";
import {
  buildWorkflowDashboard,
  buildWorkflowMetrics,
  buildWorkflowMissionSummary,
  buildWorkflowTimelineItems,
  buildWorkflowTimelinePage,
  filterWorkflowTimeline,
  sortWorkflowTimeline
} from "@shared/workflowDashboard";
import type { AgentState, ValidationCommandStatus, ValidationFinalStatus, ValidationLedger } from "@shared/types";

const validationLedger = (
  cycleNumber: number,
  createdAt: string,
  finalValidationStatus: ValidationFinalStatus,
  commandStatus: ValidationCommandStatus,
  options: { repairedFailures?: string[]; command?: string; relatedFiles?: string[] } = {}
): ValidationLedger => {
  const command = options.command ?? "npm test";
  const relatedFiles = options.relatedFiles ?? [];
  const endedAt = new Date(Date.parse(createdAt) + 1_000).toISOString();
  return {
    schemaVersion: 1,
    cycleNumber,
    createdAt,
    updatedAt: endedAt,
    plannedCommands: [command],
    attemptedCommands: [command],
    evidenceCommands: [],
    testCommands: [command],
    commandResults: [{
      commandId: `${cycleNumber}-${createdAt}`,
      command,
      normalizedCommand: command,
      cwdKind: "coding_worktree",
      phase: "integrity",
      startedAt: createdAt,
      endedAt,
      durationMs: 1_000,
      exitCode: commandStatus === "passed" ? 0 : 1,
      status: commandStatus,
      stdoutSummary: commandStatus === "passed" ? "passed" : "",
      stderrSummary: commandStatus === "passed" ? "" : "failed assertion",
      redactionApplied: false,
      relatedCheckIds: [],
      relatedFiles
    }],
    environmentFailures: [],
    commandConstructionFailures: [],
    productFailures: commandStatus === "failed" ? ["failed assertion"] : [],
    evidenceFailures: [],
    hygieneFailures: [],
    repairedFailures: options.repairedFailures ?? [],
    warnings: [],
    finalValidationStatus,
    finalValidationBasis: finalValidationStatus,
    unresolvedValidationFailures: finalValidationStatus === "failed" ? ["failed assertion"] : [],
    mergeAllowed: finalValidationStatus === "passed",
    mergeBlockedReasons: finalValidationStatus === "passed" ? [] : ["Validation failed"],
    summaryForHumans: `Validation ${finalValidationStatus}`
  };
};

const workflowAgent = (
  id: string,
  category: AgentState["category"],
  cycleNumber: number,
  startedAt: string,
  completedAt?: string
): AgentState => ({
  ...createAgentSkeleton(category, `${category} agent`, "Test the workflow dashboard.", "gpt-test"),
  id,
  workflowCycleNumber: cycleNumber,
  createdAt: startedAt,
  startedAt,
  completedAt,
  lastActivityAt: completedAt ?? startedAt,
  status: completedAt ? "completed" : "running"
});

describe("workflow dashboard read models", () => {
  it("summarizes the current mission, active repair, and concrete user needs", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal.summary = "Ship a trustworthy autonomous workbench";
    workflow.workflowCycle = {
      cycleNumber: 4,
      approvedRecommendationTitle: "Repair validation continuation",
      acceptanceCriteria: [],
      status: "repair_loop",
      startedAt: "2026-07-09T10:00:00.000Z"
    };
    workflow.workflowStage = "repair_loop";
    workflow.workflowStopReason = "human_intervention_required";
    workflow.execution = {
      ...workflow.execution,
      revision: 7,
      cycleNumber: 4,
      tag: "repairing",
      stepId: "coding",
      activeAgentId: "repair-1",
      repairAttempt: 2,
      enteredAt: "2026-07-09T10:06:00.000Z",
      updatedAt: "2026-07-09T10:06:00.000Z"
    };
    workflow.ultimateGoalProgress = {
      percentComplete: 45,
      rationale: "Nine of twenty checks are met.",
      source: "deterministic",
      updatedAt: "2026-07-09T10:10:00.000Z"
    };
    workflow.humanInterventions = [{
      id: "intervention-1",
      kind: "credentials",
      title: "Provide the signing credential",
      description: "Signing is required before release.",
      reason: "The credential is not available to the agent.",
      requestedByAgentCategory: "coding",
      severity: "high",
      blocking: true,
      status: "pending",
      createdAt: "2026-07-09T10:05:00.000Z"
    }];
    const repairAgent = workflowAgent("repair-1", "coding", 4, "2026-07-09T10:06:00.000Z");
    repairAgent.name = "Coding Repair Agent";
    repairAgent.currentSubtask = "Fixing the failed integrity assertion";

    const summary = buildWorkflowMissionSummary(workflow, [repairAgent]);

    expect(summary).toMatchObject({
      goal: "Ship a trustworthy autonomous workbench",
      cycleNumber: 4,
      cycleTitle: "Repair validation continuation",
      executionTag: "repairing",
      stage: "repair_loop",
      currentPhase: "repair",
      status: "blocked",
      goalProgressPercent: 45,
      now: "Fixing the failed integrity assertion"
    });
    expect(summary.activeAgent?.id).toBe("repair-1");
    expect(summary.needsUser).toEqual(["Provide the signing credential"]);
  });

  it("builds a deterministic, filterable, and paginated causal timeline", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.workflowCycle = {
      cycleNumber: 2,
      approvedRecommendationTitle: "Improve diagnostics",
      acceptanceCriteria: [],
      status: "integrity",
      startedAt: "2026-07-09T10:00:00.000Z"
    };
    workflow.workflowStage = "integrity_running";
    workflow.execution = {
      ...workflow.execution,
      revision: 4,
      cycleNumber: 2,
      tag: "validating",
      stepId: "integrity",
      validationKind: "initial",
      enteredAt: "2026-07-09T10:03:00.000Z",
      updatedAt: "2026-07-09T10:03:00.000Z"
    };
    workflow.activityLog = [{
      id: "activity-code",
      timestamp: "2026-07-09T10:02:00.000Z",
      source: "agent",
      status: "completed",
      title: "Coding checkpoint created for cycle 2",
      detail: "Saved src/diagnostics.ts",
      stepId: "coding",
      agentId: "coding-2",
      agentCategory: "coding"
    }];
    workflow.journal = [{
      id: "journal-code",
      sequence: 1,
      cycleNumber: 2,
      kind: "agent",
      status: "completed",
      stepId: "coding",
      title: "Coding checkpoint created for cycle 2",
      summary: "Saved src/diagnostics.ts",
      agentId: "coding-2",
      evidenceRefs: [],
      occurredAt: "2026-07-09T10:02:00.000Z"
    }];
    workflow.incidents = [{
      id: "incident-2",
      fingerprint: "2:validation:diagnostics",
      cycleNumber: 2,
      kind: "validation",
      severity: "warning",
      status: "resolved",
      sourceStep: "integrity",
      title: "Diagnostics assertion failed",
      summary: "The assertion was repaired and revalidated.",
      rootCause: "The failure message omitted the responsible path.",
      evidenceRefs: [],
      involvedPaths: ["src/diagnostics.ts"],
      automaticActions: ["Re-ran validation"],
      secondaryActions: [],
      occurrenceCount: 1,
      openedAt: "2026-07-09T10:03:00.000Z",
      updatedAt: "2026-07-09T10:04:00.000Z",
      resolvedAt: "2026-07-09T10:04:00.000Z"
    }];
    workflow.validationLedgers = [validationLedger(
      2,
      "2026-07-09T10:03:00.000Z",
      "passed",
      "passed",
      { relatedFiles: ["src/diagnostics.ts"] }
    )];
    workflow.checklistDeltas = [{
      schemaVersion: 1,
      cycleNumber: 2,
      targetedTotal: 1,
      targetedMetBefore: 0,
      targetedMetAfter: 1,
      targetedNewlyMet: ["diagnostics"],
      targetedStillUnknown: [],
      targetedNeedsAttention: [],
      targetedNotApplicable: [],
      nonTargetedChanges: [],
      evidenceObservedCount: 1,
      evidenceConsumedCount: 1,
      evidenceNotConsumedCount: 0,
      evidenceNotConsumedReasons: {},
      summaryForHumans: "Diagnostics now explain the failure.",
      didGoalProgressChange: true,
      goalProgressBefore: 10,
      goalProgressAfter: 20,
      whyStillUnknownByCheckId: {},
      createdAt: "2026-07-09T10:04:00.000Z"
    }];
    const coding = workflowAgent(
      "coding-2",
      "coding",
      2,
      "2026-07-09T10:01:00.000Z",
      "2026-07-09T10:02:00.000Z"
    );
    coding.changedFiles = ["src/diagnostics.ts"];

    const first = buildWorkflowTimelineItems(workflow, [coding], "2026-07-09T10:05:00.000Z");
    const second = buildWorkflowTimelineItems(workflow, [coding], "2026-07-09T10:05:00.000Z");
    expect(second).toEqual(first);
    expect(first.map((item) => item.kind)).toEqual(expect.arrayContaining(["cycle", "phase", "activity", "validation", "checklist"]));

    const codingItems = filterWorkflowTimeline(first, { cycleNumbers: [2], phases: ["coding"], query: "diagnostics" });
    expect(codingItems.map((item) => item.id)).toEqual(["journal:journal-code", "phase:agent:coding-2"]);
    expect(first.some((item) => item.id === "activity:activity-code")).toBe(false);
    expect(filterWorkflowTimeline(first, { incidentIds: ["incident-2"] }).map((item) => item.id)).toEqual(["incident:incident-2"]);

    const ascending = sortWorkflowTimeline(first, "ascending");
    const times = ascending.map((item) => Date.parse(item.timestamp));
    expect(times).toEqual([...times].sort((left, right) => left - right));

    const page = buildWorkflowTimelinePage(workflow, [coding], { limit: 2 }, "2026-07-09T10:05:00.000Z");
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(first.length);
    expect(page.hasMore).toBe(true);
  });

  it("derives validation, repair, work, duration, model, and token analytics", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.workflowCycle = {
      cycleNumber: 2,
      approvedRecommendationTitle: "Finish analytics",
      acceptanceCriteria: [],
      status: "completed",
      startedAt: "2026-07-09T11:00:00.000Z",
      completedAt: "2026-07-09T11:20:00.000Z"
    };
    workflow.workflowStage = "cycle_complete";
    workflow.validationLedgers = [
      validationLedger(1, "2026-07-09T10:01:00.000Z", "failed", "failed", { relatedFiles: ["src/a.ts"] }),
      validationLedger(1, "2026-07-09T10:03:00.000Z", "passed", "passed", { repairedFailures: ["failed assertion"], relatedFiles: ["src/a.ts"] }),
      validationLedger(2, "2026-07-09T11:11:00.000Z", "passed", "passed", { command: "npm run build", relatedFiles: ["src/b.ts"] })
    ];
    workflow.checklistChanges = [{
      id: "change-1",
      action: "link_evidence",
      checklistItemIds: ["check-a", "check-b"],
      rationale: "Evidence was captured.",
      sourceCycle: 1,
      userApprovalStatus: "not_required",
      confidence: 1,
      risk: "low",
      affectedGoalArea: "analytics",
      linkedEvidence: [],
      linkedChangedFiles: ["src/a.ts"],
      linkedValidationCommands: ["npm test"],
      linkedCycleIds: [1],
      linkedAgentIds: ["coding-1"],
      createdAt: "2026-07-09T10:04:00.000Z"
    }];
    workflow.checklistDeltas = [
      {
        schemaVersion: 1,
        cycleNumber: 1,
        targetedTotal: 1,
        targetedMetBefore: 0,
        targetedMetAfter: 1,
        targetedNewlyMet: ["check-a"],
        targetedStillUnknown: [],
        targetedNeedsAttention: [],
        targetedNotApplicable: [],
        nonTargetedChanges: [],
        evidenceObservedCount: 1,
        evidenceConsumedCount: 1,
        evidenceNotConsumedCount: 0,
        evidenceNotConsumedReasons: {},
        summaryForHumans: "One check advanced.",
        didGoalProgressChange: true,
        goalProgressBefore: 10,
        goalProgressAfter: 20,
        whyStillUnknownByCheckId: {},
        createdAt: "2026-07-09T10:05:00.000Z"
      },
      {
        schemaVersion: 1,
        cycleNumber: 2,
        targetedTotal: 1,
        targetedMetBefore: 0,
        targetedMetAfter: 1,
        targetedNewlyMet: ["check-a"],
        targetedStillUnknown: [],
        targetedNeedsAttention: [],
        targetedNotApplicable: [],
        nonTargetedChanges: [],
        evidenceObservedCount: 1,
        evidenceConsumedCount: 1,
        evidenceNotConsumedCount: 0,
        evidenceNotConsumedReasons: {},
        summaryForHumans: "The check advanced again after refinement.",
        didGoalProgressChange: true,
        goalProgressBefore: 20,
        goalProgressAfter: 35,
        whyStillUnknownByCheckId: {},
        createdAt: "2026-07-09T11:15:00.000Z"
      }
    ];

    const codingOne = workflowAgent("coding-1", "coding", 1, "2026-07-09T10:00:00.000Z", "2026-07-09T10:02:00.000Z");
    codingOne.name = "Coding Repair Agent";
    codingOne.changedFiles = ["src/a.ts"];
    codingOne.commandLog = [{
      command: "npm test",
      output: "failed",
      status: "failed",
      startedAt: "2026-07-09T10:01:00.000Z",
      completedAt: "2026-07-09T10:01:01.000Z",
      exitCode: 1
    }];
    codingOne.tokenUsage = {
      inputTokens: 70,
      cachedInputTokens: 10,
      outputTokens: 30,
      reasoningOutputTokens: 5,
      totalTokens: 100,
      modelContextWindow: 200_000,
      updatedAt: "2026-07-09T10:02:00.000Z"
    };

    const codingTwo = workflowAgent("coding-2", "coding", 2, "2026-07-09T11:00:00.000Z", "2026-07-09T11:12:00.000Z");
    codingTwo.model = "gpt-other";
    codingTwo.changedFiles = ["src/b.ts"];
    codingTwo.commandLog = [{
      command: "npm run build",
      output: "passed",
      status: "passed",
      startedAt: "2026-07-09T11:11:00.000Z",
      completedAt: "2026-07-09T11:11:01.000Z",
      exitCode: 0
    }];
    codingTwo.events = [{
      id: "tokens-2",
      agentId: "coding-2",
      timestamp: "2026-07-09T11:12:00.000Z",
      type: "raw",
      title: "Token usage updated",
      raw: {
        tokenUsage: {
          total: { inputTokens: 50, cachedInputTokens: 0, outputTokens: 30, reasoningOutputTokens: 3, totalTokens: 80 }
        }
      }
    }];

    const metrics = buildWorkflowMetrics(workflow, [codingOne, codingTwo], "2026-07-09T11:20:00.000Z");

    expect(metrics.validation).toEqual({
      cyclesValidated: 2,
      firstPassPassed: 1,
      firstPassRatePercent: 50,
      repairCyclesAttempted: 1,
      repairCyclesSucceeded: 1,
      repairSuccessRatePercent: 100
    });
    expect(metrics.work).toMatchObject({
      commandExecutions: 3,
      uniqueCommands: 2,
      fileReferences: 2,
      uniqueFiles: 2,
      checklistChangeRecords: 1,
      checklistItemsTouched: 2,
      checklistItemsAdvanced: 2,
      goalProgressPoints: 25
    });
    expect(metrics.cycles).toMatchObject({ observed: 2, completed: 2 });
    expect(metrics.cycles.duration.sampleCount).toBe(2);
    expect(metrics.phases.find((phase) => phase.phase === "repair")?.duration.totalMs).toBe(120_000);
    expect(metrics.agents).toMatchObject({
      total: 2,
      completed: 2,
      agentsWithTokenUsage: 2,
      tokens: {
        inputTokens: 120,
        cachedInputTokens: 10,
        outputTokens: 60,
        reasoningOutputTokens: 8,
        totalTokens: 180
      }
    });
    expect(metrics.agents.models.map((model) => model.model)).toEqual(["gpt-other", "gpt-test"]);
  });

  it("treats omitted legacy evidence collections as empty", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal.summary = "Keep old projects readable";
    const legacyRecord = workflow as unknown as Record<string, unknown>;
    delete legacyRecord.activityLog;
    delete legacyRecord.checklistChanges;
    delete legacyRecord.checklistDeltas;
    delete legacyRecord.cycleRetrospectives;
    delete legacyRecord.execution;
    delete legacyRecord.incidents;
    delete legacyRecord.journal;
    delete legacyRecord.metrics;
    delete legacyRecord.plannerDecisions;
    delete legacyRecord.stepProgress;
    delete legacyRecord.validationLedgers;

    const dashboard = buildWorkflowDashboard(
      workflow,
      [],
      { now: "2026-07-09T12:00:00.000Z" }
    );

    expect(dashboard.generatedAt).toBe("2026-07-09T12:00:00.000Z");
    expect(dashboard.mission.goal).toBe("Keep old projects readable");
    expect(dashboard.timeline.items).toEqual([]);
    expect(dashboard.metrics.validation.cyclesValidated).toBe(0);
    expect(dashboard.metrics.work.commandExecutions).toBe(0);
  });
});
