import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexAppServerTransport,
  CodexJsonLineDecoder,
  type CodexLaunchPlan
} from "@runtime/codexTransport";
import {
  RuntimeCommandExecutor,
  buildStructuredExecutionPlan,
  buildWslCodexRuntimeResolutionPlan,
  parseWslCodexRuntimeResolutionOutput
} from "@runtime/execution";
import {
  buildWslManagedWorktreeBaseResolutionSpec,
  createWorktreeAssignment,
  normalizeManagedWorktreeBaseForExecution,
  resolveLocalManagedWorktreeBaseDir
} from "@runtime/git";
import { assertExecutionPathWithinApprovedRoots } from "@runtime/projectBoundary";
import { buildWindowsWslProjectShellLaunchPlan } from "@runtime/projectShell";
import { resolveTargetProjectCommands } from "@runtime/targetProjectCommands";
import { defaultSettings } from "@shared/defaults";
import {
  detectProjectPathKind,
  resolveProjectPath,
  toProjectRelativePath,
  uncWslToLinuxPath
} from "@shared/pathUtils";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];
const localRuntime = { executionMode: "local" as const, distroName: "Ubuntu" };

const createTempRoot = async (name: string): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), `awb-${name}-`));
  tempRoots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe("Windows and WSL path hardening", () => {
  it("normalizes both supported WSL UNC spellings", () => {
    const settings = { ...defaultSettings(), executionMode: "wsl" as const, distroName: "Ubuntu" };
    const legacy = resolveProjectPath("\\\\wsl$\\Ubuntu\\home\\nicot\\repo", settings, "win32");
    const localhost = resolveProjectPath("\\\\wsl.localhost\\Ubuntu\\home\\nicot\\repo", settings, "win32");
    const forwardSlash = resolveProjectPath("//wsl.localhost/Ubuntu/home/nicot/repo", settings, "win32");

    expect(detectProjectPathKind(localhost.inputPath)).toBe("wsl-unc");
    expect(legacy.wslPath).toBe("/home/nicot/repo");
    expect(localhost.wslPath).toBe("/home/nicot/repo");
    expect(forwardSlash.hostPath).toBe("\\\\wsl.localhost\\Ubuntu\\home\\nicot\\repo");
    expect(uncWslToLinuxPath("\\\\wsl.localhost\\Ubuntu")).toEqual({
      distroName: "Ubuntu",
      linuxPath: "/"
    });
    expect(toProjectRelativePath(legacy.hostPath, localhost.hostPath)).toBe("");
  });

  it("keeps WSL shell arguments separate even when paths contain shell metacharacters", () => {
    const plan = buildWindowsWslProjectShellLaunchPlan(
      "/home/test/Project & Reports",
      "/home/test/Project & Reports/.agent-workbench/open.sh",
      "Project",
      "Ubuntu Work"
    );

    expect(plan.executable.toLowerCase()).toContain("wsl.exe");
    expect(plan.args).toEqual([
      "-d",
      "Ubuntu Work",
      "--cd",
      "/home/test/Project & Reports",
      "--exec",
      "bash",
      "/home/test/Project & Reports/.agent-workbench/open.sh"
    ]);
  });
});

describe("managed worktree boundaries", () => {
  it("expands default and relative bases under the execution user's home", () => {
    expect(resolveLocalManagedWorktreeBaseDir("~/.codex-agent-workbench/worktrees", "/home/tester"))
      .toBe("/home/tester/.codex-agent-workbench/worktrees");
    expect(resolveLocalManagedWorktreeBaseDir("managed/worktrees", "/home/tester"))
      .toBe("/home/tester/managed/worktrees");
    expect(resolveLocalManagedWorktreeBaseDir("~\\managed", "C:\\Users\\Tester"))
      .toBe("C:\\Users\\Tester\\managed");
  });

  it("passes configured WSL paths through an environment value instead of shell interpolation", () => {
    const configured = "~/worktrees'; touch /tmp/not-allowed; #";
    const spec = buildWslManagedWorktreeBaseResolutionSpec(configured);

    expect(spec.command).toBe("sh");
    expect(spec.args.join("\n")).not.toContain(configured);
    expect(spec.env.AWB_MANAGED_WORKTREE_BASE).toBe(configured);
  });

  it("normalizes Windows and UNC worktree settings into the configured WSL distro", () => {
    const settings = { executionMode: "wsl" as const, distroName: "Ubuntu" };
    expect(normalizeManagedWorktreeBaseForExecution("C:\\Users\\Tester\\worktrees", settings, "win32"))
      .toBe("/mnt/c/Users/Tester/worktrees");
    expect(normalizeManagedWorktreeBaseForExecution("\\\\wsl.localhost\\Ubuntu\\home\\tester\\worktrees", settings, "win32"))
      .toBe("/home/tester/worktrees");
    expect(() => normalizeManagedWorktreeBaseForExecution(
      "\\\\wsl$\\Debian\\home\\tester\\worktrees",
      settings,
      "win32"
    )).toThrow(/configured for "Ubuntu"/);
  });

  it("creates Git worktrees under the configured external base", async () => {
    const root = await createTempRoot("external-worktree");
    const repository = path.join(root, "repo");
    const managedBase = path.join(root, "managed worktrees");
    await mkdir(repository, { recursive: true });
    await execFileAsync("git", ["init", "-b", "main"], { cwd: repository });
    await writeFile(path.join(repository, "README.md"), "# fixture\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: repository });
    await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"], { cwd: repository });

    const assignment = await createWorktreeAssignment(
      repository,
      managedBase,
      "Fixture",
      "Coding",
      "main",
      localRuntime
    );

    expect(assignment.baseDir).toBe(managedBase);
    expect(path.relative(managedBase, assignment.worktreePath)).not.toMatch(/^\.\./);
    expect(assignment.worktreePath).not.toContain(`${path.sep}.agent-workbench${path.sep}worktrees`);
  });

  it("accepts resolved managed roots without weakening the project boundary", async () => {
    const root = await createTempRoot("approved-boundary");
    const projectRoot = path.join(root, "repo");
    const managedRoot = path.join(root, "managed");
    const worktree = path.join(managedRoot, "project", "agent", "one");
    const sibling = path.join(root, "unmanaged", "escape");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(worktree, { recursive: true });
    await mkdir(sibling, { recursive: true });

    await expect(assertExecutionPathWithinApprovedRoots(
      projectRoot,
      worktree,
      projectRoot,
      [managedRoot],
      localRuntime,
      undefined,
      "test worktree"
    )).resolves.toMatchObject({ approvedRoot: managedRoot, executionPath: worktree });

    await expect(assertExecutionPathWithinApprovedRoots(
      projectRoot,
      sibling,
      projectRoot,
      [managedRoot],
      localRuntime,
      undefined,
      "test escape"
    )).rejects.toThrow(/escape both/i);
  });
});

describe("bounded target command execution", () => {
  it("finds an NVM-only Node runtime when the probe PATH is minimal", async () => {
    const fixtureHome = await createTempRoot("nvm-only-node");
    const nvmBin = path.join(fixtureHome, ".nvm", "versions", "node", "v22.22.0", "bin");
    const nvmNode = path.join(nvmBin, "node");
    await mkdir(nvmBin, { recursive: true });
    await writeFile(nvmNode, "#!/bin/sh\nexit 0\n", { encoding: "utf8", mode: 0o755 });

    const resolutionPlan = buildWslCodexRuntimeResolutionPlan(
      { distroName: "Ubuntu" },
      { command: "node" }
    );
    const result = await new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve, reject) => {
      const child = spawn("/bin/bash", ["-s", "--"], {
        env: {
          ...process.env,
          HOME: fixtureHome,
          NVM_DIR: path.join(fixtureHome, ".nvm"),
          PATH: "/bin",
          USER: "preview-fixture"
        }
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (exitCode) => resolve({ stdout, stderr, exitCode }));
      child.stdin.end(`${resolutionPlan.shellCommand}\n`);
    });

    expect(result, result.stderr).toMatchObject({ exitCode: 0 });
    expect(parseWslCodexRuntimeResolutionOutput(result.stdout)).toEqual({
      resolvedCodexCommand: nvmNode,
      resolvedNodeCommand: nvmNode,
      user: "preview-fixture"
    });
  });

  it("describes package scripts as trust-gated exact argv with limits", async () => {
    const root = await createTempRoot("command-descriptor");
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: {
        test: "vitest run",
        build: "vite build"
      }
    }));

    const resolution = await resolveTargetProjectCommands({ projectRoot: root, projectKind: "folder" });
    const testCommand = resolution.testCommands.find((command) => command.name === "test");
    const buildCommand = resolution.testCommands.find((command) => command.name === "build");

    expect(testCommand?.execution).toMatchObject({
      source: "package_script",
      requiresProjectTrust: true,
      usesShell: false,
      timeoutMs: 600_000,
      steps: [{ executable: "npm", args: ["test"] }]
    });
    expect(buildCommand?.execution.timeoutMs).toBe(900_000);
    expect(testCommand?.execution.maxOutputBytes).toBeGreaterThan(0);
  });

  it("provides exact built-in Git steps without project trust", async () => {
    const root = await createTempRoot("git-descriptor");
    const resolution = await resolveTargetProjectCommands({ projectRoot: root, projectKind: "git" });

    expect(resolution.testCommands[0]?.execution).toMatchObject({
      source: "git_builtin",
      requiresProjectTrust: false,
      usesShell: false,
      steps: [
        { executable: "git", args: ["diff", "--check"] },
        { executable: "git", args: ["status", "--short", "--untracked-files=all"] }
      ]
    });
  });

  it("bounds structured output and supports AbortSignal cancellation", async () => {
    const executor = new RuntimeCommandExecutor(localRuntime, process.platform);
    await expect(executor.execStructuredCommand({
      command: "bash",
      args: ["-c", "head -c 8192 /dev/zero"],
      maxOutputBytes: 1024
    })).rejects.toMatchObject({ name: "ExecutionError" });

    const controller = new AbortController();
    const pending = executor.execStructuredCommand({
      command: "bash",
      args: ["-c", "sleep 10"],
      signal: controller.signal
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps structured executable arguments separate", () => {
    const plan = buildStructuredExecutionPlan(localRuntime, {
      command: "/tool/with spaces",
      args: ["--path", "value & more"],
      runtimePathDirs: ["/home/test/.nvm/versions/node/v22.22.0/bin"]
    }, "linux");
    expect(plan.file).toBe("/tool/with spaces");
    expect(plan.args).toEqual(["--path", "value & more"]);
  });

  it("prepends nvm runtime directories for WSL structured npm commands without shell-parsing argv", () => {
    const nvmBin = "/home/test/.nvm/versions/node/v22.22.0/bin";
    const plan = buildStructuredExecutionPlan({
      executionMode: "wsl",
      distroName: "Ubuntu"
    }, {
      command: "npm",
      args: ["run", "test", "--", "--grep", "value & $(not-shell)"],
      cwd: "/home/test/project with spaces",
      env: { NODE_ENV: "test" },
      runtimePathDirs: [nvmBin, "/usr/local/bin", nvmBin]
    }, "win32");

    expect(plan.file).toBe("wsl.exe");
    expect(plan.args).toEqual([
      "-d",
      "Ubuntu",
      "--cd",
      "/home/test/project with spaces",
      "--exec",
      "env",
      "NODE_ENV=test",
      "bash",
      "-lc",
      `export PATH='${nvmBin}:/usr/local/bin':$PATH; exec "$@"`,
      "bash",
      "npm",
      "run",
      "test",
      "--",
      "--grep",
      "value & $(not-shell)"
    ]);
  });
});

class FakeCodexProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  stdin: Writable = new PassThrough();
  exitCode: number | null = null;
  killed = false;

  kill(): boolean {
    if (this.killed) {
      return false;
    }
    this.killed = true;
    queueMicrotask(() => {
      this.exitCode = 0;
      this.emit("exit", 0, null);
    });
    return true;
  }
}

const createTransport = (
  child: FakeCodexProcess,
  limits?: { maxFrameChars?: number; maxBufferChars?: number }
): CodexAppServerTransport => {
  const launchPlan: CodexLaunchPlan = {
    requestedCommand: "codex",
    plan: {
      file: "codex",
      args: ["app-server"],
      options: {}
    }
  };
  return new CodexAppServerTransport(defaultSettings(), launchPlan, {
    ...limits,
    spawnProcess: (() => child as unknown as ChildProcessWithoutNullStreams) as unknown as typeof spawn
  });
};

const nextWrittenMessage = async (stream: Writable): Promise<Record<string, unknown>> => await new Promise((resolve) => {
  stream.once("data", (chunk) => resolve(JSON.parse(String(chunk).trim()) as Record<string, unknown>));
});

describe("Codex app-server transport hardening", () => {
  it("decodes split frames, reports malformed lines, and continues", () => {
    const decoder = new CodexJsonLineDecoder(128, 128);
    const messages: unknown[] = [];
    const errors: string[] = [];
    decoder.push("{\"id\":1,", (message) => messages.push(message), (error) => errors.push(error.code));
    decoder.push("\"result\":true}\nnot-json\n{\"method\":\"ok\"}\n", (message) => messages.push(message), (error) => errors.push(error.code));

    expect(messages).toEqual([{ id: 1, result: true }, { method: "ok" }]);
    expect(errors).toEqual(["MALFORMED_JSON"]);
  });

  it("treats an unterminated oversized frame as fatal", () => {
    const decoder = new CodexJsonLineDecoder(16, 16);
    const errors: Array<{ code: string; fatal: boolean }> = [];
    decoder.push("x".repeat(17), () => undefined, (error) => errors.push(error));
    expect(errors).toEqual([expect.objectContaining({ code: "BUFFER_OVERFLOW", fatal: true })]);
  });

  it("survives malformed stdout and resolves the following valid response", async () => {
    const child = new FakeCodexProcess();
    const transport = createTransport(child);
    const protocolErrors: string[] = [];
    transport.on("protocolError", (error) => protocolErrors.push(error.code));
    const written = nextWrittenMessage(child.stdin);
    const initialized = transport.initialize({ timeoutMs: 1_000 });
    const request = await written;

    child.stdout.write("not-json\n");
    child.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: { userAgent: "test", codexHome: "/tmp", platformFamily: "unix", platformOs: "linux" }
    })}\n`);

    await expect(initialized).resolves.toMatchObject({ userAgent: "test" });
    expect(protocolErrors).toEqual(["MALFORMED_JSON"]);
    await transport.dispose();
  });

  it("cancels pending requests and rejects write failures", async () => {
    const child = new FakeCodexProcess();
    const transport = createTransport(child);
    const controller = new AbortController();
    const written = nextWrittenMessage(child.stdin);
    const pending = transport.initialize({ signal: controller.signal, timeoutMs: 1_000 });
    await written;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await transport.dispose();

    const brokenChild = new FakeCodexProcess();
    brokenChild.stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error("broken pipe"));
      }
    });
    const brokenTransport = createTransport(brokenChild);
    await expect(brokenTransport.initialize({ timeoutMs: 1_000 })).rejects.toThrow(/broken pipe/i);
    await brokenTransport.dispose();
  });

  it("terminates the transport and rejects pending calls on framing overflow", async () => {
    const child = new FakeCodexProcess();
    const transport = createTransport(child, { maxFrameChars: 32, maxBufferChars: 32 });
    const written = nextWrittenMessage(child.stdin);
    const pending = transport.initialize({ timeoutMs: 1_000 });
    await written;
    child.stdout.write("x".repeat(33));

    await expect(pending).rejects.toMatchObject({ code: "BUFFER_OVERFLOW", fatal: true });
    expect(child.killed).toBe(true);
  });
});
