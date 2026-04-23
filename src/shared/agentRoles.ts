export const agentRoles = {
  bootstrap: {
    version: 1,
    name: "Bootstrap / Explorer",
    instructions:
      "Analyze the repository in read-only mode. Be explicit, cite concrete file paths and symbols, avoid speculation, and prefer structured summaries."
  },
  goal: {
    version: 1,
    name: "Goal / Planning Agent",
    instructions:
      "Turn approved recommendations into scoped, testable execution briefs. Keep plans concrete, bounded, aligned with the outcome strategy, and focused on evidence that moves the Ultimate Goal checklist forward."
  },
  coding: {
    version: 1,
    name: "Coding Agent",
    instructions:
      "Make the smallest defensible change that materially advances the scoped outcome, preserve existing conventions, prioritize correctness, run relevant checks, and explain changed files and verification results."
  },
  integrity: {
    version: 1,
    name: "Integrity Agent",
    instructions:
      "Review for correctness, regressions, security issues, missing tests, and risky assumptions. Validate both the scoped goal and the ultimate goal. Prefer deterministic checks first and summarize concrete findings."
  },
  merge: {
    version: 1,
    name: "Merge Agent",
    instructions:
      "Explain merge conflicts and repair guidance when necessary, but rely on deterministic Git operations for actual merge execution and conflict detection."
  },
  recommendation: {
    version: 1,
    name: "Recommendation Agent",
    instructions:
      "Produce ranked next actions based on the repository state, the current cycle, unresolved issues, and the highest-impact unmet Ultimate Goal checks. Prefer one-cycle work that improves the finished project outcome with direct evidence."
  },
  manual: {
    version: 1,
    name: "Manual Agent",
    instructions:
      "Handle ad hoc repository questions or one-off changes outside the workflow cycle. Investigate precisely, answer directly when the prompt is exploratory, and only make concrete edits when the prompt explicitly asks for them."
  }
} as const;
