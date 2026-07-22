import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  getAutomaticAgentReasoningEffort,
  getPreferredInterfaceCreationReasoningEffort,
  resolveAgentReasoningEffort,
  resolveInterfaceCreationReasoningEffort
} from "@shared/modelConfig";
import { SummaryCache } from "@shared/summaryCache";
import { buildRepairReportMarkdown, collectRepairAttemptReports } from "@shared/workflowRepairReport";
import { buildCycleRetrospective, buildStrategicPlan, selectNextWorkPackage } from "@shared/strategicPlanner";
import { autonomyBudgetSchema, humanInterventionRecordSchema, portableInterfaceSchema, projectCredentialsStateSchema, projectReviewLogBundleSchema, projectWorkflowStateSchema } from "@shared/schemas";
import { getPreloadEntryPath, getRendererBase, getRendererEntryPath } from "@shared/electronAppPaths";
import { calculateValidationStatus } from "@shared/validation";
import { createDefaultGoalCharter, listAutopilotPresets } from "@shared/goalCharter";
import {
  approvalDecisionRequestSchema,
  agentDetailRequestSchema,
  agentListRequestSchema,
  chooseFolderRequestSchema,
  credentialEntrySaveRequestSchema,
  credentialRequestSubmitToAgentSchema,
  credentialRequestUpdateSchema,
  createAgentRequestSchema,
  downloadInterfaceRequestSchema,
  downloadLogsRequestSchema,
  generateGoalCharterDraftRequestSchema,
  polishGoalCharterFieldRequestSchema,
  projectLogFeedRequestSchema,
  projectLoadRequestSchema,
  projectOpenRequestSchema,
  projectRepositoryChildrenRequestSchema,
  projectRepositoryExcludedPathsRequestSchema,
  projectRepositorySearchRequestSchema,
  refreshOverviewRequestSchema,
  repositoryPathQuestionRequestSchema,
  repositoryPathSummaryRequestSchema,
  repositoryPathWindowRequestSchema,
  repositoryRescanRequestSchema,
  repositoryScanSettingsRequestSchema,
  requestWorkflowPreviewRequestSchema,
  setAutopilotPolicyRequestSchema,
  setWorkflowModeRequestSchema,
  workflowDashboardRequestSchema,
  workflowPreviewCheckpointRequestSchema,
  visualExportCaptureRequestSchema,
  visualExportSessionRequestSchema,
  visualExportStartRequestSchema
} from "@shared/ipc";
import { createAgentSkeleton, createLocalProjectRecord, defaultLayout, defaultLocalState, defaultProjectWorkflowState, defaultSettings, defaultWorkflowStepProgressState, emptyUltimateGoal } from "@shared/defaults";
import type { AgentState, AgentTranscriptEntry, ApprovedRecommendation, DiscoveredModel, GoalAttainmentCheck, ProjectOverview, ProjectStats, ProjectWorkflowState, RepositoryScanSettings, RepoTreeNode, WorkflowRecommendationOption, WorkflowStage, WorkPackage } from "@shared/types";
import {
  createScopedGoalFromWorkPackage,
  createScopedGoalFromRecommendation,
  deriveWorkflowProjection,
  ensureWorkflowStepProgressState,
  getAutopilotMaxChecksPerWorkPackage,
  getAutopilotMaxNewRequiredChecksPerCycle,
  getAutopilotPolicyConfig,
  getWorkflowModeConfig,
  getWorkflowPreviewRequest,
  getNextWorkflowAutomationAction,
  hasRepeatedAutopilotFailure,
  isHighRiskAutopilotRecommendation,
  isPreviewRecommendation,
  pickAutopilotRecommendation,
  resolveEffectiveAutopilotPolicy,
  shouldAutopilotPause,
  validateAutopilotPolicy,
  workPackageRequiresModelScoping
} from "@shared/workflow";
import {
  applyChecklistEvidenceObservations,
  buildCycleContract,
  buildNoProgressReconciliationRecommendation,
  computeChecklistDelta,
  discoverProjectEvidenceCommands,
  extractChecklistEvidenceObservations,
  recordRecommendationFallbackUsed,
  recordStructuredRecommendationFailure
} from "@shared/workflowEvidence";
import {
  buildWorkflowGoalView,
  buildWorkflowTimelineSteps,
  canRevalidateExternalRepair,
  deriveWorkflowRuntimeStatus,
  deriveUserFacingWorkflowStatus,
  getWorkflowRecoveryCandidate,
  getWorkflowRepairCounterView,
  workflowActionGuide,
  workflowRunStateLabel,
  workflowSectionProminence,
  workflowStageGuidance,
  workflowStageLabel,
  workflowStatusSummary
} from "@shared/workflowView";
import { buildOperatorWorkflowViewModel, suspiciousPathReason } from "@shared/operatorWorkflowView";
import { upsertWorkflowIncident } from "@shared/workflowExecution";
import { reduceAgentRuntimeEvent } from "@runtime/runtimeEvents";
import { AppService } from "@runtime/appService";
import { WorkbenchStorage } from "@runtime/storage";
import { buildInterfaceCreationOutputSchema, parseInterfaceCreationOutput } from "@runtime/interfaceCreation";
import {
  assertSafeArtifactDestination,
  defaultPortableInterfacePath,
  defaultReviewLogPath,
  defaultVisualExportPath
} from "@runtime/artifactPaths";
import { parseManifestFile } from "@runtime/manifestParser";
import { createProjectIdentity } from "@runtime/projectIdentity";
import { classifyCommandApproval, shouldAutoApproveApproval } from "@runtime/approvalPolicy";
import {
  assertExecutionPathWithinProjectRoot,
  assertHostPathWithinProjectRoot,
  ensureSafeProjectRelativePath,
  joinExecutionPathWithinProject,
  ProjectBoundaryError,
  resolveExecutionPathWithinProjectRoot
} from "@runtime/projectBoundary";
import { hasMeaningfulRepositoryContent, scanRepository } from "@runtime/repoScanner";
import { parseUltimateGoalText } from "@runtime/ultimateGoalImport";
import { buildGitHubRepositoryName, buildGitHubSshRemoteUrl, isGitHubRemote, parseGitHubRemote } from "@runtime/github";
import {
  buildShellExecutionPlan,
  executeWslBashCommandPlan,
  buildWslCodexRuntimeResolutionPlan,
  buildStructuredExecutionPlan,
  buildWslCommandResolutionPlan,
  buildWslLoginShellExecutionPlan,
  describeWslCodexRuntimeResolutionFailure,
  describeWslCommandResolutionFailure,
  describeExecutionFailure,
  parseWslCodexRuntimeResolutionOutput,
  parseWslCommandResolutionOutput
} from "@runtime/execution";
import { assessCodexProtocolCompatibility, buildCodexUpdateCommand, checkCodexCliUpdate, compareCodexVersions, parseCodexCliVersion, parseNpmPackageVersion, updateCodexCliIfAvailable } from "@runtime/codexUpdate";
import { buildProjectShellHandoffPrompt, buildWindowsProjectShellLaunchPlan, buildWorkflowRepairAgentPrompt, openProjectShellWindow } from "@runtime/projectShell";
import { createTempDir, initGitRepo, commitAll } from "./helpers";
import { executionPathToHostPath, resolveProjectPath, windowsPathToWslPath } from "@shared/pathUtils";
import {
  applyGoalChecklistUpdates,
  assessUltimateGoalCompletion,
  auditGoalChecklist,
  buildAppealRecommendations,
  buildChecklistWorkPackages,
  buildChecklistTaskMap,
  buildChecklistTaskMapBrief,
  consolidateGoalChecklist,
  buildGoalChecklistForAssessment,
  buildGoalChecklistFromUltimateGoal,
  buildOutcomeStrategyBrief,
  buildWorkflowRecommendations,
  estimateUltimateGoalProgress,
  isVisualProject,
  type WorkflowRecommendationContext
} from "@runtime/workflowRecommendations";
import {
  CHECKLIST_EVIDENCE_HISTORY_MAX_ENTRIES,
  CHECKLIST_RENDERER_EVIDENCE_MAX_CHARS,
  CHECKLIST_EVIDENCE_MAX_CHARS,
  sanitizeGoalAttainmentCheck,
  sanitizeProjectRecord
} from "@runtime/stateSanitizer";
import {
  assessIntegrityFailure,
  sanitizeRecommendationForCycle,
  sanitizeScopedGoalForSingleAgent
} from "@runtime/workflowGuardrails";
import {
  buildValidationCommandResult,
  createValidationLedger,
  deriveMergeGateDecision,
  finalizeValidationLedger
} from "@shared/validationLedger";
import {
  deriveLegacyWorkflowDiagnostics,
  workflowCycleTaskSeparation
} from "@shared/workflowMigration";
import { resolveEvidenceCommandsForExecution, resolveTargetProjectCommands } from "@runtime/targetProjectCommands";
import { scanAndCleanRepoHygiene } from "@runtime/repoHygiene";
import { buildWorkflowAttentionItems } from "@renderer/workflowAttention";
import { buildRepairStrategyContext } from "@runtime/workflowRepairPlanner";
import {
  createAgentContextDescriptor,
  createWorkflowContextDescriptor,
  formatRelevantContextForPrompt,
  pruneWorkflowContextDescriptors,
  selectRelevantWorkflowContext
} from "@runtime/contextSelector";
import { REPOSITORY_ROOT_PARENT, buildRepositoryTreeRows } from "@renderer/repositoryTree";
import { buildDiscoveredModels } from "@runtime/modelCatalog";
import type { Model } from "@generated/app-server/v2";

type SpawnProcess = typeof import("node:child_process").spawn;
type ExecFileProcess = typeof import("node:child_process").execFile;

type PackageAppScript = {
  buildArtifactCopyFallbackPath: (destinationPath: string, attempt?: number, now?: Date) => string;
  buildTargetArgs: (
    target: string,
    outputDir: string
  ) => string[];
  createBuilderEnv: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  patchWindowsExecutableWithOfficialElectron: (unpackedDir: string) => Promise<string>;
  parsePackageArgs: (argv: string[]) => { compile: boolean; targets: string[] };
  resolveDownloadsDir: (env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform) => string;
  resolveOfficialWindowsElectronExecutable: () => Promise<string>;
  windowsPathToWslPath: (inputPath: string) => string;
};

type RepoHygieneScript = {
  analyzeTrackedFiles: (
    files: Array<string | { path: string; sizeBytes?: number }>,
    options?: { largeFileLimitBytes?: number }
  ) => Array<{ path: string; reason: string }>;
  analyzeGitignoreContent: (content: string) => Array<{ path: string; reason: string }>;
  gitignoreArtifactSamples: string[];
};

const loadPackageAppScript = async (): Promise<PackageAppScript> => {
  const moduleUrl = pathToFileURL(path.resolve("scripts/package-app.mjs")).href;
  return await import(moduleUrl) as PackageAppScript;
};

const loadRepoHygieneScript = async (): Promise<RepoHygieneScript> => {
  const moduleUrl = pathToFileURL(path.resolve("scripts/check-repo-hygiene.mjs")).href;
  return await import(moduleUrl) as RepoHygieneScript;
};

const runGitText = (args: string[]): string => {
  const result = spawnSync("git", args, { cwd: process.cwd(), encoding: "utf8" });
  if (result.status !== 0 || (!result.stdout && result.error)) {
    throw result.error ?? new Error(result.stderr || `git ${args.join(" ")} failed.`);
  }
  return result.stdout;
};

const cssVariable = (source: string, name: string): string => {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(source);
  if (!match) {
    throw new Error(`Missing CSS variable ${name}`);
  }
  return match[1].trim();
};

const hexToRgb = (value: string): [number, number, number] => {
  const normalized = value.trim().replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(normalized)) {
    throw new Error(`Expected a six-digit hex color, received ${value}`);
  }
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16)
  ];
};

const relativeLuminance = ([red, green, blue]: [number, number, number]): number => {
  const [r, g, b] = [red, green, blue].map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrastRatio = (foreground: string, background: string): number => {
  const lighter = Math.max(relativeLuminance(hexToRgb(foreground)), relativeLuminance(hexToRgb(background)));
  const darker = Math.min(relativeLuminance(hexToRgb(foreground)), relativeLuminance(hexToRgb(background)));
  return (lighter + 0.05) / (darker + 0.05);
};

const makeRecommendation = (overrides: Partial<WorkflowRecommendationOption> = {}): WorkflowRecommendationOption => ({
  id: overrides.id ?? "rec-1",
  rank: overrides.rank ?? 1,
  title: overrides.title ?? "Implement the next step",
  summary: overrides.summary ?? "Turn the current recommendation into the next bounded execution pass.",
  rationale: overrides.rationale ?? "This is the highest-value next move for the current cycle.",
  expectedImpact: overrides.expectedImpact ?? "It creates visible progress without losing the current repo context.",
  priority: overrides.priority ?? "high",
  confidence: overrides.confidence ?? 0.9,
  estimatedScope: overrides.estimatedScope ?? "small",
  riskLevel: overrides.riskLevel ?? "medium",
  relatedPaths: overrides.relatedPaths ?? ["src/index.ts"],
  sourceWorkPackageId: overrides.sourceWorkPackageId,
  targetedCheckIds: overrides.targetedCheckIds
});

const approveRecommendation = (
  recommendation: WorkflowRecommendationOption,
  overrides: Partial<ApprovedRecommendation> = {}
): ApprovedRecommendation => ({
  id: overrides.id ?? "approved-1",
  recommendationId: overrides.recommendationId ?? recommendation.id,
  rank: overrides.rank ?? recommendation.rank,
  title: overrides.title ?? recommendation.title,
  summary: overrides.summary ?? recommendation.summary,
  rationale: overrides.rationale ?? recommendation.rationale,
  expectedImpact: overrides.expectedImpact ?? recommendation.expectedImpact,
  priority: overrides.priority ?? recommendation.priority,
  confidence: overrides.confidence ?? recommendation.confidence,
  estimatedScope: overrides.estimatedScope ?? recommendation.estimatedScope,
  riskLevel: overrides.riskLevel ?? recommendation.riskLevel,
  relatedPaths: overrides.relatedPaths ?? recommendation.relatedPaths,
  sourceWorkPackageId: overrides.sourceWorkPackageId ?? recommendation.sourceWorkPackageId,
  targetedCheckIds: overrides.targetedCheckIds ?? recommendation.targetedCheckIds,
  approvedAt: overrides.approvedAt ?? "2026-04-07T00:00:00.000Z"
});

const makePassedIntegrityAgent = (): AgentState => ({
  ...createAgentSkeleton("integrity", "Integrity Agent", "Run deterministic validation.", "gpt-5.4"),
  status: "completed",
  completedAt: "2026-04-07T00:02:00.000Z",
  integrityReport: {
    summary: "Deterministic checks passed.",
    checks: [
      {
        name: "test",
        command: "npm test",
        status: "passed",
        outputSnippet: "passed"
      }
    ],
    risks: [],
    generatedAt: "2026-04-07T00:02:00.000Z"
  }
});

const makeWorkflowRecommendationContext = (
  workflow = defaultProjectWorkflowState(),
  files: WorkflowRecommendationContext["scan"]["files"] = [
    { absolutePath: "/repo/src/runtime/workflowRecommendations.ts", relativePath: "src/runtime/workflowRecommendations.ts", size: 4_096, language: "TypeScript" },
    { absolutePath: "/repo/src/shared/workflow.ts", relativePath: "src/shared/workflow.ts", size: 2_048, language: "TypeScript" },
    { absolutePath: "/repo/src/tests/unit.spec.ts", relativePath: "src/tests/unit.spec.ts", size: 2_048, language: "TypeScript" }
  ]
): WorkflowRecommendationContext => ({
  workflow,
  agents: [],
  scan: {
    kind: "git",
    files,
    stats: {
      projectRoot: "/repo",
      kind: "git",
      totalFiles: files.length,
      totalFolders: 3,
      totalSizeBytes: files.reduce((sum, file) => sum + file.size, 0),
      includedFiles: files.length,
      includedFolders: 3,
      includedSizeBytes: files.reduce((sum, file) => sum + file.size, 0),
      excludedFiles: 0,
      excludedFolders: 0,
      excludedSizeBytes: 0,
      excludedPaths: [],
      fileTypeBreakdown: { TypeScript: files.length },
      languageBreakdown: { TypeScript: files.length },
      entryPoints: ["src/runtime/workflowRecommendations.ts"],
      manifestFiles: ["package.json"],
      testsPresent: true,
      primaryManagers: ["npm"],
      explanation: "Workflow test repo"
    },
    dependencies: []
  },
  overview: undefined,
  objective: "deliver",
  maxOptions: 5
});

const makeGoalCheck = (overrides: Partial<GoalAttainmentCheck> = {}): GoalAttainmentCheck => ({
  id: overrides.id ?? "check-1",
  title: overrides.title ?? "Workflow checklist requirement is observable",
  description: overrides.description ?? "",
  required: overrides.required ?? true,
  itemKind: overrides.itemKind ?? (overrides.required === false ? "backlog" : "required"),
  canonicalKey: overrides.canonicalKey,
  groupId: overrides.groupId,
  sourceCheckIds: overrides.sourceCheckIds,
  relatedCheckIds: overrides.relatedCheckIds,
  auditFlags: overrides.auditFlags,
  needsRefinement: overrides.needsRefinement,
  classificationReason: overrides.classificationReason,
  promotionReason: overrides.promotionReason,
  introducedCycleNumber: overrides.introducedCycleNumber,
  status: overrides.status ?? "unknown",
  confidence: overrides.confidence,
  evidence: overrides.evidence ?? "",
  evidenceHistory: overrides.evidenceHistory,
  source: overrides.source ?? "agent",
  relatedPaths: overrides.relatedPaths ?? [],
  ownerAgentId: overrides.ownerAgentId,
  createdAt: overrides.createdAt ?? "2026-04-07T00:00:00.000Z",
  updatedAt: overrides.updatedAt ?? "2026-04-07T00:00:00.000Z"
});

const readJsonFixture = async <T,>(name: string): Promise<T> =>
  JSON.parse(await readFile(path.join(process.cwd(), "src/tests/fixtures", name), "utf8")) as T;

const localRuntimeSettings = {
  executionMode: "local" as const,
  distroName: "Ubuntu"
};

let ledgerCommandCounter = 0;
const makeLedgerCommandResult = (overrides: Partial<Parameters<typeof buildValidationCommandResult>[0]> = {}) => {
  ledgerCommandCounter += 1;
  return buildValidationCommandResult({
    commandId: overrides.commandId ?? `cmd-${ledgerCommandCounter}`,
    command: overrides.command ?? "npm test",
    phase: overrides.phase ?? "integrity",
    startedAt: overrides.startedAt ?? "2026-06-01T00:00:00.000Z",
    endedAt: overrides.endedAt ?? "2026-06-01T00:00:01.000Z",
    exitCode: overrides.exitCode ?? 0,
    status: overrides.status,
    stdout: overrides.stdout ?? "",
    stderr: overrides.stderr ?? "",
    cwdKind: overrides.cwdKind ?? "project_root",
    fullOutputRef: overrides.fullOutputRef,
    parsedJsonRef: overrides.parsedJsonRef,
    relatedCheckIds: overrides.relatedCheckIds,
    relatedFiles: overrides.relatedFiles,
    classifiedFailure: overrides.classifiedFailure
  });
};

const makeAppServiceLoadedProject = (projectId = "project-1") => {
  const workflow = defaultProjectWorkflowState();
  workflow.ultimateGoal = {
    ...emptyUltimateGoal("user"),
    summary: "Keep the workflow moving without freezing.",
    detailedIntent: "Advance a bounded implementation cycle while preserving workflow state.",
    successCriteria: ["A bounded next step can run."],
    confirmedAt: "2026-04-07T00:00:00.000Z"
  };
  workflow.goalChecklist = [
    makeGoalCheck({
      id: "workflow-responsive",
      title: "Workflow remains responsive during automation",
      status: "unmet",
      relatedPaths: ["src/runtime/appService.ts"]
    })
  ];
  workflow.workflowMode = "normal";
  const identity = createProjectIdentity({
    kind: "git",
    projectRoot: "/repo",
    projectName: "repo",
    repositoryName: "repo",
    normalizedRemotes: ["git@github.com:awb-tests/repo.git"],
    manifestSignature: "manifest",
    treeSignature: "tree"
  });
  const record = createLocalProjectRecord(
    projectId,
    "/repo",
    "/repo",
    "/repo",
    "/repo",
    identity,
    {
      interfaceSchemaVersion: 1,
      appMinVersion: "0.1.0",
      projectKind: "git"
    }
  );
  record.localState.autopilotEnabled = true;
  record.workflow = workflow;
  const context = makeWorkflowRecommendationContext(workflow);
  return {
    record,
    tree: [] as RepoTreeNode[],
    scan: context.scan,
    gitMetadata: {
      branch: "main",
      head: "abc123",
      isGitRepository: true,
      hasUncommittedChanges: false,
      remotes: []
    },
    summaryCache: new SummaryCache(record.summaryCache),
    candidates: []
  };
};

describe("path utils", () => {
  it("converts Windows paths into WSL paths", () => {
    expect(windowsPathToWslPath("C:\\Users\\nicot\\project")).toBe("/mnt/c/Users/nicot/project");
  });

  it("resolves UNC WSL paths", () => {
    const resolved = resolveProjectPath("\\\\wsl$\\Ubuntu\\home\\nicot\\project", {
      executionMode: "wsl",
      distroName: "Ubuntu",
      codexBinaryPath: "codex",
      worktreeBaseDir: "~/.awb",
      warnOnMntMount: true,
      mockMode: true,
      maxRepairCycles: 3,
      autoApproveCommands: false,
      autoApproveGitCommits: false,
      autoApproveGitPushes: false,
      considerPaidServices: false
    }, "win32");
    expect(resolved.wslPath).toBe("/home/nicot/project");
    expect(resolved.hostPath).toBe("\\\\wsl$\\Ubuntu\\home\\nicot\\project");
    expect(resolved.kind).toBe("wsl-unc");
  });

  it("translates linux execution paths back to Windows UNC host paths", () => {
    expect(
      executionPathToHostPath(
        "/home/nicot/project",
        {
          executionMode: "wsl",
          distroName: "Ubuntu"
        },
        "Ubuntu",
        "win32"
      )
    ).toBe("\\\\wsl$\\Ubuntu\\home\\nicot\\project");
    expect(
      executionPathToHostPath(
        "/mnt/c/Users/nicot/project",
        {
          executionMode: "wsl",
          distroName: "Ubuntu"
        },
        "Ubuntu",
        "win32"
      )
    ).toBe("C:\\Users\\nicot\\project");
  });

  it("uses a relative renderer base for production file loading", () => {
    expect(getRendererBase("serve")).toBe("/");
    expect(getRendererBase("build")).toBe("./");
  });

  it("resolves packaged renderer and preload entries from the app path", () => {
    expect(getRendererEntryPath("/app-root")).toBe(path.join("/app-root", "dist", "index.html"));
    expect(getPreloadEntryPath("/app-root")).toBe(path.join("/app-root", "dist-electron", "preload", "index.cjs"));
    expect(getRendererEntryPath("C:\\app-root")).toBe("C:\\app-root\\dist\\index.html");
    expect(getPreloadEntryPath("C:\\app-root")).toBe("C:\\app-root\\dist-electron\\preload\\index.cjs");
  });
});

describe("artifact destination safety", () => {
  it("builds target-project .agent-workbench defaults for portable, log, and visual artifacts", () => {
    const projectRoot = path.join("/tmp", "target-project");

    expect(defaultPortableInterfacePath(projectRoot)).toBe(path.join(projectRoot, ".agent-workbench", "interface.json"));
    expect(defaultReviewLogPath(projectRoot, "Quant Interview Prep", new Date("2026-06-10T17:53:57.596Z")))
      .toBe(path.join(projectRoot, ".agent-workbench", "review-logs", "Quant-Interview-Prep-review-log-2026-06-10T17-53-57-596Z.json"));
    expect(defaultVisualExportPath(projectRoot, "Quant Interview Prep", new Date("2026-06-10T17:54:19.586Z")))
      .toBe(path.join(projectRoot, ".agent-workbench", "visuals", "Quant-Interview-Prep-interface-visuals-2026-06-10T17-54-19-586Z.pdf"));
  });

  it("blocks target-project artifacts from being written into the Workbench source root", async () => {
    const projectRoot = await createTempDir("target-artifact-root");
    const wrongRootLog = path.join(process.cwd(), "quant_interview_prep-review-log-2026-06-10T17-53-57-596Z.json");

    expect(() => assertSafeArtifactDestination({
      projectRoot,
      destinationPath: wrongRootLog,
      artifactKind: "review-log",
      appSourceRoot: process.cwd()
    })).toThrow(/Agentic Workbench source repository/);
  });

  it("writes default review logs and visual paths under the active target project", async () => {
    const projectRoot = await createTempDir("target-artifact-project");
    const service = new AppService(await createTempDir("artifact-appdata")) as unknown as {
      projects: Map<string, ReturnType<typeof makeAppServiceLoadedProject>>;
      downloadLogs: AppService["downloadLogs"];
      createVisualExportDestination: AppService["createVisualExportDestination"];
    };
    const project = makeAppServiceLoadedProject("artifact-project");
    project.record.hostPath = projectRoot;
    project.record.projectRoot = projectRoot;
    project.record.displayPath = projectRoot;
    service.projects.set(project.record.id, project);

    const logPath = await service.downloadLogs(project.record.id);
    const visualPath = service.createVisualExportDestination(project.record.id);

    expect(logPath.startsWith(path.join(projectRoot, ".agent-workbench", "review-logs"))).toBe(true);
    expect(visualPath.startsWith(path.join(projectRoot, ".agent-workbench", "visuals"))).toBe(true);
    await expect(stat(logPath)).resolves.toBeTruthy();
    await expect(service.downloadLogs(project.record.id, path.join(process.cwd(), "quant_interview_prep-review-log-2026-06-10T17-53-57-596Z.json")))
      .rejects.toThrow(/Agentic Workbench source repository/);
  });
});

describe("packaging script", () => {
  it("converts Windows paths and parses distributable targets", async () => {
    const packageAppScript = await loadPackageAppScript();

    expect(packageAppScript.windowsPathToWslPath("C:\\Users\\nicot\\Downloads")).toBe("/mnt/c/Users/nicot/Downloads");
    expect(packageAppScript.parsePackageArgs(["--win", "--no-compile"])).toEqual({
      compile: false,
      targets: ["win"]
    });
    expect(packageAppScript.parsePackageArgs(["--win-portable", "--no-compile"])).toEqual({
      compile: false,
      targets: ["win-portable"]
    });
    expect(packageAppScript.parsePackageArgs(["--all"]).targets.sort()).toEqual(["mac", "win"]);
    expect(packageAppScript.buildArtifactCopyFallbackPath(
      "/mnt/c/Users/nicot/Downloads/Codex Agent Workbench-0.1.0-windows-x64.exe",
      2,
      new Date("2026-04-21T10:11:12.000Z")
    )).toBe("/mnt/c/Users/nicot/Downloads/Codex Agent Workbench-0.1.0-windows-x64-20260421101112-2.exe");
  });

  it("resolves explicit and native Windows Downloads destinations", async () => {
    const packageAppScript = await loadPackageAppScript();

    expect(packageAppScript.resolveDownloadsDir({ AWB_PACKAGE_OUTPUT_DIR: "/tmp/awb-artifacts" }, "linux")).toBe("/tmp/awb-artifacts");
    expect(packageAppScript.resolveDownloadsDir({ USERPROFILE: "C:\\Users\\TestUser" }, "win32")).toBe("C:\\Users\\TestUser\\Downloads");
  });

  it("builds the default unpacked Windows app without extra packaging credentials", async () => {
    const packageAppScript = await loadPackageAppScript();
    const args = packageAppScript.buildTargetArgs("win", "/tmp/out");
    const packageJson = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));

    expect(args).toContain("--win");
    expect(args).toContain("dir");
    expect(args).toContain("--config.win.signAndEditExecutable=false");
    expect(packageJson.build.win.signExts).toEqual(["!.exe"]);
  });

  it("exports a Windows executable patch step for preserving the official Electron binary", async () => {
    const packageAppScript = await loadPackageAppScript();

    expect(typeof packageAppScript.resolveOfficialWindowsElectronExecutable).toBe("function");
    expect(typeof packageAppScript.patchWindowsExecutableWithOfficialElectron).toBe("function");
  });

  it("drops inherited Windows package credential environment before running the builder", async () => {
    const packageAppScript = await loadPackageAppScript();
    const env = packageAppScript.createBuilderEnv({
      AWB_SIGN_WINDOWS: "1",
      AWB_WIN_CSC_LINK: "/tmp/local.pfx",
      CSC_LINK: "/tmp/generic.pfx",
      PATH: "/usr/bin",
      WIN_CSC_LINK: "/tmp/windows.pfx",
      npm_config_loglevel: "verbose"
    });

    expect(env.AWB_SIGN_WINDOWS).toBeUndefined();
    expect(env.AWB_WIN_CSC_LINK).toBeUndefined();
    expect(env.CSC_LINK).toBeUndefined();
    expect(env.WIN_CSC_LINK).toBeUndefined();
    expect(env.npm_config_loglevel).toBeUndefined();
    expect(env.CSC_IDENTITY_AUTO_DISCOVERY).toBe("false");
    expect(env.PATH).toBe("/usr/bin");
  });
});

describe("repo hygiene guardrails", () => {
  it("detects generated target-project artifacts and large unallowlisted tracked files", async () => {
    const repoHygiene = await loadRepoHygieneScript();
    const issues = repoHygiene.analyzeTrackedFiles([
      { path: "quant_interview_prep-review-log-2026-06-10T17-53-57-596Z.json", sizeBytes: 3_132_204 },
      { path: "Master_Trading_Interface-review-log-2026-04-27T18-05-38-994Z.json", sizeBytes: 45_601_439 },
      { path: "quant_interview_prep-interface.json", sizeBytes: 2_492_457 },
      { path: ".agent-workbench/review-logs/project-review-log.json", sizeBytes: 1_000 },
      { path: "docs/intentional.md", sizeBytes: 1_000 },
      { path: "assets/branding/interface_icon.png", sizeBytes: 9_000_000 },
      { path: "debug-dump.bin", sizeBytes: 8_000_000 }
    ]);

    expect(issues.map((issue) => issue.path)).toEqual(expect.arrayContaining([
      "quant_interview_prep-review-log-2026-06-10T17-53-57-596Z.json",
      "Master_Trading_Interface-review-log-2026-04-27T18-05-38-994Z.json",
      "quant_interview_prep-interface.json",
      ".agent-workbench/review-logs/project-review-log.json",
      "debug-dump.bin"
    ]));
    expect(issues.some((issue) => issue.path === "docs/intentional.md")).toBe(false);
    expect(issues.some((issue) => issue.path === "assets/branding/interface_icon.png")).toBe(false);
  });

  it("keeps .gitignore newline-separated", async () => {
    const repoHygiene = await loadRepoHygieneScript();
    const content = await readFile(path.resolve(".gitignore"), "utf8");

    expect(repoHygiene.analyzeGitignoreContent(content)).toEqual([]);
    expect(content.split(/\r?\n/).length).toBeGreaterThan(20);
    expect(content).toContain("\nnode_modules/");
  });

  it("ignores generated target-project export patterns before they can be added", async () => {
    const repoHygiene = await loadRepoHygieneScript();
    const ignored = runGitText(
      [
        "check-ignore",
        "--no-index",
        "-v",
        ...repoHygiene.gitignoreArtifactSamples
      ]
    ).trim().split(/\r?\n/);

    expect(ignored).toHaveLength(repoHygiene.gitignoreArtifactSamples.length);
    for (const sample of repoHygiene.gitignoreArtifactSamples) {
      expect(ignored.some((line) => line.endsWith(`\t${sample}`))).toBe(true);
    }
  });
});

describe("validation ledger", () => {
  it("treats pytest unavailable plus unittest passed as passed with an environment warning", () => {
    const ledger = createValidationLedger({
      cycleNumber: 1,
      testCommands: ["python3 -m pytest", "PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m unittest discover -s tests -q"]
    });
    ledger.commandResults = [
      makeLedgerCommandResult({
        commandId: "pytest-missing",
        command: "python3 -m pytest",
        exitCode: 1,
        stderr: "/usr/bin/python3: No module named pytest"
      }),
      makeLedgerCommandResult({
        commandId: "unittest-pass",
        command: "PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m unittest discover -s tests -q",
        exitCode: 0,
        stdout: "OK"
      })
    ];

    const finalized = finalizeValidationLedger(ledger);

    expect(finalized.finalValidationStatus).toBe("passed");
    expect(finalized.mergeAllowed).toBe(false);
    expect(finalized.mergeBlockedReasons.join(" ")).toContain("hygiene");
    const withHygiene = finalizeValidationLedger(ledger, {
      repoHygieneReport: {
        status: "passed",
        scannedAt: "2026-06-01T00:00:02.000Z",
        scannedRef: "test",
        forbiddenFiles: [],
        cleanedFiles: [],
        warnings: [],
        mergeBlockingFindings: [],
        summaryForHumans: "Repository hygiene passed."
      }
    });
    expect(withHygiene.mergeAllowed).toBe(true);
    expect(finalized.warnings.join(" ")).toContain("pytest unavailable");
    expect(finalized.summaryForHumans).toContain("failed attempt");

    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal.confirmedAt = "2026-06-01T00:00:00.000Z";
    workflow.validationLedgers = [finalized];
    const view = buildOperatorWorkflowViewModel({ workflow, validationLedger: finalized });
    expect(view.currentCycle.validationSummary.finalStatusLabel).toBe("Final validation passed");
    expect(view.currentCycle.validationSummary.warnings.join(" ")).toContain("pytest unavailable");
    expect(view.currentCycle.validationSummary.repaired.length).toBeGreaterThan(0);
  });

  it("treats python unavailable plus python3 passed as passed with an environment warning", () => {
    const ledger = createValidationLedger({
      cycleNumber: 1,
      testCommands: ["python -m unittest discover -s tests -q", "python3 -m unittest discover -s tests -q"]
    });
    ledger.commandResults = [
      makeLedgerCommandResult({
        commandId: "python-missing",
        command: "python -m unittest discover -s tests -q",
        exitCode: 127,
        stderr: "python: command not found"
      }),
      makeLedgerCommandResult({
        commandId: "python3-pass",
        command: "python3 -m unittest discover -s tests -q",
        exitCode: 0,
        stdout: "OK"
      })
    ];

    const finalized = finalizeValidationLedger(ledger);

    expect(finalized.finalValidationStatus).toBe("passed");
    expect(finalized.warnings.join(" ")).toContain("python unavailable");
  });

  it("keeps an unresolved assertion failure failed and merge-blocking", () => {
    const ledger = createValidationLedger({ cycleNumber: 1, testCommands: ["npm test"] });
    ledger.commandResults = [
      makeLedgerCommandResult({
        command: "npm test",
        exitCode: 1,
        stdout: "FAIL test/example.spec.ts\nAssertionError: expected true to be false"
      })
    ];

    const finalized = finalizeValidationLedger(ledger);

    expect(finalized.finalValidationStatus).toBe("failed");
    expect(finalized.mergeAllowed).toBe(false);
    expect(finalized.productFailures).toHaveLength(1);

    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal.confirmedAt = "2026-06-01T00:00:00.000Z";
    workflow.validationLedgers = [finalized];
    const view = buildOperatorWorkflowViewModel({ workflow, validationLedger: finalized });
    expect(view.currentCycle.validationSummary.finalStatusLabel).toBe("Final validation failed");
    expect(view.currentCycle.validationSummary.mergeAllowed).toBe(false);
    expect(view.currentStatus.nextOperatorAction).toBe("Fix validation failure before merge.");
  });

  it("marks an equivalent failed command repaired after a later pass", () => {
    const ledger = createValidationLedger({ cycleNumber: 1, testCommands: ["npm test"] });
    ledger.commandResults = [
      makeLedgerCommandResult({
        commandId: "npm-test-failed",
        command: "npm test",
        exitCode: 1,
        stdout: "FAIL test/example.spec.ts\nAssertionError: expected true to be false"
      }),
      makeLedgerCommandResult({
        commandId: "npm-test-passed",
        command: "npm test",
        exitCode: 0,
        stdout: "Tests passed"
      })
    ];

    const finalized = finalizeValidationLedger(ledger);

    expect(finalized.finalValidationStatus).toBe("passed");
    expect(finalized.repairedFailures).toHaveLength(1);
    expect(finalized.unresolvedValidationFailures).toEqual([]);
  });

  it("reports not_run when no validation command ran", () => {
    const finalized = finalizeValidationLedger(createValidationLedger({ cycleNumber: 1 }));

    expect(finalized.finalValidationStatus).toBe("not_run");
    expect(finalized.mergeAllowed).toBe(false);
    expect(finalized.summaryForHumans).toContain("did not run");

    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal.confirmedAt = "2026-06-01T00:00:00.000Z";
    workflow.validationLedgers = [finalized];
    const view = buildOperatorWorkflowViewModel({ workflow, validationLedger: finalized });
    expect(view.currentCycle.validationSummary.finalStatusLabel).toBe("Validation not run");
    expect(view.currentCycle.validationSummary.mergeBlockedReasons).toEqual([]);
    expect(view.currentCycle.validationSummary.finalStatusLabel).not.toMatch(/success|passed/i);
  });

  it("classifies JSON evidence parse failure as evidence failure, not product failure", () => {
    const ledger = createValidationLedger({ cycleNumber: 1, evidenceCommands: ["python3 -m aw_trends.app source-audit --limit 3"] });
    ledger.commandResults = [
      makeLedgerCommandResult({
        command: "python3 -m aw_trends.app source-audit --limit 3",
        phase: "evidence",
        exitCode: 0,
        status: "failed",
        stderr: "JSON parse failure: unexpected token"
      })
    ];

    const finalized = finalizeValidationLedger(ledger);

    expect(finalized.evidenceFailures).toHaveLength(1);
    expect(finalized.productFailures).toHaveLength(0);
    expect(finalized.finalValidationStatus).toBe("partial");
  });
});

describe("target project command resolver", () => {
  it("uses src-layout unittest validation when pytest is not declared", async () => {
    const root = await createTempDir("resolver-python-src");
    await mkdir(path.join(root, "src", "sample"), { recursive: true });
    await mkdir(path.join(root, "tests"), { recursive: true });
    await writeFile(path.join(root, "src", "sample", "__init__.py"), "");
    await writeFile(path.join(root, "tests", "test_sample.py"), "import unittest\n\nclass SampleTest(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(True)\n");

    const resolution = await resolveTargetProjectCommands({ projectRoot: root, projectKind: "folder" });

    expect(resolution.testCommands.map((command) => command.command)).toContain(
      "PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m unittest discover -s tests -q"
    );
  });

  it("does not run python -m pytest after python command not found", async () => {
    const root = await createTempDir("resolver-python3");
    await mkdir(path.join(root, "tests"), { recursive: true });
    await writeFile(path.join(root, "tests", "test_sample.py"), "import unittest\n");
    const previous = makeLedgerCommandResult({
      command: "python -m pytest",
      exitCode: 127,
      stderr: "python: command not found"
    });

    const resolution = await resolveTargetProjectCommands({
      projectRoot: root,
      projectKind: "folder",
      previousCommandResults: [previous]
    });

    expect(resolution.testCommands.some((command) => command.command.includes("python -m pytest"))).toBe(false);
    expect(resolution.testCommands.every((command) => !/\bpython\s+-m\b/.test(command.command))).toBe(true);
  });

  it("uses pytest when declared", async () => {
    const root = await createTempDir("resolver-pytest");
    await mkdir(path.join(root, "tests"), { recursive: true });
    await writeFile(path.join(root, "pyproject.toml"), "[project]\ndependencies = ['pytest']\n");
    await writeFile(path.join(root, "tests", "test_sample.py"), "def test_ok():\n    assert True\n");

    const resolution = await resolveTargetProjectCommands({ projectRoot: root, projectKind: "folder" });

    expect(resolution.testCommands.map((command) => command.command)).toContain("PYTHONDONTWRITEBYTECODE=1 python3 -m pytest");
  });

  it("uses a generic Git sanity check when no project validation command exists", async () => {
    const root = await createTempDir("resolver-git-fallback");
    await writeFile(path.join(root, "README.md"), "# Empty project\n");
    await initGitRepo(root);
    await commitAll(root, "initial");

    const resolution = await resolveTargetProjectCommands({ projectRoot: root, projectKind: "git" });

    expect(resolution.testCommands.map((command) => command.command)).toEqual([
      "git diff --check && git status --short --untracked-files=all"
    ]);
  });

  it("does not add the generic Git sanity check when project validation commands exist", async () => {
    const root = await createTempDir("resolver-git-with-package");
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "echo ok" } }, null, 2));
    await initGitRepo(root);
    await commitAll(root, "initial");

    const resolution = await resolveTargetProjectCommands({ projectRoot: root, projectKind: "git" });

    expect(resolution.testCommands.map((command) => command.command)).toEqual(["npm test"]);
  });

  it("marks live HTTP evidence commands approval-required", async () => {
    const root = await createTempDir("resolver-evidence");
    const resolved = await resolveEvidenceCommandsForExecution(root, [{
      name: "live status",
      command: "curl https://example.com/status",
      purpose: "Live status",
      expectedOutput: "json",
      mapsToChecklistGroups: [],
      mapsToCheckIds: ["check-live"],
      safeDefault: false,
      requiresNetwork: true,
      requiresCredentials: false,
      discoveredFrom: "manual",
      confidence: 0.5
    }]);

    expect(resolved.runnable).toHaveLength(0);
    expect(resolved.skipped[0]?.approvalRequired).toBe(true);
    expect(resolved.skipped[0]?.skipReason).toContain("network");
  });
});

describe("target repo hygiene scanner", () => {
  const createGitTarget = async (name: string): Promise<string> => {
    const root = await createTempDir(name);
    await initGitRepo(root);
    return root;
  };

  it("blocks EADME.md before merge", async () => {
    const root = await createGitTarget("hygiene-eadme");
    await writeFile(path.join(root, "EADME.md"), "typo\n");

    const report = await scanAndCleanRepoHygiene({
      projectRoot: root,
      projectKind: "git",
      runtimeSettings: localRuntimeSettings,
      scannedRef: "test",
      clean: true
    });

    expect(report.status).toBe("failed");
    expect(report.mergeBlockingFindings.join(" ")).toContain("EADME.md");
  });

  it("blocks ocs when docs exists", async () => {
    const root = await createGitTarget("hygiene-ocs");
    await mkdir(path.join(root, "docs"), { recursive: true });
    await mkdir(path.join(root, "ocs"), { recursive: true });
    await writeFile(path.join(root, "ocs", "core-portfolio-analytics-evidence.md"), "evidence\n");

    const report = await scanAndCleanRepoHygiene({
      projectRoot: root,
      projectKind: "git",
      runtimeSettings: localRuntimeSettings,
      scannedRef: "test",
      clean: true
    });

    expect(report.status).toBe("failed");
    expect(report.mergeBlockingFindings.join(" ")).toContain("ocs/");
  });

  it("cleans Python bytecode artifacts and records cleaned files", async () => {
    const root = await createGitTarget("hygiene-pyc");
    await mkdir(path.join(root, "src", "foo", "__pycache__"), { recursive: true });
    await writeFile(path.join(root, "src", "foo", "__pycache__", "bar.pyc"), "bytecode");

    const report = await scanAndCleanRepoHygiene({
      projectRoot: root,
      projectKind: "git",
      runtimeSettings: localRuntimeSettings,
      scannedRef: "test",
      clean: true
    });

    expect(report.cleanedFiles.some((entry) => entry.includes("__pycache__"))).toBe(true);
    expect(report.mergeBlockingFindings).toEqual([]);
    await expect(stat(path.join(root, "src", "foo", "__pycache__"))).rejects.toThrow();
  });

  it("allows valid README and docs changes", async () => {
    const root = await createGitTarget("hygiene-valid-docs");
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(path.join(root, "README.md"), "readme\n");
    await writeFile(path.join(root, "docs", "design.md"), "design\n");

    const report = await scanAndCleanRepoHygiene({
      projectRoot: root,
      projectKind: "git",
      runtimeSettings: localRuntimeSettings,
      scannedRef: "test",
      clean: true
    });

    expect(report.mergeBlockingFindings).toEqual([]);
  });

  it("blocks secret-looking values in changed files", async () => {
    const root = await createGitTarget("hygiene-secret");
    await writeFile(path.join(root, "config.env"), "API_KEY=sk-abcdefghijklmnopqrstuvwxyz\n");

    const report = await scanAndCleanRepoHygiene({
      projectRoot: root,
      projectKind: "git",
      runtimeSettings: localRuntimeSettings,
      scannedRef: "test",
      clean: true
    });

    expect(report.status).toBe("failed");
    expect(report.mergeBlockingFindings.join(" ")).toContain("secret-looking");
  });
});

describe("merge gate decisions", () => {
  const passedLedger = () => finalizeValidationLedger({
    ...createValidationLedger({ cycleNumber: 1, testCommands: ["npm test"] }),
    commandResults: [makeLedgerCommandResult({ command: "npm test", exitCode: 0, stdout: "passed" })]
  });

  it("blocks merge when validation failed", () => {
    const ledger = finalizeValidationLedger({
      ...createValidationLedger({ cycleNumber: 1, testCommands: ["npm test"] }),
      commandResults: [makeLedgerCommandResult({ command: "npm test", exitCode: 1, stdout: "AssertionError" })]
    });

    expect(deriveMergeGateDecision({ ledger }).allowed).toBe(false);
  });

  it("blocks merge when hygiene failed", () => {
    const report = {
      status: "failed" as const,
      scannedAt: "2026-06-01T00:00:00.000Z",
      scannedRef: "test",
      forbiddenFiles: ["EADME.md"],
      cleanedFiles: [],
      warnings: [],
      mergeBlockingFindings: ["EADME.md looks like a typo."],
      summaryForHumans: "Repository hygiene blocked merge."
    };

    expect(deriveMergeGateDecision({ ledger: passedLedger(), repoHygieneReport: report }).allowed).toBe(false);
  });

  it("allows merge when validation and hygiene passed", () => {
    const report = {
      status: "passed" as const,
      scannedAt: "2026-06-01T00:00:00.000Z",
      scannedRef: "test",
      forbiddenFiles: [],
      cleanedFiles: [],
      warnings: [],
      mergeBlockingFindings: [],
      summaryForHumans: "Repository hygiene passed."
    };

    expect(deriveMergeGateDecision({ ledger: passedLedger(), repoHygieneReport: report }).allowed).toBe(true);
  });

  it("does not let auto-approve push semantics bypass gates", () => {
    const ledger = finalizeValidationLedger(createValidationLedger({ cycleNumber: 1 }));

    expect(deriveMergeGateDecision({ ledger }).allowed).toBe(false);
  });
});

describe("github helpers", () => {
  it("detects GitHub remotes and derives owner/repo information", () => {
    expect(isGitHubRemote("git@github.com:OpenAI/agentic-workbench.git")).toBe(true);
    expect(isGitHubRemote("https://github.com/OpenAI/agentic-workbench.git")).toBe(true);
    expect(isGitHubRemote("git@gitlab.com:OpenAI/agentic-workbench.git")).toBe(false);
    expect(parseGitHubRemote("git@github.com:OpenAI/agentic-workbench.git")).toEqual({
      owner: "OpenAI",
      repo: "agentic-workbench"
    });
    expect(parseGitHubRemote("https://github.com/OpenAI/agentic-workbench")).toEqual({
      owner: "OpenAI",
      repo: "agentic-workbench"
    });
    expect(buildGitHubSshRemoteUrl("OpenAI", "agentic-workbench")).toBe("git@github.com:OpenAI/agentic-workbench.git");
    expect(buildGitHubRepositoryName("Agentic Workbench!")).toBe("agentic-workbench");
  });
});

describe("approval policy", () => {
  it("classifies git commit and push approvals separately from other commands", () => {
    expect(classifyCommandApproval("git commit -m \"msg\"")).toBe("git-commit");
    expect(classifyCommandApproval("git -c user.name=AWB commit -m \"msg\"")).toBe("git-commit");
    expect(classifyCommandApproval("sudo git push origin main")).toBe("git-push");
    expect(classifyCommandApproval("npm test")).toBe("command");
  });

  it("applies the configured auto-approval toggles to command approvals", () => {
    expect(
      shouldAutoApproveApproval(
        {
          kind: "command",
          command: "git commit -m \"msg\""
        },
        {
          autoApproveCommands: false,
          autoApproveGitCommits: true,
          autoApproveGitPushes: false
        }
      )
    ).toBe(true);

    expect(
      shouldAutoApproveApproval(
        {
          kind: "command",
          command: "git push origin main"
        },
        {
          autoApproveCommands: false,
          autoApproveGitCommits: false,
          autoApproveGitPushes: true
        }
      )
    ).toBe(true);

    expect(
      shouldAutoApproveApproval(
        {
          kind: "command",
          command: "npm test"
        },
        {
          autoApproveCommands: false,
          autoApproveGitCommits: true,
          autoApproveGitPushes: true
        }
      )
    ).toBe(false);
  });
});

describe("identity and validation", () => {
  it("distinguishes exact and stale snapshots", () => {
    const identity = createProjectIdentity({
      kind: "git",
      projectRoot: "/repo",
      projectName: "repo",
      manifestSignature: "m1",
      treeSignature: "t1",
      normalizedRemotes: ["git@example/repo"],
      rootCommit: "abc"
    });
    const current = {
      interfaceSchemaVersion: 1,
      appMinVersion: "0.1.0",
      lastValidatedAt: "2026-04-07T00:00:00.000Z",
      gitHead: "head-1",
      branch: "main",
      manifestHash: "m1",
      treeHash: "t1",
      projectKind: "git" as const
    };
    expect(calculateValidationStatus(identity, identity, current, current)).toBe("exact");
    expect(
      calculateValidationStatus(identity, identity, { ...current, treeHash: "changed" }, current)
    ).toBe("stale");
  });

  it("keeps the repository fingerprint stable across tree and manifest changes for git projects", () => {
    const base = createProjectIdentity({
      kind: "git",
      projectRoot: "/repo",
      projectName: "repo",
      repositoryName: "repo",
      normalizedRemotes: ["git@example/repo"],
      rootCommit: "root-1",
      manifestSignature: "manifest-a",
      treeSignature: "tree-a"
    });
    const changed = createProjectIdentity({
      kind: "git",
      projectRoot: "/repo",
      projectName: "repo",
      repositoryName: "repo",
      normalizedRemotes: ["git@example/repo"],
      rootCommit: "root-1",
      manifestSignature: "manifest-b",
      treeSignature: "tree-b"
    });

    expect(base.fingerprint).toBe(changed.fingerprint);
  });
});

describe("manifest parsing", () => {
  it("parses package and python manifests", async () => {
    const root = await createTempDir("manifest");
    await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { react: "^19.0.0" } }, null, 2));
    await writeFile(path.join(root, "requirements.txt"), "fastapi==0.115.0\nuvicorn>=0.31.0\n");

    const npmDeps = await parseManifestFile(root, "package.json");
    const pyDeps = await parseManifestFile(root, "requirements.txt");

    expect(npmDeps[0]).toMatchObject({ name: "react", version: "^19.0.0" });
    expect(pyDeps.map((entry) => entry.name)).toEqual(["fastapi", "uvicorn"]);
  });
});

describe("repo stats", () => {
  it("scans a git repository deterministically", async () => {
    const root = await createTempDir("scan");
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await mkdir(path.join(root, "release", "win"), { recursive: true });
    await mkdir(path.join(root, ".electron-builder", "out"), { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "scan-project" }, null, 2));
    await writeFile(path.join(root, "package-lock.json"), "{ this lockfile is intentionally not parsed during scans");
    await writeFile(path.join(root, "src/index.ts"), "export function hello() { return 'hi'; }\n");
    await writeFile(path.join(root, ".gitignore"), "ignored.log\n");
    await writeFile(path.join(root, "ignored.log"), "do not index\n");
    await writeFile(path.join(root, "node_modules/pkg/index.js"), "module.exports = 1;\n");
    await writeFile(path.join(root, "release", "win", "app.exe"), "binary output\n");
    await writeFile(path.join(root, ".electron-builder", "out", "builder.json"), "{}\n");
    await initGitRepo(root);
    await commitAll(root, "initial");

    const scan = await scanRepository(root, {
      isGit: true,
      gitRoot: root,
      branch: "main",
      head: "head",
      rootCommit: "root",
      normalizedRemotes: []
    }, root);

    expect(scan.stats.totalFiles).toBeGreaterThan(scan.stats.includedFiles);
    expect(scan.stats.includedFiles).toBeGreaterThanOrEqual(3);
    expect(scan.stats.excludedFiles).toBeGreaterThanOrEqual(1);
    expect(scan.stats.excludedPaths.some((entry) => entry.path === ".git" && entry.kind === "directory")).toBe(true);
    expect(scan.stats.excludedPaths.some((entry) => entry.path === "node_modules" && entry.rule === "default")).toBe(true);
    expect(scan.stats.excludedPaths.some((entry) => entry.path === "release" && entry.rule === "default")).toBe(true);
    expect(scan.stats.excludedPaths.some((entry) => entry.path === ".electron-builder" && entry.rule === "default")).toBe(true);
    expect(scan.stats.excludedPaths.some((entry) => entry.path === "ignored.log" && entry.rule === "gitignore")).toBe(true);
    expect(scan.stats.fileTypeBreakdown.TypeScript).toBe(1);
    expect(scan.stats.entryPoints).toContain("src/index.ts");
    expect(scan.dependencies.length).toBe(0);
  });

  it("skips broken symlinks inside excluded node_modules paths", async () => {
    const root = await createTempDir("scan-broken-symlink");
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "node_modules", ".bin"), { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "scan-project" }, null, 2));
    await writeFile(path.join(root, "src/index.ts"), "export const value = 1;\n");
    await symlink("../missing-package/bin/acorn", path.join(root, "node_modules", ".bin", "acorn"));

    const scan = await scanRepository(root, {
      isGit: true,
      gitRoot: root,
      branch: "main",
      head: "head",
      rootCommit: "root",
      normalizedRemotes: []
    }, root);

    expect(scan.files.some((file) => file.relativePath.startsWith("node_modules/"))).toBe(false);
    expect(scan.stats.excludedPaths.some((entry) => entry.path === "node_modules" && entry.rule === "default")).toBe(true);
    expect(scan.stats.entryPoints).toContain("src/index.ts");
  });

  it("caps large scans and records truncation metadata", async () => {
    const root = await createTempDir("scan-large-cap");
    await mkdir(path.join(root, "src"), { recursive: true });
    for (let index = 0; index < 20; index += 1) {
      await writeFile(path.join(root, "src", `file-${index}.ts`), `export const value${index} = ${index};\n`);
    }

    const scan = await scanRepository(root, {
      isGit: false,
      normalizedRemotes: []
    }, root, {
      maxIncludedFiles: 5,
      maxIncludedDirectories: 20,
      maxDepth: 10,
      maxScanDurationMs: 10_000
    });

    expect(scan.files).toHaveLength(5);
    expect(scan.stats.truncated).toBe(true);
    expect(scan.stats.truncationReasons).toContain("included_file_limit");
    expect(scan.stats.includedFileLimit).toBe(5);
    expect(scan.stats.totalFiles).toBeGreaterThan(scan.stats.includedFiles);
    expect(scan.stats.omittedFilesEstimate).toBeGreaterThan(0);
  });

  it("ignores common generated and cache directories by default", async () => {
    const root = await createTempDir("scan-expanded-ignores");
    const ignoredDirectories = [".gradle", ".idea", ".vscode", ".yarn", ".pnpm-store", ".pytest_cache", ".mypy_cache", ".ruff_cache", "vendor", "Pods", "DerivedData", ".terraform"];
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src/index.ts"), "export const value = 1;\n");
    for (const directory of ignoredDirectories) {
      await mkdir(path.join(root, directory), { recursive: true });
      await writeFile(path.join(root, directory, "generated.txt"), "generated\n");
    }

    const scan = await scanRepository(root, {
      isGit: false,
      normalizedRemotes: []
    }, root);

    for (const directory of ignoredDirectories) {
      expect(scan.files.some((file) => file.relativePath.startsWith(`${directory}/`))).toBe(false);
      expect(scan.stats.excludedPaths.some((entry) => entry.path === directory && entry.rule === "default")).toBe(true);
    }
    expect(scan.stats.entryPoints).toContain("src/index.ts");
  });

  it("recursively accounts for ignored directory size without indexing ignored files", async () => {
    const root = await createTempDir("scan-excluded-size");
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "pkg", "nested"), { recursive: true });
    await writeFile(path.join(root, "src/index.ts"), "export const value = 1;\n");
    await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "x".repeat(512));
    await writeFile(path.join(root, "node_modules", "pkg", "nested", "bundle.js"), "y".repeat(1_536));

    const scan = await scanRepository(root, {
      isGit: false,
      normalizedRemotes: []
    }, root);

    const nodeModules = scan.stats.excludedPaths.find((entry) => entry.path === "node_modules");

    expect(scan.files.some((file) => file.relativePath.startsWith("node_modules/"))).toBe(false);
    expect(nodeModules).toMatchObject({
      kind: "directory",
      rule: "default",
      fileCount: 2,
      totalSizeBytes: 2_048
    });
    expect(scan.stats.excludedFiles).toBe(2);
    expect(scan.stats.excludedFolders).toBeGreaterThanOrEqual(3);
    expect(scan.stats.excludedSizeBytes).toBe(2_048);
    expect(scan.stats.totalSizeBytes).toBe(scan.stats.includedSizeBytes + scan.stats.excludedSizeBytes);
    expect(scan.stats.totalSizeBytes).toBeGreaterThan(scan.stats.includedSizeBytes);
  });

  it("can disable ignore rules for full deep scans", async () => {
    const root = await createTempDir("scan-no-ignore-rules");
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(root, ".gitignore"), "ignored.log\n");
    await writeFile(path.join(root, "src/index.ts"), "export const value = 1;\n");
    await writeFile(path.join(root, "ignored.log"), "normally ignored\n");
    await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");

    const metadata = {
      isGit: false,
      normalizedRemotes: []
    };
    const normalScan = await scanRepository(root, metadata, root);
    const fullScan = await scanRepository(root, metadata, root, {}, { ignoreMode: "none" });
    const fullScanPaths = fullScan.files.map((file) => file.relativePath);

    expect(normalScan.files.some((file) => file.relativePath.startsWith("node_modules/"))).toBe(false);
    expect(normalScan.files.some((file) => file.relativePath === "ignored.log")).toBe(false);
    expect(normalScan.stats.excludedPaths.some((entry) => entry.path === "node_modules")).toBe(true);
    expect(normalScan.stats.excludedPaths.some((entry) => entry.path === "ignored.log")).toBe(true);
    expect(fullScanPaths).toContain("node_modules/pkg/index.js");
    expect(fullScanPaths).toContain("ignored.log");
    expect(fullScan.stats.excludedFiles).toBe(0);
    expect(fullScan.stats.excludedFolders).toBe(0);
    expect(fullScan.stats.excludedPaths).toHaveLength(0);
    expect(fullScan.stats.includedFiles).toBeGreaterThan(normalScan.stats.includedFiles);
  });

  it("skips dependency parsing for oversized manifests", async () => {
    const root = await createTempDir("scan-huge-manifest");
    await writeFile(path.join(root, "package.json"), "{".repeat(128));

    const scan = await scanRepository(root, {
      isGit: false,
      normalizedRemotes: []
    }, root, {
      maxManifestFileSizeBytes: 16
    });

    expect(scan.stats.manifestFiles).toContain("package.json");
    expect(scan.dependencies).toHaveLength(0);
    expect(scan.stats.skippedManifestFiles).toBe(1);
    expect(scan.stats.truncationReasons).toContain("manifest_file_size");
  });
});

describe("repository tree rows", () => {
  it("builds rows only from loaded and expanded repository pages", () => {
    const childrenByParent = {
      [REPOSITORY_ROOT_PARENT]: {
        projectId: "project",
        parentPath: REPOSITORY_ROOT_PARENT,
        limit: 2,
        total: 2,
        children: [
          { path: "src", name: "src", type: "directory" as const, childCount: 3 },
          { path: "README.md", name: "README.md", type: "file" as const, size: 200, language: "Markdown" }
        ],
        truncated: false
      },
      src: {
        projectId: "project",
        parentPath: "src",
        limit: 3,
        total: 3,
        children: [
          { path: "src/a.ts", name: "a.ts", type: "file" as const, size: 10, language: "TypeScript" },
          { path: "src/b.ts", name: "b.ts", type: "file" as const, size: 10, language: "TypeScript" },
          { path: "src/c.ts", name: "c.ts", type: "file" as const, size: 10, language: "TypeScript" }
        ],
        truncated: false
      }
    };

    expect(buildRepositoryTreeRows({ childrenByParent, expandedPaths: [] }).map((row) => row.path)).toEqual([
      "src",
      "README.md"
    ]);
    expect(buildRepositoryTreeRows({ childrenByParent, expandedPaths: ["src"] }).map((row) => row.path)).toEqual([
      "src",
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "README.md"
    ]);
  });

  it("keeps search navigation separate from expandable tree rows", () => {
    const childrenByParent = {
      [REPOSITORY_ROOT_PARENT]: {
        projectId: "project",
        parentPath: REPOSITORY_ROOT_PARENT,
        limit: 2,
        total: 2,
        children: [
          { path: "src", name: "src", type: "directory" as const, childCount: 1 },
          { path: "package.json", name: "package.json", type: "file" as const, size: 100, language: "JSON" }
        ],
        truncated: false
      }
    };

    const rows = buildRepositoryTreeRows({
      childrenByParent,
      expandedPaths: []
    });

    expect(rows.map((row) => row.path)).toEqual([
      "src",
      "package.json"
    ]);
  });
});

describe("reasoning defaults", () => {
  const makeModel = ({ model, ...overrides }: Partial<Model> & Pick<Model, "model">): Model => ({
    id: model,
    model,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: model,
    description: "",
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Low reasoning" },
      { reasoningEffort: "medium", description: "Medium reasoning" },
      { reasoningEffort: "high", description: "High reasoning" },
      { reasoningEffort: "xhigh", description: "Extra high reasoning" }
    ],
    defaultReasoningEffort: "medium",
    inputModalities: ["text"],
    supportsPersonality: true,
    additionalSpeedTiers: [],
    isDefault: false,
    ...overrides,
    serviceTiers: overrides.serviceTiers ?? [],
    defaultServiceTier: overrides.defaultServiceTier ?? null
  });

  it("keeps interface reasoning cost-conscious unless explicitly overridden", () => {
    const costConsciousModel: Pick<DiscoveredModel, "model" | "displayName" | "description" | "supportedReasoningEfforts" | "defaultReasoningEffort"> = {
      model: "gpt-5.4-mini",
      displayName: "GPT-5.4 Mini",
      description: "Fast model",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
      defaultReasoningEffort: "medium"
    };
    const deeperModel: Pick<DiscoveredModel, "model" | "displayName" | "description" | "supportedReasoningEfforts" | "defaultReasoningEffort"> = {
      model: "gpt-5.4",
      displayName: "GPT-5.4",
      description: "General model",
      supportedReasoningEfforts: ["medium", "high", "xhigh"],
      defaultReasoningEffort: "high"
    };

    expect(getPreferredInterfaceCreationReasoningEffort(costConsciousModel)).toBe("low");
    expect(getPreferredInterfaceCreationReasoningEffort(deeperModel)).toBe("medium");
    expect(resolveInterfaceCreationReasoningEffort(deeperModel, "low")).toBe("medium");
    expect(resolveInterfaceCreationReasoningEffort(deeperModel, "xhigh")).toBe("xhigh");
  });

  it("auto-selects deeper reasoning for coding and lighter reasoning for simple merges", () => {
    const model: Pick<DiscoveredModel, "supportedReasoningEfforts"> = {
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh"]
    };

    expect(getAutomaticAgentReasoningEffort("coding", "Implement a workflow IPC refactor.", model)).toBe("xhigh");
    expect(getAutomaticAgentReasoningEffort("coding", "Fix a small label typo.", model)).toBe("high");
    expect(getAutomaticAgentReasoningEffort("merge", "Integrate validated work deterministically.", model)).toBe("low");
    expect(getAutomaticAgentReasoningEffort("merge", "Resolve merge conflicts across branches.", model)).toBe("medium");
    expect(getAutomaticAgentReasoningEffort("recommendation", "Recommend the next workflow checklist task group.", model)).toBe("medium");
    expect(getAutomaticAgentReasoningEffort("recommendation", "Recommend the next security architecture migration step.", model)).toBe("high");
  });

  it("clamps automatic and manual reasoning to supported model efforts", () => {
    const model: Pick<DiscoveredModel, "supportedReasoningEfforts"> = {
      supportedReasoningEfforts: ["low", "medium", "high"]
    };

    expect(resolveAgentReasoningEffort(model, "coding", "Implement the scoped task.", "auto")).toBe("high");
    expect(resolveAgentReasoningEffort(model, "manual", "Explain the repository.", "manual", "xhigh")).toBe("high");
    expect(resolveAgentReasoningEffort(model, "manual", "Explain the repository.", "manual", "low")).toBe("low");
  });

  it("surfaces hidden models from the newest discovered GPT generation", () => {
    const discovered = buildDiscoveredModels([
      makeModel({ model: "gpt-5.4-mini", displayName: "GPT-5.4 Mini" }),
      makeModel({ model: "gpt-5.5", displayName: "GPT-5.5", hidden: true, defaultReasoningEffort: "high" }),
      makeModel({ model: "gpt-4.1", displayName: "GPT-4.1", hidden: true })
    ]);

    expect(discovered.map((model) => model.model)).toContain("gpt-5.5");
    expect(discovered.map((model) => model.model)).not.toContain("gpt-4.1");
    expect(discovered[0]?.model).toBe("gpt-5.5");
    expect(discovered[0]?.recommendedForInterfaceCreation).toBe(true);
    expect(discovered[0]?.labels).toContain("CLI listed");
  });
});

describe("goal charter and autopilot strategy defaults", () => {
  const goal = {
    ...emptyUltimateGoal("user"),
    summary: "Build the workbench planner settings.",
    detailedIntent: "Give the user durable control over goal fidelity and strategy.",
    successCriteria: ["Original goal is preserved", "Strategy presets persist"],
    constraints: ["Keep IPC typed"],
    nonGoals: ["Do not implement planner behavior"],
    targetAudience: "Workbench operators",
    qualityBar: "Test-backed and bounded.",
    confirmedAt: "2026-04-12T00:00:00.000Z",
    lastUpdatedAt: "2026-04-12T00:00:00.000Z"
  };

  it("creates a default Goal Charter from an accepted Ultimate Goal", () => {
    const charter = createDefaultGoalCharter(goal, "2026-04-12T00:00:00.000Z");

    expect(charter.originalUltimateGoal.summary).toBe(goal.summary);
    expect(charter.currentEffectiveGoal.summary).toBe(goal.summary);
    expect(charter.nonNegotiableRequirements).toEqual(goal.successCriteria);
    expect(charter.explicitNonGoals).toEqual(goal.nonGoals);
    expect(charter.userConstraints).toEqual(goal.constraints);
    expect(charter.definitionOfDone).toEqual(goal.successCriteria);
    expect(charter.autopilotStrategy.presetId).toBe("balanced_autopilot");
  });

  it("defines strategy presets across all requested operating modes", () => {
    const presets = listAutopilotPresets();

    expect(presets.map((preset) => preset.label)).toEqual([
      "Exact Builder",
      "Goal-Focused",
      "Balanced Autopilot",
      "Creative Builder",
      "Experimental / Moonshot"
    ]);
    expect(presets.find((preset) => preset.id === "exact_builder")?.strategy.goalRestrictiveness).toBeGreaterThanOrEqual(90);
    expect(presets.find((preset) => preset.id === "experimental_moonshot")?.strategy.innovationLatitude).toBeGreaterThanOrEqual(90);
    expect(presets.every((preset) => preset.strategy.visualPreferences.theme)).toBe(true);
  });

  it("keeps Goal Charter renderer state bounded", () => {
    const identity = createProjectIdentity({
      kind: "git",
      projectRoot: "/repo",
      projectName: "repo",
      manifestSignature: "m1",
      treeSignature: "t1",
      normalizedRemotes: ["git@example/repo"],
      rootCommit: "abc"
    });
    const record = createLocalProjectRecord(
      "project-1",
      "/repo",
      "/repo",
      "/repo",
      "/repo",
      identity,
      {
        interfaceSchemaVersion: 1,
        appMinVersion: "0.1.0",
        projectKind: "git"
      }
    );
    const longText = "x".repeat(2_000);
    record.workflow.goalCharter = {
      ...createDefaultGoalCharter({ ...goal, summary: longText }, "2026-04-12T00:00:00.000Z"),
      nonNegotiableRequirements: Array.from({ length: 40 }, (_, index) => `${index}:${longText}`),
      proposedGoalChanges: Array.from({ length: 30 }, (_, index) => ({
        id: `proposal-${index}`,
        title: `Proposal ${index}`,
        summary: longText,
        rationale: longText,
        source: "detected" as const,
        proposedGoal: { ...goal, summary: longText },
        createdAt: "2026-04-12T00:00:00.000Z"
      }))
    };

    const sanitized = sanitizeProjectRecord(record, { renderer: true }).record.workflow.goalCharter;
    expect(sanitized.nonNegotiableRequirements).toHaveLength(16);
    expect(sanitized.proposedGoalChanges).toHaveLength(8);
    expect(sanitized.originalUltimateGoal.summary.length).toBeLessThanOrEqual(520);
    expect(sanitized.proposedGoalChanges[0]?.proposedGoal?.summary.length).toBeLessThanOrEqual(520);
  });
});

describe("strategic autopilot planner", () => {
  const timestamp = "2026-04-12T00:00:00.000Z";
  const makeStrategicWorkflow = (strategyOverrides: Partial<ReturnType<typeof defaultProjectWorkflowState>["goalCharter"]["autopilotStrategy"]> = {}) => {
    const workflow = defaultProjectWorkflowState();
    const goal = {
      ...emptyUltimateGoal("user"),
      summary: "Build a visual market analytics dashboard.",
      detailedIntent: "Create a GUI dashboard for portfolio risk, drawdown, and readable analytics workflows.",
      successCriteria: [
        "Dashboard shows portfolio risk metrics",
        "Dashboard includes drawdown analysis",
        "Dashboard remains readable and responsive"
      ],
      constraints: ["Keep typed IPC boundaries intact"],
      nonGoals: ["Do not add live trading"],
      targetAudience: "Portfolio analysts",
      qualityBar: "Polished, validated, and easy to inspect.",
      confirmedAt: timestamp,
      lastUpdatedAt: timestamp
    };
    workflow.ultimateGoal = goal;
    workflow.goalCharter = createDefaultGoalCharter(goal, timestamp);
    workflow.goalCharter.autopilotStrategy = {
      ...workflow.goalCharter.autopilotStrategy,
      ...strategyOverrides,
      visualPreferences: {
        ...workflow.goalCharter.autopilotStrategy.visualPreferences,
        ...strategyOverrides.visualPreferences
      },
      autonomyBudget: {
        ...workflow.goalCharter.autopilotStrategy.autonomyBudget,
        ...strategyOverrides.autonomyBudget
      }
    };
    workflow.goalChecklist = [
      makeGoalCheck({
        id: "risk",
        title: "Dashboard shows portfolio risk metrics",
        status: "unmet",
        relatedPaths: ["src/renderer/App.tsx"]
      }),
      makeGoalCheck({
        id: "drawdown",
        title: "Dashboard includes drawdown analysis",
        status: "unmet",
        relatedPaths: ["src/analytics/drawdown.ts"]
      }),
      makeGoalCheck({
        id: "responsive",
        title: "Dashboard remains readable and responsive",
        status: "unmet",
        relatedPaths: ["src/renderer/styles.css"]
      })
    ];
    return workflow;
  };
  const planFor = (
    workflow: ReturnType<typeof makeStrategicWorkflow>,
    recommendations: WorkflowRecommendationOption[],
    options: { isVisualProject?: boolean; failedCommands?: string[]; changedFiles?: string[]; sourceAgentId?: string } = {}
  ) => buildStrategicPlan({
    projectId: "project-1",
    workflow,
    recommendations,
    workPackages: workflow.workPackages,
    isVisualProject: options.isVisualProject ?? true,
    validationCommands: ["npm run typecheck", "npm run lint", "npm test", "npm run build"],
    failedCommands: options.failedCommands ?? [],
    changedFiles: options.changedFiles ?? ["src/renderer/App.tsx", "src/renderer/styles.css"],
    sourceAgentId: options.sourceAgentId ?? "planner-agent",
    autopilotEnabled: true,
    now: timestamp
  });

  it("uses restrictiveness 100 to choose strict explicit-goal tasks", () => {
    const workflow = makeStrategicWorkflow({ goalRestrictiveness: 100, taskBatchingAggressiveness: "medium" });
    const plan = planFor(workflow, [
      makeRecommendation({ id: "ops", rank: 1, title: "Tighten operator feedback", confidence: 0.99, targetedCheckIds: undefined }),
      makeRecommendation({ id: "risk", rank: 2, title: "Satisfy goal check: Dashboard shows portfolio risk metrics", targetedCheckIds: ["risk"], confidence: 0.78 })
    ]);

    expect(plan.candidateTasks[0]?.recommendationId).toBe("risk");
  });

  it("uses restrictiveness 60 to allow small beneficial improvements", () => {
    const workflow = makeStrategicWorkflow({ goalRestrictiveness: 60, validationStrictness: "high" });
    const plan = planFor(workflow, [
      makeRecommendation({ id: "coverage", title: "Add regression coverage around dashboard risk metrics", summary: "A small verification improvement that supports the dashboard goal.", confidence: 0.86, riskLevel: "low" }),
      makeRecommendation({ id: "generic", title: "Explore unrelated repository cleanup", summary: "A broad cleanup pass.", confidence: 0.9 })
    ]);

    expect(plan.candidateTasks[0]?.recommendationId).toBe("coverage");
    expect(plan.candidateTasks[0]?.expectedValidationCommands.length).toBeGreaterThan(1);
  });

  it("uses restrictiveness 30 to propose meaningful checklist expansion", () => {
    const workflow = makeStrategicWorkflow({ goalRestrictiveness: 30, innovationLatitude: 75 });
    const plan = planFor(workflow, [
      makeRecommendation({ id: "slice", title: "Ship one bounded slice in dashboard exports", summary: "Add a useful adjacent export workflow.", confidence: 0.7 })
    ], { sourceAgentId: "recommendation-agent" });

    expect(plan.proposedChecklistChanges).toHaveLength(1);
    expect(plan.proposedChecklistChanges[0]).toMatchObject({
      action: "add",
      sourceCycle: workflow.workflowCycle.cycleNumber,
      sourceAgent: "recommendation-agent",
      userApprovalStatus: "pending"
    });
  });

  it("uses restrictiveness 0 to propose divergent related goal changes without rewriting the original goal", () => {
    const workflow = makeStrategicWorkflow({ goalRestrictiveness: 0, innovationLatitude: 100, taskBatchingAggressiveness: "very_high" });
    const originalSummary = workflow.goalCharter.originalUltimateGoal.summary;
    const plan = planFor(workflow, [
      makeRecommendation({ id: "moonshot", title: "Explore a new analytics command center direction", summary: "Divergent but related dashboard direction.", confidence: 0.7 })
    ]);

    expect(plan.proposedGoalChanges).toHaveLength(1);
    expect(plan.requiresApproval).toBe(true);
    expect(workflow.goalCharter.originalUltimateGoal.summary).toBe(originalSummary);
  });

  it("uses batching settings to choose narrow tasks or coherent work packages", () => {
    const narrow = makeRecommendation({ id: "narrow", title: "Satisfy goal check: Dashboard shows portfolio risk metrics", targetedCheckIds: ["risk"], confidence: 0.82 });
    const batch = makeRecommendation({ id: "batch", title: "Satisfy work package: dashboard analytics", targetedCheckIds: ["risk", "drawdown", "responsive"], confidence: 0.82, estimatedScope: "medium" });

    expect(planFor(makeStrategicWorkflow({ taskBatchingAggressiveness: "low" }), [batch, narrow]).candidateTasks[0]?.recommendationId).toBe("narrow");
    expect(planFor(makeStrategicWorkflow({ taskBatchingAggressiveness: "high" }), [narrow, batch]).candidateTasks[0]?.recommendationId).toBe("batch");
  });

  it("avoids repetitive low-value tasks and respects risk tolerance", () => {
    const workflow = makeStrategicWorkflow({ riskTolerance: "low" });
    workflow.memory.lastAcceptedDecisions = [{
      id: "decision-1",
      kind: "recommendation",
      title: "Stabilize recent work in dashboard",
      summary: "Repeated low-value stabilization.",
      decidedAt: timestamp,
      cycleNumber: 1
    }];
    const plan = planFor(workflow, [
      makeRecommendation({ id: "repeat", title: "Stabilize recent work in dashboard", confidence: 0.99, riskLevel: "low" }),
      makeRecommendation({ id: "risky", title: "Change runtime command execution for dashboard", confidence: 0.95, riskLevel: "high" }),
      makeRecommendation({ id: "safe", title: "Satisfy goal check: Dashboard includes drawdown analysis", targetedCheckIds: ["drawdown"], confidence: 0.78, riskLevel: "low" })
    ]);

    expect(plan.candidateTasks[0]?.recommendationId).toBe("safe");
    expect(plan.candidateTasks.find((task) => task.recommendationId === "risky")?.approvalRequired).toBe(true);
  });

  it("creates visual design tasks for GUI projects when visual priority is high", () => {
    const workflow = makeStrategicWorkflow({
      visualPriority: "very_high",
      visualPreferences: {
        theme: "system",
        primaryColor: "#102747",
        accentColor: "#b56f3f",
        density: "spacious",
        feel: "premium",
        layoutPriority: "command_center",
        motionPreference: "subtle",
        accessibilityPriority: "high_contrast",
        designStrictness: "allow_model_improvement"
      }
    });
    const plan = planFor(workflow, [
      makeRecommendation({ id: "generic", title: "Ship one bounded slice in data loading", summary: "Add a repository data-loading slice.", relatedPaths: ["src/data/load.ts"], confidence: 0.7 })
    ], { isVisualProject: true, changedFiles: ["src/renderer/App.tsx", "src/renderer/styles.css"] });
    const visualTask = plan.candidateTasks.find((task) => task.kind === "visual_polish" && task.visualDesignImpact);

    expect(visualTask).toBeDefined();
    expect(visualTask?.summary).toContain("spacious density");
    expect(visualTask?.summary).toContain("premium feel");
    expect(visualTask?.summary).toContain("command center layout priority");
    expect(visualTask?.whyNext).toContain("high-contrast accessibility");
    expect(plan.strategyHighlights.some((entry) => entry.includes("Visual preferences"))).toBe(true);
  });

  it("returns planner decisions with strategy settings and checklist targets", () => {
    const workflow = makeStrategicWorkflow({ goalRestrictiveness: 80 });
    const decision = selectNextWorkPackage({
      projectId: "project-1",
      workflow,
      recommendations: [
        makeRecommendation({ id: "risk", title: "Satisfy goal check: Dashboard shows portfolio risk metrics", targetedCheckIds: ["risk"] })
      ],
      isVisualProject: true,
      now: timestamp
    });

    expect(decision.selectedRecommendationId).toBe("risk");
    expect(decision.strategySettingsUsed.some((entry) => entry.includes("Goal restrictiveness 80"))).toBe(true);
    expect(decision.targetedChecklistIds).toEqual(["risk"]);
  });

  it("builds retrospectives with files, commands, validation outcome, and next tasks", () => {
    const workflow = makeStrategicWorkflow();
    workflow.approvedRecommendation = approveRecommendation(makeRecommendation({ id: "risk", title: "Satisfy goal check: Dashboard shows portfolio risk metrics", targetedCheckIds: ["risk"] }));
    workflow.scopedGoal = createScopedGoalFromRecommendation(workflow.approvedRecommendation, workflow.ultimateGoal);
    const codingAgent = {
      ...createAgentSkeleton("coding", "Coding", "Implement risk metrics", "gpt-5.4"),
      id: "coding-agent",
      status: "completed" as const,
      workflowCycleNumber: workflow.workflowCycle.cycleNumber,
      changedFiles: ["src/renderer/App.tsx"],
      commandLog: [{
        command: "npm test",
        output: "passed",
        status: "completed",
        startedAt: timestamp,
        completedAt: timestamp,
        exitCode: 0
      }]
    };
    const retrospective = buildCycleRetrospective({
      workflow,
      cycleNumber: workflow.workflowCycle.cycleNumber,
      agents: [codingAgent, makePassedIntegrityAgent()],
      shouldContinue: true,
      nextRecommendedTasks: ["Satisfy goal check: drawdown analysis"],
      now: timestamp
    });

    expect(retrospective.triedToDo).toContain("Satisfy goal check");
    expect(retrospective.changedFiles).toContain("src/renderer/App.tsx");
    expect(retrospective.commandsRun).toContain("npm test");
    expect(retrospective.passed).toContain("npm test");
    expect(retrospective.nextRecommendedTasks).toContain("Satisfy goal check: drawdown analysis");
  });
});

describe("summary cache", () => {
  it("invalidates when content hash changes", () => {
    const cache = new SummaryCache([
      {
        relativePath: "src/index.ts",
        pathKind: "file",
        contentHash: "one",
        title: "index.ts",
        purpose: "Entry point",
        summary: "Summary",
        keySymbols: ["hello"],
        relatedFiles: [],
        confidence: 0.8,
        source: "deterministic",
        generatedAt: "2026-04-07T00:00:00.000Z"
      }
    ]);

    expect(cache.get("src/index.ts", "one")).toBeTruthy();
    expect(cache.get("src/index.ts", "two")).toBeUndefined();
  });
});

describe("schema validation and IPC", () => {
  it("validates the portable interface format and IPC payloads", () => {
    const portable = portableInterfaceSchema.parse({
      schemaVersion: 1,
      appMinVersion: "0.1.0",
      exportedAt: "2026-04-07T00:00:00.000Z",
      checksum: "abc",
      identity: {
        version: 1,
        fingerprint: "fp",
        projectName: "repo",
        kind: "git",
        normalizedRemotes: [],
        manifestSignature: "m",
        treeSignature: "t"
      },
      validation: {
        interfaceSchemaVersion: 1,
        appMinVersion: "0.1.0",
        projectKind: "git"
      },
      layout: defaultLayout(),
      localStateDefaults: {
        ...defaultLocalState(),
        activeAgentId: "foreign-agent",
        autopilotEnabled: true,
        workflowPauseRequested: false
      },
      workflow: {
        ...defaultProjectWorkflowState(),
        autopilotPolicy: {
          ...defaultProjectWorkflowState().autopilotPolicy,
          enabled: true
        }
      },
      dependencies: [],
      summaryCache: [],
      agents: []
    });
    expect(portable.identity.projectName).toBe("repo");
    expect(portable.localStateDefaults).toMatchObject({
      activeAgentId: undefined,
      autopilotEnabled: false,
      workflowPauseRequested: true
    });
    expect(portable.workflow.autopilotPolicy.enabled).toBe(false);
    const untrustedPortableAgent = {
      ...createAgentSkeleton("coding", "Imported agent", "Imported history", "gpt-5.4"),
      id: "../../escape",
      status: "waiting_approval" as const,
      threadId: "foreign-live-thread",
      worktree: {
        baseDir: "/outside/worktrees",
        worktreePath: "/outside/worktrees/agent",
        branch: "untrusted"
      },
      approvals: [{
        id: "spoofed-approval",
        agentId: "../../escape",
        kind: "command" as const,
        threadId: "foreign-live-thread",
        serverRequestId: 41,
        summary: "Benign-looking approval",
        command: "arbitrary payload",
        cwd: "/outside",
        filePaths: [],
        createdAt: "2026-04-07T00:00:00.000Z",
        status: "pending" as const,
        availableDecisions: ["accept" as const]
      }],
      outputReference: {
        agentId: "../../escape",
        transcriptAvailable: true,
        fullOutputAvailable: true,
        updatedAt: "2026-04-07T00:00:00.000Z"
      }
    };
    expect(portableInterfaceSchema.safeParse({
      ...portable,
      agents: [untrustedPortableAgent]
    }).success).toBe(false);
    const portableWithMachineLocalWorktree = portableInterfaceSchema.parse({
      ...portable,
      agents: [{
        ...untrustedPortableAgent,
        id: "safe-agent",
        outputReference: { ...untrustedPortableAgent.outputReference, agentId: "safe-agent" },
        approvals: untrustedPortableAgent.approvals.map((approval) => ({ ...approval, agentId: "safe-agent" }))
      }]
    });
    expect(portableWithMachineLocalWorktree.agents[0]).toMatchObject({
      id: "safe-agent",
      status: "idle",
      approvals: []
    });
    expect(portableWithMachineLocalWorktree.agents[0]).not.toHaveProperty("worktree");
    expect(portableWithMachineLocalWorktree.agents[0]?.threadId).toBeUndefined();
    expect(portableWithMachineLocalWorktree.agents[0]?.outputReference).toBeUndefined();
    expect(projectLoadRequestSchema.parse({ inputPath: "/repo" }).inputPath).toBe("/repo");
    expect(projectLoadRequestSchema.parse({ inputPath: "/repo" }).creationMode).toBe("initialize_github");
    expect(projectLoadRequestSchema.parse({ inputPath: "/repo", intent: "create", creationMode: "use_folder_as_is" }).creationMode).toBe("use_folder_as_is");
    expect(chooseFolderRequestSchema.parse({ title: "Select the folder to use for this workspace", buttonLabel: "Use this folder" }).buttonLabel).toBe("Use this folder");
    expect(projectOpenRequestSchema.parse({ projectId: "saved-project" }).projectId).toBe("saved-project");
    expect(createAgentRequestSchema.parse({ projectId: "p", category: "coding", name: "Agent", prompt: "Do it", model: "gpt-5.4" }).category).toBe("coding");
    expect(credentialEntrySaveRequestSchema.parse({
      projectId: "p",
      providerName: "Polygon.io",
      keyLabel: "API key",
      apiKey: "secret"
    }).status).toBe("active");
    expect(credentialRequestUpdateSchema.parse({ projectId: "p", requestId: "r", status: "dismissed" }).status).toBe("dismissed");
    expect(credentialRequestSubmitToAgentSchema.parse({ projectId: "p", requestId: "r" }).requestId).toBe("r");
    expect(polishGoalCharterFieldRequestSchema.parse({
      projectId: "p",
      field: "currentConstraints",
      value: "keep it secure",
      currentDraft: { currentSummary: "Ship the app" },
      model: "gpt-5.4",
      reasoningEffort: "medium"
    }).field).toBe("currentConstraints");
    expect(generateGoalCharterDraftRequestSchema.parse({
      projectId: "p",
      prompt: "Build a complete platform game",
      currentDraft: { currentSummary: "Platform game" },
      model: "gpt-5.4",
      reasoningEffort: "high"
    }).reasoningEffort).toBe("high");
    expect(approvalDecisionRequestSchema.parse({ projectId: "p", agentId: "a", approvalId: "x", decision: "accept" }).decision).toBe("accept");
    expect(workflowDashboardRequestSchema.parse({
      projectId: "p",
      timeline: {
        from: "2026-04-01T00:00:00.000Z",
        to: new Date("2026-04-30T23:59:59.000Z"),
        limit: 25
      }
    }).timeline).toMatchObject({
      from: "2026-04-01T00:00:00.000Z",
      to: new Date("2026-04-30T23:59:59.000Z"),
      offset: 0,
      limit: 25
    });
    expect(downloadInterfaceRequestSchema.parse({ projectId: "p" }).projectId).toBe("p");
    expect(downloadLogsRequestSchema.parse({ projectId: "p" }).projectId).toBe("p");
    expect(visualExportStartRequestSchema.parse({
      projectId: "p",
      tabs: [{ id: "overview", label: "Overview" }]
    }).tabs[0].id).toBe("overview");
    expect(visualExportCaptureRequestSchema.parse({
      exportId: "export-1",
      target: {
        tab: { id: "logs", label: "Logs" },
        pageIndex: 1,
        pageCount: 3,
        scrollY: 900,
        cropTop: 0,
        sliceHeight: 900,
        viewportWidth: 1440,
        viewportHeight: 900
      }
    }).target.tab.id).toBe("logs");
    expect(visualExportSessionRequestSchema.parse({ exportId: "export-1" }).exportId).toBe("export-1");
    expect(refreshOverviewRequestSchema.parse({ projectId: "p" }).projectId).toBe("p");
    expect(agentListRequestSchema.parse({ projectId: "p", scope: "workflow" }).limit).toBe(20);
    expect(agentDetailRequestSchema.parse({ projectId: "p", agentId: "a" }).agentId).toBe("a");
    expect(projectLogFeedRequestSchema.parse({ projectId: "p" }).commandLimit).toBe(50);
    expect(projectRepositoryChildrenRequestSchema.parse({ projectId: "p" }).limit).toBe(120);
    expect(projectRepositorySearchRequestSchema.parse({ projectId: "p", query: "src" }).limit).toBe(120);
    expect(projectRepositoryChildrenRequestSchema.parse({ projectId: "p", limit: 5_000 }).limit).toBe(5_000);
    expect(projectRepositorySearchRequestSchema.parse({ projectId: "p", query: "src", limit: 5_000 }).limit).toBe(5_000);
    expect(projectRepositoryExcludedPathsRequestSchema.parse({ projectId: "p" }).limit).toBe(120);
    expect(repositoryScanSettingsRequestSchema.parse({
      projectId: "p",
      settings: { maxIncludedFiles: 24_000, maxDepth: 64 }
    }).settings.maxDepth).toBe(64);
    expect(repositoryRescanRequestSchema.parse({
      projectId: "p",
      options: { mode: "deep", settings: { maxIncludedFiles: 24_000 } }
    }).options.mode).toBe("deep");
    expect(repositoryPathSummaryRequestSchema.parse({
      projectId: "p",
      relativePath: "src\\renderer\\App.tsx",
      model: "gpt-5.4",
      reasoningMode: "manual",
      reasoningEffort: "high"
    }).relativePath).toBe("src/renderer/App.tsx");
    expect(repositoryPathQuestionRequestSchema.parse({
      projectId: "p",
      relativePath: "src/runtime",
      question: "What does this folder do?",
      model: "gpt-5.4"
    }).question).toBe("What does this folder do?");
    expect(repositoryPathWindowRequestSchema.parse({
      projectId: "p",
      relativePath: "src/runtime",
      initialQuestion: "Explain this folder."
    }).initialQuestion).toBe("Explain this folder.");
    expect(() => repositoryPathSummaryRequestSchema.parse({ projectId: "p", relativePath: "../secret.txt", model: "gpt-5.4" })).toThrow();
    expect(() => repositoryPathSummaryRequestSchema.parse({ projectId: "p", relativePath: "/etc/passwd", model: "gpt-5.4" })).toThrow();
    expect(() => repositoryPathWindowRequestSchema.parse({ projectId: "p", relativePath: "C:\\repo\\file.ts" })).toThrow();
  });

  it("validates the project review log bundle format", () => {
    const bundle = projectReviewLogBundleSchema.parse({
      schemaVersion: 1,
      appVersion: "0.1.0",
      exportedAt: "2026-04-07T00:00:00.000Z",
      context: {
        executionMode: "local",
        distroName: "Ubuntu",
        mockMode: false,
        maxRepairCycles: 3,
        interfaceCreationModel: "gpt-5.4",
        interfaceCreationReasoningEffort: "medium",
        autoApproveCommands: false,
        autoApproveGitCommits: false,
        autoApproveGitPushes: false,
        considerPaidServices: false
      },
      summary: {
        projectName: "repo",
        projectKind: "git",
        validationStatus: "exact",
        workflowStage: "charter_needed",
        workflowStopReason: "charter_missing",
        cycleNumber: 1,
        autopilotEnabled: false,
        workflowObjective: "deliver",
        workflowPauseRequested: false,
        totalAgents: 0,
        totalCommands: 0,
        totalEvents: 0,
        totalApprovals: 0,
        pendingApprovals: 0,
        pendingUserInputRequests: 0,
        openIssues: 0,
        agentCountsByCategory: {
          bootstrap: 0
        },
        agentCountsByStatus: {
          idle: 0
        }
      },
      redactions: ["Project root paths were replaced with <project-root>."],
      warnings: ["Command output may still contain repository content."],
      project: {
        id: "project-1",
        identity: {
          version: 1,
          fingerprint: "fp",
          projectName: "repo",
          kind: "git",
          normalizedRemotes: [],
          manifestSignature: "m",
          treeSignature: "t"
        },
        validation: {
          interfaceSchemaVersion: 1,
          appMinVersion: "0.1.0",
          lastValidatedAt: "2026-04-07T00:00:00.000Z",
          projectKind: "git"
        },
        localState: defaultLocalState(),
        workflow: defaultProjectWorkflowState(),
        dependencies: []
      },
      agents: [],
      userInputRequests: [],
      diagnostics: [],
      timeline: []
    });

    expect(bundle.summary.projectName).toBe("repo");
  });

  it("builds WSL execution plans for structured commands and shell commands", () => {
    const structuredPlan = buildStructuredExecutionPlan(
      {
        executionMode: "wsl",
        distroName: "Ubuntu"
      },
      {
        command: "codex",
        args: ["app-server"],
        cwd: "/home/nicot/project",
        env: {
          CODEX_HOME: "/home/nicot/.codex"
        }
      },
      "win32"
    );
    expect(structuredPlan.file).toBe("wsl.exe");
    expect(structuredPlan.args).toEqual([
      "-d",
      "Ubuntu",
      "--cd",
      "/home/nicot/project",
      "--exec",
      "env",
      "CODEX_HOME=/home/nicot/.codex",
      "codex",
      "app-server"
    ]);

    const shellPlan = buildShellExecutionPlan(
      {
        executionMode: "wsl",
        distroName: "Ubuntu"
      },
      {
        command: "npm run test",
        cwd: "/home/nicot/project"
      },
      "win32"
    );
    expect(shellPlan.file).toBe("wsl.exe");
    expect(shellPlan.args).toEqual([
      "-d",
      "Ubuntu",
      "--cd",
      "/home/nicot/project",
      "--exec",
      "bash",
      "-lc",
      "npm run test"
    ]);

    const shellPlanWithRuntime = buildShellExecutionPlan(
      {
        executionMode: "wsl",
        distroName: "Ubuntu"
      },
      {
        command: "npm run test",
        cwd: "/home/nicot/project",
        runtimePathDirs: ["/home/nicot/.nvm/versions/node/v22.22.0/bin"]
      },
      "win32"
    );
    expect(shellPlanWithRuntime.args).toEqual([
      "-d",
      "Ubuntu",
      "--cd",
      "/home/nicot/project",
      "--exec",
      "bash",
      "-lc",
      "export PATH='/home/nicot/.nvm/versions/node/v22.22.0/bin':$PATH; npm run test"
    ]);
  });

  it("builds WSL login-shell plans for resolved commands", () => {
    const launchPlan = buildWslLoginShellExecutionPlan(
      {
        executionMode: "wsl",
        distroName: "Ubuntu"
      },
      {
        command: "/home/nicot/.nvm/versions/node/v22.22.0/bin/codex",
        args: ["app-server"],
        cwd: "/home/nicot/project",
        env: {
          CODEX_HOME: "/home/nicot/.codex"
        },
        runtimePathDirs: ["/home/nicot/.nvm/versions/node/v22.22.0/bin"]
      },
      "win32"
    );

    expect(launchPlan.file).toBe("wsl.exe");
    expect(launchPlan.args).toEqual([
      "-d",
      "Ubuntu",
      "--cd",
      "/home/nicot/project",
      "--exec",
      "env",
      "CODEX_HOME=/home/nicot/.codex",
      "bash",
      "-lc",
      "export PATH='/home/nicot/.nvm/versions/node/v22.22.0/bin':$PATH; exec \"$@\"",
      "bash",
      "/home/nicot/.nvm/versions/node/v22.22.0/bin/codex",
      "app-server"
    ]);
  });

  it("builds a WSL codex runtime resolution probe that checks codex, node, and nvm bins", () => {
    const resolutionPlan = buildWslCodexRuntimeResolutionPlan(
      {
        distroName: "Ubuntu"
      },
      {
        command: "codex"
      }
    );

    expect(resolutionPlan.file).toBe("wsl.exe");
    expect(resolutionPlan.args).toEqual(["-d", "Ubuntu", "--exec", "bash", "-s", "--"]);
    expect(resolutionPlan.transport).toBe("stdin");
    expect(resolutionPlan.args.join(" ")).not.toContain("resolve_command");
    expect(resolutionPlan.args.join(" ")).not.toContain("expand_home_path");
    expect(resolutionPlan.shellCommand).toContain("resolve_command");
    expect(resolutionPlan.shellCommand).toContain("codex_command='codex'");
    expect(resolutionPlan.shellCommand).toContain("resolved_node");
    expect(resolutionPlan.shellCommand).toContain("$nvm_dir/current/bin");
    expect(resolutionPlan.shellCommand).toContain("$nvm_dir/versions/node");
    expect(resolutionPlan.shellCommand).toContain("__AWB_WSL_RESOLVED_CODEX__=");
    expect(resolutionPlan.shellCommand).toContain("__AWB_WSL_RESOLVED_NODE__=");
  });

  it("builds the exact WSL codex detection probe around bash -lc command -v", () => {
    const resolutionPlan = buildWslCommandResolutionPlan(
      {
        distroName: "Ubuntu"
      },
      {
        command: "codex"
      }
    );

    expect(resolutionPlan.file).toBe("wsl.exe");
    expect(resolutionPlan.args).toEqual([
      "-d",
      "Ubuntu",
      "bash",
      "-lc",
      "command -v 'codex'"
    ]);
    expect(resolutionPlan.transport).toBe("argv");
    expect(resolutionPlan.shellCommand).toBe("command -v 'codex'");
  });

  it("parses resolved WSL command output with user metadata", () => {
    expect(
      parseWslCommandResolutionOutput(
        "/home/nicot/.nvm/versions/node/v22.22.0/bin/codex\n__AWB_WSL_RESOLVED_USER__=nicot\n"
      )
    ).toEqual({
      resolvedCommand: "/home/nicot/.nvm/versions/node/v22.22.0/bin/codex",
      user: "nicot"
    });
  });

  it("parses resolved WSL codex runtime output with node metadata", () => {
    expect(
      parseWslCodexRuntimeResolutionOutput(
        [
          "__AWB_WSL_RESOLVED_USER__=nicot",
          "__AWB_WSL_RESOLVED_CODEX__=/home/nicot/.nvm/versions/node/v22.22.0/bin/codex",
          "__AWB_WSL_RESOLVED_NODE__=/home/nicot/.nvm/versions/node/v22.22.0/bin/node"
        ].join("\n")
      )
    ).toEqual({
      resolvedCodexCommand: "/home/nicot/.nvm/versions/node/v22.22.0/bin/codex",
      resolvedNodeCommand: "/home/nicot/.nvm/versions/node/v22.22.0/bin/node",
      user: "nicot"
    });
  });

  it("parses and compares Codex CLI versions for startup updates", () => {
    expect(parseCodexCliVersion("codex-cli 0.125.0")).toBe("0.125.0");
    expect(parseCodexCliVersion("warning\ncodex-cli 0.126.1\n")).toBe("0.126.1");
    expect(parseNpmPackageVersion("npm notice 11.0.0 is available\n0.126.1\n")).toBe("0.126.1");
    expect(compareCodexVersions("0.125.0", "0.126.0")).toBeLessThan(0);
    expect(compareCodexVersions("0.126.0", "0.126.0")).toBe(0);
    expect(compareCodexVersions("0.127.0", "0.126.0")).toBeGreaterThan(0);
  });

  it("reports Codex installed and current from a real version check result", async () => {
    const settings = {
      ...defaultSettings(),
      executionMode: "local" as const
    };
    const check = await checkCodexCliUpdate(settings, "linux", {
      supportedProtocolVersion: "0.128.0",
      commandRunner: {
        runCodexVersion: async () => "codex-cli 0.128.0",
        runNpmCommand: async () => "0.128.0\n"
      }
    });

    expect(check).toMatchObject({
      status: "up-to-date",
      currentVersion: "0.128.0",
      latestVersion: "0.128.0",
      updateAvailable: false
    });
  });

  it("reports Codex installed and outdated with the latest update command", async () => {
    const settings = {
      ...defaultSettings(),
      executionMode: "local" as const
    };
    const check = await checkCodexCliUpdate(settings, "linux", {
      supportedProtocolVersion: "0.128.0",
      commandRunner: {
        runCodexVersion: async () => "codex-cli 0.127.0",
        runNpmCommand: async () => "0.129.0\n"
      }
    });

    expect(check.status).toBe("outdated");
    expect(check.currentVersion).toBe("0.127.0");
    expect(check.latestVersion).toBe("0.129.0");
    expect(check.targetVersion).toBe("0.129.0");
    expect(check.updateAvailable).toBe(true);
    expect(check.updateCommand).toBe("npm install -g @openai/codex@0.129.0");
  });

  it("reports Codex missing when the installed version command fails", async () => {
    const settings = {
      ...defaultSettings(),
      executionMode: "local" as const
    };
    let npmCalls = 0;
    const check = await checkCodexCliUpdate(settings, "linux", {
      supportedProtocolVersion: "0.128.0",
      commandRunner: {
        runCodexVersion: async () => {
          throw new Error("codex not found");
        },
        runNpmCommand: async () => {
          npmCalls += 1;
          return "0.128.0\n";
        }
      }
    });

    expect(check.status).toBe("unavailable");
    expect(check.updateAvailable).toBe(false);
    expect(check.message).toContain("codex not found");
    expect(npmCalls).toBe(0);
  });

  it("explains when the latest Codex version is unavailable", async () => {
    const settings = {
      ...defaultSettings(),
      executionMode: "local" as const
    };
    const check = await checkCodexCliUpdate(settings, "linux", {
      supportedProtocolVersion: "0.128.0",
      commandRunner: {
        runCodexVersion: async () => "codex-cli 0.128.0",
        runNpmCommand: async () => "npm notice unable to contact registry"
      }
    });

    expect(check.status).toBe("unavailable");
    expect(check.currentVersion).toBe("0.128.0");
    expect(check.latestVersion).toBeUndefined();
    expect(check.message).toContain("latest Codex CLI version");
  });

  it("previews the exact Codex update command before update approval", () => {
    const settings = {
      ...defaultSettings(),
      executionMode: "local" as const
    };
    const wslSettings = {
      ...settings,
      executionMode: "wsl" as const,
      distroName: "Ubuntu"
    };

    expect(buildCodexUpdateCommand(settings, "linux", "0.128.0")).toBe("npm install -g @openai/codex@0.128.0");
    expect(buildCodexUpdateCommand(wslSettings, "win32", "0.128.0")).toBe("wsl -d \"Ubuntu\" -- npm install -g @openai/codex@0.128.0");
  });

  it("updates Codex with the target version and verifies the installed version afterward", async () => {
    const settings = {
      ...defaultSettings(),
      executionMode: "local" as const
    };
    let installedVersion = "0.127.0";
    let installArgs: string[] | undefined;

    const result = await updateCodexCliIfAvailable(settings, "linux", {
      supportedProtocolVersion: "0.128.0",
      commandRunner: {
        runCodexVersion: async () => `codex-cli ${installedVersion}`,
        runNpmCommand: async (args) => {
          if (args[0] === "view") {
            return "0.129.0\n";
          }
          installArgs = args;
          installedVersion = "0.129.0";
          return "updated\n";
        }
      }
    });

    expect(installArgs).toEqual(["install", "-g", "@openai/codex@0.129.0"]);
    expect(result).toMatchObject({
      status: "updated",
      currentVersion: "0.127.0",
      latestVersion: "0.129.0",
      updatedVersion: "0.129.0"
    });
  });

  it("updates Codex to the latest version when the bundled protocol supports it", async () => {
    const settings = {
      ...defaultSettings(),
      executionMode: "local" as const
    };
    let installedVersion = "0.128.0";
    let installArgs: string[] | undefined;

    const result = await updateCodexCliIfAvailable(settings, "linux", {
      supportedProtocolVersion: "0.140.0",
      commandRunner: {
        runCodexVersion: async () => `codex-cli ${installedVersion}`,
        runNpmCommand: async (args) => {
          if (args[0] === "view") {
            return "0.140.0\n";
          }
          installArgs = args;
          installedVersion = "0.140.0";
          return "updated\n";
        }
      }
    });

    expect(installArgs).toEqual(["install", "-g", "@openai/codex@0.140.0"]);
    expect(result).toMatchObject({
      status: "updated",
      currentVersion: "0.128.0",
      latestVersion: "0.140.0",
      updatedVersion: "0.140.0"
    });
  });

  it("updates Codex to the approved target when npm latest changes after preview", async () => {
    const settings = {
      ...defaultSettings(),
      executionMode: "local" as const
    };
    let installedVersion = "0.127.0";
    let installArgs: string[] | undefined;

    const result = await updateCodexCliIfAvailable(settings, "linux", {
      targetVersion: "0.128.0",
      commandRunner: {
        runCodexVersion: async () => `codex-cli ${installedVersion}`,
        runNpmCommand: async (args) => {
          if (args[0] === "view") {
            return "0.129.0\n";
          }
          installArgs = args;
          installedVersion = "0.128.0";
          return "updated\n";
        }
      }
    });

    expect(installArgs).toEqual(["install", "-g", "@openai/codex@0.128.0"]);
    expect(result).toMatchObject({
      status: "updated",
      currentVersion: "0.127.0",
      latestVersion: "0.129.0",
      updatedVersion: "0.128.0"
    });
  });

  it("checks Codex CLI updates during non-mock startup before readiness checks", async () => {
    const service = new AppService(await createTempDir("codex-startup-update")) as unknown as {
      settings: ReturnType<typeof defaultSettings>;
      refreshGitHubStatus: (emitState: boolean) => Promise<void>;
      updateCodexCliOnStartup: () => Promise<void>;
      loadStoredProjects: () => Promise<void>;
      refreshRuntimeReadiness: (reason?: string) => Promise<unknown>;
      runStartupWork: (options: { emitState: boolean }) => Promise<void>;
    };
    const calls: string[] = [];
    service.settings = {
      ...defaultSettings(),
      executionMode: "local",
      mockMode: false
    };
    service.refreshGitHubStatus = async () => {
      calls.push("github");
    };
    service.updateCodexCliOnStartup = async () => {
      calls.push("codex-update");
    };
    service.loadStoredProjects = async () => {
      calls.push("projects");
    };
    service.refreshRuntimeReadiness = async () => {
      calls.push("runtime-readiness");
      return {};
    };

    await service.runStartupWork({ emitState: false });

    expect(calls).toEqual(["github", "codex-update", "projects", "runtime-readiness"]);
  });

  it("does not hydrate saved-project repository indexes during startup", async () => {
    const service = new AppService(await createTempDir("startup-repository-scan")) as unknown as {
      settings: ReturnType<typeof defaultSettings>;
      projects: Map<string, ReturnType<typeof makeAppServiceLoadedProject>>;
      refreshGitHubStatus: (emitState: boolean) => Promise<void>;
      updateCodexCliOnStartup: () => Promise<void>;
      loadStoredProjects: () => Promise<void>;
      refreshRuntimeReadiness: (reason?: string) => Promise<unknown>;
      rescanRepository: AppService["rescanRepository"];
      runStartupWork: (options: { emitState: boolean }) => Promise<void>;
    };
    const project = makeAppServiceLoadedProject("startup-scan-project");
    const calls: string[] = [];

    service.settings = {
      ...defaultSettings(),
      executionMode: "local",
      mockMode: false
    };
    service.refreshGitHubStatus = async () => {
      calls.push("github");
    };
    service.updateCodexCliOnStartup = async () => {
      calls.push("codex-update");
    };
    service.loadStoredProjects = async () => {
      calls.push("projects");
      service.projects.set(project.record.id, project);
    };
    service.refreshRuntimeReadiness = async () => {
      calls.push("runtime-readiness");
      return {};
    };
    service.rescanRepository = async (projectId) => {
      calls.push(`scan:${projectId}`);
      return {} as Awaited<ReturnType<AppService["rescanRepository"]>>;
    };

    await service.runStartupWork({ emitState: false });

    expect(calls).toEqual(["github", "codex-update", "projects", "runtime-readiness"]);
  });

  it("requires update command approval and rechecks readiness after an approved update", async () => {
    const updateCommand = "npm install -g @openai/codex@0.128.0";
    const service = new AppService(await createTempDir("codex-update-approval")) as unknown as {
      settings: ReturnType<typeof defaultSettings>;
      codexUpdateCheck: {
        checkedAt: string;
        currentVersion?: string;
        latestVersion?: string;
        updateAvailable: boolean;
        updateCommand?: string;
        status: "up-to-date" | "outdated" | "unavailable" | "skipped";
        message: string;
      };
      runCodexUpdate: AppService["runCodexUpdate"];
      refreshCodexReadiness: AppService["refreshCodexReadiness"];
      checkCodexUpdate: AppService["checkCodexUpdate"];
      restartTransportAfterCodexUpdate: () => Promise<void>;
    };
    service.settings = {
      ...defaultSettings(),
      executionMode: "local"
    };
    service.codexUpdateCheck = {
      checkedAt: "2026-06-11T00:00:00.000Z",
      currentVersion: "0.127.0",
      latestVersion: "0.128.0",
      updateAvailable: true,
      updateCommand,
      status: "outdated",
      message: "Codex CLI can be updated."
    };

    const unapproved = await service.runCodexUpdate();
    expect(unapproved.status).toBe("failed");
    expect(unapproved.message).toContain("not approved");

    let readinessRefreshes = 0;
    let updateRechecks = 0;
    let transportRestarts = 0;
    service.restartTransportAfterCodexUpdate = async () => {
      transportRestarts += 1;
    };
    service.refreshCodexReadiness = async () => {
      readinessRefreshes += 1;
      return {
        checkedAt: "2026-06-11T00:00:01.000Z",
        executionMode: "local",
        codexBinaryPath: "codex",
        codexCliExists: true,
        codexVersion: "0.128.0",
        latestCodexVersion: "0.128.0",
        updateAvailable: false,
        status: "ready",
        message: "Codex CLI 0.128.0 is available."
      };
    };
    service.checkCodexUpdate = async () => {
      updateRechecks += 1;
      return {
        checkedAt: "2026-06-11T00:00:02.000Z",
        currentVersion: "0.128.0",
        latestVersion: "0.128.0",
        updateAvailable: false,
        status: "up-to-date",
        message: "Codex CLI is up to date."
      };
    };

    let installedVersion = "0.127.0";
    const approved = await service.runCodexUpdate({
      approvedCommand: updateCommand,
      commandRunner: {
        runCodexVersion: async () => `codex-cli ${installedVersion}`,
        runNpmCommand: async (args) => {
          if (args[0] === "view") {
            return "0.128.0\n";
          }
          installedVersion = "0.128.0";
          return "updated\n";
        }
      }
    });

    expect(approved.status).toBe("updated");
    expect(transportRestarts).toBe(1);
    expect(readinessRefreshes).toBe(1);
    expect(updateRechecks).toBe(1);
  });

  it("allows newer Codex CLI protocol drift and blocks older CLIs", () => {
    expect(assessCodexProtocolCompatibility("0.128.0", "0.128.0")).toMatchObject({
      status: "compatible",
      compatible: true
    });
    expect(assessCodexProtocolCompatibility("0.129.0", "0.128.0")).toMatchObject({
      status: "installed-newer",
      compatible: true
    });
    expect(assessCodexProtocolCompatibility("0.127.0", "0.128.0")).toMatchObject({
      status: "installed-older",
      compatible: false
    });
    expect(assessCodexProtocolCompatibility(undefined, "0.128.0")).toMatchObject({
      status: "unknown",
      compatible: false
    });
  });

  it("does not misclassify resolved WSL launch failures as missing installs", () => {
    expect(
      describeExecutionFailure(
        {
          executionMode: "wsl",
          distroName: "Ubuntu"
        },
        {
          command: "codex",
          resolvedCommand: "/home/nicot/.nvm/versions/node/v22.22.0/bin/codex",
          resolvedNodeCommand: "/home/nicot/.nvm/versions/node/v22.22.0/bin/node",
          resolvedUser: "nicot"
        },
        {
          code: 127,
          stderr: "/usr/bin/env: ‘node’: No such file or directory"
        },
        "win32"
      )
    ).toContain("Node.js was not available on PATH");
  });

  it("reports the actual WSL codex detection command on resolution failure", () => {
    const resolutionPlan = buildWslCommandResolutionPlan(
      {
        distroName: "Ubuntu"
      },
      {
        command: "codex"
      }
    );

    expect(
      describeWslCommandResolutionFailure(
        {
          distroName: "Ubuntu"
        },
        "codex",
        resolutionPlan,
        {
          code: 127
        }
      )
    ).toBe(
      'Command "codex" is not installed inside WSL distro "Ubuntu" when checked with executable "wsl.exe" with args ["-d","Ubuntu","bash","-lc","command -v \'codex\'"].'
    );
  });

  it("bounds WSL detection probes with a timeout", async () => {
    await expect(
      executeWslBashCommandPlan(
        {
          file: process.execPath,
          args: ["-e", "setTimeout(() => {}, 1000)"],
          shellCommand: "sleep",
          transport: "argv"
        },
        10
      )
    ).rejects.toMatchObject({
      code: "ETIMEDOUT"
    });
  });

  it("reports when codex is found but node is missing during WSL runtime resolution", () => {
    const resolutionPlan = buildWslCodexRuntimeResolutionPlan(
      {
        distroName: "Ubuntu"
      },
      {
        command: "codex"
      }
    );

    expect(
      describeWslCodexRuntimeResolutionFailure(
        {
          distroName: "Ubuntu"
        },
        "codex",
        resolutionPlan,
        {
          resolvedCodexCommand: "/home/nicot/.nvm/versions/node/v22.22.0/bin/codex",
          user: "nicot"
        },
        {
          code: 126
        }
      )
    ).toContain("but Node.js could not be resolved");
  });

  it("builds a strict interface-creation output schema accepted by response_format", () => {
    const schema = buildInterfaceCreationOutputSchema() as {
      properties: {
        overview: {
          required: string[];
        };
      };
    };

    expect(schema.properties.overview.required).toContain("statisticsSummary");
  });

  it("repairs prose-wrapped interface output into the required schema", () => {
    const result = parseInterfaceCreationOutput(`Here is the interface:\n\n\`\`\`json
{
  "overview": {
    "summary": "A small app.",
    "architecture": "Single Next.js app.",
    "whatProjectDoes": "Serves a playful site.",
    "howItIsOrganized": "Code lives under app/ and lib/."
  },
  "pathSummaries": [
    {
      "relativePath": "app/page.tsx",
      "summary": "Landing page."
    }
  ]
}
\`\`\``);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.repaired).toBe(true);
    expect(result.output.overview.statisticsSummary).toBe("A small app.");
    expect(result.output.pathSummaries[0]).toMatchObject({
      relativePath: "app/page.tsx",
      title: "page.tsx",
      purpose: "Landing page.",
      summary: "Landing page."
    });
  });
});

describe("workflow state", () => {
  it("creates a conservative default workflow state", () => {
    const workflow = defaultProjectWorkflowState();

    expect(workflow.workflowStage).toBe("charter_needed");
    expect(workflow.workflowCycle.cycleNumber).toBe(1);
    expect(workflow.workflowStopReason).toBe("charter_missing");
    expect(workflow.memory.agentFreshness.goal?.freshnessToken).toBe(0);
  });

  it("validates workflow schema defaults and intervention records", () => {
    const workflow = projectWorkflowStateSchema.parse({});
    const intervention = humanInterventionRecordSchema.parse({
      id: "int-1",
      kind: "credentials",
      title: "Provide API key",
      description: "A third-party API key is required before the cycle can continue.",
      reason: "The integration cannot be validated without external credentials.",
      requestedByAgentCategory: "goal",
      createdAt: "2026-04-07T00:00:00.000Z"
    });

    expect(workflow.workflowStage).toBe("charter_needed");
    expect(workflow.stepProgress.ultimate_goal.stepId).toBe("ultimate_goal");
    expect(workflow.stepProgress.merge.stepId).toBe("merge");
    expect(workflow.memory.contextDescriptors).toEqual([]);
    expect(projectCredentialsStateSchema.parse({}).entries).toEqual([]);
    expect(projectCredentialsStateSchema.parse({
      requests: [{
        id: "cred-1",
        providerName: "Polygon.io",
        keyLabel: "API key",
        description: "Free-tier key",
        createdAt: "2026-04-07T00:00:00.000Z"
      }]
    }).requests[0].freeOnly).toBe(true);
    expect(intervention.status).toBe("pending");
    expect(intervention.blocking).toBe(true);
  });

  it("defaults missing preview requests to none and validates preview IPC payloads", () => {
    const workflow = projectWorkflowStateSchema.parse({});

    expect(workflow.previewRequest).toMatchObject({ status: "none", remainingCycles: 1 });
    expect(getWorkflowPreviewRequest({}).status).toBe("none");
    expect(projectWorkflowStateSchema.parse({
      previewRequest: {
        status: "queued",
        remainingCycles: 3,
        requestedAt: "2026-04-07T00:00:00.000Z"
      }
    }).previewRequest?.remainingCycles).toBe(3);
    expect(getWorkflowPreviewRequest({
      previewRequest: {
        status: "queued",
        remainingCycles: 9
      }
    }).remainingCycles).toBe(3);
    expect(requestWorkflowPreviewRequestSchema.parse({
      projectId: "project-1",
      reason: "Need to inspect the app shell.",
      remainingCycles: 3
    }).remainingCycles).toBe(3);
    expect(() => requestWorkflowPreviewRequestSchema.parse({
      projectId: "project-1",
      remainingCycles: 4
    })).toThrow();
    expect(workflowPreviewCheckpointRequestSchema.parse({ projectId: "project-1" }).projectId).toBe("project-1");
  });

  it("defaults missing workflow mode to normal and exposes inspectable mode configs", () => {
    const workflow = projectWorkflowStateSchema.parse({});

    expect(defaultProjectWorkflowState().workflowMode).toBe("normal");
    expect(workflow.workflowMode).toBe("normal");
    expect(projectWorkflowStateSchema.parse({ workflowMode: undefined }).workflowMode).toBe("normal");
    expect(getWorkflowModeConfig("normal")).toMatchObject({
      mode: "autopilot_balanced",
      maxChecksPerPackage: 4,
      useRecommendationAgent: "always",
      finalAppealEnabled: true
    });
    expect(getWorkflowModeConfig("fast")).toMatchObject({
      mode: "fast",
      maxChecksPerPackage: 8,
      deterministicRecommendationFirst: true,
      useRecommendationAgent: "when_no_high_confidence_package",
      maxNewRequiredChecksPerCycle: 0,
      finalAppealEnabled: false
    });
    expect(setWorkflowModeRequestSchema.parse({ projectId: "project-1", workflowMode: "fast" }).workflowMode).toBe("fast");
  });

  it("derives blocked-human and recommendation-approved workflow stages", () => {
    const baseWorkflow = {
      ...defaultProjectWorkflowState(),
      ultimateGoal: {
        ...emptyUltimateGoal("user"),
        summary: "Ship a safe workflow orchestrator foundation.",
        confirmedAt: "2026-04-07T00:00:00.000Z"
      },
      recommendations: [
        makeRecommendation({
          id: "rec-1",
          title: "Create the first scoped goal",
          summary: "Turn the approved step into an execution brief.",
          rationale: "Recommendation and coding should stay separate."
        })
      ]
    };

    expect(deriveWorkflowProjection(baseWorkflow, []).stage).toBe("recommendation_pending");

    const approved = {
      ...baseWorkflow,
      approvedRecommendation: approveRecommendation(baseWorkflow.recommendations[0], {
        id: "approval-1"
      }),
      workflowCycle: {
        ...baseWorkflow.workflowCycle,
        approvedRecommendationId: "rec-1",
        approvedRecommendationTitle: "Create the first scoped goal",
        status: "recommendation_approved" as const
      }
    };

    expect(deriveWorkflowProjection(approved, []).stage).toBe("recommendation_approved");

    const blocked = {
      ...approved,
      humanInterventions: [
        {
          id: "int-1",
          kind: "credentials" as const,
          title: "Provide API key",
          description: "Need credentials before continuing.",
          reason: "External API validation is impossible without credentials.",
          requestedByAgentCategory: "goal" as const,
          severity: "high" as const,
          blocking: true,
          status: "pending" as const,
          createdAt: "2026-04-07T00:00:00.000Z"
        }
      ]
    };

    expect(deriveWorkflowProjection(blocked, []).stage).toBe("blocked_human");
  });

  it("selects relevant prior context deterministically and explains why", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Build a trading dashboard with live market data and safe credentials.",
      detailedIntent: "The app should use provider adapters rather than hardcoded mock data.",
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    workflow.workflowStage = "goal_ready";
    workflow.workflowCycle = {
      ...workflow.workflowCycle,
      cycleNumber: 3
    };

    const tradingDescriptor = createWorkflowContextDescriptor({
      workflow,
      agentCategory: "coding",
      summary: "Added Polygon market data provider abstraction and credential-missing empty states.",
      changedPaths: ["src/providers/marketData.ts", "src/renderer/TradingDashboard.tsx"],
      relatedPaths: ["src/providers/marketData.ts"],
      now: "2026-04-07T00:00:00.000Z"
    });
    const unrelatedDescriptor = createWorkflowContextDescriptor({
      workflow,
      agentCategory: "coding",
      summary: "Adjusted package metadata for Windows distribution.",
      changedPaths: ["package.json"],
      now: "2026-04-07T00:01:00.000Z"
    });

    const selected = selectRelevantWorkflowContext([unrelatedDescriptor, tradingDescriptor], {
      workflow,
      agentCategory: "coding",
      taskText: "Wire the live trading provider credentials into the dashboard loading state.",
      relatedPaths: ["src/providers/marketData.ts"]
    });

    expect(selected[0]?.descriptorId).toBe(tradingDescriptor.id);
    expect(selected[0]?.reasons.join(" ")).toContain("shared");
    expect(formatRelevantContextForPrompt(selected)).toContain("Relevant prior context");
  });

  it("omits stale historical checklist counts from selected prior context", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Build a trading dashboard with live market data and safe credentials.",
      detailedIntent: "The app should use provider adapters rather than hardcoded mock data.",
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };

    const descriptor = createWorkflowContextDescriptor({
      workflow,
      agentCategory: "coding",
      summary: "Cycle 4 recommendation said completion remains 8/39 and 8/39 required goal checks met (21%) while adding market provider tests.",
      changedPaths: ["src/providers/marketData.ts"],
      now: "2026-04-07T00:00:00.000Z"
    });

    const selected = selectRelevantWorkflowContext([descriptor], {
      workflow,
      agentCategory: "coding",
      taskText: "Improve market provider tests and credential handling.",
      relatedPaths: ["src/providers/marketData.ts"]
    });
    const formatted = formatRelevantContextForPrompt(selected);

    expect(formatted).toContain("[historical progress count omitted]");
    expect(formatted).not.toContain("8/39");
  });

  it("keeps completed agent context tied to the agent's original cycle", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.workflowCycle = {
      ...workflow.workflowCycle,
      cycleNumber: 74
    };
    const agent = {
      ...createAgentSkeleton("coding", "Coding Pass 1", "Implement transaction fixtures.", "gpt-5.4"),
      workflowCycleNumber: 12,
      status: "completed" as const,
      changedFiles: ["src/analytics/transactionHistory.test.ts"],
      lastMessageSnippet: "Added transaction-aware fixture evidence."
    };

    const descriptor = createAgentContextDescriptor(workflow, agent, "2026-04-07T00:00:00.000Z");

    expect(descriptor.cycleNumber).toBe(12);
  });

  it("prunes context descriptors by newest update first", () => {
    const workflow = defaultProjectWorkflowState();
    const descriptors = [0, 1, 2].map((index) =>
      createWorkflowContextDescriptor({
        workflow,
        agentCategory: "coding",
        summary: `Descriptor ${index}`,
        changedPaths: [`src/${index}.ts`],
        now: `2026-04-07T00:0${index}:00.000Z`
      })
    );

    expect(pruneWorkflowContextDescriptors(descriptors, 2).map((descriptor) => descriptor.summary)).toEqual([
      "Descriptor 2",
      "Descriptor 1"
    ]);
  });

  it("creates a scoped goal from an approved recommendation and charter", () => {
    const scopedGoal = createScopedGoalFromRecommendation(
      makeRecommendation({
        id: "rec-1",
        title: "Model workflow approvals explicitly",
        summary: "Persist approvals as first-class workflow state.",
        rationale: "Recommendation approval should be a real project action.",
        confidence: 0.91,
        estimatedScope: "medium"
      }),
      {
        ...emptyUltimateGoal("user"),
        summary: "Build a safe closed-loop orchestration foundation.",
        detailedIntent: "Evolve the dashboard toward explicit workflow state.",
        successCriteria: ["Workflow state is persisted."],
        constraints: ["Keep typed IPC intact."],
        nonGoals: ["Do not rebuild the transport layer."],
        qualityBar: "Test-backed changes with clear workflow evidence.",
        confirmedAt: "2026-04-07T00:00:00.000Z"
      }
    );

    expect(scopedGoal.summary).toBe("Model workflow approvals explicitly");
    expect(scopedGoal.acceptanceCriteria.some((entry) => entry.includes("Persist approvals"))).toBe(true);
    expect(scopedGoal.acceptanceCriteria.some((entry) => entry.includes("quality bar"))).toBe(true);
    expect(scopedGoal.constraints).toContain("Keep typed IPC intact.");
    expect(scopedGoal.constraints).toContain("Do not spend this cycle on non-goal: Do not rebuild the transport layer.");
  });

  it("creates deterministic scoped goals from clear work packages", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.workflowMode = "fast";
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Ship deterministic workflow package completion.",
      constraints: ["Keep typed IPC intact."],
      nonGoals: ["Do not rebuild the renderer shell."],
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    workflow.goalChecklist = [
      makeGoalCheck({
        id: "check-a",
        title: "Workflow package ranking groups required checks",
        status: "unmet",
        source: "success_criterion",
        relatedPaths: ["src/runtime/workflowRecommendations.ts"]
      }),
      makeGoalCheck({
        id: "check-b",
        title: "Workflow package scoped goal preserves targeted check IDs",
        status: "unknown",
        source: "success_criterion",
        relatedPaths: ["src/shared/workflow.ts"]
      })
    ];
    const workPackage: WorkPackage = {
      id: "work-package:clear",
      title: "Workflow package completion work package",
      summary: "Close related workflow package checks.",
      checkIds: ["check-a", "check-b"],
      primaryTopic: "Workflow package completion",
      likelyPaths: ["src/runtime/workflowRecommendations.ts", "src/shared/workflow.ts"],
      estimatedBreadth: "medium",
      estimatedImpact: "high",
      confidence: 0.86,
      riskLevel: "medium",
      reason: "Grouped by shared checklist semantics and workflow package paths.",
      acceptanceHints: [
        "Show repository evidence that package ranking groups required checks.",
        "Verify targeted check IDs are carried into the scoped goal."
      ],
      score: 320
    };

    const scopedGoal = createScopedGoalFromWorkPackage(workPackage, workflow, {
      sourceRecommendationId: "rec-package",
      now: "2026-04-07T00:00:00.000Z"
    });

    expect(scopedGoal).toBeTruthy();
    expect(scopedGoal?.sourceRecommendationId).toBe("rec-package");
    expect(scopedGoal?.sourceWorkPackageId).toBe(workPackage.id);
    expect(scopedGoal?.targetedCheckIds).toEqual(["check-a", "check-b"]);
    expect(scopedGoal?.likelyPaths).toEqual(workPackage.likelyPaths);
    expect(scopedGoal?.acceptanceCriteria.join(" ")).toContain("targeted required checks");
    expect(scopedGoal?.constraints).toContain("Keep typed IPC intact.");
    expect(scopedGoal?.testStrategy.join(" ")).toContain("targeted checks");
  });

  it("requires model scoping for high-risk work packages", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.workflowMode = "fast";
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Protect credential and approval handling.",
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    workflow.goalChecklist = [
      makeGoalCheck({
        id: "check-secret",
        title: "Credential handling preserves local secret storage",
        status: "unmet",
        relatedPaths: ["src/runtime/storage.ts"]
      })
    ];
    const workPackage: WorkPackage = {
      id: "work-package:risk",
      title: "Credential approval policy work package",
      summary: "Adjust credential approval and local secret storage behavior.",
      checkIds: ["check-secret"],
      primaryTopic: "Credential handling",
      likelyPaths: ["src/runtime/storage.ts", "src/runtime/approvalPolicy.ts"],
      estimatedBreadth: "medium",
      estimatedImpact: "high",
      confidence: 0.92,
      riskLevel: "high",
      reason: "Touches secrets and approval policy.",
      acceptanceHints: ["Credential storage remains local-only."],
      score: 280
    };

    expect(workPackageRequiresModelScoping(workPackage, workflow)).toBe(true);
    expect(createScopedGoalFromWorkPackage(workPackage, workflow)).toBeUndefined();
  });

  it("normalizes workflow step progress defaults and clears stale blocked states", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Ship the safer workflow loop.",
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    workflow.recommendations = [
      makeRecommendation({
        id: "rec-1",
        title: "Choose the next change",
        summary: "Pick the highest-leverage next task.",
        rationale: "The workflow needs a decision to continue."
      })
    ];
    workflow.stepProgress = {
      ...defaultWorkflowStepProgressState(),
      recommendation: {
        ...defaultWorkflowStepProgressState().recommendation,
        status: "blocked",
        requiresUserInput: true
      }
    };
    workflow.workflowStage = "recommendation_pending";

    const stepProgress = ensureWorkflowStepProgressState(workflow);

    expect(stepProgress.ultimate_goal.status).toBe("completed");
    expect(stepProgress.recommendation.status).toBe("waiting");
    expect(stepProgress.recommendation.requiresUserInput).toBe(true);
  });

  it("does not keep prompting recovery for an already handled or superseded disconnected agent", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Recover interrupted workflow agents cleanly.",
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    workflow.workflowCycle.cycleNumber = 2;
    const disconnectedAgent: AgentState = {
      ...createAgentSkeleton("coding", "Interrupted Coding Pass", "Prompt", "gpt-5.4-mini"),
      workflowCycleNumber: 2,
      createdAt: "2026-04-07T00:00:00.000Z",
      status: "disconnected",
      completedAt: "2026-04-07T00:01:00.000Z",
      disconnectedReason: "Lost app-server connection."
    };
    const replacementAgent: AgentState = {
      ...createAgentSkeleton("coding", "Coding Pass 2", "Prompt", "gpt-5.4-mini"),
      workflowCycleNumber: 2,
      status: "running",
      createdAt: "2026-04-07T00:02:00.000Z",
      startedAt: "2026-04-07T00:02:00.000Z",
      lastActivityAt: "2026-04-07T00:02:00.000Z"
    };

    expect(getWorkflowRecoveryCandidate(
      workflow,
      [disconnectedAgent, replacementAgent],
      new Date("2026-04-07T00:03:00.000Z").getTime(),
      10 * 60 * 1000
    )).toBeNull();

    replacementAgent.status = "completed";
    replacementAgent.completedAt = "2026-04-07T00:04:00.000Z";
    expect(getWorkflowRecoveryCandidate(
      workflow,
      [disconnectedAgent, replacementAgent],
      new Date("2026-04-07T00:05:00.000Z").getTime(),
      10 * 60 * 1000
    )).toBeNull();

    expect(getWorkflowRecoveryCandidate(
      workflow,
      [{ ...disconnectedAgent, recoveryHandledAt: "2026-04-07T00:02:30.000Z" }],
      new Date("2026-04-07T00:05:00.000Z").getTime(),
      10 * 60 * 1000
    )).toBeNull();
  });

  it("classifies stale starting agents without threads as startup stalls", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.workflowCycle.cycleNumber = 4;
    const startingAgent: AgentState = {
      ...createAgentSkeleton("coding", "Coding Pass 1", "Prompt", "gpt-5.4-mini"),
      workflowCycleNumber: 4,
      status: "starting",
      createdAt: "2026-04-07T00:00:00.000Z"
    };

    expect(getWorkflowRecoveryCandidate(
      workflow,
      [startingAgent],
      new Date("2026-04-07T00:30:00.000Z").getTime(),
      10 * 60 * 1000
    )).toMatchObject({
      kind: "startup_stalled",
      agent: {
        id: startingAgent.id
      }
    });
  });

  it("derives one workflow runtime status for running, stale, paused, and approval states", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Recover workflow state consistently.",
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    workflow.scopedGoal = {
      id: "goal-1",
      sourceRecommendationId: "rec-1",
      summary: "Implement recovery controls",
      executionBrief: "Fix stale running state.",
      acceptanceCriteria: [],
      constraints: [],
      testStrategy: [],
      createdAt: "2026-04-07T00:00:00.000Z"
    };
    workflow.workflowStage = "coding_running";
    workflow.stepProgress.coding.status = "running";
    workflow.stepProgress.coding.startedAt = "2026-04-07T00:00:00.000Z";
    workflow.stepProgress.coding.updatedAt = "2026-04-07T00:00:00.000Z";
    const runningAgent: AgentState = {
      ...createAgentSkeleton("coding", "Coding Pass", "Prompt", "gpt-5.4-mini"),
      workflowCycleNumber: workflow.workflowCycle.cycleNumber,
      status: "running",
      startedAt: "2026-04-07T00:00:00.000Z",
      lastActivityAt: "2026-04-07T00:09:00.000Z"
    };

    expect(deriveWorkflowRuntimeStatus(workflow, [runningAgent], {
      nowMs: new Date("2026-04-07T00:10:00.000Z").getTime(),
      staleMs: 10 * 60 * 1000
    })).toMatchObject({
      status: "running",
      canContinue: false,
      label: "Running"
    });

    expect(deriveWorkflowRuntimeStatus(workflow, [], {
      nowMs: new Date("2026-04-07T00:10:00.000Z").getTime(),
      staleMs: 10 * 60 * 1000
    })).toMatchObject({
      status: "stale-running",
      canContinue: true,
      label: "Needs recovery"
    });

    const recoveringWorkflow = {
      ...workflow,
      stepProgress: {
        ...workflow.stepProgress,
        coding: {
          ...workflow.stepProgress.coding,
          status: "recovering" as const,
          updatedAt: "2026-04-07T00:09:55.000Z"
        }
      }
    };
    expect(deriveWorkflowRuntimeStatus(recoveringWorkflow, [], {
      nowMs: new Date("2026-04-07T00:10:00.000Z").getTime(),
      staleMs: 10 * 60 * 1000
    })).toMatchObject({
      status: "recovering",
      canContinue: false,
      label: "Recovering"
    });

    const startingWorkflow = {
      ...workflow,
      stepProgress: {
        ...workflow.stepProgress,
        coding: {
          ...workflow.stepProgress.coding,
          status: "starting" as const,
          updatedAt: "2026-04-07T00:09:55.000Z"
        }
      }
    };
    expect(deriveWorkflowRuntimeStatus(startingWorkflow, [], {
      nowMs: new Date("2026-04-07T00:10:00.000Z").getTime(),
      staleMs: 10 * 60 * 1000
    })).toMatchObject({
      status: "starting-agent",
      canContinue: false,
      label: "Starting agent"
    });

    const pausedWorkflow = {
      ...workflow,
      stepProgress: {
        ...workflow.stepProgress,
        coding: {
          ...workflow.stepProgress.coding,
          status: "waiting" as const
        }
      }
    };
    expect(deriveWorkflowRuntimeStatus(pausedWorkflow, [], {
      workflowPauseRequested: true
    })).toMatchObject({
      status: "paused",
      canContinue: true
    });

    const approvalAgent: AgentState = {
      ...runningAgent,
      status: "waiting_approval",
      approvals: [{
        id: "approval-1",
        agentId: runningAgent.id,
        kind: "command",
        summary: "Run validation",
        filePaths: [],
        createdAt: "2026-04-07T00:00:00.000Z",
        status: "pending",
        availableDecisions: ["accept", "decline"]
      }]
    };
    expect(deriveWorkflowRuntimeStatus(pausedWorkflow, [approvalAgent])).toMatchObject({
      status: "awaiting-approval",
      canContinue: false,
      continueDisabledReason: "Resolve the pending approval before continuing."
    });
  });

  it("resolves durable autopilot policy defaults and clamps unsafe custom values", () => {
    const parsedWorkflow = projectWorkflowStateSchema.parse({});
    expect(parsedWorkflow.autopilotPolicy).toMatchObject({
      enabled: false,
      profile: "balanced",
      maxAutomaticActionsPerPass: 5,
      pauseOnApprovalRequired: true,
      requireExplicitApprovalForHighRiskPackages: true
    });

    expect(resolveEffectiveAutopilotPolicy({}, true)).toMatchObject({
      enabled: true,
      profile: "balanced"
    });
    expect(getAutopilotPolicyConfig("conservative")).toMatchObject({
      profile: "conservative",
      maxChecksPerWorkPackageNormal: 2,
      maxConsecutiveCycles: 1
    });
    expect(getAutopilotPolicyConfig("aggressive").maxChecksPerWorkPackageFast)
      .toBeGreaterThan(getAutopilotPolicyConfig("conservative").maxChecksPerWorkPackageFast);

    const custom = validateAutopilotPolicy({
      enabled: true,
      profile: "custom",
      maxAutomaticActionsPerPass: 999,
      maxNewRequiredChecksPerCycle: -10,
      maxChecksPerWorkPackageNormal: 99,
      maxChecksPerWorkPackageFast: 1,
      highRiskAreas: []
    });
    expect(custom.maxAutomaticActionsPerPass).toBe(12);
    expect(custom.maxNewRequiredChecksPerCycle).toBe(0);
    expect(custom.maxChecksPerWorkPackageNormal).toBe(8);
    expect(custom.maxChecksPerWorkPackageFast).toBe(8);
    expect(custom.highRiskAreas).toContain("approval policy");
    expect(setAutopilotPolicyRequestSchema.parse({
      projectId: "project-1",
      policy: { profile: "aggressive" }
    }).policy.profile).toBe("aggressive");
  });

  it("allows zero autonomy budget values to mean no strategy pause", () => {
    const budget = autonomyBudgetSchema.parse({
      maxCyclesBeforePause: 0,
      maxMinutesBeforePause: 0,
      maxFailedRepairAttempts: 0,
      maxConsecutiveTasksWithoutUserReview: 0,
      stopWhenGoalComplete: false,
      stopWhenNoSafeNextTaskExists: false,
      stopWhenPlannerWantsToChangeUltimateGoal: false,
      stopWhenValidationFailsRepeatedly: false
    });

    expect(budget).toMatchObject({
      maxCyclesBeforePause: 0,
      maxMinutesBeforePause: 0,
      maxFailedRepairAttempts: 0,
      maxConsecutiveTasksWithoutUserReview: 0,
      stopWhenGoalComplete: false,
      stopWhenNoSafeNextTaskExists: false
    });
  });

  it("pauses autopilot at background-safe checkpoints", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Ship safe background automation.",
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    const policy = validateAutopilotPolicy({ enabled: true });
    const approvalAgent: AgentState = {
      ...createAgentSkeleton("coding", "Coding", "Prompt", "gpt-5.4-mini"),
      approvals: [{
        id: "approval-1",
        agentId: "agent-1",
        kind: "command",
        summary: "Run command",
        filePaths: [],
        createdAt: "2026-04-07T00:00:00.000Z",
        status: "pending",
        availableDecisions: ["accept", "decline"]
      }]
    };
    expect(shouldAutopilotPause({ workflow, agents: [approvalAgent] }, policy)).toMatchObject({
      shouldPause: true,
      reason: "approval_required"
    });

    expect(shouldAutopilotPause({
      workflow,
      agents: [approvalAgent],
      previewReady: true,
      workflowPauseRequested: true
    }, policy)).toMatchObject({
      shouldPause: true,
      reason: "preview_ready"
    });

    workflow.humanInterventions = [{
      id: "human-1",
      kind: "credentials",
      title: "Add credential",
      description: "A local credential is required.",
      reason: "The agent cannot safely invent credentials.",
      requestedByAgentCategory: "coding",
      severity: "high",
      blocking: true,
      status: "pending",
      createdAt: "2026-04-07T00:00:00.000Z"
    }];
    expect(shouldAutopilotPause({ workflow }, policy).reason).toBe("human_blocker");
    workflow.humanInterventions = [];

    workflow.workflowStopReason = "merge_conflicts";
    workflow.repair.status = "merge_conflicts";
    expect(shouldAutopilotPause({ workflow }, policy).reason).toBe("merge_conflict");
    workflow.workflowStopReason = "repair_budget_exhausted";
    workflow.repair.status = "exhausted";
    expect(shouldAutopilotPause({ workflow }, policy).reason).toBe("repair_budget_exhausted");

    workflow.workflowStopReason = "none";
    workflow.repair.status = "idle";
    workflow.ultimateGoalCompletion = {
      state: "goal_satisfied",
      rationale: "All required checks are met.",
      source: "deterministic",
      updatedAt: "2026-04-07T00:00:00.000Z"
    };
    workflow.appeal.status = "not_applicable";
    expect(shouldAutopilotPause({ workflow, workflowObjective: "deliver" }, policy).reason).toBe("ultimate_goal_satisfied");

    workflow.ultimateGoalCompletion = undefined;
    expect(shouldAutopilotPause({ workflow, nextAction: "approve_recommendation" }, policy).reason).toBe("no_safe_recommendation");
    expect(shouldAutopilotPause({
      workflow,
      nextAction: "approve_recommendation",
      recommendation: makeRecommendation({
        title: "Change approval policy automation",
        riskLevel: "medium",
        relatedPaths: ["src/runtime/approvalPolicy.ts"]
      })
    }, policy)).toMatchObject({
      reason: "high_risk_package_requires_approval",
      highRiskPackageRequiresApproval: true
    });
    expect(shouldAutopilotPause({ workflow, projectAccessStatus: "failed" }, policy).reason).toBe("project_access_validation_failed");
  });

  it("lets a bounded repair strategy continue through a repeated validation signature", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Finish the bounded repair loop.",
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    workflow.workflowCycle = { cycleNumber: 9, acceptanceCriteria: [], status: "repair_loop" };
    workflow.workflowStopReason = "integrity_failed";
    workflow.repair = { ...workflow.repair, status: "repairing", attemptCount: 2, maxAttempts: 3 };
    const failedAgents = ["2026-04-07T00:01:00.000Z", "2026-04-07T00:02:00.000Z"].map((generatedAt) => ({
      ...createAgentSkeleton("integrity", "Integrity Agent", "Validate.", "gpt-5.4-mini"),
      status: "failed" as const,
      workflowCycleNumber: 9,
      integrityReport: {
        summary: "Typecheck failed in the same module.",
        checks: [{ name: "typecheck", command: "npm run typecheck", status: "failed" as const, outputSnippet: "TS2322" }],
        risks: ["Typecheck failed in src/workflow.ts."],
        generatedAt
      }
    }));
    const policy = validateAutopilotPolicy({ enabled: true, profile: "balanced" });

    expect(hasRepeatedAutopilotFailure(workflow, failedAgents)).toBe(true);
    expect(shouldAutopilotPause({ workflow, agents: failedAgents }, policy)).toMatchObject({ shouldPause: false });
  });

  it("does not let resolved historical failures pause a completed cycle", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Keep workflow automation moving after resolved merge retries.",
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    workflow.workflowCycle = {
      cycleNumber: 17,
      acceptanceCriteria: [],
      status: "ready_to_merge"
    };

    const firstConflict: AgentState = {
      ...createAgentSkeleton("merge", "Merge Agent", "Merge prompt", "gpt-5.4-mini"),
      status: "conflicted",
      workflowCycleNumber: 17,
      mergeReport: {
        summary: "Merge conflicts were detected and require follow-up.",
        mergedBranches: [],
        conflicts: ["CONFLICT (content): Merge conflict in smoke/question-bank.spec.ts"],
        conflictCycleCount: 1,
        generatedAt: "2026-04-07T00:01:00.000Z"
      }
    };
    const secondConflict: AgentState = {
      ...createAgentSkeleton("merge", "Merge Agent", "Merge prompt", "gpt-5.4-mini"),
      status: "conflicted",
      workflowCycleNumber: 17,
      mergeReport: {
        summary: "Merge conflicts were detected and require follow-up.",
        mergedBranches: [],
        conflicts: ["CONFLICT (content): Merge conflict in smoke/question-bank.spec.ts"],
        conflictCycleCount: 2,
        generatedAt: "2026-04-07T00:02:00.000Z"
      }
    };
    const successfulMerge: AgentState = {
      ...createAgentSkeleton("merge", "Merge Agent", "Merge prompt", "gpt-5.4-mini"),
      status: "completed",
      workflowCycleNumber: 17,
      mergeReport: {
        summary: "All selected coding-agent branches merged cleanly.",
        mergedBranches: ["awb/example"],
        conflicts: [],
        conflictCycleCount: 0,
        generatedAt: "2026-04-07T00:03:00.000Z"
      }
    };
    const policy = validateAutopilotPolicy({ enabled: true, profile: "balanced" });

    expect(hasRepeatedAutopilotFailure(workflow, [firstConflict, secondConflict, successfulMerge])).toBe(false);
    expect(shouldAutopilotPause({
      workflow,
      agents: [firstConflict, secondConflict, successfulMerge]
    }, policy).shouldPause).toBe(false);

    workflow.workflowCycle.status = "completed";
    workflow.workflowStage = "cycle_complete";
    workflow.workflowStopReason = "cycle_completed";

    expect(hasRepeatedAutopilotFailure(workflow, [firstConflict, secondConflict, successfulMerge])).toBe(false);
    expect(shouldAutopilotPause({
      workflow,
      agents: [firstConflict, secondConflict, successfulMerge],
      nextAction: "generate_recommendations"
    }, policy).shouldPause).toBe(false);
    expect(getNextWorkflowAutomationAction(
      workflow,
      [firstConflict, secondConflict, successfulMerge],
      "git",
      policy,
      false,
      "deliver"
    )).toBe("generate_recommendations");
  });

  it("applies autopilot policy to work-package selection, Fast Mode, and deterministic scoping", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.workflowMode = "fast";
    workflow.autopilotPolicy = validateAutopilotPolicy({ enabled: true, profile: "balanced" });
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Build a market analytics dashboard.",
      successCriteria: [
        "App includes drawdown visualization and recovery analysis",
        "App includes rolling volatility and rolling Sharpe metrics"
      ],
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    workflow.goalChecklist = buildGoalChecklistFromUltimateGoal(workflow.ultimateGoal, [], "2026-04-07T00:00:00.000Z");
    const checkIds = workflow.goalChecklist.map((check) => check.id);
    const recommendations = [
      makeRecommendation({
        id: "package",
        title: "Satisfy work package: performance analytics",
        summary: "Close 2 related required checks with shared implementation and evidence.",
        targetedCheckIds: checkIds,
        sourceWorkPackageId: "work-package:analytics",
        confidence: 0.82,
        estimatedScope: "medium"
      }),
      makeRecommendation({
        id: "polish",
        title: "Polish dashboard spacing",
        summary: "Backlog polish while required checks remain open.",
        confidence: 0.99
      })
    ];

    expect(pickAutopilotRecommendation(recommendations, workflow)?.id).toBe("package");
    expect(pickAutopilotRecommendation([recommendations[1]], workflow)).toBeUndefined();

    const balancedNormal = getWorkflowModeConfig("normal", workflow.autopilotPolicy);
    const balancedFast = getWorkflowModeConfig("fast", workflow.autopilotPolicy);
    expect(balancedFast.maxChecksPerPackage).toBeGreaterThan(balancedNormal.maxChecksPerPackage);
    expect(getAutopilotMaxNewRequiredChecksPerCycle(workflow.autopilotPolicy, "fast")).toBe(0);
    expect(getAutopilotMaxChecksPerWorkPackage(getAutopilotPolicyConfig("aggressive"), "fast"))
      .toBeGreaterThan(getAutopilotMaxChecksPerWorkPackage(getAutopilotPolicyConfig("conservative"), "fast"));

    const workPackage: WorkPackage = {
      id: "work-package:analytics",
      title: "analytics work package",
      summary: "Close analytics checks.",
      checkIds,
      primaryTopic: "performance analytics",
      likelyPaths: ["src/analytics.ts"],
      estimatedBreadth: "medium",
      estimatedImpact: "high",
      confidence: 0.86,
      riskLevel: "medium",
      reason: "Related analytics checks.",
      acceptanceHints: ["Verify analytics output."],
      score: 250
    };
    expect(createScopedGoalFromWorkPackage(workPackage, workflow, {
      mode: "fast",
      autopilotPolicy: workflow.autopilotPolicy
    })).toBeDefined();
    expect(createScopedGoalFromWorkPackage(workPackage, workflow, {
      mode: "fast",
      autopilotPolicy: validateAutopilotPolicy({
        enabled: true,
        profile: "custom",
        allowDeterministicScoping: false
      })
    })).toBeUndefined();
    expect(isHighRiskAutopilotRecommendation(makeRecommendation({
      title: "Adjust runtime command execution",
      riskLevel: "medium"
    }), getAutopilotPolicyConfig("aggressive"))).toBe(true);
  });

  it("keeps autopilot behind approval and repair safety boundaries", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Keep automation bounded.",
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    const approvalAgent: AgentState = {
      ...createAgentSkeleton("coding", "Coding", "Prompt", "gpt-5.4-mini"),
      status: "waiting_approval",
      approvals: [{
        id: "approval-1",
        agentId: "agent-1",
        kind: "command",
        command: "git push origin main",
        summary: "Push changes",
        filePaths: [],
        createdAt: "2026-04-07T00:00:00.000Z",
        status: "pending",
        availableDecisions: ["accept", "decline"]
      }]
    };
    expect(getNextWorkflowAutomationAction(
      workflow,
      [approvalAgent],
      "git",
      validateAutopilotPolicy({ enabled: true })
    )).toBeNull();
    expect(shouldAutoApproveApproval(approvalAgent.approvals[0], {
      autoApproveCommands: true,
      autoApproveGitCommits: false,
      autoApproveGitPushes: false
    })).toBe(false);

    workflow.workflowStopReason = "integrity_failed";
    workflow.repair.latestFailureReason = "npm test failed";
    expect(shouldAutopilotPause({
      workflow
    }, validateAutopilotPolicy({ enabled: true, profile: "balanced" })).shouldPause).toBe(false);
    expect(shouldAutopilotPause({
      workflow
    }, validateAutopilotPolicy({ enabled: true, profile: "conservative" })).reason).toBe("integrity_failure");
    expect(shouldAutopilotPause({
      workflow,
      promotedRequiredCheckCount: 3
    }, validateAutopilotPolicy({ enabled: true, profile: "balanced", maxNewRequiredChecksPerCycle: 2 })).reason).toBe("required_check_promotion_cap");
  });

  it("selects the next automation action conservatively from workflow state", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Ship a safe automated workflow.",
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };

    expect(getNextWorkflowAutomationAction(workflow, [], "folder")).toBe("generate_recommendations");
    expect(getNextWorkflowAutomationAction(workflow, [
      {
        ...createAgentSkeleton("goal", "Ultimate Goal Agent", "Detect the goal.", "gpt-5.4-mini"),
        status: "running",
        currentPhase: "Detecting ultimate goal"
      }
    ], "folder")).toBe("generate_recommendations");
    expect(getNextWorkflowAutomationAction(workflow, [
      {
        ...createAgentSkeleton("recommendation", "Recommendation Agent", "Prompt", "gpt-5.4-mini"),
        status: "running"
      }
    ], "folder")).toBeNull();
    expect(getNextWorkflowAutomationAction(workflow, [
      {
        ...createAgentSkeleton("manual", "Manual Agent", "Prompt", "gpt-5.4-mini"),
        approvals: [
          {
            id: "approval-1",
            agentId: "manual-1",
            kind: "command",
            threadId: "thread-1",
            serverRequestId: "request-1",
            summary: "Manual approval",
            filePaths: [],
            createdAt: "2026-04-07T00:00:00.000Z",
            status: "pending",
            availableDecisions: ["accept", "decline"]
          }
        ]
      }
    ], "folder")).toBe("generate_recommendations");

    workflow.recommendations = [
      makeRecommendation({
        id: "rec-1",
        title: "Create the scoped goal",
        summary: "Turn the chosen step into a bounded plan.",
        rationale: "Scoping should stay explicit.",
        confidence: 0.92
      })
    ];
    expect(getNextWorkflowAutomationAction(workflow, [], "folder", true)).toBe("approve_recommendation");
    workflow.approvedRecommendation = approveRecommendation(workflow.recommendations[0], { id: "approved-1" });
    workflow.workflowCycle.approvedRecommendationId = "rec-1";

    expect(getNextWorkflowAutomationAction(workflow, [], "folder")).toBe("create_scoped_goal");
    expect(getNextWorkflowAutomationAction(workflow, [
      {
        ...createAgentSkeleton("goal", "Ultimate Goal Agent", "Detect the goal.", "gpt-5.4-mini"),
        status: "running",
        currentPhase: "Detecting ultimate goal"
      }
    ], "folder")).toBe("create_scoped_goal");
    expect(getNextWorkflowAutomationAction(workflow, [
      {
        ...createAgentSkeleton("goal", "Goal Agent", "Prompt", "gpt-5.4-mini"),
        status: "running"
      }
    ], "folder")).toBeNull();

    workflow.scopedGoal = {
      id: "goal-1",
      sourceRecommendationId: "rec-1",
      summary: "Implement the next step",
      executionBrief: "Do the work safely.",
      acceptanceCriteria: ["Checks pass"],
      constraints: [],
      testStrategy: [],
      createdAt: "2026-04-07T00:01:00.000Z"
    };
    workflow.stepProgress.coding.status = "completed";
    workflow.stepProgress.integrity.status = "failed";
    workflow.workflowStage = "repair_loop";
    workflow.workflowStopReason = "integrity_failed";

    expect(getNextWorkflowAutomationAction(workflow, [], "folder")).toBe("repair_coding");
    expect(getNextWorkflowAutomationAction(workflow, [], "folder", false, true)).toBeNull();

    workflow.workflowStopReason = "repair_budget_exhausted";
    expect(getNextWorkflowAutomationAction(workflow, [], "folder")).toBeNull();
  });

  it("stops after a completed cycle when the Ultimate Goal is satisfied unless optimize mode is active", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Ship a working Tic Tac Toe game.",
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    workflow.workflowCycle.status = "completed";
    workflow.workflowStage = "cycle_complete";
    workflow.workflowStopReason = "ultimate_goal_satisfied";
    workflow.stepProgress.merge.status = "completed";
    workflow.ultimateGoalCompletion = {
      state: "goal_satisfied",
      rationale: "The latest successful cycle appears to satisfy the requested game goal.",
      source: "deterministic",
      updatedAt: "2026-04-07T00:10:00.000Z"
    };
    workflow.appeal = {
      status: "not_applicable",
      reason: "No visual surface was detected.",
      completedAt: "2026-04-07T00:10:00.000Z"
    };

    expect(deriveWorkflowProjection(workflow, [])).toMatchObject({
      stage: "cycle_complete",
      stopReason: "ultimate_goal_satisfied",
      cycleStatus: "completed"
    });
    expect(getNextWorkflowAutomationAction(workflow, [], "folder", false, false, "deliver")).toBeNull();
    expect(workflowStatusSummary(workflow, false, "deliver")).toBe("Ultimate Goal satisfied; automatic cycles stopped");
    expect(workflowActionGuide(workflow, false, false, "deliver")).toMatchObject({
      title: "Ultimate Goal satisfied"
    });
    expect(workflowRunStateLabel(workflow, "folder", false, false, "deliver")).toBe("Waiting on you");

    expect(getNextWorkflowAutomationAction(workflow, [], "folder", false, false, "optimize")).toBe("generate_recommendations");
    workflow.recommendations = [
      makeRecommendation({
        id: "rec-1",
        title: "Polish the game board UI",
        summary: "Improve spacing, turn feedback, and button clarity."
      })
    ];
    expect(deriveWorkflowProjection(workflow, [])).toMatchObject({
      stage: "recommendation_pending",
      stopReason: "awaiting_recommendation_approval",
      cycleStatus: "completed"
    });
    expect(getNextWorkflowAutomationAction(workflow, [], "folder", true, false, "optimize")).toBe("approve_recommendation");
    expect(workflowStatusSummary(workflow, true, "optimize")).toContain("improvement");
  });

  it("queues one final appeal pass after a satisfied visual goal before stopping", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Ship a working portfolio tracker UI.",
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    workflow.workflowCycle.status = "completed";
    workflow.workflowStage = "cycle_complete";
    workflow.workflowStopReason = "ultimate_goal_satisfied";
    workflow.stepProgress.merge.status = "completed";
    workflow.ultimateGoalCompletion = {
      state: "goal_satisfied",
      rationale: "The base portfolio tracker goal is complete.",
      source: "deterministic",
      updatedAt: "2026-04-07T00:10:00.000Z"
    };

    const appealProjection = deriveWorkflowProjection(workflow, []);
    expect(appealProjection).toMatchObject({
      stage: "appeal_pending",
      stopReason: "appeal_missing",
      cycleStatus: "completed"
    });
    workflow.workflowStage = appealProjection.stage;
    workflow.workflowStopReason = appealProjection.stopReason;
    workflow.workflowCycle.status = appealProjection.cycleStatus;
    expect(getNextWorkflowAutomationAction(workflow, [], "folder", false, false, "deliver")).toBe("generate_recommendations");
    expect(workflowStatusSummary(workflow, false, "deliver")).toContain("appeal");

    workflow.appeal.status = "pending";
    workflow.recommendations = [
      makeRecommendation({
        id: "appeal-1",
        title: "Polish the portfolio dashboard",
        summary: "Improve spacing and visible state in the dashboard."
      })
    ];

    expect(deriveWorkflowProjection(workflow, [])).toMatchObject({
      stage: "appeal_pending",
      stopReason: "awaiting_appeal_approval",
      cycleStatus: "completed"
    });
    expect(getNextWorkflowAutomationAction(workflow, [], "folder", true, false, "deliver")).toBe("approve_recommendation");
    expect(workflowActionGuide(workflow, false, false, "deliver")).toMatchObject({
      title: "Choose the final appeal pass"
    });

    workflow.appeal = {
      status: "completed",
      completedAt: "2026-04-07T00:20:00.000Z",
      cycleNumber: 2
    };
    workflow.recommendations = [];
    expect(getNextWorkflowAutomationAction(workflow, [], "folder", false, false, "deliver")).toBeNull();
  });

  it("falls back to the highest-confidence recommendation when no option targets the checklist", () => {
    const recommendations = [
      makeRecommendation({
        id: "rec-1",
        rank: 1,
        title: "First ranked option",
        confidence: 0.81,
        priority: "high"
      }),
      makeRecommendation({
        id: "rec-2",
        rank: 2,
        title: "Highest confidence option",
        confidence: 0.96,
        priority: "medium"
      }),
      makeRecommendation({
        id: "rec-3",
        rank: 3,
        title: "Tie on confidence but lower priority",
        confidence: 0.96,
        priority: "low"
      })
    ];

    expect(pickAutopilotRecommendation(recommendations)?.id).toBe("rec-2");
  });

  it("prefers checklist-completion recommendations over higher-confidence generic stabilization", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.goalChecklist = buildGoalChecklistFromUltimateGoal(
      {
        ...emptyUltimateGoal("user"),
        summary: "Build a market research dashboard.",
        successCriteria: ["App includes drawdown visualization and recovery analysis"]
      },
      [],
      "2026-04-07T00:00:00.000Z"
    );

    const recommendations = [
      makeRecommendation({
        id: "rec-1",
        rank: 1,
        title: "Satisfy goal check: App includes drawdown visualization and recovery analysis",
        summary: "Gather implementation and validation evidence for this required check.",
        rationale: "The goal checklist blocks completion here.",
        expectedImpact: "This moves the Ultimate Goal percentage by converting an explicit required check into evidenced completion.",
        confidence: 0.84,
        priority: "high"
      }),
      makeRecommendation({
        id: "rec-2",
        rank: 2,
        title: "Stabilize recent work in package.json",
        summary: "Review the latest package script changes and close the loop.",
        rationale: "The repository already has fresh changes.",
        expectedImpact: "This converts partial progress into durable progress.",
        confidence: 0.97,
        priority: "high"
      })
    ];

    expect(pickAutopilotRecommendation(recommendations, workflow)?.id).toBe("rec-1");
  });

  it("prefers coherent goal batches over single-check churn when both target the checklist", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.goalChecklist = buildGoalChecklistFromUltimateGoal(
      {
        ...emptyUltimateGoal("user"),
        summary: "Build a market research dashboard.",
        successCriteria: [
          "App includes drawdown visualization and recovery analysis",
          "App includes rolling volatility and rolling Sharpe metrics"
        ]
      },
      [],
      "2026-04-07T00:00:00.000Z"
    );

    const recommendations = [
      makeRecommendation({
        id: "rec-batch",
        rank: 2,
        title: "Satisfy goal batch: performance analytics",
        summary: "Implement one coherent performance analytics batch covering 2 related required checks with shared code, tests, and evidence.",
        rationale: "These checks share implementation paths and validation evidence.",
        expectedImpact: "This can move multiple required Goal checklist items to met in one cycle.",
        confidence: 0.82,
        priority: "high",
        estimatedScope: "medium"
      }),
      makeRecommendation({
        id: "rec-single",
        rank: 1,
        title: "Satisfy goal check: App includes drawdown visualization and recovery analysis",
        summary: "Gather implementation and validation evidence for this required check.",
        rationale: "The goal checklist blocks completion here.",
        expectedImpact: "This moves the Ultimate Goal percentage by converting an explicit required check into evidenced completion.",
        confidence: 0.9,
        priority: "high"
      })
    ];

    expect(pickAutopilotRecommendation(recommendations, workflow)?.id).toBe("rec-batch");
  });
});

describe("workflow view helpers", () => {
  it("maps each workflow stage to clear user-facing guidance", () => {
    const stages: WorkflowStage[] = [
      "charter_needed",
      "recommendation_pending",
      "recommendation_approved",
      "goal_ready",
      "coding_running",
      "integrity_running",
      "repair_loop",
      "ready_to_merge",
      "merged",
      "appeal_pending",
      "blocked_human",
      "cycle_complete"
    ];

    for (const stage of stages) {
      expect(workflowStageLabel(stage).length).toBeGreaterThan(3);
      const guidance = workflowStageGuidance(stage);
      expect(guidance.meaning.length).toBeGreaterThan(10);
      expect(guidance.systemAction.length).toBeGreaterThan(10);
      expect(guidance.userAction.length).toBeGreaterThan(5);
      expect(guidance.next.length).toBeGreaterThan(10);
    }

    expect(workflowStageGuidance("integrity_running").systemAction).toContain("validation");
  });

  it("chooses exactly one primary action and reflects draft or blocker state", () => {
    const charterNeeded = defaultProjectWorkflowState();
    charterNeeded.ultimateGoalDraft = {
      ...emptyUltimateGoal("detected"),
      summary: "Draft workflow goal"
    };
    expect(workflowActionGuide(charterNeeded)).toMatchObject({
      kind: "confirm_goal",
      actionLabel: "Open Settings"
    });
    expect(workflowActionGuide(charterNeeded).description).toContain("Open Settings");

    const chooseRecommendation = defaultProjectWorkflowState();
    chooseRecommendation.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Ship a safer workflow.",
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    chooseRecommendation.recommendations = [
      makeRecommendation({
        id: "rec-1",
        title: "Pick the next step",
        summary: "Choose the next cycle action.",
        rationale: "The system is ready to continue."
      })
    ];
    expect(workflowActionGuide(chooseRecommendation)).toMatchObject({
      kind: "choose_recommendation",
      actionLabel: "Choose next step"
    });
    chooseRecommendation.workflowStage = "recommendation_pending";
    expect(workflowStatusSummary(chooseRecommendation)).toBe("Review and choose the next recommended step");
    expect(workflowActionGuide(chooseRecommendation, false, true)).toMatchObject({
      kind: "none",
      title: "Autopilot is choosing the next step"
    });
    expect(workflowStatusSummary(chooseRecommendation, true)).toContain("Autopilot");
    expect(workflowRunStateLabel(chooseRecommendation, "folder", false, true)).toBe("Running automatically");
    expect(workflowActionGuide(chooseRecommendation, false, false, "optimize")).toMatchObject({
      kind: "choose_recommendation",
      actionLabel: "Choose improvement"
    });
    expect(workflowStatusSummary(chooseRecommendation, true, "optimize")).toContain("improvement");

    const blocked = {
      ...chooseRecommendation,
      workflowStage: "blocked_human" as const,
      humanInterventions: [
        {
          id: "int-1",
          kind: "credentials" as const,
          title: "Add credentials",
          description: "Credentials are required before the workflow can continue.",
          reason: "Validation cannot proceed without external access.",
          requestedByAgentCategory: "integrity" as const,
          severity: "high" as const,
          blocking: true,
          status: "pending" as const,
          createdAt: "2026-04-07T00:00:00.000Z"
        }
      ]
    };
    expect(workflowActionGuide(blocked)).toMatchObject({
      kind: "resolve_blocker",
      actionLabel: "Resolve blocker"
    });
    expect(workflowSectionProminence(blocked)).toEqual({
      recommendations: true,
      humanIntervention: true,
      manualHandoff: false
    });

    chooseRecommendation.recommendations = [];
    chooseRecommendation.scopedGoal = {
      id: "goal-1",
      sourceRecommendationId: "rec-1",
      summary: "Implement the change",
      executionBrief: "Do the work.",
      acceptanceCriteria: [],
      constraints: [],
      testStrategy: [],
      createdAt: "2026-04-07T00:00:00.000Z"
    };
    chooseRecommendation.workflowStage = "goal_ready";
    expect(workflowActionGuide(chooseRecommendation, true).kind).toBe("none");
    expect(workflowRunStateLabel(chooseRecommendation, "folder")).toBe("Running automatically");
  });

  it("builds sequential workflow timeline steps with live active-step detail", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Ship the sequential workflow UI.",
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    workflow.approvedRecommendation = {
      ...approveRecommendation(makeRecommendation({
        id: "rec-1",
        title: "Implement the sequential workflow tab",
        summary: "Replace the dense dashboard.",
        rationale: "The current workflow is too hard to follow.",
        confidence: 0.96
      })),
      approvedAt: "2026-04-07T00:01:00.000Z"
    };
    workflow.scopedGoal = {
      id: "goal-1",
      sourceRecommendationId: "rec-1",
      summary: "Implement the sequential workflow tab",
      executionBrief: "Make the workflow read top to bottom.",
      acceptanceCriteria: [],
      constraints: [],
      testStrategy: [],
      createdAt: "2026-04-07T00:02:00.000Z"
    };
    workflow.workflowStage = "coding_running";
    workflow.stepProgress = {
      ...defaultWorkflowStepProgressState(),
      ultimate_goal: {
        ...defaultWorkflowStepProgressState().ultimate_goal,
        status: "completed",
        requiresUserInput: false,
        completedAt: "2026-04-07T00:00:00.000Z"
      },
      recommendation: {
        ...defaultWorkflowStepProgressState().recommendation,
        status: "completed",
        requiresUserInput: false,
        completedAt: "2026-04-07T00:01:00.000Z"
      },
      goal_plan: {
        ...defaultWorkflowStepProgressState().goal_plan,
        status: "completed",
        requiresUserInput: false,
        completedAt: "2026-04-07T00:02:00.000Z"
      },
      coding: {
        ...defaultWorkflowStepProgressState().coding,
        status: "running",
        startedAt: "2026-04-07T00:03:00.000Z",
        updatedAt: "2026-04-07T00:03:30.000Z",
        lastEventAt: "2026-04-07T00:03:30.000Z",
        currentActivity: "Implementing chart controls in renderer",
        currentSubstep: "Updating the active step card",
        latestProgressNote: "Touched App.tsx and styles.css",
        runCount: 1,
        attemptCount: 1,
        agentCategory: "coding"
      }
    };

    const steps = buildWorkflowTimelineSteps(workflow);
    const activeStep = steps.find((step) => step.isCurrent);

    expect(steps.map((step) => step.id)).toEqual(["ultimate_goal", "recommendation", "goal_plan", "coding", "integrity", "merge"]);
    expect(activeStep).toMatchObject({
      id: "coding",
      status: "running",
      currentActivity: "Implementing chart controls in renderer",
      currentSubstep: "Updating the active step card",
      latestProgressNote: "Touched App.tsx and styles.css",
      runCount: 1,
      attemptCount: 1
    });
  });

  it("marks the blocked step prominently in the sequential timeline", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Ship a safe workflow.",
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    workflow.approvedRecommendation = {
      ...approveRecommendation(makeRecommendation({
        id: "rec-1",
        title: "Implement the next step",
        summary: "Do the work.",
        rationale: "The workflow is ready.",
        confidence: 0.94
      })),
      approvedAt: "2026-04-07T00:00:00.000Z"
    };
    workflow.scopedGoal = {
      id: "goal-1",
      sourceRecommendationId: "rec-1",
      summary: "Implement the next step",
      executionBrief: "Do the work.",
      acceptanceCriteria: [],
      constraints: [],
      testStrategy: [],
      createdAt: "2026-04-07T00:00:00.000Z"
    };
    workflow.workflowStage = "blocked_human";
    workflow.humanInterventions = [
      {
        id: "int-1",
        kind: "credentials",
        title: "Add credentials",
        description: "A blocker needs your help before work can continue.",
        reason: "Validation cannot reach the external system.",
        requestedByAgentCategory: "integrity",
        severity: "high",
        blocking: true,
        status: "pending",
        createdAt: "2026-04-07T00:05:00.000Z"
      }
    ];

    const codingStep = buildWorkflowTimelineSteps(workflow).find((step) => step.id === "coding");

    expect(codingStep).toMatchObject({
      isCurrent: true,
      isBlocked: true,
      status: "blocked",
      requiresUserInput: true,
      blockedReason: "A blocker needs your help before work can continue."
    });
  });

  it("projects repair counters, manual takeover, and goal explanations cleanly", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Improve workflow observability.",
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    workflow.approvedRecommendation = approveRecommendation(makeRecommendation({
      id: "rec-1",
      title: "Add a live transcript panel",
      summary: "Surface step-by-step agent progress in the UI.",
      rationale: "The user needs to see what each workflow step is actually doing.",
      expectedImpact: "It makes active workflow execution observable instead of opaque."
    }));
    workflow.scopedGoal = {
      id: "goal-1",
      sourceRecommendationId: "rec-1",
      summary: "Add a live transcript panel",
      executionBrief: "Stream workflow and agent updates into a readable panel.",
      acceptanceCriteria: ["Users can inspect live agent activity."],
      constraints: ["Keep typed IPC intact."],
      testStrategy: ["Renderer and runtime tests cover the new activity flow."],
      createdAt: "2026-04-07T00:01:00.000Z"
    };
    workflow.workflowStage = "repair_loop";
    workflow.repair = {
      attemptCount: 3,
      maxAttempts: 3,
      status: "exhausted",
      latestIssueSummary: "Lint still fails in the renderer.",
      latestFailureReason: "The transcript panel introduced invalid JSX nesting.",
      lastUpdatedAt: "2026-04-07T00:04:00.000Z"
    };
    workflow.manualHandoff = {
      reason: "repair_exhausted",
      title: "Automatic repair reached its limit",
      whatSystemWasTryingToDo: "Add a live transcript panel",
      validationIssue: "Lint still fails in the renderer.",
      latestFailureReason: "The transcript panel introduced invalid JSX nesting.",
      involvedPaths: ["src/renderer/App.tsx", "src/renderer/styles.css"],
      shellSupported: true,
      createdAt: "2026-04-07T00:04:00.000Z"
    };

    expect(getWorkflowRepairCounterView(workflow)).toMatchObject({
      label: "Repair attempt 3 of 3",
      attemptCount: 3,
      maxAttempts: 3,
      isFinalAttempt: true,
      status: "exhausted"
    });
    expect(buildWorkflowGoalView(workflow)).toMatchObject({
      currentGoal: "Add a live transcript panel",
      chosenNextStep: "Add a live transcript panel",
      executionPlan: "Add a live transcript panel"
    });
    expect(workflowActionGuide(workflow)).toMatchObject({
      kind: "manual_takeover",
      actionLabel: "Revalidate repair"
    });
    expect(canRevalidateExternalRepair(workflow)).toBe(true);
    expect(workflowRunStateLabel(workflow, "git")).toBe("Waiting on you");
  });

  it("projects exhausted repair ahead of stale completed merge progress", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Keep blocker state authoritative.",
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    workflow.scopedGoal = {
      id: "goal-1",
      sourceRecommendationId: "rec-1",
      summary: "Revalidate external repair",
      executionBrief: "Validate the repaired checkout before merge.",
      acceptanceCriteria: [],
      constraints: [],
      testStrategy: [],
      createdAt: "2026-04-07T00:01:00.000Z"
    };
    workflow.workflowCycle.status = "merged";
    workflow.workflowStage = "merged";
    workflow.stepProgress.merge.status = "completed";
    workflow.stepProgress.integrity.status = "failed";
    workflow.repair = {
      attemptCount: 3,
      maxAttempts: 3,
      status: "exhausted",
      latestIssueSummary: "Validation failed.",
      latestFailureReason: "pytest is unavailable in this environment.",
      lastUpdatedAt: "2026-04-07T00:04:00.000Z"
    };

    expect(deriveWorkflowProjection(workflow, [])).toMatchObject({
      stage: "repair_loop",
      stopReason: "repair_budget_exhausted",
      cycleStatus: "repair_loop"
    });
  });

  it("offers repair revalidation for legacy exhausted repair state without a manual handoff", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Recover a saved repair loop.",
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    workflow.workflowStage = "repair_loop";
    workflow.workflowStopReason = "integrity_failed";
    workflow.repair = {
      attemptCount: 2,
      maxAttempts: 2,
      status: "exhausted",
      latestIssueSummary: "Validation and hygiene still block merge.",
      latestFailureReason: "Repository hygiene blocked merge after external repair.",
      lastUpdatedAt: "2026-04-07T00:04:00.000Z"
    };

    expect(canRevalidateExternalRepair(workflow)).toBe(true);
    expect(workflowActionGuide(workflow)).toMatchObject({
      kind: "manual_takeover",
      title: "Revalidate repair before merge",
      actionLabel: "Revalidate repair"
    });

    const attentionItems = buildWorkflowAttentionItems({
      workflow,
      approvals: [],
      userInputRequests: [],
      humanInterventions: [],
      credentialRequests: [],
      timeline: buildWorkflowTimelineSteps(workflow),
      agents: []
    });

    expect(attentionItems).toContainEqual(expect.objectContaining({
      id: "repair:revalidate",
      title: "Repair needs revalidation"
    }));
  });

  it("projects active repair and revalidation ahead of retained failure evidence", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.workflowCycle.cycleNumber = 7;
    workflow.workflowStage = "repair_loop";
    workflow.workflowStopReason = "integrity_failed";
    const failedLedger = {
      ...finalizeValidationLedger({
        ...createValidationLedger({ cycleNumber: 7, testCommands: ["npm test"] }),
        commandResults: [makeLedgerCommandResult({ command: "npm test", exitCode: 1, stdout: "AssertionError" })]
      }),
      updatedAt: "2026-04-07T00:02:00.000Z"
    };
    const failedHygiene = {
      status: "failed" as const,
      scannedAt: "2026-04-07T00:02:00.000Z",
      scannedRef: "integrity:7",
      forbiddenFiles: ["EADME.md"],
      cleanedFiles: [],
      warnings: [],
      mergeBlockingFindings: ["EADME.md looks like a typo path."],
      summaryForHumans: "Repository hygiene failed."
    };
    workflow.validationLedgers = [failedLedger];
    workflow.repoHygieneReports = [failedHygiene];
    workflow.repair = {
      attemptCount: 1,
      maxAttempts: 4,
      status: "repairing",
      latestIssueSummary: "Tests and hygiene failed.",
      latestFailureReason: "npm test failed and EADME.md must be repaired.",
      lastUpdatedAt: "2026-04-07T00:03:00.000Z"
    };

    expect(deriveUserFacingWorkflowStatus(workflow)).toMatchObject({
      label: "Repair in progress",
      tone: "running"
    });
    expect(buildOperatorWorkflowViewModel({ workflow }).currentStatus).toMatchObject({
      primaryLabel: "Repair in progress",
      nextOperatorAction: "The system is repairing the current failure; validation will run automatically next.",
      severity: "running"
    });

    workflow.repair.status = "retrying_validation";
    workflow.stepProgress.integrity.currentActivity = "Re-running npm test";

    expect(deriveUserFacingWorkflowStatus(workflow)).toMatchObject({
      label: "Repair validation running",
      explanation: "Re-running npm test",
      tone: "running"
    });
    expect(buildOperatorWorkflowViewModel({ workflow }).currentStatus.nextOperatorAction)
      .toBe("The system is revalidating the repair; merge will continue automatically if validation passes.");
  });

  it("uses one structured incident instead of duplicating its manual handoff", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.workflowCycle.cycleNumber = 12;
    workflow.workflowStage = "repair_loop";
    workflow.workflowStopReason = "repair_budget_exhausted";
    workflow.repair = {
      ...workflow.repair,
      status: "exhausted",
      attemptCount: 3,
      maxAttempts: 3,
      latestFailureReason: "The same assertion remains unresolved."
    };
    workflow.manualHandoff = {
      reason: "repair_exhausted",
      title: "Automatic repair needs a decision",
      whatSystemWasTryingToDo: "Repair the failed assertion.",
      validationIssue: "npm test failed.",
      latestFailureReason: "The same assertion remains unresolved.",
      involvedPaths: ["src/workflow.ts"],
      shellSupported: true,
      createdAt: "2026-04-07T00:03:00.000Z"
    };
    const incident = upsertWorkflowIncident(workflow, {
      kind: "validation",
      severity: "high",
      sourceStep: "integrity",
      title: "Validation repair budget exhausted",
      summary: "npm test still fails after three repairs.",
      rootCause: "The same assertion remains unresolved.",
      involvedPaths: ["src/workflow.ts"],
      userActionRequired: "Review the failed assertion, repair manually, or reset the cycle.",
      primaryAction: { kind: "open_shell", label: "Open repair agent" },
      now: "2026-04-07T00:03:00.000Z"
    });

    const attentionItems = buildWorkflowAttentionItems({
      workflow,
      approvals: [],
      userInputRequests: [],
      humanInterventions: [],
      credentialRequests: [],
      timeline: buildWorkflowTimelineSteps(workflow),
      agents: []
    });

    expect(attentionItems).toEqual([
      expect.objectContaining({
        id: `incident:${incident.id}`,
        title: incident.title,
        target: "manual-handoff"
      })
    ]);
  });

  it("keeps a superseded integrity failure in history instead of active attention", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.workflowCycle.cycleNumber = 8;
    workflow.workflowStage = "repair_loop";
    workflow.workflowStopReason = "integrity_failed";
    workflow.stepProgress.integrity.status = "failed";
    workflow.stepProgress.integrity.warning = "npm test failed before the repair.";
    const failedIntegrityAgent: AgentState = {
      ...createAgentSkeleton("integrity", "Integrity Pass 1", "Validate cycle 8", "gpt-5.4"),
      id: "integrity-failed-8",
      workflowCycleNumber: 8,
      status: "failed",
      completedAt: "2026-04-07T00:02:00.000Z",
      integrityReport: {
        summary: "npm test failed before repair.",
        checks: [{ name: "Tests", command: "npm test", status: "failed", outputSnippet: "AssertionError" }],
        risks: ["Tests failed."],
        generatedAt: "2026-04-07T00:02:00.000Z"
      }
    };
    const passingIntegrityAgent: AgentState = {
      ...createAgentSkeleton("integrity", "Integrity Pass 2", "Revalidate cycle 8", "gpt-5.4"),
      id: "integrity-passed-8",
      workflowCycleNumber: 8,
      status: "completed",
      completedAt: "2026-04-07T00:05:00.000Z",
      integrityReport: {
        summary: "All validation passed after repair.",
        checks: [{ name: "Tests", command: "npm test", status: "passed", outputSnippet: "passed" }],
        risks: [],
        generatedAt: "2026-04-07T00:05:00.000Z"
      }
    };

    const attentionItems = buildWorkflowAttentionItems({
      workflow,
      approvals: [],
      userInputRequests: [],
      humanInterventions: [],
      credentialRequests: [],
      timeline: buildWorkflowTimelineSteps(workflow),
      agents: [failedIntegrityAgent, passingIntegrityAgent]
    });

    expect(attentionItems).toEqual([]);
  });

  it("deduplicates a manual repair blocker from failed-agent and timeline copies", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.workflowCycle.cycleNumber = 9;
    workflow.workflowStage = "repair_loop";
    workflow.workflowStopReason = "repair_budget_exhausted";
    workflow.stepProgress.integrity.status = "failed";
    workflow.stepProgress.integrity.warning = "npm test still fails.";
    workflow.repair = {
      attemptCount: 3,
      maxAttempts: 3,
      status: "exhausted",
      latestIssueSummary: "Tests still fail.",
      latestFailureReason: "npm test still fails.",
      lastUpdatedAt: "2026-04-07T00:05:00.000Z"
    };
    workflow.manualHandoff = {
      reason: "repair_exhausted",
      title: "Automatic repair reached its limit",
      whatSystemWasTryingToDo: "Repair the current cycle",
      validationIssue: "Tests still fail.",
      latestFailureReason: "npm test still fails.",
      involvedPaths: ["src/index.ts"],
      shellSupported: true,
      createdAt: "2026-04-07T00:05:00.000Z"
    };
    const failedIntegrityAgent: AgentState = {
      ...createAgentSkeleton("integrity", "Integrity Pass 3", "Validate cycle 9", "gpt-5.4"),
      workflowCycleNumber: 9,
      status: "failed",
      completedAt: "2026-04-07T00:04:00.000Z",
      integrityReport: {
        summary: "npm test still fails.",
        checks: [{ name: "Tests", command: "npm test", status: "failed", outputSnippet: "failed" }],
        risks: ["Tests failed."],
        generatedAt: "2026-04-07T00:04:00.000Z"
      }
    };

    const attentionItems = buildWorkflowAttentionItems({
      workflow,
      approvals: [],
      userInputRequests: [],
      humanInterventions: [],
      credentialRequests: [],
      timeline: buildWorkflowTimelineSteps(workflow),
      agents: [failedIntegrityAgent]
    });

    expect(attentionItems).toEqual([
      expect.objectContaining({
        id: "manual-handoff:repair_exhausted",
        title: "Automatic repair reached its limit"
      })
    ]);
  });

  it("uses the newest current-cycle validation result even when a stale failure is supplied explicitly", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.workflowCycle.cycleNumber = 10;
    workflow.workflowStage = "repair_loop";
    const failedLedger = {
      ...finalizeValidationLedger({
        ...createValidationLedger({ cycleNumber: 10, testCommands: ["npm test"] }),
        commandResults: [makeLedgerCommandResult({ command: "npm test", exitCode: 1, stdout: "AssertionError" })]
      }),
      createdAt: "2026-04-07T00:01:00.000Z",
      updatedAt: "2026-04-07T00:02:00.000Z"
    };
    const passedLedger = {
      ...finalizeValidationLedger({
        ...createValidationLedger({ cycleNumber: 10, testCommands: ["npm test"] }),
        commandResults: [makeLedgerCommandResult({ command: "npm test", exitCode: 0, stdout: "passed" })]
      }),
      createdAt: "2026-04-07T00:04:00.000Z",
      updatedAt: "2026-04-07T00:05:00.000Z"
    };
    workflow.validationLedgers = [failedLedger, passedLedger];

    const status = deriveUserFacingWorkflowStatus(workflow, { validationLedger: failedLedger });
    const view = buildOperatorWorkflowViewModel({ workflow, validationLedger: failedLedger });

    expect(status.label).not.toBe("Merge blocked by validation failure");
    expect(view.currentCycle.validationSummary.finalStatus).toBe("passed");
    expect(view.currentCycle.validationSummary.failedAttempts).toBe(0);
    expect(view.historySummary.validationTrend).toContain("failed");
    expect(view.historySummary.validationTrend).toContain("passed");
  });

  it("distinguishes early repair stops from configured repair-budget exhaustion", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Keep repair state honest.",
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    workflow.workflowStage = "repair_loop";
    workflow.repair = {
      attemptCount: 1,
      maxAttempts: 5,
      status: "exhausted",
      latestIssueSummary: "Validation still fails after the latest repair.",
      latestFailureReason: "Integrity hit an environment or dependency blocker that a repair coding pass is unlikely to fix. Stop retrying and resolve the validation environment first.",
      lastUpdatedAt: "2026-04-07T00:04:00.000Z"
    };
    workflow.manualHandoff = {
      reason: "repair_stopped_early",
      title: "Automatic repair stopped early",
      whatSystemWasTryingToDo: "Repair the current workflow step",
      validationIssue: "Validation still fails after the latest repair.",
      latestFailureReason: "Integrity hit an environment or dependency blocker that a repair coding pass is unlikely to fix. Stop retrying and resolve the validation environment first.",
      involvedPaths: ["package.json"],
      shellSupported: true,
      createdAt: "2026-04-07T00:04:00.000Z"
    };

    const projection = deriveWorkflowProjection(workflow, []);
    workflow.workflowStage = projection.stage;
    workflow.workflowStopReason = projection.stopReason;

    expect(projection.stopReason).toBe("repair_stopped_early");
    expect(workflowStatusSummary(workflow)).toBe("Automatic repair stopped early and manual intervention is needed");
    expect(workflowActionGuide(workflow)).toMatchObject({
      kind: "manual_takeover",
      title: "Automatic repair stopped early"
    });
  });

  it("surfaces merge conflicts as a manual handoff instead of a silent repair state", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Finish the integration flow.",
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    workflow.workflowStage = "repair_loop";
    workflow.workflowStopReason = "merge_conflicts";
    workflow.stepProgress.merge.status = "failed";
    workflow.repair = {
      attemptCount: 1,
      maxAttempts: 5,
      status: "merge_conflicts",
      latestIssueSummary: "Merge conflicts were detected and require follow-up.",
      latestFailureReason: "src/index.ts",
      lastUpdatedAt: "2026-04-07T00:04:00.000Z"
    };
    workflow.manualHandoff = {
      reason: "merge_conflicts",
      title: "Merge conflicts detected",
      whatSystemWasTryingToDo: "Integrate validated coding-agent branches into the opened project checkout",
      validationIssue: "Merge conflicts were detected and require follow-up.",
      latestFailureReason: "src/index.ts",
      involvedPaths: ["src/index.ts"],
      shellSupported: true,
      createdAt: "2026-04-07T00:04:00.000Z"
    };

    expect(workflowStatusSummary(workflow)).toBe("Merge conflicts require manual resolution before integration can continue");
    expect(workflowActionGuide(workflow)).toMatchObject({
      kind: "manual_takeover",
      title: "Merge conflicts detected",
      actionLabel: "Open Codex terminal"
    });
    expect(workflowRunStateLabel(workflow, "git")).toBe("Waiting on you");
    expect(workflowSectionProminence(workflow).manualHandoff).toBe(true);
  });

  it("routes merge-conflict attention details to the manual handoff panel", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Finish the integration flow.",
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    workflow.workflowStage = "repair_loop";
    workflow.workflowStopReason = "merge_conflicts";
    workflow.stepProgress.merge.status = "failed";
    workflow.repair = {
      attemptCount: 1,
      maxAttempts: 5,
      status: "merge_conflicts",
      latestIssueSummary: "Merge conflicts were detected and require follow-up.",
      latestFailureReason: "CONFLICT (content): Merge conflict in smoke/question-bank.spec.ts",
      lastUpdatedAt: "2026-04-07T00:04:00.000Z"
    };
    workflow.manualHandoff = {
      reason: "merge_conflicts",
      title: "Merge conflicts detected",
      whatSystemWasTryingToDo: "Integrate validated coding-agent branches into the opened project checkout",
      validationIssue: "Merge conflicts were detected and require follow-up.",
      latestFailureReason: "CONFLICT (content): Merge conflict in smoke/question-bank.spec.ts",
      involvedPaths: ["smoke/question-bank.spec.ts", "src/App.tsx"],
      shellSupported: true,
      createdAt: "2026-04-07T00:04:00.000Z"
    };

    const attentionItems = buildWorkflowAttentionItems({
      workflow,
      approvals: [],
      userInputRequests: [],
      humanInterventions: [],
      credentialRequests: [],
      timeline: buildWorkflowTimelineSteps(workflow),
      agents: []
    });

    expect(attentionItems).toContainEqual(expect.objectContaining({
      id: "manual-handoff:merge_conflicts",
      title: "Merge conflicts detected",
      target: "manual-handoff"
    }));
  });

  it("does not classify checkout update failures without conflicts as merge conflicts", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Finish the integration flow.",
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    workflow.approvedRecommendation = approveRecommendation(makeRecommendation({
      id: "rec-merge-checkout",
      title: "Integrate validated work",
      summary: "Merge the completed branch.",
      rationale: "The work passed validation."
    }));
    workflow.scopedGoal = {
      id: "goal-merge-checkout",
      sourceRecommendationId: "rec-merge-checkout",
      summary: "Integrate validated work",
      executionBrief: "Merge the completed branch.",
      acceptanceCriteria: [],
      constraints: [],
      testStrategy: [],
      createdAt: "2026-04-07T00:01:00.000Z"
    };
    workflow.workflowCycle.status = "ready_to_merge";
    workflow.stepProgress.coding.status = "completed";
    workflow.stepProgress.integrity.status = "completed";
    workflow.stepProgress.merge.status = "failed";

    const mergeAgent: AgentState = {
      ...createAgentSkeleton("merge", "Merge Agent", "Integrate validated work.", "gpt-5.4"),
      status: "failed",
      workflowCycleNumber: workflow.workflowCycle.cycleNumber,
      mergeReport: {
        summary: "Merged cleanly in the integration worktree, but the opened checkout was not updated.",
        targetBranch: "main",
        mergedBranches: ["awb/coding-pass"],
        conflicts: [],
        conflictCycleCount: 0,
        generatedAt: "2026-04-07T00:04:00.000Z"
      }
    };

    expect(deriveWorkflowProjection(workflow, [mergeAgent])).toMatchObject({
      stage: "ready_to_merge",
      stopReason: "none"
    });
  });

  it("keeps opened-checkout update blockers attached to merge instead of coding", async () => {
    const service = new AppService(await createTempDir("checkout-update-blocker")) as unknown as {
      syncWorkflowState: (project: ReturnType<typeof makeAppServiceLoadedProject>) => void;
    };
    const project = makeAppServiceLoadedProject("checkout-update-blocker-project");
    const workflow = project.record.workflow;
    workflow.approvedRecommendation = approveRecommendation(makeRecommendation({
      id: "rec-checkout-update",
      title: "Integrate validated work",
      summary: "Merge the completed branch.",
      rationale: "The work passed validation."
    }));
    workflow.scopedGoal = {
      id: "goal-checkout-update",
      sourceRecommendationId: "rec-checkout-update",
      summary: "Integrate validated work",
      executionBrief: "Merge the completed branch.",
      acceptanceCriteria: [],
      constraints: [],
      testStrategy: [],
      createdAt: "2026-04-07T00:01:00.000Z"
    };
    workflow.stepProgress.coding.status = "completed";
    workflow.stepProgress.integrity.status = "completed";
    workflow.stepProgress.merge.status = "failed";
    workflow.humanInterventions = [
      {
        id: "intervention-checkout-update",
        kind: "other",
        title: "Opened checkout update blocked",
        description: "Validated changes merged cleanly in the integration worktree, but Git could not apply them to the opened project checkout.",
        reason: "Merge finalization could not update the opened project checkout.",
        requestedByAgentCategory: "merge",
        severity: "high",
        blocking: true,
        status: "pending",
        createdAt: "2026-04-07T00:04:00.000Z"
      }
    ];

    service.syncWorkflowState(project);

    expect(workflow.workflowStage).toBe("blocked_human");
    expect(workflow.stepProgress.coding.status).toBe("completed");
    expect(workflow.stepProgress.merge).toMatchObject({
      status: "blocked",
      requiresUserInput: true,
      blockedReason: "Validated changes merged cleanly in the integration worktree, but Git could not apply them to the opened project checkout."
    });
  });

  it("resolves stale merge human interventions after successful merge cleanup", async () => {
    const service = new AppService(await createTempDir("merge-intervention-cleanup")) as unknown as {
      resolveWorkflowHumanInterventions: (
        workflow: ProjectWorkflowState,
        predicate: (intervention: ProjectWorkflowState["humanInterventions"][number]) => boolean,
        resolutionNotes: string
      ) => void;
    };
    const workflow = defaultProjectWorkflowState();
    workflow.humanInterventions = [
      {
        id: "merge-blocker",
        kind: "other",
        title: "Opened checkout update blocked",
        description: "Validated changes were not applied.",
        reason: "Fast-forward failed.",
        requestedByAgentCategory: "merge",
        severity: "high",
        blocking: true,
        status: "pending",
        createdAt: "2026-04-07T00:04:00.000Z"
      },
      {
        id: "credential-blocker",
        kind: "credentials",
        title: "Provide API key",
        description: "Credentials are required.",
        reason: "Missing API key.",
        requestedByAgentCategory: "coding",
        severity: "high",
        blocking: true,
        status: "pending",
        createdAt: "2026-04-07T00:05:00.000Z"
      }
    ];
    workflow.memory.knownOpenIssues = [
      {
        id: "issue-merge-blocker",
        title: "Opened checkout update blocked",
        detail: "Validated changes were not applied.",
        source: "human",
        status: "open",
        recordedAt: "2026-04-07T00:04:00.000Z"
      },
      {
        id: "issue-credential-blocker",
        title: "Provide API key",
        detail: "Credentials are required.",
        source: "human",
        status: "open",
        recordedAt: "2026-04-07T00:05:00.000Z"
      }
    ];

    service.resolveWorkflowHumanInterventions(
      workflow,
      (intervention) => intervention.requestedByAgentCategory === "merge",
      "Resolved automatically after merge finalization completed."
    );

    expect(workflow.humanInterventions.find((entry) => entry.id === "merge-blocker")).toMatchObject({
      status: "resolved",
      resolutionNotes: "Resolved automatically after merge finalization completed."
    });
    expect(workflow.humanInterventions.find((entry) => entry.id === "credential-blocker")).toMatchObject({
      status: "pending"
    });
    expect(workflow.memory.knownOpenIssues.find((entry) => entry.id === "issue-merge-blocker")).toMatchObject({
      status: "resolved"
    });
    expect(workflow.memory.knownOpenIssues.find((entry) => entry.id === "issue-credential-blocker")).toMatchObject({
      status: "open"
    });
  });

  it("selects merge-ready coding branches from the active workflow cycle", async () => {
    const service = new AppService(await createTempDir("merge-candidate-branches")) as unknown as {
      getMergeCandidateCodingBranches: (project: ReturnType<typeof makeAppServiceLoadedProject>) => string[];
    };
    const project = makeAppServiceLoadedProject("merge-candidate-project");
    const workflow = project.record.workflow;
    workflow.workflowCycle.cycleNumber = 3;
    project.record.agents = [
      {
        ...createAgentSkeleton("coding", "Previous Cycle Coding", "Old cycle.", "gpt-5.4"),
        workflowCycleNumber: 2,
        status: "completed",
        completedAt: "2026-04-07T00:05:00.000Z",
        changedFiles: ["src/old-cycle.ts"],
        worktree: { baseDir: "/repo/.agent-workbench", worktreePath: "/repo/.agent-workbench/old", branch: "awb/repo/old-cycle", targetBranch: "main" }
      },
      {
        ...createAgentSkeleton("coding", "Failed Coding", "Failed current cycle.", "gpt-5.4"),
        workflowCycleNumber: 3,
        status: "failed",
        completedAt: "2026-04-07T00:06:00.000Z",
        changedFiles: ["src/failed.ts"],
        worktree: { baseDir: "/repo/.agent-workbench", worktreePath: "/repo/.agent-workbench/failed", branch: "awb/repo/failed", targetBranch: "main" }
      },
      {
        ...createAgentSkeleton("coding", "Coding Pass 1", "Current cycle.", "gpt-5.4"),
        workflowCycleNumber: 3,
        status: "completed",
        completedAt: "2026-04-07T00:04:00.000Z",
        changedFiles: ["src/current.ts"],
        worktree: { baseDir: "/repo/.agent-workbench", worktreePath: "/repo/.agent-workbench/current", branch: "awb/repo/current", targetBranch: "main" }
      },
      {
        ...createAgentSkeleton("coding", "Repair Coding Pass 2", "Latest current cycle.", "gpt-5.4"),
        workflowCycleNumber: 3,
        status: "completed",
        completedAt: "2026-04-07T00:07:00.000Z",
        changedFiles: ["src/current.ts", "src/repair.ts"],
        worktree: { baseDir: "/repo/.agent-workbench", worktreePath: "/repo/.agent-workbench/repair", branch: "awb/repo/repair", targetBranch: "awb/repo/current" }
      }
    ];

    expect(service.getMergeCandidateCodingBranches(project)).toEqual(["awb/repo/current", "awb/repo/repair"]);
  });

  it("marks repairing and retrying validation in the timeline instead of leaving a stale failed state", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Keep repair status visible.",
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    workflow.workflowStage = "repair_loop";
    workflow.repair = {
      attemptCount: 2,
      maxAttempts: 4,
      status: "retrying_validation",
      latestIssueSummary: "Typecheck failed",
      latestFailureReason: "A repair pass is being revalidated.",
      lastUpdatedAt: "2026-04-07T00:05:00.000Z"
    };
    workflow.stepProgress.coding = {
      ...workflow.stepProgress.coding,
      status: "completed",
      currentActivity: "Repair pass complete"
    };
    workflow.stepProgress.integrity = {
      ...workflow.stepProgress.integrity,
      status: "running",
      currentActivity: "Re-running validation",
      currentSubstep: "Validation retry 2 of 4"
    };

    const integrityStep = buildWorkflowTimelineSteps(workflow).find((step) => step.id === "integrity");

    expect(integrityStep).toMatchObject({
      displayStatus: "retrying_validation",
      displayStatusLabel: "Retrying validation",
      repairAttemptLabel: "Repair attempt 2 of 4",
      currentSubstep: "Validation retry 2 of 4"
    });
    expect(workflowStatusSummary(workflow)).toBe("Validation retry 2 of 4 is running");
  });
});

describe("workflow repair reports", () => {
  it("collects failed integrity passes for the active workflow cycle and pairs them with coding passes", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.workflowCycle.cycleNumber = 4;
    workflow.workflowCycle.startedAt = "2026-04-07T10:00:00.000Z";
    workflow.workflowStage = "repair_loop";
    workflow.repair = {
      attemptCount: 2,
      maxAttempts: 5,
      status: "exhausted",
      latestIssueSummary: "Repairs failed repeatedly.",
      latestFailureReason: "Renderer production assets still do not load.",
      lastUpdatedAt: "2026-04-07T10:16:00.000Z"
    };
    workflow.manualHandoff = {
      reason: "repair_exhausted",
      title: "Automatic repair reached its limit",
      whatSystemWasTryingToDo: "Fix the production renderer bootstrap.",
      validationIssue: "Renderer asset paths are still invalid in Electron file mode.",
      latestFailureReason: "Renderer production assets still do not load.",
      involvedPaths: ["src/main/index.ts", "vite.config.ts"],
      shellSupported: true,
      createdAt: "2026-04-07T10:16:00.000Z"
    };
    workflow.activityLog = [
      {
        id: "activity-1",
        timestamp: "2026-04-07T10:01:00.000Z",
        source: "workflow",
        status: "running",
        title: "Coding pass started",
        detail: "Coding Pass 1",
        stepId: "coding",
        agentCategory: "coding",
        agentId: "coding-1"
      },
      {
        id: "activity-2",
        timestamp: "2026-04-07T10:04:00.000Z",
        source: "validation",
        status: "failed",
        title: "build failed",
        detail: "npm run build",
        stepId: "integrity",
        agentCategory: "integrity",
        agentId: "integrity-1"
      },
      {
        id: "activity-3",
        timestamp: "2026-04-07T10:08:00.000Z",
        source: "workflow",
        status: "running",
        title: "Repair pass started",
        detail: "Repair Coding Pass 2",
        stepId: "coding",
        agentCategory: "coding",
        agentId: "coding-2"
      },
      {
        id: "activity-4",
        timestamp: "2026-04-07T10:15:00.000Z",
        source: "validation",
        status: "failed",
        title: "build failed",
        detail: "npm run build",
        stepId: "integrity",
        agentCategory: "integrity",
        agentId: "integrity-2"
      }
    ];

    const codingOne: AgentState = {
      ...createAgentSkeleton("coding", "Coding Pass 1", "Prompt", "gpt-5.4"),
      id: "coding-1",
      workflowCycleNumber: 4,
      startedAt: "2026-04-07T10:01:00.000Z",
      completedAt: "2026-04-07T10:03:00.000Z",
      changedFiles: ["src/main/index.ts"],
      commandLog: [
        {
          command: "npm run build",
          cwd: "/repo",
          output: "build output",
          status: "completed",
          startedAt: "2026-04-07T10:02:00.000Z",
          completedAt: "2026-04-07T10:02:30.000Z",
          exitCode: 0
        }
      ]
    };
    const codingTwo: AgentState = {
      ...createAgentSkeleton("coding", "Repair Coding Pass 2", "Prompt", "gpt-5.4"),
      id: "coding-2",
      workflowCycleNumber: 4,
      startedAt: "2026-04-07T10:08:00.000Z",
      completedAt: "2026-04-07T10:12:00.000Z",
      changedFiles: ["vite.config.ts"]
    };
    const integrityOne: AgentState = {
      ...createAgentSkeleton("integrity", "Integrity Agent", "Prompt", "gpt-5.4"),
      id: "integrity-1",
      workflowCycleNumber: 4,
      status: "failed",
      startedAt: "2026-04-07T10:03:30.000Z",
      completedAt: "2026-04-07T10:04:10.000Z",
      integrityReport: {
        summary: "Build failed in Electron file mode.",
        checks: [
          {
            name: "build",
            command: "npm run build",
            status: "failed",
            outputSnippet: "renderer asset path failure"
          }
        ],
        risks: ["Absolute renderer asset paths still break file:// loading."],
        generatedAt: "2026-04-07T10:04:10.000Z"
      }
    };
    const integrityTwo: AgentState = {
      ...createAgentSkeleton("integrity", "Integrity Agent", "Prompt", "gpt-5.4"),
      id: "integrity-2",
      workflowCycleNumber: 4,
      status: "failed",
      startedAt: "2026-04-07T10:13:00.000Z",
      completedAt: "2026-04-07T10:15:30.000Z",
      integrityReport: {
        summary: "Build still fails after repair.",
        checks: [
          {
            name: "build",
            command: "npm run build",
            status: "failed",
            outputSnippet: "still loading /assets/* from filesystem root"
          }
        ],
        risks: ["Renderer production assets still do not load."],
        generatedAt: "2026-04-07T10:15:30.000Z"
      }
    };
    const oldCycleIntegrity: AgentState = {
      ...createAgentSkeleton("integrity", "Integrity Agent", "Prompt", "gpt-5.4"),
      id: "integrity-old",
      workflowCycleNumber: 3,
      status: "failed",
      integrityReport: {
        summary: "Old cycle failure",
        checks: [],
        risks: ["ignore me"],
        generatedAt: "2026-04-06T10:15:30.000Z"
      }
    };

    const attempts = collectRepairAttemptReports(workflow, [
      oldCycleIntegrity,
      integrityTwo,
      codingTwo,
      codingOne,
      integrityOne
    ]);

    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({
      attemptNumber: 1,
      codingAgent: { id: "coding-1" },
      integrityAgent: { id: "integrity-1" }
    });
    expect(attempts[1]).toMatchObject({
      attemptNumber: 2,
      codingAgent: { id: "coding-2" },
      integrityAgent: { id: "integrity-2" }
    });
    expect(attempts[1].relatedActivity.map((event) => event.id)).toContain("activity-4");
  });

  it("builds a shareable markdown repair report", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.workflowCycle.cycleNumber = 2;
    workflow.workflowStage = "repair_loop";
    workflow.workflowStopReason = "repair_budget_exhausted";
    workflow.ultimateGoal.summary = "Ship a working Electron shell.";
    workflow.scopedGoal = {
      id: "goal-1",
      sourceRecommendationId: "rec-1",
      summary: "Fix Electron production renderer assets",
      executionBrief: "Use relative asset paths for file mode.",
      acceptanceCriteria: ["Renderer loads in production."],
      constraints: [],
      testStrategy: ["Run build and validate Electron file-mode startup."],
      createdAt: "2026-04-07T10:00:00.000Z"
    };
    workflow.repair = {
      attemptCount: 1,
      maxAttempts: 1,
      status: "exhausted",
      latestIssueSummary: "Build still fails after repair.",
      latestFailureReason: "Renderer production assets still do not load.",
      lastUpdatedAt: "2026-04-07T10:15:30.000Z"
    };
    workflow.manualHandoff = {
      reason: "repair_exhausted",
      title: "Automatic repair reached its limit",
      whatSystemWasTryingToDo: "Fix Electron production renderer assets",
      validationIssue: "Renderer asset paths remain incorrect.",
      latestFailureReason: "Renderer production assets still do not load.",
      involvedPaths: ["vite.config.ts"],
      shellSupported: true,
      createdAt: "2026-04-07T10:16:00.000Z"
    };
    workflow.activityLog = [
      {
        id: "activity-1",
        timestamp: "2026-04-07T10:15:00.000Z",
        source: "validation",
        status: "failed",
        title: "build failed",
        detail: "npm run build",
        stepId: "integrity",
        agentCategory: "integrity",
        agentId: "integrity-1"
      }
    ];

    const integrity: AgentState = {
      ...createAgentSkeleton("integrity", "Integrity Agent", "Prompt", "gpt-5.4"),
      id: "integrity-1",
      workflowCycleNumber: 2,
      status: "failed",
      integrityReport: {
        summary: "Build still fails after repair.",
        checks: [
          {
            name: "build",
            command: "npm run build",
            status: "failed",
            outputSnippet: "file:///assets/app.js not found"
          }
        ],
        risks: ["Renderer production assets still do not load."],
        generatedAt: "2026-04-07T10:15:30.000Z"
      }
    };

    const markdown = buildRepairReportMarkdown("Agentic Workbench", workflow, [integrity]);

    expect(markdown).toContain("# Repair Failure Report");
    expect(markdown).toContain("Project: Agentic Workbench");
    expect(markdown).toContain("## Manual Handoff");
    expect(markdown).toContain("## Attempt 1");
    expect(markdown).toContain("Renderer production assets still do not load.");
    expect(markdown).toContain("npm run build");
  });
});

describe("workflow guardrails", () => {
  it("rejects oversized recommendation candidates and preserves bounded ones", () => {
    expect(sanitizeRecommendationForCycle(makeRecommendation({
      title: "Implement the entire phase 1 workflow end-to-end",
      summary: "Complete the whole app across the repo in one pass.",
      estimatedScope: "large",
      relatedPaths: [
        "src/main/index.ts",
        "src/preload/index.ts",
        "src/renderer/App.tsx",
        "src/runtime/appService.ts",
        "src/shared/workflow.ts"
      ]
    }))).toBeUndefined();

    expect(sanitizeRecommendationForCycle(makeRecommendation({
      title: "Fix the renderer asset base path",
      summary: "Make the Electron production renderer use relative asset URLs.",
      estimatedScope: "small",
      relatedPaths: ["src/main/index.ts", "vite.config.ts", "src/renderer/App.tsx", "src/renderer/styles.css", "src/shared/types.ts"]
    }))).toMatchObject({
      title: "Fix the renderer asset base path",
      estimatedScope: "small",
      relatedPaths: ["src/main/index.ts", "vite.config.ts", "src/renderer/App.tsx", "src/renderer/styles.css"]
    });

    expect(sanitizeRecommendationForCycle(makeRecommendation({
      title: "Coordinate the next workflow slice",
      summary: "Touch renderer state, preload wiring, runtime orchestration, merge handling, validation output, and tests together.",
      estimatedScope: "medium",
      relatedPaths: [
        "src/main/index.ts",
        "src/preload/index.ts",
        "src/renderer/App.tsx",
        "src/runtime/appService.ts",
        "src/shared/workflow.ts",
        "src/tests/unit.spec.ts"
      ]
    }))).toBeUndefined();
  });

  it("normalizes long checklist recommendation titles before applying breadth limits", () => {
    const recommendation = sanitizeRecommendationForCycle(makeRecommendation({
      title: "Satisfy goal check: App shows key performance statistics including returns, volatility, Sharpe ratio, maximum drawdown, beta, correlation, rolling context, benchmark comparison, and risk regime cues",
      summary: "Gather direct implementation and validation evidence for this required check.",
      rationale: "The goal checklist blocks completion until this required analytics check has direct repository evidence.",
      expectedImpact: "This moves an explicit required check toward evidenced completion.",
      estimatedScope: "small",
      relatedPaths: [
        "src/renderer/index.html",
        "src/shared/performanceStats.ts",
        "tests/performanceStats.test.ts"
      ]
    }));

    expect(recommendation).toMatchObject({
      summary: "Gather direct implementation and validation evidence for this required check.",
      estimatedScope: "small",
      relatedPaths: [
        "src/renderer/index.html",
        "src/shared/performanceStats.ts",
        "tests/performanceStats.test.ts"
      ]
    });
    expect(recommendation?.title.startsWith("Satisfy goal check:")).toBe(true);
    expect(recommendation?.title.length).toBeLessThanOrEqual(96);
  });

  it("tightens scoped goals to one coding-agent pass", () => {
    const scopedGoal = sanitizeScopedGoalForSingleAgent({
      id: "goal-1",
      sourceRecommendationId: "rec-1",
      summary: "Implement the next step across the entire phase 1 workflow and supporting systems",
      executionBrief: "Touch the renderer, preload, runtime, persistence, and workflow orchestration to close the gap.",
      acceptanceCriteria: ["One", "Two", "Three", "Four", "Five"],
      constraints: ["Keep IPC typed."],
      testStrategy: ["Run typecheck", "Run build", "Run tests", "Run smoke test"],
      createdAt: "2026-04-07T00:00:00.000Z"
    });

    expect(scopedGoal.summary.length).toBeLessThanOrEqual(110);
    expect(scopedGoal.executionBrief).toContain("one coherent coding pass");
    expect(scopedGoal.executionBrief).toContain("largest reviewable batch");
    expect(scopedGoal.constraints).toContain("Keep this work scoped to one coherent coding agent pass.");
    expect(scopedGoal.constraints).toContain("Batch related checks only when they share implementation paths, tests, or evidence.");
    expect(scopedGoal.acceptanceCriteria).toHaveLength(5);
    expect(scopedGoal.testStrategy).toHaveLength(4);
  });

  it("stops retries early for environment blockers but keeps repeated failures repairable", () => {
    const environmentFailure = assessIntegrityFailure({
      summary: "Typecheck could not run.",
      checks: [
        {
          name: "typecheck",
          command: "npm run typecheck",
          status: "failed",
          outputSnippet: "sh: 1: tsc: not found"
        }
      ],
      risks: ["node_modules is missing, and there is no global tsc."],
      generatedAt: "2026-04-07T00:00:00.000Z"
    });
    expect(environmentFailure).toMatchObject({
      kind: "environment_blocker",
      shouldRetry: false
    });

    const repeatedFailure = assessIntegrityFailure(
      {
        summary: "Build still fails after repair.",
        checks: [
          {
            name: "build",
            command: "npm run build",
            status: "failed",
            outputSnippet: "dist/renderer/index.html still points at /assets/app.js"
          }
        ],
        risks: ["Renderer production assets still do not load."],
        generatedAt: "2026-04-07T00:02:00.000Z"
      },
      [
        {
          summary: "Build failed before the repair.",
          checks: [
            {
              name: "build",
              command: "npm run build",
              status: "failed",
              outputSnippet: "dist/renderer/index.html still points at /assets/app.js"
            }
          ],
          risks: ["Renderer production assets still do not load."],
          generatedAt: "2026-04-07T00:01:00.000Z"
        }
      ]
    );
    expect(repeatedFailure).toMatchObject({
      kind: "repeated_failure",
      shouldRetry: true
    });
    expect(repeatedFailure.latestFailureReason).toContain("change strategy explicitly");
  });

  it("keeps code-level module failures repairable and ignores generic retry noise in repeated signatures", () => {
    const repairableFailure = assessIntegrityFailure({
      summary: "Tests fail because one local import is wrong.",
      checks: [
        {
          name: "test",
          command: "npm run test",
          status: "failed",
          outputSnippet: "Error: Cannot find module './Button' from src/components/App.test.tsx"
        }
      ],
      risks: ["A project-relative import path is still broken in the test file."],
      generatedAt: "2026-04-07T00:00:00.000Z"
    });

    expect(repairableFailure).toMatchObject({
      kind: "repairable",
      shouldRetry: true
    });

    const repeatedFailure = assessIntegrityFailure(
      {
        summary: "Build still fails after repair.",
        checks: [
          {
            name: "build",
            command: "npm run build",
            status: "failed",
            outputSnippet: "dist/renderer/index.html still points at /assets/app.js"
          }
        ],
        risks: ["Investigate failing command: npm run build"],
        generatedAt: "2026-04-07T00:02:00.000Z"
      },
      [
        {
          summary: "Build failed before the repair.",
          checks: [
            {
              name: "build",
              command: "npm run build",
              status: "failed",
              outputSnippet: "dist/renderer/index.html still points at /assets/app.js"
            }
          ],
          risks: ["Renderer production assets still do not load."],
          generatedAt: "2026-04-07T00:01:00.000Z"
        }
      ]
    );

    expect(repeatedFailure).toMatchObject({
      kind: "repeated_failure",
      shouldRetry: true
    });
  });

  it("builds a repair strategy brief from prior repair attempts", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.workflowCycle.cycleNumber = 3;
    workflow.approvedRecommendation = approveRecommendation(
      makeRecommendation({
        relatedPaths: ["src/app.ts", "src/renderer/view.tsx", "src/shared/state.ts"]
      })
    );

    const codingOne: AgentState = {
      ...createAgentSkeleton("coding", "Repair Coding Pass 1", "Prompt", "gpt-5.4"),
      id: "coding-1",
      workflowCycleNumber: 3,
      changedFiles: ["src/app.ts"],
      lastMessageSnippet: "Adjusted the renderer asset bootstrap.",
      startedAt: "2026-04-07T10:01:00.000Z",
      completedAt: "2026-04-07T10:03:00.000Z"
    };
    const integrityOne: AgentState = {
      ...createAgentSkeleton("integrity", "Integrity Agent", "Prompt", "gpt-5.4"),
      id: "integrity-1",
      workflowCycleNumber: 3,
      status: "failed",
      integrityReport: {
        summary: "Build still fails after repair.",
        checks: [
          {
            name: "build",
            command: "npm run build",
            status: "failed",
            outputSnippet: "dist/renderer/index.html still points at /assets/app.js"
          }
        ],
        risks: ["Renderer production assets still do not load."],
        generatedAt: "2026-04-07T10:04:00.000Z"
      }
    };
    const codingTwo: AgentState = {
      ...createAgentSkeleton("coding", "Repair Coding Pass 2", "Prompt", "gpt-5.4"),
      id: "coding-2",
      workflowCycleNumber: 3,
      changedFiles: ["src/app.ts"],
      startedAt: "2026-04-07T10:05:00.000Z",
      completedAt: "2026-04-07T10:06:00.000Z"
    };
    const integrityTwo: AgentState = {
      ...createAgentSkeleton("integrity", "Integrity Agent", "Prompt", "gpt-5.4"),
      id: "integrity-2",
      workflowCycleNumber: 3,
      status: "failed",
      integrityReport: {
        summary: "Build still fails after repair.",
        checks: [
          {
            name: "build",
            command: "npm run build",
            status: "failed",
            outputSnippet: "dist/renderer/index.html still points at /assets/app.js"
          }
        ],
        risks: ["Renderer production assets still do not load."],
        generatedAt: "2026-04-07T10:07:00.000Z"
      }
    };

    const strategy = buildRepairStrategyContext(workflow, [
      codingOne,
      integrityOne,
      codingTwo,
      integrityTwo
    ]);

    expect(strategy.recurringFailureCount).toBe(2);
    expect(strategy.recentAttemptSummaries).toHaveLength(2);
    expect(strategy.recentAttemptSummaries[0]).toContain("Attempt 1");
    expect(strategy.focusHints.some((hint) => hint.includes("repeated 2 times"))).toBe(true);
    expect(strategy.focusHints.some((hint) => hint.includes("src/app.ts"))).toBe(true);
    expect(strategy.focusHints.some((hint) => hint.includes("src/renderer/view.tsx"))).toBe(true);
    expect(strategy.retryableRisks).toContain("Renderer production assets still do not load.");
  });
});

describe("workflow recommendations", () => {
  it("builds repo-aware ranked recommendations with rationale and a five-item cap", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Improve workflow observability in the renderer.",
      detailedIntent: "Add live execution updates, clearer repair state, and better next-step choices.",
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    workflow.memory.knownOpenIssues = [
      {
        id: "issue-1",
        title: "Renderer workflow state is hard to inspect",
        detail: "The workflow only shows a short status line for each agent.",
        source: "integrity",
        status: "open",
        recordedAt: "2026-04-07T00:00:00.000Z"
      }
    ];
    workflow.memory.lastAcceptedDecisions = [
      {
        id: "decision-1",
        kind: "recommendation",
        title: "Add workflow observability",
        summary: "Expose active step progress in the renderer.",
        decidedAt: "2026-04-07T00:00:00.000Z",
        cycleNumber: 1
      }
    ];
    workflow.memory.perCycleSummaries = [
      {
        cycleNumber: 1,
        summary: "Added the first workflow step cards.",
        openIssueIds: ["issue-1"],
        createdAt: "2026-04-07T00:00:00.000Z"
      }
    ];

    const stats: ProjectStats = {
      projectRoot: "/repo",
      kind: "git",
      totalFiles: 10,
      totalFolders: 4,
      totalSizeBytes: 10_240,
      includedFiles: 8,
      includedFolders: 3,
      includedSizeBytes: 8_192,
      excludedFiles: 2,
      excludedFolders: 1,
      excludedSizeBytes: 2_048,
      excludedPaths: [],
      fileTypeBreakdown: { TypeScript: 6, CSS: 1, Markdown: 1 },
      languageBreakdown: { TypeScript: 6, CSS: 1, Markdown: 1 },
      entryPoints: ["src/renderer/App.tsx", "src/runtime/appService.ts"],
      manifestFiles: ["package.json"],
      testsPresent: false,
      primaryManagers: ["npm"],
      explanation: "Small Electron repo"
    };
    const overview: ProjectOverview = {
      summary: "Electron workbench",
      architecture: "Electron main process with React renderer and typed IPC.",
      importantFiles: ["src/renderer/App.tsx", "src/runtime/appService.ts"],
      subsystemSummaries: [],
      dependencyHighlights: [],
      recommendations: [],
      source: "deterministic",
      generatedAt: "2026-04-07T00:00:00.000Z"
    };
    const recommendations = buildWorkflowRecommendations({
      workflow,
      agents: [
        {
          ...createAgentSkeleton("coding", "Coding Pass 1", "Implement the transcript panel.", "gpt-5.4"),
          changedFiles: ["src/renderer/App.tsx", "src/renderer/styles.css"]
        }
      ],
      scan: {
        kind: "git",
        files: [
          { absolutePath: "/repo/src/renderer/App.tsx", relativePath: "src/renderer/App.tsx", size: 4_096, language: "TypeScript" },
          { absolutePath: "/repo/src/runtime/appService.ts", relativePath: "src/runtime/appService.ts", size: 4_096, language: "TypeScript" },
          { absolutePath: "/repo/src/tests/unit.spec.ts", relativePath: "src/tests/unit.spec.ts", size: 2_048, language: "TypeScript" }
        ],
        stats,
        dependencies: []
      },
      overview,
      objective: "deliver",
      maxOptions: 8
    });

    expect(recommendations).toHaveLength(5);
    expect(recommendations.map((entry) => entry.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(recommendations.map((entry) => entry.title)).size).toBe(recommendations.length);
    expect(recommendations.every((entry) => entry.rationale.length > 10 && entry.expectedImpact.length > 10)).toBe(true);
    expect(recommendations.every((entry) => entry.relatedPaths.length <= 4 && entry.estimatedScope !== "large")).toBe(true);
    expect(recommendations.some((entry) => entry.relatedPaths.includes("src/renderer/App.tsx"))).toBe(true);
  });

  it("ranks unmet required goal checks ahead of generic recent-change stabilization", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Build a desktop market analytics dashboard.",
      detailedIntent: "The app should include direct drawdown and rolling-metric research workflows.",
      successCriteria: [
        "App includes drawdown visualization and recovery analysis",
        "App includes rolling metrics such as rolling volatility and rolling Sharpe"
      ],
      constraints: ["Keep the app usable without premium data credentials."],
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    workflow.goalChecklist = buildGoalChecklistFromUltimateGoal(
      workflow.ultimateGoal,
      [],
      "2026-04-07T00:00:00.000Z"
    );

    const stats: ProjectStats = {
      projectRoot: "/repo",
      kind: "git",
      totalFiles: 5,
      totalFolders: 4,
      totalSizeBytes: 12_288,
      includedFiles: 5,
      includedFolders: 4,
      includedSizeBytes: 12_288,
      excludedFiles: 0,
      excludedFolders: 0,
      excludedSizeBytes: 0,
      excludedPaths: [],
      fileTypeBreakdown: { TypeScript: 4, JSON: 1 },
      languageBreakdown: { TypeScript: 4, JSON: 1 },
      entryPoints: ["src/renderer/App.tsx"],
      manifestFiles: ["package.json"],
      testsPresent: true,
      primaryManagers: ["npm"],
      explanation: "Small Electron analytics repo"
    };

    const recommendations = buildWorkflowRecommendations({
      workflow,
      agents: [
        {
          ...createAgentSkeleton("coding", "Coding Pass 1", "Stabilize package scripts.", "gpt-5.4"),
          changedFiles: ["package.json"]
        }
      ],
      scan: {
        kind: "git",
        files: [
          { absolutePath: "/repo/src/renderer/App.tsx", relativePath: "src/renderer/App.tsx", size: 4_096, language: "TypeScript" },
          { absolutePath: "/repo/src/analytics/drawdown.ts", relativePath: "src/analytics/drawdown.ts", size: 2_048, language: "TypeScript" },
          { absolutePath: "/repo/src/analytics/rollingMetrics.ts", relativePath: "src/analytics/rollingMetrics.ts", size: 2_048, language: "TypeScript" },
          { absolutePath: "/repo/src/tests/analytics.spec.ts", relativePath: "src/tests/analytics.spec.ts", size: 2_048, language: "TypeScript" },
          { absolutePath: "/repo/package.json", relativePath: "package.json", size: 1_024, language: "JSON" }
        ],
        stats,
        dependencies: []
      },
      overview: undefined,
      objective: "deliver",
      maxOptions: 5
    });

    expect(recommendations[0]?.title).toContain("Satisfy work package:");
    expect(recommendations[0]?.summary).toContain("related required checks");
    expect(recommendations[0]?.estimatedScope).toBe("medium");
    expect(recommendations.slice(0, 2).every((entry) => /^Satisfy (?:work package|goal check):/.test(entry.title))).toBe(true);
    const stabilizeIndex = recommendations.findIndex((entry) => entry.title.startsWith("Stabilize recent work"));
    expect(stabilizeIndex === -1 || stabilizeIndex > 1).toBe(true);
  });

  it("consolidates duplicate semantic checklist constraints before computing progress", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Build a portfolio intelligence dashboard.",
      constraints: [
        "Preserve a clean separation between data connectors, normalized data schemas, analytics engines, recommendation logic, and UI components."
      ],
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    const baseChecklist = buildGoalChecklistFromUltimateGoal(
      workflow.ultimateGoal,
      [],
      "2026-04-07T00:00:00.000Z"
    );
    const canonicalConstraint = baseChecklist.find((check) => check.source === "constraint");
    expect(canonicalConstraint).toBeTruthy();

    workflow.goalChecklist = applyGoalChecklistUpdates(
      baseChecklist,
      [
        {
          action: "add",
          id: "constraint-architecture-separation",
          title: "Constraint preserved: Preserve a clean separation between data connectors, normalized data schemas, analytics engines, recommendation logic, and UI components.",
          required: true,
          status: "unmet",
          evidence: "The supplied workflow source of truth lists this as a highest-impact open check.",
          relatedPaths: ["docs/goal-evidence.md"]
        },
        {
          action: "update",
          id: canonicalConstraint?.id,
          title: canonicalConstraint?.title ?? "Constraint preserved: Preserve a clean separation between data connectors, normalized data schemas, analytics...",
          status: "met",
          evidence: "src/architecture/layerSeparation.test.ts asserts zero forbidden dependencies between connector, schema, analytics, recommendation, and UI layers.",
          relatedPaths: ["src/architecture/layerSeparation.test.ts"]
        }
      ],
      { timestamp: "2026-04-07T00:03:00.000Z", ultimateGoal: workflow.ultimateGoal, cycleNumber: 1 }
    );

    const separationChecks = workflow.goalChecklist.filter((check) =>
      `${check.title} ${check.description}`.toLowerCase().includes("separation")
    );
    expect(separationChecks).toHaveLength(1);
    expect(separationChecks[0]?.status).toBe("unmet");
    expect(separationChecks[0]?.evidence).toContain("Consolidated");
    expect(separationChecks[0]?.sourceCheckIds).toContain("constraint-architecture-separation");
    expect(separationChecks[0]?.evidenceHistory?.some((entry) => entry.evidence.includes("layerSeparation.test.ts"))).toBe(true);

    const reconsolidated = buildGoalChecklistFromUltimateGoal(
      workflow.ultimateGoal,
      workflow.goalChecklist,
      "2026-04-07T00:04:00.000Z"
    );
    const reconsolidatedConstraint = reconsolidated.find((check) =>
      `${check.title} ${check.description}`.toLowerCase().includes("separation")
    );
    expect(reconsolidatedConstraint?.evidence.match(/Consolidated/g)).toHaveLength(1);

    workflow.workflowCycle.status = "completed";
    const progress = estimateUltimateGoalProgress({
      workflow,
      agents: [makePassedIntegrityAgent()],
      scan: {
        kind: "git",
        files: [],
        stats: {
          projectRoot: "/repo",
          kind: "git",
          totalFiles: 1,
          totalFolders: 1,
          totalSizeBytes: 1_024,
          includedFiles: 1,
          includedFolders: 1,
          includedSizeBytes: 1_024,
          excludedFiles: 0,
          excludedFolders: 0,
          excludedSizeBytes: 0,
          excludedPaths: [],
          fileTypeBreakdown: { TypeScript: 1 },
          languageBreakdown: { TypeScript: 1 },
          entryPoints: ["src/App.tsx"],
          manifestFiles: ["package.json"],
          testsPresent: true,
          primaryManagers: ["npm"],
          explanation: "Dashboard repo"
        },
        dependencies: []
      },
      overview: undefined,
      objective: "deliver",
      maxOptions: 5
    });

    expect(progress.percentComplete).toBeLessThan(100);
  });

  it("keeps backlog and observations out of Ultimate Goal completion math", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Ship a stable workflow checklist ledger.",
      successCriteria: ["Required ledger checks are persisted and evidenced"],
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    workflow.goalChecklist = applyGoalChecklistUpdates(
      buildGoalChecklistFromUltimateGoal(workflow.ultimateGoal, [], "2026-04-07T00:00:00.000Z"),
      [
        {
          title: "Required ledger checks are persisted and evidenced",
          status: "met",
          evidence: "src/runtime/workflowRecommendations.ts persists required checklist metadata."
        },
        {
          action: "add",
          title: "Polish the checklist labels later",
          itemKind: "backlog",
          required: false,
          status: "unmet",
          evidence: "Non-blocking label polish."
        },
        {
          action: "add",
          title: "Observe whether future grouping copy can be nicer",
          itemKind: "observation",
          required: false,
          status: "unknown",
          evidence: "Observation only."
        }
      ],
      { timestamp: "2026-04-07T00:01:00.000Z", ultimateGoal: workflow.ultimateGoal, cycleNumber: 1 }
    );
    workflow.workflowCycle.status = "completed";

    const progress = estimateUltimateGoalProgress({
      ...makeWorkflowRecommendationContext(workflow),
      agents: [makePassedIntegrityAgent()]
    });

    expect(workflow.goalChecklist.filter((check) => check.itemKind !== "required")).toHaveLength(2);
    expect(progress.percentComplete).toBe(100);
  });

  it("defaults agent-suggested checks to backlog and caps normal required promotions per cycle", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Stabilize workflow checklist grouping and requirement ledger promotion.",
      successCriteria: ["Checklist grouping closes related requirements"],
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    const baseChecklist = buildGoalChecklistFromUltimateGoal(workflow.ultimateGoal, [], "2026-04-07T00:00:00.000Z");
    const checklist = applyGoalChecklistUpdates(
      baseChecklist,
      [
        { action: "add", title: "Improve the workflow copy someday", status: "unknown", required: true },
        { action: "add", title: "Checklist grouping closes related requirement evidence", status: "unmet", required: true },
        { action: "add", title: "Requirement ledger promotion remains stable", status: "unmet", required: true },
        { action: "add", title: "Workflow checklist promotion includes extra ledger diagnostics", status: "unmet", required: true },
        { action: "add", title: "Validation failed and blocks checklist completion", status: "unmet", required: true }
      ],
      {
        timestamp: "2026-04-07T00:02:00.000Z",
        ultimateGoal: workflow.ultimateGoal,
        cycleNumber: 2,
        maxNewRequiredChecks: 2
      }
    );
    const newAgentChecks = checklist.filter((check) => check.source === "agent");
    const backlog = newAgentChecks.filter((check) => check.itemKind !== "required");

    expect(backlog.some((check) => check.title === "Improve the workflow copy someday")).toBe(true);
    expect(checklist.filter((check) =>
      check.itemKind === "required" &&
      (
        check.title.includes("Checklist grouping closes") ||
        check.title.includes("Requirement ledger promotion")
      )
    )).toHaveLength(2);
    expect(checklist.find((check) => check.title.includes("extra ledger diagnostics"))?.classificationReason).toContain("normal cap");
    expect(checklist.find((check) => check.title.includes("Validation failed"))?.promotionReason).toContain("normal cap");
  });

  it("consolidates exact and near duplicate checks without merging unrelated requirements", () => {
    const checks = consolidateGoalChecklist([
      makeGoalCheck({
        id: "a",
        title: "Workflow checklist stores canonical keys",
        description: "Required checks keep a canonical key for deduplication.",
        status: "met",
        evidence: "src/runtime/workflowRecommendations.ts stores canonicalKey.",
        relatedPaths: ["src/runtime/workflowRecommendations.ts"],
        source: "deterministic"
      }),
      makeGoalCheck({
        id: "b",
        title: "Workflow checklist stores canonical keys",
        description: "Duplicate exact title.",
        status: "unknown",
        evidence: "A duplicate was observed.",
        source: "agent"
      }),
      makeGoalCheck({
        id: "c",
        title: "Canonical checklist keys are persisted for workflow deduplication",
        description: "Near duplicate with the same acceptance phrase.",
        status: "unmet",
        evidence: "src/runtime/workflowRecommendations.ts still needs canonicalKey evidence.",
        relatedPaths: ["src/runtime/workflowRecommendations.ts"],
        source: "agent"
      }),
      makeGoalCheck({
        id: "d",
        title: "Renderer keyboard shortcuts remain visible",
        description: "Unrelated renderer behavior.",
        status: "unknown",
        relatedPaths: ["src/renderer/App.tsx"],
        source: "success_criterion"
      })
    ]);
    const canonical = checks.find((check) => check.sourceCheckIds?.includes("c"));

    expect(checks).toHaveLength(2);
    expect(canonical?.status).toBe("unmet");
    expect(canonical?.relatedCheckIds).toEqual(expect.arrayContaining(["a", "b"]));
    expect(canonical?.evidenceHistory?.map((entry) => entry.checkId)).toEqual(expect.arrayContaining(["a", "b", "c"]));
    expect(checks.some((check) => check.title.includes("Renderer keyboard"))).toBe(true);
  });

  it("sanitizes checklist evidence, consolidation notes, and history idempotently", () => {
    const repeatedNote = "Consolidated 4 semantically equivalent checklist entries.";
    const hugeEvidence = [
      "src/runtime/stateSanitizer.ts caps persisted checklist evidence.",
      ...Array.from({ length: 80 }, () => repeatedNote),
      "src/runtime/stateSanitizer.ts caps persisted checklist evidence.",
      "x".repeat(5_000)
    ].join("\n");
    const check = makeGoalCheck({
      id: "bloated-check",
      title: "Essential status fields stay stable",
      status: "unmet",
      evidence: hugeEvidence,
      evidenceHistory: Array.from({ length: 8 }, (_, index) => ({
        checkId: `history-${index}`,
        title: "Historical evidence",
        source: "agent" as const,
        status: "unknown" as const,
        evidence: `${"history ".repeat(200)}${index}`,
        createdAt: `2026-04-07T00:0${index}:00.000Z`,
        updatedAt: `2026-04-07T00:0${index}:30.000Z`
      }))
    });

    const sanitized = sanitizeGoalAttainmentCheck(check);
    const sanitizedAgain = sanitizeGoalAttainmentCheck(sanitized);

    expect(sanitized).toEqual(sanitizedAgain);
    expect(sanitized.id).toBe("bloated-check");
    expect(sanitized.title).toBe("Essential status fields stay stable");
    expect(sanitized.status).toBe("unmet");
    expect(sanitized.evidence.length).toBeLessThanOrEqual(CHECKLIST_EVIDENCE_MAX_CHARS);
    expect(sanitized.evidence.match(/Consolidated/g)).toHaveLength(1);
    expect(sanitized.evidenceHistory).toHaveLength(CHECKLIST_EVIDENCE_HISTORY_MAX_ENTRIES);
    expect(sanitized.evidenceHistory?.every((entry) => entry.evidence.length <= 750)).toBe(true);
  });

  it("sanitizes single-entry checklist consolidation paths", () => {
    const repeatedNote = "Consolidated 3 semantically equivalent checklist entries.";
    const [check] = consolidateGoalChecklist([
      makeGoalCheck({
        id: "single-bloated",
        title: "Single checklist entry gets compacted",
        status: "unknown",
        evidence: `${repeatedNote}\n${repeatedNote}\n${"large evidence ".repeat(600)}`,
        evidenceHistory: Array.from({ length: 7 }, (_, index) => ({
          checkId: `single-history-${index}`,
          title: "Single history",
          source: "agent" as const,
          status: "unknown" as const,
          evidence: "raw output ".repeat(200),
          updatedAt: `2026-04-07T00:1${index}:00.000Z`
        }))
      })
    ]);

    expect(check?.evidence.length).toBeLessThanOrEqual(CHECKLIST_EVIDENCE_MAX_CHARS);
    expect(check?.evidence.match(/Consolidated/g)).toHaveLength(1);
    expect(check?.evidenceHistory).toHaveLength(CHECKLIST_EVIDENCE_HISTORY_MAX_ENTRIES);
    expect(check?.id).toBe("single-bloated");
  });

  it("compacts persisted and renderer project state to bounded workflow payloads", () => {
    const identity = createProjectIdentity({
      kind: "git",
      projectRoot: "/repo",
      projectName: "repo",
      repositoryName: "repo",
      normalizedRemotes: ["git@github.com:awb-tests/repo.git"],
      manifestSignature: "manifest",
      treeSignature: "tree"
    });
    const record = createLocalProjectRecord(
      "project-1",
      "/repo",
      "/repo",
      "/repo",
      "/repo",
      identity,
      {
        interfaceSchemaVersion: 1,
        appMinVersion: "0.1.0",
        projectKind: "git"
      }
    );
    record.workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Keep renderer state bounded.",
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    record.workflow.goalChecklist = [
      makeGoalCheck({
        id: "heavy-check",
        title: "Renderer payload keeps checklist evidence short",
        status: "unmet",
        evidence: "evidence ".repeat(400_000)
      })
    ];
    const agent = createAgentSkeleton("coding", "Heavy history agent", "prompt ".repeat(2_000), "gpt-5.4-mini");
    agent.events = Array.from({ length: 1_400 }, (_, index) => ({
      id: `event-${index}`,
      agentId: agent.id,
      timestamp: `2026-04-07T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
      type: "raw" as const,
      title: `Event ${index}`,
      detail: "detail ".repeat(500),
      raw: { output: "raw ".repeat(500) }
    }));
    agent.commandLog = Array.from({ length: 700 }, (_, index) => ({
      itemId: `cmd-${index}`,
      command: `npm test -- --run ${index} ${"x".repeat(100)}`,
      output: "output ".repeat(2_000),
      status: "completed",
      startedAt: `2026-04-07T00:${String(index % 60).padStart(2, "0")}:10.000Z`,
      completedAt: `2026-04-07T00:${String(index % 60).padStart(2, "0")}:20.000Z`,
      exitCode: 0
    }));
    record.agents = [agent];

    const persisted = sanitizeProjectRecord(record).record;
    const renderer = sanitizeProjectRecord(record, { renderer: true }).record;

    expect(persisted.agents.reduce((count, entry) => count + entry.events.length, 0)).toBeLessThanOrEqual(1_000);
    expect(persisted.agents.reduce((count, entry) => count + entry.commandLog.length, 0)).toBeLessThanOrEqual(450);
    expect(renderer.workflow.goalChecklist[0]?.evidence.length).toBeLessThanOrEqual(CHECKLIST_RENDERER_EVIDENCE_MAX_CHARS);
    expect(JSON.stringify(renderer.workflow.goalChecklist).length).toBeLessThan(2_000);
    expect(JSON.stringify(renderer.workflow).length).toBeLessThan(25_000);
  });

  it("flags vague checklist items without turning concrete acceptance criteria into vague work", () => {
    const vague = auditGoalChecklist([
      makeGoalCheck({
        id: "vague",
        title: "Improve workflow robustness",
        description: "Make it better and cleaner.",
        source: "agent"
      }),
      makeGoalCheck({
        id: "concrete",
        title: "Improve validation handling when npm test fails",
        description: "tests/unit.spec.ts asserts failed validation keeps the required check unmet.",
        relatedPaths: ["src/tests/unit.spec.ts"],
        source: "agent"
      })
    ]);

    expect(vague).toHaveLength(2);
    expect(vague.find((check) => check.id === "vague")?.auditFlags).toEqual(expect.arrayContaining(["vague", "not_observable"]));
    expect(vague.find((check) => check.id === "vague")?.needsRefinement).toBe(true);
    expect(vague.find((check) => check.id === "concrete")?.auditFlags ?? []).not.toContain("vague");
  });

  it("builds deterministic work packages from related required checks", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Stabilize workflow checklist grouping.",
      successCriteria: [
        "Workflow checklist classifies required ledger items",
        "Workflow checklist groups related ledger items",
        "Renderer exposes keyboard shortcut hints"
      ],
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    workflow.goalChecklist = applyGoalChecklistUpdates(
      buildGoalChecklistFromUltimateGoal(workflow.ultimateGoal, [], "2026-04-07T00:00:00.000Z"),
      [
        {
          title: "Workflow checklist classifies required ledger items",
          status: "unmet",
          evidence: "Runtime checklist classification is still open.",
          relatedPaths: ["src/runtime/workflowRecommendations.ts"]
        },
        {
          title: "Workflow checklist groups related ledger items",
          status: "unmet",
          evidence: "Runtime work-package grouping is still open.",
          relatedPaths: ["src/runtime/workflowRecommendations.ts"]
        },
        {
          title: "Renderer exposes keyboard shortcut hints",
          status: "unknown",
          relatedPaths: ["src/renderer/App.tsx"]
        },
        {
          action: "add",
          title: "Polish renderer badge colors",
          itemKind: "backlog",
          required: false,
          status: "unmet",
          relatedPaths: ["src/renderer/App.tsx"]
        }
      ],
      { timestamp: "2026-04-07T00:01:00.000Z", ultimateGoal: workflow.ultimateGoal, cycleNumber: 1 }
    );

    const packages = buildChecklistWorkPackages(makeWorkflowRecommendationContext(workflow));
    const checklistPackage = packages.find((workPackage) => workPackage.checkIds.length >= 2);
    const singlePackage = packages.find((workPackage) => workPackage.checkIds.length === 1);

    expect(checklistPackage?.likelyPaths).toContain("src/runtime/workflowRecommendations.ts");
    expect(checklistPackage?.acceptanceHints.length).toBeGreaterThan(0);
    expect(singlePackage).toBeTruthy();
    expect((checklistPackage?.score ?? 0)).toBeGreaterThan(singlePackage?.score ?? 0);
    expect(packages.every((workPackage) => !workPackage.title.toLowerCase().includes("polish renderer badge"))).toBe(true);

    const recommendations = buildWorkflowRecommendations(makeWorkflowRecommendationContext(workflow));
    expect(recommendations[0]?.title).toMatch(/^Satisfy work package:/);
    expect(recommendations[0]?.summary).toContain("related required checks");
  });

  it("prioritizes preview-oriented recommendations without satisfying the goal by itself", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Build an inspectable workflow dashboard.",
      successCriteria: ["Workflow tab exposes the current project structure"],
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    workflow.previewRequest = {
      status: "active",
      requestedAt: "2026-04-07T00:00:00.000Z",
      startedAt: "2026-04-07T00:00:01.000Z",
      remainingCycles: 1
    };
    workflow.goalChecklist = applyGoalChecklistUpdates(
      buildGoalChecklistFromUltimateGoal(workflow.ultimateGoal, [], "2026-04-07T00:00:00.000Z"),
      [{
        title: "Workflow tab exposes the current project structure",
        status: "unknown",
        relatedPaths: ["src/renderer/App.tsx"]
      }],
      { timestamp: "2026-04-07T00:01:00.000Z", ultimateGoal: workflow.ultimateGoal, cycleNumber: 1 }
    );

    const recommendations = buildWorkflowRecommendations(makeWorkflowRecommendationContext(workflow, [
      { absolutePath: "/repo/src/renderer/App.tsx", relativePath: "src/renderer/App.tsx", size: 8_192, language: "TypeScript" },
      { absolutePath: "/repo/src/main.tsx", relativePath: "src/main.tsx", size: 512, language: "TypeScript" }
    ]));

    expect(recommendations[0]?.title).toBe("Generate runnable preview checkpoint");
    expect(isPreviewRecommendation(recommendations[0])).toBe(true);
    expect(recommendations[0]?.relatedPaths).toContain("src/renderer/App.tsx");
    expect(pickAutopilotRecommendation(recommendations, workflow)?.id).toBe(recommendations[0]?.id);
    expect(assessUltimateGoalCompletion(makeWorkflowRecommendationContext(workflow)).state).toBe("needs_more_work");
  });

  it("lets fast mode build larger coherent work packages than normal mode", () => {
    const criteria = [
      "Recommendation ranking retires multiple unmet required checks",
      "Scoped goal metadata carries targeted check IDs",
      "Acceptance evidence names grouped workflow package paths",
      "Checklist consolidation keeps required package items distinct",
      "Recommendation fallback avoids generic stabilization churn",
      "Workflow task map exposes grouped package progress"
    ];
    const buildWorkflow = (mode: "normal" | "fast") => {
      const workflow = defaultProjectWorkflowState();
      workflow.workflowMode = mode;
      workflow.ultimateGoal = {
        ...emptyUltimateGoal("user"),
        summary: "Close workflow package convergence requirements.",
        successCriteria: criteria,
        confirmedAt: "2026-04-07T00:00:00.000Z"
      };
      workflow.goalChecklist = applyGoalChecklistUpdates(
        buildGoalChecklistFromUltimateGoal(workflow.ultimateGoal, [], "2026-04-07T00:00:00.000Z"),
        criteria.map((title) => ({
          title,
          description: "The related workflow package work should be implemented together.",
          status: "unmet" as const,
          relatedPaths: ["src/runtime/workflowRecommendations.ts"]
        })),
        { timestamp: "2026-04-07T00:01:00.000Z", ultimateGoal: workflow.ultimateGoal, cycleNumber: 1 }
      );
      return workflow;
    };

    const normalPackages = buildChecklistWorkPackages(makeWorkflowRecommendationContext(buildWorkflow("normal")));
    const fastPackages = buildChecklistWorkPackages(makeWorkflowRecommendationContext(buildWorkflow("fast")));

    const normalMax = Math.max(...normalPackages.map((workPackage) => workPackage.checkIds.length));
    const fastMax = Math.max(...fastPackages.map((workPackage) => workPackage.checkIds.length));
    expect(normalMax).toBeLessThanOrEqual(4);
    expect(fastMax).toBeGreaterThan(normalMax);
    expect(fastMax).toBeGreaterThanOrEqual(5);
  });

  it("makes fast mode prefer grouped required-check completion over generic stabilization", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.workflowMode = "fast";
    const criteria = [
      "Recommendation ranking retires multiple unmet required checks",
      "Scoped goal metadata carries targeted check IDs",
      "Acceptance evidence names grouped workflow package paths",
      "Checklist consolidation keeps required package items distinct",
      "Workflow task map exposes grouped package progress"
    ];
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Finish workflow package convergence.",
      successCriteria: criteria,
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    workflow.goalChecklist = applyGoalChecklistUpdates(
      buildGoalChecklistFromUltimateGoal(workflow.ultimateGoal, [], "2026-04-07T00:00:00.000Z"),
      criteria.map((title) => ({
        title,
        description: "The requirement should close through the same workflow recommendation module.",
        status: "unmet" as const,
        relatedPaths: ["src/runtime/workflowRecommendations.ts"]
      })),
      { timestamp: "2026-04-07T00:01:00.000Z", ultimateGoal: workflow.ultimateGoal, cycleNumber: 1 }
    );

    const recommendations = buildWorkflowRecommendations({
      ...makeWorkflowRecommendationContext(workflow),
      agents: [
        {
          ...createAgentSkeleton("coding", "Coding Pass", "Touch package metadata.", "gpt-5.4"),
          changedFiles: ["package.json"]
        }
      ]
    });

    expect(recommendations[0]?.title).toMatch(/^Satisfy work package:/);
    expect(recommendations[0]?.targetedCheckIds?.length).toBeGreaterThanOrEqual(4);
    expect(recommendations[0]?.sourceWorkPackageId).toMatch(/^work-package:/);
    expect(recommendations[0]?.summary).toContain("related required checks");
    const stabilizeIndex = recommendations.findIndex((entry) => entry.title.startsWith("Stabilize recent work"));
    expect(stabilizeIndex === -1 || stabilizeIndex > 1).toBe(true);
  });

  it("keeps fast-mode new required checks capped except hard blockers and safety issues", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.workflowMode = "fast";
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Ship workflow package convergence.",
      successCriteria: ["Workflow packages retire required checks"],
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    const checklist = applyGoalChecklistUpdates(
      buildGoalChecklistFromUltimateGoal(workflow.ultimateGoal, [], "2026-04-07T00:00:00.000Z"),
      [
        {
          action: "add",
          title: "Workflow package copy can be polished later",
          status: "unknown",
          required: true
        },
        {
          action: "add",
          title: "Credential secret handling blocks completion",
          status: "unmet",
          required: true,
          evidence: "A credential safety issue blocks completion until fixed."
        }
      ],
      {
        timestamp: "2026-04-07T00:01:00.000Z",
        ultimateGoal: workflow.ultimateGoal,
        cycleNumber: 2,
        maxNewRequiredChecks: getWorkflowModeConfig("fast").maxNewRequiredChecksPerCycle
      }
    );

    expect(checklist.find((check) => check.title === "Workflow package copy can be polished later")?.itemKind).toBe("backlog");
    const safetyCheck = checklist.find((check) => check.title === "Credential secret handling blocks completion");
    expect(safetyCheck?.itemKind).toBe("required");
    expect(safetyCheck?.promotionReason).toContain("Promoted outside the normal cap");
  });

  it("does not downweight fast-mode security work behind polish", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.workflowMode = "fast";
    const criteria = [
      "Credential handling keeps secrets local-only",
      "Approval policy stays explicit before privileged operations",
      "Runtime command execution preserves sandbox safety"
    ];
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Protect workflow credential and approval safety.",
      successCriteria: criteria,
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    workflow.goalChecklist = [
      makeGoalCheck({
        id: "security-check-1",
        title: "Credential handling keeps secrets local-only",
        status: "unmet",
        source: "success_criterion",
        relatedPaths: ["src/runtime/storage.ts"]
      }),
      makeGoalCheck({
        id: "security-check-2",
        title: "Approval policy stays explicit before privileged operations",
        status: "unmet",
        source: "success_criterion",
        relatedPaths: ["src/runtime/approvalPolicy.ts"]
      }),
      makeGoalCheck({
        id: "security-check-3",
        title: "Runtime command execution preserves sandbox safety",
        status: "unknown",
        source: "constraint",
        relatedPaths: ["src/runtime/execution.ts"]
      })
    ];

    const recommendations = buildWorkflowRecommendations({
      ...makeWorkflowRecommendationContext(workflow),
      agents: [
        {
          ...createAgentSkeleton("coding", "Coding Pass", "Polish workflow labels.", "gpt-5.4"),
          changedFiles: ["src/renderer/App.tsx"]
        }
      ]
    });

    expect(recommendations[0]?.title).toMatch(/^Satisfy work package:/);
    expect(recommendations[0]?.targetedCheckIds?.length).toBeGreaterThanOrEqual(2);
    expect(recommendations[0]?.title.toLowerCase()).not.toContain("polish");
  });

  it("turns redundant checklist removals into non-blocking not-applicable checks", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Build a local-first market dashboard.",
      successCriteria: ["Dashboard renders portfolio holdings"],
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    const baseChecklist = buildGoalChecklistFromUltimateGoal(
      workflow.ultimateGoal,
      [],
      "2026-04-07T00:00:00.000Z"
    );
    const holdingsCheck = baseChecklist.find((check) => check.title === "Dashboard renders portfolio holdings");
    expect(holdingsCheck).toBeTruthy();
    workflow.goalChecklist = applyGoalChecklistUpdates(
      baseChecklist,
      [
        {
          action: "remove",
          id: holdingsCheck?.id,
          title: holdingsCheck?.title ?? "Dashboard renders portfolio holdings",
          status: "not_applicable",
          evidence: "A later repository inspection found this user-derived check is redundant with a more precise portfolio snapshot check."
        }
      ],
      { timestamp: "2026-04-07T00:03:00.000Z" }
    );

    const removedCheck = workflow.goalChecklist.find((check) => check.id === holdingsCheck?.id);
    expect(removedCheck?.required).toBe(false);
    expect(removedCheck?.status).toBe("not_applicable");
  });

  it("keeps large detected ultimate-goal checklists available for adaptive recommendations", () => {
    const detectedGoal = {
      ...emptyUltimateGoal("detected"),
      summary: "Build a compact workflow target.",
      successCriteria: Array.from({ length: 20 }, (_entry, index) => `Detected success criterion ${index + 1}`),
      constraints: Array.from({ length: 12 }, (_entry, index) => `Detected constraint ${index + 1}`),
      qualityBar: "The result is easy to validate.",
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };

    const checklist = buildGoalChecklistFromUltimateGoal(detectedGoal, [], "2026-04-07T00:00:00.000Z");
    const successCriteria = checklist.filter((check) => check.source === "success_criterion");
    const constraints = checklist.filter((check) => check.source === "constraint");

    expect(successCriteria).toHaveLength(20);
    expect(constraints).toHaveLength(12);
    expect(checklist.find((check) => check.source === "quality_bar")).toBeTruthy();
  });

  it("summarizes large checklists into semantic task groups instead of fixed item chunks", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Build a complete portfolio intelligence workstation.",
      successCriteria: [
        "Portfolio view shows holdings, market value, cash, and weights",
        "Portfolio view explains sector, industry, and theme concentration",
        "Performance analytics include returns, drawdown, volatility, and Sharpe",
        "Performance analytics reconcile deposits, withdrawals, dividends, fees, and cash flows",
        "Research intelligence includes news, filings, earnings, and peer comparisons",
        "Research intelligence includes sentiment, watchlists, and company-specific notes",
        "Risk and rebalance intelligence shows factor exposure, drift, stress, and target-weight recommendations"
      ],
      constraints: [
        "Keep brokerage credentials and API keys out of source code",
        "Keep live providers credential-gated with offline demo mode"
      ],
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    workflow.goalChecklist = buildGoalChecklistFromUltimateGoal(workflow.ultimateGoal, [], "2026-04-07T00:00:00.000Z");

    const context: WorkflowRecommendationContext = {
      workflow,
      agents: [],
      scan: {
        kind: "git",
        files: [],
        stats: {
          projectRoot: "/repo",
          kind: "git",
          totalFiles: 1,
          totalFolders: 1,
          totalSizeBytes: 1_024,
          includedFiles: 1,
          includedFolders: 1,
          includedSizeBytes: 1_024,
          excludedFiles: 0,
          excludedFolders: 0,
          excludedSizeBytes: 0,
          excludedPaths: [],
          fileTypeBreakdown: { TypeScript: 1 },
          languageBreakdown: { TypeScript: 1 },
          entryPoints: ["src/App.tsx"],
          manifestFiles: ["package.json"],
          testsPresent: true,
          primaryManagers: ["npm"],
          explanation: "Portfolio dashboard repo"
        },
        dependencies: []
      },
      overview: undefined,
      objective: "deliver",
      maxOptions: 5
    };
    const persistedTaskMap = buildChecklistTaskMap(context, "2026-04-07T00:01:00.000Z");
    const taskMap = buildChecklistTaskMapBrief(context);

    expect(persistedTaskMap.totalRequiredChecks).toBeGreaterThan(7);
    expect(persistedTaskMap.groups.some((group) => group.title === "performance analytics" && group.openCheckCount >= 2)).toBe(true);
    expect(persistedTaskMap.groups.some((group) => group.title === "security and brokerage safety")).toBe(true);
    expect(taskMap).toContain("Estimated task groups from checklist semantics");
    expect(taskMap).toContain("performance analytics");
    expect(taskMap).toContain("research intelligence");
    expect(taskMap).toContain("security and brokerage safety");
    expect(taskMap).not.toContain("random");
  });

  it("keeps long unknown checklist items ahead of generic fallback recommendations", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Build a desktop market analytics dashboard.",
      detailedIntent: "The app should include computed statistics, rolling analytics, and technical overlays.",
      successCriteria: [
        "App shows key performance statistics such as returns, volatility, Sharpe ratio, max drawdown, beta, and correlation",
        "App includes rolling metrics such as rolling volatility, rolling Sharpe, and rolling correlation",
        "User can toggle technical overlays such as moving averages and volume-based indicators"
      ],
      constraints: ["Keep the app usable without premium data credentials."],
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    workflow.goalChecklist = buildGoalChecklistFromUltimateGoal(
      workflow.ultimateGoal,
      [],
      "2026-04-07T00:00:00.000Z"
    );

    const stats: ProjectStats = {
      projectRoot: "/repo",
      kind: "git",
      totalFiles: 5,
      totalFolders: 4,
      totalSizeBytes: 12_288,
      includedFiles: 5,
      includedFolders: 4,
      includedSizeBytes: 12_288,
      excludedFiles: 0,
      excludedFolders: 0,
      excludedSizeBytes: 0,
      excludedPaths: [],
      fileTypeBreakdown: { TypeScript: 4, JSON: 1 },
      languageBreakdown: { TypeScript: 4, JSON: 1 },
      entryPoints: ["package.json", "src/main/app.ts"],
      manifestFiles: ["package.json"],
      testsPresent: true,
      primaryManagers: ["npm"],
      explanation: "Small Electron analytics repo"
    };

    const recommendations = buildWorkflowRecommendations({
      workflow,
      agents: [
        {
          ...createAgentSkeleton("coding", "Coding Pass 1", "Stabilize package scripts.", "gpt-5.4"),
          changedFiles: ["package.json"]
        }
      ],
      scan: {
        kind: "git",
        files: [
          { absolutePath: "/repo/src/main/app.ts", relativePath: "src/main/app.ts", size: 2_048, language: "TypeScript" },
          { absolutePath: "/repo/src/renderer/index.html", relativePath: "src/renderer/index.html", size: 4_096, language: "HTML" },
          { absolutePath: "/repo/src/shared/performanceStats.ts", relativePath: "src/shared/performanceStats.ts", size: 2_048, language: "TypeScript" },
          { absolutePath: "/repo/tests/startupWorkspaceReadiness.test.ts", relativePath: "tests/startupWorkspaceReadiness.test.ts", size: 2_048, language: "TypeScript" },
          { absolutePath: "/repo/package.json", relativePath: "package.json", size: 1_024, language: "JSON" }
        ],
        stats,
        dependencies: []
      },
      overview: undefined,
      objective: "deliver",
      maxOptions: 5
    });

    expect(recommendations.length).toBeGreaterThan(0);
    expect(recommendations[0]?.title).toMatch(/^Satisfy (?:work package|goal check):/);
    expect(recommendations[0]?.title).not.toContain("operator feedback");
  });

  it("does not seed checklist recommendations from unrelated recent files", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Build a portfolio intelligence dashboard with comparable company analysis.",
      detailedIntent: "The app should add peer analysis without confusing it with the last social-news slice.",
      successCriteria: [
        "The app includes a comparable company analysis module that can generate peer groups for each holding, compare valuation, growth, margins, profitability, leverage, momentum, sentiment, and recent news, and explain why each peer was selected."
      ],
      constraints: ["Keep the implementation deterministic."],
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    workflow.goalChecklist = buildGoalChecklistFromUltimateGoal(
      workflow.ultimateGoal,
      [],
      "2026-04-07T00:00:00.000Z"
    ).map((check) => ({
      ...check,
      status: "unmet" as const,
      evidence: "No comparable-company module exists yet.",
      relatedPaths: ["src", "docs/goal-evidence.md"]
    }));

    const recommendations = buildWorkflowRecommendations({
      workflow,
      agents: [
        {
          ...createAgentSkeleton("coding", "Previous Social News Pass", "Implement social monitoring.", "gpt-5.4"),
          changedFiles: ["src/analytics/socialNewsMonitor.ts", "src/analytics/socialNewsMonitor.test.ts"]
        }
      ],
      scan: {
        kind: "git",
        files: [
          { absolutePath: "/repo/src/App.tsx", relativePath: "src/App.tsx", size: 4_096, language: "TypeScript" },
          { absolutePath: "/repo/src/App.test.tsx", relativePath: "src/App.test.tsx", size: 2_048, language: "TypeScript" },
          { absolutePath: "/repo/src/analytics/socialNewsMonitor.ts", relativePath: "src/analytics/socialNewsMonitor.ts", size: 2_048, language: "TypeScript" },
          { absolutePath: "/repo/src/analytics/socialNewsMonitor.test.ts", relativePath: "src/analytics/socialNewsMonitor.test.ts", size: 2_048, language: "TypeScript" },
          { absolutePath: "/repo/docs/goal-evidence.md", relativePath: "docs/goal-evidence.md", size: 1_024, language: "Markdown" }
        ],
        stats: {
          projectRoot: "/repo",
          kind: "git",
          totalFiles: 5,
          totalFolders: 4,
          totalSizeBytes: 11_264,
          includedFiles: 5,
          includedFolders: 4,
          includedSizeBytes: 11_264,
          excludedFiles: 0,
          excludedFolders: 0,
          excludedSizeBytes: 0,
          excludedPaths: [],
          fileTypeBreakdown: { TypeScript: 4, Markdown: 1 },
          languageBreakdown: { TypeScript: 4, Markdown: 1 },
          entryPoints: ["src/App.tsx"],
          manifestFiles: ["package.json"],
          testsPresent: true,
          primaryManagers: ["npm"],
          explanation: "Portfolio dashboard repo"
        },
        dependencies: []
      },
      overview: undefined,
      objective: "deliver",
      maxOptions: 5
    });

    expect(recommendations[0]?.title).toContain("Satisfy goal check:");
    expect(recommendations[0]?.relatedPaths).toContain("docs/goal-evidence.md");
    expect(recommendations[0]?.relatedPaths).toContain("src/App.tsx");
    expect(recommendations[0]?.relatedPaths).not.toContain("src/analytics/socialNewsMonitor.ts");
  });

  it("builds an outcome strategy brief from the Ultimate Goal and open checklist", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Build a desktop market analytics dashboard.",
      detailedIntent: "The finished app should make drawdown and rolling-risk analysis obvious to a portfolio operator.",
      successCriteria: [
        "App includes drawdown visualization and recovery analysis",
        "App includes rolling metrics such as rolling volatility and rolling Sharpe"
      ],
      constraints: ["Keep offline mode usable without premium credentials."],
      nonGoals: ["Do not add brokerage trading or account-linking flows."],
      qualityBar: "The result should be test-backed, readable, and polished enough for a portfolio review.",
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    workflow.goalChecklist = buildGoalChecklistFromUltimateGoal(
      workflow.ultimateGoal,
      [],
      "2026-04-07T00:00:00.000Z"
    );

    const brief = buildOutcomeStrategyBrief({
      workflow,
      agents: [],
      scan: {
        kind: "git",
        files: [
          { absolutePath: "/repo/src/renderer/App.tsx", relativePath: "src/renderer/App.tsx", size: 4_096, language: "TypeScript" },
          { absolutePath: "/repo/src/analytics/drawdown.ts", relativePath: "src/analytics/drawdown.ts", size: 2_048, language: "TypeScript" },
          { absolutePath: "/repo/src/analytics/rollingMetrics.ts", relativePath: "src/analytics/rollingMetrics.ts", size: 2_048, language: "TypeScript" }
        ],
        stats: {
          projectRoot: "/repo",
          kind: "git",
          totalFiles: 3,
          totalFolders: 3,
          totalSizeBytes: 8_192,
          includedFiles: 3,
          includedFolders: 3,
          includedSizeBytes: 8_192,
          excludedFiles: 0,
          excludedFolders: 0,
          excludedSizeBytes: 0,
          excludedPaths: [],
          fileTypeBreakdown: { TypeScript: 3 },
          languageBreakdown: { TypeScript: 3 },
          entryPoints: ["src/renderer/App.tsx"],
          manifestFiles: ["package.json"],
          testsPresent: true,
          primaryManagers: ["npm"],
          explanation: "Small analytics app"
        },
        dependencies: []
      },
      overview: undefined,
      objective: "deliver",
      maxOptions: 5
    });

    expect(brief).toContain("Outcome strategy:");
    expect(brief).toContain("Primary next move: Satisfy the highest-impact coherent batch");
    expect(brief).toContain("Efficient batching opportunity:");
    expect(brief).toContain("App includes drawdown visualization");
    expect(brief).toContain("Quality bar:");
    expect(brief).toContain("Keep offline mode usable");
    expect(brief).toContain("Avoid non-goals:");
    expect(brief).toContain("src/analytics/drawdown.ts");
  });

  it("biases deterministic recommendations toward a custom focus", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Improve repository usability.",
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };

    const recommendations = buildWorkflowRecommendations({
      workflow,
      agents: [],
      scan: {
        kind: "git",
        files: [
          { absolutePath: "/repo/src/renderer/App.tsx", relativePath: "src/renderer/App.tsx", size: 4_096, language: "TypeScript" },
          { absolutePath: "/repo/src/runtime/appService.ts", relativePath: "src/runtime/appService.ts", size: 4_096, language: "TypeScript" }
        ],
        stats: {
          projectRoot: "/repo",
          kind: "git",
          totalFiles: 2,
          totalFolders: 2,
          totalSizeBytes: 8_192,
          includedFiles: 2,
          includedFolders: 2,
          includedSizeBytes: 8_192,
          excludedFiles: 0,
          excludedFolders: 0,
          excludedSizeBytes: 0,
          excludedPaths: [],
          fileTypeBreakdown: { TypeScript: 2 },
          languageBreakdown: { TypeScript: 2 },
          entryPoints: ["src/renderer/App.tsx"],
          manifestFiles: ["package.json"],
          testsPresent: false,
          primaryManagers: ["npm"],
          explanation: "Small repo"
        },
        dependencies: []
      },
      customFocus: "improve keyboard shortcuts in the workflow tab",
      overview: undefined,
      objective: "deliver",
      maxOptions: 5
    });

    expect(recommendations[0]?.title.toLowerCase()).toContain("keyboard shortcuts");
    expect(recommendations.slice(0, 3).every((entry) => entry.title.toLowerCase().includes("keyboard shortcuts"))).toBe(true);
  });

  it("shifts deterministic recommendations toward bounded improvements in optimize mode", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Ship a working desktop workflow UI.",
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };

    const recommendations = buildWorkflowRecommendations({
      workflow,
      agents: [],
      scan: {
        kind: "git",
        files: [
          { absolutePath: "/repo/src/renderer/App.tsx", relativePath: "src/renderer/App.tsx", size: 4_096, language: "TypeScript" },
          { absolutePath: "/repo/src/renderer/styles.css", relativePath: "src/renderer/styles.css", size: 4_096, language: "CSS" },
          { absolutePath: "/repo/src/runtime/appService.ts", relativePath: "src/runtime/appService.ts", size: 4_096, language: "TypeScript" }
        ],
        stats: {
          projectRoot: "/repo",
          kind: "git",
          totalFiles: 3,
          totalFolders: 3,
          totalSizeBytes: 12_288,
          includedFiles: 3,
          includedFolders: 3,
          includedSizeBytes: 12_288,
          excludedFiles: 0,
          excludedFolders: 0,
          excludedSizeBytes: 0,
          excludedPaths: [],
          fileTypeBreakdown: { TypeScript: 2, CSS: 1 },
          languageBreakdown: { TypeScript: 2, CSS: 1 },
          entryPoints: ["src/renderer/App.tsx"],
          manifestFiles: ["package.json"],
          testsPresent: true,
          primaryManagers: ["npm"],
          explanation: "UI-heavy repo"
        },
        dependencies: []
      },
      overview: undefined,
      objective: "optimize",
      maxOptions: 5
    });

    expect(recommendations.some((entry) => /polish|harden|trim/i.test(entry.title))).toBe(true);
  });

  it("builds final appeal recommendations only for visual projects", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Ship a portfolio tracker dashboard.",
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    const visualContext = {
      workflow,
      agents: [],
      scan: {
        kind: "git" as const,
        files: [
          { absolutePath: "/repo/src/App.tsx", relativePath: "src/App.tsx", size: 4_096, language: "TypeScript" },
          { absolutePath: "/repo/src/styles.css", relativePath: "src/styles.css", size: 2_048, language: "CSS" }
        ],
        stats: {
          projectRoot: "/repo",
          kind: "git" as const,
          totalFiles: 2,
          totalFolders: 1,
          totalSizeBytes: 6_144,
          includedFiles: 2,
          includedFolders: 1,
          includedSizeBytes: 6_144,
          excludedFiles: 0,
          excludedFolders: 0,
          excludedSizeBytes: 0,
          excludedPaths: [],
          fileTypeBreakdown: { TypeScript: 1, CSS: 1 },
          languageBreakdown: { TypeScript: 1, CSS: 1 },
          entryPoints: ["src/App.tsx"],
          manifestFiles: ["package.json"],
          testsPresent: true,
          primaryManagers: ["npm"],
          explanation: "React dashboard"
        },
        dependencies: [{ manifest: "package.json", ecosystem: "npm", name: "react", version: "19.0.0" }]
      },
      overview: undefined,
      objective: "deliver" as const,
      maxOptions: 5
    };

    expect(isVisualProject(visualContext)).toBe(true);
    const appealRecommendations = buildAppealRecommendations(visualContext);
    expect(appealRecommendations.length).toBeGreaterThan(0);
    expect(appealRecommendations[0]?.title.toLowerCase()).toContain("polish");
    expect(appealRecommendations.every((entry) => entry.estimatedScope === "small")).toBe(true);

    expect(buildAppealRecommendations({
      ...visualContext,
      scan: {
        ...visualContext.scan,
        files: [{ absolutePath: "/repo/src/index.ts", relativePath: "src/index.ts", size: 1024, language: "TypeScript" }],
        dependencies: []
      }
    })).toHaveLength(0);
  });

  it("estimates Ultimate Goal completion conservatively from workflow history", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Ship a workflow that can run repeated autonomous cycles safely.",
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    workflow.workflowStage = "coding_running";
    workflow.scopedGoal = {
      id: "goal-1",
      sourceRecommendationId: "rec-1",
      summary: "Implement the automation controls",
      executionBrief: "Do the work.",
      acceptanceCriteria: [],
      constraints: [],
      testStrategy: [],
      createdAt: "2026-04-07T00:01:00.000Z"
    };
    workflow.memory.perCycleSummaries = [
      {
        cycleNumber: 1,
        summary: "Completed the first workflow cycle.",
        openIssueIds: [],
        createdAt: "2026-04-07T00:00:00.000Z"
      }
    ];
    workflow.memory.lastAcceptedDecisions = [
      {
        id: "decision-1",
        kind: "recommendation",
        title: "Tighten the workflow loop",
        summary: "Keep the cycle explicit.",
        decidedAt: "2026-04-07T00:00:00.000Z",
        cycleNumber: 1
      }
    ];
    workflow.memory.knownOpenIssues = [
      {
        id: "issue-1",
        title: "Add more validation",
        detail: "A second pass should cover more failure modes.",
        source: "integrity",
        status: "open",
        recordedAt: "2026-04-07T00:00:00.000Z"
      }
    ];

    const progress = estimateUltimateGoalProgress({
      workflow,
      agents: [],
      scan: {
        kind: "git",
        files: [],
        stats: {
          projectRoot: "/repo",
          kind: "git",
          totalFiles: 1,
          totalFolders: 1,
          totalSizeBytes: 1_024,
          includedFiles: 1,
          includedFolders: 1,
          includedSizeBytes: 1_024,
          excludedFiles: 0,
          excludedFolders: 0,
          excludedSizeBytes: 0,
          excludedPaths: [],
          fileTypeBreakdown: { TypeScript: 1 },
          languageBreakdown: { TypeScript: 1 },
          entryPoints: ["src/index.ts"],
          manifestFiles: ["package.json"],
          testsPresent: true,
          primaryManagers: ["npm"],
          explanation: "Test repo"
        },
        dependencies: []
      },
      overview: undefined,
      objective: "deliver",
      maxOptions: 5
    });

    expect(progress.percentComplete).toBeGreaterThanOrEqual(0);
    expect(progress.percentComplete).toBeLessThan(100);
    expect(progress.rationale).toContain("required goal checks");
  });

  it("does not satisfy the Ultimate Goal from cycle count or accepted decisions alone", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Build a local Tic Tac Toe game.",
      successCriteria: ["3x3 board renders", "Turns alternate", "Wins and draws are detected"],
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    workflow.workflowCycle.status = "completed";
    workflow.memory.perCycleSummaries = [
      {
        cycleNumber: 1,
        summary: "Build Tic Tac Toe game with turn handling and winner detection.",
        openIssueIds: [],
        createdAt: "2026-04-07T00:00:00.000Z"
      }
    ];
    workflow.memory.lastAcceptedDecisions = workflow.ultimateGoal.successCriteria.map((criterion, index) => ({
      id: `decision-${index}`,
      kind: "merge" as const,
      title: criterion,
      summary: criterion,
      decidedAt: "2026-04-07T00:00:00.000Z",
      cycleNumber: 1
    }));

    const context = {
      workflow,
      agents: [makePassedIntegrityAgent()],
      scan: {
        kind: "git" as const,
        files: [],
        stats: {
          projectRoot: "/repo",
          kind: "git" as const,
          totalFiles: 3,
          totalFolders: 2,
          totalSizeBytes: 4_096,
          includedFiles: 3,
          includedFolders: 2,
          includedSizeBytes: 4_096,
          excludedFiles: 0,
          excludedFolders: 0,
          excludedSizeBytes: 0,
          excludedPaths: [],
          fileTypeBreakdown: { TypeScript: 2, CSS: 1 },
          languageBreakdown: { TypeScript: 2, CSS: 1 },
          entryPoints: ["src/App.tsx"],
          manifestFiles: ["package.json"],
          testsPresent: true,
          primaryManagers: ["npm"],
          explanation: "Simple game repo"
        },
        dependencies: []
      },
      overview: undefined,
      objective: "deliver" as const,
      maxOptions: 5
    };
    const progress = estimateUltimateGoalProgress(context);
    const assessment = assessUltimateGoalCompletion(context, progress);

    expect(progress.percentComplete).toBeLessThan(100);
    expect(assessment.state).toBe("needs_more_work");
    expect(assessment.rationale).toContain("required goal check");
  });

  it("can mark a completed workflow as satisfying the Ultimate Goal", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Build a local Tic Tac Toe game.",
      detailedIntent: "Players should be able to click a 3x3 board, alternate turns, and reset the match.",
      successCriteria: ["3x3 board renders", "Turns alternate", "Wins and draws are detected"],
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    workflow.workflowCycle.status = "completed";
    workflow.memory.perCycleSummaries = [
      {
        cycleNumber: 1,
        summary: "Build Tic Tac Toe game with turn handling and winner detection.",
        openIssueIds: [],
        createdAt: "2026-04-07T00:00:00.000Z"
      }
    ];
    workflow.memory.lastAcceptedDecisions = [
      {
        id: "decision-1",
        kind: "merge",
        title: "Build Tic Tac Toe game",
        summary: "Ship the playable board and reset flow.",
        decidedAt: "2026-04-07T00:00:00.000Z",
        cycleNumber: 1
      },
      {
        id: "decision-2",
        kind: "recommendation",
        title: "Implement winner detection",
        summary: "Close the gameplay loop.",
        decidedAt: "2026-04-07T00:00:00.000Z",
        cycleNumber: 1
      },
      {
        id: "decision-3",
        kind: "scoped_goal",
        title: "Wire reset flow",
        summary: "Let the user start a new match.",
        decidedAt: "2026-04-07T00:00:00.000Z",
        cycleNumber: 1
      }
    ];
    workflow.approvedRecommendation = approveRecommendation(makeRecommendation({
      id: "rec-1",
      title: "Build Tic Tac Toe game",
      summary: "Create the playable board and reset flow."
    }));
    workflow.scopedGoal = {
      id: "goal-1",
      sourceRecommendationId: "rec-1",
      summary: "Build Tic Tac Toe game with winner detection",
      executionBrief: "Implement the board, turn state, winner detection, and reset action.",
      acceptanceCriteria: [],
      constraints: [],
      testStrategy: [],
      createdAt: "2026-04-07T00:01:00.000Z"
    };
    workflow.goalChecklist = applyGoalChecklistUpdates(
      buildGoalChecklistFromUltimateGoal(workflow.ultimateGoal, [], "2026-04-07T00:01:00.000Z"),
      workflow.ultimateGoal.successCriteria.map((criterion) => ({
        title: criterion,
        status: "met",
        evidence: `Implemented and validated: ${criterion}`
      })),
      { timestamp: "2026-04-07T00:03:00.000Z" }
    );
    const agents = [makePassedIntegrityAgent()];

    const progress = estimateUltimateGoalProgress({
      workflow,
      agents,
      scan: {
        kind: "git",
        files: [],
        stats: {
          projectRoot: "/repo",
          kind: "git",
          totalFiles: 3,
          totalFolders: 2,
          totalSizeBytes: 4_096,
          includedFiles: 3,
          includedFolders: 2,
          includedSizeBytes: 4_096,
          excludedFiles: 0,
          excludedFolders: 0,
          excludedSizeBytes: 0,
          excludedPaths: [],
          fileTypeBreakdown: { TypeScript: 2, CSS: 1 },
          languageBreakdown: { TypeScript: 2, CSS: 1 },
          entryPoints: ["src/App.tsx"],
          manifestFiles: ["package.json"],
          testsPresent: true,
          primaryManagers: ["npm"],
          explanation: "Simple game repo"
        },
        dependencies: []
      },
      overview: undefined,
      objective: "deliver",
      maxOptions: 5
    });
    const assessment = assessUltimateGoalCompletion({
      workflow,
      agents,
      scan: {
        kind: "git",
        files: [],
        stats: {
          projectRoot: "/repo",
          kind: "git",
          totalFiles: 3,
          totalFolders: 2,
          totalSizeBytes: 4_096,
          includedFiles: 3,
          includedFolders: 2,
          includedSizeBytes: 4_096,
          excludedFiles: 0,
          excludedFolders: 0,
          excludedSizeBytes: 0,
          excludedPaths: [],
          fileTypeBreakdown: { TypeScript: 2, CSS: 1 },
          languageBreakdown: { TypeScript: 2, CSS: 1 },
          entryPoints: ["src/App.tsx"],
          manifestFiles: ["package.json"],
          testsPresent: true,
          primaryManagers: ["npm"],
          explanation: "Simple game repo"
        },
        dependencies: []
      },
      overview: undefined,
      objective: "deliver",
      maxOptions: 5
    }, progress);

    expect(assessment.state).toBe("goal_satisfied");
  });

  it("keeps a required blocker when agents admit the product is still placeholder-only", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Build a market analytics dashboard.",
      successCriteria: ["Charts display real historical market data"],
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    workflow.workflowCycle.status = "completed";
    workflow.goalChecklist = applyGoalChecklistUpdates(
      buildGoalChecklistFromUltimateGoal(workflow.ultimateGoal, [], "2026-04-07T00:01:00.000Z"),
      [{
        title: "Charts display real historical market data",
        status: "met",
        evidence: "The chart component has a data provider contract."
      }],
      { timestamp: "2026-04-07T00:03:00.000Z" }
    );
    const placeholderAgent: AgentState = {
      ...createAgentSkeleton("coding", "Coding Pass 1", "Open the UI.", "gpt-5.4"),
      status: "completed",
      completedAt: "2026-04-07T00:04:00.000Z",
      lastMessageSnippet: "The UI is still a local placeholder shell - no live market data yet."
    };
    const agents = [placeholderAgent, makePassedIntegrityAgent()];
    const checklist = buildGoalChecklistForAssessment({ workflow, agents }, "2026-04-07T00:05:00.000Z");

    expect(checklist.find((check) => check.id === "deterministic:no-admitted-incomplete-work")?.status).toBe("unmet");
    const progress = estimateUltimateGoalProgress({
      workflow: {
        ...workflow,
        goalChecklist: checklist
      },
      agents,
      scan: {
        kind: "git",
        files: [],
        stats: {
          projectRoot: "/repo",
          kind: "git",
          totalFiles: 3,
          totalFolders: 2,
          totalSizeBytes: 4_096,
          includedFiles: 3,
          includedFolders: 2,
          includedSizeBytes: 4_096,
          excludedFiles: 0,
          excludedFolders: 0,
          excludedSizeBytes: 0,
          excludedPaths: [],
          fileTypeBreakdown: { TypeScript: 2, CSS: 1 },
          languageBreakdown: { TypeScript: 2, CSS: 1 },
          entryPoints: ["src/App.tsx"],
          manifestFiles: ["package.json"],
          testsPresent: true,
          primaryManagers: ["npm"],
          explanation: "Dashboard repo"
        },
        dependencies: []
      },
      overview: undefined,
      objective: "deliver",
      maxOptions: 5
    });

    expect(progress.percentComplete).toBeLessThan(100);
  });
});

describe("workflow planning evidence layer", () => {
  type AwTrendsCycleFixture = {
    cycleNumber: number;
    selectedCandidate: {
      id: string;
      title: string;
      summary: string;
      expectedFiles: string[];
      targetedCheckIds: string[];
      scoreBreakdown: Record<string, number>;
    };
    workPackage: Pick<WorkPackage, "id" | "title" | "summary" | "primaryTopic" | "likelyPaths" | "acceptanceHints" | "checkIds" | "score">;
    goalChecklist: Array<{
      id: string;
      title: string;
      description: string;
      status: GoalAttainmentCheck["status"];
    }>;
  };

  const buildAwTrendsWorkflow = (fixture: AwTrendsCycleFixture) => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Deliver an offline-reviewable market trends assistant with source provenance and access policy evidence.",
      successCriteria: fixture.goalChecklist.map((check) => check.description),
      confirmedAt: "2026-06-01T00:00:00.000Z"
    };
    workflow.workflowCycle.cycleNumber = fixture.cycleNumber;
    workflow.workflowStage = "goal_ready";
    workflow.goalChecklist = fixture.goalChecklist.map((check) => makeGoalCheck({
      id: check.id,
      title: check.title,
      description: check.description,
      status: check.status,
      source: "success_criterion",
      relatedPaths: fixture.workPackage.likelyPaths
    }));
    workflow.workPackages = [{
      ...fixture.workPackage,
      estimatedBreadth: "medium",
      estimatedImpact: "high",
      confidence: 0.91,
      riskLevel: "medium",
      reason: "Grouped by source provenance and access policy plus shared likely paths.",
      acceptanceHints: fixture.workPackage.acceptanceHints,
      checkIds: fixture.workPackage.checkIds
    }];
    const recommendation = makeRecommendation({
      id: "recommendation:source-provenance",
      title: fixture.selectedCandidate.title,
      summary: fixture.selectedCandidate.summary,
      rationale: "Grouped by source provenance and access policy plus shared checklist semantics.",
      expectedImpact: "This moves the Ultimate Goal percentage by producing shared repository evidence for multiple required checks.",
      relatedPaths: fixture.workPackage.likelyPaths,
      sourceWorkPackageId: fixture.workPackage.id,
      targetedCheckIds: fixture.selectedCandidate.targetedCheckIds,
      estimatedScope: "medium"
    });
    workflow.recommendations = [recommendation];
    workflow.approvedRecommendation = approveRecommendation(recommendation);
    workflow.workflowCycle.approvedRecommendationId = recommendation.id;
    workflow.workflowCycle.approvedRecommendationTitle = recommendation.title;
    workflow.scopedGoal = {
      id: "scoped-source-provenance",
      sourceRecommendationId: recommendation.id,
      sourceWorkPackageId: fixture.workPackage.id,
      summary: "Satisfy source provenance and access policy",
      executionBrief: "Produce machine-checkable source provenance and access policy evidence.",
      acceptanceCriteria: fixture.workPackage.acceptanceHints,
      constraints: ["Keep offline/demo behavior safe."],
      testStrategy: [
        "PYTHONPATH=src python3 -m aw_trends.app source-audit \"market data quotes corporate actions\" --limit 6"
      ],
      targetedCheckIds: fixture.selectedCandidate.targetedCheckIds,
      likelyPaths: fixture.workPackage.likelyPaths,
      createdAt: "2026-06-01T00:00:00.000Z"
    };
    workflow.plannerDecisions = [{
      id: "planner-cycle-23",
      planId: "plan-cycle-23",
      cycleNumber: fixture.cycleNumber,
      selectedTaskId: fixture.selectedCandidate.id,
      selectedRecommendationId: recommendation.id,
      selectedTaskTitle: fixture.selectedCandidate.title,
      whySelected: "Selected because it targets four unknown required checks, but prior cycles show repetition risk.",
      score: 320,
      scoreBreakdown: fixture.selectedCandidate.scoreBreakdown,
      strategySettingsUsed: ["high validation strictness"],
      targetedChecklistIds: fixture.selectedCandidate.targetedCheckIds,
      expectedFiles: fixture.selectedCandidate.expectedFiles,
      expectedValidationCommands: ["python3 -m unittest discover -s tests -q"],
      approvalRequired: false,
      goalChangeProposalIds: [],
      checklistChangeIds: [],
      visualDesignImpact: false,
      createdAt: "2026-06-01T00:00:00.000Z"
    }];
    return workflow;
  };

  type LegacyWorkflowFixture = {
    summary?: { projectName?: string };
    workflow: {
      workflowStage?: WorkflowStage;
      autopilotStatus?: ProjectWorkflowState["autopilotStatus"];
      workflowCycle?: Partial<ProjectWorkflowState["workflowCycle"]>;
      ultimateGoalProgress?: { percentComplete: number; requiredMet?: number; requiredTotal?: number };
      goalChecklist: Array<{
        id: string;
        title: string;
        description: string;
        status: GoalAttainmentCheck["status"];
      }>;
      workPackages?: Array<Pick<WorkPackage, "id" | "title" | "summary" | "primaryTopic" | "likelyPaths" | "acceptanceHints" | "checkIds" | "score">>;
      strategicPlans?: Array<{
        id: string;
        cycleNumber: number;
        recentAgentOutputs?: string[];
        candidateTasks?: Array<{
          id: string;
          kind: "work_package" | "goal_check" | "validation" | "stabilization" | "custom";
          title: string;
          summary: string;
          sourceWorkPackageId?: string;
          targetedCheckIds: string[];
          expectedFiles: string[];
          expectedValidationCommands: string[];
          scoreBreakdown: Record<string, number>;
        }>;
        recommendedTaskId?: string;
      }>;
    };
  };

  const buildWorkflowFromLegacyFixture = (fixture: LegacyWorkflowFixture): ProjectWorkflowState => {
    const workflow = defaultProjectWorkflowState();
    const cycleNumber = fixture.workflow.workflowCycle?.cycleNumber ?? fixture.workflow.autopilotStatus?.cycleNumber ?? 1;
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: `${fixture.summary?.projectName ?? "Project"} legacy workflow regression goal`,
      successCriteria: fixture.workflow.goalChecklist.map((check) => check.description),
      confirmedAt: "2026-06-01T00:00:00.000Z"
    };
    workflow.workflowStage = fixture.workflow.workflowStage ?? "goal_ready";
    workflow.workflowCycle = {
      ...workflow.workflowCycle,
      ...fixture.workflow.workflowCycle,
      cycleNumber
    };
    workflow.autopilotStatus = fixture.workflow.autopilotStatus;
    workflow.ultimateGoalProgress = fixture.workflow.ultimateGoalProgress
      ? {
        percentComplete: fixture.workflow.ultimateGoalProgress.percentComplete,
        rationale: `${fixture.workflow.ultimateGoalProgress.requiredMet ?? 0}/${fixture.workflow.ultimateGoalProgress.requiredTotal ?? fixture.workflow.goalChecklist.length} required checks met.`,
        source: "deterministic",
        updatedAt: "2026-06-01T00:00:00.000Z"
      }
      : undefined;
    workflow.goalChecklist = fixture.workflow.goalChecklist.map((check) => makeGoalCheck({
      id: check.id,
      title: check.title,
      description: check.description,
      status: check.status,
      source: "success_criterion",
      relatedPaths: fixture.workflow.workPackages?.[0]?.likelyPaths ?? []
    }));
    workflow.workPackages = (fixture.workflow.workPackages ?? []).map((workPackage) => ({
      ...workPackage,
      estimatedBreadth: "medium" as const,
      estimatedImpact: "high" as const,
      confidence: 0.9,
      riskLevel: "medium" as const,
      reason: `Grouped by ${workPackage.primaryTopic}.`
    }));
    const selectedCandidate = fixture.workflow.strategicPlans?.flatMap((plan) => plan.candidateTasks ?? [])[0];
    if (selectedCandidate) {
      const recommendation = makeRecommendation({
        id: `recommendation:${selectedCandidate.id}`,
        title: selectedCandidate.title,
        summary: selectedCandidate.summary,
        relatedPaths: selectedCandidate.expectedFiles,
        sourceWorkPackageId: selectedCandidate.sourceWorkPackageId,
        targetedCheckIds: selectedCandidate.targetedCheckIds,
        estimatedScope: "medium"
      });
      workflow.recommendations = [recommendation];
      workflow.approvedRecommendation = approveRecommendation(recommendation);
      workflow.scopedGoal = {
        id: `scoped:${selectedCandidate.id}`,
        sourceRecommendationId: recommendation.id,
        sourceWorkPackageId: selectedCandidate.sourceWorkPackageId,
        summary: selectedCandidate.title,
        executionBrief: selectedCandidate.summary,
        acceptanceCriteria: workflow.workPackages.find((entry) => entry.id === selectedCandidate.sourceWorkPackageId)?.acceptanceHints ?? [],
        constraints: [],
        testStrategy: selectedCandidate.expectedValidationCommands,
        targetedCheckIds: selectedCandidate.targetedCheckIds,
        likelyPaths: selectedCandidate.expectedFiles,
        createdAt: "2026-06-01T00:00:00.000Z"
      };
      workflow.plannerDecisions = [{
        id: `planner:${cycleNumber}`,
        planId: fixture.workflow.strategicPlans?.[0]?.id ?? `plan:${cycleNumber}`,
        cycleNumber,
        selectedTaskId: selectedCandidate.id,
        selectedRecommendationId: recommendation.id,
        selectedTaskTitle: selectedCandidate.title,
        whySelected: "Selected from retained legacy strategic plan.",
        score: Object.values(selectedCandidate.scoreBreakdown).reduce((sum, value) => sum + value, 0),
        scoreBreakdown: selectedCandidate.scoreBreakdown,
        strategySettingsUsed: [],
        targetedChecklistIds: selectedCandidate.targetedCheckIds,
        expectedFiles: selectedCandidate.expectedFiles,
        expectedValidationCommands: selectedCandidate.expectedValidationCommands,
        approvalRequired: false,
        goalChangeProposalIds: [],
        checklistChangeIds: [],
        visualDesignImpact: false,
        createdAt: "2026-06-01T00:00:00.000Z"
      }];
    }
    workflow.strategicPlans = (fixture.workflow.strategicPlans ?? []).map((plan) => ({
      id: plan.id,
      projectId: "fixture-project",
      cycleNumber: plan.cycleNumber,
      createdAt: "2026-06-01T00:00:00.000Z",
      originalGoalSummary: workflow.ultimateGoal.summary,
      currentEffectiveGoalSummary: workflow.ultimateGoal.summary,
      mode: "autopilot_balanced",
      strategySnapshot: workflow.goalCharter.autopilotStrategy,
      strategyHighlights: [],
      repoScanStatus: "fixture",
      previousCycleOutcomes: [],
      failedCommands: [],
      changedFiles: [],
      openBlockers: [],
      userFeedback: [],
      recentAgentOutputs: plan.recentAgentOutputs ?? [],
      architectureNotes: [],
      candidateTasks: (plan.candidateTasks ?? []).map((candidate) => ({
        id: candidate.id,
        kind: candidate.kind,
        title: candidate.title,
        summary: candidate.summary,
        sourceWorkPackageId: candidate.sourceWorkPackageId,
        targetedCheckIds: candidate.targetedCheckIds,
        expectedChecklistImpact: "Fixture candidate targets retained checklist IDs.",
        expectedFiles: candidate.expectedFiles,
        expectedValidationCommands: candidate.expectedValidationCommands,
        riskLevel: "medium",
        whyNext: "Fixture candidate retained from legacy plan.",
        approvalRequired: false,
        goalChangeProposalIds: [],
        checklistChangeIds: [],
        visualDesignImpact: false,
        shouldSplit: false,
        score: Object.values(candidate.scoreBreakdown).reduce((sum, value) => sum + value, 0),
        scoreBreakdown: candidate.scoreBreakdown,
        confidence: 0.9
      })),
      candidateWorkPackages: workflow.workPackages,
      proposedGoalChanges: [],
      proposedChecklistChanges: [],
      recommendedTaskId: plan.recommendedTaskId,
      requiresApproval: false,
      plannerSummary: "Fixture strategic plan.",
      continueRecommendation: "continue"
    }));
    return workflow;
  };

  it("loads active-cycle legacy state and derives concrete diagnostics without generic status labels", async () => {
    const fixture = await readJsonFixture<LegacyWorkflowFixture>("aw-trends-active-cycle-23-legacy.json");
    const workflow = buildWorkflowFromLegacyFixture(fixture);

    const report = deriveLegacyWorkflowDiagnostics(workflow, {
      agents: [],
      now: "2026-06-01T00:00:00.000Z",
      deriveChecklistDelta: true,
      deriveValidationLedger: true,
      deriveRepoHygiene: true
    });
    const view = buildOperatorWorkflowViewModel({
      workflow,
      projectName: fixture.summary?.projectName,
      workflowPauseRequested: true
    });

    expect(report.cycleContractDerived).toBe(true);
    expect(workflow.cycleContract?.schemaVersion).toBe(1);
    expect(workflow.cycleContract?.selectedTaskSource).toBe("derived_from_legacy_state");
    expect(workflow.cycleContract?.plainEnglishObjective).toContain("Prove the source provenance and access policy slice");
    expect(workflow.cycleContract?.plainEnglishObjective).not.toContain("Use this coherent work package");
    expect(workflow.cycleContract?.targetedChecklistItems.map((item) => item.fullDescription).join("\n")).toContain("provider freshness");
    expect(workflow.checklistDeltas[0]?.summaryForHumans).toContain("not recorded");
    expect(workflow.validationLedgers[0]?.finalValidationStatus).toBe("not_run");
    expect(workflow.repoHygieneReports[0]?.status).toBe("unknown");
    expect(workflow.recommendationHealth.fallbackUsedForCurrentRecommendation).toBe(true);
    expect(view.currentStatus.primaryLabel).toBe("Paused after coding checkpoint; awaiting integrity/merge");
    expect(view.currentStatus.technicalStage).toBe("Preparing Coding");
    expect(view.planner.fallbackWarning).toContain("Structured recommendation output was invalid");
  });

  it("reconciles source-audit evidence into targeted checklist delta from legacy state", async () => {
    const fixture = await readJsonFixture<LegacyWorkflowFixture>("aw-trends-active-cycle-23-legacy.json");
    const evidence = await readJsonFixture<unknown>("aw-trends-source-audit-evidence.json");
    const workflow = buildWorkflowFromLegacyFixture(fixture);
    deriveLegacyWorkflowDiagnostics(workflow, {
      now: "2026-06-01T00:00:00.000Z",
      deriveChecklistDelta: false,
      deriveValidationLedger: false,
      deriveRepoHygiene: false
    });
    const targetIds = workflow.cycleContract?.targetedChecklistItems.map((item) => item.checkId) ?? [];
    const before = workflow.goalChecklist;
    const observations = extractChecklistEvidenceObservations(JSON.stringify(evidence), {
      cycleNumber: workflow.workflowCycle.cycleNumber,
      targetedCheckIds: targetIds,
      knownCheckIds: workflow.goalChecklist.map((check) => check.id),
      evidenceSourceType: "command_output",
      sourceRef: { commandId: "source-audit" },
      observedAt: "2026-06-01T00:05:00.000Z"
    });
    const applied = applyChecklistEvidenceObservations(workflow.goalChecklist, observations, {
      targetedCheckIds: targetIds,
      timestamp: "2026-06-01T00:06:00.000Z"
    });
    workflow.goalChecklist = applied.checklist;
    const delta = computeChecklistDelta(before, workflow.goalChecklist, applied.observations, {
      cycleNumber: workflow.workflowCycle.cycleNumber,
      targetedCheckIds: targetIds,
      timestamp: "2026-06-01T00:06:00.000Z"
    });

    expect(delta.targetedNewlyMet).toHaveLength(4);
    expect(delta.evidenceConsumedCount).toBe(4);
    expect(delta.goalProgressAfter).toBeGreaterThan(delta.goalProgressBefore);
  });

  it("rejects implementation prose evidence that omits check IDs", async () => {
    const fixture = await readJsonFixture<LegacyWorkflowFixture>("aw-trends-active-cycle-23-legacy.json");
    const evidence = await readJsonFixture<unknown>("aw-trends-evidence-missing-check-ids.json");
    const workflow = buildWorkflowFromLegacyFixture(fixture);
    deriveLegacyWorkflowDiagnostics(workflow, {
      now: "2026-06-01T00:00:00.000Z",
      deriveChecklistDelta: false,
      deriveValidationLedger: false,
      deriveRepoHygiene: false
    });
    const targetIds = workflow.cycleContract?.targetedChecklistItems.map((item) => item.checkId) ?? [];
    const observations = extractChecklistEvidenceObservations(JSON.stringify(evidence), {
      cycleNumber: workflow.workflowCycle.cycleNumber,
      targetedCheckIds: targetIds,
      knownCheckIds: workflow.goalChecklist.map((check) => check.id),
      evidenceSourceType: "artifact",
      sourceRef: { artifactPath: "artifacts/source-audit.json" },
      observedAt: "2026-06-01T00:05:00.000Z"
    });
    const applied = applyChecklistEvidenceObservations(workflow.goalChecklist, observations, {
      targetedCheckIds: targetIds,
      timestamp: "2026-06-01T00:06:00.000Z"
    });
    const delta = computeChecklistDelta(workflow.goalChecklist, applied.checklist, applied.observations, {
      cycleNumber: workflow.workflowCycle.cycleNumber,
      targetedCheckIds: targetIds,
      timestamp: "2026-06-01T00:06:00.000Z"
    });

    expect(applied.checklist.filter((check) => targetIds.includes(check.id)).every((check) => check.status === "unknown")).toBe(true);
    expect(delta.evidenceNotConsumedCount).toBeGreaterThan(0);
    expect(delta.evidenceNotConsumedReasons.missing_check_id).toBeGreaterThan(0);
    expect(Object.values(delta.whyStillUnknownByCheckId)).toContain("evidence emitted but missing check ID");
  });

  it("classifies repaired validation attempts and only allows merge when hygiene passed", async () => {
    const fixture = await readJsonFixture<{
      cycleNumber: number;
      commands: Array<{ commandId: string; command: string; phase: "integrity"; exitCode: number; stdout?: string; stderr?: string }>;
      repoHygiene: NonNullable<ReturnType<typeof buildOperatorWorkflowViewModel>["currentCycle"]["repoHygiene"]>;
    }>("aw-trends-validation-repair.json");
    const ledger = createValidationLedger({
      cycleNumber: fixture.cycleNumber,
      testCommands: fixture.commands.map((command) => command.command)
    });
    ledger.commandResults = fixture.commands.map((command) => makeLedgerCommandResult({
      commandId: command.commandId,
      command: command.command,
      phase: command.phase,
      exitCode: command.exitCode,
      stdout: command.stdout,
      stderr: command.stderr
    }));

    const withoutHygiene = finalizeValidationLedger(ledger);
    const withHygiene = finalizeValidationLedger(ledger, { repoHygieneReport: fixture.repoHygiene });
    const workflow = defaultProjectWorkflowState();
    workflow.workflowCycle.cycleNumber = fixture.cycleNumber;
    workflow.validationLedgers = [withHygiene];
    workflow.repoHygieneReports = [fixture.repoHygiene];
    const view = buildOperatorWorkflowViewModel({ workflow, validationLedger: withHygiene, repoHygieneReport: fixture.repoHygiene });

    expect(withoutHygiene.finalValidationStatus).toBe("passed");
    expect(withoutHygiene.mergeAllowed).toBe(false);
    expect(withHygiene.finalValidationStatus).toBe("passed");
    expect(withHygiene.mergeAllowed).toBe(true);
    expect(withHygiene.environmentFailures.join(" ")).toContain("pytest is unavailable");
    expect(withHygiene.environmentFailures.join(" ")).toContain("Python executable was unavailable");
    expect(view.currentCycle.validationSummary.repaired.length).toBeGreaterThanOrEqual(2);
    expect(view.currentCycle.validationSummary.mergeAllowed).toBe(true);
  });

  it("blocks hygiene bad paths and surfaces exact paths", async () => {
    const fixture = await readJsonFixture<{ changedFiles: string[] }>("aw-trends-hygiene-bad-paths.json");
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal.confirmedAt = "2026-06-01T00:00:00.000Z";
    workflow.workflowCycle.cycleNumber = 23;
    workflow.repoHygieneReports = [{
      status: "failed",
      scannedAt: "2026-06-01T00:00:00.000Z",
      scannedRef: "fixture:23",
      forbiddenFiles: fixture.changedFiles.filter((file) => suspiciousPathReason(file) || /__pycache__|\.pyc$/i.test(file)),
      cleanedFiles: [],
      warnings: [],
      mergeBlockingFindings: fixture.changedFiles
        .filter((file) => suspiciousPathReason(file) || /__pycache__|\.pyc$/i.test(file))
        .map((file) => `${file}: ${suspiciousPathReason(file) ?? "generated Python bytecode cannot be merged"}`),
      summaryForHumans: "Repository hygiene failed for suspicious changed paths."
    }];
    const agent = {
      ...createAgentSkeleton("coding", "Coding Pass", "Implement source evidence", "gpt-5.4"),
      workflowCycleNumber: 23,
      changedFiles: fixture.changedFiles
    };
    const view = buildOperatorWorkflowViewModel({ workflow, agents: [agent] });

    expect(view.currentStatus.primaryLabel).toBe("Merge blocked by repository hygiene");
    expect(view.repositoryHealth.suspiciousPaths).toEqual(expect.arrayContaining(["EADME.md", "ocs/core-portfolio-analytics-evidence.md"]));
    expect(view.currentCycle.changedFilesSummary.find((group) => group.kind === "generated")?.files).toContain("src/aw_trends/__pycache__/app.cpython-312.pyc");
    expect(view.currentCycle.validationSummary.mergeAllowed).toBe(false);
  });

  it("turns repeated fallback/no-delta fixture into a reconciliation task", async () => {
    const base = await readJsonFixture<LegacyWorkflowFixture>("aw-trends-active-cycle-23-legacy.json");
    const fixture = await readJsonFixture<{
      cycles: Array<{ cycleNumber: number }>;
      cycleContract: { targetedCheckIds: string[] };
      recentAgentOutputs: string[];
    }>("aw-trends-repeated-fallback-no-delta.json");
    const workflow = buildWorkflowFromLegacyFixture(base);
    deriveLegacyWorkflowDiagnostics(workflow, {
      now: "2026-06-01T00:00:00.000Z",
      deriveChecklistDelta: false,
      deriveValidationLedger: false,
      deriveRepoHygiene: false
    });
    workflow.checklistDeltas = fixture.cycles.map((cycle) => ({
      schemaVersion: 1,
      cycleNumber: cycle.cycleNumber,
      targetedTotal: fixture.cycleContract.targetedCheckIds.length,
      targetedMetBefore: 0,
      targetedMetAfter: 0,
      targetedNewlyMet: [],
      targetedStillUnknown: fixture.cycleContract.targetedCheckIds,
      targetedNeedsAttention: [],
      targetedNotApplicable: [],
      nonTargetedChanges: [],
      evidenceObservedCount: 1,
      evidenceConsumedCount: 0,
      evidenceNotConsumedCount: 1,
      evidenceNotConsumedReasons: { missing_check_id: 1 },
      summaryForHumans: "Validation passed but no targeted checklist item became met.",
      didGoalProgressChange: false,
      goalProgressBefore: 13,
      goalProgressAfter: 13,
      whyStillUnknownByCheckId: Object.fromEntries(fixture.cycleContract.targetedCheckIds.map((checkId) => [checkId, "evidence emitted but missing check ID"])),
      createdAt: `2026-06-${String(cycle.cycleNumber).padStart(2, "0")}T00:00:00.000Z`
    }));
    workflow.evidenceObservations = [{
      observationId: "obs-source-audit-missing-ids",
      cycleNumber: 23,
      checkId: "unknown",
      status: "met",
      evidenceText: "source-audit emitted targeted_check_satisfaction rows",
      evidenceSourceType: "command_output",
      sourceRef: { commandId: "source-audit", sourceKey: "targeted_check_satisfaction" },
      relevantPaths: ["src/aw_trends/app.py"],
      validationCommands: [],
      confidence: 0.45,
      observedAt: "2026-06-23T00:00:00.000Z",
      consumedByChecklist: false,
      notConsumedReason: "missing_check_id"
    }];

    const recommendation = buildNoProgressReconciliationRecommendation(workflow);

    expect(recommendation?.title).toContain("Debug checklist evidence ingestion");
    expect(recommendation?.title).not.toContain("Satisfy work package");
    expect(recommendation?.summary).toContain("did not reconcile");
  });

  it("derives history task separation without swapping completed and next tasks", async () => {
    const fixture = await readJsonFixture<{ cycles: Array<{ cycleNumber: number; triedToDo: string; nextRecommendedTasks: string[] }> }>("aw-trends-history-task-mixing.json");
    const workflow = defaultProjectWorkflowState();
    workflow.workflowCycle.cycleNumber = 23;
    workflow.cycleRetrospectives = fixture.cycles.map((cycle) => ({
      id: `retro-${cycle.cycleNumber}`,
      cycleNumber: cycle.cycleNumber,
      createdAt: `2026-06-${cycle.cycleNumber}T00:00:00.000Z`,
      triedToDo: cycle.triedToDo,
      whyChosen: "Fixture",
      changedFiles: [],
      commandsRun: [],
      passed: [],
      failed: [],
      learned: [],
      checklistItemsAdvanced: [],
      goalChecklistChangeRecommendation: "Fixture",
      nextRecommendedTasks: cycle.nextRecommendedTasks,
      shouldContinue: true
    }));

    const cycle21 = workflowCycleTaskSeparation(workflow, 21);
    const cycle22 = workflowCycleTaskSeparation(workflow, 22);

    expect(cycle21.completedTask).toBe("Satisfy work package: source provenance and access policy");
    expect(cycle21.nextRecommendedTask).toBe("Satisfy work package: core portfolio analytics");
    expect(cycle22.completedTask).toBe("Satisfy work package: core portfolio analytics");
    expect(cycle22.nextRecommendedTask).toBe("Satisfy work package: source provenance and access policy");
  });

  it("exports review logs with diagnostic objects and redaction", async () => {
    const fixture = await readJsonFixture<LegacyWorkflowFixture>("aw-trends-active-cycle-23-legacy.json");
    const workflow = buildWorkflowFromLegacyFixture(fixture);
    workflow.evidenceObservations = [{
      observationId: "obs-redaction",
      cycleNumber: workflow.workflowCycle.cycleNumber,
      checkId: "success_criterion:coxjd1",
      status: "met",
      evidenceText: "Evidence lives at /home/nicot/private/AW_Trends and token sk-abcdefghijklmnopqrstuvwxyz123456",
      evidenceSourceType: "command_output",
      sourceRef: { commandId: "source-audit", sourceKey: "targeted_check_satisfaction" },
      relevantPaths: ["/home/nicot/private/AW_Trends/src/aw_trends/app.py"],
      validationCommands: ["PYTHONPATH=src python3 -m aw_trends.app source-audit"],
      confidence: 0.9,
      observedAt: "2026-06-01T00:05:00.000Z",
      consumedByChecklist: true
    }];
    const project = makeAppServiceLoadedProject("review-log-diagnostics-project");
    project.record.identity.projectName = "AW_Trends";
    project.record.workflow = workflow;
    const storage = new WorkbenchStorage(await createTempDir("review-log-diagnostics-appdata"));
    const outputDir = await createTempDir("review-log-diagnostics-output");
    const outputPath = await storage.writeReviewLogBundleToFile(project.record, defaultSettings(), [], path.join(outputDir, "review-log.json"));
    const raw = await readFile(outputPath, "utf8");
    const parsed = projectReviewLogBundleSchema.parse(JSON.parse(raw));

    expect(parsed.workflowDiagnostics?.activeCycle.cycleContract?.targetedChecklistItems).toHaveLength(4);
    expect(parsed.workflowDiagnostics?.activeCycle.checklistDelta?.summaryForHumans).toContain("not recorded");
    expect(parsed.workflowDiagnostics?.activeCycle.validationLedger?.finalValidationStatus).toBe("not_run");
    expect(parsed.workflowDiagnostics?.activeCycle.repoHygieneReport?.status).toBe("unknown");
    expect(parsed.workflowDiagnostics?.activeCycle.recommendationHealth.fallbackUsedForCurrentRecommendation).toBe(true);
    expect(parsed.workflowDiagnostics?.activeCycle.cycleStartedWithTask).toContain("source provenance");
    expect(parsed.workflowDiagnostics?.activeCycle.evidenceCommands).toEqual([]);
    expect(raw).not.toContain("/home/nicot/private");
    expect(raw).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(raw).toContain("<local-path>");
    expect(parsed.workflowDiagnostics?.redactionStatus.fullCommandOutputIncluded).toBe(false);
  });

  it("keeps generic projects generic while still deriving cycle contracts from work-package data", async () => {
    const fixture = await readJsonFixture<LegacyWorkflowFixture>("generic-project-legacy.json");
    const workflow = buildWorkflowFromLegacyFixture(fixture);
    deriveLegacyWorkflowDiagnostics(workflow, {
      now: "2026-06-01T00:00:00.000Z",
      deriveChecklistDelta: true,
      deriveValidationLedger: true,
      deriveRepoHygiene: true
    });
    const commands = discoverProjectEvidenceCommands({
      files: [
        { relativePath: "src/importer.ts" },
        { relativePath: "tests/importer.test.ts" }
      ],
      checklist: workflow.goalChecklist,
      workPackages: workflow.workPackages
    });

    expect(workflow.cycleContract?.plainEnglishObjective).toContain("import validation");
    expect(workflow.cycleContract?.targetedChecklistItems.map((item) => item.checkId)).toEqual([
      "success_criterion:import-validation",
      "success_criterion:audit-summary"
    ]);
    expect(commands.some((command) => command.command.includes("aw_trends"))).toBe(false);
  });

  it("derives paused-after-checkpoint status for AW_Trends-like cycle 23", async () => {
    const fixture = await readJsonFixture<AwTrendsCycleFixture>("aw-trends-cycle-23-active.json");
    const workflow = buildAwTrendsWorkflow(fixture);
    workflow.workflowStage = "goal_ready";
    const codingAgent = {
      ...createAgentSkeleton("coding", "Coding Pass 23", "Implement source provenance", "gpt-5.4"),
      status: "completed" as const,
      workflowCycleNumber: fixture.cycleNumber,
      currentPhase: "Checkpointed worktree changes for merge",
      completedAt: "2026-06-01T00:10:00.000Z"
    };

    const status = deriveUserFacingWorkflowStatus(workflow, { agents: [codingAgent] });

    expect(status.label).toBe("Paused after coding checkpoint; awaiting integrity/merge");
    expect(status.label).not.toBe("Preparing Coding");
  });

  it("derived status reports validation failure as merge-blocking", async () => {
    const fixture = await readJsonFixture<AwTrendsCycleFixture>("aw-trends-cycle-23-active.json");
    const workflow = buildAwTrendsWorkflow(fixture);
    const ledger = finalizeValidationLedger({
      ...createValidationLedger({ cycleNumber: fixture.cycleNumber, testCommands: ["npm test"] }),
      commandResults: [makeLedgerCommandResult({ command: "npm test", exitCode: 1, stdout: "AssertionError" })]
    });
    workflow.validationLedgers = [ledger];

    const status = deriveUserFacingWorkflowStatus(workflow, { validationLedger: ledger });

    expect(status.label).toBe("Merge blocked by validation failure");
  });

  it("derived status does not display success or a validation blocker before coding has run", async () => {
    const fixture = await readJsonFixture<AwTrendsCycleFixture>("aw-trends-cycle-23-active.json");
    const workflow = buildAwTrendsWorkflow(fixture);
    const ledger = finalizeValidationLedger(createValidationLedger({ cycleNumber: fixture.cycleNumber }));
    workflow.validationLedgers = [ledger];

    const status = deriveUserFacingWorkflowStatus(workflow, { validationLedger: ledger });

    expect(status.label).toBe("Preparing Coding");
    expect(status.label).not.toMatch(/blocked/i);
    expect(status.label).not.toMatch(/success|passed/i);
  });

  it("derived status reports awaiting validation after coding reached a checkpoint", async () => {
    const fixture = await readJsonFixture<AwTrendsCycleFixture>("aw-trends-cycle-23-active.json");
    const workflow = buildAwTrendsWorkflow(fixture);
    workflow.stepProgress.coding.status = "completed";
    const ledger = finalizeValidationLedger(createValidationLedger({ cycleNumber: fixture.cycleNumber }));
    workflow.validationLedgers = [ledger];

    const status = deriveUserFacingWorkflowStatus(workflow, { validationLedger: ledger });

    expect(status.label).toBe("Awaiting validation");
  });

  it("operator view keeps fresh Cycle 1 setup out of merge-blocked validation state", () => {
    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Ship the first project increment.",
      confirmedAt: "2026-06-01T00:00:00.000Z"
    };
    workflow.workflowStage = "goal_ready";

    const view = buildOperatorWorkflowViewModel({ workflow });

    expect(view.currentStatus.primaryLabel).toBe("Preparing Coding");
    expect(view.currentStatus.nextOperatorAction).toBe("The system is preparing a scoped goal");
    expect(view.currentCycle.validationSummary.finalStatusLabel).toBe("Validation unknown");
    expect(view.currentCycle.validationSummary.mergeBlockedReasons).toEqual([]);
  });

  it("builds an operator overview model for AW_Trends-like cycle 23", async () => {
    const fixture = await readJsonFixture<AwTrendsCycleFixture>("aw-trends-cycle-23-active.json");
    const workflow = buildAwTrendsWorkflow(fixture);
    workflow.goalChecklist = [
      ...workflow.goalChecklist,
      ...Array.from({ length: 12 }, (_, index) => makeGoalCheck({
        id: `extra-check-${index + 1}`,
        title: `Extra required check ${index + 1}`,
        status: index < 2 ? "met" : "unknown",
        source: "success_criterion"
      }))
    ];
    workflow.ultimateGoalProgress = {
      percentComplete: 13,
      rationale: "2 of 16 required checks are met.",
      source: "deterministic",
      updatedAt: "2026-06-01T00:12:00.000Z"
    };
    workflow.recommendationHealth = recordRecommendationFallbackUsed(
      recordStructuredRecommendationFailure(workflow.recommendationHealth, {
        category: "schema_mismatch",
        message: "recommendations[0].priority expected enum value",
        at: "2026-06-01T00:00:00.000Z"
      }),
      {
        reason: "Planner fallback used because structured recommendation output failed schema validation.",
        candidateCount: 3,
        confidence: 0.91
      }
    );
    workflow.cycleContract = buildCycleContract(workflow, {
      now: "2026-06-01T00:00:00.000Z",
      selectedTaskSource: "deterministic_fallback"
    });
    const codingAgent = {
      ...createAgentSkeleton("coding", "Coding Pass 23", "Implement source provenance", "gpt-5.4"),
      status: "completed" as const,
      workflowCycleNumber: fixture.cycleNumber,
      currentPhase: "Checkpointed worktree changes for merge",
      changedFiles: ["src/aw_trends/app.py", "src/aw_trends/ranking.py"],
      completedAt: "2026-06-01T00:10:00.000Z"
    };

    const view = buildOperatorWorkflowViewModel({
      workflow,
      agents: [codingAgent],
      projectName: "AW_Trends",
      branch: "feature/source-provenance",
      workflowPauseRequested: true,
      approvalCount: 0
    });

    expect(view.currentStatus.primaryLabel).toBe("Paused after coding checkpoint; awaiting integrity/merge");
    expect(view.currentStatus.primaryLabel).not.toBe("Preparing Coding");
    expect(view.currentCycle.cycleNumber).toBe(23);
    expect(view.goalProgress.percent).toBe(13);
    expect(view.goalProgress.requiredMet).toBe(2);
    expect(view.goalProgress.requiredTotal).toBe(16);
    expect(view.currentCycle.cycleContract?.targetedChecklistItems).toHaveLength(4);
    expect(view.planner.fallbackWarning).toContain("Planner fallback used");
    expect(view.currentCycle.cycleContract?.concreteGoalForThisCycle).not.toContain("Use this coherent work package");
  });

  it("expands a generic work-package summary into a concrete cycle contract", async () => {
    const fixture = await readJsonFixture<AwTrendsCycleFixture>("aw-trends-cycle-23-active.json");
    const workflow = buildAwTrendsWorkflow(fixture);
    workflow.recommendationHealth = recordRecommendationFallbackUsed(
      recordStructuredRecommendationFailure(workflow.recommendationHealth, {
        category: "schema_mismatch",
        message: "recommendations[0].priority expected enum value",
        at: "2026-06-01T00:00:00.000Z"
      }),
      {
        reason: "Planner fallback used: structured recommendation JSON failed schema validation. Selected deterministic work package because it targeted 4 unknown required checks.",
        candidateCount: 3,
        confidence: 0.91
      }
    );

    const contract = buildCycleContract(workflow, {
      now: "2026-06-01T00:00:00.000Z",
      selectedTaskSource: "deterministic_fallback"
    });

    expect(contract.plainEnglishObjective).toContain("Prove the source provenance and access policy slice");
    expect(contract.plainEnglishObjective).toContain("ranking factors");
    expect(contract.plainEnglishObjective).toContain("validation flows");
    expect(contract.plainEnglishObjective).not.toContain("Use this coherent work package");
    expect(contract.targetedChecklistItems).toHaveLength(4);
    expect(contract.targetedChecklistItems[0]?.fullDescription).toContain("provider freshness");
    expect(contract.scoreBreakdown.repetition).toBe(-70);
    expect(contract.repetitionPenalty).toBe(-70);
    expect(contract.expectedFilesOrAreas).toEqual(expect.arrayContaining(["src/aw_trends/app.py", "src/aw_trends/ranking.py"]));
    expect(contract.fallbackOrHealthWarnings.join(" ")).toContain("Planner fallback used");
  });

  it("operator cycle contract exposes targeted checks, done-when criteria, expected files, validation plan, and repetition penalty", async () => {
    const fixture = await readJsonFixture<AwTrendsCycleFixture>("aw-trends-cycle-23-active.json");
    const workflow = buildAwTrendsWorkflow(fixture);
    workflow.cycleContract = buildCycleContract(workflow, {
      now: "2026-06-01T00:00:00.000Z",
      selectedTaskSource: "deterministic_fallback"
    });

    const view = buildOperatorWorkflowViewModel({ workflow, workflowPauseRequested: true });
    const contract = view.currentCycle.cycleContract;

    expect(contract?.concreteGoalForThisCycle).toContain("Prove the source provenance and access policy slice");
    expect(contract?.targetedChecklistItems.map((item) => item.fullDescription).join("\n")).toContain("provider freshness");
    expect(contract?.doneWhen.length).toBeGreaterThan(0);
    expect(contract?.expectedFilesOrAreas).toEqual(expect.arrayContaining(["src/aw_trends/app.py", "src/aw_trends/ranking.py"]));
    expect([...contract?.expectedEvidenceCommands ?? [], ...contract?.expectedValidationCommands ?? []].length).toBeGreaterThan(0);
    expect(view.planner.scoreBreakdown.find((score) => score.key === "repetition")?.value).toBe(-70);
  });

  it("operator repository hygiene flags suspicious changed paths and cleaned generated artifacts", async () => {
    const fixture = await readJsonFixture<AwTrendsCycleFixture>("aw-trends-cycle-23-active.json");
    const workflow = buildAwTrendsWorkflow(fixture);
    workflow.repoHygieneReports = [{
      status: "failed",
      scannedAt: "2026-06-01T00:15:00.000Z",
      scannedRef: "cycle:23",
      forbiddenFiles: ["EADME.md", "ocs/source-policy.md"],
      cleanedFiles: ["src/aw_trends/__pycache__/ranking.cpython-312.pyc"],
      warnings: ["Suspicious typo paths were found."],
      mergeBlockingFindings: ["EADME.md is not an expected repository path.", "ocs/source-policy.md looks like a docs typo."],
      summaryForHumans: "Repository hygiene failed because suspicious typo paths were present."
    }];
    const codingAgent = {
      ...createAgentSkeleton("coding", "Coding Pass 23", "Implement source provenance", "gpt-5.4"),
      workflowCycleNumber: fixture.cycleNumber,
      status: "completed" as const,
      changedFiles: ["EADME.md", "ocs/source-policy.md", "src/aw_trends/__pycache__/ranking.cpython-312.pyc"]
    };

    const view = buildOperatorWorkflowViewModel({ workflow, agents: [codingAgent] });

    expect(suspiciousPathReason("EADME.md")).toContain("README");
    expect(suspiciousPathReason("ocs/source-policy.md")).toContain("docs");
    expect(view.repositoryHealth.suspiciousPaths).toEqual(expect.arrayContaining(["EADME.md", "ocs/source-policy.md"]));
    expect(view.repositoryHealth.cleanedGeneratedArtifacts).toContain("src/aw_trends/__pycache__/ranking.cpython-312.pyc");
    expect(view.currentCycle.changedFilesSummary.find((group) => group.kind === "suspicious")?.files).toEqual(expect.arrayContaining(["EADME.md", "ocs/source-policy.md"]));
    expect(view.currentStatus.nextOperatorAction).toBe("Remove or repair forbidden changed paths before merge.");
  });

  it("marks targeted checks met from explicit targeted_check_satisfaction JSON", async () => {
    const fixture = await readJsonFixture<AwTrendsCycleFixture>("aw-trends-cycle-23-active.json");
    const evidence = await readJsonFixture<unknown>("aw-trends-source-audit-evidence.json");
    const workflow = buildAwTrendsWorkflow(fixture);
    const targetIds = fixture.selectedCandidate.targetedCheckIds;
    const observations = extractChecklistEvidenceObservations(JSON.stringify(evidence), {
      cycleNumber: fixture.cycleNumber,
      targetedCheckIds: targetIds,
      knownCheckIds: workflow.goalChecklist.map((check) => check.id),
      evidenceSourceType: "command_output",
      sourceRef: {
        commandId: "cmd-source-audit",
        agentRunId: "agent-source-audit"
      },
      observedAt: "2026-06-01T00:05:00.000Z"
    });

    const applied = applyChecklistEvidenceObservations(workflow.goalChecklist, observations, {
      targetedCheckIds: targetIds,
      timestamp: "2026-06-01T00:06:00.000Z"
    });
    const delta = computeChecklistDelta(workflow.goalChecklist, applied.checklist, applied.observations, {
      cycleNumber: fixture.cycleNumber,
      targetedCheckIds: targetIds,
      timestamp: "2026-06-01T00:06:00.000Z"
    });

    expect(observations.filter((observation) => observation.consumedByChecklist)).toHaveLength(4);
    expect(applied.checklist.filter((check) => targetIds.includes(check.id)).every((check) => check.status === "met")).toBe(true);
    expect(delta.targetedNewlyMet).toHaveLength(4);
    expect(delta.evidenceObservedCount).toBeGreaterThanOrEqual(4);
    expect(delta.evidenceConsumedCount).toBe(4);
    expect(delta.didGoalProgressChange).toBe(true);

    workflow.checklistDeltas = [delta];
    const view = buildOperatorWorkflowViewModel({ workflow });
    expect(view.currentCycle.checklistDeltaSummary.newlyMet).toEqual(expect.arrayContaining(targetIds));
    expect(view.currentCycle.checklistDeltaSummary.evidenceConsumed).toBe(4);
  });

  it("stores evidence without check IDs but does not consume it into checklist status", async () => {
    const fixture = await readJsonFixture<AwTrendsCycleFixture>("aw-trends-cycle-23-active.json");
    const evidence = await readJsonFixture<unknown>("aw-trends-evidence-without-check-ids.json");
    const workflow = buildAwTrendsWorkflow(fixture);
    const targetIds = fixture.selectedCandidate.targetedCheckIds;
    const observations = extractChecklistEvidenceObservations(JSON.stringify(evidence), {
      cycleNumber: fixture.cycleNumber,
      targetedCheckIds: targetIds,
      knownCheckIds: workflow.goalChecklist.map((check) => check.id),
      evidenceSourceType: "artifact",
      sourceRef: {
        artifactPath: "artifacts/source-audit.json"
      },
      observedAt: "2026-06-01T00:05:00.000Z"
    });
    const applied = applyChecklistEvidenceObservations(workflow.goalChecklist, observations, {
      targetedCheckIds: targetIds,
      timestamp: "2026-06-01T00:06:00.000Z"
    });
    const delta = computeChecklistDelta(workflow.goalChecklist, applied.checklist, applied.observations, {
      cycleNumber: fixture.cycleNumber,
      targetedCheckIds: targetIds,
      timestamp: "2026-06-01T00:06:00.000Z"
    });

    expect(observations.length).toBeGreaterThan(0);
    expect(applied.observations.every((observation) => !observation.consumedByChecklist)).toBe(true);
    expect(applied.observations.some((observation) => observation.notConsumedReason === "missing_check_id")).toBe(true);
    expect(applied.checklist.filter((check) => targetIds.includes(check.id)).every((check) => check.status === "unknown")).toBe(true);
    expect(delta.didGoalProgressChange).toBe(false);
    expect(delta.evidenceNotConsumedReasons.missing_check_id).toBeGreaterThan(0);
    expect(delta.whyStillUnknownByCheckId[targetIds[0] ?? ""]).toBe("evidence emitted but missing check ID");

    workflow.checklistDeltas = [delta];
    workflow.evidenceObservations = applied.observations;
    const view = buildOperatorWorkflowViewModel({ workflow });
    expect(view.currentCycle.checklistDeltaSummary.evidenceNotConsumedReasons.join(" ")).toContain("missing check id");
    expect(view.currentCycle.checklistDeltaSummary.whyStillUnknownByCheckId[targetIds[0] ?? ""]).toBe("evidence emitted but missing check ID");
  });

  it("distinguishes validation passing from checklist advancement", async () => {
    const fixture = await readJsonFixture<AwTrendsCycleFixture>("aw-trends-cycle-23-active.json");
    const workflow = buildAwTrendsWorkflow(fixture);
    const delta = computeChecklistDelta(workflow.goalChecklist, workflow.goalChecklist, [], {
      cycleNumber: fixture.cycleNumber,
      targetedCheckIds: fixture.selectedCandidate.targetedCheckIds,
      timestamp: "2026-06-01T00:06:00.000Z"
    });

    expect(delta.targetedNewlyMet).toHaveLength(0);
    expect(delta.didGoalProgressChange).toBe(false);
    expect(delta.summaryForHumans).toContain("No checklist evidence was emitted");
    expect(Object.values(delta.whyStillUnknownByCheckId)).toContain("no evidence emitted");

    const view = buildOperatorWorkflowViewModel({ workflow });
    expect(view.emptyStates.checklistDelta).toBe("No checklist delta recorded yet because integrity/reconciliation has not run.");
    expect(view.currentCycle.checklistDeltaSummary.summary).toContain("integrity/reconciliation has not run");
  });

  it("turns repeated no-delta attempts into a reconciliation recommendation", async () => {
    const fixture = await readJsonFixture<AwTrendsCycleFixture>("aw-trends-cycle-23-active.json");
    const workflow = buildAwTrendsWorkflow(fixture);
    workflow.cycleContract = buildCycleContract(workflow, {
      now: "2026-06-01T00:00:00.000Z",
      selectedTaskSource: "deterministic_fallback"
    });
    workflow.checklistDeltas = [20, 21, 23].map((cycleNumber) => ({
      schemaVersion: 1,
      cycleNumber,
      targetedTotal: 4,
      targetedMetBefore: 0,
      targetedMetAfter: 0,
      targetedNewlyMet: [],
      targetedStillUnknown: fixture.selectedCandidate.targetedCheckIds,
      targetedNeedsAttention: [],
      targetedNotApplicable: [],
      nonTargetedChanges: [],
      evidenceObservedCount: 1,
      evidenceConsumedCount: 0,
      evidenceNotConsumedCount: 1,
      evidenceNotConsumedReasons: { missing_check_id: 1 },
      summaryForHumans: "Validation passed but no targeted checklist item became met.",
      didGoalProgressChange: false,
      goalProgressBefore: 13,
      goalProgressAfter: 13,
      whyStillUnknownByCheckId: Object.fromEntries(fixture.selectedCandidate.targetedCheckIds.map((checkId) => [checkId, "evidence emitted but missing check ID"])),
      createdAt: `2026-06-${String(cycleNumber).padStart(2, "0")}T00:00:00.000Z`
    }));
    workflow.evidenceObservations = [{
      observationId: "obs-source-audit",
      cycleNumber: 23,
      checkId: "unknown",
      status: "met",
      evidenceText: "source-audit emitted targeted_check_satisfaction rows",
      evidenceSourceType: "command_output",
      sourceRef: { commandId: "source-audit", sourceKey: "targeted_check_satisfaction" },
      relevantPaths: ["src/aw_trends/app.py"],
      validationCommands: [],
      confidence: 0.45,
      observedAt: "2026-06-23T00:00:00.000Z",
      consumedByChecklist: false,
      notConsumedReason: "missing_check_id"
    }];

    const recommendation = buildNoProgressReconciliationRecommendation(workflow);

    expect(recommendation?.title).toBe("Debug checklist evidence ingestion for source provenance and access policy");
    expect(recommendation?.summary).toContain("source-audit emitted targeted_check_satisfaction rows");
    expect(recommendation?.summary).toContain("did not reconcile");
    expect(recommendation?.targetedCheckIds).toEqual(fixture.selectedCandidate.targetedCheckIds);
  });

  it("records structured recommendation failures and visible fallback warnings", () => {
    let health = defaultProjectWorkflowState().recommendationHealth;
    health = recordStructuredRecommendationFailure(health, {
      category: "schema_mismatch",
      message: "recommendations[0].riskLevel expected enum"
    });
    health = recordStructuredRecommendationFailure(health, {
      category: "missing_required_field",
      message: "ultimateGoalProgress is required"
    });
    health = recordRecommendationFallbackUsed(health, {
      reason: "Planner fallback used: structured recommendation JSON failed schema validation. Selected deterministic work package because it targeted 4 unknown required checks.",
      candidateCount: 3,
      confidence: 0.91
    });

    expect(health.totalStructuredAttempts).toBe(2);
    expect(health.totalStructuredFailures).toBe(2);
    expect(health.consecutiveStructuredFailures).toBe(2);
    expect(health.visibleWarningLevel).toBe("warning");
    expect(health.fallbackUsedForCurrentRecommendation).toBe(true);
    expect(health.fallbackReason).toContain("Planner fallback used");

    const workflow = defaultProjectWorkflowState();
    workflow.ultimateGoal.confirmedAt = "2026-06-01T00:00:00.000Z";
    workflow.recommendationHealth = health;
    const warningView = buildOperatorWorkflowViewModel({ workflow });
    expect(warningView.planner.fallbackWarning).toContain("Planner fallback used");

    const structuredWorkflow = defaultProjectWorkflowState();
    structuredWorkflow.ultimateGoal.confirmedAt = "2026-06-01T00:00:00.000Z";
    structuredWorkflow.recommendationHealth = {
      ...structuredWorkflow.recommendationHealth,
      totalStructuredAttempts: 1,
      selectedTaskSource: "structured_recommendation",
      modelRecommendationAccepted: true
    };
    const structuredView = buildOperatorWorkflowViewModel({ workflow: structuredWorkflow });
    expect(structuredView.planner.fallbackWarning).toBeUndefined();
  });

  it("discovers safe AW_Trends-like evidence commands separately from tests", async () => {
    const fixture = await readJsonFixture<AwTrendsCycleFixture>("aw-trends-cycle-23-active.json");
    const workflow = buildAwTrendsWorkflow(fixture);
    const commands = discoverProjectEvidenceCommands({
      files: [
        { relativePath: "src/aw_trends/app.py" },
        { relativePath: "src/aw_trends/ranking.py" },
        { relativePath: "tests/test_source_audit.py" }
      ],
      checklist: workflow.goalChecklist,
      previousSuccessfulCommands: [
        "python3 -m unittest discover -s tests -q",
        "/bin/bash -lc 'git status --short --untracked-files=all'"
      ]
    });

    const sourceAudit = commands.find((command) => command.command.includes("source-audit"));
    const gitStatus = commands.find((command) => command.command.includes("git status --short"));
    expect(sourceAudit?.safeDefault).toBe(true);
    expect(sourceAudit?.expectedOutput).toBe("json");
    expect(gitStatus?.expectedOutput).toBe("text");
    expect(sourceAudit?.mapsToCheckIds).toEqual(expect.arrayContaining(fixture.selectedCandidate.targetedCheckIds));
    expect(commands.some((command) => command.command === "python3 -m unittest discover -s tests -q")).toBe(true);
  });

  it("does not infer JSON output from generic status or audit command names", () => {
    const commands = discoverProjectEvidenceCommands({
      previousSuccessfulCommands: [
        "python3 tools/audit_sources.py",
        "/bin/bash -lc 'git diff --check && git status --short --untracked-files=all'",
        "python3 tools/source-audit.py --limit 3",
        "python3 -m sample.app status"
      ]
    });

    expect(commands.find((command) => command.command.includes("audit_sources.py"))?.expectedOutput).toBe("text");
    expect(commands.find((command) => command.command.includes("git diff --check"))?.expectedOutput).toBe("text");
    expect(commands.find((command) => command.command.includes("source-audit.py"))?.expectedOutput).toBe("json");
    expect(commands.find((command) => command.command.includes("sample.app status"))?.expectedOutput).toBe("json");
  });

  it("derives a cycle contract for legacy workflow state without one", async () => {
    const fixture = await readJsonFixture<AwTrendsCycleFixture>("aw-trends-cycle-23-active.json");
    const workflow = buildAwTrendsWorkflow(fixture);
    const legacyWorkflow = projectWorkflowStateSchema.parse({
      ...workflow,
      cycleContract: undefined
    });
    const contract = buildCycleContract(legacyWorkflow, {
      now: "2026-06-01T00:00:00.000Z",
      selectedTaskSource: "derived_from_legacy_state"
    });

    expect(legacyWorkflow.cycleContract).toBeUndefined();
    expect(contract.selectedTaskSource).toBe("derived_from_legacy_state");
    expect(contract.targetedChecklistItems).toHaveLength(4);
    expect(contract.plainEnglishObjective).toContain("machine-checkable evidence");
  });
});

describe("project shell handoff", () => {
  const createProjectShellSpawnStub = (
    handler: (child: EventEmitter & { unref: () => void }) => void
  ): SpawnProcess =>
    (() => {
      const child = new EventEmitter() as EventEmitter & { unref: () => void };
      child.unref = () => undefined;
      queueMicrotask(() => {
        handler(child);
      });
      return child as unknown as ReturnType<SpawnProcess>;
    }) as SpawnProcess;

  it("builds a Windows handoff plan scoped to the active WSL project root", () => {
    const plan = buildWindowsProjectShellLaunchPlan("C:\\Users\\nicot\\project\\.agent-workbench\\manual-handoff\\open-codex-terminal.cmd", "Workbench");

    expect(plan.executable.toLowerCase()).toContain("cmd.exe");
    expect(plan.cwd).toContain(".agent-workbench\\manual-handoff");
    expect(plan.args).toContain("/k");
    expect(plan.args).not.toContain("/c");
    expect(plan.args).not.toContain("/s");
    expect(plan.commandPreview).toContain("cmd.exe");
    expect(plan.commandPreview).toContain("/k");
    expect(plan.commandPreview).toContain("open-codex-terminal.cmd");
    expect(plan.commandPreview).toContain("Codex Handoff - Workbench");
  });

  it("builds a Codex handoff prompt with repair and user-input context", () => {
    const prompt = buildProjectShellHandoffPrompt({
      projectName: "Workbench",
      projectRoot: "/home/nicot/project",
      manualHandoff: {
        reason: "repair_exhausted",
        title: "Automatic repair reached its limit",
        whatSystemWasTryingToDo: "Repair the renderer build",
        validationIssue: "Vite still fails in production mode.",
        latestFailureReason: "The asset manifest path is still wrong.",
        involvedPaths: ["src/main/index.ts", "vite.config.ts"]
      },
      pendingUserInputRequests: [{
        title: "API key",
        description: "The agent needs a local credential before it can continue.",
        attachmentInboxRelativePath: ".agent-workbench/input-requests/request-1",
        attachments: [{ relativePath: ".agent-workbench/input-requests/request-1/setup-notes.txt" }],
        questions: [{
          header: "API key",
          question: "Create the account and paste the key.",
          isSecret: true
        }]
      }],
      pendingHumanInterventions: [{
        title: "Accept the vendor invite",
        description: "Finish the browser-based approval step.",
        severity: "high"
      }]
    });

    expect(prompt).toContain("Current workflow blocker:");
    expect(prompt).toContain("Pending user input requests:");
    expect(prompt).toContain("API key [secret]: Create the account and paste the key.");
    expect(prompt).toContain("Other pending human blockers:");
    expect(prompt).toContain("Accept the vendor invite");
  });

  it("builds a Codex repair-agent prompt with hygiene, validation, and cycle context", () => {
    const hygiene = {
      status: "failed" as const,
      scannedAt: "2026-06-27T12:00:00.000Z",
      scannedRef: "merge:23:pre",
      forbiddenFiles: ["EADME.md"],
      cleanedFiles: ["src/aw_trends/__pycache__/app.cpython-312.pyc"],
      warnings: [],
      mergeBlockingFindings: ["EADME.md looks like a typo path and blocks merge."],
      summaryForHumans: "Repository hygiene blocked merge: EADME.md looks like a typo path."
    };
    const ledger = createValidationLedger({
      cycleNumber: 23,
      testCommands: ["python3 -m unittest discover -s tests -q"]
    });
    ledger.commandResults = [
      {
        ...makeLedgerCommandResult({
          command: "python3 -m pytest",
          exitCode: 1,
          stderr: "/usr/bin/python3: No module named pytest"
        }),
        fullOutputRef: "private-full-output-ref"
      }
    ];
    const finalized = finalizeValidationLedger(ledger, { repoHygieneReport: hygiene });
    const prompt = buildWorkflowRepairAgentPrompt({
      projectName: "AW_Trends",
      projectRoot: "/home/nicot/dev/AW_Trends",
      branchOrPath: "main",
      statusLabel: "Merge blocked by repository hygiene",
      technicalStage: "Repair Loop",
      activeAgent: "Repair Coding Pass 1",
      currentPhase: "Merge blocked by repository hygiene",
      currentFocus: "Prove source provenance and access policy with machine-checkable evidence.",
      nextOperatorAction: "Remove or repair forbidden changed paths before merge.",
      cycleNumber: 23,
      cycleContract: {
        schemaVersion: 1,
        cycleNumber: 23,
        createdAt: "2026-06-27T12:00:00.000Z",
        updatedAt: "2026-06-27T12:00:00.000Z",
        selectedTaskTitle: "Satisfy source provenance and access policy",
        selectedTaskKind: "work_package",
        selectedTaskSource: "deterministic_fallback",
        plainEnglishObjective: "Produce evidence for source provenance and access policy.",
        concreteGoalForThisCycle: "Prove source provenance and access policy with machine-checkable evidence.",
        targetedChecklistItems: [{
          checkId: "source-access-policy",
          title: "Source access policy is documented",
          fullDescription: "Document allowed source access, provider freshness, and dashboard warning behavior.",
          required: true,
          itemKind: "required",
          previousStatus: "unknown",
          currentStatus: "unknown",
          currentEvidence: "",
          evidenceHistoryCount: 0,
          whyTargeted: "The current work package selected this check.",
          acceptanceHint: "Evidence must reference the check ID.",
          relatedPaths: ["docs/source-provenance-access-policy-evidence.md"],
          observableSignalsExpected: ["targeted_check_satisfaction includes source-access-policy"]
        }],
        expectedFilesOrAreas: ["docs/source-provenance-access-policy-evidence.md"],
        expectedValidationCommands: ["python3 -m unittest discover -s tests -q"],
        expectedEvidenceCommands: ["python3 scripts/source-audit.py --json"],
        acceptanceCriteria: [],
        nonGoalsForThisCycle: [],
        constraintsForThisCycle: [],
        whySelectedNow: "Required checks remain unknown.",
        scoreBreakdown: { repetition: -70 },
        repetitionPenalty: -70,
        priorSimilarAttempts: [],
        currentKnownBlockers: ["Repository hygiene is blocking merge."],
        fallbackOrHealthWarnings: [],
        doneWhen: ["Hygiene passes and validation is reportable."],
        failureModes: ["Creating typo paths such as EADME.md."],
        sourceDataRefs: {}
      },
      checklistDelta: undefined,
      validationLedger: finalized,
      repoHygieneReport: hygiene,
      changedFiles: ["EADME.md", "docs/source-provenance-access-policy-evidence.md"],
      recentAgentMessages: ["Repair Coding Pass 1: wrote EADME.md by mistake."],
      pendingApprovals: 0
    });

    expect(prompt).toContain("separate Codex CLI repair agent");
    expect(prompt).toContain("Merge blocked by repository hygiene");
    expect(prompt).toContain("source-access-policy");
    expect(prompt).toContain("EADME.md looks like a typo path");
    expect(prompt).toContain("Final status: failed");
    expect(prompt).toContain("Remove or repair forbidden changed paths before merge.");
    expect(prompt).not.toContain("private-full-output-ref");
  });

  it("adds merge-conflict recovery steps to Codex handoff prompts", () => {
    const prompt = buildProjectShellHandoffPrompt({
      projectName: "Workbench",
      projectRoot: "/home/nicot/project",
      manualHandoff: {
        reason: "merge_conflicts",
        title: "Merge conflicts detected",
        whatSystemWasTryingToDo: "Integrate validated coding-agent branches into the opened project checkout",
        validationIssue: "Merge conflicts were detected and require follow-up.",
        latestFailureReason: "src/index.ts",
        involvedPaths: ["src/index.ts"]
      },
      pendingUserInputRequests: [],
      pendingHumanInterventions: []
    });

    expect(prompt).toContain("Merge conflict recovery:");
    expect(prompt).toContain("Run the project's relevant validation commands");
    expect(prompt).toContain("press Retry merge");
  });

  it("fails safely when project shell handoff is requested off Windows", async () => {
    await expect(openProjectShellWindow({
      projectName: "Workbench",
      projectRoot: "/home/nicot/project",
      projectHostPath: "/tmp/project-shell-off-windows",
      prompt: "hello\n",
      settings: {
        executionMode: "local",
        distroName: "Ubuntu",
        codexBinaryPath: "codex"
      }
    }, "linux")).resolves.toEqual({
      launched: false,
      message: "Project shell handoff is only available on Windows."
    });
  });

  it("writes the handoff prompt and resolves as soon as the terminal launcher spawns", async () => {
    const projectHostPath = await createTempDir("project-shell-launch");
    const prompt = "Manual handoff prompt\n";
    let launch:
      | {
        executable: string;
        args: string[];
        options: Record<string, unknown>;
      }
      | undefined;
    const spawnStub = createProjectShellSpawnStub((child) => {
      child.emit("spawn");
    });
    const wrappedSpawn = ((executable: string, args: string[], options: Record<string, unknown>) => {
      launch = { executable, args, options };
      return spawnStub(executable, args, options as never);
    }) as SpawnProcess;

    await expect(openProjectShellWindow({
      projectName: "Workbench",
      projectRoot: "/home/nicot/project",
      projectHostPath,
      prompt,
      settings: {
        executionMode: "local",
        distroName: "Ubuntu",
        codexBinaryPath: "codex"
      }
    }, "win32", wrappedSpawn)).resolves.toMatchObject({
      launched: true
    });
    expect(launch?.executable.toLowerCase()).toContain("cmd.exe");
    expect(launch?.options).toMatchObject({
      cwd: path.join(projectHostPath, ".agent-workbench", "manual-handoff"),
      detached: true,
      stdio: "ignore",
      windowsHide: false
    });
    await expect(readFile(path.join(projectHostPath, ".agent-workbench", "manual-handoff", "codex-handoff.md"), "utf8")).resolves.toBe(prompt);
    await expect(readFile(path.join(projectHostPath, ".agent-workbench", "manual-handoff", "open-codex-terminal.cmd"), "utf8"))
      .resolves.toContain("if \"%status%\"==\"-1\" (");
    await expect(readFile(path.join(projectHostPath, ".agent-workbench", "manual-handoff", "terminal-launch.txt"), "utf8"))
      .resolves.toContain("Launcher script:");
  });

  it("surfaces Windows launcher failures instead of reporting false success", async () => {
    const spawnStub = createProjectShellSpawnStub((child) => {
      child.emit("error", new Error("spawn EPERM"));
    });

    await expect(openProjectShellWindow({
      projectName: "Workbench",
      projectRoot: "/home/nicot/project",
      projectHostPath: await createTempDir("project-shell-error"),
      prompt: "Manual handoff prompt\n",
      settings: {
        executionMode: "local",
        distroName: "Ubuntu",
        codexBinaryPath: "codex"
      }
    }, "win32", spawnStub)).resolves.toMatchObject({
      launched: false,
      message: expect.stringContaining("spawn EPERM")
    });
  });

  it("falls back to PowerShell with a valid Start-Process command when the primary launcher fails", async () => {
    const launches: Array<{
      executable: string;
      args: string[];
      options: Record<string, unknown>;
    }> = [];
    const spawnStub = ((executable: string, args: string[], options: Record<string, unknown>) => {
      launches.push({ executable, args, options });
      const child = new EventEmitter() as EventEmitter & { unref: () => void };
      child.unref = () => undefined;
      queueMicrotask(() => {
        if (launches.length === 1) {
          child.emit("error", new Error("primary failed"));
          return;
        }
        child.emit("spawn");
      });
      return child as unknown as ReturnType<SpawnProcess>;
    }) as SpawnProcess;

    await expect(openProjectShellWindow({
      projectName: "Workbench",
      projectRoot: "/home/nicot/project",
      projectHostPath: await createTempDir("project-shell-fallback"),
      prompt: "Manual handoff prompt\n",
      settings: {
        executionMode: "local",
        distroName: "Ubuntu",
        codexBinaryPath: "codex"
      }
    }, "win32", spawnStub)).resolves.toMatchObject({
      launched: true
    });

    expect(launches).toHaveLength(2);
    expect(launches[1]?.executable.toLowerCase()).toContain("powershell.exe");
    expect(launches[1]?.options).toMatchObject({
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    expect(launches[1]?.args).toContain("-Command");
    const fallbackCommand = launches[1]?.args[launches[1].args.length - 1] ?? "";
    expect(fallbackCommand).toContain("Start-Process -FilePath");
    expect(fallbackCommand).toContain("cmd.exe");
    expect(fallbackCommand).toContain("open-codex-terminal.cmd");
    expect(fallbackCommand).toContain("-ArgumentList @('/d', '/k',");
    expect(fallbackCommand).toContain("-WorkingDirectory");
  });

  it("omits an invalid distro flag and falls back to the default WSL distro when the configured distro cannot be matched", async () => {
    const projectHostPath = await createTempDir("project-shell-default-distro");
    const execFileStub = ((file: string, args: readonly string[], _options: Record<string, unknown>, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      expect(file).toBe("wsl.exe");
      expect(args).toEqual(["--list", "--quiet"]);
      callback(null, "Ubuntu-24.04\nDebian\n", "");
      return undefined as never;
    }) as unknown as ExecFileProcess;
    const spawnStub = createProjectShellSpawnStub((child) => {
      child.emit("spawn");
    });

    await expect(openProjectShellWindow({
      projectName: "Workbench",
      projectRoot: "/mnt/c/Users/nicot/project",
      projectHostPath,
      prompt: "Manual handoff prompt\n",
      settings: {
        executionMode: "wsl",
        distroName: "Ubuntu",
        codexBinaryPath: "codex"
      }
    }, "win32", spawnStub, execFileStub)).resolves.toMatchObject({
      launched: true
    });

    await expect(readFile(path.join(projectHostPath, ".agent-workbench", "manual-handoff", "open-codex-terminal.cmd"), "utf8"))
      .resolves.not.toContain("wsl.exe -d ");
    await expect(readFile(path.join(projectHostPath, ".agent-workbench", "manual-handoff", "terminal-launch.txt"), "utf8"))
      .resolves.toContain("Effective WSL distro: <default>");
  });

  it("uses the lone installed distro when the configured name is stale", async () => {
    const projectHostPath = await createTempDir("project-shell-single-distro");
    const execFileStub = ((_: string, __: readonly string[], ___: Record<string, unknown>, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      callback(null, "Ubuntu-24.04\n", "");
      return undefined as never;
    }) as unknown as ExecFileProcess;
    const spawnStub = createProjectShellSpawnStub((child) => {
      child.emit("spawn");
    });

    await expect(openProjectShellWindow({
      projectName: "Workbench",
      projectRoot: "/mnt/c/Users/nicot/project",
      projectHostPath,
      prompt: "Manual handoff prompt\n",
      settings: {
        executionMode: "wsl",
        distroName: "Ubuntu",
        codexBinaryPath: "codex"
      }
    }, "win32", spawnStub, execFileStub)).resolves.toMatchObject({
      launched: true
    });

    await expect(readFile(path.join(projectHostPath, ".agent-workbench", "manual-handoff", "open-codex-terminal.cmd"), "utf8"))
      .resolves.toContain('wsl.exe" -d "Ubuntu-24.04"');
    await expect(readFile(path.join(projectHostPath, ".agent-workbench", "manual-handoff", "terminal-launch.txt"), "utf8"))
      .resolves.toContain("Effective WSL distro: Ubuntu-24.04");
  });
});

describe("project boundary", () => {
  it("rejects unsafe relative paths before mutating project files", () => {
    expect(ensureSafeProjectRelativePath("reports/output.json", "Export")).toBe("reports/output.json");
    expect(() => ensureSafeProjectRelativePath("../outside.json", "Export")).toThrow(ProjectBoundaryError);
    expect(() => ensureSafeProjectRelativePath("/tmp/outside.json", "Export")).toThrow(ProjectBoundaryError);
  });

  it("keeps host-path mutations inside the canonical project root and blocks symlink escapes", async () => {
    const projectRoot = await createTempDir("boundary-root");
    const outsideRoot = await createTempDir("boundary-outside");
    await mkdir(path.join(projectRoot, "safe"), { recursive: true });
    await mkdir(path.join(outsideRoot, "target"), { recursive: true });
    await symlink(outsideRoot, path.join(projectRoot, "escape"));

    const safePath = await assertHostPathWithinProjectRoot(projectRoot, path.join(projectRoot, "safe", "file.txt"), "Write file");
    expect(safePath.endsWith(path.join("safe", "file.txt"))).toBe(true);

    await expect(
      assertHostPathWithinProjectRoot(projectRoot, path.join(projectRoot, "escape", "target", "file.txt"), "Write file")
    ).rejects.toThrow("outside the active project folder");
  });

  it("rejects execution-path traversal and keeps derived worktree paths inside the project", async () => {
    const projectRoot = await createTempDir("boundary-execution");
    const settings = {
      executionMode: "local" as const,
      distroName: "Ubuntu"
    };

    const nestedPath = joinExecutionPathWithinProject(projectRoot, ".agent-workbench", "worktrees", "coding-pass");
    expect(nestedPath).toContain(".agent-workbench");

    await expect(
      assertExecutionPathWithinProjectRoot(
        projectRoot,
        "../outside",
        projectRoot,
        settings,
        undefined,
        "Command execution"
      )
    ).rejects.toThrow("escape the active project folder");

    await expect(
      assertExecutionPathWithinProjectRoot(
        projectRoot,
        nestedPath,
        projectRoot,
        settings,
        undefined,
        "Command execution"
      )
    ).resolves.toMatchObject({
      executionPath: nestedPath
    });
  });

  it("maps execution paths back into the active host project root without relying on renderer-shared Node helpers", () => {
    expect(
      resolveExecutionPathWithinProjectRoot(
        "/home/nicot/project",
        "/home/nicot/project/src/index.ts",
        "\\\\wsl$\\Ubuntu\\home\\nicot\\project",
        "Agent execution"
      )
    ).toEqual({
      executionPath: "/home/nicot/project/src/index.ts",
      hostPath: "\\\\wsl$\\Ubuntu\\home\\nicot\\project\\src\\index.ts"
    });

    expect(
      resolveExecutionPathWithinProjectRoot(
        "/mnt/c/Users/nicot/project",
        "/mnt/c/Users/nicot/project/.agent-workbench/worktrees/coding",
        "C:\\Users\\nicot\\project",
        "Coding worktree creation"
      )
    ).toEqual({
      executionPath: "/mnt/c/Users/nicot/project/.agent-workbench/worktrees/coding",
        hostPath: "C:\\Users\\nicot\\project\\.agent-workbench\\worktrees\\coding"
      });

    expect(
      resolveExecutionPathWithinProjectRoot(
        "/mnt/c/Users/nicot/Downloads/test2",
        "C:\\Users\\nicot\\Downloads\\test2\\src\\index.ts",
        "C:\\Users\\nicot\\Downloads\\test2",
        "Agent execution"
      )
    ).toEqual({
      executionPath: "/mnt/c/Users/nicot/Downloads/test2/src/index.ts",
      hostPath: "C:\\Users\\nicot\\Downloads\\test2\\src\\index.ts"
    });
  });
});

describe("project content assessment", () => {
  it("treats empty and placeholder-only folders as not meaningful for repo analysis", () => {
    expect(
      hasMeaningfulRepositoryContent({
        files: [],
        dependencies: [],
        stats: {
          projectRoot: "/repo",
          kind: "folder",
          totalFiles: 0,
          totalFolders: 0,
          totalSizeBytes: 0,
          includedFiles: 0,
          includedFolders: 0,
          includedSizeBytes: 0,
          excludedFiles: 0,
          excludedFolders: 0,
          excludedSizeBytes: 0,
          excludedPaths: [],
          fileTypeBreakdown: {},
          languageBreakdown: {},
          entryPoints: [],
          manifestFiles: [],
          testsPresent: false,
          primaryManagers: [],
          explanation: "Empty"
        }
      })
    ).toBe(false);

    expect(
      hasMeaningfulRepositoryContent({
        files: [
          { absolutePath: "/repo/.gitignore", relativePath: ".gitignore", size: 24, language: "Other" },
          { absolutePath: "/repo/README.md", relativePath: "README.md", size: 80, language: "Markdown" }
        ],
        dependencies: [],
        stats: {
          projectRoot: "/repo",
          kind: "folder",
          totalFiles: 2,
          totalFolders: 0,
          totalSizeBytes: 104,
          includedFiles: 2,
          includedFolders: 0,
          includedSizeBytes: 104,
          excludedFiles: 0,
          excludedFolders: 0,
          excludedSizeBytes: 0,
          excludedPaths: [],
          fileTypeBreakdown: { Markdown: 1, Other: 1 },
          languageBreakdown: { Markdown: 80, Other: 24 },
          entryPoints: [],
          manifestFiles: [],
          testsPresent: false,
          primaryManagers: [],
          explanation: "Placeholder"
        }
      })
    ).toBe(false);
  });

  it("treats source files as meaningful repository content", () => {
    expect(
      hasMeaningfulRepositoryContent({
        files: [
          { absolutePath: "/repo/package.json", relativePath: "package.json", size: 180, language: "JSON" },
          { absolutePath: "/repo/src/index.ts", relativePath: "src/index.ts", size: 140, language: "TypeScript" }
        ],
        dependencies: [],
        stats: {
          projectRoot: "/repo",
          kind: "folder",
          totalFiles: 2,
          totalFolders: 1,
          totalSizeBytes: 320,
          includedFiles: 2,
          includedFolders: 1,
          includedSizeBytes: 320,
          excludedFiles: 0,
          excludedFolders: 0,
          excludedSizeBytes: 0,
          excludedPaths: [],
          fileTypeBreakdown: { JSON: 1, TypeScript: 1 },
          languageBreakdown: { JSON: 180, TypeScript: 140 },
          entryPoints: ["src/index.ts"],
          manifestFiles: ["package.json"],
          testsPresent: false,
          primaryManagers: ["npm"],
          explanation: "Source files"
        }
      })
    ).toBe(true);
  });
});

describe("ultimate goal text import", () => {
  it("parses labeled paragraphs into an import preview", () => {
    const preview = parseUltimateGoalText([
      "Project Charter: Build a durable workflow dashboard.",
      "Detailed Intent:\nCoordinate repo analysis, planning, coding, and validation in one explicit loop.",
      "Success Criteria:\n- Recommendations are persisted.\n- Repair loops are visible.",
      "Constraints:\n- Keep typed IPC.\n- Keep the renderer sandboxed.",
      "Explicit non-goals:\n- No hidden filesystem access.",
      "Definition of done:\n- Tests cover the import path.",
      "Quality Bar: Stable, test-backed behavior.",
      "Target Audience: Developers operating the desktop app.",
      "Non-negotiable requirements:\n- Preserve renderer sandboxing.",
      "Charter non-goals:\n- Do not add TUI scraping.",
      "Flexible requirements:\n- Button copy may change if clearer.",
      "Nice-to-have ideas:\n- Add import previews.",
      "User constraints:\n- Keep imports local.",
      "Technical preferences:\n- Use typed IPC.",
      "Aesthetic preferences:\n- Keep settings dense."
    ].join("\n\n"), "goal.txt");

    expect(preview.completeness).toBe("complete");
    expect(preview.goal.summary).toBe("Build a durable workflow dashboard.");
    expect(preview.goal.successCriteria).toEqual(["Recommendations are persisted.", "Repair loops are visible."]);
    expect(preview.goal.constraints).toEqual(["Keep typed IPC.", "Keep the renderer sandboxed."]);
    expect(preview.charter.explicitNonGoals).toEqual(["Do not add TUI scraping."]);
    expect(preview.charter.flexibleRequirements).toEqual(["Button copy may change if clearer."]);
    expect(preview.missingFields).toEqual([]);
  });

  it("assigns text to the region named by each section title", () => {
    const preview = parseUltimateGoalText([
      "Current Effective Goal: Build a focused import flow.",
      "Detailed Intent: Keep goal setup explicit and reviewable.",
      "Success Criteria:\n- Uploaded files populate the matching fields.",
      "Constraints:\n- Preserve typed IPC.",
      "Explicit non-goals:\n- Do not auto-confirm uploaded files.",
      "Definition of done:\n- Parser tests cover adjacent headings.",
      "Quality Bar: Reliable and easy to inspect.",
      "Target Audience: Workbench operators.",
      "Non-negotiable requirements:\n- Do not expose Node APIs.",
      "Charter non-goals",
      "- Do not add websocket transport.",
      "- Do not scrape a TUI.",
      "",
      "Flexible requirements",
      "- The import button can live in Settings or Workflow.",
      "- The title matching can accept old aliases.",
      "",
      "Nice-to-have ideas:\n- Show richer previews.",
      "User constraints:\n- Keep the file plain text.",
      "Technical preferences:\n- Use the shared type model.",
      "Aesthetic preferences:\n- Keep controls compact."
    ].join("\n"), "regions.txt");

    expect(preview.charter.explicitNonGoals).toEqual([
      "Do not add websocket transport.",
      "Do not scrape a TUI."
    ]);
    expect(preview.charter.flexibleRequirements).toEqual([
      "The import button can live in Settings or Workflow.",
      "The title matching can accept old aliases."
    ]);
    expect(preview.missingFields).toEqual([]);
  });

  it("falls back to paragraph order and reports missing sections when parsing is partial", () => {
    const preview = parseUltimateGoalText([
      "Build a durable workflow dashboard.",
      "Coordinate repo analysis, planning, coding, and validation in one explicit loop.",
      "- Recommendations are persisted.\n- Repair loops are visible."
    ].join("\n\n"), "partial-goal.txt");

    expect(preview.goal.summary).toBe("Build a durable workflow dashboard.");
    expect(preview.goal.detailedIntent).toContain("Coordinate repo analysis");
    expect(preview.goal.successCriteria).toEqual(["Recommendations are persisted.", "Repair loops are visible."]);
    expect(preview.completeness).toBe("partial");
    expect(preview.missingFields).toContain("constraints");
    expect(preview.warnings.some((warning) => warning.includes("expected field order"))).toBe(true);
  });
});

describe("AppService workflow performance guards", () => {
  it("quarantines appended and malformed project state JSON without throwing", async () => {
    const appData = await createTempDir("state-repair-storage");
    const storage = new WorkbenchStorage(appData);
    const appendedRecord = makeAppServiceLoadedProject("appended-state").record;
    const appendedStatePath = path.join(appData, "projects", appendedRecord.id, "state.json");
    await mkdir(path.dirname(appendedStatePath), { recursive: true });
    await storage.saveRegistry([appendedRecord.id]);
    await writeFile(appendedStatePath, `${JSON.stringify(appendedRecord)}${JSON.stringify({ duplicate: true })}`);

    const appendedProjects = await storage.loadAllProjects();
    const appendedIssues = storage.consumeLoadIssues();
    const appendedIssue = appendedIssues.find((issue) => issue.action === "quarantined" && issue.statePath === appendedStatePath);

    expect(appendedProjects).toEqual([]);
    expect(appendedIssue?.message).toContain("duplicate_appended_json");
    expect(appendedIssue?.quarantinePath).toContain("state.json.quarantine.duplicate-appended-json");

    const brokenRecord = makeAppServiceLoadedProject("broken-state").record;
    const brokenStatePath = path.join(appData, "projects", brokenRecord.id, "state.json");
    await mkdir(path.dirname(brokenStatePath), { recursive: true });
    await storage.saveRegistry([brokenRecord.id]);
    await writeFile(brokenStatePath, "{ malformed");

    await expect(storage.loadAllProjects()).resolves.toEqual([]);
    const quarantineIssues = storage.consumeLoadIssues();
    const quarantineIssue = quarantineIssues.find((issue) => issue.action === "quarantined" && issue.statePath === brokenStatePath);
    expect(quarantineIssue?.quarantinePath).toContain("state.json.quarantine.malformed-json");
  });

  it("repair:state reports a malformed state path and exits cleanly after quarantine", async () => {
    const appData = await createTempDir("repair-state-script");
    const projectDir = path.join(appData, "projects", "script-broken");
    const statePath = path.join(projectDir, "state.json");
    await mkdir(projectDir, { recursive: true });
    await writeFile(statePath, "not json");

    const repairModule = await import(pathToFileURL(path.resolve("scripts/repair-state.mjs")).href) as {
      loadSanitizer: () => Promise<unknown>;
      repairFile: (targetStatePath: string, sanitizer: unknown) => Promise<unknown>;
      buildPrintableResult: (result: unknown) => Record<string, unknown>;
    };
    const result = await repairModule.repairFile(statePath, await repairModule.loadSanitizer());
    const printable = repairModule.buildPrintableResult(result);

    expect(printable).toMatchObject({
      statePath,
      action: "quarantined",
      changed: true,
      issue: "malformed_json"
    });
    expect(printable.before).toBe("8 bytes");
    expect(String(printable.backupPath)).toContain("state.json.backup.repair-malformed-malformed_json");
    expect(String(printable.message)).toContain("Malformed JSON");
    expect(String(printable.quarantinePath)).toContain("state.json.quarantine.repair-");
  });

  it("repair:state quarantines duplicate appended JSON and reports the exact corrupted path", async () => {
    const appData = await createTempDir("repair-state-script-appended");
    const projectDir = path.join(appData, "projects", "script-appended");
    const statePath = path.join(projectDir, "state.json");
    const record = makeAppServiceLoadedProject("script-appended").record;
    await mkdir(projectDir, { recursive: true });
    await writeFile(statePath, `${JSON.stringify(record)}${JSON.stringify(record)}`);

    const repairModule = await import(pathToFileURL(path.resolve("scripts/repair-state.mjs")).href) as {
      loadSanitizer: () => Promise<unknown>;
      repairFile: (targetStatePath: string, sanitizer: unknown) => Promise<unknown>;
      buildPrintableResult: (result: unknown) => Record<string, unknown>;
    };
    const result = await repairModule.repairFile(statePath, await repairModule.loadSanitizer());
    const printable = repairModule.buildPrintableResult(result);

    expect(printable.statePath).toBe(statePath);
    expect(printable.action).toBe("quarantined");
    expect(printable.issue).toBe("duplicate_appended_json");
    expect(String(printable.quarantinePath)).toContain("state.json.quarantine.repair-duplicate-appended-json");
    await expect(readFile(statePath, "utf8")).rejects.toThrow();
  });

  it("repair:state compacts oversized valid state and writes full output sidecars", async () => {
    const appData = await createTempDir("repair-state-script-oversized");
    const projectDir = path.join(appData, "projects", "script-oversized");
    const statePath = path.join(projectDir, "state.json");
    const record = makeAppServiceLoadedProject("script-oversized").record;
    const agent = createAgentSkeleton("coding", "Repair Huge Output", "Prompt", "gpt-5.4");
    const fullOutput = `repair full output ${"z".repeat(1_550_000)}`;
    agent.commandLog = [{
      itemId: "cmd-repair-huge",
      command: "npm test",
      output: fullOutput,
      status: "completed",
      startedAt: "2026-04-07T00:00:00.000Z",
      completedAt: "2026-04-07T00:01:00.000Z",
      exitCode: 0
    }];
    record.agents = [agent];
    await mkdir(projectDir, { recursive: true });
    await writeFile(statePath, JSON.stringify(record));

    const repairModule = await import(pathToFileURL(path.resolve("scripts/repair-state.mjs")).href) as {
      loadSanitizer: () => Promise<unknown>;
      repairFile: (targetStatePath: string, sanitizer: unknown) => Promise<unknown>;
      buildPrintableResult: (result: unknown) => Record<string, unknown>;
    };
    const result = await repairModule.repairFile(statePath, await repairModule.loadSanitizer());
    const printable = repairModule.buildPrintableResult(result);
    const outputSidecar = JSON.parse(await readFile(path.join(projectDir, "agent-outputs", `${agent.id}.json`), "utf8")) as { output: string };

    expect(printable).toMatchObject({
      statePath,
      action: "compacted",
      issue: "oversized_valid_state",
      changed: true,
      sidecarsWritten: 1
    });
    expect(String(printable.backupPath)).toContain("state.json.backup.sanitizer-v");
    expect(outputSidecar.output).toContain(fullOutput);
    expect((await stat(statePath)).size).toBeLessThan(100_000);
  });

  it("stores full agent transcript text in a sidecar and reads it back without truncation", async () => {
    const appData = await createTempDir("agent-transcript-sidecar");
    const storage = new WorkbenchStorage(appData);
    const projectId = "transcript-project";
    const agent = { id: "agent-long-output", name: "Long Output Agent" };
    const fullText = `FULL OUTPUT\n${"line with details\n".repeat(2_500)}`;
    const entry: AgentTranscriptEntry = {
      id: "entry-full-output",
      timestamp: "2026-04-07T00:00:00.000Z",
      kind: "message",
      title: "Final agent output",
      text: fullText
    };

    await storage.appendAgentTranscriptEntry(projectId, agent, entry);
    await storage.saveAgentFullOutput(projectId, agent, fullText);

    const entries = await storage.readAgentTranscript(projectId, agent.id);
    const output = await storage.getAgentFullOutput(projectId, agent.id);
    expect(entries).toHaveLength(1);
    expect(entries?.[0]?.text).toBe(fullText);
    expect(output).toBe(fullText);
  });

  it("compacts oversized valid state while preserving full agent output sidecars", async () => {
    const appData = await createTempDir("oversized-valid-state");
    const storage = new WorkbenchStorage(appData);
    const project = makeAppServiceLoadedProject("oversized-project");
    const agent = createAgentSkeleton("coding", "Huge Output Agent", "Implement with verbose logs.", "gpt-5.4");
    const fullOutput = `full command output\n${"x".repeat(1_650_000)}`;
    agent.status = "completed";
    agent.workflowCycleNumber = 3;
    agent.commandLog = [{
      itemId: "cmd-huge-output",
      command: "npm test -- --verbose",
      output: fullOutput,
      status: "completed",
      startedAt: "2026-04-07T00:00:00.000Z",
      completedAt: "2026-04-07T00:01:00.000Z",
      exitCode: 0
    }];
    agent.events = [{
      id: "event-huge-raw",
      agentId: agent.id,
      timestamp: "2026-04-07T00:01:00.000Z",
      type: "raw",
      status: "info",
      title: "Huge raw transport event",
      detail: "raw detail",
      raw: { payload: "r".repeat(80_000) }
    }];
    project.record.agents = [agent];
    const statePath = path.join(appData, "projects", project.record.id, "state.json");
    await mkdir(path.dirname(statePath), { recursive: true });
    await storage.saveRegistry([project.record.id]);
    await writeFile(statePath, JSON.stringify(project.record));

    const beforeSize = (await stat(statePath)).size;
    const records = await storage.loadAllProjects();
    const issues = storage.consumeLoadIssues();
    const afterSize = (await stat(statePath)).size;
    const sidecarOutput = await storage.getAgentFullOutput(project.record.id, agent.id);

    expect(beforeSize).toBeGreaterThan(1_500_000);
    expect(records).toHaveLength(1);
    expect(afterSize).toBeLessThan(beforeSize / 5);
    expect(issues.some((issue) => issue.action === "warning" && issue.statePath === statePath)).toBe(true);
    expect(issues.some((issue) => issue.action === "compacted" && issue.statePath === statePath)).toBe(true);
    expect(records[0]?.agents[0]?.commandLog[0]?.output.length ?? 0).toBeLessThan(2_200);
    expect(records[0]?.agents[0]?.events[0]?.raw).not.toEqual({ payload: "r".repeat(80_000) });
    expect(records[0]?.agents[0]?.outputReference?.fullOutputAvailable).toBe(true);
    expect(sidecarOutput).toContain(fullOutput);
  });

  it("adds a safe recovery diagnostic when startup quarantines saved state", async () => {
    const appData = await createTempDir("startup-quarantine-diagnostic");
    const storage = new WorkbenchStorage(appData);
    const record = makeAppServiceLoadedProject("startup-broken").record;
    const statePath = path.join(appData, "projects", record.id, "state.json");
    await mkdir(path.dirname(statePath), { recursive: true });
    await storage.saveRegistry([record.id]);
    await writeFile(statePath, "{ broken");

    const service = new AppService(appData) as unknown as {
      loadStoredProjects: () => Promise<void>;
      getRendererState: () => { diagnostics: string[]; projects: unknown[] };
    };

    await service.loadStoredProjects();
    const state = service.getRendererState();

    expect(state.projects).toHaveLength(0);
    expect(state.diagnostics.some((entry) => entry.includes("saved project state file") && entry.includes("quarantined"))).toBe(true);
    expect(state.diagnostics.some((entry) => entry.includes(statePath))).toBe(true);
  });

  it("caps renderer state payloads and flags omitted nonessential details", async () => {
    const service = new AppService(await createTempDir("renderer-payload-cap")) as unknown as {
      projects: Map<string, ReturnType<typeof makeAppServiceLoadedProject>>;
      activeProjectId?: string;
      getRendererState: () => ReturnType<AppService["getRendererState"]>;
    };
    for (let index = 0; index < 650; index += 1) {
      const project = makeAppServiceLoadedProject(`payload-project-${index}`);
      project.record.workflow.memory.canonicalFacts = Array.from({ length: 24 }, (_, factIndex) => `fact ${index}-${factIndex} ${"x".repeat(120)}`);
      service.projects.set(project.record.id, project);
      if (index === 0) {
        service.activeProjectId = project.record.id;
      }
    }

    const state = service.getRendererState();

    expect(state.rendererPayload?.truncated).toBe(true);
    expect(state.rendererPayload?.sizeBytes ?? 0).toBeLessThanOrEqual(state.rendererPayload?.limitBytes ?? 0);
    expect(state.rendererPayload?.warning).toContain("capped");
    expect(state.projects).toHaveLength(1);
    expect(state.projects[0]?.record.id).toBe(service.activeProjectId);
  });

  it("safe mode skips saved projects and agent resume on startup", async () => {
    const appData = await createTempDir("safe-mode-startup");
    const storage = new WorkbenchStorage(appData);
    const project = makeAppServiceLoadedProject("safe-mode-project");
    const agent = createAgentSkeleton("coding", "Running Agent", "Continue work.", "gpt-5.4");
    agent.status = "running";
    agent.threadId = "thread-safe-mode";
    project.record.agents = [agent];
    const statePath = path.join(appData, "projects", project.record.id, "state.json");
    await mkdir(path.dirname(statePath), { recursive: true });
    await storage.saveRegistry([project.record.id]);
    await writeFile(statePath, JSON.stringify(project.record));

    const service = new AppService(appData);
    await service.initialize({ safeMode: true });
    const state = service.getRendererState();
    const stored = JSON.parse(await readFile(statePath, "utf8")) as { agents: Array<{ status: string }> };

    expect(state.projects).toHaveLength(0);
    expect(state.activeProjectId).toBeUndefined();
    expect(state.codexReadiness.status).toBe("skipped");
    expect(state.codexAvailability.message).toContain("Safe mode");
    expect(stored.agents[0]?.status).toBe("running");
  });

  it("keeps huge live agent messages as previews in main state", () => {
    const agent = createAgentSkeleton("coding", "Huge Message Agent", "Prompt", "gpt-5.4");
    const hugeText = `message ${"m".repeat(120_000)}`;

    reduceAgentRuntimeEvent(agent, {
      kind: "item-completed",
      threadId: "thread-huge-message",
      itemId: "message-huge",
      itemType: "agentMessage",
      title: "Agent message",
      detail: hugeText,
      raw: { text: hugeText }
    });

    expect(agent.lastMessageSnippet?.length ?? 0).toBeLessThanOrEqual(260);
    expect(agent.events[0]?.detail?.length ?? 0).toBeLessThanOrEqual(4_000);
    expect(JSON.stringify(agent.events[0]?.raw).length).toBeLessThan(3_000);
  });

  it("sanitizes huge raw transport event lists in saved state", () => {
    const project = makeAppServiceLoadedProject("huge-raw-events");
    const agent = createAgentSkeleton("coding", "Raw Event Agent", "Prompt", "gpt-5.4");
    agent.events = Array.from({ length: 1_200 }, (_, index) => ({
      id: `raw-${index}`,
      agentId: agent.id,
      timestamp: `2026-04-07T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
      type: "raw" as const,
      status: "info" as const,
      title: `Raw event ${index}`,
      detail: "d".repeat(10_000),
      raw: { payload: "r".repeat(20_000) }
    }));
    project.record.agents = [agent];

    const sanitized = sanitizeProjectRecord(project.record);
    const storedAgent = sanitized.record.agents[0];

    expect(sanitized.report.changed).toBe(true);
    expect(sanitized.report.agentEventsRemoved).toBeGreaterThan(0);
    expect(storedAgent?.events.length).toBeLessThanOrEqual(120);
    expect(storedAgent?.events[0]?.detail?.length ?? 0).toBeLessThanOrEqual(1_250);
    expect(JSON.stringify(storedAgent?.events[0]?.raw).length).toBeLessThan(1_700);
  });

  it("lists workflow cycles as capped summaries and loads older cycle agents/full output on demand", async () => {
    const appData = await createTempDir("history-lazy-service");
    const service = new AppService(appData) as unknown as {
      projects: Map<string, ReturnType<typeof makeAppServiceLoadedProject>>;
      storage: WorkbenchStorage;
      listWorkflowCycles: AppService["listWorkflowCycles"];
      getWorkflowCycle: AppService["getWorkflowCycle"];
      listCycleAgents: AppService["listCycleAgents"];
      getAgentTranscript: AppService["getAgentTranscript"];
      getAgentFullOutput: AppService["getAgentFullOutput"];
    };
    const project = makeAppServiceLoadedProject("history-project");
    project.record.workflow.workflowCycle.cycleNumber = 12;
    project.record.workflow.workflowCycle.status = "coding";
    project.record.workflow.memory.perCycleSummaries = Array.from({ length: 11 }, (_, index) => ({
      cycleNumber: index + 1,
      summary: `Human readable cycle ${index + 1} summary.`,
      openIssueIds: [],
      createdAt: `2026-04-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`
    }));
    const longOutput = `complete sidecar output ${"x".repeat(50_000)}`;
    const longCommandOutput = `command output ${"y".repeat(25_000)}`;
    const cycleEightAgent = {
      ...createAgentSkeleton("coding", "Cycle 8 Coding", "Implement cycle 8.", "gpt-5.4"),
      id: "cycle-8-agent",
      workflowCycleNumber: 8,
      status: "completed" as const,
      startedAt: "2026-04-08T00:00:00.000Z",
      completedAt: "2026-04-08T00:04:00.000Z",
      changedFiles: ["src/cycle-eight.ts"],
      commandLog: [{
        itemId: "cmd-cycle-8",
        command: "npm test -- cycle-eight",
        output: longCommandOutput,
        status: "completed",
        startedAt: "2026-04-08T00:02:00.000Z",
        completedAt: "2026-04-08T00:03:00.000Z",
        exitCode: 0
      }],
      approvals: [{
        id: "approval-cycle-8",
        agentId: "cycle-8-agent",
        kind: "command",
        summary: "Run cycle eight validation",
        reason: "The test command validates this cycle.",
        command: "npm test -- cycle-eight",
        filePaths: [],
        createdAt: "2026-04-08T00:01:30.000Z",
        status: "approved" as const,
        availableDecisions: ["accept", "decline"]
      }],
      events: [{
        id: "failed-event-cycle-8",
        agentId: "cycle-8-agent",
        timestamp: "2026-04-08T00:03:30.000Z",
        type: "item" as const,
        status: "failed" as const,
        title: "Retryable warning",
        detail: "A nonfatal issue was recorded without expanding the full transcript.",
        raw: { payload: "debug".repeat(4_000) }
      }]
    } satisfies AgentState;
    project.record.workflow.goalChecklist.push(makeGoalCheck({
      id: "cycle-eight-check",
      title: "Cycle eight behavior is validated",
      status: "met",
      ownerAgentId: cycleEightAgent.id,
      relatedPaths: ["src/cycle-eight.ts"]
    }));
    project.record.userInputRequests.push({
      id: "input-cycle-8",
      agentId: cycleEightAgent.id,
      requestedByAgentCategory: "coding",
      threadId: "thread-cycle-8",
      serverRequestId: "request-cycle-8",
      title: "Clarify cycle eight scope",
      description: "Operator input was requested during cycle eight.",
      questions: [],
      attachmentInboxPath: "/tmp/inbox",
      attachmentInboxRelativePath: ".agent-workbench/user-input/input-cycle-8",
      attachments: [],
      status: "submitted",
      createdAt: "2026-04-08T00:01:00.000Z",
      submittedAt: "2026-04-08T00:01:10.000Z"
    });
    project.record.agents = [
      cycleEightAgent,
      {
        ...createAgentSkeleton("coding", "Cycle 12 Coding", "Implement current cycle.", "gpt-5.4"),
        id: "cycle-12-agent",
        workflowCycleNumber: 12,
        status: "running" as const,
        startedAt: "2026-04-12T00:00:00.000Z",
        changedFiles: [],
        commandLog: []
      },
      {
        ...createAgentSkeleton("integrity", "Cycle 11 Integrity", "Validate cycle 11.", "gpt-5.4"),
        id: "cycle-11-agent",
        workflowCycleNumber: 11,
        status: "completed" as const,
        startedAt: "2026-04-11T00:00:00.000Z",
        completedAt: "2026-04-11T00:03:00.000Z",
        changedFiles: ["src/cycle-eleven.ts"],
        commandLog: []
      }
    ];
    project.record.workflow.plannerDecisions = [{
      id: "planner-cycle-8",
      planId: "plan-cycle-8",
      cycleNumber: 8,
      selectedTaskId: "candidate-cycle-8",
      selectedRecommendationId: "recommendation-cycle-8",
      selectedTaskTitle: "Satisfy goal check: Cycle eight behavior is validated",
      whySelected: "Selected because it targeted a required checklist item and had direct validation available.",
      score: 321,
      scoreBreakdown: { checklistImpact: 90 },
      strategySettingsUsed: ["Goal restrictiveness 80", "medium batching", "high validation strictness"],
      targetedChecklistIds: ["cycle-eight-check"],
      expectedFiles: ["src/cycle-eight.ts"],
      expectedValidationCommands: ["npm test -- cycle-eight"],
      approvalRequired: false,
      goalChangeProposalIds: [],
      checklistChangeIds: ["check-change-cycle-8"],
      visualDesignImpact: false,
      createdAt: "2026-04-08T00:00:30.000Z"
    }];
    project.record.workflow.checklistChanges = [{
      id: "check-change-cycle-8",
      action: "mark_complete",
      checklistItemIds: ["cycle-eight-check"],
      title: "Cycle eight behavior is validated",
      rationale: "Cycle eight completed with linked validation evidence.",
      sourceCycle: 8,
      sourceAgent: cycleEightAgent.id,
      userApprovalStatus: "not_required",
      confidence: 0.9,
      risk: "low",
      affectedGoalArea: "Workflow history",
      linkedEvidence: ["npm test -- cycle-eight passed"],
      linkedChangedFiles: ["src/cycle-eight.ts"],
      linkedValidationCommands: ["npm test -- cycle-eight"],
      linkedCycleIds: [8],
      linkedAgentIds: [cycleEightAgent.id],
      createdAt: "2026-04-08T00:04:00.000Z"
    }];
    project.record.workflow.cycleRetrospectives = [{
      id: "retro-cycle-8",
      cycleNumber: 8,
      createdAt: "2026-04-08T00:04:00.000Z",
      triedToDo: "Satisfy goal check: Cycle eight behavior is validated",
      whyChosen: "Selected because the planner targeted a required checklist item.",
      changedFiles: ["src/cycle-eight.ts"],
      commandsRun: ["npm test -- cycle-eight"],
      passed: ["npm test -- cycle-eight"],
      failed: [],
      learned: ["Cycle eight validation is observable."],
      checklistItemsAdvanced: ["met: Cycle eight behavior is validated"],
      goalChecklistChangeRecommendation: "Checklist evidence was linked to the completed cycle.",
      nextRecommendedTasks: ["Satisfy next checklist item"],
      shouldContinue: true
    }];
    service.projects.set(project.record.id, project);
    await service.storage.appendAgentTranscriptEntry(project.record.id, cycleEightAgent, {
      id: "cycle-8-sidecar",
      timestamp: "2026-04-08T00:04:00.000Z",
      kind: "message",
      title: "Full final output",
      text: longOutput
    });

    const firstPage = service.listWorkflowCycles(project.record.id, { limit: 5 });
    const secondPage = service.listWorkflowCycles(project.record.id, { cursor: firstPage.nextCursor, limit: 5 });
    const cycleEightDetail = service.getWorkflowCycle(project.record.id, "8");
    const cycleEightAgents = service.listCycleAgents(project.record.id, "8");
    const fullOutput = await service.getAgentFullOutput(project.record.id, cycleEightAgent.id);
    const transcript = await service.getAgentTranscript(project.record.id, cycleEightAgent.id);

    expect(firstPage.cycles.map((cycle) => cycle.cycleNumber)).toEqual([12, 11, 10, 9, 8]);
    expect(firstPage.recentPreloaded).toBe(5);
    expect(firstPage.nextCursor).toBe("5");
    expect(JSON.stringify(firstPage)).not.toContain(longOutput);
    expect(JSON.stringify(firstPage)).not.toContain(longCommandOutput);
    expect(secondPage.cycles.map((cycle) => cycle.cycleNumber)).toEqual([7, 6, 5, 4, 3]);
    expect(firstPage.cycles.some((cycle) => cycle.cycleNumber === 7)).toBe(false);
    const cycleEightSummary = firstPage.cycles.find((cycle) => cycle.cycleNumber === 8);
    expect(cycleEightSummary?.commandsRun).toEqual(["npm test -- cycle-eight"]);
    expect(cycleEightSummary?.approvalSummaries[0]).toContain("Run cycle eight validation");
    expect(cycleEightSummary?.errorSummaries[0]).toContain("Retryable warning");
    expect(cycleEightSummary?.userInputRequestSummaries[0]).toContain("Clarify cycle eight scope");
    expect(cycleEightSummary?.checklistTargets[0]).toContain("Cycle eight behavior is validated");
    expect(cycleEightSummary?.selectionReason).toContain("targeted a required checklist item");
    expect(cycleEightSummary?.strategySettingsUsed).toContain("Goal restrictiveness 80");
    expect(cycleEightSummary?.checklistChanges[0]).toContain("mark complete");
    expect(cycleEightSummary?.retrospective).toContain("Tried: Satisfy goal check");
    expect(cycleEightSummary?.validationOutcome).toContain("no final validation ledger");
    expect(cycleEightDetail).not.toHaveProperty("agents");
    expect(cycleEightDetail.plannerDecision?.selectedRecommendationId).toBe("recommendation-cycle-8");
    expect(cycleEightDetail.retrospectiveRecord?.commandsRun).toContain("npm test -- cycle-eight");
    expect(cycleEightDetail.checklistChangeRecords[0]?.rationale).toContain("linked validation evidence");
    expect(cycleEightAgents.total).toBe(1);
    expect(cycleEightAgents.agents[0]?.changedFiles).toEqual(["src/cycle-eight.ts"]);
    expect(cycleEightAgents.agents[0]?.commands).toEqual(["npm test -- cycle-eight"]);
    expect(cycleEightAgents.agents[0]?.approvalSummaries[0]).toContain("Run cycle eight validation");
    expect(cycleEightAgents.agents[0]?.errorSummaries[0]).toContain("Retryable warning");
    expect(cycleEightAgents.agents[0]?.transcriptAvailable).toBe(true);
    expect(JSON.stringify(cycleEightAgents)).not.toContain(longOutput);
    expect(JSON.stringify(cycleEightAgents)).not.toContain(longCommandOutput);
    expect(fullOutput.fromSidecar).toBe(true);
    expect(fullOutput.output).toContain(longOutput);
    expect(fullOutput.output.length).toBeGreaterThan(50_000);
    expect(transcript.entries[0]?.text).toBe(longOutput);
  });

  it("keeps history selected/completed task separate from the next recommendation", async () => {
    const appData = await createTempDir("history-task-separation");
    const service = new AppService(appData) as unknown as {
      projects: Map<string, ReturnType<typeof makeAppServiceLoadedProject>>;
      listWorkflowCycles: AppService["listWorkflowCycles"];
    };
    const project = makeAppServiceLoadedProject("history-separation-project");
    project.record.workflow.workflowCycle.cycleNumber = 23;
    project.record.workflow.workflowCycle.status = "recommendation_approved";
    project.record.workflow.cycleRetrospectives = [
      {
        id: "retro-21",
        cycleNumber: 21,
        createdAt: "2026-06-21T00:00:00.000Z",
        triedToDo: "Satisfy work package: source provenance and access policy",
        whyChosen: "Selected because source provenance checks were unknown.",
        changedFiles: ["src/aw_trends/ranking.py"],
        commandsRun: ["python3 -m unittest discover -s tests -q"],
        passed: ["python3 -m unittest discover -s tests -q"],
        failed: [],
        learned: ["Source provenance evidence still needed reconciliation."],
        checklistItemsAdvanced: [],
        goalChecklistChangeRecommendation: "No targeted checklist delta.",
        nextRecommendedTasks: ["Satisfy work package: core portfolio analytics"],
        shouldContinue: true
      },
      {
        id: "retro-22",
        cycleNumber: 22,
        createdAt: "2026-06-22T00:00:00.000Z",
        triedToDo: "Satisfy work package: core portfolio analytics",
        whyChosen: "Selected because portfolio analytics had a validation path.",
        changedFiles: ["src/aw_trends/app.py"],
        commandsRun: ["python3 -m unittest discover -s tests -q"],
        passed: ["python3 -m unittest discover -s tests -q"],
        failed: [],
        learned: ["Portfolio analytics was implemented."],
        checklistItemsAdvanced: ["met: Portfolio analytics"],
        goalChecklistChangeRecommendation: "Portfolio analytics advanced.",
        nextRecommendedTasks: ["Satisfy work package: source provenance and access policy"],
        shouldContinue: true
      }
    ];
    service.projects.set(project.record.id, project);

    const history = service.listWorkflowCycles(project.record.id, { limit: 5 });
    const cycle21 = history.cycles.find((cycle) => cycle.cycleNumber === 21);
    const cycle22 = history.cycles.find((cycle) => cycle.cycleNumber === 22);

    expect(cycle21?.selectedTask).toBe("Satisfy work package: source provenance and access policy");
    expect(cycle21?.nextStepRecommendation).toBe("Satisfy work package: core portfolio analytics");
    expect(cycle21?.selectedTask).not.toBe(cycle21?.nextStepRecommendation);
    expect(cycle22?.selectedTask).toBe("Satisfy work package: core portfolio analytics");
    expect(cycle22?.nextStepRecommendation).toBe("Satisfy work package: source provenance and access policy");
    expect(cycle22?.selectedTask).not.toBe(cycle22?.nextStepRecommendation);
  });

  it("keeps history viewer controls explicit and raw details collapsed by default", async () => {
    const source = await readFile(path.join(process.cwd(), "src/renderer/App.tsx"), "utf8");

    expect(source).toContain("Copy output");
    expect(source).toContain("Search within output");
    expect(source).toContain("Wrap text");
    expect(source).toContain("Preformatted");
    expect(source).toContain("Plain text");
    expect(source).toContain("Open transcript");
    expect(source).toContain("<summary>Technical details</summary>");
    expect(source).toContain("technicalDetailsOpen && viewer?.transcript");
    expect(source).toContain("transcriptEntries.slice(0, 220)");
    expect(source).toContain("Show all transcript events");
    expect(source).not.toContain("Promise.all([\n      window.workbench.getAgentFullOutput");
  });

  it("keeps Mission Control labels and full-output actions visible", async () => {
    const appSource = await readFile(path.join(process.cwd(), "src/renderer/App.tsx"), "utf8");
    const commandCenterSource = await readFile(path.join(process.cwd(), "src/renderer/components/CommandCenter.tsx"), "utf8");

    expect(appSource).toContain("<CommandCenter");
    expect(appSource).toContain("whyThisMatters={commandCenterWhy}");
    expect(appSource).toContain("health={commandCenterHealth}");
    expect(appSource).toContain("onOpenOutput={(agent) => openAgentOutputById(agent)}");
    expect(appSource).toContain("<button className=\"primary-button\" type=\"button\" onClick={() => onOpenOutput(agent)}>View full output</button>");
    expect(commandCenterSource).toContain("Mission control");
    expect(commandCenterSource).toContain("Ultimate goal");
    expect(commandCenterSource).toContain("Live execution map");
    expect(commandCenterSource).toContain("Causal timeline");
    expect(commandCenterSource).toContain("Needs you");
    expect(commandCenterSource).toContain("Latest result");
    expect(commandCenterSource).toContain("Planned handoff");
    expect(commandCenterSource).toContain("Progress, changes, and project health");
  });

  it("keeps key design tokens above readable contrast thresholds", async () => {
    const styles = await readFile(path.join(process.cwd(), "src/renderer/styles.css"), "utf8");

    expect(styles).toContain("--surfaceElevated");
    expect(styles).toContain("--textPrimary");
    expect(styles).toContain("--textMuted");
    expect(styles).toContain("--focusRing");
    expect(contrastRatio(cssVariable(styles, "--textPrimary"), cssVariable(styles, "--ivory-50"))).toBeGreaterThanOrEqual(12);
    expect(contrastRatio(cssVariable(styles, "--textMuted"), cssVariable(styles, "--ivory-50"))).toBeGreaterThanOrEqual(6);
    expect(contrastRatio(cssVariable(styles, "--onNavy"), cssVariable(styles, "--navy-970"))).toBeGreaterThanOrEqual(13);
    expect(contrastRatio(cssVariable(styles, "--onNavyMuted"), cssVariable(styles, "--navy-970"))).toBeGreaterThanOrEqual(10);
  });

  it("keeps transcript and History surfaces spacious in the visual polish layer", async () => {
    const styles = await readFile(path.join(process.cwd(), "src/renderer/styles.css"), "utf8");
    const polishSection = styles.slice(styles.indexOf("/* Visual polish pass"));

    expect(polishSection).toContain("min-height: min(62vh, 640px)");
    expect(polishSection).toContain("max-height: min(58vh, 680px)");
    expect(polishSection).toContain("grid-template-columns: minmax(0, 1fr) minmax(min(460px, 100%), 0.44fr)");
    expect(polishSection).toContain("max-width: 88ch");
    expect(polishSection).toContain("background: var(--codeSurface)");
  });

  it("uses visible focus and non-color-only state indicators in key renderer styles", async () => {
    const styles = await readFile(path.join(process.cwd(), "src/renderer/styles.css"), "utf8");
    const polishSection = styles.slice(styles.indexOf("/* Visual polish pass"));

    expect(polishSection).toContain("button:focus-visible");
    expect(polishSection).toContain(".status-chip::before");
    expect(polishSection).toContain(".badge-exact::before");
    expect(polishSection).toContain(".badge-stale::before");
    expect(polishSection).toContain(".badge-incompatible::before");
    expect(polishSection).toContain(".badge-unvalidated::before");
  });

  it("keeps Goal Charter visual preferences in scoped goal prompt context", async () => {
    const source = await readFile(path.join(process.cwd(), "src/runtime/appService.ts"), "utf8");

    expect(source).toContain("buildVisualPreferenceBrief(currentStrategy)");
    expect(source).toContain("Goal Charter / Autopilot Strategy visual preferences");
    expect(source).toContain("comfortable card/table/transcript readability");
  });

  it("reports repository scan truncation and skipped counts without expanding the full tree", async () => {
    const service = new AppService(await createTempDir("repository-scan-status")) as unknown as {
      projects: Map<string, ReturnType<typeof makeAppServiceLoadedProject>>;
      getRepositoryScanStatus: AppService["getRepositoryScanStatus"];
    };
    const project = makeAppServiceLoadedProject("repo-scan-project");
    const stats: ProjectStats = {
      projectRoot: "/repo",
      kind: "git",
      createdAt: "2026-04-07T00:00:00.000Z",
      totalFiles: 1_250,
      totalFolders: 120,
      totalSizeBytes: 8_000_000,
      includedFiles: 500,
      includedFolders: 80,
      includedSizeBytes: 2_000_000,
      excludedFiles: 700,
      excludedFolders: 40,
      excludedSizeBytes: 6_000_000,
      excludedPaths: [{
        path: "node_modules",
        kind: "directory",
        rule: "default",
        fileCount: 700,
        totalSizeBytes: 6_000_000
      }],
      fileTypeBreakdown: { ".ts": 300 },
      languageBreakdown: { TypeScript: 300 },
      entryPoints: ["src/index.ts"],
      manifestFiles: ["package.json"],
      testsPresent: true,
      primaryManagers: ["npm"],
      explanation: "Repository scan was bounded.",
      truncated: true,
      truncationReason: "included_file_limit",
      truncationReasons: ["included_file_limit"],
      includedFileLimit: 500,
      includedDirectoryLimit: 80,
      maxDepth: 12,
      maxScanDurationMs: 1_500,
      maxManifestFileSizeBytes: 256_000,
      excludedPathLimit: 25,
      omittedFilesEstimate: 50,
      omittedDirectoriesEstimate: 5,
      skippedManifestFiles: 2
    };
    project.record.stats = stats;
    project.scan = { ...project.scan, files: [] };
    service.projects.set(project.record.id, project);

    const status = service.getRepositoryScanStatus(project.record.id);

    expect(status.status).toBe("truncated");
    expect(status.truncated).toBe(true);
    expect(status.filesIndexed).toBe(500);
    expect(status.skippedCount).toBeGreaterThanOrEqual(742);
    expect(status.skippedReasons.map((entry) => entry.reason)).toContain("Oversized manifest skipped");
    expect(status.limits.includedFileLimit).toBe(500);
    expect(status.excludedPaths[0]?.path).toBe("node_modules");
  });

  it("reports partial repository scans when exclusions exist without truncation", async () => {
    const service = new AppService(await createTempDir("repository-partial-status")) as unknown as {
      projects: Map<string, ReturnType<typeof makeAppServiceLoadedProject>>;
      getRepositoryScanStatus: AppService["getRepositoryScanStatus"];
    };
    const project = makeAppServiceLoadedProject("repo-partial-project");
    project.record.stats = {
      ...(project.record.stats ?? project.scan.stats),
      totalFiles: 12,
      totalFolders: 5,
      totalSizeBytes: 50_000,
      includedFiles: 10,
      includedFolders: 4,
      includedSizeBytes: 42_000,
      excludedFiles: 2,
      excludedFolders: 1,
      excludedSizeBytes: 8_000,
      excludedPaths: [{
        path: ".git",
        kind: "directory",
        rule: "default",
        fileCount: 2,
        totalSizeBytes: 8_000
      }],
      truncated: false,
      truncationReason: undefined,
      truncationReasons: []
    };
    service.projects.set(project.record.id, project);

    const status = service.getRepositoryScanStatus(project.record.id);

    expect(status.status).toBe("partially_indexed");
    expect(status.truncated).toBe(false);
    expect(status.excludedFiles).toBe(2);
    expect(status.excludedFolders).toBe(1);
    expect(status.searchScope).toBe("indexed_files");
  });

  it("caps repository search results and reports search scope", async () => {
    const service = new AppService(await createTempDir("repository-search-cap")) as unknown as {
      projects: Map<string, ReturnType<typeof makeAppServiceLoadedProject>>;
      searchRepositoryFiles: AppService["searchRepositoryFiles"];
    };
    const project = makeAppServiceLoadedProject("repo-search-project");
    const files = Array.from({ length: 12 }, (_, index) => ({
      absolutePath: `/repo/src/match-${index}.ts`,
      relativePath: `src/match-${index}.ts`,
      size: 100 + index,
      language: "TypeScript"
    }));
    project.scan = {
      ...project.scan,
      files,
      stats: {
        ...project.scan.stats,
        scanMode: "deep",
        totalFiles: files.length,
        includedFiles: files.length,
        includedSizeBytes: files.reduce((sum, file) => sum + file.size, 0)
      }
    };
    project.record.stats = project.scan.stats;
    service.projects.set(project.record.id, project);

    const results = await service.searchRepositoryFiles(project.record.id, "match", { limit: 5 });

    expect(results.results).toHaveLength(5);
    expect(results.total).toBe(12);
    expect(results.truncated).toBe(true);
    expect(results.resultCap).toBe(5);
    expect(results.searchScope).toBe("full_deep_index");
  });

  it("keeps repository summary and tree children paged instead of sending the full tree", async () => {
    const service = new AppService(await createTempDir("repository-lazy-summary")) as unknown as {
      projects: Map<string, ReturnType<typeof makeAppServiceLoadedProject>>;
      getRepositorySummary: AppService["getRepositorySummary"];
      listRepositoryChildren: AppService["listRepositoryChildren"];
      listExcludedPaths: AppService["listExcludedPaths"];
    };
    const project = makeAppServiceLoadedProject("repo-lazy-project");
    project.scan = {
      ...project.scan,
      files: Array.from({ length: 20 }, (_, index) => ({
        absolutePath: `/repo/src/file-${index}.ts`,
        relativePath: `src/file-${index}.ts`,
        size: 20,
        language: "TypeScript"
      })),
      stats: {
        ...project.scan.stats,
        totalFiles: 22,
        includedFiles: 20,
        excludedFiles: 2,
        excludedPaths: [
          { path: "node_modules", kind: "directory", rule: "default", fileCount: 2, totalSizeBytes: 1_000 },
          { path: ".agent-workbench", kind: "directory", rule: "default", fileCount: 0, totalSizeBytes: 0 }
        ]
      }
    };
    project.record.stats = project.scan.stats;
    project.tree = [{
      path: "massive",
      name: "massive",
      type: "directory",
      children: [{ path: "massive/private.ts", name: "private.ts", type: "file", size: 99, language: "TypeScript" }]
    }];
    service.projects.set(project.record.id, project);

    const summary = await service.getRepositorySummary(project.record.id);
    const rootPage = await service.listRepositoryChildren(project.record.id, "", { limit: 1 });
    const excluded = service.listExcludedPaths(project.record.id, { limit: 1 });

    expect("tree" in summary).toBe(false);
    expect(JSON.stringify(summary)).not.toContain("massive/private.ts");
    expect(rootPage.children).toHaveLength(1);
    expect(rootPage.children[0]?.path).toBe("src");
    expect(rootPage.children[0]).not.toHaveProperty("children");
    expect(excluded.paths).toHaveLength(1);
    expect(excluded.total).toBe(2);
    expect(excluded.truncated).toBe(true);
  });

  it("uses larger paged repository tree batches for broad indexes", async () => {
    const service = new AppService(await createTempDir("repository-large-page")) as unknown as {
      projects: Map<string, ReturnType<typeof makeAppServiceLoadedProject>>;
      getRepositorySummary: AppService["getRepositorySummary"];
      listRepositoryChildren: AppService["listRepositoryChildren"];
    };
    const project = makeAppServiceLoadedProject("repo-large-page-project");
    const files = Array.from({ length: 5_200 }, (_, index) => ({
      absolutePath: `/repo/file-${index}.ts`,
      relativePath: `file-${index}.ts`,
      size: 20,
      language: "TypeScript"
    }));
    project.scan = {
      ...project.scan,
      files,
      stats: {
        ...project.scan.stats,
        totalFiles: files.length,
        includedFiles: files.length,
        includedSizeBytes: files.reduce((sum, file) => sum + file.size, 0),
        excludedFiles: 0,
        excludedFolders: 0,
        excludedPaths: []
      }
    };
    project.record.stats = project.scan.stats;
    service.projects.set(project.record.id, project);

    const summary = await service.getRepositorySummary(project.record.id);
    const nextPage = await service.listRepositoryChildren(project.record.id, "", { cursor: summary.rootChildren.nextCursor });

    expect(summary.rootChildren.children).toHaveLength(5_000);
    expect(summary.rootChildren.total).toBe(5_200);
    expect(summary.rootChildren.nextCursor).toBe("5000");
    expect(nextPage.children).toHaveLength(200);
    expect(nextPage.nextCursor).toBeUndefined();
  });

  it("hydrates repository tree data lazily from the saved sidecar index", async () => {
    const repoRoot = await createTempDir("repository-sidecar-index");
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(path.join(repoRoot, "src/index.ts"), "export const value = 1;\n");
    const service = new AppService(await createTempDir("repository-sidecar-appdata")) as unknown as {
      projects: Map<string, ReturnType<typeof makeAppServiceLoadedProject>>;
      storage: WorkbenchStorage;
      rescanRepository: AppService["rescanRepository"];
      getRepositorySummary: AppService["getRepositorySummary"];
    };
    const project = makeAppServiceLoadedProject("repo-sidecar-project");
    project.record.displayPath = repoRoot;
    project.record.wslPath = repoRoot;
    project.record.projectRoot = repoRoot;
    project.record.hostPath = repoRoot;
    project.record.stats = {
      ...project.scan.stats,
      projectRoot: repoRoot,
      includedFiles: 1,
      totalFiles: 1,
      includedSizeBytes: 24,
      totalSizeBytes: 24
    };
    project.scan = {
      ...project.scan,
      files: [],
      stats: project.record.stats
    };
    let rescanCalled = false;
    service.rescanRepository = async () => {
      rescanCalled = true;
      return {} as Awaited<ReturnType<AppService["rescanRepository"]>>;
    };
    service.projects.set(project.record.id, project);
    await service.storage.saveRepositoryIndex({
      projectId: project.record.id,
      projectRoot: repoRoot,
      treeHash: "tree",
      scanMode: "deep",
      files: [
        { relativePath: "src/index.ts", size: 24, language: "TypeScript" }
      ]
    });

    const summary = await service.getRepositorySummary(project.record.id);

    expect(rescanCalled).toBe(false);
    expect(project.scan.files.map((file) => file.relativePath)).toEqual(["src/index.ts"]);
    expect(project.scan.files[0]?.absolutePath).toBe(path.join(repoRoot, "src", "index.ts"));
    expect(project.scan.stats.scanMode).toBe("deep");
    expect(summary.rootChildren.children.map((entry) => entry.path)).toEqual(["src"]);
  });

  it("creates and caches deterministic summaries for repository folders", async () => {
    const service = new AppService(await createTempDir("repository-folder-summary")) as unknown as {
      projects: Map<string, ReturnType<typeof makeAppServiceLoadedProject>>;
      getFileSummary: AppService["getFileSummary"];
      persistProjectUpdate: (project: ReturnType<typeof makeAppServiceLoadedProject>) => Promise<void>;
    };
    const project = makeAppServiceLoadedProject("repo-folder-summary-project");
    const files = [
      { absolutePath: "/repo/src/runtime/appService.ts", relativePath: "src/runtime/appService.ts", size: 120, language: "TypeScript" },
      { absolutePath: "/repo/src/runtime/fileSummary.ts", relativePath: "src/runtime/fileSummary.ts", size: 80, language: "TypeScript" },
      { absolutePath: "/repo/src/runtime/styles.css", relativePath: "src/runtime/styles.css", size: 40, language: "CSS" }
    ];
    project.scan = {
      ...project.scan,
      files,
      stats: {
        ...project.scan.stats,
        totalFiles: files.length,
        includedFiles: files.length,
        includedSizeBytes: files.reduce((sum, file) => sum + file.size, 0),
        languageBreakdown: { TypeScript: 2, CSS: 1 },
        entryPoints: ["src/runtime/appService.ts"]
      }
    };
    project.record.stats = project.scan.stats;
    service.projects.set(project.record.id, project);
    let saves = 0;
    service.persistProjectUpdate = async (updatedProject) => {
      saves += 1;
      updatedProject.record.summaryCache = updatedProject.summaryCache.list();
    };

    const summary = await service.getFileSummary(project.record.id, "src/runtime");
    const cached = await service.getFileSummary(project.record.id, "src/runtime");

    expect(summary.pathKind).toBe("directory");
    expect(summary.relativePath).toBe("src/runtime");
    expect(summary.summary).toContain("src/runtime contains 3 indexed files");
    expect(summary.keySymbols).toContain("TypeScript (2)");
    expect(summary.relatedFiles).toEqual([
      "src/runtime/appService.ts",
      "src/runtime/fileSummary.ts",
      "src/runtime/styles.css"
    ]);
    expect(cached.contentHash).toBe(summary.contentHash);
    expect(project.record.summaryCache).toHaveLength(1);
    expect(saves).toBe(1);
  });

  it("rescans normally and supports persisted deep scan settings", async () => {
    const repoRoot = await createTempDir("repository-rescan-action");
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(path.join(repoRoot, "package.json"), JSON.stringify({ name: "repository-rescan-action" }));
    for (let index = 0; index < 6; index += 1) {
      await writeFile(path.join(repoRoot, "src", `file-${index}.ts`), `export const value${index} = ${index};\n`);
    }
    const service = new AppService(await createTempDir("repository-rescan-appdata")) as unknown as {
      projects: Map<string, ReturnType<typeof makeAppServiceLoadedProject>>;
      rescanRepository: AppService["rescanRepository"];
      getRepositoryScanStatus: AppService["getRepositoryScanStatus"];
      getRepositoryScanLimits: AppService["getRepositoryScanLimits"];
      updateRepositoryScanSettings: AppService["updateRepositoryScanSettings"];
    };
    const project = makeAppServiceLoadedProject("repo-rescan-project");
    project.record.displayPath = repoRoot;
    project.record.wslPath = repoRoot;
    project.record.projectRoot = repoRoot;
    project.record.hostPath = repoRoot;
    service.projects.set(project.record.id, project);

    await service.rescanRepository(project.record.id, { mode: "normal" });
    const normalStatus = service.getRepositoryScanStatus(project.record.id);
    const defaultLimits = service.getRepositoryScanLimits(project.record.id);
    const deepSettings: RepositoryScanSettings = {
      maxIncludedFiles: 2,
      maxIncludedDirectories: 10,
      maxDepth: 8,
      maxManifestFileSizeBytes: 100_000,
      maxScanDurationMs: 10_000,
      maxExcludedPathRecords: 10
    };
    const limits = await service.updateRepositoryScanSettings(project.record.id, deepSettings);
    await service.rescanRepository(project.record.id, { mode: "deep" });
    const deepStatus = service.getRepositoryScanStatus(project.record.id);

    expect(normalStatus.status).toBe("indexed");
    expect(normalStatus.searchScope).toBe("indexed_files");
    expect(defaultLimits.deepDefaults.maxIncludedFiles).toBe(100_000);
    expect(defaultLimits.hardMaximums.maxIncludedFiles).toBe(100_000);
    expect(limits.effective.maxIncludedFiles).toBe(2);
    expect(service.getRepositoryScanLimits(project.record.id).settings.maxIncludedFiles).toBe(2);
    expect(deepStatus.status).toBe("truncated");
    expect(deepStatus.searchScope).toBe("full_deep_index");
    expect(deepStatus.limitHits.map((hit) => hit.code)).toContain("included_file_limit");
    expect(deepStatus.limits.includedFileLimit).toBe(2);
  });

  it("uses no ignore rules for deep repository rescans", async () => {
    const repoRoot = await createTempDir("repository-deep-rescan-no-ignore");
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await mkdir(path.join(repoRoot, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(repoRoot, ".gitignore"), "ignored.log\n");
    await writeFile(path.join(repoRoot, "package.json"), JSON.stringify({ name: "repository-deep-rescan-no-ignore" }));
    await writeFile(path.join(repoRoot, "src/index.ts"), "export const value = 1;\n");
    await writeFile(path.join(repoRoot, "ignored.log"), "normally ignored\n");
    await writeFile(path.join(repoRoot, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    const service = new AppService(await createTempDir("repository-deep-rescan-no-ignore-appdata")) as unknown as {
      projects: Map<string, ReturnType<typeof makeAppServiceLoadedProject>>;
      rescanRepository: AppService["rescanRepository"];
      getRepositoryScanStatus: AppService["getRepositoryScanStatus"];
    };
    const project = makeAppServiceLoadedProject("repo-deep-no-ignore-project");
    project.record.displayPath = repoRoot;
    project.record.wslPath = repoRoot;
    project.record.projectRoot = repoRoot;
    project.record.hostPath = repoRoot;
    service.projects.set(project.record.id, project);

    await service.rescanRepository(project.record.id, { mode: "normal" });
    const normalStatus = service.getRepositoryScanStatus(project.record.id);
    const normalPaths = project.scan.files.map((file) => file.relativePath);

    await service.rescanRepository(project.record.id, {
      mode: "deep",
      settings: {
        maxIncludedFiles: 100,
        maxIncludedDirectories: 100,
        maxDepth: 20,
        maxManifestFileSizeBytes: 100_000,
        maxScanDurationMs: 10_000,
        maxExcludedPathRecords: 100
      }
    });
    const deepStatus = service.getRepositoryScanStatus(project.record.id);
    const deepPaths = project.scan.files.map((file) => file.relativePath);

    expect(normalStatus.excludedPaths.some((entry) => entry.path === "node_modules")).toBe(true);
    expect(normalStatus.excludedPaths.some((entry) => entry.path === "ignored.log")).toBe(true);
    expect(normalPaths).not.toContain("node_modules/pkg/index.js");
    expect(normalPaths).not.toContain("ignored.log");
    expect(deepStatus.status).toBe("indexed");
    expect(deepStatus.searchScope).toBe("full_deep_index");
    expect(deepStatus.excludedFiles).toBe(0);
    expect(deepStatus.excludedFolders).toBe(0);
    expect(deepStatus.excludedPaths).toHaveLength(0);
    expect(deepPaths).toContain("node_modules/pkg/index.js");
    expect(deepPaths).toContain("ignored.log");
  });

  it("skips Codex readiness and update checks in mock mode", async () => {
    const service = new AppService(await createTempDir("mock-codex-readiness")) as unknown as {
      settings: { mockMode: boolean };
      refreshCodexReadiness: AppService["refreshCodexReadiness"];
      checkCodexUpdate: AppService["checkCodexUpdate"];
    };
    service.settings.mockMode = true;

    const startedAt = performance.now();
    const readiness = await service.refreshCodexReadiness("test mock readiness");
    const update = await service.checkCodexUpdate();

    expect(readiness.status).toBe("skipped");
    expect(readiness.message).toContain("Mock mode");
    expect(readiness.warnings?.[0]).toContain("Mock mode skips");
    expect(update.status).toBe("skipped");
    expect(update.updateAvailable).toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  it("coalesces repeated Codex readiness detection requests", async () => {
    let releaseProbe: (() => void) | undefined;
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const service = new AppService(await createTempDir("codex-readiness-coalescing")) as unknown as {
      refreshCodexReadiness: AppService["refreshCodexReadiness"];
      refreshCodexReadinessInternal: AppService["refreshCodexReadiness"];
    };
    let probes = 0;
    service.refreshCodexReadinessInternal = async () => {
      probes += 1;
      await probeGate;
      return {
        checkedAt: "2026-06-11T00:00:00.000Z",
        executionMode: "local",
        codexBinaryPath: "codex",
        codexCliExists: true,
        codexVersion: "0.128.0",
        updateAvailable: false,
        status: "ready",
        message: "Codex ready."
      };
    };

    const first = service.refreshCodexReadiness("first check");
    const second = service.refreshCodexReadiness("second check");
    await Promise.resolve();
    expect(probes).toBe(1);
    releaseProbe?.();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe(secondResult);
  });

  it("disposes a reusable transport when model discovery fails", async () => {
    const service = new AppService(await createTempDir("runtime-readiness-dispose")) as any;
    let disposeCalls = 0;
    const failedTransport = {
      listModels: async () => {
        throw new Error("model discovery failed");
      },
      dispose: async () => {
        disposeCalls += 1;
      }
    };
    service.transport = failedTransport;
    service.codexAvailability = { source: "live" };

    await service.refreshRuntimeReadiness("failing reusable transport");

    expect(disposeCalls).toBe(1);
    expect(service.transport).toBeUndefined();
    expect(service.codexAvailability).toMatchObject({
      source: "unavailable",
      message: "model discovery failed"
    });
  });

  it("ignores exit events from a superseded transport", async () => {
    const service = new AppService(await createTempDir("stale-transport-exit")) as any;
    const oldTransport = {};
    const replacementTransport = {};
    const project = makeAppServiceLoadedProject("stale-transport-project");
    const agent = createAgentSkeleton("coding", "Live replacement agent", "Keep working", "gpt-test");
    agent.status = "running";
    agent.threadId = "replacement-thread";
    project.record.agents.push(agent);
    service.projects.set(project.record.id, project);
    service.transport = replacementTransport;
    service.codexAvailability = { source: "live" };
    service.threadToAgent.set(agent.threadId, { projectId: project.record.id, agentId: agent.id });

    await service.handleTransportExit(oldTransport);

    expect(service.transport).toBe(replacementTransport);
    expect(service.threadToAgent.get(agent.threadId)).toEqual({ projectId: project.record.id, agentId: agent.id });
    expect(agent.status).toBe("running");
    expect(service.codexAvailability.source).toBe("live");
  });

  it("ignores late requests and notifications emitted by a superseded transport", async () => {
    const service = new AppService(await createTempDir("stale-transport-events")) as any;
    const oldTransport = new EventEmitter() as any;
    const replacementTransport = new EventEmitter() as any;
    let oldResponses = 0;
    let replacementResponses = 0;
    oldTransport.respond = async () => { oldResponses += 1; };
    replacementTransport.respond = async () => { replacementResponses += 1; };
    const project = makeAppServiceLoadedProject("stale-event-project");
    const agent = createAgentSkeleton("coding", "Replacement agent", "Keep working", "gpt-test");
    agent.status = "running";
    agent.threadId = "reused-thread-id";
    project.record.agents.push(agent);
    service.projects.set(project.record.id, project);
    service.threadToAgent.set(agent.threadId, { projectId: project.record.id, agentId: agent.id });
    service.transport = oldTransport;
    service.attachTransportListeners(oldTransport);
    service.transport = replacementTransport;

    oldTransport.emit("notification", {
      method: "item/agentMessage/delta",
      params: {
        threadId: agent.threadId,
        turnId: "old-turn",
        itemId: "old-item",
        delta: "stale output"
      }
    });
    oldTransport.emit("request", {
      method: "item/commandExecution/requestApproval",
      id: "reused-request-id",
      params: {
        threadId: agent.threadId,
        turnId: "old-turn",
        itemId: "old-item",
        command: "npm test",
        cwd: project.record.projectRoot,
        reason: "stale request"
      }
    });
    await Promise.resolve();

    expect(agent.events.some((event) => event.detail?.includes("stale output"))).toBe(false);
    expect(agent.approvals).toHaveLength(0);
    expect(oldResponses).toBe(0);
    expect(replacementResponses).toBe(0);
  });

  it("coalesces duplicate workflow automation schedules for one project", async () => {
    const service = new AppService(await createTempDir("automation-schedule")) as unknown as {
      projects: Map<string, unknown>;
      workflowAutomationTimers: Map<string, unknown>;
      workflowAutomationQueued: Set<string>;
      shouldScheduleWorkflowAutomation: () => boolean;
      runWorkflowAutomation: () => Promise<void>;
      scheduleWorkflowAutomation: (projectId: string, reason?: string) => void;
      cancelScheduledWorkflowAutomation: (projectId: string) => void;
    };
    const project = makeAppServiceLoadedProject("schedule-project");
    service.projects.set(project.record.id, project);
    service.shouldScheduleWorkflowAutomation = () => true;
    let runs = 0;
    service.runWorkflowAutomation = async () => {
      runs += 1;
    };

    service.scheduleWorkflowAutomation(project.record.id, "first click");
    service.scheduleWorkflowAutomation(project.record.id, "second click");

    expect(service.workflowAutomationTimers.size).toBe(1);
    expect(service.workflowAutomationQueued.has(project.record.id)).toBe(true);
    expect(runs).toBe(0);
    service.cancelScheduledWorkflowAutomation(project.record.id);
  });

  it("pauses workflow automation instead of repeating a no-progress action forever", async () => {
    const service = new AppService(await createTempDir("automation-no-progress")) as unknown as {
      pauseWorkflowAutomationForNoProgress: (project: ReturnType<typeof makeAppServiceLoadedProject>, action: ReturnType<typeof getNextWorkflowAutomationAction>) => void;
    };
    const project = makeAppServiceLoadedProject("no-progress-project");

    service.pauseWorkflowAutomationForNoProgress(project, "run_merge");

    expect(project.record.localState.workflowPauseRequested).toBe(true);
    expect(project.record.workflow.autopilotStatus?.pausedReason).toBe("automation_no_progress");
    expect(project.record.workflow.activityLog[0]?.title).toBe("Workflow automation paused to avoid a loop");
  });

  it("applies duplicate recommendation and scoped-goal outputs only once", async () => {
    const service = new AppService(await createTempDir("structured-output")) as unknown as {
      persistProjectUpdate: () => Promise<void>;
      applyRecommendationOutput: (
        project: ReturnType<typeof makeAppServiceLoadedProject>,
        agent: AgentState,
        rawText: string,
        automate?: boolean,
        source?: string
      ) => Promise<boolean>;
      applyScopedGoalOutput: (
        project: ReturnType<typeof makeAppServiceLoadedProject>,
        agent: AgentState,
        approvedRecommendation: ApprovedRecommendation,
        rawText: string,
        automate?: boolean,
        source?: string
      ) => Promise<boolean>;
    };
    const project = makeAppServiceLoadedProject("structured-project");
    const recommendationAgent = createAgentSkeleton("recommendation", "Recommendation", "prompt", "gpt-5.4");
    const goalAgent = createAgentSkeleton("goal", "Goal", "prompt", "gpt-5.4");
    project.record.agents.push(recommendationAgent, goalAgent);
    let saves = 0;
    service.persistProjectUpdate = async () => {
      saves += 1;
    };
    const recommendationOutput = JSON.stringify({
      summary: "A bounded recommendation is ready.",
      ultimateGoalProgress: { percentComplete: 25, rationale: "One required check still needs implementation." },
      ultimateGoalCompletion: { state: "needs_more_work", rationale: "The workflow still needs a coding pass." },
      recommendations: [
        {
          title: "Implement the responsive workflow guard",
          summary: "Add bounded runtime guards around workflow automation.",
          rationale: "It prevents repeated workflow action loops.",
          expectedImpact: "One click cannot freeze the app.",
          priority: "high",
          confidence: 0.9,
          estimatedScope: "small",
          riskLevel: "medium",
          relatedPaths: ["src/runtime/appService.ts"]
        }
      ],
      goalCheckUpdates: []
    });

    await expect(service.applyRecommendationOutput(project, recommendationAgent, recommendationOutput, false, "item/completed")).resolves.toBe(true);
    const recommendationCountAfterFirstApply = project.record.workflow.recommendations.length;
    await expect(service.applyRecommendationOutput(project, recommendationAgent, recommendationOutput, false, "rawResponseItem/completed")).resolves.toBe(true);
    await expect(service.applyRecommendationOutput(project, recommendationAgent, recommendationOutput, false, "thread/read")).resolves.toBe(true);
    expect(recommendationCountAfterFirstApply).toBeGreaterThan(0);
    expect(project.record.workflow.recommendations).toHaveLength(recommendationCountAfterFirstApply);
    expect(recommendationAgent.appliedStructuredOutputs).toHaveLength(1);

    const approved = approveRecommendation(project.record.workflow.recommendations[0]);
    project.record.workflow.approvedRecommendation = approved;
    const scopedGoalOutput = JSON.stringify({
      summary: "Implement workflow automation guards.",
      executionBrief: "Add single-flight scheduling, no-progress detection, and bounded renderer updates.",
      acceptanceCriteria: ["Duplicate workflow commands are coalesced.", "Automation pauses when no progress repeats."],
      constraints: ["Keep typed IPC.", "Do not disable automation."],
      testStrategy: ["Run focused unit tests."]
    });

    await expect(service.applyScopedGoalOutput(project, goalAgent, approved, scopedGoalOutput, false, "item/completed")).resolves.toBe(true);
    await expect(service.applyScopedGoalOutput(project, goalAgent, approved, scopedGoalOutput, false, "rawResponseItem/completed")).resolves.toBe(true);
    await expect(service.applyScopedGoalOutput(project, goalAgent, approved, scopedGoalOutput, false, "thread/read")).resolves.toBe(true);
    expect(project.record.workflow.scopedGoal?.sourceRecommendationId).toBe(approved.recommendationId);
    expect(goalAgent.appliedStructuredOutputs).toHaveLength(1);
    expect(saves).toBe(2);
  });

  it("applies repository path summary outputs once and persists sanitized related files", async () => {
    const service = new AppService(await createTempDir("repository-summary-output")) as unknown as {
      projects: Map<string, ReturnType<typeof makeAppServiceLoadedProject>>;
      applyRepositoryPathSummaryOutput: (
        project: ReturnType<typeof makeAppServiceLoadedProject>,
        agent: AgentState,
        rawText: string,
        source: string
      ) => Promise<void>;
      persistProjectUpdate: (project: ReturnType<typeof makeAppServiceLoadedProject>, options?: unknown) => Promise<void>;
    };
    const project = makeAppServiceLoadedProject("repository-summary-output-project");
    project.scan = {
      ...project.scan,
      files: [
        { absolutePath: "/repo/src/runtime/appService.ts", relativePath: "src/runtime/appService.ts", size: 120, language: "TypeScript" },
        { absolutePath: "/repo/src/runtime/fileSummary.ts", relativePath: "src/runtime/fileSummary.ts", size: 80, language: "TypeScript" },
        { absolutePath: "/repo/src/shared/types.ts", relativePath: "src/shared/types.ts", size: 60, language: "TypeScript" }
      ],
      stats: {
        ...project.scan.stats,
        totalFiles: 3,
        includedFiles: 3,
        includedSizeBytes: 260,
        entryPoints: ["src/runtime/appService.ts"]
      }
    };
    project.record.stats = project.scan.stats;
    service.projects.set(project.record.id, project);
    const agent = createAgentSkeleton("manual", "Repository Summary", "Summarize src/runtime.", "gpt-5.4");
    agent.repositorySummaryTarget = {
      relativePath: "src/runtime",
      pathKind: "directory",
      contentHash: "runtime-hash"
    };
    project.record.agents.push(agent);
    let saves = 0;
    service.persistProjectUpdate = async (updatedProject) => {
      saves += 1;
      updatedProject.record.summaryCache = updatedProject.summaryCache.list();
    };
    const output = [
      "The model wrapped this response in prose.",
      JSON.stringify({
        title: "Runtime services",
        purpose: "Owns privileged project operations and repository-aware workflows.",
        summary: "The runtime folder coordinates repository scanning, summary persistence, and agent lifecycle orchestration.",
        keySymbols: ["AppService", "buildDeterministicDirectorySummary"],
        relatedFiles: ["src/runtime/appService.ts", "src/shared/types.ts", "missing.ts", "../secret.txt"],
        confidence: 1.4
      })
    ].join("\n");

    await service.applyRepositoryPathSummaryOutput(project, agent, output, "item/completed");
    await service.applyRepositoryPathSummaryOutput(project, agent, output, "rawResponseItem/completed");

    const summary = project.summaryCache.get("src/runtime", "runtime-hash");
    expect(summary).toBeTruthy();
    expect(summary?.source).toBe("codex");
    expect(summary?.pathKind).toBe("directory");
    expect(summary?.confidence).toBe(1);
    expect(summary?.relatedFiles).toEqual(["src/runtime/appService.ts", "src/shared/types.ts"]);
    expect(project.record.summaryCache).toHaveLength(1);
    expect(agent.currentPhase).toBe("Repository summary saved");
    expect(agent.appliedStructuredOutputs).toHaveLength(1);
    expect(saves).toBe(1);
  });

  it("skips unchanged project writes and trims renderer snapshots", async () => {
    const service = new AppService(await createTempDir("save-trim")) as unknown as {
      storage: {
        saveProject: () => Promise<void>;
        loadRegistry: () => Promise<string[]>;
        saveRegistry: () => Promise<void>;
      };
      compactProjectRuntimeHistory: () => void;
      recordAgentContextDescriptor: () => void;
      syncWorkflowState: () => void;
      saveProject: (project: ReturnType<typeof makeAppServiceLoadedProject>) => Promise<void>;
      compactRendererProjectRecord: (
        record: ReturnType<typeof makeAppServiceLoadedProject>["record"],
        options?: { inactive?: boolean }
      ) => ReturnType<typeof makeAppServiceLoadedProject>["record"];
    };
    const project = makeAppServiceLoadedProject("save-project");
    const agent = createAgentSkeleton("coding", "Long history", "prompt ".repeat(400), "gpt-5.4");
    agent.events = Array.from({ length: 100 }, (_, index) => ({
      id: `event-${index}`,
      agentId: agent.id,
      timestamp: `2026-04-07T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
      type: "raw" as const,
      title: `Event ${index}`,
      detail: "detail ".repeat(400),
      raw: { output: "raw ".repeat(400) }
    }));
    agent.commandLog = Array.from({ length: 40 }, (_, index) => ({
      itemId: `cmd-${index}`,
      command: `npm test -- --run ${index}`,
      output: "output ".repeat(1_000),
      status: "completed",
      startedAt: `2026-04-07T00:${String(index % 60).padStart(2, "0")}:10.000Z`,
      completedAt: `2026-04-07T00:${String(index % 60).padStart(2, "0")}:20.000Z`,
      exitCode: 0
    }));
    project.record.agents = [agent];
    project.record.workflow.activityLog = Array.from({ length: 120 }, (_, index) => ({
      id: `activity-${index}`,
      timestamp: `2026-04-07T00:${String(index % 60).padStart(2, "0")}:30.000Z`,
      source: "workflow" as const,
      status: "running" as const,
      title: `Activity ${index}`,
      detail: "activity ".repeat(400)
    }));
    let writes = 0;
    service.compactProjectRuntimeHistory = () => undefined;
    service.recordAgentContextDescriptor = () => undefined;
    service.syncWorkflowState = () => undefined;
    service.storage.saveProject = async () => {
      writes += 1;
    };
    service.storage.loadRegistry = async () => [project.record.id];
    service.storage.saveRegistry = async () => undefined;

    await service.saveProject(project);
    await service.saveProject(project);

    expect(writes).toBe(1);
    const activeRecord = service.compactRendererProjectRecord(project.record);
    const inactiveRecord = service.compactRendererProjectRecord(project.record, { inactive: true });
    expect(activeRecord.agents[0]?.events.length).toBeLessThanOrEqual(3);
    expect(activeRecord.agents[0]?.commandLog.length).toBeLessThanOrEqual(3);
    expect(activeRecord.workflow.activityLog.length).toBeLessThanOrEqual(80);
    expect(inactiveRecord.agents).toHaveLength(0);
    expect(inactiveRecord.workflow.activityLog).toHaveLength(0);
  });

  it("coalesces live project saves without repeating workflow sync", async () => {
    const service = new AppService(await createTempDir("save-live-coalesce")) as unknown as {
      storage: {
        saveProject: () => Promise<void>;
        loadRegistry: () => Promise<string[]>;
        saveRegistry: () => Promise<void>;
      };
      compactProjectRuntimeHistory: () => void;
      recordAgentContextDescriptor: () => void;
      syncWorkflowState: () => void;
      projectSaveQueued: Map<string, Promise<void>>;
      saveProject: (
        project: ReturnType<typeof makeAppServiceLoadedProject>,
        options?: { force?: boolean; syncWorkflow?: boolean }
      ) => Promise<void>;
    };
    const project = makeAppServiceLoadedProject("live-save-project");
    let writes = 0;
    let syncs = 0;
    let releaseFirstWrite: (() => void) | undefined;
    const firstWriteStarted = new Promise<void>((resolve) => {
      service.storage.saveProject = async () => {
        writes += 1;
        if (writes === 1) {
          resolve();
          await new Promise<void>((release) => {
            releaseFirstWrite = release;
          });
        }
      };
    });
    service.compactProjectRuntimeHistory = () => undefined;
    service.recordAgentContextDescriptor = () => undefined;
    service.syncWorkflowState = () => {
      syncs += 1;
    };
    service.storage.loadRegistry = async () => [project.record.id];
    service.storage.saveRegistry = async () => undefined;

    const firstSave = service.saveProject(project, { syncWorkflow: false });
    await firstWriteStarted;
    project.record.localState.workflowPauseRequested = true;
    const secondSave = service.saveProject(project, { syncWorkflow: false });
    const thirdSave = service.saveProject(project, { syncWorkflow: false });
    await Promise.resolve();

    expect(service.projectSaveQueued.size).toBe(1);
    releaseFirstWrite?.();
    await Promise.all([firstSave, secondSave, thirdSave]);

    expect(writes).toBe(2);
    expect(syncs).toBe(0);
  });

  it("reports runtime readiness as blocked when model discovery is unavailable", async () => {
    const service = new AppService(await createTempDir("readiness-blocked")) as unknown as {
      projects: Map<string, ReturnType<typeof makeAppServiceLoadedProject>>;
      activeProjectId?: string;
      settings: { githubAccount?: { username: string; linkedAt: string } };
      githubStatus: { state: string; username?: string; sshReady: boolean; message: string };
      codexAvailability: { source: "live" | "mock" | "unavailable"; message?: string };
      availableModels: DiscoveredModel[];
      getRendererState: () => { runtimeReadiness: { status: string; blockAgentActions: boolean; summary: string; checks: Array<{ id: string; status: string; message: string; manualCommand?: string }> } };
    };
    const project = makeAppServiceLoadedProject("readiness-project");
    service.projects.set(project.record.id, project);
    service.activeProjectId = project.record.id;
    service.settings.githubAccount = { username: "awb-tests", linkedAt: "2026-04-07T00:00:00.000Z" };
    service.githubStatus = {
      state: "linked",
      username: "awb-tests",
      sshReady: true,
      message: "GitHub account linked."
    };
    service.codexAvailability = {
      source: "unavailable",
      message: "Model discovery is not available."
    };
    service.availableModels = [];

    const report = service.getRendererState().runtimeReadiness;
    const codexCheck = report.checks.find((check) => check.id === "codex-model-discovery");

    expect(report.status).toBe("blocked");
    expect(report.blockAgentActions).toBe(true);
    expect(report.summary).toContain("Codex model discovery");
    expect(codexCheck?.status).toBe("failed");
    expect(codexCheck?.message).toContain("Model discovery is not available");
    expect(codexCheck?.manualCommand).toContain("codex");
  });

  it("does not create fallback recommendations when model discovery is unavailable", async () => {
    const service = new AppService(await createTempDir("recommendation-readiness-blocked")) as unknown as {
      projects: Map<string, ReturnType<typeof makeAppServiceLoadedProject>>;
      activeProjectId?: string;
      settings: { githubAccount?: { username: string; linkedAt: string } };
      githubStatus: { state: string; username?: string; sshReady: boolean; message: string };
      codexAvailability: { source: "live" | "mock" | "unavailable"; message?: string };
      availableModels: DiscoveredModel[];
      refreshRuntimeReadiness: () => Promise<unknown>;
      getRendererState: () => { runtimeReadiness: unknown };
      runRecommendation: (projectId: string, automate?: boolean, customFocus?: string) => Promise<void>;
    };
    const project = makeAppServiceLoadedProject("recommendation-blocked-project");
    service.projects.set(project.record.id, project);
    service.activeProjectId = project.record.id;
    service.settings.githubAccount = { username: "awb-tests", linkedAt: "2026-04-07T00:00:00.000Z" };
    service.githubStatus = {
      state: "linked",
      username: "awb-tests",
      sshReady: true,
      message: "GitHub account linked."
    };
    service.codexAvailability = {
      source: "unavailable",
      message: "Codex app-server and model discovery are unavailable."
    };
    service.availableModels = [];
    service.refreshRuntimeReadiness = async () => service.getRendererState().runtimeReadiness;

    await expect(service.runRecommendation(project.record.id)).rejects.toThrow(/Agent-backed workflow actions are blocked|Codex model discovery/);

    expect(project.record.workflow.recommendations).toHaveLength(0);
    expect(project.record.workflow.activityLog.some((event) => event.title.includes("Recommendation generation started"))).toBe(false);
  });

  it("does not create deterministic scoped goals when model discovery is unavailable", async () => {
    const service = new AppService(await createTempDir("goal-readiness-blocked")) as unknown as {
      projects: Map<string, ReturnType<typeof makeAppServiceLoadedProject>>;
      activeProjectId?: string;
      settings: { githubAccount?: { username: string; linkedAt: string } };
      githubStatus: { state: string; username?: string; sshReady: boolean; message: string };
      codexAvailability: { source: "live" | "mock" | "unavailable"; message?: string };
      availableModels: DiscoveredModel[];
      refreshRuntimeReadiness: () => Promise<unknown>;
      getRendererState: () => { runtimeReadiness: unknown };
      createScopedGoal: (projectId: string, automate?: boolean) => Promise<unknown>;
    };
    const project = makeAppServiceLoadedProject("goal-blocked-project");
    const recommendation = makeRecommendation();
    project.record.workflow.recommendations = [recommendation];
    project.record.workflow.approvedRecommendation = approveRecommendation(recommendation);
    service.projects.set(project.record.id, project);
    service.activeProjectId = project.record.id;
    service.settings.githubAccount = { username: "awb-tests", linkedAt: "2026-04-07T00:00:00.000Z" };
    service.githubStatus = {
      state: "linked",
      username: "awb-tests",
      sshReady: true,
      message: "GitHub account linked."
    };
    service.codexAvailability = {
      source: "unavailable",
      message: "Codex app-server and model discovery are unavailable."
    };
    service.availableModels = [];
    service.refreshRuntimeReadiness = async () => service.getRendererState().runtimeReadiness;

    await expect(service.createScopedGoal(project.record.id)).rejects.toThrow(/Agent-backed workflow actions are blocked|Codex model discovery/);

    expect(project.record.workflow.scopedGoal).toBeUndefined();
    expect(project.record.workflow.activityLog.some((event) => event.title.includes("Deterministic scoped plan selected"))).toBe(false);
  });

  it("does not await slow project saves when advancing workflow from the UI", async () => {
    const service = new AppService(await createTempDir("advance-nonblocking")) as unknown as {
      projects: Map<string, ReturnType<typeof makeAppServiceLoadedProject>>;
      saveProject: () => Promise<void>;
      shouldScheduleWorkflowAutomation: () => boolean;
      scheduleWorkflowAutomation: (projectId: string, reason?: string) => void;
      ensureAgentBackedRuntimeReady: () => Promise<void>;
      advanceWorkflowStage: (projectId: string) => Promise<string>;
      dispose: (options?: { flush?: boolean }) => Promise<void>;
    };
    const project = makeAppServiceLoadedProject("advance-nonblocking-project");
    project.record.workflow.stepProgress.merge.status = "running";
    service.projects.set(project.record.id, project);
    service.shouldScheduleWorkflowAutomation = () => true;
    let automationScheduled = false;
    service.scheduleWorkflowAutomation = () => {
      automationScheduled = true;
    };
    service.ensureAgentBackedRuntimeReady = async () => undefined;
    let saveStarted = false;
    service.saveProject = async () => {
      saveStarted = true;
      await new Promise(() => undefined);
    };

    const startedAt = performance.now();
    await service.advanceWorkflowStage(project.record.id);

    expect(performance.now() - startedAt).toBeLessThan(100);
    expect(project.record.workflow.stepProgress.merge.status).toBe("waiting");
    expect(project.record.workflow.activityLog[0]?.title).toBe("Stale workflow active step requeued");
    expect(automationScheduled).toBe(true);
    expect(saveStarted).toBe(false);
    await service.dispose({ flush: false });
  });

  it("does not await slow project saves when resuming workflow from the UI", async () => {
    const service = new AppService(await createTempDir("resume-nonblocking")) as unknown as {
      projects: Map<string, ReturnType<typeof makeAppServiceLoadedProject>>;
      saveProject: () => Promise<void>;
      shouldScheduleWorkflowAutomation: () => boolean;
      scheduleWorkflowAutomation: (projectId: string, reason?: string) => void;
      updateUiState: (projectId: string, partial: Partial<ReturnType<typeof makeAppServiceLoadedProject>["record"]["localState"]>) => Promise<void>;
      dispose: (options?: { flush?: boolean }) => Promise<void>;
    };
    const project = makeAppServiceLoadedProject("resume-nonblocking-project");
    project.record.localState.workflowPauseRequested = true;
    service.projects.set(project.record.id, project);
    service.shouldScheduleWorkflowAutomation = () => true;
    let automationScheduled = false;
    service.scheduleWorkflowAutomation = () => {
      automationScheduled = true;
    };
    let saveStarted = false;
    service.saveProject = async () => {
      saveStarted = true;
      await new Promise(() => undefined);
    };

    const startedAt = performance.now();
    await service.updateUiState(project.record.id, { workflowPauseRequested: false });

    expect(performance.now() - startedAt).toBeLessThan(100);
    expect(project.record.localState.workflowPauseRequested).toBe(false);
    expect(project.record.workflow.activityLog[0]?.title).toBe("Workflow automation resumed");
    expect(automationScheduled).toBe(true);
    expect(saveStarted).toBe(false);
    await service.dispose({ flush: false });
  });

  it("acknowledges autopilot checkpoints even when the manual pause flag is already clear", async () => {
    const service = new AppService(await createTempDir("resume-autopilot-checkpoint")) as unknown as {
      projects: Map<string, ReturnType<typeof makeAppServiceLoadedProject>>;
      saveProject: () => Promise<void>;
      shouldScheduleWorkflowAutomation: () => boolean;
      scheduleWorkflowAutomation: (projectId: string, reason?: string) => void;
      updateUiState: (projectId: string, partial: Partial<ReturnType<typeof makeAppServiceLoadedProject>["record"]["localState"]>) => Promise<void>;
      dispose: (options?: { flush?: boolean }) => Promise<void>;
    };
    const project = makeAppServiceLoadedProject("resume-autopilot-checkpoint-project");
    project.record.localState.autopilotEnabled = true;
    project.record.localState.workflowPauseRequested = false;
    project.record.workflow.ultimateGoal = {
      ...emptyUltimateGoal("user"),
      summary: "Keep background workflow responsive.",
      confirmedAt: "2026-04-07T00:00:00.000Z"
    };
    project.record.workflow.workflowCycle.status = "completed";
    project.record.workflow.workflowStage = "cycle_complete";
    project.record.workflow.workflowStopReason = "cycle_completed";
    project.record.workflow.autopilotStatus = {
      enabled: true,
      profile: "balanced",
      workflowMode: "normal",
      stage: "cycle_complete",
      cycleNumber: project.record.workflow.workflowCycle.cycleNumber,
      lastCompletedAction: "run_merge",
      nextPlannedAction: "generate_recommendations",
      pausedReason: "repeated_failure",
      pausedDetail: "The same workflow failure repeated in this cycle.",
      highRiskPackageRequiresApproval: false,
      updatedAt: "2026-04-07T00:01:00.000Z"
    };
    service.projects.set(project.record.id, project);
    service.shouldScheduleWorkflowAutomation = () => true;
    let automationScheduled = false;
    service.scheduleWorkflowAutomation = () => {
      automationScheduled = true;
    };
    let saveStarted = false;
    service.saveProject = async () => {
      saveStarted = true;
      await new Promise(() => undefined);
    };

    const startedAt = performance.now();
    await service.updateUiState(project.record.id, { workflowPauseRequested: false });

    expect(performance.now() - startedAt).toBeLessThan(100);
    expect(project.record.workflow.activityLog[0]?.title).toBe("Autopilot checkpoint acknowledged");
    expect(project.record.workflow.autopilotStatus?.pausedReason).toBeUndefined();
    expect(automationScheduled).toBe(true);
    expect(saveStarted).toBe(false);
    await service.dispose({ flush: false });
  });
});

describe("event reducer", () => {
  it("coalesces streaming message chunks into a single readable event", () => {
    const agent: AgentState = createAgentSkeleton("coding", "Agent", "Prompt", "gpt-5.4");
    reduceAgentRuntimeEvent(agent, {
      kind: "agent-message-delta",
      threadId: "thread-1",
      itemId: "item-1",
      delta: "Hello"
    });
    reduceAgentRuntimeEvent(agent, {
      kind: "agent-message-delta",
      threadId: "thread-1",
      itemId: "item-1",
      delta: " world\nNext line"
    });
    reduceAgentRuntimeEvent(agent, {
      kind: "item-completed",
      threadId: "thread-1",
      itemId: "item-1",
      itemType: "agentMessage",
      title: "Agent message",
      detail: "Hello world\nNext line"
    });
    reduceAgentRuntimeEvent(agent, {
      kind: "approval-request",
      approval: {
        id: "approval-1",
        agentId: "agent-1",
        kind: "command",
        summary: "npm test",
        filePaths: [],
        createdAt: "2026-04-07T00:00:00.000Z",
        status: "pending",
        availableDecisions: ["accept", "decline"],
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1"
      }
    });
    const messageEvents = agent.events.filter((event) => event.type === "message");
    expect(agent.lastMessageSnippet).toContain("Next line");
    expect(messageEvents).toHaveLength(1);
    expect(messageEvents[0]?.detail).toBe("Hello world\nNext line");
    expect(messageEvents[0]?.status).toBe("completed");
    expect(agent.approvals).toHaveLength(1);
    expect(agent.status).toBe("waiting_approval");
  });

  it("summarizes structured agent JSON for display", () => {
    const agent: AgentState = createAgentSkeleton("recommendation", "Recommendation", "Prompt", "gpt-5.4");
    reduceAgentRuntimeEvent(agent, {
      kind: "agent-message-delta",
      threadId: "thread-1",
      itemId: "item-1",
      delta: "{\"summary\":"
    });
    expect(agent.lastMessageSnippet).toBe("Receiving structured agent output...");

    reduceAgentRuntimeEvent(agent, {
      kind: "item-completed",
      threadId: "thread-1",
      itemId: "item-1",
      itemType: "agentMessage",
      title: "Agent message",
      detail: JSON.stringify({
        summary: "Pick the next coherent implementation batch.",
        ultimateGoalProgress: { percentComplete: 42, rationale: "Several required checks remain." },
        recommendations: [
          { title: "Build the company guide data model", summary: "Covers company profiles, compensation context, and source notes." }
        ],
        goalCheckUpdates: [
          { title: "Compensation context required", status: "unmet" },
          { title: "Local fixture separation", status: "met" }
        ]
      })
    });

    const event = agent.events.find((entry) => entry.type === "message");
    expect(event?.detail).toContain("Summary: Pick the next coherent implementation batch.");
    expect(event?.detail).toContain("Recommendations:");
    expect(event?.detail).toContain("Checklist updates: 2");
    expect(event?.detail).not.toContain("{\"summary\"");
    expect(agent.lastMessageSnippet).toContain("Summary: Pick the next coherent implementation batch.");
  });

  it("strips terminal control sequences from event display text", () => {
    const agent: AgentState = createAgentSkeleton("coding", "Agent", "Prompt", "gpt-5.4");
    reduceAgentRuntimeEvent(agent, {
      kind: "command-output",
      threadId: "thread-1",
      itemId: "item-1",
      delta: "\u001b[31mfailed\u001b[0m\r\nnext"
    });

    expect(agent.events[0]?.detail).toBe("failed\nnext");
  });

  it("caps bulky raw event payloads before they enter persisted agent state", () => {
    const agent: AgentState = createAgentSkeleton("coding", "Agent", "Prompt", "gpt-5.4");
    reduceAgentRuntimeEvent(agent, {
      kind: "item-completed",
      threadId: "thread-1",
      itemId: "item-1",
      itemType: "agentMessage",
      title: "Agent message",
      detail: "d".repeat(20_000),
      raw: {
        type: "agentMessage",
        text: "x".repeat(20_000),
        nested: {
          output: "y".repeat(20_000)
        }
      }
    });

    const event = agent.events[0];
    const raw = event?.raw as { text?: string; nested?: { output?: string } } | undefined;
    expect(event?.detail?.length).toBeLessThanOrEqual(8_000);
    expect(raw?.text?.length).toBeLessThan(2_100);
    expect(raw?.nested?.output?.length).toBeLessThan(2_100);
    expect(JSON.stringify(event).length).toBeLessThan(13_000);
  });
});
