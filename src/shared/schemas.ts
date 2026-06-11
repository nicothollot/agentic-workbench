import { z } from "zod";
import { APP_VERSION, PORTABLE_INTERFACE_VERSION, PROJECT_FINGERPRINT_VERSION, REVIEW_LOG_BUNDLE_VERSION } from "./constants";
import { defaultProjectWorkflowState } from "./defaults";

const isoDatetime = () => z.string().datetime({ offset: true });

export const validationStatusSchema = z.enum(["exact", "stale", "incompatible", "unvalidated"]);
export const projectPathKindSchema = z.enum(["windows", "wsl-unc", "linux"]);
export const projectKindSchema = z.enum(["git", "folder"]);
export const summarySourceSchema = z.enum(["deterministic", "codex", "hybrid", "mock"]);
export const agentCategorySchema = z.enum(["bootstrap", "goal", "coding", "integrity", "merge", "recommendation", "manual"]);
export const interfaceReasoningEffortSchema = z.enum(["low", "medium", "high", "xhigh"]);
export const executionModeSchema = z.enum(["local", "wsl"]);
export const gitHubLinkStateSchema = z.enum(["linked", "not_linked", "needs_ssh", "cli_missing", "error"]);
export const ultimateGoalSourceSchema = z.enum(["user", "detected"]);
export const recommendationRiskLevelSchema = z.enum(["low", "medium", "high"]);
export const ultimateGoalProgressSourceSchema = z.enum(["recommendation", "deterministic"]);
export const workflowObjectiveSchema = z.enum(["deliver", "optimize"]);
export const workflowModeSchema = z.enum(["normal", "fast"]);
export const workflowPreviewStatusSchema = z.enum(["none", "queued", "active", "ready", "completed", "cancelled"]);
export const autopilotProfileSchema = z.enum(["balanced", "conservative", "aggressive", "custom"]);
export const autopilotIntegrityFailurePolicySchema = z.enum(["repair", "pause", "policy"]);
export const autopilotPresetIdSchema = z.enum([
  "exact_builder",
  "goal_focused",
  "balanced_autopilot",
  "creative_builder",
  "experimental_moonshot"
]);
export const planningHorizonSchema = z.enum(["short", "medium", "long"]);
export const taskBatchingAggressivenessSchema = z.enum(["low", "medium", "high", "very_high"]);
export const riskToleranceSchema = z.enum(["low", "medium", "high"]);
export const refactorAppetiteSchema = z.enum(["low", "medium", "high", "very_high"]);
export const validationStrictnessSchema = z.enum(["low", "medium", "high", "very_high"]);
export const approvalSensitivitySchema = z.enum(["strict", "normal", "relaxed", "autonomous"]);
export const checklistChangeActionSchema = z.enum([
  "add",
  "remove",
  "split",
  "merge",
  "reprioritize",
  "mark_obsolete",
  "mark_blocked",
  "mark_complete",
  "link_evidence",
  "link_changed_files",
  "link_validation_commands",
  "link_cycle_ids",
  "link_agent_ids"
]);
export const plannerApprovalStatusSchema = z.enum(["not_required", "pending", "accepted", "rejected"]);
export const candidateTaskKindSchema = z.enum([
  "goal_check",
  "work_package",
  "blocker",
  "validation",
  "stabilization",
  "visual_polish",
  "goal_evolution",
  "custom",
  "fallback"
]);
export const strategicAutopilotModeSchema = z.enum([
  "manual",
  "guided",
  "autopilot_safe",
  "autopilot_balanced",
  "autopilot_creative",
  "autopilot_aggressive"
]);
export const visualThemePreferenceSchema = z.enum(["light", "dark", "system", "custom"]);
export const visualDensityPreferenceSchema = z.enum(["compact", "balanced", "spacious"]);
export const visualFeelPreferenceSchema = z.enum(["professional", "modern", "playful", "minimal", "premium", "technical", "futuristic", "cozy"]);
export const visualLayoutPrioritySchema = z.enum(["dashboard", "document_editor", "command_center", "kanban", "terminal_like", "data_heavy", "visual_first"]);
export const motionPreferenceSchema = z.enum(["none", "subtle", "polished"]);
export const accessibilityPrioritySchema = z.enum(["normal", "high_contrast", "keyboard_first", "screen_reader_conscious"]);
export const designStrictnessSchema = z.enum(["follow_user_exactly", "allow_model_improvement"]);
export const visualPrioritySchema = z.enum(["low", "medium", "high", "very_high"]);
export const ultimateGoalCompletionStateSchema = z.enum(["needs_more_work", "goal_satisfied"]);
export const goalCheckStatusSchema = z.enum(["unknown", "unmet", "met", "not_applicable"]);
export const goalCheckItemKindSchema = z.enum(["required", "backlog", "observation"]);
export const goalCheckAuditFlagSchema = z.enum([
  "vague",
  "not_observable",
  "too_broad",
  "duplicate",
  "not_tied_to_goal",
  "task_not_requirement",
  "polish_not_required",
  "impossible_to_validate"
]);
export const goalCheckSourceSchema = z.enum(["success_criterion", "quality_bar", "constraint", "agent", "deterministic"]);
export const workflowAppealStatusSchema = z.enum(["not_started", "not_applicable", "pending", "running", "completed"]);
export const workflowRepairStatusSchema = z.enum(["idle", "repairing", "retrying_validation", "fixed", "exhausted", "merge_conflicts"]);
export const workflowEventStatusSchema = z.enum(["info", "running", "waiting", "completed", "failed"]);
export const workflowActivitySourceSchema = z.enum(["workflow", "agent", "validation", "approval", "system"]);
export const workflowStageSchema = z.enum([
  "charter_needed",
  "recommendation_pending",
  "recommendation_approved",
  "goal_ready",
  "coding_running",
  "integrity_running",
  "repair_loop",
  "ready_to_merge",
  "merged",
  "appeal_pending",
  "blocked_human",
  "cycle_complete"
]);
export const workflowStopReasonSchema = z.enum([
  "none",
  "charter_missing",
  "recommendation_missing",
  "awaiting_recommendation_approval",
  "goal_not_scoped",
  "human_intervention_required",
  "integrity_failed",
  "repair_stopped_early",
  "repair_budget_exhausted",
  "merge_conflicts",
  "appeal_missing",
  "awaiting_appeal_approval",
  "ultimate_goal_satisfied",
  "cycle_completed"
]);
export const workflowStepIdSchema = z.enum(["ultimate_goal", "recommendation", "goal_plan", "coding", "integrity", "merge"]);
export const workflowStepStatusSchema = z.enum(["not_started", "waiting", "recovering", "starting", "running", "blocked", "completed", "failed"]);
export const workflowCycleStatusSchema = z.enum([
  "idle",
  "recommendation_approved",
  "goal_ready",
  "coding",
  "integrity",
  "repair_loop",
  "ready_to_merge",
  "merged",
  "completed",
  "blocked_human"
]);
export const humanInterventionKindSchema = z.enum([
  "account_creation",
  "credentials",
  "email_verification",
  "api_access",
  "captcha_or_sso",
  "billing_or_legal",
  "product_question",
  "external_setup",
  "other"
]);
export const humanInterventionSeveritySchema = z.enum(["low", "medium", "high", "critical"]);
export const humanInterventionStatusSchema = z.enum(["pending", "resolved", "dismissed"]);
export const agentLifecycleStatusSchema = z.enum([
  "idle",
  "starting",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "conflicted",
  "disconnected"
]);
export const approvalDecisionSchema = z.enum(["accept", "acceptForSession", "decline", "cancel"]);
export const credentialEntryStatusSchema = z.enum(["active", "needs_attention", "disabled"]);
export const credentialRequestStatusSchema = z.enum(["pending", "fulfilled", "dismissed"]);
export const agentReasoningModeSchema = z.enum(["auto", "manual"]);
export const agentReasoningEffortsSchema = z.object({
  bootstrap: interfaceReasoningEffortSchema.optional(),
  goal: interfaceReasoningEffortSchema.optional(),
  coding: interfaceReasoningEffortSchema.optional(),
  integrity: interfaceReasoningEffortSchema.optional(),
  merge: interfaceReasoningEffortSchema.optional(),
  recommendation: interfaceReasoningEffortSchema.optional(),
  manual: interfaceReasoningEffortSchema.optional()
});

export const linkedGitHubAccountSchema = z.object({
  username: z.string().min(1),
  linkedAt: isoDatetime()
});

export const gitHubStatusSchema = z.object({
  state: gitHubLinkStateSchema,
  username: z.string().min(1).optional(),
  sshReady: z.boolean().default(false),
  message: z.string().min(1),
  checkedAt: isoDatetime().optional()
});

export const appSettingsSchema = z.object({
  executionMode: executionModeSchema,
  distroName: z.string().min(1),
  codexBinaryPath: z.string().min(1),
  codexHome: z.string().optional(),
  worktreeBaseDir: z.string().min(1),
  preferredEditorCommand: z.string().optional(),
  warnOnMntMount: z.boolean(),
  mockMode: z.boolean(),
  maxRepairCycles: z.number().int().min(1).max(10).default(3),
  interfaceCreationModel: z.string().min(1).optional(),
  interfaceCreationReasoningEffort: interfaceReasoningEffortSchema.optional(),
  interfaceCreationConfiguredAt: isoDatetime().optional(),
  agentReasoningMode: agentReasoningModeSchema.default("auto"),
  agentReasoningEfforts: agentReasoningEffortsSchema.default({}),
  githubAccount: linkedGitHubAccountSchema.optional(),
  autoApproveCommands: z.boolean().default(false),
  autoApproveGitCommits: z.boolean().default(false),
  autoApproveGitPushes: z.boolean().default(false),
  considerPaidServices: z.boolean().default(false)
});

export const reviewLogRuntimeContextSchema = z.object({
  executionMode: executionModeSchema,
  distroName: z.string().min(1),
  mockMode: z.boolean(),
  maxRepairCycles: z.number().int().min(1).max(10),
  interfaceCreationModel: z.string().min(1).optional(),
  interfaceCreationReasoningEffort: interfaceReasoningEffortSchema.optional(),
  agentReasoningMode: agentReasoningModeSchema.optional(),
  agentReasoningEfforts: agentReasoningEffortsSchema.optional(),
  autoApproveCommands: z.boolean(),
  autoApproveGitCommits: z.boolean(),
  autoApproveGitPushes: z.boolean(),
  considerPaidServices: z.boolean().default(false)
});

export const projectIdentitySchema = z.object({
  version: z.number().default(PROJECT_FINGERPRINT_VERSION),
  fingerprint: z.string().min(1),
  projectName: z.string().min(1),
  kind: projectKindSchema,
  repositoryName: z.string().optional(),
  gitRoot: z.string().optional(),
  selectedSubpath: z.string().optional(),
  normalizedRemotes: z.array(z.string()),
  rootCommit: z.string().optional(),
  manifestSignature: z.string().min(1),
  treeSignature: z.string().min(1)
});

export const validationSnapshotSchema = z.object({
  interfaceSchemaVersion: z.number().default(PORTABLE_INTERFACE_VERSION),
  appMinVersion: z.string().default(APP_VERSION),
  lastValidatedAt: isoDatetime().optional(),
  gitHead: z.string().optional(),
  branch: z.string().optional(),
  manifestHash: z.string().optional(),
  treeHash: z.string().optional(),
  projectAccess: z.object({
    status: z.enum(["passed", "failed"]),
    checkedAt: isoDatetime(),
    probeFileName: z.string().min(1),
    executionPath: z.string().min(1),
    hostPath: z.string().min(1),
    message: z.string().min(1),
    error: z.string().optional()
  }).optional(),
  projectKind: projectKindSchema
});

export const dependencyRecordSchema = z.object({
  manifest: z.string().min(1),
  ecosystem: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  dev: z.boolean().optional()
});

export const projectStatsSchema = z.object({
  projectRoot: z.string().min(1),
  kind: projectKindSchema,
  scanStartedAt: isoDatetime().optional(),
  scanCompletedAt: isoDatetime().optional(),
  scanMode: z.enum(["normal", "deep"]).optional(),
  createdAt: isoDatetime().optional(),
  lastCommitAt: isoDatetime().optional(),
  totalFiles: z.number().int().nonnegative(),
  totalFolders: z.number().int().nonnegative(),
  totalSizeBytes: z.number().nonnegative(),
  includedFiles: z.number().int().nonnegative().default(0),
  includedFolders: z.number().int().nonnegative().default(0),
  includedSizeBytes: z.number().nonnegative().default(0),
  excludedFiles: z.number().int().nonnegative().default(0),
  excludedFolders: z.number().int().nonnegative().default(0),
  excludedSizeBytes: z.number().nonnegative().default(0),
  excludedPaths: z.array(
    z.object({
      path: z.string().min(1),
      kind: z.enum(["file", "directory"]),
      rule: z.enum(["default", "gitignore"]),
      fileCount: z.number().int().nonnegative(),
      totalSizeBytes: z.number().nonnegative()
    })
  ).default([]),
  fileTypeBreakdown: z.record(z.number().int().nonnegative()).default({}),
  languageBreakdown: z.record(z.number().nonnegative()).default({}),
  entryPoints: z.array(z.string()),
  manifestFiles: z.array(z.string()),
  testsPresent: z.boolean(),
  primaryManagers: z.array(z.string()),
  explanation: z.string(),
  truncated: z.boolean().optional(),
  truncationReason: z.string().optional(),
  truncationReasons: z.array(z.enum([
    "included_file_limit",
    "included_directory_limit",
    "depth_limit",
    "scan_duration_limit",
    "manifest_file_size",
    "excluded_path_record_limit"
  ])).optional(),
  includedFileLimit: z.number().int().positive().optional(),
  includedDirectoryLimit: z.number().int().positive().optional(),
  maxDepth: z.number().int().positive().optional(),
  maxScanDurationMs: z.number().int().positive().optional(),
  maxManifestFileSizeBytes: z.number().int().positive().optional(),
  excludedPathLimit: z.number().int().positive().optional(),
  excludedPathRecordsTruncated: z.boolean().optional(),
  omittedFilesEstimate: z.number().int().nonnegative().optional(),
  omittedDirectoriesEstimate: z.number().int().nonnegative().optional(),
  skippedManifestFiles: z.number().int().nonnegative().optional(),
  scanDurationMs: z.number().nonnegative().optional()
});

export const repositoryScanSettingsSchema = z.object({
  maxIncludedFiles: z.number().int().min(1).max(250_000).optional(),
  maxIncludedDirectories: z.number().int().min(1).max(100_000).optional(),
  maxDepth: z.number().int().min(1).max(128).optional(),
  maxManifestFileSizeBytes: z.number().int().min(1).max(20_000_000).optional(),
  maxScanDurationMs: z.number().int().min(1).max(120_000).optional(),
  maxExcludedPathRecords: z.number().int().min(1).max(10_000).optional()
});

export const repoTreeNodeSchema: z.ZodType<{
  path: string;
  name: string;
  type: "file" | "directory";
  size?: number;
  language?: string;
  children?: unknown[];
}> = z.lazy(() =>
  z.object({
    path: z.string().min(1),
    name: z.string().min(1),
    type: z.enum(["file", "directory"]),
    size: z.number().nonnegative().optional(),
    language: z.string().optional(),
    children: z.array(repoTreeNodeSchema).optional()
  })
);

export const fileSummarySchema = z.object({
  relativePath: z.string().min(1),
  pathKind: z.enum(["file", "directory"]).default("file"),
  contentHash: z.string().min(1),
  title: z.string().min(1),
  purpose: z.string().min(1),
  summary: z.string().min(1),
  keySymbols: z.array(z.string()),
  relatedFiles: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  source: summarySourceSchema,
  generatedAt: isoDatetime()
});

export const projectSubsystemSummarySchema = z.object({
  name: z.string().min(1),
  summary: z.string().min(1),
  paths: z.array(z.string()).default([])
});

export const projectOverviewSchema = z.object({
  summary: z.string().min(1),
  architecture: z.string().min(1),
  whatProjectDoes: z.string().optional(),
  howItIsOrganized: z.string().optional(),
  importantToKnowFirst: z.string().optional(),
  importantFiles: z.array(z.string()).default([]),
  subsystemSummaries: z.array(projectSubsystemSummarySchema).default([]),
  dependencyHighlights: z.array(z.string()).default([]),
  statisticsSummary: z.string().optional(),
  recommendations: z.array(z.string()).default([]),
  source: summarySourceSchema,
  generatedAt: isoDatetime()
});

export const layoutConfigSchema = z.object({
  leftPanelWidth: z.number().int().positive(),
  rightPanelWidth: z.number().int().positive(),
  bottomPanelHeight: z.number().int().positive(),
  activeCenterTab: z.enum(["overview", "workflow", "history", "runs", "logs", "repository", "credentials", "settings", "agents", "file", "diff", "reports"])
});

export const localProjectStateSchema = z.object({
  selectedFile: z.string().optional(),
  treeFilter: z.string().default(""),
  activeAgentId: z.string().optional(),
  autopilotEnabled: z.boolean().default(false),
  workflowObjective: workflowObjectiveSchema.default("deliver"),
  workflowPauseRequested: z.boolean().default(false),
  lastOpenedAt: isoDatetime().optional()
});

export const ultimateGoalSchema = z.object({
  summary: z.string().default(""),
  detailedIntent: z.string().default(""),
  successCriteria: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  nonGoals: z.array(z.string()).default([]),
  targetAudience: z.string().default(""),
  qualityBar: z.string().default(""),
  source: ultimateGoalSourceSchema.default("user"),
  confirmedAt: isoDatetime().optional(),
  lastUpdatedAt: isoDatetime().optional()
});

export const visualPreferenceProfileSchema = z.object({
  theme: visualThemePreferenceSchema.default(defaultProjectWorkflowState().goalCharter.autopilotStrategy.visualPreferences.theme),
  primaryColor: z.string().min(1).max(40).default(defaultProjectWorkflowState().goalCharter.autopilotStrategy.visualPreferences.primaryColor),
  accentColor: z.string().min(1).max(40).default(defaultProjectWorkflowState().goalCharter.autopilotStrategy.visualPreferences.accentColor),
  density: visualDensityPreferenceSchema.default(defaultProjectWorkflowState().goalCharter.autopilotStrategy.visualPreferences.density),
  feel: visualFeelPreferenceSchema.default(defaultProjectWorkflowState().goalCharter.autopilotStrategy.visualPreferences.feel),
  layoutPriority: visualLayoutPrioritySchema.default(defaultProjectWorkflowState().goalCharter.autopilotStrategy.visualPreferences.layoutPriority),
  motionPreference: motionPreferenceSchema.default(defaultProjectWorkflowState().goalCharter.autopilotStrategy.visualPreferences.motionPreference),
  accessibilityPriority: accessibilityPrioritySchema.default(defaultProjectWorkflowState().goalCharter.autopilotStrategy.visualPreferences.accessibilityPriority),
  designStrictness: designStrictnessSchema.default(defaultProjectWorkflowState().goalCharter.autopilotStrategy.visualPreferences.designStrictness)
});

export const autonomyBudgetSchema = z.object({
  maxCyclesBeforePause: z.number().int().min(1).max(24).default(defaultProjectWorkflowState().goalCharter.autopilotStrategy.autonomyBudget.maxCyclesBeforePause),
  maxMinutesBeforePause: z.number().int().min(1).max(480).default(defaultProjectWorkflowState().goalCharter.autopilotStrategy.autonomyBudget.maxMinutesBeforePause),
  maxFailedRepairAttempts: z.number().int().min(0).max(10).default(defaultProjectWorkflowState().goalCharter.autopilotStrategy.autonomyBudget.maxFailedRepairAttempts),
  maxConsecutiveTasksWithoutUserReview: z.number().int().min(1).max(24).default(defaultProjectWorkflowState().goalCharter.autopilotStrategy.autonomyBudget.maxConsecutiveTasksWithoutUserReview),
  stopWhenGoalComplete: z.boolean().default(true),
  stopWhenNoSafeNextTaskExists: z.boolean().default(true),
  stopWhenPlannerWantsToChangeUltimateGoal: z.boolean().default(true),
  stopWhenValidationFailsRepeatedly: z.boolean().default(true)
});

export const autopilotStrategySchema = z.object({
  presetId: z.union([autopilotPresetIdSchema, z.literal("custom")]).default(defaultProjectWorkflowState().goalCharter.autopilotStrategy.presetId),
  goalRestrictiveness: z.number().int().min(0).max(100).default(defaultProjectWorkflowState().goalCharter.autopilotStrategy.goalRestrictiveness),
  planningHorizon: planningHorizonSchema.default(defaultProjectWorkflowState().goalCharter.autopilotStrategy.planningHorizon),
  taskBatchingAggressiveness: taskBatchingAggressivenessSchema.default(defaultProjectWorkflowState().goalCharter.autopilotStrategy.taskBatchingAggressiveness),
  innovationLatitude: z.number().int().min(0).max(100).default(defaultProjectWorkflowState().goalCharter.autopilotStrategy.innovationLatitude),
  riskTolerance: riskToleranceSchema.default(defaultProjectWorkflowState().goalCharter.autopilotStrategy.riskTolerance),
  refactorAppetite: refactorAppetiteSchema.default(defaultProjectWorkflowState().goalCharter.autopilotStrategy.refactorAppetite),
  visualPriority: visualPrioritySchema.default(defaultProjectWorkflowState().goalCharter.autopilotStrategy.visualPriority),
  visualPreferences: visualPreferenceProfileSchema.default(defaultProjectWorkflowState().goalCharter.autopilotStrategy.visualPreferences),
  validationStrictness: validationStrictnessSchema.default(defaultProjectWorkflowState().goalCharter.autopilotStrategy.validationStrictness),
  autonomyBudget: autonomyBudgetSchema.default(defaultProjectWorkflowState().goalCharter.autopilotStrategy.autonomyBudget),
  approvalSensitivity: approvalSensitivitySchema.default(defaultProjectWorkflowState().goalCharter.autopilotStrategy.approvalSensitivity)
});

export const goalChangeRecordSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().default(""),
  rationale: z.string().default(""),
  source: z.enum(["user", "detected", "planner"]),
  proposedGoal: ultimateGoalSchema.optional(),
  fromGoalSummary: z.string().optional(),
  toGoalSummary: z.string().optional(),
  createdAt: isoDatetime(),
  decidedAt: isoDatetime().optional(),
  decisionNotes: z.string().optional()
});

export const goalChangeProposalSchema = goalChangeRecordSchema.extend({
  approvalStatus: plannerApprovalStatusSchema.default("pending"),
  requiredByStrategy: z.boolean().default(true),
  risk: recommendationRiskLevelSchema.default("medium"),
  affectedGoalArea: z.string().default("")
});

export const goalCharterSchema = z.object({
  originalUltimateGoal: ultimateGoalSchema.default(defaultProjectWorkflowState().goalCharter.originalUltimateGoal),
  currentEffectiveGoal: ultimateGoalSchema.default(defaultProjectWorkflowState().goalCharter.currentEffectiveGoal),
  nonNegotiableRequirements: z.array(z.string()).default([]),
  flexibleRequirements: z.array(z.string()).default([]),
  niceToHaveIdeas: z.array(z.string()).default([]),
  explicitNonGoals: z.array(z.string()).default([]),
  userConstraints: z.array(z.string()).default([]),
  aestheticPreferences: z.array(z.string()).default([]),
  technicalPreferences: z.array(z.string()).default([]),
  definitionOfDone: z.array(z.string()).default([]),
  autopilotStrategy: autopilotStrategySchema.default(defaultProjectWorkflowState().goalCharter.autopilotStrategy),
  acceptedGoalChanges: z.array(goalChangeRecordSchema).default([]),
  rejectedGoalChanges: z.array(goalChangeRecordSchema).default([]),
  proposedGoalChanges: z.array(goalChangeRecordSchema).default([]),
  createdAt: isoDatetime().default(defaultProjectWorkflowState().goalCharter.createdAt),
  updatedAt: isoDatetime().default(defaultProjectWorkflowState().goalCharter.updatedAt)
});

export const workflowRecommendationOptionSchema = z.object({
  id: z.string().min(1),
  rank: z.number().int().positive(),
  title: z.string().min(1),
  summary: z.string().default(""),
  rationale: z.string().default(""),
  expectedImpact: z.string().default(""),
  priority: z.enum(["high", "medium", "low"]),
  confidence: z.number().min(0).max(1),
  estimatedScope: z.enum(["small", "medium", "large"]).default("medium"),
  riskLevel: recommendationRiskLevelSchema.default("medium"),
  relatedPaths: z.array(z.string()).default([]),
  sourceWorkPackageId: z.string().min(1).optional(),
  targetedCheckIds: z.array(z.string().min(1)).optional()
});

export const autopilotPolicySchema = z.object({
  enabled: z.boolean().default(false),
  profile: autopilotProfileSchema.default("balanced"),
  maxAutomaticActionsPerPass: z.number().int().min(1).max(12).default(5),
  maxConsecutiveCycles: z.number().int().min(1).max(12).optional(),
  pauseOnPreviewReady: z.boolean().default(true),
  pauseOnHumanBlocker: z.boolean().default(true),
  pauseOnApprovalRequired: z.boolean().default(true),
  pauseOnIntegrityFailure: autopilotIntegrityFailurePolicySchema.default("repair"),
  pauseOnMergeConflict: z.boolean().default(true),
  allowDeterministicScoping: z.boolean().default(true),
  allowAgentRecommendationWhenDeterministicPackageExists: z.boolean().default(true),
  allowBacklogPromotion: z.boolean().default(false),
  maxNewRequiredChecksPerCycle: z.number().int().min(0).max(5).default(2),
  preferGroupedChecklistPackages: z.boolean().default(true),
  maxChecksPerWorkPackageNormal: z.number().int().min(1).max(8).default(4),
  maxChecksPerWorkPackageFast: z.number().int().min(1).max(12).default(8),
  allowFastModeBatching: z.boolean().default(true),
  requireExplicitApprovalForHighRiskPackages: z.boolean().default(true),
  highRiskAreas: z.array(z.string().min(1)).default(defaultProjectWorkflowState().autopilotPolicy.highRiskAreas),
  stopWhenGoalSatisfied: z.boolean().default(true),
  stopWhenNoSafeRecommendation: z.boolean().default(true)
});

export const approvedRecommendationSchema = z.object({
  id: z.string().min(1),
  recommendationId: z.string().min(1),
  rank: z.number().int().positive(),
  title: z.string().min(1),
  summary: z.string().default(""),
  rationale: z.string().default(""),
  expectedImpact: z.string().default(""),
  priority: z.enum(["high", "medium", "low"]),
  confidence: z.number().min(0).max(1),
  estimatedScope: z.enum(["small", "medium", "large"]).default("medium"),
  riskLevel: recommendationRiskLevelSchema.default("medium"),
  relatedPaths: z.array(z.string()).default([]),
  sourceWorkPackageId: z.string().min(1).optional(),
  targetedCheckIds: z.array(z.string().min(1)).optional(),
  approvedAt: isoDatetime()
});

export const scopedGoalSchema = z.object({
  id: z.string().min(1),
  sourceRecommendationId: z.string().min(1),
  sourceWorkPackageId: z.string().min(1).optional(),
  summary: z.string().min(1),
  executionBrief: z.string().min(1),
  acceptanceCriteria: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  testStrategy: z.array(z.string()).default([]),
  targetedCheckIds: z.array(z.string().min(1)).optional(),
  likelyPaths: z.array(z.string().min(1)).optional(),
  createdAt: isoDatetime()
});

export const goalAttainmentCheckSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(""),
  required: z.boolean().default(true),
  itemKind: goalCheckItemKindSchema.default("required"),
  canonicalKey: z.string().min(1).optional(),
  groupId: z.string().min(1).optional(),
  mergedInto: z.string().min(1).optional(),
  sourceCheckIds: z.array(z.string()).default([]).optional(),
  relatedCheckIds: z.array(z.string()).default([]).optional(),
  auditFlags: z.array(goalCheckAuditFlagSchema).default([]).optional(),
  needsRefinement: z.boolean().optional(),
  classificationReason: z.string().optional(),
  promotionReason: z.string().optional(),
  introducedCycleNumber: z.number().int().positive().optional(),
  status: goalCheckStatusSchema.default("unknown"),
  confidence: z.number().min(0).max(1).optional(),
  evidence: z.string().default(""),
  evidenceHistory: z.array(z.object({
    checkId: z.string().min(1),
    title: z.string().default(""),
    source: goalCheckSourceSchema,
    status: goalCheckStatusSchema,
    evidence: z.string().default(""),
    ownerAgentId: z.string().min(1).optional(),
    createdAt: isoDatetime().optional(),
    updatedAt: isoDatetime().optional()
  })).default([]).optional(),
  source: goalCheckSourceSchema.default("agent"),
  relatedPaths: z.array(z.string()).default([]),
  ownerAgentId: z.string().min(1).optional(),
  createdAt: isoDatetime(),
  updatedAt: isoDatetime()
});

export const workPackageSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().default(""),
  checkIds: z.array(z.string()).default([]),
  primaryTopic: z.string().default("related goal checks"),
  likelyPaths: z.array(z.string()).default([]),
  estimatedBreadth: z.enum(["small", "medium", "large"]).default("medium"),
  estimatedImpact: z.enum(["low", "medium", "high"]).default("medium"),
  confidence: z.number().min(0).max(1).default(0.7),
  riskLevel: recommendationRiskLevelSchema.default("medium"),
  reason: z.string().default(""),
  acceptanceHints: z.array(z.string()).default([]),
  score: z.number().default(0)
});

export const checklistChangeSchema = z.object({
  id: z.string().min(1),
  action: checklistChangeActionSchema,
  checklistItemIds: z.array(z.string()).default([]),
  title: z.string().optional(),
  rationale: z.string().default(""),
  sourceCycle: z.number().int().positive(),
  sourceAgent: z.string().min(1).optional(),
  userApprovalStatus: plannerApprovalStatusSchema.default("not_required"),
  confidence: z.number().min(0).max(1).default(0.7),
  risk: recommendationRiskLevelSchema.default("medium"),
  affectedGoalArea: z.string().default(""),
  linkedEvidence: z.array(z.string()).default([]),
  linkedChangedFiles: z.array(z.string()).default([]),
  linkedValidationCommands: z.array(z.string()).default([]),
  linkedCycleIds: z.array(z.number().int().positive()).default([]),
  linkedAgentIds: z.array(z.string()).default([]),
  createdAt: isoDatetime()
});

export const candidateTaskSchema = z.object({
  id: z.string().min(1),
  kind: candidateTaskKindSchema,
  title: z.string().min(1),
  summary: z.string().default(""),
  recommendationId: z.string().min(1).optional(),
  sourceWorkPackageId: z.string().min(1).optional(),
  targetedCheckIds: z.array(z.string()).default([]),
  expectedChecklistImpact: z.string().default(""),
  expectedFiles: z.array(z.string()).default([]),
  expectedValidationCommands: z.array(z.string()).default([]),
  riskLevel: recommendationRiskLevelSchema.default("medium"),
  whyNext: z.string().default(""),
  approvalRequired: z.boolean().default(false),
  goalChangeProposalIds: z.array(z.string()).default([]),
  checklistChangeIds: z.array(z.string()).default([]),
  visualDesignImpact: z.boolean().default(false),
  shouldSplit: z.boolean().default(false),
  score: z.number().default(0),
  scoreBreakdown: z.record(z.number()).default({}),
  confidence: z.number().min(0).max(1).default(0.7)
});

export const strategicPlanSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  cycleNumber: z.number().int().positive(),
  createdAt: isoDatetime(),
  originalGoalSummary: z.string().default(""),
  currentEffectiveGoalSummary: z.string().default(""),
  mode: strategicAutopilotModeSchema.default("manual"),
  strategySnapshot: autopilotStrategySchema.default(defaultProjectWorkflowState().goalCharter.autopilotStrategy),
  strategyHighlights: z.array(z.string()).default([]),
  repoScanStatus: z.string().default("unknown"),
  previousCycleOutcomes: z.array(z.string()).default([]),
  failedCommands: z.array(z.string()).default([]),
  changedFiles: z.array(z.string()).default([]),
  openBlockers: z.array(z.string()).default([]),
  userFeedback: z.array(z.string()).default([]),
  recentAgentOutputs: z.array(z.string()).default([]),
  architectureNotes: z.array(z.string()).default([]),
  candidateTasks: z.array(candidateTaskSchema).default([]),
  candidateWorkPackages: z.array(workPackageSchema).default([]),
  proposedGoalChanges: z.array(goalChangeProposalSchema).default([]),
  proposedChecklistChanges: z.array(checklistChangeSchema).default([]),
  recommendedTaskId: z.string().min(1).optional(),
  requiresApproval: z.boolean().default(false),
  plannerSummary: z.string().default(""),
  continueRecommendation: z.enum(["continue", "pause", "ask_user"]).default("continue"),
  pauseReason: z.string().optional()
});

export const plannerDecisionSchema = z.object({
  id: z.string().min(1),
  planId: z.string().min(1),
  cycleNumber: z.number().int().positive(),
  selectedTaskId: z.string().min(1).optional(),
  selectedRecommendationId: z.string().min(1).optional(),
  selectedTaskTitle: z.string().optional(),
  whySelected: z.string().default(""),
  score: z.number().default(0),
  scoreBreakdown: z.record(z.number()).default({}),
  strategySettingsUsed: z.array(z.string()).default([]),
  targetedChecklistIds: z.array(z.string()).default([]),
  expectedFiles: z.array(z.string()).default([]),
  expectedValidationCommands: z.array(z.string()).default([]),
  approvalRequired: z.boolean().default(false),
  goalChangeProposalIds: z.array(z.string()).default([]),
  checklistChangeIds: z.array(z.string()).default([]),
  visualDesignImpact: z.boolean().default(false),
  createdAt: isoDatetime()
});

export const cycleRetrospectiveSchema = z.object({
  id: z.string().min(1),
  cycleNumber: z.number().int().positive(),
  createdAt: isoDatetime(),
  triedToDo: z.string().default(""),
  whyChosen: z.string().default(""),
  changedFiles: z.array(z.string()).default([]),
  commandsRun: z.array(z.string()).default([]),
  passed: z.array(z.string()).default([]),
  failed: z.array(z.string()).default([]),
  learned: z.array(z.string()).default([]),
  checklistItemsAdvanced: z.array(z.string()).default([]),
  goalChecklistChangeRecommendation: z.string().default(""),
  nextRecommendedTasks: z.array(z.string()).default([]),
  shouldContinue: z.boolean().default(false),
  pauseReason: z.string().optional()
});

export const workflowTaskMapGroupSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  rationale: z.string().default(""),
  checkIds: z.array(z.string()).default([]),
  representativeChecks: z.array(z.string()).default([]),
  relatedPaths: z.array(z.string()).default([]),
  openCheckCount: z.number().int().nonnegative().default(0),
  metCheckCount: z.number().int().nonnegative().default(0),
  status: z.enum(["open", "in_progress", "complete"]).default("open"),
  priority: z.number().default(0)
});

export const workflowTaskMapSchema = z.object({
  groups: z.array(workflowTaskMapGroupSchema).default([]),
  totalRequiredChecks: z.number().int().nonnegative().default(0),
  openRequiredChecks: z.number().int().nonnegative().default(0),
  updatedAt: isoDatetime().default(defaultProjectWorkflowState().taskMap.updatedAt)
});

export const workflowCycleSchema = z.object({
  cycleNumber: z.number().int().positive().default(1),
  approvedRecommendationId: z.string().optional(),
  approvedRecommendationTitle: z.string().optional(),
  scopedGoalSummary: z.string().optional(),
  acceptanceCriteria: z.array(z.string()).default([]),
  status: workflowCycleStatusSchema.default("idle"),
  startedAt: isoDatetime().optional(),
  completedAt: isoDatetime().optional()
});

export const workflowPreviewRequestSchema = z.object({
  status: workflowPreviewStatusSchema.default("none"),
  requestedAt: isoDatetime().optional(),
  startedAt: isoDatetime().optional(),
  completedAt: isoDatetime().optional(),
  remainingCycles: z.number().int().min(0).max(3).default(1),
  modeBeforePreview: workflowModeSchema.optional(),
  autopilotWasEnabled: z.boolean().optional(),
  reason: z.string().optional(),
  evidence: z.array(z.string()).default([]).optional()
});

export const workflowBudgetsSchema = z.object({
  maxRepairLoops: z.number().int().nonnegative().default(3),
  maxRecommendationOptions: z.number().int().positive().default(5),
  maxCycleSummaries: z.number().int().positive().default(12),
  maxAcceptedDecisions: z.number().int().positive().default(24),
  maxOpenIssues: z.number().int().positive().default(24),
  maxAgentRestartsPerCategory: z.number().int().positive().default(3),
  maxCodingIterationsPerCycle: z.number().int().positive().default(4),
  maxIntegrityRunsPerCycle: z.number().int().positive().default(3)
});

export const humanInterventionRecordSchema = z.object({
  id: z.string().min(1),
  kind: humanInterventionKindSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  reason: z.string().min(1),
  requestedByAgentCategory: agentCategorySchema,
  severity: humanInterventionSeveritySchema.default("medium"),
  blocking: z.boolean().default(true),
  status: humanInterventionStatusSchema.default("pending"),
  linkedUserInputRequestId: z.string().min(1).optional(),
  resolutionNotes: z.string().optional(),
  createdAt: isoDatetime(),
  resolvedAt: isoDatetime().optional()
});

export const userInputRequestOptionSchema = z.object({
  label: z.string().min(1),
  description: z.string().default("")
});

export const userInputRequestQuestionSchema = z.object({
  id: z.string().min(1),
  header: z.string().min(1),
  question: z.string().min(1),
  isOther: z.boolean().default(false),
  isSecret: z.boolean().default(false),
  options: z.array(userInputRequestOptionSchema).default([])
});

export const userInputRequestAttachmentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  relativePath: z.string().min(1),
  sizeBytes: z.number().nonnegative().default(0),
  addedAt: isoDatetime()
});

export const userInputRequestSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  requestedByAgentCategory: agentCategorySchema,
  threadId: z.string().min(1),
  turnId: z.string().min(1).optional(),
  itemId: z.string().min(1).optional(),
  serverRequestId: z.union([z.string(), z.number()]),
  humanInterventionId: z.string().min(1).optional(),
  title: z.string().min(1),
  description: z.string().min(1),
  questions: z.array(userInputRequestQuestionSchema).default([]),
  attachmentInboxPath: z.string().min(1),
  attachmentInboxRelativePath: z.string().min(1),
  attachments: z.array(userInputRequestAttachmentSchema).default([]),
  status: z.enum(["pending", "submitted"]).default("pending"),
  createdAt: isoDatetime(),
  submittedAt: isoDatetime().optional()
});

export const credentialRequestRecordSchema = z.object({
  id: z.string().min(1),
  providerName: z.string().min(1),
  keyLabel: z.string().min(1),
  description: z.string().min(1),
  status: credentialRequestStatusSchema.default("pending"),
  requestedByAgentCategory: agentCategorySchema.optional(),
  agentId: z.string().min(1).optional(),
  userInputRequestId: z.string().min(1).optional(),
  humanInterventionId: z.string().min(1).optional(),
  freeOnly: z.boolean().default(true),
  createdAt: isoDatetime(),
  resolvedAt: isoDatetime().optional(),
  submittedToAgentAt: isoDatetime().optional(),
  notes: z.string().optional()
});

export const credentialEntryMetadataSchema = z.object({
  id: z.string().min(1),
  providerName: z.string().min(1),
  keyLabel: z.string().min(1),
  hasApiKey: z.boolean().default(false),
  hasSecretKey: z.boolean().default(false),
  status: credentialEntryStatusSchema.default("active"),
  source: z.enum(["user", "agent_auto"]).default("user"),
  freeTier: z.boolean().optional(),
  notes: z.string().optional(),
  linkedRequestIds: z.array(z.string().min(1)).default([]),
  createdAt: isoDatetime(),
  updatedAt: isoDatetime()
});

export const projectCredentialsStateSchema = z.object({
  entries: z.array(credentialEntryMetadataSchema).default([]),
  requests: z.array(credentialRequestRecordSchema).default([])
});

export const workflowCycleSummarySchema = z.object({
  cycleNumber: z.number().int().positive(),
  summary: z.string().min(1),
  openIssueIds: z.array(z.string()).default([]),
  createdAt: isoDatetime()
});

export const workflowAcceptedDecisionSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["ultimate_goal", "recommendation", "scoped_goal", "human_intervention", "merge"]),
  title: z.string().min(1),
  summary: z.string().default(""),
  decidedAt: isoDatetime(),
  cycleNumber: z.number().int().positive().optional(),
  sourceAgentCategory: agentCategorySchema.optional()
});

export const workflowOpenIssueSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  detail: z.string().default(""),
  source: z.enum(["recommendation", "goal", "coding", "integrity", "merge", "human", "system"]),
  status: z.enum(["open", "resolved"]).default("open"),
  recordedAt: isoDatetime(),
  resolvedAt: isoDatetime().optional()
});

export const agentFreshnessMarkerSchema = z.object({
  restartCount: z.number().int().nonnegative().default(0),
  freshnessToken: z.number().int().nonnegative().default(0),
  lastRestartedAt: isoDatetime().optional(),
  lastSummarizedAt: isoDatetime().optional()
});

export const workflowContextDescriptorSchema = z.object({
  id: z.string().min(1),
  cycleNumber: z.number().int().positive(),
  agentCategory: agentCategorySchema,
  workflowStage: workflowStageSchema,
  goalTokens: z.array(z.string()).default([]),
  workTypeTags: z.array(z.string()).default([]),
  changedPaths: z.array(z.string()).default([]),
  relatedPaths: z.array(z.string()).default([]),
  acceptedDecisionIds: z.array(z.string()).default([]),
  openIssueIds: z.array(z.string()).default([]),
  resolvedIssueIds: z.array(z.string()).default([]),
  summary: z.string().default(""),
  featureWeights: z.record(z.number()).default({}),
  createdAt: isoDatetime(),
  updatedAt: isoDatetime()
});

export const workflowRelevantContextSelectionSchema = z.object({
  descriptorId: z.string().min(1),
  cycleNumber: z.number().int().positive(),
  agentCategory: agentCategorySchema,
  score: z.number().nonnegative(),
  reasons: z.array(z.string()).default([]),
  summary: z.string().default(""),
  paths: z.array(z.string()).default([]),
  decisionIds: z.array(z.string()).default([]),
  issueIds: z.array(z.string()).default([])
});

export const workflowMemorySchema = z.object({
  canonicalSummary: z.string().default(""),
  canonicalFacts: z.array(z.string()).default([]),
  perCycleSummaries: z.array(workflowCycleSummarySchema).default([]),
  lastAcceptedDecisions: z.array(workflowAcceptedDecisionSchema).default([]),
  knownOpenIssues: z.array(workflowOpenIssueSchema).default([]),
  agentFreshness: z.record(agentCategorySchema, agentFreshnessMarkerSchema).default(defaultProjectWorkflowState().memory.agentFreshness),
  contextDescriptors: z.array(workflowContextDescriptorSchema).default([]),
  lastRelevantContext: z.array(workflowRelevantContextSelectionSchema).default([])
});

export const workflowStepProgressSchema = z.object({
  stepId: workflowStepIdSchema,
  status: workflowStepStatusSchema.default("not_started"),
  requiresUserInput: z.boolean().default(false),
  startedAt: isoDatetime().optional(),
  updatedAt: isoDatetime().optional(),
  completedAt: isoDatetime().optional(),
  lastEventAt: isoDatetime().optional(),
  currentActivity: z.string().optional(),
  currentSubstep: z.string().optional(),
  latestProgressNote: z.string().optional(),
  blockedReason: z.string().optional(),
  message: z.string().optional(),
  warning: z.string().optional(),
  runCount: z.number().int().nonnegative().default(0),
  attemptCount: z.number().int().nonnegative().default(0),
  agentCategory: agentCategorySchema.optional()
});

export const ultimateGoalProgressEstimateSchema = z.object({
  percentComplete: z.number().int().min(0).max(100),
  rationale: z.string().min(1),
  source: ultimateGoalProgressSourceSchema,
  updatedAt: isoDatetime()
});

export const ultimateGoalCompletionAssessmentSchema = z.object({
  state: ultimateGoalCompletionStateSchema,
  rationale: z.string().min(1),
  source: ultimateGoalProgressSourceSchema,
  updatedAt: isoDatetime()
});

export const workflowStepProgressStateSchema = z.object({
  ultimate_goal: workflowStepProgressSchema.default(defaultProjectWorkflowState().stepProgress.ultimate_goal),
  recommendation: workflowStepProgressSchema.default(defaultProjectWorkflowState().stepProgress.recommendation),
  goal_plan: workflowStepProgressSchema.default(defaultProjectWorkflowState().stepProgress.goal_plan),
  coding: workflowStepProgressSchema.default(defaultProjectWorkflowState().stepProgress.coding),
  integrity: workflowStepProgressSchema.default(defaultProjectWorkflowState().stepProgress.integrity),
  merge: workflowStepProgressSchema.default(defaultProjectWorkflowState().stepProgress.merge)
});

export const workflowActivityEventSchema = z.object({
  id: z.string().min(1),
  timestamp: isoDatetime(),
  source: workflowActivitySourceSchema,
  status: workflowEventStatusSchema,
  title: z.string().min(1),
  detail: z.string().optional(),
  stepId: workflowStepIdSchema.optional(),
  agentId: z.string().min(1).optional(),
  agentCategory: agentCategorySchema.optional()
});

export const autopilotRuntimeStatusSchema = z.object({
  enabled: z.boolean(),
  profile: autopilotProfileSchema,
  workflowMode: workflowModeSchema,
  stage: workflowStageSchema,
  cycleNumber: z.number().int().positive(),
  currentRecommendationId: z.string().min(1).optional(),
  currentRecommendationTitle: z.string().min(1).optional(),
  lastCompletedAction: z.string().min(1).optional(),
  nextPlannedAction: z.string().min(1).optional(),
  pausedReason: z.enum([
    "disabled",
    "manual_pause_requested",
    "preview_ready",
    "human_blocker",
    "approval_required",
    "integrity_failure",
    "repair_budget_exhausted",
    "merge_conflict",
    "ultimate_goal_satisfied",
    "no_safe_recommendation",
  "project_access_validation_failed",
  "repeated_failure",
  "goal_change_requires_approval",
  "high_risk_package_requires_approval",
    "unsafe_scope_broadening",
    "required_check_promotion_cap",
    "max_consecutive_cycles",
    "automation_no_progress"
  ]).optional(),
  pausedDetail: z.string().optional(),
  highRiskPackageRequiresApproval: z.boolean().default(false),
  updatedAt: isoDatetime()
});

export const workflowManualHandoffSchema = z.object({
  reason: z.enum(["repair_exhausted", "repair_stopped_early", "merge_conflicts"]),
  title: z.string().min(1),
  whatSystemWasTryingToDo: z.string().min(1),
  validationIssue: z.string().min(1),
  latestFailureReason: z.string().min(1),
  involvedPaths: z.array(z.string()).default([]),
  shellSupported: z.boolean().default(false),
  createdAt: isoDatetime(),
  lastOpenedAt: isoDatetime().optional(),
  lastOpenError: z.string().optional()
});

export const workflowRepairStateSchema = z.object({
  attemptCount: z.number().int().nonnegative().default(0),
  maxAttempts: z.number().int().min(1).default(defaultProjectWorkflowState().repair.maxAttempts),
  status: workflowRepairStatusSchema.default(defaultProjectWorkflowState().repair.status),
  latestIssueSummary: z.string().optional(),
  latestFailureReason: z.string().optional(),
  lastUpdatedAt: isoDatetime().optional()
});

export const workflowAppealStateSchema = z.object({
  status: workflowAppealStatusSchema.default(defaultProjectWorkflowState().appeal.status),
  reason: z.string().optional(),
  startedAt: isoDatetime().optional(),
  completedAt: isoDatetime().optional(),
  cycleNumber: z.number().int().positive().optional()
});

export const projectWorkflowStateSchema = z.object({
  ultimateGoal: ultimateGoalSchema.default(defaultProjectWorkflowState().ultimateGoal),
  ultimateGoalDraft: ultimateGoalSchema.optional(),
  goalCharter: goalCharterSchema.default(defaultProjectWorkflowState().goalCharter),
  workflowMode: workflowModeSchema.default(defaultProjectWorkflowState().workflowMode),
  previewRequest: workflowPreviewRequestSchema.default({ status: "none", remainingCycles: 1 }),
  autopilotPolicy: autopilotPolicySchema.default(defaultProjectWorkflowState().autopilotPolicy),
  autopilotStatus: autopilotRuntimeStatusSchema.optional(),
  ultimateGoalProgress: ultimateGoalProgressEstimateSchema.optional(),
  ultimateGoalCompletion: ultimateGoalCompletionAssessmentSchema.optional(),
  goalChecklist: z.array(goalAttainmentCheckSchema).default([]),
  taskMap: workflowTaskMapSchema.default(defaultProjectWorkflowState().taskMap),
  workPackages: z.array(workPackageSchema).default([]),
  strategicPlans: z.array(strategicPlanSchema).default([]),
  plannerDecisions: z.array(plannerDecisionSchema).default([]),
  checklistChanges: z.array(checklistChangeSchema).default([]),
  cycleRetrospectives: z.array(cycleRetrospectiveSchema).default([]),
  workflowCycle: workflowCycleSchema.default(defaultProjectWorkflowState().workflowCycle),
  approvedRecommendation: approvedRecommendationSchema.optional(),
  scopedGoal: scopedGoalSchema.optional(),
  workflowStage: workflowStageSchema.default(defaultProjectWorkflowState().workflowStage),
  repairLoopCount: z.number().int().nonnegative().default(0),
  appeal: workflowAppealStateSchema.default(defaultProjectWorkflowState().appeal),
  repair: workflowRepairStateSchema.default(defaultProjectWorkflowState().repair),
  workflowBudgets: workflowBudgetsSchema.default(defaultProjectWorkflowState().workflowBudgets),
  workflowStopReason: workflowStopReasonSchema.default(defaultProjectWorkflowState().workflowStopReason),
  manualHandoff: workflowManualHandoffSchema.optional(),
  humanInterventions: z.array(humanInterventionRecordSchema).default([]),
  recommendations: z.array(workflowRecommendationOptionSchema).default([]),
  recommendationsGeneratedAt: isoDatetime().optional(),
  stepProgress: workflowStepProgressStateSchema.default(defaultProjectWorkflowState().stepProgress),
  memory: workflowMemorySchema.default(defaultProjectWorkflowState().memory),
  activityLog: z.array(workflowActivityEventSchema).default([])
});

export const interfaceCreationStateSchema = z.object({
  status: z.enum(["idle", "queued", "running", "completed", "failed"]),
  phase: z.string().min(1),
  message: z.string().min(1),
  model: z.string().optional(),
  reasoningEffort: interfaceReasoningEffortSchema.optional(),
  selectedModelSource: z.enum(["user", "recommended"]),
  deterministicScanReady: z.boolean(),
  agentAnalysisReady: z.boolean(),
  outputSource: summarySourceSchema,
  startedAt: isoDatetime().optional(),
  completedAt: isoDatetime().optional(),
  lastError: z.string().optional()
});

export const worktreeAssignmentSchema = z.object({
  baseDir: z.string().min(1),
  worktreePath: z.string().min(1),
  branch: z.string().min(1),
  targetBranch: z.string().optional()
});

export const approvalRequestSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  kind: z.enum(["command", "file-change", "permissions", "apply-patch"]),
  threadId: z.string().optional(),
  turnId: z.string().optional(),
  itemId: z.string().optional(),
  serverRequestId: z.union([z.string(), z.number()]).optional(),
  summary: z.string().min(1),
  reason: z.string().optional(),
  command: z.string().optional(),
  cwd: z.string().optional(),
  filePaths: z.array(z.string()),
  createdAt: isoDatetime(),
  status: z.enum(["pending", "approved", "rejected", "cancelled"]),
  availableDecisions: z.array(approvalDecisionSchema)
});

export const runtimeEventSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  timestamp: isoDatetime(),
  type: z.enum(["thread", "turn", "item", "message", "command", "file-change", "approval", "report", "raw"]),
  status: workflowEventStatusSchema.optional(),
  stepId: workflowStepIdSchema.optional(),
  agentCategory: agentCategorySchema.optional(),
  itemId: z.string().min(1).optional(),
  title: z.string().min(1),
  detail: z.string().optional(),
  raw: z.unknown().optional()
});

export const integrityReportSchema = z.object({
  summary: z.string().min(1),
  checks: z.array(
    z.object({
      name: z.string().min(1),
      command: z.string().min(1),
      status: z.enum(["passed", "failed", "skipped"]),
      outputSnippet: z.string()
    })
  ),
  risks: z.array(z.string()),
  generatedAt: isoDatetime()
});

export const mergeReportSchema = z.object({
  summary: z.string().min(1),
  targetBranch: z.string().optional(),
  mergedBranches: z.array(z.string()),
  conflicts: z.array(z.string()),
  conflictCycleCount: z.number().int().nonnegative(),
  generatedAt: isoDatetime()
});

export const recommendationReportSchema = z.object({
  summary: z.string().min(1),
  ultimateGoalProgress: z.object({
    percentComplete: z.number().int().min(0).max(100),
    rationale: z.string().min(1)
  }).optional(),
  nextSteps: z.array(
    z.object({
      rank: z.number().int().positive(),
      title: z.string().min(1),
      summary: z.string().default(""),
      rationale: z.string().default(""),
      expectedImpact: z.string().default(""),
      priority: z.enum(["high", "medium", "low"]),
      confidence: z.number().min(0).max(1),
      estimatedScope: z.enum(["small", "medium", "large"]).default("medium"),
      riskLevel: recommendationRiskLevelSchema.default("medium"),
      relatedPaths: z.array(z.string()).default([])
    })
  ),
  generatedAt: isoDatetime()
});

export const agentStateSchema = z.object({
  id: z.string().min(1),
  category: agentCategorySchema,
  name: z.string().min(1),
  taskPrompt: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: interfaceReasoningEffortSchema.optional(),
  reasoningEffortSource: agentReasoningModeSchema.optional(),
  workflowCycleNumber: z.number().int().positive().optional(),
  createdAt: isoDatetime(),
  startedAt: isoDatetime().optional(),
  completedAt: isoDatetime().optional(),
  threadId: z.string().optional(),
  status: agentLifecycleStatusSchema,
  currentPhase: z.string().optional(),
  currentSubtask: z.string().optional(),
  lastActivityAt: isoDatetime().optional(),
  lastMessageSnippet: z.string().optional(),
  worktree: worktreeAssignmentSchema.optional(),
  changedFiles: z.array(z.string()),
  approvals: z.array(approvalRequestSchema),
  commandLog: z.array(
    z.object({
      itemId: z.string().min(1).optional(),
      command: z.string().min(1),
      cwd: z.string().optional(),
      output: z.string(),
      status: z.string().min(1),
      startedAt: isoDatetime(),
      completedAt: isoDatetime().optional(),
      exitCode: z.number().int().nullable().optional()
    })
  ),
  events: z.array(runtimeEventSchema),
  disconnectedReason: z.string().optional(),
  recoveryHandledAt: isoDatetime().optional(),
  integrityReport: integrityReportSchema.optional(),
  mergeReport: mergeReportSchema.optional(),
  recommendationReport: recommendationReportSchema.optional(),
  appliedStructuredOutputs: z.array(
    z.object({
      kind: z.enum(["recommendation", "scoped_goal"]),
      contentHash: z.string().min(1),
      appliedAt: isoDatetime(),
      source: z.string().optional()
    })
  ).default([]),
  outputReference: z.object({
    agentId: z.string().min(1),
    workflowCycleNumber: z.number().int().positive().optional(),
    transcriptAvailable: z.boolean(),
    fullOutputAvailable: z.boolean(),
    updatedAt: isoDatetime()
  }).optional()
});

export const portableInterfaceSchema = z.object({
  schemaVersion: z.number().default(PORTABLE_INTERFACE_VERSION),
  appMinVersion: z.string().default(APP_VERSION),
  exportedAt: isoDatetime(),
  checksum: z.string().min(1),
  identity: projectIdentitySchema,
  validation: validationSnapshotSchema,
  layout: layoutConfigSchema,
  localStateDefaults: localProjectStateSchema,
  workflow: z.preprocess((value) => value ?? defaultProjectWorkflowState(), projectWorkflowStateSchema),
  overview: projectOverviewSchema.optional(),
  stats: projectStatsSchema.optional(),
  dependencies: z.array(dependencyRecordSchema),
  summaryCache: z.array(fileSummarySchema),
  agents: z.array(agentStateSchema)
});

export const localProjectRecordSchema = z.object({
  id: z.string().min(1),
  displayPath: z.string().min(1),
  wslPath: z.string().min(1),
  projectRoot: z.string().min(1),
  hostPath: z.string().min(1).optional(),
  distroName: z.string().min(1).optional(),
  identity: projectIdentitySchema,
  validation: validationSnapshotSchema,
  interfacePath: z.string().optional(),
  layout: layoutConfigSchema,
  localState: localProjectStateSchema,
  workflow: z.preprocess((value) => value ?? defaultProjectWorkflowState(), projectWorkflowStateSchema),
  interfaceCreation: interfaceCreationStateSchema.optional(),
  overview: projectOverviewSchema.optional(),
  stats: projectStatsSchema.optional(),
  repositoryScanSettings: repositoryScanSettingsSchema.optional(),
  dependencies: z.array(dependencyRecordSchema),
  summaryCache: z.array(fileSummarySchema),
  agents: z.array(agentStateSchema),
  userInputRequests: z.array(userInputRequestSchema).default([]),
  credentials: projectCredentialsStateSchema.default({ entries: [], requests: [] })
});

export const reviewLogSummarySchema = z.object({
  projectName: z.string().min(1),
  projectKind: projectKindSchema,
  validationStatus: validationStatusSchema,
  workflowStage: workflowStageSchema,
  workflowStopReason: workflowStopReasonSchema,
  cycleNumber: z.number().int().positive(),
  autopilotEnabled: z.boolean(),
  workflowObjective: workflowObjectiveSchema,
  workflowPauseRequested: z.boolean(),
  totalAgents: z.number().int().nonnegative(),
  totalCommands: z.number().int().nonnegative(),
  totalEvents: z.number().int().nonnegative(),
  totalApprovals: z.number().int().nonnegative(),
  pendingApprovals: z.number().int().nonnegative(),
  pendingUserInputRequests: z.number().int().nonnegative(),
  openIssues: z.number().int().nonnegative(),
  agentCountsByCategory: z.record(z.string(), z.number().int().nonnegative()),
  agentCountsByStatus: z.record(z.string(), z.number().int().nonnegative())
});

export const reviewLogTimelineEntrySchema = z.object({
  timestamp: isoDatetime(),
  source: z.enum(["workflow", "agent"]),
  sourceLabel: z.string().min(1),
  agentId: z.string().min(1).optional(),
  agentCategory: agentCategorySchema.optional(),
  status: workflowEventStatusSchema,
  title: z.string().min(1),
  detail: z.string().optional()
});

export const reviewLogProjectSnapshotSchema = z.object({
  id: z.string().min(1),
  identity: projectIdentitySchema,
  validation: validationSnapshotSchema,
  localState: localProjectStateSchema,
  workflow: z.preprocess((value) => value ?? defaultProjectWorkflowState(), projectWorkflowStateSchema),
  interfaceCreation: interfaceCreationStateSchema.optional(),
  overview: projectOverviewSchema.optional(),
  stats: projectStatsSchema.optional(),
  dependencies: z.array(dependencyRecordSchema)
});

export const projectReviewLogBundleSchema = z.object({
  schemaVersion: z.number().default(REVIEW_LOG_BUNDLE_VERSION),
  appVersion: z.string().default(APP_VERSION),
  exportedAt: isoDatetime(),
  context: reviewLogRuntimeContextSchema,
  summary: reviewLogSummarySchema,
  redactions: z.array(z.string().min(1)),
  warnings: z.array(z.string().min(1)),
  project: reviewLogProjectSnapshotSchema,
  agents: z.array(agentStateSchema),
  userInputRequests: z.array(userInputRequestSchema),
  diagnostics: z.array(z.string()),
  timeline: z.array(reviewLogTimelineEntrySchema)
});

export const ipcEnvelopeSchema = z.object({
  channel: z.string().min(1),
  payload: z.unknown().optional()
});
