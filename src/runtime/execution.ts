import { execFile, spawn, type ChildProcessWithoutNullStreams, type ExecFileOptionsWithStringEncoding, type SpawnOptionsWithoutStdio } from "node:child_process";
import { posix as pathPosix } from "node:path";
import { promisify } from "node:util";
import type { AppSettings, ExecutionMode } from "@shared/types";

const execFileAsync = promisify(execFile);

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface StructuredCommandSpec {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  runtimePathDirs?: string[];
  timeoutMs?: number;
}

export interface ShellCommandSpec {
  command: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  runtimePathDirs?: string[];
  timeoutMs?: number;
}

export interface ExecutionPlan {
  file: string;
  args: string[];
  options: SpawnOptionsWithoutStdio;
}

export interface ExecutionFailureSpec {
  command: string;
  cwd?: string;
  resolvedCommand?: string;
  resolvedNodeCommand?: string;
  resolvedUser?: string;
}

export interface WslResolvedCommand {
  requestedCommand: string;
  resolvedCommand: string;
  user?: string;
}

export interface WslResolvedCodexRuntime {
  requestedCodexCommand: string;
  resolvedCodexCommand?: string;
  resolvedNodeCommand?: string;
  runtimePathDirs: string[];
  user?: string;
}

export interface WslBashCommandPlan {
  file: string;
  args: string[];
  shellCommand: string;
  transport: "argv" | "stdin";
}

interface ParsedWslCommandResolutionOutput {
  resolvedCommand: string;
  user?: string;
}

interface ParsedWslCodexRuntimeResolutionOutput {
  resolvedCodexCommand?: string;
  resolvedNodeCommand?: string;
  user?: string;
}

export const resolveExecutionMode = (
  settings: Pick<AppSettings, "executionMode">,
  platform: NodeJS.Platform = process.platform
): ExecutionMode => (platform === "win32" && settings.executionMode === "wsl" ? "wsl" : "local");

const cleanEnvironment = (env?: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );

const toWslEnvArgs = (env?: Record<string, string | undefined>): string[] =>
  Object.entries(cleanEnvironment(env)).map(([key, value]) => `${key}=${value}`);

const WSL_RESOLVED_USER_PREFIX = "__AWB_WSL_RESOLVED_USER__=";
const WSL_RESOLVED_CODEX_PREFIX = "__AWB_WSL_RESOLVED_CODEX__=";
const WSL_RESOLVED_NODE_PREFIX = "__AWB_WSL_RESOLVED_NODE__=";

const quoteForBash = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
const dedupeStrings = (values: string[]): string[] => [...new Set(values.filter(Boolean))];

const buildWslBaseArgs = (
  settings: Pick<AppSettings, "distroName">,
  cwd?: string,
  env?: Record<string, string | undefined>
): string[] => {
  const args = ["-d", settings.distroName];
  if (cwd) {
    args.push("--cd", cwd);
  }
  args.push("--exec");
  const envArgs = toWslEnvArgs(env);
  if (envArgs.length > 0) {
    args.push("env", ...envArgs);
  }
  return args;
};

export const buildWslLoginShellExecutionPlan = (
  settings: Pick<AppSettings, "executionMode" | "distroName">,
  spec: StructuredCommandSpec,
  platform: NodeJS.Platform = process.platform
): ExecutionPlan => {
  const mode = resolveExecutionMode(settings, platform);
  if (mode !== "wsl") {
    return buildStructuredExecutionPlan(settings, spec, platform);
  }

  const runtimePathPrefix = dedupeStrings(spec.runtimePathDirs ?? []).join(":");
  const shellCommand = runtimePathPrefix
    ? `export PATH=${quoteForBash(runtimePathPrefix)}:$PATH; exec "$@"`
    : "exec \"$@\"";

  return {
    file: "wsl.exe",
    args: [
      ...buildWslBaseArgs(settings, spec.cwd, spec.env),
      "bash",
      "-lc",
      shellCommand,
      "bash",
      spec.command,
      ...(spec.args ?? [])
    ],
    options: {
      env: process.env
    }
  };
};

const formatWslProbeArgs = (args: string[]): string => JSON.stringify(args);

const formatWslProbeInvocation = (plan: WslBashCommandPlan): string =>
  plan.transport === "stdin"
    ? `executable "${plan.file}" with args ${formatWslProbeArgs(plan.args)} using stdin transport`
    : `executable "${plan.file}" with args ${formatWslProbeArgs(plan.args)}`;

const logWslCodexDetection = (payload: {
  distro: string;
  executable: string;
  args: string[];
  transport: WslBashCommandPlan["transport"];
  shellCommand: string;
  exitCode: number | string | null;
  stdout: string;
  stderr: string;
  resolvedCommand?: string;
  resolvedNodeCommand?: string;
  resolvedUser?: string;
}): void => {
  console.info("[wsl-codex-detect]", JSON.stringify(payload));
};

export const buildWslBashCommandPlan = (
  settings: Pick<AppSettings, "distroName">,
  spec: Pick<ShellCommandSpec, "command" | "cwd">
): WslBashCommandPlan => {
  const args = ["-d", settings.distroName];
  if (spec.cwd) {
    args.push("--cd", spec.cwd);
  }
  args.push("bash", "-lc", spec.command);
  return {
    file: "wsl.exe",
    args,
    shellCommand: spec.command,
    transport: "argv"
  };
};

const buildWslBashStdinPlan = (
  settings: Pick<AppSettings, "distroName">,
  spec: Pick<ShellCommandSpec, "command" | "cwd">
): WslBashCommandPlan => ({
  file: "wsl.exe",
  args: [...buildWslBaseArgs(settings, spec.cwd), "bash", "-s", "--"],
  shellCommand: spec.command,
  transport: "stdin"
});

export const buildWslCommandResolutionPlan = (
  settings: Pick<AppSettings, "distroName">,
  spec: Pick<StructuredCommandSpec, "command" | "cwd">
): WslBashCommandPlan =>
  buildWslBashCommandPlan(settings, {
    command: `command -v ${quoteForBash(spec.command)}`,
    cwd: spec.cwd
  });

const buildWslCodexRuntimeResolutionShellCommand = (codexCommand: string): string => {
  const quotedCodexCommand = quoteForBash(codexCommand);
  return [
    "set -eu",
    "",
    "expand_home_path() {",
    "  local value",
    "  value=\"$1\"",
    "  case \"$value\" in",
    "    '~')",
    "      printf '%s\\n' \"$HOME\"",
    "      ;;",
    "    '~/'*)",
    "      printf '%s/%s\\n' \"$HOME\" \"${value#~/}\"",
    "      ;;",
    "    *)",
    "      printf '%s\\n' \"$value\"",
    "      ;;",
    "  esac",
    "}",
    "",
    "resolve_direct_command() {",
    "  local command_spec",
    "  command_spec=\"$(expand_home_path \"$1\")\"",
    "  case \"$command_spec\" in",
    "    */*)",
    "      if [ -f \"$command_spec\" ] && [ -x \"$command_spec\" ]; then",
    "        printf '%s\\n' \"$command_spec\"",
    "      fi",
    "      ;;",
    "    *)",
    "      command -v \"$command_spec\" 2>/dev/null || true",
    "      ;;",
    "  esac",
    "}",
    "",
    "search_nvm_command() {",
    "  local command_spec command_name nvm_dir candidate",
    "  command_spec=\"$(expand_home_path \"$1\")\"",
    "  command_name=\"${command_spec##*/}\"",
    "  nvm_dir=\"${NVM_DIR:-$HOME/.nvm}\"",
    "",
    "  if [ -d \"$nvm_dir/current/bin\" ]; then",
    "    candidate=\"$nvm_dir/current/bin/$command_name\"",
    "    if [ -f \"$candidate\" ] && [ -x \"$candidate\" ]; then",
    "      printf '%s\\n' \"$candidate\"",
    "      return 0",
    "    fi",
    "  fi",
    "",
    "  if [ -d \"$nvm_dir/versions/node\" ]; then",
    "    while IFS= read -r candidate_dir; do",
    "      candidate=\"$candidate_dir/$command_name\"",
    "      if [ -f \"$candidate\" ] && [ -x \"$candidate\" ]; then",
    "        printf '%s\\n' \"$candidate\"",
    "        return 0",
    "      fi",
    "    done < <(find \"$nvm_dir/versions/node\" -mindepth 2 -maxdepth 2 -type d -name bin -print 2>/dev/null | LC_ALL=C sort -V -r)",
    "  fi",
    "",
    "  return 1",
    "}",
    "",
    "resolve_command() {",
    "  local resolved",
    "  resolved=\"$(resolve_direct_command \"$1\")\"",
    "  if [ -n \"$resolved\" ]; then",
    "    printf '%s\\n' \"$resolved\"",
    "    return 0",
    "  fi",
    "  search_nvm_command \"$1\" || true",
    "}",
    "",
    `codex_command=${quotedCodexCommand}`,
    "resolved_codex=\"$(resolve_command \"$codex_command\")\"",
    "resolved_node=\"\"",
    "",
    "if [ -n \"$resolved_codex\" ]; then",
    "  codex_bin_dir=\"$(dirname \"$resolved_codex\")\"",
    "  if [ -f \"$codex_bin_dir/node\" ] && [ -x \"$codex_bin_dir/node\" ]; then",
    "    resolved_node=\"$codex_bin_dir/node\"",
    "  fi",
    "fi",
    "",
    "if [ -z \"$resolved_node\" ]; then",
    "  resolved_node=\"$(resolve_command node)\"",
    "fi",
    "",
    `printf '%s%s\\n' ${quoteForBash(WSL_RESOLVED_USER_PREFIX)} "\${USER:-$(id -un)}"`,
    "if [ -n \"$resolved_codex\" ]; then",
    `  printf '%s%s\\n' ${quoteForBash(WSL_RESOLVED_CODEX_PREFIX)} "$resolved_codex"`,
    "fi",
    "if [ -n \"$resolved_node\" ]; then",
    `  printf '%s%s\\n' ${quoteForBash(WSL_RESOLVED_NODE_PREFIX)} "$resolved_node"`,
    "fi",
    "",
    "if [ -z \"$resolved_codex\" ]; then",
    "  exit 127",
    "fi",
    "if [ -z \"$resolved_node\" ]; then",
    "  exit 126",
    "fi"
  ].join("\n");
};

export const buildWslCodexRuntimeResolutionPlan = (
  settings: Pick<AppSettings, "distroName">,
  spec: Pick<StructuredCommandSpec, "command" | "cwd">
): WslBashCommandPlan =>
  buildWslBashStdinPlan(settings, {
    command: buildWslCodexRuntimeResolutionShellCommand(spec.command),
    cwd: spec.cwd
  });

export const parseWslCommandResolutionOutput = (stdout: string): ParsedWslCommandResolutionOutput | null => {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return null;
  }

  const userLine = lines.find((line) => line.startsWith(WSL_RESOLVED_USER_PREFIX));
  const resolvedCommand = lines.find((line) => !line.startsWith(WSL_RESOLVED_USER_PREFIX));
  if (!resolvedCommand) {
    return null;
  }

  return {
    resolvedCommand,
    user: userLine ? userLine.slice(WSL_RESOLVED_USER_PREFIX.length).trim() : undefined
  };
};

export const parseWslCodexRuntimeResolutionOutput = (stdout: string): ParsedWslCodexRuntimeResolutionOutput => {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const userLine = lines.find((line) => line.startsWith(WSL_RESOLVED_USER_PREFIX));
  const codexLine = lines.find((line) => line.startsWith(WSL_RESOLVED_CODEX_PREFIX));
  const nodeLine = lines.find((line) => line.startsWith(WSL_RESOLVED_NODE_PREFIX));

  return {
    resolvedCodexCommand: codexLine ? codexLine.slice(WSL_RESOLVED_CODEX_PREFIX.length).trim() : undefined,
    resolvedNodeCommand: nodeLine ? nodeLine.slice(WSL_RESOLVED_NODE_PREFIX.length).trim() : undefined,
    user: userLine ? userLine.slice(WSL_RESOLVED_USER_PREFIX.length).trim() : undefined
  };
};

const getHomeDirectoryUser = (resolvedCommand: string): string | undefined => {
  const match = /^\/home\/([^/]+)\//.exec(resolvedCommand);
  return match?.[1];
};

export const buildStructuredExecutionPlan = (
  settings: Pick<AppSettings, "executionMode" | "distroName">,
  spec: StructuredCommandSpec,
  platform: NodeJS.Platform = process.platform
): ExecutionPlan => {
  const mode = resolveExecutionMode(settings, platform);
  if (mode === "local") {
    return {
      file: spec.command,
      args: spec.args ?? [],
      options: {
        cwd: spec.cwd,
        env: {
          ...process.env,
          ...cleanEnvironment(spec.env)
        }
      }
    };
  }

  const args = [...buildWslBaseArgs(settings, spec.cwd, spec.env), spec.command, ...(spec.args ?? [])];

  return {
    file: "wsl.exe",
    args,
    options: {
      env: process.env
    }
  };
};

export const buildShellExecutionPlan = (
  settings: Pick<AppSettings, "executionMode" | "distroName">,
  spec: ShellCommandSpec,
  platform: NodeJS.Platform = process.platform
): ExecutionPlan => {
  const mode = resolveExecutionMode(settings, platform);
  if (mode === "wsl") {
    const runtimePathPrefix = dedupeStrings(spec.runtimePathDirs ?? []).join(":");
    const shellCommand = runtimePathPrefix
      ? `export PATH=${quoteForBash(runtimePathPrefix)}:$PATH; ${spec.command}`
      : spec.command;
    const args = ["-d", settings.distroName];
    if (spec.cwd) {
      args.push("--cd", spec.cwd);
    }
    args.push("--exec");
    const envArgs = toWslEnvArgs(spec.env);
    if (envArgs.length > 0) {
      args.push("env", ...envArgs);
    }
    args.push("bash", "-lc", shellCommand);
    return {
      file: "wsl.exe",
      args,
      options: {
        env: process.env
      }
    };
  }

  if (platform === "win32") {
    return {
      file: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", spec.command],
      options: {
        cwd: spec.cwd,
        env: {
          ...process.env,
          ...cleanEnvironment(spec.env)
        }
      }
    };
  }

  return {
    file: "bash",
    args: ["-lc", spec.command],
    options: {
      cwd: spec.cwd,
      env: {
        ...process.env,
        ...cleanEnvironment(spec.env)
      }
    }
  };
};

const appendDetails = (message: string, details?: string): string => {
  const trimmed = details?.trim();
  return trimmed ? `${message} ${trimmed}` : message;
};

const formatWslResolutionContext = (resolvedCommand?: string, resolvedUser?: string): string => {
  if (!resolvedCommand) {
    return "";
  }

  const userSuffix = resolvedUser ? ` as WSL user "${resolvedUser}"` : "";
  return ` Resolved via the WSL bash probe to "${resolvedCommand}"${userSuffix}.`;
};

const formatWslNodeResolutionContext = (resolvedNodeCommand?: string): string =>
  resolvedNodeCommand ? ` Node.js resolved to "${resolvedNodeCommand}".` : "";

export const describeWslCommandResolutionFailure = (
  settings: Pick<AppSettings, "distroName">,
  command: string,
  plan: WslBashCommandPlan,
  error: { code?: number | string; stderr?: string; message?: string }
): string => {
  const stderr = error.stderr?.trim() ?? "";
  const code = typeof error.code === "string" ? error.code : undefined;
  const numericCode = typeof error.code === "number" ? error.code : undefined;
  const message = error.message?.trim() ?? "";
  const invocation = formatWslProbeInvocation(plan);

  if (code === "ENOENT") {
    return "WSL is not installed or wsl.exe is not available on PATH.";
  }
  if (/there is no distribution with the supplied name/i.test(stderr)) {
    return `WSL distro "${settings.distroName}" was not found.`;
  }
  if (numericCode === 127) {
    return `Command "${command}" is not installed inside WSL distro "${settings.distroName}" when checked with ${invocation}.`;
  }
  if (stderr) {
    return appendDetails(
      `Failed to resolve command "${command}" inside WSL distro "${settings.distroName}" when checked with ${invocation}.`,
      stderr
    );
  }
  return appendDetails(
    `Failed to resolve command "${command}" inside WSL distro "${settings.distroName}" when checked with ${invocation}.`,
    message
  );
};

export const describeWslCodexRuntimeResolutionFailure = (
  settings: Pick<AppSettings, "distroName">,
  command: string,
  plan: WslBashCommandPlan,
  parsed: ParsedWslCodexRuntimeResolutionOutput,
  error: { code?: number | string; stderr?: string; message?: string }
): string => {
  const stderr = error.stderr?.trim() ?? "";
  const code = typeof error.code === "string" ? error.code : undefined;
  const numericCode = typeof error.code === "number" ? error.code : undefined;
  const message = error.message?.trim() ?? "";
  const invocation = formatWslProbeInvocation(plan);

  if (code === "ENOENT") {
    return "WSL is not installed or wsl.exe is not available on PATH.";
  }
  if (/there is no distribution with the supplied name/i.test(stderr)) {
    return `WSL distro "${settings.distroName}" was not found.`;
  }
  if (!parsed.resolvedCodexCommand && numericCode === 127) {
    return `Command "${command}" is not installed inside WSL distro "${settings.distroName}" when checked with ${invocation}.`;
  }
  if (parsed.resolvedCodexCommand && !parsed.resolvedNodeCommand) {
    return appendDetails(
      `Command "${command}" was found at "${parsed.resolvedCodexCommand}" inside WSL distro "${settings.distroName}", but Node.js could not be resolved for that runtime.`,
      stderr || message
    );
  }
  if (stderr) {
    return appendDetails(
      `Failed to resolve the Codex runtime inside WSL distro "${settings.distroName}" when checked with ${invocation}.`,
      stderr
    );
  }
  return appendDetails(
    `Failed to resolve the Codex runtime inside WSL distro "${settings.distroName}" when checked with ${invocation}.`,
    message
  );
};

export const describeExecutionFailure = (
  settings: Pick<AppSettings, "executionMode" | "distroName">,
  spec: ExecutionFailureSpec,
  error: { code?: number | string; stderr?: string; message?: string },
  platform: NodeJS.Platform = process.platform
): string => {
  const mode = resolveExecutionMode(settings, platform);
  const stderr = error.stderr?.trim() ?? "";
  const code = typeof error.code === "string" ? error.code : undefined;
  const message = error.message?.trim() ?? "";
  const resolutionContext = formatWslResolutionContext(spec.resolvedCommand, spec.resolvedUser);
  const nodeResolutionContext = formatWslNodeResolutionContext(spec.resolvedNodeCommand);

  if (mode === "wsl") {
    if (code === "ENOENT") {
      return "WSL is not installed or wsl.exe is not available on PATH.";
    }
    if (/there is no distribution with the supplied name/i.test(stderr)) {
      return `WSL distro "${settings.distroName}" was not found.`;
    }
    if (/execvpe\([^)]*\) failed: no such file or directory/i.test(stderr)) {
      if (spec.resolvedCommand) {
        return appendDetails(
          `Resolved command "${spec.resolvedCommand}" could not be launched inside WSL distro "${settings.distroName}".`,
          stderr
        );
      }
      return `Command "${spec.command}" is not installed inside WSL distro "${settings.distroName}".`;
    }
    if (/\/usr\/bin\/env:.*node.*no such file or directory/i.test(stderr)) {
      if (spec.resolvedCommand) {
        return appendDetails(
          `Resolved command "${spec.resolvedCommand}" was found inside WSL distro "${settings.distroName}", but Node.js was not available on PATH for that launch.${nodeResolutionContext}`,
          stderr
        );
      }
      return appendDetails(
        `Command "${spec.command}" depends on Node.js, but node was not available on PATH inside WSL distro "${settings.distroName}".${nodeResolutionContext}`,
        stderr
      );
    }
    if (/command not found/i.test(stderr) || error.code === 127) {
      if (spec.resolvedCommand) {
        return appendDetails(
          `Resolved command "${spec.resolvedCommand}" could not be launched inside WSL distro "${settings.distroName}".`,
          stderr || message
        );
      }
      return `Command "${spec.command}" is not available inside WSL distro "${settings.distroName}".`;
    }
    if ((/failed to translate/i.test(stderr) || /no such file or directory/i.test(stderr)) && spec.cwd) {
      return appendDetails(`The translated WSL working directory "${spec.cwd}" could not be used.`, stderr);
    }
    if (stderr) {
      return appendDetails(
        `Command "${spec.command}" failed inside WSL distro "${settings.distroName}".${resolutionContext}`,
        stderr
      );
    }
    return appendDetails(
      `Command "${spec.command}" failed inside WSL distro "${settings.distroName}".${resolutionContext}`,
      message
    );
  }

  if (code === "ENOENT") {
    return `Command "${spec.command}" is not installed or not available on PATH.`;
  }
  if ((/no such file or directory/i.test(stderr) || /enoent/i.test(message)) && spec.cwd) {
    return appendDetails(`The working directory "${spec.cwd}" does not exist or is not accessible.`, stderr || message);
  }
  if (stderr) {
    return appendDetails(`Command "${spec.command}" failed.`, stderr);
  }
  return appendDetails(`Command "${spec.command}" failed.`, message);
};

type ExecutionFailure = Error & {
  stdout?: string;
  stderr?: string;
  code?: number | string;
};

const executeWslBashCommandPlan = async (plan: WslBashCommandPlan): Promise<CommandResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(plan.file, plan.args, {
      env: process.env
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finishReject = (error: ExecutionFailure): void => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };

    const finishResolve = (result: CommandResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      const failure = error as ExecutionFailure;
      failure.stdout = stdout;
      failure.stderr = stderr;
      finishReject(failure);
    });

    child.on("close", (code, signal) => {
      if (code === 0) {
        finishResolve({
          stdout,
          stderr,
          exitCode: 0
        });
        return;
      }

      const failure = new Error(
        code === null ? `WSL probe terminated with signal ${signal ?? "unknown"}.` : `WSL probe exited with code ${code}.`
      ) as ExecutionFailure;
      failure.stdout = stdout;
      failure.stderr = stderr;
      failure.code = code ?? (signal ?? undefined);
      finishReject(failure);
    });

    child.stdin.on("error", () => {
      // The bash probe can exit before stdin fully flushes on failures.
    });

    if (plan.transport === "stdin") {
      child.stdin.end(`${plan.shellCommand}\n`);
      return;
    }

    child.stdin.end();
  });

export class RuntimeCommandExecutor {
  constructor(
    private readonly settings: Pick<AppSettings, "executionMode" | "distroName">,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  spawnStructuredCommand(
    spec: StructuredCommandSpec,
    options?: Omit<SpawnOptionsWithoutStdio, "cwd" | "env">
  ): ChildProcessWithoutNullStreams {
    const plan = buildStructuredExecutionPlan(this.settings, spec, this.platform);
    return spawn(plan.file, plan.args, {
      ...plan.options,
      ...options
    });
  }

  async execStructuredCommand(spec: StructuredCommandSpec): Promise<CommandResult> {
    const plan = buildStructuredExecutionPlan(this.settings, spec, this.platform);
    try {
      const { stdout, stderr } = await execFileAsync(
        plan.file,
        plan.args,
        {
          ...(plan.options as ExecFileOptionsWithStringEncoding),
          encoding: "utf8",
          timeout: spec.timeoutMs
        }
      );
      return {
        stdout,
        stderr,
        exitCode: 0
      };
    } catch (error) {
      const typedError = error as { stdout?: string; stderr?: string; code?: number | string; message?: string };
      const failure = new Error(describeExecutionFailure(this.settings, spec, typedError, this.platform)) as ExecutionFailure;
      failure.name = "ExecutionError";
      failure.stdout = typedError.stdout ?? "";
      failure.stderr = typedError.stderr ?? "";
      failure.code = typedError.code;
      throw failure;
    }
  }

  async resolveWslCommand(spec: Pick<StructuredCommandSpec, "command" | "env" | "cwd">): Promise<WslResolvedCommand> {
    const mode = resolveExecutionMode(this.settings, this.platform);
    if (mode !== "wsl") {
      return {
        requestedCommand: spec.command,
        resolvedCommand: spec.command,
        user: process.env.USER ?? process.env.USERNAME
      };
    }

    const plan = buildWslCommandResolutionPlan(this.settings, spec);
    logWslCodexDetection({
      distro: this.settings.distroName,
      executable: plan.file,
      args: plan.args,
      transport: plan.transport,
      shellCommand: plan.shellCommand,
      exitCode: null,
      stdout: "",
      stderr: ""
    });

    try {
      const { stdout, stderr } = await executeWslBashCommandPlan(plan);
      const parsed = parseWslCommandResolutionOutput(stdout);
      logWslCodexDetection({
        distro: this.settings.distroName,
        executable: plan.file,
        args: plan.args,
        transport: plan.transport,
        shellCommand: plan.shellCommand,
        exitCode: 0,
        stdout,
        stderr,
        resolvedCommand: parsed?.resolvedCommand,
        resolvedUser: parsed?.user
      });
      if (!parsed?.resolvedCommand) {
        throw new Error(
          `Failed to resolve command "${spec.command}" inside WSL distro "${this.settings.distroName}" when checked with ${formatWslProbeInvocation(plan)}: no path was returned.`
        );
      }
      if (!parsed.resolvedCommand.startsWith("/")) {
        throw new Error(
          `Command "${spec.command}" resolved to "${parsed.resolvedCommand}" inside WSL distro "${this.settings.distroName}" when checked with ${formatWslProbeInvocation(plan)}, but not as an absolute path.`
        );
      }

      const homeDirectoryUser = getHomeDirectoryUser(parsed.resolvedCommand);
      if (homeDirectoryUser && parsed.user && homeDirectoryUser !== parsed.user) {
        throw new Error(
          `WSL user mismatch for distro "${this.settings.distroName}": command "${spec.command}" resolved to "${parsed.resolvedCommand}" when checked with ${formatWslProbeInvocation(plan)}, but the WSL bash probe is running as user "${parsed.user}".`
        );
      }

      return {
        requestedCommand: spec.command,
        resolvedCommand: parsed.resolvedCommand,
        user: parsed.user
      };
    } catch (error) {
      if (error instanceof Error && !("code" in error)) {
        throw error;
      }
      const typedError = error as { stdout?: string; stderr?: string; code?: number | string; message?: string };
      const parsed = parseWslCommandResolutionOutput(typedError.stdout ?? "");
      logWslCodexDetection({
        distro: this.settings.distroName,
        executable: plan.file,
        args: plan.args,
        transport: plan.transport,
        shellCommand: plan.shellCommand,
        exitCode: typeof typedError.code === "number" || typeof typedError.code === "string" ? typedError.code : null,
        stdout: typedError.stdout ?? "",
        stderr: typedError.stderr ?? typedError.message ?? "",
        resolvedCommand: parsed?.resolvedCommand,
        resolvedUser: parsed?.user
      });
      throw new Error(describeWslCommandResolutionFailure(this.settings, spec.command, plan, typedError));
    }
  }

  async resolveWslCodexRuntime(spec: Pick<StructuredCommandSpec, "command" | "cwd">): Promise<WslResolvedCodexRuntime> {
    const mode = resolveExecutionMode(this.settings, this.platform);
    if (mode !== "wsl") {
      return {
        requestedCodexCommand: spec.command,
        resolvedCodexCommand: spec.command,
        resolvedNodeCommand: process.execPath,
        runtimePathDirs: dedupeStrings([pathPosix.dirname(spec.command), pathPosix.dirname(process.execPath)]),
        user: process.env.USER ?? process.env.USERNAME
      };
    }

    const plan = buildWslCodexRuntimeResolutionPlan(this.settings, spec);
    logWslCodexDetection({
      distro: this.settings.distroName,
      executable: plan.file,
      args: plan.args,
      transport: plan.transport,
      shellCommand: plan.shellCommand,
      exitCode: null,
      stdout: "",
      stderr: ""
    });

    try {
      const { stdout, stderr } = await executeWslBashCommandPlan(plan);
      const parsed = parseWslCodexRuntimeResolutionOutput(stdout);
      logWslCodexDetection({
        distro: this.settings.distroName,
        executable: plan.file,
        args: plan.args,
        transport: plan.transport,
        shellCommand: plan.shellCommand,
        exitCode: 0,
        stdout,
        stderr,
        resolvedCommand: parsed.resolvedCodexCommand,
        resolvedNodeCommand: parsed.resolvedNodeCommand,
        resolvedUser: parsed.user
      });

      if (!parsed.resolvedCodexCommand) {
        throw new Error(
          `Failed to resolve command "${spec.command}" inside WSL distro "${this.settings.distroName}" when checked with ${formatWslProbeInvocation(plan)}: no Codex path was returned.`
        );
      }
      if (!parsed.resolvedCodexCommand.startsWith("/")) {
        throw new Error(
          `Command "${spec.command}" resolved to "${parsed.resolvedCodexCommand}" inside WSL distro "${this.settings.distroName}" when checked with ${formatWslProbeInvocation(plan)}, but not as an absolute path.`
        );
      }
      if (!parsed.resolvedNodeCommand) {
        throw new Error(
          `Command "${spec.command}" resolved to "${parsed.resolvedCodexCommand}" inside WSL distro "${this.settings.distroName}", but no Node.js runtime path was returned.`
        );
      }
      if (!parsed.resolvedNodeCommand.startsWith("/")) {
        throw new Error(
          `Node.js resolved to "${parsed.resolvedNodeCommand}" inside WSL distro "${this.settings.distroName}" when checked with ${formatWslProbeInvocation(plan)}, but not as an absolute path.`
        );
      }

      const homeDirectoryUser = getHomeDirectoryUser(parsed.resolvedCodexCommand);
      if (homeDirectoryUser && parsed.user && homeDirectoryUser !== parsed.user) {
        throw new Error(
          `WSL user mismatch for distro "${this.settings.distroName}": command "${spec.command}" resolved to "${parsed.resolvedCodexCommand}" when checked with ${formatWslProbeInvocation(plan)}, but the WSL bash probe is running as user "${parsed.user}".`
        );
      }

      return {
        requestedCodexCommand: spec.command,
        resolvedCodexCommand: parsed.resolvedCodexCommand,
        resolvedNodeCommand: parsed.resolvedNodeCommand,
        runtimePathDirs: dedupeStrings([
          pathPosix.dirname(parsed.resolvedCodexCommand),
          pathPosix.dirname(parsed.resolvedNodeCommand)
        ]),
        user: parsed.user
      };
    } catch (error) {
      if (error instanceof Error && !("code" in error)) {
        throw error;
      }
      const typedError = error as { stdout?: string; stderr?: string; code?: number | string; message?: string };
      const parsed = parseWslCodexRuntimeResolutionOutput(typedError.stdout ?? "");
      logWslCodexDetection({
        distro: this.settings.distroName,
        executable: plan.file,
        args: plan.args,
        transport: plan.transport,
        shellCommand: plan.shellCommand,
        exitCode: typeof typedError.code === "number" || typeof typedError.code === "string" ? typedError.code : null,
        stdout: typedError.stdout ?? "",
        stderr: typedError.stderr ?? typedError.message ?? "",
        resolvedCommand: parsed.resolvedCodexCommand,
        resolvedNodeCommand: parsed.resolvedNodeCommand,
        resolvedUser: parsed.user
      });
      throw new Error(describeWslCodexRuntimeResolutionFailure(this.settings, spec.command, plan, parsed, typedError));
    }
  }

  async runShellCommand(spec: ShellCommandSpec): Promise<CommandResult> {
    const plan = buildShellExecutionPlan(this.settings, spec, this.platform);
    try {
      const { stdout, stderr } = await execFileAsync(
        plan.file,
        plan.args,
        {
          ...(plan.options as ExecFileOptionsWithStringEncoding),
          encoding: "utf8",
          timeout: spec.timeoutMs
        }
      );
      return {
        stdout,
        stderr,
        exitCode: 0
      };
    } catch (error) {
      const typedError = error as { stdout?: string; stderr?: string; code?: number | string; message?: string };
      return {
        stdout: typedError.stdout ?? "",
        stderr: typedError.stderr ?? describeExecutionFailure(this.settings, { command: spec.command, cwd: spec.cwd }, typedError, this.platform),
        exitCode: typeof typedError.code === "number" ? typedError.code : 1
      };
    }
  }
}
