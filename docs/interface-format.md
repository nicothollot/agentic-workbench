# Portable Interface Format

Portable interfaces are stored at `.agent-workbench/interface.json`.

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
