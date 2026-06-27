import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type {
  ProjectEvidenceCommand,
  ProjectKind,
  ValidationCommandPhase,
  ValidationCommandResult
} from "@shared/types";
import { unique } from "@shared/utils";

export interface TargetProjectResolvedCommand {
  name: string;
  command: string;
  phase: ValidationCommandPhase;
  kind: "test" | "evidence";
  expectedOutput?: ProjectEvidenceCommand["expectedOutput"];
  approvalRequired: boolean;
  skipReason?: string;
  mapsToCheckIds: string[];
  relatedFiles: string[];
}

export interface TargetProjectCommandResolution {
  testCommands: TargetProjectResolvedCommand[];
  evidenceCommands: TargetProjectResolvedCommand[];
  skippedEvidenceCommands: TargetProjectResolvedCommand[];
  warnings: string[];
}

export interface TargetProjectCommandResolverInput {
  projectRoot: string;
  projectKind: ProjectKind;
  evidenceCommands?: ProjectEvidenceCommand[];
  previousCommandResults?: ValidationCommandResult[];
}

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
};

const readOptionalText = async (filePath: string): Promise<string> => {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
};

const listPythonTestFiles = async (projectRoot: string): Promise<string[]> => {
  const testsRoot = path.join(projectRoot, "tests");
  try {
    const entries = await readdir(testsRoot, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /^test.*\.py$|.*_test\.py$|.*\.py$/i.test(entry.name))
      .map((entry) => path.posix.join("tests", entry.name));
  } catch {
    return [];
  }
};

const hasSrcLayout = async (projectRoot: string): Promise<boolean> => {
  const srcRoot = path.join(projectRoot, "src");
  try {
    const entries = await readdir(srcRoot, { withFileTypes: true });
    return entries.some((entry) => entry.isDirectory() || entry.name.endsWith(".py"));
  } catch {
    return false;
  }
};

const parsePackageScripts = async (projectRoot: string): Promise<Record<string, string>> => {
  const text = await readOptionalText(path.join(projectRoot, "package.json"));
  if (!text) {
    return {};
  }
  try {
    const parsed = JSON.parse(text) as { scripts?: Record<string, string> };
    return parsed.scripts ?? {};
  } catch {
    return {};
  }
};

const pythonManifestText = async (projectRoot: string): Promise<string> =>
  [
    await readOptionalText(path.join(projectRoot, "pyproject.toml")),
    await readOptionalText(path.join(projectRoot, "requirements.txt")),
    await readOptionalText(path.join(projectRoot, "requirements-dev.txt")),
    await readOptionalText(path.join(projectRoot, "setup.cfg")),
    await readOptionalText(path.join(projectRoot, "tox.ini")),
    await readOptionalText(path.join(projectRoot, "README.md"))
  ].join("\n");

const pythonProjectLikely = async (projectRoot: string): Promise<boolean> => {
  if (await exists(path.join(projectRoot, "pyproject.toml"))) {
    return true;
  }
  if (await exists(path.join(projectRoot, "requirements.txt"))) {
    return true;
  }
  if (await exists(path.join(projectRoot, "setup.py"))) {
    return true;
  }
  if ((await listPythonTestFiles(projectRoot)).length > 0) {
    return true;
  }
  return await hasSrcLayout(projectRoot);
};

const commandWithPythonDefaults = (command: string, srcLayout: boolean): string => {
  const env: string[] = [];
  if (!/\bPYTHONDONTWRITEBYTECODE=/.test(command)) {
    env.push("PYTHONDONTWRITEBYTECODE=1");
  }
  if (srcLayout && !/\bPYTHONPATH=/.test(command)) {
    env.push("PYTHONPATH=src");
  }
  return [...env, command].join(" ").trim();
};

const hasPreviousPytestSuccess = (results: ValidationCommandResult[] = []): boolean =>
  results.some((result) => result.status === "passed" && /\bpytest\b/i.test(result.command));

const hasPreviousPythonCommandNotFound = (results: ValidationCommandResult[] = []): boolean =>
  results.some((result) =>
    /\bpython\b(?!3)/i.test(result.command) &&
    result.classifiedFailure?.kind === "environment_toolchain"
  );

const evidenceCommandApprovalReason = (command: ProjectEvidenceCommand): string | undefined => {
  const text = command.command;
  if (command.requiresCredentials || /\b(?:api[_-]?key|token|secret|credential|oauth|login|account|password)\b/i.test(text)) {
    return "Evidence command requires credentials or an account-specific flow.";
  }
  if (command.requiresNetwork || /\b(?:curl|wget|--live-http|browser|playwright|remote|deploy)\b/i.test(text)) {
    return "Evidence command uses live network or browser access.";
  }
  if (/\b(?:rm\s+-rf|git\s+push|git\s+reset|sudo|dd\s+|mkfs|paid|billing)\b/i.test(text)) {
    return "Evidence command is destructive, privileged, or paid-provider related.";
  }
  if (!command.safeDefault) {
    return "Evidence command is not marked safe by the project evidence model.";
  }
  return undefined;
};

export const resolveEvidenceCommandsForExecution = async (
  projectRoot: string,
  evidenceCommands: ProjectEvidenceCommand[] = []
): Promise<{ runnable: TargetProjectResolvedCommand[]; skipped: TargetProjectResolvedCommand[] }> => {
  const srcLayout = await hasSrcLayout(projectRoot);
  const resolved = evidenceCommands.map((command): TargetProjectResolvedCommand => {
    const skipReason = evidenceCommandApprovalReason(command);
    const resolvedCommand = /^python3?\b/.test(command.command) || /\s+python3?\b/.test(command.command)
      ? commandWithPythonDefaults(command.command, srcLayout)
      : command.command;
    return {
      name: command.name,
      command: resolvedCommand,
      phase: "evidence",
      kind: "evidence",
      expectedOutput: command.expectedOutput,
      approvalRequired: Boolean(skipReason),
      skipReason,
      mapsToCheckIds: command.mapsToCheckIds,
      relatedFiles: []
    };
  });
  return {
    runnable: resolved.filter((command) => !command.approvalRequired).slice(0, 8),
    skipped: resolved.filter((command) => command.approvalRequired).slice(0, 12)
  };
};

export const resolveTargetProjectCommands = async (
  input: TargetProjectCommandResolverInput
): Promise<TargetProjectCommandResolution> => {
  const warnings: string[] = [];
  const testCommands: TargetProjectResolvedCommand[] = [];
  const scripts = await parsePackageScripts(input.projectRoot);
  for (const name of ["lint", "typecheck", "test", "build"]) {
    if (scripts[name]) {
      testCommands.push({
        name,
        command: name === "test" ? "npm test" : `npm run ${name}`,
        phase: "integrity",
        kind: "test",
        approvalRequired: false,
        mapsToCheckIds: [],
        relatedFiles: ["package.json"]
      });
    }
  }

  if (await pythonProjectLikely(input.projectRoot)) {
    const manifest = await pythonManifestText(input.projectRoot);
    const srcLayout = await hasSrcLayout(input.projectRoot);
    const testFiles = await listPythonTestFiles(input.projectRoot);
    const pytestDeclared =
      /\bpytest\b|\[tool\.pytest/i.test(manifest) ||
      hasPreviousPytestSuccess(input.previousCommandResults);
    const readmeRequiresPytest = /(?:run|use|required?|with)\s+pytest|python3?\s+-m\s+pytest/i.test(manifest);
    const pythonExecutable = hasPreviousPythonCommandNotFound(input.previousCommandResults) ? "python3" : "python3";
    if (hasPreviousPythonCommandNotFound(input.previousCommandResults)) {
      warnings.push("python was unavailable previously; using python3 for project validation.");
    }
    if (pytestDeclared || readmeRequiresPytest) {
      testCommands.push({
        name: "pytest",
        command: commandWithPythonDefaults(`${pythonExecutable} -m pytest`, srcLayout),
        phase: "integrity",
        kind: "test",
        approvalRequired: false,
        mapsToCheckIds: [],
        relatedFiles: ["pyproject.toml", "requirements.txt", "tests/"]
      });
    } else if (testFiles.length > 0) {
      testCommands.push({
        name: "unittest",
        command: commandWithPythonDefaults(`${pythonExecutable} -m unittest discover -s tests -q`, srcLayout),
        phase: "integrity",
        kind: "test",
        approvalRequired: false,
        mapsToCheckIds: [],
        relatedFiles: ["tests/"]
      });
    }
  }

  const evidence = await resolveEvidenceCommandsForExecution(input.projectRoot, input.evidenceCommands);
  const dedupedTests = unique(testCommands.map((command) => command.command))
    .map((command) => testCommands.find((entry) => entry.command === command)!)
    .slice(0, 8);
  const testCommandSet = new Set(dedupedTests.map((command) => command.command));
  return {
    testCommands: dedupedTests,
    evidenceCommands: evidence.runnable.filter((command) => !testCommandSet.has(command.command)),
    skippedEvidenceCommands: evidence.skipped.filter((command) => !testCommandSet.has(command.command)),
    warnings
  };
};
