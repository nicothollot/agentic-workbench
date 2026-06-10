import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  copyFile,
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

const backupIfNeeded = async (statePath, version) => {
  const directory = path.dirname(statePath);
  const prefix = `state.json.backup.sanitizer-v${version}.`;
  const entries = await readdir(directory);
  const existing = entries.find((entry) => entry.startsWith(prefix) && entry.endsWith(".json"));
  if (existing) {
    return path.join(directory, existing);
  }
  const backupPath = path.join(directory, `${prefix}${timestampForFile()}.json`);
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
      repairedMalformedJson: false,
      parseMessage: undefined
    };
  } catch (error) {
    const parseMessage = error instanceof Error ? error.message : String(error);
    const prefix = parseJsonObjectPrefix(raw);
    if (!prefix) {
      return {
        ok: false,
        parseMessage
      };
    }

    try {
      return {
        ok: true,
        parsed: JSON.parse(prefix),
        repairedMalformedJson: true,
        parseMessage
      };
    } catch {
      return {
        ok: false,
        parseMessage
      };
    }
  }
};

const quarantineFile = async (statePath) => {
  const quarantinePath = path.join(path.dirname(statePath), `state.json.quarantine.repair-${timestampForFile()}.json`);
  await rename(statePath, quarantinePath);
  return quarantinePath;
};

export const repairFile = async (statePath, sanitizer) => {
  const beforeText = await readFile(statePath, "utf8");
  const beforeBytes = Buffer.byteLength(beforeText);
  const parsedState = parseStateText(beforeText);
  if (!parsedState.ok) {
    const quarantinePath = await quarantineFile(statePath);
    return {
      statePath,
      changed: true,
      beforeBytes,
      afterBytes: 0,
      bytesSaved: beforeBytes,
      backupPath: undefined,
      quarantinePath,
      action: "quarantined",
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

  const { record, report } = sanitizer.sanitizeProjectRecord(parsedState.parsed);
  const afterText = JSON.stringify(record);
  const afterBytes = Buffer.byteLength(afterText);

  if (!report.changed && !parsedState.repairedMalformedJson) {
    return {
      statePath,
      changed: false,
      beforeBytes,
      afterBytes: beforeBytes,
      bytesSaved: 0,
      backupPath: undefined,
      quarantinePath: undefined,
      action: "unchanged",
      message: "State JSON parsed and no sanitizer changes were needed.",
      report
    };
  }

  const backupPath = await backupIfNeeded(statePath, sanitizer.STATE_SANITIZER_VERSION);
  const temporaryPath = `${statePath}.repair-${process.pid}-${Date.now()}.tmp`;
  await writeFile(temporaryPath, afterText);
  await rename(temporaryPath, statePath);
  return {
    statePath,
    changed: true,
    beforeBytes,
    afterBytes,
    bytesSaved: beforeBytes - afterBytes,
    backupPath,
    quarantinePath: undefined,
    action: parsedState.repairedMalformedJson ? "repaired-malformed-json" : "sanitized",
    message: parsedState.repairedMalformedJson
      ? `Kept the first complete JSON object after parse error: ${parsedState.parseMessage}`
      : "Sanitized oversized or duplicated state fields.",
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
    message: result.message,
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
