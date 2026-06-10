export type ValidationStatus = "exact" | "stale" | "incompatible" | "unvalidated";
export type ProjectPathKind = "windows" | "wsl-unc" | "linux";
export type ProjectKind = "git" | "folder";
export type SummarySource = "deterministic" | "codex" | "hybrid" | "mock";
export type AgentCategory = "bootstrap" | "goal" | "coding" | "integrity" | "merge" | "recommendation" | "manual";
export type AgentLifecycleStatus =
  | "idle"
  | "starting"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "conflicted"
  | "disconnected";
export type ApprovalKind = "command" | "file-change" | "permissions" | "apply-patch";
export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
export type InterfaceReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type AgentReasoningMode = "auto" | "manual";
export type AgentReasoningEfforts = Partial<Record<AgentCategory, InterfaceReasoningEffort>>;
export type InterfaceCreationStatus = "idle" | "queued" | "running" | "completed" | "failed";
export type ModelCatalogSource = "live" | "mock" | "unavailable";
export type ExecutionMode = "local" | "wsl";
export type GitHubLinkState = "linked" | "not_linked" | "needs_ssh" | "cli_missing" | "error";
export type UltimateGoalSource = "user" | "detected";
export type RecommendationRiskLevel = "low" | "medium" | "high";
export type UltimateGoalProgressSource = "recommendation" | "deterministic";
export type WorkflowObjective = "deliver" | "optimize";
export type WorkflowMode = "normal" | "fast";
export type WorkflowPreviewStatus = "none" | "queued" | "active" | "ready" | "completed" | "cancelled";
export type AutopilotProfile = "balanced" | "conservative" | "aggressive" | "custom";
export type AutopilotIntegrityFailurePolicy = "repair" | "pause" | "policy";
export type AutopilotPauseReason =
  | "disabled"
  | "manual_pause_requested"
  | "preview_ready"
  | "human_blocker"
  | "approval_required"
  | "integrity_failure"
  | "repair_budget_exhausted"
  | "merge_conflict"
  | "ultimate_goal_satisfied"
  | "no_safe_recommendation"
  | "project_access_validation_failed"
  | "repeated_failure"
  | "high_risk_package_requires_approval"
  | "unsafe_scope_broadening"
  | "required_check_promotion_cap"
  | "max_consecutive_cycles"
  | "automation_no_progress";
export interface AutopilotPolicy {
  enabled: boolean;
  profile: AutopilotProfile;
  maxAutomaticActionsPerPass: number;
  maxConsecutiveCycles?: number;
  pauseOnPreviewReady: boolean;
  pauseOnHumanBlocker: boolean;
  pauseOnApprovalRequired: boolean;
  pauseOnIntegrityFailure: AutopilotIntegrityFailurePolicy;
  pauseOnMergeConflict: boolean;
  allowDeterministicScoping: boolean;
  allowAgentRecommendationWhenDeterministicPackageExists: boolean;
  allowBacklogPromotion: boolean;
  maxNewRequiredChecksPerCycle: number;
  preferGroupedChecklistPackages: boolean;
  maxChecksPerWorkPackageNormal: number;
  maxChecksPerWorkPackageFast: number;
  allowFastModeBatching: boolean;
  requireExplicitApprovalForHighRiskPackages: boolean;
  highRiskAreas: string[];
  stopWhenGoalSatisfied: boolean;
  stopWhenNoSafeRecommendation: boolean;
}
export type UltimateGoalCompletionState = "needs_more_work" | "goal_satisfied";
export type WorkflowAppealStatus = "not_started" | "not_applicable" | "pending" | "running" | "completed";
export type WorkflowRepairStatus = "idle" | "repairing" | "retrying_validation" | "fixed" | "exhausted" | "merge_conflicts";
export type WorkflowEventStatus = "info" | "running" | "waiting" | "completed" | "failed";
export type WorkflowActivitySource = "workflow" | "agent" | "validation" | "approval" | "system";
export type WorkflowStage =
  | "charter_needed"
  | "recommendation_pending"
  | "recommendation_approved"
  | "goal_ready"
  | "coding_running"
  | "integrity_running"
  | "repair_loop"
  | "ready_to_merge"
  | "merged"
  | "appeal_pending"
  | "blocked_human"
  | "cycle_complete";
export type WorkflowStopReason =
  | "none"
  | "charter_missing"
  | "recommendation_missing"
  | "awaiting_recommendation_approval"
  | "goal_not_scoped"
  | "human_intervention_required"
  | "integrity_failed"
  | "repair_stopped_early"
  | "repair_budget_exhausted"
  | "merge_conflicts"
  | "appeal_missing"
  | "awaiting_appeal_approval"
  | "ultimate_goal_satisfied"
  | "cycle_completed";
export type WorkflowStepId = "ultimate_goal" | "recommendation" | "goal_plan" | "coding" | "integrity" | "merge";
export type WorkflowStepStatus = "not_started" | "waiting" | "recovering" | "starting" | "running" | "blocked" | "completed" | "failed";
export type WorkflowCycleStatus =
  | "idle"
  | "recommendation_approved"
  | "goal_ready"
  | "coding"
  | "integrity"
  | "repair_loop"
  | "ready_to_merge"
  | "merged"
  | "completed"
  | "blocked_human";
export type HumanInterventionKind =
  | "account_creation"
  | "credentials"
  | "email_verification"
  | "api_access"
  | "captcha_or_sso"
  | "billing_or_legal"
  | "product_question"
  | "external_setup"
  | "other";
export type HumanInterventionSeverity = "low" | "medium" | "high" | "critical";
export type HumanInterventionStatus = "pending" | "resolved" | "dismissed";
export type WorkflowDecisionKind = "ultimate_goal" | "recommendation" | "scoped_goal" | "human_intervention" | "merge";
export type UserInputRequestStatus = "pending" | "submitted";
export type CredentialEntryStatus = "active" | "needs_attention" | "disabled";
export type CredentialRequestStatus = "pending" | "fulfilled" | "dismissed";
export type WorkspaceCenterTab =
  | "overview"
  | "workflow"
  | "runs"
  | "logs"
  | "repository"
  | "credentials"
  | "settings"
  | "agents"
  | "file"
  | "diff"
  | "reports";
export type WorkspaceVisualTabId = Extract<WorkspaceCenterTab, "overview" | "workflow" | "runs" | "logs" | "repository" | "credentials" | "settings">;

export interface VisualExportTab {
  id: WorkspaceVisualTabId;
  label: string;
}

export interface VisualExportCaptureTarget {
  tab: VisualExportTab;
  pageIndex: number;
  pageCount: number;
  scrollY: number;
  cropTop: number;
  sliceHeight: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface VisualExportSessionStart {
  exportId: string;
}

export interface AppSettings {
  executionMode: ExecutionMode;
  distroName: string;
  codexBinaryPath: string;
  codexHome?: string;
  worktreeBaseDir: string;
  preferredEditorCommand?: string;
  warnOnMntMount: boolean;
  mockMode: boolean;
  maxRepairCycles: number;
  interfaceCreationModel?: string;
  interfaceCreationReasoningEffort?: InterfaceReasoningEffort;
  interfaceCreationConfiguredAt?: string;
  agentReasoningMode?: AgentReasoningMode;
  agentReasoningEfforts?: AgentReasoningEfforts;
  githubAccount?: LinkedGitHubAccount;
  autoApproveCommands: boolean;
  autoApproveGitCommits: boolean;
  autoApproveGitPushes: boolean;
  considerPaidServices: boolean;
}

export interface ReviewLogRuntimeContext {
  executionMode: ExecutionMode;
  distroName: string;
  mockMode: boolean;
  maxRepairCycles: number;
  interfaceCreationModel?: string;
  interfaceCreationReasoningEffort?: InterfaceReasoningEffort;
  agentReasoningMode?: AgentReasoningMode;
  agentReasoningEfforts?: AgentReasoningEfforts;
  autoApproveCommands: boolean;
  autoApproveGitCommits: boolean;
  autoApproveGitPushes: boolean;
  considerPaidServices: boolean;
}

export interface LinkedGitHubAccount {
  username: string;
  linkedAt: string;
}

export interface GitHubStatus {
  state: GitHubLinkState;
  username?: string;
  sshReady: boolean;
  message: string;
  checkedAt?: string;
}

export interface DiscoveredModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  supportedReasoningEfforts: InterfaceReasoningEffort[];
  defaultReasoningEffort?: InterfaceReasoningEffort;
  supportsPersonality: boolean;
  isDefault: boolean;
  labels: string[];
  recommendedForInterfaceCreation: boolean;
}

export interface CodexAvailability {
  source: ModelCatalogSource;
  message?: string;
  installedCodexVersion?: string;
  generatedProtocolVersion?: string;
  protocolCompatibility?: "compatible" | "installed-newer" | "installed-older" | "unknown";
}

export type RuntimeDependencyCheckStatus = "checking" | "passed" | "warning" | "failed";

export interface RuntimeDependencyCheck {
  id: string;
  label: string;
  status: RuntimeDependencyCheckStatus;
  message: string;
  fixInApp?: string;
  manualCommand?: string;
}

export interface RuntimeReadinessReport {
  status: "checking" | "ready" | "blocked";
  checkedAt?: string;
  summary: string;
  blockAgentActions: boolean;
  checks: RuntimeDependencyCheck[];
}

export interface UltimateGoal {
  summary: string;
  detailedIntent: string;
  successCriteria: string[];
  constraints: string[];
  nonGoals: string[];
  targetAudience: string;
  qualityBar: string;
  source: UltimateGoalSource;
  confirmedAt?: string;
  lastUpdatedAt?: string;
}

export interface WorkflowRecommendationOption {
  id: string;
  rank: number;
  title: string;
  summary: string;
  rationale: string;
  expectedImpact: string;
  priority: "high" | "medium" | "low";
  confidence: number;
  estimatedScope: "small" | "medium" | "large";
  riskLevel: RecommendationRiskLevel;
  relatedPaths: string[];
  sourceWorkPackageId?: string;
  targetedCheckIds?: string[];
}

export interface ApprovedRecommendation {
  id: string;
  recommendationId: string;
  rank: number;
  title: string;
  summary: string;
  rationale: string;
  expectedImpact: string;
  priority: "high" | "medium" | "low";
  confidence: number;
  estimatedScope: "small" | "medium" | "large";
  riskLevel: RecommendationRiskLevel;
  relatedPaths: string[];
  sourceWorkPackageId?: string;
  targetedCheckIds?: string[];
  approvedAt: string;
}

export interface ScopedGoal {
  id: string;
  sourceRecommendationId: string;
  sourceWorkPackageId?: string;
  summary: string;
  executionBrief: string;
  acceptanceCriteria: string[];
  constraints: string[];
  testStrategy: string[];
  targetedCheckIds?: string[];
  likelyPaths?: string[];
  createdAt: string;
}

export type GoalCheckStatus = "unknown" | "unmet" | "met" | "not_applicable";
export type GoalCheckItemKind = "required" | "backlog" | "observation";
export type GoalCheckAuditFlag =
  | "vague"
  | "not_observable"
  | "too_broad"
  | "duplicate"
  | "not_tied_to_goal"
  | "task_not_requirement"
  | "polish_not_required"
  | "impossible_to_validate";

export type GoalCheckSource =
  | "success_criterion"
  | "quality_bar"
  | "constraint"
  | "agent"
  | "deterministic";

export interface GoalCheckEvidenceHistoryEntry {
  checkId: string;
  title: string;
  source: GoalCheckSource;
  status: GoalCheckStatus;
  evidence: string;
  ownerAgentId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface GoalAttainmentCheck {
  id: string;
  title: string;
  description: string;
  required: boolean;
  itemKind: GoalCheckItemKind;
  canonicalKey?: string;
  groupId?: string;
  mergedInto?: string;
  sourceCheckIds?: string[];
  relatedCheckIds?: string[];
  auditFlags?: GoalCheckAuditFlag[];
  needsRefinement?: boolean;
  classificationReason?: string;
  promotionReason?: string;
  introducedCycleNumber?: number;
  status: GoalCheckStatus;
  confidence?: number;
  evidence: string;
  evidenceHistory?: GoalCheckEvidenceHistoryEntry[];
  source: GoalCheckSource;
  relatedPaths: string[];
  ownerAgentId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowTaskMapGroup {
  id: string;
  title: string;
  rationale: string;
  checkIds: string[];
  representativeChecks: string[];
  relatedPaths: string[];
  openCheckCount: number;
  metCheckCount: number;
  status: "open" | "in_progress" | "complete";
  priority: number;
}

export interface WorkflowTaskMap {
  groups: WorkflowTaskMapGroup[];
  totalRequiredChecks: number;
  openRequiredChecks: number;
  updatedAt: string;
}

export interface WorkPackage {
  id: string;
  title: string;
  summary: string;
  checkIds: string[];
  primaryTopic: string;
  likelyPaths: string[];
  estimatedBreadth: "small" | "medium" | "large";
  estimatedImpact: "low" | "medium" | "high";
  confidence: number;
  riskLevel: RecommendationRiskLevel;
  reason: string;
  acceptanceHints: string[];
  score: number;
}

export interface WorkflowCycle {
  cycleNumber: number;
  approvedRecommendationId?: string;
  approvedRecommendationTitle?: string;
  scopedGoalSummary?: string;
  acceptanceCriteria: string[];
  status: WorkflowCycleStatus;
  startedAt?: string;
  completedAt?: string;
}

export interface WorkflowPreviewRequest {
  status: WorkflowPreviewStatus;
  requestedAt?: string;
  startedAt?: string;
  completedAt?: string;
  remainingCycles?: number;
  modeBeforePreview?: WorkflowMode;
  autopilotWasEnabled?: boolean;
  reason?: string;
  evidence?: string[];
}

export interface WorkflowBudgets {
  maxRepairLoops: number;
  maxRecommendationOptions: number;
  maxCycleSummaries: number;
  maxAcceptedDecisions: number;
  maxOpenIssues: number;
  maxAgentRestartsPerCategory: number;
  maxCodingIterationsPerCycle: number;
  maxIntegrityRunsPerCycle: number;
}

export interface HumanInterventionRecord {
  id: string;
  kind: HumanInterventionKind;
  title: string;
  description: string;
  reason: string;
  requestedByAgentCategory: AgentCategory;
  severity: HumanInterventionSeverity;
  blocking: boolean;
  status: HumanInterventionStatus;
  linkedUserInputRequestId?: string;
  resolutionNotes?: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface UserInputRequestOption {
  label: string;
  description: string;
}

export interface UserInputRequestQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: UserInputRequestOption[];
}

export interface UserInputRequestAttachment {
  id: string;
  name: string;
  relativePath: string;
  sizeBytes: number;
  addedAt: string;
}

export interface UserInputRequestRecord {
  id: string;
  agentId: string;
  requestedByAgentCategory: AgentCategory;
  threadId: string;
  turnId?: string;
  itemId?: string;
  serverRequestId: string | number;
  humanInterventionId?: string;
  title: string;
  description: string;
  questions: UserInputRequestQuestion[];
  attachmentInboxPath: string;
  attachmentInboxRelativePath: string;
  attachments: UserInputRequestAttachment[];
  status: UserInputRequestStatus;
  createdAt: string;
  submittedAt?: string;
}

export interface CredentialRequestRecord {
  id: string;
  providerName: string;
  keyLabel: string;
  description: string;
  status: CredentialRequestStatus;
  requestedByAgentCategory?: AgentCategory;
  agentId?: string;
  userInputRequestId?: string;
  humanInterventionId?: string;
  freeOnly?: boolean;
  createdAt: string;
  resolvedAt?: string;
  submittedToAgentAt?: string;
  notes?: string;
}

export interface CredentialEntryMetadata {
  id: string;
  providerName: string;
  keyLabel: string;
  hasApiKey: boolean;
  hasSecretKey: boolean;
  status: CredentialEntryStatus;
  source?: "user" | "agent_auto";
  freeTier?: boolean;
  notes?: string;
  linkedRequestIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectCredentialsState {
  entries: CredentialEntryMetadata[];
  requests: CredentialRequestRecord[];
}

export interface WorkflowCycleSummary {
  cycleNumber: number;
  summary: string;
  openIssueIds: string[];
  createdAt: string;
}

export interface WorkflowAcceptedDecision {
  id: string;
  kind: WorkflowDecisionKind;
  title: string;
  summary: string;
  decidedAt: string;
  cycleNumber?: number;
  sourceAgentCategory?: AgentCategory;
}

export interface WorkflowOpenIssue {
  id: string;
  title: string;
  detail: string;
  source: "recommendation" | "goal" | "coding" | "integrity" | "merge" | "human" | "system";
  status: "open" | "resolved";
  recordedAt: string;
  resolvedAt?: string;
}

export interface AgentFreshnessMarker {
  restartCount: number;
  freshnessToken: number;
  lastRestartedAt?: string;
  lastSummarizedAt?: string;
}

export interface WorkflowContextDescriptor {
  id: string;
  cycleNumber: number;
  agentCategory: AgentCategory;
  workflowStage: WorkflowStage;
  goalTokens: string[];
  workTypeTags: string[];
  changedPaths: string[];
  relatedPaths: string[];
  acceptedDecisionIds: string[];
  openIssueIds: string[];
  resolvedIssueIds: string[];
  summary: string;
  featureWeights: Record<string, number>;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRelevantContextSelection {
  descriptorId: string;
  cycleNumber: number;
  agentCategory: AgentCategory;
  score: number;
  reasons: string[];
  summary: string;
  paths: string[];
  decisionIds: string[];
  issueIds: string[];
}

export interface WorkflowMemory {
  canonicalSummary: string;
  canonicalFacts: string[];
  perCycleSummaries: WorkflowCycleSummary[];
  lastAcceptedDecisions: WorkflowAcceptedDecision[];
  knownOpenIssues: WorkflowOpenIssue[];
  agentFreshness: Partial<Record<AgentCategory, AgentFreshnessMarker>>;
  contextDescriptors: WorkflowContextDescriptor[];
  lastRelevantContext: WorkflowRelevantContextSelection[];
}

export interface WorkflowActivityEvent {
  id: string;
  timestamp: string;
  source: WorkflowActivitySource;
  status: WorkflowEventStatus;
  title: string;
  detail?: string;
  stepId?: WorkflowStepId;
  agentId?: string;
  agentCategory?: AgentCategory;
}

export interface AutopilotRuntimeStatus {
  enabled: boolean;
  profile: AutopilotProfile;
  workflowMode: WorkflowMode;
  stage: WorkflowStage;
  cycleNumber: number;
  currentRecommendationId?: string;
  currentRecommendationTitle?: string;
  lastCompletedAction?: string;
  nextPlannedAction?: string;
  pausedReason?: AutopilotPauseReason;
  pausedDetail?: string;
  highRiskPackageRequiresApproval: boolean;
  updatedAt: string;
}

export interface WorkflowManualHandoff {
  reason: "repair_exhausted" | "repair_stopped_early" | "merge_conflicts";
  title: string;
  whatSystemWasTryingToDo: string;
  validationIssue: string;
  latestFailureReason: string;
  involvedPaths: string[];
  shellSupported: boolean;
  createdAt: string;
  lastOpenedAt?: string;
  lastOpenError?: string;
}

export interface WorkflowRepairState {
  attemptCount: number;
  maxAttempts: number;
  status: WorkflowRepairStatus;
  latestIssueSummary?: string;
  latestFailureReason?: string;
  lastUpdatedAt?: string;
}

export interface WorkflowAppealState {
  status: WorkflowAppealStatus;
  reason?: string;
  startedAt?: string;
  completedAt?: string;
  cycleNumber?: number;
}

export interface WorkflowStepProgress {
  stepId: WorkflowStepId;
  status: WorkflowStepStatus;
  requiresUserInput: boolean;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  lastEventAt?: string;
  currentActivity?: string;
  currentSubstep?: string;
  latestProgressNote?: string;
  blockedReason?: string;
  message?: string;
  warning?: string;
  runCount: number;
  attemptCount: number;
  agentCategory?: AgentCategory;
}

export interface UltimateGoalProgressEstimate {
  percentComplete: number;
  rationale: string;
  source: UltimateGoalProgressSource;
  updatedAt: string;
}

export interface UltimateGoalCompletionAssessment {
  state: UltimateGoalCompletionState;
  rationale: string;
  source: UltimateGoalProgressSource;
  updatedAt: string;
}

export interface ProjectWorkflowState {
  ultimateGoal: UltimateGoal;
  ultimateGoalDraft?: UltimateGoal;
  workflowMode: WorkflowMode;
  previewRequest?: WorkflowPreviewRequest;
  autopilotPolicy: AutopilotPolicy;
  autopilotStatus?: AutopilotRuntimeStatus;
  ultimateGoalProgress?: UltimateGoalProgressEstimate;
  ultimateGoalCompletion?: UltimateGoalCompletionAssessment;
  goalChecklist: GoalAttainmentCheck[];
  taskMap: WorkflowTaskMap;
  workPackages: WorkPackage[];
  workflowCycle: WorkflowCycle;
  approvedRecommendation?: ApprovedRecommendation;
  scopedGoal?: ScopedGoal;
  workflowStage: WorkflowStage;
  repairLoopCount: number;
  appeal: WorkflowAppealState;
  repair: WorkflowRepairState;
  workflowBudgets: WorkflowBudgets;
  workflowStopReason: WorkflowStopReason;
  manualHandoff?: WorkflowManualHandoff;
  humanInterventions: HumanInterventionRecord[];
  recommendations: WorkflowRecommendationOption[];
  recommendationsGeneratedAt?: string;
  stepProgress: Record<WorkflowStepId, WorkflowStepProgress>;
  memory: WorkflowMemory;
  activityLog: WorkflowActivityEvent[];
}

export interface ResolvedProjectPath {
  kind: ProjectPathKind;
  inputPath: string;
  displayPath: string;
  wslPath: string;
  hostPath: string;
  distroName?: string;
  mountWarning: boolean;
}

export interface ProjectIdentity {
  version: number;
  fingerprint: string;
  projectName: string;
  kind: ProjectKind;
  repositoryName?: string;
  gitRoot?: string;
  selectedSubpath?: string;
  normalizedRemotes: string[];
  rootCommit?: string;
  manifestSignature: string;
  treeSignature: string;
}

export interface ValidationSnapshot {
  interfaceSchemaVersion: number;
  appMinVersion: string;
  lastValidatedAt?: string;
  gitHead?: string;
  branch?: string;
  manifestHash?: string;
  treeHash?: string;
  projectAccess?: ProjectAccessProbe;
  projectKind: ProjectKind;
}

export interface ProjectAccessProbe {
  status: "passed" | "failed";
  checkedAt: string;
  probeFileName: string;
  executionPath: string;
  hostPath: string;
  message: string;
  error?: string;
}

export interface InterfacePreview {
  projectName: string;
  summarySnippet: string;
  agentPanelCount: number;
  repoTreeReady: boolean;
  overviewReady: boolean;
  versionSummary: string;
  lastOpenedAt?: string;
  validationStatus: ValidationStatus;
  subsystemCount: number;
  pathSummaryCount: number;
  dependencyCount: number;
  contentSource: SummarySource;
}

export interface ProjectStats {
  projectRoot: string;
  kind: ProjectKind;
  createdAt?: string;
  lastCommitAt?: string;
  totalFiles: number;
  totalFolders: number;
  totalSizeBytes: number;
  includedFiles: number;
  includedFolders: number;
  includedSizeBytes: number;
  excludedFiles: number;
  excludedFolders: number;
  excludedSizeBytes: number;
  excludedPaths: Array<{
    path: string;
    kind: "file" | "directory";
    rule: "default" | "gitignore";
    fileCount: number;
    totalSizeBytes: number;
  }>;
  fileTypeBreakdown: Record<string, number>;
  languageBreakdown: Record<string, number>;
  entryPoints: string[];
  manifestFiles: string[];
  testsPresent: boolean;
  primaryManagers: string[];
  explanation: string;
}

export interface DependencyRecord {
  manifest: string;
  ecosystem: string;
  name: string;
  version: string;
  dev?: boolean;
}

export interface RepoTreeNode {
  path: string;
  name: string;
  type: "file" | "directory";
  size?: number;
  language?: string;
  children?: RepoTreeNode[];
}

export interface FileSummary {
  relativePath: string;
  pathKind: "file" | "directory";
  contentHash: string;
  title: string;
  purpose: string;
  summary: string;
  keySymbols: string[];
  relatedFiles: string[];
  confidence: number;
  source: SummarySource;
  generatedAt: string;
}

export interface ProjectSubsystemSummary {
  name: string;
  summary: string;
  paths: string[];
}

export interface ProjectOverview {
  summary: string;
  architecture: string;
  whatProjectDoes?: string;
  howItIsOrganized?: string;
  importantToKnowFirst?: string;
  importantFiles: string[];
  subsystemSummaries: ProjectSubsystemSummary[];
  dependencyHighlights: string[];
  statisticsSummary?: string;
  recommendations: string[];
  source: SummarySource;
  generatedAt: string;
}

export interface LayoutConfig {
  leftPanelWidth: number;
  rightPanelWidth: number;
  bottomPanelHeight: number;
  activeCenterTab: WorkspaceCenterTab;
}

export interface LocalProjectState {
  selectedFile?: string;
  treeFilter: string;
  activeAgentId?: string;
  autopilotEnabled: boolean;
  workflowObjective: WorkflowObjective;
  workflowPauseRequested: boolean;
  lastOpenedAt?: string;
}

export interface InterfaceCreationState {
  status: InterfaceCreationStatus;
  phase: string;
  message: string;
  model?: string;
  reasoningEffort?: InterfaceReasoningEffort;
  selectedModelSource: "user" | "recommended";
  deterministicScanReady: boolean;
  agentAnalysisReady: boolean;
  outputSource: SummarySource;
  startedAt?: string;
  completedAt?: string;
  lastError?: string;
}

export interface WorktreeAssignment {
  baseDir: string;
  worktreePath: string;
  branch: string;
  targetBranch?: string;
}

export interface ApprovalRequestRecord {
  id: string;
  agentId: string;
  kind: ApprovalKind;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  serverRequestId?: string | number;
  summary: string;
  reason?: string;
  command?: string;
  cwd?: string;
  filePaths: string[];
  createdAt: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  availableDecisions: ApprovalDecision[];
}

export interface AgentCommandExecution {
  itemId?: string;
  command: string;
  cwd?: string;
  output: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  exitCode?: number | null;
}

export interface RuntimeEventRecord {
  id: string;
  agentId: string;
  timestamp: string;
  type:
    | "thread"
    | "turn"
    | "item"
    | "message"
    | "command"
    | "file-change"
    | "approval"
    | "report"
    | "raw";
  status?: WorkflowEventStatus;
  stepId?: WorkflowStepId;
  agentCategory?: AgentCategory;
  itemId?: string;
  title: string;
  detail?: string;
  raw?: unknown;
}

export interface IntegrityReport {
  summary: string;
  checks: Array<{
    name: string;
    command: string;
    status: "passed" | "failed" | "skipped";
    outputSnippet: string;
  }>;
  risks: string[];
  generatedAt: string;
}

export interface MergeReport {
  summary: string;
  targetBranch?: string;
  mergedBranches: string[];
  conflicts: string[];
  conflictCycleCount: number;
  generatedAt: string;
}

export interface RecommendationReport {
  summary: string;
  ultimateGoalProgress?: Pick<UltimateGoalProgressEstimate, "percentComplete" | "rationale">;
  nextSteps: Array<{
    rank: number;
    title: string;
    summary: string;
    rationale: string;
    expectedImpact: string;
    priority: "high" | "medium" | "low";
    confidence: number;
    estimatedScope: "small" | "medium" | "large";
    riskLevel: RecommendationRiskLevel;
    relatedPaths: string[];
  }>;
  generatedAt: string;
}

export interface StructuredOutputApplication {
  kind: "recommendation" | "scoped_goal";
  contentHash: string;
  appliedAt: string;
  source?: string;
}

export interface AgentState {
  id: string;
  category: AgentCategory;
  name: string;
  taskPrompt: string;
  model: string;
  reasoningEffort?: InterfaceReasoningEffort;
  reasoningEffortSource?: AgentReasoningMode;
  workflowCycleNumber?: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  threadId?: string;
  status: AgentLifecycleStatus;
  currentPhase?: string;
  currentSubtask?: string;
  lastActivityAt?: string;
  lastMessageSnippet?: string;
  worktree?: WorktreeAssignment;
  changedFiles: string[];
  approvals: ApprovalRequestRecord[];
  commandLog: AgentCommandExecution[];
  events: RuntimeEventRecord[];
  disconnectedReason?: string;
  recoveryHandledAt?: string;
  integrityReport?: IntegrityReport;
  mergeReport?: MergeReport;
  recommendationReport?: RecommendationReport;
  appliedStructuredOutputs?: StructuredOutputApplication[];
}

export type AgentHistoryScope = "all" | "workflow" | "manual";

export interface AgentListResponse {
  projectId: string;
  scope: AgentHistoryScope;
  offset: number;
  limit: number;
  total: number;
  agents: AgentState[];
}

export interface ProjectCommandLogEntry {
  id: string;
  agentId: string;
  agentName: string;
  agentCategory: AgentCategory;
  itemId?: string;
  command: string;
  cwd?: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  exitCode?: number | null;
}

export interface ProjectLogFeedResponse {
  projectId: string;
  activity: {
    offset: number;
    limit: number;
    total: number;
    entries: WorkflowActivityEvent[];
  };
  commands: {
    offset: number;
    limit: number;
    total: number;
    entries: ProjectCommandLogEntry[];
  };
}

export interface PortableProjectInterface {
  schemaVersion: number;
  appMinVersion: string;
  exportedAt: string;
  checksum: string;
  identity: ProjectIdentity;
  validation: ValidationSnapshot;
  layout: LayoutConfig;
  localStateDefaults: LocalProjectState;
  workflow: ProjectWorkflowState;
  overview?: ProjectOverview;
  stats?: ProjectStats;
  dependencies: DependencyRecord[];
  summaryCache: FileSummary[];
  agents: AgentState[];
}

export interface LocalProjectRecord {
  id: string;
  displayPath: string;
  wslPath: string;
  projectRoot: string;
  hostPath: string;
  distroName?: string;
  identity: ProjectIdentity;
  validation: ValidationSnapshot;
  interfacePath?: string;
  layout: LayoutConfig;
  localState: LocalProjectState;
  workflow: ProjectWorkflowState;
  interfaceCreation?: InterfaceCreationState;
  overview?: ProjectOverview;
  stats?: ProjectStats;
  dependencies: DependencyRecord[];
  summaryCache: FileSummary[];
  agents: AgentState[];
  userInputRequests: UserInputRequestRecord[];
  credentials: ProjectCredentialsState;
}

export interface ReviewLogSummary {
  projectName: string;
  projectKind: ProjectKind;
  validationStatus: ValidationStatus;
  workflowStage: WorkflowStage;
  workflowStopReason: WorkflowStopReason;
  cycleNumber: number;
  autopilotEnabled: boolean;
  workflowObjective: WorkflowObjective;
  workflowPauseRequested: boolean;
  totalAgents: number;
  totalCommands: number;
  totalEvents: number;
  totalApprovals: number;
  pendingApprovals: number;
  pendingUserInputRequests: number;
  openIssues: number;
  agentCountsByCategory: Record<AgentCategory, number>;
  agentCountsByStatus: Record<AgentLifecycleStatus, number>;
}

export interface ReviewLogTimelineEntry {
  timestamp: string;
  source: "workflow" | "agent";
  sourceLabel: string;
  agentId?: string;
  agentCategory?: AgentCategory;
  status: WorkflowEventStatus;
  title: string;
  detail?: string;
}

export interface ReviewLogProjectSnapshot {
  id: string;
  identity: ProjectIdentity;
  validation: ValidationSnapshot;
  localState: LocalProjectState;
  workflow: ProjectWorkflowState;
  interfaceCreation?: InterfaceCreationState;
  overview?: ProjectOverview;
  stats?: ProjectStats;
  dependencies: DependencyRecord[];
}

export interface ProjectReviewLogBundle {
  schemaVersion: number;
  appVersion: string;
  exportedAt: string;
  context: ReviewLogRuntimeContext;
  summary: ReviewLogSummary;
  redactions: string[];
  warnings: string[];
  project: ReviewLogProjectSnapshot;
  agents: AgentState[];
  userInputRequests: UserInputRequestRecord[];
  diagnostics: string[];
  timeline: ReviewLogTimelineEntry[];
}

export interface InterfaceCandidate {
  source: "portable" | "local";
  label: string;
  path: string;
  preview: InterfacePreview;
  validationStatus: ValidationStatus;
  data: PortableProjectInterface | LocalProjectRecord;
}

export interface ProjectLoadResult {
  resolvedPath: ResolvedProjectPath;
  projectRoot: string;
  projectHostPath: string;
  identity: ProjectIdentity;
  validation: ValidationSnapshot;
  stats: ProjectStats;
  dependencies: DependencyRecord[];
  tree: RepoTreeNode[];
  overview?: ProjectOverview;
  interfaceCandidates: InterfaceCandidate[];
}

export interface LoadedProjectView {
  record: LocalProjectRecord;
  tree: RepoTreeNode[];
  validationStatus: ValidationStatus;
  candidates: InterfaceCandidate[];
}

export interface ProjectRepositoryView {
  projectId: string;
  tree: RepoTreeNode[];
  dependencies: DependencyRecord[];
  summaryCache: FileSummary[];
}

export interface OpenProjectShellResult {
  launched: boolean;
  message: string;
}

export type UltimateGoalImportField =
  | "summary"
  | "detailedIntent"
  | "successCriteria"
  | "constraints"
  | "nonGoals"
  | "qualityBar"
  | "targetAudience";

export interface UltimateGoalImportPreview {
  sourceFileName: string;
  goal: Omit<UltimateGoal, "confirmedAt" | "lastUpdatedAt">;
  populatedFields: UltimateGoalImportField[];
  missingFields: UltimateGoalImportField[];
  warnings: string[];
  completeness: "complete" | "partial";
}

export interface WorkbenchState {
  settings: AppSettings;
  github: GitHubStatus;
  projects: LoadedProjectView[];
  activeProjectId?: string;
  availableModels: DiscoveredModel[];
  codexAvailability: CodexAvailability;
  runtimeReadiness: RuntimeReadinessReport;
  diagnostics: string[];
}
