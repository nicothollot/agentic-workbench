import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { parseUntrackedStatusPaths, resolveContentBoundPreviewRevision } from "@runtime/previewRevision";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];
const runtimeSettings = { executionMode: "local" as const, distroName: "Ubuntu" };

const makeTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "awb-preview-revision-"));
  temporaryRoots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("content-bound preview revisions", () => {
  it("parses NUL-delimited untracked paths without treating spaces as separators", () => {
    expect(parseUntrackedStatusPaths(" M src/app.ts\0?? public/new image.png\0R  next.ts\0old.ts\0"))
      .toEqual(["public/new image.png"]);
  });

  it("changes a Git revision for tracked and untracked working-tree content", async () => {
    const root = await makeTempRoot();
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "preview@example.test"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Preview Test"], { cwd: root });
    await writeFile(path.join(root, "app.ts"), "export const value = 1;\n", "utf8");
    await execFileAsync("git", ["add", "app.ts"], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "initial"], { cwd: root });

    const clean = await resolveContentBoundPreviewRevision({ projectRoot: root, projectHostPath: root, runtimeSettings });
    await writeFile(path.join(root, "app.ts"), "export const value = 2;\n", "utf8");
    const trackedDirty = await resolveContentBoundPreviewRevision({ projectRoot: root, projectHostPath: root, runtimeSettings });
    await writeFile(path.join(root, "new file.ts"), "export const added = true;\n", "utf8");
    const withUntracked = await resolveContentBoundPreviewRevision({ projectRoot: root, projectHostPath: root, runtimeSettings });

    expect(clean).toMatch(/^[a-f0-9]{40}$/);
    expect(trackedDirty).toMatch(new RegExp(`^${clean}:dirty:`));
    expect(withUntracked).not.toBe(trackedDirty);
  });

  it("changes a Git revision when ignored environment inputs change without exposing their values", async () => {
    const root = await makeTempRoot();
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "preview@example.test"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Preview Test"], { cwd: root });
    await writeFile(path.join(root, ".gitignore"), ".env*\n", "utf8");
    await writeFile(path.join(root, "app.ts"), "export const value = 1;\n", "utf8");
    await execFileAsync("git", ["add", ".gitignore", "app.ts"], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "initial"], { cwd: root });

    const withoutEnvironment = await resolveContentBoundPreviewRevision({ projectRoot: root, projectHostPath: root, runtimeSettings });
    await writeFile(path.join(root, ".env.local"), "PRIVATE_VALUE=first-secret\n", "utf8");
    const firstEnvironment = await resolveContentBoundPreviewRevision({ projectRoot: root, projectHostPath: root, runtimeSettings });
    await writeFile(path.join(root, ".env.local"), "PRIVATE_VALUE=second-secret\n", "utf8");
    const secondEnvironment = await resolveContentBoundPreviewRevision({ projectRoot: root, projectHostPath: root, runtimeSettings });

    expect(firstEnvironment).not.toBe(withoutEnvironment);
    expect(secondEnvironment).not.toBe(firstEnvironment);
    expect(firstEnvironment).not.toContain("first-secret");
    expect(secondEnvironment).not.toContain("second-secret");
  });

  it("hashes non-Git folder contents rather than stale scan metadata", async () => {
    const root = await makeTempRoot();
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "app.ts"), "first\n", "utf8");
    const first = await resolveContentBoundPreviewRevision({ projectRoot: root, projectHostPath: root, runtimeSettings });
    await writeFile(path.join(root, "src", "app.ts"), "second\n", "utf8");
    const second = await resolveContentBoundPreviewRevision({ projectRoot: root, projectHostPath: root, runtimeSettings });

    expect(first).toMatch(/^folder:[a-f0-9]{64}$/);
    expect(second).not.toBe(first);
  });
});
