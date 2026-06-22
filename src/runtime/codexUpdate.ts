import type { AppSettings } from "@shared/types";
import { GENERATED_CODEX_CLI_VERSION } from "@generated/app-server/protocolVersion";
import { RuntimeCommandExecutor, resolveExecutionMode } from "./execution";

const CODEX_PACKAGE_NAME = "@openai/codex";
const NPM_VERSION_TIMEOUT_MS = 15_000;
const NPM_INSTALL_TIMEOUT_MS = 180_000;

export type CodexUpdateStatus = "up-to-date" | "updated" | "skipped" | "failed";
export type CodexProtocolCompatibilityStatus = "compatible" | "installed-newer" | "installed-older" | "unknown";

export interface CodexUpdateResult {
  status: CodexUpdateStatus;
  message: string;
  currentVersion?: string;
  latestVersion?: string;
  updatedVersion?: string;
  supportedProtocolVersion?: string;
}

export interface CodexUpdateCheck {
  status: "up-to-date" | "outdated" | "unavailable" | "skipped";
  message: string;
  currentVersion?: string;
  latestVersion?: string;
  targetVersion?: string;
  updateAvailable: boolean;
  updateCommand?: string;
  supportedProtocolVersion?: string;
}

export interface CodexUpdateCommandRunner {
  runCodexVersion(): Promise<string>;
  runNpmCommand(args: string[], timeoutMs: number): Promise<string>;
}

export interface CodexUpdateOptions {
  supportedProtocolVersion?: string;
  targetVersion?: string;
  commandRunner?: CodexUpdateCommandRunner;
}

export interface CodexProtocolCompatibility {
  status: CodexProtocolCompatibilityStatus;
  compatible: boolean;
  installedVersion?: string;
  generatedProtocolVersion: string;
  message: string;
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

export const GENERATED_CODEX_APP_SERVER_PROTOCOL_VERSION = GENERATED_CODEX_CLI_VERSION;

export const assessCodexProtocolCompatibility = (
  installedVersion: string | undefined,
  generatedProtocolVersion = GENERATED_CODEX_APP_SERVER_PROTOCOL_VERSION
): CodexProtocolCompatibility => {
  if (!installedVersion) {
    return {
      status: "unknown",
      compatible: false,
      generatedProtocolVersion,
      message: `Could not determine the installed Codex CLI version. This Workbench build was generated for Codex app-server protocol ${generatedProtocolVersion}.`
    };
  }

  const comparison = compareCodexVersions(installedVersion, generatedProtocolVersion);
  if (comparison === 0) {
    return {
      status: "compatible",
      compatible: true,
      installedVersion,
      generatedProtocolVersion,
      message: `Codex CLI ${installedVersion} matches the bundled app-server protocol.`
    };
  }

  if (comparison > 0) {
    return {
      status: "installed-newer",
      compatible: true,
      installedVersion,
      generatedProtocolVersion,
      message: `Installed Codex CLI ${installedVersion} is newer than the app-server protocol bundled with this Workbench build (${generatedProtocolVersion}). Workbench will use the installed CLI.`
    };
  }

  return {
    status: "installed-older",
    compatible: false,
    installedVersion,
    generatedProtocolVersion,
    message: `Installed Codex CLI ${installedVersion} is older than the app-server protocol bundled with this Workbench build (${generatedProtocolVersion}). Install Codex CLI ${generatedProtocolVersion} before running live agents.`
  };
};

const quoteForPosixShell = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

const quoteForPowerShell = (value: string): string => `"${value.replace(/`/g, "``").replace(/"/g, "`\"")}"`;

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

export const readInstalledCodexCliVersion = async (
  settings: AppSettings,
  platform: NodeJS.Platform = process.platform
): Promise<string | undefined> => {
  const executor = new RuntimeCommandExecutor(settings, platform);
  return parseCodexCliVersion(await runCodexVersion(executor, settings, platform));
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

const createDefaultCodexUpdateCommandRunner = (
  settings: AppSettings,
  platform: NodeJS.Platform
): CodexUpdateCommandRunner => {
  const executor = new RuntimeCommandExecutor(settings, platform);
  return {
    runCodexVersion: async () => await runCodexVersion(executor, settings, platform),
    runNpmCommand: async (args, timeoutMs) => await runNpmCommand(executor, settings, platform, args, timeoutMs)
  };
};

export const buildCodexUpdateCommand = (
  settings: AppSettings,
  platform: NodeJS.Platform = process.platform,
  targetVersion = "latest"
): string => {
  const packageSpec = `${CODEX_PACKAGE_NAME}@${targetVersion}`;
  const mode = resolveExecutionMode(settings, platform);
  if (mode === "wsl" && platform === "win32") {
    return `wsl -d ${quoteForPowerShell(settings.distroName)} -- npm install -g ${packageSpec}`;
  }
  return `npm install -g ${packageSpec}`;
};

export const checkCodexCliUpdate = async (
  settings: AppSettings,
  platform: NodeJS.Platform = process.platform,
  options: CodexUpdateOptions = {}
): Promise<CodexUpdateCheck> => {
  const runner = options.commandRunner ?? createDefaultCodexUpdateCommandRunner(settings, platform);
  try {
    const currentVersion = parseCodexCliVersion(await runner.runCodexVersion());
    if (!currentVersion) {
      return {
        status: "unavailable",
        updateAvailable: false,
        message: "Could not determine the installed Codex CLI version."
      };
    }

    const latestOutput = await runner.runNpmCommand(
      ["view", CODEX_PACKAGE_NAME, "version"],
      NPM_VERSION_TIMEOUT_MS
    );
    const latestVersion = parseNpmPackageVersion(latestOutput);
    if (!latestVersion) {
      return {
        status: "unavailable",
        currentVersion,
        updateAvailable: false,
        message: "Could not determine the latest Codex CLI version from npm."
      };
    }

    const supportedProtocolVersion = options.supportedProtocolVersion;
    const targetVersion = options.targetVersion ?? latestVersion;
    const updateAvailable = compareCodexVersions(currentVersion, targetVersion) < 0;

    if (!updateAvailable) {
      return {
        status: "up-to-date",
        currentVersion,
        latestVersion,
        targetVersion,
        updateAvailable: false,
        supportedProtocolVersion,
        message: `Codex CLI is up to date at ${currentVersion}.`
      };
    }

    return {
      status: "outdated",
      currentVersion,
      latestVersion,
      targetVersion,
      updateAvailable: true,
      updateCommand: buildCodexUpdateCommand(settings, platform, targetVersion),
      supportedProtocolVersion,
      message: `Codex CLI ${currentVersion} can be updated to ${targetVersion}.`
    };
  } catch (error) {
    return {
      status: "unavailable",
      updateAvailable: false,
      message: formatFailure("Codex CLI update check failed.", error)
    };
  }
};

export const updateCodexCliIfAvailable = async (
  settings: AppSettings,
  platform: NodeJS.Platform = process.platform,
  options: CodexUpdateOptions = {}
): Promise<CodexUpdateResult> => {
  const runner = options.commandRunner ?? createDefaultCodexUpdateCommandRunner(settings, platform);

  try {
    const check = await checkCodexCliUpdate(settings, platform, options);
    if (!check.currentVersion) {
      return {
        status: "failed",
        message: check.message
      };
    }
    if (!check.latestVersion || !check.targetVersion) {
      return {
        status: "failed",
        currentVersion: check.currentVersion,
        message: check.message
      };
    }
    if (!check.updateAvailable) {
      return {
        status: check.status === "skipped" ? "skipped" : "up-to-date",
        currentVersion: check.currentVersion,
        latestVersion: check.latestVersion,
        supportedProtocolVersion: check.supportedProtocolVersion,
        message: check.message
      };
    }

    await runner.runNpmCommand(
      ["install", "-g", `${CODEX_PACKAGE_NAME}@${check.targetVersion}`],
      NPM_INSTALL_TIMEOUT_MS
    );
    const updatedVersion = parseCodexCliVersion(await runner.runCodexVersion());

    return {
      status: updatedVersion && compareCodexVersions(updatedVersion, check.targetVersion) >= 0 ? "updated" : "failed",
      currentVersion: check.currentVersion,
      latestVersion: check.latestVersion,
      updatedVersion,
      supportedProtocolVersion: check.supportedProtocolVersion,
      message: updatedVersion
        ? `Updated Codex CLI from ${check.currentVersion} to ${updatedVersion}.`
        : `Tried to update Codex CLI from ${check.currentVersion} to ${check.targetVersion}, but could not detect the version afterward.`
    };
  } catch (error) {
    return {
      status: "failed",
      message: formatFailure("Codex CLI update check failed.", error)
    };
  }
};
