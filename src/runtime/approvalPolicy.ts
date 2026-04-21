import path from "node:path";
import type { AppSettings, ApprovalRequestRecord } from "@shared/types";

export type CommandApprovalClass = "git-commit" | "git-push" | "command";

const gitOptionsWithValues = new Set(["-c", "-C", "--exec-path", "--git-dir", "--namespace", "--super-prefix", "--work-tree"]);

const tokenizeShellLikeText = (value: string): string[] => value.match(/"[^"]*"|'[^']*'|`[^`]*`|\S+/g) ?? [];

const normalizeShellToken = (token: string): string =>
  token
    .replace(/^[("'`]+/, "")
    .replace(/[)"'`,;:]+$/, "")
    .trim();

const normalizeExecutable = (token: string): string => path.posix.basename(token.replace(/\\/g, "/")).toLowerCase();

const findExecutableIndex = (tokens: string[]): number | undefined => {
  for (const [index, rawToken] of tokens.entries()) {
    const token = normalizeShellToken(rawToken);
    if (!token) {
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token)) {
      continue;
    }
    if (token === "env" || token === "command" || token === "sudo") {
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    return index;
  }

  return undefined;
};

export const classifyCommandApproval = (command?: string): CommandApprovalClass => {
  if (!command?.trim()) {
    return "command";
  }

  const tokens = tokenizeShellLikeText(command);
  const executableIndex = findExecutableIndex(tokens);
  if (executableIndex === undefined) {
    return "command";
  }

  const executable = normalizeExecutable(normalizeShellToken(tokens[executableIndex]));
  if (executable !== "git" && executable !== "git.exe") {
    return "command";
  }

  for (let index = executableIndex + 1; index < tokens.length; index += 1) {
    const token = normalizeShellToken(tokens[index]);
    if (!token) {
      continue;
    }
    if (token === "--") {
      continue;
    }
    if (token.startsWith("-")) {
      if (gitOptionsWithValues.has(token)) {
        index += 1;
      }
      continue;
    }

    if (token === "commit") {
      return "git-commit";
    }
    if (token === "push") {
      return "git-push";
    }
    return "command";
  }

  return "command";
};

export const shouldAutoApproveApproval = (
  approval: Pick<ApprovalRequestRecord, "kind" | "command">,
  settings: Pick<AppSettings, "autoApproveCommands" | "autoApproveGitCommits" | "autoApproveGitPushes">
): boolean => {
  if (approval.kind !== "command" || !approval.command?.trim()) {
    return false;
  }

  const approvalClass = classifyCommandApproval(approval.command);
  if (approvalClass === "git-commit") {
    return settings.autoApproveGitCommits;
  }
  if (approvalClass === "git-push") {
    return settings.autoApproveGitPushes;
  }
  return settings.autoApproveCommands;
};
