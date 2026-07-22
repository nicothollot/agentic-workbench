import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const userDataPrefix = "--user-data-dir=";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const readSettings = async (settingsPath) => {
  try {
    const parsed = JSON.parse(await readFile(settingsPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const findUserDataArgument = (args) => {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument.startsWith(userDataPrefix)) {
      return { index, count: 1, value: argument.slice(userDataPrefix.length) };
    }
    if (argument === "--user-data-dir" && args[index + 1]) {
      return { index, count: 2, value: args[index + 1] };
    }
  }
  return undefined;
};

export const prepareElectronLaunch = async ({
  args = [],
  env = process.env,
  temporaryPrefix = "agentic-workbench-mock-"
} = {}) => {
  const applicationArgs = [...args];
  const suppliedArgument = findUserDataArgument(applicationArgs);
  let userDataDir = suppliedArgument?.value || env.AWB_USER_DATA_DIR?.trim();
  let removeUserDataOnExit = false;

  if (suppliedArgument) {
    applicationArgs.splice(suppliedArgument.index, suppliedArgument.count);
  }

  if (!userDataDir && env.AWB_MOCK_MODE === "1") {
    userDataDir = await mkdtemp(path.join(os.tmpdir(), temporaryPrefix));
    removeUserDataOnExit = true;
  }

  if (userDataDir) {
    userDataDir = path.resolve(userDataDir);
    await mkdir(userDataDir, { recursive: true });
  }

  if (env.AWB_MOCK_MODE === "1") {
    if (!userDataDir) {
      throw new Error("Mock mode needs an isolated Electron user-data directory.");
    }
    const settingsPath = path.join(userDataDir, "settings.json");
    const settings = await readSettings(settingsPath);
    await writeFile(settingsPath, `${JSON.stringify({
      ...settings,
      mockMode: true,
      interfaceCreationConfiguredAt: settings.interfaceCreationConfiguredAt ?? new Date().toISOString()
    }, null, 2)}\n`, "utf8");
  }

  return {
    applicationArgs,
    electronSwitches: userDataDir ? [`${userDataPrefix}${userDataDir}`] : [],
    userDataDir,
    async cleanup() {
      if (removeUserDataOnExit && userDataDir) {
        await rm(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    }
  };
};

export const spawnManaged = (command, args, options = {}) => spawn(command, args, {
  ...options,
  detached: process.platform !== "win32"
});

const waitForExit = async (child, timeoutMs) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  return await Promise.race([
    new Promise((resolve) => {
      child.once("exit", () => resolve(true));
      child.once("error", () => resolve(false));
    }),
    delay(timeoutMs).then(() => false)
  ]);
};

const signalPosixProcessGroup = (child, signal) => {
  if (!child.pid) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH") {
      throw error;
    }
  }
};

const killWindowsProcessTree = async (child) => {
  if (!child.pid) {
    return false;
  }
  const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true
  });
  return await waitForExit(killer, 5_000);
};

export const stopManaged = async (child, graceMs = 3_000) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  if (process.platform === "win32") {
    if (!(await killWindowsProcessTree(child))) {
      child.kill();
    }
    await waitForExit(child, graceMs);
    return;
  }

  signalPosixProcessGroup(child, "SIGTERM");
  if (!(await waitForExit(child, graceMs))) {
    signalPosixProcessGroup(child, "SIGKILL");
    await waitForExit(child, 1_000);
  }
};
