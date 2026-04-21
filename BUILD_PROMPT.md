
# Codex Agent Workbench build prompt

Below is a paste-ready prompt for Codex CLI.

---

You are a senior staff engineer, desktop tooling architect, and security-conscious developer-experience builder.

Build a production-quality v1 application in the current repository called **Codex Agent Workbench**.

This app is a **local-first Windows desktop application** that gives me a visual control center for multiple Codex agents working on one repository. The Codex runtime lives in **WSL Ubuntu**. The UI runs on Windows. The app must be designed so I can use it on my laptop and later copy the repo/app to my desktop and get the same per-project interface behavior.

Do the implementation work in this repository now. Do not stop after scaffolding. Continue until the app compiles, the test suite passes, and the core workflows are implemented in code. If a Windows-only packaging step cannot be executed from the current Ubuntu/WSL environment, still implement the feature, add the packaging scripts, verify everything else you can locally, and leave a concise verified Windows packaging checklist in the docs.

Make sensible decisions without asking me questions unless you are truly blocked by a missing secret or missing binary. When you make a choice, document it in `ARCHITECTURE.md`.

## Core product idea

This app is a repository loader and agent dashboard.

Expected user experience:

1. I launch the app.
2. The app asks me to select a folder to work in.
3. The app computes a project identity for that folder.
4. If the app detects an existing saved interface associated with that project, it shows:
   - the message: **"We've detected an interface associated with this project. Would you like to use it?"**
   - a small preview card
   - validation state against the current project version
   - choices like **Use saved interface**, **Create fresh interface**, **Import interface**
5. If no prior interface exists, the app creates a new one.
6. For a new project, a bootstrap analysis agent analyzes the repository and fills the interface with:
   - an interactive repository tree
   - per-file summaries
   - project statistics
   - detected libraries/dependencies
   - a human-readable explanation of what the project is and how it is structured
7. The app includes an agent control section where I can run multiple agents and visually see what each one is doing in real time.
8. The interface is saved locally per project.
9. The interface can also be exported/imported as a portable project interface file that other users of the app can use with the same project.
10. The app can automatically determine whether the saved interface is still valid for the current project version.

## Non-negotiable architecture rules

Follow these rules exactly:

1. **Use Electron + React + TypeScript** for the desktop app.
2. Use a **secure Electron architecture**:
   - `contextIsolation: true`
   - renderer sandboxing enabled
   - no Node integration in the renderer
   - narrow preload bridge only
   - validate every IPC payload
   - load only local packaged assets
3. The renderer must never directly spawn shell commands.
4. Put privileged logic in the Electron main process and/or a dedicated utility-process runtime broker.
5. **Do not screen-scrape Codex CLI. Do not parse the TUI as a protocol. Do not use `codex exec --json` as the primary transport.**
6. Use the official **`codex app-server` over stdio JSON-RPC** as the main Codex integration surface.
7. **Do not use the experimental websocket transport.**
8. Generate and use the app-server TypeScript schema from the installed Codex version:
   - `codex app-server generate-ts --out ...`
   - vendor the generated types/schemas into the repo
   - the code must compile against those generated types
   - do not invent protocol fields or enum values
9. The app must treat the **WSL environment as the execution truth** for Codex, Git, worktrees, and repo analysis in the user’s target setup.
10. Keep the app **local-first**:
    - no remote backend
    - no SaaS database
    - no telemetry
    - no analytics
11. Prefer **pure JS/TS dependencies**. Avoid native Node add-ons unless absolutely necessary.
12. Add a **mock Codex transport** so the UI and tests can run without a live Codex session.

## High-level system design

Implement the app in these layers.

### 1) Renderer
React + TypeScript UI.

Responsibilities:
- startup/project picker flow
- project overview
- repository tree
- file summary panel
- agent dashboard
- activity/event stream
- approvals UI
- merge/integrity/recommendation results
- saved interface preview/import/export UI
- settings UI
- validation status badges

### 2) Preload bridge
Expose a tiny, typed API from main to renderer.
No raw Node APIs in the renderer.

### 3) Main process
Responsibilities:
- application lifecycle
- native folder picker
- secure BrowserWindow creation
- app data paths
- IPC validation
- interface save/load/export/import
- opening external editors if needed
- error handling / logging

### 4) Runtime broker
Create a dedicated runtime broker layer for privileged project operations. This can live in a utility process or equivalent isolated privileged module.

Responsibilities:
- start/stop `codex app-server` inside WSL
- manage JSON-RPC stdio transport
- resolve Windows paths, UNC `\\wsl$\...` paths, and WSL paths
- run deterministic WSL helper commands for:
  - git root detection
  - git metadata
  - worktree management
  - merge attempts
  - conflict detection
  - repo scanning
  - file reads
  - dependency manifest parsing
- never expose arbitrary shell execution to the renderer

### 5) Persistence
Use **file-based local persistence**. Do not require SQLite or a remote DB for v1.

Use two persistence scopes:

#### Local app data
Store machine-local state under the OS app-data directory:
- project registry
- recent projects
- local UI state
- cached summaries
- runtime session metadata
- logs

#### Portable project interface file
Store a portable, shareable file in the repo root:
- suggested path: `.agent-workbench/interface.json`
- optional companion preview metadata file if useful

This file must be:
- versioned
- schema-validated
- portable across machines
- safe to share
- free of secrets, auth caches, tokens, raw credentials, or unsafe logs

## Project identity and validation design

Implement a robust concept of project identity.

### Project identity
For Git repositories, identify a project using a normalized fingerprint derived from:
- git root
- normalized remote URL(s) if present
- repository name
- initial/root commit if available
- selected root-relative path if the user opened a subdirectory
- a stable manifest/tree signature

For non-Git folders, use:
- canonical folder name
- stable relative tree signature
- manifest signature if any

### Validation snapshot
A saved interface should include validation metadata such as:
- interface schema version
- app min version
- last validated timestamp
- last validated Git HEAD commit (if Git)
- branch name
- manifest hash / dependency signature
- tree summary hash
- whether the project was Git or non-Git

### Validation statuses
Implement at least these statuses:
- `exact` = saved interface matches current validated project snapshot
- `stale` = same project identity but code/dependency snapshot changed
- `incompatible` = wrong project or unsupported schema/app version
- `unvalidated` = no snapshot yet

Use these statuses in the startup prompt and on the main screen.

## Startup flow requirements

Implement this exact startup behavior:

1. App opens to a project loader screen with:
   - open folder button
   - recent projects list
   - import interface button

2. After folder selection:
   - normalize the path
   - detect whether it is a Windows path, UNC WSL path, or WSL path
   - derive the WSL path used for Codex/Git operations
   - detect the real project root (Git root if applicable, otherwise selected folder)

3. Search for a saved interface in both places:
   - local app-data project registry
   - portable `.agent-workbench/interface.json` inside the project

4. If one or more interfaces are found:
   - show the message:
     **"We've detected an interface associated with this project. Would you like to use it?"**
   - show a mini preview card for each candidate
   - show validation badge (`exact`, `stale`, etc.)
   - show last used / last validated timestamps
   - let the user choose:
     - Use saved interface
     - Create fresh interface
     - Import interface file
     - Revalidate interface

5. If no interface is found:
   - create a fresh project interface
   - immediately kick off the bootstrap analysis workflow

## Preview card requirements

Do not waste time on screenshot capture for v1.
Implement a **synthetic preview card** rendered from saved interface metadata.

Preview card should show:
- project name
- project summary snippet
- number of agent panels
- whether repo tree/project overview are ready
- last validated commit or version summary
- last opened timestamp
- validation badge

## Repository analysis requirements

For a new interface, automatically run a bootstrap workflow.

### Bootstrap workflow goals
The bootstrap workflow must produce:

1. **Interactive repository tree**
   - folders/files
   - search/filter
   - expand/collapse
   - clicking a file opens a details panel

2. **Per-file summary**
   - when I click a file, I see:
     - what the file is for
     - what it does
     - key exports/classes/functions if relevant
     - related files
     - confidence indicator
   - summaries must be cached by content hash
   - stale summaries must be invalidated when the file changes

3. **Project statistics**
   Include at least:
   - project root path
   - git/non-git
   - creation date fallback logic:
     - earliest Git commit date if available
     - otherwise folder creation time if available
   - last commit date if Git
   - total file count
   - total folder count
   - total size
   - language breakdown
   - detected entry points
   - manifest files found
   - whether tests are present
   - primary package/toolchain managers
   - short human explanation of what the project appears to do

4. **Libraries/dependencies**
   Parse common manifest formats deterministically where possible:
   - `package.json`
   - lockfiles
   - `requirements.txt`
   - `pyproject.toml`
   - `Pipfile`
   - `poetry.lock`
   - `Cargo.toml`
   - `go.mod`
   - `pom.xml`
   - `build.gradle`
   - `Gemfile`
   - `composer.json`
   - others if easy
   Display dependency names and versions when deterministically available.

### Analysis implementation rules
Use a hybrid deterministic + Codex approach:

#### Deterministic local analysis
Use direct WSL helper commands / Node parsing for:
- file tree
- stats
- manifests
- dependency lists
- Git metadata
- language detection by extension
- ignore rules

#### Codex semantic analysis
Use Codex for:
- project overview
- architecture explanation
- important file identification
- semantic file summaries
- recommendations

### Performance and scale rules
Do not naively dump an entire huge repo into one giant prompt.

Implement a staged strategy:
1. deterministic scan first
2. project overview second
3. priority file summaries next
4. background summary queue for remaining files
5. on-demand summary generation for clicked files that are not ready yet

Use ignore defaults:
- `.git`
- `node_modules`
- build output directories
- large binary assets
- generated files when detectable

Also respect `.gitignore` when practical.

## Codex thread and context design

Use the app-server thread model deliberately.

### Bootstrap context
Create a **bootstrap explorer thread** for each project.
This thread should analyze the repository in read-only mode and produce the initial project overview.

### New coding agents
When the user creates a new coding agent, prefer to create it by **forking from the bootstrap explorer thread** so the coding agent inherits repository understanding and context rather than starting from zero.

### Resume on reopen
Persist thread IDs in the project interface state. On reopen:
- resume threads when possible
- gracefully handle missing/expired threads
- if a thread cannot be resumed, keep the agent card but mark it disconnected and allow recreation

## Agent categories and workflow design

Implement these agent categories as first-class built-in templates.

### 1) Bootstrap / Explorer Agent
Purpose:
- repository understanding
- project overview
- file summaries
- important file prioritization

Default behavior:
- read-only
- no code changes
- no merge actions

### 2) Coding Agents
Purpose:
- user-programmable implementation agents
- multiple instances allowed

Requirements:
- user can create many
- each coding agent has:
  - name
  - task prompt
  - model selection
  - worktree/branch assignment if Git
  - status
  - event stream
  - changed files list
  - diff preview
  - approval queue
  - command output
- each coding agent must run in its own isolated worktree when the project is Git-based
- for non-Git projects, allow only one write-enabled coding agent at a time and clearly explain why

### 3) Integrity Agent
Purpose:
- verify the work of coding agents
- check that changes do not break the system
- look for correctness, regressions, security issues, risky patterns, missing tests, and obvious efficiency issues

Behavior:
- deterministic checks first:
  - detect candidate lint/typecheck/test/build commands
  - run them in a safe integration workspace
- Codex reasoning second:
  - run review against uncommitted changes / base branch / commit as appropriate
  - produce a structured integrity report
- this agent should be mostly read-only in spirit; any changes it proposes should be explicit and reviewable

### 4) Merge Agent
Purpose:
- coordinate integration of coding-agent branches
- detect merge conflicts
- retry integration after fixes
- communicate conflicts back to the relevant coding agent(s)

Behavior:
- use deterministic Git operations for merge/rebase/conflict detection
- if conflicts occur:
  - identify conflicting files
  - identify involved agent branches
  - create follow-up tasks for those agents
  - mark agent statuses clearly
- after conflicts are fixed:
  - retry merge
  - trigger integrity checks again
- do not auto-push to remote
- local merge only for v1

### 5) Recommendation Agent
Purpose:
- after meaningful code changes or successful integration, scan the updated repository and propose next steps

Behavior:
- read-only
- structured output:
  - what changed
  - what is likely unfinished
  - recommended next tasks
  - priority/confidence

## Agent orchestration rules

Implement a visible orchestration model.

### Worktree policy
For Git repos:
- each write-enabled coding agent gets its own dedicated Git worktree + branch
- merge agent uses a separate integration worktree
- integrity agent runs checks in the integration worktree or another safe review workspace
- recommendation agent can read the main checkout or integration state

### Worktree storage
Do not clutter the project root with worktree folders.
Use a configurable WSL-side worktree base directory, for example under the user’s Linux home.

### Branch naming
Use predictable names, for example:
- `awb/<project-slug>/<agent-slug>-<short-id>`

### Merge policy
Use a deterministic merge queue:
- selected target branch defaults to the repo’s default branch or current branch
- merge agent attempts merges in a stable order
- on failure, stop and report
- do not hide Git conflicts

### Non-Git fallback
If the project is not under Git:
- disable merge agent
- allow bootstrap/integrity/recommendation
- allow at most one write-enabled coding agent at once
- offer an “Initialize Git” action if easy

## Agent prompts and structured outputs

Implement internal role templates for built-in agents.

Store them in code as versioned role definitions, for example in `src/shared/agentRoles.ts`.

### Explorer role
Must optimize for:
- repository understanding
- accurate summaries
- no speculation
- cite concrete file paths and symbols in internal structured outputs when possible

### Coding role wrapper
Must optimize for:
- correctness over speed
- smallest defensible change
- follow existing conventions
- run relevant checks
- explain changed files and verification results

### Integrity role
Must optimize for:
- correctness
- regressions
- security
- missing tests
- failure modes
- risky assumptions
- merge safety

### Merge role
Use Codex only for conflict explanation and repair guidance.
Use deterministic Git commands for the actual merge/conflict detection workflow.

### Recommendation role
Must output prioritized next actions rather than vague suggestions.

### Structured output requirement
Wherever possible, use app-server `outputSchema` with strict JSON-shaped results for:
- project overview
- file summary
- integrity report
- merge report
- recommendation report

Do not rely on free-form text if structured output is feasible.

## Live observability requirements

The whole point of this app is that I can see what every agent is doing.

Implement a strong observability UX.

### Agent cards
Each agent card must show:
- agent name
- category
- thread id / internal id
- model
- worktree/branch
- status
- current phase if known
- last activity time
- last short summary / latest message snippet
- pending approvals count
- changed files count
- command currently running if any

### Agent detail panel
When I open an agent, show:
- live event stream
- conversation summary
- recent assistant output
- commands run
- command output
- file changes
- diff preview
- approvals
- integrity/merge/recommendation reports if relevant

### Event handling rules
Use app-server item notifications as the source of truth.
Do not build state from guessed text.
Gracefully render at least:
- thread lifecycle
- turn lifecycle
- item started/completed
- agent message deltas
- command execution output
- file change events
- approval requests/resolutions
- review results
- diff / plan updates when useful
- unknown future events in a raw fallback viewer

### Terminal / command panel
Implement a bottom-panel terminal/command area.
If you add a true interactive terminal, back it with app-server command execution/PTY support rather than local unsafe renderer execution.
A simpler read-only command log is acceptable only if an interactive terminal would meaningfully delay the core app.

## Approval and security model

Implement secure defaults.

### Default safety rules
For Git projects:
- default coding-agent mode should be a bounded writable mode inside the agent’s worktree
- default approval behavior should require user review for risky actions
- network access should be off by default unless explicitly needed and enabled

For non-Git projects:
- start even more conservatively

### Approval UI
When the runtime receives a command approval or file-change approval request:
- show which agent requested it
- show reason if available
- show command / cwd / file paths if available
- allow accept / reject / other supported decisions
- record the result in the event history

### Secret handling
Never export or copy:
- `~/.codex/auth.json`
- credential-store secrets
- tokens
- API keys
- environment secrets
- unsafe logs containing secrets

### Portable interface export must exclude
- auth caches
- Codex credentials
- raw secret environment variables
- shell history unrelated to this project
- full bulky logs unless user explicitly opts in

### Safe Electron implementation
Enforce:
- context isolation
- sandboxed renderer
- strict preload API
- CSP for local assets
- validated IPC
- no `eval`
- no remote HTTP content in the app UI
- explicit error boundaries

## WSL and path-handling requirements

This app is for a Windows user whose Codex runtime is in WSL Ubuntu.

Implement robust path support.

### Supported input path types
- `C:\...`
- `\\wsl$\Ubuntu\home\user\project`
- Linux path strings if imported through metadata

### Path rules
1. Normalize and store both:
   - user-visible display path
   - actual WSL execution path
2. If the selected path is on Windows:
   - derive the WSL `/mnt/...` equivalent
3. If the selected path is a UNC WSL path:
   - derive distro name and Linux path
4. Keep path conversion logic in one tested module
5. Do not scatter string hacks around the codebase

### WSL settings
Create a settings panel for:
- distro name
- codex binary path (default `codex`)
- optional `CODEX_HOME`
- optional worktree base directory
- optional preferred editor/open command
- whether to warn when the repo lives on `/mnt/...`

## Deterministic helper operations

Build deterministic helper modules for operations that should not rely on model reasoning:

- project root detection
- git detection
- git metadata
- worktree create/list/remove
- merge attempt
- merge conflict parsing
- dependency manifest parsing
- repository stats
- file content hashing
- summary cache invalidation
- import/export validation
- path conversion

These helpers should be thoroughly unit-tested.

## UI layout requirements

Design a practical IDE-style layout.

### Suggested layout
- top bar:
  - project name
  - validation badge
  - current branch / target branch
  - quick actions
  - rate-limit indicator if available
- left panel:
  - repository tree
  - search
  - project overview shortcuts
- center panel:
  - overview tab / file details tab / diff tab / reports tab
- right panel:
  - agent board
  - create agent button
  - agent filters
- bottom panel:
  - activity stream
  - approvals
  - terminal / command output

Make the layout state saveable per project.

## Saved interface format

Implement a strongly typed, versioned portable interface file.

Suggested top-level contents:
- schema version
- app min version
- project identity
- validation snapshot
- layout config
- panel preferences
- agent preset config
- cached overview metadata
- optional summary cache metadata references
- exported at timestamp

Do not store machine-specific absolute paths in the portable file unless they are clearly optional and non-authoritative.
Prefer project-relative identifiers.

## Import/export behavior

### Export
Implement “Export interface”:
- writes a portable file
- validates schema before writing
- strips secrets and machine-local runtime fields
- includes a checksum/hash if useful
- defaults to repo-local `.agent-workbench/interface.json`

### Import
Implement “Import interface”:
- validate schema version
- compare project identity
- show warning on mismatch
- allow import if the user confirms a mismatch
- preserve local machine-specific settings separately

## Recommended models and defaults

Implement per-agent model selection.

Reasonable defaults:
- bootstrap/explorer: fast model
- recommendation: fast model
- coding: stronger model
- integrity: stronger model
- merge explanation: stronger model

Also detect available models from app-server and gracefully fall back if a preferred model is unavailable.

## Mock mode and developer experience

Create a mock transport and fixture system.

### Mock mode goals
- app can be run without live Codex access
- tests can simulate:
  - project bootstrap
  - live streaming messages
  - approvals
  - file changes
  - merge conflicts
  - integrity results
  - recommendation results

### Dev ergonomics
Add npm scripts for at least:
- `dev`
- `build`
- `typecheck`
- `lint`
- `test`
- `test:watch`
- `dist:win` or equivalent
- optional `mock` mode if useful

## Testing requirements

I care a lot about avoiding bugs.
Build real tests.

### Unit tests
Add tests for:
- path conversion
- project identity calculation
- validation status calculation
- manifest parsing
- repo statistics
- file summary cache invalidation
- portable interface schema validation
- IPC payload validation
- event reducer / state machine logic

### Integration tests
Add tests for:
- startup detection of saved interfaces
- import/export roundtrip
- bootstrap workflow against mock transport
- approval queue handling
- merge-conflict workflow
- resume/reconnect logic

### Build verification
Run and pass:
- typecheck
- lint
- tests
- production build

If a test cannot run in this environment, document exactly why and still leave the test in place.

## Reliability and UX edge cases

Handle these carefully:

1. Codex app-server process dies unexpectedly
   - show disconnected state
   - allow reconnect
   - do not corrupt saved interface state

2. Project path moves
   - use fingerprinting so the project can still be recognized

3. Portable interface file exists but schema is old
   - show incompatible status
   - offer migration if easy, otherwise re-create

4. Repo is huge
   - do not freeze UI
   - stream progress
   - background queue summaries

5. File summary is clicked before it exists
   - show loading state
   - generate on demand

6. Merge conflict loop repeats
   - show explicit conflict cycle count
   - allow manual intervention

7. Non-Git project
   - clearly degrade features instead of failing silently

8. WSL repo under `/mnt/c/...`
   - support it
   - warn that it may be slower

9. User lacks `codex` or `git` or `bubblewrap`
   - detect
   - show actionable diagnostics

## Required files and docs

Create at least:
- `README.md`
- `ARCHITECTURE.md`
- `SECURITY.md`
- `AGENTS.md`
- any needed schema/docs for portable interface format
- clear setup instructions for Windows + WSL Ubuntu

### README must include
- what the app does
- prerequisites
- how to configure WSL distro
- how to run in dev mode
- how to build
- how saved interfaces work
- how portable interface export/import works
- limitations/non-goals

### SECURITY.md must include
- Electron hardening choices
- secret handling policy
- approval model
- WSL execution boundary
- export/import safety rules

### AGENTS.md for this repo
Create an `AGENTS.md` for this project so future Codex runs know:
- build/test commands
- security rules
- architecture boundaries
- “do not bypass typed IPC”
- “do not put Node APIs in renderer”
- “do not replace app-server stdio with websocket”

## Suggested repository structure

Use a clean structure similar to this, adapted as needed:

- `src/main/`
- `src/preload/`
- `src/renderer/`
- `src/runtime/`
- `src/shared/`
- `src/tests/`
- `docs/` if helpful
- generated app-server schema/types under a clearly named generated directory

## Implementation strategy

Execute in roughly this order:

1. scaffold Electron + React + TypeScript app
2. set up secure BrowserWindow + preload bridge
3. create typed runtime broker abstraction
4. add mock transport
5. implement WSL path resolver + tested helper utilities
6. implement project registry + portable interface schema
7. implement startup/project loader and saved interface detection UI
8. implement deterministic repo scan + project overview UI
9. wire real app-server transport over stdio
10. implement bootstrap explorer workflow
11. implement repository tree + file summary panel
12. implement agent board + coding agents
13. implement worktree manager for Git repos
14. implement merge agent + integrity agent + recommendation agent
15. implement approvals UI
16. implement save/load/export/import
17. implement tests
18. run typecheck/lint/test/build
19. polish docs

## Coding standards

- TypeScript strict mode
- no `any` unless fully justified
- exhaustive switches on protocol methods/statuses where reasonable
- small focused modules
- comments only where they add value
- avoid giant god classes
- do not hide errors
- prefer explicit state machines / reducers for runtime event handling

## Important implementation nuances

1. Use the generated app-server types as the protocol source of truth.
2. Treat streamed `item/*` notifications as authoritative runtime state.
3. Handle overloaded/retryable transport errors gracefully.
4. Use Codex for semantic tasks, deterministic code for deterministic tasks.
5. Keep dangerous capabilities behind approvals.
6. Design for resumability: project reopen should feel stateful.
7. Do not tie portable interface validity to absolute local paths.
8. Keep the UI responsive during bootstrap analysis.

## Final acceptance criteria

I will consider this done only if all of the following are true:

1. I can launch the app and choose a folder.
2. The app detects prior interfaces associated with the project.
3. The app shows the saved-interface message and preview card.
4. For a fresh project, the app automatically performs bootstrap analysis.
5. I can browse the repository tree and click files to see summaries.
6. I can see project stats and dependency/library lists.
7. I can create multiple coding agents.
8. I can see what each agent is doing in real time.
9. In a Git repo, each write-enabled coding agent uses its own worktree/branch.
10. Merge and integrity workflows exist and are visible.
11. The app saves and reloads interface state per project.
12. I can export and import a portable interface file.
13. The app validates saved interface state against the current project version.
14. The renderer remains locked down and secure.
15. The project typechecks, lints, tests, and builds.

## Final response format

When you finish, respond with:

1. `What I built`
2. `Architecture summary`
3. `Key files`
4. `How to run`
5. `Verification performed`
6. `Known limitations`
7. `Next recommended improvements`

Do not stop at a plan. Build the app.

---
