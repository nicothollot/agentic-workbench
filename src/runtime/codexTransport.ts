import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ClientRequest, InitializeParams, InitializeResponse, ServerNotification, ServerRequest } from "@generated/app-server";
import type { ModelListResponse, ThreadReadResponse, ThreadResumeResponse, ThreadStartParams, ThreadStartResponse, TurnStartParams, TurnStartResponse } from "@generated/app-server/v2";
import { APP_VERSION } from "@shared/constants";
import type { AppSettings } from "@shared/types";
import {
  RuntimeCommandExecutor,
  buildStructuredExecutionPlan,
  buildWslLoginShellExecutionPlan,
  describeExecutionFailure,
  resolveExecutionMode,
  type ExecutionPlan
} from "./execution";

export interface TransportEventMap {
  notification: [ServerNotification];
  request: [ServerRequest];
  exit: [number | null];
  protocolError: [CodexTransportProtocolError];
}

export interface CodexTransportRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface CodexTransport {
  initialize(options?: CodexTransportRequestOptions): Promise<InitializeResponse>;
  listModels(options?: CodexTransportRequestOptions): Promise<ModelListResponse>;
  startThread(params: ThreadStartParams, options?: CodexTransportRequestOptions): Promise<ThreadStartResponse>;
  resumeThread(threadId: string, options?: CodexTransportRequestOptions): Promise<ThreadResumeResponse>;
  readThread(threadId: string, includeTurns: boolean, options?: CodexTransportRequestOptions): Promise<ThreadReadResponse>;
  startTurn(params: TurnStartParams, options?: CodexTransportRequestOptions): Promise<TurnStartResponse>;
  respond(serverRequestId: string | number, result: unknown, options?: CodexTransportRequestOptions): Promise<void>;
  dispose(): Promise<void>;
  on<E extends keyof TransportEventMap>(event: E, listener: (...args: TransportEventMap[E]) => void): this;
  off<E extends keyof TransportEventMap>(event: E, listener: (...args: TransportEventMap[E]) => void): this;
}

export interface CodexLaunchPlan {
  plan: ExecutionPlan;
  requestedCommand: string;
  resolvedCommand?: string;
  resolvedNodeCommand?: string;
  resolvedUser?: string;
}

const DEFAULT_CODEX_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_CODEX_INITIALIZE_TIMEOUT_MS = 30_000;
const DEFAULT_CODEX_MODEL_LIST_TIMEOUT_MS = 30_000;
const DEFAULT_CODEX_WRITE_TIMEOUT_MS = 30_000;
export const DEFAULT_CODEX_MAX_FRAME_CHARS = 8 * 1024 * 1024;
export const DEFAULT_CODEX_MAX_BUFFER_CHARS = 8 * 1024 * 1024;
const MAX_CODEX_STDERR_CHARS = 64 * 1024;

type ProtocolErrorCode = "MALFORMED_JSON" | "INVALID_MESSAGE" | "FRAME_TOO_LARGE" | "BUFFER_OVERFLOW" | "INCOMPLETE_FRAME";

export class CodexTransportProtocolError extends Error {
  constructor(
    readonly code: ProtocolErrorCode,
    message: string,
    readonly fatal: boolean
  ) {
    super(message);
    this.name = "CodexTransportProtocolError";
  }
}

export class CodexJsonLineDecoder {
  private buffer = "";

  constructor(
    private readonly maxFrameChars = DEFAULT_CODEX_MAX_FRAME_CHARS,
    private readonly maxBufferChars = DEFAULT_CODEX_MAX_BUFFER_CHARS
  ) {}

  push(
    chunk: string,
    onMessage: (message: unknown) => void,
    onError: (error: CodexTransportProtocolError) => void
  ): void {
    this.buffer += chunk;

    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }
      const rawLine = this.buffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!rawLine.trim()) {
        continue;
      }
      if (rawLine.length > this.maxFrameChars) {
        this.buffer = "";
        onError(new CodexTransportProtocolError(
          "FRAME_TOO_LARGE",
          `Codex app-server emitted a JSON line larger than ${this.maxFrameChars} characters.`,
          true
        ));
        return;
      }
      try {
        onMessage(JSON.parse(rawLine));
      } catch {
        onError(new CodexTransportProtocolError(
          "MALFORMED_JSON",
          `Codex app-server emitted malformed JSON (${rawLine.length} characters).`,
          false
        ));
      }
    }

    if (this.buffer.length > this.maxBufferChars || this.buffer.length > this.maxFrameChars) {
      this.buffer = "";
      onError(new CodexTransportProtocolError(
        "BUFFER_OVERFLOW",
        `Codex app-server stdout exceeded the ${Math.min(this.maxBufferChars, this.maxFrameChars)} character framing limit without a newline.`,
        true
      ));
    }
  }

  finish(onError: (error: CodexTransportProtocolError) => void): void {
    if (this.buffer.trim()) {
      const bufferedLength = this.buffer.length;
      this.buffer = "";
      onError(new CodexTransportProtocolError(
        "INCOMPLETE_FRAME",
        `Codex app-server exited with an incomplete JSON line (${bufferedLength} characters).`,
        false
      ));
    }
  }
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

export interface CodexAppServerTransportOptions {
  spawnProcess?: typeof spawn;
  maxFrameChars?: number;
  maxBufferChars?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isRequestId = (value: unknown): value is string | number =>
  typeof value === "string" || (typeof value === "number" && Number.isFinite(value));

const classifyIncomingMessage = (
  value: unknown
): { kind: "request" | "notification" | "response"; message: Record<string, unknown> } | CodexTransportProtocolError => {
  if (!isRecord(value)) {
    return new CodexTransportProtocolError("INVALID_MESSAGE", "Codex app-server emitted a non-object JSON-RPC message.", false);
  }
  if (value.jsonrpc !== undefined && value.jsonrpc !== "2.0") {
    return new CodexTransportProtocolError("INVALID_MESSAGE", "Codex app-server emitted an unsupported JSON-RPC version.", false);
  }
  if ("method" in value) {
    if (typeof value.method !== "string" || !value.method.trim()) {
      return new CodexTransportProtocolError("INVALID_MESSAGE", "Codex app-server emitted a message with an invalid method.", false);
    }
    if ("id" in value && value.id !== undefined) {
      if (!isRequestId(value.id)) {
        return new CodexTransportProtocolError("INVALID_MESSAGE", "Codex app-server emitted a request with an invalid id.", false);
      }
      return { kind: "request", message: value };
    }
    return { kind: "notification", message: value };
  }
  if (!isRequestId(value.id)) {
    return new CodexTransportProtocolError("INVALID_MESSAGE", "Codex app-server emitted a response with an invalid id.", false);
  }
  const hasResult = Object.prototype.hasOwnProperty.call(value, "result");
  const hasError = Object.prototype.hasOwnProperty.call(value, "error");
  if (hasResult === hasError || (hasError && !isRecord(value.error))) {
    return new CodexTransportProtocolError("INVALID_MESSAGE", "Codex app-server emitted a malformed response envelope.", false);
  }
  return { kind: "response", message: value };
};

const createAbortError = (method: string): Error => {
  const error = new Error(`Codex app-server request was cancelled: ${method}`);
  error.name = "AbortError";
  return error;
};

const requestTimeoutForMethod = (method: string): number => {
  if (method === "initialize") {
    return DEFAULT_CODEX_INITIALIZE_TIMEOUT_MS;
  }
  if (method === "model/list") {
    return DEFAULT_CODEX_MODEL_LIST_TIMEOUT_MS;
  }
  return DEFAULT_CODEX_REQUEST_TIMEOUT_MS;
};

export class CodexAppServerTransport extends EventEmitter<TransportEventMap> implements CodexTransport {
  static async resolveLaunchPlan(
    settings: AppSettings,
    platform: NodeJS.Platform = process.platform
  ): Promise<CodexLaunchPlan> {
    const env = settings.codexHome ? { CODEX_HOME: settings.codexHome } : undefined;
    const mode = resolveExecutionMode(settings, platform);

    if (mode !== "wsl") {
      return {
        requestedCommand: settings.codexBinaryPath,
        plan: buildStructuredExecutionPlan(
          settings,
          {
            command: settings.codexBinaryPath,
            args: ["app-server"],
            env
          },
          platform
        )
      };
    }

    const executor = new RuntimeCommandExecutor(settings, platform);
    const resolvedRuntime = await executor.resolveWslCodexRuntime({
      command: settings.codexBinaryPath
    });

    return {
      requestedCommand: settings.codexBinaryPath,
      resolvedCommand: resolvedRuntime.resolvedCodexCommand,
      resolvedNodeCommand: resolvedRuntime.resolvedNodeCommand,
      resolvedUser: resolvedRuntime.user,
      plan: buildWslLoginShellExecutionPlan(
        settings,
        {
          command: resolvedRuntime.resolvedCodexCommand ?? settings.codexBinaryPath,
          args: ["app-server"],
          env,
          runtimePathDirs: resolvedRuntime.runtimePathDirs
        },
        platform
      )
    };
  }

  private readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly decoder: CodexJsonLineDecoder;
  private requestId = 1;
  private stderrBuffer = "";
  private disposed = false;
  private terminalFailure?: Error;

  constructor(
    private readonly settings: AppSettings,
    private readonly launchPlan: CodexLaunchPlan,
    options: CodexAppServerTransportOptions = {}
  ) {
    super();
    this.decoder = new CodexJsonLineDecoder(options.maxFrameChars, options.maxBufferChars);
    const spawnProcess = options.spawnProcess ?? spawn;
    this.process = spawnProcess(
      this.launchPlan.plan.file,
      this.launchPlan.plan.args,
      this.launchPlan.plan.options
    );
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (chunk: string) => {
      this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-MAX_CODEX_STDERR_CHARS);
    });
    this.process.stdin.on("error", (error) => {
      const failure = new Error(`Codex app-server stdin failed: ${error.message}`);
      this.failTransport(failure, true);
    });
    this.process.on("error", (error) => {
      const mapped = describeExecutionFailure(
        this.settings,
        {
          command: this.launchPlan.requestedCommand,
          resolvedCommand: this.launchPlan.resolvedCommand,
          resolvedNodeCommand: this.launchPlan.resolvedNodeCommand,
          resolvedUser: this.launchPlan.resolvedUser
        },
        {
          code: (error as NodeJS.ErrnoException).code,
          message: error.message
        }
      );
      this.failTransport(new Error(mapped), false);
    });
    this.process.on("exit", (code) => {
      this.decoder.finish((error) => this.emit("protocolError", error));
      this.emit("exit", code);
      const failureMessage = this.stderrBuffer.trim()
        ? describeExecutionFailure(
          this.settings,
          {
            command: this.launchPlan.requestedCommand,
            resolvedCommand: this.launchPlan.resolvedCommand,
            resolvedNodeCommand: this.launchPlan.resolvedNodeCommand,
            resolvedUser: this.launchPlan.resolvedUser
          },
          {
            code: code ?? undefined,
            stderr: this.stderrBuffer
          }
        )
        : this.disposed
          ? "Codex app-server was disposed."
          : "Codex app-server exited unexpectedly.";
      this.failTransport(new Error(failureMessage), false);
    });
  }

  private onStdout(chunk: string): void {
    if (this.disposed || this.terminalFailure) {
      return;
    }
    this.decoder.push(
      chunk,
      (message) => this.onIncomingMessage(message),
      (error) => {
        this.emit("protocolError", error);
        if (error.fatal) {
          this.failTransport(error, true);
        }
      }
    );
  }

  private onIncomingMessage(value: unknown): void {
    const classified = classifyIncomingMessage(value);
    if (classified instanceof CodexTransportProtocolError) {
      this.emit("protocolError", classified);
      return;
    }

    const message = classified.message;
    if (classified.kind === "request") {
      this.emit("request", message as ServerRequest);
      return;
    }
    if (classified.kind === "notification") {
      this.emit("notification", message as ServerNotification);
      return;
    }

    const id = message.id as string | number;
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);
    pending.cleanup();
    if ("error" in message && message.error) {
      const error = message.error as { message?: unknown; code?: unknown };
      const codeSuffix = typeof error.code === "string" || typeof error.code === "number"
        ? ` (${error.code})`
        : "";
      pending.reject(new Error(`${typeof error.message === "string" ? error.message : "Codex app-server request failed"}${codeSuffix}`));
      return;
    }
    pending.resolve(message.result);
  }

  private failTransport(error: Error, terminate: boolean): void {
    this.terminalFailure ??= error;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.cleanup();
      pending.reject(error);
    }
    if (terminate && this.process.exitCode === null && !this.process.killed) {
      this.process.kill("SIGTERM");
    }
  }

  private async writeMessage(
    message: unknown,
    signal?: AbortSignal,
    timeoutMs = DEFAULT_CODEX_WRITE_TIMEOUT_MS
  ): Promise<void> {
    if (this.disposed || this.terminalFailure || this.process.exitCode !== null || this.process.killed) {
      throw this.terminalFailure ?? new Error("Codex app-server transport is not available.");
    }
    if (signal?.aborted) {
      throw createAbortError("write");
    }

    const serialized = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const onAbort = (): void => finish(createAbortError("write"));
      const timeout = setTimeout(() => {
        finish(new Error(`Codex app-server write timed out after ${timeoutMs / 1000}s.`));
      }, timeoutMs);
      timeout.unref();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        // The callback fires after the chunk has been flushed, including when
        // write() reports backpressure. Stream errors are surfaced here or by
        // the stdin error handler above.
        this.process.stdin.write(serialized, "utf8", (error) => finish(error));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async call<TResponse>(request: ClientRequest, options: CodexTransportRequestOptions = {}): Promise<TResponse> {
    const message = {
      jsonrpc: "2.0",
      ...request
    };
    const id = request.id;
    if (options.signal?.aborted) {
      throw createAbortError(request.method);
    }
    return await new Promise<TResponse>((resolve, reject) => {
      let settled = false;
      const timeoutMs = options.timeoutMs ?? requestTimeoutForMethod(request.method);
      const cleanup = (): void => {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const finishReject = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };
      const finishResolve = (value: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(value as TResponse);
      };
      const onAbort = (): void => {
        if (this.pending.delete(id)) {
          finishReject(createAbortError(request.method));
        }
      };
      const timeout = setTimeout(() => {
        if (!this.pending.delete(id)) {
          return;
        }
        finishReject(new Error(`Codex app-server request timed out after ${timeoutMs / 1000}s: ${request.method}`));
      }, timeoutMs);
      timeout.unref();
      options.signal?.addEventListener("abort", onAbort, { once: true });

      this.pending.set(id, {
        method: request.method,
        resolve: finishResolve,
        reject: finishReject,
        cleanup
      });

      void this.writeMessage(message, options.signal, timeoutMs).catch((error) => {
        if (!this.pending.delete(id)) {
          return;
        }
        finishReject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async initialize(options?: CodexTransportRequestOptions): Promise<InitializeResponse> {
    const params: InitializeParams = {
      clientInfo: {
        name: "codex-agent-workbench",
        title: "Codex Agent Workbench",
        version: APP_VERSION
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false
      }
    };
    return await this.call<InitializeResponse>({
      id: this.requestId++,
      method: "initialize",
      params
    }, options);
  }

  async listModels(options?: CodexTransportRequestOptions): Promise<ModelListResponse> {
    const data: ModelListResponse["data"] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;

    do {
      const response: ModelListResponse = await this.call<ModelListResponse>({
        id: this.requestId++,
        method: "model/list",
        params: {
          cursor,
          limit: 100,
          includeHidden: true
        }
      }, options);
      data.push(...response.data);
      cursor = response.nextCursor;
      if (cursor) {
        if (seenCursors.has(cursor)) {
          throw new Error(`Codex model discovery returned a repeated cursor: ${cursor}`);
        }
        seenCursors.add(cursor);
      }
    } while (cursor);

    return {
      data,
      nextCursor: null
    };
  }

  async startThread(params: ThreadStartParams, options?: CodexTransportRequestOptions): Promise<ThreadStartResponse> {
    return await this.call<ThreadStartResponse>({
      id: this.requestId++,
      method: "thread/start",
      params
    }, options);
  }

  async resumeThread(threadId: string, options?: CodexTransportRequestOptions): Promise<ThreadResumeResponse> {
    return await this.call<ThreadResumeResponse>({
      id: this.requestId++,
      method: "thread/resume",
      params: {
        threadId
      }
    }, options);
  }

  async readThread(threadId: string, includeTurns: boolean, options?: CodexTransportRequestOptions): Promise<ThreadReadResponse> {
    return await this.call<ThreadReadResponse>({
      id: this.requestId++,
      method: "thread/read",
      params: {
        threadId,
        includeTurns
      }
    }, options);
  }

  async startTurn(params: TurnStartParams, options?: CodexTransportRequestOptions): Promise<TurnStartResponse> {
    return await this.call<TurnStartResponse>({
      id: this.requestId++,
      method: "turn/start",
      params
    }, options);
  }

  async respond(
    serverRequestId: string | number,
    result: unknown,
    options?: CodexTransportRequestOptions
  ): Promise<void> {
    await this.writeMessage({
      jsonrpc: "2.0",
      id: serverRequestId,
      result
    }, options?.signal, options?.timeoutMs ?? DEFAULT_CODEX_WRITE_TIMEOUT_MS);
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.failTransport(new Error("Codex app-server transport was disposed."), false);
    if (this.process.exitCode !== null || this.process.signalCode !== null) {
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const complete = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(forceKillTimer);
        resolve();
      };
      const forceKillTimer = setTimeout(() => {
        if (this.process.exitCode === null && this.process.signalCode === null) {
          this.process.kill("SIGKILL");
        }
        complete();
      }, 500);
      forceKillTimer.unref();

      this.process.once("exit", () => complete());
      this.process.stdin.end();
      this.process.kill("SIGTERM");
    });
  }
}
