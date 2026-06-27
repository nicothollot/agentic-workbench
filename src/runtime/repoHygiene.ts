import { lstat, readdir, readFile, realpath, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { AppSettings, ProjectKind, RepoHygieneReport } from "@shared/types";
import { nowIso, unique } from "@shared/utils";
import { RuntimeCommandExecutor } from "./execution";

type RuntimeSettings = Pick<AppSettings, "executionMode" | "distroName">;

export interface RepoHygieneScanInput {
  projectRoot: string;
  hostRoot?: string;
  projectKind: ProjectKind;
  runtimeSettings: RuntimeSettings;
  scannedRef: string;
  clean?: boolean;
}

const TYPO_ROOT_DOCS = new Set(["EADME.md", "RREADME.md", "READM.md", "READNE.md", "README.m"]);
const ROOT_DOC_CANONICALS = ["README.md", "LICENSE", "CHANGELOG.md", "pyproject.toml"];
const GENERATED_ARTIFACT_PATTERN =
  /(?:^|\/)(?:Screenshot\s+\d{4}|.*(?:interface-export|interface-visuals|review-log|review_log|transcript|full-output|raw-output|debug-dump).*\.(?:json|txt|md|log|png|jpg|jpeg|webp|pdf)|.*\.(?:har))$/i;
const SECRET_PATTERN =
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b|\b(?:ghp|github_pat)_[A-Za-z0-9_]{16,}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{12,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|(?:api[_\s-]?key|secret(?:[_\s-]?key)?|access[_\s-]?token|refresh[_\s-]?token|client[_\s-]?secret|password)\s*[:=]\s*["']?[A-Za-z0-9_./+=~:-]{12,}/i;
const ABSOLUTE_LOCAL_PATH_PATTERN = /\b(?:[A-Za-z]:\\Users\\|\/(?:home|Users|mnt|private|Volumes)\/)[^\s"'`]+/;
const TEXT_FILE_PATTERN = /\.(?:md|txt|json|yaml|yml|toml|ini|env|py|ts|tsx|js|jsx|mjs|cjs|css|html|csv)$/i;

const normalizeRelativePath = (value: string): string =>
  value.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");

const getPathModule = (root: string): path.PlatformPath => root.includes("\\") ? path.win32 : path.posix;

const isContained = (root: string, candidate: string): boolean => {
  const pathModule = getPathModule(root);
  const relative = pathModule.relative(pathModule.resolve(root), pathModule.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !pathModule.isAbsolute(relative));
};

const hostPathForRelative = (hostRoot: string, relativePath: string): string => {
  const pathModule = getPathModule(hostRoot);
  return pathModule.join(hostRoot, ...relativePath.split("/"));
};

const levenshteinDistance = (left: string, right: string): number => {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let col = 1; col <= right.length; col += 1) {
      current[col] = Math.min(
        previous[col] + 1,
        current[col - 1] + 1,
        previous[col - 1] + (left[row - 1] === right[col - 1] ? 0 : 1)
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? Math.max(left.length, right.length);
};

const parseGitStatusPaths = (output: string): string[] =>
  unique(
    output
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => {
        const candidate = line.slice(3).trim();
        const renameMarker = " -> ";
        return normalizeRelativePath(candidate.includes(renameMarker) ? candidate.slice(candidate.lastIndexOf(renameMarker) + renameMarker.length) : candidate);
      })
  );

const readChangedGitPaths = async (
  projectRoot: string,
  projectKind: ProjectKind,
  runtimeSettings: RuntimeSettings
): Promise<string[]> => {
  if (projectKind !== "git") {
    return [];
  }
  try {
    const { stdout } = await new RuntimeCommandExecutor(runtimeSettings).execStructuredCommand({
      command: "git",
      args: ["status", "--porcelain=1", "--untracked-files=all"],
      cwd: projectRoot
    });
    return parseGitStatusPaths(stdout);
  } catch {
    return [];
  }
};

const cleanupPythonBytecode = async (root: string): Promise<string[]> => {
  const cleaned: string[] = [];
  const pathModule = getPathModule(root);
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".venv" || entry.name === "venv") {
        continue;
      }
      const fullPath = pathModule.join(directory, entry.name);
      const relative = normalizeRelativePath(pathModule.relative(root, fullPath));
      if (entry.isDirectory() && entry.name === "__pycache__") {
        await rm(fullPath, { recursive: true, force: true });
        cleaned.push(relative.endsWith("/") ? relative : `${relative}/`);
        continue;
      }
      if (entry.isFile() && /\.(?:pyc|pyo)$/i.test(entry.name)) {
        await unlink(fullPath).catch(() => undefined);
        cleaned.push(relative);
        continue;
      }
      if (entry.isDirectory()) {
        await visit(fullPath);
      }
    }
  };
  await visit(root);
  return unique(cleaned);
};

const rootEntries = async (hostRoot: string): Promise<Set<string>> => {
  try {
    return new Set((await readdir(hostRoot, { withFileTypes: true })).map((entry) => entry.name));
  } catch {
    return new Set();
  }
};

const shouldReadFileForHygiene = async (filePath: string, relativePath: string): Promise<boolean> => {
  if (!TEXT_FILE_PATTERN.test(relativePath)) {
    return false;
  }
  try {
    const info = await stat(filePath);
    return info.isFile() && info.size <= 1_000_000;
  } catch {
    return false;
  }
};

const inspectSymlink = async (hostRoot: string, relativePath: string): Promise<string | undefined> => {
  const candidate = hostPathForRelative(hostRoot, relativePath);
  try {
    const link = await lstat(candidate);
    if (!link.isSymbolicLink()) {
      return undefined;
    }
    const resolvedRoot = await realpath(hostRoot);
    const resolvedTarget = await realpath(candidate);
    return isContained(resolvedRoot, resolvedTarget) ? undefined : `${relativePath} symlink escapes the project root.`;
  } catch {
    return undefined;
  }
};

const pathFindings = async (hostRoot: string, changedPaths: string[]): Promise<{ blocking: string[]; warnings: string[]; forbidden: string[] }> => {
  const entries = await rootEntries(hostRoot);
  const blocking: string[] = [];
  const warnings: string[] = [];
  const forbidden: string[] = [];
  const docsExists = entries.has("docs");
  const srcExists = entries.has("src");
  const testsExists = entries.has("tests");

  for (const relativePath of changedPaths) {
    const normalized = normalizeRelativePath(relativePath);
    const first = normalized.split("/")[0] ?? normalized;
    if (!normalized || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
      blocking.push(`${relativePath} is outside the intended project boundary.`);
      forbidden.push(relativePath);
      continue;
    }
    if (/__pycache__(?:\/|$)|\.(?:pyc|pyo)$/i.test(normalized)) {
      blocking.push(`${normalized} is generated Python bytecode and cannot be merged.`);
      forbidden.push(normalized);
    }
    if (/^\.pytest_cache(?:\/|$)/.test(normalized)) {
      blocking.push(`${normalized} is pytest cache output and cannot be merged.`);
      forbidden.push(normalized);
    }
    if (TYPO_ROOT_DOCS.has(normalized) || (normalized === first && ROOT_DOC_CANONICALS.some((canonical) => levenshteinDistance(normalized.toLowerCase(), canonical.toLowerCase()) === 1 && normalized !== canonical))) {
      blocking.push(`${normalized} looks like an accidental typo of a root documentation/config file.`);
      forbidden.push(normalized);
    }
    if (docsExists && first === "ocs") {
      blocking.push(`${normalized} is under ocs/, which looks like a typo of docs/.`);
      forbidden.push(normalized);
    }
    if (srcExists && first === "srx") {
      blocking.push(`${normalized} is under srx/, which looks like a typo of src/.`);
      forbidden.push(normalized);
    }
    if (testsExists && (first === "tesst" || first === "test")) {
      blocking.push(`${normalized} is under ${first}/, which looks inconsistent with the existing tests/ directory.`);
      forbidden.push(normalized);
    }
    if (GENERATED_ARTIFACT_PATTERN.test(normalized) && !normalized.startsWith(".agent-workbench/internal/")) {
      blocking.push(`${normalized} is a generated artifact outside .agent-workbench/internal storage.`);
      forbidden.push(normalized);
    }
    const symlinkFinding = await inspectSymlink(hostRoot, normalized);
    if (symlinkFinding) {
      blocking.push(symlinkFinding);
      forbidden.push(normalized);
    }
  }
  return { blocking: unique(blocking), warnings: unique(warnings), forbidden: unique(forbidden) };
};

const contentFindings = async (hostRoot: string, changedPaths: string[]): Promise<{ blocking: string[]; warnings: string[] }> => {
  const blocking: string[] = [];
  const warnings: string[] = [];
  for (const relativePath of changedPaths) {
    const normalized = normalizeRelativePath(relativePath);
    const filePath = hostPathForRelative(hostRoot, normalized);
    if (!isContained(hostRoot, filePath) || !(await shouldReadFileForHygiene(filePath, normalized))) {
      continue;
    }
    const text = await readFile(filePath, "utf8").catch(() => "");
    if (!text) {
      continue;
    }
    if (SECRET_PATTERN.test(text)) {
      blocking.push(`${normalized} contains a secret-looking value.`);
    }
    if (/^(?:docs\/|.*\.(?:md|txt|json|log|yaml|yml|toml)$)/i.test(normalized) && ABSOLUTE_LOCAL_PATH_PATTERN.test(text)) {
      warnings.push(`${normalized} contains an absolute local path.`);
    }
  }
  return { blocking: unique(blocking), warnings: unique(warnings) };
};

export const scanAndCleanRepoHygiene = async (input: RepoHygieneScanInput): Promise<RepoHygieneReport> => {
  const hostRoot = input.hostRoot ?? input.projectRoot;
  const cleanedFiles = input.clean === false ? [] : await cleanupPythonBytecode(hostRoot);
  const changedPaths = await readChangedGitPaths(input.projectRoot, input.projectKind, input.runtimeSettings);
  const pathReport = await pathFindings(hostRoot, changedPaths);
  const contentReport = await contentFindings(hostRoot, changedPaths);
  const mergeBlockingFindings = unique([...pathReport.blocking, ...contentReport.blocking]);
  const warnings = unique([
    ...pathReport.warnings,
    ...contentReport.warnings
  ]);
  const status: RepoHygieneReport["status"] = mergeBlockingFindings.length > 0 ? "failed" : warnings.length > 0 ? "warnings" : "passed";
  return {
    status,
    scannedAt: nowIso(),
    scannedRef: input.scannedRef,
    forbiddenFiles: pathReport.forbidden,
    cleanedFiles,
    warnings,
    mergeBlockingFindings,
    summaryForHumans: mergeBlockingFindings.length > 0
      ? `Repository hygiene blocked merge: ${mergeBlockingFindings[0]}`
      : cleanedFiles.length > 0
        ? "Generated Python bytecode artifacts cleaned before diff/merge."
        : warnings.length > 0
          ? `Repository hygiene passed with ${warnings.length} warning${warnings.length === 1 ? "" : "s"}.`
          : "Repository hygiene passed."
  };
};
