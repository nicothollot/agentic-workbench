# Security

## Electron Hardening

- `contextIsolation: true`
- renderer `sandbox: true`
- `nodeIntegration: false`
- preload bridge is explicit and typed
- local assets only
- CSP in `index.html`
- external links are denied in-app and opened with `shell.openExternal`

## IPC Rules

- Renderer never spawns shell commands directly.
- IPC payloads are validated in the main process before dispatch.
- Sensitive operations remain in main/runtime modules.
- Future work on new features should extend the typed preload API rather than adding ad hoc IPC channels.

## Codex Boundary

- Codex integration uses `codex app-server` over stdio JSON-RPC.
- No TUI scraping.
- No websocket transport.
- Approval requests from Codex are surfaced in the UI and recorded in event history.

## WSL Boundary

- WSL is treated as the execution truth.
- Path conversion is centralized rather than scattered through UI code.
- Git/worktree/merge operations are deterministic runtime actions, not renderer behavior.

## Secret Handling

Portable exports must not include:

- `~/.codex/auth.json`
- token caches
- raw credentials
- unrelated shell history
- secret environment variables

The current portable format stores repository understanding and UI state only.

## Approval Model

- Command, file-change, permission, and patch approvals are first-class records.
- Approval decisions are explicit and reviewable.
- Defaults are conservative for non-Git projects.

## Packaging / Distribution Safety

- The repository uses pure JS/TS dependencies for the main application logic.
- Windows packaging is performed via `electron-builder --win nsis`.
- In restricted WSL environments, packaging may fail before downloading Windows Electron artifacts from GitHub; this is an environment constraint, not a fallback to unsafe behavior.
