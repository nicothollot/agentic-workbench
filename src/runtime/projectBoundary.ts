import { realpath } from "node:fs/promises";
import path from "node:path";
import type { AppSettings } from "@shared/types";
import { toProjectRelativePath, windowsPathToWslPath, wslPathToWindowsPath } from "@shared/pathUtils";

const WINDOWS_ABSOLUTE_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\)/;

const getPathModule = (value: string): path.PlatformPath =>
  WINDOWS_ABSOLUTE_PATH.test(value) ? path.win32 : path;

const hasUnsafeTraversal = (value: string): boolean =>
  value
    .replace(/\\/g, "/")
    .split("/")
    .some((segment) => segment === "..");

const isContainedPath = (projectRoot: string, candidate: string): boolean => {
  const pathModule = getPathModule(projectRoot);
  const relative = pathModule.relative(projectRoot, candidate);
  return relative === "" || (!relative.startsWith("..") && !pathModule.isAbsolute(relative));
};

const canonicalizeExistingPath = async (value: string): Promise<string> => await realpath(value);

const findExistingAncestor = async (value: string): Promise<string> => {
  const pathModule = getPathModule(value);
  let current = pathModule.resolve(value);

  while (true) {
    try {
      return await realpath(current);
    } catch {
      const parent = pathModule.dirname(current);
      if (parent === current) {
        throw new ProjectBoundaryError("The project boundary could not be resolved because no existing parent directory was found.");
      }
      current = parent;
    }
  }
};

const canonicalizeTargetPath = async (value: string): Promise<string> => {
  try {
    return await realpath(value);
  } catch {
    const pathModule = getPathModule(value);
    const parent = await findExistingAncestor(pathModule.dirname(value));
    return pathModule.join(parent, pathModule.basename(value));
  }
};

const trimTrailingPathSeparators = (value: string): string => {
  const trimmed = value.replace(/[\\/]+$/, "");
  if (!trimmed) {
    return value.startsWith("\\") ? "\\" : value.startsWith("/") ? "/" : value;
  }
  if (/^[a-zA-Z]:$/.test(trimmed)) {
    return `${trimmed}\\`;
  }
  return trimmed;
};

const WINDOWS_DRIVE_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/;

const isAnyAbsolutePath = (value: string): boolean =>
  path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || WINDOWS_ABSOLUTE_PATH.test(value);

const isContainedRelativePath = (relativePath: string): boolean => {
  const normalized = relativePath.replace(/\\/g, "/");
  return normalized === "" || (!normalized.startsWith("..") && !normalized.startsWith("/") && !WINDOWS_ABSOLUTE_PATH.test(relativePath));
};

const equivalentPathVariants = (value: string): string[] => {
  const normalized = trimTrailingPathSeparators(value);
  const variants = new Set<string>([normalized]);
  if (WINDOWS_DRIVE_ABSOLUTE_PATH.test(normalized)) {
    variants.add(windowsPathToWslPath(normalized));
  }
  const translatedWindowsPath = wslPathToWindowsPath(normalized);
  if (translatedWindowsPath) {
    variants.add(translatedWindowsPath);
  }
  return [...variants];
};

const findContainedRelativePath = (projectRoot: string, candidate: string): string | undefined => {
  for (const rootVariant of equivalentPathVariants(projectRoot)) {
    for (const candidateVariant of equivalentPathVariants(candidate)) {
      const relativePath = toProjectRelativePath(rootVariant, candidateVariant);
      if (isContainedRelativePath(relativePath)) {
        return relativePath.replace(/\\/g, "/");
      }
    }
  }
  return undefined;
};

export class ProjectBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectBoundaryError";
  }
}

export const ensureSafeProjectRelativePath = (relativePath: string, operation: string): string => {
  if (!relativePath.trim()) {
    throw new ProjectBoundaryError(`${operation} was rejected because the target path was empty.`);
  }
  if (path.posix.isAbsolute(relativePath) || WINDOWS_ABSOLUTE_PATH.test(relativePath) || hasUnsafeTraversal(relativePath)) {
    throw new ProjectBoundaryError(`${operation} was rejected because the target path escapes the active project folder.`);
  }

  const normalized = relativePath.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
  if (!normalized || normalized === ".") {
    throw new ProjectBoundaryError(`${operation} was rejected because the target path was not a concrete project-relative path.`);
  }
  return normalized;
};

export const joinExecutionPathWithinProject = (projectRoot: string, ...segments: string[]): string => {
  const pathModule = WINDOWS_ABSOLUTE_PATH.test(projectRoot) ? path.win32 : path.posix;
  const candidate = pathModule.join(projectRoot, ...segments);
  const normalizedRoot = pathModule.normalize(projectRoot);
  const normalizedCandidate = pathModule.normalize(candidate);
  const relative = pathModule.relative(normalizedRoot, normalizedCandidate);
  if (relative.startsWith("..") || pathModule.isAbsolute(relative)) {
    throw new ProjectBoundaryError("A worktree or execution path escaped the active project folder.");
  }
  return normalizedCandidate;
};

export const assertHostPathWithinProjectRoot = async (
  projectRootHostPath: string,
  candidatePath: string,
  operation: string
): Promise<string> => {
  const canonicalProjectRoot = await canonicalizeExistingPath(projectRootHostPath);
  const candidateCanonicalPath = await canonicalizeTargetPath(candidatePath);
  if (!isContainedPath(canonicalProjectRoot, candidateCanonicalPath)) {
    throw new ProjectBoundaryError(`${operation} was rejected because it would access a path outside the active project folder.`);
  }
  return candidateCanonicalPath;
};

export const assertProjectRelativeHostPath = async (
  projectRootHostPath: string,
  relativePath: string,
  operation: string
): Promise<string> => {
  const safeRelativePath = ensureSafeProjectRelativePath(relativePath, operation);
  return await assertHostPathWithinProjectRoot(projectRootHostPath, path.join(projectRootHostPath, safeRelativePath), operation);
};

export const resolveExecutionPathWithinProjectRoot = (
  projectRootExecutionPath: string,
  candidateExecutionPath: string,
  projectRootHostPath: string,
  operation: string
): { executionPath: string; hostPath: string } => {
  const pathModule = getPathModule(projectRootExecutionPath) === path.win32 ? path.win32 : path.posix;
  const normalizedRoot = pathModule.normalize(projectRootExecutionPath);
  const normalizedCandidate = pathModule.normalize(
    isAnyAbsolutePath(candidateExecutionPath)
      ? candidateExecutionPath
      : pathModule.join(projectRootExecutionPath, candidateExecutionPath)
  );
  const relative = findContainedRelativePath(normalizedRoot, normalizedCandidate);

  if (relative === undefined || hasUnsafeTraversal(candidateExecutionPath)) {
    throw new ProjectBoundaryError(`${operation} was rejected because it would escape the active project folder.`);
  }

  const hostPathModule = getPathModule(projectRootHostPath);
  const hostSegments = relative === "" ? [] : relative.split(/[\\/]+/).filter((segment) => segment.length > 0);
  const hostPath = hostSegments.length > 0 ? hostPathModule.join(projectRootHostPath, ...hostSegments) : projectRootHostPath;

  return {
    executionPath: hostSegments.length > 0 ? pathModule.join(normalizedRoot, ...hostSegments) : normalizedRoot,
    hostPath
  };
};

export const assertExecutionPathWithinProjectRoot = async (
  projectRootExecutionPath: string,
  candidateExecutionPath: string,
  projectRootHostPath: string,
  settings: Pick<AppSettings, "executionMode" | "distroName">,
  distroName: string | undefined,
  operation: string
): Promise<{ executionPath: string; hostPath: string }> => {
  void settings;
  void distroName;
  const resolved = resolveExecutionPathWithinProjectRoot(
    projectRootExecutionPath,
    candidateExecutionPath,
    projectRootHostPath,
    operation
  );
  await assertHostPathWithinProjectRoot(projectRootHostPath, resolved.hostPath, operation);

  return resolved;
};
