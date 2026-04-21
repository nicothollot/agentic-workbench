import path from "node:path";
import type { AppSettings, GitHubStatus, LinkedGitHubAccount } from "@shared/types";
import { nowIso } from "@shared/utils";
import { RuntimeCommandExecutor } from "./execution";

const GITHUB_HOST = "github.com";
const GITHUB_LINK_COMMAND = "gh auth login --hostname github.com --git-protocol ssh --web";

export interface GitHubRepositoryRef {
  owner: string;
  repo: string;
}

type RuntimeSettings = Pick<AppSettings, "executionMode" | "distroName" | "mockMode">;

const normalizeComparablePath = (value: string): string => {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:/i.test(normalized) ? normalized.toLowerCase() : normalized;
};

const isExactExecutionPath = (left: string, right: string): boolean =>
  normalizeComparablePath(left) === normalizeComparablePath(right);

const execStructured = async (
  settings: RuntimeSettings,
  command: string,
  args: string[],
  cwd?: string,
  env?: Record<string, string | undefined>
): Promise<string> => {
  const executor = new RuntimeCommandExecutor(settings);
  const result = await executor.execStructuredCommand({
    command,
    args,
    cwd,
    env
  });
  return result.stdout.trim();
};

const parseGitHubUsernameFromStatus = (output: string): string | undefined => {
  const accountMatch = output.match(/Logged in to github\.com (?:account|as)\s+([A-Za-z0-9-]+)/i);
  return accountMatch?.[1];
};

const parseGitProtocolFromStatus = (output: string): "ssh" | "https" | undefined => {
  const protocolMatch = output.match(/Git operations protocol:\s*(ssh|https)/i);
  return protocolMatch?.[1]?.toLowerCase() as "ssh" | "https" | undefined;
};

const isMissingGhCli = (message: string): boolean =>
  /command "gh" is not installed|command "gh" is not available|not installed or not available on path/i.test(message);

const isUnlinkedGhStatus = (message: string): boolean =>
  /gh auth login|not logged in|not logged into any github hosts|authentication/i.test(message);

const isMissingGitIdentity = (message: string): boolean =>
  /user\.email|user\.name|author identity unknown|unable to auto-detect email address/i.test(message);

export const buildGitHubLinkCommand = (): string => GITHUB_LINK_COMMAND;

export const isGitHubRemote = (remote: string): boolean => /github\.com[:/]/i.test(remote);

export const parseGitHubRemote = (remote: string): GitHubRepositoryRef | null => {
  const normalized = remote.trim().replace(/\.git$/i, "");
  const patterns = [
    /github\.com[:/]([^/\s:]+)\/([^/\s]+)$/i,
    /ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+)$/i
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) {
      return {
        owner: match[1],
        repo: match[2]
      };
    }
  }
  return null;
};

export const buildGitHubRepositoryName = (projectName: string): string =>
  projectName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/\.{2,}/g, ".")
    .slice(0, 100) || "project";

export const buildGitHubSshRemoteUrl = (owner: string, repo: string): string => `git@github.com:${owner}/${repo}.git`;

export const getGitHubStatus = async (
  settings: RuntimeSettings,
  storedAccount?: LinkedGitHubAccount
): Promise<GitHubStatus> => {
  const checkedAt = nowIso();
  if (settings.mockMode && storedAccount) {
    return {
      state: "linked",
      username: storedAccount.username,
      sshReady: true,
      message: `Mock mode is using linked GitHub account ${storedAccount.username}.`,
      checkedAt
    };
  }

  try {
    const executor = new RuntimeCommandExecutor(settings);
    const authStatus = await executor.execStructuredCommand({
      command: "gh",
      args: ["auth", "status", "--active", "--hostname", GITHUB_HOST]
    });
    const combinedOutput = `${authStatus.stdout}\n${authStatus.stderr}`.trim();
    const username = parseGitHubUsernameFromStatus(combinedOutput) ?? storedAccount?.username;
    const gitProtocol = parseGitProtocolFromStatus(combinedOutput);

    if (gitProtocol === "ssh") {
      return {
        state: "linked",
        username,
        sshReady: true,
        message: username
          ? `GitHub is linked as ${username} and ready for SSH-backed repositories.`
          : "GitHub is linked and ready for SSH-backed repositories.",
        checkedAt
      };
    }

    return {
      state: "needs_ssh",
      username,
      sshReady: false,
      message: `GitHub CLI is authenticated${username ? ` as ${username}` : ""}, but Git operations are not set to SSH. Run \`${GITHUB_LINK_COMMAND}\` and choose SSH.`,
      checkedAt
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isMissingGhCli(message)) {
      return {
        state: "cli_missing",
        sshReady: false,
        message: `GitHub CLI (gh) is required. Install it, then run \`${GITHUB_LINK_COMMAND}\`.`,
        checkedAt
      };
    }
    if (isUnlinkedGhStatus(message)) {
      return {
        state: "not_linked",
        sshReady: false,
        message: `Link GitHub before using the workbench. Run \`${GITHUB_LINK_COMMAND}\`, then refresh this status.`,
        checkedAt
      };
    }
    return {
      state: "error",
      username: storedAccount?.username,
      sshReady: false,
      message: `GitHub status check failed. ${message}`,
      checkedAt
    };
  }
};

const getGitTopLevel = async (settings: RuntimeSettings, executionPath: string): Promise<string | undefined> => {
  try {
    return await execStructured(settings, "git", ["rev-parse", "--show-toplevel"], executionPath);
  } catch {
    return undefined;
  }
};

const getCurrentBranch = async (settings: RuntimeSettings, executionPath: string): Promise<string> => {
  try {
    const branch = await execStructured(settings, "git", ["branch", "--show-current"], executionPath);
    return branch || "main";
  } catch {
    return "main";
  }
};

const hasCommit = async (settings: RuntimeSettings, executionPath: string): Promise<boolean> => {
  try {
    await execStructured(settings, "git", ["rev-parse", "--verify", "HEAD"], executionPath);
    return true;
  } catch {
    return false;
  }
};

const listRemoteUrls = async (settings: RuntimeSettings, executionPath: string): Promise<string[]> => {
  try {
    const output = await execStructured(settings, "git", ["remote", "-v"], executionPath);
    return [...new Set(
      output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.split(/\s+/)[1])
        .filter(Boolean)
    )];
  } catch {
    return [];
  }
};

const hasOriginRemote = async (settings: RuntimeSettings, executionPath: string): Promise<boolean> => {
  try {
    await execStructured(settings, "git", ["remote", "get-url", "origin"], executionPath);
    return true;
  } catch {
    return false;
  }
};

const ensureInitialCommit = async (settings: RuntimeSettings, executionPath: string): Promise<void> => {
  if (await hasCommit(settings, executionPath)) {
    return;
  }

  try {
    await execStructured(settings, "git", ["add", "-A"], executionPath);
    await execStructured(settings, "git", ["commit", "--allow-empty", "-m", "Initial commit"], executionPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isMissingGitIdentity(message)) {
      throw new Error(
        "Git needs a user name and email before the initial repository commit can be created. Configure `git config --global user.name` and `git config --global user.email`, then try again."
      );
    }
    throw error;
  }
};

export const ensureGitHubRepositoryForCreation = async (
  executionPath: string,
  linkedAccount: LinkedGitHubAccount,
  settings: RuntimeSettings
): Promise<void> => {
  const existingGitRoot = await getGitTopLevel(settings, executionPath);
  const insideParentRepository = existingGitRoot !== undefined && !isExactExecutionPath(existingGitRoot, executionPath);
  const gitRoot = insideParentRepository ? executionPath : (existingGitRoot ?? executionPath);

  if (!existingGitRoot || insideParentRepository) {
    await execStructured(settings, "git", ["init", "-b", "main"], gitRoot);
  }

  const remoteUrls = insideParentRepository ? [] : await listRemoteUrls(settings, gitRoot);
  if (remoteUrls.some(isGitHubRemote)) {
    return;
  }

  if (remoteUrls.length > 0) {
    throw new Error("This folder already belongs to a non-GitHub Git repository. Open a GitHub-backed repository instead, or start from a clean folder.");
  }

  await ensureInitialCommit(settings, gitRoot);

  const repositoryName = buildGitHubRepositoryName(path.basename(gitRoot));
  const sshRemoteUrl = buildGitHubSshRemoteUrl(linkedAccount.username, repositoryName);

  if (settings.mockMode) {
    if (await hasOriginRemote(settings, gitRoot)) {
      await execStructured(settings, "git", ["remote", "set-url", "origin", sshRemoteUrl], gitRoot);
    } else {
      await execStructured(settings, "git", ["remote", "add", "origin", sshRemoteUrl], gitRoot);
    }
    return;
  }

  const nameWithOwner = `${linkedAccount.username}/${repositoryName}`;
  await execStructured(
    settings,
    "gh",
    ["repo", "create", nameWithOwner, "--private", "--source", ".", "--remote", "origin"],
    gitRoot
  );

  if (await hasOriginRemote(settings, gitRoot)) {
    await execStructured(settings, "git", ["remote", "set-url", "origin", sshRemoteUrl], gitRoot);
  } else {
    await execStructured(settings, "git", ["remote", "add", "origin", sshRemoteUrl], gitRoot);
  }

  const branch = await getCurrentBranch(settings, gitRoot);
  try {
    await execStructured(settings, "git", ["push", "-u", "origin", branch], gitRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/permission denied \(publickey\)|could not read from remote repository/i.test(message)) {
      throw new Error(
        `The GitHub repository was created, but the initial SSH push failed. Ensure your SSH keys are configured for GitHub, then push ${branch} to ${sshRemoteUrl}.`
      );
    }
    throw error;
  }
};
