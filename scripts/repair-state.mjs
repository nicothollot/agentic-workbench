import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile
} from "node:fs/promises";
import ts from "typescript";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const usage = `Usage:
  npm run repair:state -- /path/to/state.json
  npm run repair:state -- /path/to/projects
  npm run repair:state

Without a path, the script scans the default Codex Agent Workbench app-data projects folder.`;

const timestampForFile = () => new Date().toISOString().replace(/[:.]/g, "-");
const PROJECT_STATE_COMPACT_BYTES = 1_500_000;
const SIDE_CAR_PRESERVE_TEXT_BYTES = 12_000;
const SIDE_CAR_PRESERVE_EVENT_BYTES = 8_000;

const fileExists = async (filePath) => {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
};

export const loadSanitizer = async () => {
  const sourcePath = path.join(repoRoot, "src", "runtime", "stateSanitizer.ts");
  const source = await readFile(sourcePath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove
    }
  }).outputText;
  const sandbox = { exports: {}, require };
  vm.runInNewContext(output, sandbox, { filename: sourcePath });
  return sandbox.exports;
};

const defaultProjectsDirCandidates = () => {
  const candidates = [];
  if (process.env.AWB_PROJECTS_DIR) {
    candidates.push(process.env.AWB_PROJECTS_DIR);
  }
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, "codex-agent-workbench", "projects"));
  }
  const windowsUser = process.env.USERNAME ?? process.env.USER;
  if (windowsUser) {
    candidates.push(path.join("/mnt/c/Users", windowsUser, "AppData", "Roaming", "codex-agent-workbench", "projects"));
  }
  if (process.env.HOME) {
    candidates.push(path.join(process.env.HOME, "AppData", "Roaming", "codex-agent-workbench", "projects"));
  }
  return candidates;
};

const resolveDefaultProjectsDir = async () => {
  for (const candidate of defaultProjectsDirCandidates()) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
};

export const findStateFiles = async (targetPath) => {
  const absolute = path.resolve(targetPath);
  const targetStat = await stat(absolute);
  if (targetStat.isFile()) {
    return [absolute];
  }
  if (!targetStat.isDirectory()) {
    return [];
  }

  const directState = path.join(absolute, "state.json");
  if (await fileExists(directState)) {
    return [directState];
  }

  const entries = await readdir(absolute, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const statePath = path.join(absolute, entry.name, "state.json");
    if (await fileExists(statePath)) {
      files.push(statePath);
    }
  }
  return files.sort();
};

const backupStateFile = async (statePath, label) => {
  const directory = path.dirname(statePath);
  const backupPath = path.join(directory, `state.json.backup.${label}.${timestampForFile()}.json`);
  await copyFile(statePath, backupPath);
  return backupPath;
};

export const parseJsonObjectPrefix = (raw) => {
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
};

export const parseStateText = (raw) => {
  try {
    return {
      ok: true,
      parsed: JSON.parse(raw),
      issue: undefined,
      parseMessage: undefined
    };
  } catch (error) {
    const parseMessage = error instanceof Error ? error.message : String(error);
    const prefix = parseJsonObjectPrefix(raw);
    if (!prefix) {
      return {
        ok: false,
        issue: "malformed_json",
        parseMessage
      };
    }

    const startOffset = raw.length - raw.trimStart().length;
    const trailing = raw.slice(startOffset + prefix.length).trim();
    if (trailing.startsWith("{") || trailing.startsWith("[")) {
      return {
        ok: false,
        issue: "duplicate_appended_json",
        parseMessage: `A complete JSON object is followed by ${trailing.length} trailing character(s). Original parse error: ${parseMessage}`
      };
    }

    return {
      ok: false,
      issue: "malformed_json",
      parseMessage
    };
  }
};

const quarantineReasonSlug = (value) => {
  const slug = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "invalid-state";
};

const quarantineFile = async (statePath, reason) => {
  const quarantinePath = path.join(path.dirname(statePath), `state.json.quarantine.repair-${quarantineReasonSlug(reason)}.${timestampForFile()}.json`);
  await rename(statePath, quarantinePath);
  return quarantinePath;
};

const serializedByteLength = (value) => {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return typeof text === "string" ? Buffer.byteLength(text) : 0;
  } catch {
    return 0;
  }
};

const transcriptEntriesFromAgent = (projectId, agent) => {
  const commandEntries = Array.isArray(agent.commandLog)
    ? agent.commandLog.map((command, index) => ({
      id: `${agent.id}:command:${command.itemId ?? index}`,
      timestamp: command.completedAt ?? command.startedAt ?? new Date(0).toISOString(),
      kind: "command",
      itemId: command.itemId,
      title: command.command ?? "Command output",
      text: command.output ?? "",
      metadata: {
        status: command.status ?? "unknown",
        exitCode: command.exitCode ?? null,
        cwd: command.cwd ?? null
      }
    }))
    : [];
  const eventEntries = Array.isArray(agent.events)
    ? agent.events.map((event) => ({
      id: `${agent.id}:event:${event.id}`,
      timestamp: event.timestamp ?? new Date(0).toISOString(),
      kind: event.type === "message" ? "message" : event.type === "raw" ? "raw" : "event",
      itemId: event.itemId,
      title: event.title ?? "Agent event",
      text: event.detail,
      raw: event.raw,
      metadata: {
        status: event.status ?? null,
        type: event.type ?? "event",
        projectId
      }
    }))
    : [];
  const approvalEntries = Array.isArray(agent.approvals)
    ? agent.approvals.map((approval) => ({
      id: `${agent.id}:approval:${approval.id}`,
      timestamp: approval.createdAt ?? new Date(0).toISOString(),
      kind: "approval",
      itemId: approval.itemId,
      title: "Approval requested",
      text: [approval.summary, approval.reason, approval.command].filter(Boolean).join("\n\n"),
      metadata: {
        status: approval.status ?? "unknown",
        kind: approval.kind ?? "approval"
      }
    }))
    : [];
  return [...eventEntries, ...commandEntries, ...approvalEntries]
    .filter((entry) => entry.text?.trim() || entry.raw !== undefined || entry.title?.trim())
    .sort((left, right) => String(left.timestamp).localeCompare(String(right.timestamp)));
};

const transcriptOutputText = (entries) => entries
  .map((entry) => {
    const heading = `[${entry.timestamp}] ${String(entry.kind).toUpperCase()} - ${entry.title}`;
    const body = entry.text?.trim()
      ? entry.text
      : entry.raw !== undefined
        ? JSON.stringify(entry.raw, null, 2)
        : "";
    return body ? `${heading}\n${body}` : heading;
  })
  .join("\n\n");

const agentHasSidecarWorthyOutput = (agent) =>
  Array.isArray(agent.commandLog) && agent.commandLog.some((command) => Buffer.byteLength(command.output ?? "") > SIDE_CAR_PRESERVE_TEXT_BYTES) ||
  Array.isArray(agent.events) && agent.events.some((event) =>
    Buffer.byteLength(event.detail ?? "") > SIDE_CAR_PRESERVE_EVENT_BYTES ||
    serializedByteLength(event.raw) > SIDE_CAR_PRESERVE_EVENT_BYTES
  );

const writeJsonAtomically = async (filePath, value) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.repair-${process.pid}-${Date.now()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(value));
  await rename(temporaryPath, filePath);
};

const preserveAgentOutputSidecars = async (statePath, record, options = {}) => {
  const projectId = record?.id ?? path.basename(path.dirname(statePath));
  const agents = Array.isArray(record?.agents) ? record.agents : [];
  let written = 0;
  for (const agent of agents) {
    if (!agent?.id || (!options.force && !agentHasSidecarWorthyOutput(agent))) {
      continue;
    }
    const entries = transcriptEntriesFromAgent(projectId, agent);
    if (entries.length === 0) {
      continue;
    }
    const updatedAt = new Date().toISOString();
    await writeJsonAtomically(path.join(path.dirname(statePath), "agent-transcripts", `${agent.id}.json`), {
      version: 1,
      projectId,
      agentId: agent.id,
      agentName: agent.name ?? agent.id,
      updatedAt,
      entries
    });
    await writeJsonAtomically(path.join(path.dirname(statePath), "agent-outputs", `${agent.id}.json`), {
      version: 1,
      projectId,
      agentId: agent.id,
      agentName: agent.name ?? agent.id,
      workflowCycleNumber: agent.workflowCycleNumber,
      updatedAt,
      output: transcriptOutputText(entries)
    });
    agent.outputReference = {
      agentId: agent.id,
      workflowCycleNumber: agent.workflowCycleNumber,
      transcriptAvailable: true,
      fullOutputAvailable: true,
      updatedAt
    };
    written += 1;
  }
  return written;
};

export const repairFile = async (statePath, sanitizer) => {
  const beforeText = await readFile(statePath, "utf8");
  const beforeBytes = Buffer.byteLength(beforeText);
  const parsedState = parseStateText(beforeText);
  if (!parsedState.ok) {
    const backupPath = await backupStateFile(statePath, `repair-malformed-${parsedState.issue ?? "json"}`);
    const quarantinePath = await quarantineFile(statePath, parsedState.issue ?? "malformed-json");
    return {
      statePath,
      changed: true,
      beforeBytes,
      afterBytes: 0,
      bytesSaved: beforeBytes,
      backupPath,
      quarantinePath,
      action: "quarantined",
      issue: parsedState.issue ?? "malformed_json",
      message: `Malformed JSON could not be repaired: ${parsedState.parseMessage}`,
      report: {
        checklistItemsSanitized: 0,
        evidenceFieldsTruncated: 0,
        evidenceHistoryEntriesRemoved: 0,
        duplicateEvidenceLinesRemoved: 0,
        consolidationNotesRemoved: 0,
        activityEventsRemoved: 0,
        agentEventsRemoved: 0,
        commandRecordsRemoved: 0,
        agentsCompacted: 0
      }
    };
  }

  const sidecarsWritten = await preserveAgentOutputSidecars(statePath, parsedState.parsed, { force: beforeBytes > PROJECT_STATE_COMPACT_BYTES });
  const { record, report } = sanitizer.sanitizeProjectRecord(parsedState.parsed);
  const afterText = JSON.stringify(record);
  const afterBytes = Buffer.byteLength(afterText);

  if (!report.changed && beforeBytes <= PROJECT_STATE_COMPACT_BYTES) {
    return {
      statePath,
      changed: false,
      beforeBytes,
      afterBytes: beforeBytes,
      bytesSaved: 0,
      backupPath: undefined,
      quarantinePath: undefined,
      action: "unchanged",
      issue: undefined,
      message: "State JSON parsed and no sanitizer changes were needed.",
      sidecarsWritten,
      report
    };
  }

  const backupPath = await backupStateFile(statePath, `sanitizer-v${sanitizer.STATE_SANITIZER_VERSION}`);
  await writeJsonAtomically(statePath, record);
  return {
    statePath,
    changed: true,
    beforeBytes,
    afterBytes,
    bytesSaved: beforeBytes - afterBytes,
    backupPath,
    quarantinePath: undefined,
    action: beforeBytes > PROJECT_STATE_COMPACT_BYTES ? "compacted" : "sanitized",
    issue: beforeBytes > PROJECT_STATE_COMPACT_BYTES ? "oversized_valid_state" : "sanitizer_changes",
    message: beforeBytes > PROJECT_STATE_COMPACT_BYTES
      ? "Compacted oversized valid state and preserved full output sidecars where possible."
      : "Sanitized oversized or duplicated state fields.",
    sidecarsWritten,
    report
  };
};

const formatBytes = (value) => `${value} bytes`;

export const buildPrintableResult = (result) => ({
    statePath: result.statePath,
    changed: result.changed,
    before: formatBytes(result.beforeBytes),
    after: formatBytes(result.afterBytes),
    bytesSaved: result.bytesSaved,
    backupPath: result.backupPath,
    quarantinePath: result.quarantinePath,
    action: result.action,
    issue: result.issue,
    message: result.message,
    sidecarsWritten: result.sidecarsWritten ?? 0,
    checklistItemsSanitized: result.report.checklistItemsSanitized,
    evidenceFieldsTruncated: result.report.evidenceFieldsTruncated,
    evidenceHistoryEntriesRemoved: result.report.evidenceHistoryEntriesRemoved,
    duplicateEvidenceLinesRemoved: result.report.duplicateEvidenceLinesRemoved,
    consolidationNotesRemoved: result.report.consolidationNotesRemoved,
    activityEventsRemoved: result.report.activityEventsRemoved,
    agentEventsRemoved: result.report.agentEventsRemoved,
    commandRecordsRemoved: result.report.commandRecordsRemoved,
    agentsCompacted: result.report.agentsCompacted
  });

const printResult = (result) => {
  console.log(JSON.stringify(buildPrintableResult(result)));
};

export const main = async () => {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage);
    return;
  }

  const target = args[0] ?? await resolveDefaultProjectsDir();
  if (!target) {
    throw new Error("No state path provided and no default projects directory was found.");
  }

  const sanitizer = await loadSanitizer();
  const stateFiles = await findStateFiles(target);
  if (stateFiles.length === 0) {
    throw new Error(`No state.json files found under ${target}`);
  }

  let changed = 0;
  let totalBytesSaved = 0;
  for (const statePath of stateFiles) {
    try {
      const result = await repairFile(statePath, sanitizer);
      printResult(result);
      if (result.changed) {
        changed += 1;
        totalBytesSaved += result.bytesSaved;
      }
    } catch (error) {
      console.log(JSON.stringify({
        statePath,
        changed: false,
        action: "failed",
        message: error instanceof Error ? error.message : String(error)
      }));
    }
  }

  console.log(JSON.stringify({
    scanned: stateFiles.length,
    changed,
    totalBytesSaved
  }));
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
