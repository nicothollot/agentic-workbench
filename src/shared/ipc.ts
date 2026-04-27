import { z } from "zod";
import {
  agentCategorySchema,
  agentReasoningModeSchema,
  appSettingsSchema,
  gitHubStatusSchema,
  humanInterventionKindSchema,
  humanInterventionSeveritySchema,
  interfaceReasoningEffortSchema,
  localProjectRecordSchema,
  portableInterfaceSchema,
  ultimateGoalSchema,
  validationStatusSchema
} from "./schemas";

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

export const projectLoadRequestSchema = z.object({
  inputPath: z.string().min(1),
  intent: z.enum(["open", "create"]).default("open")
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

export const layoutUpdateRequestSchema = z.object({
  projectId: z.string().min(1),
  leftPanelWidth: z.number().int().positive().optional(),
  rightPanelWidth: z.number().int().positive().optional(),
  bottomPanelHeight: z.number().int().positive().optional(),
  activeCenterTab: z.enum(["overview", "workflow", "logs", "agents", "credentials", "file", "diff", "reports"]).optional()
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

export const projectSnapshotSchema = localProjectRecordSchema.extend({
  portable: portableInterfaceSchema.optional()
});

export const rendererStateSchema = z.object({
  settings: appSettingsSchema,
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
    message: z.string().optional()
  }).optional(),
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
  | "app:quit"
  | "settings:get"
  | "settings:update"
  | "project:load"
  | "project:open"
  | "project:selectInterface"
  | "project:exportInterface"
  | "project:downloadInterface"
  | "project:downloadLogs"
  | "project:importInterface"
  | "project:getFileSummary"
  | "project:updateLayout"
  | "project:updateUiState"
  | "project:openProjectShell"
  | "credentials:saveEntry"
  | "credentials:deleteEntry"
  | "credentials:updateRequest"
  | "credentials:submitRequestToAgent"
  | "workflow:updateUltimateGoal"
  | "workflow:detectUltimateGoal"
  | "workflow:importUltimateGoalText"
  | "workflow:approveRecommendation"
  | "workflow:createScopedGoal"
  | "workflow:retryGoal"
  | "workflow:advanceStage"
  | "workflow:recover"
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
