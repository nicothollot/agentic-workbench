import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FileSummary, ProjectOverview } from "@shared/types";
import { nowIso } from "@shared/utils";
import { sha256 } from "./hashUtils";
import type { ScannedFile } from "./repoScanner";

const symbolRegexByExtension: Array<{ match: RegExp; label: string }> = [
  { match: /\bexport\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g, label: "function" },
  { match: /\bfunction\s+([A-Za-z0-9_]+)/g, label: "function" },
  { match: /\bexport\s+class\s+([A-Za-z0-9_]+)/g, label: "class" },
  { match: /\bclass\s+([A-Za-z0-9_]+)/g, label: "class" },
  { match: /\bconst\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\(/g, label: "const" }
];

const guessPurpose = (relativePath: string): string => {
  if (relativePath.includes("/tests/") || /\.(test|spec)\./.test(relativePath)) {
    return "This file contains automated tests.";
  }
  if (/package\.json$/.test(relativePath)) {
    return "This file declares package metadata and scripts.";
  }
  if (/\.(md|mdx)$/.test(relativePath)) {
    return "This file provides project documentation.";
  }
  if (/(^|\/)main\.(ts|tsx|js|jsx)$/.test(relativePath)) {
    return "This file likely contains an application entry point.";
  }
  return "This file is part of the repository implementation.";
};

const extractSymbols = (source: string): string[] => {
  const symbols = new Set<string>();
  for (const { match } of symbolRegexByExtension) {
    let result: RegExpExecArray | null;
    while ((result = match.exec(source)) !== null) {
      symbols.add(result[1]);
      if (symbols.size >= 10) {
        return [...symbols];
      }
    }
  }
  return [...symbols];
};

export const buildDeterministicFileSummary = async (
  projectRoot: string,
  file: ScannedFile,
  relatedFiles: string[]
): Promise<FileSummary> => {
  const raw = await readFile(path.join(projectRoot, file.relativePath), "utf8");
  const contentHash = sha256(raw);
  const symbols = extractSymbols(raw);
  const firstNonEmptyLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return {
    relativePath: file.relativePath,
    pathKind: "file",
    contentHash,
    title: path.basename(file.relativePath),
    purpose: guessPurpose(file.relativePath),
    summary: firstNonEmptyLine
      ? `The file starts with \`${firstNonEmptyLine.slice(0, 120)}\` and exposes ${symbols.length || "no obvious"} top-level symbols.`
      : "The file is currently empty or only contains whitespace.",
    keySymbols: symbols,
    relatedFiles: relatedFiles.slice(0, 5),
    confidence: raw.length > 0 ? 0.62 : 0.2,
    source: "deterministic",
    generatedAt: nowIso()
  };
};

export const buildDeterministicOverview = (summaryInput: {
  projectName: string;
  explanation: string;
  entryPoints: string[];
  manifestFiles: string[];
  primaryManagers: string[];
}): ProjectOverview => {
  const explanation = summaryInput.explanation.trim();
  if (/effectively empty and ready for initial setup/i.test(explanation)) {
    return {
      summary: `${summaryInput.projectName} is effectively empty and ready for setup.`,
      architecture: "No meaningful source files, entry points, or dependency manifests were detected yet.",
      whatProjectDoes: explanation,
      howItIsOrganized: "The current folder does not contain enough implementation content for repository analysis yet.",
      importantToKnowFirst: "Skip repository analysis for now and define the Ultimate Goal or setup plan first.",
      importantFiles: [],
      subsystemSummaries: [],
      dependencyHighlights: [],
      statisticsSummary: "The initial scan found no meaningful implementation content to analyze.",
      recommendations: [
        "Define the Ultimate Goal and desired project setup before generating code.",
        "Add source files or manifests later if you want repository analysis to run."
      ],
      source: "deterministic",
      generatedAt: nowIso()
    };
  }

  return {
    summary: `${summaryInput.projectName} looks like a ${explanation.toLowerCase()}`,
    architecture: `Key entry points include ${summaryInput.entryPoints.join(", ") || "no obvious entry point"}. Dependency/toolchain manifests include ${summaryInput.manifestFiles.join(", ") || "none detected"}. Primary managers: ${summaryInput.primaryManagers.join(", ") || "unknown"}.`,
    whatProjectDoes: explanation,
    howItIsOrganized: `Entry points: ${summaryInput.entryPoints.join(", ") || "none detected yet"}.`,
    importantToKnowFirst: "This overview was produced from deterministic repository scanning rather than agent analysis.",
    importantFiles: summaryInput.entryPoints.slice(0, 8),
    subsystemSummaries: [],
    dependencyHighlights: summaryInput.primaryManagers.map((manager) => `Detected ${manager} toolchain metadata.`),
    statisticsSummary: `The initial scan found ${summaryInput.manifestFiles.length} manifest files and ${summaryInput.entryPoints.length} candidate entry points.`,
    recommendations: [
      "Review the detected entry points and manifests to confirm the bootstrap summary.",
      "Open important files to generate richer semantic summaries where needed."
    ],
    source: "deterministic",
    generatedAt: nowIso()
  };
};
