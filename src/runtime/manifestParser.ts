import { readFile } from "node:fs/promises";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import { parse as parseToml } from "smol-toml";
import type { DependencyRecord } from "@shared/types";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: ""
});

const supportedDependencyManifests = new Set([
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "Pipfile",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "composer.json"
]);

const splitRequirementsLine = (line: string): { name: string; version: string } | null => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) {
    return null;
  }

  const match = trimmed.match(/^([A-Za-z0-9_.-]+)\s*([=<>!~].+)?$/);
  if (!match) {
    return null;
  }

  return {
    name: match[1],
    version: match[2]?.trim() ?? "unspecified"
  };
};

const parsePackageJson = (manifestPath: string, raw: string): DependencyRecord[] => {
  const packageJson = JSON.parse(raw) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };

  const records: DependencyRecord[] = [];
  for (const [name, version] of Object.entries(packageJson.dependencies ?? {})) {
    records.push({ manifest: manifestPath, ecosystem: "npm", name, version });
  }
  for (const [name, version] of Object.entries(packageJson.devDependencies ?? {})) {
    records.push({ manifest: manifestPath, ecosystem: "npm", name, version, dev: true });
  }
  for (const [name, version] of Object.entries(packageJson.peerDependencies ?? {})) {
    records.push({ manifest: manifestPath, ecosystem: "npm-peer", name, version });
  }
  return records;
};

const parseRequirements = (manifestPath: string, raw: string): DependencyRecord[] =>
  raw
    .split(/\r?\n/)
    .map((line) => splitRequirementsLine(line))
    .filter((entry): entry is { name: string; version: string } => Boolean(entry))
    .map((entry) => ({
      manifest: manifestPath,
      ecosystem: "python",
      name: entry.name,
      version: entry.version
    }));

const parseTomlDependencies = (
  manifestPath: string,
  raw: string,
  dependencyPaths: string[]
): DependencyRecord[] => {
  const document = parseToml(raw) as Record<string, unknown>;
  const records: DependencyRecord[] = [];

  for (const dependencyPath of dependencyPaths) {
    const value = dependencyPath.split(".").reduce<unknown>((current, segment) => {
      if (!current || typeof current !== "object") {
        return undefined;
      }
      return (current as Record<string, unknown>)[segment];
    }, document);

    if (!value || typeof value !== "object") {
      continue;
    }

    for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
      if (typeof entry === "string") {
        records.push({
          manifest: manifestPath,
          ecosystem: "toml",
          name,
          version: entry
        });
        continue;
      }

      if (entry && typeof entry === "object" && "version" in entry) {
        const version = (entry as { version?: unknown }).version;
        records.push({
          manifest: manifestPath,
          ecosystem: "toml",
          name,
          version: typeof version === "string" ? version : "workspace"
        });
      }
    }
  }

  return records;
};

const parseGoMod = (manifestPath: string, raw: string): DependencyRecord[] => {
  const records: DependencyRecord[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    const match = trimmed.match(/^([A-Za-z0-9./_-]+)\s+v?([A-Za-z0-9+_.-]+)$/);
    if (match && !trimmed.startsWith("module ") && !trimmed.startsWith("go ")) {
      records.push({
        manifest: manifestPath,
        ecosystem: "go",
        name: match[1],
        version: match[2]
      });
    }
  }
  return records;
};

const parsePomXml = (manifestPath: string, raw: string): DependencyRecord[] => {
  const document = xmlParser.parse(raw) as {
    project?: {
      dependencies?: {
        dependency?: Array<{ artifactId?: string; version?: string; scope?: string }> | { artifactId?: string; version?: string; scope?: string };
      };
    };
  };
  const dependencyEntries = document.project?.dependencies?.dependency;
  const list = Array.isArray(dependencyEntries) ? dependencyEntries : dependencyEntries ? [dependencyEntries] : [];

  return list
    .filter((entry) => entry.artifactId)
    .map((entry) => ({
      manifest: manifestPath,
      ecosystem: "maven",
      name: entry.artifactId ?? "unknown",
      version: entry.version ?? "managed",
      dev: entry.scope === "test"
    }));
};

const parseGradle = (manifestPath: string, raw: string): DependencyRecord[] => {
  const records: DependencyRecord[] = [];
  const regex = /(?:implementation|api|testImplementation|runtimeOnly)\s+["']([^:"']+):([^:"']+):([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(raw)) !== null) {
    records.push({
      manifest: manifestPath,
      ecosystem: "gradle",
      name: `${match[1]}:${match[2]}`,
      version: match[3],
      dev: match[0].startsWith("test")
    });
  }
  return records;
};

const parseGemfile = (manifestPath: string, raw: string): DependencyRecord[] => {
  const records: DependencyRecord[] = [];
  const regex = /gem\s+["']([^"']+)["'](?:,\s*["']([^"']+)["'])?/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(raw)) !== null) {
    records.push({
      manifest: manifestPath,
      ecosystem: "ruby",
      name: match[1],
      version: match[2] ?? "latest"
    });
  }
  return records;
};

const parseComposerJson = (manifestPath: string, raw: string): DependencyRecord[] => {
  const composer = JSON.parse(raw) as { require?: Record<string, string>; "require-dev"?: Record<string, string> };
  const records: DependencyRecord[] = [];
  for (const [name, version] of Object.entries(composer.require ?? {})) {
    records.push({ manifest: manifestPath, ecosystem: "composer", name, version });
  }
  for (const [name, version] of Object.entries(composer["require-dev"] ?? {})) {
    records.push({ manifest: manifestPath, ecosystem: "composer", name, version, dev: true });
  }
  return records;
};

export const parseManifestFile = async (projectRoot: string, relativePath: string): Promise<DependencyRecord[]> => {
  if (!supportedDependencyManifests.has(path.basename(relativePath))) {
    return [];
  }

  const absolutePath = path.join(projectRoot, relativePath);
  const raw = await readFile(absolutePath, "utf8");

  if (relativePath.endsWith("package.json")) {
    return parsePackageJson(relativePath, raw);
  }

  if (relativePath.endsWith("requirements.txt") || relativePath.endsWith("Pipfile")) {
    return parseRequirements(relativePath, raw);
  }

  if (relativePath.endsWith("pyproject.toml")) {
    return parseTomlDependencies(relativePath, raw, ["project.dependencies", "tool.poetry.dependencies"]);
  }

  if (relativePath.endsWith("Cargo.toml")) {
    return parseTomlDependencies(relativePath, raw, ["dependencies", "dev-dependencies"]);
  }

  if (relativePath.endsWith("go.mod")) {
    return parseGoMod(relativePath, raw);
  }

  if (relativePath.endsWith("pom.xml")) {
    return parsePomXml(relativePath, raw);
  }

  if (relativePath.endsWith("build.gradle") || relativePath.endsWith("build.gradle.kts")) {
    return parseGradle(relativePath, raw);
  }

  if (relativePath.endsWith("Gemfile")) {
    return parseGemfile(relativePath, raw);
  }

  if (relativePath.endsWith("composer.json")) {
    return parseComposerJson(relativePath, raw);
  }

  return [];
};

export const detectPrimaryManagers = (manifestFiles: string[]): string[] => {
  const managers = new Set<string>();
  for (const file of manifestFiles) {
    if (file.endsWith("package.json")) {
      managers.add("npm");
    }
    if (file.endsWith("pnpm-lock.yaml")) {
      managers.add("pnpm");
    }
    if (file.endsWith("yarn.lock")) {
      managers.add("yarn");
    }
    if (file.endsWith("pyproject.toml") || file.endsWith("requirements.txt")) {
      managers.add("python");
    }
    if (file.endsWith("Cargo.toml")) {
      managers.add("cargo");
    }
    if (file.endsWith("go.mod")) {
      managers.add("go");
    }
    if (file.endsWith("pom.xml") || file.endsWith("build.gradle") || file.endsWith("build.gradle.kts")) {
      managers.add("java");
    }
    if (file.endsWith("Gemfile")) {
      managers.add("bundler");
    }
    if (file.endsWith("composer.json")) {
      managers.add("composer");
    }
  }
  return [...managers];
};
