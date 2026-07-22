import { afterEach, describe, expect, it } from "vitest";
import type { ServerRequest } from "@generated/app-server";
import type { JsonValue } from "@generated/app-server/serde_json/JsonValue";
import type { DynamicToolCallResponse } from "@generated/app-server/v2";
import { AppService } from "@runtime/appService";
import { MockCodexTransport } from "@runtime/mockCodexTransport";
import type { PreviewProjectContext } from "@runtime/previewBroker";
import { createAgentSkeleton, createLocalProjectRecord } from "@shared/defaults";
import type {
  AgentState,
  LocalProjectRecord,
  PreviewAction,
  PreviewCheckpointKind,
  PreviewReadiness,
  PreviewSessionProjection,
  PreviewSessionStatus
} from "@shared/types";
import { nowIso } from "@shared/utils";
import { createTempDir } from "./helpers";

type BrowserToolRequest = Extract<ServerRequest, { method: "item/tool/call" }>;

interface BrowserSessionOwnership {
  projectId: string;
  sessionId: string;
}

interface BrowserTestProject {
  record: LocalProjectRecord;
}

interface BrowserTestService {
  projects: Map<string, BrowserTestProject>;
  previewBroker: FakePreviewBroker;
  transport: CapturingBrowserTransport;
  agentBrowserSessions: Map<string, BrowserSessionOwnership>;
  previewProjectContext: (
    project: BrowserTestProject,
    agent?: AgentState
  ) => Promise<PreviewProjectContext>;
  processBrowserToolRequest: (
    request: BrowserToolRequest,
    project: BrowserTestProject,
    agent: AgentState
  ) => Promise<void>;
  evaluateBrowserGateForContext: (
    project: BrowserTestProject,
    context: PreviewProjectContext
  ) => Promise<{ allowed: boolean; message: string }>;
  scheduleProjectSave: () => void;
  persistProjectUpdate: () => Promise<void>;
  syncWorkflowState: () => void;
  emitState: () => void;
  emitStateNow: () => void;
}

const createSession = (
  projectId: string,
  id: string,
  status: PreviewSessionStatus = "ready",
  checkpointKind: PreviewCheckpointKind = "explicit",
  sourceRevision = "revision:operator"
): PreviewSessionProjection => {
  const timestamp = nowIso();
  return {
    id,
    projectId,
    projectFingerprint: "browser-tool-project-fingerprint",
    sourceRevision,
    checkpointKind,
    status,
    recipe: {
      id: "test-preview",
      adapter: "vite",
      source: "detected",
      command: "npm",
      args: ["run", "dev"],
      cwd: ".",
      urlPath: "/",
      fingerprint: "test-preview-recipe"
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    readyAt: status === "ready" ? timestamp : undefined,
    validatedUrl: status === "ready" ? "http://127.0.0.1:4173/" : undefined,
    message: status === "trust_required" ? "Trust this project to run: npm run dev" : "Browser evidence is ready for review.",
    artifacts: [],
    console: [],
    network: [],
    blockedOrigins: []
  };
};

class FakePreviewBroker {
  activeSession?: PreviewSessionProjection;
  nextStartStatus: PreviewSessionStatus = "ready";
  startDelayMs = 0;
  startCalls = 0;
  trustCalls = 0;
  readonly actionCalls: Array<{ projectId: string; sessionId: string; action: PreviewAction }> = [];

  getProjection(): { activeSession?: PreviewSessionProjection; latestReport?: undefined } {
    return { activeSession: this.activeSession };
  }

  async getReadiness(context: PreviewProjectContext): Promise<PreviewReadiness> {
    return {
      projectId: context.projectId,
      status: "ready",
      message: "Preview is ready.",
      checkedAt: nowIso()
    };
  }

  async startPreview(
    context: PreviewProjectContext,
    checkpointKind: PreviewCheckpointKind
  ): Promise<PreviewSessionProjection> {
    this.startCalls += 1;
    if (this.startDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.startDelayMs));
    }
    const session = createSession(
      context.projectId,
      `agent-session-${this.startCalls}`,
      this.nextStartStatus,
      checkpointKind,
      context.sourceRevision
    );
    this.nextStartStatus = "ready";
    this.activeSession = session;
    return session;
  }

  async trustAndStartPreview(projectId: string, sessionId: string): Promise<PreviewSessionProjection> {
    if (
      !this.activeSession ||
      this.activeSession.projectId !== projectId ||
      this.activeSession.id !== sessionId ||
      this.activeSession.status !== "trust_required"
    ) {
      throw new Error("Only the active trust request can be started.");
    }
    this.trustCalls += 1;
    const session = createSession(
      projectId,
      `${sessionId}-trusted`,
      "ready",
      this.activeSession.checkpointKind,
      this.activeSession.sourceRevision
    );
    this.activeSession = session;
    return session;
  }

  async performAction(
    projectId: string,
    sessionId: string,
    action: PreviewAction
  ): Promise<PreviewSessionProjection> {
    this.actionCalls.push({ projectId, sessionId, action });
    if (
      !this.activeSession ||
      this.activeSession.projectId !== projectId ||
      this.activeSession.id !== sessionId ||
      this.activeSession.status !== "ready"
    ) {
      throw new Error("The requested preview session is not active for this project.");
    }
    return this.activeSession;
  }

  async stopPreview(projectId: string, sessionId: string): Promise<void> {
    if (this.activeSession?.projectId === projectId && this.activeSession.id === sessionId) {
      this.activeSession = {
        ...this.activeSession,
        status: "stopped",
        stoppedAt: nowIso(),
        updatedAt: nowIso()
      };
    }
  }

  async dispose(): Promise<void> {
    return;
  }
}

class CapturingBrowserTransport extends MockCodexTransport {
  readonly responses = new Map<string, DynamicToolCallResponse>();

  override async respond(serverRequestId?: string | number, result?: unknown): Promise<void> {
    if (serverRequestId !== undefined) {
      this.responses.set(String(serverRequestId), result as DynamicToolCallResponse);
    }
  }
}

const services = new Set<AppService>();

afterEach(async () => {
  const activeServices = [...services];
  services.clear();
  await Promise.allSettled(activeServices.map(async (service) => await service.dispose({ flush: false })));
});

const createHarness = async (): Promise<{
  service: AppService;
  runtime: BrowserTestService;
  project: BrowserTestProject;
  agentA: AgentState;
  agentB: AgentState;
  broker: FakePreviewBroker;
  transport: CapturingBrowserTransport;
}> => {
  const service = new AppService(await createTempDir("browser-tool-ownership"));
  services.add(service);
  const projectId = "browser-tool-project";
  const record = createLocalProjectRecord(
    projectId,
    "/repo",
    "/repo",
    "/repo",
    "/repo",
    {
      version: 1,
      fingerprint: "browser-tool-project-fingerprint",
      projectName: "browser-tool-project",
      kind: "folder",
      normalizedRemotes: [],
      manifestSignature: "manifest",
      treeSignature: "tree"
    },
    {
      interfaceSchemaVersion: 1,
      appMinVersion: "1.0.0",
      projectKind: "folder"
    }
  );
  const agentA = createAgentSkeleton("manual", "Browser agent A", "Inspect the interface.", "gpt-test");
  const agentB = createAgentSkeleton("manual", "Browser agent B", "Inspect the interface.", "gpt-test");
  record.agents.push(agentA, agentB);
  const project: BrowserTestProject = { record };
  const broker = new FakePreviewBroker();
  const transport = new CapturingBrowserTransport();
  const runtime = service as unknown as BrowserTestService;
  runtime.projects.set(projectId, project);
  runtime.previewBroker = broker;
  runtime.transport = transport;
  runtime.previewProjectContext = async (_project, agent) => ({
    projectId,
    projectFingerprint: record.identity.fingerprint,
    projectRoot: record.projectRoot,
    projectHostPath: record.hostPath,
    sourceRevision: `revision:agent:${agent?.id ?? "operator"}`,
    cycleNumber: record.workflow.workflowCycle.cycleNumber
  });
  runtime.scheduleProjectSave = () => undefined;
  runtime.persistProjectUpdate = async () => undefined;
  runtime.syncWorkflowState = () => undefined;
  runtime.emitState = () => undefined;
  runtime.emitStateNow = () => undefined;
  return { service, runtime, project, agentA, agentB, broker, transport };
};

const request = (
  id: string,
  agent: AgentState,
  tool: string,
  args: Record<string, JsonValue> = {}
): BrowserToolRequest => ({
  method: "item/tool/call",
  id,
  params: {
    threadId: agent.threadId ?? `thread-${agent.id}`,
    turnId: "turn-1",
    callId: `call-${id}`,
    namespace: "workbench_preview",
    tool,
    arguments: args
  }
});

const callBrowserTool = async (
  runtime: BrowserTestService,
  transport: CapturingBrowserTransport,
  project: BrowserTestProject,
  agent: AgentState,
  id: string,
  tool: string,
  args: Record<string, JsonValue> = {}
): Promise<DynamicToolCallResponse> => {
  await runtime.processBrowserToolRequest(request(id, agent, tool, args), project, agent);
  const response = transport.responses.get(id);
  if (!response) {
    throw new Error(`Missing browser response for ${id}.`);
  }
  return response;
};

const responseText = (response: DynamicToolCallResponse): string =>
  response.contentItems
    .filter((item): item is Extract<(typeof response.contentItems)[number], { type: "inputText" }> => item.type === "inputText")
    .map((item) => item.text)
    .join("\n");

describe("AppService dynamic browser ownership", () => {
  it("does not let workbench_preview.start replace operator, pre-merge, or another agent's active session", async () => {
    const { runtime, project, agentA, agentB, broker, transport } = await createHarness();

    broker.activeSession = createSession(project.record.id, "operator-session");
    const operatorResponse = await callBrowserTool(runtime, transport, project, agentA, "operator-start", "start");
    expect(operatorResponse.success).toBe(false);
    expect(responseText(operatorResponse)).toContain("operator's active browser preview");
    expect(broker.activeSession.id).toBe("operator-session");
    expect(broker.startCalls).toBe(0);

    broker.activeSession = createSession(project.record.id, "pre-merge-session", "ready", "pre_merge");
    const preMergeResponse = await callBrowserTool(runtime, transport, project, agentA, "pre-merge-start", "start");
    expect(preMergeResponse.success).toBe(false);
    expect(responseText(preMergeResponse)).toContain("active pre-merge browser gate");
    expect(broker.activeSession.id).toBe("pre-merge-session");
    expect(broker.startCalls).toBe(0);

    broker.activeSession = undefined;
    const agentBStart = await callBrowserTool(runtime, transport, project, agentB, "agent-b-start", "start");
    expect(agentBStart.success).toBe(true);
    const agentBSessionId = broker.getProjection().activeSession?.id;
    const agentAResponse = await callBrowserTool(runtime, transport, project, agentA, "agent-a-start", "start");
    expect(agentAResponse.success).toBe(false);
    expect(responseText(agentAResponse)).toContain("another agent's active browser session");
    expect(broker.getProjection().activeSession?.id).toBe(agentBSessionId);
    expect(broker.startCalls).toBe(1);
  });

  it("serializes simultaneous starts so only one agent can claim the project browser", async () => {
    const { runtime, project, agentA, agentB, broker, transport } = await createHarness();
    broker.startDelayMs = 25;

    const [responseA, responseB] = await Promise.all([
      callBrowserTool(runtime, transport, project, agentA, "concurrent-a", "start"),
      callBrowserTool(runtime, transport, project, agentB, "concurrent-b", "start")
    ]);

    expect(responseA.success).toBe(true);
    expect(responseB.success).toBe(false);
    expect(responseText(responseB)).toContain("another agent's active browser session");
    expect(broker.startCalls).toBe(1);
    expect(runtime.agentBrowserSessions.get(agentA.id)?.sessionId).toBe(broker.activeSession?.id);
    expect(runtime.agentBrowserSessions.has(agentB.id)).toBe(false);
  });

  it("keeps operator and pre-merge lifecycle mutations from replacing live sessions", async () => {
    const { service, runtime, project, agentA, broker, transport } = await createHarness();
    broker.activeSession = createSession(project.record.id, "live-pre-merge", "ready", "pre_merge", "merge-revision");

    await expect(service.startProjectPreview(project.record.id, "explicit")).rejects.toThrow(/cannot be replaced/);
    expect(broker.activeSession.id).toBe("live-pre-merge");
    expect(broker.startCalls).toBe(0);

    broker.activeSession = createSession(project.record.id, "live-operator-preview");
    const gateResult = await runtime.evaluateBrowserGateForContext(project, {
      projectId: project.record.id,
      projectFingerprint: project.record.identity.fingerprint,
      projectRoot: project.record.projectRoot,
      projectHostPath: project.record.hostPath,
      sourceRevision: "merge-revision",
      cycleNumber: project.record.workflow.workflowCycle.cycleNumber
    });
    expect(gateResult.allowed).toBe(false);
    expect(gateResult.message).toContain("cannot replace an active explicit preview");
    expect(broker.activeSession.id).toBe("live-operator-preview");
    expect(broker.startCalls).toBe(0);

    broker.activeSession = undefined;
    const agentStart = await callBrowserTool(runtime, transport, project, agentA, "stop-owned-start", "start");
    expect(agentStart.success).toBe(true);
    const agentSessionId = broker.getProjection().activeSession?.id;
    expect(runtime.agentBrowserSessions.get(agentA.id)?.sessionId).toBe(agentSessionId);
    await service.stopProjectPreview(project.record.id, agentSessionId!);
    expect(runtime.agentBrowserSessions.has(agentA.id)).toBe(false);
    expect(broker.getProjection().activeSession?.status).toBe("stopped");
  });

  it("routes actions only to the exact ready session owned by the requesting agent", async () => {
    const { runtime, project, agentA, agentB, broker, transport } = await createHarness();
    const started = await callBrowserTool(runtime, transport, project, agentA, "owned-start", "start");
    expect(started.success).toBe(true);
    const ownedSessionId = broker.activeSession?.id;

    const foreignAction = await callBrowserTool(runtime, transport, project, agentB, "foreign-action", "snapshot");
    expect(foreignAction.success).toBe(false);
    expect(responseText(foreignAction)).toContain("does not own a ready browser preview");
    expect(broker.actionCalls).toHaveLength(0);

    const ownedAction = await callBrowserTool(runtime, transport, project, agentA, "owned-action", "snapshot");
    expect(ownedAction.success).toBe(true);
    expect(broker.actionCalls).toHaveLength(1);
    expect(broker.actionCalls[0]?.sessionId).toBe(ownedSessionId);

    broker.activeSession = createSession(project.record.id, "replacement-operator-session");
    const staleAction = await callBrowserTool(runtime, transport, project, agentA, "stale-action", "snapshot");
    expect(staleAction.success).toBe(false);
    expect(responseText(staleAction)).toContain("session is stale");
    expect(runtime.agentBrowserSessions.has(agentA.id)).toBe(false);
    expect(broker.actionCalls).toHaveLength(1);
  });

  it("routes native select and bounded wait actions only through the requesting agent's exact session", async () => {
    const { runtime, project, agentA, agentB, broker, transport } = await createHarness();
    const started = await callBrowserTool(runtime, transport, project, agentA, "action-start", "start");
    expect(started.success).toBe(true);
    const ownedSessionId = broker.activeSession?.id;

    const foreignSelect = await callBrowserTool(
      runtime,
      transport,
      project,
      agentB,
      "foreign-select",
      "select",
      { ref: "element-7", values: ["alpha"] }
    );
    expect(foreignSelect.success).toBe(false);
    expect(responseText(foreignSelect)).toContain("does not own a ready browser preview");
    expect(broker.actionCalls).toHaveLength(0);

    const ownedSelect = await callBrowserTool(
      runtime,
      transport,
      project,
      agentA,
      "owned-select",
      "select",
      { ref: "element-7", values: ["alpha", "beta"] }
    );
    const ownedWait = await callBrowserTool(
      runtime,
      transport,
      project,
      agentA,
      "owned-wait",
      "wait",
      { milliseconds: 1_250 }
    );

    expect(ownedSelect.success).toBe(true);
    expect(ownedWait.success).toBe(true);
    expect(broker.actionCalls).toEqual([
      {
        projectId: project.record.id,
        sessionId: ownedSessionId,
        action: { type: "select", ref: "element-7", values: ["alpha", "beta"] }
      },
      {
        projectId: project.record.id,
        sessionId: ownedSessionId,
        action: { type: "wait", milliseconds: 1_250 }
      }
    ]);

    const outOfBoundsWait = await callBrowserTool(
      runtime,
      transport,
      project,
      agentA,
      "out-of-bounds-wait",
      "wait",
      { milliseconds: 30_001 }
    );
    expect(outOfBoundsWait.success).toBe(false);
    expect(broker.actionCalls).toHaveLength(2);
  });

  it("transfers an exact trust restart to its agent and rejects stale trust ownership", async () => {
    const { service, runtime, project, agentA, broker, transport } = await createHarness();
    broker.nextStartStatus = "trust_required";
    const trustResponse = await callBrowserTool(runtime, transport, project, agentA, "trust-start", "start");
    expect(trustResponse.success).toBe(false);
    const pendingSessionId = broker.activeSession?.id;
    expect(pendingSessionId).toBeTruthy();
    expect(runtime.agentBrowserSessions.get(agentA.id)?.sessionId).toBe(pendingSessionId);

    const trustedSession = await service.grantPreviewTrust(project.record.id, pendingSessionId!);
    expect(trustedSession.status).toBe("ready");
    expect(trustedSession.id).not.toBe(pendingSessionId);
    expect(runtime.agentBrowserSessions.get(agentA.id)?.sessionId).toBe(trustedSession.id);
    const trustedAction = await callBrowserTool(runtime, transport, project, agentA, "trusted-action", "snapshot");
    expect(trustedAction.success).toBe(true);
    expect(broker.actionCalls.at(-1)?.sessionId).toBe(trustedSession.id);

    const staleTrust = createSession(
      project.record.id,
      "stale-trust-session",
      "trust_required",
      "explicit",
      `revision:agent:${agentA.id}`
    );
    broker.activeSession = staleTrust;
    runtime.agentBrowserSessions.set(agentA.id, {
      projectId: project.record.id,
      sessionId: staleTrust.id
    });
    broker.activeSession = createSession(project.record.id, "newer-operator-session");
    await expect(service.grantPreviewTrust(project.record.id, staleTrust.id)).rejects.toThrow(/stale/);
    expect(runtime.agentBrowserSessions.has(agentA.id)).toBe(false);
    expect(broker.trustCalls).toBe(1);
    expect(broker.activeSession.id).toBe("newer-operator-session");
  });
});
