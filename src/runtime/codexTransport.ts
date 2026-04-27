import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ClientRequest, InitializeResponse, ServerNotification, ServerRequest } from "@generated/app-server";
import type { ModelListResponse, ThreadReadResponse, ThreadResumeResponse, ThreadStartParams, ThreadStartResponse, TurnStartParams, TurnStartResponse } from "@generated/app-server/v2";
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
}

export interface CodexTransport {
  initialize(): Promise<InitializeResponse>;
  listModels(): Promise<ModelListResponse>;
  startThread(params: ThreadStartParams): Promise<ThreadStartResponse>;
  resumeThread(threadId: string): Promise<ThreadResumeResponse>;
  readThread(threadId: string, includeTurns: boolean): Promise<ThreadReadResponse>;
  startTurn(params: TurnStartParams): Promise<TurnStartResponse>;
  respond(serverRequestId: string | number, result: unknown): Promise<void>;
  dispose(): Promise<void>;
  on<E extends keyof TransportEventMap>(event: E, listener: (...args: TransportEventMap[E]) => void): this;
}

interface CodexLaunchPlan {
  plan: ExecutionPlan;
  requestedCommand: string;
  resolvedCommand?: string;
  resolvedNodeCommand?: string;
  resolvedUser?: string;
}

const DEFAULT_CODEX_REQUEST_TIMEOUT_MS = 120_000;

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
  private readonly pending = new Map<string | number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private requestId = 1;
  private buffer = "";
  private stderrBuffer = "";

  constructor(
    private readonly settings: AppSettings,
    private readonly launchPlan: CodexLaunchPlan
  ) {
    super();
    this.process = spawn(this.launchPlan.plan.file, this.launchPlan.plan.args, this.launchPlan.plan.options);
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (chunk: string) => {
      this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-4000);
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
      for (const pending of this.pending.values()) {
        pending.reject(new Error(mapped));
      }
      this.pending.clear();
    });
    this.process.on("exit", (code) => {
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
        : "Codex app-server exited unexpectedly.";
      for (const pending of this.pending.values()) {
        pending.reject(new Error(failureMessage));
      }
      this.pending.clear();
    });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      const message = JSON.parse(line) as Record<string, unknown>;
      if ("method" in message && "id" in message) {
        this.emit("request", message as ServerRequest);
        continue;
      }
      if ("method" in message) {
        this.emit("notification", message as ServerNotification);
        continue;
      }
      if ("id" in message) {
        const id = message.id as string | number;
        const pending = this.pending.get(id);
        if (!pending) {
          continue;
        }
        this.pending.delete(id);
        if ("error" in message && message.error) {
          const error = message.error as { message?: string };
          pending.reject(new Error(error.message ?? "Codex app-server request failed"));
        } else {
          pending.resolve((message as { result?: unknown }).result);
        }
      }
    }
  }

  private async call<TResponse>(request: ClientRequest): Promise<TResponse> {
    const message = {
      jsonrpc: "2.0",
      ...request
    };
    const id = request.id;
    return await new Promise<TResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.delete(id)) {
          return;
        }
        reject(new Error(`Codex app-server request timed out after ${DEFAULT_CODEX_REQUEST_TIMEOUT_MS / 1000}s: ${request.method}`));
      }, DEFAULT_CODEX_REQUEST_TIMEOUT_MS);
      timeout.unref();

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value as TResponse);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });

      try {
        this.process.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async initialize(): Promise<InitializeResponse> {
    return await this.call<InitializeResponse>({
      id: this.requestId++,
      method: "initialize",
      params: {
        clientInfo: {
          name: "codex-agent-workbench",
          title: "Codex Agent Workbench",
          version: "0.1.0"
        },
        capabilities: {
          experimentalApi: true
        }
      }
    });
  }

  async listModels(): Promise<ModelListResponse> {
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
      });
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

  async startThread(params: ThreadStartParams): Promise<ThreadStartResponse> {
    return await this.call<ThreadStartResponse>({
      id: this.requestId++,
      method: "thread/start",
      params
    });
  }

  async resumeThread(threadId: string): Promise<ThreadResumeResponse> {
    return await this.call<ThreadResumeResponse>({
      id: this.requestId++,
      method: "thread/resume",
      params: {
        threadId,
        persistExtendedHistory: true
      }
    });
  }

  async readThread(threadId: string, includeTurns: boolean): Promise<ThreadReadResponse> {
    return await this.call<ThreadReadResponse>({
      id: this.requestId++,
      method: "thread/read",
      params: {
        threadId,
        includeTurns
      }
    });
  }

  async startTurn(params: TurnStartParams): Promise<TurnStartResponse> {
    return await this.call<TurnStartResponse>({
      id: this.requestId++,
      method: "turn/start",
      params
    });
  }

  async respond(serverRequestId: string | number, result: unknown): Promise<void> {
    this.process.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: serverRequestId,
        result
      })}\n`,
      "utf8"
    );
  }

  async dispose(): Promise<void> {
    if (this.process.exitCode !== null || this.process.killed) {
      return;
    }

    await new Promise<void>((resolve) => {
      const complete = (): void => {
        clearTimeout(forceKillTimer);
        resolve();
      };
      const forceKillTimer = setTimeout(() => {
        if (this.process.exitCode === null && !this.process.killed) {
          this.process.kill("SIGKILL");
        }
      }, 500);
      forceKillTimer.unref();

      this.process.once("exit", () => complete());
      this.process.stdin.end();
      this.process.kill("SIGTERM");
    });
  }
}
