# Architecture

## Core Decisions

- Electron + React + TypeScript with a sandboxed renderer.
- Narrow preload bridge only. No Node APIs are exposed directly to the renderer.
- Privileged logic lives in the main process plus runtime modules under `src/runtime`.
- Codex integration uses the official `codex app-server` stdio transport.
- The vendored TypeScript protocol bindings are generated from the installed Codex version into `src/generated/app-server`.
- Persistence is file-based only: app-data JSON for local state, `.agent-workbench/interface.json` for portable state.
- WSL is the execution boundary for Codex, Git, worktrees, merge attempts, and deterministic repo operations.
- Mock transport exists so the UI and tests run without a live Codex session.

## Layers

### Renderer

`src/renderer`

- Project loader flow
- saved-interface chooser
- repository tree and file-summary panel
- agent board
- activity stream and approvals
- top/bottom IDE-style layout

### Preload

`src/preload/index.ts`

- Typed, minimal API surface
- all renderer calls go through `ipcRenderer.invoke`
- state updates are pushed via `state:updated`

### Main

`src/main/index.ts`

- BrowserWindow lifecycle
- secure `webPreferences`
- folder/file dialogs
- IPC validation before dispatch
- forwards service state updates to the renderer

### Runtime Broker / Services

`src/runtime`

- `appService.ts`: orchestration entry point
- `codexTransport.ts`: real app-server stdio JSON-RPC transport
- `mockCodexTransport.ts`: deterministic fake transport
- `repoScanner.ts`: deterministic repository scan/stats/dependency pass
- `manifestParser.ts`: deterministic manifest parsing
- `git.ts`: Git metadata, worktrees, merge attempt helpers
- `storage.ts`: app-data + portable interface persistence
- `runtimeEvents.ts`: reducer for transport-driven agent state

## Codex Transport

The installed Codex CLI currently speaks newline-delimited JSON-RPC over stdio for `app-server`. The transport implementation:

- starts `codex app-server`
- sends JSON-RPC request objects one per line
- reads one JSON object per line
- routes responses, notifications, and server-initiated approval requests

No TUI scraping, websocket transport, or `codex exec --json` primary transport is used.

## Project Identity And Validation

Identity uses:

- project kind (`git` or non-Git folder)
- git root when available
- normalized remotes
- root commit
- manifest hash
- tree hash

Validation snapshot stores:

- interface schema version
- app minimum version
- last validation timestamp
- branch / HEAD
- manifest hash
- tree hash
- project kind

Portable interface files are intentionally excluded from the identity tree signature so exporting the interface does not invalidate itself.

## Persistence

Local app-data state:

- `settings.json`
- `registry.json`
- `projects/<id>/state.json`

Portable state:

- `.agent-workbench/interface.json`

Portable exports include overview, layout defaults, dependency metadata, summary cache, and agent cards, but exclude machine-local secrets and credentials.

## Windows + WSL Notes

- The UI can accept Windows paths, UNC WSL paths, or Linux paths.
- Windows paths are converted to `/mnt/...` WSL paths for execution.
- Worktrees are created in a configurable WSL-side base directory, not in the repo root.
- `/mnt/...` repositories are supported and can be warned about for performance reasons.

## Testing Strategy

Unit coverage includes:

- path conversion
- identity and validation
- manifest parsing
- repo stats
- summary cache
- interface schema validation
- IPC payload validation
- runtime event reducer behavior

Integration coverage targets:

- startup detection of saved interfaces
- export/import roundtrip
- bootstrap workflow in mock transport
- approval queue handling
- merge-conflict workflow
- saved-thread resume/disconnect behavior
