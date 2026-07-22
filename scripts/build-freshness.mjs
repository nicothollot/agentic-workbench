import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const buildInputPaths = [
  "assets/branding",
  "index.html",
  "package-lock.json",
  "package.json",
  "src/generated",
  "src/main",
  "src/preload",
  "src/renderer",
  "src/runtime",
  "src/shared",
  "tsconfig.base.json",
  "tsconfig.electron.json",
  "tsconfig.json",
  "vite.config.ts",
  "vite.main.config.ts",
  "vite.preload.config.ts",
  "vite.shared-electron.ts"
];

export const requiredBuildOutputs = [
  "dist/index.html",
  "dist-electron/main/index.cjs",
  "dist-electron/preload/index.cjs"
];

const collectFiles = async (entryPath) => {
  let entry;
  try {
    entry = await stat(entryPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  if (entry.isFile()) {
    return [{ path: entryPath, mtimeMs: entry.mtimeMs }];
  }
  if (!entry.isDirectory()) {
    return [];
  }

  const children = await readdir(entryPath, { withFileTypes: true });
  const nested = await Promise.all(children.map((child) => collectFiles(path.join(entryPath, child.name))));
  return nested.flat();
};

const relative = (rootDir, filePath) => path.relative(rootDir, filePath) || ".";

export const inspectBuildFreshness = async ({
  rootDir = repositoryRoot,
  inputPaths = buildInputPaths,
  outputPaths = requiredBuildOutputs
} = {}) => {
  const outputs = [];
  for (const outputPath of outputPaths) {
    const absolutePath = path.resolve(rootDir, outputPath);
    try {
      const details = await stat(absolutePath);
      if (!details.isFile() || details.size === 0) {
        return {
          fresh: false,
          reason: `${relative(rootDir, absolutePath)} is empty or not a file.`
        };
      }
      outputs.push({ path: absolutePath, mtimeMs: details.mtimeMs });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return {
          fresh: false,
          reason: `${relative(rootDir, absolutePath)} is missing.`
        };
      }
      throw error;
    }
  }

  const inputs = (await Promise.all(
    inputPaths.map((inputPath) => collectFiles(path.resolve(rootDir, inputPath)))
  )).flat();

  if (inputs.length === 0) {
    return { fresh: false, reason: "No build inputs were found." };
  }

  const newestInput = inputs.reduce((newest, candidate) =>
    candidate.mtimeMs > newest.mtimeMs ? candidate : newest
  );
  const oldestOutput = outputs.reduce((oldest, candidate) =>
    candidate.mtimeMs < oldest.mtimeMs ? candidate : oldest
  );

  if (newestInput.mtimeMs > oldestOutput.mtimeMs) {
    return {
      fresh: false,
      reason: `${relative(rootDir, newestInput.path)} is newer than ${relative(rootDir, oldestOutput.path)}.`
    };
  }

  return { fresh: true, reason: "Compiled renderer, main, and preload assets are current." };
};
