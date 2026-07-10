import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { AppService } from "@runtime/appService";
import { sha256 } from "@runtime/hashUtils";
import { WorkbenchStorage } from "@runtime/storage";
import {
  createAgentSkeleton,
  createLocalProjectRecord,
  createPortableInterface,
  defaultProjectWorkflowState,
  emptyValidationSnapshot
} from "@shared/defaults";
import { portableInterfaceSchema, projectWorkflowStateSchema } from "@shared/schemas";
import type { ProjectIdentity, WorkflowActivityEvent } from "@shared/types";
import { WORKFLOW_SCHEMA_VERSION } from "@shared/types";
import {
  ensureWorkflowV2State,
  upsertWorkflowIncident
} from "@shared/workflowExecution";
import { stableStringify } from "@shared/utils";
import { createTempDir, commitAll, initGitRepo, writeMockSettings } from "./helpers";

const execFileAsync = promisify(execFile);

const updatePortableChecksum = (payload: Record<string, unknown>): void => {
  const serializable = JSON.parse(JSON.stringify({
    ...payload,
    checksum: ""
  })) as Record<string, unknown>;
  payload.checksum = sha256(stableStringify(serializable));
};

const legacyActivity: WorkflowActivityEvent[] = [
  {
    id: "legacy-validation-failed",
    timestamp: "2026-07-08T14:02:00.000Z",
    source: "validation",
    status: "failed",
    stepId: "integrity",
    title: "Legacy integrity run failed",
    detail: "Two assertions failed before the application upgrade."
  },
  {
    id: "legacy-coding-finished",
    timestamp: "2026-07-08T14:00:00.000Z",
    source: "agent",
    status: "completed",
    stepId: "coding",
    title: "Legacy coding checkpoint completed",
    detail: "The coding agent produced a repair checkpoint."
  }
];

const identity = (projectName = "workflow-persistence"): ProjectIdentity => ({
  version: 1,
  fingerprint: `${projectName}-fingerprint`,
  projectName,
  kind: "git",
  normalizedRemotes: [],
  manifestSignature: "manifest-signature",
  treeSignature: "tree-signature"
});

const legacyWorkflowPayload = (): Record<string, unknown> => {
  const workflow = defaultProjectWorkflowState();
  workflow.workflowStage = "integrity_running";
  workflow.workflowStopReason = "none";
  workflow.activityLog = structuredClone(legacyActivity);
  workflow.stepProgress.coding.status = "completed";
  workflow.stepProgress.integrity.status = "running";

  const payload = structuredClone(workflow) as unknown as Record<string, unknown>;
  payload.schemaVersion = 1;
  delete payload.execution;
  delete payload.incidents;
  delete payload.journal;
  delete payload.metrics;
  return payload;
};

const activeServices = new Set<AppService>();

const createService = async (appDataDir: string): Promise<AppService> => {
  await writeMockSettings(appDataDir);
  const service = new AppService(appDataDir);
  activeServices.add(service);
  await service.initialize();
  return service;
};

afterEach(async () => {
  const services = [...activeServices];
  activeServices.clear();
  await Promise.allSettled(services.map((service) => service.dispose({ flush: false })));
});

describe("workflow v1 persistence migration", () => {
  it("hydrates missing v2 fields from schema defaults, then backfills legacy activity without loss", () => {
    const parsed = projectWorkflowStateSchema.parse(JSON.parse(JSON.stringify(legacyWorkflowPayload())));

    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.execution).toMatchObject({
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      revision: 1,
      tag: "needs_goal",
      stepId: "ultimate_goal"
    });
    expect(parsed.incidents).toEqual([]);
    expect(parsed.journal).toEqual([]);
    expect(parsed.metrics.totalTokens).toBe(0);
    expect(parsed.activityLog).toEqual(legacyActivity);

    ensureWorkflowV2State(parsed, [], { now: "2026-07-09T12:00:00.000Z" });

    expect(parsed.schemaVersion).toBe(WORKFLOW_SCHEMA_VERSION);
    expect(parsed.execution).toMatchObject({
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      revision: 2,
      tag: "validating",
      stepId: "integrity",
      validationKind: "initial"
    });
    expect(parsed.activityLog).toEqual(legacyActivity);
    expect(parsed.journal.map((event) => event.title)).toEqual(expect.arrayContaining([
      "Legacy integrity run failed",
      "Legacy coding checkpoint completed",
      "Workflow state upgraded to v2",
      "needs_goal → validating"
    ]));
    expect(parsed.journal.filter((event) => event.kind === "migration")).toHaveLength(1);

    const journalSnapshot = structuredClone(parsed.journal);
    ensureWorkflowV2State(parsed, [], { now: "2026-07-09T12:05:00.000Z" });
    expect(parsed.activityLog).toEqual(legacyActivity);
    expect(parsed.journal).toEqual(journalSnapshot);
  });

  it("migrates a v1 portable payload and preserves its workflow through schema round-trips", () => {
    const record = createLocalProjectRecord(
      "portable-v1-project",
      "/repo",
      "/repo",
      "/repo",
      "/repo",
      identity("portable-v1"),
      emptyValidationSnapshot("git")
    );
    const legacyPortable = createPortableInterface(record) as unknown as Record<string, unknown>;
    legacyPortable.schemaVersion = 1;
    legacyPortable.checksum = "legacy-checksum";
    legacyPortable.workflow = legacyWorkflowPayload();
    legacyPortable.validation = {
      ...record.validation,
      interfaceSchemaVersion: 1
    };

    const imported = portableInterfaceSchema.parse(JSON.parse(JSON.stringify(legacyPortable)));
    expect(imported.schemaVersion).toBe(1);
    expect(imported.workflow.activityLog).toEqual(legacyActivity);

    ensureWorkflowV2State(imported.workflow, imported.agents, { now: "2026-07-09T12:00:00.000Z" });
    const serialized = JSON.stringify(imported);
    const reparsed = portableInterfaceSchema.parse(JSON.parse(serialized));

    expect(reparsed.workflow.schemaVersion).toBe(WORKFLOW_SCHEMA_VERSION);
    expect(reparsed.workflow.execution).toEqual(imported.workflow.execution);
    expect(reparsed.workflow.activityLog).toEqual(legacyActivity);
    expect(reparsed.workflow.journal).toEqual(imported.workflow.journal);
    expect(reparsed.workflow.metrics).toEqual(imported.workflow.metrics);
  });

  it("accepts a legacy v1 file whose pre-serialization checksum cannot be reproduced from JSON", async () => {
    const appDataDir = await createTempDir("workflow-portable-v1-checksum-storage");
    const exportDir = await createTempDir("workflow-portable-v1-checksum-export");
    const exportPath = path.join(exportDir, "interface.json");
    const storage = new WorkbenchStorage(appDataDir);
    const record = createLocalProjectRecord(
      "portable-v1-checksum-project",
      "/repo",
      "/repo",
      "/repo",
      "/repo",
      identity("portable-v1-checksum"),
      emptyValidationSnapshot("git")
    );
    const payload = createPortableInterface(record) as unknown as Record<string, unknown>;
    payload.schemaVersion = 1;
    payload.checksum = "legacy-pre-serialization-checksum";
    payload.workflow = legacyWorkflowPayload();
    payload.validation = {
      ...record.validation,
      interfaceSchemaVersion: 1
    };
    await writeFile(exportPath, JSON.stringify(payload, null, 2));

    const imported = await storage.readPortableInterface(exportPath);

    expect(imported?.schemaVersion).toBe(1);
    expect(imported?.workflow.schemaVersion).toBe(1);
    expect(imported?.workflow.activityLog).toEqual(legacyActivity);
  });

  it("retains canonical workflow, incident, journal, and metrics data in a storage export/import", async () => {
    const appDataDir = await createTempDir("workflow-portable-storage");
    const exportDir = await createTempDir("workflow-portable-export");
    const exportPath = path.join(exportDir, "interface.json");
    const storage = new WorkbenchStorage(appDataDir);
    const record = createLocalProjectRecord(
      "portable-v2-project",
      "/repo",
      "/repo",
      "/repo",
      "/repo",
      identity("portable-v2"),
      emptyValidationSnapshot("git")
    );

    record.workflow.activityLog = structuredClone(legacyActivity);
    ensureWorkflowV2State(record.workflow, [], { now: "2026-07-09T12:00:00.000Z" });
    record.workflow.metrics = {
      totalInputTokens: 1_200,
      totalCachedInputTokens: 300,
      totalOutputTokens: 450,
      totalReasoningTokens: 125,
      totalTokens: 1_650,
      updatedAt: "2026-07-09T12:01:00.000Z"
    };
    const incident = upsertWorkflowIncident(record.workflow, {
      kind: "validation",
      severity: "high",
      sourceStep: "integrity",
      title: "Validation failed",
      summary: "A persisted validation incident needs repair.",
      rootCause: "The workflow storage round-trip test detected a failed assertion.",
      evidenceRefs: ["validation:storage-roundtrip"],
      involvedPaths: ["src/example.ts"],
      automaticActions: ["Queued repair"],
      nextSystemAction: "Repair and revalidate.",
      now: "2026-07-09T12:02:00.000Z"
    });

    await storage.writePortableInterfaceToFile(record, exportPath);
    const imported = await storage.readPortableInterface(exportPath);

    expect(imported).not.toBeNull();
    expect(imported?.schemaVersion).toBe(2);
    expect(imported?.checksum).not.toBe("");
    expect(imported?.workflow.execution).toEqual(record.workflow.execution);
    expect(imported?.workflow.activityLog).toEqual(record.workflow.activityLog);
    expect(imported?.workflow.journal).toEqual(record.workflow.journal);
    expect(imported?.workflow.metrics).toEqual(record.workflow.metrics);
    expect(imported?.workflow.incidents).toEqual(record.workflow.incidents);
    expect(imported?.workflow.incidents[0]?.id).toBe(incident.id);
  });

  it("exports redacted portable history without machine-local or live agent state", async () => {
    const appDataDir = await createTempDir("workflow-portable-redaction-storage");
    const exportDir = await createTempDir("workflow-portable-redaction-export");
    const exportPath = path.join(exportDir, "interface.json");
    const storage = new WorkbenchStorage(appDataDir);
    const projectRoot = "/home/alice/private-project";
    const worktreePath = "/tmp/agent-worktrees/private-project/coding";
    const secret = "sk-abcdefghijklmnopqrstuv";
    const record = createLocalProjectRecord(
      "portable-redaction-project",
      projectRoot,
      projectRoot,
      projectRoot,
      projectRoot,
      { ...identity("portable-redaction"), gitRoot: projectRoot },
      {
        ...emptyValidationSnapshot("git"),
        projectAccess: {
          status: "passed",
          checkedAt: "2026-07-09T12:00:00.000Z",
          probeFileName: ".portable-probe",
          executionPath: projectRoot,
          hostPath: projectRoot,
          message: `Write access confirmed at ${projectRoot}.`
        }
      }
    );
    record.localState.selectedFile = `${projectRoot}/src/private.ts`;
    record.localState.treeFilter = "private.ts";
    record.localState.activeAgentId = "coding-agent";
    record.localState.workflowPauseRequested = true;
    record.localState.lastOpenedAt = "2026-07-09T12:00:00.000Z";
    record.workflow.execution.activeRunId = "live-run-id";
    record.workflow.execution.effectKey = "live-effect-key";
    record.workflow.activityLog = [{
      id: "sensitive-history",
      timestamp: "2026-07-09T12:01:00.000Z",
      source: "agent",
      status: "completed",
      stepId: "coding",
      title: "Historical coding result",
      detail: `Updated ${projectRoot}/src/private.ts with token ${secret}.`
    }];
    const approvalIncident = upsertWorkflowIncident(record.workflow, {
      kind: "approval",
      severity: "warning",
      sourceStep: "coding",
      title: "Live approval",
      summary: `Approve a command in ${worktreePath}.`,
      rootCause: `The command contains ${secret}.`,
      evidenceRefs: ["approval:live-approval"],
      automaticActions: [],
      userActionRequired: "Approve the live command.",
      primaryAction: { kind: "approve", label: "Approve", targetId: "live-approval" },
      status: "open",
      now: "2026-07-09T12:02:00.000Z"
    });
    const agent = createAgentSkeleton("coding", "Coding Agent", "Preserve useful history.", "gpt-test");
    agent.id = "coding-agent";
    agent.status = "running";
    agent.threadId = "live-thread-id";
    agent.currentPhase = "Running a live command";
    agent.currentSubtask = `Editing ${worktreePath}/src/private.ts`;
    agent.worktree = {
      baseDir: "/tmp/agent-worktrees",
      worktreePath,
      branch: "agent/coding",
      targetBranch: "main"
    };
    agent.changedFiles = [`${projectRoot}/src/private.ts`];
    agent.approvals = [{
      id: "live-approval",
      agentId: agent.id,
      kind: "command",
      threadId: agent.threadId,
      turnId: "live-turn-id",
      itemId: "live-item-id",
      serverRequestId: "live-server-request",
      summary: `Run a privileged command with ${secret}`,
      command: `deploy --api-key ${secret}`,
      cwd: worktreePath,
      filePaths: [`${worktreePath}/src/private.ts`],
      createdAt: "2026-07-09T12:03:00.000Z",
      status: "pending",
      availableDecisions: ["accept", "decline"]
    }];
    agent.commandLog = [{
      itemId: "live-command",
      command: `deploy --api-key ${secret}`,
      cwd: worktreePath,
      output: `Bearer ${secret} from ${projectRoot}`,
      status: "completed",
      startedAt: "2026-07-09T12:03:00.000Z",
      completedAt: "2026-07-09T12:04:00.000Z",
      exitCode: 0
    }];
    agent.events = [{
      id: "live-event",
      agentId: agent.id,
      timestamp: "2026-07-09T12:04:00.000Z",
      type: "raw",
      status: "completed",
      title: "Historical event",
      detail: `Completed work in ${worktreePath} using ${secret}.`,
      raw: { token: secret, path: projectRoot }
    }];
    agent.outputReference = {
      agentId: agent.id,
      transcriptAvailable: true,
      fullOutputAvailable: true,
      updatedAt: "2026-07-09T12:04:00.000Z"
    };
    record.agents = [agent];

    await storage.writePortableInterfaceToFile(record, exportPath);
    const serialized = await readFile(exportPath, "utf8");
    const imported = await storage.readPortableInterface(exportPath);

    expect(imported).not.toBeNull();
    expect(serialized).not.toContain(projectRoot);
    expect(serialized).not.toContain(worktreePath);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("live-thread-id");
    expect(serialized).not.toContain("live-server-request");
    expect(serialized).not.toContain("live-run-id");
    expect(imported?.identity.gitRoot).toBeUndefined();
    expect(imported?.validation.projectAccess).toBeUndefined();
    expect(imported?.localStateDefaults).toMatchObject({
      treeFilter: "",
      workflowPauseRequested: false
    });
    expect(imported?.localStateDefaults.selectedFile).toBeUndefined();
    expect(imported?.localStateDefaults.activeAgentId).toBeUndefined();
    expect(imported?.localStateDefaults.lastOpenedAt).toBeUndefined();
    expect(imported?.workflow.execution.activeRunId).toBeUndefined();
    expect(imported?.workflow.execution.effectKey).toBeUndefined();
    expect(imported?.workflow.activityLog[0]?.title).toBe("Historical coding result");
    expect(imported?.workflow.activityLog[0]?.detail).toContain("<project-root>");
    const importedApprovalIncident = imported?.workflow.incidents.find((entry) => entry.id === approvalIncident.id);
    expect(importedApprovalIncident).toMatchObject({
      status: "superseded",
      secondaryActions: []
    });
    expect(importedApprovalIncident?.primaryAction).toBeUndefined();
    expect(importedApprovalIncident?.userActionRequired).toBeUndefined();
    expect(imported?.agents[0]).toMatchObject({
      id: agent.id,
      status: "idle",
      approvals: []
    });
    expect(imported?.agents[0]?.threadId).toBeUndefined();
    expect(imported?.agents[0]?.worktree).toBeUndefined();
    expect(imported?.agents[0]?.outputReference).toBeUndefined();
    expect(imported?.agents[0]?.commandLog[0]?.output).toBe("");
    expect(imported?.agents[0]?.commandLog[0]?.cwd).toBeUndefined();
    expect(imported?.agents[0]?.events[0]?.raw).toBeUndefined();
    expect(record.agents[0]?.status).toBe("running");
    expect(record.workflow.incidents.find((entry) => entry.id === approvalIncident.id)?.status).toBe("open");
  });

  it("rejects a checksummed payload after its content is changed", async () => {
    const appDataDir = await createTempDir("workflow-portable-checksum-storage");
    const exportDir = await createTempDir("workflow-portable-checksum-export");
    const exportPath = path.join(exportDir, "interface.json");
    const storage = new WorkbenchStorage(appDataDir);
    const record = createLocalProjectRecord(
      "portable-checksum-project",
      "/repo",
      "/repo",
      "/repo",
      "/repo",
      identity("portable-checksum"),
      emptyValidationSnapshot("git")
    );

    await storage.writePortableInterfaceToFile(record, exportPath);
    const payload = JSON.parse(await readFile(exportPath, "utf8")) as Record<string, unknown>;
    payload.appMinVersion = "tampered";
    await writeFile(exportPath, JSON.stringify(payload, null, 2));

    expect(await storage.readPortableInterface(exportPath)).toBeNull();
  });

  it("rejects a future portable schema version even when its checksum is valid", async () => {
    const appDataDir = await createTempDir("workflow-portable-version-storage");
    const exportDir = await createTempDir("workflow-portable-version-export");
    const exportPath = path.join(exportDir, "interface.json");
    const storage = new WorkbenchStorage(appDataDir);
    const record = createLocalProjectRecord(
      "portable-future-project",
      "/repo",
      "/repo",
      "/repo",
      "/repo",
      identity("portable-future"),
      emptyValidationSnapshot("git")
    );

    await storage.writePortableInterfaceToFile(record, exportPath);
    const payload = JSON.parse(await readFile(exportPath, "utf8")) as Record<string, unknown>;
    payload.schemaVersion = 3;
    updatePortableChecksum(payload);
    await writeFile(exportPath, JSON.stringify(payload, null, 2));

    expect(portableInterfaceSchema.safeParse(payload).success).toBe(false);
    expect(await storage.readPortableInterface(exportPath)).toBeNull();
  });

  it("keeps legacy activity when AppService selects an imported v1 portable candidate", async () => {
    const root = await createTempDir("workflow-portable-selection");
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      name: "workflow-portable-selection",
      scripts: { test: "echo test" }
    }));
    await writeFile(path.join(root, "src/index.ts"), "export const value = 1;\n");
    await initGitRepo(root);
    await commitAll(root, "initial");
    await execFileAsync("git", ["remote", "add", "origin", "git@github.com:awb-tests/workflow-portable-selection.git"], { cwd: root });

    const serviceA = await createService(await createTempDir("workflow-portable-selection-a"));
    await serviceA.loadProject(root);
    const selected = await serviceA.selectPendingInterface("fresh");
    const sourceProject = serviceA.getState().projects.find((project) => project.record.id === selected.record.id);
    expect(sourceProject).toBeDefined();
    sourceProject!.record.workflow.activityLog = structuredClone(legacyActivity);

    const exportPath = await serviceA.exportInterface(selected.record.id);
    const payload = JSON.parse(await readFile(exportPath, "utf8")) as Record<string, unknown>;
    payload.schemaVersion = 1;
    payload.workflow = legacyWorkflowPayload();
    const validation = payload.validation as Record<string, unknown>;
    validation.interfaceSchemaVersion = 1;
    updatePortableChecksum(payload);
    await writeFile(exportPath, JSON.stringify(payload, null, 2));

    const serviceB = await createService(await createTempDir("workflow-portable-selection-b"));
    const imported = await serviceB.importInterface(root, exportPath);
    const importedProject = serviceB.getState().projects.find((project) => project.record.id === imported.record.id);

    expect(importedProject?.record.workflow.schemaVersion).toBe(WORKFLOW_SCHEMA_VERSION);
    expect(importedProject?.record.workflow.activityLog).toEqual(expect.arrayContaining(legacyActivity));
    expect(importedProject?.record.workflow.journal.map((event) => event.title)).toEqual(expect.arrayContaining([
      "Legacy integrity run failed",
      "Legacy coding checkpoint completed"
    ]));
  });
});
