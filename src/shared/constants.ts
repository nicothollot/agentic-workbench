export const APP_NAME = "Codex Agent Workbench";
export const APP_VERSION = "0.1.0";
export const APP_ID = "com.codex.agentworkbench";
export const PORTABLE_INTERFACE_VERSION = 1;
export const REVIEW_LOG_BUNDLE_VERSION = 1;
export const PORTABLE_INTERFACE_PATH = ".agent-workbench/interface.json";
export const USER_INPUT_REQUESTS_PATH = ".agent-workbench/input-requests";
export const PROJECT_SHELL_HANDOFF_DIR = ".agent-workbench/manual-handoff";
export const PROJECT_SHELL_HANDOFF_PATH = ".agent-workbench/manual-handoff/codex-handoff.md";
export const PROJECT_SHELL_LAUNCHER_SCRIPT_PATH = ".agent-workbench/manual-handoff/open-codex-terminal.sh";
export const PROJECT_SHELL_LAUNCHER_CMD_PATH = ".agent-workbench/manual-handoff/open-codex-terminal.cmd";
export const PROJECT_SHELL_LAUNCH_LOG_PATH = ".agent-workbench/manual-handoff/terminal-launch.txt";
export const SUMMARY_CACHE_VERSION = 1;
export const PROJECT_FINGERPRINT_VERSION = 1;
export const DEFAULT_DISTRO_NAME = "Ubuntu";
export const DEFAULT_CODEX_BINARY = "codex";
export const DEFAULT_WORKTREE_BASE_DIR = "~/.codex-agent-workbench/worktrees";
export const DEFAULT_IGNORES = [
  ".git",
  ".agent-workbench",
  "node_modules",
  "dist",
  "build",
  "release",
  "out",
  ".electron-builder",
  "build-resources/generated",
  ".next",
  ".nuxt",
  ".output",
  ".parcel-cache",
  ".svelte-kit",
  ".turbo",
  ".cache",
  "coverage",
  "target",
  ".venv",
  "venv",
  "__pycache__"
];
