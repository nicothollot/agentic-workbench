import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PersistedWindowState {
  version: 1;
  bounds: WindowBounds;
  maximized: boolean;
}

// Keep Electron's native minimum aligned with the renderer's compact layout.
// This must remain below the logical work area of common high-DPI Windows
// laptops (for example 1366x768 at 150-200% scaling).
export const MINIMUM_WINDOW_SIZE = { width: 600, height: 360 } as const;

const windowBoundsSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().min(320),
  height: z.number().int().min(240)
});

const persistedWindowStateSchema = z.object({
  version: z.literal(1),
  bounds: windowBoundsSchema,
  maximized: z.boolean()
});

const intersectionArea = (left: WindowBounds, right: WindowBounds): number => {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  return width * height;
};

export const clampWindowBounds = (
  requested: WindowBounds,
  workAreas: WindowBounds[],
  minimum = MINIMUM_WINDOW_SIZE
): WindowBounds => {
  const fallback = workAreas[0] ?? { x: 0, y: 0, width: 1480, height: 940 };
  const workArea = workAreas.reduce(
    (best, candidate) => intersectionArea(requested, candidate) > intersectionArea(requested, best) ? candidate : best,
    fallback
  );
  const width = Math.min(workArea.width, Math.max(Math.min(minimum.width, workArea.width), requested.width));
  const height = Math.min(workArea.height, Math.max(Math.min(minimum.height, workArea.height), requested.height));
  return {
    x: Math.min(Math.max(requested.x, workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(requested.y, workArea.y), workArea.y + workArea.height - height),
    width,
    height
  };
};

export const defaultWindowBounds = (workArea: WindowBounds): WindowBounds => {
  const width = Math.max(Math.min(1480, Math.floor(workArea.width * 0.9)), Math.min(MINIMUM_WINDOW_SIZE.width, workArea.width));
  const height = Math.max(Math.min(940, Math.floor(workArea.height * 0.9)), Math.min(MINIMUM_WINDOW_SIZE.height, workArea.height));
  return {
    x: workArea.x + Math.floor((workArea.width - width) / 2),
    y: workArea.y + Math.floor((workArea.height - height) / 2),
    width,
    height
  };
};

export class WindowStateStore {
  private readonly filePath: string;
  private saveInFlight: Promise<void> = Promise.resolve();

  constructor(userDataDir: string) {
    this.filePath = path.join(userDataDir, "window-state.json");
  }

  async load(): Promise<PersistedWindowState | undefined> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return persistedWindowStateSchema.parse(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }

  async save(state: PersistedWindowState): Promise<void> {
    const validated = persistedWindowStateSchema.parse(state);
    // A transient filesystem failure must not poison every later resize/move
    // persistence attempt for the lifetime of the Electron process.
    this.saveInFlight = this.saveInFlight.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
      await rename(temporaryPath, this.filePath);
    });
    await this.saveInFlight;
  }
}
