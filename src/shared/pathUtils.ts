import type { AppSettings, ProjectPathKind, ResolvedProjectPath } from "./types";

const WINDOWS_DRIVE_PATH = /^[a-zA-Z]:[\\/]/;
const WSL_UNC_PATH = /^\\\\wsl\$\\([^\\]+)\\(.*)$/i;
const WSL_MNT_DRIVE_PATH = /^\/mnt\/([a-zA-Z])(\/.*)?$/;
const WINDOWS_PREFIX = /^[a-zA-Z]:/;

const detectPlatform = (): NodeJS.Platform =>
  typeof process !== "undefined" && typeof process.platform === "string"
    ? process.platform
    : "linux";

const normalizePosixPath = (inputPath: string): string => {
  const absolute = inputPath.startsWith("/");
  const segments = inputPath.split("/").filter((segment) => segment.length > 0);
  const normalized: string[] = [];

  for (const segment of segments) {
    if (segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (normalized.length > 0 && normalized[normalized.length - 1] !== "..") {
        normalized.pop();
      } else if (!absolute) {
        normalized.push("..");
      }
      continue;
    }
    normalized.push(segment);
  }

  if (normalized.length === 0) {
    return absolute ? "/" : ".";
  }

  return `${absolute ? "/" : ""}${normalized.join("/")}`;
};

const splitComparablePath = (inputPath: string): { prefix: string; segments: string[]; isWindows: boolean } => {
  const normalized = inputPath.replace(/\\/g, "/");
  if (WINDOWS_PREFIX.test(normalized)) {
    const prefix = normalized.slice(0, 2).toLowerCase();
    const tail = normalized.slice(2).replace(/^\/+/, "");
    return {
      prefix,
      segments: tail.length > 0 ? tail.split("/").filter(Boolean) : [],
      isWindows: true
    };
  }

  const uncMatch = normalized.match(/^\/\/([^/]+)\/([^/]+)(\/.*)?$/);
  if (uncMatch) {
    return {
      prefix: `//${uncMatch[1].toLowerCase()}/${uncMatch[2].toLowerCase()}`,
      segments: (uncMatch[3] ?? "").split("/").filter(Boolean),
      isWindows: true
    };
  }

  return {
    prefix: normalized.startsWith("/") ? "/" : "",
    segments: normalized.split("/").filter(Boolean),
    isWindows: false
  };
};

const relativePath = (fromPath: string, toPath: string): string => {
  const from = splitComparablePath(fromPath);
  const to = splitComparablePath(toPath);
  if (from.prefix !== to.prefix) {
    return toPath.replace(/\\/g, "/");
  }

  let sharedIndex = 0;
  while (
    sharedIndex < from.segments.length &&
    sharedIndex < to.segments.length &&
    (
      from.isWindows
        ? from.segments[sharedIndex].toLowerCase() === to.segments[sharedIndex].toLowerCase()
        : from.segments[sharedIndex] === to.segments[sharedIndex]
    )
  ) {
    sharedIndex += 1;
  }

  return [
    ...Array.from({ length: from.segments.length - sharedIndex }, () => ".."),
    ...to.segments.slice(sharedIndex)
  ].join("/");
};

export const detectProjectPathKind = (inputPath: string): ProjectPathKind => {
  if (WINDOWS_DRIVE_PATH.test(inputPath)) {
    return "windows";
  }

  if (WSL_UNC_PATH.test(inputPath)) {
    return "wsl-unc";
  }

  return "linux";
};

export const normalizeWindowsPath = (inputPath: string): string => inputPath.replace(/\//g, "\\").replace(/\\+$/, "");

export const windowsPathToWslPath = (inputPath: string): string => {
  const normalized = normalizeWindowsPath(inputPath);
  const drive = normalized.slice(0, 1).toLowerCase();
  const tail = normalized.slice(2).replace(/\\/g, "/");
  return `/mnt/${drive}${tail.startsWith("/") ? tail : `/${tail}`}`;
};

export const wslPathToWindowsPath = (inputPath: string): string | null => {
  const match = inputPath.match(WSL_MNT_DRIVE_PATH);
  if (!match) {
    return null;
  }

  const drive = match[1].toUpperCase();
  const tail = (match[2] ?? "").replace(/\//g, "\\");
  return `${drive}:${tail}`;
};

export const uncWslToLinuxPath = (inputPath: string): { distroName: string; linuxPath: string } => {
  const match = inputPath.match(WSL_UNC_PATH);
  if (!match) {
    throw new Error(`Not a WSL UNC path: ${inputPath}`);
  }

  const distroName = match[1];
  const linuxTail = match[2].replace(/\\/g, "/");
  return {
    distroName,
    linuxPath: linuxTail.startsWith("/") ? linuxTail : `/${linuxTail}`
  };
};

export const linuxPathToUncWslPath = (linuxPath: string, distroName: string): string => {
  const normalized = normalizePosixPath(linuxPath);
  const tail = normalized.replace(/^\//, "").replace(/\//g, "\\");
  return tail.length > 0 ? `\\\\wsl$\\${distroName}\\${tail}` : `\\\\wsl$\\${distroName}`;
};

export const executionPathToHostPath = (
  executionPath: string,
  settings: Pick<AppSettings, "executionMode" | "distroName">,
  distroName = settings.distroName,
  platform: NodeJS.Platform = detectPlatform()
): string => {
  if (platform !== "win32" || settings.executionMode !== "wsl") {
    return executionPath;
  }

  const translatedWindowsPath = wslPathToWindowsPath(executionPath);
  if (translatedWindowsPath) {
    return translatedWindowsPath;
  }

  if (!distroName) {
    throw new Error(`Cannot translate WSL path "${executionPath}" to a Windows host path without a distro name.`);
  }

  return linuxPathToUncWslPath(executionPath, distroName);
};

export const resolveProjectPath = (
  inputPath: string,
  settings: AppSettings,
  platform: NodeJS.Platform = detectPlatform()
): ResolvedProjectPath => {
  const kind = detectProjectPathKind(inputPath);
  const usesWslExecution = platform === "win32" && settings.executionMode === "wsl";

  if (kind === "windows") {
    const normalizedWindowsPath = normalizeWindowsPath(inputPath);
    const wslPath = usesWslExecution ? windowsPathToWslPath(inputPath) : normalizedWindowsPath;
    return {
      kind,
      inputPath,
      displayPath: normalizedWindowsPath,
      hostPath: normalizedWindowsPath,
      wslPath,
      distroName: usesWslExecution ? settings.distroName : undefined,
      mountWarning: usesWslExecution && wslPath.startsWith("/mnt/")
    };
  }

  if (kind === "wsl-unc") {
    const { distroName, linuxPath } = uncWslToLinuxPath(inputPath);
    return {
      kind,
      inputPath,
      displayPath: inputPath.replace(/\\+$/, ""),
      hostPath: inputPath.replace(/\\+$/, ""),
      wslPath: usesWslExecution ? linuxPath : inputPath.replace(/\\+$/, ""),
      distroName: usesWslExecution ? distroName : undefined,
      mountWarning: usesWslExecution && linuxPath.startsWith("/mnt/")
    };
  }

  const displayPath = normalizePosixPath(inputPath);
  const wslPath = usesWslExecution ? displayPath : displayPath;
  return {
    kind,
    inputPath,
    displayPath,
    hostPath: executionPathToHostPath(displayPath, settings, settings.distroName, platform),
    wslPath,
    distroName: usesWslExecution ? settings.distroName : undefined,
    mountWarning: usesWslExecution && displayPath.startsWith("/mnt/")
  };
};

export const toProjectRelativePath = (projectRoot: string, absolutePath: string): string =>
  relativePath(projectRoot, absolutePath);
