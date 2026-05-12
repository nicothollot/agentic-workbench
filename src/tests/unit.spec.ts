import { EventEmitter } from "node:events";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
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
import { humanInterventionRecordSchema, portableInterfaceSchema, projectCredentialsStateSchema, projectReviewLogBundleSchema, projectWorkflowStateSchema } from "@shared/schemas";
import { getPreloadEntryPath, getRendererBase, getRendererEntryPath } from "@shared/electronAppPaths";
import { calculateValidationStatus } from "@shared/validation";
import {
  approvalDecisionRequestSchema,
  agentDetailRequestSchema,
  agentListRequestSchema,
  credentialEntrySaveRequestSchema,
  credentialRequestSubmitToAgentSchema,
  credentialRequestUpdateSchema,
  createAgentRequestSchema,
  downloadInterfaceRequestSchema,
  downloadLogsRequestSchema,
  projectLogFeedRequestSchema,
  projectLoadRequestSchema,
  projectOpenRequestSchema,
  refreshOverviewRequestSchema
} from "@shared/ipc";
import { createAgentSkeleton, defaultLayout, defaultLocalState, defaultProjectWorkflowState, defaultWorkflowStepProgressState, emptyUltimateGoal } from "@shared/defaults";
import type { AgentState, ApprovedRecommendation, DiscoveredModel, ProjectOverview, ProjectStats, WorkflowRecommendationOption, WorkflowStage } from "@shared/types";
import {
  createScopedGoalFromRecommendation,
  deriveWorkflowProjection,
  ensureWorkflowStepProgressState,
  getNextWorkflowAutomationAction,
  pickAutopilotRecommendation
} from "@shared/workflow";
import {
  buildWorkflowGoalView,
  buildWorkflowTimelineSteps,
  getWorkflowRecoveryCandidate,
  getWorkflowRepairCounterView,
  workflowActionGuide,
  workflowRunStateLabel,
  workflowSectionProminence,
  workflowStageGuidance,
  workflowStageLabel,
  workflowStatusSummary
} from "@shared/workflowView";
import { reduceAgentRuntimeEvent } from "@runtime/runtimeEvents";
import { buildInterfaceCreationOutputSchema, parseInterfaceCreationOutput } from "@runtime/interfaceCreation";
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
import { assessCodexProtocolCompatibility, compareCodexVersions, parseCodexCliVersion, parseNpmPackageVersion } from "@runtime/codexUpdate";
import { buildProjectShellHandoffPrompt, buildWindowsProjectShellLaunchPlan, openProjectShellWindow } from "@runtime/projectShell";
import { createTempDir, initGitRepo, commitAll } from "./helpers";
import { executionPathToHostPath, resolveProjectPath, windowsPathToWslPath } from "@shared/pathUtils";
import {
  applyGoalChecklistUpdates,
  assessUltimateGoalCompletion,
  buildAppealRecommendations,
  buildChecklistTaskMap,
  buildChecklistTaskMapBrief,
  buildGoalChecklistForAssessment,
  buildGoalChecklistFromUltimateGoal,
  buildOutcomeStrategyBrief,
  buildWorkflowRecommendations,
  estimateUltimateGoalProgress,
  isVisualProject,
  type WorkflowRecommendationContext
} from "@runtime/workflowRecommendations";
import {
  assessIntegrityFailure,
  sanitizeRecommendationForCycle,
  sanitizeScopedGoalForSingleAgent
} from "@runtime/workflowGuardrails";
import { buildRepairStrategyContext } from "@runtime/workflowRepairPlanner";
import {
  createAgentContextDescriptor,
  createWorkflowContextDescriptor,
  formatRelevantContextForPrompt,
  pruneWorkflowContextDescriptors,
  selectRelevantWorkflowContext
} from "@runtime/contextSelector";
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
  parsePackageArgs: (argv: string[]) => { compile: boolean; targets: string[] };
  resolveDownloadsDir: (env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform) => string;
  windowsPathToWslPath: (inputPath: string) => string;
};

const loadPackageAppScript = async (): Promise<PackageAppScript> => {
  const moduleUrl = pathToFileURL(path.resolve("scripts/package-app.mjs")).href;
  return await import(moduleUrl) as PackageAppScript;
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
  relatedPaths: overrides.relatedPaths ?? ["src/index.ts"]
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

describe("packaging script", () => {
  it("converts Windows paths and parses distributable targets", async () => {
    const packageAppScript = await loadPackageAppScript();

    expect(packageAppScript.windowsPathToWslPath("C:\\Users\\nicot\\Downloads")).toBe("/mnt/c/Users/nicot/Downloads");
    expect(packageAppScript.parsePackageArgs(["--win", "--no-compile"])).toEqual({
      compile: false,
      targets: ["win"]
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

  it("builds the Windows portable executable without extra packaging credentials", async () => {
    const packageAppScript = await loadPackageAppScript();
    const args = packageAppScript.buildTargetArgs("win", "/tmp/out");
    const packageJson = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));

    expect(args).toContain("--win");
    expect(args).toContain("portable");
    expect(args).toContain("--config.win.signAndEditExecutable=false");
    expect(packageJson.build.win.signExts).toEqual(["!.exe"]);
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
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "scan-project" }, null, 2));
    await writeFile(path.join(root, "src/index.ts"), "export function hello() { return 'hi'; }\n");
    await writeFile(path.join(root, ".gitignore"), "ignored.log\n");
    await writeFile(path.join(root, "ignored.log"), "do not index\n");
    await writeFile(path.join(root, "node_modules/pkg/index.js"), "module.exports = 1;\n");
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
    expect(scan.stats.excludedFiles).toBeGreaterThanOrEqual(2);
    expect(scan.stats.excludedPaths.some((entry) => entry.path === ".git" && entry.kind === "directory")).toBe(true);
    expect(scan.stats.excludedPaths.some((entry) => entry.path === "node_modules" && entry.rule === "default")).toBe(true);
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
    ...overrides
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
      localStateDefaults: defaultLocalState(),
      dependencies: [],
      summaryCache: [],
      agents: []
    });
    expect(portable.identity.projectName).toBe("repo");
    expect(projectLoadRequestSchema.parse({ inputPath: "/repo" }).inputPath).toBe("/repo");
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
    expect(approvalDecisionRequestSchema.parse({ projectId: "p", agentId: "a", approvalId: "x", decision: "accept" }).decision).toBe("accept");
    expect(downloadInterfaceRequestSchema.parse({ projectId: "p" }).projectId).toBe("p");
    expect(downloadLogsRequestSchema.parse({ projectId: "p" }).projectId).toBe("p");
    expect(refreshOverviewRequestSchema.parse({ projectId: "p" }).projectId).toBe("p");
    expect(agentListRequestSchema.parse({ projectId: "p", scope: "workflow" }).limit).toBe(20);
    expect(agentDetailRequestSchema.parse({ projectId: "p", agentId: "a" }).agentId).toBe("a");
    expect(projectLogFeedRequestSchema.parse({ projectId: "p" }).commandLimit).toBe(50);
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

  it("detects Codex app-server protocol drift before live agents launch", () => {
    expect(assessCodexProtocolCompatibility("0.128.0", "0.128.0")).toMatchObject({
      status: "compatible",
      compatible: true
    });
    expect(assessCodexProtocolCompatibility("0.129.0", "0.128.0")).toMatchObject({
      status: "installed-newer",
      compatible: false
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
      actionLabel: "Confirm Ultimate Goal"
    });
    expect(workflowActionGuide(charterNeeded).description).toContain("detected draft");

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
      actionLabel: "Open Codex terminal"
    });
    expect(workflowRunStateLabel(workflow, "git")).toBe("Waiting on you");
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

    expect(recommendations[0]?.title).toContain("Satisfy goal batch:");
    expect(recommendations[0]?.summary).toContain("related required checks");
    expect(recommendations[0]?.estimatedScope).toBe("medium");
    expect(recommendations.slice(0, 2).every((entry) => /^Satisfy goal (?:batch|check):/.test(entry.title))).toBe(true);
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
      { timestamp: "2026-04-07T00:03:00.000Z" }
    );

    const separationChecks = workflow.goalChecklist.filter((check) =>
      `${check.title} ${check.description}`.toLowerCase().includes("separation")
    );
    expect(separationChecks).toHaveLength(1);
    expect(separationChecks[0]?.status).toBe("met");
    expect(separationChecks[0]?.evidence).toContain("Consolidated");

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

    expect(progress.percentComplete).toBe(100);
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
    expect(recommendations[0]?.title).toMatch(/^Satisfy goal (?:batch|check):/);
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
      "Non-goals:\n- No hidden filesystem access.",
      "Quality Bar: Stable, test-backed behavior.",
      "Target Audience: Developers operating the desktop app."
    ].join("\n\n"), "goal.txt");

    expect(preview.completeness).toBe("complete");
    expect(preview.goal.summary).toBe("Build a durable workflow dashboard.");
    expect(preview.goal.successCriteria).toEqual(["Recommendations are persisted.", "Repair loops are visible."]);
    expect(preview.goal.constraints).toEqual(["Keep typed IPC.", "Keep the renderer sandboxed."]);
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
