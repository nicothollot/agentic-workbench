# Portable Interface Format

Portable interfaces are stored at `<target-project>/.agent-workbench/interface.json`.

Top-level fields:

- `schemaVersion`
- `appMinVersion`
- `exportedAt`
- `checksum`
- `identity`
- `validation`
- `layout`
- `localStateDefaults`
- `workflow`
- `overview`
- `stats`
- `dependencies`
- `summaryCache`
- `agents`

Properties:

- versioned and schema-validated
- version 2 is checksummed before write and verified before import
- project-identity-aware
- portable across machines
- intentionally free of auth state and secrets

Portable export retains redacted workflow history, reports, journal events, incident evidence, model metadata, token totals, and command outcomes. It removes live Codex thread/run handles, worktree locations, pending approval payloads, raw event payloads, command output, project-access probes, and machine-local UI selections. Known project/worktree paths and common credential-shaped values are redacted before the checksum is calculated.

Schema versions 1 and 2 are accepted. Version 1 data is hydrated and migrated by the runtime; its historical writer hashed JavaScript `undefined` properties that JSON omitted, so v1 imports require the checksum field but cannot reliably recompute it from disk. Version 2 uses a JSON-canonical checksum and verifies it strictly. Future versions are rejected instead of being silently stripped or rewritten by an older app.

The runtime excludes `.agent-workbench` from repository fingerprinting so exporting the file does not invalidate the project identity by itself.

Generated review logs, visuals, repair reports, transcripts, and workflow histories are not part of the Agentic Workbench source tree. Keep them under the target project's `.agent-workbench/` subdirectories or machine-local app data, and never commit them to the `agentic-workbench` repo root.

## Workflow Diagnostics

Interface schema v2 extends the existing workflow envelope with canonical execution, incidents, journal, and metrics. Version 1 files are accepted and migrated on load; their retained activity, agents, validation records, and workflow decisions are preserved.

- `execution`: the revisioned canonical state for the active cycle, including active step/run, repair attempt, validation kind, resume state, and linked incident.
- `incidents`: deduplicated blockers with root cause, evidence references, automatic actions, next system action, and explicit user action when one is actually required.
- `journal`: an ordered causal record of transitions, agents, validation, repairs, merges, approvals, incidents, and migrations.
- `metrics`: persisted aggregate token counters used by the dashboard, with per-agent structured usage retained alongside it.

Workflow state can include versioned diagnostic objects used by the operator UI and review-log export:

- `CycleContract`: concrete per-cycle objective, targeted checks, expected files/commands/evidence, selection rationale, prior attempts, and failure modes.
- `ChecklistDelta`: reconciliation result for targeted checks, including consumed/unconsumed evidence and why checks remain unknown.
- `ValidationLedger`: summarized command attempts with failure classification, repaired attempts, final validation status, and merge gate reasons.
- `RepoHygieneReport`: repository hygiene scan status, forbidden paths, cleaned generated artifacts, warnings, and merge-blocking findings.
- `RecommendationHealth`: structured recommendation parse/fallback health, including visible fallback warnings.
- `evidenceCommands`: safe project-discovered evidence commands. Project-specific adapters must be offline-safe by default, avoid credentials/network unless explicitly marked, and map evidence to checklist IDs or groups.

Saved-state compatibility is best-effort and versioned. When old state lacks these objects, the app derives what it can from retained plans, recommendations, work packages, checklist data, command records, and history. Missing checklist deltas are represented as "not recorded" rather than inferred progress. Missing hygiene is treated as unknown/not passed. Review-log export writes a derived diagnostics block with task-separation fields (`cycleStartedWithTask`, `completedTask`, `nextRecommendedTask`) and redacted summaries; it must not embed credentials, local paths, or full private command output.
