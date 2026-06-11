import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppService } from "@runtime/appService";
import { MockCodexTransport } from "@runtime/mockCodexTransport";
import { WorkbenchStorage } from "@runtime/storage";
import {
  applyGoalChecklistUpdates,
  buildGoalChecklistFromUltimateGoal
} from "@runtime/workflowRecommendations";
import type { GoalCheckUpdateInput } from "@runtime/workflowRecommendations";
import { createAgentSkeleton, createLocalProjectRecord } from "@shared/defaults";
import { projectReviewLogBundleSchema } from "@shared/schemas";
import type { AgentState, UltimateGoal } from "@shared/types";
import { nowIso } from "@shared/utils";
import { createTempDir, initGitRepo, commitAll, writeMockSettings } from "./helpers";

const execFileAsync = promisify(execFile);
const createdServices = new Set<AppService>();

const createService = async (appDataDir: string): Promise<AppService> => {
  await writeMockSettings(appDataDir);
  const service = new AppService(appDataDir);
  trackService(service);
  await service.initialize();
  return service;
};

const trackService = (service: AppService): AppService => {
  const dispose = service.dispose.bind(service);
  service.dispose = async () => {
    createdServices.delete(service);
    await dispose();
  };
  createdServices.add(service);
  return service;
};

afterEach(async () => {
  const services = [...createdServices];
  createdServices.clear();
  await Promise.allSettled(services.map((service) => service.dispose({ flush: false })));
});

const createSampleProject = async (
  name: string,
  kind: "git" | "folder" = "git",
  scripts: Record<string, string> = {
    lint: "echo lint",
    typecheck: "echo typecheck",
    test: "echo test",
    build: "echo build"
  }
): Promise<string> => {
  const root = await createTempDir(name);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name,
        scripts
      },
      null,
      2
    )
  );
  await writeFile(path.join(root, "src/index.ts"), "export const value = 1;\n");
  if (kind === "git") {
    await initGitRepo(root);
    await commitAll(root, "initial");
    await execFileAsync("git", ["remote", "add", "origin", `git@github.com:awb-tests/${name}.git`], { cwd: root });
  }
  return root;
};

const createSampleRepo = async (name: string): Promise<string> => await createSampleProject(name, "git");

const createSampleFolder = async (
  name: string,
  scripts?: Record<string, string>
): Promise<string> => await createSampleProject(name, "folder", scripts);

const withFakeGitHubRepoCreationTooling = async <T>(run: () => Promise<T>): Promise<T> => {
  const fakeBin = await createTempDir("fake-github-bin");
  const realGit = (await execFileAsync("which", ["git"])).stdout.trim();
  const gitShimPath = path.join(fakeBin, "git");
  const ghShimPath = path.join(fakeBin, "gh");

  await writeFile(
    gitShimPath,
    `#!/bin/sh
if [ "$1" = "push" ]; then
  exit 0
fi
exec "${realGit}" "$@"
`,
    "utf8"
  );
  await writeFile(
    ghShimPath,
    `#!/bin/sh
if [ "$1" = "repo" ] && [ "$2" = "create" ]; then
  exit 0
fi
echo "unexpected gh invocation: $@" >&2
exit 1
`,
    "utf8"
  );
  await chmod(gitShimPath, 0o755);
  await chmod(ghShimPath, 0o755);

  const previousPath = process.env.PATH ?? "";
  process.env.PATH = `${fakeBin}:${previousPath}`;
  try {
    return await run();
  } finally {
    process.env.PATH = previousPath;
  }
};

const waitFor = async <T>(getValue: () => T | null | undefined | false, timeoutMs = 4_000): Promise<T> => {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    const value = getValue();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for test condition.");
};

const getProjectRecord = (service: AppService, projectId: string) =>
  service.getState().projects.find((entry) => entry.record.id === projectId)?.record;

const isScopedGoalOutputSchema = (value: unknown): boolean => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const properties = (value as { properties?: Record<string, unknown> }).properties;
  return Boolean(properties?.executionBrief && properties?.acceptanceCriteria && properties?.testStrategy);
};

class FailingScopedGoalTransport extends MockCodexTransport {
  async startTurn(params: Parameters<MockCodexTransport["startTurn"]>[0]): ReturnType<MockCodexTransport["startTurn"]> {
    if (isScopedGoalOutputSchema(params.outputSchema)) {
      throw new Error("Array buffer allocation failed");
    }
    return await super.startTurn(params);
  }
}

class CapturingPromptTransport extends MockCodexTransport {
  readonly threadStarts: Array<Parameters<MockCodexTransport["startThread"]>[0]> = [];
  readonly turnStarts: Array<Parameters<MockCodexTransport["startTurn"]>[0]> = [];

  async startThread(params: Parameters<MockCodexTransport["startThread"]>[0]): ReturnType<MockCodexTransport["startThread"]> {
    this.threadStarts.push(params);
    return await super.startThread(params);
  }

  async startTurn(params: Parameters<MockCodexTransport["startTurn"]>[0]): ReturnType<MockCodexTransport["startTurn"]> {
    this.turnStarts.push(params);
    return await super.startTurn(params);
  }
}

describe("integration flows", () => {
  it("does not report an existing interface on a true first open", async () => {
    const root = await createSampleRepo("first-open");
    const appData = await createTempDir("appdata-first-open");
    const service = await createService(appData);
    const loadResult = await service.loadProject(root);

    expect(loadResult.interfaceCandidates).toHaveLength(0);
  });

  it("verifies write access to the opened project folder and cleans up the probe file", async () => {
    const root = await createSampleRepo("write-probe");
    const appData = await createTempDir("appdata-write-probe");
    const service = await createService(appData);
    const loadResult = await service.loadProject(root);

    expect(loadResult.validation.projectAccess?.status).toBe("passed");
    expect(loadResult.validation.projectAccess?.message).toContain(root);
    await expect(access(path.join(root, loadResult.validation.projectAccess?.probeFileName ?? "missing"))).rejects.toThrow();
  });

  it("rejects non-GitHub repositories in open mode", async () => {
    const root = await createTempDir("non-github-open");
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "non-github-open" }, null, 2));
    await writeFile(path.join(root, "src/index.ts"), "export const value = 1;\n");
    await initGitRepo(root);
    await commitAll(root, "initial");

    const appData = await createTempDir("appdata-non-github-open");
    const service = await createService(appData);

    await expect(service.loadProject(root)).rejects.toThrow("GitHub-backed repositories");
  });

  it("initializes a new workspace folder as a GitHub SSH repository in create mode", async () => {
    await withFakeGitHubRepoCreationTooling(async () => {
      const root = await createSampleFolder("new-github-workspace");
      const appData = await createTempDir("appdata-new-github-workspace");
      const service = await createService(appData);

      const loadResult = await service.loadProject(root, "create");
      const remoteUrl = (await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: root })).stdout.trim();
      const branch = (await execFileAsync("git", ["branch", "--show-current"], { cwd: root })).stdout.trim();
      const head = (await execFileAsync("git", ["rev-parse", "--verify", "HEAD"], { cwd: root })).stdout.trim();

      expect(loadResult.validation.projectKind).toBe("git");
      expect(remoteUrl.startsWith("git@github.com:awb-tests/")).toBe(true);
      expect(remoteUrl.endsWith(".git")).toBe(true);
      expect(branch).toBe("main");
      expect(head.length).toBeGreaterThan(0);
    });
  });

  it("keeps create-mode scans and write checks inside the exact selected folder when it sits under another git repo", async () => {
    const parentRoot = await createTempDir("parent-git-root");
    const childRoot = path.join(parentRoot, "nested-workspace");

    await initGitRepo(parentRoot);
    await execFileAsync("git", ["remote", "add", "origin", "git@github.com:awb-tests/parent-git-root.git"], { cwd: parentRoot });
    await writeFile(path.join(parentRoot, "parent-only.txt"), "this file must stay outside the nested workspace boundary\n", "utf8");
    await mkdir(childRoot, { recursive: true });

    const appData = await createTempDir("appdata-nested-create");
    const service = await createService(appData);
    const loadResult = await service.loadProject(childRoot, "create");
    const childGitRoot = (await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: childRoot })).stdout.trim();

    expect(loadResult.projectRoot).toBe(childRoot);
    expect(loadResult.projectHostPath).toBe(childRoot);
    expect(loadResult.stats.projectRoot).toBe(childRoot);
    expect(loadResult.validation.projectAccess?.message).toContain(childRoot);
    expect(path.dirname(loadResult.validation.projectAccess?.hostPath ?? "")).toBe(childRoot);
    expect(loadResult.stats.excludedPaths.some((entry) => entry.path === "parent-only.txt")).toBe(false);
    expect(loadResult.tree.some((entry) => entry.path === "parent-only.txt")).toBe(false);
    expect(childGitRoot).toBe(childRoot);
  });

  it("starts in launcher mode instead of auto-activating a saved project", async () => {
    const root = await createSampleRepo("launcher-start");
    const appData = await createTempDir("appdata-launcher-start");
    const serviceA = await createService(appData);

    await serviceA.loadProject(root);
    const selected = await serviceA.selectPendingInterface("fresh");
    await new Promise((resolve) => setTimeout(resolve, 80));

    const serviceB = await createService(appData);
    const state = serviceB.getState();
    expect(state.projects.some((project) => project.record.id === selected.record.id)).toBe(true);
    expect(state.activeProjectId).toBeUndefined();
  });

  it("defers saved project hydration until after the launcher can render", async () => {
    const root = await createSampleRepo("launcher-deferred-startup");
    const appData = await createTempDir("appdata-launcher-deferred-startup");
    const serviceA = await createService(appData);

    await serviceA.loadProject(root, "create");
    const selected = await serviceA.selectPendingInterface("fresh");
    await new Promise((resolve) => setTimeout(resolve, 80));

    const serviceB = trackService(new AppService(appData));
    await serviceB.initialize({ deferStartupWork: true });

    expect(serviceB.getState().projects.some((project) => project.record.id === selected.record.id)).toBe(false);

    await serviceB.runDeferredStartupWork();

    const state = serviceB.getState();
    expect(state.projects.some((project) => project.record.id === selected.record.id)).toBe(true);
    expect(state.activeProjectId).toBeUndefined();
  });

  it("ignores partial saved records that only contain stats or agents", async () => {
    const root = await createSampleRepo("partial-record");
    const appData = await createTempDir("appdata-partial-record");
    const service = await createService(appData);
    const loadResult = await service.loadProject(root);
    const storage = new WorkbenchStorage(appData);

    const partialRecord = createLocalProjectRecord(
      "partial-record-id",
      loadResult.resolvedPath.displayPath,
      loadResult.resolvedPath.wslPath,
      loadResult.projectRoot,
      loadResult.projectHostPath,
      loadResult.identity,
      loadResult.validation,
      loadResult.resolvedPath.distroName
    );
    partialRecord.stats = loadResult.stats;
    partialRecord.agents.push(createAgentSkeleton("bootstrap", "Bootstrap", "Prompt", "gpt-5.4-mini"));

    await storage.saveProject(partialRecord);
    await storage.saveRegistry([partialRecord.id]);

    const reloaded = await service.loadProject(root);
    expect(reloaded.interfaceCandidates).toHaveLength(0);
  });

  it("detects saved interfaces from local registry and portable files", async () => {
    const root = await createSampleRepo("saved");
    const appData = await createTempDir("appdata-detect");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    await new Promise((resolve) => setTimeout(resolve, 80));
    await service.exportInterface(selected.record.id);

    const reloaded = await service.loadProject(root);
    expect(reloaded.interfaceCandidates.map((candidate) => candidate.source).sort()).toEqual(["local", "portable"]);
  });

  it("reopens a saved project into the active workspace and can return to launcher", async () => {
    const root = await createSampleRepo("reopen-saved");
    const appData = await createTempDir("appdata-reopen-saved");
    const service = await createService(appData);

    await service.loadProject(root, "create");
    const created = await service.selectPendingInterface("fresh");
    await new Promise((resolve) => setTimeout(resolve, 80));

    service.showLauncher();
    expect(service.getState().activeProjectId).toBeUndefined();

    let activeProjectIdDuringOpen: string | undefined;
    service.once("stateChanged", (state) => {
      activeProjectIdDuringOpen = state.activeProjectId;
    });

    const reopened = await service.openProject(created.record.id);
    const state = service.getState();
    const activeProject = state.projects.find((project) => project.record.id === reopened.record.id);

    expect(activeProjectIdDuringOpen).toBe(created.record.id);
    expect(state.activeProjectId).toBe(created.record.id);
    expect(reopened.tree.length).toBeGreaterThan(0);
    expect(activeProject?.record.localState.lastOpenedAt).toBeTruthy();
  });

  it("serves repository data through bounded lazy pages", async () => {
    const root = await createSampleRepo("lazy-repository-api");
    for (let index = 0; index < 45; index += 1) {
      const directory = path.join(root, `module-${String(index).padStart(2, "0")}`);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "index.ts"), `export const module${index} = ${index};\n`);
    }

    const appData = await createTempDir("appdata-lazy-repository-api");
    const service = await createService(appData);
    await service.loadProject(root);
    const selected = await service.selectPendingInterface("fresh");

    const legacyView = service.getRepositoryView(selected.record.id);
    expect(legacyView.tree.length).toBeLessThanOrEqual(32);
    expect(legacyView.treeTruncated).toBe(true);

    const summary = service.getRepositorySummary(selected.record.id);
    expect(summary.rootChildren.total).toBeGreaterThan(32);
    expect(summary.rootChildren.children.some((entry) => entry.path === "src")).toBe(true);

    const firstPage = service.listRepositoryChildren(selected.record.id, "", { limit: 10 });
    expect(firstPage.children).toHaveLength(10);
    expect(firstPage.nextCursor).toBeTruthy();

    const secondPage = service.listRepositoryChildren(selected.record.id, "", { cursor: firstPage.nextCursor, limit: 10 });
    expect(secondPage.children).toHaveLength(10);
    expect(secondPage.children[0]?.path).not.toBe(firstPage.children[0]?.path);

    const moduleChildren = service.listRepositoryChildren(selected.record.id, "module-00", { limit: 10 });
    expect(moduleChildren.children.map((entry) => entry.path)).toContain("module-00/index.ts");

    const search = service.searchRepositoryFiles(selected.record.id, "index.ts", { limit: 5 });
    expect(search.results).toHaveLength(5);
    expect(search.truncated).toBe(true);
    expect(search.total).toBeGreaterThan(5);
  });

  it("exports and imports a portable interface roundtrip", async () => {
    const root = await createSampleRepo("roundtrip");
    const appDataA = await createTempDir("appdata-roundtrip-a");
    const serviceA = await createService(appDataA);
    await serviceA.loadProject(root);
    const selected = await serviceA.selectPendingInterface("fresh");
    await new Promise((resolve) => setTimeout(resolve, 80));
    await serviceA.saveCredentialEntry(selected.record.id, {
      providerName: "Polygon.io",
      keyLabel: "API key",
      apiKey: "polygon-secret",
      notes: "local only"
    });
    const exportPath = await serviceA.exportInterface(selected.record.id);
    const exportedPayload = JSON.parse(await readFile(exportPath, "utf8")) as Record<string, unknown>;
    expect(exportedPayload.credentials).toBeUndefined();
    expect(JSON.stringify(exportedPayload)).not.toContain("polygon-secret");

    const appDataB = await createTempDir("appdata-roundtrip-b");
    const serviceB = await createService(appDataB);
    const imported = await serviceB.importInterface(root, exportPath);
    await new Promise((resolve) => setTimeout(resolve, 80));

    const project = serviceB.getState().projects.find((entry) => entry.record.id === imported.record.id);
    expect(project?.record.overview?.summary.length).toBeGreaterThan(10);
    expect(project?.record.agents.some((agent) => agent.category === "bootstrap")).toBe(true);
    expect(project?.record.credentials.entries).toEqual([]);
  });

  it("downloads a shareable interface file and can import it from outside the project root", async () => {
    const root = await createSampleRepo("shareable-roundtrip");
    const appDataA = await createTempDir("appdata-shareable-roundtrip-a");
    const serviceA = await createService(appDataA);
    await serviceA.loadProject(root);
    const selected = await serviceA.selectPendingInterface("fresh");
    await new Promise((resolve) => setTimeout(resolve, 80));

    const downloadDir = await createTempDir("downloaded-interface");
    const downloadPath = path.join(downloadDir, "shareable-interface.json");
    const exported = await serviceA.downloadInterface(selected.record.id, downloadPath);

    const appDataB = await createTempDir("appdata-shareable-roundtrip-b");
    const serviceB = await createService(appDataB);
    const imported = await serviceB.importInterfaceFromExternalPath(root, exported);
    await new Promise((resolve) => setTimeout(resolve, 80));

    const project = serviceB.getState().projects.find((entry) => entry.record.id === imported.record.id);
    expect(exported).toBe(downloadPath);
    expect(project?.record.overview?.summary.length).toBeGreaterThan(10);
    expect(project?.record.summaryCache.length).toBeGreaterThan(0);
  });

  it("bootstraps a fresh project through the interface-creation agent workflow", async () => {
    const root = await createSampleRepo("bootstrap");
    const appData = await createTempDir("appdata-bootstrap");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");

    await new Promise((resolve) => setTimeout(resolve, 80));

    const project = service.getState().projects.find((entry) => entry.record.id === selected.record.id);
    const bootstrap = project?.record.agents.find((agent) => agent.category === "bootstrap");
    expect(bootstrap?.threadId).toBeTruthy();
    expect(project?.record.interfaceCreation?.status).toBe("completed");
    expect(project?.record.overview?.source).toBe("hybrid");
    expect(project?.record.summaryCache.length).toBeGreaterThan(0);
  });

  it("exposes discovered model metadata and saves workflow agent settings", async () => {
    const appData = await createTempDir("appdata-settings");
    const service = await createService(appData);

    const stateBefore = service.getState();
    expect(stateBefore.availableModels.length).toBeGreaterThan(0);
    expect(stateBefore.availableModels.some((model) => model.recommendedForInterfaceCreation)).toBe(true);

    await service.updateSettings({
      interfaceCreationModel: stateBefore.availableModels[0]?.model,
      interfaceCreationReasoningEffort: "high",
      agentReasoningMode: "manual",
      agentReasoningEfforts: {
        coding: "xhigh",
        merge: "low"
      },
      maxRepairCycles: 4
    });

    const stateAfter = service.getState();
    expect(stateAfter.settings.interfaceCreationReasoningEffort).toBe("high");
    expect(stateAfter.settings.agentReasoningMode).toBe("manual");
    expect(stateAfter.settings.agentReasoningEfforts?.coding).toBe("xhigh");
    expect(stateAfter.settings.agentReasoningEfforts?.merge).toBe("low");
    expect(stateAfter.settings.maxRepairCycles).toBe(4);
    expect(stateAfter.settings.interfaceCreationConfiguredAt).toBeTruthy();
  });

  it("skips bootstrap analysis for a new empty project", async () => {
    const root = await createTempDir("empty-new-project");
    const appData = await createTempDir("appdata-empty-new-project");
    const service = await createService(appData);

    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    await new Promise((resolve) => setTimeout(resolve, 80));

    const project = getProjectRecord(service, selected.record.id);
    expect(project?.overview?.summary).toContain("ready for setup");
    expect(project?.interfaceCreation?.status).toBe("completed");
    expect(project?.interfaceCreation?.phase).toBe("Setup ready");
    expect(project?.agents.some((agent) => agent.category === "bootstrap" && agent.threadId)).toBe(false);
  });

  it("keeps bootstrap analysis skipped when reopening an empty saved project", async () => {
    const root = await createTempDir("empty-reopen-project");
    const appData = await createTempDir("appdata-empty-reopen-project");
    const service = await createService(appData);

    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    await new Promise((resolve) => setTimeout(resolve, 80));

    service.showLauncher();
    await service.openProject(selected.record.id);

    const project = getProjectRecord(service, selected.record.id);
    expect(project?.interfaceCreation?.phase).toBe("Setup ready");
    expect(project?.agents.some((agent) => agent.category === "bootstrap" && agent.threadId)).toBe(false);
  });

  it("syncs the max repair cycle setting into loaded workflow state", async () => {
    const root = await createSampleRepo("settings-repair-sync");
    const appData = await createTempDir("appdata-settings-repair-sync");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");

    await service.updateSettings({
      maxRepairCycles: 2
    });

    const workflow = getProjectRecord(service, selected.record.id)?.workflow;
    expect(workflow?.repair.maxAttempts).toBe(2);
    expect(workflow?.workflowBudgets.maxRepairLoops).toBe(2);
  });

  it("preserves the Original Ultimate Goal while updating the Current Effective Goal separately", async () => {
    const root = await createSampleRepo("goal-charter-original-current");
    const appData = await createTempDir("appdata-goal-charter-original-current");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");

    await service.updateUltimateGoal(selected.record.id, {
      summary: "Build the original product charter.",
      detailedIntent: "Capture the baseline goal.",
      successCriteria: ["Original is visible"],
      constraints: ["Keep IPC typed"],
      nonGoals: ["Do not add planner behavior"],
      targetAudience: "Operators",
      qualityBar: "Clear and test-backed.",
      source: "user"
    });
    await service.updateUltimateGoal(selected.record.id, {
      summary: "Build the evolved effective charter.",
      detailedIntent: "Current goal can evolve after acceptance.",
      successCriteria: ["Current is distinct"],
      constraints: ["Keep IPC typed"],
      nonGoals: ["Do not alter original"],
      targetAudience: "Operators",
      qualityBar: "Clear and test-backed.",
      source: "user"
    });

    const charter = service.getGoalCharter(selected.record.id);
    expect(charter.originalUltimateGoal.summary).toBe("Build the original product charter.");
    expect(charter.currentEffectiveGoal.summary).toBe("Build the evolved effective charter.");
    expect(charter.acceptedGoalChanges[0]?.toGoalSummary).toBe("Build the evolved effective charter.");
  });

  it("persists custom Autopilot Strategy and visual preferences across app restart", async () => {
    const root = await createSampleRepo("goal-charter-strategy-persistence");
    const appData = await createTempDir("appdata-goal-charter-strategy-persistence");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");

    const presets = service.listAutopilotPresets();
    expect(presets.map((preset) => preset.label)).toContain("Balanced Autopilot");
    const strategy = {
      ...service.getAutopilotStrategy(selected.record.id),
      presetId: "custom" as const,
      goalRestrictiveness: 42,
      planningHorizon: "long" as const,
      taskBatchingAggressiveness: "high" as const,
      innovationLatitude: 77,
      riskTolerance: "medium" as const,
      refactorAppetite: "high" as const,
      validationStrictness: "very_high" as const,
      approvalSensitivity: "relaxed" as const,
      visualPreferences: {
        ...service.getAutopilotStrategy(selected.record.id).visualPreferences,
        theme: "custom" as const,
        primaryColor: "#123456",
        accentColor: "#abcdef",
        density: "compact" as const,
        feel: "technical" as const,
        layoutPriority: "data_heavy" as const,
        motionPreference: "polished" as const,
        accessibilityPriority: "keyboard_first" as const,
        designStrictness: "follow_user_exactly" as const
      }
    };

    await service.updateAutopilotStrategy(selected.record.id, strategy);
    await service.updateGoalCharter(selected.record.id, {
      technicalPreferences: ["Prefer generated protocol types"],
      aestheticPreferences: ["Dense command-center UI"]
    });
    expect(service.getAutopilotStrategy(selected.record.id).goalRestrictiveness).toBe(42);

    await service.dispose();
    const restarted = await createService(appData);
    const restored = getProjectRecord(restarted, selected.record.id);
    expect(restored?.workflow.goalCharter.autopilotStrategy.goalRestrictiveness).toBe(42);
    expect(restored?.workflow.goalCharter.autopilotStrategy.visualPreferences.primaryColor).toBe("#123456");
    expect(restored?.workflow.goalCharter.technicalPreferences).toContain("Prefer generated protocol types");
    expect(restored?.workflow.goalCharter.aestheticPreferences).toContain("Dense command-center UI");
  });

  it("auto-detects an Ultimate Goal proposal without starting workflow execution", async () => {
    const root = await createSampleRepo("goal-charter-detect-proposal");
    const appData = await createTempDir("appdata-goal-charter-detect-proposal");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");

    const beforeAgents = getProjectRecord(service, selected.record.id)?.agents.length ?? 0;
    const detected = await service.detectUltimateGoal(selected.record.id);
    const record = getProjectRecord(service, selected.record.id);

    expect(detected.summary).toBeTruthy();
    expect(record?.workflow.goalCharter.proposedGoalChanges[0]?.source).toBe("detected");
    expect(record?.workflow.goalCharter.proposedGoalChanges[0]?.proposedGoal?.summary).toBe(detected.summary);
    expect(record?.workflow.ultimateGoal.confirmedAt).toBeUndefined();
    expect(record?.workflow.recommendations).toHaveLength(0);
    expect(record?.workflow.scopedGoal).toBeUndefined();
    expect(record?.agents.filter((agent) => agent.category === "coding" || agent.category === "recommendation")).toHaveLength(0);
    expect((record?.agents.length ?? 0)).toBeGreaterThanOrEqual(beforeAgents);
  });

  it("applies the configured reasoning effort to interface creation state", async () => {
    const root = await createSampleRepo("reasoning-applied");
    const appData = await createTempDir("appdata-reasoning-applied");
    const service = await createService(appData);
    await service.updateSettings({
      agentReasoningMode: "manual",
      agentReasoningEfforts: {
        bootstrap: "high"
      }
    });

    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    await new Promise((resolve) => setTimeout(resolve, 80));

    const project = service.getState().projects.find((entry) => entry.record.id === selected.record.id);
    expect(project?.record.interfaceCreation?.reasoningEffort).toBe("high");
  });

  it("uses the selected model and reasoning effort for workflow agents", async () => {
    const root = await createSampleRepo("workflow-model-config");
    const appData = await createTempDir("appdata-workflow-model-config");
    const service = await createService(appData);
    await service.updateSettings({
      interfaceCreationModel: "gpt-5.4",
      agentReasoningMode: "manual",
      agentReasoningEfforts: {
        goal: "xhigh"
      }
    });

    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");

    await service.detectUltimateGoal(selected.record.id);
    await waitFor(() => getProjectRecord(service, selected.record.id)?.agents.some((agent) => agent.category === "goal"));

    const goalAgent = getProjectRecord(service, selected.record.id)?.agents.find((agent) => agent.category === "goal");
    expect(goalAgent?.model).toBe("gpt-5.4");
    expect(goalAgent?.reasoningEffort).toBe("xhigh");
    expect(goalAgent?.reasoningEffortSource).toBe("manual");
  });

  it("auto-selects high-depth reasoning for coding agents and low-depth reasoning for simple merge agents", async () => {
    const root = await createSampleRepo("workflow-agent-auto-reasoning");
    const appData = await createTempDir("appdata-workflow-agent-auto-reasoning");
    const service = await createService(appData);

    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");

    const codingAgent = await service.createAgent(selected.record.id, "coding", "Coding Agent", "Implement a small workflow fix.", "gpt-5.4");
    expect(["high", "xhigh"]).toContain(codingAgent.reasoningEffort);
    expect(codingAgent.reasoningEffortSource).toBe("auto");

    await service.runMerge(selected.record.id);
    const mergeAgent = getProjectRecord(service, selected.record.id)?.agents.find((agent) => agent.category === "merge");
    expect(["low", "medium"]).toContain(mergeAgent?.reasoningEffort);
    expect(mergeAgent?.reasoningEffortSource).toBe("auto");
  });

  it("replaces an existing local interface in place instead of silently creating a duplicate", async () => {
    const root = await createSampleRepo("replace-existing");
    const appData = await createTempDir("appdata-replace-existing");
    const service = await createService(appData);

    await service.loadProject(root, "create");
    const first = await service.selectPendingInterface("fresh");
    await new Promise((resolve) => setTimeout(resolve, 80));

    await service.loadProject(root, "create");
    const replaced = await service.selectPendingInterface("fresh", undefined, "replace");
    await new Promise((resolve) => setTimeout(resolve, 80));

    const storage = new WorkbenchStorage(appData);
    const records = await storage.loadAllProjects();
    expect(records).toHaveLength(1);
    expect(replaced.record.id).toBe(first.record.id);
  });

  it("creates a second saved interface only when duplicate is chosen explicitly", async () => {
    const root = await createSampleRepo("duplicate-existing");
    const appData = await createTempDir("appdata-duplicate-existing");
    const service = await createService(appData);

    await service.loadProject(root, "create");
    await service.selectPendingInterface("fresh");
    await new Promise((resolve) => setTimeout(resolve, 80));

    await service.loadProject(root, "create");
    await service.selectPendingInterface("fresh", undefined, "duplicate");
    await new Promise((resolve) => setTimeout(resolve, 80));

    const storage = new WorkbenchStorage(appData);
    const records = await storage.loadAllProjects();
    expect(records).toHaveLength(2);
  });

  it("writes a sanitized review log bundle with workflow and agent history", async () => {
    const root = await createSampleRepo("review-log-export");
    const appData = await createTempDir("appdata-review-log-export");
    const service = await createService(appData);
    const loadResult = await service.loadProject(root, "create");
    const storage = new WorkbenchStorage(appData);

    const record = createLocalProjectRecord(
      "review-log-project",
      loadResult.resolvedPath.displayPath,
      loadResult.resolvedPath.wslPath,
      loadResult.projectRoot,
      loadResult.projectHostPath,
      loadResult.identity,
      loadResult.validation
    );

    record.localState.autopilotEnabled = true;
    record.workflow.workflowCycle.cycleNumber = 2;
    record.workflow.workflowStage = "repair_loop";
    record.workflow.workflowStopReason = "integrity_failed";
    record.workflow.activityLog.unshift({
      id: "workflow-1",
      timestamp: "2026-04-07T00:00:02.000Z",
      source: "agent",
      status: "failed",
      title: "Integrity failed",
      detail: `Validation failed while checking ${root}/src/index.ts with token=secret-token-value-12345`,
      stepId: "integrity",
      agentId: "agent-1",
      agentCategory: "integrity"
    });
    record.workflow.memory.knownOpenIssues.push({
      id: "issue-1",
      title: "Repeated integrity failure",
      detail: `Failures keep pointing at ${root}/src/index.ts`,
      source: "integrity",
      status: "open",
      recordedAt: "2026-04-07T00:00:01.000Z"
    });

    const agent = createAgentSkeleton("coding", "Coding Agent", `Fix the workflow issue in ${root}`, "gpt-5.4");
    agent.id = "agent-1";
    agent.status = "failed";
    agent.startedAt = "2026-04-07T00:00:00.000Z";
    agent.completedAt = "2026-04-07T00:00:03.000Z";
    agent.worktree = {
      baseDir: path.join(root, ".awb-worktrees"),
      worktreePath: path.join(root, ".awb-worktrees", "coding-agent"),
      branch: "awb/coding-agent"
    };
    agent.commandLog.push({
      command: `npm test -- ${root}/src/index.ts`,
      cwd: root,
      output: `FAIL ${root}/src/index.ts\nWorktree: ${agent.worktree.worktreePath}\nAuthorization: Bearer secret-token-value-12345\napiKey=sk-proj-secretvalue1234567890`,
      status: "failed",
      startedAt: "2026-04-07T00:00:01.000Z",
      completedAt: "2026-04-07T00:00:02.000Z",
      exitCode: 1
    });
    agent.events.push({
      id: "event-1",
      agentId: agent.id,
      timestamp: "2026-04-07T00:00:01.500Z",
      type: "command",
      status: "failed",
      title: "Command output",
      detail: `Command failed in ${root}/src/index.ts`,
      agentCategory: "coding"
    });
    record.agents.push(agent);

    record.userInputRequests.push({
      id: "request-1",
      agentId: agent.id,
      requestedByAgentCategory: "coding",
      threadId: "thread-1",
      serverRequestId: "server-1",
      title: "Need environment detail",
      description: `Attach the failing log from ${root}`,
      questions: [],
      attachmentInboxPath: path.join(root, ".agent-workbench", "input-requests", "request-1"),
      attachmentInboxRelativePath: ".agent-workbench/input-requests/request-1",
      attachments: [],
      status: "pending",
      createdAt: "2026-04-07T00:00:02.500Z"
    });

    const destination = path.join(appData, "exports", "review-log.json");
    await storage.writeReviewLogBundleToFile(record, service.getState().settings, [`Diagnostic for ${root}`], destination);

    const raw = await readFile(destination, "utf8");
    const bundle = projectReviewLogBundleSchema.parse(JSON.parse(raw));

    expect(raw).not.toContain(root);
    expect(raw).not.toContain("secret-token-value-12345");
    expect(raw).not.toContain("sk-proj-secretvalue1234567890");
    expect(raw).toContain("<project-root>");
    expect(raw).toContain("[redacted]");
    expect(raw).toContain("<agent-worktree>");
    expect(raw).toContain("<user-input-inbox>");
    expect(bundle.summary.totalAgents).toBe(1);
    expect(bundle.summary.pendingUserInputRequests).toBe(1);
    expect(bundle.timeline.some((entry) => entry.title === "Integrity failed")).toBe(true);
    expect(bundle.agents[0]?.commandLog[0]?.cwd).toBe("<project-root>");
  });

  it("handles approval queue requests and decisions", async () => {
    const root = await createSampleRepo("approvals");
    const appData = await createTempDir("appdata-approvals");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    const projectId = selected.record.id;
    const agent = await service.createAgent(projectId, "coding", "Agent", "Update the code.", "gpt-5.4");

    (service as any).handleTransportRequest({
      method: "item/commandExecution/requestApproval",
      id: "approval-request-1",
      params: {
        threadId: agent.threadId,
        turnId: "turn-1",
        itemId: "item-1",
        command: "npm test",
        cwd: root,
        reason: "Run the test suite"
      }
    });

    const pendingApproval = await waitFor(
      () => getProjectRecord(service, projectId)?.agents.find((entry) => entry.id === agent.id)?.approvals[0]
    );
    expect(pendingApproval.summary).toBe("npm test");

    await service.approve(projectId, agent.id, pendingApproval.id, "accept");
    await waitFor(
      () => getProjectRecord(service, projectId)?.agents.find((entry) => entry.id === agent.id)?.approvals[0]?.status === "approved"
    );
  });

  it("keeps live thread instructions role-scoped and sends the task prompt once", async () => {
    const root = await createSampleRepo("prompt-structure");
    const appData = await createTempDir("appdata-prompt-structure");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");

    const transport = new CapturingPromptTransport();
    (service as unknown as { transport: MockCodexTransport }).transport = transport;
    const taskPrompt = "Update the code with the distinctive prompt-structure marker.";
    await service.createAgent(selected.record.id, "coding", "Prompt Agent", taskPrompt, "gpt-5.4");

    const baseInstructions = transport.threadStarts.at(-1)?.baseInstructions ?? "";
    const developerInstructions = transport.threadStarts.at(-1)?.developerInstructions ?? "";
    const turnText = transport.turnStarts
      .at(-1)
      ?.input
      .filter((entry): entry is Extract<(typeof transport.turnStarts)[number]["input"][number], { type: "text" }> => entry.type === "text")
      .map((entry) => entry.text)
      .join("\n") ?? "";

    expect(baseInstructions).toContain("Make the largest coherent, reviewable change");
    expect(baseInstructions).not.toContain(taskPrompt);
    expect(developerInstructions).toContain("Project boundary rules");
    expect(developerInstructions).toContain("External service policy");
    expect(developerInstructions).toContain("free/no-card APIs and API keys are allowed");
    expect(developerInstructions).toContain("request the credential through the user-input/Credentials flow");
    expect(turnText).toContain(taskPrompt);
    expect(turnText).not.toContain("Make the largest coherent, reviewable change");
  });

  it("starts read-only agents with the current sandbox policy shape", async () => {
    const root = await createSampleRepo("readonly-sandbox-policy");
    const appData = await createTempDir("appdata-readonly-sandbox-policy");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");

    const transport = new CapturingPromptTransport();
    (service as unknown as { transport: MockCodexTransport }).transport = transport;
    await service.createAgent(selected.record.id, "integrity", "Read-only Agent", "Inspect without editing.", "gpt-5.4");

    const sandboxPolicy = transport.turnStarts.at(-1)?.sandboxPolicy;
    expect(sandboxPolicy).toEqual({
      type: "readOnly",
      networkAccess: false
    });
    expect(JSON.stringify(sandboxPolicy)).not.toContain("readOnlyAccess");
    expect(JSON.stringify(sandboxPolicy)).not.toContain("\"access\"");
  });

  it("auto-approves git commit and push approvals when those toggles are enabled", async () => {
    const root = await createSampleRepo("approval-auto-git");
    const appData = await createTempDir("appdata-approval-auto-git");
    const service = await createService(appData);
    await service.updateSettings({
      autoApproveGitCommits: true,
      autoApproveGitPushes: true
    });
    await service.loadProject(root);
    const selected = await service.selectPendingInterface("fresh");
    const agent = await service.createAgent(selected.record.id, "coding", "Agent", "Update the code.", "gpt-5.4");

    await (service as any).handleTransportRequest({
      method: "item/commandExecution/requestApproval",
      id: "auto-commit-approval",
      params: {
        threadId: agent.threadId,
        turnId: "turn-1",
        itemId: "item-1",
        command: "git commit -m \"checkpoint\"",
        cwd: root,
        reason: "Create a checkpoint commit"
      }
    });

    await (service as any).handleTransportRequest({
      method: "item/commandExecution/requestApproval",
      id: "auto-push-approval",
      params: {
        threadId: agent.threadId,
        turnId: "turn-1",
        itemId: "item-2",
        command: "git push origin main",
        cwd: root,
        reason: "Push the branch"
      }
    });

    const approvals = await waitFor(() => {
      const records = getProjectRecord(service, selected.record.id)?.agents.find((entry) => entry.id === agent.id)?.approvals ?? [];
      return records.length >= 2 ? records : null;
    });

    expect(approvals.every((approval) => approval.status === "approved")).toBe(true);
    expect(approvals.filter((approval) => approval.status === "pending")).toHaveLength(0);
    expect(approvals.some((approval) => approval.command === "git commit -m \"checkpoint\"")).toBe(true);
    expect(approvals.some((approval) => approval.command === "git push origin main")).toBe(true);
  });

  it("surfaces merge conflicts through the merge workflow", async () => {
    const root = await createSampleRepo("merge");
    const appData = await createTempDir("appdata-merge");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    const project = (service as any).projects.get(selected.record.id);
    project.record.workflow.ultimateGoal = {
      ...project.record.workflow.ultimateGoal,
      summary: "Surface merge conflicts through the workflow.",
      confirmedAt: "2026-04-12T00:00:00.000Z"
    };

    await writeFile(path.join(root, "src/index.ts"), "export const value = 'main';\n");
    await commitAll(root, "main change");

    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    await execFileAsync("git", ["checkout", "-b", "feature-a"], { cwd: root });
    await writeFile(path.join(root, "src/index.ts"), "export const value = 'feature-a';\n");
    await commitAll(root, "feature a");
    await execFileAsync("git", ["checkout", "main"], { cwd: root });

    await execFileAsync("git", ["checkout", "-b", "feature-b"], { cwd: root });
    await writeFile(path.join(root, "src/index.ts"), "export const value = 'feature-b';\n");
    await commitAll(root, "feature b");
    await execFileAsync("git", ["checkout", "main"], { cwd: root });

    project.record.agents.push({
      ...createAgentSkeleton("coding", "Agent A", "Task A", "gpt-5.4"),
      worktree: { baseDir: appData, worktreePath: root, branch: "feature-a", targetBranch: "main" }
    });
    project.record.agents.push({
      ...createAgentSkeleton("coding", "Agent B", "Task B", "gpt-5.4"),
      worktree: { baseDir: appData, worktreePath: root, branch: "feature-b", targetBranch: "main" }
    });

    await service.runMerge(selected.record.id);
    const record = service.getState().projects.find((entry) => entry.record.id === selected.record.id)?.record;
    const mergeAgent = record?.agents.find((entry) => entry.category === "merge");
    expect(mergeAgent?.mergeReport?.conflicts.length).toBeGreaterThan(0);
    expect(mergeAgent?.status).toBe("conflicted");
    expect(record?.workflow.repair.status).toBe("merge_conflicts");
    expect(record?.workflow.manualHandoff).toMatchObject({
      reason: "merge_conflicts",
      title: "Merge conflicts detected",
      validationIssue: "Merge conflicts were detected and require follow-up."
    });
    expect(record?.workflow.manualHandoff?.involvedPaths).toContain("src/index.ts");

    record!.workflow.manualHandoff = undefined;
    (service as any).syncWorkflowState(project);
    expect(project.record.workflow.manualHandoff).toMatchObject({
      reason: "merge_conflicts",
      title: "Merge conflicts detected"
    });
  });

  it("retries merge after conflicts are resolved manually", async () => {
    const root = await createSampleRepo("merge-retry");
    const appData = await createTempDir("appdata-merge-retry");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    const project = (service as any).projects.get(selected.record.id);
    const workflow = project.record.workflow;

    workflow.ultimateGoal = {
      ...workflow.ultimateGoal,
      summary: "Complete a merge-conflict recovery flow.",
      confirmedAt: "2026-04-12T00:00:00.000Z"
    };
    workflow.scopedGoal = {
      id: "scoped-goal-merge-retry",
      sourceRecommendationId: "rec-merge-retry",
      summary: "Retry integration after manual conflict resolution.",
      executionBrief: "Resolve conflicts and rerun the merge.",
      acceptanceCriteria: [],
      constraints: [],
      testStrategy: ["Run merge after conflicts are resolved."],
      createdAt: "2026-04-12T00:00:00.000Z"
    };
    workflow.stepProgress.coding.status = "completed";
    workflow.stepProgress.integrity.status = "completed";

    await writeFile(path.join(root, "src/index.ts"), "export const value = 'main';\n");
    await commitAll(root, "main change");

    await execFileAsync("git", ["checkout", "-b", "feature-a"], { cwd: root });
    await writeFile(path.join(root, "src/index.ts"), "export const value = 'resolved';\n");
    await commitAll(root, "feature a");
    await execFileAsync("git", ["checkout", "main"], { cwd: root });

    await execFileAsync("git", ["checkout", "-b", "feature-b"], { cwd: root });
    await writeFile(path.join(root, "src/index.ts"), "export const value = 'feature-b';\n");
    await commitAll(root, "feature b");
    await execFileAsync("git", ["checkout", "main"], { cwd: root });

    project.record.agents.push({
      ...createAgentSkeleton("coding", "Agent A", "Task A", "gpt-5.4"),
      workflowCycleNumber: workflow.workflowCycle.cycleNumber,
      status: "completed",
      completedAt: "2026-04-12T00:01:00.000Z",
      worktree: { baseDir: appData, worktreePath: root, branch: "feature-a", targetBranch: "main" }
    });
    project.record.agents.push({
      ...createAgentSkeleton("coding", "Agent B", "Task B", "gpt-5.4"),
      workflowCycleNumber: workflow.workflowCycle.cycleNumber,
      status: "completed",
      completedAt: "2026-04-12T00:02:00.000Z",
      worktree: { baseDir: appData, worktreePath: root, branch: "feature-b", targetBranch: "main" }
    });

    await service.runMerge(selected.record.id);
    expect(getProjectRecord(service, selected.record.id)?.workflow.repair.status).toBe("merge_conflicts");
    const conflictedMergeAgent = getProjectRecord(service, selected.record.id)?.agents.find((agent) => agent.category === "merge");
    const conflictedWorktreePath = conflictedMergeAgent?.worktree?.worktreePath;
    expect(conflictedWorktreePath).toBeTruthy();
    await expect(access(conflictedWorktreePath!)).resolves.toBeUndefined();

    await execFileAsync("git", ["checkout", "feature-b"], { cwd: root });
    await writeFile(path.join(root, "src/index.ts"), "export const value = 'resolved';\n");
    await commitAll(root, "resolve feature branch conflict");
    await execFileAsync("git", ["checkout", "main"], { cwd: root });

    const previousMergeAgentCount = getProjectRecord(service, selected.record.id)?.agents.filter((agent) => agent.category === "merge").length ?? 0;
    await service.retryWorkflowGoal(selected.record.id);

    const record = await waitFor(() => {
      const candidate = getProjectRecord(service, selected.record.id);
      const mergeAgents = candidate?.agents.filter((agent) => agent.category === "merge") ?? [];
      const latestMergeAgent = mergeAgents[0];
      return mergeAgents.length > previousMergeAgentCount && latestMergeAgent?.status === "completed" ? candidate : null;
    }, 8_000);

    const latestMergeAgent = record.agents.filter((agent) => agent.category === "merge")[0];
    expect(latestMergeAgent?.status).toBe("completed");
    expect(latestMergeAgent?.mergeReport?.conflicts).toHaveLength(0);
    expect(record.workflow.manualHandoff).toBeUndefined();
    expect(record.workflow.repair.status).not.toBe("merge_conflicts");
    expect(record.workflow.activityLog.some((event) => event.title === "Manual merge retry requested")).toBe(true);
    expect(await readFile(path.join(root, "src/index.ts"), "utf8")).toContain("resolved");
    await expect(access(conflictedWorktreePath!)).rejects.toThrow();
  }, 12_000);

  it("queues merge conflict retries without awaiting merge work on the caller path", async () => {
    const root = await createSampleRepo("merge-retry-queued");
    const appData = await createTempDir("appdata-merge-retry-queued");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    const project = (service as any).projects.get(selected.record.id);
    const workflow = project.record.workflow;
    const latestFailureReason = "CONFLICT (content): Merge conflict in src/index.ts";

    workflow.repair.status = "merge_conflicts";
    workflow.repair.latestIssueSummary = "Merge conflicts were detected and require follow-up.";
    workflow.repair.latestFailureReason = latestFailureReason;
    workflow.manualHandoff = {
      reason: "merge_conflicts",
      title: "Merge conflicts detected",
      whatSystemWasTryingToDo: "Integrate validated coding-agent branches into the opened project checkout",
      validationIssue: "Merge conflicts were detected and require follow-up.",
      latestFailureReason,
      involvedPaths: ["src/index.ts"],
      shellSupported: false,
      createdAt: nowIso()
    };
    workflow.stepProgress.merge.status = "failed";

    const runMergeCalls: Array<{ projectId: string; automate: boolean }> = [];
    let releaseRunMerge: (() => void) | undefined;
    (service as any).runMerge = async (queuedProjectId: string, automate = false): Promise<void> => {
      runMergeCalls.push({ projectId: queuedProjectId, automate });
      await new Promise<void>((resolve) => {
        releaseRunMerge = resolve;
      });
    };

    const startedAt = performance.now();
    await service.retryWorkflowGoal(selected.record.id);

    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(runMergeCalls).toHaveLength(0);

    await waitFor(() => runMergeCalls.length === 1 ? true : null, 1_000);
    expect(runMergeCalls).toEqual([{ projectId: selected.record.id, automate: true }]);

    await service.retryWorkflowGoal(selected.record.id);
    expect(runMergeCalls).toHaveLength(1);

    releaseRunMerge?.();
    await waitFor(() => ((service as any).workflowMergeRetryInFlight as Set<string>).has(selected.record.id) ? null : true, 1_000);
  }, 6_000);

  it("applies a manually resolved integration worktree when retrying merge conflicts", async () => {
    const root = await createSampleRepo("merge-retry-worktree");
    const appData = await createTempDir("appdata-merge-retry-worktree");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    const project = (service as any).projects.get(selected.record.id);
    const workflow = project.record.workflow;

    workflow.ultimateGoal = {
      ...workflow.ultimateGoal,
      summary: "Complete a worktree-based merge-conflict recovery flow.",
      confirmedAt: "2026-04-12T00:00:00.000Z"
    };
    workflow.scopedGoal = {
      id: "scoped-goal-merge-retry-worktree",
      sourceRecommendationId: "rec-merge-retry-worktree",
      summary: "Retry integration after resolving the integration worktree.",
      executionBrief: "Resolve conflicts in the integration worktree and retry.",
      acceptanceCriteria: [],
      constraints: [],
      testStrategy: ["Run merge after conflicts are resolved in the worktree."],
      createdAt: "2026-04-12T00:00:00.000Z"
    };
    workflow.stepProgress.coding.status = "completed";
    workflow.stepProgress.integrity.status = "completed";

    await writeFile(path.join(root, "src/index.ts"), "export const value = 'main';\n");
    await commitAll(root, "main change");

    await execFileAsync("git", ["checkout", "-b", "feature-a"], { cwd: root });
    await writeFile(path.join(root, "src/index.ts"), "export const value = 'feature-a';\n");
    await commitAll(root, "feature a");
    await execFileAsync("git", ["checkout", "main"], { cwd: root });

    await execFileAsync("git", ["checkout", "-b", "feature-b"], { cwd: root });
    await writeFile(path.join(root, "src/index.ts"), "export const value = 'feature-b';\n");
    await commitAll(root, "feature b");
    await execFileAsync("git", ["checkout", "main"], { cwd: root });

    project.record.agents.push({
      ...createAgentSkeleton("coding", "Agent A", "Task A", "gpt-5.4"),
      workflowCycleNumber: workflow.workflowCycle.cycleNumber,
      status: "completed",
      completedAt: "2026-04-12T00:01:00.000Z",
      worktree: { baseDir: appData, worktreePath: root, branch: "feature-a", targetBranch: "main" }
    });
    project.record.agents.push({
      ...createAgentSkeleton("coding", "Agent B", "Task B", "gpt-5.4"),
      workflowCycleNumber: workflow.workflowCycle.cycleNumber,
      status: "completed",
      completedAt: "2026-04-12T00:02:00.000Z",
      worktree: { baseDir: appData, worktreePath: root, branch: "feature-b", targetBranch: "main" }
    });

    await service.runMerge(selected.record.id);
    const conflictedRecord = getProjectRecord(service, selected.record.id);
    const mergeAgent = conflictedRecord?.agents.find((agent) => agent.category === "merge");
    const worktreePath = mergeAgent?.worktree?.worktreePath;
    expect(conflictedRecord?.workflow.repair.status).toBe("merge_conflicts");
    expect(mergeAgent?.status).toBe("conflicted");
    expect(worktreePath).toBeTruthy();

    await writeFile(path.join(worktreePath!, "src/index.ts"), "export const value = 'resolved-in-worktree';\n");
    await execFileAsync("git", ["add", "src/index.ts"], { cwd: worktreePath! });

    const previousMergeAgentCount = conflictedRecord?.agents.filter((agent) => agent.category === "merge").length ?? 0;
    await service.retryWorkflowGoal(selected.record.id);

    const record = await waitFor(() => {
      const candidate = getProjectRecord(service, selected.record.id);
      const mergeAgents = candidate?.agents.filter((agent) => agent.category === "merge") ?? [];
      const latestMergeAgent = mergeAgents[0];
      return mergeAgents.length === previousMergeAgentCount && latestMergeAgent?.status === "completed" ? candidate : null;
    }, 8_000);

    const latestMergeAgent = record.agents.filter((agent) => agent.category === "merge")[0];
    expect(latestMergeAgent?.mergeReport?.conflicts).toHaveLength(0);
    expect(latestMergeAgent?.mergeReport?.summary).toContain("Resolved merge-conflict worktree was applied");
    expect(record.workflow.manualHandoff).toBeUndefined();
    expect(record.workflow.repair.status).not.toBe("merge_conflicts");
    expect(await readFile(path.join(root, "src/index.ts"), "utf8")).toContain("resolved-in-worktree");
    await expect(execFileAsync("git", ["merge-base", "--is-ancestor", "feature-a", "main"], { cwd: root })).resolves.toBeTruthy();
    await expect(execFileAsync("git", ["merge-base", "--is-ancestor", "feature-b", "main"], { cwd: root })).resolves.toBeTruthy();
    await expect(access(worktreePath!)).rejects.toThrow();
  }, 12_000);

  it("updates the opened checkout after a successful merge", async () => {
    const root = await createSampleRepo("merge-success");
    const appData = await createTempDir("appdata-merge-success");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    const project = (service as any).projects.get(selected.record.id);

    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    await execFileAsync("git", ["checkout", "-b", "feature-a"], { cwd: root });
    await writeFile(path.join(root, "src/index.ts"), "export const value = 'merged';\n");
    await commitAll(root, "feature a");
    await execFileAsync("git", ["checkout", "main"], { cwd: root });

    project.record.agents.push({
      ...createAgentSkeleton("coding", "Agent A", "Task A", "gpt-5.4"),
      worktree: { baseDir: appData, worktreePath: root, branch: "feature-a", targetBranch: "main" }
    });

    await service.runMerge(selected.record.id);

    const mergeAgent = service.getState().projects.find((entry) => entry.record.id === selected.record.id)?.record.agents.find((entry) => entry.category === "merge");
    expect(mergeAgent?.status).toBe("completed");
    expect(mergeAgent?.mergeReport?.summary).toContain("opened checkout");
    expect(await readFile(path.join(root, "src/index.ts"), "utf8")).toContain("merged");
  });

  it("pushes the opened checkout after a successful merge when not in mock mode", async () => {
    const root = await createSampleRepo("merge-push-success");
    const appData = await createTempDir("appdata-merge-push-success");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    const project = (service as any).projects.get(selected.record.id);
    (service as any).settings.mockMode = false;

    const remote = await createTempDir("merge-push-success-remote.git");
    await execFileAsync("git", ["init", "--bare"], { cwd: remote });
    await execFileAsync("git", ["remote", "set-url", "origin", remote], { cwd: root });
    await execFileAsync("git", ["push", "-u", "origin", "main"], { cwd: root });

    await execFileAsync("git", ["checkout", "-b", "feature-push"], { cwd: root });
    await writeFile(path.join(root, "src/index.ts"), "export const value = 'pushed merge';\n");
    await commitAll(root, "feature push");
    await execFileAsync("git", ["checkout", "main"], { cwd: root });

    project.record.agents.push({
      ...createAgentSkeleton("coding", "Agent Push", "Task Push", "gpt-5.4"),
      worktree: { baseDir: appData, worktreePath: root, branch: "feature-push", targetBranch: "main" }
    });

    await (service as any).runMergeInternal(selected.record.id);

    const mergeAgent = getProjectRecord(service, selected.record.id)?.agents.find((entry) => entry.category === "merge");
    const localHead = (await execFileAsync("git", ["rev-parse", "main"], { cwd: root })).stdout.trim();
    const remoteHead = (await execFileAsync("git", ["--git-dir", remote, "rev-parse", "main"])).stdout.trim();
    expect(mergeAgent?.status).toBe("completed");
    expect(mergeAgent?.mergeReport?.summary).toContain("Pushed main to origin");
    expect(remoteHead).toBe(localHead);
  });

  it("keeps a successful merge completed when the post-merge project refresh fails", async () => {
    const root = await createSampleRepo("merge-refresh-failure");
    const appData = await createTempDir("appdata-merge-refresh-failure");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    const project = (service as any).projects.get(selected.record.id);
    project.record.workflow.ultimateGoal = {
      ...project.record.workflow.ultimateGoal,
      summary: "Verify merge completion survives refresh errors.",
      confirmedAt: "2026-04-12T00:00:00.000Z"
    };
    project.record.workflow.scopedGoal = {
      id: "scoped-goal-refresh-failure",
      sourceRecommendationId: "rec-refresh-failure",
      summary: "Merge a branch even if overview refresh fails.",
      executionBrief: "Merge the branch and keep the workflow state successful.",
      acceptanceCriteria: [],
      constraints: [],
      testStrategy: [],
      createdAt: "2026-04-12T00:00:00.000Z"
    };
    project.record.workflow.stepProgress.coding.status = "completed";
    project.record.workflow.stepProgress.integrity.status = "completed";

    await execFileAsync("git", ["checkout", "-b", "feature-refresh"], { cwd: root });
    await writeFile(path.join(root, "src/index.ts"), "export const value = 'merged despite refresh failure';\n");
    await commitAll(root, "feature refresh");
    await execFileAsync("git", ["checkout", "main"], { cwd: root });

    project.record.agents.push({
      ...createAgentSkeleton("coding", "Agent A", "Task A", "gpt-5.4"),
      worktree: { baseDir: appData, worktreePath: root, branch: "feature-refresh", targetBranch: "main" }
    });
    (service as any).scanCurrentProject = async () => {
      const error = new Error("EISDIR: illegal operation on a directory, lstat 'node_modules/.bin/vite'");
      (error as NodeJS.ErrnoException).code = "EISDIR";
      throw error;
    };

    await service.runMerge(selected.record.id);

    const record = getProjectRecord(service, selected.record.id);
    const mergeAgent = record?.agents.find((entry) => entry.category === "merge");
    expect(mergeAgent?.status).toBe("completed");
    expect(record?.workflow.workflowStage).toBe("merged");
    expect(record?.workflow.workflowStopReason).toBe("none");
    expect(record?.workflow.repair.status).not.toBe("merge_conflicts");
    expect(await readFile(path.join(root, "src/index.ts"), "utf8")).toContain("merged despite refresh failure");
    expect(service.getState().diagnostics[0]).toContain("project overview refresh failed");
  });

  it("runs git integrity checks in a review worktree based on the latest coding branch", async () => {
    const root = await createSampleProject("integrity-review-worktree", "git", {
      typecheck: "node -e \"const fs = require('fs'); process.exit(fs.existsSync('src/feature.ts') ? 0 : 1)\""
    });
    const appData = await createTempDir("appdata-integrity-review-worktree");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    const project = (service as any).projects.get(selected.record.id);
    const workflow = project.record.workflow;

    workflow.ultimateGoal = {
      ...workflow.ultimateGoal,
      summary: "Validate the latest coding branch safely.",
      confirmedAt: "2026-04-12T00:00:00.000Z"
    };
    workflow.scopedGoal = {
      id: "scoped-goal-1",
      sourceRecommendationId: "rec-1",
      summary: "Check the coding branch in a safe review workspace.",
      executionBrief: "Run integrity checks against the coding branch changes.",
      acceptanceCriteria: [],
      constraints: [],
      testStrategy: [],
      createdAt: "2026-04-12T00:00:00.000Z"
    };

    await execFileAsync("git", ["checkout", "-b", "feature-a"], { cwd: root });
    await writeFile(path.join(root, "src/feature.ts"), "export const feature = 'from-review-branch';\n");
    await commitAll(root, "feature a");
    await execFileAsync("git", ["checkout", "main"], { cwd: root });

    project.record.agents.push({
      ...createAgentSkeleton("coding", "Coding Pass 1", "Implement the feature file.", "gpt-5.4"),
      workflowCycleNumber: workflow.workflowCycle.cycleNumber,
      status: "completed",
      completedAt: "2026-04-12T00:01:00.000Z",
      changedFiles: ["src/feature.ts"],
      worktree: { baseDir: appData, worktreePath: root, branch: "feature-a", targetBranch: "main" }
    });

    await expect(access(path.join(root, "src/feature.ts"))).rejects.toThrow();

    await service.runIntegrity(selected.record.id);

    const integrityAgent = getProjectRecord(service, selected.record.id)?.agents.find((agent) => agent.category === "integrity");
    expect(integrityAgent?.threadId).toBeUndefined();
    expect(integrityAgent?.worktree?.worktreePath).toContain(".agent-workbench/worktrees");
    expect(integrityAgent?.integrityReport?.checks).toHaveLength(1);
    expect(integrityAgent?.integrityReport?.checks[0]).toMatchObject({
      name: "typecheck",
      command: "npm run typecheck",
      status: "passed"
    });
    expect(integrityAgent?.status).toBe("completed");
  });

  it("bases repair coding passes on the latest completed coding branch in the active workflow cycle", async () => {
    const root = await createSampleRepo("repair-pass-branch-base");
    const appData = await createTempDir("appdata-repair-pass-branch-base");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    const project = (service as any).projects.get(selected.record.id);
    const workflow = project.record.workflow;

    workflow.scopedGoal = {
      id: "scoped-goal-2",
      sourceRecommendationId: "rec-2",
      summary: "Continue the current repair branch.",
      executionBrief: "Apply the next repair on top of the latest completed coding branch.",
      acceptanceCriteria: [],
      constraints: [],
      testStrategy: [],
      createdAt: "2026-04-12T00:00:00.000Z"
    };

    await execFileAsync("git", ["checkout", "-b", "feature-a"], { cwd: root });
    await writeFile(path.join(root, "src/repair-base.ts"), "export const repairBase = true;\n");
    await commitAll(root, "repair base");
    await execFileAsync("git", ["checkout", "main"], { cwd: root });

    project.record.agents.push({
      ...createAgentSkeleton("coding", "Coding Pass 1", "Initial repair pass.", "gpt-5.4"),
      workflowCycleNumber: workflow.workflowCycle.cycleNumber,
      status: "completed",
      completedAt: "2026-04-12T00:01:00.000Z",
      changedFiles: ["src/repair-base.ts"],
      worktree: { baseDir: appData, worktreePath: root, branch: "feature-a", targetBranch: "main" }
    });

    await (service as any).startWorkflowCodingPass(selected.record.id, true);

    const repairAgent = getProjectRecord(service, selected.record.id)?.agents.find((agent) => agent.name.startsWith("Repair Coding Pass"));
    expect(repairAgent?.worktree?.targetBranch).toBe("feature-a");
  });

  it("checkpoints coding-agent worktree edits and merges them back into the opened checkout", async () => {
    const root = await createSampleRepo("coding-worktree-checkpoint");
    const appData = await createTempDir("appdata-coding-worktree-checkpoint");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");

    const agent = await service.createAgent(selected.record.id, "coding", "Coding Pass 1", "Add a new feature file.", "gpt-5.4");
    const worktreePath = agent.worktree?.worktreePath;
    const branch = agent.worktree?.branch;
    expect(worktreePath).toBeTruthy();
    expect(branch).toBeTruthy();

    await writeFile(path.join(worktreePath!, "src/feature.ts"), "export const feature = 'from-agent';\n");
    await expect(access(path.join(root, "src/feature.ts"))).rejects.toThrow();

    (service as any).handleTransportNotification({
      method: "turn/completed",
      params: {
        threadId: agent.threadId,
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });

    const finalizedAgent = await waitFor(() => {
      const stored = getProjectRecord(service, selected.record.id)?.agents.find((entry) => entry.id === agent.id);
      return stored?.status === "completed" && stored.changedFiles.includes("src/feature.ts") ? stored : null;
    });
    expect(finalizedAgent.currentPhase).toContain("merge");
    await expect(access(worktreePath!)).rejects.toThrow();

    const branchAheadCount = Number((await execFileAsync("git", ["rev-list", "--count", `main..${branch}`], { cwd: root })).stdout.trim());
    expect(branchAheadCount).toBeGreaterThan(0);

    await service.runMerge(selected.record.id);

    expect(await readFile(path.join(root, "src/feature.ts"), "utf8")).toContain("from-agent");
  });

  it("prunes stale managed worktrees when reopening a saved workspace", async () => {
    const root = await createSampleRepo("prune-stale-worktree");
    const appData = await createTempDir("appdata-prune-stale-worktree");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");

    const staleWorktreePath = path.join(root, ".agent-workbench", "worktrees", "prune-stale-worktree", "stale-pass", "stale");
    await execFileAsync("git", ["worktree", "add", "-b", "awb/prune-stale/manual", staleWorktreePath, "main"], { cwd: root });
    await expect(access(staleWorktreePath)).resolves.toBeUndefined();

    await service.openProject(selected.record.id);

    await expect(access(staleWorktreePath)).rejects.toThrow();
  });

  it("marks saved active agents disconnected when a previous session ended mid-run", async () => {
    const root = await createSampleRepo("resume");
    const appData = await createTempDir("appdata-resume");
    const serviceA = await createService(appData);
    await serviceA.loadProject(root);
    const selected = await serviceA.selectPendingInterface("fresh");
    await new Promise((resolve) => setTimeout(resolve, 80));
    const record = getProjectRecord(serviceA, selected.record.id);
    expect(record).toBeTruthy();
    const activeAgent = createAgentSkeleton("recommendation", "Interrupted Recommendation Agent", "Generate recommendations.", "gpt-5.4-mini");
    activeAgent.status = "running";
    activeAgent.startedAt = new Date().toISOString();
    activeAgent.threadId = "missing-thread";
    const activeAgentWithoutThread = createAgentSkeleton("recommendation", "Interrupted Recommendation Without Thread", "Generate recommendations.", "gpt-5.4-mini");
    activeAgentWithoutThread.status = "running";
    activeAgentWithoutThread.startedAt = new Date().toISOString();
    record?.agents.unshift(activeAgent);
    record?.agents.unshift(activeAgentWithoutThread);
    await serviceA.updateUiState(selected.record.id, { treeFilter: "resume-marker" });
    await serviceA.exportInterface(selected.record.id);

    const serviceB = await createService(appData);
    const loadResult = await serviceB.loadProject(root);
    const localCandidate = loadResult.interfaceCandidates.find((candidate) => candidate.source === "local");
    expect(localCandidate).toBeTruthy();
    const reopened = await serviceB.selectPendingInterface("local", localCandidate?.path);
    expect(reopened.record.agents.find((agent) => agent.id === activeAgent.id)?.status).toBe("disconnected");
    expect(reopened.record.agents.find((agent) => agent.id === activeAgentWithoutThread.id)?.status).toBe("disconnected");
    expect(reopened.record.workflow.stepProgress.recommendation.status).toBe("waiting");
  });

  it("detects and persists an ultimate goal draft", async () => {
    const root = await createSampleRepo("ultimate-goal");
    const appData = await createTempDir("appdata-ultimate-goal");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");

    const detected = await service.detectUltimateGoal(selected.record.id);
    await new Promise((resolve) => setTimeout(resolve, 80));

    const project = service.getState().projects.find((entry) => entry.record.id === selected.record.id);
    expect(detected.source).toBe("detected");
    expect(project?.record.workflow.ultimateGoalDraft?.summary.length).toBeGreaterThan(10);
    expect(project?.record.agents.some((agent) => agent.category === "goal")).toBe(true);
  });

  it("approves a recommendation and creates a scoped goal as separate workflow actions", async () => {
    const root = await createSampleRepo("recommendation-cycle");
    const appData = await createTempDir("appdata-recommendation-cycle");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    await new Promise((resolve) => setTimeout(resolve, 80));

    await service.updateUltimateGoal(
      selected.record.id,
      {
        summary: "Build a safe workflow orchestrator foundation.",
        detailedIntent: "Move from manual dashboarding toward explicit loop state.",
        successCriteria: ["Workflow state is persisted."],
        constraints: ["Keep typed IPC intact."],
        nonGoals: ["Do not fake full autonomy."],
        targetAudience: "Developers maintaining the app.",
        qualityBar: "Production-grade and test-backed.",
        source: "user"
      },
      true
    );
    await service.runRecommendation(selected.record.id);

    const recommendationId = await waitFor(
      () => service.getState().projects.find((entry) => entry.record.id === selected.record.id)?.record.workflow.recommendations[0]?.id
    );
    expect(recommendationId).toBeTruthy();

    await service.approveRecommendation(selected.record.id, recommendationId);
    await service.createScopedGoal(selected.record.id);

    const project = await waitFor(() => {
      const candidate = service.getState().projects.find((entry) => entry.record.id === selected.record.id);
      return candidate?.record.workflow.scopedGoal ? candidate : null;
    });
    const codingStarted = await waitFor(() => {
      const candidate = service.getState().projects.find((entry) => entry.record.id === selected.record.id);
      return candidate?.record.workflow.stepProgress.coding.runCount ? candidate : null;
    });
    expect(project?.record.workflow.approvedRecommendation?.recommendationId).toBe(recommendationId);
    expect(project?.record.workflow.scopedGoal?.summary.length).toBeGreaterThan(5);
    expect(codingStarted.record.workflow.stepProgress.coding.runCount).toBeGreaterThan(0);
    expect(codingStarted.record.agents.some((agent) => agent.category === "coding")).toBe(true);
  });

  it("persists workflow mode changes without interrupting active workflow agents", async () => {
    const root = await createSampleRepo("workflow-mode-persistence");
    const appData = await createTempDir("appdata-workflow-mode-persistence");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");

    const fastWorkflow = await service.setWorkflowMode(selected.record.id, "fast");
    const storage = new WorkbenchStorage(appData);
    const storedFastRecord = (await storage.loadAllProjects()).find((record) => record.id === selected.record.id);
    expect(fastWorkflow.workflowMode).toBe("fast");
    expect(storedFastRecord?.workflow.workflowMode).toBe("fast");

    const project = (service as any).projects.get(selected.record.id);
    const activeAgent: any = {
      ...createAgentSkeleton("coding", "Coding Pass", "Keep running.", "gpt-5.4"),
      status: "running" as const
    };
    project.record.agents.unshift(activeAgent);

    const normalWorkflow = await service.setWorkflowMode(selected.record.id, "normal");
    expect(normalWorkflow.workflowMode).toBe("normal");
    expect(project.record.agents.find((agent: any) => agent.id === activeAgent.id)?.status).toBe("running");
  });

  it("queues Generate Preview safely, reaches preview ready, and resumes autopilot afterward", async () => {
    const root = await createSampleRepo("workflow-preview-cycle");
    const appData = await createTempDir("appdata-workflow-preview-cycle");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");
    (service as any).transport = undefined;
    (service as any).codexAvailability = { source: "unavailable" };

    await service.updateUltimateGoal(selected.record.id, {
      summary: "Build an inspectable workflow preview.",
      detailedIntent: "The operator needs to inspect the app structure before normal workflow continues.",
      successCriteria: ["The preview surface is visible and honest about incomplete areas."],
      constraints: ["Keep typed IPC intact.", "Do not claim final completion from a preview alone."],
      nonGoals: ["Do not add secrets."],
      targetAudience: "Workbench operators",
      qualityBar: "Preview state is durable and resumable.",
      source: "user"
    }, true);

    const project = (service as any).projects.get(selected.record.id);
    const activeAgent: any = {
      ...createAgentSkeleton("coding", "Coding Pass", "Keep running.", "gpt-5.4"),
      status: "running" as const
    };
    project.record.agents.unshift(activeAgent);

    const queued = await service.requestWorkflowPreview(selected.record.id, "Inspect the current app shell.");
    expect(queued.previewRequest?.status).toBe("queued");
    expect(project.record.agents.find((agent: any) => agent.id === activeAgent.id)?.status).toBe("running");

    activeAgent.status = "completed";
    await service.runRecommendation(selected.record.id, false);
    const previewRecommendation = getProjectRecord(service, selected.record.id)?.workflow.recommendations[0];
    expect(previewRecommendation?.title).toBe("Generate runnable preview checkpoint");
    expect(getProjectRecord(service, selected.record.id)?.workflow.previewRequest?.status).toBe("active");

    await service.approveRecommendation(selected.record.id, previewRecommendation?.id ?? "");
    await service.createScopedGoal(selected.record.id, false);
    const scopedPreview = getProjectRecord(service, selected.record.id)?.workflow.scopedGoal;
    expect(scopedPreview?.acceptanceCriteria.some((criterion) => criterion.includes("visible/runnable preview"))).toBe(true);

    await service.setAutopilotPolicy(selected.record.id, { enabled: true, pauseOnPreviewReady: true });
    const liveProject = (service as any).projects.get(selected.record.id);
    liveProject.record.workflow.workflowCycle.status = "merged";
    (service as any).finalizeWorkflowCycle(liveProject);
    await (service as any).persistProjectUpdate(liveProject);

    const ready = getProjectRecord(service, selected.record.id)?.workflow;
    expect(ready?.previewRequest?.status).toBe("ready");
    expect(ready?.previewRequest?.evidence?.[0]).toContain("deterministic validation and integration");
    expect(ready?.ultimateGoalCompletion?.state).toBe("needs_more_work");
    expect(getProjectRecord(service, selected.record.id)?.localState.workflowPauseRequested).toBe(true);
    expect(getProjectRecord(service, selected.record.id)?.workflow.autopilotPolicy.enabled).toBe(true);

    const completed = await service.completeWorkflowPreview(selected.record.id);
    expect(completed.previewRequest?.status).toBe("completed");
    expect(getProjectRecord(service, selected.record.id)?.localState.workflowPauseRequested).toBe(false);
    expect(getProjectRecord(service, selected.record.id)?.workflow.autopilotPolicy.enabled).toBe(true);
  });

  it("uses deterministic fast-mode packages before launching a recommendation agent", async () => {
    const root = await createSampleRepo("fast-deterministic-recommendation");
    const appData = await createTempDir("appdata-fast-deterministic-recommendation");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");
    const transport = new CapturingPromptTransport();
    (service as unknown as { transport: MockCodexTransport }).transport = transport;

    await service.updateUltimateGoal(selected.record.id, {
      summary: "Close coherent workflow package requirements.",
      detailedIntent: "The workflow should batch related required checks when Fast Mode can do so safely.",
      successCriteria: [
        "Recommendation ranking retires multiple unmet required checks",
        "Scoped goal metadata carries targeted check IDs",
        "Acceptance evidence names grouped workflow package paths",
        "Checklist consolidation keeps required package items distinct",
        "Workflow task map exposes grouped package progress"
      ],
      constraints: ["Keep changes local to workflow package fixtures."],
      nonGoals: ["Do not build Generate Preview."],
      targetAudience: "Workbench operators",
      qualityBar: "Deterministic, bounded, and test-backed.",
      source: "user"
    }, false);

    const record = getProjectRecord(service, selected.record.id);
    expect(record).toBeTruthy();
    if (!record) {
      return;
    }
    const workflow = record.workflow;
    workflow.ultimateGoal.confirmedAt = "2026-04-12T00:00:00.000Z";
    workflow.goalChecklist = applyGoalChecklistUpdates(
      workflow.goalChecklist,
      workflow.ultimateGoal.successCriteria.map((criterion: string) => ({
        title: criterion,
        status: "unmet" as const,
        evidence: "Fast Mode should retire this through the shared workflow package implementation.",
        relatedPaths: ["src/index.ts"]
      })),
      {
        timestamp: "2026-04-12T00:00:00.000Z",
        ultimateGoal: workflow.ultimateGoal,
        cycleNumber: workflow.workflowCycle.cycleNumber
      }
    );
    await service.setWorkflowMode(selected.record.id, "fast");
    const previousRecommendationAgentCount = record.agents.filter((agent) => agent.category === "recommendation").length;

    await service.runRecommendation(selected.record.id, false);

    const recommendation = await waitFor(() => getProjectRecord(service, selected.record.id)?.workflow.recommendations[0]);
    expect(recommendation.sourceWorkPackageId).toMatch(/^work-package:/);
    expect(recommendation.targetedCheckIds?.length).toBeGreaterThanOrEqual(4);
    const recommendationAgentsAfter = getProjectRecord(service, selected.record.id)?.agents.filter((agent) => agent.category === "recommendation") ?? [];
    expect(recommendationAgentsAfter).toHaveLength(previousRecommendationAgentCount);
    expect(transport.threadStarts).toHaveLength(0);

    const beforeGoalAgentCount = (getProjectRecord(service, selected.record.id)?.agents ?? []).filter((agent) => agent.category === "goal").length;
    await service.approveRecommendation(selected.record.id, recommendation.id);
    await service.createScopedGoal(selected.record.id, false);
    const scopedGoal = getProjectRecord(service, selected.record.id)?.workflow.scopedGoal;
    expect(scopedGoal?.sourceWorkPackageId).toBe(recommendation.sourceWorkPackageId);
    expect(scopedGoal?.targetedCheckIds?.length).toBeGreaterThanOrEqual(4);
    const goalAgentsAfter = getProjectRecord(service, selected.record.id)?.agents.filter((agent) => agent.category === "goal") ?? [];
    expect(goalAgentsAfter).toHaveLength(beforeGoalAgentCount);
  });

  it("falls back to the recommendation agent when fast-mode deterministic packages are insufficient", async () => {
    const root = await createSampleRepo("fast-recommendation-agent-fallback");
    const appData = await createTempDir("appdata-fast-recommendation-agent-fallback");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");
    const transport = new CapturingPromptTransport();
    (service as unknown as { transport: MockCodexTransport }).transport = transport;

    await service.updateUltimateGoal(selected.record.id, {
      summary: "Close one small workflow requirement.",
      detailedIntent: "Only one requirement is available, so Fast Mode should not invent a package.",
      successCriteria: ["Single workflow requirement is evidenced"],
      constraints: ["Keep typed IPC intact."],
      nonGoals: [],
      targetAudience: "Workbench operators",
      qualityBar: "Small and verified.",
      source: "user"
    }, false);
    const record = getProjectRecord(service, selected.record.id);
    expect(record).toBeTruthy();
    if (!record) {
      return;
    }
    record.workflow.ultimateGoal.confirmedAt = "2026-04-12T00:00:00.000Z";
    await service.setWorkflowMode(selected.record.id, "fast");

    await service.runRecommendation(selected.record.id, false);

    await waitFor(() => getProjectRecord(service, selected.record.id)?.agents.find((agent) => agent.category === "recommendation"));
    expect(transport.threadStarts.length).toBeGreaterThan(0);
  });

  it("blocks the workflow on a pending human intervention and clears the block when resolved", async () => {
    const root = await createSampleRepo("blocked-human");
    const appData = await createTempDir("appdata-blocked-human");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");

    await service.updateUltimateGoal(
      selected.record.id,
      {
        summary: "Build a safe workflow orchestrator foundation.",
        detailedIntent: "Move from manual dashboarding toward explicit loop state.",
        successCriteria: ["Workflow state is persisted."],
        constraints: ["Keep typed IPC intact."],
        nonGoals: ["Do not fake full autonomy."],
        targetAudience: "Developers maintaining the app.",
        qualityBar: "Production-grade and test-backed.",
        source: "user"
      },
      true
    );

    const intervention = await service.requestHumanIntervention(selected.record.id, {
      kind: "credentials",
      title: "Provide API credentials",
      description: "A third-party API key is required before validation can continue.",
      reason: "The integration cannot be exercised without credentials.",
      requestedByAgentCategory: "goal",
      severity: "high",
      blocking: true
    });

    expect(service.getState().projects.find((entry) => entry.record.id === selected.record.id)?.record.workflow.workflowStage).toBe("blocked_human");

    await service.resolveHumanIntervention(selected.record.id, intervention.id, "resolved", "Credentials were added locally.");

    const workflow = service.getState().projects.find((entry) => entry.record.id === selected.record.id)?.record.workflow;
    expect(workflow?.workflowStage).toBe("recommendation_pending");
    expect(workflow?.humanInterventions.find((entry) => entry.id === intervention.id)?.status).toBe("resolved");
  });

  it("surfaces structured user input requests with attachment staging and submits them back to the transport", async () => {
    const root = await createSampleRepo("user-input-request");
    const appData = await createTempDir("appdata-user-input-request");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    const project = getProjectRecord(service, selected.record.id);
    if (!project) {
      throw new Error("Project record missing after selection.");
    }
    const runtime = service as any;

    const agent = createAgentSkeleton("coding", "Coding Agent", "Wait for external setup", "gpt-test");
    agent.threadId = "thread-user-input";
    project.agents.unshift(agent);
    runtime.threadToAgent.set(agent.threadId, {
      projectId: selected.record.id,
      agentId: agent.id
    });

    const respond = vi.fn(async () => undefined);
    runtime.transport = {
      respond
    };

    await runtime.processTransportRequest({
      method: "item/tool/requestUserInput",
      id: "request-user-input-1",
      params: {
        threadId: agent.threadId,
        turnId: "turn-1",
        itemId: "item-1",
        questions: [
          {
            id: "api_key",
            header: "API key",
            question: "Create the vendor account and paste the API key.",
            isOther: false,
            isSecret: true,
            options: null
          },
          {
            id: "notes",
            header: "What you completed",
            question: "Describe where the credentials were added and anything else the agent should inspect.",
            isOther: true,
            isSecret: false,
            options: [
              {
                label: "Stored in .env.local",
                description: "The key is present in the local environment file."
              }
            ]
          }
        ]
      }
    });

    const userInputRequest = await waitFor(() => getProjectRecord(service, selected.record.id)?.userInputRequests[0]);
    expect(userInputRequest.title).toBe("API key");
    expect(userInputRequest.status).toBe("pending");
    expect(getProjectRecord(service, selected.record.id)?.workflow.workflowStage).toBe("blocked_human");

    const attachmentSourceDir = await createTempDir("user-input-attachment-source");
    const attachmentSource = path.join(attachmentSourceDir, "setup-notes.txt");
    await writeFile(attachmentSource, "created account and added API key locally\n", "utf8");

    await service.addUserInputRequestAttachments(selected.record.id, userInputRequest.id, [attachmentSource]);

    const updatedRequest = getProjectRecord(service, selected.record.id)?.userInputRequests.find((entry) => entry.id === userInputRequest.id);
    expect(updatedRequest?.attachments).toHaveLength(1);
    const stagedAttachmentPath = path.join(root, ...(updatedRequest?.attachments[0].relativePath.split("/") ?? []));
    expect((await readFile(stagedAttachmentPath, "utf8")).trim()).toBe("created account and added API key locally");

    await service.submitUserInputRequest(selected.record.id, userInputRequest.id, [
      "sk-test-123",
      "Stored in .env.local and ready for validation."
    ]);

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith("request-user-input-1", {
      answers: [
        "sk-test-123",
        expect.stringContaining(updatedRequest?.attachments[0].relativePath ?? "")
      ]
    });
    expect(getProjectRecord(service, selected.record.id)?.userInputRequests.find((entry) => entry.id === userInputRequest.id)?.status).toBe("submitted");
    expect(
      getProjectRecord(service, selected.record.id)?.workflow.humanInterventions.find((entry) => entry.linkedUserInputRequestId === userInputRequest.id)?.status
    ).toBe("resolved");
  });

  it("routes mid-run credential requests to Credentials and sends stored secrets only after explicit approval", async () => {
    const root = await createSampleRepo("credential-request-flow");
    const appData = await createTempDir("appdata-credential-request-flow");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    const project = getProjectRecord(service, selected.record.id);
    if (!project) {
      throw new Error("Project record missing after selection.");
    }
    const runtime = service as any;

    const agent = createAgentSkeleton("coding", "Coding Agent", "Need live data", "gpt-test");
    agent.threadId = "thread-credential-flow";
    project.agents.unshift(agent);
    runtime.threadToAgent.set(agent.threadId, {
      projectId: selected.record.id,
      agentId: agent.id
    });

    const respond = vi.fn(async () => undefined);
    runtime.transport = { respond };

    await runtime.processTransportRequest({
      method: "item/tool/requestUserInput",
      id: "request-credential-flow",
      params: {
        threadId: agent.threadId,
        turnId: "turn-1",
        itemId: "item-1",
        questions: [
          {
            id: "api_key",
            header: "Polygon.io API key",
            question: "Paste the free-tier Polygon.io API key. Do not use a paid plan.",
            isOther: false,
            isSecret: true,
            options: null
          },
          {
            id: "notes",
            header: "Credential notes",
            question: "Confirm this is a free/no-card API key.",
            isOther: true,
            isSecret: false,
            options: null
          }
        ]
      }
    });

    const afterRequest = getProjectRecord(service, selected.record.id);
    const credentialRequest = afterRequest?.credentials.requests[0];
    const userInputRequest = afterRequest?.userInputRequests[0];
    expect(afterRequest?.layout.activeCenterTab).toBe("credentials");
    expect(afterRequest?.workflow.workflowStage).toBe("blocked_human");
    expect(credentialRequest).toMatchObject({
      providerName: "Polygon.io",
      keyLabel: "API key",
      status: "pending",
      freeOnly: true,
      userInputRequestId: userInputRequest?.id
    });

    await service.saveCredentialEntry(selected.record.id, {
      providerName: "Polygon.io",
      keyLabel: "API key",
      apiKey: "free-polygon-key",
      notes: "Free tier, no card.",
      linkedRequestIds: [credentialRequest?.id ?? ""]
    });

    const storedRequest = getProjectRecord(service, selected.record.id)?.credentials.requests.find((entry) => entry.id === credentialRequest?.id);
    expect(storedRequest?.status).toBe("pending");
    expect(storedRequest?.notes).toContain("explicit approval");

    await service.submitCredentialRequestToAgent(selected.record.id, credentialRequest?.id ?? "");

    expect(respond).toHaveBeenCalledWith("request-credential-flow", {
      answers: [
        "free-polygon-key",
        expect.stringContaining("Credential approved from the local Credentials section")
      ]
    });
    const afterSubmit = getProjectRecord(service, selected.record.id);
    expect(afterSubmit?.credentials.requests.find((entry) => entry.id === credentialRequest?.id)?.status).toBe("fulfilled");
    expect(afterSubmit?.userInputRequests.find((entry) => entry.id === userInputRequest?.id)?.status).toBe("submitted");
    expect(afterSubmit?.workflow.humanInterventions.find((entry) => entry.linkedUserInputRequestId === userInputRequest?.id)?.status).toBe("resolved");
  });

  it("rejects paid credential requests when Consider Paid Services is off", async () => {
    const root = await createSampleRepo("paid-credential-rejected");
    const appData = await createTempDir("appdata-paid-credential-rejected");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    const project = getProjectRecord(service, selected.record.id);
    if (!project) {
      throw new Error("Project record missing after selection.");
    }
    const runtime = service as any;

    const agent = createAgentSkeleton("coding", "Coding Agent", "Need paid data", "gpt-test");
    agent.threadId = "thread-paid-credential";
    project.agents.unshift(agent);
    runtime.threadToAgent.set(agent.threadId, {
      projectId: selected.record.id,
      agentId: agent.id
    });

    const respond = vi.fn(async () => undefined);
    runtime.transport = { respond };

    await runtime.processTransportRequest({
      method: "item/tool/requestUserInput",
      id: "request-paid-credential",
      params: {
        threadId: agent.threadId,
        turnId: "turn-1",
        itemId: "item-1",
        questions: [
          {
            id: "api_key",
            header: "Premium market data API key",
            question: "Enter the paid subscription API key after setting up billing with a credit card.",
            isOther: false,
            isSecret: true,
            options: null
          }
        ]
      }
    });

    expect(respond).toHaveBeenCalledWith("request-paid-credential", {
      answers: [
        expect.stringContaining("Paid API services are disabled")
      ]
    });
    const record = getProjectRecord(service, selected.record.id);
    expect(record?.userInputRequests).toEqual([]);
    expect(record?.credentials.requests).toEqual([]);
    expect(record?.workflow.workflowStage).not.toBe("blocked_human");
  });

  it("persists the ultimate goal across service restarts", async () => {
    const root = await createSampleRepo("workflow-persistence");
    const appData = await createTempDir("appdata-workflow-persistence");
    const serviceA = await createService(appData);
    await serviceA.loadProject(root);
    const selected = await serviceA.selectPendingInterface("fresh");

    await serviceA.updateUltimateGoal(
      selected.record.id,
      {
        summary: "Persist the workflow charter.",
        detailedIntent: "Ensure the project remembers its charter across restarts.",
        successCriteria: ["The charter survives app restarts."],
        constraints: ["Keep persistence local and typed."],
        nonGoals: ["No remote storage."],
        targetAudience: "Developers using the desktop app.",
        qualityBar: "Durable and explicit.",
        source: "user"
      },
      true
    );
    await new Promise((resolve) => setTimeout(resolve, 80));

    const serviceB = await createService(appData);
    const project = serviceB.getState().projects.find((entry) => entry.record.id === selected.record.id);
    expect(project?.record.workflow.ultimateGoal.summary).toBe("Persist the workflow charter.");
    expect(project?.record.workflow.ultimateGoal.confirmedAt).toBeTruthy();
  });

  it("automatically generates recommendations after the Ultimate Goal is confirmed", async () => {
    const root = await createSampleRepo("auto-recommendations");
    const appData = await createTempDir("appdata-auto-recommendations");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");

    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");

    await service.updateUltimateGoal(
      selected.record.id,
      {
        summary: "Move the workflow toward minimal-input automation.",
        detailedIntent: "Generate recommendations automatically once the charter is confirmed.",
        successCriteria: ["Recommendations appear without an extra click."],
        constraints: ["Keep the workflow state typed and explicit."],
        nonGoals: ["Do not bypass approvals."],
        targetAudience: "Operators of the workflow tab.",
        qualityBar: "Clear, deterministic, and test-backed.",
        source: "user"
      },
      true
    );

    const workflow = await waitFor(() => {
      const candidate = getProjectRecord(service, selected.record.id)?.workflow;
      return candidate && candidate.recommendations.length > 0 ? candidate : null;
    });

    expect(workflow.workflowStage).toBe("recommendation_pending");
    expect(workflow.stepProgress.recommendation.status).toBe("waiting");
    expect(workflow.stepProgress.recommendation.requiresUserInput).toBe(true);
    expect(workflow.ultimateGoalProgress?.percentComplete).toBeGreaterThan(0);
    expect(workflow.ultimateGoalProgress?.source).toBe("recommendation");
    expect(workflow.ultimateGoalProgress?.rationale.length).toBeGreaterThan(10);
  });

  it("parses recommendation output from noisy concatenated JSON messages", async () => {
    const root = await createSampleRepo("noisy-recommendation-output");
    const appData = await createTempDir("appdata-noisy-recommendation-output");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    const project = (service as any).projects.get(selected.record.id);

    const validPayload = {
      summary: "The repository needs one bounded architecture slice next.",
      ultimateGoalProgress: {
        percentComplete: 48,
        rationale: "The workflow has evidence for some checks, but data-boundary work is still open."
      },
      ultimateGoalCompletion: {
        state: "needs_more_work",
        rationale: "Required checks remain open."
      },
      recommendations: [
        {
          title: "Add a local market-data adapter",
          summary: "Move deterministic candle fixtures behind a small shared adapter.",
          rationale: "A data-ingestion boundary makes the next analytics slices easier to verify.",
          expectedImpact: "This creates direct evidence for separating ingestion from analytics and rendering.",
          priority: "medium",
          confidence: 0.78,
          estimatedScope: "small",
          riskLevel: "low",
          relatedPaths: ["src/index.ts", "not-in-project.ts"]
        }
      ],
      goalCheckUpdates: [
        {
          action: "update",
          id: null,
          title: "Constraint preserved: data ingestion is separated from rendering",
          description: null,
          required: true,
          status: "met",
          confidence: 0.86,
          evidence: "src/index.ts is used as deterministic repository evidence in this regression test.",
          relatedPaths: ["src/index.ts"]
        }
      ]
    };
    const noisyOutput = [
      "Partial draft object that should be ignored:",
      "{\"summary\":\"partial\",\"recommendations\":[],\"ultimateGoalCompletion\":{\"state\":\"needs_more_work\",\"rationale\":\"Not enough data yet.\"}}",
      JSON.stringify(validPayload),
      "Trailing diagnostic object that should also be ignored:",
      "{\"note\":\"ignored\"}"
    ].join("\n");

    const parsed = (service as any).parseRecommendationOutput(project, noisyOutput);

    expect(parsed?.summary).toBe(validPayload.summary);
    expect(parsed?.ultimateGoalProgress?.percentComplete).toBe(48);
    expect(parsed?.recommendations).toHaveLength(1);
    expect(parsed?.recommendations[0]?.title).toBe("Add a local market-data adapter");
    expect(parsed?.recommendations[0]?.relatedPaths).toEqual(["src/index.ts"]);
    expect(parsed?.goalCheckUpdates[0]?.title).toContain("data ingestion");
  });

  it("retains checklist updates when model recommendations are filtered as too broad", async () => {
    const root = await createSampleRepo("filtered-recommendation-updates");
    const appData = await createTempDir("appdata-filtered-recommendation-updates");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    const project = (service as any).projects.get(selected.record.id);

    const payload = {
      summary: "The goal is not satisfied; direct charting evidence is still missing.",
      ultimateGoalProgress: {
        percentComplete: 42,
        rationale: "Required checklist items still need implementation evidence."
      },
      ultimateGoalCompletion: {
        state: "needs_more_work",
        rationale: "The checklist still has required unmet items."
      },
      recommendations: [
        {
          title: "Rebuild every analytics, charting, persistence, validation, and provider workflow in one pass",
          summary: "Touch renderer state, preload wiring, runtime orchestration, data ingestion, analytics computation, chart rendering, validation output, packaging, documentation, and all tests together.",
          rationale: "This option is intentionally too broad and should be filtered by the cycle guardrail.",
          expectedImpact: "The parser should keep the checklist updates and let deterministic fallback recommendations take over.",
          priority: "high",
          confidence: 0.8,
          estimatedScope: "large",
          riskLevel: "high",
          relatedPaths: [
            "src/index.ts",
            "package.json",
            "README.md",
            "src/runtime/appService.ts",
            "src/renderer/App.tsx",
            "src/preload/index.ts"
          ]
        }
      ],
      goalCheckUpdates: [
        {
          action: "update",
          id: null,
          title: "App displays price history with responsive interactive charts across multiple timeframes",
          description: null,
          required: true,
          status: "unmet",
          confidence: 0.91,
          evidence: "src/index.ts is the only inspected project file in this regression fixture, so chart evidence is still absent.",
          relatedPaths: ["src/index.ts"]
        }
      ]
    };

    const parsed = (service as any).parseRecommendationOutput(project, JSON.stringify(payload));

    expect(parsed?.summary).toBe(payload.summary);
    expect(parsed?.recommendations).toHaveLength(0);
    expect(parsed?.goalCheckUpdates).toHaveLength(1);
    expect(parsed?.goalCheckUpdates[0]?.status).toBe("unmet");
  });

  it("queues a final appeal recommendation set after a satisfied visual deliver goal", async () => {
    const root = await createSampleRepo("appeal-recommendations");
    await writeFile(path.join(root, "src/App.tsx"), "export function App() { return <main>Portfolio tracker</main>; }\n");
    await commitAll(root, "add visual app surface");
    const appData = await createTempDir("appdata-appeal-recommendations");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");

    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");

    const project = (service as any).projects.get(selected.record.id);
    const workflow = project.record.workflow;
    const appealGoal: UltimateGoal = {
      summary: "Build a portfolio tracker and analytics tool.",
      detailedIntent: "Deliver a usable visual app for tracking holdings, performance, and analytics.",
      successCriteria: ["The app is usable.", "The visible experience is credible."],
      constraints: [],
      nonGoals: [],
      targetAudience: "",
      qualityBar: "",
      source: "user",
      confirmedAt: "2026-04-19T00:00:00.000Z"
    };
    workflow.ultimateGoal = appealGoal;
    const metGoalCheckUpdates: GoalCheckUpdateInput[] = appealGoal.successCriteria.map((criterion) => ({
      title: criterion,
      status: "met",
      evidence: "The checked-in App.tsx provides a visible portfolio tracker surface for this appeal-flow test."
    }));
    workflow.goalChecklist = applyGoalChecklistUpdates(
      buildGoalChecklistFromUltimateGoal(appealGoal, [], "2026-04-19T00:00:00.000Z"),
      metGoalCheckUpdates,
      { timestamp: "2026-04-19T00:01:00.000Z" }
    );
    workflow.workflowCycle.status = "completed";
    workflow.ultimateGoalProgress = {
      percentComplete: 100,
      rationale: "The base app goal is satisfied before the final visual polish pass.",
      source: "deterministic",
      updatedAt: "2026-04-19T00:00:00.000Z"
    };
    workflow.ultimateGoalCompletion = {
      state: "goal_satisfied",
      rationale: "The base app goal is satisfied before the final visual polish pass.",
      source: "deterministic",
      updatedAt: "2026-04-19T00:00:00.000Z"
    };
    project.record.agents.push({
      ...createAgentSkeleton("integrity", "Integrity Agent", "Run deterministic validation.", "gpt-5.4"),
      workflowCycleNumber: workflow.workflowCycle.cycleNumber,
      status: "completed",
      completedAt: "2026-04-19T00:02:00.000Z",
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
        generatedAt: "2026-04-19T00:02:00.000Z"
      }
    });

    await service.runRecommendation(selected.record.id, true);

    const appealWorkflow = await waitFor(() => {
      const candidate = getProjectRecord(service, selected.record.id)?.workflow;
      return candidate?.appeal.status === "pending" && candidate.recommendations.length > 0 ? candidate : null;
    });

    expect(appealWorkflow.workflowStage).toBe("appeal_pending");
    expect(appealWorkflow.workflowStopReason).toBe("awaiting_appeal_approval");
    expect(appealWorkflow.recommendations[0]?.estimatedScope).toBe("small");
    expect(appealWorkflow.recommendations[0]?.title.toLowerCase()).toContain("polish");
  });

  it("autopilot picks a checklist-aligned recommendation and only stops at the next recommendation boundary when turned off", async () => {
    const root = await createSampleFolder("autopilot-boundary", {
      lint: "node -e \"setTimeout(() => process.exit(0), 120)\"",
      typecheck: "node -e \"setTimeout(() => process.exit(0), 120)\"",
      test: "node -e \"setTimeout(() => process.exit(0), 120)\"",
      build: "node -e \"setTimeout(() => process.exit(0), 120)\""
    });
    const appData = await createTempDir("appdata-autopilot-boundary");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");

    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");
    await service.updateUiState(selected.record.id, { autopilotEnabled: true });

    await service.updateUltimateGoal(
      selected.record.id,
      {
        summary: "Let the checklist runner continue until the next recommendation decision.",
        detailedIntent: "The runner should pick the most checklist-aligned next step, but turning it off should only affect the next recommendation boundary.",
        successCriteria: ["A recommendation is picked automatically.", "Turning the runner off does not interrupt the active cycle."],
        constraints: ["Keep the behavior persisted in project state."],
        nonGoals: ["Do not cancel work that is already running."],
        targetAudience: "Operators who want to switch between unattended and supervised execution.",
        qualityBar: "Explicit, predictable automation boundaries.",
        source: "user"
      },
      true
    );

    const autopilotApproved = await waitFor(() => {
      const workflow = getProjectRecord(service, selected.record.id)?.workflow;
      return workflow?.approvedRecommendation && workflow.recommendations.length > 0 ? workflow : null;
    }, 6_000);

    const checklistRecommendations = autopilotApproved.recommendations.filter((entry) =>
      /^Satisfy (?:work package|goal check):/.test(entry.title)
    );
    if (checklistRecommendations.length > 0) {
      expect(autopilotApproved.approvedRecommendation?.recommendationId).toBe(checklistRecommendations[0]?.id);
    } else {
      expect(autopilotApproved.approvedRecommendation?.confidence).toBe(
        Math.max(...autopilotApproved.recommendations.map((entry) => entry.confidence))
      );
    }

    await service.updateUiState(selected.record.id, { autopilotEnabled: false });

    const nextCycle = await waitFor(() => {
      const workflow = getProjectRecord(service, selected.record.id)?.workflow;
      return workflow &&
        workflow.workflowCycle.status === "completed" &&
        workflow.recommendations.length > 0
        ? workflow
        : null;
    }, 10_000);

    expect(getProjectRecord(service, selected.record.id)?.localState.autopilotEnabled).toBe(false);
    expect(nextCycle.workflowStage).toBe("recommendation_pending");
    expect(nextCycle.stepProgress.recommendation.requiresUserInput).toBe(true);
  }, 14_000);

  it("persists workflow pause requests and resumes when continue is triggered in a later session", async () => {
    const root = await createSampleFolder("pause-and-resume", {
      lint: "node -e \"setTimeout(() => process.exit(0), 120)\"",
      typecheck: "node -e \"setTimeout(() => process.exit(0), 120)\"",
      test: "node -e \"setTimeout(() => process.exit(0), 120)\"",
      build: "node -e \"setTimeout(() => process.exit(0), 120)\""
    });
    const appData = await createTempDir("appdata-pause-and-resume");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");

    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");

    await service.updateUltimateGoal(
      selected.record.id,
      {
        summary: "Pause the workflow after the current step and resume it later.",
        detailedIntent: "Pause should persist to disk so the next automatic step does not start until continue is pressed in a later session.",
        successCriteria: ["Pause is saved.", "Continue resumes the saved workflow state."],
        constraints: ["Do not cancel the step that is already running."],
        nonGoals: ["Do not require a fresh recommendation cycle."],
        targetAudience: "Operators who want to stop between automatic workflow steps.",
        qualityBar: "Persisted, explicit, and deterministic.",
        source: "user"
      },
      true
    );

    const recommendationId = await waitFor(() => getProjectRecord(service, selected.record.id)?.workflow.recommendations[0]?.id);
    await service.approveRecommendation(selected.record.id, recommendationId);

    await waitFor(() => {
      const workflow = getProjectRecord(service, selected.record.id)?.workflow;
      return workflow?.stepProgress.integrity.status === "running" ? workflow : null;
    }, 6_000);

    await service.updateUiState(selected.record.id, { workflowPauseRequested: true });

    const pausedRecord = await waitFor(() => {
      const record = getProjectRecord(service, selected.record.id);
      return record?.localState.workflowPauseRequested && record.workflow.stepProgress.merge.status === "waiting" ? record : null;
    }, 10_000);

    expect(pausedRecord.workflow.workflowStage).toBe("ready_to_merge");
    expect(pausedRecord.workflow.activityLog.some((event) => event.title === "Automation pause requested")).toBe(true);

    await service.dispose();

    const serviceB = await createService(appData);
    await serviceB.openProject(selected.record.id);
    await new Promise((resolve) => setTimeout(resolve, 250));

    const reopenedPausedRecord = getProjectRecord(serviceB, selected.record.id);
    expect(reopenedPausedRecord?.localState.workflowPauseRequested).toBe(true);
    expect(reopenedPausedRecord?.workflow.stepProgress.merge.status).toBe("waiting");

    await serviceB.updateUiState(selected.record.id, { workflowPauseRequested: false });

    const resumedWorkflow = await waitFor(() => {
      const workflow = getProjectRecord(serviceB, selected.record.id)?.workflow;
      return workflow?.stepProgress.merge.status === "completed" ? workflow : null;
    }, 10_000);

    expect(getProjectRecord(serviceB, selected.record.id)?.localState.workflowPauseRequested).toBe(false);
    expect(resumedWorkflow.activityLog.some((event) => event.title === "Workflow automation resumed")).toBe(true);
  }, 14_000);

  it("resumes goal planning from an approved recommendation waiting for scoping", async () => {
    const root = await createSampleFolder("pause-at-goal-plan", {
      lint: "node -e \"setTimeout(() => process.exit(0), 80)\"",
      typecheck: "node -e \"setTimeout(() => process.exit(0), 80)\"",
      test: "node -e \"setTimeout(() => process.exit(0), 80)\"",
      build: "node -e \"setTimeout(() => process.exit(0), 80)\""
    });
    const appData = await createTempDir("appdata-pause-at-goal-plan");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");

    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");

    await service.updateUltimateGoal(
      selected.record.id,
      {
        summary: "Resume cleanly from an approved recommendation.",
        detailedIntent: "Continuing a paused workflow should start the goal agent when the chosen recommendation has not been scoped yet.",
        successCriteria: ["The goal-plan step starts after continue."],
        constraints: ["Keep the saved recommendation decision intact."],
        nonGoals: ["Do not regenerate recommendations just to resume."],
        targetAudience: "Operators continuing a paused workflow cycle.",
        qualityBar: "The next step begins without an extra developer-control click.",
        source: "user"
      },
      true
    );

    const recommendationId = await waitFor(() => getProjectRecord(service, selected.record.id)?.workflow.recommendations[0]?.id);
    await service.updateUiState(selected.record.id, { workflowPauseRequested: true });
    await service.approveRecommendation(selected.record.id, recommendationId);

    const pausedAtGoalPlan = await waitFor(() => {
      const record = getProjectRecord(service, selected.record.id);
      return record?.localState.workflowPauseRequested &&
        record.workflow.approvedRecommendation &&
        !record.workflow.scopedGoal &&
        record.workflow.workflowStage === "recommendation_approved" &&
        record.workflow.stepProgress.goal_plan.status === "waiting"
        ? record
        : null;
    });
    expect(pausedAtGoalPlan.workflow.stepProgress.goal_plan.currentActivity).toBe("Queued for scoping");

    await service.dispose();

    const serviceB = await createService(appData);
    await serviceB.openProject(selected.record.id);
    expect(getProjectRecord(serviceB, selected.record.id)?.workflow.scopedGoal).toBeUndefined();

    await serviceB.updateUiState(selected.record.id, { workflowPauseRequested: false });

    const resumedWorkflow = await waitFor(() => {
      const workflow = getProjectRecord(serviceB, selected.record.id)?.workflow;
      return workflow?.scopedGoal ? workflow : null;
    }, 8_000);

    expect(resumedWorkflow.approvedRecommendation?.recommendationId).toBe(recommendationId);
    expect(resumedWorkflow.stepProgress.goal_plan.status).toBe("completed");
    expect(resumedWorkflow.activityLog.some((event) => event.title === "Workflow automation resumed")).toBe(true);
  }, 12_000);

  it("falls back to a deterministic scoped goal when goal-agent launch runs out of buffer", async () => {
    const root = await createSampleFolder("goal-plan-launch-allocation-fallback", {
      lint: "echo lint",
      typecheck: "echo typecheck",
      test: "echo test",
      build: "echo build"
    });
    const appData = await createTempDir("appdata-goal-plan-launch-allocation-fallback");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");

    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");
    await service.updateUltimateGoal(
      selected.record.id,
      {
        summary: "Keep workflow continuation resilient.",
        detailedIntent: "A transient app-server allocation failure while starting the goal agent should not strand the cycle after a recommendation is approved.",
        successCriteria: ["A fallback scoped goal is created after continue."],
        constraints: ["Preserve the approved recommendation decision."],
        nonGoals: ["Do not require a manual retry for goal planning."],
        targetAudience: "Operators running repeated workflow cycles.",
        qualityBar: "The cycle advances to a scoped goal with visible fallback evidence.",
        source: "user"
      },
      true
    );

    const recommendationId = await waitFor(() => getProjectRecord(service, selected.record.id)?.workflow.recommendations[0]?.id);
    await service.updateUiState(selected.record.id, { workflowPauseRequested: true });
    await service.approveRecommendation(selected.record.id, recommendationId);

    (service as unknown as { transport: MockCodexTransport }).transport = new FailingScopedGoalTransport();
    await service.updateUiState(selected.record.id, { workflowPauseRequested: false });

    const resumedWorkflow = await waitFor(() => {
      const workflow = getProjectRecord(service, selected.record.id)?.workflow;
      return workflow?.scopedGoal ? workflow : null;
    }, 8_000);

    expect(resumedWorkflow.approvedRecommendation?.recommendationId).toBe(recommendationId);
    expect(resumedWorkflow.scopedGoal?.sourceRecommendationId).toBe(recommendationId);
    expect(resumedWorkflow.activityLog.some((event) => event.title === "Goal agent launch failed; using fallback scoped plan")).toBe(true);
    expect(service.getState().diagnostics.some((entry) => entry.includes("Array buffer allocation failed"))).toBe(true);
  }, 12_000);

  it("recovers goal planning when a recoverable automation error escapes before an agent starts", async () => {
    const root = await createSampleFolder("goal-plan-outer-error-fallback", {
      lint: "echo lint",
      typecheck: "echo typecheck",
      test: "echo test",
      build: "echo build"
    });
    const appData = await createTempDir("appdata-goal-plan-outer-error-fallback");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");

    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");
    await service.updateUltimateGoal(
      selected.record.id,
      {
        summary: "Recover escaped automation failures.",
        detailedIntent: "A recoverable runtime failure should not leave an approved recommendation stranded before goal planning creates a scoped goal.",
        successCriteria: ["A deterministic scoped goal is created without a manual retry."],
        constraints: ["Keep the approved recommendation intact."],
        nonGoals: ["Do not regenerate recommendations after the recommendation was approved."],
        targetAudience: "Operators using autopilot.",
        qualityBar: "Autopilot should continue from durable workflow state.",
        source: "user"
      },
      true
    );

    const recommendationId = await waitFor(() => getProjectRecord(service, selected.record.id)?.workflow.recommendations[0]?.id);
    await service.updateUiState(selected.record.id, { workflowPauseRequested: true });
    await service.approveRecommendation(selected.record.id, recommendationId);

    service.createScopedGoal = async () => {
      throw new Error("Array buffer allocation failed");
    };

    await service.updateUiState(selected.record.id, { workflowPauseRequested: false });

    const recoveredWorkflow = await waitFor(() => {
      const workflow = getProjectRecord(service, selected.record.id)?.workflow;
      return workflow?.scopedGoal ? workflow : null;
    }, 8_000);

    expect(recoveredWorkflow.approvedRecommendation?.recommendationId).toBe(recommendationId);
    expect(recoveredWorkflow.scopedGoal?.sourceRecommendationId).toBe(recommendationId);
    expect(recoveredWorkflow.activityLog.some((event) => event.title === "Goal planning recovered with fallback")).toBe(true);
  }, 12_000);

  it("rechecks stale satisfied goal evidence and regenerates checklist recommendations after continue", async () => {
    const root = await createSampleFolder("resume-stale-satisfied-goal", {
      lint: "echo lint",
      typecheck: "echo typecheck",
      test: "echo test",
      build: "echo build"
    });
    const appData = await createTempDir("appdata-resume-stale-satisfied-goal");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");

    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");
    await service.updateUiState(selected.record.id, { workflowPauseRequested: true });

    const targetCriterion = "Recommendations appear without an extra click.";
    await service.updateUltimateGoal(
      selected.record.id,
      {
        summary: "Move the workflow toward minimal-input automation.",
        detailedIntent: "Generate recommendations automatically once the charter is confirmed.",
        successCriteria: [targetCriterion],
        constraints: [],
        nonGoals: ["Do not bypass approvals."],
        targetAudience: "Operators of the workflow tab.",
        qualityBar: "",
        source: "user"
      },
      true
    );

    const record = getProjectRecord(service, selected.record.id);
    expect(record).toBeTruthy();
    if (!record) {
      throw new Error("Expected project record.");
    }

    const staleTimestamp = "2026-04-20T00:00:00.000Z";
    const staleEvidence = "Cycle 30 completed after deterministic validation and integration. Scoped goal: Smallest viable slice: stabilize package/startup-readiness work.";
    record.workflow.goalChecklist = applyGoalChecklistUpdates(
      buildGoalChecklistFromUltimateGoal(record.workflow.ultimateGoal, record.workflow.goalChecklist, staleTimestamp),
      [{
        title: targetCriterion,
        status: "met",
        confidence: 0.95,
        evidence: staleEvidence,
        relatedPaths: ["package.json"]
      }],
      { timestamp: staleTimestamp }
    );
    record.workflow.workflowCycle.status = "completed";
    record.workflow.workflowStage = "cycle_complete";
    record.workflow.workflowStopReason = "ultimate_goal_satisfied";
    record.workflow.recommendations = [];
    record.workflow.recommendationsGeneratedAt = undefined;
    record.workflow.approvedRecommendation = undefined;
    record.workflow.scopedGoal = undefined;
    record.workflow.appeal = {
      status: "not_applicable",
      reason: "The stale saved state treated the goal as complete.",
      completedAt: staleTimestamp
    };
    record.workflow.ultimateGoalProgress = {
      percentComplete: 100,
      rationale: "Stale saved state treated all checks as complete.",
      source: "deterministic",
      updatedAt: staleTimestamp
    };
    record.workflow.ultimateGoalCompletion = {
      state: "goal_satisfied",
      rationale: "Stale saved state treated all checks as complete.",
      source: "deterministic",
      updatedAt: staleTimestamp
    };
    record.workflow.stepProgress.recommendation = {
      ...record.workflow.stepProgress.recommendation,
      status: "completed",
      requiresUserInput: false,
      completedAt: staleTimestamp,
      updatedAt: staleTimestamp,
      currentActivity: "No next cycle required"
    };
    await service.updateUiState(selected.record.id, { treeFilter: "stale-satisfied-goal" });
    await service.dispose();

    const serviceB = await createService(appData);
    await serviceB.openProject(selected.record.id);

    const reopened = getProjectRecord(serviceB, selected.record.id);
    const reopenedTargetCheck = reopened?.workflow.goalChecklist.find((check) => check.title === targetCriterion);
    expect(reopened?.localState.workflowPauseRequested).toBe(true);
    expect(reopenedTargetCheck?.status).toBe("unknown");
    expect(reopened?.workflow.ultimateGoalCompletion?.state).toBe("needs_more_work");

    await serviceB.updateUiState(selected.record.id, { workflowPauseRequested: false });

    const resumedWorkflow = await waitFor(() => {
      const workflow = getProjectRecord(serviceB, selected.record.id)?.workflow;
      return workflow?.recommendations.some((recommendation) => recommendation.title.includes(targetCriterion))
        ? workflow
        : null;
    }, 6_000);

    expect(resumedWorkflow.recommendations[0]?.title).toBe(`Satisfy goal check: ${targetCriterion}`);
    expect(resumedWorkflow.ultimateGoalCompletion?.state).toBe("needs_more_work");
    expect(resumedWorkflow.activityLog.some((event) => event.title === "Goal checklist evidence refreshed")).toBe(true);
  }, 10_000);

  it("recovers an interrupted coding run from the saved scoped goal", async () => {
    const root = await createSampleFolder("recover-interrupted-coding");
    const appData = await createTempDir("appdata-recover-interrupted-coding");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");

    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");
    await service.updateUltimateGoal(
      selected.record.id,
      {
        summary: "Recover interrupted workflow work from durable decisions.",
        detailedIntent: "The workflow should restart from the saved recommendation and scoped goal if a coding agent is interrupted.",
        successCriteria: ["The interrupted agent is marked disconnected.", "A fresh coding pass starts from the saved scoped goal."],
        constraints: ["Do not require a new recommendation."],
        nonGoals: ["Do not keep waiting on a stale app-server request."],
        targetAudience: "Operators recovering from laptop or network interruptions.",
        qualityBar: "Explicit, persisted, and restartable.",
        source: "user"
      },
      true
    );

    const recommendationId = await waitFor(() => getProjectRecord(service, selected.record.id)?.workflow.recommendations[0]?.id);
    await service.updateUiState(selected.record.id, { workflowPauseRequested: true });
    await service.approveRecommendation(selected.record.id, recommendationId);
    await service.createScopedGoal(selected.record.id);
    await waitFor(() => getProjectRecord(service, selected.record.id)?.workflow.scopedGoal);

    const record = getProjectRecord(service, selected.record.id);
    expect(record).toBeTruthy();
    const interruptedAgent = createAgentSkeleton("coding", "Interrupted Coding Pass", "Implement the saved scoped goal.", "gpt-5.4-mini");
    interruptedAgent.workflowCycleNumber = record?.workflow.workflowCycle.cycleNumber;
    interruptedAgent.status = "running";
    interruptedAgent.startedAt = new Date().toISOString();
    interruptedAgent.threadId = "lost-coding-thread";
    interruptedAgent.currentPhase = "Turn running";
    record?.agents.unshift(interruptedAgent);
    if (record) {
      record.workflow.stepProgress.coding = {
        ...record.workflow.stepProgress.coding,
        status: "running",
        startedAt: interruptedAgent.startedAt,
        updatedAt: interruptedAgent.startedAt,
        currentActivity: "Interrupted coding run",
        agentCategory: "coding"
      };
    }

    service.recoverWorkflow(selected.record.id);

    const recovered = await waitFor(() => {
      const nextRecord = getProjectRecord(service, selected.record.id);
      const codingAgents = nextRecord?.agents.filter((agent) => agent.category === "coding") ?? [];
      const replacement = codingAgents.find((agent) => agent.id !== interruptedAgent.id && agent.name.startsWith("Coding Pass"));
      return nextRecord && replacement ? { record: nextRecord, replacement } : null;
    }, 6_000);

    expect(recovered.record.agents.find((agent) => agent.id === interruptedAgent.id)?.status).toBe("disconnected");
    expect(recovered.record.agents.find((agent) => agent.id === interruptedAgent.id)?.recoveryHandledAt).toBeTruthy();
    expect(recovered.record.localState.workflowPauseRequested).toBe(false);
    expect(recovered.record.workflow.activityLog.some((event) => event.title === "Workflow recovery point prepared")).toBe(true);
    expect(recovered.replacement.workflowCycleNumber).toBe(recovered.record.workflow.workflowCycle.cycleNumber);
  }, 10_000);

  it("marks an explicitly targeted goal check met after a validated cycle", async () => {
    const root = await createSampleFolder("goal-check-cycle", {
      lint: "echo lint",
      typecheck: "echo typecheck",
      test: "echo test",
      build: "echo build"
    });
    const appData = await createTempDir("appdata-goal-check-cycle");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");

    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");
    await service.updateUiState(selected.record.id, { workflowPauseRequested: true });
    const targetCriterion = "Targeted workflow recovery progress is reflected in the goal checklist.";
    await service.updateUltimateGoal(
      selected.record.id,
      {
        summary: "Make workflow progress visible and durable.",
        detailedIntent: "A successful scoped cycle should advance the exact goal-check recommendation it completed.",
        successCriteria: [targetCriterion],
        constraints: [],
        nonGoals: ["Do not rely on a later recommendation pass to show cycle progress."],
        targetAudience: "Operators watching a resumed workflow.",
        qualityBar: "",
        source: "user"
      },
      true
    );

    const record = getProjectRecord(service, selected.record.id);
    expect(record).toBeTruthy();
    if (!record) {
      throw new Error("Expected project record.");
    }
    record.workflow.recommendations = [{
      id: "target-rec",
      rank: 1,
      title: `Satisfy goal check: ${targetCriterion}`,
      summary: `Gather implementation and validation evidence for this required check: ${targetCriterion}`,
      rationale: "The workflow should burn down the explicit required checklist item.",
      expectedImpact: "The Ultimate Goal percentage should move when the validated cycle closes this check.",
      priority: "high",
      confidence: 0.96,
      estimatedScope: "small",
      riskLevel: "low",
      relatedPaths: ["src/index.ts"]
    }];
    record.workflow.recommendationsGeneratedAt = new Date().toISOString();

    await service.updateUiState(selected.record.id, { workflowPauseRequested: true });
    await service.approveRecommendation(selected.record.id, "target-rec");
    await service.createScopedGoal(selected.record.id);
    const scopedRecord = await waitFor(() => {
      const nextRecord = getProjectRecord(service, selected.record.id);
      return nextRecord?.workflow.scopedGoal ? nextRecord : null;
    }, 4_000);

    const completedAt = new Date().toISOString();
    const codingAgent = createAgentSkeleton("coding", "Coding Pass 1", "Implement the targeted criterion.", "gpt-5.4-mini");
    codingAgent.workflowCycleNumber = scopedRecord.workflow.workflowCycle.cycleNumber;
    codingAgent.status = "completed";
    codingAgent.startedAt = completedAt;
    codingAgent.completedAt = completedAt;
    codingAgent.changedFiles = ["src/index.ts"];
    scopedRecord.agents.unshift(codingAgent);
    scopedRecord.workflow.stepProgress.coding = {
      ...scopedRecord.workflow.stepProgress.coding,
      status: "completed",
      startedAt: completedAt,
      updatedAt: completedAt,
      completedAt,
      currentActivity: "Coding complete",
      agentCategory: "coding"
    };

    await service.runIntegrity(selected.record.id);
    await service.runMerge(selected.record.id);
    await service.advanceWorkflowStage(selected.record.id);

    const completed = getProjectRecord(service, selected.record.id)?.workflow;
    const targetCheck = completed?.goalChecklist.find((check) => check.title === targetCriterion);
    expect(targetCheck?.status).toBe("met");
    expect(targetCheck?.evidence).toContain("deterministic validation and integration");
    expect(completed?.ultimateGoalProgress?.percentComplete).toBe(100);
    expect(completed?.ultimateGoalCompletion?.state).toBe("goal_satisfied");
  }, 12_000);

  it("upgrades a plain folder into a git project and auto-advances the cycle after recommendation approval", async () => {
    const root = await createSampleFolder("auto-folder-cycle");
    const appData = await createTempDir("appdata-auto-folder-cycle");
    const service = await createService(appData);
    const loadResult = await service.loadProject(root, "create");

    expect(loadResult.identity.kind).toBe("git");
    expect(loadResult.validation.projectKind).toBe("git");

    const selected = await service.selectPendingInterface("fresh");
    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");

    await service.updateUltimateGoal(
      selected.record.id,
      {
        summary: "Make the workflow work safely for any project folder.",
        detailedIntent: "New folders should be upgraded into Git and still move through the recommendation, coding, validation, and finalization loop.",
        successCriteria: ["A freshly initialized project can complete a cycle."],
        constraints: ["Keep all writes inside the selected folder."],
        nonGoals: ["Do not require users to initialize Git manually first."],
        targetAudience: "Users opening ordinary folders as projects.",
        qualityBar: "Safe and understandable automation.",
        source: "user"
      },
      true
    );

    const recommendationId = await waitFor(() => getProjectRecord(service, selected.record.id)?.workflow.recommendations[0]?.id);
    await service.approveRecommendation(selected.record.id, recommendationId);

    const workflow = await waitFor(() => {
      const candidate = getProjectRecord(service, selected.record.id)?.workflow;
      return candidate &&
        candidate.workflowStage === "recommendation_pending" &&
        candidate.workflowCycle.status === "completed" &&
        candidate.recommendations.length > 0
        ? candidate
        : null;
    }, 6_000);

    const mergeAgent = getProjectRecord(service, selected.record.id)?.agents.find((agent) => agent.category === "merge");
    expect(workflow.workflowStage).toBe("recommendation_pending");
    expect(workflow.memory.perCycleSummaries.length).toBeGreaterThan(0);
    expect(mergeAgent?.mergeReport?.summary).toContain("merged cleanly");
  }, 10_000);

  it("runs repair loops automatically and pauses when the repair budget is exhausted", async () => {
    const root = await createSampleFolder("repair-budget", {
      lint: "node -e \"process.exit(1)\""
    });
    const appData = await createTempDir("appdata-repair-budget");
    const service = await createService(appData);
    await service.updateSettings({
      maxRepairCycles: 2
    });
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");

    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");

    await service.updateUltimateGoal(
      selected.record.id,
      {
        summary: "Exercise the repair loop safely.",
        detailedIntent: "The workflow should retry failed validation until the configured repair budget is exhausted.",
        successCriteria: ["Repair passes happen automatically.", "The workflow pauses when the budget is spent."],
        constraints: ["Do not continue indefinitely."],
        nonGoals: ["Do not hide failed validation."],
        targetAudience: "Developers relying on automatic workflow retries.",
        qualityBar: "Explicit failure state with deterministic retries.",
        source: "user"
      },
      true
    );

    const recommendationId = await waitFor(() => getProjectRecord(service, selected.record.id)?.workflow.recommendations[0]?.id);
    await service.approveRecommendation(selected.record.id, recommendationId);

    const workflow = await waitFor(() => {
      const candidate = getProjectRecord(service, selected.record.id)?.workflow;
      return candidate?.workflowStopReason === "repair_budget_exhausted" ? candidate : null;
    }, 8_000);

    expect(workflow.workflowStage).toBe("repair_loop");
    expect(workflow.repairLoopCount).toBe(2);
    expect(workflow.repair.status).toBe("exhausted");
    expect(workflow.repair.attemptCount).toBe(workflow.repair.maxAttempts);
    expect(workflow.manualHandoff?.reason).toBe("repair_exhausted");
    expect(workflow.activityLog.some((event) => event.title === "Automatic repair exhausted")).toBe(true);
    expect(workflow.stepProgress.integrity.status).toBe("failed");
    expect(workflow.stepProgress.integrity.warning).toContain("configured limit");
    const codingAgents = getProjectRecord(service, selected.record.id)?.agents.filter((agent) => agent.category === "coding") ?? [];
    expect(codingAgents).toHaveLength(3);
    expect(codingAgents[0]?.taskPrompt).toContain("Latest failure reason:");
    expect(codingAgents[0]?.taskPrompt).toContain("Repair history:");
    expect(codingAgents[0]?.taskPrompt).toContain("Repair strategy for this attempt:");
  }, 10_000);

  it("retries the current scoped goal manually after repair exhaustion", async () => {
    const root = await createSampleFolder("manual-retry-after-exhaustion", {
      lint: "node -e \"setTimeout(() => process.exit(1), 150)\""
    });
    const appData = await createTempDir("appdata-manual-retry-after-exhaustion");
    const service = await createService(appData);
    await service.updateSettings({
      maxRepairCycles: 2
    });
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");

    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");

    await service.updateUltimateGoal(
      selected.record.id,
      {
        summary: "Allow an explicit retry after automatic repair gives up.",
        detailedIntent: "An operator should be able to rerun the same scoped goal without editing settings first.",
        successCriteria: ["Manual retry clears the exhausted state.", "The same scoped goal starts another coding pass."],
        constraints: ["Keep the retry explicit and persisted in workflow state."],
        nonGoals: ["Do not silently bypass repair exhaustion."],
        targetAudience: "Operators recovering from exhausted repair loops.",
        qualityBar: "Clear, state-backed, and deterministic.",
        source: "user"
      },
      true
    );

    const recommendationId = await waitFor(() => getProjectRecord(service, selected.record.id)?.workflow.recommendations[0]?.id);
    await service.approveRecommendation(selected.record.id, recommendationId);

    await waitFor(() => {
      const workflow = getProjectRecord(service, selected.record.id)?.workflow;
      return workflow?.repair.status === "exhausted" ? workflow : null;
    }, 10_000);

    const previousCodingAgentCount = getProjectRecord(service, selected.record.id)?.agents.filter((agent) => agent.category === "coding").length ?? 0;
    await service.retryWorkflowGoal(selected.record.id);

    const retriedWorkflow = await waitFor(() => {
      const record = getProjectRecord(service, selected.record.id);
      const codingAgentCount = record?.agents.filter((agent) => agent.category === "coding").length ?? 0;
      return record && codingAgentCount > previousCodingAgentCount ? record.workflow : null;
    }, 8_000);

    expect(retriedWorkflow.manualHandoff).toBeUndefined();
    expect(retriedWorkflow.repair.status).not.toBe("exhausted");
    expect(retriedWorkflow.activityLog.some((event) => event.title === "Manual retry requested")).toBe(true);
  }, 12_000);

  it("retries validation instead of coding after an environment blocker is resolved externally", async () => {
    const root = await createSampleProject("manual-env-validation-retry", "git", {
      typecheck: "node -e \"const fs = require('fs'); process.exit(fs.existsSync('src/external-fix.ts') ? 0 : 1)\""
    });
    const appData = await createTempDir("appdata-manual-env-validation-retry");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    const project = (service as any).projects.get(selected.record.id);
    const workflow = project.record.workflow;
    const environmentFailureReason = "Integrity hit an environment or dependency blocker that a repair coding pass is unlikely to fix. Stop retrying and resolve the validation environment first.";

    workflow.ultimateGoal = {
      ...workflow.ultimateGoal,
      summary: "Recover from an integrity environment blocker.",
      confirmedAt: "2026-04-12T00:00:00.000Z"
    };
    workflow.scopedGoal = {
      id: "scoped-goal-env-retry",
      sourceRecommendationId: "rec-env-retry",
      summary: "Validate the externally fixed checkout.",
      executionBrief: "Retry validation without launching another coding pass.",
      acceptanceCriteria: [],
      constraints: [],
      testStrategy: ["Run typecheck after the environment is fixed."],
      createdAt: "2026-04-12T00:00:00.000Z"
    };
    workflow.approvedRecommendation = {
      id: "approved-env-retry",
      recommendationId: "rec-env-retry",
      rank: 1,
      title: "Validate the externally fixed checkout.",
      summary: "Retry validation after the environment blocker is resolved.",
      rationale: "The coding work should not be repeated for an environment-only failure.",
      expectedImpact: "The workflow can continue from the current validated state.",
      priority: "high",
      confidence: 0.9,
      estimatedScope: "small",
      riskLevel: "low",
      relatedPaths: ["package.json"],
      approvedAt: "2026-04-12T00:00:00.000Z"
    };

    await execFileAsync("git", ["checkout", "-b", "feature-a"], { cwd: root });
    await writeFile(path.join(root, "src/workbench-branch.ts"), "export const workbenchBranch = true;\n");
    await commitAll(root, "workbench branch");
    await execFileAsync("git", ["checkout", "main"], { cwd: root });

    project.record.agents.push({
      ...createAgentSkeleton("coding", "Coding Pass 1", "Initial implementation.", "gpt-5.4"),
      workflowCycleNumber: workflow.workflowCycle.cycleNumber,
      status: "completed",
      completedAt: "2026-04-12T00:01:00.000Z",
      changedFiles: ["src/workbench-branch.ts"],
      worktree: { baseDir: appData, worktreePath: root, branch: "feature-a", targetBranch: "main" }
    });

    workflow.workflowStage = "repair_loop";
    workflow.workflowStopReason = "repair_stopped_early";
    workflow.stepProgress.coding.status = "completed";
    workflow.stepProgress.integrity.status = "failed";
    workflow.repair = {
      attemptCount: 0,
      maxAttempts: 5,
      status: "exhausted",
      latestIssueSummary: "Validation could not run npm.",
      latestFailureReason: environmentFailureReason,
      lastUpdatedAt: "2026-04-12T00:02:00.000Z"
    };
    workflow.manualHandoff = {
      reason: "repair_stopped_early",
      title: "Automatic repair stopped early",
      whatSystemWasTryingToDo: "Validate the current scoped goal.",
      validationIssue: "Validation could not run npm.",
      latestFailureReason: environmentFailureReason,
      involvedPaths: ["package.json"],
      shellSupported: true,
      createdAt: "2026-04-12T00:02:00.000Z"
    };

    await writeFile(path.join(root, "src/external-fix.ts"), "export const externalFix = true;\n");
    await commitAll(root, "external fix");

    const previousCodingAgentCount = project.record.agents.filter((agent: any) => agent.category === "coding").length;
    await service.retryWorkflowGoal(selected.record.id);

    const record = await waitFor(() => {
      const candidate = getProjectRecord(service, selected.record.id);
      const integrityAgent = candidate?.agents.find((agent) => agent.category === "integrity");
      return integrityAgent?.status === "completed" ? candidate : null;
    }, 8_000);

    const codingAgentCount = record.agents.filter((agent) => agent.category === "coding").length;
    const integrityAgent = record.agents.find((agent) => agent.category === "integrity");
    expect(codingAgentCount).toBe(previousCodingAgentCount);
    expect(record.workflow.activityLog.some((event) => event.title === "Manual validation retry requested")).toBe(true);
    expect(record.workflow.manualHandoff).toBeUndefined();
    expect(integrityAgent?.worktree).toBeUndefined();
    expect(integrityAgent?.integrityReport?.checks[0]).toMatchObject({
      name: "typecheck",
      status: "passed"
    });
  }, 12_000);

  it("continues the repair workflow when the max repair cycle limit increases mid-run", async () => {
    const root = await createSampleFolder("repair-limit-live-update", {
      lint: "node -e \"process.exit(1)\""
    });
    const appData = await createTempDir("appdata-repair-limit-live-update");
    const service = await createService(appData);
    await service.updateSettings({
      maxRepairCycles: 1
    });
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");

    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");

    await service.updateUltimateGoal(
      selected.record.id,
      {
        summary: "Exercise live repair-limit updates safely.",
        detailedIntent: "The workflow should keep using the latest configured repair limit while an automatic run is active.",
        successCriteria: ["The workflow resumes when the repair limit is raised."],
        constraints: ["Keep the repair state explicit and persisted."],
        nonGoals: ["Do not rely on a renderer-only toggle."],
        targetAudience: "Developers relying on unattended repair loops.",
        qualityBar: "State-backed and deterministic.",
        source: "user"
      },
      true
    );

    const recommendationId = await waitFor(() => getProjectRecord(service, selected.record.id)?.workflow.recommendations[0]?.id);
    await service.approveRecommendation(selected.record.id, recommendationId);

    await waitFor(() => {
      const workflow = getProjectRecord(service, selected.record.id)?.workflow;
      return workflow?.repair.status === "exhausted" && workflow.repair.attemptCount === 1 ? workflow : null;
    }, 8_000);

    await service.updateSettings({
      maxRepairCycles: 2
    });

    const workflow = await waitFor(() => {
      const candidate = getProjectRecord(service, selected.record.id)?.workflow;
      return candidate?.repair.status === "exhausted" && candidate.repair.attemptCount === 2 ? candidate : null;
    }, 8_000);

    expect(workflow.repair.maxAttempts).toBe(2);
    expect(workflow.activityLog.some((event) => event.title === "Automatic repair resumed")).toBe(true);
    const codingAgents = getProjectRecord(service, selected.record.id)?.agents.filter((agent) => agent.category === "coding") ?? [];
    expect(codingAgents).toHaveLength(3);
  }, 12_000);

  it("resumes a saved budget-exhausted workflow on reopen when the repair limit is higher", async () => {
    const root = await createSampleFolder("repair-limit-reopen", {
      lint: "node -e \"process.exit(1)\""
    });
    const appData = await createTempDir("appdata-repair-limit-reopen");
    const service = await createService(appData);
    await service.updateSettings({
      maxRepairCycles: 1
    });
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");

    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");

    await service.updateUltimateGoal(
      selected.record.id,
      {
        summary: "Recover a saved repair loop after the configured limit increases.",
        detailedIntent: "A reopened workflow should continue with the next repair attempt instead of staying stranded in an exhausted state.",
        successCriteria: ["The saved workflow resumes automatically.", "The next repair pass uses the next attempt number."],
        constraints: ["Keep the persisted workflow state authoritative."],
        nonGoals: ["Do not restart the workflow from scratch."],
        targetAudience: "Developers reopening a partially repaired project.",
        qualityBar: "Stateful and token-efficient.",
        source: "user"
      },
      true
    );

    const recommendationId = await waitFor(() => getProjectRecord(service, selected.record.id)?.workflow.recommendations[0]?.id);
    await service.approveRecommendation(selected.record.id, recommendationId);

    await waitFor(() => {
      const workflow = getProjectRecord(service, selected.record.id)?.workflow;
      return workflow?.repair.status === "exhausted" && workflow.repair.attemptCount === 1 ? workflow : null;
    }, 8_000);
    await service.updateUiState(selected.record.id, {});

    const reopenedService = new AppService(appData);
    createdServices.add(reopenedService);
    await reopenedService.initialize();
    await reopenedService.updateSettings({
      maxRepairCycles: 2
    });
    await reopenedService.loadProject(root, "create");
    const reopened = await reopenedService.selectPendingInterface("local");

    let lastResumeState = "workflow not observed";
    const resumedWorkflow = await waitFor(() => {
      const record = getProjectRecord(reopenedService, reopened.record.id);
      const codingAgentCount = record?.agents.filter((agent) => agent.category === "coding" && agent.status !== "disconnected").length ?? 0;
      const workflow = record?.workflow;
      lastResumeState = JSON.stringify({
        repair: workflow?.repair,
        codingAgentCount,
        agentStatuses: record?.agents.map((agent) => ({ category: agent.category, status: agent.status })),
        latestActivity: workflow?.activityLog.slice(-5).map((event) => ({ title: event.title, status: event.status }))
      });
      return workflow?.repair.status === "exhausted" && workflow.repair.attemptCount === 2 && codingAgentCount === 3
        ? workflow
        : null;
    }, 40_000).catch((error) => {
      throw new Error(`${error instanceof Error ? error.message : String(error)} Last observed state: ${lastResumeState}`);
    });

    expect(resumedWorkflow.repair.maxAttempts).toBe(2);
    expect(resumedWorkflow.activityLog.some((event) => event.title === "Automatic repair resumed")).toBe(true);
  }, 48_000);

  it("imports an Ultimate Goal from a text file for review before confirmation", async () => {
    const root = await createSampleRepo("goal-import");
    const appData = await createTempDir("appdata-goal-import");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");

    const importPath = path.join(root, "goal-import.txt");
    await writeFile(importPath, [
      "Project Charter: Build a durable workflow dashboard.",
      "Detailed Intent:\nCoordinate repo analysis, planning, coding, and validation in one explicit loop.",
      "Success Criteria:\n- Recommendations are persisted.\n- Repair loops are visible.",
      "Constraints:\n- Keep typed IPC.\n- Keep the renderer sandboxed.",
      "Non-goals:\n- No raw filesystem access from the renderer.",
      "Quality Bar: Stable, test-backed behavior.",
      "Target Audience: Developers operating the desktop app."
    ].join("\n\n"));

    const preview = await service.importUltimateGoalText(selected.record.id, importPath);

    expect(preview.completeness).toBe("complete");
    expect(preview.goal.summary).toBe("Build a durable workflow dashboard.");
    expect(preview.goal.constraints).toContain("Keep typed IPC.");
    expect(preview.missingFields).toEqual([]);
  });

  it("rejects interface export and import paths that escape the active project folder", async () => {
    const root = await createSampleRepo("interface-boundary");
    const appData = await createTempDir("appdata-interface-boundary");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");

    const outsidePath = path.join(path.dirname(root), "outside-interface.json");
    await writeFile(outsidePath, "{}\n");

    await expect(service.exportInterface(selected.record.id, outsidePath)).rejects.toThrow("outside the active project folder");
    await expect(service.importInterface(root, outsidePath)).rejects.toThrow("outside the active project folder");
  });

  it("refreshes the overview against the latest repository scan", async () => {
    const root = await createSampleRepo("overview-refresh");
    const appData = await createTempDir("appdata-overview-refresh");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");

    const beforeIncludedFiles = getProjectRecord(service, selected.record.id)?.stats?.includedFiles ?? 0;
    expect(beforeIncludedFiles).toBeGreaterThan(0);

    await writeFile(path.join(root, "src/feature.ts"), "export const feature = 'refreshed';\n");
    await service.refreshOverview(selected.record.id);
    await waitFor(() => {
      const record = getProjectRecord(service, selected.record.id);
      return record?.interfaceCreation?.status === "completed" && (record.stats?.includedFiles ?? 0) > beforeIncludedFiles;
    });

    const refreshed = getProjectRecord(service, selected.record.id);
    expect(refreshed?.stats?.includedFiles).toBeGreaterThan(beforeIncludedFiles);
    expect(refreshed?.summaryCache.length).toBeGreaterThan(0);
    expect(refreshed?.interfaceCreation?.message).toBeTruthy();
  });

  it("auto-rejects approval requests that target paths outside the active project folder", async () => {
    const root = await createSampleFolder("approval-boundary");
    const appData = await createTempDir("appdata-approval-boundary");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");

    const agent = await service.createAgent(selected.record.id, "coding", "Coding Agent", "Touch the project files safely.", "gpt-5.4");

    (service as unknown as { handleTransportRequest: (request: unknown) => void }).handleTransportRequest({
      method: "item/commandExecution/requestApproval",
      id: "unsafe-approval",
      params: {
        threadId: agent.threadId,
        turnId: "turn-1",
        itemId: "item-1",
        command: "touch /tmp/outside",
        cwd: path.join(root, ".."),
        reason: "Attempt an unsafe write"
      }
    });

    const approval = await waitFor(() => getProjectRecord(service, selected.record.id)?.agents.find((entry) => entry.id === agent.id)?.approvals[0]);
    expect(approval.status).toBe("rejected");
    expect(approval.summary).toBe("Blocked by project boundary");
    expect(approval.reason).toContain("escape the active project folder");
  });

  it("auto-rejects approval requests whose command references paths outside the active project folder", async () => {
    const root = await createSampleFolder("approval-command-boundary");
    const appData = await createTempDir("appdata-approval-command-boundary");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");

    const agent = await service.createAgent(selected.record.id, "coding", "Boundary Agent", "Stay inside the project.", "gpt-5.4");

    (service as any).handleTransportRequest({
      method: "item/commandExecution/requestApproval",
      id: "unsafe-command-approval",
      params: {
        threadId: agent.threadId,
        turnId: "turn-1",
        itemId: "item-1",
        command: "rg todo ~/Downloads",
        cwd: root,
        reason: "Search for context outside the project"
      }
    });

    const approval = await waitFor(() => getProjectRecord(service, selected.record.id)?.agents.find((entry) => entry.id === agent.id)?.approvals[0]);
    expect(approval.status).toBe("rejected");
    expect(approval.summary).toBe("Blocked by project boundary");
    expect(approval.reason).toContain("outside the active project folder");
  });

  it("keeps exact project-root references with trailing punctuation inside the project boundary", async () => {
    const root = await createSampleFolder("approval-root-reference");
    const appData = await createTempDir("appdata-approval-root-reference");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");

    const agent = await service.createAgent(selected.record.id, "coding", "Boundary Agent", "Stay inside the project.", "gpt-5.4");

    (service as any).handleTransportRequest({
      method: "item/commandExecution/requestApproval",
      id: "safe-root-reference",
      params: {
        threadId: agent.threadId,
        turnId: "turn-1",
        itemId: "item-1",
        command: "touch ./inside.txt",
        cwd: root,
        reason: `Work inside ${root}.`
      }
    });

    const approval = await waitFor(() => getProjectRecord(service, selected.record.id)?.agents.find((entry) => entry.id === agent.id)?.approvals[0]);
    expect(approval.status).toBe("pending");
    expect(approval.reason).not.toContain("[outside-project path blocked]");
  });

  it("allows safe shell-wrapped write approvals inside the project boundary", async () => {
    const root = await createSampleFolder("approval-shell-wrapper");
    const appData = await createTempDir("appdata-approval-shell-wrapper");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");

    const agent = await service.createAgent(selected.record.id, "coding", "Boundary Agent", "Stay inside the project.", "gpt-5.4");

    (service as any).handleTransportRequest({
      method: "item/commandExecution/requestApproval",
      id: "safe-shell-command-approval",
      params: {
        threadId: agent.threadId,
        turnId: "turn-1",
        itemId: "item-1",
        command: "/bin/bash -lc \"printf '' > test.txt\"",
        cwd: root,
        reason: "Create a file inside the project"
      }
    });

    const approval = await waitFor(() => getProjectRecord(service, selected.record.id)?.agents.find((entry) => entry.id === agent.id)?.approvals[0]);
    expect(approval.status).toBe("pending");
    expect(approval.command).toBe("/bin/bash -lc \"printf '' > test.txt\"");
    expect(approval.summary).toBe("/bin/bash -lc \"printf '' > test.txt\"");
  });

  it("keeps safe shell executable paths visible in command logs", async () => {
    const root = await createSampleFolder("command-log-shell-wrapper");
    const appData = await createTempDir("appdata-command-log-shell-wrapper");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");

    const agent = await service.createAgent(selected.record.id, "coding", "Boundary Agent", "Stay inside the project.", "gpt-5.4");

    (service as any).handleTransportNotification({
      method: "item/started",
      params: {
        threadId: agent.threadId,
        item: {
          id: "command-item-1",
          type: "commandExecution",
          command: "/bin/bash -lc \"printf '' > test.txt\"",
          cwd: root
        }
      }
    });

    const command = await waitFor(() => getProjectRecord(service, selected.record.id)?.agents.find((entry) => entry.id === agent.id)?.commandLog[0]);
    expect(command.command).toBe("/bin/bash -lc \"printf '' > test.txt\"");
    expect(command.cwd).toBe(root);
  });

  it("keeps streaming agent deltas out of workflow activity until the message completes", async () => {
    const root = await createSampleFolder("streaming-activity-coalesce");
    const appData = await createTempDir("appdata-streaming-activity-coalesce");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");

    const agent = await service.createAgent(
      selected.record.id,
      "coding",
      "Streaming Agent",
      "Stream progress.",
      "gpt-5.4",
      { launchThread: false }
    );
    agent.threadId = "streaming-agent-thread";
    (service as any).threadToAgent.set(agent.threadId, { projectId: selected.record.id, agentId: agent.id });

    (service as any).handleTransportNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: agent.threadId,
        turnId: "turn-streaming",
        itemId: "message-1",
        delta: "First "
      }
    });
    (service as any).handleTransportNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: agent.threadId,
        turnId: "turn-streaming",
        itemId: "message-1",
        delta: "second"
      }
    });

    const recordAfterDeltas = getProjectRecord(service, selected.record.id);
    const streamingRows = recordAfterDeltas?.workflow.activityLog.filter((event) =>
      event.agentId === agent.id && event.title === "Agent message"
    ) ?? [];
    expect(streamingRows).toHaveLength(0);

    (service as any).handleTransportNotification({
      method: "item/completed",
      params: {
        threadId: agent.threadId,
        turnId: "turn-streaming",
        item: {
          type: "agentMessage",
          id: "message-1",
          text: "First second",
          phase: null,
          memoryCitation: null
        }
      }
    });

    const recordAfterCompletion = getProjectRecord(service, selected.record.id);
    const completedRows = recordAfterCompletion?.workflow.activityLog.filter((event) =>
      event.agentId === agent.id && event.title === "Agent message"
    ) ?? [];
    expect(completedRows).toHaveLength(1);
    expect(completedRows[0].detail).toContain("First second");
  });

  it("acknowledges stale workflow recovery before slow transport startup completes", async () => {
    const root = await createSampleFolder("recovery-ack-before-startup");
    const appData = await createTempDir("appdata-recovery-ack-before-startup");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");

    const project = (service as any).projects.get(selected.record.id);
    const workflow = project.record.workflow;
    workflow.ultimateGoal = {
      summary: "Recover without blocking the UI.",
      detailedIntent: "Recovery should acknowledge immediately and continue startup in the background.",
      successCriteria: ["Continue returns quickly."],
      constraints: ["Keep local state durable."],
      nonGoals: ["Do not redesign the UI."],
      targetAudience: "Workbench operators",
      qualityBar: "Responsive and explicit.",
      source: "user",
      confirmedAt: nowIso()
    };
    workflow.scopedGoal = {
      id: "scoped-recovery",
      sourceRecommendationId: "rec-recovery",
      summary: "Restart the saved coding step.",
      executionBrief: "Continue from the saved scoped goal.",
      acceptanceCriteria: [],
      constraints: [],
      testStrategy: [],
      createdAt: nowIso()
    };
    workflow.workflowStage = "coding_running";
    workflow.workflowStopReason = "none";
    workflow.workflowCycle.status = "coding";
    workflow.stepProgress.coding = {
      ...workflow.stepProgress.coding,
      status: "running",
      startedAt: nowIso(),
      updatedAt: nowIso(),
      currentActivity: "Interrupted coding run",
      agentCategory: "coding"
    };
    project.record.localState.autopilotEnabled = true;
    workflow.autopilotPolicy = {
      ...workflow.autopilotPolicy,
      enabled: true
    };
    const interruptedAgent: AgentState = {
      ...createAgentSkeleton("coding", "Interrupted Coding Pass", "Implement the saved scoped goal.", "gpt-5.4-mini"),
      workflowCycleNumber: workflow.workflowCycle.cycleNumber,
      status: "running",
      startedAt: nowIso(),
      threadId: "lost-coding-thread",
      currentPhase: "Turn running"
    };
    project.record.agents.unshift(interruptedAgent);

    let releaseStartup!: () => void;
    const startupGate = new Promise<void>((resolve) => {
      releaseStartup = resolve;
    });
    const initializeTransport = vi.fn(async () => {
      await startupGate;
      (service as any).transport = new MockCodexTransport();
      (service as any).codexAvailability = { source: "mock", message: "Mock transport ready." };
    });
    (service as any).transport = undefined;
    (service as any).codexAvailability = { source: "unavailable", message: "Starting test transport." };
    (service as any).initializeTransport = initializeTransport;

    const startedAt = performance.now();
    const stage = service.recoverWorkflow(selected.record.id);
    const elapsed = performance.now() - startedAt;

    expect(stage).toBe("goal_ready");
    expect(elapsed).toBeLessThan(100);
    expect(initializeTransport).toHaveBeenCalled();
    expect(getProjectRecord(service, selected.record.id)?.workflow.stepProgress.coding.status).toBe("recovering");

    releaseStartup();
    await waitFor(() => !(service as any).workflowRecoveryInFlight.has(selected.record.id));
  });

  it("ignores token usage storms for renderer emits and project saves", async () => {
    const root = await createSampleFolder("token-usage-storm");
    const appData = await createTempDir("appdata-token-usage-storm");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");
    const agent = await service.createAgent(selected.record.id, "integrity", "Token Usage Agent", "Inspect.", "gpt-5.4");
    await new Promise((resolve) => setTimeout(resolve, 900));

    const originalSaveProject = (service as any).saveProject.bind(service);
    let saveCount = 0;
    let emitCount = 0;
    (service as any).saveProject = async (...args: unknown[]) => {
      saveCount += 1;
      return await originalSaveProject(...args);
    };
    service.on("stateChanged", () => {
      emitCount += 1;
    });

    for (let index = 0; index < 50; index += 1) {
      (service as any).handleTransportNotification({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: agent.threadId,
          turnId: "turn-token",
          tokenUsage: {
            total: { inputTokens: index, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: index },
            last: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 1 },
            modelContextWindow: null
          }
        }
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(saveCount).toBe(0);
    expect(emitCount).toBe(0);
  });

  it("deduplicates repeated command status activity rows", async () => {
    const root = await createSampleFolder("command-activity-dedupe");
    const appData = await createTempDir("appdata-command-activity-dedupe");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");
    const agent = await service.createAgent(selected.record.id, "integrity", "Command Agent", "Run a command.", "gpt-5.4");
    await new Promise((resolve) => setTimeout(resolve, 100));

    const startedNotification = {
      method: "item/started",
      params: {
        threadId: agent.threadId,
        turnId: "turn-command",
        item: {
          type: "commandExecution",
          id: "cmd-1",
          command: "npm test",
          cwd: root
        }
      }
    };
    const completedNotification = {
      method: "item/completed",
      params: {
        threadId: agent.threadId,
        turnId: "turn-command",
        item: {
          type: "commandExecution",
          id: "cmd-1",
          command: "npm test",
          cwd: root,
          status: "completed",
          exitCode: 0
        }
      }
    };

    (service as any).handleTransportNotification(startedNotification);
    (service as any).handleTransportNotification(startedNotification);
    (service as any).handleTransportNotification(completedNotification);
    (service as any).handleTransportNotification(completedNotification);

    const activity = getProjectRecord(service, selected.record.id)?.workflow.activityLog ?? [];
    expect(activity.filter((event) => event.agentId === agent.id && event.title === "Command started")).toHaveLength(1);
    expect(activity.filter((event) => event.agentId === agent.id && event.title === "Command completed")).toHaveLength(1);
  });

  it("flushes final transport states promptly", async () => {
    const root = await createSampleFolder("final-state-flush");
    const appData = await createTempDir("appdata-final-state-flush");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");
    const agent = await service.createAgent(selected.record.id, "integrity", "Final Flush Agent", "Inspect.", "gpt-5.4");
    await new Promise((resolve) => setTimeout(resolve, 900));

    let saveCount = 0;
    (service as any).saveProject = async () => {
      saveCount += 1;
    };

    (service as any).handleTransportNotification({
      method: "turn/completed",
      params: {
        threadId: agent.threadId,
        turn: {
          id: "turn-final",
          items: [],
          status: "completed",
          error: null,
          startedAt: Math.floor(Date.now() / 1000),
          completedAt: Math.floor(Date.now() / 1000),
          durationMs: 1
        }
      }
    });

    await waitFor(() => saveCount > 0);
  });

  it("keeps normal renderer state compact for raw events and command output", async () => {
    const root = await createSampleFolder("renderer-compact-state");
    const appData = await createTempDir("appdata-renderer-compact-state");
    const service = await createService(appData);
    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");
    const agent = await service.createAgent(selected.record.id, "integrity", "Compact Agent", "Inspect.", "gpt-5.4");
    const project = (service as any).projects.get(selected.record.id);
    const storedAgent = project.record.agents.find((entry: AgentState) => entry.id === agent.id) as AgentState;
    storedAgent.commandLog.unshift({
      itemId: "huge-command",
      command: "npm test",
      output: "x".repeat(50_000),
      status: "running",
      startedAt: nowIso()
    });
    storedAgent.events.unshift({
      id: "huge-event",
      agentId: storedAgent.id,
      timestamp: nowIso(),
      type: "raw",
      status: "info",
      title: "Huge raw event",
      detail: "d".repeat(20_000),
      raw: { payload: "r".repeat(20_000) }
    });

    const rendererRecord = service.getRendererState().projects.find((entry) => entry.record.id === selected.record.id)?.record;
    const rendererAgent = rendererRecord?.agents.find((entry) => entry.id === agent.id);
    expect(rendererAgent?.commandLog[0]?.output).toBe("");
    expect(rendererAgent?.events[0]?.raw).toBeUndefined();
    expect(rendererAgent?.events[0]?.detail?.length ?? 0).toBeLessThanOrEqual(820);
  });

  it("creates manual agents separately from the workflow cycle while preserving git worktree isolation", async () => {
    const root = await createSampleRepo("manual-agent");
    const appData = await createTempDir("appdata-manual-agent");
    const service = await createService(appData);
    await service.loadProject(root);
    const selected = await service.selectPendingInterface("fresh");
    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");

    const before = getProjectRecord(service, selected.record.id)?.workflow.stepProgress.coding.runCount;
    const agent = await service.createAgent(selected.record.id, "manual", "Manual Agent", "Explain the repo and make a one-off change.", "gpt-5.4");
    const stored = getProjectRecord(service, selected.record.id)?.agents.find((entry) => entry.id === agent.id);

    expect(stored?.category).toBe("manual");
    expect(stored?.worktree?.worktreePath).toContain(".agent-workbench/worktrees");
    expect(getProjectRecord(service, selected.record.id)?.workflow.stepProgress.coding.runCount).toBe(before);
  });

  it("applies completed manual-agent changes back to the opened checkout", async () => {
    const root = await createSampleRepo("manual-apply");
    const appData = await createTempDir("appdata-manual-apply");
    const service = await createService(appData);
    await service.loadProject(root);
    const selected = await service.selectPendingInterface("fresh");

    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    await execFileAsync("git", ["checkout", "-b", "feature-manual"], { cwd: root });
    await writeFile(path.join(root, "src/index.ts"), "export const value = 'manual';\n");
    await commitAll(root, "manual change");
    await execFileAsync("git", ["checkout", "main"], { cwd: root });

    const project = (service as any).projects.get(selected.record.id);
    const agent = {
      ...createAgentSkeleton("manual", "Manual Agent", "Apply a one-off change.", "gpt-5.4"),
      threadId: "manual-thread",
      worktree: { baseDir: appData, worktreePath: root, branch: "feature-manual", targetBranch: "main" }
    };
    project.record.agents.unshift(agent);
    (service as any).threadToAgent.set("manual-thread", { projectId: selected.record.id, agentId: agent.id });

    (service as any).handleTransportNotification({
      method: "turn/completed",
      params: {
        threadId: "manual-thread",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });

    await waitFor(
      () => getProjectRecord(service, selected.record.id)?.agents.find((entry) => entry.id === agent.id)?.currentPhase === "Manual changes applied to the opened checkout"
    );
    expect(await readFile(path.join(root, "src/index.ts"), "utf8")).toContain("manual");
  });

  it("regenerates recommendations around a custom focus", async () => {
    const root = await createSampleRepo("custom-recommendation");
    const appData = await createTempDir("appdata-custom-recommendation");
    const service = await createService(appData);
    await service.loadProject(root);
    const selected = await service.selectPendingInterface("fresh");
    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");
    await service.updateUiState(selected.record.id, { workflowPauseRequested: true });

    await service.updateUltimateGoal(selected.record.id, {
      summary: "Improve operator ergonomics.",
      detailedIntent: "Keep the workflow fast to review and easy to steer manually when needed.",
      successCriteria: ["Recommendations stay concrete and easy to review."],
      constraints: ["Keep changes inside the active project folder."],
      nonGoals: [],
      targetAudience: "Operators of the workbench",
      qualityBar: "Small, safe, focused changes.",
      source: "user"
    }, true);

    await service.runRecommendation(selected.record.id, false, "keyboard shortcuts in the workflow tab");

    const recommendationTitle = await waitFor(() => getProjectRecord(service, selected.record.id)?.workflow.recommendations[0]?.title);
    expect(recommendationTitle.toLowerCase()).toContain("keyboard shortcuts");
  });
});
