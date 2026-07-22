import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { nanoid } from "nanoid";
import { DEFAULT_WORKTREE_BASE_DIR } from "@shared/constants";
import { detectProjectPathKind, uncWslToLinuxPath, windowsPathToWslPath } from "@shared/pathUtils";
import { slugify } from "@shared/utils";
import type { AppSettings, WorktreeAssignment } from "@shared/types";
import type { GitMetadata } from "./repoScanner";
import { resolveExecutionMode, RuntimeCommandExecutor } from "./execution";

type RuntimeSettings = Pick<AppSettings, "executionMode" | "distroName">;
const WORKBENCH_GIT_EXCLUDE_ENTRY = ".agent-workbench/";
const WORKTREE_BASE_ENV = "AWB_MANAGED_WORKTREE_BASE";

const execGit = async (settings: RuntimeSettings, projectRoot: string, args: string[]): Promise<string> => {
  const executor = new RuntimeCommandExecutor(settings);
  const { stdout } = await executor.execStructuredCommand({
    command: "git",
    args,
    cwd: projectRoot
  });
  return stdout.trim();
};

const normalizeOptionalOutput = (value: string): string | undefined => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const getPathModule = (value: string): path.PlatformPath =>
  /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(value) ? path.win32 : path.posix;

const assertValidConfiguredBaseDir = (configuredBaseDir: string): string => {
  const trimmed = configuredBaseDir.trim();
  if (!trimmed || trimmed.includes("\0")) {
    throw new Error("The managed worktree base directory must be a non-empty path.");
  }
  return trimmed;
};

export const resolveLocalManagedWorktreeBaseDir = (
  configuredBaseDir: string,
  homeDirectory = os.homedir()
): string => {
  const configured = assertValidConfiguredBaseDir(configuredBaseDir);
  const homePathModule = getPathModule(homeDirectory);
  const expanded = configured === "~"
    ? homeDirectory
    : configured.startsWith("~/") || configured.startsWith("~\\")
      ? homePathModule.join(homeDirectory, configured.slice(2))
      : configured;
  const pathModule = getPathModule(expanded || homeDirectory);
  return pathModule.normalize(pathModule.isAbsolute(expanded) ? expanded : pathModule.resolve(homeDirectory, expanded));
};

export const buildWslManagedWorktreeBaseResolutionSpec = (
  configuredBaseDir: string
): { command: string; args: string[]; env: Record<string, string> } => ({
  command: "sh",
  args: [
    "-c",
    [
      "set -eu",
      `value="\${${WORKTREE_BASE_ENV}}"`,
      "case \"$value\" in",
      "  '~') resolved=\"$HOME\" ;;",
      "  '~/'*) resolved=\"$HOME/${value#~/}\" ;;",
      "  /*) resolved=\"$value\" ;;",
      "  *) resolved=\"$HOME/$value\" ;;",
      "esac",
      "mkdir -p -- \"$resolved\"",
      "cd -- \"$resolved\"",
      "pwd -P"
    ].join("\n")
  ],
  env: {
    [WORKTREE_BASE_ENV]: assertValidConfiguredBaseDir(configuredBaseDir)
  }
});

export const normalizeManagedWorktreeBaseForExecution = (
  configuredBaseDir: string,
  settings: RuntimeSettings,
  platform: NodeJS.Platform = process.platform
): string => {
  const configured = assertValidConfiguredBaseDir(configuredBaseDir);
  if (resolveExecutionMode(settings, platform) !== "wsl") {
    return configured;
  }

  const kind = detectProjectPathKind(configured);
  if (kind === "windows") {
    return windowsPathToWslPath(configured);
  }
  if (kind === "wsl-unc") {
    const parsed = uncWslToLinuxPath(configured);
    if (parsed.distroName.localeCompare(settings.distroName, undefined, { sensitivity: "accent" }) !== 0) {
      throw new Error(
        `The managed worktree base uses WSL distro "${parsed.distroName}", but execution is configured for "${settings.distroName}".`
      );
    }
    return parsed.linuxPath;
  }
  return configured.replace(/\\/g, "/");
};

export const resolveManagedWorktreeBaseDir = async (
  projectRoot: string,
  configuredBaseDir: string,
  settings: RuntimeSettings,
  platform: NodeJS.Platform = process.platform
): Promise<string> => {
  if (resolveExecutionMode(settings, platform) !== "wsl") {
    const resolved = resolveLocalManagedWorktreeBaseDir(configuredBaseDir);
    await mkdir(resolved, { recursive: true });
    return resolved;
  }

  const executor = new RuntimeCommandExecutor(settings, platform);
  const spec = buildWslManagedWorktreeBaseResolutionSpec(
    normalizeManagedWorktreeBaseForExecution(configuredBaseDir, settings, platform)
  );
  const { stdout } = await executor.execStructuredCommand({
    ...spec,
    cwd: projectRoot,
    timeoutMs: 15_000
  });
  const resolved = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
  if (!resolved || !path.posix.isAbsolute(resolved)) {
    throw new Error("WSL did not return an absolute managed worktree base directory.");
  }
  return path.posix.normalize(resolved);
};

const joinManagedWorktreePath = (baseDir: string, ...segments: string[]): string => {
  const pathModule = getPathModule(baseDir);
  const normalizedBase = pathModule.normalize(baseDir);
  const candidate = pathModule.join(normalizedBase, ...segments);
  if (!isContainedPath(normalizedBase, candidate) || candidate === normalizedBase) {
    throw new Error("The managed worktree path escaped its configured base directory.");
  }
  return candidate;
};

const isContainedPath = (root: string, candidate: string): boolean => {
  const pathModule = getPathModule(root);
  const relative = pathModule.relative(pathModule.normalize(root), pathModule.normalize(candidate));
  return relative === "" || (!relative.startsWith("..") && !pathModule.isAbsolute(relative));
};

const uniquePaths = (paths: string[]): string[] => [...new Set(paths.filter(Boolean))];

const isWorkbenchExcludeEntry = (line: string): boolean => {
  const trimmed = line.trim();
  return trimmed === WORKBENCH_GIT_EXCLUDE_ENTRY || trimmed === ".agent-workbench";
};

const ensureManagedWorktreeGitExclude = async (projectRoot: string, settings: RuntimeSettings): Promise<void> => {
  if (resolveExecutionMode(settings) === "wsl") {
    const executor = new RuntimeCommandExecutor(settings);
    await executor.execStructuredCommand({
      command: "sh",
      args: [
        "-c",
        [
          "set -eu",
          `entry='${WORKBENCH_GIT_EXCLUDE_ENTRY}'`,
          "exclude_path=\"$(git rev-parse --git-path info/exclude)\"",
          "mkdir -p \"$(dirname \"$exclude_path\")\"",
          "touch \"$exclude_path\"",
          "if ! grep -qxF \"$entry\" \"$exclude_path\" && ! grep -qxF '.agent-workbench' \"$exclude_path\"; then",
          "  printf '\\n%s\\n' \"$entry\" >> \"$exclude_path\"",
          "fi"
        ].join("\n")
      ],
      cwd: projectRoot
    });
    return;
  }

  const rawExcludePath = await execGit(settings, projectRoot, ["rev-parse", "--git-path", "info/exclude"]);
  const pathModule = getPathModule(projectRoot);
  const excludePath = pathModule.isAbsolute(rawExcludePath)
    ? rawExcludePath
    : pathModule.resolve(projectRoot, rawExcludePath);

  await mkdir(pathModule.dirname(excludePath), { recursive: true });

  let existing = "";
  try {
    existing = await readFile(excludePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  if (existing.split(/\r?\n/).some(isWorkbenchExcludeEntry)) {
    return;
  }

  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await writeFile(excludePath, `${existing}${separator}${WORKBENCH_GIT_EXCLUDE_ENTRY}\n`, "utf8");
};

const parseStatusEntries = (output: string): string[] =>
  uniquePaths(
    output
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => {
        const candidate = line.slice(3).trim();
        const renameMarker = " -> ";
        return candidate.includes(renameMarker) ? candidate.slice(candidate.lastIndexOf(renameMarker) + renameMarker.length).trim() : candidate;
      })
  );

const parseLinePaths = (output: string): string[] =>
  uniquePaths(
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  );

export const readGitMetadata = async (projectRoot: string, settings: RuntimeSettings): Promise<GitMetadata> => {
  try {
    const gitRoot = await execGit(settings, projectRoot, ["rev-parse", "--show-toplevel"]);
    const [branch, head, rootCommit, remotes, earliestCommitAt, lastCommitAt] = await Promise.all([
      execGit(settings, projectRoot, ["branch", "--show-current"]),
      execGit(settings, projectRoot, ["rev-parse", "HEAD"]),
      execGit(settings, projectRoot, ["rev-list", "--max-parents=0", "HEAD"]),
      execGit(settings, projectRoot, ["remote", "-v"]),
      execGit(settings, projectRoot, ["log", "--reverse", "--format=%cI", "--max-count=1"]),
      execGit(settings, projectRoot, ["log", "-1", "--format=%cI"])
    ]);

    const normalizedRemotes = remotes
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split(/\s+/)[1])
      .filter(Boolean)
      .map((url) => url.replace(/\.git$/, "").toLowerCase());

    return {
      isGit: true,
      gitRoot,
      branch,
      head,
      rootCommit: rootCommit.split(/\r?\n/)[0],
      earliestCommitAt: normalizeOptionalOutput(earliestCommitAt),
      lastCommitAt: normalizeOptionalOutput(lastCommitAt),
      normalizedRemotes: [...new Set(normalizedRemotes)]
    };
  } catch {
    return {
      isGit: false,
      normalizedRemotes: []
    };
  }
};

export const createWorktreeAssignment = async (
  projectRoot: string,
  configuredBaseDir: string,
  projectSlug: string,
  agentSlug: string,
  targetBranch: string,
  settings: RuntimeSettings,
  platform: NodeJS.Platform = process.platform
): Promise<WorktreeAssignment> => {
  const normalizedProjectSlug = slugify(projectSlug) || "project";
  const normalizedAgentSlug = slugify(agentSlug) || "agent";
  const branch = `awb/${normalizedProjectSlug}/${normalizedAgentSlug}-${nanoid(6).toLowerCase()}`;
  const baseDir = await resolveManagedWorktreeBaseDir(projectRoot, configuredBaseDir, settings, platform);
  const worktreePath = joinManagedWorktreePath(
    baseDir,
    normalizedProjectSlug,
    normalizedAgentSlug,
    nanoid(6)
  );

  if (resolveExecutionMode(settings, platform) === "wsl") {
    const executor = new RuntimeCommandExecutor(settings, platform);
    await executor.execStructuredCommand({
      command: "mkdir",
      args: ["-p", path.posix.dirname(worktreePath)],
      timeoutMs: 15_000
    });
  } else {
    await mkdir(getPathModule(worktreePath).dirname(worktreePath), { recursive: true });
  }

  await ensureManagedWorktreeGitExclude(projectRoot, settings);
  await execGit(settings, projectRoot, ["worktree", "add", "-b", branch, worktreePath, targetBranch]);

  return {
    baseDir,
    worktreePath,
    branch,
    targetBranch
  };
};

export const getManagedWorktreeBaseDir = (
  _projectRoot: string,
  configuredBaseDir = DEFAULT_WORKTREE_BASE_DIR,
  homeDirectory = os.homedir()
): string => resolveLocalManagedWorktreeBaseDir(configuredBaseDir, homeDirectory);

export const listWorktrees = async (projectRoot: string, settings: RuntimeSettings): Promise<Array<{ path: string; branch?: string }>> => {
  const output = await execGit(settings, projectRoot, ["worktree", "list", "--porcelain"]);
  const worktrees: Array<{ path: string; branch?: string }> = [];
  let current: { path: string; branch?: string } | undefined;

  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = { path: line.replace("worktree ", "").trim() };
      worktrees.push(current);
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.replace("branch refs/heads/", "").trim();
    }
  }

  return worktrees;
};

export const removeWorktree = async (projectRoot: string, worktreePath: string, settings: RuntimeSettings): Promise<void> => {
  await execGit(settings, projectRoot, ["worktree", "remove", "--force", worktreePath]);
};

export const pruneManagedWorktrees = async (
  projectRoot: string,
  managedBaseDir: string,
  activeWorktreePaths: string[],
  settings: RuntimeSettings
): Promise<string[]> => {
  const pathModule = getPathModule(projectRoot);
  const normalizedProjectRoot = pathModule.normalize(projectRoot);
  const activeWorktreeSet = new Set(activeWorktreePaths.map((entry) => pathModule.normalize(entry)));
  const removed: string[] = [];

  for (const worktree of await listWorktrees(projectRoot, settings)) {
    const normalizedPath = pathModule.normalize(worktree.path);
    if (normalizedPath === normalizedProjectRoot) {
      continue;
    }
    if (!isContainedPath(managedBaseDir, normalizedPath)) {
      continue;
    }
    if (activeWorktreeSet.has(normalizedPath)) {
      continue;
    }

    await removeWorktree(projectRoot, normalizedPath, settings);
    removed.push(normalizedPath);
  }

  if (removed.length > 0) {
    await execGit(settings, projectRoot, ["worktree", "prune"]);
  }

  return removed;
};

export const listPendingWorktreeFiles = async (worktreePath: string, settings: RuntimeSettings): Promise<string[]> => {
  const output = await execGit(settings, worktreePath, ["status", "--porcelain=1", "--untracked-files=all"]);
  return parseStatusEntries(output);
};

export const listUnmergedWorktreeFiles = async (worktreePath: string, settings: RuntimeSettings): Promise<string[]> => {
  const output = await execGit(settings, worktreePath, ["diff", "--name-only", "--diff-filter=U"]);
  return parseLinePaths(output);
};

export const listBranchChangedFiles = async (
  worktreePath: string,
  targetBranch: string,
  sourceRef: string,
  settings: RuntimeSettings
): Promise<string[]> => {
  const output = await execGit(settings, worktreePath, ["diff", "--name-only", `${targetBranch}...${sourceRef}`]);
  return parseLinePaths(output);
};

export const checkpointWorktreeChanges = async (
  worktreePath: string,
  targetBranch: string,
  sourceRef: string,
  message: string,
  settings: RuntimeSettings
): Promise<{ changedFiles: string[]; createdCommit: boolean; commitSha?: string }> => {
  await ensureManagedWorktreeGitExclude(worktreePath, settings);
  const pendingFiles = await listPendingWorktreeFiles(worktreePath, settings);
  let createdCommit = false;
  let commitSha: string | undefined;

  if (pendingFiles.length > 0) {
    await execGit(settings, worktreePath, ["add", "--all"]);
    await execGit(settings, worktreePath, [
      "-c",
      "user.name=Codex Agent Workbench",
      "-c",
      "user.email=awb@local.invalid",
      "commit",
      "-m",
      message
    ]);
    commitSha = (await execGit(settings, worktreePath, ["rev-parse", "HEAD"])).split(/\r?\n/)[0];
    createdCommit = true;
  }

  const branchChangedFiles = await listBranchChangedFiles(worktreePath, targetBranch, sourceRef, settings);
  return {
    changedFiles: uniquePaths([...branchChangedFiles, ...pendingFiles]),
    createdCommit,
    commitSha
  };
};

export const listBranchesMissingFromHead = async (
  worktreePath: string,
  branches: string[],
  settings: RuntimeSettings
): Promise<string[]> => {
  const executor = new RuntimeCommandExecutor(settings);
  const missingBranches: string[] = [];

  for (const branch of uniquePaths(branches)) {
    try {
      await executor.execStructuredCommand({
        command: "git",
        args: ["merge-base", "--is-ancestor", branch, "HEAD"],
        cwd: worktreePath
      });
    } catch {
      missingBranches.push(branch);
    }
  }

  return missingBranches;
};

export const determineDefaultBranch = async (projectRoot: string, settings: RuntimeSettings): Promise<string> => {
  try {
    const remoteHead = await execGit(settings, projectRoot, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
    const normalized = remoteHead.replace("refs/remotes/origin/", "").trim();
    if (normalized) {
      return normalized;
    }
  } catch {
    // Fall through to the checked-out branch or a conventional fallback.
  }

  try {
    const current = await execGit(settings, projectRoot, ["branch", "--show-current"]);
    if (current) {
      return current;
    }
  } catch {
    // Fall through to a conventional fallback.
  }

  return "main";
};

export const applyBranchToProjectCheckout = async (
  projectRoot: string,
  sourceBranch: string,
  settings: RuntimeSettings
): Promise<string> => {
  const currentBranch = await execGit(settings, projectRoot, ["branch", "--show-current"]);
  if (!currentBranch) {
    throw new Error("The opened project checkout is in a detached HEAD state and cannot be updated automatically.");
  }

  await execGit(settings, projectRoot, ["merge", "--ff-only", sourceBranch]);
  return currentBranch;
};

export const pushBranchToOrigin = async (
  projectRoot: string,
  branch: string,
  settings: RuntimeSettings
): Promise<{ branch: string; remote: string; output: string }> => {
  if (!branch.trim()) {
    throw new Error("Cannot push because the opened project checkout is not on a named branch.");
  }

  await execGit(settings, projectRoot, ["remote", "get-url", "origin"]);
  const output = await execGit(settings, projectRoot, ["push", "origin", branch]);
  return {
    branch,
    remote: "origin",
    output
  };
};

export const attemptMerge = async (
  integrationWorktreePath: string,
  targetBranch: string,
  branches: string[],
  settings: RuntimeSettings
): Promise<{ conflicts: string[]; mergedBranches: string[] }> => {
  const mergedBranches: string[] = [];
  const conflicts: string[] = [];
  const executor = new RuntimeCommandExecutor(settings);

  for (const branch of branches) {
    try {
      await executor.execStructuredCommand({
        command: "git",
        args: ["merge", "--no-ff", "--no-edit", branch],
        cwd: integrationWorktreePath
      });
      mergedBranches.push(branch);
      continue;
    } catch (error) {
      const typedError = error as { stdout?: string; stderr?: string };
      const combined = `${typedError.stdout ?? ""}\n${typedError.stderr ?? ""}`;
      combined
        .split(/\r?\n/)
        .filter((line) => line.startsWith("CONFLICT"))
        .forEach((line) => conflicts.push(line));
      break;
    }
  }

  return { conflicts, mergedBranches };
};
