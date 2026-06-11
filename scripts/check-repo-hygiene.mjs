#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";

export const LARGE_FILE_LIMIT_BYTES = 5 * 1024 * 1024;

const allowedLargeExactPaths = new Set([
  "CATC_Brand_Kit.pdf",
  "package-lock.json"
]);

const allowedLargePrefixes = [
  "assets/branding/",
  "src/generated/app-server/"
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
  const issues = analyzeTrackedFiles(files);
  if (issues.length > 0) {
    const lines = [
      "Repository hygiene check failed.",
      "Tracked target-project/generated artifacts must not live in the Agentic Workbench source repository:",
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
