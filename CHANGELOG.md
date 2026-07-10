# Changelog

## 1.0.0

- Replaced the long, block-heavy workspace with a bounded three-region operator shell and responsive navigation.
- Added CATC Dark, CATC Light, and Space themes, density controls, and reduced-motion support.
- Rebuilt Overview as Mission Control with an interactive execution map, causal timeline, current/next handoff, and evidence drawer.
- Added canonical workflow execution state, structured incidents, a durable journal, workflow analytics, and token metrics.
- Made repair completion explicitly persist and schedule deterministic revalidation before merge continuation.
- Added durable recovery for checkpoint-finalization errors, incident closure on retry/reset, and race-safe approval handling.
- Prevented stale or superseded failures from keeping current status blocked or pausing successful automation.
- Added backward-compatible interface/workflow schema-v2 migration and focused migration, persistence, reducer, dashboard, and repair tests.
- Hardened portable v2 exports with strict checksums, path/secret redaction, and removal of live machine-local execution state.
