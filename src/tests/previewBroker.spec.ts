import { constants } from "node:fs";
import { access, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultSettings } from "@shared/defaults";
import type { PreviewProjectContext } from "@runtime/previewBroker";
import { PreviewBroker, buildPreviewNodeCommandSpec } from "@runtime/previewBroker";
import { createTempDir } from "./helpers";

const workerPath = path.resolve("scripts", "preview-broker", "worker.cjs");
const originalBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;

afterEach(() => {
  if (originalBrowsersPath === undefined) {
    delete process.env.PLAYWRIGHT_BROWSERS_PATH;
  } else {
    process.env.PLAYWRIGHT_BROWSERS_PATH = originalBrowsersPath;
  }
});

const projectContext = (root: string, projectId = "preview-project"): PreviewProjectContext => ({
  projectId,
  projectFingerprint: `fingerprint-${projectId}`,
  projectRoot: root,
  projectHostPath: root,
  sourceRevision: "revision-1",
  cycleNumber: 1
});

const findCompatibleCachedChromium = async (): Promise<string | undefined> => {
  if (process.platform !== "linux") return undefined;
  const cacheRoot = path.join(homedir(), ".cache", "ms-playwright");
  let entries: string[];
  try {
    entries = (await readdir(cacheRoot))
      .filter((entry) => /^chromium-\d+$/.test(entry))
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const candidate = path.join(cacheRoot, entry);
    try {
      await access(path.join(candidate, "chrome-linux", "chrome"), constants.X_OK);
      return candidate;
    } catch {
      // This Playwright version expects the chrome-linux layout.
    }
  }
  return undefined;
};

const configureCompatibleBrowserCache = async (): Promise<boolean> => {
  const installed = await findCompatibleCachedChromium();
  if (!installed) return false;
  const browsersManifest = JSON.parse(await readFile(path.resolve("node_modules", "playwright-core", "browsers.json"), "utf8")) as {
    browsers: Array<{ name: string; revision: string }>;
  };
  const revision = browsersManifest.browsers.find((browser) => browser.name === "chromium")?.revision;
  if (!revision) return false;
  const root = await createTempDir("preview-browser-cache");
  await symlink(installed, path.join(root, `chromium-${revision}`), "dir");
  process.env.PLAYWRIGHT_BROWSERS_PATH = root;
  return true;
};

describe("PreviewBroker", () => {
  it("carries an NVM Node runtime into worker and browser-install structured commands", () => {
    const runtime = {
      resolvedNodeCommand: "/home/test/.nvm/versions/node/v22.22.0/bin/node",
      runtimePathDirs: ["/home/test/.nvm/versions/node/v22.22.0/bin"]
    };

    expect(buildPreviewNodeCommandSpec(runtime, ["/opt/workbench/preview/worker.cjs"], {
      timeoutMs: 180_000
    })).toEqual({
      command: runtime.resolvedNodeCommand,
      args: ["/opt/workbench/preview/worker.cjs"],
      runtimePathDirs: runtime.runtimePathDirs,
      timeoutMs: 180_000
    });
    expect(buildPreviewNodeCommandSpec(runtime, ["/opt/workbench/playwright-core/cli.js", "install", "chromium"], {
      timeoutMs: 600_000,
      maxOutputBytes: 8 * 1024 * 1024
    })).toEqual({
      command: runtime.resolvedNodeCommand,
      args: ["/opt/workbench/playwright-core/cli.js", "install", "chromium"],
      runtimePathDirs: runtime.runtimePathDirs,
      timeoutMs: 600_000,
      maxOutputBytes: 8 * 1024 * 1024
    });
  });

  it("removes unreachable artifact evidence left by an earlier process", async () => {
    const root = await createTempDir("preview-orphan-cleanup");
    const appData = await createTempDir("preview-orphan-cleanup-appdata");
    const staleArtifact = path.join(appData, "preview", "artifacts", "stale-project", "stale-session", "capture.png");
    await mkdir(path.dirname(staleArtifact), { recursive: true });
    await writeFile(staleArtifact, "unreachable evidence");
    await writeFile(path.join(root, "index.html"), "<h1>Cleanup fixture</h1>");
    const broker = new PreviewBroker(appData, workerPath, defaultSettings);

    try {
      const pending = await broker.startPreview(projectContext(root, "cleanup-orphans"));
      expect(pending.status).toBe("trust_required");
      await expect(access(staleArtifact)).rejects.toThrow();
    } finally {
      await broker.dispose();
    }
  });

  it("keeps execution trust scoped to both the project and recipe fingerprint", async () => {
    const root = await createTempDir("preview-trust");
    const appData = await createTempDir("preview-trust-appdata");
    await writeFile(path.join(root, "index.html"), "<h1>First version</h1>");
    const broker = new PreviewBroker(appData, workerPath, defaultSettings);
    const context = projectContext(root);

    try {
      const first = await broker.startPreview(context);
      expect(first.status).toBe("trust_required");
      const trust = await broker.grantTrust(context);
      expect(trust.projectFingerprint).toBe(context.projectFingerprint);

      await writeFile(path.join(root, "index.html"), "<h1>Changed recipe fingerprint</h1>");
      const changed = await broker.startPreview({ ...context, sourceRevision: "revision-2" });
      expect(changed.status).toBe("trust_required");
      expect(changed.recipe.fingerprint).not.toBe(first.recipe.fingerprint);

      const persisted = JSON.parse(await readFile(path.join(appData, "preview", "trust.json"), "utf8")) as unknown[];
      expect(persisted).toHaveLength(1);
    } finally {
      await broker.dispose();
    }
  });

  it("reports the managed browser install command and cleans a spawned server when browser launch fails", async () => {
    const root = await createTempDir("preview-process-cleanup");
    const appData = await createTempDir("preview-process-cleanup-appdata");
    const emptyBrowserCache = await createTempDir("preview-empty-browser-cache");
    process.env.PLAYWRIGHT_BROWSERS_PATH = emptyBrowserCache;
    await mkdir(path.join(root, ".agent-workbench"), { recursive: true });
    await writeFile(path.join(root, ".agent-workbench", "preview.json"), JSON.stringify({
      command: "node",
      args: ["server.cjs", "{port}"],
      cwd: ".",
      urlPath: "/",
      adapter: "custom"
    }));
    await writeFile(path.join(root, "server.cjs"), `
      const fs = require("node:fs");
      const http = require("node:http");
      fs.writeFileSync("server.pid", String(process.pid));
      http.createServer((_request, response) => response.end("ready")).listen(Number(process.argv[2]), "127.0.0.1");
    `);
    const broker = new PreviewBroker(appData, workerPath, defaultSettings);
    const context = projectContext(root, "cleanup-project");

    try {
      const readiness = await broker.getReadiness(context, true);
      expect(readiness.status).toBe("browser_required");
      expect(readiness.browserInstallCommand).toMatch(/^'node' /);
      expect(readiness.browserInstallCommand).toContain("node_modules/playwright-core/cli.js");
      await broker.grantTrust(context);
      await expect(broker.startPreview(context)).rejects.toThrow("Chromium is unavailable");
      expect(broker.getProjection(context.projectId).activeSession?.status).toBe("failed");

      const serverPid = Number(await readFile(path.join(root, "server.pid"), "utf8"));
      expect(Number.isInteger(serverPid)).toBe(true);
      expect(() => process.kill(serverPid, 0)).toThrow();
    } finally {
      await broker.dispose();
    }
  }, 25_000);

  it("atomically trusts only the exact stored session context and preserves its pre-merge checkpoint", async () => {
    const hasBrowser = await configureCompatibleBrowserCache();
    if (!hasBrowser) {
      process.env.PLAYWRIGHT_BROWSERS_PATH = await createTempDir("preview-atomic-empty-browser-cache");
    }
    const mainRoot = await createTempDir("preview-atomic-main");
    const integrationRoot = await createTempDir("preview-atomic-integration");
    const appData = await createTempDir("preview-atomic-appdata");
    await mkdir(path.join(integrationRoot, ".agent-workbench"), { recursive: true });
    const recipe = {
      command: "node",
      args: ["server.cjs", "{port}"],
      cwd: ".",
      urlPath: "/",
      adapter: "custom"
    };
    const recipePath = path.join(integrationRoot, ".agent-workbench", "preview.json");
    await writeFile(recipePath, JSON.stringify(recipe));
    await writeFile(path.join(integrationRoot, "server.cjs"), `
      const fs = require("node:fs");
      const http = require("node:http");
      fs.writeFileSync("integration-launched.txt", process.cwd());
      http.createServer((_request, response) => response.end("<!doctype html><title>Integration worktree</title><h1>Integration worktree</h1>")).listen(Number(process.argv[2]), "127.0.0.1");
    `);
    const broker = new PreviewBroker(appData, workerPath, defaultSettings);
    const context: PreviewProjectContext = {
      ...projectContext(integrationRoot, "atomic-project"),
      projectRoot: integrationRoot,
      projectHostPath: integrationRoot,
      projectFingerprint: "atomic-project-fingerprint",
      sourceRevision: "integration-commit-sha",
      cycleNumber: 7
    };

    try {
      const pending = await broker.startPreview(context, "pre_merge");
      expect(pending.status).toBe("trust_required");
      await expect(broker.trustAndStartPreview("different-project", pending.id)).rejects.toThrow("does not belong");
      await expect(broker.trustAndStartPreview(context.projectId, "missing-session")).rejects.toThrow("does not belong");

      await writeFile(recipePath, JSON.stringify({ ...recipe, args: ["changed-server.cjs", "{port}"] }));
      await expect(broker.trustAndStartPreview(context.projectId, pending.id)).rejects.toThrow("recipe changed");
      await writeFile(recipePath, JSON.stringify(recipe));

      if (hasBrowser) {
        const restarted = await broker.trustAndStartPreview(context.projectId, pending.id);
        expect(restarted.status).toBe("ready");
        expect(restarted.latestSnapshot?.title).toBe("Integration worktree");
      } else {
        await expect(broker.trustAndStartPreview(context.projectId, pending.id)).rejects.toThrow("Chromium is unavailable");
      }

      const restarted = broker.getProjection(context.projectId).activeSession;
      expect(restarted).toMatchObject({
        projectId: context.projectId,
        projectFingerprint: context.projectFingerprint,
        sourceRevision: context.sourceRevision,
        checkpointKind: "pre_merge"
      });
      expect(await readFile(path.join(integrationRoot, "integration-launched.txt"), "utf8")).toBe(integrationRoot);
      await expect(access(path.join(mainRoot, "integration-launched.txt"))).rejects.toThrow();
      expect(JSON.stringify(broker.getProjection(context.projectId))).not.toContain(integrationRoot);
      if (hasBrowser) {
        expect(broker.getProjection(context.projectId).latestReport).toMatchObject({
          cycleNumber: 7,
          checkpointKind: "pre_merge",
          sourceRevision: "integration-commit-sha"
        });
      }
      await expect(broker.trustAndStartPreview(context.projectId, pending.id)).rejects.toThrow("trust-required");
    } finally {
      await broker.dispose();
    }
  }, 45_000);

  it("runs the versioned worker, captures real browser evidence, and idles cleanly when Chromium is cached", async () => {
    const hasBrowser = await configureCompatibleBrowserCache();
    const root = await createTempDir("preview-browser-project");
    const appData = await createTempDir("preview-browser-appdata");
    const outsideRoot = await createTempDir("preview-browser-outside");
    await writeFile(path.join(outsideRoot, "secret.txt"), "must-not-be-served");
    await symlink(path.join(outsideRoot, "secret.txt"), path.join(root, "escape.txt"));
    await writeFile(path.join(root, "index.html"), `<!doctype html>
      <html><head><title>Preview fixture</title></head><body>
        <label>Name <input aria-label="Name"></label>
        <button aria-label="Apply" onclick="document.querySelector('output').textContent = document.querySelector('input').value">Apply</button>
        <output role="status">Waiting</output>
      </body></html>`);
    const broker = new PreviewBroker(appData, workerPath, defaultSettings, { sessionIdleTimeoutMs: 1_000 });
    const context = projectContext(root, "browser-project");

    try {
      const readiness = await broker.getReadiness(context, true);
      if (!hasBrowser) {
        expect(readiness.status).toBe("browser_required");
        expect(readiness.browserInstallCommand).toContain("playwright-core");
        return;
      }

      expect(readiness.status, readiness.message).toBe("ready");
      await broker.grantTrust(context);
      const session = await broker.startPreview(context);
      expect(session.status).toBe("ready");
      expect(session.validatedUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
      expect(session.artifacts.filter((artifact) => artifact.kind === "screenshot")).toHaveLength(3);
      expect(session.latestSnapshot?.title).toBe("Preview fixture");

      const screenshot = session.artifacts.find((artifact) => artifact.kind === "screenshot");
      expect(screenshot).toBeDefined();
      const payload = await broker.getArtifact(context.projectId, session.id, screenshot!.id);
      expect([...payload.bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

      const input = session.latestSnapshot?.elements.find((element) => element.name === "Name");
      expect(input).toBeDefined();
      const filled = await broker.performAction(context.projectId, session.id, { type: "fill", ref: input!.ref, value: "Codex" });
      await expect(broker.performAction(context.projectId, session.id, { type: "click", ref: input!.ref })).rejects.toThrow("stale");
      const button = filled.latestSnapshot?.elements.find((element) => element.name === "Apply");
      expect(button).toBeDefined();
      const clicked = await broker.performAction(context.projectId, session.id, { type: "click", ref: button!.ref });
      expect(clicked.latestSnapshot?.ariaSnapshot).toContain("Codex");

      const report = broker.getProjection(context.projectId).latestReport;
      expect(report?.verdict).toBe("pass");
      expect(broker.approveReport(context.projectId, session.id).approvedAt).toBeDefined();
      await expect(broker.performAction(context.projectId, session.id, { type: "navigate", url: "https://example.com" })).rejects.toThrow("outside");

      const escaped = await broker.performAction(context.projectId, session.id, { type: "navigate", url: "/escape.txt" });
      expect(escaped.latestSnapshot?.ariaSnapshot).not.toContain("must-not-be-served");
      const updatedReport = broker.getProjection(context.projectId).latestReport;
      expect(updatedReport?.verdict).toBe("needs_review");
      expect(updatedReport?.approvedAt).toBeUndefined();

      await expect.poll(
        () => broker.getProjection(context.projectId).activeSession?.status,
        { timeout: 5_000, interval: 100 }
      ).toBe("stopped");
      await expect(fetch(session.validatedUrl!, { signal: AbortSignal.timeout(500) })).rejects.toThrow();
    } finally {
      await broker.dispose();
    }
  }, 60_000);
});
