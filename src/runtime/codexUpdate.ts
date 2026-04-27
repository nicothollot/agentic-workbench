import type { AppSettings } from "@shared/types";
import { RuntimeCommandExecutor, resolveExecutionMode } from "./execution";

const CODEX_PACKAGE_NAME = "@openai/codex";
const NPM_VERSION_TIMEOUT_MS = 15_000;
const NPM_INSTALL_TIMEOUT_MS = 180_000;

export type CodexUpdateStatus = "up-to-date" | "updated" | "failed";

export interface CodexUpdateResult {
  status: CodexUpdateStatus;
  message: string;
  currentVersion?: string;
  latestVersion?: string;
  updatedVersion?: string;
}

export const parseCodexCliVersion = (output: string): string | undefined => {
  const match = /\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(output);
  return match?.[1];
};

export const parseNpmPackageVersion = (output: string): string | undefined =>
  output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(line));

const parseVersionParts = (version: string): { parts: number[]; prerelease: string | undefined } | undefined => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (!match) {
    return undefined;
  }
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]
  };
};

export const compareCodexVersions = (left: string, right: string): number => {
  const parsedLeft = parseVersionParts(left);
  const parsedRight = parseVersionParts(right);
  if (!parsedLeft || !parsedRight) {
    return left.localeCompare(right);
  }

  for (let index = 0; index < parsedLeft.parts.length; index += 1) {
    const difference = parsedLeft.parts[index] - parsedRight.parts[index];
    if (difference !== 0) {
      return difference;
    }
  }

  if (parsedLeft.prerelease === parsedRight.prerelease) {
    return 0;
  }
  if (!parsedLeft.prerelease) {
    return 1;
  }
  if (!parsedRight.prerelease) {
    return -1;
  }
  return parsedLeft.prerelease.localeCompare(parsedRight.prerelease);
};

const quoteForPosixShell = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

const formatFailure = (message: string, error: unknown): string => {
  const detail = error instanceof Error ? error.message : String(error);
  return `${message} ${detail}`.trim();
};

const runCodexVersion = async (
  executor: RuntimeCommandExecutor,
  settings: AppSettings,
  platform: NodeJS.Platform
): Promise<string> => {
  const mode = resolveExecutionMode(settings, platform);
  if (mode !== "wsl") {
    const result = await executor.execStructuredCommand({
      command: settings.codexBinaryPath,
      args: ["--version"],
      env: settings.codexHome ? { CODEX_HOME: settings.codexHome } : undefined,
      timeoutMs: NPM_VERSION_TIMEOUT_MS
    });
    return `${result.stdout}\n${result.stderr}`;
  }

  const runtime = await executor.resolveWslCodexRuntime({
    command: settings.codexBinaryPath
  });
  const result = await executor.runShellCommand({
    command: `${quoteForPosixShell(runtime.resolvedCodexCommand ?? settings.codexBinaryPath)} --version`,
    env: settings.codexHome ? { CODEX_HOME: settings.codexHome } : undefined,
    runtimePathDirs: runtime.runtimePathDirs,
    timeoutMs: NPM_VERSION_TIMEOUT_MS
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || "Codex version command failed.");
  }
  return `${result.stdout}\n${result.stderr}`;
};

const runNpmCommand = async (
  executor: RuntimeCommandExecutor,
  settings: AppSettings,
  platform: NodeJS.Platform,
  args: string[],
  timeoutMs: number
): Promise<string> => {
  const mode = resolveExecutionMode(settings, platform);
  if (mode !== "wsl") {
    const result = await executor.execStructuredCommand({
      command: "npm",
      args,
      timeoutMs
    });
    return `${result.stdout}\n${result.stderr}`;
  }

  const runtime = await executor.resolveWslCodexRuntime({
    command: settings.codexBinaryPath
  });
  const command = ["npm", ...args.map(quoteForPosixShell)].join(" ");
  const result = await executor.runShellCommand({
    command,
    runtimePathDirs: runtime.runtimePathDirs,
    timeoutMs
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || "npm command failed.");
  }
  return `${result.stdout}\n${result.stderr}`;
};

export const updateCodexCliIfAvailable = async (
  settings: AppSettings,
  platform: NodeJS.Platform = process.platform
): Promise<CodexUpdateResult> => {
  const executor = new RuntimeCommandExecutor(settings, platform);

  try {
    const currentVersion = parseCodexCliVersion(await runCodexVersion(executor, settings, platform));
    if (!currentVersion) {
      return {
        status: "failed",
        message: "Could not determine the installed Codex CLI version."
      };
    }

    const latestOutput = await runNpmCommand(
      executor,
      settings,
      platform,
      ["view", CODEX_PACKAGE_NAME, "version"],
      NPM_VERSION_TIMEOUT_MS
    );
    const latestVersion = parseNpmPackageVersion(latestOutput);
    if (!latestVersion) {
      return {
        status: "failed",
        currentVersion,
        message: "Could not determine the latest Codex CLI version from npm."
      };
    }

    if (compareCodexVersions(currentVersion, latestVersion) >= 0) {
      return {
        status: "up-to-date",
        currentVersion,
        latestVersion,
        message: `Codex CLI is up to date at ${currentVersion}.`
      };
    }

    await runNpmCommand(
      executor,
      settings,
      platform,
      ["install", "-g", `${CODEX_PACKAGE_NAME}@latest`],
      NPM_INSTALL_TIMEOUT_MS
    );
    const updatedVersion = parseCodexCliVersion(await runCodexVersion(executor, settings, platform));

    return {
      status: "updated",
      currentVersion,
      latestVersion,
      updatedVersion,
      message: updatedVersion
        ? `Updated Codex CLI from ${currentVersion} to ${updatedVersion}.`
        : `Updated Codex CLI from ${currentVersion}; latest available is ${latestVersion}.`
    };
  } catch (error) {
    return {
      status: "failed",
      message: formatFailure("Codex CLI update check failed.", error)
    };
  }
};
