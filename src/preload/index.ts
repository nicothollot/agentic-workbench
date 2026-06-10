import { contextBridge, ipcRenderer } from "electron";
import type {
  AgentCategory,
  AgentFullOutputResponse,
  AgentHistoryScope,
  AgentListResponse,
  AgentReasoningMode,
  AgentState,
  AgentTranscriptResponse,
  AutopilotPolicy,
  ApprovalDecision,
  CodexReadinessReport,
  CodexUpdateCheckResult,
  CodexUpdateRunResult,
  CycleAgentListResponse,
  CredentialEntryMetadata,
  CredentialEntryStatus,
  CredentialRequestRecord,
  FileSummary,
  GitHubStatus,
  HumanInterventionRecord,
  InterfaceReasoningEffort,
  LocalProjectState,
  LoadedProjectView,
  OpenProjectShellResult,
  ProjectLogFeedResponse,
  ProjectLoadResult,
  ProjectRepositoryView,
  ProjectRepositorySummary,
  ProjectWorkflowState,
  RepositoryScanStatus,
  RepositoryChildrenResponse,
  RepositorySearchResponse,
  RuntimeReadinessReport,
  UserInputRequestRecord,
  UltimateGoalImportPreview,
  UltimateGoal,
  VisualExportCaptureTarget,
  VisualExportSessionStart,
  VisualExportTab,
  WorkflowCycleDetail,
  WorkflowCycleListResponse,
  WorkbenchState
} from "@shared/types";

const invoke = async <T>(channel: string, payload?: unknown): Promise<T> => await ipcRenderer.invoke(channel, payload) as T;
const STATE_UPDATE_COALESCE_MS = 150;

export interface WorkbenchApi {
  getState(): Promise<WorkbenchState>;
  onStateUpdated(listener: (state: WorkbenchState) => void): () => void;
  refreshGitHubStatus(): Promise<GitHubStatus>;
  chooseFolder(): Promise<string | null>;
  chooseImportBundle(): Promise<{ projectRootPath: string; importPath: string } | null>;
  importInterfaceBundle(): Promise<LoadedProjectView | null>;
  showLauncher(): Promise<void>;
  openDevTools(): Promise<boolean>;
  checkRuntimeReadiness(): Promise<RuntimeReadinessReport>;
  getCodexReadiness(): Promise<CodexReadinessReport>;
  checkCodexUpdate(): Promise<CodexUpdateCheckResult>;
  runCodexUpdate(): Promise<CodexUpdateRunResult>;
  quit(): Promise<void>;
  loadProject(inputPath: string, intent?: "open" | "create"): Promise<ProjectLoadResult>;
  openProject(projectId: string): Promise<LoadedProjectView>;
  selectInterface(source: "portable" | "local" | "fresh", path?: string, freshBehavior?: "replace" | "duplicate"): Promise<LoadedProjectView>;
  updateSettings(payload: Record<string, unknown>): Promise<unknown>;
  getFileSummary(projectId: string, relativePath: string): Promise<FileSummary>;
  getRepositoryView(projectId: string): Promise<ProjectRepositoryView>;
  getRepositorySummary(projectId: string): Promise<ProjectRepositorySummary>;
  listRepositoryChildren(
    projectId: string,
    parentPath: string,
    options?: { cursor?: string; limit?: number }
  ): Promise<RepositoryChildrenResponse>;
  searchRepositoryFiles(projectId: string, query: string, options?: { limit?: number }): Promise<RepositorySearchResponse>;
  getRepositoryScanStatus(projectId: string): Promise<RepositoryScanStatus>;
  rescanRepository(projectId: string, options?: { mode?: "normal" | "deep" }): Promise<ProjectRepositorySummary>;
  listAgents(projectId: string, scope?: AgentHistoryScope, offset?: number, limit?: number): Promise<AgentListResponse>;
  getAgent(projectId: string, agentId: string): Promise<AgentState>;
  listWorkflowCycles(projectId: string, options?: { cursor?: string; limit?: number }): Promise<WorkflowCycleListResponse>;
  getWorkflowCycle(projectId: string, cycleId: string): Promise<WorkflowCycleDetail>;
  listCycleAgents(projectId: string, cycleId: string): Promise<CycleAgentListResponse>;
  getAgentTranscript(projectId: string, agentId: string): Promise<AgentTranscriptResponse>;
  getAgentFullOutput(projectId: string, agentId: string): Promise<AgentFullOutputResponse>;
  getLogFeed(
    projectId: string,
    options?: {
      activityOffset?: number;
      activityLimit?: number;
      commandOffset?: number;
      commandLimit?: number;
    }
  ): Promise<ProjectLogFeedResponse>;
  updateLayout(projectId: string, payload: Record<string, unknown>): Promise<void>;
  updateUiState(projectId: string, payload: Partial<LocalProjectState>): Promise<void>;
  openProjectShell(projectId: string): Promise<OpenProjectShellResult>;
  saveCredentialEntry(
    projectId: string,
    payload: {
      entryId?: string;
      providerName: string;
      keyLabel: string;
      apiKey: string;
      secretKey?: string;
      notes?: string;
      status?: CredentialEntryStatus;
      linkedRequestIds?: string[];
    }
  ): Promise<CredentialEntryMetadata>;
  deleteCredentialEntry(projectId: string, entryId: string): Promise<void>;
  updateCredentialRequest(
    projectId: string,
    requestId: string,
    status: CredentialRequestRecord["status"],
    notes?: string
  ): Promise<CredentialRequestRecord>;
  submitCredentialRequestToAgent(projectId: string, requestId: string): Promise<CredentialRequestRecord>;
  updateUltimateGoal(projectId: string, goal: Omit<UltimateGoal, "confirmedAt" | "lastUpdatedAt">, confirm?: boolean): Promise<UltimateGoal>;
  detectUltimateGoal(projectId: string): Promise<UltimateGoal>;
  importUltimateGoalText(projectId: string): Promise<UltimateGoalImportPreview | null>;
  approveRecommendation(projectId: string, recommendationId: string): Promise<unknown>;
  createScopedGoal(projectId: string): Promise<unknown>;
  retryWorkflowGoal(projectId: string): Promise<unknown>;
  setWorkflowMode(projectId: string, workflowMode: ProjectWorkflowState["workflowMode"]): Promise<ProjectWorkflowState>;
  requestWorkflowPreview(projectId: string, reason?: string, remainingCycles?: number): Promise<ProjectWorkflowState>;
  cancelWorkflowPreview(projectId: string): Promise<ProjectWorkflowState>;
  completeWorkflowPreview(projectId: string): Promise<ProjectWorkflowState>;
  setAutopilotPolicy(projectId: string, policy: Partial<AutopilotPolicy>): Promise<ProjectWorkflowState>;
  advanceWorkflowStage(projectId: string): Promise<string>;
  recoverWorkflow(projectId: string): Promise<string>;
  clearStaleWorkflowLock(projectId: string): Promise<string>;
  requestHumanIntervention(
    projectId: string,
    payload: Omit<HumanInterventionRecord, "id" | "status" | "createdAt" | "resolvedAt" | "resolutionNotes">
  ): Promise<HumanInterventionRecord>;
  resolveHumanIntervention(
    projectId: string,
    interventionId: string,
    status?: "resolved" | "dismissed",
    resolutionNotes?: string
  ): Promise<HumanInterventionRecord>;
  submitUserInputRequest(projectId: string, requestId: string, answers: string[]): Promise<UserInputRequestRecord>;
  addUserInputRequestAttachments(projectId: string, requestId: string): Promise<UserInputRequestRecord>;
  openUserInputRequestInbox(projectId: string, requestId: string): Promise<void>;
  exportInterface(projectId: string, destinationPath?: string): Promise<string>;
  downloadInterface(projectId: string): Promise<string | null>;
  downloadLogs(projectId: string): Promise<string | null>;
  startVisualExport(projectId: string, tabs: VisualExportTab[]): Promise<VisualExportSessionStart | null>;
  captureVisualExportPage(exportId: string, target: VisualExportCaptureTarget): Promise<void>;
  finishVisualExport(exportId: string): Promise<string>;
  cancelVisualExport(exportId: string): Promise<void>;
  importInterface(projectRootPath: string, importPath: string, allowMismatch?: boolean): Promise<LoadedProjectView>;
  createAgent(
    projectId: string,
    category: AgentCategory,
    name: string,
    prompt: string,
    model: string,
    reasoningMode?: AgentReasoningMode,
    reasoningEffort?: InterfaceReasoningEffort
  ): Promise<unknown>;
  approve(projectId: string, agentId: string, approvalId: string, decision: ApprovalDecision): Promise<void>;
  runIntegrity(projectId: string): Promise<void>;
  runMerge(projectId: string): Promise<void>;
  runRecommendation(projectId: string, customFocus?: string): Promise<void>;
  refreshOverview(projectId: string): Promise<void>;
  revalidate(projectId: string): Promise<string>;
}

const api: WorkbenchApi = {
  getState: async () => await invoke<WorkbenchState>("app:getState"),
  refreshGitHubStatus: async () => await invoke<GitHubStatus>("github:refreshStatus"),
  onStateUpdated: (listener) => {
    let frameId: ReturnType<typeof setTimeout> | null = null;
    let latestState: WorkbenchState | null = null;
    const flush = (): void => {
      frameId = null;
      if (latestState) {
        listener(latestState);
        latestState = null;
      }
    };
    const wrapped = (_event: Electron.IpcRendererEvent, state: WorkbenchState) => {
      latestState = state;
      if (frameId !== null) {
        return;
      }
      frameId = setTimeout(flush, STATE_UPDATE_COALESCE_MS);
    };
    ipcRenderer.on("state:updated", wrapped);
    return () => {
      if (frameId !== null) {
        clearTimeout(frameId);
      }
      ipcRenderer.removeListener("state:updated", wrapped);
    };
  },
  chooseFolder: async () => await invoke<string | null>("app:chooseFolder"),
  chooseImportBundle: async () => await invoke<{ projectRootPath: string; importPath: string } | null>("app:chooseImportBundle"),
  importInterfaceBundle: async () => await invoke<LoadedProjectView | null>("app:importInterfaceBundle"),
  showLauncher: async () => await invoke<void>("app:showLauncher"),
  openDevTools: async () => await invoke<boolean>("app:openDevTools"),
  checkRuntimeReadiness: async () => await invoke<RuntimeReadinessReport>("app:checkRuntimeReadiness"),
  getCodexReadiness: async () => await invoke<CodexReadinessReport>("app:getCodexReadiness"),
  checkCodexUpdate: async () => await invoke<CodexUpdateCheckResult>("app:checkCodexUpdate"),
  runCodexUpdate: async () => await invoke<CodexUpdateRunResult>("app:runCodexUpdate"),
  quit: async () => await invoke<void>("app:quit"),
  loadProject: async (inputPath, intent = "open") => await invoke<ProjectLoadResult>("project:load", { inputPath, intent }),
  openProject: async (projectId) => await invoke<LoadedProjectView>("project:open", { projectId }),
  selectInterface: async (source, path, freshBehavior) =>
    await invoke<LoadedProjectView>("project:selectInterface", { projectId: "pending", source, path, freshBehavior }),
  updateSettings: async (payload) => await invoke<unknown>("settings:update", payload),
  getFileSummary: async (projectId, relativePath) => await invoke<FileSummary>("project:getFileSummary", { projectId, relativePath }),
  getRepositoryView: async (projectId) => await invoke<ProjectRepositoryView>("project:getRepositoryView", { projectId }),
  getRepositorySummary: async (projectId) => await invoke<ProjectRepositorySummary>("project:getRepositorySummary", { projectId }),
  listRepositoryChildren: async (projectId, parentPath, options = {}) =>
    await invoke<RepositoryChildrenResponse>("project:listRepositoryChildren", { projectId, parentPath, ...options }),
  searchRepositoryFiles: async (projectId, query, options = {}) =>
    await invoke<RepositorySearchResponse>("project:searchRepositoryFiles", { projectId, query, ...options }),
  getRepositoryScanStatus: async (projectId) =>
    await invoke<RepositoryScanStatus>("project:getRepositoryScanStatus", { projectId }),
  rescanRepository: async (projectId, options = {}) =>
    await invoke<ProjectRepositorySummary>("project:rescanRepository", { projectId, options }),
  updateLayout: async (projectId, payload) => await invoke<void>("project:updateLayout", { projectId, ...payload }),
  updateUiState: async (projectId, payload) => await invoke<void>("project:updateUiState", { projectId, ...payload }),
  openProjectShell: async (projectId) => await invoke<OpenProjectShellResult>("project:openProjectShell", { projectId }),
  saveCredentialEntry: async (projectId, payload) =>
    await invoke<CredentialEntryMetadata>("credentials:saveEntry", { projectId, ...payload }),
  deleteCredentialEntry: async (projectId, entryId) =>
    await invoke<void>("credentials:deleteEntry", { projectId, entryId }),
  updateCredentialRequest: async (projectId, requestId, status, notes) =>
    await invoke<CredentialRequestRecord>("credentials:updateRequest", { projectId, requestId, status, notes }),
  submitCredentialRequestToAgent: async (projectId, requestId) =>
    await invoke<CredentialRequestRecord>("credentials:submitRequestToAgent", { projectId, requestId }),
  updateUltimateGoal: async (projectId, goal, confirm = true) =>
    await invoke<UltimateGoal>("workflow:updateUltimateGoal", { projectId, goal, confirm }),
  detectUltimateGoal: async (projectId) => await invoke<UltimateGoal>("workflow:detectUltimateGoal", { projectId }),
  importUltimateGoalText: async (projectId) =>
    await invoke<UltimateGoalImportPreview | null>("workflow:importUltimateGoalText", { projectId }),
  approveRecommendation: async (projectId, recommendationId) =>
    await invoke("workflow:approveRecommendation", { projectId, recommendationId }),
  createScopedGoal: async (projectId) => await invoke("workflow:createScopedGoal", { projectId }),
  retryWorkflowGoal: async (projectId) => await invoke("workflow:retryGoal", { projectId }),
  setWorkflowMode: async (projectId, workflowMode) => await invoke<ProjectWorkflowState>("workflow:setMode", { projectId, workflowMode }),
  requestWorkflowPreview: async (projectId, reason, remainingCycles = 1) =>
    await invoke<ProjectWorkflowState>("workflow:requestPreview", { projectId, reason, remainingCycles }),
  cancelWorkflowPreview: async (projectId) => await invoke<ProjectWorkflowState>("workflow:cancelPreview", { projectId }),
  completeWorkflowPreview: async (projectId) => await invoke<ProjectWorkflowState>("workflow:completePreview", { projectId }),
  setAutopilotPolicy: async (projectId, policy) => await invoke<ProjectWorkflowState>("workflow:setAutopilotPolicy", { projectId, policy }),
  advanceWorkflowStage: async (projectId) => await invoke<string>("workflow:advanceStage", { projectId }),
  recoverWorkflow: async (projectId) => await invoke<string>("workflow:recover", { projectId }),
  clearStaleWorkflowLock: async (projectId) => await invoke<string>("workflow:clearStaleLock", { projectId }),
  requestHumanIntervention: async (projectId, payload) =>
    await invoke<HumanInterventionRecord>("workflow:requestHumanIntervention", { projectId, ...payload }),
  resolveHumanIntervention: async (projectId, interventionId, status = "resolved", resolutionNotes = "") =>
    await invoke<HumanInterventionRecord>("workflow:resolveHumanIntervention", { projectId, interventionId, status, resolutionNotes }),
  submitUserInputRequest: async (projectId, requestId, answers) =>
    await invoke<UserInputRequestRecord>("workflow:submitUserInputRequest", { projectId, requestId, answers }),
  addUserInputRequestAttachments: async (projectId, requestId) =>
    await invoke<UserInputRequestRecord>("workflow:addUserInputRequestAttachments", { projectId, requestId }),
  openUserInputRequestInbox: async (projectId, requestId) =>
    await invoke<void>("workflow:openUserInputRequestInbox", { projectId, requestId }),
  exportInterface: async (projectId, destinationPath) => await invoke<string>("project:exportInterface", { projectId, destinationPath }),
  downloadInterface: async (projectId) => await invoke<string | null>("project:downloadInterface", { projectId }),
  downloadLogs: async (projectId) => await invoke<string | null>("project:downloadLogs", { projectId }),
  startVisualExport: async (projectId, tabs) =>
    await invoke<VisualExportSessionStart | null>("project:startVisualExport", { projectId, tabs }),
  captureVisualExportPage: async (exportId, target) =>
    await invoke<void>("project:captureVisualExportPage", { exportId, target }),
  finishVisualExport: async (exportId) => await invoke<string>("project:finishVisualExport", { exportId }),
  cancelVisualExport: async (exportId) => await invoke<void>("project:cancelVisualExport", { exportId }),
  importInterface: async (projectRootPath, importPath, allowMismatch = false) =>
    await invoke<LoadedProjectView>("project:importInterface", { projectRootPath, importPath, allowMismatch }),
  listAgents: async (projectId, scope = "all", offset = 0, limit = 20) =>
    await invoke<AgentListResponse>("project:listAgents", { projectId, scope, offset, limit }),
  getAgent: async (projectId, agentId) =>
    await invoke<AgentState>("project:getAgent", { projectId, agentId }),
  listWorkflowCycles: async (projectId, options = {}) =>
    await invoke<WorkflowCycleListResponse>("project:listWorkflowCycles", { projectId, ...options }),
  getWorkflowCycle: async (projectId, cycleId) =>
    await invoke<WorkflowCycleDetail>("project:getWorkflowCycle", { projectId, cycleId }),
  listCycleAgents: async (projectId, cycleId) =>
    await invoke<CycleAgentListResponse>("project:listCycleAgents", { projectId, cycleId }),
  getAgentTranscript: async (projectId, agentId) =>
    await invoke<AgentTranscriptResponse>("project:getAgentTranscript", { projectId, agentId }),
  getAgentFullOutput: async (projectId, agentId) =>
    await invoke<AgentFullOutputResponse>("project:getAgentFullOutput", { projectId, agentId }),
  getLogFeed: async (projectId, options = {}) =>
    await invoke<ProjectLogFeedResponse>("project:getLogFeed", { projectId, ...options }),
  createAgent: async (projectId, category, name, prompt, model, reasoningMode, reasoningEffort) =>
    await invoke<unknown>("agent:create", { projectId, category, name, prompt, model, reasoningMode, reasoningEffort }),
  approve: async (projectId, agentId, approvalId, decision) =>
    await invoke<void>("agent:approve", { projectId, agentId, approvalId, decision }),
  runIntegrity: async (projectId) => await invoke<void>("agent:runIntegrity", projectId),
  runMerge: async (projectId) => await invoke<void>("agent:runMerge", projectId),
  runRecommendation: async (projectId, customFocus) => await invoke<void>("agent:runRecommendation", { projectId, customFocus }),
  refreshOverview: async (projectId) => await invoke<void>("project:refreshOverview", { projectId }),
  revalidate: async (projectId) => await invoke<string>("project:revalidate", projectId)
};

contextBridge.exposeInMainWorld("workbench", api);
