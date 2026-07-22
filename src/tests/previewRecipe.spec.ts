import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectPreviewRecipe, materializePreviewRecipe } from "@runtime/previewRecipe";
import { createTempDir } from "./helpers";

describe("preview recipe detection", () => {
  it("detects Vite without executing a package script", async () => {
    const root = await createTempDir("preview-vite");
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: { dev: "vite" },
      devDependencies: { vite: "7.1.3" }
    }));
    await writeFile(path.join(root, "package-lock.json"), "{}");

    const result = await detectPreviewRecipe(root);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      return;
    }
    expect(result.recipe).toMatchObject({ adapter: "vite", command: "npm", source: "detected" });
    expect(materializePreviewRecipe(result.recipe, 43127).args).toContain("43127");
  });

  it("prefers a validated explicit recipe", async () => {
    const root = await createTempDir("preview-explicit");
    await mkdir(path.join(root, ".agent-workbench"), { recursive: true });
    await writeFile(path.join(root, ".agent-workbench", "preview.json"), JSON.stringify({
      command: "npm",
      args: ["run", "storybook", "--", "--port", "{port}"],
      cwd: ".",
      urlPath: "/components",
      adapter: "custom"
    }));

    const result = await detectPreviewRecipe(root);
    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.recipe).toMatchObject({ source: "explicit", command: "npm", urlPath: "/components" });
    }
  });

  it("rejects shell expressions and parent-directory cwd", async () => {
    const root = await createTempDir("preview-unsafe");
    await mkdir(path.join(root, ".agent-workbench"), { recursive: true });
    await writeFile(path.join(root, ".agent-workbench", "preview.json"), JSON.stringify({
      command: "npm && curl example.com",
      cwd: "../outside"
    }));

    const result = await detectPreviewRecipe(root);
    expect(result.status).toBe("recipe_required");
    expect(result.message).toContain("unsafe");
  });

  it("requires custom commands to consume the isolated broker port", async () => {
    const root = await createTempDir("preview-port-token");
    await mkdir(path.join(root, ".agent-workbench"), { recursive: true });
    await writeFile(path.join(root, ".agent-workbench", "preview.json"), JSON.stringify({
      command: "npm",
      args: ["run", "storybook"],
      adapter: "custom"
    }));

    const result = await detectPreviewRecipe(root);
    expect(result.status).toBe("recipe_required");
    expect(result.message).toContain("{port}");
  });

  it("rejects origin-like urlPath values", async () => {
    const root = await createTempDir("preview-url-path");
    await mkdir(path.join(root, ".agent-workbench"), { recursive: true });
    await writeFile(path.join(root, ".agent-workbench", "preview.json"), JSON.stringify({
      command: "npm",
      args: ["run", "storybook", "--", "--port", "{port}"],
      urlPath: "//example.com/",
      adapter: "custom"
    }));

    const result = await detectPreviewRecipe(root);
    expect(result.status).toBe("recipe_required");
    expect(result.message).toContain("urlPath");
  });

  it("fails closed when an explicit recipe exceeds its read limit", async () => {
    const root = await createTempDir("preview-oversized-recipe");
    await mkdir(path.join(root, ".agent-workbench"), { recursive: true });
    await writeFile(path.join(root, ".agent-workbench", "preview.json"), " ".repeat(129 * 1024));
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: { dev: "vite" },
      devDependencies: { vite: "7.1.3" }
    }));

    const result = await detectPreviewRecipe(root);
    expect(result.status).toBe("recipe_required");
    expect(result.message).toContain("byte limit");
  });

  it("fingerprints static entry-point contents and validates materialized ports", async () => {
    const root = await createTempDir("preview-static-fingerprint");
    await writeFile(path.join(root, "index.html"), "<h1>First</h1>");
    const first = await detectPreviewRecipe(root);
    await writeFile(path.join(root, "index.html"), "<h1>Second</h1>");
    const second = await detectPreviewRecipe(root);

    expect(first.status).toBe("ready");
    expect(second.status).toBe("ready");
    if (first.status === "ready" && second.status === "ready") {
      expect(first.recipe.adapter).toBe("static");
      expect(first.recipe.fingerprint).not.toBe(second.recipe.fingerprint);
      expect(() => materializePreviewRecipe(first.recipe, 70_000)).toThrow("between 1 and 65535");
    }
  });
});
