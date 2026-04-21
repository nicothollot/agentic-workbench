import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { JsonValue } from "@generated/app-server/serde_json/JsonValue";
import type { ProjectIdentity, ValidationSnapshot } from "@shared/types";
import type { InterfaceCreationState, InterfaceReasoningEffort, ProjectOverview, SummarySource } from "@shared/types";
import { nowIso, stableStringify } from "@shared/utils";
import { buildDeterministicFileSummary } from "./fileSummary";
import { sha256 } from "./hashUtils";
import type { RepoScanResult } from "./repoScanner";

const pathSummaryDraftSchema = z.object({
  relativePath: z.string().min(1),
  pathKind: z.enum(["file", "directory"]).default("file"),
  title: z.string().min(1),
  purpose: z.string().min(1),
  summary: z.string().min(1),
  keySymbols: z.array(z.string()).default([]),
  relatedFiles: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(0.78)
});

const overviewDraftSchema = z.object({
  summary: z.string().min(1),
  architecture: z.string().min(1),
  whatProjectDoes: z.string().min(1),
  howItIsOrganized: z.string().min(1),
  importantToKnowFirst: z.string().min(1),
  importantFiles: z.array(z.string()).default([]),
  subsystemSummaries: z.array(
    z.object({
      name: z.string().min(1),
      summary: z.string().min(1),
      paths: z.array(z.string()).default([])
    })
  ).default([]),
  dependencyHighlights: z.array(z.string()).default([]),
  statisticsSummary: z.string().min(1),
  recommendations: z.array(z.string()).default([])
});

export const interfaceCreationOutputSchema = z.object({
  overview: overviewDraftSchema,
  pathSummaries: z.array(pathSummaryDraftSchema).default([])
});

export type InterfaceCreationOutput = z.infer<typeof interfaceCreationOutputSchema>;
export type InterfaceCreationParseFailureKind = "no-structured-output" | "malformed-json" | "schema-mismatch";
export type InterfaceCreationParseResult =
  | {
      ok: true;
      output: InterfaceCreationOutput;
      rawText: string;
      extractedText: string;
      repaired: boolean;
      candidateCount: number;
    }
  | {
      ok: false;
      kind: InterfaceCreationParseFailureKind;
      message: string;
      rawText: string;
      extractedText?: string;
      repaired: false;
      candidateCount: number;
      issues: string[];
    };

export const INTERFACE_CREATION_CONFIG = {
  promptFileLimit: 10,
  promptCharBudget: 9_000,
  outputPathSummaryLimit: 12,
  outputSubsystemLimit: 6
} as const;

const createInterfaceCreationState = (
  patch: Partial<InterfaceCreationState> & Pick<InterfaceCreationState, "status" | "phase" | "message">
): InterfaceCreationState => {
  const startedAt = patch.startedAt ?? nowIso();
  return {
    status: patch.status,
    phase: patch.phase,
    message: patch.message,
    model: patch.model,
    reasoningEffort: patch.reasoningEffort,
    selectedModelSource: patch.selectedModelSource ?? "recommended",
    deterministicScanReady: patch.deterministicScanReady ?? true,
    agentAnalysisReady: patch.agentAnalysisReady ?? false,
    outputSource: patch.outputSource ?? "deterministic",
    startedAt,
    completedAt: patch.completedAt,
    lastError: patch.lastError
  };
};

const selectImportantFiles = (scan: RepoScanResult, promptFileLimit: number): string[] => {
  const preferred = new Set<string>([
    ...scan.stats.manifestFiles,
    ...scan.stats.entryPoints,
    ...scan.files
      .map((file) => file.relativePath)
      .filter((relativePath) => /(^|\/)(README|main|index|app|server|client|renderer|preload)\./i.test(relativePath))
  ]);

  return [...preferred]
    .filter((relativePath) => scan.files.some((file) => file.relativePath === relativePath))
    .sort()
    .slice(0, promptFileLimit);
};

const selectImportantDirectories = (scan: RepoScanResult, limit: number): Array<{ relativePath: string; fileCount: number }> => {
  const counts = new Map<string, number>();

  for (const file of scan.files) {
    const segments = file.relativePath.split("/");
    if (segments.length < 2) {
      continue;
    }
    const key = segments[0];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([relativePath, fileCount]) => ({ relativePath, fileCount }));
};

export const buildInterfaceCreationOutputSchema = () => {
  const config = INTERFACE_CREATION_CONFIG;
  return {
    type: "object",
    additionalProperties: false,
    required: ["overview", "pathSummaries"],
    properties: {
      overview: {
        type: "object",
        additionalProperties: false,
        required: [
          "summary",
          "architecture",
          "whatProjectDoes",
          "howItIsOrganized",
          "importantToKnowFirst",
          "importantFiles",
          "subsystemSummaries",
          "dependencyHighlights",
          "statisticsSummary",
          "recommendations"
        ],
        properties: {
          summary: { type: "string" },
          architecture: { type: "string" },
          whatProjectDoes: { type: "string" },
          howItIsOrganized: { type: "string" },
          importantToKnowFirst: { type: "string" },
          importantFiles: {
            type: "array",
            maxItems: config.outputPathSummaryLimit,
            items: { type: "string" }
          },
          subsystemSummaries: {
            type: "array",
            maxItems: config.outputSubsystemLimit,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "summary", "paths"],
              properties: {
                name: { type: "string" },
                summary: { type: "string" },
                paths: {
                  type: "array",
                  maxItems: 4,
                  items: { type: "string" }
                }
              }
            }
          },
          dependencyHighlights: {
            type: "array",
            maxItems: 8,
            items: { type: "string" }
          },
          statisticsSummary: { type: "string" },
          recommendations: {
            type: "array",
            maxItems: 5,
            items: { type: "string" }
          }
        }
      },
      pathSummaries: {
        type: "array",
        maxItems: config.outputPathSummaryLimit,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["relativePath", "pathKind", "title", "purpose", "summary", "keySymbols", "relatedFiles", "confidence"],
          properties: {
            relativePath: { type: "string" },
            pathKind: { type: "string", enum: ["file", "directory"] },
            title: { type: "string" },
            purpose: { type: "string" },
            summary: { type: "string" },
            keySymbols: {
              type: "array",
              maxItems: 8,
              items: { type: "string" }
            },
            relatedFiles: {
              type: "array",
              maxItems: 6,
              items: { type: "string" }
            },
            confidence: { type: "number", minimum: 0, maximum: 1 }
          }
        }
      }
    }
  };
};

export const createQueuedInterfaceCreationState = (
  model?: string,
  reasoningEffort?: InterfaceReasoningEffort,
  selectedModelSource: "user" | "recommended" = "recommended"
): InterfaceCreationState =>
  createInterfaceCreationState({
    status: "queued",
    phase: "Queued",
    message: "Preparing deterministic repository facts for interface creation.",
    model,
    reasoningEffort,
    selectedModelSource,
    deterministicScanReady: true,
    agentAnalysisReady: false,
    outputSource: "deterministic"
  });

export const createSkippedInterfaceCreationState = (
  model?: string,
  reasoningEffort?: InterfaceReasoningEffort,
  selectedModelSource: "user" | "recommended" = "recommended"
): InterfaceCreationState =>
  createInterfaceCreationState({
    status: "completed",
    phase: "Setup ready",
    message: "Repository analysis was skipped because the project is effectively empty. Define the Ultimate Goal to begin setup.",
    model,
    reasoningEffort,
    selectedModelSource,
    deterministicScanReady: true,
    agentAnalysisReady: false,
    outputSource: "deterministic",
    completedAt: nowIso()
  });

const truncateSnippet = (raw: string, limit: number): string =>
  raw.length <= limit ? raw : `${raw.slice(0, limit)}\n...`;

export const buildInterfaceCreationTurn = async (input: {
  projectRoot: string;
  projectHostPath: string;
  identity: ProjectIdentity;
  validation: ValidationSnapshot;
  scan: RepoScanResult;
}): Promise<{ prompt: string; outputSchema: JsonValue }> => {
  const config = INTERFACE_CREATION_CONFIG;
  const importantFiles = selectImportantFiles(input.scan, config.promptFileLimit);
  const importantDirectories = selectImportantDirectories(input.scan, Math.min(6, config.outputSubsystemLimit));
  const fileContexts: Array<Record<string, unknown>> = [];
  let remainingChars = config.promptCharBudget;

  for (const relativePath of importantFiles) {
    if (remainingChars < 400) {
      break;
    }

    const file = input.scan.files.find((entry) => entry.relativePath === relativePath);
    if (!file) {
      continue;
    }

    const siblings = input.scan.files
      .filter((entry) => path.dirname(entry.relativePath) === path.dirname(relativePath) && entry.relativePath !== relativePath)
      .map((entry) => entry.relativePath)
      .slice(0, 5);
    const deterministicSummary = await buildDeterministicFileSummary(input.projectHostPath, file, siblings);
    const snippetBudget = Math.min(remainingChars, Math.max(900, Math.floor(config.promptCharBudget / config.promptFileLimit)));
    const raw = await readFile(path.join(input.projectHostPath, relativePath), "utf8");
    const snippet = truncateSnippet(raw, snippetBudget);
    remainingChars -= snippet.length;

    fileContexts.push({
      relativePath,
      size: file.size,
      language: file.language,
      deterministicPurpose: deterministicSummary.purpose,
      deterministicSummary: deterministicSummary.summary,
      keySymbols: deterministicSummary.keySymbols,
      relatedFiles: deterministicSummary.relatedFiles,
      snippet
    });
  }

  const promptPayload = {
    identity: {
      projectName: input.identity.projectName,
      repositoryName: input.identity.repositoryName ?? input.identity.projectName,
      kind: input.identity.kind,
      fingerprint: input.identity.fingerprint
    },
    validation: {
      branch: input.validation.branch ?? null,
      gitHead: input.validation.gitHead ?? null,
      projectKind: input.validation.projectKind
    },
    stats: {
      totalFiles: input.scan.stats.totalFiles,
      totalFolders: input.scan.stats.totalFolders,
      totalSizeBytes: input.scan.stats.totalSizeBytes,
      includedFiles: input.scan.stats.includedFiles,
      includedFolders: input.scan.stats.includedFolders,
      includedSizeBytes: input.scan.stats.includedSizeBytes,
      excludedFiles: input.scan.stats.excludedFiles,
      excludedFolders: input.scan.stats.excludedFolders,
      excludedSizeBytes: input.scan.stats.excludedSizeBytes,
      excludedPaths: input.scan.stats.excludedPaths,
      fileTypeBreakdown: input.scan.stats.fileTypeBreakdown,
      entryPoints: input.scan.stats.entryPoints,
      manifestFiles: input.scan.stats.manifestFiles,
      primaryManagers: input.scan.stats.primaryManagers,
      testsPresent: input.scan.stats.testsPresent,
      languageBreakdown: input.scan.stats.languageBreakdown,
      explanation: input.scan.stats.explanation
    },
    dependencies: input.scan.dependencies.slice(0, 30),
    importantDirectories,
    importantFiles: fileContexts,
    topLevelTree: input.scan.tree.slice(0, 12).map((node) => ({
      path: node.path,
      type: node.type,
      children: node.children?.slice(0, 8).map((child) => child.path) ?? []
    }))
  };

  return {
    prompt: [
      "Create the initial repository interface from the structured scan data below.",
      "Be specific, concise, and non-generic.",
      "Use deterministic facts as ground truth for repository structure, dependencies, and project statistics.",
      "Infer the human-readable overview and path summaries from those facts and snippets.",
      "Keep the output practical and concise. Prefer 1-3 sentence summaries.",
      "Explain what the project appears to do, how it is organized, what matters first, and the major subsystems.",
      "Include path summaries for the most important files or directories only.",
      "Return exactly one JSON object that matches the output schema.",
      "Do not wrap the JSON in markdown fences and do not add any commentary before or after it.",
      "Every overview string field must be present and non-empty. Use concise factual text rather than placeholders.",
      "Only include file or directory paths that exist in the provided repository facts.",
      "Do not mention missing context unless it materially limits confidence.",
      "",
      stableStringify(promptPayload)
    ].join("\n"),
    outputSchema: buildInterfaceCreationOutputSchema()
  };
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const asTrimmedString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const pickNonEmptyString = (...values: unknown[]): string => {
  for (const value of values) {
    const trimmed = asTrimmedString(value);
    if (trimmed) {
      return trimmed;
    }
  }
  return "";
};

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : [];

const clampConfidence = (value: unknown, fallback = 0.78): number => {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return fallback;
  }
  return Math.min(1, Math.max(0, value));
};

const normalizeOverviewDraft = (value: unknown): InterfaceCreationOutput["overview"] | null => {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const summary = pickNonEmptyString(
    record.summary,
    record.whatProjectDoes,
    record.architecture,
    record.howItIsOrganized,
    record.importantToKnowFirst
  );
  if (!summary) {
    return null;
  }

  const architecture = pickNonEmptyString(record.architecture, record.howItIsOrganized, summary);
  const whatProjectDoes = pickNonEmptyString(record.whatProjectDoes, summary, architecture);
  const howItIsOrganized = pickNonEmptyString(record.howItIsOrganized, architecture, summary);
  const importantToKnowFirst = pickNonEmptyString(record.importantToKnowFirst, summary, whatProjectDoes);
  const statisticsSummary = pickNonEmptyString(record.statisticsSummary, summary, architecture);

  return {
    summary,
    architecture,
    whatProjectDoes,
    howItIsOrganized,
    importantToKnowFirst,
    importantFiles: asStringArray(record.importantFiles),
    subsystemSummaries: Array.isArray(record.subsystemSummaries)
      ? record.subsystemSummaries.flatMap((entry) => {
          const subsystem = asRecord(entry);
          if (!subsystem) {
            return [];
          }
          const name = pickNonEmptyString(subsystem.name);
          const subsystemSummary = pickNonEmptyString(subsystem.summary);
          if (!name || !subsystemSummary) {
            return [];
          }
          return [{
            name,
            summary: subsystemSummary,
            paths: asStringArray(subsystem.paths)
          }];
        })
      : [],
    dependencyHighlights: asStringArray(record.dependencyHighlights),
    statisticsSummary,
    recommendations: asStringArray(record.recommendations)
  };
};

const normalizePathSummaryDraft = (value: unknown): InterfaceCreationOutput["pathSummaries"][number] | null => {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const relativePath = pickNonEmptyString(record.relativePath, record.path);
  if (!relativePath) {
    return null;
  }

  const title = pickNonEmptyString(record.title, path.basename(relativePath), relativePath);
  const purpose = pickNonEmptyString(record.purpose, record.summary, title);
  const summary = pickNonEmptyString(record.summary, record.purpose, purpose);
  if (!title || !purpose || !summary) {
    return null;
  }

  return {
    relativePath,
    pathKind: record.pathKind === "directory" ? "directory" : "file",
    title,
    purpose,
    summary,
    keySymbols: asStringArray(record.keySymbols),
    relatedFiles: asStringArray(record.relatedFiles),
    confidence: clampConfidence(record.confidence)
  };
};

const normalizeInterfaceCreationPayload = (value: unknown): InterfaceCreationOutput | null => {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const overview = normalizeOverviewDraft(record.overview ?? record.projectOverview ?? record.interfaceOverview);
  if (!overview) {
    return null;
  }

  const rawPathSummaries = record.pathSummaries ?? record.importantPaths ?? record.paths;
  const pathSummaries = Array.isArray(rawPathSummaries)
    ? rawPathSummaries.flatMap((entry) => {
        const normalized = normalizePathSummaryDraft(entry);
        return normalized ? [normalized] : [];
      })
    : [];

  const repaired = interfaceCreationOutputSchema.safeParse({
    overview,
    pathSummaries
  });
  return repaired.success ? repaired.data : null;
};

const formatZodIssues = (issues: z.ZodIssue[]): string[] =>
  issues.map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "root"}: ${issue.message}`);

const collectJsonCandidates = (rawText: string): string[] => {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (value: string): void => {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    candidates.push(trimmed);
  };

  push(rawText);

  const fencePattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of rawText.matchAll(fencePattern)) {
    push(match[1] ?? "");
  }

  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < rawText.length; index += 1) {
    const char = rawText[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }

    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        push(rawText.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return candidates;
};

export const parseInterfaceCreationOutput = (rawText: string): InterfaceCreationParseResult => {
  const candidates = collectJsonCandidates(rawText);
  if (candidates.length === 0) {
    return {
      ok: false,
      kind: "no-structured-output",
      message: "No JSON object could be extracted from the interface-creation response.",
      rawText,
      repaired: false,
      candidateCount: 0,
      issues: []
    };
  }

  let malformedIssues: string[] = [];
  let schemaIssues: string[] = [];
  let lastParsedCandidate: string | undefined;

  for (const candidate of candidates) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(candidate);
      lastParsedCandidate = candidate;
    } catch (error) {
      malformedIssues = [...malformedIssues, error instanceof Error ? error.message : String(error)];
      continue;
    }

    const direct = interfaceCreationOutputSchema.safeParse(parsedJson);
    if (direct.success) {
      return {
        ok: true,
        output: direct.data,
        rawText,
        extractedText: candidate,
        repaired: false,
        candidateCount: candidates.length
      };
    }

    const repaired = normalizeInterfaceCreationPayload(parsedJson);
    if (repaired) {
      return {
        ok: true,
        output: repaired,
        rawText,
        extractedText: candidate,
        repaired: true,
        candidateCount: candidates.length
      };
    }

    schemaIssues = [...schemaIssues, ...formatZodIssues(direct.error.issues)];
  }

  if (schemaIssues.length > 0) {
    return {
      ok: false,
      kind: "schema-mismatch",
      message: `Structured JSON was returned but failed schema validation: ${[...new Set(schemaIssues)].join("; ")}`,
      rawText,
      extractedText: lastParsedCandidate,
      repaired: false,
      candidateCount: candidates.length,
      issues: [...new Set(schemaIssues)]
    };
  }

  return {
    ok: false,
    kind: "malformed-json",
    message: `A JSON-like response was found but could not be parsed: ${[...new Set(malformedIssues)].join("; ")}`,
    rawText,
    repaired: false,
    candidateCount: candidates.length,
    issues: [...new Set(malformedIssues)]
  };
};

export const toStoredOverview = (overview: InterfaceCreationOutput["overview"], source: SummarySource): ProjectOverview => ({
  ...overview,
  source,
  generatedAt: nowIso()
});

export const getPathContentHash = (scan: RepoScanResult, relativePath: string, pathKind: "file" | "directory"): string => {
  if (pathKind === "file") {
    const file = scan.files.find((entry) => entry.relativePath === relativePath);
    return file ? sha256(stableStringify([file.relativePath, file.size])) : sha256(relativePath);
  }

  const childPaths = scan.files
    .filter((entry) => entry.relativePath === relativePath || entry.relativePath.startsWith(`${relativePath}/`))
    .map((entry) => [entry.relativePath, entry.size]);
  return sha256(stableStringify(childPaths.length > 0 ? childPaths : [relativePath]));
};
