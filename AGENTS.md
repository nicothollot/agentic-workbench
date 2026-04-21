# AGENTS

## Build / Test Commands

- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run build`
- `npm run dist:win`
- `npm run generate:app-server`

## Architecture Boundaries

- Do not bypass typed IPC.
- Do not expose Node APIs in the renderer.
- Do not replace `codex app-server` stdio transport with websocket or TUI scraping.
- Keep privileged repository operations in `src/runtime` and/or main process code.
- Keep portable interface data secret-free and machine-agnostic.

## Security Rules

- Preserve `contextIsolation: true`, renderer sandboxing, and `nodeIntegration: false`.
- Validate IPC payloads with schemas before dispatch.
- Keep Codex approvals visible and explicit.
- Treat WSL as execution truth for Git/Codex/worktrees.

## Working Conventions

- Prefer deterministic code for deterministic tasks.
- Use the generated protocol types under `src/generated/app-server` as the source of truth.
- Avoid broad renderer abstractions that smuggle privileged behavior through the preload.
- Add tests for new path, persistence, reducer, and workflow logic.
