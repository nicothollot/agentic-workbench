import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication } from "playwright";
import { defaultSettings } from "../../src/shared/defaults";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface LaunchedWorkbench {
  app: ElectronApplication;
  userDataDir: string;
  projectDir: string;
  close: () => Promise<void>;
}

export const launchCompiledWorkbench = async (
  settingsOverrides: Record<string, unknown> = {},
  electronSwitches: string[] = []
): Promise<LaunchedWorkbench> => {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "agentic-workbench-e2e-"));
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "agentic-workbench-project-e2e-"));
  await mkdir(userDataDir, { recursive: true });
  await writeFile(path.join(projectDir, "index.html"), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Workbench fixture</title></head>
<body><main><h1>Workbench fixture</h1><button type="button">Continue</button></main></body></html>\n`, "utf8");
  await writeFile(path.join(userDataDir, "settings.json"), `${JSON.stringify({
    ...defaultSettings(),
    mockMode: true,
    interfaceCreationConfiguredAt: new Date().toISOString(),
    motionMode: "reduced",
    ...settingsOverrides
  }, null, 2)}\n`, "utf8");

  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      args: [
        ...electronSwitches,
        `--user-data-dir=${userDataDir}`,
        repositoryRoot
      ],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        AWB_MOCK_MODE: "1",
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1"
      },
      timeout: 45_000
    });
  } catch (error) {
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    await rm(projectDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    throw error;
  }

  const launchedApp = app;
  let closed = false;
  return {
    app: launchedApp,
    userDataDir,
    projectDir,
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      try {
        await launchedApp.close();
      } finally {
        await rm(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        await rm(projectDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    }
  };
};
