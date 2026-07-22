# Codex Agent Workbench

Codex Agent Workbench is a local-first Electron desktop app for loading a repository, detecting saved per-project interfaces, bootstrapping repository understanding, and coordinating multiple Codex agents against one codebase.

The desktop UI is intended to run on Windows. Codex, Git, worktrees, and deterministic repository operations are treated as WSL Ubuntu execution truth. The app can also run in mock mode so the UI and tests work without a live Codex session.

## What It Does

- Opens a repository or folder and derives a stable project identity.
- Detects saved interfaces from local app data and portable `.agent-workbench/interface.json`.
- Shows a saved-interface decision flow with validation badges and synthetic preview cards.
- Bootstraps repository tree, project stats, dependency discovery, overview text, and cached file summaries.
- Creates bootstrap, coding, integrity, merge, and recommendation agents.
- Opens to Mission Control: a live goal-to-merge pipeline, causal timeline, current/next handoff, deduplicated attention queue, and evidence drawer.
- Records canonical workflow execution revisions, structured incidents, a durable workflow journal, token usage, and validation/repair analytics.
- Keeps full workflow, history, repository, logs, credentials, and settings details available in advanced tabs.
- Uses the official `codex app-server` stdio JSON-RPC path for live Codex integration.
- Stores machine-local registry/state in app data and portable interface data in the repo.

## Prerequisites

- Windows 11 with WSL2 and Ubuntu.
- Node.js 22.12+ (the repository pins 22.22.0 in `.nvmrc`) and npm 10+.
- `git` available in WSL.
- `codex` installed in WSL and authenticated if you want live Codex transport.
- For Windows packaging: outbound access to Electron release artifacts from `github.com`.

## WSL Configuration

The app settings panel exposes:

- execution mode (`local` or `wsl`)
- WSL distro name
- Codex binary path
- optional `CODEX_HOME`
- worktree base directory
- optional editor command
- `/mnt/...` warning toggle

Path handling is centralized and tested for:

- `C:\...`
- `\\wsl$\Ubuntu\...`
- Linux/WSL paths

Windows paths are converted to `/mnt/<drive>/...`. UNC WSL paths are converted back to Linux paths while preserving distro identity.
When the app runs natively on Windows in `wsl` mode, repository commands and `codex app-server` execute inside the configured WSL distro while repository file reads use the translated Windows/UNC host path.

## Development

Install dependencies:

```bash
npm install
```

Generate the vendored app-server bindings:

```bash
npm run generate:app-server
```

Run the app in development:

```bash
npm run dev
```

Run in mock mode:

```bash
npm run mock
```

Run the compiled local workspace without generating a new Windows executable:

```bash
npm start
```

`npm start` checks whether the renderer, main-process, and preload bundles are current and rebuilds them when needed. This is also the primary local Windows workflow: from PowerShell in the repository, run `npm start`; the Electron app runs on Windows while Git, Codex, managed previews, and worktrees continue to use WSL as execution truth.

## Build And Test

```bash
npm run check:repo-hygiene
npm run typecheck
npm run lint
npm test
npm run build:app
npm run test:e2e
```

Distributable packaging:

```bash
npm run build
npm run package:win
npm run package:mac
```

`npm run build` compiles the local Electron app assets only. It does not create or copy a one-file desktop executable.

Use the packaging commands only when you deliberately need a shareable desktop artifact:

- WSL/Linux and native Windows packaging emits an unpacked Windows app folder by default; use `npm run package:win:portable` only when a one-file portable `.exe` is required.
- macOS packaging emits a `.dmg`.

Windows packaging is available for local use. `npm run package:win` and `npm run dist:win` produce an unpacked app folder without requesting extra files or secrets; `npm run package:win:portable` and `npm run dist:win:portable` produce the optional one-file `.exe`.

When a packaging command is used, the final unpacked folder, optional portable `.exe`, or `.dmg` is copied into the detected Downloads folder. Under WSL, the script prefers the Windows profile Downloads folder, so this machine resolves to `/mnt/c/Users/nicot/Downloads`.
Use `AWB_PACKAGE_OUTPUT_DIR=/path/to/output npm run package:win` to override the destination.

Detailed packaging and test instructions:

- [docs/windows-packaging.md](docs/windows-packaging.md)

## Saved Interfaces

Machine-local state is stored under the OS app-data directory and contains:

- project registry
- local layout/UI state
- cached file summaries
- runtime metadata
- agent transcript/full-output sidecars
- diagnostics used for safe mode and state repair

Portable interfaces are stored in:

```text
<target-project>/.agent-workbench/interface.json
```

The portable file is versioned and schema-validated. Version 2 checksums are verified on import; legacy version 1 files remain importable and are migrated. Exports exclude secrets, auth state, live approvals, raw command output, and machine-local execution handles.

## Import And Export

- Export writes `<target-project>/.agent-workbench/interface.json` by default.
- Review logs write to `<target-project>/.agent-workbench/review-logs/` when no user-chosen download path is provided.
- Visual exports write to `<target-project>/.agent-workbench/visuals/` by default.
- Repair reports and other generated workflow artifacts belong under `<target-project>/.agent-workbench/reports/` or a user-chosen download location.
- Import validates schema version and project identity before applying.
- Identity mismatches are blocked unless the caller explicitly allows them.
- Machine-specific paths and settings stay local.
- The runtime blocks target-project artifacts from being written into the Agentic Workbench source repository.

## Workspace And Advanced Views

The workspace opens on Mission, a calm high-level operator view:

- Live execution map: goal, recommendation, plan, coding, integrity, and merge stages with repair-loop routing.
- Causal timeline: selectable events with attached status, source, and evidence.
- Now / Next / Needs you: the active agent, planned handoff, and one deduplicated operator queue.
- Evidence drawer: progress, changed files, planner rationale, and project health without overwhelming the main view.
- Analytics: cycle throughput, validation pass rate, repair success, commands, files, models, and token totals.

Advanced tabs remain available for detailed operation:

- Workflow: current plan, automation controls, approvals, handoffs, and deeper traces.
- History: cycle summaries and agent cards. Every retained agent has a visible "View full output" action.
- Repository: indexed file tree, scan status, truncation/partial-index warnings, summaries, and excluded paths.
- Settings: runtime readiness, Codex update checks, credentials, model defaults, safe mode state, and Goal Charter settings.

Preview runs through a managed Playwright broker in WSL. Repository preview commands require project trust, browser sessions are scoped to their operator or agent owner, and visual projects must produce content-bound browser evidence before merge. Browser binaries or Linux dependencies are installed only through an explicit operator action.

The full-output viewer supports copy, search, line wrapping, preformatted/plain text modes, and collapsed technical details. Preview text may be truncated, but retained sidecar output is loaded on demand.

## Repo Hygiene

Do not commit generated target-project artifacts to this repository. In particular, keep these out of the `agentic-workbench` repo root:

- target-project review logs
- exported interface JSON
- visual audit PDFs and screenshots
- repair reports
- agent transcripts or full outputs
- workflow histories
- repository scan artifacts

Use the target project's `.agent-workbench/` directory for portable target-project artifacts, or OS app-data for machine-local state. The root `.gitignore` blocks common generated artifact patterns, and `npm run check:repo-hygiene` fails when forbidden tracked files or unexpectedly large unallowlisted files appear.

If a generated artifact with private project history, absolute local paths, transcripts, or sensitive content was committed, remove it from the current tree immediately. A Git history purge may also be advisable, but should only be done deliberately by maintainers.

## Limitations / Non-goals

- The renderer focuses on harness operation and repository evidence, not full IDE parity.
- Deterministic validation remains the merge authority even when agents provide richer narrative summaries.
- Packaging from WSL depends on network access to Electron artifacts and, in some setups, a Windows-native packaging pass.
- The app does not ship telemetry, analytics, or a remote backend.
