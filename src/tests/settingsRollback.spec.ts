import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AppService } from "@runtime/appService";
import { WorkbenchStorage, type SecretStorageCodec } from "@runtime/storage";
import type { AppSettings, LocalProjectRecord } from "@shared/types";
import { createTempDir, writeMockSettings } from "./helpers";

const secretCodec: SecretStorageCodec = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value, "utf8"),
  decryptString: (encrypted) => encrypted.toString("utf8")
};

type TestProject = { record: LocalProjectRecord };

type AppServiceInternals = {
  storage: WorkbenchStorage;
  projects: Map<string, TestProject>;
  saveProject(project: TestProject, options?: { force?: boolean }): Promise<void>;
};

const waitFor = async <T,>(read: () => T | undefined, timeoutMs = 4_000): Promise<T> => {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for settings rollback fixture.");
};

const touchedProjectSettings = (record: LocalProjectRecord) => {
  const bootstrapAgent = record.agents.find((agent) => agent.category === "bootstrap");
  return {
    workflow: {
      maxRepairLoops: record.workflow.workflowBudgets.maxRepairLoops,
      maxRepairAttempts: record.workflow.repair.maxAttempts,
      repairLoopCount: record.workflow.repairLoopCount
    },
    interfaceCreation: record.interfaceCreation
      ? {
        model: record.interfaceCreation.model,
        reasoningEffort: record.interfaceCreation.reasoningEffort,
        selectedModelSource: record.interfaceCreation.selectedModelSource
      }
      : undefined,
    bootstrapAgent: bootstrapAgent
      ? {
        model: bootstrapAgent.model,
        reasoningEffort: bootstrapAgent.reasoningEffort,
        reasoningEffortSource: bootstrapAgent.reasoningEffortSource,
        threadId: bootstrapAgent.threadId
      }
      : undefined
  };
};

describe("AppService settings rollback", () => {
  it("restores settings and project fields after a post-persistence reconciliation failure, then accepts a later update", async () => {
    const appDataDir = await createTempDir("settings-rollback");
    const projectRoot = await createTempDir("settings-rollback-project");
    await mkdir(path.join(projectRoot, "src"), { recursive: true });
    await writeFile(path.join(projectRoot, "package.json"), JSON.stringify({
      name: "settings-rollback-project",
      scripts: { test: "echo test" }
    }, null, 2));
    await writeFile(path.join(projectRoot, "src/index.ts"), "export const ready = true;\n");
    await writeMockSettings(appDataDir);

    const service = new AppService(appDataDir, secretCodec);
    await service.initialize();
    try {
      await service.loadProject(projectRoot, "create");
      const selected = await service.selectPendingInterface("fresh");
      const internals = service as unknown as AppServiceInternals;
      const project = await waitFor(() => {
        const candidate = internals.projects.get(selected.record.id);
        return candidate?.record.interfaceCreation?.status === "completed" ? candidate : undefined;
      });
      const bootstrapAgent = project.record.agents.find((agent) => agent.category === "bootstrap");
      expect(bootstrapAgent).toBeDefined();
      bootstrapAgent!.threadId = undefined;
      await internals.saveProject(project, { force: true });

      const stateBefore = service.getState();
      const settingsBefore = structuredClone(stateBefore.settings);
      const settingsRevisionBefore = stateBefore.settingsRevision ?? 0;
      const projectFieldsBefore = structuredClone(touchedProjectSettings(project.record));
      const targetModel = stateBefore.availableModels.find((model) => model.model !== projectFieldsBefore.interfaceCreation?.model)?.model;
      expect(targetModel).toBeDefined();
      const targetRepairCycles = settingsBefore.maxRepairCycles === 5 ? 4 : 5;
      const targetReasoningEffort = projectFieldsBefore.interfaceCreation?.reasoningEffort === "high" ? "low" : "high";
      const update: Partial<AppSettings> = {
        maxRepairCycles: targetRepairCycles,
        interfaceCreationModel: targetModel,
        agentModelMode: "manual",
        interfaceCreationReasoningEffort: targetReasoningEffort,
        agentReasoningMode: "manual",
        agentReasoningEfforts: {
          ...(settingsBefore.agentReasoningEfforts ?? {}),
          bootstrap: targetReasoningEffort
        }
      };

      const storage = internals.storage;
      const originalSaveProject = storage.saveProject.bind(storage);
      const originalSaveSettings = storage.saveSettings.bind(storage);
      const settingsWrites: AppSettings[] = [];
      vi.spyOn(storage, "saveSettings").mockImplementation(async (settings) => {
        settingsWrites.push(structuredClone(settings) as unknown as AppSettings);
        await originalSaveSettings(settings);
      });
      let injectedFailure = false;
      vi.spyOn(storage, "saveProject").mockImplementation(async (record) => {
        const failAfterWrite = !injectedFailure &&
          record.id === project.record.id &&
          record.workflow.repair.maxAttempts === targetRepairCycles &&
          record.interfaceCreation?.reasoningEffort === targetReasoningEffort;
        await originalSaveProject(record);
        if (failAfterWrite) {
          injectedFailure = true;
          throw new Error("Injected project reconciliation persistence failure");
        }
      });

      await expect(service.updateSettings(update)).rejects.toThrow("Injected project reconciliation persistence failure");

      expect(injectedFailure).toBe(true);
      expect(settingsWrites.map((settings) => settings.maxRepairCycles)).toEqual([
        targetRepairCycles,
        settingsBefore.maxRepairCycles
      ]);
      expect(service.getState().settings).toEqual(settingsBefore);
      expect(service.getState().settingsRevision).toBe(settingsRevisionBefore);
      expect(touchedProjectSettings(project.record)).toEqual(projectFieldsBefore);

      const persistedAfterRollback = new WorkbenchStorage(appDataDir, secretCodec);
      await expect(persistedAfterRollback.loadSettings()).resolves.toEqual(settingsBefore);
      const persistedProjectAfterRollback = await persistedAfterRollback.loadProject(project.record.id);
      expect(persistedProjectAfterRollback).not.toBeNull();
      expect(touchedProjectSettings(persistedProjectAfterRollback!)).toEqual(projectFieldsBefore);

      await expect(service.updateSettings(update)).resolves.toMatchObject({
        maxRepairCycles: targetRepairCycles,
        interfaceCreationModel: targetModel,
        interfaceCreationReasoningEffort: targetReasoningEffort
      });
      expect(service.getState().settingsRevision).toBe(settingsRevisionBefore + 1);
      expect(touchedProjectSettings(project.record)).toMatchObject({
        workflow: {
          maxRepairLoops: targetRepairCycles,
          maxRepairAttempts: targetRepairCycles
        },
        interfaceCreation: {
          model: targetModel,
          reasoningEffort: targetReasoningEffort,
          selectedModelSource: "user"
        },
        bootstrapAgent: {
          model: targetModel,
          reasoningEffort: targetReasoningEffort,
          reasoningEffortSource: "manual"
        }
      });

      const persistedAfterSuccess = new WorkbenchStorage(appDataDir, secretCodec);
      await expect(persistedAfterSuccess.loadSettings()).resolves.toMatchObject(update);
      const persistedProjectAfterSuccess = await persistedAfterSuccess.loadProject(project.record.id);
      expect(persistedProjectAfterSuccess).not.toBeNull();
      expect(touchedProjectSettings(persistedProjectAfterSuccess!)).toEqual(touchedProjectSettings(project.record));
    } finally {
      await service.dispose({ flush: false });
      vi.restoreAllMocks();
    }
  }, 12_000);
});
