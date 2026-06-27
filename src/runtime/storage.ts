import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { APP_VERSION, PORTABLE_INTERFACE_PATH, REVIEW_LOG_BUNDLE_VERSION } from "@shared/constants";
import { createPortableInterface } from "@shared/defaults";
import { localProjectRecordSchema, portableInterfaceSchema, projectReviewLogBundleSchema, projectWorkflowStateSchema } from "@shared/schemas";
import type {
  AgentCategory,
  AgentLifecycleStatus,
  AgentTranscriptEntry,
  AppSettings,
  LocalProjectRecord,
  PortableProjectInterface,
  ProjectReviewLogBundle,
  ReviewLogCycleDiagnostics,
  ReviewLogEvidenceObservationSummary,
  ReviewLogRedactionStatus,
  ReviewLogRuntimeContext,
  ReviewLogSummary,
  ReviewLogTimelineEntry,
  ReviewLogWorkflowDiagnostics
} from "@shared/types";
import { nowIso, stableStringify, unique } from "@shared/utils";
import { deriveUserFacingWorkflowStatus } from "@shared/workflowView";
import {
  cycleContractForCycle,
  deriveLegacyWorkflowDiagnostics,
  workflowCycleTaskSeparation
} from "@shared/workflowMigration";
import { sha256 } from "./hashUtils";
import { assertHostPathWithinProjectRoot } from "./projectBoundary";
import { sanitizeProjectRecord, STATE_SANITIZER_VERSION, type StateSanitizerReport } from "./stateSanitizer";

type PathReplacement = {
  from: string;
  to: string;
};

export interface SecretStorageCodec {
  encryptString(value: string): Buffer;
  decryptString(encrypted: Buffer): string;
  isEncryptionAvailable(): boolean;
}

export interface CredentialSecretInput {
  apiKey: string;
  secretKey?: string;
}

type StoredSecretValue = {
  encoding: "safeStorage" | "plain";
  value: string;
};

type CredentialSecretStore = {
  version: 1;
  entries: Record<string, {
    apiKey: StoredSecretValue;
    secretKey?: StoredSecretValue;
    updatedAt: string;
  }>;
};

type ProjectStateParseResult =
  | { ok: true; value: unknown }
  | { ok: false; issue: ProjectStateIssueKind; message: string };

type ProjectStateIssueKind =
  | "malformed_json"
  | "duplicate_appended_json"
  | "state_too_large_to_load"
  | "schema_invalid";

export interface ProjectStateValidationResult {
  ok: boolean;
  statePath: string;
  sizeBytes: number;
  issue?: ProjectStateIssueKind;
  message?: string;
  parsed?: unknown;
  shouldCompact: boolean;
}

export interface StateLoadIssue {
  projectId: string;
  statePath: string;
  action: "compacted" | "quarantined" | "ignored" | "warning";
  message: string;
  quarantinePath?: string;
}

type AgentTranscriptStore = {
  version: 1;
  projectId: string;
  agentId: string;
  agentName: string;
  updatedAt: string;
  entries: AgentTranscriptEntry[];
};

type AgentFullOutputStore = {
  version: 1;
  projectId: string;
  agentId: string;
  agentName?: string;
  workflowCycleNumber?: number;
  updatedAt: string;
  output: string;
};

export type RepositoryIndexEntry = {
  relativePath: string;
  size: number;
  language: string;
};

export type RepositoryIndexStore = {
  version: 1;
  projectId: string;
  savedAt: string;
  projectRoot: string;
  treeHash?: string;
  scanMode?: "normal" | "deep";
  files: RepositoryIndexEntry[];
};

export const PROJECT_STATE_WARNING_BYTES = 750_000;
export const PROJECT_STATE_COMPACT_BYTES = 1_500_000;
export const PROJECT_STATE_HARD_LOAD_BYTES = 24_000_000;

const SIDE_CAR_PRESERVE_TEXT_BYTES = 12_000;
const SIDE_CAR_PRESERVE_EVENT_BYTES = 8_000;

const buildReviewLogRuntimeContext = (settings: AppSettings): ReviewLogRuntimeContext => ({
  executionMode: settings.executionMode,
  distroName: settings.distroName,
  mockMode: settings.mockMode,
  maxRepairCycles: settings.maxRepairCycles,
  interfaceCreationModel: settings.interfaceCreationModel,
  interfaceCreationReasoningEffort: settings.interfaceCreationReasoningEffort,
  agentReasoningMode: settings.agentReasoningMode,
  agentReasoningEfforts: settings.agentReasoningEfforts,
  autoApproveCommands: settings.autoApproveCommands,
  autoApproveGitCommits: settings.autoApproveGitCommits,
  autoApproveGitPushes: settings.autoApproveGitPushes,
  considerPaidServices: settings.considerPaidServices
});

const createAgentCategoryCounts = (): Record<AgentCategory, number> => ({
  bootstrap: 0,
  goal: 0,
  coding: 0,
  integrity: 0,
  merge: 0,
  recommendation: 0,
  manual: 0
});

const createAgentLifecycleStatusCounts = (): Record<AgentLifecycleStatus, number> => ({
  idle: 0,
  starting: 0,
  running: 0,
  waiting_approval: 0,
  completed: 0,
  failed: 0,
  conflicted: 0,
  disconnected: 0
});

const buildReviewLogSummary = (record: LocalProjectRecord): ReviewLogSummary => {
  const agentCountsByCategory = createAgentCategoryCounts();
  const agentCountsByStatus = createAgentLifecycleStatusCounts();
  let totalCommands = 0;
  let totalEvents = 0;
  let totalApprovals = 0;
  let pendingApprovals = 0;

  for (const agent of record.agents) {
    agentCountsByCategory[agent.category] += 1;
    agentCountsByStatus[agent.status] += 1;
    totalCommands += agent.commandLog.length;
    totalEvents += agent.events.length;
    totalApprovals += agent.approvals.length;
    pendingApprovals += agent.approvals.filter((approval) => approval.status === "pending").length;
  }

  return {
    projectName: record.identity.projectName,
    projectKind: record.identity.kind,
    validationStatus: record.validation.lastValidatedAt ? "exact" : "unvalidated",
    workflowStage: record.workflow.workflowStage,
    workflowStopReason: record.workflow.workflowStopReason,
    cycleNumber: record.workflow.workflowCycle.cycleNumber,
    autopilotEnabled: record.localState.autopilotEnabled,
    workflowObjective: record.localState.workflowObjective,
    workflowPauseRequested: record.localState.workflowPauseRequested,
    totalAgents: record.agents.length,
    totalCommands,
    totalEvents,
    totalApprovals,
    pendingApprovals,
    pendingUserInputRequests: record.userInputRequests.filter((request) => request.status === "pending").length,
    openIssues: record.workflow.memory.knownOpenIssues.filter((issue) => issue.status === "open").length,
    agentCountsByCategory,
    agentCountsByStatus
  };
};

const buildReviewTimeline = (record: LocalProjectRecord): ReviewLogTimelineEntry[] => {
  const workflowEntries: ReviewLogTimelineEntry[] = record.workflow.activityLog.map((event) => ({
    timestamp: event.timestamp,
    source: "workflow",
    sourceLabel: event.agentCategory ? `${event.source}:${event.agentCategory}` : event.source,
    agentId: event.agentId,
    agentCategory: event.agentCategory,
    status: event.status,
    title: event.title,
    detail: event.detail
  }));

  const agentEntries: ReviewLogTimelineEntry[] = record.agents.flatMap((agent) =>
    agent.events.map((event) => ({
      timestamp: event.timestamp,
      source: "agent",
      sourceLabel: agent.name,
      agentId: agent.id,
      agentCategory: agent.category,
      status: event.status ?? "info",
      title: event.title,
      detail: event.detail
    }))
  );

  return [...workflowEntries, ...agentEntries].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
};

const reviewLogRedactionStatus = (): ReviewLogRedactionStatus => ({
  localPathsRedacted: true,
  secretsRedacted: true,
  fullCommandOutputIncluded: false,
  note: "Diagnostics include summarized/redacted workflow objects and command summaries; retained full-output sidecars are not embedded in this review log."
});

const latestByTime = <T,>(entries: T[], getTime: (entry: T) => string | undefined): T | undefined =>
  entries.slice().sort((left, right) => (Date.parse(getTime(right) ?? "") || 0) - (Date.parse(getTime(left) ?? "") || 0))[0];

const evidenceObservationSummary = (
  observation: LocalProjectRecord["workflow"]["evidenceObservations"][number]
): ReviewLogEvidenceObservationSummary => ({
  observationId: observation.observationId,
  cycleNumber: observation.cycleNumber,
  checkId: observation.checkId,
  status: observation.status,
  evidenceText: observation.evidenceText,
  evidenceSourceType: observation.evidenceSourceType,
  sourceKey: observation.sourceRef.sourceKey,
  relevantPaths: observation.relevantPaths,
  validationCommands: observation.validationCommands,
  confidence: observation.confidence,
  consumedByChecklist: observation.consumedByChecklist,
  notConsumedReason: observation.notConsumedReason
});

const reviewCycleDiagnostics = (
  record: LocalProjectRecord,
  cycleNumber: number,
  redactionStatus: ReviewLogRedactionStatus
): ReviewLogCycleDiagnostics => {
  const workflow = record.workflow;
  const taskSeparation = workflowCycleTaskSeparation(workflow, cycleNumber);
  const cycleAgents = record.agents.filter((agent) =>
    agent.workflowCycleNumber === undefined || agent.workflowCycleNumber === cycleNumber
  );
  const validationLedger = latestByTime(
    workflow.validationLedgers.filter((ledger) => ledger.cycleNumber === cycleNumber),
    (ledger) => ledger.updatedAt
  );
  const repoHygieneReport = latestByTime(
    workflow.repoHygieneReports.filter((report) => report.scannedRef.includes(`:${cycleNumber}`)),
    (report) => report.scannedAt
  ) ?? (cycleNumber === workflow.workflowCycle.cycleNumber ? latestByTime(workflow.repoHygieneReports, (report) => report.scannedAt) : undefined);
  return {
    cycleNumber,
    cycleStartedWithTask: taskSeparation.cycleStartedWithTask,
    completedTask: taskSeparation.completedTask,
    nextRecommendedTask: taskSeparation.nextRecommendedTask,
    cycleContract: cycleContractForCycle(workflow, cycleNumber),
    checklistDelta: latestByTime(
      [
        ...workflow.checklistDeltas.filter((delta) => delta.cycleNumber === cycleNumber),
        ...workflow.cycleRetrospectives.filter((entry) => entry.cycleNumber === cycleNumber).flatMap((entry) => entry.checklistDelta ? [entry.checklistDelta] : [])
      ],
      (delta) => delta.createdAt
    ),
    evidenceObservations: workflow.evidenceObservations
      .filter((observation) => observation.cycleNumber === cycleNumber)
      .slice(0, 80)
      .map(evidenceObservationSummary),
    validationLedger,
    recommendationHealth: workflow.recommendationHealth,
    repoHygieneReport,
    derivedStatus: cycleNumber === workflow.workflowCycle.cycleNumber
      ? deriveUserFacingWorkflowStatus(workflow, {
        agents: cycleAgents,
        validationLedger,
        repoHygieneReport,
        workflowPauseRequested: record.localState.workflowPauseRequested
      })
      : undefined,
    evidenceCommands: workflow.evidenceCommands.slice(0, 30),
    redactionStatus
  };
};

const cloneRecordForReviewExport = (record: LocalProjectRecord, exportedAt: string): LocalProjectRecord => {
  const workflow = projectWorkflowStateSchema.parse(JSON.parse(JSON.stringify(record.workflow)));
  deriveLegacyWorkflowDiagnostics(workflow, {
    agents: record.agents,
    now: exportedAt,
    deriveChecklistDelta: true,
    deriveValidationLedger: true,
    deriveRepoHygiene: true
  });
  return {
    ...record,
    workflow
  };
};

const buildReviewWorkflowDiagnostics = (record: LocalProjectRecord): ReviewLogWorkflowDiagnostics => {
  const redactionStatus = reviewLogRedactionStatus();
  const activeCycleNumber = record.workflow.workflowCycle.cycleNumber;
  const cycleNumbers = unique([
    activeCycleNumber,
    ...record.workflow.cycleRetrospectives.map((entry) => entry.cycleNumber),
    ...record.workflow.validationLedgers.map((entry) => entry.cycleNumber),
    ...record.workflow.checklistDeltas.map((entry) => entry.cycleNumber),
    ...record.workflow.evidenceObservations.map((entry) => entry.cycleNumber)
  ])
    .sort((left, right) => right - left)
    .slice(0, 40);
  return {
    activeCycle: reviewCycleDiagnostics(record, activeCycleNumber, redactionStatus),
    cycles: cycleNumbers.map((cycleNumber) => reviewCycleDiagnostics(record, cycleNumber, redactionStatus)),
    redactionStatus
  };
};

const toPathVariants = (value: string | undefined): string[] => {
  if (!value) {
    return [];
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed === path.sep || trimmed === "/") {
    return [];
  }

  return unique([
    trimmed,
    trimmed.replace(/\\/g, "/"),
    trimmed.replace(/\//g, "\\")
  ]).filter((entry) => entry.length > 1);
};

const collectPathReplacements = (record: LocalProjectRecord): PathReplacement[] => {
  const replacements: PathReplacement[] = [];
  const add = (value: string | undefined, alias: string): void => {
    for (const variant of toPathVariants(value)) {
      replacements.push({ from: variant, to: alias });
    }
  };

  add(record.displayPath, "<project-root>");
  add(record.hostPath, "<project-root>");
  add(record.projectRoot, "<project-root>");
  add(record.wslPath, "<project-root>");

  for (const request of record.userInputRequests) {
    add(request.attachmentInboxPath, "<user-input-inbox>");
  }

  for (const agent of record.agents) {
    add(agent.worktree?.baseDir, "<managed-worktrees>");
    add(agent.worktree?.worktreePath, "<agent-worktree>");
  }

  return replacements
    .filter((replacement) => replacement.from !== replacement.to)
    .sort((left, right) => right.from.length - left.from.length);
};

const redactString = (value: string, replacements: PathReplacement[]): string => {
  let next = value;
  for (const replacement of replacements) {
    next = next.split(replacement.from).join(replacement.to);
  }
  return next
    .replace(/AGENT_WORKBENCH_CREDENTIAL\s+({[^\r\n]+})/g, "AGENT_WORKBENCH_CREDENTIAL [redacted]")
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g, "[redacted-secret]")
    .replace(/\b(?:ghp|github_pat)_[A-Za-z0-9_]{16,}\b/g, "[redacted-token]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[redacted-access-key]")
    .replace(/\b(?:[A-Za-z]:\\Users\\[^\s"'`]+|\/(?:home|Users|mnt|var|tmp|private|Volumes)\/[^\s"'`]+)/g, "<local-path>")
    .replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted-token]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [redacted]")
    .replace(
      /\b(api[_\s-]?key|secret(?:[_\s-]?key)?|token|access[_\s-]?token|refresh[_\s-]?token|client[_\s-]?secret|authorization|password)\b(\s*[:=]\s*["']?)([A-Za-z0-9_./+=~:-]{12,})(["']?)/gi,
      "$1$2[redacted]$4"
    )
    .replace(/(--(?:api-key|token|secret|password)\s+)(\S{8,})/gi, "$1[redacted]")
    .replace(/([?&](?:api[_-]?key|key|token|secret|access_token|client_secret)=)([^&\s]+)/gi, "$1[redacted]");
};

const sanitizeReviewValue = (value: unknown, replacements: PathReplacement[]): unknown => {
  if (typeof value === "string") {
    return redactString(value, replacements);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeReviewValue(entry, replacements));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, sanitizeReviewValue(entry, replacements)])
    );
  }

  return value;
};

const buildRedactionNotes = (record: LocalProjectRecord): string[] => {
  const notes = ["Project root paths were replaced with <project-root>."];
  notes.push("Local credential metadata and secret values were excluded.");
  notes.push("Common API key, token, bearer credential, and password-looking values were masked.");

  if (record.agents.some((agent) => agent.worktree)) {
    notes.push("Managed worktree paths were replaced with <managed-worktrees> and <agent-worktree>.");
  }

  if (record.userInputRequests.some((request) => request.attachmentInboxPath)) {
    notes.push("User input attachment inbox paths were replaced with <user-input-inbox>.");
  }

  return notes;
};

export class WorkbenchStorage {
  private readonly writeQueues = new Map<string, Promise<void>>();
  private readonly loadIssues: StateLoadIssue[] = [];
  private readonly debugState = process.env.AWB_DEBUG_STATE === "1";
  private readonly debugPerf = process.env.WORKBENCH_PERF === "1" || process.env.AWB_DEBUG_WORKFLOW_PERF === "1";

  constructor(
    private readonly appDataDir: string,
    private readonly secretCodec?: SecretStorageCodec
  ) {}

  private buildPortableInterfacePayload(record: LocalProjectRecord): PortableProjectInterface {
    const portable = createPortableInterface(record);
    const payloadWithoutChecksum = {
      ...portable,
      checksum: ""
    };
    const checksum = sha256(stableStringify(payloadWithoutChecksum));
    const finalPayload: PortableProjectInterface = {
      ...portable,
      checksum
    };

    portableInterfaceSchema.parse(finalPayload);
    return finalPayload;
  }

  private buildReviewLogBundlePayload(
    record: LocalProjectRecord,
    settings: AppSettings,
    diagnostics: string[]
  ): ProjectReviewLogBundle {
    const exportedAt = nowIso();
    const exportRecord = cloneRecordForReviewExport(record, exportedAt);
    const bundle: ProjectReviewLogBundle = {
      schemaVersion: REVIEW_LOG_BUNDLE_VERSION,
      appVersion: APP_VERSION,
      exportedAt,
      context: buildReviewLogRuntimeContext(settings),
      summary: buildReviewLogSummary(exportRecord),
      redactions: buildRedactionNotes(exportRecord),
      warnings: [
        "Project/worktree paths and common secret-looking values were redacted, but repository content may still contain project-sensitive information.",
        "The bundle only includes the workflow, events, and command output currently retained by the app."
      ],
      workflowDiagnostics: buildReviewWorkflowDiagnostics(exportRecord),
      project: {
        id: exportRecord.id,
        identity: exportRecord.identity,
        validation: exportRecord.validation,
        localState: exportRecord.localState,
        workflow: exportRecord.workflow,
        interfaceCreation: exportRecord.interfaceCreation,
        overview: exportRecord.overview,
        stats: exportRecord.stats,
        dependencies: exportRecord.dependencies
      },
      agents: exportRecord.agents,
      userInputRequests: exportRecord.userInputRequests,
      diagnostics,
      timeline: buildReviewTimeline(exportRecord)
    };

    const sanitized = sanitizeReviewValue(bundle, collectPathReplacements(exportRecord)) as ProjectReviewLogBundle;
    return projectReviewLogBundleSchema.parse(sanitized);
  }

  private projectDir(projectId: string): string {
    return path.join(this.appDataDir, "projects", projectId);
  }

  private projectStatePath(projectId: string): string {
    return path.join(this.projectDir(projectId), "state.json");
  }

  private projectCredentialSecretPath(projectId: string): string {
    return path.join(this.projectDir(projectId), "credentials.secrets.json");
  }

  private projectRepositoryIndexPath(projectId: string): string {
    return path.join(this.projectDir(projectId), "repository-index.json");
  }

  private projectAgentTranscriptDir(projectId: string): string {
    return path.join(this.projectDir(projectId), "agent-transcripts");
  }

  private projectAgentTranscriptPath(projectId: string, agentId: string): string {
    return path.join(this.projectAgentTranscriptDir(projectId), `${agentId}.json`);
  }

  private projectAgentOutputDir(projectId: string): string {
    return path.join(this.projectDir(projectId), "agent-outputs");
  }

  private projectAgentOutputPath(projectId: string, agentId: string): string {
    return path.join(this.projectAgentOutputDir(projectId), `${agentId}.json`);
  }

  private registryPath(): string {
    return path.join(this.appDataDir, "registry.json");
  }

  private settingsPath(): string {
    return path.join(this.appDataDir, "settings.json");
  }

  async ensureBaseDirs(): Promise<void> {
    await mkdir(path.join(this.appDataDir, "projects"), { recursive: true });
  }

  consumeLoadIssues(): StateLoadIssue[] {
    const issues = [...this.loadIssues];
    this.loadIssues.length = 0;
    return issues;
  }

  private recordLoadIssue(issue: StateLoadIssue): void {
    this.loadIssues.push(issue);
    const detail = issue.quarantinePath ? ` -> ${issue.quarantinePath}` : "";
    console.warn(`[storage] ${issue.action} ${issue.statePath}${detail}: ${issue.message}`);
  }

  private isRetryableAtomicWriteError(error: unknown): boolean {
    return Boolean(
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "EPERM" || error.code === "EACCES" || error.code === "EBUSY")
    );
  }

  private stringifyForStorage(filePath: string, value: unknown): string {
    const startedAt = performance.now();
    const compact = JSON.stringify(value);
    const output = compact.length > 512_000 ? compact : JSON.stringify(value, null, 2);
    if (this.debugState) {
      console.info(
        `[storage] stringify ${path.basename(filePath)}: ${compact.length} bytes compact, ${Math.round(performance.now() - startedAt)}ms`
      );
    }
    return output;
  }

  private quarantineReasonSlug(message: string): string {
    const slug = message
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
    return slug || "invalid-state";
  }

  private async writeJsonAtomicallyNow(filePath: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}.tmp`;
    await writeFile(temporaryPath, this.stringifyForStorage(filePath, value));
    let lastError: unknown;
    for (let attempt = 0; attempt < 7; attempt += 1) {
      try {
        await rename(temporaryPath, filePath);
        return;
      } catch (error) {
        lastError = error;
        if (!this.isRetryableAtomicWriteError(error) || attempt === 6) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
      }
    }

    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
    const previousWrite = this.writeQueues.get(filePath) ?? Promise.resolve();
    const nextWrite = previousWrite
      .catch(() => undefined)
      .then(async () => await this.writeJsonAtomicallyNow(filePath, value));
    this.writeQueues.set(filePath, nextWrite);
    try {
      await nextWrite;
    } finally {
      if (this.writeQueues.get(filePath) === nextWrite) {
        this.writeQueues.delete(filePath);
      }
    }
  }

  async loadRegistry(): Promise<string[]> {
    try {
      const raw = await readFile(this.registryPath(), "utf8");
      return JSON.parse(raw) as string[];
    } catch {
      return [];
    }
  }

  async saveRegistry(projectIds: string[]): Promise<void> {
    await this.ensureBaseDirs();
    await this.writeJsonAtomically(this.registryPath(), projectIds);
  }

  async loadSettings(): Promise<Record<string, unknown> | null> {
    try {
      return JSON.parse(await readFile(this.settingsPath(), "utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  async saveSettings(settings: Record<string, unknown>): Promise<void> {
    await this.ensureBaseDirs();
    await this.writeJsonAtomically(this.settingsPath(), settings);
  }

  async saveProject(record: LocalProjectRecord): Promise<void> {
    await this.ensureBaseDirs();
    await mkdir(this.projectDir(record.id), { recursive: true });
    await this.preserveAgentOutputSidecars(record.id, record);
    const sanitizeStartedAt = performance.now();
    const sanitized = sanitizeProjectRecord(record);
    if (this.debugPerf) {
      const serializedBytes = JSON.stringify(sanitized.record).length;
      console.info(
        `[workflow-perf] sanitizeProjectRecord ${record.identity.projectName}: ${serializedBytes} bytes in ${Math.round(performance.now() - sanitizeStartedAt)}ms`
      );
    }
    await this.writeJsonAtomically(this.projectStatePath(record.id), sanitized.record);
  }

  async saveRepositoryIndex(index: Omit<RepositoryIndexStore, "version" | "savedAt">): Promise<void> {
    await this.ensureBaseDirs();
    const store: RepositoryIndexStore = {
      version: 1,
      savedAt: nowIso(),
      ...index,
      files: index.files.map((file) => ({
        relativePath: file.relativePath,
        size: Math.max(0, Math.floor(file.size)),
        language: file.language
      }))
    };
    await this.writeJsonAtomically(this.projectRepositoryIndexPath(index.projectId), store);
  }

  async loadRepositoryIndex(projectId: string): Promise<RepositoryIndexStore | null> {
    try {
      const raw = await readFile(this.projectRepositoryIndexPath(projectId), "utf8");
      const parsed = JSON.parse(raw) as Partial<RepositoryIndexStore>;
      if (parsed.version !== 1 || parsed.projectId !== projectId || typeof parsed.projectRoot !== "string" || !Array.isArray(parsed.files)) {
        return null;
      }
      const files = parsed.files
        .filter((file): file is RepositoryIndexEntry =>
          Boolean(file) &&
          typeof file.relativePath === "string" &&
          file.relativePath.length > 0 &&
          !path.isAbsolute(file.relativePath) &&
          !file.relativePath.split("/").includes("..") &&
          typeof file.size === "number" &&
          Number.isFinite(file.size) &&
          typeof file.language === "string"
        )
        .map((file) => ({
          relativePath: file.relativePath,
          size: Math.max(0, Math.floor(file.size)),
          language: file.language
        }));
      return {
        version: 1,
        projectId,
        savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : nowIso(),
        projectRoot: parsed.projectRoot,
        treeHash: typeof parsed.treeHash === "string" ? parsed.treeHash : undefined,
        scanMode: parsed.scanMode === "deep" ? "deep" : parsed.scanMode === "normal" ? "normal" : undefined,
        files
      };
    } catch {
      return null;
    }
  }

  private parseJsonObjectPrefix(raw: string): string | undefined {
    const trimmed = raw.trimStart();
    if (!trimmed.startsWith("{")) {
      return undefined;
    }

    const startOffset = raw.length - trimmed.length;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = startOffset; index < raw.length; index += 1) {
      const char = raw[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = !inString;
        continue;
      }
      if (inString) {
        continue;
      }
      if (char === "{") {
        depth += 1;
        continue;
      }
      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          return raw.slice(startOffset, index + 1);
        }
      }
    }
    return undefined;
  }

  private parseProjectStateText(raw: string): ProjectStateParseResult {
    try {
      return { ok: true, value: JSON.parse(raw) };
    } catch (error) {
      const parseMessage = error instanceof Error ? error.message : String(error);
      const prefix = this.parseJsonObjectPrefix(raw);
      if (!prefix) {
        return {
          ok: false,
          issue: "malformed_json",
          message: parseMessage
        };
      }

      const startOffset = raw.length - raw.trimStart().length;
      const trailing = raw.slice(startOffset + prefix.length).trim();
      if (trailing.startsWith("{") || trailing.startsWith("[")) {
        return {
          ok: false,
          issue: "duplicate_appended_json",
          message: `A complete JSON object is followed by ${trailing.length} trailing character(s). Original parse error: ${parseMessage}`
        };
      }

      return {
        ok: false,
        issue: "malformed_json",
        message: parseMessage
      };
    }
  }

  async validateProjectStateFile(statePath: string): Promise<ProjectStateValidationResult> {
    const sizeBytes = (await stat(statePath)).size;
    if (sizeBytes > PROJECT_STATE_HARD_LOAD_BYTES) {
      return {
        ok: false,
        statePath,
        sizeBytes,
        issue: "state_too_large_to_load",
        message: `State file is ${sizeBytes} bytes, above the hard load limit of ${PROJECT_STATE_HARD_LOAD_BYTES} bytes.`,
        shouldCompact: false
      };
    }

    const raw = await readFile(statePath, "utf8");
    const parsed = this.parseProjectStateText(raw);
    if (!parsed.ok) {
      return {
        ok: false,
        statePath,
        sizeBytes,
        issue: parsed.issue,
        message: parsed.message,
        shouldCompact: false
      };
    }

    return {
      ok: true,
      statePath,
      sizeBytes,
      parsed: parsed.value,
      shouldCompact: sizeBytes > PROJECT_STATE_COMPACT_BYTES
    };
  }

  async quarantineProjectState(projectId: string, reason: string): Promise<string> {
    return await this.quarantineProjectStateFile(projectId, this.projectStatePath(projectId), reason);
  }

  private async quarantineProjectStateFile(projectId: string, statePath: string, message: string): Promise<string> {
    const timestamp = nowIso().replace(/[:.]/g, "-");
    const reason = this.quarantineReasonSlug(message);
    const quarantinePath = path.join(this.projectDir(projectId), `state.json.quarantine.${reason}.${timestamp}.json`);
    await rename(statePath, quarantinePath);
    this.recordLoadIssue({
      projectId,
      statePath,
      action: "quarantined",
      message,
      quarantinePath
    });
    return quarantinePath;
  }

  private encodeSecretValue(value: string): StoredSecretValue {
    if (this.secretCodec?.isEncryptionAvailable()) {
      return {
        encoding: "safeStorage",
        value: this.secretCodec.encryptString(value).toString("base64")
      };
    }

    return {
      encoding: "plain",
      value
    };
  }

  private decodeSecretValue(value: StoredSecretValue): string {
    if (value.encoding === "safeStorage" && this.secretCodec?.isEncryptionAvailable()) {
      return this.secretCodec.decryptString(Buffer.from(value.value, "base64"));
    }

    return value.value;
  }

  private async loadCredentialSecretStore(projectId: string): Promise<CredentialSecretStore> {
    try {
      const raw = await readFile(this.projectCredentialSecretPath(projectId), "utf8");
      const parsed = JSON.parse(raw) as CredentialSecretStore;
      return {
        version: 1,
        entries: parsed.entries ?? {}
      };
    } catch {
      return {
        version: 1,
        entries: {}
      };
    }
  }

  private async saveCredentialSecretStore(projectId: string, store: CredentialSecretStore): Promise<void> {
    await this.ensureBaseDirs();
    await mkdir(this.projectDir(projectId), { recursive: true });
    await this.writeJsonAtomically(this.projectCredentialSecretPath(projectId), store);
  }

  async saveCredentialSecret(projectId: string, entryId: string, secrets: CredentialSecretInput): Promise<void> {
    const store = await this.loadCredentialSecretStore(projectId);
    store.entries[entryId] = {
      apiKey: this.encodeSecretValue(secrets.apiKey),
      secretKey: secrets.secretKey?.trim() ? this.encodeSecretValue(secrets.secretKey.trim()) : undefined,
      updatedAt: nowIso()
    };
    await this.saveCredentialSecretStore(projectId, store);
  }

  async deleteCredentialSecret(projectId: string, entryId: string): Promise<void> {
    const store = await this.loadCredentialSecretStore(projectId);
    delete store.entries[entryId];
    await this.saveCredentialSecretStore(projectId, store);
  }

  async hasCredentialSecret(projectId: string, entryId: string): Promise<{ hasApiKey: boolean; hasSecretKey: boolean }> {
    const store = await this.loadCredentialSecretStore(projectId);
    const entry = store.entries[entryId];
    return {
      hasApiKey: Boolean(entry?.apiKey),
      hasSecretKey: Boolean(entry?.secretKey)
    };
  }

  async readCredentialSecret(projectId: string, entryId: string): Promise<CredentialSecretInput | null> {
    const store = await this.loadCredentialSecretStore(projectId);
    const entry = store.entries[entryId];
    if (!entry) {
      return null;
    }

    return {
      apiKey: this.decodeSecretValue(entry.apiKey),
      secretKey: entry.secretKey ? this.decodeSecretValue(entry.secretKey) : undefined
    };
  }

  private transcriptEntriesFromAgent(projectId: string, agent: LocalProjectRecord["agents"][number]): AgentTranscriptEntry[] {
    const commandEntries: AgentTranscriptEntry[] = (agent.commandLog ?? []).map((command, index) => ({
      id: `${agent.id}:command:${command.itemId ?? index}`,
      timestamp: command.completedAt ?? command.startedAt,
      kind: "command",
      itemId: command.itemId,
      title: command.command,
      text: command.output,
      metadata: {
        status: command.status,
        exitCode: command.exitCode ?? null,
        cwd: command.cwd ?? null
      }
    }));
    const approvalEntries: AgentTranscriptEntry[] = (agent.approvals ?? []).map((approval) => ({
      id: `${agent.id}:approval:${approval.id}`,
      timestamp: approval.createdAt,
      kind: "approval",
      itemId: approval.itemId,
      title: "Approval requested",
      text: [approval.summary, approval.reason, approval.command].filter(Boolean).join("\n\n"),
      metadata: {
        status: approval.status,
        kind: approval.kind
      }
    }));
    const eventEntries: AgentTranscriptEntry[] = (agent.events ?? []).map((event) => ({
      id: `${agent.id}:event:${event.id}`,
      timestamp: event.timestamp,
      kind: event.type === "message" ? "message" : event.type === "raw" ? "raw" : "event",
      itemId: event.itemId,
      title: event.title,
      text: event.detail,
      raw: event.raw,
      metadata: {
        status: event.status ?? null,
        type: event.type,
        projectId
      }
    }));
    return [...eventEntries, ...commandEntries, ...approvalEntries]
      .filter((entry) => entry.text?.trim() || entry.raw !== undefined || entry.title.trim())
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  }

  private transcriptOutputText(entries: AgentTranscriptEntry[]): string {
    return entries
      .map((entry) => {
        const heading = `[${entry.timestamp}] ${entry.kind.toUpperCase()} - ${entry.title}`;
        const body = entry.text?.trim()
          ? entry.text
          : entry.raw !== undefined
            ? JSON.stringify(entry.raw, null, 2)
            : "";
        return body ? `${heading}\n${body}` : heading;
      })
      .join("\n\n");
  }

  private serializedByteLength(value: unknown): number {
    try {
      return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value));
    } catch {
      return 0;
    }
  }

  private agentHasSidecarWorthyOutput(agent: LocalProjectRecord["agents"][number]): boolean {
    return (agent.commandLog ?? []).some((command) => Buffer.byteLength(command.output) > SIDE_CAR_PRESERVE_TEXT_BYTES) ||
      (agent.events ?? []).some((event) =>
        Buffer.byteLength(event.detail ?? "") > SIDE_CAR_PRESERVE_EVENT_BYTES ||
        this.serializedByteLength(event.raw) > SIDE_CAR_PRESERVE_EVENT_BYTES
      );
  }

  private async preserveAgentOutputSidecars(projectId: string, record: LocalProjectRecord, options: { force?: boolean } = {}): Promise<void> {
    for (const agent of record.agents ?? []) {
      if (!options.force && !this.agentHasSidecarWorthyOutput(agent)) {
        continue;
      }
      const entries = this.transcriptEntriesFromAgent(projectId, agent);
      if (entries.length === 0) {
        continue;
      }
      await this.saveAgentTranscript(projectId, agent, entries);
      await this.saveAgentFullOutput(projectId, agent, this.transcriptOutputText(entries));
      agent.outputReference = {
        agentId: agent.id,
        workflowCycleNumber: agent.workflowCycleNumber,
        transcriptAvailable: true,
        fullOutputAvailable: true,
        updatedAt: nowIso()
      };
    }
  }

  async loadProject(projectId: string): Promise<LocalProjectRecord | null> {
    const statePath = this.projectStatePath(projectId);
    try {
      const validation = await this.validateProjectStateFile(statePath);
      if (!validation.ok) {
        await this.quarantineProjectStateFile(projectId, statePath, `${validation.issue ?? "invalid_state"}. ${validation.message ?? "Project state is invalid."}`);
        return null;
      }
      if (validation.sizeBytes > PROJECT_STATE_WARNING_BYTES) {
        this.recordLoadIssue({
          projectId,
          statePath,
          action: "warning",
          message: `Project state is ${validation.sizeBytes} bytes. It will be compacted at ${PROJECT_STATE_COMPACT_BYTES} bytes.`
        });
      }
      const parsedJson = validation.parsed as LocalProjectRecord;
      if (validation.shouldCompact) {
        await this.preserveAgentOutputSidecars(projectId, parsedJson, { force: true });
      } else {
        await this.preserveAgentOutputSidecars(projectId, parsedJson);
      }
      const sanitized = sanitizeProjectRecord(parsedJson);
      const record = localProjectRecordSchema.parse(sanitized.record) as LocalProjectRecord;
      if (sanitized.report.changed || validation.shouldCompact) {
        await this.backupProjectStateBeforeMigration(projectId, statePath);
        await this.writeJsonAtomically(statePath, record);
        this.recordLoadIssue({
          projectId,
          statePath,
          action: "compacted",
          message: validation.shouldCompact
            ? `Oversized valid state was compacted from ${validation.sizeBytes} bytes to ${JSON.stringify(record).length} bytes.`
            : "Project state was compacted by the sanitizer."
        });
        this.logSanitizerReport(projectId, validation.sizeBytes, JSON.stringify(record).length, sanitized.report);
      }
      return record;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return null;
      }
      const message = error instanceof Error ? error.message : String(error);
      await this.quarantineProjectStateFile(projectId, statePath, `schema_invalid. State validation failed. ${message}`).catch((quarantineError) => {
        this.recordLoadIssue({
          projectId,
          statePath,
          action: "ignored",
          message: `State validation failed (${message}) and quarantine failed: ${quarantineError instanceof Error ? quarantineError.message : String(quarantineError)}`
        });
      });
      return null;
    }
  }

  private async backupProjectStateBeforeMigration(projectId: string, statePath: string): Promise<void> {
    const projectDir = this.projectDir(projectId);
    const backupPrefix = `state.json.backup.sanitizer-v${STATE_SANITIZER_VERSION}.`;
    const existingBackups = await readdir(projectDir).catch(() => []);
    if (existingBackups.some((entry) => entry.startsWith(backupPrefix))) {
      return;
    }
    const timestamp = nowIso().replace(/[:.]/g, "-");
    await copyFile(statePath, path.join(projectDir, `${backupPrefix}${timestamp}.json`));
  }

  private logSanitizerReport(projectId: string, beforeBytes: number, afterBytes: number, report: StateSanitizerReport): void {
    if (!this.debugState) {
      return;
    }
    console.info(
      [
        `[storage] sanitized project ${projectId}: ${beforeBytes} -> ${afterBytes} bytes`,
        `checklist=${report.checklistItemsSanitized}`,
        `evidenceTruncated=${report.evidenceFieldsTruncated}`,
        `historyRemoved=${report.evidenceHistoryEntriesRemoved}`,
        `eventsRemoved=${report.activityEventsRemoved + report.agentEventsRemoved}`,
        `commandsRemoved=${report.commandRecordsRemoved}`,
        `agentsCompacted=${report.agentsCompacted}`
      ].join(" ")
    );
  }

  async loadAllProjects(): Promise<LocalProjectRecord[]> {
    const projectIds = await this.loadRegistry();
    const records: Array<LocalProjectRecord | null> = [];
    for (const projectId of projectIds) {
      records.push(await this.loadProject(projectId));
    }
    return records.filter((record): record is LocalProjectRecord => record !== null);
  }

  async saveAgentTranscript(
    projectId: string,
    agent: Pick<LocalProjectRecord["agents"][number], "id" | "name" | "workflowCycleNumber">,
    transcript: AgentTranscriptEntry[]
  ): Promise<void> {
    await this.ensureBaseDirs();
    await mkdir(this.projectAgentTranscriptDir(projectId), { recursive: true });
    const store: AgentTranscriptStore = {
      version: 1,
      projectId,
      agentId: agent.id,
      agentName: agent.name,
      updatedAt: nowIso(),
      entries: transcript
    };
    await this.writeJsonAtomically(this.projectAgentTranscriptPath(projectId, agent.id), store);
  }

  async appendAgentTranscriptEntry(
    projectId: string,
    agent: Pick<LocalProjectRecord["agents"][number], "id" | "name" | "workflowCycleNumber">,
    entry: AgentTranscriptEntry
  ): Promise<void> {
    await this.ensureBaseDirs();
    await mkdir(this.projectAgentTranscriptDir(projectId), { recursive: true });
    const transcriptPath = this.projectAgentTranscriptPath(projectId, agent.id);
    let entries: AgentTranscriptEntry[] = [];
    try {
      const existing = JSON.parse(await readFile(transcriptPath, "utf8")) as AgentTranscriptStore;
      entries = Array.isArray(existing.entries) ? existing.entries : [];
    } catch {
      // Missing or malformed transcript sidecars should not affect the primary project state.
    }

    entries.push(entry);
    if (entries.length > 2_000) {
      entries = entries.slice(-2_000);
    }
    await this.saveAgentTranscript(projectId, agent, entries);
  }

  async getAgentTranscript(projectId: string, agentId: string): Promise<AgentTranscriptEntry[] | null> {
    try {
      const transcriptPath = this.projectAgentTranscriptPath(projectId, agentId);
      const store = JSON.parse(await readFile(transcriptPath, "utf8")) as AgentTranscriptStore;
      return Array.isArray(store.entries) ? store.entries : [];
    } catch {
      return null;
    }
  }

  async readAgentTranscript(projectId: string, agentId: string): Promise<AgentTranscriptEntry[] | null> {
    return await this.getAgentTranscript(projectId, agentId);
  }

  async saveAgentFullOutput(
    projectId: string,
    agent: Pick<LocalProjectRecord["agents"][number], "id" | "name" | "workflowCycleNumber">,
    output: string
  ): Promise<void> {
    await this.ensureBaseDirs();
    await mkdir(this.projectAgentOutputDir(projectId), { recursive: true });
    const store: AgentFullOutputStore = {
      version: 1,
      projectId,
      agentId: agent.id,
      agentName: agent.name,
      workflowCycleNumber: agent.workflowCycleNumber,
      updatedAt: nowIso(),
      output
    };
    await this.writeJsonAtomically(this.projectAgentOutputPath(projectId, agent.id), store);
  }

  async getAgentFullOutput(projectId: string, agentId: string): Promise<string | null> {
    try {
      const outputPath = this.projectAgentOutputPath(projectId, agentId);
      const store = JSON.parse(await readFile(outputPath, "utf8")) as AgentFullOutputStore;
      return typeof store.output === "string" ? store.output : "";
    } catch {
      return null;
    }
  }

  async writePortableInterface(projectRoot: string, record: LocalProjectRecord, destinationPath?: string): Promise<string> {
    const finalPayload = this.buildPortableInterfacePayload(record);
    const outputPath = destinationPath
      ? path.isAbsolute(destinationPath)
        ? destinationPath
        : path.join(projectRoot, destinationPath)
      : path.join(projectRoot, PORTABLE_INTERFACE_PATH);
    await assertHostPathWithinProjectRoot(projectRoot, outputPath, "Portable interface export");
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, JSON.stringify(finalPayload, null, 2));
    return outputPath;
  }

  async writePortableInterfaceToFile(record: LocalProjectRecord, destinationPath: string): Promise<string> {
    const finalPayload = this.buildPortableInterfacePayload(record);
    const outputPath = path.resolve(destinationPath);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, JSON.stringify(finalPayload, null, 2));
    return outputPath;
  }

  async writeReviewLogBundleToFile(
    record: LocalProjectRecord,
    settings: AppSettings,
    diagnostics: string[],
    destinationPath: string
  ): Promise<string> {
    const finalPayload = this.buildReviewLogBundlePayload(record, settings, diagnostics);
    const outputPath = path.resolve(destinationPath);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, JSON.stringify(finalPayload, null, 2));
    return outputPath;
  }

  async readPortableInterface(interfacePath: string): Promise<PortableProjectInterface | null> {
    try {
      const raw = await readFile(interfacePath, "utf8");
      return portableInterfaceSchema.parse(JSON.parse(raw));
    } catch {
      return null;
    }
  }
}
