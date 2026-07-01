import type {
  RepoHygieneReport,
  ValidationCommandPhase,
  ValidationCommandResult,
  ValidationCommandStatus,
  ValidationFailureClassification,
  ValidationFinalStatus,
  ValidationLedger
} from "./types";
import { nowIso, unique } from "./utils";

export const VALIDATION_LEDGER_SCHEMA_VERSION = 1;
const VALIDATION_OUTPUT_SUMMARY_LIMIT = 2_000;

const SECRET_PATTERN =
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b|\b(?:ghp|github_pat)_[A-Za-z0-9_]{16,}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{12,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const ABSOLUTE_PATH_PATTERN = /\b(?:[A-Za-z]:\\[^\s"'`]+|\/(?:home|Users|mnt|var|tmp|private|Volumes)\/[^\s"'`]+)/g;

const normalizeSpace = (value: string): string => value.trim().replace(/\s+/g, " ");

const truncate = (value: string, maxLength: number): string => {
  const normalized = normalizeSpace(value);
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
};

export const redactValidationOutput = (value: string): { text: string; redactionApplied: boolean } => {
  const text = value
    .replace(SECRET_PATTERN, "[redacted-secret]")
    .replace(ABSOLUTE_PATH_PATTERN, "<local-path>");
  return {
    text,
    redactionApplied: text !== value
  };
};

export const normalizeValidationCommand = (command: string): string =>
  normalizeSpace(command)
    .replace(/\bPYTHONDONTWRITEBYTECODE=1\s+/g, "")
    .replace(/\bPYTHONPATH=src\s+/g, "")
    .replace(/\bpython\b/g, "python")
    .toLowerCase();

const commandFamily = (command: string): string => {
  const normalized = normalizeValidationCommand(command);
  if (/\b(?:python3?|pytest)\b/.test(normalized) && /\b(?:pytest|unittest|discover)\b/.test(normalized)) {
    return "python-tests";
  }
  if (/\bnpm\s+(?:run\s+)?test\b/.test(normalized)) {
    return "node-tests";
  }
  if (/\bnpm\s+run\s+typecheck\b/.test(normalized)) {
    return "node-typecheck";
  }
  if (/\bnpm\s+run\s+lint\b/.test(normalized)) {
    return "node-lint";
  }
  if (/\bnpm\s+run\s+build\b/.test(normalized)) {
    return "node-build";
  }
  return normalized;
};

const hasLaterRepairingPass = (failed: ValidationCommandResult, results: ValidationCommandResult[]): ValidationCommandResult | undefined => {
  const failedIndex = results.findIndex((result) => result.commandId === failed.commandId);
  const laterPassed = results.slice(Math.max(0, failedIndex + 1)).filter((result) => result.status === "passed");
  if (failed.classifiedFailure?.kind === "product_test") {
    return laterPassed.find((result) => result.normalizedCommand === failed.normalizedCommand);
  }
  return laterPassed.find((result) => commandFamily(result.command) === commandFamily(failed.command));
};

const classifyByPattern = (
  command: string,
  phase: ValidationCommandPhase,
  output: string,
  status: ValidationCommandStatus,
  exitCode?: number | null
): ValidationFailureClassification | undefined => {
  if (status === "passed") {
    return undefined;
  }
  if (status === "timed_out") {
    return {
      kind: "timeout",
      summary: `Command timed out: ${command}`,
      mergeBlocking: true
    };
  }
  if (status === "cancelled") {
    return {
      kind: "unknown",
      summary: `Command was cancelled: ${command}`,
      mergeBlocking: true
    };
  }
  if (status === "skipped") {
    const approvalRequired = /\b(?:curl|wget|live-http|login|credential|paid|billing|oauth|browser)\b/i.test(command);
    return {
      kind: approvalRequired ? "approval_required" : "unknown",
      summary: approvalRequired ? `Command requires explicit approval: ${command}` : `Command skipped: ${command}`,
      mergeBlocking: false
    };
  }
  if (phase === "hygiene") {
    return {
      kind: "hygiene",
      summary: truncate(output || `Repository hygiene failed: ${command}`, 240),
      mergeBlocking: true
    };
  }
  if (/python(?:3)?:?\s+command not found|python(?:3)?: not found|command ["']?python["']?.*(?:not installed|not available|not found)|no such file or directory.*python/i.test(output)) {
    return {
      kind: "environment_toolchain",
      summary: "Python executable was unavailable in this environment.",
      mergeBlocking: true
    };
  }
  if (/No module named ['"]?pytest['"]?|pytest: command not found|pytest: not found/i.test(output)) {
    return {
      kind: "environment_tooling_unavailable",
      summary: "pytest is unavailable in this environment.",
      mergeBlocking: true
    };
  }
  if (/broken pipe|pipefail|SIGPIPE|write error/i.test(output)) {
    return {
      kind: "command_construction",
      summary: "The command failed because its shell pipeline was malformed or fragile.",
      mergeBlocking: true
    };
  }
  if (/(?:ModuleNotFoundError|ImportError):\s+No module named/i.test(output) && !/\bPYTHONPATH=/.test(command)) {
    return {
      kind: "command_construction",
      summary: "Python import failed; the command may need the project PYTHONPATH.",
      mergeBlocking: true
    };
  }
  if (phase === "evidence" && /json|parse|unexpected token|expected.*object|invalid/i.test(output)) {
    return {
      kind: "evidence_command",
      summary: "Evidence command output could not be parsed as expected.",
      mergeBlocking: true
    };
  }
  if (
    /AssertionError|^\s*FAIL:|^\s*FAILED\b|=+\s+FAILURES\s+=+|expect\(.*\)\.|tests? failed|received .* expected/i.test(output) ||
    (phase === "integrity" && typeof exitCode === "number" && exitCode !== 0 && /\b(?:test|spec|assert|unittest|pytest|vitest)\b/i.test(output))
  ) {
    return {
      kind: "product_test",
      summary: "Tests ran and reported an assertion or product failure.",
      mergeBlocking: true
    };
  }
  if (phase === "evidence") {
    return {
      kind: "evidence_command",
      summary: truncate(output || `Evidence command failed: ${command}`, 240),
      mergeBlocking: true
    };
  }
  return {
    kind: "unknown",
    summary: truncate(output || `Command failed: ${command}`, 240),
    mergeBlocking: true
  };
};

export interface BuildValidationCommandResultInput {
  commandId: string;
  command: string;
  phase: ValidationCommandPhase;
  startedAt: string;
  endedAt: string;
  exitCode?: number | null;
  status?: ValidationCommandStatus;
  stdout?: string;
  stderr?: string;
  cwdKind?: ValidationCommandResult["cwdKind"];
  fullOutputRef?: string;
  parsedJsonRef?: string;
  relatedCheckIds?: string[];
  relatedFiles?: string[];
  classifiedFailure?: ValidationFailureClassification;
}

export const buildValidationCommandResult = (input: BuildValidationCommandResultInput): ValidationCommandResult => {
  const stdout = input.stdout ?? "";
  const stderr = input.stderr ?? "";
  const redactedStdout = redactValidationOutput(stdout);
  const redactedStderr = redactValidationOutput(stderr);
  const status = input.status ?? (input.exitCode === 0 ? "passed" : "failed");
  const normalizedCommand = normalizeValidationCommand(input.command);
  const combined = `${stdout}\n${stderr}`.trim();
  const classifiedFailure = input.classifiedFailure ?? classifyByPattern(input.command, input.phase, combined, status, input.exitCode);
  const durationMs = Math.max(0, Date.parse(input.endedAt) - Date.parse(input.startedAt));
  return {
    commandId: input.commandId,
    command: input.command,
    normalizedCommand,
    cwdKind: input.cwdKind ?? "unknown",
    phase: input.phase,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationMs: Number.isFinite(durationMs) ? durationMs : 0,
    exitCode: input.exitCode,
    status,
    stdoutSummary: truncate(redactedStdout.text, VALIDATION_OUTPUT_SUMMARY_LIMIT),
    stderrSummary: truncate(redactedStderr.text, VALIDATION_OUTPUT_SUMMARY_LIMIT),
    fullOutputRef: input.fullOutputRef,
    parsedJsonRef: input.parsedJsonRef,
    redactionApplied: redactedStdout.redactionApplied || redactedStderr.redactionApplied,
    classifiedFailure,
    relatedCheckIds: input.relatedCheckIds ?? [],
    relatedFiles: input.relatedFiles ?? []
  };
};

export const createValidationLedger = (input: {
  cycleNumber: number;
  plannedCommands?: string[];
  evidenceCommands?: string[];
  testCommands?: string[];
  createdAt?: string;
}): ValidationLedger => {
  const createdAt = input.createdAt ?? nowIso();
  return {
    schemaVersion: VALIDATION_LEDGER_SCHEMA_VERSION,
    cycleNumber: input.cycleNumber,
    createdAt,
    updatedAt: createdAt,
    plannedCommands: input.plannedCommands ?? unique([...(input.testCommands ?? []), ...(input.evidenceCommands ?? [])]),
    attemptedCommands: [],
    evidenceCommands: input.evidenceCommands ?? [],
    testCommands: input.testCommands ?? [],
    commandResults: [],
    environmentFailures: [],
    commandConstructionFailures: [],
    productFailures: [],
    evidenceFailures: [],
    hygieneFailures: [],
    repairedFailures: [],
    warnings: [],
    finalValidationStatus: "not_run",
    finalValidationBasis: "",
    unresolvedValidationFailures: [],
    mergeAllowed: false,
    mergeBlockedReasons: ["Validation has not run."],
    summaryForHumans: "Validation has not run."
  };
};

const summarizeFailure = (result: ValidationCommandResult): string =>
  result.classifiedFailure?.summary || `${result.command} failed`;

const addUnique = (target: string[], values: Array<string | undefined>): string[] =>
  unique([...target, ...values.filter((value): value is string => Boolean(value?.trim()))]);

const containsPytestUnavailable = (results: ValidationCommandResult[]): boolean =>
  results.some((result) => result.classifiedFailure?.kind === "environment_tooling_unavailable" && /pytest/i.test(result.classifiedFailure.summary));

const containsPythonUnavailable = (results: ValidationCommandResult[]): boolean =>
  results.some((result) => result.classifiedFailure?.kind === "environment_toolchain" && /python/i.test(result.classifiedFailure.summary));

const hasUnittestPass = (results: ValidationCommandResult[]): boolean =>
  results.some((result) => result.status === "passed" && /\bunittest\b/i.test(result.command));

const hasPython3Pass = (results: ValidationCommandResult[]): boolean =>
  results.some((result) => result.status === "passed" && /\bpython3\b/i.test(result.command));

export const finalizeValidationLedger = (
  ledger: ValidationLedger,
  options: {
    updatedAt?: string;
    repoHygieneReport?: RepoHygieneReport;
    manualOverride?: boolean;
    manualOverrideReason?: string;
  } = {}
): ValidationLedger => {
  const results = ledger.commandResults.map((result) => ({ ...result, classifiedFailure: result.classifiedFailure ? { ...result.classifiedFailure } : undefined }));
  const testResults = results.filter((result) => result.phase === "integrity" || ledger.testCommands.includes(result.command));
  const attemptedCommands = unique(results.filter((result) => result.status !== "skipped").map((result) => result.command));
  const failedResults = results.filter((result) => result.status !== "passed" && result.status !== "skipped");
  const skippedResults = results.filter((result) => result.status === "skipped");
  const repaired: string[] = [];
  const unresolved: string[] = [];

  for (const result of failedResults) {
    const repair = hasLaterRepairingPass(result, results);
    if (repair && result.classifiedFailure) {
      result.classifiedFailure = {
        ...result.classifiedFailure,
        repairedByCommandId: repair.commandId
      };
      repaired.push(`${summarizeFailure(result)} Repaired by ${repair.command}.`);
      continue;
    }
    if (result.classifiedFailure?.mergeBlocking !== false) {
      unresolved.push(summarizeFailure(result));
    }
  }

  const environmentFailures = results
    .filter((result) => result.classifiedFailure?.kind === "environment_toolchain" || result.classifiedFailure?.kind === "environment_tooling_unavailable")
    .map(summarizeFailure);
  const commandConstructionFailures = results
    .filter((result) => result.classifiedFailure?.kind === "command_construction")
    .map(summarizeFailure);
  const productFailures = results
    .filter((result) => result.classifiedFailure?.kind === "product_test")
    .map(summarizeFailure);
  const evidenceFailures = results
    .filter((result) => result.classifiedFailure?.kind === "evidence_command")
    .map(summarizeFailure);
  const hygieneFailures = unique([
    ...results.filter((result) => result.classifiedFailure?.kind === "hygiene").map(summarizeFailure),
    ...(options.repoHygieneReport?.mergeBlockingFindings ?? [])
  ]);
  const hygieneGateBlockers = unique([
    !options.repoHygieneReport
      ? "Repository hygiene has not been scanned for this cycle."
      : options.repoHygieneReport.status !== "passed"
        ? options.repoHygieneReport.summaryForHumans || `Repository hygiene status is ${options.repoHygieneReport.status}.`
        : undefined,
    ...(options.repoHygieneReport?.mergeBlockingFindings ?? [])
  ].filter((entry): entry is string => Boolean(entry?.trim())));
  const warnings = [...ledger.warnings];
  if (containsPytestUnavailable(results) && hasUnittestPass(results)) {
    warnings.push("pytest unavailable in this environment; project-supported unittest validation passed.");
  }
  if (containsPythonUnavailable(results) && hasPython3Pass(results)) {
    warnings.push("python unavailable in this environment; python3 validation passed.");
  }

  const testPassed = testResults.some((result) => result.status === "passed");
  const allTestsSkipped = testResults.length > 0 && testResults.every((result) => result.status === "skipped");
  const unresolvedValidationFailures = unique([...unresolved, ...hygieneFailures]);
  let finalValidationStatus: ValidationFinalStatus;
  if (testResults.length === 0) {
    finalValidationStatus = results.length === 0 ? "not_run" : skippedResults.length === results.length ? "skipped" : "partial";
  } else if (allTestsSkipped) {
    finalValidationStatus = "skipped";
  } else if (unresolvedValidationFailures.length > 0) {
    finalValidationStatus = testPassed && evidenceFailures.length > 0 && productFailures.length === 0 ? "partial" : "failed";
  } else if (testPassed) {
    finalValidationStatus = "passed";
  } else {
    finalValidationStatus = "failed";
  }

  const finalValidationBasis = (() => {
    if (finalValidationStatus === "passed") {
      const finalPassingTest = [...testResults].reverse().find((result) => result.status === "passed");
      return finalPassingTest ? `Final validation passed via ${finalPassingTest.command}.` : "Final validation passed.";
    }
    if (finalValidationStatus === "not_run") {
      return "No validation command ran.";
    }
    if (finalValidationStatus === "skipped") {
      return skippedResults.map((result) => result.classifiedFailure?.summary ?? `${result.command} skipped`).join(" ");
    }
    if (finalValidationStatus === "partial") {
      return "Some validation passed, but evidence or required checks remain unresolved.";
    }
    return unresolvedValidationFailures[0] ?? "Validation failed.";
  })();

  const mergeBlockedReasons = unique([
    ...(finalValidationStatus === "passed" ? [] : [`Validation status is ${finalValidationStatus}.`]),
    ...unresolvedValidationFailures,
    ...hygieneGateBlockers
  ]);
  const mergeAllowed = options.manualOverride ? true : finalValidationStatus === "passed" && mergeBlockedReasons.length === 0;
  const failedAttempts = failedResults.length;
  const repairedFailures = unique(repaired);
  const summaryForHumans = (() => {
    if (options.manualOverride) {
      return `Manual override recorded: ${options.manualOverrideReason ?? "validation gate bypassed by operator"}.`;
    }
    if (finalValidationStatus === "passed" && repairedFailures.length > 0) {
      const finalPassingTest = [...testResults].reverse().find((result) => result.status === "passed");
      return `${failedAttempts} failed attempt${failedAttempts === 1 ? "" : "s"} ${failedAttempts === 1 ? "was" : "were"} repaired; final validation passed${finalPassingTest ? ` via ${finalPassingTest.command}` : ""}.`;
    }
    if (finalValidationStatus === "passed") {
      return finalValidationBasis;
    }
    if (finalValidationStatus === "not_run") {
      return "Validation did not run; success cannot be reported.";
    }
    if (finalValidationStatus === "partial") {
      return "Validation is partial; merge requires explicit approval after unresolved evidence or checks are reviewed.";
    }
    if (finalValidationStatus === "skipped") {
      return "Validation was skipped; success cannot be reported.";
    }
    return `Validation failed: ${unresolvedValidationFailures[0] ?? "unresolved failure remains"}.`;
  })();

  return {
    ...ledger,
    updatedAt: options.updatedAt ?? nowIso(),
    attemptedCommands,
    commandResults: results,
    environmentFailures: unique(environmentFailures),
    commandConstructionFailures: unique(commandConstructionFailures),
    productFailures: unique(productFailures),
    evidenceFailures: unique(evidenceFailures),
    hygieneFailures,
    repairedFailures,
    warnings: addUnique(warnings, []),
    finalValidationStatus,
    finalValidationBasis,
    unresolvedValidationFailures,
    mergeAllowed,
    mergeBlockedReasons,
    summaryForHumans
  };
};

export const validationSuccessIsReportable = (ledger?: ValidationLedger): boolean =>
  Boolean(ledger && ledger.finalValidationStatus === "passed" && ledger.unresolvedValidationFailures.length === 0);

export const deriveMergeGateDecision = (input: {
  ledger?: ValidationLedger;
  repoHygieneReport?: RepoHygieneReport;
  manualOverride?: boolean;
  manualOverrideReason?: string;
}): { allowed: boolean; blockedReasons: string[]; manualOverrideRecorded?: string } => {
  const hygieneGateBlockers = unique([
    !input.repoHygieneReport
      ? "Repository hygiene has not been scanned."
      : input.repoHygieneReport.status !== "passed"
        ? input.repoHygieneReport.summaryForHumans || `Repository hygiene status is ${input.repoHygieneReport.status}.`
        : undefined,
    ...(input.repoHygieneReport?.mergeBlockingFindings ?? [])
  ].filter((entry): entry is string => Boolean(entry?.trim())));
  const blockedReasons = unique([
    !validationSuccessIsReportable(input.ledger)
      ? input.ledger
        ? input.ledger.summaryForHumans
        : "No validation ledger has passed."
      : undefined,
    ...(input.ledger?.unresolvedValidationFailures ?? []),
    ...hygieneGateBlockers
  ].filter((entry): entry is string => Boolean(entry?.trim())));
  if (input.manualOverride) {
    return {
      allowed: true,
      blockedReasons,
      manualOverrideRecorded: input.manualOverrideReason ?? "Manual override approved."
    };
  }
  return {
    allowed: blockedReasons.length === 0,
    blockedReasons
  };
};
