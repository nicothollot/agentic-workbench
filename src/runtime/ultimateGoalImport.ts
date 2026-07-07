import { readFile } from "node:fs/promises";
import path from "node:path";
import type { UltimateGoalImportCharterSections, UltimateGoalImportField, UltimateGoalImportPreview } from "@shared/types";

const orderedFields: UltimateGoalImportField[] = [
  "summary",
  "detailedIntent",
  "successCriteria",
  "constraints",
  "nonGoals",
  "definitionOfDone",
  "qualityBar",
  "targetAudience",
  "nonNegotiableRequirements",
  "explicitNonGoals",
  "flexibleRequirements",
  "niceToHaveIdeas",
  "userConstraints",
  "technicalPreferences",
  "aestheticPreferences"
];

const fieldAliases: Record<UltimateGoalImportField, string[]> = {
  summary: ["summary", "project charter", "charter", "project summary", "one sentence summary", "current effective goal", "ultimate goal"],
  detailedIntent: ["detailed intent", "intent", "detailed goal", "goal intent"],
  successCriteria: ["success criteria", "success", "acceptance criteria"],
  constraints: ["constraints", "constraint", "guardrails", "project constraints"],
  nonGoals: ["non-goals", "non goals", "out of scope", "explicit non-goals", "explicit non goals"],
  qualityBar: ["quality bar", "quality", "quality standard"],
  targetAudience: ["target audience", "audience", "users"],
  nonNegotiableRequirements: ["non-negotiable requirements", "non negotiable requirements", "hard requirements", "must-have requirements", "must have requirements"],
  flexibleRequirements: ["flexible requirements", "adaptable requirements"],
  niceToHaveIdeas: ["nice-to-have ideas", "nice to have ideas", "nice-to-haves", "nice to haves", "optional ideas"],
  explicitNonGoals: ["charter non-goals", "charter non goals", "charter exclusions", "charter out of scope"],
  userConstraints: ["user constraints", "operator constraints", "human constraints"],
  aestheticPreferences: ["aesthetic preferences", "visual preferences", "design preferences"],
  technicalPreferences: ["technical preferences", "technology preferences", "implementation preferences"],
  definitionOfDone: ["definition of done", "done definition", "completion definition"]
};

const listFields = new Set<UltimateGoalImportField>([
  "successCriteria",
  "constraints",
  "nonGoals",
  "nonNegotiableRequirements",
  "flexibleRequirements",
  "niceToHaveIdeas",
  "explicitNonGoals",
  "userConstraints",
  "aestheticPreferences",
  "technicalPreferences",
  "definitionOfDone"
]);

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

interface ParsedSection {
  field: UltimateGoalImportField;
  content: string;
}

const appendLine = (lines: string[], line: string): void => {
  if (lines.length === 0 && !line.trim()) {
    return;
  }
  lines.push(line);
};

const extractLabeledSections = (
  rawText: string
): {
  sections: ParsedSection[];
  unlabeledText: string;
} => {
  const sections: ParsedSection[] = [];
  const unlabeledLines: string[] = [];
  let currentField: UltimateGoalImportField | undefined;
  let currentLines: string[] = [];

  const flushCurrent = () => {
    if (!currentField) {
      return;
    }
    sections.push({
      field: currentField,
      content: currentLines.join("\n").trim()
    });
    currentField = undefined;
    currentLines = [];
  };

  for (const line of rawText.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = line.trim();
    const inlineMatch = trimmed.match(/^([^:]{1,120}):\s*(.*)$/);
    const inlineField = inlineMatch ? resolveFieldFromHeading(inlineMatch[1] ?? "") : undefined;
    const headingField = inlineField ?? (trimmed ? resolveFieldFromHeading(trimmed) : undefined);

    if (headingField) {
      flushCurrent();
      currentField = headingField;
      currentLines = [];
      if (inlineField) {
        appendLine(currentLines, inlineMatch?.[2] ?? "");
      }
      continue;
    }

    if (currentField) {
      appendLine(currentLines, line);
    } else {
      unlabeledLines.push(line);
    }
  }

  flushCurrent();

  return {
    sections,
    unlabeledText: unlabeledLines.join("\n").trim()
  };
};

const splitParagraphs = (raw: string): string[] =>
  raw
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

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

const emptyCharter = (): UltimateGoalImportCharterSections => ({
  nonNegotiableRequirements: [],
  flexibleRequirements: [],
  niceToHaveIdeas: [],
  explicitNonGoals: [],
  userConstraints: [],
  aestheticPreferences: [],
  technicalPreferences: [],
  definitionOfDone: []
});

const assignField = (
  goal: UltimateGoalImportPreview["goal"],
  charter: UltimateGoalImportCharterSections,
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
    } else if (field === "nonNegotiableRequirements") {
      charter.nonNegotiableRequirements = list;
    } else if (field === "flexibleRequirements") {
      charter.flexibleRequirements = list;
    } else if (field === "niceToHaveIdeas") {
      charter.niceToHaveIdeas = list;
    } else if (field === "explicitNonGoals") {
      charter.explicitNonGoals = list;
    } else if (field === "userConstraints") {
      charter.userConstraints = list;
    } else if (field === "aestheticPreferences") {
      charter.aestheticPreferences = list;
    } else if (field === "technicalPreferences") {
      charter.technicalPreferences = list;
    } else if (field === "definitionOfDone") {
      charter.definitionOfDone = list;
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

const populatedFieldsForGoal = (
  goal: UltimateGoalImportPreview["goal"],
  charter: UltimateGoalImportCharterSections
): UltimateGoalImportField[] =>
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
    if (field === "nonGoals") {
      return goal.nonGoals.length > 0;
    }
    return charter[field].length > 0;
  });

export const parseUltimateGoalText = (
  rawText: string,
  sourceFileName = "goal.txt"
): UltimateGoalImportPreview => {
  const goal = emptyGoal();
  const charter = emptyCharter();
  const warnings: string[] = [];
  const { sections, unlabeledText } = extractLabeledSections(rawText);
  const unlabeledParagraphs = splitParagraphs(unlabeledText);
  const paragraphs = splitParagraphs(rawText);

  for (const section of sections) {
    assignField(goal, charter, section.field, section.content);
  }

  let orderedFieldIndex = 0;
  for (const paragraph of unlabeledParagraphs) {
    while (orderedFieldIndex < orderedFields.length) {
      const field = orderedFields[orderedFieldIndex];
      const alreadyPopulated = populatedFieldsForGoal(goal, charter).includes(field);
      orderedFieldIndex += 1;
      if (alreadyPopulated) {
        continue;
      }
      assignField(goal, charter, field, paragraph);
      break;
    }
  }

  const populatedFields = populatedFieldsForGoal(goal, charter);
  const missingFields = orderedFields.filter((field) => !populatedFields.includes(field));

  if (paragraphs.length === 0) {
    warnings.push("The selected text file was empty.");
  } else if (sections.length === 0) {
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
    charter,
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
