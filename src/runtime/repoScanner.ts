import { lstat, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import ignore from "ignore";
import { DEFAULT_IGNORES } from "@shared/constants";
import type { DependencyRecord, ProjectKind, ProjectStats, RepoTreeNode } from "@shared/types";
import { stableStringify } from "@shared/utils";
import { sha256 } from "./hashUtils";
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
  const root: RepoTreeNode[] = [];

  for (const file of files) {
    const parts = file.relativePath.split("/");
    let currentChildren = root;
    let currentPath = "";

    parts.forEach((part, index) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isLeaf = index === parts.length - 1;
      let node = currentChildren.find((entry) => entry.name === part && entry.type === (isLeaf ? "file" : "directory"));
      if (!node) {
        node = {
          path: currentPath,
          name: part,
          type: isLeaf ? "file" : "directory",
          children: isLeaf ? undefined : []
        };
        currentChildren.push(node);
      }

      if (isLeaf) {
        node.size = file.size;
        node.language = file.language;
        return;
      }

      node.children ??= [];
      currentChildren = node.children;
    });
  }

  const sortNodes = (nodes: RepoTreeNode[]): RepoTreeNode[] =>
    nodes
      .map((node) => ({
        ...node,
        children: node.children ? sortNodes(node.children) : undefined
      }))
      .sort((left, right) =>
        left.type === right.type ? left.name.localeCompare(right.name) : left.type === "directory" ? -1 : 1
      );

  return sortNodes(root);
};

export const scanRepository = async (
  projectRootHostPath: string,
  gitMetadata: GitMetadata,
  executionProjectRoot = projectRootHostPath
): Promise<RepoScanResult> => {
  const matcher = await buildIgnoreMatcher(projectRootHostPath);
  const files: ScannedFile[] = [];
  const folders = new Set<string>();
  const manifestFiles = new Set<string>();
  const dependencies: DependencyRecord[] = [];
  const excludedPaths: ProjectStats["excludedPaths"] = [];
  const languageBreakdown: Record<string, number> = {};
  const fileTypeBreakdown: Record<string, number> = {};
  let includedSizeBytes = 0;
  let excludedFiles = 0;
  let excludedFolders = 0;
  let excludedSizeBytes = 0;

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

    let entries;
    try {
      entries = await readdir(absolutePath, { withFileTypes: true });
    } catch (error) {
      if (isSkippableScanError(error)) {
        return {
          fileCount: 0,
          folderCount: 1,
          totalSizeBytes: 0
        };
      }
      throw error;
    }
    let fileCount = 0;
    let folderCount = 1;
    let totalSizeBytes = 0;

    for (const entry of entries) {
      const childSummary = await summarizeExcludedPath(path.join(absolutePath, entry.name));
      fileCount += childSummary.fileCount;
      folderCount += childSummary.folderCount;
      totalSizeBytes += childSummary.totalSizeBytes;
    }

    return {
      fileCount,
      folderCount,
      totalSizeBytes
    };
  };

  const walk = async (currentDir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      if (isSkippableScanError(error)) {
        return;
      }
      throw error;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const absolutePath = path.join(currentDir, entry.name);
        const relativePath = path.relative(projectRootHostPath, absolutePath).split(path.sep).join("/");
        if (!relativePath) {
          return;
        }

        const exclusionRule = matcher.match(relativePath);
        if (exclusionRule) {
          const summary = await summarizeExcludedPath(absolutePath);
          excludedFiles += summary.fileCount;
          excludedFolders += summary.folderCount;
          excludedSizeBytes += summary.totalSizeBytes;
          excludedPaths.push({
            path: relativePath,
            kind: entry.isDirectory() ? "directory" : "file",
            rule: exclusionRule,
            fileCount: summary.fileCount,
            totalSizeBytes: summary.totalSizeBytes
          });
          return;
        }

        if (entry.isDirectory()) {
          folders.add(relativePath);
          await walk(absolutePath);
          return;
        }

        if (!entry.isFile()) {
          return;
        }

        let fileStats;
        try {
          fileStats = await stat(absolutePath);
        } catch (error) {
          if (isSkippableScanError(error)) {
            return;
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
          dependencies.push(...(await parseManifestFile(projectRootHostPath, relativePath)));
        }
      })
    );
  };

  await walk(projectRootHostPath);

  const entryPoints = findEntryPoints(files);
  const totalFiles = files.length + excludedFiles;
  const totalFolders = folders.size + excludedFolders;
  const totalSizeBytes = includedSizeBytes + excludedSizeBytes;
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
    explanation: summarizeProjectPurpose([...manifestFiles], entryPoints, languageBreakdown)
  };

  const treeHash = sha256(stableStringify(files.map((file) => [file.relativePath, file.size])));
  const manifestHash = sha256(stableStringify(dependencies));

  return {
    kind: gitMetadata.isGit ? "git" : "folder",
    tree: toTree(files),
    files,
    stats,
    dependencies: dependencies.sort((left, right) => `${left.manifest}:${left.name}`.localeCompare(`${right.manifest}:${right.name}`)),
    manifestHash,
    treeHash
  };
};
