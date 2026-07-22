import { EventEmitter } from "node:events";
import { once } from "node:events";
import { access, lstat, mkdir, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { nanoid } from "nanoid";
import { z } from "zod";
import { resolveProjectPath } from "@shared/pathUtils";
import {
  previewActionSchema,
  previewArtifactMetadataSchema,
  previewConsoleEntrySchema,
  previewNetworkEntrySchema,
  previewSnapshotSchema,
  projectTrustRecordSchema
} from "@shared/previewSchemas";
import type {
  AppSettings,
  PreviewAction,
  PreviewArtifactMetadata,
  PreviewCheckpointKind,
  PreviewGateReport,
  PreviewReadiness,
  PreviewRecipe,
  PreviewSessionProjection,
  ProjectTrustRecord
} from "@shared/types";
import { nowIso } from "@shared/utils";
import {
  RuntimeCommandExecutor,
  type StructuredCommandSpec,
  type WslResolvedNodeRuntime
} from "./execution";
import { sha256 } from "./hashUtils";
import { detectPreviewRecipe } from "./previewRecipe";

const PREVIEW_PROTOCOL_VERSION = 1;
const MAX_WORKER_LINE_BYTES = 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const START_REQUEST_TIMEOUT_MS = 180_000;
const ACTION_REQUEST_TIMEOUT_MS = 45_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const MAX_ACTIVE_SESSIONS = 2;
const MAX_PENDING_REQUESTS = 32;
const MAX_RETAINED_SESSIONS = 24;
const MAX_RETAINED_PROJECT_STATE = 200;
const MAX_TRUST_RECORDS = 1_000;
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const SESSION_IDLE_TIMEOUT_MS = 30 * 60_000;
const SAFE_ARTIFACT_FILE_NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/;

export const buildPreviewNodeCommandSpec = (
  runtime: Pick<WslResolvedNodeRuntime, "resolvedNodeCommand" | "runtimePathDirs">,
  args: string[],
  limits: Pick<StructuredCommandSpec, "timeoutMs" | "maxOutputBytes"> = {}
): StructuredCommandSpec => ({
  command: runtime.resolvedNodeCommand,
  args,
  runtimePathDirs: [...runtime.runtimePathDirs],
  ...limits
});

const readBoundedFile = async (filePath: string, maxBytes: number): Promise<Buffer> => {
  const file = await open(filePath, "r");
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > maxBytes) {
      throw new Error(`File exceeded its ${maxBytes} byte read limit or is not regular.`);
    }
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let total = 0;
    while (total <= maxBytes) {
      const { bytesRead } = await file.read(buffer, total, maxBytes + 1 - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > maxBytes) {
      throw new Error(`File exceeded its ${maxBytes} byte read limit.`);
    }
    return buffer.subarray(0, total);
  } finally {
    await file.close();
  }
};

const previewProjectContextSchema = z.object({
  projectId: z.string().min(1).max(500).refine((value) => !value.includes("\0")),
  projectFingerprint: z.string().min(1).max(1_000),
  projectRoot: z.string().min(1).max(4_000).refine((value) => !value.includes("\0")),
  projectHostPath: z.string().min(1).max(4_000).refine((value) => !value.includes("\0")),
  sourceRevision: z.string().min(1).max(1_000),
  cycleNumber: z.number().int().nonnegative()
}).strict();

const workerEventSchema = z.object({
  event: z.string().min(1).max(100),
  params: z.record(z.string(), z.unknown()).default({})
});

const workerResponseSchema = z.object({
  id: z.number().int().positive(),
  result: z.unknown().optional(),
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    data: z.unknown().optional()
  }).optional()
}).refine(
  (value) => (value.result !== undefined) !== (value.error !== undefined),
  "Worker response must include exactly one of result or error."
);

const workerArtifactSchema = previewArtifactMetadataSchema.extend({
  id: z.string().min(1).max(200),
  label: z.string().min(1).max(200),
  sizeBytes: z.number().int().nonnegative().max(MAX_ARTIFACT_BYTES),
  fileName: z.string().regex(SAFE_ARTIFACT_FILE_NAME)
});

const workerStartResultSchema = z.object({
  protocolVersion: z.literal(PREVIEW_PROTOCOL_VERSION),
  url: z.string().url(),
  snapshot: previewSnapshotSchema,
  artifacts: z.array(workerArtifactSchema).max(100),
  console: z.array(previewConsoleEntrySchema).max(500),
  network: z.array(previewNetworkEntrySchema).max(1_000)
});

const workerPingResultSchema = z.object({
  protocolVersion: z.literal(PREVIEW_PROTOCOL_VERSION),
  node: z.string(),
  browserReady: z.boolean(),
  browserInstalled: z.boolean().default(false),
  browserExecutable: z.string().optional(),
  browserError: z.string().optional()
});

type PendingWorkerRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type PreviewWorkerEvents = {
  event: [event: string, params: Record<string, unknown>];
  exit: [error?: Error];
};

class PreviewWorkerConnection extends EventEmitter<PreviewWorkerEvents> {
  private child?: ChildProcessWithoutNullStreams;
  private nodeRuntime?: WslResolvedNodeRuntime;
  private stdoutBuffer = "";
  private stderr = "";
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingWorkerRequest>();
  private disposed = false;
  private closing = false;
  private exitHandled = false;

  constructor(
    private readonly settings: AppSettings,
    private readonly workerExecutionPath: string
  ) {
    super();
  }

  async start(): Promise<void> {
    const executor = new RuntimeCommandExecutor({
      executionMode: process.platform === "win32" ? "wsl" : this.settings.executionMode,
      distroName: this.settings.distroName
    });
    const node = await executor.resolveWslNodeRuntime({ timeoutMs: 15_000 });
    this.nodeRuntime = node;
    this.child = executor.spawnStructuredCommand(buildPreviewNodeCommandSpec(node, [this.workerExecutionPath], {
      timeoutMs: START_REQUEST_TIMEOUT_MS
    }));
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-32_000);
    });
    this.child.on("error", (error) => this.handleExit(error));
    this.child.on("exit", (code, signal) => {
      if (this.disposed) {
        this.handleExit();
        return;
      }
      this.handleExit(new Error(
        code === null
          ? `Preview broker exited with signal ${signal ?? "unknown"}.`
          : `Preview broker exited with code ${code}.${this.stderr.trim() ? ` ${this.stderr.trim()}` : ""}`
      ));
    });
    this.child.stdin.on("error", (error) => this.handleExit(error));
    await new Promise<void>((resolve, reject) => {
      this.child?.once("spawn", resolve);
      this.child?.once("error", reject);
    });
  }

  get resolvedNodeRuntime(): WslResolvedNodeRuntime | undefined {
    return this.nodeRuntime;
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer) > MAX_WORKER_LINE_BYTES * 2) {
      this.handleExit(new Error("Preview broker output exceeded the framing limit."));
      void this.dispose();
      return;
    }
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) {
        if (Buffer.byteLength(line) > MAX_WORKER_LINE_BYTES) {
          this.handleExit(new Error("Preview broker emitted an oversized protocol line."));
          void this.dispose();
          return;
        }
        this.handleLine(line);
      }
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      this.emit("event", "protocol.error", { message: "Preview broker emitted malformed JSON." });
      return;
    }
    const event = workerEventSchema.safeParse(raw);
    if (event.success) {
      this.emit("event", event.data.event, event.data.params);
      return;
    }
    const response = workerResponseSchema.safeParse(raw);
    if (!response.success) {
      this.emit("event", "protocol.error", { message: "Preview broker emitted an invalid message." });
      return;
    }
    const pending = this.pending.get(response.data.id);
    if (!pending) {
      return;
    }
    this.pending.delete(response.data.id);
    clearTimeout(pending.timer);
    if (response.data.error) {
      const error = Object.assign(new Error(response.data.error.message), { code: response.data.error.code });
      pending.reject(error);
      return;
    }
    pending.resolve(response.data.result);
  }

  private handleExit(error?: Error): void {
    if (this.exitHandled) {
      return;
    }
    this.exitHandled = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error ?? new Error("Preview broker stopped."));
    }
    this.pending.clear();
    if (!this.closing) {
      this.emit("exit", error);
    }
  }

  async request(method: string, params: unknown = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (!this.child || this.disposed || !this.child.stdin.writable) {
      throw new Error("Preview broker is not running.");
    }
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      throw new Error(`Preview broker has reached its ${MAX_PENDING_REQUESTS} request backpressure limit.`);
    }
    const id = this.nextRequestId++;
    const payload = `${JSON.stringify({ protocolVersion: PREVIEW_PROTOCOL_VERSION, id, method, params })}\n`;
    if (Buffer.byteLength(payload) > MAX_WORKER_LINE_BYTES) {
      throw new Error("Preview broker request exceeded the protocol limit.");
    }
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Preview broker request ${method} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
    });
    if (!this.child.stdin.write(payload)) {
      await once(this.child.stdin, "drain");
    }
    return await response;
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.closing = true;
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        await this.request("stop", {}, 5_000);
      } catch {
        // The exact worker process below is still terminated.
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
      await Promise.race([
        child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, "exit").then(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000))
      ]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
    this.disposed = true;
    this.child = undefined;
    this.handleExit();
  }
}

export interface PreviewProjectContext {
  projectId: string;
  projectFingerprint: string;
  projectRoot: string;
  projectHostPath: string;
  sourceRevision: string;
  cycleNumber: number;
}

export interface PreviewArtifactPayload {
  metadata: PreviewArtifactMetadata;
  bytes: Uint8Array;
}

type ManagedSession = {
  context: PreviewProjectContext;
  projection: PreviewSessionProjection;
  connection?: PreviewWorkerConnection;
  artifactDirectory: string;
  artifactFiles: Map<string, string>;
  report?: PreviewGateReport;
  idleTimer?: ReturnType<typeof setTimeout>;
};

type PreviewBrokerEvents = {
  changed: [projectId: string];
};

export interface PreviewBrokerOptions {
  sessionIdleTimeoutMs?: number;
}

export class PreviewBroker extends EventEmitter<PreviewBrokerEvents> {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly reports = new Map<string, PreviewGateReport>();
  private readonly readiness = new Map<string, PreviewReadiness>();
  private trustRecords?: ProjectTrustRecord[];
  private trustLoadPromise?: Promise<ProjectTrustRecord[]>;
  private trustWriteQueue: Promise<void> = Promise.resolve();
  private trustMutationQueue: Promise<void> = Promise.resolve();
  private browserInstallPromise?: Promise<void>;
  private readonly sessionIdleTimeoutMs: number;
  private readonly projectOperationQueues = new Map<string, Promise<void>>();
  private artifactStorageReady?: Promise<void>;
  private artifactStorageError?: Error;

  constructor(
    private readonly appDataDir: string,
    private readonly workerHostPath: string,
    private readonly settingsProvider: () => AppSettings,
    options: PreviewBrokerOptions = {}
  ) {
    super();
    this.sessionIdleTimeoutMs = Math.max(1_000, options.sessionIdleTimeoutMs ?? SESSION_IDLE_TIMEOUT_MS);
  }

  private trustFilePath(): string {
    return path.join(this.appDataDir, "preview", "trust.json");
  }

  private artifactRoot(): string {
    return path.join(this.appDataDir, "preview", "artifacts");
  }

  private assertManagedArtifactRoot(): string {
    const previewRoot = path.resolve(this.appDataDir, "preview");
    const artifactRoot = path.resolve(this.artifactRoot());
    const relative = path.relative(previewRoot, artifactRoot);
    if (relative !== "artifacts" || path.isAbsolute(relative)) {
      throw new Error("Preview artifact storage resolved outside the managed preview directory.");
    }
    return artifactRoot;
  }

  private async clearManagedArtifactTree(): Promise<void> {
    await rm(this.assertManagedArtifactRoot(), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }

  private async ensureArtifactStorageReady(): Promise<void> {
    if (!this.artifactStorageReady) {
      // Reports and sessions intentionally live only in memory. Evidence left by
      // a previous process is unreachable, so the first preview in this process
      // starts from an empty managed tree. Lazy initialization prevents merely
      // constructing a replacement service from disturbing a still-live broker.
      this.artifactStorageReady = this.clearManagedArtifactTree().catch((error) => {
        this.artifactStorageError = error instanceof Error ? error : new Error(String(error));
      });
    }
    await this.artifactStorageReady;
    if (this.artifactStorageError) {
      throw new Error(`Preview artifact cleanup failed: ${this.artifactStorageError.message}`);
    }
  }

  private executionPath(hostPath: string): string {
    const settings = this.settingsProvider();
    const runtimeSettings = process.platform === "win32"
      ? { ...settings, executionMode: "wsl" as const }
      : settings;
    return resolveProjectPath(hostPath, runtimeSettings, process.platform).wslPath;
  }

  private async loadTrustRecords(): Promise<ProjectTrustRecord[]> {
    if (this.trustRecords) {
      return this.trustRecords;
    }
    if (!this.trustLoadPromise) {
      this.trustLoadPromise = (async () => {
        try {
          const raw = (await readBoundedFile(this.trustFilePath(), 1024 * 1024)).toString("utf8");
          this.trustRecords = z.array(projectTrustRecordSchema).max(MAX_TRUST_RECORDS).parse(JSON.parse(raw));
        } catch {
          // Corrupt, oversized, or unavailable trust data always fails closed.
          this.trustRecords = [];
        }
        return this.trustRecords;
      })().finally(() => {
        this.trustLoadPromise = undefined;
      });
    }
    return await this.trustLoadPromise;
  }

  private async saveTrustRecords(): Promise<void> {
    const records = await this.loadTrustRecords();
    this.trustWriteQueue = this.trustWriteQueue.catch(() => undefined).then(async () => {
      const filePath = this.trustFilePath();
      await mkdir(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.${nanoid()}.tmp`;
      try {
        await writeFile(temporaryPath, `${JSON.stringify(records, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await rename(temporaryPath, filePath);
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    await this.trustWriteQueue;
  }

  private async serializeTrustMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.trustMutationQueue.catch(() => undefined).then(operation);
    this.trustMutationQueue = run.then(() => undefined, () => undefined);
    return await run;
  }

  private async serializeProjectOperation<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.projectOperationQueues.get(projectId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(operation);
    const tail = run.then(() => undefined, () => undefined);
    this.projectOperationQueues.set(projectId, tail);
    try {
      return await run;
    } finally {
      if (this.projectOperationQueues.get(projectId) === tail) {
        this.projectOperationQueues.delete(projectId);
      }
    }
  }

  private async isTrusted(context: PreviewProjectContext, recipe: PreviewRecipe): Promise<boolean> {
    return await this.serializeTrustMutation(async () => {
      const records = await this.loadTrustRecords();
      const record = records.find((entry) =>
        entry.projectId === context.projectId &&
        entry.projectFingerprint === context.projectFingerprint &&
        entry.recipeFingerprint === recipe.fingerprint
      );
      if (!record) {
        return false;
      }
      record.lastUsedAt = nowIso();
      await this.saveTrustRecords();
      return true;
    });
  }

  async grantTrust(context: PreviewProjectContext): Promise<ProjectTrustRecord> {
    context = previewProjectContextSchema.parse(context);
    return await this.serializeProjectOperation(context.projectId, async () => await this.grantTrustUnlocked(context));
  }

  private async grantTrustUnlocked(context: PreviewProjectContext): Promise<ProjectTrustRecord> {
    const detection = await detectPreviewRecipe(context.projectHostPath);
    if (detection.status !== "ready") {
      throw new Error(detection.message);
    }
    const record = await this.grantTrustForRecipe(context, detection.recipe);
    this.emit("changed", context.projectId);
    return record;
  }

  private async grantTrustForRecipe(
    context: PreviewProjectContext,
    recipe: PreviewRecipe
  ): Promise<ProjectTrustRecord> {
    const record = await this.serializeTrustMutation(async () => {
      const records = await this.loadTrustRecords();
      const timestamp = nowIso();
      const nextRecord: ProjectTrustRecord = {
        projectId: context.projectId,
        projectFingerprint: context.projectFingerprint,
        recipeFingerprint: recipe.fingerprint,
        grantedAt: timestamp,
        lastUsedAt: timestamp
      };
      const retained = records
        .filter((entry) => entry.projectId !== context.projectId)
        .sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt))
        .slice(0, MAX_TRUST_RECORDS - 1);
      retained.push(nextRecord);
      this.trustRecords = retained;
      await this.saveTrustRecords();
      return nextRecord;
    });
    return record;
  }

  async trustAndStartPreview(projectId: string, sessionId: string): Promise<PreviewSessionProjection> {
    if (!projectId || projectId.length > 500 || !sessionId || sessionId.length > 500) {
      throw new Error("Preview project or session identifier is invalid.");
    }
    return await this.serializeProjectOperation(projectId, async () => {
      const session = this.sessions.get(sessionId);
      if (!session || session.projection.projectId !== projectId || session.context.projectId !== projectId) {
        throw new Error("The requested trust session does not belong to this project.");
      }
      if (session.projection.status !== "trust_required") {
        throw new Error("Only a pending trust-required preview session can be trusted and started.");
      }

      const context = previewProjectContextSchema.parse(session.context);
      const checkpointKind = session.projection.checkpointKind;
      const detection = await detectPreviewRecipe(context.projectHostPath);
      if (detection.status !== "ready") {
        throw new Error(detection.message);
      }
      if (detection.recipe.fingerprint !== session.projection.recipe.fingerprint) {
        throw new Error("The preview recipe changed after trust was requested. Review the updated command before running it.");
      }

      await this.grantTrustForRecipe(context, session.projection.recipe);
      this.emit("changed", projectId);
      return await this.startPreviewUnlocked(context, checkpointKind);
    });
  }

  private async createConnection(): Promise<PreviewWorkerConnection> {
    await access(this.workerHostPath);
    const connection = new PreviewWorkerConnection(this.settingsProvider(), this.executionPath(this.workerHostPath));
    await connection.start();
    return connection;
  }

  private async playwrightCliHostPath(): Promise<string> {
    const workerDirectory = path.dirname(this.workerHostPath);
    const candidates = [
      path.join(workerDirectory, "node_modules", "playwright-core", "cli.js"),
      path.resolve(workerDirectory, "..", "..", "node_modules", "playwright-core", "cli.js")
    ];
    for (const candidate of candidates) {
      try {
        await access(candidate);
        return candidate;
      } catch {
        // Try the next deterministic development or packaged layout.
      }
    }
    throw new Error("The packaged Playwright installer could not be located.");
  }

  private browserInstallCommand(cliHostPath: string, nodeCommand = "node"): string {
    const executionPath = this.executionPath(cliHostPath);
    const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
    return `${quote(nodeCommand)} ${quote(executionPath)} install chromium`;
  }

  private setReadiness(projectId: string, result: PreviewReadiness): void {
    this.readiness.delete(projectId);
    this.readiness.set(projectId, result);
    while (this.readiness.size > MAX_RETAINED_PROJECT_STATE) {
      const oldestProjectId = this.readiness.keys().next().value;
      if (!oldestProjectId) break;
      this.readiness.delete(oldestProjectId);
    }
    this.emit("changed", projectId);
  }

  async getReadiness(context: PreviewProjectContext, force = false): Promise<PreviewReadiness> {
    context = previewProjectContextSchema.parse(context);
    const detection = await detectPreviewRecipe(context.projectHostPath);
    if (detection.status !== "ready") {
      const result: PreviewReadiness = {
        projectId: context.projectId,
        status: "recipe_required",
        message: detection.message,
        checkedAt: nowIso()
      };
      this.setReadiness(context.projectId, result);
      return result;
    }
    if (!force) {
      const cached = this.readiness.get(context.projectId);
      if (cached?.recipe?.fingerprint === detection.recipe.fingerprint && Date.now() - new Date(cached.checkedAt).getTime() < 30_000) {
        return cached;
      }
    }

    let connection: PreviewWorkerConnection | undefined;
    try {
      connection = await this.createConnection();
      const ping = workerPingResultSchema.parse(await connection.request("ping"));
      const browserLaunchFailure = ping.browserInstalled && !ping.browserReady;
      const result: PreviewReadiness = {
        projectId: context.projectId,
        status: ping.browserReady ? "ready" : browserLaunchFailure ? "unavailable" : "browser_required",
        message: ping.browserReady
          ? detection.message
          : browserLaunchFailure
            ? `Managed Chromium is installed but could not start in WSL. ${ping.browserError ?? "The required Linux browser dependencies may be missing."} Install missing WSL libraries only with explicit administrator approval (for example, Playwright's install-deps chromium command), then retry.`
            : `The managed WSL Chromium revision is not installed yet.${ping.browserError ? ` ${ping.browserError}` : ""}`,
        recipe: detection.recipe,
        browserInstallCommand: ping.browserReady || browserLaunchFailure
          ? undefined
          : this.browserInstallCommand(
            await this.playwrightCliHostPath(),
            connection.resolvedNodeRuntime?.resolvedNodeCommand
          ),
        checkedAt: nowIso()
      };
      this.setReadiness(context.projectId, result);
      return result;
    } catch (error) {
      const result: PreviewReadiness = {
        projectId: context.projectId,
        status: "unavailable",
        message: error instanceof Error ? error.message : String(error),
        recipe: detection.recipe,
        checkedAt: nowIso()
      };
      this.setReadiness(context.projectId, result);
      return result;
    } finally {
      await connection?.dispose();
    }
  }

  async installBrowser(context: PreviewProjectContext): Promise<PreviewReadiness> {
    context = previewProjectContextSchema.parse(context);
    if (!this.browserInstallPromise) {
      this.browserInstallPromise = (async () => {
        const cliHostPath = await this.playwrightCliHostPath();
        const settings = this.settingsProvider();
        const executor = new RuntimeCommandExecutor({
          executionMode: process.platform === "win32" ? "wsl" : settings.executionMode,
          distroName: settings.distroName
        });
        const node = await executor.resolveWslNodeRuntime({ timeoutMs: 15_000 });
        await executor.execStructuredCommand(buildPreviewNodeCommandSpec(node, [
          this.executionPath(cliHostPath),
          "install",
          "chromium"
        ], {
          timeoutMs: INSTALL_TIMEOUT_MS,
          maxOutputBytes: 8 * 1024 * 1024
        }));
      })().finally(() => {
        this.browserInstallPromise = undefined;
      });
    }
    await this.browserInstallPromise;
    return await this.getReadiness(context, true);
  }

  private sessionForProject(projectId: string): ManagedSession | undefined {
    return [...this.sessions.values()].reverse().find((session) => session.projection.projectId === projectId);
  }

  getProjection(projectId: string): {
    readiness?: PreviewReadiness;
    activeSession?: PreviewSessionProjection;
    latestReport?: PreviewGateReport;
  } {
    const session = this.sessionForProject(projectId);
    return {
      readiness: this.readiness.get(projectId),
      activeSession: session?.projection,
      latestReport: session?.report ?? this.reports.get(projectId)
    };
  }

  private updateSession(session: ManagedSession, patch: Partial<PreviewSessionProjection>): void {
    session.projection = {
      ...session.projection,
      ...patch,
      updatedAt: nowIso()
    };
    this.emit("changed", session.projection.projectId);
  }

  private touchSession(session: ManagedSession): void {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = undefined;
    }
    if (session.projection.status !== "ready") {
      return;
    }
    session.idleTimer = setTimeout(() => {
      void this.stopPreview(session.projection.projectId, session.projection.id).catch(() => undefined);
    }, this.sessionIdleTimeoutMs);
    session.idleTimer.unref?.();
  }

  private setReport(projectId: string, report: PreviewGateReport): void {
    this.reports.delete(projectId);
    this.reports.set(projectId, report);
    while (this.reports.size > MAX_RETAINED_PROJECT_STATE) {
      const oldestProjectId = this.reports.keys().next().value;
      if (!oldestProjectId) break;
      this.reports.delete(oldestProjectId);
    }
  }

  private async removeRetainedSession(sessionId: string, session: ManagedSession): Promise<void> {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    this.sessions.delete(sessionId);
    const artifactRoot = path.resolve(this.artifactRoot());
    const artifactDirectory = path.resolve(session.artifactDirectory);
    const relative = path.relative(artifactRoot, artifactDirectory);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      await rm(artifactDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private pruneRetainedSessions(): void {
    if (this.sessions.size <= MAX_RETAINED_SESSIONS) return;
    const removable = [...this.sessions.entries()].filter(([, session]) =>
      ["failed", "stopped", "trust_required"].includes(session.projection.status)
    );
    for (const [sessionId, session] of removable) {
      if (this.sessions.size <= MAX_RETAINED_SESSIONS) break;
      void this.removeRetainedSession(sessionId, session);
    }
  }

  private registerArtifact(session: ManagedSession, raw: unknown): PreviewArtifactMetadata | undefined {
    const parsed = workerArtifactSchema.safeParse(raw);
    if (!parsed.success || path.basename(parsed.data.fileName) !== parsed.data.fileName) {
      return undefined;
    }
    const { fileName, ...metadata } = parsed.data;
    session.artifactFiles.set(metadata.id, fileName);
    const artifacts = [metadata, ...session.projection.artifacts.filter((entry) => entry.id !== metadata.id)].slice(0, 200);
    session.projection = { ...session.projection, artifacts, updatedAt: nowIso() };
    return metadata;
  }

  private refreshReport(session: ManagedSession): PreviewGateReport | undefined {
    if (!session.report) return undefined;
    const screenshotCount = session.projection.artifacts.filter((artifact) => artifact.kind === "screenshot").length;
    const accessibilityCount = session.projection.artifacts.filter((artifact) => artifact.kind === "accessibility").length;
    const runtimeFindings = [
      ...session.projection.console
        .filter((entry) => entry.level === "error")
        .map((entry) => `Console: ${entry.text}`),
      ...session.projection.network
        .filter((entry) => entry.outcome !== "ok")
        .map((entry) => `${entry.outcome === "blocked" ? "Blocked" : "Network"}: ${entry.method} ${entry.url}${entry.status ? ` (${entry.status})` : ""}`)
    ];
    const evidenceFindings = [
      ...(screenshotCount < 3 ? [`Browser evidence is incomplete: expected 3 viewport screenshots, found ${screenshotCount}.`] : []),
      ...(accessibilityCount < 1 ? ["Browser evidence is incomplete: no accessibility snapshot was captured."] : [])
    ];
    const blockingFindings = [...new Set([...evidenceFindings, ...runtimeFindings])].slice(0, 200);
    const artifactIds = session.projection.artifacts.map((artifact) => artifact.id);
    const verdict = evidenceFindings.length > 0 ? "fail" : blockingFindings.length > 0 ? "needs_review" : "pass";
    const evidenceIsUnchanged = session.report.verdict === verdict &&
      JSON.stringify(session.report.artifactIds) === JSON.stringify(artifactIds) &&
      JSON.stringify(session.report.blockingFindings) === JSON.stringify(blockingFindings);
    const report: PreviewGateReport = {
      ...session.report,
      verdict,
      deterministicResults: [
        "Preview server passed its loopback readiness probe.",
        `${screenshotCount} viewport screenshots captured.`,
        `${accessibilityCount} accessibility snapshot${accessibilityCount === 1 ? "" : "s"} captured.`,
        `${session.projection.blockedOrigins.length} external browser origin${session.projection.blockedOrigins.length === 1 ? "" : "s"} blocked.`
      ],
      artifactIds,
      blockingFindings,
      reviewedAt: evidenceIsUnchanged ? session.report.reviewedAt : undefined,
      approvedAt: evidenceIsUnchanged ? session.report.approvedAt : undefined
    };
    session.report = report;
    this.setReport(session.projection.projectId, report);
    return report;
  }

  private attachConnectionEvents(session: ManagedSession, connection: PreviewWorkerConnection): void {
    connection.on("event", (event, params) => {
      let evidenceChanged = false;
      if (event === "artifact") {
        evidenceChanged = this.registerArtifact(session, params) !== undefined;
      } else if (event === "console") {
        const entry = previewConsoleEntrySchema.safeParse(params);
        if (entry.success) {
          session.projection.console = [...session.projection.console, entry.data].slice(-500);
          evidenceChanged = true;
        }
      } else if (event === "network") {
        const entry = previewNetworkEntrySchema.safeParse(params);
        if (entry.success) {
          session.projection.network = [...session.projection.network, entry.data].slice(-1_000);
          evidenceChanged = true;
          if (entry.data.outcome === "blocked") {
            try {
              const origin = new URL(entry.data.url).origin;
              session.projection.blockedOrigins = [...new Set([...session.projection.blockedOrigins, origin])].slice(-100);
            } catch {
              // An invalid URL is retained in the bounded network record only.
            }
          }
        }
      } else if (event === "session.phase") {
        const phase = typeof params.phase === "string" ? params.phase.replaceAll("_", " ") : "starting";
        this.updateSession(session, { message: `Preview ${phase}` });
        return;
      } else if (event === "worker.error" || event === "protocol.error") {
        const message = typeof params.message === "string" ? params.message : "Preview worker error";
        if (session.idleTimer) clearTimeout(session.idleTimer);
        this.updateSession(session, { status: "failed", message, error: message });
        void connection.dispose();
        return;
      }
      if (evidenceChanged) this.refreshReport(session);
      this.updateSession(session, {});
    });
    connection.on("exit", (error) => {
      if (session.projection.status !== "stopped" && session.projection.status !== "failed") {
        if (session.idleTimer) clearTimeout(session.idleTimer);
        this.updateSession(session, {
          status: "failed",
          message: "Preview browser stopped unexpectedly.",
          error: error?.message ?? "Preview browser stopped unexpectedly."
        });
      }
    });
  }

  async startPreview(
    context: PreviewProjectContext,
    checkpointKind: PreviewCheckpointKind = "explicit"
  ): Promise<PreviewSessionProjection> {
    context = previewProjectContextSchema.parse(context);
    if (checkpointKind !== "explicit" && checkpointKind !== "pre_merge") {
      throw new Error("Unknown preview checkpoint kind.");
    }
    return await this.serializeProjectOperation(
      context.projectId,
      async () => await this.startPreviewUnlocked(context, checkpointKind)
    );
  }

  private async startPreviewUnlocked(
    context: PreviewProjectContext,
    checkpointKind: PreviewCheckpointKind
  ): Promise<PreviewSessionProjection> {
    await this.ensureArtifactStorageReady();
    const detection = await detectPreviewRecipe(context.projectHostPath);
    if (detection.status !== "ready") {
      throw new Error(detection.message);
    }
    const existing = this.sessionForProject(context.projectId);
    if (existing) {
      await this.stopPreviewUnlocked(context.projectId, existing.projection.id);
    }
    const active = [...this.sessions.values()].filter((session) =>
      !["failed", "stopped", "trust_required"].includes(session.projection.status)
    );
    if (active.length >= MAX_ACTIVE_SESSIONS) {
      throw new Error(`At most ${MAX_ACTIVE_SESSIONS} preview sessions may run at once.`);
    }

    const sessionId = `preview-${nanoid()}`;
    const timestamp = nowIso();
    const artifactDirectory = path.join(this.artifactRoot(), sha256(context.projectId).slice(0, 32), sessionId);
    const projection: PreviewSessionProjection = {
      id: sessionId,
      projectId: context.projectId,
      projectFingerprint: context.projectFingerprint,
      sourceRevision: context.sourceRevision,
      checkpointKind,
      status: "starting",
      recipe: detection.recipe,
      createdAt: timestamp,
      updatedAt: timestamp,
      message: "Preparing a trusted WSL preview session",
      artifacts: [],
      console: [],
      network: [],
      blockedOrigins: []
    };
    const session: ManagedSession = {
      context: { ...context },
      projection,
      artifactDirectory,
      artifactFiles: new Map()
    };
    this.sessions.set(sessionId, session);
    this.pruneRetainedSessions();

    let trusted: boolean;
    try {
      trusted = await this.isTrusted(context, detection.recipe);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.updateSession(session, { status: "failed", message, error: message });
      throw error;
    }
    if (!trusted) {
      this.updateSession(session, {
        status: "trust_required",
        message: `Trust this project to run: ${`${detection.recipe.command} ${detection.recipe.args.join(" ")}`.slice(0, 2_000)}`
      });
      return session.projection;
    }

    let connection: PreviewWorkerConnection | undefined;
    try {
      await mkdir(artifactDirectory, { recursive: true });
      connection = await this.createConnection();
      session.connection = connection;
      this.attachConnectionEvents(session, connection);
      this.updateSession(session, { status: "starting", message: "Starting the project preview server" });
      const result = workerStartResultSchema.parse(await connection.request("start", {
        projectRoot: context.projectRoot,
        recipe: detection.recipe,
        artifactDir: this.executionPath(artifactDirectory),
        startTimeoutMs: 120_000
      }, START_REQUEST_TIMEOUT_MS));
      const parsedUrl = new URL(result.url);
      if (parsedUrl.protocol !== "http:" || parsedUrl.hostname !== "127.0.0.1" || !parsedUrl.port) {
        throw new Error("Preview worker returned an invalid non-loopback URL.");
      }
      for (const artifact of result.artifacts) {
        this.registerArtifact(session, artifact);
      }
      this.updateSession(session, {
        status: "ready",
        message: "Browser evidence is ready for review.",
        readyAt: nowIso(),
        validatedUrl: result.url,
        latestSnapshot: result.snapshot,
        console: result.console.slice(-500),
        network: result.network.slice(-1_000)
      });
      session.report = {
        id: `preview-report-${nanoid()}`,
        projectId: context.projectId,
        cycleNumber: context.cycleNumber,
        checkpointKind,
        sourceRevision: context.sourceRevision,
        recipeFingerprint: detection.recipe.fingerprint,
        verdict: "fail",
        deterministicResults: [],
        artifactIds: [],
        blockingFindings: [],
        createdAt: nowIso()
      };
      const report = this.refreshReport(session);
      this.updateSession(session, {
        message: report?.verdict === "pass"
          ? "Browser evidence is ready for review."
          : "Browser evidence is ready with findings that require review."
      });
      this.touchSession(session);
      this.emit("changed", context.projectId);
      return session.projection;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.updateSession(session, { status: "failed", message, error: message });
      await connection?.dispose();
      this.pruneRetainedSessions();
      throw error;
    }
  }

  async performAction(projectId: string, sessionId: string, rawAction: PreviewAction): Promise<PreviewSessionProjection> {
    const action = previewActionSchema.parse(rawAction) as PreviewAction;
    return await this.serializeProjectOperation(
      projectId,
      async () => await this.performActionUnlocked(projectId, sessionId, action)
    );
  }

  private async performActionUnlocked(
    projectId: string,
    sessionId: string,
    action: PreviewAction
  ): Promise<PreviewSessionProjection> {
    const session = this.sessions.get(sessionId);
    if (!session || session.projection.projectId !== projectId || !session.connection || session.projection.status !== "ready") {
      throw new Error("The requested preview session is not active for this project.");
    }
    this.touchSession(session);
    try {
      const result = await session.connection.request("action", { action }, ACTION_REQUEST_TIMEOUT_MS);
      if (action.type !== "screenshot") {
        const snapshot = previewSnapshotSchema.safeParse(result);
        if (snapshot.success) {
          this.updateSession(session, { latestSnapshot: snapshot.data });
        }
      } else {
        this.registerArtifact(session, result);
        this.updateSession(session, {});
      }
      const report = this.refreshReport(session);
      if (report) {
        this.updateSession(session, {
          message: report.verdict === "pass"
            ? "Browser evidence is ready for review."
            : "Browser evidence is ready with findings that require review."
        });
      }
      this.touchSession(session);
      return session.projection;
    } catch (error) {
      if (error instanceof Error && error.message.includes("timed out")) {
        this.updateSession(session, { status: "failed", message: error.message, error: error.message });
        await session.connection.dispose();
      }
      throw error;
    }
  }

  async getArtifact(projectId: string, sessionId: string, artifactId: string): Promise<PreviewArtifactPayload> {
    const session = this.sessions.get(sessionId);
    if (!session || session.projection.projectId !== projectId) {
      throw new Error("Unknown preview session.");
    }
    const metadata = session.projection.artifacts.find((entry) => entry.id === artifactId);
    const fileName = session.artifactFiles.get(artifactId);
    if (!metadata || !fileName || path.basename(fileName) !== fileName) {
      throw new Error("Unknown preview artifact.");
    }
    const filePath = path.join(session.artifactDirectory, fileName);
    const relative = path.relative(session.artifactDirectory, filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Preview artifact path escaped its session directory.");
    }
    const symbolicFile = await lstat(filePath);
    if (!symbolicFile.isFile() || symbolicFile.isSymbolicLink() || symbolicFile.size > MAX_ARTIFACT_BYTES) {
      throw new Error("Preview artifact is unavailable or exceeds the 20 MB read limit.");
    }
    const resolvedDirectory = await realpath(session.artifactDirectory);
    const resolvedFile = await realpath(filePath);
    const realRelative = path.relative(resolvedDirectory, resolvedFile);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      throw new Error("Preview artifact resolved outside its session directory.");
    }
    const bytes = new Uint8Array(await readBoundedFile(resolvedFile, MAX_ARTIFACT_BYTES));
    this.touchSession(session);
    return { metadata: { ...metadata, sizeBytes: bytes.byteLength }, bytes };
  }

  validatedUrl(projectId: string, sessionId: string): string {
    const session = this.sessions.get(sessionId);
    if (!session || session.projection.projectId !== projectId || session.projection.status !== "ready" || !session.projection.validatedUrl) {
      throw new Error("The preview session does not have a validated browser URL.");
    }
    const parsed = new URL(session.projection.validatedUrl);
    if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port) {
      throw new Error("The preview URL is not a validated loopback address.");
    }
    this.touchSession(session);
    return parsed.toString();
  }

  approveReport(projectId: string, sessionId: string): PreviewGateReport {
    if (this.projectOperationQueues.has(projectId)) {
      throw new Error("Wait for the active preview operation to finish before approving its evidence.");
    }
    const session = this.sessions.get(sessionId);
    if (!session || session.projection.projectId !== projectId || !session.report || session.projection.status !== "ready") {
      throw new Error("No preview gate report is ready for review.");
    }
    const currentReport = this.refreshReport(session);
    if (!currentReport || currentReport.verdict === "fail") {
      throw new Error("Incomplete browser evidence cannot be approved; capture the required checkpoints first.");
    }
    const timestamp = nowIso();
    session.report = {
      ...session.report,
      reviewedAt: timestamp,
      approvedAt: timestamp
    };
    this.setReport(projectId, session.report);
    this.touchSession(session);
    this.emit("changed", projectId);
    return session.report;
  }

  async stopPreview(projectId: string, sessionId: string): Promise<void> {
    await this.serializeProjectOperation(projectId, async () => await this.stopPreviewUnlocked(projectId, sessionId));
  }

  private async stopPreviewUnlocked(projectId: string, sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.projection.projectId !== projectId) {
      return;
    }
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = undefined;
    }
    await session.connection?.dispose();
    session.connection = undefined;
    this.updateSession(session, {
      status: "stopped",
      message: "Preview session stopped",
      stoppedAt: nowIso()
    });
    this.pruneRetainedSessions();
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.sessions.values()].map(async (session) => {
      if (session.idleTimer) clearTimeout(session.idleTimer);
      await session.connection?.dispose();
    }));
    this.sessions.clear();
    this.reports.clear();
    this.readiness.clear();
    if (this.artifactStorageReady) {
      await this.artifactStorageReady;
      await this.clearManagedArtifactTree().catch(() => undefined);
    }
  }
}
