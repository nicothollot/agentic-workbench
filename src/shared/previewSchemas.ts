import { z } from "zod";

export const previewAdapterSchema = z.enum(["vite", "next", "cra", "astro", "static", "custom"]);
export const previewCheckpointKindSchema = z.enum(["explicit", "pre_merge"]);
export const previewGateVerdictSchema = z.enum(["pass", "needs_review", "fail", "not_applicable"]);

export const previewRecipeSchema = z.object({
  id: z.string().min(1),
  adapter: previewAdapterSchema,
  source: z.enum(["explicit", "detected"]),
  command: z.string().min(1),
  args: z.array(z.string()).max(64),
  cwd: z.string().min(1),
  urlPath: z.string().startsWith("/").default("/"),
  fingerprint: z.string().min(1),
  manifestPath: z.string().min(1).optional()
});

export const projectTrustRecordSchema = z.object({
  projectId: z.string().min(1),
  projectFingerprint: z.string().min(1),
  recipeFingerprint: z.string().min(1),
  grantedAt: z.string().datetime({ offset: true }),
  lastUsedAt: z.string().datetime({ offset: true })
});

export const previewViewportSchema = z.object({
  id: z.enum(["desktop", "tablet", "mobile", "custom"]),
  width: z.number().int().min(240).max(7680),
  height: z.number().int().min(240).max(4320),
  // Worker screenshots are normalized to CSS pixels so evidence remains
  // comparable across Windows display scale factors.
  deviceScaleFactor: z.literal(1).optional()
});

export const previewArtifactMetadataSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["screenshot", "accessibility", "console", "network", "trace"]),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  createdAt: z.string().datetime({ offset: true }),
  viewport: previewViewportSchema.optional(),
  label: z.string().min(1)
});

export const previewConsoleEntrySchema = z.object({
  id: z.string().min(1),
  level: z.enum(["log", "info", "warning", "error"]),
  text: z.string(),
  timestamp: z.string().datetime({ offset: true })
});

export const previewNetworkEntrySchema = z.object({
  id: z.string().min(1),
  url: z.string(),
  method: z.string().min(1),
  status: z.number().int().optional(),
  outcome: z.enum(["ok", "failed", "blocked"]),
  detail: z.string().optional(),
  timestamp: z.string().datetime({ offset: true })
});

export const previewElementReferenceSchema = z.object({
  ref: z.string().min(1),
  role: z.string().optional(),
  name: z.string().optional(),
  tag: z.string().min(1),
  inputType: z.string().optional()
});

export const previewSnapshotSchema = z.object({
  url: z.string(),
  title: z.string(),
  ariaSnapshot: z.string(),
  elements: z.array(previewElementReferenceSchema).max(2_000),
  capturedAt: z.string().datetime({ offset: true })
});

export const previewActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), url: z.string().min(1).max(2_000) }),
  z.object({ type: z.literal("click"), ref: z.string().min(1) }),
  z.object({ type: z.literal("fill"), ref: z.string().min(1), value: z.string().max(20_000) }),
  z.object({ type: z.literal("select"), ref: z.string().min(1), values: z.array(z.string().max(1_000)).max(100) }),
  z.object({ type: z.literal("press"), key: z.string().min(1).max(80), ref: z.string().min(1).optional() }),
  z.object({ type: z.literal("scroll"), deltaX: z.number().min(-100_000).max(100_000).optional(), deltaY: z.number().min(-100_000).max(100_000) }),
  z.object({ type: z.literal("wait"), milliseconds: z.number().int().min(0).max(30_000) }),
  z.object({ type: z.literal("screenshot"), viewport: previewViewportSchema.optional(), label: z.string().min(1).max(120).optional() }),
  z.object({ type: z.literal("snapshot") })
]);

export const previewSessionProjectionSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  projectFingerprint: z.string().min(1),
  sourceRevision: z.string().min(1),
  checkpointKind: previewCheckpointKindSchema,
  status: z.enum(["trust_required", "starting", "running", "capturing", "ready", "failed", "stopped"]),
  recipe: previewRecipeSchema,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  readyAt: z.string().datetime({ offset: true }).optional(),
  stoppedAt: z.string().datetime({ offset: true }).optional(),
  validatedUrl: z.string().url().optional(),
  message: z.string(),
  artifacts: z.array(previewArtifactMetadataSchema).max(200),
  console: z.array(previewConsoleEntrySchema).max(500),
  network: z.array(previewNetworkEntrySchema).max(1_000),
  latestSnapshot: previewSnapshotSchema.optional(),
  blockedOrigins: z.array(z.string()).max(100),
  error: z.string().optional()
});

export const previewReadinessSchema = z.object({
  projectId: z.string().min(1),
  status: z.enum(["ready", "recipe_required", "browser_required", "unavailable"]),
  message: z.string(),
  recipe: previewRecipeSchema.optional(),
  browserInstallCommand: z.string().optional(),
  checkedAt: z.string().datetime({ offset: true })
});

export const previewGateReportSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  cycleNumber: z.number().int().nonnegative(),
  checkpointKind: previewCheckpointKindSchema,
  sourceRevision: z.string().min(1),
  recipeFingerprint: z.string().min(1),
  verdict: previewGateVerdictSchema,
  deterministicResults: z.array(z.string()).max(200),
  agentSummary: z.string().optional(),
  artifactIds: z.array(z.string()).max(200),
  blockingFindings: z.array(z.string()).max(200),
  createdAt: z.string().datetime({ offset: true }),
  reviewedAt: z.string().datetime({ offset: true }).optional(),
  approvedAt: z.string().datetime({ offset: true }).optional()
});

export const previewStateProjectionSchema = z.object({
  readiness: previewReadinessSchema.optional(),
  activeSession: previewSessionProjectionSchema.optional(),
  latestReport: previewGateReportSchema.optional()
});
