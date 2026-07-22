import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inspectBuildFreshness } from "./build-freshness.mjs";
import { prepareElectronLaunch } from "./electron-launch.mjs";

const createFixture = async () => {
  const fixture = await prepareElectronLaunch({
    env: { AWB_MOCK_MODE: "1" },
    temporaryPrefix: "agentic-workbench-startup-test-"
  });
  const rootDir = path.join(fixture.userDataDir, "freshness");
  await mkdir(rootDir, { recursive: true });
  return { fixture, rootDir };
};

describe("compiled build freshness", () => {
  it("reports missing, current, and stale build outputs deterministically", async () => {
    const { fixture, rootDir } = await createFixture();
    try {
      await writeFile(path.join(rootDir, "input.ts"), "input\n", "utf8");
      const missing = await inspectBuildFreshness({
        rootDir,
        inputPaths: ["input.ts"],
        outputPaths: ["renderer.js", "main.cjs", "preload.cjs"]
      });
      expect(missing.fresh).toBe(false);
      expect(missing.reason).toContain("renderer.js is missing");

      const oldTime = new Date(Date.now() - 10_000);
      const newTime = new Date(Date.now() + 10_000);
      for (const output of ["renderer.js", "main.cjs", "preload.cjs"]) {
        const outputPath = path.join(rootDir, output);
        await writeFile(outputPath, "compiled\n", "utf8");
        await utimes(outputPath, newTime, newTime);
      }
      await utimes(path.join(rootDir, "input.ts"), oldTime, oldTime);

      const fresh = await inspectBuildFreshness({
        rootDir,
        inputPaths: ["input.ts"],
        outputPaths: ["renderer.js", "main.cjs", "preload.cjs"]
      });
      expect(fresh.fresh).toBe(true);

      await utimes(path.join(rootDir, "input.ts"), new Date(newTime.getTime() + 10_000), new Date(newTime.getTime() + 10_000));
      const stale = await inspectBuildFreshness({
        rootDir,
        inputPaths: ["input.ts"],
        outputPaths: ["renderer.js", "main.cjs", "preload.cjs"]
      });
      expect(stale.fresh).toBe(false);
      expect(stale.reason).toContain("input.ts is newer than");
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("mock Electron launch preparation", () => {
  it("creates, seeds, and removes an isolated user-data profile", async () => {
    const launch = await prepareElectronLaunch({
      env: { AWB_MOCK_MODE: "1" },
      temporaryPrefix: "agentic-workbench-startup-test-"
    });
    const userDataDir = launch.userDataDir;
    expect(userDataDir).toBeTruthy();
    expect(launch.electronSwitches).toEqual([`--user-data-dir=${userDataDir}`]);

    const settings = JSON.parse(await readFile(path.join(userDataDir, "settings.json"), "utf8"));
    expect(settings.mockMode).toBe(true);
    expect(settings.interfaceCreationConfiguredAt).toBeTruthy();

    await launch.cleanup();
    await expect(stat(userDataDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves non-profile application arguments", async () => {
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), "agentic-workbench-explicit-"));
    const launch = await prepareElectronLaunch({
      args: [`--user-data-dir=${userDataDir}`, "--safe-mode"],
      env: { AWB_MOCK_MODE: "1" }
    });
    try {
      expect(launch.applicationArgs).toEqual(["--safe-mode"]);
      expect(launch.userDataDir).toBe(path.resolve(userDataDir));
    } finally {
      await launch.cleanup();
      await rm(userDataDir, { recursive: true, force: true });
    }
  });
});
