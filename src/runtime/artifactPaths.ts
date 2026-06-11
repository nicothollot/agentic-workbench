import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { PORTABLE_INTERFACE_PATH } from "@shared/constants";

export type ProjectArtifactKind = "portable-interface" | "review-log" | "visual-export";

export class ArtifactDestinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactDestinationError";
  }
}

export const safeArtifactFileStem = (value: string): string => {
  const normalized = value.trim().replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
  return normalized || "project";
};

export const timestampForArtifactName = (date = new Date()): string =>
  date.toISOString().replace(/[:.]/g, "-");

export const defaultPortableInterfacePath = (projectRoot: string): string =>
  path.join(projectRoot, PORTABLE_INTERFACE_PATH);

export const defaultReviewLogPath = (projectRoot: string, projectName: string, date = new Date()): string =>
  path.join(
    projectRoot,
    ".agent-workbench",
    "review-logs",
    `${safeArtifactFileStem(projectName)}-review-log-${timestampForArtifactName(date)}.json`
  );

export const defaultVisualExportPath = (projectRoot: string, projectName: string, date = new Date()): string =>
  path.join(
    projectRoot,
    ".agent-workbench",
    "visuals",
    `${safeArtifactFileStem(projectName)}-interface-visuals-${timestampForArtifactName(date)}.pdf`
  );

export const isPathInsideOrEqual = (parentPath: string, childPath: string): boolean => {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const readPackageName = (directory: string): string | undefined => {
  const packagePath = path.join(directory, "package.json");
  if (!existsSync(packagePath)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: unknown };
    return typeof parsed.name === "string" ? parsed.name : undefined;
  } catch {
    return undefined;
  }
};

export const findAgenticWorkbenchSourceRoot = (startPath = process.cwd()): string | undefined => {
  let current = path.resolve(startPath);
  if (path.extname(current)) {
    current = path.dirname(current);
  }

  while (true) {
    if (readPackageName(current) === "codex-agent-workbench") {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
};

export const resolveArtifactDestination = (
  projectRoot: string,
  destinationPath: string | undefined,
  defaultPath: string
): string => {
  if (!destinationPath) {
    return defaultPath;
  }

  return path.isAbsolute(destinationPath)
    ? path.resolve(destinationPath)
    : path.resolve(projectRoot, destinationPath);
};

export const assertSafeArtifactDestination = ({
  projectRoot,
  destinationPath,
  artifactKind,
  appSourceRoot
}: {
  projectRoot: string;
  destinationPath: string;
  artifactKind: ProjectArtifactKind;
  appSourceRoot?: string;
}): string => {
  const resolvedDestination = path.resolve(destinationPath);
  const resolvedProjectRoot = path.resolve(projectRoot);
  const detectedAppRoot = appSourceRoot
    ?? findAgenticWorkbenchSourceRoot(path.dirname(resolvedDestination))
    ?? findAgenticWorkbenchSourceRoot();

  if (
    detectedAppRoot &&
    isPathInsideOrEqual(detectedAppRoot, resolvedDestination) &&
    !isPathInsideOrEqual(resolvedProjectRoot, resolvedDestination)
  ) {
    throw new ArtifactDestinationError(
      `Refusing to write ${artifactKind.replace(/-/g, " ")} into the Agentic Workbench source repository. ` +
      "Use the target project's .agent-workbench directory or choose an explicit non-repository export location."
    );
  }

  return resolvedDestination;
};
