import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { APP_VERSION, PORTABLE_INTERFACE_PATH, REVIEW_LOG_BUNDLE_VERSION } from "@shared/constants";
import { createPortableInterface } from "@shared/defaults";
import { localProjectRecordSchema, portableInterfaceSchema, projectReviewLogBundleSchema } from "@shared/schemas";
import type {
  AgentCategory,
  AgentLifecycleStatus,
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
  return next;
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

  if (record.agents.some((agent) => agent.worktree)) {
    notes.push("Managed worktree paths were replaced with <managed-worktrees> and <agent-worktree>.");
  }

  if (record.userInputRequests.some((request) => request.attachmentInboxPath)) {
    notes.push("User input attachment inbox paths were replaced with <user-input-inbox>.");
  }

  return notes;
};

export class WorkbenchStorage {
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
        "Project and worktree paths were redacted, but repository content and tool output may still contain sensitive information.",
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

  private registryPath(): string {
    return path.join(this.appDataDir, "registry.json");
  }

  private settingsPath(): string {
    return path.join(this.appDataDir, "settings.json");
  }

  async ensureBaseDirs(): Promise<void> {
    await mkdir(path.join(this.appDataDir, "projects"), { recursive: true });
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
    await writeFile(this.registryPath(), JSON.stringify(projectIds, null, 2));
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
    await writeFile(this.settingsPath(), JSON.stringify(settings, null, 2));
  }

  async saveProject(record: LocalProjectRecord): Promise<void> {
    await this.ensureBaseDirs();
    await mkdir(this.projectDir(record.id), { recursive: true });
    await writeFile(this.projectStatePath(record.id), JSON.stringify(record, null, 2));
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
    await writeFile(this.projectCredentialSecretPath(projectId), JSON.stringify(store, null, 2));
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
    try {
      const raw = await readFile(this.projectStatePath(projectId), "utf8");
      return localProjectRecordSchema.parse(JSON.parse(raw)) as LocalProjectRecord;
    } catch {
      return null;
    }
  }

  async loadAllProjects(): Promise<LocalProjectRecord[]> {
    const projectIds = await this.loadRegistry();
    const records = await Promise.all(projectIds.map((projectId) => this.loadProject(projectId)));
    return records.filter((record): record is LocalProjectRecord => record !== null);
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
