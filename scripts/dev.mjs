#!/usr/bin/env node
import { stat } from "node:fs/promises";
import { watchFile, unwatchFile } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";
import { repositoryRoot } from "./build-freshness.mjs";
import { prepareElectronLaunch, spawnManaged, stopManaged } from "./electron-launch.mjs";

const viteEntry = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));
const mainOutput = path.join(repositoryRoot, "dist-electron/main/index.cjs");
const preloadOutput = path.join(repositoryRoot, "dist-electron/preload/index.cjs");
const requestedDevUrl = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173";
const devUrl = new URL(requestedDevUrl);
const host = devUrl.hostname;
const port = devUrl.port || "80";
const startupTimeoutMs = 60_000;
const restartDebounceMs = 2_000;

const applicationArgs = process.argv.slice(2);
const mockFlagIndex = applicationArgs.indexOf("--mock");
if (mockFlagIndex !== -1) {
  applicationArgs.splice(mockFlagIndex, 1);
  process.env.AWB_MOCK_MODE = "1";
}

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
if (devUrl.protocol !== "http:" || !loopbackHosts.has(host)) {
  throw new Error("VITE_DEV_SERVER_URL must be an http:// loopback URL.");
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const fileSignature = async (filePath) => {
  try {
    const details = await stat(filePath);
    return `${details.mtimeMs}:${details.size}`;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
};

const waitUntil = async (description, predicate, timeoutMs = startupTimeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (resolvedExitCode !== undefined) {
      throw new Error(`Stopped waiting for ${description} because a development process exited.`);
    }
    try {
      if (await predicate()) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(125);
  }
  throw new Error(`Timed out waiting for ${description}.${lastError ? ` ${lastError instanceof Error ? lastError.message : String(lastError)}` : ""}`);
};

const isRendererReady = async () => await new Promise((resolve) => {
  const request = http.get(devUrl, (response) => {
    response.resume();
    resolve((response.statusCode ?? 500) < 500);
  });
  request.setTimeout(1_000, () => request.destroy());
  request.once("error", () => resolve(false));
});

const initialMainSignature = await fileSignature(mainOutput);
const initialPreloadSignature = await fileSignature(preloadOutput);
const launch = await prepareElectronLaunch({ args: applicationArgs });
const children = new Set();
const watchedFiles = [mainOutput, preloadOutput];
const observedBundleSignatures = new Map();
let electron;
let restartTimer;
let shuttingDown = false;
let resolvedExitCode;
let resolveCompletion;
const completion = new Promise((resolve) => {
  resolveCompletion = resolve;
});

const finish = (exitCode) => {
  if (resolvedExitCode !== undefined) {
    return;
  }
  resolvedExitCode = exitCode;
  resolveCompletion();
};

const startWorker = (label, args) => {
  const child = spawnManaged(process.execPath, [viteEntry, ...args], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit"
  });
  children.add(child);
  child.once("error", (error) => {
    console.error(`[dev] ${label} failed to launch:`, error);
    finish(1);
  });
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!shuttingDown) {
      console.error(`[dev] ${label} exited unexpectedly (${signal ?? `code ${code ?? "unknown"}`}).`);
      finish(code && code > 0 ? code : 1);
    }
  });
  return child;
};

startWorker("renderer dev server", [
  "--host", host,
  "--port", port,
  "--strictPort"
]);
startWorker("main-process watcher", [
  "build", "--config", "vite.main.config.ts", "--watch"
]);
startWorker("preload watcher", [
  "build", "--config", "vite.preload.config.ts", "--watch"
]);

const launchElectron = () => {
  const child = spawnManaged(electronPath, [
    ...launch.electronSwitches,
    repositoryRoot,
    ...launch.applicationArgs
  ], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: devUrl.toString().replace(/\/$/, "")
    },
    stdio: "inherit"
  });
  electron = child;
  children.add(child);
  child.once("error", (error) => {
    if (!shuttingDown && electron === child) {
      console.error("[dev] Electron failed to launch:", error);
      finish(1);
    }
  });
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!shuttingDown && electron === child) {
      console.info(`[dev] Electron closed (${signal ?? `code ${code ?? "unknown"}`}).`);
      finish(code && code > 0 ? code : 0);
    }
  });
};

const restartElectron = async () => {
  if (shuttingDown || !electron) {
    return;
  }
  const previous = electron;
  electron = undefined;
  console.info("[dev] Main or preload bundle changed; restarting Electron.");
  await stopManaged(previous);
  if (!shuttingDown) {
    launchElectron();
  }
};

const scheduleElectronRestart = () => {
  if (shuttingDown || !electron) {
    return;
  }
  if (restartTimer) {
    clearTimeout(restartTimer);
  }
  restartTimer = setTimeout(() => {
    restartTimer = undefined;
    void restartElectron().catch((error) => {
      console.error(`[dev] Electron restart failed: ${error instanceof Error ? error.message : String(error)}`);
      finish(1);
    });
  }, restartDebounceMs);
};

const shutdown = async () => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
  }
  for (const filePath of watchedFiles) {
    unwatchFile(filePath);
  }
  await Promise.allSettled([...children].map((child) => stopManaged(child)));
  await launch.cleanup();
};

process.once("SIGINT", () => {
  console.info("[dev] Interrupt received; shutting down.");
  finish(0);
});
process.once("SIGTERM", () => {
  console.info("[dev] Termination requested; shutting down.");
  finish(0);
});

try {
  await Promise.race([
    Promise.all([
      waitUntil("the renderer dev server", isRendererReady),
      waitUntil("a fresh main-process bundle", async () => {
        const signature = await fileSignature(mainOutput);
        return Boolean(signature && signature !== initialMainSignature);
      }),
      waitUntil("a fresh preload bundle", async () => {
        const signature = await fileSignature(preloadOutput);
        return Boolean(signature && signature !== initialPreloadSignature);
      })
    ]),
    completion.then(() => {
      throw new Error("A development process exited during startup.");
    })
  ]);

  // Watch only the compiled entry points. Sourcemap writes should not cause extra restarts.
  for (const filePath of watchedFiles) {
    observedBundleSignatures.set(filePath, await fileSignature(filePath));
    watchFile(filePath, { interval: 250 }, (current) => {
      const signature = `${current.mtimeMs}:${current.size}`;
      if (signature !== observedBundleSignatures.get(filePath)) {
        observedBundleSignatures.set(filePath, signature);
        scheduleElectronRestart();
      }
    });
  }

  if (launch.userDataDir) {
    console.info(`[dev] Using isolated user data: ${launch.userDataDir}`);
  }
  console.info(`[dev] Renderer and Electron bundles are ready at ${devUrl.toString()}`);
  launchElectron();
  await completion;
} catch (error) {
  console.error(`[dev] ${error instanceof Error ? error.message : String(error)}`);
  resolvedExitCode = 1;
} finally {
  await shutdown();
}

process.exitCode = resolvedExitCode ?? 0;
