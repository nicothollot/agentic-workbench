import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { AppService } from "@runtime/appService";
import { WorkbenchStorage } from "@runtime/storage";
import {
  applyGoalChecklistUpdates,
  buildGoalChecklistFromUltimateGoal
} from "@runtime/workflowRecommendations";
import type { GoalCheckUpdateInput } from "@runtime/workflowRecommendations";
import { createAgentSkeleton, createLocalProjectRecord } from "@shared/defaults";
import { projectReviewLogBundleSchema } from "@shared/schemas";
import type { UltimateGoal } from "@shared/types";
import { createTempDir, initGitRepo, commitAll, writeMockSettings } from "./helpers";

const execFileAsync = promisify(execFile);

const createService = async (appDataDir: string): Promise<AppService> => {
  await writeMockSettings(appDataDir);
  const service = new AppService(appDataDir);
  await service.initialize();
  return service;
};

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
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
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

    const reopened = await service.openProject(created.record.id);
    const state = service.getState();
    const activeProject = state.projects.find((project) => project.record.id === reopened.record.id);

    expect(state.activeProjectId).toBe(created.record.id);
    expect(reopened.tree.length).toBeGreaterThan(0);
    expect(activeProject?.record.localState.lastOpenedAt).toBeTruthy();
  });

  it("exports and imports a portable interface roundtrip", async () => {
    const root = await createSampleRepo("roundtrip");
    const appDataA = await createTempDir("appdata-roundtrip-a");
    const serviceA = await createService(appDataA);
    await serviceA.loadProject(root);
    const selected = await serviceA.selectPendingInterface("fresh");
    await new Promise((resolve) => setTimeout(resolve, 80));
    const exportPath = await serviceA.exportInterface(selected.record.id);

    const appDataB = await createTempDir("appdata-roundtrip-b");
    const serviceB = await createService(appDataB);
    const imported = await serviceB.importInterface(root, exportPath);
    await new Promise((resolve) => setTimeout(resolve, 80));

    const project = serviceB.getState().projects.find((entry) => entry.record.id === imported.record.id);
    expect(project?.record.overview?.summary.length).toBeGreaterThan(10);
    expect(project?.record.agents.some((agent) => agent.category === "bootstrap")).toBe(true);
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
      maxRepairCycles: 4
    });

    const stateAfter = service.getState();
    expect(stateAfter.settings.interfaceCreationReasoningEffort).toBe("high");
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

  it("applies the configured reasoning effort to interface creation state", async () => {
    const root = await createSampleRepo("reasoning-applied");
    const appData = await createTempDir("appdata-reasoning-applied");
    const service = await createService(appData);
    await service.updateSettings({
      interfaceCreationReasoningEffort: "high"
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
      interfaceCreationReasoningEffort: "xhigh"
    });

    await service.loadProject(root, "create");
    const selected = await service.selectPendingInterface("fresh");
    await waitFor(() => getProjectRecord(service, selected.record.id)?.interfaceCreation?.status === "completed");

    await service.detectUltimateGoal(selected.record.id);
    await waitFor(() => getProjectRecord(service, selected.record.id)?.agents.some((agent) => agent.category === "goal"));

    const goalAgent = getProjectRecord(service, selected.record.id)?.agents.find((agent) => agent.category === "goal");
    expect(goalAgent?.model).toBe("gpt-5.4");
    expect(goalAgent?.reasoningEffort).toBe("xhigh");
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
      detail: `Validation failed while checking ${root}/src/index.ts`,
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
      output: `FAIL ${root}/src/index.ts\nWorktree: ${agent.worktree.worktreePath}`,
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
    expect(raw).toContain("<project-root>");
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
      return mergeAgents.length > previousMergeAgentCount ? candidate : null;
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
    record?.agents.unshift(activeAgent);
    await serviceA.updateUiState(selected.record.id, { treeFilter: "resume-marker" });
    await serviceA.exportInterface(selected.record.id);

    const serviceB = await createService(appData);
    const loadResult = await serviceB.loadProject(root);
    const localCandidate = loadResult.interfaceCandidates.find((candidate) => candidate.source === "local");
    expect(localCandidate).toBeTruthy();
    const reopened = await serviceB.selectPendingInterface("local", localCandidate?.path);
    expect(reopened.record.agents.find((agent) => agent.id === activeAgent.id)?.status).toBe("disconnected");
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
    expect(project?.record.workflow.approvedRecommendation?.recommendationId).toBe(recommendationId);
    expect(project?.record.workflow.scopedGoal?.summary.length).toBeGreaterThan(5);
    expect(project?.record.workflow.workflowStage).toBe("goal_ready");
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

  it("autopilot picks the highest-confidence recommendation and only stops at the next recommendation boundary when turned off", async () => {
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
        summary: "Let the workflow run unattended until the next recommendation decision.",
        detailedIntent: "Autopilot should pick the most confident next step, but turning it off should only affect the next recommendation boundary.",
        successCriteria: ["Autopilot picks a recommendation automatically.", "Turning it off does not interrupt the active cycle."],
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

    expect(autopilotApproved.approvedRecommendation?.confidence).toBe(
      Math.max(...autopilotApproved.recommendations.map((entry) => entry.confidence))
    );

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

    await service.recoverWorkflow(selected.record.id);

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

    const reopenedService = new AppService(appData);
    await reopenedService.initialize();
    await reopenedService.updateSettings({
      maxRepairCycles: 2
    });
    await reopenedService.loadProject(root, "create");
    const reopened = await reopenedService.selectPendingInterface("local");

    const resumedWorkflow = await waitFor(() => {
      const record = getProjectRecord(reopenedService, reopened.record.id);
      const codingAgentCount = record?.agents.filter((agent) => agent.category === "coding" && agent.status !== "disconnected").length ?? 0;
      const workflow = record?.workflow;
      return workflow?.repair.status === "exhausted" && workflow.repair.attemptCount === 2 && codingAgentCount === 3
        ? workflow
        : null;
    }, 12_000);

    expect(resumedWorkflow.repair.maxAttempts).toBe(2);
    expect(resumedWorkflow.activityLog.some((event) => event.title === "Automatic repair resumed")).toBe(true);
  }, 16_000);

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
