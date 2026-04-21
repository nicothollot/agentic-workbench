import { readFile } from "node:fs/promises";
import path from "node:path";
import type { UltimateGoalImportField, UltimateGoalImportPreview } from "@shared/types";

const orderedFields: UltimateGoalImportField[] = [
  "summary",
  "detailedIntent",
  "successCriteria",
  "constraints",
  "nonGoals",
  "qualityBar",
  "targetAudience"
];

const fieldAliases: Record<UltimateGoalImportField, string[]> = {
  summary: ["summary", "project charter", "charter", "project summary", "one sentence summary"],
  detailedIntent: ["detailed intent", "intent", "detailed goal", "goal intent"],
  successCriteria: ["success criteria", "success", "acceptance criteria"],
  constraints: ["constraints", "constraint", "guardrails"],
  nonGoals: ["non-goals", "non goals", "out of scope"],
  qualityBar: ["quality bar", "quality", "quality standard"],
  targetAudience: ["target audience", "audience", "users"]
};

const listFields = new Set<UltimateGoalImportField>(["successCriteria", "constraints", "nonGoals"]);

const normalizeHeading = (value: string): string =>
  value
    .toLowerCase()
    .replace(/^#+\s*/, "")
    .replace(/[*_`]/g, "")
    .replace(/[:\-.]+$/, "")
    .trim();

const resolveFieldFromHeading = (heading: string): UltimateGoalImportField | undefined => {
  const normalized = normalizeHeading(heading);
  return orderedFields.find((field) => fieldAliases[field].includes(normalized));
};

const splitParagraphs = (raw: string): string[] =>
  raw
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

const extractLabeledParagraph = (
  paragraph: string
): {
  field?: UltimateGoalImportField;
  content: string;
} => {
  const lines = paragraph.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) {
    return { content: "" };
  }

  const [firstLine, ...rest] = lines;
  const inlineMatch = firstLine.match(/^([^:]+):\s*(.*)$/);
  if (inlineMatch) {
    const field = resolveFieldFromHeading(inlineMatch[1] ?? "");
    if (field) {
      const inlineContent = (inlineMatch[2] ?? "").trim();
      return {
        field,
        content: [inlineContent, ...rest].filter((line) => line.length > 0).join("\n").trim()
      };
    }
  }

  const headingField = resolveFieldFromHeading(firstLine);
  if (headingField && rest.length > 0) {
    return {
      field: headingField,
      content: rest.join("\n").trim()
    };
  }

  return {
    content: lines.join("\n").trim()
  };
};

const parseListField = (content: string): string[] => {
  const cleanedLines = content
    .split("\n")
    .map((line) => line.replace(/^\s*[-*•]\s*/, "").trim())
    .filter((line) => line.length > 0);

  if (cleanedLines.length > 1) {
    return cleanedLines;
  }

  return content
    .split(/[;\n]/)
    .map((entry) => entry.replace(/^\s*[-*•]\s*/, "").trim())
    .filter((entry) => entry.length > 0);
};

const emptyGoal = (): UltimateGoalImportPreview["goal"] => ({
  summary: "",
  detailedIntent: "",
  successCriteria: [],
  constraints: [],
  nonGoals: [],
  targetAudience: "",
  qualityBar: "",
  source: "user"
});

const assignField = (
  goal: UltimateGoalImportPreview["goal"],
  field: UltimateGoalImportField,
  content: string
): void => {
  if (!content.trim()) {
    return;
  }

  if (listFields.has(field)) {
    const list = parseListField(content);
    if (field === "successCriteria") {
      goal.successCriteria = list;
    } else if (field === "constraints") {
      goal.constraints = list;
    } else if (field === "nonGoals") {
      goal.nonGoals = list;
    }
    return;
  }

  if (field === "summary") {
    goal.summary = content.trim();
  } else if (field === "detailedIntent") {
    goal.detailedIntent = content.trim();
  } else if (field === "qualityBar") {
    goal.qualityBar = content.trim();
  } else if (field === "targetAudience") {
    goal.targetAudience = content.trim();
  }
};

const populatedFieldsForGoal = (goal: UltimateGoalImportPreview["goal"]): UltimateGoalImportField[] =>
  orderedFields.filter((field) => {
    if (field === "summary") {
      return goal.summary.trim().length > 0;
    }
    if (field === "detailedIntent") {
      return goal.detailedIntent.trim().length > 0;
    }
    if (field === "qualityBar") {
      return goal.qualityBar.trim().length > 0;
    }
    if (field === "targetAudience") {
      return goal.targetAudience.trim().length > 0;
    }
    if (field === "successCriteria") {
      return goal.successCriteria.length > 0;
    }
    if (field === "constraints") {
      return goal.constraints.length > 0;
    }
    return goal.nonGoals.length > 0;
  });

export const parseUltimateGoalText = (
  rawText: string,
  sourceFileName = "goal.txt"
): UltimateGoalImportPreview => {
  const goal = emptyGoal();
  const warnings: string[] = [];
  const paragraphs = splitParagraphs(rawText);
  const unlabeledParagraphs: string[] = [];

  for (const paragraph of paragraphs) {
    const parsed = extractLabeledParagraph(paragraph);
    if (parsed.field) {
      assignField(goal, parsed.field, parsed.content);
      continue;
    }
    unlabeledParagraphs.push(parsed.content);
  }

  let orderedFieldIndex = 0;
  for (const paragraph of unlabeledParagraphs) {
    while (orderedFieldIndex < orderedFields.length) {
      const field = orderedFields[orderedFieldIndex];
      const alreadyPopulated = populatedFieldsForGoal(goal).includes(field);
      orderedFieldIndex += 1;
      if (alreadyPopulated) {
        continue;
      }
      assignField(goal, field, paragraph);
      break;
    }
  }

  const populatedFields = populatedFieldsForGoal(goal);
  const missingFields = orderedFields.filter((field) => !populatedFields.includes(field));

  if (paragraphs.length === 0) {
    warnings.push("The selected text file was empty.");
  } else if (unlabeledParagraphs.length === paragraphs.length) {
    warnings.push("No section labels were detected, so paragraphs were mapped in the expected field order.");
  }
  if (missingFields.length > 0) {
    warnings.push("Some required sections were not detected automatically and still need review.");
  }
  if (goal.summary && /[.!?].+[.!?]/.test(goal.summary)) {
    warnings.push("The imported summary contains multiple sentences. Review it if you want a shorter one-line charter.");
  }

  return {
    sourceFileName,
    goal,
    populatedFields,
    missingFields,
    warnings,
    completeness: missingFields.length === 0 ? "complete" : "partial"
  };
};

export const readUltimateGoalTextImport = async (filePath: string): Promise<UltimateGoalImportPreview> => {
  if (path.extname(filePath).toLowerCase() !== ".txt") {
    throw new Error("Ultimate Goal import only supports .txt files.");
  }

  const rawText = await readFile(filePath, "utf8");
  return parseUltimateGoalText(rawText, path.basename(filePath));
};
