import type { AgentState, ProjectWorkflowState, WorkflowActivityEvent } from "./types";

export interface RepairAttemptReport {
  attemptNumber: number;
  codingAgent?: AgentState;
  integrityAgent: AgentState;
  relatedActivity: WorkflowActivityEvent[];
}

const toTime = (value?: string): number => {
  if (!value) {
    return Number.NaN;
  }

  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? Number.NaN : parsed;
};

const firstFiniteTime = (...values: Array<string | undefined>): number => {
  for (const value of values) {
    const parsed = toTime(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return Number.NaN;
};

const formatTimestamp = (value?: string): string => {
  if (!value) {
    return "unknown";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toISOString();
};

const summarizeAgentTime = (agent?: AgentState): number =>
  firstFiniteTime(
    agent?.integrityReport?.generatedAt,
    agent?.mergeReport?.generatedAt,
    agent?.completedAt,
    agent?.lastActivityAt,
    agent?.startedAt,
    agent?.createdAt
  );

const workflowEventTime = (event: WorkflowActivityEvent): number =>
  firstFiniteTime(event.timestamp);

export const collectRepairAttemptReports = (
  workflow: ProjectWorkflowState,
  agents: AgentState[]
): RepairAttemptReport[] => {
  const cycleNumber = workflow.workflowCycle.cycleNumber;
  const cycleAgents = agents.filter((agent) => agent.workflowCycleNumber === cycleNumber);
  const failedIntegrityAgents = cycleAgents
    .filter((agent) => agent.category === "integrity" && agent.status === "failed" && agent.integrityReport)
    .sort((left, right) => summarizeAgentTime(left) - summarizeAgentTime(right));
  const codingAgents = cycleAgents
    .filter((agent) => agent.category === "coding")
    .sort((left, right) => summarizeAgentTime(left) - summarizeAgentTime(right));
  const assignedCodingIds = new Set<string>();

  return failedIntegrityAgents.map((integrityAgent, index) => {
    const integrityTime = summarizeAgentTime(integrityAgent);
    const codingAgent = codingAgents
      .filter((agent) => !assignedCodingIds.has(agent.id))
      .filter((agent) => {
        const agentTime = summarizeAgentTime(agent);
        return !Number.isFinite(integrityTime) || !Number.isFinite(agentTime) || agentTime <= integrityTime;
      })
      .sort((left, right) => summarizeAgentTime(right) - summarizeAgentTime(left))[0]
      ?? codingAgents.find((agent) => !assignedCodingIds.has(agent.id));

    if (codingAgent) {
      assignedCodingIds.add(codingAgent.id);
    }

    const attemptStart = firstFiniteTime(
      codingAgent?.startedAt,
      codingAgent?.createdAt,
      workflow.workflowCycle.startedAt
    );
    const attemptEnd = firstFiniteTime(
      integrityAgent.integrityReport?.generatedAt,
      integrityAgent.completedAt,
      integrityAgent.lastActivityAt,
      integrityAgent.createdAt
    );
    const relatedActivity = workflow.activityLog
      .filter((event) => {
        const eventTime = workflowEventTime(event);
        if (!Number.isFinite(eventTime)) {
          return false;
        }
        if (Number.isFinite(attemptStart) && eventTime < attemptStart) {
          return false;
        }
        if (Number.isFinite(attemptEnd) && eventTime > attemptEnd) {
          return false;
        }
        return (
          event.agentId === codingAgent?.id ||
          event.agentId === integrityAgent.id ||
          event.stepId === "coding" ||
          event.stepId === "integrity"
        );
      })
      .sort((left, right) => workflowEventTime(left) - workflowEventTime(right));

    return {
      attemptNumber: index + 1,
      codingAgent,
      integrityAgent,
      relatedActivity
    };
  });
};

const renderAgentBlock = (label: string, agent?: AgentState): string[] => {
  if (!agent) {
    return [`- ${label}: not found`];
  }

  const lines = [
    `- ${label}: ${agent.name}`,
    `- ${label} model: ${agent.model}`,
    `- ${label} status: ${agent.status}`,
    `- ${label} started: ${formatTimestamp(agent.startedAt ?? agent.createdAt)}`,
    `- ${label} completed: ${formatTimestamp(agent.completedAt)}`,
    `- ${label} changed files: ${agent.changedFiles.length ? agent.changedFiles.join(", ") : "none recorded"}`
  ];

  if (agent.currentPhase) {
    lines.push(`- ${label} phase: ${agent.currentPhase}`);
  }
  if (agent.lastMessageSnippet) {
    lines.push(`- ${label} note: ${agent.lastMessageSnippet}`);
  }

  return lines;
};

export const buildRepairReportMarkdown = (
  projectName: string,
  workflow: ProjectWorkflowState,
  agents: AgentState[]
): string => {
  const attempts = collectRepairAttemptReports(workflow, agents);
  const generatedAt = new Date().toISOString();
  const lines: string[] = [
    `# Repair Failure Report`,
    ``,
    `- Project: ${projectName}`,
    `- Generated at: ${generatedAt}`,
    `- Workflow cycle: ${workflow.workflowCycle.cycleNumber}`,
    `- Workflow stage: ${workflow.workflowStage}`,
    `- Stop reason: ${workflow.workflowStopReason}`,
    `- Repair status: ${workflow.repair.status}`,
    `- Repair attempts used: ${workflow.repair.attemptCount} of ${workflow.repair.maxAttempts}`,
    `- Ultimate Goal: ${workflow.ultimateGoal.summary || "Not confirmed"}`,
    `- Scoped goal: ${workflow.scopedGoal?.summary ?? "No scoped goal recorded"}`,
    ``
  ];

  if (workflow.manualHandoff) {
    lines.push(
      `## Manual Handoff`,
      ``,
      `- Reason: ${workflow.manualHandoff.reason}`,
      `- Title: ${workflow.manualHandoff.title}`,
      `- What failed: ${workflow.manualHandoff.validationIssue}`,
      `- Latest failure reason: ${workflow.manualHandoff.latestFailureReason}`,
      `- Involved paths: ${workflow.manualHandoff.involvedPaths.length ? workflow.manualHandoff.involvedPaths.join(", ") : "none recorded"}`,
      ``
    );
  }

  if (!attempts.length) {
    lines.push(`No failed integrity reports were recorded for this workflow cycle.`);
    return lines.join("\n");
  }

  lines.push(
    `## Failure Summary`,
    ``,
    `- Failed integrity passes captured: ${attempts.length}`,
    `- Latest issue summary: ${workflow.repair.latestIssueSummary ?? "No latest issue summary recorded"}`,
    `- Latest failure reason: ${workflow.repair.latestFailureReason ?? "No latest failure reason recorded"}`,
    ``
  );

  for (const attempt of attempts) {
    const integrityReport = attempt.integrityAgent.integrityReport;
    lines.push(
      `## Attempt ${attempt.attemptNumber}`,
      ``,
      ...renderAgentBlock("Coding agent", attempt.codingAgent),
      ...renderAgentBlock("Integrity agent", attempt.integrityAgent),
      `- Integrity summary: ${integrityReport?.summary ?? "No integrity summary recorded"}`,
      ``
    );

    if (integrityReport?.risks.length) {
      lines.push(`### Risks`, ``);
      for (const risk of integrityReport.risks) {
        lines.push(`- ${risk}`);
      }
      lines.push(``);
    }

    if (integrityReport?.checks.length) {
      lines.push(`### Deterministic Checks`, ``);
      for (const check of integrityReport.checks) {
        lines.push(
          `- ${check.name}: ${check.status}`,
          `  Command: ${check.command}`
        );
        if (check.outputSnippet.trim()) {
          lines.push(``, "```text", check.outputSnippet, "```");
        }
      }
      lines.push(``);
    }

    const commandAgents = [attempt.codingAgent, attempt.integrityAgent].filter((agent): agent is AgentState => Boolean(agent));
    const commands = commandAgents.flatMap((agent) =>
      agent.commandLog.map((command) => ({
        agentName: agent.name,
        ...command
      }))
    );
    if (commands.length) {
      lines.push(`### Agent Commands`, ``);
      for (const command of commands) {
        lines.push(
          `- ${command.agentName}: ${command.command}`,
          `  Status: ${command.status}${command.exitCode !== undefined ? ` (exit ${command.exitCode ?? "unknown"})` : ""}`,
          `  Working directory: ${command.cwd ?? "not provided"}`
        );
        if (command.output.trim()) {
          lines.push(``, "```text", command.output, "```");
        }
      }
      lines.push(``);
    }

    if (attempt.relatedActivity.length) {
      lines.push(`### Workflow Activity`, ``);
      for (const event of attempt.relatedActivity) {
        lines.push(
          `- ${formatTimestamp(event.timestamp)} | ${event.status} | ${event.title}${event.detail ? ` | ${event.detail}` : ""}`
        );
      }
      lines.push(``);
    }
  }

  return lines.join("\n");
};
