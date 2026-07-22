import { copyFile, mkdir, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { APP_VERSION, PORTABLE_INTERFACE_PATH, REVIEW_LOG_BUNDLE_VERSION } from "@shared/constants";
import { createPortableInterface } from "@shared/defaults";
import { appSettingsSchema, localProjectRecordSchema, portableInterfaceSchema, projectReviewLogBundleSchema, projectWorkflowStateSchema, storageEntityIdSchema } from "@shared/schemas";
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

export type CredentialStorageErrorCode =
  | "credential_storage_unavailable"
  | "credential_storage_locked"
  | "credential_store_corrupt";

/**
 * A recoverable credential failure that callers should surface to the user.
 * `credential_storage_unavailable` means a new secret cannot be encrypted on
 * this machine. `credential_storage_locked` means encrypted data exists but
 * cannot currently be decrypted. `credential_store_corrupt` means the store
 * failed strict integrity validation and was deliberately left untouched.
 */
export class CredentialStorageError extends Error {
  readonly name = "CredentialStorageError";

  constructor(
    readonly code: CredentialStorageErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

export class StorageReadLimitError extends Error {
  readonly name = "StorageReadLimitError";

  constructor(
    readonly filePath: string,
    readonly maxBytes: number
  ) {
    super(`Refused to load ${path.basename(filePath)} because it exceeds the ${maxBytes} byte storage limit.`);
  }
}

export interface VersionedStorageBackup {
  backupPath: string;
  created: boolean;
  sourceVersion: string;
}

const safeStorageSecretValueSchema = z.object({
  encoding: z.literal("safeStorage"),
  value: z.string().min(1).regex(
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
    "Encrypted credential value must be valid base64."
  )
}).strict();

const legacyPlainSecretValueSchema = z.object({
  encoding: z.literal("plain"),
  value: z.string()
}).strict();

const storedSecretValueSchema = z.discriminatedUnion("encoding", [
  safeStorageSecretValueSchema,
  legacyPlainSecretValueSchema
]);

const credentialSecretStoreSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string().min(1), z.object({
    apiKey: storedSecretValueSchema,
    secretKey: storedSecretValueSchema.optional(),
    updatedAt: z.string().datetime({ offset: true })
  }).strict())
}).strict();

type StoredSecretValue = z.infer<typeof storedSecretValueSchema>;
type CredentialSecretStore = z.infer<typeof credentialSecretStoreSchema>;

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

export const SETTINGS_MAX_LOAD_BYTES = 1_000_000;
export const REGISTRY_MAX_LOAD_BYTES = 4_000_000;
export const REPOSITORY_INDEX_MAX_LOAD_BYTES = 64_000_000;
export const PORTABLE_INTERFACE_MAX_LOAD_BYTES = 24_000_000;
export const CREDENTIAL_STORE_MAX_LOAD_BYTES = 4_000_000;
export const AGENT_TRANSCRIPT_MAX_ENTRIES = 2_000;
export const AGENT_TRANSCRIPT_MAX_BYTES = 8_000_000;
export const AGENT_TRANSCRIPT_ENTRY_MAX_BYTES = 512_000;
export const AGENT_FULL_OUTPUT_MAX_BYTES = 8_000_000;

const STORAGE_TRUNCATION_MARKER = "[... truncated by Agent Workbench storage limits ...]";

const SIDE_CAR_PRESERVE_TEXT_BYTES = 12_000;
const SIDE_CAR_PRESERVE_EVENT_BYTES = 8_000;

const buildReviewLogRuntimeContext = (settings: AppSettings): ReviewLogRuntimeContext => ({
  executionMode: settings.executionMode,
  distroName: settings.distroName,
  mockMode: settings.mockMode,
  maxRepairCycles: settings.maxRepairCycles,
  interfaceCreationModel: settings.interfaceCreationModel,
  agentModelMode: settings.agentModelMode,
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
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted-private-key]")
    .replace(/AGENT_WORKBENCH_CREDENTIAL\s+({[^\r\n]+})/g, "AGENT_WORKBENCH_CREDENTIAL [redacted]")
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g, "[redacted-secret]")
    .replace(/\b(?:ghp|github_pat)_[A-Za-z0-9_]{16,}\b/g, "[redacted-token]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[redacted-access-key]")
    .replace(/\b(?:[A-Za-z]:\\Users\\[^\s"'`]+|\/(?:home|Users|mnt|var|tmp|private|Volumes)\/[^\s"'`]+)/g, "<local-path>")
    .replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted-token]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [redacted]")
    .replace(/\b(https?:\/\/)([^/\s:@]+):([^@\s/]+)@/gi, "$1[redacted]@")
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

const portableOmittedKeys = new Set([
  "activeRunId",
  "apiKey",
  "authorization",
  "clientSecret",
  "cwd",
  "effectKey",
  "gitRoot",
  "itemId",
  "outputReference",
  "password",
  "projectAccess",
  "raw",
  "refreshToken",
  "secretKey",
  "serverRequestId",
  "threadId",
  "turnId",
  "worktree"
]);

const portableSensitiveKeys = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "clientsecret",
  "credential",
  "credentials",
  "password",
  "refreshtoken",
  "secret",
  "secretkey",
  "token"
]);

const portableBlankKeys = new Set(["output", "outputSnippet"]);

const sanitizePortableValue = (value: unknown, replacements: PathReplacement[]): unknown => {
  if (typeof value === "string") {
    return redactString(value, replacements);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizePortableValue(entry, replacements));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => {
        if (portableOmittedKeys.has(key) || portableSensitiveKeys.has(key.replace(/[^a-z0-9]/gi, "").toLowerCase())) {
          return [];
        }
        if (portableBlankKeys.has(key)) {
          return [[key, ""]];
        }
        return [[key, sanitizePortableValue(entry, replacements)]];
      })
    );
  }
  return value;
};

const portableAgentStatus = (status: LocalProjectRecord["agents"][number]["status"]): LocalProjectRecord["agents"][number]["status"] =>
  status === "starting" || status === "running" || status === "waiting_approval" ? "idle" : status;

const sanitizePortableAgent = (
  agent: LocalProjectRecord["agents"][number],
  replacements: PathReplacement[]
): LocalProjectRecord["agents"][number] => {
  const sanitized = sanitizePortableValue(agent, replacements) as LocalProjectRecord["agents"][number];
  const wasLive = agent.status === "starting" || agent.status === "running" || agent.status === "waiting_approval";
  return {
    ...sanitized,
    status: portableAgentStatus(agent.status),
    currentPhase: wasLive ? "Portable history; live execution was not transferred" : sanitized.currentPhase,
    currentSubtask: wasLive ? undefined : sanitized.currentSubtask,
    approvals: sanitized.approvals
      .filter((approval) => approval.status !== "pending")
      .map((approval) => ({
        ...approval,
        command: undefined,
        cwd: undefined,
        availableDecisions: []
      })),
    commandLog: sanitized.commandLog.map((command) => ({
      ...command,
      cwd: undefined,
      output: ""
    })),
    events: sanitized.events.map((event) => ({
      ...event,
      raw: undefined
    })),
    threadId: undefined,
    worktree: undefined,
    outputReference: undefined
  };
};

const sanitizePortableWorkflow = (
  workflow: LocalProjectRecord["workflow"],
  replacements: PathReplacement[],
  exportedAt: string
): LocalProjectRecord["workflow"] => {
  const sanitized = sanitizePortableValue(workflow, replacements) as LocalProjectRecord["workflow"];
  return {
    ...sanitized,
    execution: {
      ...sanitized.execution,
      activeRunId: undefined,
      effectKey: undefined
    },
    autopilotStatus: undefined,
    incidents: sanitized.incidents.map((incident) => incident.kind === "approval" && (incident.status === "open" || incident.status === "resolving")
      ? {
        ...incident,
        status: "superseded",
        userActionRequired: undefined,
        primaryAction: undefined,
        secondaryActions: [],
        automaticActions: [...incident.automaticActions, "Live approval state was intentionally excluded from the portable interface."],
        updatedAt: exportedAt,
        resolvedAt: exportedAt
      }
      : incident)
  };
};

const sanitizePortableInterface = (
  portable: PortableProjectInterface,
  record: LocalProjectRecord
): PortableProjectInterface => {
  const replacements = collectPathReplacements(record);
  const sanitized = sanitizePortableValue(portable, replacements) as PortableProjectInterface;
  return {
    ...sanitized,
    identity: {
      ...sanitized.identity,
      gitRoot: undefined
    },
    validation: {
      ...sanitized.validation,
      projectAccess: undefined
    },
    localStateDefaults: {
      ...sanitized.localStateDefaults,
      selectedFile: undefined,
      treeFilter: "",
      activeAgentId: undefined,
      workflowPauseRequested: false,
      lastOpenedAt: undefined
    },
    workflow: sanitizePortableWorkflow(portable.workflow, replacements, portable.exportedAt),
    stats: sanitized.stats ? { ...sanitized.stats, projectRoot: "." } : undefined,
    agents: portable.agents.map((agent) => sanitizePortableAgent(agent, replacements))
  };
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
  private readonly fileQueues = new Map<string, Promise<void>>();
  private readonly loadIssues: StateLoadIssue[] = [];
  private readonly debugState = process.env.AWB_DEBUG_STATE === "1";
  private readonly debugPerf = process.env.WORKBENCH_PERF === "1" || process.env.AWB_DEBUG_WORKFLOW_PERF === "1";

  constructor(
    private readonly appDataDir: string,
    private readonly secretCodec?: SecretStorageCodec
  ) {}

  private buildPortableInterfacePayload(record: LocalProjectRecord): PortableProjectInterface {
    const portable = JSON.parse(JSON.stringify(
      sanitizePortableInterface(createPortableInterface(record), record)
    )) as PortableProjectInterface;
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
    const projectsRoot = path.resolve(this.appDataDir, "projects");
    const safeProjectId = storageEntityIdSchema.parse(projectId);
    const projectDirectory = path.resolve(projectsRoot, safeProjectId);
    if (path.dirname(projectDirectory) !== projectsRoot) {
      throw new Error("Project storage path escaped the managed projects directory.");
    }
    return projectDirectory;
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
    const transcriptDirectory = path.resolve(this.projectAgentTranscriptDir(projectId));
    const safeAgentId = storageEntityIdSchema.parse(agentId);
    const transcriptPath = path.resolve(transcriptDirectory, `${safeAgentId}.json`);
    if (path.dirname(transcriptPath) !== transcriptDirectory) {
      throw new Error("Agent transcript path escaped its managed project directory.");
    }
    return transcriptPath;
  }

  private projectAgentOutputDir(projectId: string): string {
    return path.join(this.projectDir(projectId), "agent-outputs");
  }

  private projectAgentOutputPath(projectId: string, agentId: string): string {
    const outputDirectory = path.resolve(this.projectAgentOutputDir(projectId));
    const safeAgentId = storageEntityIdSchema.parse(agentId);
    const outputPath = path.resolve(outputDirectory, `${safeAgentId}.json`);
    if (path.dirname(outputPath) !== outputDirectory) {
      throw new Error("Agent output path escaped its managed project directory.");
    }
    return outputPath;
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

  private async readTextFileBounded(filePath: string, maxBytes: number): Promise<string> {
    const handle = await open(filePath, "r");
    try {
      const fileStats = await handle.stat();
      if (fileStats.size > maxBytes) {
        throw new StorageReadLimitError(filePath, maxBytes);
      }

      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let position = 0;
      while (totalBytes <= maxBytes) {
        const remaining = maxBytes + 1 - totalBytes;
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
        if (bytesRead === 0) {
          break;
        }
        chunks.push(chunk.subarray(0, bytesRead));
        totalBytes += bytesRead;
        position += bytesRead;
        if (totalBytes > maxBytes) {
          throw new StorageReadLimitError(filePath, maxBytes);
        }
      }
      return Buffer.concat(chunks, totalBytes).toString("utf8");
    } finally {
      await handle.close();
    }
  }

  private async runFileOperation<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
    const previousOperation = this.fileQueues.get(filePath) ?? Promise.resolve();
    const result = previousOperation
      .catch(() => undefined)
      .then(operation);
    const queueTail = result.then(() => undefined, () => undefined);
    this.fileQueues.set(filePath, queueTail);
    try {
      return await result;
    } finally {
      if (this.fileQueues.get(filePath) === queueTail) {
        this.fileQueues.delete(filePath);
      }
    }
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
    await this.runFileOperation(filePath, async () => await this.writeJsonAtomicallyNow(filePath, value));
  }

  /**
   * Public atomic replacement primitive for versioned migrations. All writes
   * to the same path are serialized within this storage instance.
   */
  async replaceJsonAtomically(filePath: string, value: unknown): Promise<void> {
    await this.writeJsonAtomically(filePath, value);
  }

  /**
   * Creates one immutable, timestamped backup for a source schema version.
   * Repeated migration attempts return the existing backup instead of
   * producing an unbounded series of identical pre-migration copies.
   */
  async createVersionedBackupOnce(filePath: string, sourceVersion: string | number): Promise<VersionedStorageBackup> {
    const normalizedVersion = String(sourceVersion)
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!normalizedVersion) {
      throw new Error("A source version is required before creating a migration backup.");
    }

    const queueKey = `${filePath}\0backup\0${normalizedVersion}`;
    return await this.runFileOperation(queueKey, async () => {
      const directory = path.dirname(filePath);
      const backupPrefix = `${path.basename(filePath)}.backup.source-v${normalizedVersion}.`;
      const existing = (await readdir(directory).catch(() => []))
        .filter((entry) => entry.startsWith(backupPrefix))
        .sort()[0];
      if (existing) {
        return {
          backupPath: path.join(directory, existing),
          created: false,
          sourceVersion: normalizedVersion
        };
      }

      const timestamp = nowIso().replace(/[:.]/g, "-");
      const backupPath = path.join(directory, `${backupPrefix}${timestamp}.json`);
      await copyFile(filePath, backupPath);
      return { backupPath, created: true, sourceVersion: normalizedVersion };
    });
  }

  async loadRegistry(): Promise<string[]> {
    try {
      const raw = await this.readTextFileBounded(this.registryPath(), REGISTRY_MAX_LOAD_BYTES);
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => storageEntityIdSchema.safeParse(entry).success)
        : [];
    } catch {
      return [];
    }
  }

  async saveRegistry(projectIds: string[]): Promise<void> {
    await this.ensureBaseDirs();
    await this.writeJsonAtomically(this.registryPath(), z.array(storageEntityIdSchema).parse(projectIds));
  }

  async loadSettings(): Promise<AppSettings | null> {
    try {
      const raw = await this.readTextFileBounded(this.settingsPath(), SETTINGS_MAX_LOAD_BYTES);
      return appSettingsSchema.parse(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  async saveSettings(settings: Record<string, unknown>): Promise<void> {
    await this.ensureBaseDirs();
    await this.writeJsonAtomically(this.settingsPath(), appSettingsSchema.parse(settings));
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
      const raw = await this.readTextFileBounded(
        this.projectRepositoryIndexPath(projectId),
        REPOSITORY_INDEX_MAX_LOAD_BYTES
      );
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

    const raw = await this.readTextFileBounded(statePath, PROJECT_STATE_HARD_LOAD_BYTES);
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
    let encryptionAvailable = false;
    try {
      encryptionAvailable = this.secretCodec?.isEncryptionAvailable() === true;
    } catch {
      encryptionAvailable = false;
    }
    if (!encryptionAvailable || !this.secretCodec) {
      throw new CredentialStorageError(
        "credential_storage_unavailable",
        "Secure credential storage is unavailable. The secret was not saved."
      );
    }

    try {
      return {
        encoding: "safeStorage",
        value: this.secretCodec.encryptString(value).toString("base64")
      };
    } catch (error) {
      throw new CredentialStorageError(
        "credential_storage_unavailable",
        "Secure credential storage could not encrypt the secret. The secret was not saved.",
        { cause: error }
      );
    }
  }

  private decodeSecretValue(value: StoredSecretValue): string {
    if (value.encoding === "plain") {
      // Legacy plaintext remains readable so the caller can migrate it once
      // secure storage becomes available. New plaintext writes are forbidden.
      return value.value;
    }

    let encryptionAvailable = false;
    try {
      encryptionAvailable = this.secretCodec?.isEncryptionAvailable() === true;
    } catch {
      encryptionAvailable = false;
    }
    if (!encryptionAvailable || !this.secretCodec) {
      throw new CredentialStorageError(
        "credential_storage_locked",
        "This credential is encrypted and cannot be unlocked because secure credential storage is unavailable."
      );
    }

    try {
      return this.secretCodec.decryptString(Buffer.from(value.value, "base64"));
    } catch (error) {
      throw new CredentialStorageError(
        "credential_storage_locked",
        "This credential is encrypted but could not be unlocked on this machine.",
        { cause: error }
      );
    }
  }

  private async loadCredentialSecretStore(projectId: string): Promise<CredentialSecretStore> {
    const credentialPath = this.projectCredentialSecretPath(projectId);
    let raw: string;
    try {
      raw = await this.readTextFileBounded(credentialPath, CREDENTIAL_STORE_MAX_LOAD_BYTES);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return { version: 1, entries: {} };
      }
      if (error instanceof StorageReadLimitError) {
        throw new CredentialStorageError(
          "credential_store_corrupt",
          `The credential store exceeds its ${CREDENTIAL_STORE_MAX_LOAD_BYTES} byte integrity limit and was not modified.`,
          { cause: error }
        );
      }
      throw new CredentialStorageError(
        "credential_storage_unavailable",
        "The credential store could not be read. Existing credentials were not modified.",
        { cause: error }
      );
    }

    try {
      return credentialSecretStoreSchema.parse(JSON.parse(raw));
    } catch (error) {
      throw new CredentialStorageError(
        "credential_store_corrupt",
        "The credential store failed integrity validation and was not modified.",
        { cause: error }
      );
    }
  }

  private async saveCredentialSecretStoreNow(projectId: string, store: CredentialSecretStore): Promise<void> {
    const validated = credentialSecretStoreSchema.parse(store);
    await this.writeJsonAtomicallyNow(this.projectCredentialSecretPath(projectId), validated);
  }

  async saveCredentialSecret(projectId: string, entryId: string, secrets: CredentialSecretInput): Promise<void> {
    await this.ensureBaseDirs();
    await mkdir(this.projectDir(projectId), { recursive: true });
    const credentialPath = this.projectCredentialSecretPath(projectId);
    await this.runFileOperation(credentialPath, async () => {
      const store = await this.loadCredentialSecretStore(projectId);
      store.entries[entryId] = {
        apiKey: this.encodeSecretValue(secrets.apiKey),
        secretKey: secrets.secretKey?.trim() ? this.encodeSecretValue(secrets.secretKey.trim()) : undefined,
        updatedAt: nowIso()
      };
      await this.saveCredentialSecretStoreNow(projectId, store);
    });
  }

  async deleteCredentialSecret(projectId: string, entryId: string): Promise<void> {
    await this.ensureBaseDirs();
    await mkdir(this.projectDir(projectId), { recursive: true });
    const credentialPath = this.projectCredentialSecretPath(projectId);
    await this.runFileOperation(credentialPath, async () => {
      const store = await this.loadCredentialSecretStore(projectId);
      delete store.entries[entryId];
      await this.saveCredentialSecretStoreNow(projectId, store);
    });
  }

  async hasCredentialSecret(projectId: string, entryId: string): Promise<{ hasApiKey: boolean; hasSecretKey: boolean }> {
    const credentialPath = this.projectCredentialSecretPath(projectId);
    return await this.runFileOperation(credentialPath, async () => {
      const store = await this.loadCredentialSecretStore(projectId);
      const entry = store.entries[entryId];
      return {
        hasApiKey: Boolean(entry?.apiKey),
        hasSecretKey: Boolean(entry?.secretKey)
      };
    });
  }

  async readCredentialSecret(projectId: string, entryId: string): Promise<CredentialSecretInput | null> {
    const credentialPath = this.projectCredentialSecretPath(projectId);
    return await this.runFileOperation(credentialPath, async () => {
      const store = await this.loadCredentialSecretStore(projectId);
      const entry = store.entries[entryId];
      if (!entry) {
        return null;
      }

      return {
        apiKey: this.decodeSecretValue(entry.apiKey),
        secretKey: entry.secretKey ? this.decodeSecretValue(entry.secretKey) : undefined
      };
    });
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

  private utf8Prefix(value: string, maxBytes: number): string {
    const encoded = Buffer.from(value);
    if (encoded.length <= maxBytes) {
      return value;
    }
    return encoded.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/u, "");
  }

  private utf8Suffix(value: string, maxBytes: number): string {
    const encoded = Buffer.from(value);
    if (encoded.length <= maxBytes) {
      return value;
    }
    return encoded.subarray(encoded.length - maxBytes).toString("utf8").replace(/^\uFFFD/u, "");
  }

  private truncateTextForStorage(value: string, maxBytes: number, label: string): string {
    const originalBytes = Buffer.byteLength(value);
    if (originalBytes <= maxBytes) {
      return value;
    }
    const marker = `\n\n${STORAGE_TRUNCATION_MARKER}\n${label} was ${originalBytes} bytes; the storage cap is ${maxBytes} bytes.\n\n`;
    const contentBudget = Math.max(0, maxBytes - Buffer.byteLength(marker));
    const prefixBudget = Math.floor(contentBudget * 0.4);
    const suffixBudget = contentBudget - prefixBudget;
    return `${this.utf8Prefix(value, prefixBudget)}${marker}${this.utf8Suffix(value, suffixBudget)}`;
  }

  private truncateTranscriptEntry(entry: AgentTranscriptEntry): AgentTranscriptEntry {
    const next: AgentTranscriptEntry = {
      ...entry,
      id: this.truncateTextForStorage(entry.id, 8_192, "Transcript entry id"),
      title: this.truncateTextForStorage(entry.title, 32_000, "Transcript entry title"),
      itemId: entry.itemId
        ? this.truncateTextForStorage(entry.itemId, 8_192, "Transcript item id")
        : undefined,
      text: entry.text
        ? this.truncateTextForStorage(entry.text, AGENT_TRANSCRIPT_ENTRY_MAX_BYTES, "Transcript entry text")
        : undefined,
      metadata: entry.metadata
        ? Object.fromEntries(Object.entries(entry.metadata).map(([key, value]) => [
          this.truncateTextForStorage(key, 2_048, "Transcript metadata key"),
          typeof value === "string"
            ? this.truncateTextForStorage(value, 32_000, "Transcript metadata value")
            : value
        ]))
        : undefined
    };

    if (entry.raw !== undefined && this.serializedByteLength(entry.raw) > AGENT_TRANSCRIPT_ENTRY_MAX_BYTES) {
      let serialized: string;
      try {
        serialized = JSON.stringify(entry.raw);
      } catch {
        serialized = entry.raw instanceof Error
          ? entry.raw.message
          : "[Unserializable raw transcript payload]";
      }
      next.raw = this.truncateTextForStorage(
        serialized,
        AGENT_TRANSCRIPT_ENTRY_MAX_BYTES,
        "Raw transcript payload"
      );
    }
    return next;
  }

  private capTranscriptEntries(agentId: string, transcript: AgentTranscriptEntry[]): AgentTranscriptEntry[] {
    const normalized = transcript.map((entry) => this.truncateTranscriptEntry(entry));
    const maximumCandidateCount = normalized.length > AGENT_TRANSCRIPT_MAX_ENTRIES
      ? AGENT_TRANSCRIPT_MAX_ENTRIES - 1
      : AGENT_TRANSCRIPT_MAX_ENTRIES;
    const firstCandidate = Math.max(0, normalized.length - maximumCandidateCount);
    const selected: AgentTranscriptEntry[] = [];
    let selectedBytes = 0;
    // Reserve enough room for the store envelope and an omission marker.
    const entryBudget = AGENT_TRANSCRIPT_MAX_BYTES - 4_096;
    for (let index = normalized.length - 1; index >= firstCandidate; index -= 1) {
      const entry = normalized[index];
      const entryBytes = this.serializedByteLength(entry) + 1;
      if (selectedBytes + entryBytes > entryBudget) {
        break;
      }
      selected.unshift(entry);
      selectedBytes += entryBytes;
    }

    const omittedEntries = normalized.length - selected.length;
    if (omittedEntries === 0) {
      return selected;
    }
    const markerTimestamp = selected[0]?.timestamp ?? normalized.at(-1)?.timestamp ?? nowIso();
    return [{
      id: `${agentId}:storage-truncation`,
      timestamp: markerTimestamp,
      kind: "event",
      title: "Earlier transcript entries truncated",
      text: `${STORAGE_TRUNCATION_MARKER} ${omittedEntries} earlier transcript entr${omittedEntries === 1 ? "y was" : "ies were"} removed to stay within storage limits.`,
      metadata: {
        truncated: true,
        omittedEntries,
        maxEntries: AGENT_TRANSCRIPT_MAX_ENTRIES,
        maxBytes: AGENT_TRANSCRIPT_MAX_BYTES
      }
    }, ...selected];
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
      entries: this.capTranscriptEntries(agent.id, transcript)
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
    await this.runFileOperation(transcriptPath, async () => {
      let entries: AgentTranscriptEntry[] = [];
      try {
        const existing = JSON.parse(
          await this.readTextFileBounded(transcriptPath, AGENT_TRANSCRIPT_MAX_BYTES)
        ) as AgentTranscriptStore;
        entries = Array.isArray(existing.entries) ? existing.entries : [];
      } catch {
        // Missing, malformed, or legacy-oversized transcript sidecars do not
        // affect primary project state. The new entry starts a bounded store.
      }

      const store: AgentTranscriptStore = {
        version: 1,
        projectId,
        agentId: agent.id,
        agentName: agent.name,
        updatedAt: nowIso(),
        entries: this.capTranscriptEntries(agent.id, [...entries, entry])
      };
      await this.writeJsonAtomicallyNow(transcriptPath, store);
    });
  }

  async getAgentTranscript(projectId: string, agentId: string): Promise<AgentTranscriptEntry[] | null> {
    const transcriptPath = this.projectAgentTranscriptPath(projectId, agentId);
    try {
      return await this.runFileOperation(transcriptPath, async () => {
        const store = JSON.parse(
          await this.readTextFileBounded(transcriptPath, AGENT_TRANSCRIPT_MAX_BYTES)
        ) as AgentTranscriptStore;
        return Array.isArray(store.entries) ? this.capTranscriptEntries(agentId, store.entries) : [];
      });
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
    const baseStore = {
      version: 1 as const,
      projectId,
      agentId: agent.id,
      agentName: agent.name,
      workflowCycleNumber: agent.workflowCycleNumber,
      updatedAt: nowIso()
    };
    let outputBudget = AGENT_FULL_OUTPUT_MAX_BYTES - 4_096;
    let store: AgentFullOutputStore = {
      ...baseStore,
      output: this.truncateTextForStorage(output, outputBudget, "Agent full output")
    };
    while (this.serializedByteLength(store) > AGENT_FULL_OUTPUT_MAX_BYTES && outputBudget > 1_024) {
      const overflow = this.serializedByteLength(store) - AGENT_FULL_OUTPUT_MAX_BYTES;
      outputBudget = Math.max(1_024, outputBudget - overflow - 1_024);
      store = {
        ...baseStore,
        output: this.truncateTextForStorage(output, outputBudget, "Agent full output")
      };
    }
    await this.writeJsonAtomically(this.projectAgentOutputPath(projectId, agent.id), store);
  }

  async getAgentFullOutput(projectId: string, agentId: string): Promise<string | null> {
    try {
      const outputPath = this.projectAgentOutputPath(projectId, agentId);
      const store = JSON.parse(
        // Allow bounded envelope headroom when reading sidecars written by an
        // older build whose output alone was close to the new cap.
        await this.readTextFileBounded(outputPath, AGENT_FULL_OUTPUT_MAX_BYTES + 64_000)
      ) as AgentFullOutputStore;
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
      const raw = await this.readTextFileBounded(interfacePath, PORTABLE_INTERFACE_MAX_LOAD_BYTES);
      const value = JSON.parse(raw) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
      }
      const serialized = value as Record<string, unknown>;
      if (typeof serialized.checksum !== "string" || serialized.checksum.length === 0) {
        return null;
      }
      const expectedChecksum = sha256(stableStringify({
        ...serialized,
        checksum: ""
      }));
      const isLegacyV1 = serialized.schemaVersion === 1;
      if (!isLegacyV1 && serialized.checksum !== expectedChecksum) {
        return null;
      }
      return portableInterfaceSchema.parse(value);
    } catch {
      return null;
    }
  }
}
