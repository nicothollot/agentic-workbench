import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSettings } from "@shared/defaults";
import type { AgentTranscriptEntry } from "@shared/types";
import {
  AGENT_FULL_OUTPUT_MAX_BYTES,
  AGENT_TRANSCRIPT_MAX_ENTRIES,
  CREDENTIAL_STORE_MAX_LOAD_BYTES,
  CredentialStorageError,
  SETTINGS_MAX_LOAD_BYTES,
  WorkbenchStorage,
  type SecretStorageCodec
} from "@runtime/storage";
import { createTempDir } from "./helpers";

const transcriptEntry = (index: number): AgentTranscriptEntry => ({
  id: `entry-${index}`,
  timestamp: new Date(index * 1_000).toISOString(),
  kind: "message",
  title: `Message ${index}`,
  text: `Transcript body ${index}`
});

const reversibleSecretCodec = (): SecretStorageCodec => ({
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`encrypted:${value}`, "utf8"),
  decryptString: (value) => value.toString("utf8").replace(/^encrypted:/, "")
});

describe("WorkbenchStorage hardening", () => {
  it("returns only fully validated settings and refuses oversized settings files", async () => {
    const appDataDir = await createTempDir("storage-settings-validation");
    const settingsPath = path.join(appDataDir, "settings.json");
    const storage = new WorkbenchStorage(appDataDir);
    await mkdir(appDataDir, { recursive: true });

    await writeFile(settingsPath, JSON.stringify({ ...defaultSettings(), unexpected: "discard me" }));
    const valid = await storage.loadSettings();
    expect(valid).toEqual(defaultSettings());
    expect(valid).not.toHaveProperty("unexpected");

    await writeFile(settingsPath, JSON.stringify({ ...defaultSettings(), maxRepairCycles: 99 }));
    await expect(storage.loadSettings()).resolves.toBeNull();

    await writeFile(settingsPath, "x".repeat(SETTINGS_MAX_LOAD_BYTES + 1));
    await expect(storage.loadSettings()).resolves.toBeNull();
  });

  it("validates settings before atomically replacing the last known-good file", async () => {
    const appDataDir = await createTempDir("storage-settings-save-validation");
    const storage = new WorkbenchStorage(appDataDir);
    const settings = defaultSettings();
    await storage.saveSettings(settings as unknown as Record<string, unknown>);

    await expect(storage.saveSettings({ ...settings, executionMode: "invalid" }))
      .rejects.toThrow();
    await expect(storage.loadSettings()).resolves.toEqual(settings);
  });

  it("creates one timestamped backup per source version and exposes atomic replacement", async () => {
    const appDataDir = await createTempDir("storage-versioned-backup");
    const sourcePath = path.join(appDataDir, "state.json");
    const storage = new WorkbenchStorage(appDataDir);
    await mkdir(appDataDir, { recursive: true });
    await writeFile(sourcePath, JSON.stringify({ schemaVersion: 1, value: "before" }));

    const backups = await Promise.all([
      storage.createVersionedBackupOnce(sourcePath, 1),
      storage.createVersionedBackupOnce(sourcePath, 1)
    ]);
    expect(backups.filter((backup) => backup.created)).toHaveLength(1);
    expect(new Set(backups.map((backup) => backup.backupPath)).size).toBe(1);
    expect(JSON.parse(await readFile(backups[0].backupPath, "utf8"))).toEqual({
      schemaVersion: 1,
      value: "before"
    });

    await storage.replaceJsonAtomically(sourcePath, { schemaVersion: 2, value: "after" });
    expect(JSON.parse(await readFile(sourcePath, "utf8"))).toEqual({ schemaVersion: 2, value: "after" });
    const versionTwo = await storage.createVersionedBackupOnce(sourcePath, 2);
    expect(versionTwo.created).toBe(true);
    const backupFiles = (await readdir(appDataDir)).filter((entry) => entry.includes(".backup.source-v"));
    expect(backupFiles).toHaveLength(2);
  });

  it("never writes new plaintext credentials and reports encrypted credentials as locked", async () => {
    const appDataDir = await createTempDir("storage-credential-locking");
    let available = true;
    const codec: SecretStorageCodec = {
      isEncryptionAvailable: () => available,
      encryptString: (value) => Buffer.from(`encrypted:${value}`, "utf8"),
      decryptString: (value) => value.toString("utf8").replace(/^encrypted:/, "")
    };
    const storage = new WorkbenchStorage(appDataDir, codec);
    await storage.saveCredentialSecret("project", "entry", {
      apiKey: "api-secret-value",
      secretKey: "secondary-secret"
    });

    const credentialPath = path.join(appDataDir, "projects", "project", "credentials.secrets.json");
    const persisted = await readFile(credentialPath, "utf8");
    expect(persisted).not.toContain("api-secret-value");
    expect(await storage.readCredentialSecret("project", "entry")).toEqual({
      apiKey: "api-secret-value",
      secretKey: "secondary-secret"
    });

    available = false;
    await expect(storage.readCredentialSecret("project", "entry")).rejects.toMatchObject({
      name: "CredentialStorageError",
      code: "credential_storage_locked"
    } satisfies Partial<CredentialStorageError>);

    const unavailableStorage = new WorkbenchStorage(await createTempDir("storage-credential-unavailable"));
    await expect(unavailableStorage.saveCredentialSecret("project", "entry", { apiKey: "must-not-persist" }))
      .rejects.toMatchObject({
        name: "CredentialStorageError",
        code: "credential_storage_unavailable"
      } satisfies Partial<CredentialStorageError>);
  });

  it("keeps legacy plaintext readable without treating ciphertext as plaintext", async () => {
    const appDataDir = await createTempDir("storage-legacy-credential");
    const projectDir = path.join(appDataDir, "projects", "project");
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, "credentials.secrets.json"), JSON.stringify({
      version: 1,
      entries: {
        legacy: {
          apiKey: { encoding: "plain", value: "legacy-plain-value" },
          updatedAt: "2026-07-21T00:00:00.000Z"
        },
        encrypted: {
          apiKey: { encoding: "safeStorage", value: Buffer.from("ciphertext").toString("base64") },
          updatedAt: "2026-07-21T00:00:00.000Z"
        }
      }
    }));
    const storage = new WorkbenchStorage(appDataDir);

    await expect(storage.readCredentialSecret("project", "legacy")).resolves.toEqual({
      apiKey: "legacy-plain-value",
      secretKey: undefined
    });
    await expect(storage.readCredentialSecret("project", "encrypted")).rejects.toMatchObject({
      code: "credential_storage_locked"
    });
  });

  it("serializes the complete credential read-modify-write operation", async () => {
    const appDataDir = await createTempDir("storage-credential-concurrency");
    const storage = new WorkbenchStorage(appDataDir, reversibleSecretCodec());
    await Promise.all(Array.from({ length: 80 }, (_, index) =>
      storage.saveCredentialSecret("project", `entry-${index}`, { apiKey: `secret-${index}` })
    ));

    const credentialPath = path.join(appDataDir, "projects", "project", "credentials.secrets.json");
    const firstStore = JSON.parse(await readFile(credentialPath, "utf8")) as { entries: Record<string, unknown> };
    expect(Object.keys(firstStore.entries)).toHaveLength(80);
    await expect(storage.readCredentialSecret("project", "entry-0")).resolves.toMatchObject({ apiKey: "secret-0" });
    await expect(storage.readCredentialSecret("project", "entry-79")).resolves.toMatchObject({ apiKey: "secret-79" });

    await Promise.all([
      ...Array.from({ length: 20 }, (_, index) => storage.deleteCredentialSecret("project", `entry-${index}`)),
      ...Array.from({ length: 20 }, (_, index) =>
        storage.saveCredentialSecret("project", `replacement-${index}`, { apiKey: `replacement-secret-${index}` })
      )
    ]);
    const secondStore = JSON.parse(await readFile(credentialPath, "utf8")) as { entries: Record<string, unknown> };
    expect(Object.keys(secondStore.entries)).toHaveLength(80);
    expect(secondStore.entries).not.toHaveProperty("entry-0");
    expect(secondStore.entries).toHaveProperty("replacement-19");
  });

  it("fails closed and preserves malformed or schema-invalid credential stores", async () => {
    const appDataDir = await createTempDir("storage-credential-corruption");
    const projectDir = path.join(appDataDir, "projects", "project");
    const credentialPath = path.join(projectDir, "credentials.secrets.json");
    const storage = new WorkbenchStorage(appDataDir, reversibleSecretCodec());
    await mkdir(projectDir, { recursive: true });

    for (const invalidStore of [
      "{ malformed credential JSON",
      JSON.stringify({
        version: 1,
        entries: {
          entry: {
            apiKey: { encoding: "safeStorage", value: "not base64!" },
            updatedAt: "not-an-iso-timestamp",
            unexpected: true
          }
        }
      })
    ]) {
      await writeFile(credentialPath, invalidStore);

      await expect(storage.saveCredentialSecret("project", "new-entry", { apiKey: "new-secret" }))
        .rejects.toMatchObject({ code: "credential_store_corrupt" });
      await expect(storage.deleteCredentialSecret("project", "entry"))
        .rejects.toMatchObject({ code: "credential_store_corrupt" });
      await expect(storage.hasCredentialSecret("project", "entry"))
        .rejects.toMatchObject({ code: "credential_store_corrupt" });
      expect(await readFile(credentialPath, "utf8")).toBe(invalidStore);
    }
  });

  it("fails closed without replacing an oversized credential store", async () => {
    const appDataDir = await createTempDir("storage-credential-oversized");
    const projectDir = path.join(appDataDir, "projects", "project");
    const credentialPath = path.join(projectDir, "credentials.secrets.json");
    const storage = new WorkbenchStorage(appDataDir, reversibleSecretCodec());
    const oversizedStore = "x".repeat(CREDENTIAL_STORE_MAX_LOAD_BYTES + 1);
    await mkdir(projectDir, { recursive: true });
    await writeFile(credentialPath, oversizedStore);

    await expect(storage.saveCredentialSecret("project", "new-entry", { apiKey: "new-secret" }))
      .rejects.toMatchObject({ code: "credential_store_corrupt" });
    expect((await stat(credentialPath)).size).toBe(Buffer.byteLength(oversizedStore));
    expect(await readFile(credentialPath, "utf8")).toBe(oversizedStore);
  });

  it("serializes concurrent transcript append operations without losing entries", async () => {
    const appDataDir = await createTempDir("storage-transcript-concurrency");
    const storage = new WorkbenchStorage(appDataDir);
    const agent = { id: "agent", name: "Concurrent Agent" };
    await Promise.all(Array.from({ length: 120 }, (_, index) =>
      storage.appendAgentTranscriptEntry("project", agent, transcriptEntry(index))
    ));

    const entries = await storage.readAgentTranscript("project", agent.id);
    expect(entries).toHaveLength(120);
    expect(new Set(entries?.map((entry) => entry.id)).size).toBe(120);
  });

  it("rejects traversal identifiers before resolving project or agent sidecar paths", async () => {
    const appDataDir = await createTempDir("storage-sidecar-traversal");
    const storage = new WorkbenchStorage(appDataDir);
    const outsideAgentPath = path.join(appDataDir, "escape.json");

    await expect(storage.saveAgentTranscript(
      "project",
      { id: "../../../escape", name: "Untrusted Agent" },
      [transcriptEntry(1)]
    )).rejects.toThrow("Storage identifiers");
    await expect(storage.saveAgentFullOutput(
      "../outside-project",
      { id: "agent", name: "Untrusted Project" },
      "must not be written"
    )).rejects.toThrow("Storage identifiers");
    await expect(stat(outsideAgentPath)).rejects.toThrow();
  });

  it("filters traversal project identifiers from the persisted registry", async () => {
    const appDataDir = await createTempDir("storage-registry-traversal");
    const storage = new WorkbenchStorage(appDataDir);
    await mkdir(appDataDir, { recursive: true });
    await writeFile(path.join(appDataDir, "registry.json"), JSON.stringify([
      "safe-project",
      "../outside",
      "nested/project",
      "also_safe"
    ]));

    await expect(storage.loadRegistry()).resolves.toEqual(["safe-project", "also_safe"]);
    await expect(storage.saveRegistry(["safe-project", "../outside"])).rejects.toThrow("Storage identifiers");
  });

  it("caps transcripts and full output with explicit truncation markers", async () => {
    const appDataDir = await createTempDir("storage-output-caps");
    const storage = new WorkbenchStorage(appDataDir);
    const agent = { id: "agent", name: "Verbose Agent" };
    await storage.saveAgentTranscript(
      "project",
      agent,
      Array.from({ length: AGENT_TRANSCRIPT_MAX_ENTRIES + 5 }, (_, index) => transcriptEntry(index))
    );

    const entries = await storage.readAgentTranscript("project", agent.id);
    expect(entries?.length).toBeLessThanOrEqual(AGENT_TRANSCRIPT_MAX_ENTRIES);
    expect(entries?.[0]?.metadata).toMatchObject({ truncated: true });
    expect(entries?.[0]?.text).toContain("truncated by Agent Workbench storage limits");

    const oversizedOutput = `begin\n${"x".repeat(AGENT_FULL_OUTPUT_MAX_BYTES)}\nend`;
    await storage.saveAgentFullOutput("project", agent, oversizedOutput);
    const output = await storage.getAgentFullOutput("project", agent.id);
    const outputPath = path.join(appDataDir, "projects", "project", "agent-outputs", "agent.json");
    expect((await stat(outputPath)).size).toBeLessThanOrEqual(AGENT_FULL_OUTPUT_MAX_BYTES);
    expect(output).toContain("truncated by Agent Workbench storage limits");
    expect(output).toContain("begin");
    expect(output).toContain("end");
  });
});
