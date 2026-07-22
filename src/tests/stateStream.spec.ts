import { describe, expect, it } from "vitest";
import { createAgentSkeleton, createLocalProjectRecord, defaultSettings } from "@shared/defaults";
import {
  RENDERER_STATE_PROTOCOL_VERSION,
  applyWorkbenchDelta,
  diffWorkbenchState,
  rendererDeltaEnvelopeSchema,
  rendererSnapshotEnvelopeSchema,
  type RendererDeltaEnvelope
} from "@shared/stateStream";
import type { LoadedProjectView, WorkbenchState } from "@shared/types";

const baseState = (): WorkbenchState => ({
  settings: defaultSettings(),
  settingsRevision: 0,
  operations: [],
  github: {
    state: "not_linked",
    sshReady: false,
    message: "GitHub is optional for local work."
  },
  projects: [],
  availableModels: [],
  codexAvailability: {
    source: "mock",
    message: "Test catalog"
  },
  codexReadiness: {
    executionMode: "local",
    codexBinaryPath: "codex",
    updateAvailable: false,
    status: "ready",
    message: "Ready"
  },
  runtimeReadiness: {
    status: "ready",
    summary: "Local capabilities are ready.",
    blockAgentActions: false,
    checks: []
  },
  diagnostics: []
});

const projectView = (): LoadedProjectView => {
  const record = createLocalProjectRecord(
    "project-1",
    "/repo",
    "/repo",
    "/repo",
    "/repo",
    {
      version: 1,
      fingerprint: "project-fingerprint",
      projectName: "State stream fixture",
      kind: "git",
      normalizedRemotes: [],
      manifestSignature: "manifest",
      treeSignature: "tree"
    },
    {
      interfaceSchemaVersion: 2,
      appMinVersion: "1.0.0",
      projectKind: "git"
    }
  );
  return {
    record,
    tree: [],
    validationStatus: "unvalidated",
    candidates: []
  };
};

const envelope = (operations: ReturnType<typeof diffWorkbenchState>): RendererDeltaEnvelope => ({
  protocolVersion: RENDERER_STATE_PROTOCOL_VERSION,
  streamId: "stream-1",
  baseRevision: 4,
  revision: 5,
  operations
});

describe("renderer state stream", () => {
  it("round-trips shell changes without replacing project state", () => {
    const previous = baseState();
    const next = {
      ...previous,
      diagnostics: ["Display scale: 150%"],
      settings: { ...previous.settings, appearanceTheme: "catc-light" as const }
    };

    const operations = diffWorkbenchState(previous, next);
    expect(operations.map((operation) => operation.type)).toEqual(["shell.replace"]);
    expect(applyWorkbenchDelta(previous, envelope(operations))).toEqual(next);
  });

  it("reconciles only a changed agent and workflow domain", () => {
    const previousProject = projectView();
    const previous = { ...baseState(), projects: [previousProject], activeProjectId: previousProject.record.id };
    const agent = createAgentSkeleton("coding", "Builder", "Implement the feature", "mock-model");
    const nextProject: LoadedProjectView = {
      ...previousProject,
      record: {
        ...previousProject.record,
        workflow: {
          ...previousProject.record.workflow,
          workflowStage: "coding_running"
        },
        agents: [agent]
      }
    };
    const next = { ...previous, projects: [nextProject] };

    const operations = diffWorkbenchState(previous, next);
    expect(operations.map((operation) => operation.type)).toEqual([
      "project.workflow.replace",
      "project.agents.reconcile"
    ]);
    expect(applyWorkbenchDelta(previous, envelope(operations))).toEqual(next);
  });

  it("validates snapshots and rejects protocol drift", () => {
    const snapshot = {
      protocolVersion: RENDERER_STATE_PROTOCOL_VERSION,
      streamId: "stream-1",
      revision: 0,
      data: baseState()
    };
    expect(rendererSnapshotEnvelopeSchema.parse(snapshot)).toEqual(snapshot);
    expect(() => rendererDeltaEnvelopeSchema.parse({ ...envelope([]), protocolVersion: 3 })).toThrow();
  });
});
