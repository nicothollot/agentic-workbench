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
- `overview`
- `stats`
- `dependencies`
- `summaryCache`
- `agents`

Properties:

- versioned and schema-validated
- checksumed before write
- project-identity-aware
- portable across machines
- intentionally free of auth state and secrets

The runtime excludes `.agent-workbench` from repository fingerprinting so exporting the file does not invalidate the project identity by itself.

Generated review logs, visuals, repair reports, transcripts, and workflow histories are not part of the Agentic Workbench source tree. Keep them under the target project's `.agent-workbench/` subdirectories or machine-local app data, and never commit them to the `agentic-workbench` repo root.

## Workflow Diagnostics

Workflow state can include versioned diagnostic objects used by the operator UI and review-log export:

- `CycleContract`: concrete per-cycle objective, targeted checks, expected files/commands/evidence, selection rationale, prior attempts, and failure modes.
- `ChecklistDelta`: reconciliation result for targeted checks, including consumed/unconsumed evidence and why checks remain unknown.
- `ValidationLedger`: summarized command attempts with failure classification, repaired attempts, final validation status, and merge gate reasons.
- `RepoHygieneReport`: repository hygiene scan status, forbidden paths, cleaned generated artifacts, warnings, and merge-blocking findings.
- `RecommendationHealth`: structured recommendation parse/fallback health, including visible fallback warnings.
- `evidenceCommands`: safe project-discovered evidence commands. Project-specific adapters must be offline-safe by default, avoid credentials/network unless explicitly marked, and map evidence to checklist IDs or groups.

Saved-state compatibility is best-effort and versioned. When old state lacks these objects, the app derives what it can from retained plans, recommendations, work packages, checklist data, command records, and history. Missing checklist deltas are represented as "not recorded" rather than inferred progress. Missing hygiene is treated as unknown/not passed. Review-log export writes a derived diagnostics block with task-separation fields (`cycleStartedWithTask`, `completedTask`, `nextRecommendedTask`) and redacted summaries; it must not embed credentials, local paths, or full private command output.
