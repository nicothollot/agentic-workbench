import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import ignore from "ignore";
import { DEFAULT_IGNORES } from "@shared/constants";
import type { DependencyRecord, ProjectKind, ProjectStats, RepoTreeNode } from "@shared/types";
import { detectPrimaryManagers, parseManifestFile } from "./manifestParser";

export interface GitMetadata {
  isGit: boolean;
  gitRoot?: string;
  branch?: string;
  head?: string;
  rootCommit?: string;
  earliestCommitAt?: string;
  lastCommitAt?: string;
  normalizedRemotes: string[];
}

export interface ScannedFile {
  absolutePath: string;
  relativePath: string;
  size: number;
  language: string;
}

export interface RepoScanResult {
  kind: ProjectKind;
  tree: RepoTreeNode[];
  files: ScannedFile[];
  stats: ProjectStats;
  dependencies: DependencyRecord[];
  manifestHash: string;
  treeHash: string;
}

type ExclusionRule = "default" | "gitignore";
type ScanTruncationReason = NonNullable<ProjectStats["truncationReasons"]>[number];

export interface RepositoryScanLimits {
  maxIncludedFiles: number;
  maxIncludedDirectories: number;
  maxDepth: number;
  maxManifestFileSizeBytes: number;
  maxScanDurationMs: number;
  maxExcludedPathRecords: number;
}

export const DEFAULT_REPOSITORY_SCAN_LIMITS: RepositoryScanLimits = {
  maxIncludedFiles: 12_000,
  maxIncludedDirectories: 6_000,
  maxDepth: 32,
  maxManifestFileSizeBytes: 1_000_000,
  maxScanDurationMs: 10_000,
  maxExcludedPathRecords: 500
};

const SCAN_EVENT_LOOP_YIELD_INTERVAL = 100;
const debugRepoScanPerf = process.env.WORKBENCH_PERF === "1" || process.env.AWB_DEBUG_WORKFLOW_PERF === "1";

const isSkippableScanError = (error: unknown): boolean => {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  return code === "EACCES" || code === "EPERM" || code === "ENOENT" || code === "EISDIR";
};

const sourceLikeExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".rb",
  ".php",
  ".html",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".sql",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".swift",
  ".dart"
]);

const documentationExtensions = new Set([".md", ".mdx", ".txt", ".rst"]);
const configLikeExtensions = new Set([".json", ".yaml", ".yml", ".toml", ".ini", ".conf", ".properties"]);
const trivialFileNames = new Set([
  ".gitignore",
  ".gitattributes",
  ".gitmodules",
  ".gitkeep",
  ".keep",
  ".editorconfig",
  ".npmrc",
  ".nvmrc",
  ".prettierrc",
  ".prettierignore",
  ".eslintignore",
  ".dockerignore",
  "license",
  "license.md"
]);

const manifestCandidates = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "requirements.txt",
  "pyproject.toml",
  "Pipfile",
  "poetry.lock",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "composer.json"
]);

const languageByExtension: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".json": "JSON",
  ".py": "Python",
  ".go": "Go",
  ".rs": "Rust",
  ".java": "Java",
  ".kt": "Kotlin",
  ".rb": "Ruby",
  ".php": "PHP",
  ".md": "Markdown",
  ".css": "CSS",
  ".html": "HTML",
  ".toml": "TOML",
  ".yml": "YAML",
  ".yaml": "YAML"
};

const buildIgnoreMatcher = async (projectRoot: string) => {
  const defaultMatcher = ignore().add(DEFAULT_IGNORES);
  const gitignoreMatcher = ignore();
  try {
    const gitignoreContent = await readFile(path.join(projectRoot, ".gitignore"), "utf8");
    gitignoreMatcher.add(gitignoreContent);
  } catch {
    // Optional file.
  }
  return {
    match(relativePath: string): ExclusionRule | null {
      if (defaultMatcher.ignores(relativePath)) {
        return "default";
      }
      if (gitignoreMatcher.ignores(relativePath)) {
        return "gitignore";
      }
      return null;
    }
  };
};

const guessLanguage = (relativePath: string): string => languageByExtension[path.extname(relativePath).toLowerCase()] ?? "Other";

const isTrivialPlaceholderFile = (file: Pick<ScannedFile, "relativePath">): boolean => {
  const baseName = path.basename(file.relativePath).toLowerCase();
  return trivialFileNames.has(baseName);
};

const isSourceLikeFile = (file: Pick<ScannedFile, "relativePath" | "language">): boolean => {
  const extension = path.extname(file.relativePath).toLowerCase();
  if (sourceLikeExtensions.has(extension)) {
    return true;
  }

  const baseName = path.basename(file.relativePath);
  return /^(Dockerfile|Makefile|Procfile)$/i.test(baseName) || (file.language !== "Markdown" && file.language !== "JSON" && file.language !== "YAML" && file.language !== "TOML" && file.language !== "Other");
};

export const hasMeaningfulRepositoryContent = (
  scan: Pick<RepoScanResult, "files" | "dependencies" | "stats">
): boolean => {
  if (scan.files.length === 0) {
    return false;
  }

  if (scan.dependencies.length > 0) {
    return true;
  }

  if (scan.stats.entryPoints.some((entry) => entry !== "package.json")) {
    return true;
  }

  if (scan.files.some((file) => !isTrivialPlaceholderFile(file) && isSourceLikeFile(file))) {
    return true;
  }

  const documentationFiles = scan.files.filter((file) => {
    if (isTrivialPlaceholderFile(file)) {
      return false;
    }
    const extension = path.extname(file.relativePath).toLowerCase();
    return documentationExtensions.has(extension) && file.size >= 200;
  });
  if (documentationFiles.length >= 2) {
    return true;
  }

  const nonTrivialConfigFiles = scan.files.filter((file) => {
    if (isTrivialPlaceholderFile(file)) {
      return false;
    }
    const extension = path.extname(file.relativePath).toLowerCase();
    return configLikeExtensions.has(extension) && file.size >= 300;
  });
  if (nonTrivialConfigFiles.length >= 2 && scan.stats.includedSizeBytes >= 1_500) {
    return true;
  }

  const nonTrivialFiles = scan.files.filter((file) => !isTrivialPlaceholderFile(file));
  return nonTrivialFiles.length >= 3 && scan.stats.includedSizeBytes >= 1_500;
};

const summarizeProjectPurpose = (manifestFiles: string[], entryPoints: string[], languageBreakdown: Record<string, number>): string => {
  if (manifestFiles.length === 0 && entryPoints.length === 0 && Object.keys(languageBreakdown).length === 0) {
    return "This project folder is effectively empty and ready for initial setup.";
  }
  if (manifestFiles.includes("package.json")) {
    if (entryPoints.some((entry) => entry.endsWith("electron.ts") || entry.endsWith("main.ts"))) {
      return "This appears to be a JavaScript/TypeScript desktop or tooling project.";
    }
    return "This appears to be a JavaScript/TypeScript application or library.";
  }
  if (manifestFiles.includes("pyproject.toml") || manifestFiles.includes("requirements.txt")) {
    return "This appears to be a Python project with deterministic dependency metadata.";
  }
  if (manifestFiles.includes("Cargo.toml")) {
    return "This appears to be a Rust project.";
  }
  if (manifestFiles.includes("go.mod")) {
    return "This appears to be a Go module.";
  }

  const dominantLanguage = Object.entries(languageBreakdown).sort((left, right) => right[1] - left[1])[0]?.[0];
  return dominantLanguage
    ? `This repository is primarily ${dominantLanguage} source code.`
    : "This repository contains a mixed set of source files.";
};

const findEntryPoints = (files: ScannedFile[]): string[] =>
  files
    .map((file) => file.relativePath)
    .filter((relativePath) =>
      /(src\/)?(index|main|app)\.(ts|tsx|js|jsx|py|go|rs|java)$/.test(relativePath) ||
      /package\.json$/.test(relativePath)
    )
    .slice(0, 12);

const toTree = (files: ScannedFile[]): RepoTreeNode[] => {
  type IndexedRepoTreeNode = Omit<RepoTreeNode, "children"> & {
    children?: IndexedRepoTreeNode[];
    childIndex?: Map<string, IndexedRepoTreeNode>;
  };
  const root: IndexedRepoTreeNode[] = [];
  const rootIndex = new Map<string, IndexedRepoTreeNode>();

  for (const file of files) {
    const parts = file.relativePath.split("/");
    let currentChildren = root;
    let currentIndex = rootIndex;
    let currentPath = "";

    parts.forEach((part, index) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isLeaf = index === parts.length - 1;
      const nodeKey = `${isLeaf ? "file" : "directory"}:${part}`;
      let node = currentIndex.get(nodeKey);
      if (!node) {
        node = {
          path: currentPath,
          name: part,
          type: isLeaf ? "file" : "directory",
          children: isLeaf ? undefined : [],
          childIndex: isLeaf ? undefined : new Map<string, IndexedRepoTreeNode>()
        };
        currentChildren.push(node);
        currentIndex.set(nodeKey, node);
      }

      if (isLeaf) {
        node.size = file.size;
        node.language = file.language;
        return;
      }

      node.children ??= [];
      currentChildren = node.children;
      node.childIndex ??= new Map<string, IndexedRepoTreeNode>();
      currentIndex = node.childIndex;
    });
  }

  const sortNodes = (nodes: IndexedRepoTreeNode[]): RepoTreeNode[] =>
    nodes
      .map((node) => ({
        path: node.path,
        name: node.name,
        type: node.type,
        size: node.size,
        language: node.language,
        children: node.children ? sortNodes(node.children) : undefined
      }))
      .sort((left, right) =>
        left.type === right.type ? left.name.localeCompare(right.name) : left.type === "directory" ? -1 : 1
      );

  return sortNodes(root);
};

const mergeScanLimits = (limits: Partial<RepositoryScanLimits> = {}): RepositoryScanLimits => ({
  maxIncludedFiles: Math.max(1, Math.floor(limits.maxIncludedFiles ?? DEFAULT_REPOSITORY_SCAN_LIMITS.maxIncludedFiles)),
  maxIncludedDirectories: Math.max(1, Math.floor(limits.maxIncludedDirectories ?? DEFAULT_REPOSITORY_SCAN_LIMITS.maxIncludedDirectories)),
  maxDepth: Math.max(1, Math.floor(limits.maxDepth ?? DEFAULT_REPOSITORY_SCAN_LIMITS.maxDepth)),
  maxManifestFileSizeBytes: Math.max(1, Math.floor(limits.maxManifestFileSizeBytes ?? DEFAULT_REPOSITORY_SCAN_LIMITS.maxManifestFileSizeBytes)),
  maxScanDurationMs: Math.max(1, Math.floor(limits.maxScanDurationMs ?? DEFAULT_REPOSITORY_SCAN_LIMITS.maxScanDurationMs)),
  maxExcludedPathRecords: Math.max(1, Math.floor(limits.maxExcludedPathRecords ?? DEFAULT_REPOSITORY_SCAN_LIMITS.maxExcludedPathRecords))
});

const truncationReasonLabels: Record<ScanTruncationReason, string> = {
  included_file_limit: "included file limit reached",
  included_directory_limit: "included directory limit reached",
  depth_limit: "maximum scan depth reached",
  scan_duration_limit: "scan duration limit reached",
  manifest_file_size: "oversized manifest file skipped",
  excluded_path_record_limit: "excluded path record limit reached"
};

const summarizeTruncationReasons = (reasons: ScanTruncationReason[]): string | undefined =>
  reasons.length ? reasons.map((reason) => truncationReasonLabels[reason]).join("; ") : undefined;

const hashScannedFiles = (files: ScannedFile[]): string => {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(String(file.size));
    hash.update("\0");
    hash.update(file.language);
    hash.update("\n");
  }
  return hash.digest("hex");
};

const hashDependencies = (dependencies: DependencyRecord[]): string => {
  const hash = createHash("sha256");
  for (const dependency of [...dependencies].sort((left, right) =>
    `${left.manifest}:${left.ecosystem}:${left.name}:${left.version}:${left.dev ? "1" : "0"}`
      .localeCompare(`${right.manifest}:${right.ecosystem}:${right.name}:${right.version}:${right.dev ? "1" : "0"}`)
  )) {
    hash.update(dependency.manifest);
    hash.update("\0");
    hash.update(dependency.ecosystem);
    hash.update("\0");
    hash.update(dependency.name);
    hash.update("\0");
    hash.update(dependency.version);
    hash.update("\0");
    hash.update(dependency.dev ? "1" : "0");
    hash.update("\n");
  }
  return hash.digest("hex");
};

export const scanRepository = async (
  projectRootHostPath: string,
  gitMetadata: GitMetadata,
  executionProjectRoot = projectRootHostPath,
  scanLimits: Partial<RepositoryScanLimits> = {}
): Promise<RepoScanResult> => {
  const limits = mergeScanLimits(scanLimits);
  const scanStartedAt = performance.now();
  const matcher = await buildIgnoreMatcher(projectRootHostPath);
  const files: ScannedFile[] = [];
  const folders = new Set<string>();
  const manifestFiles = new Set<string>();
  const dependencies: DependencyRecord[] = [];
  const excludedPaths: ProjectStats["excludedPaths"] = [];
  const truncationReasons = new Set<ScanTruncationReason>();
  const languageBreakdown: Record<string, number> = {};
  const fileTypeBreakdown: Record<string, number> = {};
  let includedSizeBytes = 0;
  let excludedFiles = 0;
  let excludedFolders = 0;
  let excludedSizeBytes = 0;
  let omittedFilesEstimate = 0;
  let omittedDirectoriesEstimate = 0;
  let skippedManifestFiles = 0;
  let excludedPathRecordsTruncated = false;
  let scannedEntriesSinceYield = 0;
  let stopScan = false;

  const markTruncated = (
    reason: ScanTruncationReason,
    estimates: { files?: number; directories?: number } = {}
  ): void => {
    truncationReasons.add(reason);
    omittedFilesEstimate += estimates.files ?? 0;
    omittedDirectoriesEstimate += estimates.directories ?? 0;
  };

  const hasExceededScanDuration = (): boolean => {
    if (performance.now() - scanStartedAt <= limits.maxScanDurationMs) {
      return false;
    }
    markTruncated("scan_duration_limit");
    stopScan = true;
    return true;
  };

  const yieldDuringLargeScan = async (): Promise<void> => {
    scannedEntriesSinceYield += 1;
    if (scannedEntriesSinceYield < SCAN_EVENT_LOOP_YIELD_INTERVAL) {
      hasExceededScanDuration();
      return;
    }
    scannedEntriesSinceYield = 0;
    await yieldImmediate();
    hasExceededScanDuration();
  };

  const summarizeExcludedPath = async (absolutePath: string): Promise<{ fileCount: number; folderCount: number; totalSizeBytes: number }> => {
    let entryStats;
    try {
      entryStats = await lstat(absolutePath);
    } catch (error) {
      if (isSkippableScanError(error)) {
        return {
          fileCount: 0,
          folderCount: 0,
          totalSizeBytes: 0
        };
      }
      throw error;
    }

    if (entryStats.isFile()) {
      return {
        fileCount: 1,
        folderCount: 0,
        totalSizeBytes: entryStats.size
      };
    }
    if (entryStats.isSymbolicLink()) {
      return {
        fileCount: 1,
        folderCount: 0,
        totalSizeBytes: 0
      };
    }
    if (!entryStats.isDirectory()) {
      return {
        fileCount: 0,
        folderCount: 0,
        totalSizeBytes: 0
      };
    }

    return {
      fileCount: 0,
      folderCount: 1,
      totalSizeBytes: 0
    };
  };

  const recordExcludedPath = (entry: {
    path: string;
    kind: "directory" | "file";
    rule: ExclusionRule;
    fileCount: number;
    totalSizeBytes: number;
  }): void => {
    if (excludedPaths.length < limits.maxExcludedPathRecords) {
      excludedPaths.push(entry);
      return;
    }
    excludedPathRecordsTruncated = true;
    truncationReasons.add("excluded_path_record_limit");
  };

  const walk = async (currentDir: string, depth: number): Promise<void> => {
    if (stopScan || hasExceededScanDuration()) {
      return;
    }
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      if (isSkippableScanError(error)) {
        return;
      }
      throw error;
    }
    for (let index = 0; index < entries.length; index += 1) {
      if (stopScan) {
        return;
      }
      const entry = entries[index];
      await yieldDuringLargeScan();
      if (stopScan) {
        return;
      }
      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = path.relative(projectRootHostPath, absolutePath).split(path.sep).join("/");
      if (!relativePath) {
        continue;
      }

      const entryDepth = depth + 1;
      if (entryDepth > limits.maxDepth) {
        markTruncated("depth_limit", {
          files: entry.isFile() ? 1 : 0,
          directories: entry.isDirectory() ? 1 : 0
        });
        continue;
      }

      const exclusionRule = matcher.match(relativePath);
      if (exclusionRule) {
        const summary = await summarizeExcludedPath(absolutePath);
        excludedFiles += summary.fileCount;
        excludedFolders += summary.folderCount;
        excludedSizeBytes += summary.totalSizeBytes;
        recordExcludedPath({
          path: relativePath,
          kind: entry.isDirectory() ? "directory" : "file",
          rule: exclusionRule,
          fileCount: summary.fileCount,
          totalSizeBytes: summary.totalSizeBytes
        });
        continue;
      }

      if (entry.isDirectory()) {
        if (folders.size >= limits.maxIncludedDirectories) {
          markTruncated("included_directory_limit", { directories: 1 });
          continue;
        }
        folders.add(relativePath);
        await walk(absolutePath, entryDepth);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (files.length >= limits.maxIncludedFiles) {
        markTruncated("included_file_limit", { files: Math.max(1, entries.length - index) });
        stopScan = true;
        return;
      }

      let fileStats;
      try {
        fileStats = await stat(absolutePath);
      } catch (error) {
        if (isSkippableScanError(error)) {
          continue;
        }
        throw error;
      }
      const language = guessLanguage(relativePath);
      files.push({
        absolutePath,
        relativePath,
        size: fileStats.size,
        language
      });
      includedSizeBytes += fileStats.size;
      fileTypeBreakdown[language] = (fileTypeBreakdown[language] ?? 0) + 1;
      languageBreakdown[language] = (languageBreakdown[language] ?? 0) + fileStats.size;

      const baseName = path.basename(relativePath);
      if (manifestCandidates.has(baseName)) {
        manifestFiles.add(relativePath);
        if (fileStats.size > limits.maxManifestFileSizeBytes) {
          skippedManifestFiles += 1;
          markTruncated("manifest_file_size");
          continue;
        }
        dependencies.push(...(await parseManifestFile(projectRootHostPath, relativePath)));
      }
    }
  };

  await walk(projectRootHostPath, 0);

  const entryPoints = findEntryPoints(files);
  const totalFiles = files.length + excludedFiles + omittedFilesEstimate;
  const totalFolders = folders.size + excludedFolders + omittedDirectoriesEstimate;
  const totalSizeBytes = includedSizeBytes + excludedSizeBytes;
  const scanDurationMs = performance.now() - scanStartedAt;
  const sortedTruncationReasons = [...truncationReasons].sort();
  const stats: ProjectStats = {
    projectRoot: executionProjectRoot,
    kind: gitMetadata.isGit ? "git" : "folder",
    createdAt: gitMetadata.earliestCommitAt,
    lastCommitAt: gitMetadata.lastCommitAt,
    totalFiles,
    totalFolders,
    totalSizeBytes,
    includedFiles: files.length,
    includedFolders: folders.size,
    includedSizeBytes,
    excludedFiles,
    excludedFolders,
    excludedSizeBytes,
    excludedPaths: excludedPaths.sort((left, right) => right.totalSizeBytes - left.totalSizeBytes || left.path.localeCompare(right.path)),
    fileTypeBreakdown,
    languageBreakdown,
    entryPoints,
    manifestFiles: [...manifestFiles].sort(),
    testsPresent: files.some((file) => /(^|\/)(test|tests|__tests__)\//.test(file.relativePath) || /\.(test|spec)\./.test(file.relativePath)),
    primaryManagers: detectPrimaryManagers([...manifestFiles]),
    explanation: summarizeProjectPurpose([...manifestFiles], entryPoints, languageBreakdown),
    truncated: sortedTruncationReasons.length > 0,
    truncationReasons: sortedTruncationReasons,
    truncationReason: summarizeTruncationReasons(sortedTruncationReasons),
    includedFileLimit: limits.maxIncludedFiles,
    includedDirectoryLimit: limits.maxIncludedDirectories,
    maxDepth: limits.maxDepth,
    maxScanDurationMs: limits.maxScanDurationMs,
    maxManifestFileSizeBytes: limits.maxManifestFileSizeBytes,
    excludedPathLimit: limits.maxExcludedPathRecords,
    excludedPathRecordsTruncated,
    omittedFilesEstimate,
    omittedDirectoriesEstimate,
    skippedManifestFiles,
    scanDurationMs
  };

  const sortedDependencies = dependencies.sort((left, right) => `${left.manifest}:${left.name}`.localeCompare(`${right.manifest}:${right.name}`));
  const tree = toTree(files);

  if (debugRepoScanPerf) {
    console.info(
      `[repo-scan-perf] scan ${projectRootHostPath}: ${Math.round(scanDurationMs)}ms, ` +
      `files=${files.length}, directories=${folders.size}, excludedPaths=${excludedPaths.length}, ` +
      `excludedFiles=${excludedFiles}, truncated=${stats.truncated ? stats.truncationReason : "false"}`
    );
  }

  return {
    kind: gitMetadata.isGit ? "git" : "folder",
    tree,
    files,
    stats,
    dependencies: sortedDependencies,
    manifestHash: hashDependencies(sortedDependencies),
    treeHash: hashScannedFiles(files)
  };
};
