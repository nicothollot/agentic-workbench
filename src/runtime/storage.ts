import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { APP_VERSION, PORTABLE_INTERFACE_PATH, REVIEW_LOG_BUNDLE_VERSION } from "@shared/constants";
import { createPortableInterface } from "@shared/defaults";
import { localProjectRecordSchema, portableInterfaceSchema, projectReviewLogBundleSchema } from "@shared/schemas";
import type {
  AgentCategory,
  AgentLifecycleStatus,
  AgentTranscriptEntry,
  AppSettings,
  LocalProjectRecord,
  PortableProjectInterface,
  ProjectReviewLogBundle,
  ReviewLogRuntimeContext,
  ReviewLogSummary,
  ReviewLogTimelineEntry
} from "@shared/types";
import { nowIso, stableStringify, unique } from "@shared/utils";
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
  | { ok: true; value: unknown; repairedMalformedJson: boolean; message?: string }
  | { ok: false; message: string };

export interface StateLoadIssue {
  projectId: string;
  statePath: string;
  action: "repaired" | "quarantined" | "ignored";
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
    const bundle: ProjectReviewLogBundle = {
      schemaVersion: REVIEW_LOG_BUNDLE_VERSION,
      appVersion: APP_VERSION,
      exportedAt: nowIso(),
      context: buildReviewLogRuntimeContext(settings),
      summary: buildReviewLogSummary(record),
      redactions: buildRedactionNotes(record),
      warnings: [
        "Project/worktree paths and common secret-looking values were redacted, but repository content may still contain project-sensitive information.",
        "The bundle only includes the workflow, events, and command output currently retained by the app."
      ],
      project: {
        id: record.id,
        identity: record.identity,
        validation: record.validation,
        localState: record.localState,
        workflow: record.workflow,
        interfaceCreation: record.interfaceCreation,
        overview: record.overview,
        stats: record.stats,
        dependencies: record.dependencies
      },
      agents: record.agents,
      userInputRequests: record.userInputRequests,
      diagnostics,
      timeline: buildReviewTimeline(record)
    };

    const sanitized = sanitizeReviewValue(bundle, collectPathReplacements(record)) as ProjectReviewLogBundle;
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

  private projectAgentTranscriptDir(projectId: string): string {
    return path.join(this.projectDir(projectId), "agent-transcripts");
  }

  private projectAgentTranscriptPath(projectId: string, agentId: string): string {
    return path.join(this.projectAgentTranscriptDir(projectId), `${agentId}.json`);
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

  private parseProjectStateText(raw: string): ProjectStateParseResult {
    try {
      return { ok: true, value: JSON.parse(raw), repairedMalformedJson: false };
    } catch (error) {
      const parseMessage = error instanceof Error ? error.message : String(error);
      const trimmed = raw.trimStart();
      if (!trimmed.startsWith("{")) {
        return {
          ok: false,
          message: parseMessage
        };
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
        } else if (char === "}") {
          depth -= 1;
          if (depth === 0) {
            const candidate = raw.slice(startOffset, index + 1);
            try {
              return {
                ok: true,
                value: JSON.parse(candidate),
                repairedMalformedJson: true,
                message: `Parsed the first complete JSON object and discarded ${raw.length - index - 1} trailing character(s). Original parse error: ${parseMessage}`
              };
            } catch {
              break;
            }
          }
        }
      }

      return {
        ok: false,
        message: parseMessage
      };
    }
  }

  private async quarantineProjectState(projectId: string, statePath: string, message: string): Promise<string> {
    const timestamp = nowIso().replace(/[:.]/g, "-");
    const quarantinePath = path.join(this.projectDir(projectId), `state.json.quarantine.${timestamp}.json`);
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

  async loadProject(projectId: string): Promise<LocalProjectRecord | null> {
    const statePath = this.projectStatePath(projectId);
    try {
      const raw = await readFile(statePath, "utf8");
      const parsed = this.parseProjectStateText(raw);
      if (!parsed.ok) {
        await this.quarantineProjectState(projectId, statePath, `Malformed JSON. ${parsed.message}`);
        return null;
      }
      const parsedJson = parsed.value as LocalProjectRecord;
      const sanitized = sanitizeProjectRecord(parsedJson);
      const record = localProjectRecordSchema.parse(sanitized.record) as LocalProjectRecord;
      if (sanitized.report.changed || parsed.repairedMalformedJson) {
        await this.backupProjectStateBeforeMigration(projectId, statePath);
        await this.writeJsonAtomically(statePath, record);
        if (parsed.repairedMalformedJson) {
          this.recordLoadIssue({
            projectId,
            statePath,
            action: "repaired",
            message: parsed.message ?? "Malformed JSON was repaired by keeping the first complete JSON object."
          });
        }
        this.logSanitizerReport(projectId, raw.length, JSON.stringify(record).length, sanitized.report);
      }
      return record;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return null;
      }
      const message = error instanceof Error ? error.message : String(error);
      await this.quarantineProjectState(projectId, statePath, `State validation failed. ${message}`).catch((quarantineError) => {
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

  async appendAgentTranscriptEntry(projectId: string, agent: Pick<LocalProjectRecord["agents"][number], "id" | "name">, entry: AgentTranscriptEntry): Promise<void> {
    await this.ensureBaseDirs();
    await mkdir(this.projectAgentTranscriptDir(projectId), { recursive: true });
    const transcriptPath = this.projectAgentTranscriptPath(projectId, agent.id);
    let store: AgentTranscriptStore = {
      version: 1,
      projectId,
      agentId: agent.id,
      agentName: agent.name,
      updatedAt: nowIso(),
      entries: []
    };
    try {
      const existing = JSON.parse(await readFile(transcriptPath, "utf8")) as AgentTranscriptStore;
      store = {
        version: 1,
        projectId,
        agentId: agent.id,
        agentName: agent.name,
        updatedAt: nowIso(),
        entries: Array.isArray(existing.entries) ? existing.entries : []
      };
    } catch {
      // Missing or malformed transcript sidecars should not affect the primary project state.
    }

    store.entries.push(entry);
    if (store.entries.length > 2_000) {
      store.entries = store.entries.slice(-2_000);
    }
    store.updatedAt = nowIso();
    await this.writeJsonAtomically(transcriptPath, store);
  }

  async readAgentTranscript(projectId: string, agentId: string): Promise<AgentTranscriptEntry[] | null> {
    try {
      const transcriptPath = this.projectAgentTranscriptPath(projectId, agentId);
      const store = JSON.parse(await readFile(transcriptPath, "utf8")) as AgentTranscriptStore;
      return Array.isArray(store.entries) ? store.entries : [];
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
