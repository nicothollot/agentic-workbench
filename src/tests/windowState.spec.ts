import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { clampWindowBounds, defaultWindowBounds, WindowStateStore } from "@main/windowState";

describe("window state layout", () => {
  it("centers the first window and uses the available display", () => {
    expect(defaultWindowBounds({ x: 0, y: 0, width: 1920, height: 1080 })).toEqual({
      x: 220,
      y: 70,
      width: 1480,
      height: 940
    });
  });

  it("moves a disconnected-display window onto the current work area", () => {
    expect(clampWindowBounds(
      { x: 5000, y: -1000, width: 1480, height: 940 },
      [{ x: 0, y: 0, width: 1280, height: 720 }]
    )).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
  });

  it("preserves negative coordinates for a connected secondary display", () => {
    expect(clampWindowBounds(
      { x: -1700, y: 40, width: 1400, height: 900 },
      [
        { x: 0, y: 0, width: 1920, height: 1080 },
        { x: -1920, y: 0, width: 1920, height: 1080 }
      ]
    )).toEqual({ x: -1700, y: 40, width: 1400, height: 900 });
  });

  it("keeps a restored window inside a high-DPI laptop work area", () => {
    expect(clampWindowBounds(
      { x: -400, y: -200, width: 1480, height: 940 },
      [{ x: 0, y: 0, width: 911, height: 480 }]
    )).toEqual({ x: 0, y: 0, width: 911, height: 480 });

    expect(defaultWindowBounds({ x: 0, y: 0, width: 683, height: 384 })).toEqual({
      x: 34,
      y: 12,
      width: 614,
      height: 360
    });
  });

  it("recovers the save queue after a transient write failure", async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "awb-window-state-"));
    const userDataDir = path.join(temporaryRoot, "profile");
    await writeFile(userDataDir, "temporarily not a directory", "utf8");
    const store = new WindowStateStore(userDataDir);
    const state = {
      version: 1 as const,
      bounds: { x: 12, y: 18, width: 900, height: 700 },
      maximized: false
    };

    try {
      await expect(store.save(state)).rejects.toThrow();
      await unlink(userDataDir);
      await mkdir(userDataDir);
      await expect(store.save(state)).resolves.toBeUndefined();
      await expect(readFile(path.join(userDataDir, "window-state.json"), "utf8"))
        .resolves.toContain('"width": 900');
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
