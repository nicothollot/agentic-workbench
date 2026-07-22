import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { AppSettings } from "@shared/types";
import { RuntimeCommandExecutor } from "./execution";
import { readGitMetadata } from "./git";
import { scanRepository } from "./repoScanner";

type RuntimeSettings = Pick<AppSettings, "executionMode" | "distroName">;

const GIT_STATUS_LIMIT_BYTES = 2 * 1024 * 1024;
const GIT_DIFF_LIMIT_BYTES = 16 * 1024 * 1024;
const MAX_UNTRACKED_FILES = 1_000;
const MAX_UNTRACKED_PATH_BYTES = 256 * 1024;
const MAX_IGNORED_ENV_FILES = 200;
const MAX_FOLDER_CONTENT_BYTES = 128 * 1024 * 1024;

const hashParts = (parts: Array<string | Buffer>): string => {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
  }
  return hash.digest("hex");
};

export const parseUntrackedStatusPaths = (status: string): string[] =>
  status
    .split("\0")
    .filter((entry) => entry.startsWith("?? "))
    .map((entry) => entry.slice(3));

const hashGitPaths = async (
  executor: RuntimeCommandExecutor,
  projectRoot: string,
  paths: string[],
  label: string
): Promise<Array<[string, string]>> => {
  const hashesByPath: Array<[string, string]> = [];
  for (let offset = 0; offset < paths.length; offset += 100) {
    const batch = paths.slice(offset, offset + 100);
    const output = (await executor.execStructuredCommand({
      command: "git",
      args: ["hash-object", "--no-filters", "--", ...batch],
      cwd: projectRoot,
      maxOutputBytes: 256 * 1024
    })).stdout.trim();
    const hashes = output ? output.split(/\r?\n/) : [];
    if (hashes.length !== batch.length || hashes.some((entry) => !/^[a-f0-9]{40,64}$/i.test(entry))) {
      throw new Error(`Git could not produce a complete content fingerprint for the ${label}.`);
    }
    batch.forEach((filePath, index) => hashesByPath.push([filePath, hashes[index]]));
  }
  return hashesByPath;
};

const fingerprintGitContents = async (
  projectRoot: string,
  head: string,
  runtimeSettings: RuntimeSettings
): Promise<string> => {
  const executor = new RuntimeCommandExecutor(runtimeSettings);
  const status = (await executor.execStructuredCommand({
    command: "git",
    args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    cwd: projectRoot,
    maxOutputBytes: GIT_STATUS_LIMIT_BYTES
  })).stdout;

  const untrackedPaths = parseUntrackedStatusPaths(status);
  const pathBytes = untrackedPaths.reduce((total, entry) => total + Buffer.byteLength(entry), 0);
  if (untrackedPaths.length > MAX_UNTRACKED_FILES || pathBytes > MAX_UNTRACKED_PATH_BYTES) {
    throw new Error(
      "The dirty working tree is too large to bind safely to a browser report. Commit or reduce the untracked files, then retry Preview."
    );
  }

  // Environment files are commonly ignored by Git but can materially alter a
  // preview or validation command. Hash only their bytes (never expose them)
  // so an old report/approval cannot be reused after a secret or flag changes.
  const ignoredEnvironmentOutput = (await executor.execStructuredCommand({
    command: "git",
    args: [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
      "--",
      ":(glob)**/.env",
      ":(glob)**/.env.*"
    ],
    cwd: projectRoot,
    maxOutputBytes: MAX_UNTRACKED_PATH_BYTES
  })).stdout;
  const ignoredEnvironmentPaths = ignoredEnvironmentOutput.split("\0").filter(Boolean).sort();
  const ignoredEnvironmentPathBytes = ignoredEnvironmentPaths.reduce(
    (total, entry) => total + Buffer.byteLength(entry),
    0
  );
  if (
    ignoredEnvironmentPaths.length > MAX_IGNORED_ENV_FILES ||
    ignoredEnvironmentPathBytes > MAX_UNTRACKED_PATH_BYTES
  ) {
    throw new Error("Too many ignored environment files exist to bind the checkout safely. Reduce them, then retry verification.");
  }
  if (!status && ignoredEnvironmentPaths.length === 0) {
    return head;
  }

  const diff = (await executor.execStructuredCommand({
    command: "git",
    args: ["diff", "--no-ext-diff", "--binary", "--no-color", "HEAD", "--"],
    cwd: projectRoot,
    maxOutputBytes: GIT_DIFF_LIMIT_BYTES
  })).stdout;
  const untrackedHashes = await hashGitPaths(executor, projectRoot, untrackedPaths, "untracked verification files");
  const ignoredEnvironmentHashes = await hashGitPaths(
    executor,
    projectRoot,
    ignoredEnvironmentPaths,
    "ignored environment files"
  );

  return `${head}:dirty:${hashParts([
    status,
    "\0DIFF\0",
    diff,
    "\0UNTRACKED\0",
    JSON.stringify(untrackedHashes),
    "\0IGNORED_ENVIRONMENT\0",
    JSON.stringify(ignoredEnvironmentHashes)
  ])}`;
};

const fingerprintFolderContents = async (
  projectRoot: string,
  projectHostPath: string
): Promise<string> => {
  const scan = await scanRepository(
    projectHostPath,
    { isGit: false, normalizedRemotes: [] },
    projectRoot
  );
  if (scan.stats.truncated) {
    throw new Error(
      `The folder is too large to bind safely to a content-bound report (${scan.stats.truncationReason ?? "repository scan limit reached"}).`
    );
  }
  if (scan.stats.includedSizeBytes > MAX_FOLDER_CONTENT_BYTES) {
    throw new Error("The folder source exceeds the 128 MB content-verification limit.");
  }

  const hash = createHash("sha256");
  for (const file of [...scan.files].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    const before = await stat(file.absolutePath);
    const bytes = await readFile(file.absolutePath);
    const after = await stat(file.absolutePath);
    if (
      !before.isFile() ||
      !after.isFile() ||
      before.size !== bytes.byteLength ||
      after.size !== bytes.byteLength ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new Error(`The source changed while it was being fingerprinted: ${file.relativePath}`);
    }
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return `folder:${hash.digest("hex")}`;
};

export const resolveContentBoundPreviewRevision = async (input: {
  projectRoot: string;
  projectHostPath: string;
  runtimeSettings: RuntimeSettings;
}): Promise<string> => {
  const metadata = await readGitMetadata(input.projectRoot, input.runtimeSettings);
  if (metadata.isGit && metadata.head) {
    return await fingerprintGitContents(input.projectRoot, metadata.head, input.runtimeSettings);
  }
  return await fingerprintFolderContents(input.projectRoot, input.projectHostPath);
};
