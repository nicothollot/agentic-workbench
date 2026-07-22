import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { defaultSettings } from "@shared/defaults";
import { nowIso } from "@shared/utils";

const execFileAsync = promisify(execFile);

export const createTempDir = async (name: string): Promise<string> => {
  const directory = path.join(tmpdir(), `awb-${name}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  await mkdir(directory, { recursive: true });
  return directory;
};

export const initGitRepo = async (root: string): Promise<void> => {
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "awb@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "AWB Tests"], { cwd: root });
};

export const commitAll = async (root: string, message: string): Promise<void> => {
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", message], { cwd: root });
};

export const writeMockSettings = async (appDataDir: string): Promise<void> => {
  const settings = defaultSettings();
  settings.mockMode = true;
  // Integration fixtures intentionally opt into repository command execution.
  // Production defaults remain explicit-approval-first.
  settings.autoApproveCommands = true;
  settings.worktreeBaseDir = path.join(appDataDir, "worktrees");
  settings.githubAccount = {
    username: "awb-tests",
    linkedAt: nowIso()
  };
  await mkdir(appDataDir, { recursive: true });
  await writeFile(path.join(appDataDir, "settings.json"), JSON.stringify(settings, null, 2));
};
