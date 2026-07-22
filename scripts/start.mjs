#!/usr/bin/env node
import { spawn } from "node:child_process";
import electronPath from "electron";
import { inspectBuildFreshness, repositoryRoot } from "./build-freshness.mjs";
import { prepareElectronLaunch, spawnManaged, stopManaged } from "./electron-launch.mjs";

const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";

const run = async (command, args, options = {}) => await new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: "inherit", ...options });
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (code === 0) {
      resolve();
      return;
    }
    reject(new Error(`${command} ${args.join(" ")} exited with ${signal ?? `code ${code ?? "unknown"}`}.`));
  });
});

const runNpm = async (args) => {
  if (process.env.npm_execpath) {
    await run(process.execPath, [process.env.npm_execpath, ...args], { cwd: repositoryRoot });
    return;
  }
  await run(npmExecutable, args, {
    cwd: repositoryRoot,
    shell: process.platform === "win32"
  });
};

const runElectron = async (args, env) => await new Promise((resolve, reject) => {
  const child = spawnManaged(electronPath, args, {
    cwd: repositoryRoot,
    env,
    stdio: "inherit"
  });
  let stopping = false;

  const removeSignalHandlers = () => {
    process.off("SIGINT", handleInterrupt);
    process.off("SIGTERM", handleTermination);
  };
  const stop = () => {
    if (stopping) {
      return;
    }
    stopping = true;
    void stopManaged(child).catch(reject);
  };
  const handleInterrupt = () => stop();
  const handleTermination = () => stop();

  process.once("SIGINT", handleInterrupt);
  process.once("SIGTERM", handleTermination);
  child.once("error", (error) => {
    removeSignalHandlers();
    reject(error);
  });
  child.once("exit", (code, signal) => {
    removeSignalHandlers();
    if (code === 0 || stopping) {
      resolve();
      return;
    }
    reject(new Error(`Electron exited with ${signal ?? `code ${code ?? "unknown"}`}.`));
  });
});

let launch;

try {
  const freshness = await inspectBuildFreshness();
  if (!freshness.fresh || process.env.AWB_FORCE_BUILD === "1") {
    console.info(`[start] Building application: ${process.env.AWB_FORCE_BUILD === "1" ? "AWB_FORCE_BUILD=1" : freshness.reason}`);
    await runNpm(["run", "build:app"]);
  } else {
    console.info(`[start] ${freshness.reason}`);
  }

  launch = await prepareElectronLaunch({ args: process.argv.slice(2) });
  if (launch.userDataDir) {
    console.info(`[start] Using isolated user data: ${launch.userDataDir}`);
  }

  await runElectron([
    ...launch.electronSwitches,
    repositoryRoot,
    ...launch.applicationArgs
  ], process.env);
} finally {
  await launch?.cleanup();
}
