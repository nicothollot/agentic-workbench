import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "@shared/defaults";
import {
  RENDERER_STATE_PROTOCOL_VERSION,
  diffWorkbenchState,
  type RendererDeltaEnvelope,
  type RendererSnapshotEnvelope
} from "@shared/stateStream";
import type { WorkbenchState } from "@shared/types";
import type { WorkbenchApi } from "./index";

type IpcListener = (event: unknown, payload: unknown) => void;

const electronHarness = vi.hoisted(() => ({
  handlers: new Map<string, IpcListener[]>(),
  invoke: vi.fn<(channel: string, payload?: unknown) => Promise<unknown>>(),
  exposed: undefined as unknown
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: vi.fn((_key: string, value: unknown) => {
      electronHarness.exposed = value;
    })
  },
  ipcRenderer: {
    invoke: electronHarness.invoke,
    on: vi.fn((channel: string, listener: IpcListener) => {
      const listeners = electronHarness.handlers.get(channel) ?? [];
      listeners.push(listener);
      electronHarness.handlers.set(channel, listeners);
    })
  }
}));

const baseState = (diagnostics: string[]): WorkbenchState => ({
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
  diagnostics
});

const snapshot = (revision: number, state: WorkbenchState, streamId = "stream-1"): RendererSnapshotEnvelope => ({
  protocolVersion: RENDERER_STATE_PROTOCOL_VERSION,
  streamId,
  revision,
  data: state
});

const delta = (
  baseRevision: number,
  revision: number,
  previous: WorkbenchState,
  next: WorkbenchState,
  streamId = "stream-1"
): RendererDeltaEnvelope => ({
  protocolVersion: RENDERER_STATE_PROTOCOL_VERSION,
  streamId,
  baseRevision,
  revision,
  operations: diffWorkbenchState(previous, next)
});

const deferred = <T,>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

const emit = (channel: string, payload: unknown): void => {
  for (const listener of electronHarness.handlers.get(channel) ?? []) {
    listener({}, payload);
  }
};

describe("preload renderer state resynchronization", () => {
  let api: WorkbenchApi;

  beforeEach(async () => {
    vi.resetModules();
    electronHarness.handlers.clear();
    electronHarness.invoke.mockReset();
    electronHarness.exposed = undefined;
    await import("./index");
    api = electronHarness.exposed as WorkbenchApi;
  });

  it("sends project-only privileged actions as typed object payloads", async () => {
    electronHarness.invoke.mockResolvedValue(undefined);

    await api.runIntegrity("project-1");
    await api.runMerge("project-2");
    await api.revalidate("project-3");

    expect(electronHarness.invoke).toHaveBeenNthCalledWith(1, "agent:runIntegrity", { projectId: "project-1" });
    expect(electronHarness.invoke).toHaveBeenNthCalledWith(2, "agent:runMerge", { projectId: "project-2" });
    expect(electronHarness.invoke).toHaveBeenNthCalledWith(3, "project:revalidate", { projectId: "project-3" });
  });

  it("replays a delta that arrives while a resync snapshot is in flight", async () => {
    const revisionFive = baseState(["revision-5"]);
    const revisionSix = baseState(["revision-6"]);
    const revisionSeven = baseState(["revision-7"]);
    const resync = deferred<RendererSnapshotEnvelope>();
    electronHarness.invoke.mockImplementation(async (channel) => {
      if (channel === "state:subscribe") {
        return snapshot(5, revisionFive);
      }
      if (channel === "state:resync") {
        return await resync.promise;
      }
      throw new Error(`Unexpected channel: ${channel}`);
    });

    await expect(api.getState()).resolves.toEqual(revisionFive);
    emit("state:resync-required", { protocolVersion: RENDERER_STATE_PROTOCOL_VERSION });
    emit("state:delta", delta(6, 7, revisionSix, revisionSeven));
    resync.resolve(snapshot(6, revisionSix));

    await vi.waitFor(async () => {
      await expect(api.getState()).resolves.toEqual(revisionSeven);
    });
    expect(electronHarness.invoke.mock.calls.filter(([channel]) => channel === "state:resync")).toHaveLength(1);
  });

  it("never installs a lower revision returned late for the same stream", async () => {
    const revisionNine = baseState(["revision-9"]);
    const revisionTen = baseState(["revision-10"]);
    const resync = deferred<RendererSnapshotEnvelope>();
    electronHarness.invoke.mockImplementation(async (channel) => {
      if (channel === "state:subscribe") {
        return snapshot(10, revisionTen);
      }
      if (channel === "state:resync") {
        return await resync.promise;
      }
      throw new Error(`Unexpected channel: ${channel}`);
    });
    const notifications: WorkbenchState[] = [];

    await api.getState();
    api.onStateUpdated((state) => notifications.push(state));
    emit("state:resync-required", { protocolVersion: RENDERER_STATE_PROTOCOL_VERSION });
    resync.resolve(snapshot(9, revisionNine));

    await vi.waitFor(() => expect(notifications.length).toBeGreaterThan(0));
    await expect(api.getState()).resolves.toEqual(revisionTen);
  });

  it("requests another snapshot when buffered deltas do not form a complete chain", async () => {
    const revisionFive = baseState(["revision-5"]);
    const revisionSix = baseState(["revision-6"]);
    const revisionSeven = baseState(["revision-7"]);
    const revisionEight = baseState(["revision-8"]);
    const firstResync = deferred<RendererSnapshotEnvelope>();
    let resyncCalls = 0;
    electronHarness.invoke.mockImplementation(async (channel) => {
      if (channel === "state:subscribe") {
        return snapshot(5, revisionFive);
      }
      if (channel === "state:resync") {
        resyncCalls += 1;
        if (resyncCalls === 1) {
          return await firstResync.promise;
        }
        return resyncCalls === 2 ? snapshot(6, revisionSix) : snapshot(8, revisionEight);
      }
      throw new Error(`Unexpected channel: ${channel}`);
    });

    await api.getState();
    emit("state:resync-required", { protocolVersion: RENDERER_STATE_PROTOCOL_VERSION });
    emit("state:delta", delta(7, 8, revisionSeven, revisionEight));
    firstResync.resolve(snapshot(6, revisionSix));

    await vi.waitFor(async () => {
      expect(resyncCalls).toBe(3);
      await expect(api.getState()).resolves.toEqual(revisionEight);
    });
  });
});
