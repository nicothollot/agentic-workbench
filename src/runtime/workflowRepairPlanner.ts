import type { AgentState, ProjectWorkflowState } from "@shared/types";
import { collectRepairAttemptReports } from "@shared/workflowRepairReport";
import { buildIntegrityFailureSignature, collectRetryableIntegrityRisks } from "./workflowGuardrails";

export interface RepairStrategyContext {
  recurringFailureCount: number;
  retryableRisks: string[];
  recentAttemptSummaries: string[];
  focusHints: string[];
}

const unique = <T>(values: T[]): T[] => [...new Set(values)];

const normalizePath = (value: string): string =>
  value.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");

const joinList = (values: string[], maxItems: number): string =>
  values.slice(0, maxItems).join(", ");

const summarizeAttempt = (attemptNumber: number, codingAgent: AgentState | undefined, validationSummary: string): string => {
  const changedFiles = unique((codingAgent?.changedFiles ?? []).map(normalizePath).filter((entry) => entry.length > 0));
  const fragments = [`Attempt ${attemptNumber}`];

  fragments.push(
    changedFiles.length > 0
      ? `changed ${joinList(changedFiles, 4)}`
      : "recorded no changed files"
  );
  fragments.push(`validation outcome: ${validationSummary}`);

  const codingNote = codingAgent?.lastMessageSnippet ?? codingAgent?.currentPhase;
  if (codingNote) {
    fragments.push(`coding note: ${codingNote}`);
  }

  return fragments.join("; ");
};

export const buildRepairStrategyContext = (
  workflow: ProjectWorkflowState,
  agents: AgentState[]
): RepairStrategyContext => {
  const attempts = collectRepairAttemptReports(workflow, agents);
  const latestAttempt = attempts[attempts.length - 1];
  const latestReport = latestAttempt?.integrityAgent.integrityReport;
  const latestSignature = latestReport ? buildIntegrityFailureSignature(latestReport) : "";
  const recurringFailureCount = latestSignature.length > 0
    ? attempts.filter((attempt) => {
        const report = attempt.integrityAgent.integrityReport;
        return report ? buildIntegrityFailureSignature(report) === latestSignature : false;
      }).length
    : 0;

  const retryableRisks = latestReport ? collectRetryableIntegrityRisks(latestReport) : [];
  const failedCommands = unique(
    attempts.flatMap((attempt) =>
      (attempt.integrityAgent.integrityReport?.checks ?? [])
        .filter((check) => check.status === "failed")
        .map((check) => check.command.trim())
        .filter((command) => command.length > 0)
    )
  );
  const touchedFiles = unique(
    attempts.flatMap((attempt) => (attempt.codingAgent?.changedFiles ?? []).map(normalizePath))
      .filter((entry) => entry.length > 0)
  );
  const scopedPaths = unique(
    [
      ...(workflow.approvedRecommendation?.relatedPaths ?? []),
      ...(workflow.manualHandoff?.involvedPaths ?? [])
    ]
      .map(normalizePath)
      .filter((entry) => entry.length > 0)
  );
  const untouchedScopedPaths = scopedPaths.filter((entry) => !touchedFiles.includes(entry));

  const recentAttemptSummaries = attempts
    .slice(-3)
    .map((attempt) =>
      summarizeAttempt(
        attempt.attemptNumber,
        attempt.codingAgent,
        attempt.integrityAgent.integrityReport?.summary ?? "Validation failed."
      )
    );

  const focusHints = [
    recurringFailureCount >= 2
      ? `The current integrity failure signature has repeated ${recurringFailureCount} times. Change approach instead of repeating the last edit pattern.`
      : undefined,
    failedCommands.length > 0 ? `Recurring failing checks: ${joinList(failedCommands, 3)}.` : undefined,
    touchedFiles.length > 0 ? `Files already touched in this repair loop: ${joinList(touchedFiles, 8)}.` : undefined,
    untouchedScopedPaths.length > 0 ? `Still-untouched scoped paths worth inspecting next: ${joinList(untouchedScopedPaths, 4)}.` : undefined,
    retryableRisks.length > 0 ? `Unresolved repair targets: ${retryableRisks.join("; ")}` : undefined
  ].filter((entry): entry is string => Boolean(entry));

  return {
    recurringFailureCount,
    retryableRisks,
    recentAttemptSummaries,
    focusHints
  };
};
