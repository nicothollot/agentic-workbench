import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { PreviewAdapter, PreviewRecipe } from "@shared/types";
import { sha256 } from "./hashUtils";

const MAX_PREVIEW_CONFIG_BYTES = 128 * 1024;
const MAX_PACKAGE_JSON_BYTES = 2 * 1024 * 1024;
const PORT_TOKEN = "{port}";

const previewUrlPathSchema = z.string()
  .startsWith("/")
  .max(1_000)
  .refine((value) => !value.startsWith("//") && !value.includes("\\"), {
    message: "Preview urlPath must be a project-relative URL path, not an origin or network path."
  });

const explicitRecipeSchema = z.object({
  command: z.string().trim().min(1).max(512),
  args: z.array(z.string().max(2_000).refine((value) => !value.includes("\0"), "Arguments cannot contain NUL bytes.")).max(64).default([]),
  cwd: z.string().trim().min(1).max(1_000).default("."),
  urlPath: previewUrlPathSchema.default("/"),
  adapter: z.enum(["vite", "next", "cra", "astro", "static", "custom"]).default("custom")
}).strict().superRefine((recipe, context) => {
  const getsPortFromEnvironment = recipe.adapter === "cra";
  const usesBuiltInStaticServer = recipe.adapter === "static" && recipe.command === "__awb_static__";
  if (!getsPortFromEnvironment && !usesBuiltInStaticServer && !recipe.args.some((argument) => argument.includes(PORT_TOKEN))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["args"],
      message: `Preview recipe args must include ${PORT_TOKEN} so the broker can allocate an isolated loopback port.`
    });
  }
});

type PackageManifest = {
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
};

export type PreviewRecipeDetection =
  | { status: "ready"; recipe: PreviewRecipe; message: string }
  | { status: "recipe_required"; message: string };

type BoundedTextResult =
  | { status: "ready"; text: string }
  | { status: "missing" }
  | { status: "invalid"; message: string };

const readBoundedText = async (filePath: string, limit: number): Promise<BoundedTextResult> => {
  try {
    const file = await stat(filePath);
    if (!file.isFile()) {
      return { status: "invalid", message: "The path is not a regular file." };
    }
    if (file.size > limit) {
      return { status: "invalid", message: `The file exceeds the ${limit.toLocaleString()} byte limit.` };
    }
    return { status: "ready", text: await readFile(filePath, "utf8") };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? { status: "missing" }
      : { status: "invalid", message: error instanceof Error ? error.message : String(error) };
  }
};

const exists = async (filePath: string): Promise<boolean> => {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
};

const normalizeRelativeCwd = (value: string): string => {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "") || ".";
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")) {
    throw new Error("Preview recipe cwd must stay inside the opened project.");
  }
  return normalized;
};

const validateExecutable = (value: string): string => {
  if (/\s/.test(value) || /[;&|`$<>\r\n\0]/.test(value)) {
    throw new Error("Preview recipe command must be a single executable, not a shell expression.");
  }
  return value;
};

const buildRecipe = (input: {
  adapter: PreviewAdapter;
  source: PreviewRecipe["source"];
  command: string;
  args: string[];
  cwd: string;
  urlPath: string;
  manifestPath?: string;
  fingerprintInput: unknown;
}): PreviewRecipe => {
  const fingerprint = sha256(JSON.stringify(input.fingerprintInput));
  return {
    id: `preview-${fingerprint.slice(0, 16)}`,
    adapter: input.adapter,
    source: input.source,
    command: validateExecutable(input.command),
    args: input.args,
    cwd: normalizeRelativeCwd(input.cwd),
    urlPath: input.urlPath,
    fingerprint,
    manifestPath: input.manifestPath
  };
};

const packageManager = async (hostRoot: string): Promise<"npm" | "pnpm" | "yarn"> => {
  if (await exists(path.join(hostRoot, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (await exists(path.join(hostRoot, "yarn.lock"))) {
    return "yarn";
  }
  return "npm";
};

const managerArgs = (manager: "npm" | "pnpm" | "yarn", script: string, forwarded: string[]): string[] => {
  if (manager === "yarn") {
    return [script, ...forwarded];
  }
  return ["run", script, "--", ...forwarded];
};

const detectAdapter = (manifest: PackageManifest): PreviewAdapter | undefined => {
  const dependencies = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
  if ("vite" in dependencies) {
    return "vite";
  }
  if ("next" in dependencies) {
    return "next";
  }
  if ("react-scripts" in dependencies) {
    return "cra";
  }
  if ("astro" in dependencies) {
    return "astro";
  }
  return undefined;
};

const adapterForwardedArgs = (adapter: PreviewAdapter): string[] => {
  if (adapter === "next") {
    return ["--hostname", "127.0.0.1", "--port", PORT_TOKEN];
  }
  if (adapter === "vite" || adapter === "astro") {
    return ["--host", "127.0.0.1", "--port", PORT_TOKEN, "--strictPort"];
  }
  return [];
};

export const detectPreviewRecipe = async (hostRoot: string): Promise<PreviewRecipeDetection> => {
  const explicitPath = path.join(hostRoot, ".agent-workbench", "preview.json");
  const explicitResult = await readBoundedText(explicitPath, MAX_PREVIEW_CONFIG_BYTES);
  if (explicitResult.status === "invalid") {
    return {
      status: "recipe_required",
      message: `The explicit preview recipe could not be read safely: ${explicitResult.message}`
    };
  }
  if (explicitResult.status === "ready") {
    const explicitText = explicitResult.text;
    let raw: unknown;
    try {
      raw = JSON.parse(explicitText);
    } catch (error) {
      return {
        status: "recipe_required",
        message: `The explicit preview recipe is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
      };
    }
    try {
      const explicit = explicitRecipeSchema.parse(raw);
      const recipe = buildRecipe({
        ...explicit,
        source: "explicit",
        manifestPath: ".agent-workbench/preview.json",
        fingerprintInput: { explicit, content: explicitText }
      });
      return { status: "ready", recipe, message: "Using the project's explicit preview recipe." };
    } catch (error) {
      return {
        status: "recipe_required",
        message: `The explicit preview recipe is unsafe or invalid: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  const packagePath = path.join(hostRoot, "package.json");
  const packageResult = await readBoundedText(packagePath, MAX_PACKAGE_JSON_BYTES);
  if (packageResult.status === "ready") {
    const packageText = packageResult.text;
    try {
      const manifest = JSON.parse(packageText) as PackageManifest;
      const adapter = detectAdapter(manifest);
      const scripts = manifest.scripts ?? {};
      const script = ["preview", "dev", "start"].find((name) => typeof scripts[name] === "string");
      if (adapter && script) {
        const manager = await packageManager(hostRoot);
        const args = managerArgs(manager, script, adapterForwardedArgs(adapter));
        const recipe = buildRecipe({
          adapter,
          source: "detected",
          command: manager,
          args,
          cwd: ".",
          urlPath: "/",
          manifestPath: "package.json",
          fingerprintInput: {
            adapter,
            manager,
            script,
            scriptValue: scripts[script],
            args,
            packageHash: sha256(packageText)
          }
        });
        return { status: "ready", recipe, message: `Detected a ${adapter} preview using ${manager} ${script}.` };
      }
    } catch {
      // The repository scanner reports malformed package.json separately. A
      // guided recipe remains safer than guessing here.
    }
  }

  const indexResult = await readBoundedText(path.join(hostRoot, "index.html"), MAX_PACKAGE_JSON_BYTES);
  if (indexResult.status === "invalid") {
    return {
      status: "recipe_required",
      message: `The static preview entry point could not be read safely: ${indexResult.message}`
    };
  }
  if (indexResult.status === "ready") {
    const recipe = buildRecipe({
      adapter: "static",
      source: "detected",
      command: "__awb_static__",
      args: [],
      cwd: ".",
      urlPath: "/",
      manifestPath: "index.html",
      fingerprintInput: { adapter: "static", index: indexResult.text }
    });
    return { status: "ready", recipe, message: "Detected a static HTML preview." };
  }

  return {
    status: "recipe_required",
    message: "No deterministic browser preview recipe was found. Add .agent-workbench/preview.json or choose a command in Preview."
  };
};

export const materializePreviewRecipe = (recipe: PreviewRecipe, port: number): PreviewRecipe => {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Preview port must be an integer between 1 and 65535.");
  }
  return {
    ...recipe,
    args: recipe.args.map((argument) => argument.replaceAll(PORT_TOKEN, String(port)))
  };
};
