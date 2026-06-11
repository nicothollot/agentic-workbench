#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

export const LARGE_FILE_LIMIT_BYTES = 5 * 1024 * 1024;
export const GITIGNORE_MIN_LINE_COUNT = 20;

const allowedLargeExactPaths = new Set([
  "CATC_Brand_Kit.pdf",
  "package-lock.json"
]);

const allowedLargePrefixes = [
  "assets/branding/",
  "src/generated/app-server/"
];

const requiredGitignorePatterns = [
  "node_modules/",
  "*-review-log-*.json",
  "*review-log*.json",
  "*-interface-visuals-*.pdf",
  "*-repair-report-*.md",
  "*repair-report*.md",
  "*-interface.json",
  "*_interface.json",
  ".agent-workbench/",
  "agent-transcripts/",
  "agent-outputs/"
];

export const gitignoreArtifactSamples = [
  "quant_interview_prep-review-log-2026-06-10T17-53-57-596Z.json",
  "quant_interview_prep-interface.json",
  "quant_interview_prep-interface-visuals-2026-06-10T17-54-19-586Z.pdf",
  "quant-interview-prep-cycle-2-repair-report-2026-05-07T20-46-41-218Z.md",
  ".agent-workbench/interface.json",
  "agent-outputs/coding-agent.txt"
];

const normalizePath = (filePath) => filePath.replace(/\\/g, "/").replace(/^\.\//, "");

const isRootFile = (filePath) => !normalizePath(filePath).includes("/");

const baseName = (filePath) => {
  const normalized = normalizePath(filePath);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
};

const matchesRootArtifactName = (filePath) => {
  if (!isRootFile(filePath)) {
    return false;
  }

  const name = baseName(filePath);
  return [
    /^quant[-_]interview[-_]prep/i,
    /^Master_Trading_Interface-review-log-/i,
    /review-log.*\.json$/i,
    /interface-visuals.*\.pdf$/i,
    /visuals.*\.pdf$/i,
    /repair-report.*\.md$/i,
    /-interface\.json$/i,
    /_interface\.json$/i
  ].some((pattern) => pattern.test(name));
};

const matchesForbiddenArtifactPath = (filePath) => {
  const normalized = normalizePath(filePath);
  return [
    ".agent-workbench/",
    ".codex/",
    "agent-transcripts/",
    "agent-outputs/",
    "workflow-history/",
    "visual-audits/",
    "exports/"
  ].some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix));
};

const isAllowedLargeFile = (filePath) => {
  const normalized = normalizePath(filePath);
  return allowedLargeExactPaths.has(normalized) || allowedLargePrefixes.some((prefix) => normalized.startsWith(prefix));
};

const parseCheckIgnoreOutput = (output) => new Set(
  output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const tabIndex = line.lastIndexOf("\t");
      return tabIndex === -1 ? line.trim() : line.slice(tabIndex + 1).trim();
    })
);

export const analyzeTrackedFiles = (
  files,
  options = {}
) => {
  const largeFileLimitBytes = options.largeFileLimitBytes ?? LARGE_FILE_LIMIT_BYTES;
  const issues = [];

  for (const file of files) {
    const path = normalizePath(typeof file === "string" ? file : file.path);
    const sizeBytes = typeof file === "string" ? undefined : file.sizeBytes;

    if (matchesRootArtifactName(path)) {
      issues.push({
        path,
        reason: "root target-project generated artifact"
      });
    }

    if (matchesForbiddenArtifactPath(path)) {
      issues.push({
        path,
        reason: "tracked Workbench runtime/output directory"
      });
    }

    if (
      typeof sizeBytes === "number" &&
      sizeBytes > largeFileLimitBytes &&
      !isAllowedLargeFile(path)
    ) {
      issues.push({
        path,
        reason: `unexpectedly large tracked file (${sizeBytes} bytes)`
      });
    }
  }

  return issues;
};

export const analyzeGitignoreContent = (content) => {
  const lines = content.split(/\r?\n/);
  const populatedLines = new Set(lines.map((line) => line.trim()).filter(Boolean));
  const issues = [];

  if (lines.length <= GITIGNORE_MIN_LINE_COUNT) {
    issues.push({
      path: ".gitignore",
      reason: `expected more than ${GITIGNORE_MIN_LINE_COUNT} newline-separated lines, found ${lines.length}`
    });
  }

  if (!content.includes("\nnode_modules/")) {
    issues.push({
      path: ".gitignore",
      reason: "node_modules/ must be on its own newline, not folded into the Dependencies comment"
    });
  }

  const missingPatterns = requiredGitignorePatterns.filter((pattern) => !populatedLines.has(pattern));
  if (missingPatterns.length > 0) {
    issues.push({
      path: ".gitignore",
      reason: `missing required generated-artifact ignore patterns: ${missingPatterns.join(", ")}`
    });
  }

  return issues;
};

export const getGitignoreIssues = () => {
  let content = "";
  try {
    content = readFileSync(".gitignore", "utf8");
  } catch (error) {
    return [{
      path: ".gitignore",
      reason: `unable to read .gitignore: ${error instanceof Error ? error.message : String(error)}`
    }];
  }

  const issues = analyzeGitignoreContent(content);
  const result = spawnSync("git", ["check-ignore", "--no-index", "-v", ...gitignoreArtifactSamples], { encoding: "utf8" });

  if (result.status === null && result.error) {
    issues.push({
      path: ".gitignore",
      reason: `unable to run git check-ignore: ${result.error.message}`
    });
    return issues;
  }

  if (typeof result.status === "number" && result.status > 1) {
    issues.push({
      path: ".gitignore",
      reason: result.stderr.trim() || "git check-ignore failed"
    });
    return issues;
  }

  const ignoredPaths = parseCheckIgnoreOutput(result.stdout);
  for (const sample of gitignoreArtifactSamples) {
    if (!ignoredPaths.has(sample)) {
      issues.push({
        path: sample,
        reason: "sample generated artifact is not ignored by .gitignore"
      });
    }
  }

  return issues;
};

export const getTrackedFiles = () => {
  const result = spawnSync("git", ["ls-files", "-z"], { encoding: "utf8" });
  if (result.status !== 0 || (!result.stdout && result.error)) {
    throw result.error ?? new Error(result.stderr || "git ls-files failed.");
  }
  const output = result.stdout;
  return output
    .split("\0")
    .filter(Boolean)
    .map((path) => {
      let sizeBytes = 0;
      try {
        sizeBytes = statSync(path).size;
      } catch {
        sizeBytes = 0;
      }
      return { path, sizeBytes };
    });
};

export const runRepoHygieneCheck = (files = getTrackedFiles()) => {
  const issues = [
    ...analyzeTrackedFiles(files),
    ...getGitignoreIssues()
  ];
  if (issues.length > 0) {
    const lines = [
      "Repository hygiene check failed.",
      "Fix these tracked artifact, ignore-rule, or large-file issues before committing:",
      ...issues.map((issue) => `- ${issue.path}: ${issue.reason}`)
    ];
    return {
      ok: false,
      message: lines.join("\n"),
      issues
    };
  }

  return {
    ok: true,
    message: "Repository hygiene check passed.",
    issues
  };
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = runRepoHygieneCheck();
  if (!result.ok) {
    console.error(result.message);
    process.exitCode = 1;
  } else {
    console.log(result.message);
  }
}
