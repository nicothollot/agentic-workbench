import { z } from "zod";
import {
  agentCategorySchema,
  agentReasoningModeSchema,
  autopilotPolicySchema,
  autopilotStrategySchema,
  appSettingsSchema,
  gitHubStatusSchema,
  goalChangeRecordSchema,
  goalCharterSchema,
  goalCharterDraftTextFieldSchema,
  humanInterventionKindSchema,
  humanInterventionSeveritySchema,
  interfaceReasoningEffortSchema,
  localProjectRecordSchema,
  portableInterfaceSchema,
  repoTreeNodeSchema,
  repositoryScanSettingsSchema,
  ultimateGoalSchema,
  validationStatusSchema,
  workflowModeSchema
} from "./schemas";
import { previewActionSchema, previewCheckpointKindSchema, previewStateProjectionSchema } from "./previewSchemas";

export const credentialEntrySaveRequestSchema = z.object({
  projectId: z.string().min(1),
  entryId: z.string().min(1).optional(),
  providerName: z.string().min(1),
  keyLabel: z.string().min(1),
  apiKey: z.string().min(1),
  secretKey: z.string().optional(),
  notes: z.string().optional(),
  status: z.enum(["active", "needs_attention", "disabled"]).default("active"),
  linkedRequestIds: z.array(z.string().min(1)).default([])
});

export const credentialEntryDeleteRequestSchema = z.object({
  projectId: z.string().min(1),
  entryId: z.string().min(1)
});

export const credentialRequestUpdateSchema = z.object({
  projectId: z.string().min(1),
  requestId: z.string().min(1),
  status: z.enum(["pending", "fulfilled", "dismissed"]),
  notes: z.string().optional()
});

export const credentialRequestSubmitToAgentSchema = z.object({
  projectId: z.string().min(1),
  requestId: z.string().min(1)
});

export const chooseFolderRequestSchema = z.object({
  title: z.string().min(1).max(160).optional(),
  buttonLabel: z.string().min(1).max(80).optional(),
  message: z.string().min(1).max(240).optional()
}).default({});

export const projectCreationModeSchema = z.enum(["initialize_github", "use_folder_as_is"]);

export const projectLoadRequestSchema = z.object({
  inputPath: z.string().min(1),
  intent: z.enum(["open", "create"]).default("open"),
  creationMode: projectCreationModeSchema.default("initialize_github")
});

export const projectOpenRequestSchema = z.object({
  projectId: z.string().min(1)
});

export const projectSelectionDecisionSchema = z.object({
  projectId: z.string().min(1),
  source: z.enum(["portable", "local", "fresh"]),
  path: z.string().optional(),
  freshBehavior: z.enum(["replace", "duplicate"]).optional()
});

export const createAgentRequestSchema = z.object({
  projectId: z.string().min(1),
  category: agentCategorySchema,
  name: z.string().min(1),
  prompt: z.string().min(1),
  model: z.string().min(1),
  reasoningMode: agentReasoningModeSchema.optional(),
  reasoningEffort: interfaceReasoningEffortSchema.optional()
});

export const approvalDecisionRequestSchema = z.object({
  projectId: z.string().min(1),
  agentId: z.string().min(1),
  approvalId: z.string().min(1),
  decision: z.enum(["accept", "acceptForSession", "decline", "cancel"])
});

export const exportInterfaceRequestSchema = z.object({
  projectId: z.string().min(1),
  destinationPath: z.string().min(1).optional()
});

export const downloadInterfaceRequestSchema = z.object({
  projectId: z.string().min(1)
});

export const downloadLogsRequestSchema = z.object({
  projectId: z.string().min(1)
});

export const visualExportTabSchema = z.object({
  id: z.enum(["overview", "workflow", "history", "runs", "logs", "repository", "credentials", "settings"]),
  label: z.string().min(1).max(80)
});

export const visualExportStartRequestSchema = z.object({
  projectId: z.string().min(1),
  tabs: z.array(visualExportTabSchema).min(1).max(8)
});

export const visualExportCaptureRequestSchema = z.object({
  exportId: z.string().min(1),
  target: z.object({
    tab: visualExportTabSchema,
    pageIndex: z.number().int().min(0),
    pageCount: z.number().int().min(1).max(250),
    scrollY: z.number().nonnegative(),
    cropTop: z.number().nonnegative(),
    sliceHeight: z.number().positive(),
    viewportWidth: z.number().positive(),
    viewportHeight: z.number().positive()
  })
});

export const visualExportSessionRequestSchema = z.object({
  exportId: z.string().min(1)
});

export const codexUpdateRunRequestSchema = z.object({
  approvedCommand: z.string().min(1).optional()
}).optional();

export const importInterfaceRequestSchema = z.object({
  projectRootPath: z.string().min(1),
  importPath: z.string().min(1),
  allowMismatch: z.boolean().default(false)
});

export const refreshOverviewRequestSchema = z.object({
  projectId: z.string().min(1)
});

export const fileSummaryRequestSchema = z.object({
  projectId: z.string().min(1),
  relativePath: z.string().min(1)
});

export const projectRepositoryViewRequestSchema = z.object({
  projectId: z.string().min(1)
});

export const projectRepositorySummaryRequestSchema = z.object({
  projectId: z.string().min(1)
});

const repositoryTreePageLimit = 20_000;
const repositoryRelativePathSchema = z.string().min(1).transform((value) => value.replace(/\\/g, "/")).refine((value) => {
  if (!value || value === "." || value.startsWith("/") || /^[A-Za-z]:\//.test(value)) {
    return false;
  }
  return !value.split("/").some((segment) => segment === "..");
}, "Repository paths must stay inside the opened project.");

export const projectRepositoryChildrenRequestSchema = z.object({
  projectId: z.string().min(1),
  parentPath: z.string().default(""),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(repositoryTreePageLimit).default(120)
});

export const projectRepositorySearchRequestSchema = z.object({
  projectId: z.string().min(1),
  query: z.string().default(""),
  limit: z.number().int().min(1).max(repositoryTreePageLimit).default(120)
});

export const repositoryPathSummaryRequestSchema = z.object({
  projectId: z.string().min(1),
  relativePath: repositoryRelativePathSchema,
  model: z.string().min(1),
  reasoningMode: agentReasoningModeSchema.optional(),
  reasoningEffort: interfaceReasoningEffortSchema.optional()
});

export const repositoryPathQuestionRequestSchema = repositoryPathSummaryRequestSchema.extend({
  question: z.string().min(1)
});

export const repositoryPathWindowRequestSchema = z.object({
  projectId: z.string().min(1),
  relativePath: repositoryRelativePathSchema,
  initialQuestion: z.string().trim().max(4_000).optional()
});

export const repositoryScanSettingsRequestSchema = z.object({
  projectId: z.string().min(1),
  settings: repositoryScanSettingsSchema
});

export const projectRepositoryExcludedPathsRequestSchema = z.object({
  projectId: z.string().min(1),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(500).default(120)
});

export const agentListRequestSchema = z.object({
  projectId: z.string().min(1),
  scope: z.enum(["all", "workflow", "manual"]).default("all"),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(20)
});

export const agentDetailRequestSchema = z.object({
  projectId: z.string().min(1),
  agentId: z.string().min(1)
});

export const projectLogFeedRequestSchema = z.object({
  projectId: z.string().min(1),
  activityOffset: z.number().int().min(0).default(0),
  activityLimit: z.number().int().min(1).max(200).default(80),
  commandOffset: z.number().int().min(0).default(0),
  commandLimit: z.number().int().min(1).max(120).default(50)
});

export const workflowCycleListRequestSchema = z.object({
  projectId: z.string().min(1),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(50).default(20)
});

export const workflowCycleDetailRequestSchema = z.object({
  projectId: z.string().min(1),
  cycleId: z.string().min(1)
});

export const cycleAgentListRequestSchema = z.object({
  projectId: z.string().min(1),
  cycleId: z.string().min(1)
});

export const agentTranscriptRequestSchema = z.object({
  projectId: z.string().min(1),
  agentId: z.string().min(1)
});

export const repositoryRescanRequestSchema = z.object({
  projectId: z.string().min(1),
  options: z.object({
    mode: z.enum(["normal", "deep"]).default("normal"),
    settings: repositoryScanSettingsSchema.optional()
  }).default({ mode: "normal" })
});

export const layoutUpdateRequestSchema = z.object({
  projectId: z.string().min(1),
  leftPanelWidth: z.number().int().positive().optional(),
  rightPanelWidth: z.number().int().positive().optional(),
  bottomPanelHeight: z.number().int().positive().optional(),
  activeCenterTab: z.enum(["overview", "workflow", "history", "runs", "logs", "repository", "credentials", "settings", "agents", "file", "diff", "reports"]).optional()
});

export const uiStateUpdateRequestSchema = z.object({
  projectId: z.string().min(1),
  selectedFile: z.string().optional(),
  treeFilter: z.string().optional(),
  activeAgentId: z.string().optional(),
  autopilotEnabled: z.boolean().optional(),
  workflowObjective: z.enum(["deliver", "optimize"]).optional(),
  workflowPauseRequested: z.boolean().optional()
});

export const openProjectShellRequestSchema = z.object({
  projectId: z.string().min(1)
});

export const openWorkflowRepairAgentRequestSchema = z.object({
  projectId: z.string().min(1)
});

export const updateUltimateGoalRequestSchema = z.object({
  projectId: z.string().min(1),
  goal: ultimateGoalSchema.omit({
    confirmedAt: true,
    lastUpdatedAt: true
  }),
  confirm: z.boolean().default(true)
});

export const detectUltimateGoalRequestSchema = z.object({
  projectId: z.string().min(1)
});

export const importUltimateGoalTextRequestSchema = z.object({
  projectId: z.string().min(1)
});

export const goalCharterRequestSchema = z.object({
  projectId: z.string().min(1)
});

export const updateGoalCharterRequestSchema = z.object({
  projectId: z.string().min(1),
  patch: goalCharterSchema.partial()
});

export const polishGoalCharterFieldRequestSchema = z.object({
  projectId: z.string().min(1),
  field: goalCharterDraftTextFieldSchema,
  value: z.string().min(1).max(8_000),
  currentDraft: z.record(goalCharterDraftTextFieldSchema, z.string().max(8_000)).optional(),
  model: z.string().min(1),
  reasoningEffort: interfaceReasoningEffortSchema.optional()
});

export const generateGoalCharterDraftRequestSchema = z.object({
  projectId: z.string().min(1),
  prompt: z.string().min(1).max(12_000),
  currentDraft: z.record(goalCharterDraftTextFieldSchema, z.string().max(8_000)).optional(),
  model: z.string().min(1),
  reasoningEffort: interfaceReasoningEffortSchema.optional()
});

export const autopilotStrategyRequestSchema = z.object({
  projectId: z.string().min(1)
});

export const updateAutopilotStrategyRequestSchema = z.object({
  projectId: z.string().min(1),
  strategy: autopilotStrategySchema
});

export const strategicPlanRequestSchema = z.object({
  projectId: z.string().min(1)
});

export const goalChangeProposalRequestSchema = z.object({
  projectId: z.string().min(1),
  proposal: goalChangeRecordSchema
});

export const goalChangeDecisionRequestSchema = z.object({
  projectId: z.string().min(1),
  proposalId: z.string().min(1),
  decisionNotes: z.string().max(1_000).optional()
});

export const plannerCycleRecordRequestSchema = z.object({
  projectId: z.string().min(1),
  cycleId: z.string().min(1)
});

export const workflowDashboardRequestSchema = z.object({
  projectId: z.string().min(1),
  timeline: z.object({
    cycleNumbers: z.array(z.number().int().positive()).max(50).optional(),
    phases: z.array(z.enum(["goal", "recommendation", "planning", "coding", "integrity", "repair", "merge", "complete", "system"])).max(9).optional(),
    kinds: z.array(z.enum(["cycle", "phase", "activity", "validation", "checklist"])).max(5).optional(),
    statuses: z.array(z.enum(["info", "pending", "running", "waiting", "completed", "failed", "blocked"])).max(7).optional(),
    agentIds: z.array(z.string().min(1)).max(100).optional(),
    incidentIds: z.array(z.string().min(1)).max(100).optional(),
    query: z.string().max(500).optional(),
    from: z.union([z.string(), z.number(), z.date()]).optional(),
    to: z.union([z.string(), z.number(), z.date()]).optional(),
    sortOrder: z.enum(["ascending", "descending"]).optional(),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(500).default(100)
  }).default({ offset: 0, limit: 100 })
});

export const approveRecommendationRequestSchema = z.object({
  projectId: z.string().min(1),
  recommendationId: z.string().min(1)
});

export const createScopedGoalRequestSchema = z.object({
  projectId: z.string().min(1)
});

export const retryWorkflowGoalRequestSchema = z.object({
  projectId: z.string().min(1)
});

export const revalidateWorkflowRepairRequestSchema = z.object({
  projectId: z.string().min(1)
});

export const resetWorkflowCycleRequestSchema = z.object({
  projectId: z.string().min(1)
});

export const setWorkflowModeRequestSchema = z.object({
  projectId: z.string().min(1),
  workflowMode: workflowModeSchema
});

export const requestWorkflowPreviewRequestSchema = z.object({
  projectId: z.string().min(1),
  reason: z.string().max(240).optional(),
  remainingCycles: z.number().int().min(1).max(3).default(1)
});

export const workflowPreviewCheckpointRequestSchema = z.object({
  projectId: z.string().min(1)
});

export const previewProjectRequestSchema = z.object({
  projectId: z.string().min(1)
});

export const previewStartRequestSchema = previewProjectRequestSchema.extend({
  checkpointKind: previewCheckpointKindSchema.default("explicit")
});

export const previewActionRequestSchema = previewProjectRequestSchema.extend({
  sessionId: z.string().min(1),
  action: previewActionSchema
});

export const previewArtifactRequestSchema = previewProjectRequestSchema.extend({
  sessionId: z.string().min(1),
  artifactId: z.string().min(1)
});

export const previewSessionRequestSchema = previewProjectRequestSchema.extend({
  sessionId: z.string().min(1)
});

export const setAutopilotPolicyRequestSchema = z.object({
  projectId: z.string().min(1),
  policy: autopilotPolicySchema.partial()
});

export const runRecommendationRequestSchema = z.object({
  projectId: z.string().min(1),
  customFocus: z.string().min(1).optional()
});

export const advanceWorkflowStageRequestSchema = z.object({
  projectId: z.string().min(1)
});

export const requestHumanInterventionRequestSchema = z.object({
  projectId: z.string().min(1),
  kind: humanInterventionKindSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  reason: z.string().min(1),
  requestedByAgentCategory: agentCategorySchema,
  severity: humanInterventionSeveritySchema.default("medium"),
  blocking: z.boolean().default(true)
});

export const resolveHumanInterventionRequestSchema = z.object({
  projectId: z.string().min(1),
  interventionId: z.string().min(1),
  status: z.enum(["resolved", "dismissed"]).default("resolved"),
  resolutionNotes: z.string().default("")
});

export const submitUserInputRequestResponseSchema = z.object({
  projectId: z.string().min(1),
  requestId: z.string().min(1),
  answers: z.array(z.string())
});

export const manageUserInputRequestAttachmentsSchema = z.object({
  projectId: z.string().min(1),
  requestId: z.string().min(1)
});

export const validationBadgeSchema = validationStatusSchema;

const interfacePreviewSchema = z.object({
  projectName: z.string().min(1),
  summarySnippet: z.string(),
  agentPanelCount: z.number().int().nonnegative(),
  repoTreeReady: z.boolean(),
  overviewReady: z.boolean(),
  versionSummary: z.string(),
  lastOpenedAt: z.string().datetime({ offset: true }).optional(),
  validationStatus: validationStatusSchema,
  subsystemCount: z.number().int().nonnegative(),
  pathSummaryCount: z.number().int().nonnegative(),
  dependencyCount: z.number().int().nonnegative(),
  contentSource: z.enum(["deterministic", "codex", "hybrid", "mock"])
});

const interfaceCandidateSchema = z.object({
  source: z.enum(["portable", "local"]),
  label: z.string().min(1),
  path: z.string().min(1),
  preview: interfacePreviewSchema,
  validationStatus: validationStatusSchema,
  data: z.union([portableInterfaceSchema, localProjectRecordSchema])
});

/**
 * The bounded project projection sent to a renderer. This deliberately mirrors
 * LoadedProjectView rather than the older portable-project shape. Keeping the
 * runtime schema accurate is important because it is also used by the v2 state
 * stream at the main/preload trust boundary.
 */
export const projectSnapshotSchema = z.object({
  record: localProjectRecordSchema,
  tree: z.array(repoTreeNodeSchema),
  validationStatus: validationStatusSchema,
  candidates: z.array(interfaceCandidateSchema)
});

export const settingsUpdateRequestSchema = z.union([
  z.object({
    patch: appSettingsSchema.partial(),
    baseRevision: z.number().int().nonnegative().optional()
  }).strict(),
  appSettingsSchema.partial().strict().transform((patch) => ({ patch }))
]);

export const rendererStateSchema = z.object({
  settings: appSettingsSchema,
  settingsRevision: z.number().int().nonnegative().default(0),
  operations: z.array(z.object({
    id: z.string().min(1),
    kind: z.enum(["settings-update", "project-open", "repository-scan", "runtime-restart", "preview-session"]),
    status: z.enum(["running", "completed", "failed", "cancelled"]),
    phase: z.string().min(1),
    message: z.string(),
    startedAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }).optional(),
    error: z.string().optional()
  })).default([]),
  preview: previewStateProjectionSchema.optional(),
  github: gitHubStatusSchema,
  projects: z.array(projectSnapshotSchema),
  activeProjectId: z.string().optional(),
  availableModels: z.array(
    z.object({
      id: z.string().min(1),
      model: z.string().min(1),
      displayName: z.string().min(1),
      description: z.string(),
      supportedReasoningEfforts: z.array(interfaceReasoningEffortSchema),
      defaultReasoningEffort: interfaceReasoningEffortSchema.optional(),
      supportsPersonality: z.boolean(),
      isDefault: z.boolean(),
      labels: z.array(z.string()),
      recommendedForInterfaceCreation: z.boolean()
    })
  ).default([]),
  codexAvailability: z.object({
    source: z.enum(["live", "mock", "unavailable"]),
    message: z.string().optional(),
    installedCodexVersion: z.string().optional(),
    generatedProtocolVersion: z.string().optional(),
    protocolCompatibility: z.enum(["compatible", "installed-newer", "installed-older", "unknown"]).optional()
  }).optional(),
  codexReadiness: z.object({
    checkedAt: z.string().optional(),
    executionMode: z.enum(["local", "wsl"]),
    distroName: z.string().optional(),
    codexBinaryPath: z.string(),
    codexCliExists: z.boolean().optional(),
    codexPath: z.string().optional(),
    nodePath: z.string().optional(),
    codexVersion: z.string().optional(),
    latestCodexVersion: z.string().optional(),
    updateAvailable: z.boolean(),
    updateCommand: z.string().optional(),
    status: z.enum(["checking", "ready", "outdated", "unavailable", "skipped"]),
    message: z.string(),
    warnings: z.array(z.string()).optional(),
    errors: z.array(z.string()).optional()
  }),
  codexUpdate: z.object({
    checkedAt: z.string(),
    currentVersion: z.string().optional(),
    latestVersion: z.string().optional(),
    targetVersion: z.string().optional(),
    updateAvailable: z.boolean(),
    updateCommand: z.string().optional(),
    status: z.enum(["up-to-date", "outdated", "unavailable", "skipped"]),
    message: z.string()
  }).optional(),
  runtimeReadiness: z.object({
    status: z.enum(["checking", "ready", "blocked"]),
    checkedAt: z.string().optional(),
    summary: z.string(),
    blockAgentActions: z.boolean(),
    checks: z.array(z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      status: z.enum(["checking", "passed", "warning", "failed"]),
      message: z.string(),
      fixInApp: z.string().optional(),
      manualCommand: z.string().optional()
    }))
  }),
  diagnostics: z.array(z.string()).default([])
});

export type IpcChannel =
  | "app:getState"
  | "github:refreshStatus"
  | "app:chooseFolder"
  | "app:chooseImportBundle"
  | "app:importInterfaceBundle"
  | "app:showLauncher"
  | "app:openDevTools"
  | "app:checkRuntimeReadiness"
  | "app:getCodexReadiness"
  | "app:refreshCodexReadiness"
  | "app:checkCodexUpdate"
  | "app:runCodexUpdate"
  | "app:getExecutionEnvironmentStatus"
  | "app:quit"
  | "settings:get"
  | "settings:update"
  | "project:load"
  | "project:open"
  | "project:selectInterface"
  | "project:exportInterface"
  | "project:downloadInterface"
  | "project:downloadLogs"
  | "project:startVisualExport"
  | "project:captureVisualExportPage"
  | "project:finishVisualExport"
  | "project:cancelVisualExport"
  | "project:importInterface"
  | "project:getFileSummary"
  | "project:getRepositoryView"
  | "project:getRepositorySummary"
  | "project:listRepositoryChildren"
  | "project:searchRepositoryFiles"
  | "project:getRepositoryScanStatus"
  | "project:rescanRepository"
  | "project:listAgents"
  | "project:getAgent"
  | "project:listWorkflowCycles"
  | "project:getWorkflowCycle"
  | "project:listCycleAgents"
  | "project:getAgentTranscript"
  | "project:getAgentFullOutput"
  | "project:getLogFeed"
  | "project:updateLayout"
  | "project:updateUiState"
  | "project:openProjectShell"
  | "workflow:openRepairAgent"
  | "workflow:getDashboard"
  | "credentials:saveEntry"
  | "credentials:deleteEntry"
  | "credentials:updateRequest"
  | "credentials:submitRequestToAgent"
  | "workflow:updateUltimateGoal"
  | "workflow:detectUltimateGoal"
  | "workflow:importUltimateGoalText"
  | "workflow:getGoalCharter"
  | "workflow:updateGoalCharter"
  | "workflow:polishGoalCharterField"
  | "workflow:generateGoalCharterDraft"
  | "workflow:getAutopilotStrategy"
  | "workflow:updateAutopilotStrategy"
  | "workflow:listAutopilotPresets"
  | "workflow:generateStrategicPlan"
  | "workflow:selectNextWorkPackage"
  | "workflow:proposeGoalChange"
  | "workflow:acceptGoalChange"
  | "workflow:rejectGoalChange"
  | "workflow:listChecklistChanges"
  | "workflow:getPlannerDecision"
  | "workflow:getCycleRetrospective"
  | "workflow:approveRecommendation"
  | "workflow:createScopedGoal"
  | "workflow:retryGoal"
  | "workflow:revalidateRepair"
  | "workflow:resetCycle"
  | "workflow:setMode"
  | "workflow:requestPreview"
  | "workflow:cancelPreview"
  | "workflow:completePreview"
  | "preview:getReadiness"
  | "preview:grantTrust"
  | "preview:start"
  | "preview:stop"
  | "preview:performAction"
  | "preview:getArtifact"
  | "preview:openExternal"
  | "preview:installBrowser"
  | "workflow:advanceStage"
  | "workflow:recover"
  | "workflow:clearStaleLock"
  | "workflow:requestHumanIntervention"
  | "workflow:resolveHumanIntervention"
  | "workflow:submitUserInputRequest"
  | "workflow:addUserInputRequestAttachments"
  | "workflow:openUserInputRequestInbox"
  | "agent:create"
  | "agent:approve"
  | "agent:runIntegrity"
  | "agent:runMerge"
  | "agent:runRecommendation"
  | "project:refreshOverview"
  | "project:revalidate";
