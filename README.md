# Codex Agent Workbench

Codex Agent Workbench is a local-first Electron desktop app for loading a repository, detecting saved per-project interfaces, bootstrapping repository understanding, and coordinating multiple Codex agents against one codebase.

The desktop UI is intended to run on Windows. Codex, Git, worktrees, and deterministic repository operations are treated as WSL Ubuntu execution truth. The app can also run in mock mode so the UI and tests work without a live Codex session.

## What It Does

- Opens a repository or folder and derives a stable project identity.
- Detects saved interfaces from local app data and portable `.agent-workbench/interface.json`.
- Shows a saved-interface decision flow with validation badges and synthetic preview cards.
- Bootstraps repository tree, project stats, dependency discovery, overview text, and cached file summaries.
- Creates bootstrap, coding, integrity, merge, and recommendation agents.
- Uses the official `codex app-server` stdio JSON-RPC path for live Codex integration.
- Stores machine-local registry/state in app data and portable interface data in the repo.

## Prerequisites

- Windows 11 with WSL2 and Ubuntu.
- Node.js 24+ and npm 11+.
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
npm run build:app
npm start
```

## Build And Test

```bash
npm run typecheck
npm run lint
npm test
npm run build:app
```

Distributable packaging:

```bash
npm run build
npm run package:win
npm run package:mac
```

`npm run build` creates the native one-file distributable for the current build host:

- WSL/Linux and native Windows emit a Windows portable `.exe`.
- macOS emits a `.dmg`.

Windows executable packaging is available for local use. `npm run package:win` and `npm run dist:win` produce the local portable `.exe` without requesting extra files or secrets.

The final `.exe` or `.dmg` is copied into the detected Downloads folder. Under WSL, the script prefers the Windows profile Downloads folder, so this machine resolves to `/mnt/c/Users/nicot/Downloads`.
Use `AWB_PACKAGE_OUTPUT_DIR=/path/to/output npm run build` to override the destination.

Detailed packaging and test instructions:

- [docs/windows-packaging.md](docs/windows-packaging.md)

## Saved Interfaces

Machine-local state is stored under the OS app-data directory and contains:

- project registry
- local layout/UI state
- cached file summaries
- runtime metadata

Portable interfaces are stored in:

```text
.agent-workbench/interface.json
```

The portable file is versioned, schema-validated, checksumed, and excludes secrets, auth state, and raw credentials.

## Import And Export

- Export writes `.agent-workbench/interface.json` by default.
- Import validates schema version and project identity before applying.
- Identity mismatches are blocked unless the caller explicitly allows them.
- Machine-specific paths and settings stay local.

## Limitations / Non-goals

- The current renderer focuses on core flows, not full IDE parity.
- Integrity/recommendation reports currently lean more on deterministic data than on rich structured Codex responses.
- Packaging from WSL depends on network access to Electron artifacts and, in some setups, a Windows-native packaging pass.
- The app does not ship telemetry, analytics, or a remote backend.
