import { execFile, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PROJECT_SHELL_HANDOFF_PATH,
  PROJECT_SHELL_LAUNCHER_CMD_PATH,
  PROJECT_SHELL_LAUNCHER_SCRIPT_PATH,
  PROJECT_SHELL_LAUNCH_LOG_PATH
} from "@shared/constants";
import type {
  AppSettings,
  ChecklistDelta,
  CycleContract,
  HumanInterventionRecord,
  OpenProjectShellResult,
  RepoHygieneReport,
  UserInputRequestRecord,
  ValidationLedger,
  WorkflowManualHandoff
} from "@shared/types";
import { RuntimeCommandExecutor } from "./execution";

export interface ProjectShellLaunchPlan {
  executable: string;
  args: string[];
  commandPreview: string;
  cwd?: string;
  windowsHide?: boolean;
}

export interface ProjectShellPromptContext {
  projectName: string;
  projectRoot: string;
  manualHandoff?: Pick<
    WorkflowManualHandoff,
    "reason" | "title" | "whatSystemWasTryingToDo" | "validationIssue" | "latestFailureReason" | "involvedPaths"
  >;
  pendingUserInputRequests: Array<
    Pick<UserInputRequestRecord, "title" | "description" | "attachmentInboxRelativePath"> & {
      attachments: Array<{ relativePath: string }>;
      questions: Array<Pick<UserInputRequestRecord["questions"][number], "header" | "question" | "isSecret">>;
    }
  >;
  pendingHumanInterventions: Array<Pick<HumanInterventionRecord, "title" | "description" | "severity">>;
}

export interface WorkflowRepairAgentPromptContext {
  agentRoleIntro?: string;
  projectName: string;
  projectRoot: string;
  branchOrPath: string;
  statusLabel: string;
  technicalStage: string;
  activeAgent: string;
  currentPhase: string;
  currentFocus: string;
  nextOperatorAction: string;
  cycleNumber: number;
  cycleContract?: CycleContract;
  checklistDelta?: ChecklistDelta;
  validationLedger?: ValidationLedger;
  repoHygieneReport?: RepoHygieneReport;
  changedFiles: string[];
  recentAgentMessages: string[];
  pendingApprovals: number;
}

export interface OpenProjectShellWindowRequest {
  projectName: string;
  projectRoot: string;
  projectHostPath: string;
  prompt: string;
  settings: Pick<AppSettings, "executionMode" | "distroName" | "codexBinaryPath" | "codexHome">;
}

type ExecFileProcess = typeof execFile;

const quoteForPowerShell = (value: string): string => `'${value.replace(/'/g, "''")}'`;

const quoteForBashSingle = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;

const quoteForCmd = (value: string): string => `"${value}"`;

const resolveWindowsCommandInterpreter = (): string =>
  process.env.ComSpec ?? (process.env.SystemRoot ? path.win32.join(process.env.SystemRoot, "System32", "cmd.exe") : "cmd.exe");

const resolveWindowsPowerShellExecutable = (): string =>
  process.env.SystemRoot
    ? path.win32.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";

const resolveWindowsWslExecutable = (): string =>
  process.env.SystemRoot
    ? path.win32.join(process.env.SystemRoot, "System32", "wsl.exe")
    : "wsl.exe";

const toHostPath = (projectHostPath: string, relativePath: string): string =>
  path.join(projectHostPath, ...relativePath.split("/"));

const toExecutionPath = (projectRoot: string, relativePath: string): string =>
  path.posix.join(projectRoot, relativePath);

const buildProjectShellWindowTitle = (projectName: string): string => `Codex Handoff - ${projectName}`;

const formatLauncherFailure = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const WSL_UNC_PREFIX = /^\\\\wsl(?:\.localhost)?\\([^\\]+)(?:\\|$)/i;

const normalizeWslDistroName = (value?: string): string | undefined => {
  const trimmed = value?.trim().replace(/^['"]+|['"]+$/g, "");
  return trimmed ? trimmed : undefined;
};

const parseWslDistributionList = (stdout: string): string[] =>
  stdout
    .split("\u0000").join("")
    .split(/\r?\n/)
    .map((line) => normalizeWslDistroName(line))
    .filter((line): line is string => Boolean(line));

const deriveWslDistroFromPath = (inputPath?: string): string | undefined => {
  const match = inputPath?.trim().match(WSL_UNC_PREFIX);
  return normalizeWslDistroName(match?.[1]);
};

const findMatchingWslDistro = (availableDistros: string[], candidate?: string): string | undefined => {
  const normalizedCandidate = normalizeWslDistroName(candidate);
  if (!normalizedCandidate) {
    return undefined;
  }

  return availableDistros.find((entry) => entry === normalizedCandidate)
    ?? availableDistros.find((entry) => entry.localeCompare(normalizedCandidate, undefined, { sensitivity: "accent" }) === 0);
};

const listWindowsWslDistros = async (
  execFileProcess: ExecFileProcess
): Promise<string[]> => await new Promise((resolve, reject) => {
  execFileProcess("wsl.exe", ["--list", "--quiet"], { encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
    if (error) {
      const failure = Object.assign(new Error(error.message), { stdout, stderr, code: "code" in error ? error.code : undefined });
      reject(failure);
      return;
    }
    resolve(parseWslDistributionList(stdout));
  });
});

const resolveWindowsProjectShellDistroName = async (
  request: OpenProjectShellWindowRequest,
  execFileProcess: ExecFileProcess
): Promise<string | undefined> => {
  const configuredDistroName = normalizeWslDistroName(request.settings.distroName);
  const pathCandidates = [
    deriveWslDistroFromPath(request.projectHostPath),
    deriveWslDistroFromPath(process.execPath),
    deriveWslDistroFromPath(process.cwd())
  ];

  try {
    const availableDistros = await listWindowsWslDistros(execFileProcess);
    if (availableDistros.length === 0) {
      return configuredDistroName;
    }

    for (const candidate of [configuredDistroName, ...pathCandidates]) {
      const matched = findMatchingWslDistro(availableDistros, candidate);
      if (matched) {
        return matched;
      }
    }

    if (availableDistros.length === 1) {
      return availableDistros[0];
    }

    return undefined;
  } catch {
    return configuredDistroName;
  }
};

export const buildProjectShellHandoffPrompt = (context: ProjectShellPromptContext): string => {
  const lines = [
    "You are taking over a paused Codex Agent Workbench workflow inside this repository.",
    `Project: ${context.projectName}`,
    `Working root: ${context.projectRoot}`,
    ""
  ];

  if (context.manualHandoff) {
    lines.push(
      "Current workflow blocker:",
      `- Title: ${context.manualHandoff.title}`,
      `- What the system was trying to do: ${context.manualHandoff.whatSystemWasTryingToDo}`,
      `- Validation issue: ${context.manualHandoff.validationIssue}`,
      `- Latest failure reason: ${context.manualHandoff.latestFailureReason}`
    );
    if (context.manualHandoff.involvedPaths.length > 0) {
      lines.push(
        "- Involved paths:",
        ...context.manualHandoff.involvedPaths.map((entry) => `  - ${entry}`)
      );
    }
    if (context.manualHandoff.reason === "merge_conflicts") {
      lines.push(
        "- Merge conflict recovery:",
        "  - Inspect the conflicting paths and resolve the intended final contents in the repository.",
        "  - Run the project's relevant validation commands after resolving the files.",
        "  - Commit the resolved state if Git has staged or unstaged conflict-resolution changes.",
        "  - Tell the user to return to Workbench and press Retry merge."
      );
    }
    lines.push("");
  }

  if (context.pendingUserInputRequests.length > 0) {
    lines.push("Pending user input requests:");
    for (const request of context.pendingUserInputRequests) {
      lines.push(
        `- ${request.title}: ${request.description}`,
        `  - Attachment inbox: ${request.attachmentInboxRelativePath}`
      );
      if (request.questions.length > 0) {
        lines.push(...request.questions.map((question) =>
          `  - ${question.header}${question.isSecret ? " [secret]" : ""}: ${question.question}`
        ));
      }
      if (request.attachments.length > 0) {
        lines.push(...request.attachments.map((attachment) => `  - Existing attachment: ${attachment.relativePath}`));
      }
    }
    lines.push("");
  }

  if (context.pendingHumanInterventions.length > 0) {
    lines.push("Other pending human blockers:");
    for (const intervention of context.pendingHumanInterventions) {
      lines.push(`- [${intervention.severity}] ${intervention.title}: ${intervention.description}`);
    }
    lines.push("");
  }

  lines.push(
    "Instructions for this handoff:",
    "- Start by summarizing the blocker and the safest next move for the user.",
    "- If user action is still required, ask for it one step at a time and keep the checklist explicit.",
    "- If you can continue by inspecting the repo or running commands, do that from this project root.",
    "- Treat files under .agent-workbench/input-requests as user-provided context unless the user asks to copy them into project files.",
    "- Stay focused on getting the paused workflow unstuck."
  );

  return `${lines.join("\n").trim()}\n`;
};

const pushSection = (lines: string[], title: string, values: string[]): void => {
  const cleaned = values.map((entry) => entry.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    return;
  }
  lines.push(title, ...cleaned, "");
};

const bulletList = (values: string[], maxItems = 12): string[] =>
  values.slice(0, maxItems).map((entry) => `- ${entry}`);

export const buildWorkflowRepairAgentPrompt = (context: WorkflowRepairAgentPromptContext): string => {
  const contract = context.cycleContract;
  const ledger = context.validationLedger;
  const hygiene = context.repoHygieneReport;
  const delta = context.checklistDelta;
  const failedCommands = ledger?.commandResults
    .filter((result) => result.status !== "passed" && result.status !== "skipped")
    .slice(0, 8)
    .map((result) => {
      const failure = result.classifiedFailure?.summary ?? (result.stderrSummary || result.stdoutSummary || "failed");
      return `${result.command} -> ${result.status}: ${failure}`;
    }) ?? [];

  const lines = [
    context.agentRoleIntro ?? "You are a separate Codex CLI repair agent launched by Agentic Workbench.",
    "Your job is to repair the current workflow blocker in this repository, not to re-plan the project.",
    `Project: ${context.projectName}`,
    `Working root: ${context.projectRoot}`,
    `Branch/path: ${context.branchOrPath}`,
    "",
    "Current Workbench diagnosis:",
    `- Status: ${context.statusLabel}`,
    `- Stage: ${context.technicalStage}`,
    `- Active agent: ${context.activeAgent}`,
    `- Phase: ${context.currentPhase}`,
    `- Current focus: ${context.currentFocus}`,
    `- Next operator action: ${context.nextOperatorAction}`,
    `- Pending approvals: ${context.pendingApprovals}`,
    ""
  ];

  if (contract) {
    lines.push(
      "Cycle contract:",
      `- Cycle: ${context.cycleNumber}`,
      `- Objective: ${contract.concreteGoalForThisCycle || contract.plainEnglishObjective}`,
      `- Selected task: ${contract.selectedTaskTitle}`,
      `- Why selected: ${contract.whySelectedNow}`,
      ""
    );
    pushSection(lines, "Targeted checklist items:", contract.targetedChecklistItems.map((item) =>
      `- ${item.checkId}: ${item.title} [${item.currentStatus}] ${item.fullDescription}${item.acceptanceHint ? ` Acceptance hint: ${item.acceptanceHint}` : ""}`
    ));
    pushSection(lines, "Expected files or areas:", bulletList(contract.expectedFilesOrAreas, 16));
    pushSection(lines, "Expected evidence commands:", bulletList(contract.expectedEvidenceCommands, 10));
    pushSection(lines, "Expected validation commands:", bulletList(contract.expectedValidationCommands, 10));
    pushSection(lines, "Known cycle blockers:", bulletList(contract.currentKnownBlockers, 10));
    pushSection(lines, "Cycle failure modes to avoid:", bulletList(contract.failureModes, 10));
  }

  if (hygiene) {
    lines.push(
      "Repository hygiene:",
      `- Status: ${hygiene.status}`,
      `- Summary: ${hygiene.summaryForHumans}`
    );
    lines.push(...bulletList([
      ...hygiene.mergeBlockingFindings,
      ...hygiene.forbiddenFiles.map((entry) => `Forbidden changed path: ${entry}`),
      ...hygiene.warnings.map((entry) => `Warning: ${entry}`),
      ...hygiene.cleanedFiles.map((entry) => `Cleaned generated artifact: ${entry}`)
    ], 24));
    lines.push("");
  }

  if (ledger) {
    lines.push(
      "Validation ledger:",
      `- Final status: ${ledger.finalValidationStatus}`,
      `- Basis: ${ledger.finalValidationBasis}`,
      `- Merge allowed: ${ledger.mergeAllowed ? "yes" : "no"}`,
      `- Summary: ${ledger.summaryForHumans}`
    );
    pushSection(lines, "Merge-blocking validation reasons:", bulletList(ledger.mergeBlockedReasons, 14));
    pushSection(lines, "Unresolved validation failures:", bulletList(ledger.unresolvedValidationFailures, 14));
    pushSection(lines, "Failed command attempts:", bulletList(failedCommands, 8));
    pushSection(lines, "Repaired validation attempts:", bulletList(ledger.repairedFailures, 8));
  }

  if (delta) {
    lines.push(
      "Checklist delta:",
      `- ${delta.summaryForHumans}`,
      `- Evidence observed: ${delta.evidenceObservedCount}; consumed: ${delta.evidenceConsumedCount}; not consumed: ${delta.evidenceNotConsumedCount}`
    );
    pushSection(lines, "Targeted checks still unknown:", bulletList(delta.targetedStillUnknown, 14));
    pushSection(lines, "Why targeted checks remain unknown:", bulletList(
      Object.entries(delta.whyStillUnknownByCheckId).map(([checkId, reason]) => `${checkId}: ${reason}`),
      14
    ));
  }

  pushSection(lines, "Changed files seen by Workbench:", bulletList(context.changedFiles, 24));
  pushSection(lines, "Recent agent messages:", bulletList(context.recentAgentMessages, 8));

  lines.push(
    "Repair instructions:",
    "- Inspect the exact blocker paths and validation failures before editing.",
    "- If repository hygiene is blocking, remove generated junk or typo paths, or move useful content into the intended repository path.",
    "- If validation is blocking, fix the product/test/evidence issue that the ledger names; do not claim success until the relevant command passes.",
    "- Keep the work generic to this project. Do not invent AW_Trends-only commands unless the repository already contains them.",
    "- Do not add secrets, machine-local paths, raw credentials, or bulky generated output.",
    "- Run the most relevant validation and evidence commands you can from this project root.",
    "- When done, summarize changed files, commands run, remaining blockers, and tell the operator whether to return to Workbench and press Revalidate or Retry merge."
  );

  return `${lines.join("\n").trim()}\n`;
};

const buildCodexHandoffShellScript = (
  projectRoot: string,
  promptExecutionPath: string,
  settings: Pick<AppSettings, "codexBinaryPath" | "codexHome">,
  runtime?: {
    resolvedCodexCommand?: string;
    runtimePathDirs?: string[];
  }
): string => {
  const codexCommand = runtime?.resolvedCodexCommand ?? settings.codexBinaryPath;
  const runtimePathPrefix = runtime?.runtimePathDirs?.filter(Boolean).join(":");
  return [
    "#!/usr/bin/env bash",
    "set +e",
    `cd ${quoteForBashSingle(projectRoot)} || exit 1`,
    "clear",
    "printf 'Codex Agent Workbench handoff\\n\\n'",
    `cat ${quoteForBashSingle(promptExecutionPath)}`,
    "printf '\\n\\nLaunching Codex interactive handoff...\\n\\n'",
    `prompt=$(cat ${quoteForBashSingle(promptExecutionPath)})`,
    runtimePathPrefix ? `export PATH=${quoteForBashSingle(runtimePathPrefix)}:$PATH` : "",
    settings.codexHome ? `export CODEX_HOME=${quoteForBashSingle(settings.codexHome)}` : "",
    `${quoteForBashSingle(codexCommand)} --no-alt-screen -C ${quoteForBashSingle(projectRoot)} "$prompt"`,
    "status=$?",
    "printf '\\n\\nCodex exited with status %s. Staying in the project shell.\\n\\n' \"$status\"",
    "exec bash"
  ].filter(Boolean).join("\n");
};

const buildWindowsProjectShellLauncherScript = (
  projectName: string,
  projectRoot: string,
  shellScriptExecutionPath: string,
  launcherWorkingDirectoryHostPath: string,
  promptHostPath: string,
  shellScriptHostPath: string,
  launchLogHostPath: string,
  settings: { distroName?: string }
): string => [
  "@echo off",
  "setlocal",
  `title ${buildProjectShellWindowTitle(projectName)}`,
  `cd /d ${quoteForCmd(launcherWorkingDirectoryHostPath)}`,
  "echo Starting Codex Agent Workbench handoff...",
  "echo.",
  settings.distroName
    ? [
        `${quoteForCmd(resolveWindowsWslExecutable())} -d ${quoteForCmd(settings.distroName)} --cd ${quoteForCmd(projectRoot)} bash ${quoteForCmd(shellScriptExecutionPath)}`,
        "set \"status=%ERRORLEVEL%\"",
        "if \"%status%\"==\"-1\" (",
        "  echo.",
        `  echo Explicit WSL distro ${quoteForCmd(settings.distroName)} failed with status %status%. Retrying with the default WSL distro...`,
        `  ${quoteForCmd(resolveWindowsWslExecutable())} --cd ${quoteForCmd(projectRoot)} bash ${quoteForCmd(shellScriptExecutionPath)}`,
        "  set \"status=%ERRORLEVEL%\"",
        ")"
      ].join("\r\n")
    : [
        `${quoteForCmd(resolveWindowsWslExecutable())} --cd ${quoteForCmd(projectRoot)} bash ${quoteForCmd(shellScriptExecutionPath)}`,
        "set \"status=%ERRORLEVEL%\""
      ].join("\r\n"),
  "echo.",
  "echo Codex handoff process exited with status %status%.",
  `echo Launcher working directory: ${launcherWorkingDirectoryHostPath}`,
  `echo Prompt file: ${promptHostPath}`,
  `echo Shell script: ${shellScriptHostPath}`,
  `echo Debug log: ${launchLogHostPath}`,
  "echo.",
  "echo If Codex did not start correctly, copy the error text above and send it back.",
  "endlocal"
].join("\r\n");

const buildPowerShellFallbackLaunchPlan = (
  launcherHostPath: string
): ProjectShellLaunchPlan => {
  const commandInterpreter = resolveWindowsCommandInterpreter();
  const launcherWorkingDirectory = path.win32.dirname(launcherHostPath);
  const powerShellCommand = [
    "Start-Process",
    `-FilePath ${quoteForPowerShell(commandInterpreter)}`,
    `-ArgumentList @('/d', '/k', ${quoteForPowerShell(launcherHostPath)})`,
    `-WorkingDirectory ${quoteForPowerShell(launcherWorkingDirectory)}`,
    `-WindowStyle Normal`
  ].join(" ");

  return {
    executable: resolveWindowsPowerShellExecutable(),
    args: ["-NoLogo", "-NoProfile", "-WindowStyle", "Hidden", "-Command", powerShellCommand],
    commandPreview: powerShellCommand,
    cwd: launcherWorkingDirectory,
    windowsHide: true
  };
};

export const buildWindowsProjectShellLaunchPlan = (
  launcherHostPath: string,
  projectName: string
): ProjectShellLaunchPlan => {
  const commandInterpreter = resolveWindowsCommandInterpreter();
  const launcherWorkingDirectory = path.win32.dirname(launcherHostPath);
  return {
    executable: commandInterpreter,
    args: ["/d", "/k", launcherHostPath],
    commandPreview: `${buildProjectShellWindowTitle(projectName)} :: ${quoteForCmd(commandInterpreter)} /d /k ${quoteForCmd(launcherHostPath)}`,
    cwd: launcherWorkingDirectory,
    windowsHide: false
  };
};

const buildLaunchLog = (details: {
  projectName: string;
  launcherHostPath: string;
  promptHostPath: string;
  shellScriptHostPath: string;
  requestedDistroName?: string;
  effectiveDistroName?: string;
  commandPreview: string;
  fallbackCommandPreview: string;
  error?: string;
}): string => [
  `Project: ${details.projectName}`,
  `Launcher script: ${details.launcherHostPath}`,
  `Prompt file: ${details.promptHostPath}`,
  `WSL shell script: ${details.shellScriptHostPath}`,
  `Requested WSL distro: ${details.requestedDistroName ?? "<default>"}`,
  `Effective WSL distro: ${details.effectiveDistroName ?? "<default>"}`,
  `Primary launcher: ${details.commandPreview}`,
  `Fallback launcher: ${details.fallbackCommandPreview}`,
  details.error ? `Last error: ${details.error}` : "Last error: none"
].join("\n");

const launchProjectShellWindow = async (
  plan: ProjectShellLaunchPlan,
  spawnProcess: typeof spawn
): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const child = spawnProcess(plan.executable, plan.args, {
      cwd: plan.cwd,
      detached: true,
      stdio: "ignore",
      windowsHide: plan.windowsHide ?? false
    });
    let settled = false;
    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      callback();
    };

    child.once("error", (error) => {
      settle(() => {
        reject(error);
      });
    });
    child.once("spawn", () => {
      child.unref();
      settle(resolve);
    });
  });
};

export const openProjectShellWindow = async (
  request: OpenProjectShellWindowRequest,
  platform: NodeJS.Platform = process.platform,
  spawnProcess: typeof spawn = spawn,
  execFileProcess: ExecFileProcess = execFile
): Promise<OpenProjectShellResult> => {
  if (platform !== "win32") {
    return {
      launched: false,
      message: "Project shell handoff is only available on Windows."
    };
  }

  try {
    const promptHostPath = toHostPath(request.projectHostPath, PROJECT_SHELL_HANDOFF_PATH);
    const promptExecutionPath = toExecutionPath(request.projectRoot, PROJECT_SHELL_HANDOFF_PATH);
    const shellScriptHostPath = toHostPath(request.projectHostPath, PROJECT_SHELL_LAUNCHER_SCRIPT_PATH);
    const shellScriptExecutionPath = toExecutionPath(request.projectRoot, PROJECT_SHELL_LAUNCHER_SCRIPT_PATH);
    const launcherHostPath = toHostPath(request.projectHostPath, PROJECT_SHELL_LAUNCHER_CMD_PATH);
    const launchLogHostPath = toHostPath(request.projectHostPath, PROJECT_SHELL_LAUNCH_LOG_PATH);
    const launcherWorkingDirectoryHostPath = path.win32.dirname(launcherHostPath);
    const effectiveDistroName = await resolveWindowsProjectShellDistroName(request, execFileProcess);
    await mkdir(path.dirname(promptHostPath), { recursive: true });
    await writeFile(promptHostPath, request.prompt, "utf8");

    let resolvedRuntime: { resolvedCodexCommand?: string; runtimePathDirs?: string[] } | undefined;
    if (effectiveDistroName) {
      try {
        const executor = new RuntimeCommandExecutor({
          executionMode: request.settings.executionMode,
          distroName: effectiveDistroName
        }, platform);
        const runtime = await executor.resolveWslCodexRuntime({
          command: request.settings.codexBinaryPath,
          cwd: request.projectRoot
        });
        resolvedRuntime = {
          resolvedCodexCommand: runtime.resolvedCodexCommand,
          runtimePathDirs: runtime.runtimePathDirs
        };
      } catch {
        resolvedRuntime = undefined;
      }
    }

    const shellScript = buildCodexHandoffShellScript(
      request.projectRoot,
      promptExecutionPath,
      request.settings,
      resolvedRuntime
    );
    await writeFile(shellScriptHostPath, shellScript, "utf8");
    const launcherScript = buildWindowsProjectShellLauncherScript(
      request.projectName,
      request.projectRoot,
      shellScriptExecutionPath,
      launcherWorkingDirectoryHostPath,
      promptHostPath,
      shellScriptHostPath,
      launchLogHostPath,
      { distroName: effectiveDistroName }
    );
    await writeFile(launcherHostPath, launcherScript, "utf8");

    const plan = buildWindowsProjectShellLaunchPlan(launcherHostPath, request.projectName);
    const fallbackPlan = buildPowerShellFallbackLaunchPlan(launcherHostPath);
    await writeFile(launchLogHostPath, buildLaunchLog({
      projectName: request.projectName,
      launcherHostPath,
      promptHostPath,
      shellScriptHostPath,
      requestedDistroName: normalizeWslDistroName(request.settings.distroName),
      effectiveDistroName,
      commandPreview: plan.commandPreview,
      fallbackCommandPreview: fallbackPlan.commandPreview
    }), "utf8");

    try {
      await launchProjectShellWindow(plan, spawnProcess);
    } catch {
      await launchProjectShellWindow(fallbackPlan, spawnProcess);
    }

    return {
      launched: true,
      message:
        `Tried to open a Codex terminal for ${request.projectName}. `
        + `If no window appeared, run ${launcherHostPath} manually. `
        + `Debug log: ${launchLogHostPath}`
    };
  } catch (error) {
    const launchLogHostPath = toHostPath(request.projectHostPath, PROJECT_SHELL_LAUNCH_LOG_PATH);
    const launcherHostPath = toHostPath(request.projectHostPath, PROJECT_SHELL_LAUNCHER_CMD_PATH);
    try {
      await writeFile(launchLogHostPath, buildLaunchLog({
        projectName: request.projectName,
        launcherHostPath,
        promptHostPath: toHostPath(request.projectHostPath, PROJECT_SHELL_HANDOFF_PATH),
        shellScriptHostPath: toHostPath(request.projectHostPath, PROJECT_SHELL_LAUNCHER_SCRIPT_PATH),
        requestedDistroName: normalizeWslDistroName(request.settings.distroName),
        commandPreview: "not built",
        fallbackCommandPreview: "not built",
        error: formatLauncherFailure(error)
      }), "utf8");
    } catch {
      // Ignore diagnostics-write failures and preserve the original launch error.
    }
    return {
      launched: false,
      message: `${formatLauncherFailure(error)} Debug log: ${launchLogHostPath}`
    };
  }
};
