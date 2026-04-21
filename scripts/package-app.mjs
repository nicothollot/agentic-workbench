import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const stageDir = path.join(rootDir, ".electron-builder", "app");
const packageOutputRoot = path.join(rootDir, ".electron-builder", "out");

const appTargets = new Set(["win", "mac"]);
const windowsSigningModes = new Set(["auto", "required", "disabled"]);

const hasValue = (value) => typeof value === "string" && value.trim().length > 0;

const normalizeSigningModeEnvValue = (value) => {
  if (!hasValue(value)) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on", "required", "force", "signed"].includes(normalized)) {
    return "required";
  }
  if (["0", "false", "no", "off", "disabled", "unsigned"].includes(normalized)) {
    return "disabled";
  }
  if (normalized === "auto") {
    return "auto";
  }

  throw new Error(`Invalid AWB_SIGN_WINDOWS value: ${value}`);
};

const getFirstEnvValue = (env, keys) => {
  for (const key of keys) {
    if (hasValue(env[key])) {
      return env[key].trim();
    }
  }

  return undefined;
};

export const isWslEnvironment = (env = process.env, platform = process.platform) => {
  if (platform !== "linux") {
    return false;
  }

  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) {
    return true;
  }

  try {
    const version = existsSync("/proc/version")
      ? readFileSync("/proc/version", "utf8").toLowerCase()
      : "";
    return version.includes("microsoft") || version.includes("wsl");
  } catch {
    return false;
  }
};

const directoryExists = (directoryPath) => {
  try {
    return statSync(directoryPath).isDirectory();
  } catch {
    return false;
  }
};

const expandHome = (inputPath) => {
  if (inputPath === "~") {
    return os.homedir();
  }
  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
};

export const windowsPathToWslPath = (inputPath) => {
  const normalized = inputPath.trim().replace(/\\/g, "/");
  const driveMatch = /^([a-zA-Z]):\/(.*)$/.exec(normalized);
  if (!driveMatch) {
    return normalized;
  }

  return `/mnt/${driveMatch[1].toLowerCase()}/${driveMatch[2]}`;
};

const normalizeOutputOverride = (outputPath) => {
  const expanded = expandHome(outputPath);
  if (isWslEnvironment() && /^[a-zA-Z]:[\\/]/.test(expanded)) {
    return windowsPathToWslPath(expanded);
  }

  return path.resolve(expanded);
};

const readWindowsUserProfileFromCmd = () => {
  const result = spawnSync("cmd.exe", ["/d", "/s", "/c", "echo %USERPROFILE%"], {
    encoding: "utf8",
    windowsHide: true
  });

  if (result.status !== 0 || result.error) {
    return undefined;
  }

  const profile = result.stdout.trim().split(/\r?\n/).at(-1)?.trim();
  return profile && /^[a-zA-Z]:[\\/]/.test(profile) ? profile : undefined;
};

const resolveWslWindowsDownloadsDir = () => {
  const profile = readWindowsUserProfileFromCmd();
  if (profile) {
    const downloadsPath = windowsPathToWslPath(path.win32.join(profile, "Downloads"));
    if (directoryExists(downloadsPath)) {
      return downloadsPath;
    }
  }

  const username = os.userInfo().username;
  const matchingLinuxUsername = `/mnt/c/Users/${username}/Downloads`;
  if (directoryExists(matchingLinuxUsername)) {
    return matchingLinuxUsername;
  }

  const usersRoot = "/mnt/c/Users";
  if (directoryExists(usersRoot)) {
    const ignoredNames = new Set(["All Users", "Default", "Default User", "Public", "desktop.ini"]);
    const candidate = readdirSync(usersRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !ignoredNames.has(entry.name))
      .map((entry) => path.posix.join(usersRoot, entry.name, "Downloads"))
      .find((downloadsPath) => directoryExists(downloadsPath));

    if (candidate) {
      return candidate;
    }
  }

  return undefined;
};

export const resolveDownloadsDir = (env = process.env, platform = process.platform) => {
  const override = env.AWB_PACKAGE_OUTPUT_DIR || env.AWB_DOWNLOADS_DIR;
  if (override) {
    return normalizeOutputOverride(override);
  }

  if (platform === "win32") {
    return path.win32.join(env.USERPROFILE || os.homedir(), "Downloads");
  }

  if (isWslEnvironment(env, platform)) {
    const windowsDownloads = resolveWslWindowsDownloadsDir();
    if (windowsDownloads) {
      return windowsDownloads;
    }
  }

  return path.join(os.homedir(), "Downloads");
};

export const resolveDefaultPackageTargets = (env = process.env, platform = process.platform) => {
  if (platform === "darwin") {
    return ["mac"];
  }

  if (platform === "win32" || isWslEnvironment(env, platform)) {
    return ["win"];
  }

  return ["win"];
};

export const parsePackageArgs = (argv) => {
  const targets = new Set();
  let compile = true;
  let windowsSigningMode = "auto";

  for (const arg of argv) {
    if (arg === "--win" || arg === "--windows") {
      targets.add("win");
      continue;
    }
    if (arg === "--mac" || arg === "--macos") {
      targets.add("mac");
      continue;
    }
    if (arg === "--all") {
      targets.add("win");
      targets.add("mac");
      continue;
    }
    if (arg === "--no-compile") {
      compile = false;
      continue;
    }
    if (arg === "--signed" || arg === "--sign") {
      windowsSigningMode = "required";
      continue;
    }
    if (arg === "--unsigned" || arg === "--no-sign") {
      windowsSigningMode = "disabled";
      continue;
    }

    throw new Error(`Unknown package argument: ${arg}`);
  }

  return {
    compile,
    targets: targets.size > 0 ? [...targets] : resolveDefaultPackageTargets(),
    windowsSigningMode
  };
};

const assertTargetsCanBuildOnHost = (targets) => {
  if (targets.includes("mac") && process.platform !== "darwin") {
    throw new Error("macOS DMG packaging must be run on macOS. Use `npm run package:mac` from a Mac build host.");
  }

  for (const target of targets) {
    if (!appTargets.has(target)) {
      throw new Error(`Unsupported package target: ${target}`);
    }
  }
};

export const resolveWindowsSigningMode = (requestedMode = "auto", env = process.env) => {
  if (!windowsSigningModes.has(requestedMode)) {
    throw new Error(`Unsupported Windows signing mode: ${requestedMode}`);
  }
  if (requestedMode !== "auto") {
    return requestedMode;
  }

  return normalizeSigningModeEnvValue(env.AWB_SIGN_WINDOWS) ?? "auto";
};

const normalizeCodeSigningFileReference = (input, env = process.env, platform = process.platform) => {
  const trimmed = input.trim();
  if (isWslEnvironment(env, platform) && /^[a-zA-Z]:[\\/]/.test(trimmed)) {
    return windowsPathToWslPath(trimmed);
  }

  return trimmed;
};

const isLocalCertificateReference = (input) => {
  const trimmed = input.trim();
  if (trimmed.startsWith("https://") || trimmed.startsWith("data:")) {
    return false;
  }
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) && (trimmed.length > 2048 || trimmed.endsWith("="))) {
    return false;
  }

  return true;
};

const hasWindowsSpecificSigningMaterial = (env) =>
  [
    "WIN_CSC_LINK",
    "AWB_WIN_CSC_LINK",
    "AWB_WIN_CERTIFICATE_FILE",
    "AWB_WIN_CERTIFICATE_SUBJECT_NAME",
    "AWB_WIN_CERT_SUBJECT",
    "AWB_WIN_CERTIFICATE_SHA1",
    "AWB_WIN_CERT_SHA1"
  ].some((key) => hasValue(env[key]));

const hasGenericSigningMaterial = (env) => hasValue(env.CSC_LINK);

const buildWindowsSigningConfigArgs = (env, platform) => {
  const args = [
    "--config.win.signAndEditExecutable=true",
    "--config.win.forceCodeSigning=true"
  ];

  const certificateFile = getFirstEnvValue(env, [
    "AWB_WIN_CERTIFICATE_FILE"
  ]);
  if (certificateFile) {
    args.push(
      "--config.win.signtoolOptions.certificateFile",
      normalizeCodeSigningFileReference(certificateFile, env, platform)
    );
  }

  const certificateSubjectName = getFirstEnvValue(env, [
    "AWB_WIN_CERTIFICATE_SUBJECT_NAME",
    "AWB_WIN_CERT_SUBJECT"
  ]);
  if (certificateSubjectName) {
    args.push("--config.win.signtoolOptions.certificateSubjectName", certificateSubjectName);
  }

  const certificateSha1 = getFirstEnvValue(env, [
    "AWB_WIN_CERTIFICATE_SHA1",
    "AWB_WIN_CERT_SHA1"
  ]);
  if (certificateSha1) {
    args.push("--config.win.signtoolOptions.certificateSha1", certificateSha1);
  }

  const publisherName = getFirstEnvValue(env, ["AWB_WIN_PUBLISHER_NAME"]);
  if (publisherName) {
    args.push("--config.win.signtoolOptions.publisherName", publisherName);
  }

  return args;
};

export const createWindowsSigningConfig = (
  requestedMode = "auto",
  env = process.env,
  platform = process.platform
) => {
  const mode = resolveWindowsSigningMode(requestedMode, env);
  const hasWindowsMaterial = hasWindowsSpecificSigningMaterial(env);
  const hasAnySupportedMaterial = hasWindowsMaterial || hasGenericSigningMaterial(env);

  if (mode === "disabled") {
    return {
      enabled: false,
      cliArgs: ["--config.win.signAndEditExecutable=false"],
      env: {},
      mode,
      reason: "Windows code signing was disabled."
    };
  }

  if (mode === "auto" && !hasWindowsMaterial) {
    return {
      enabled: false,
      cliArgs: ["--config.win.signAndEditExecutable=false"],
      env: {},
      mode,
      reason: "No Windows-specific code signing material was provided."
    };
  }

  if (mode === "required" && !hasAnySupportedMaterial) {
    throw new Error(
      [
        "Windows code signing was requested, but no signing certificate was configured.",
        "Set WIN_CSC_LINK or AWB_WIN_CSC_LINK to a trusted code-signing certificate file, base64 payload, or HTTPS URL.",
        "Set WIN_CSC_KEY_PASSWORD or AWB_WIN_CSC_KEY_PASSWORD if the certificate requires a password."
      ].join(" ")
    );
  }

  const signingEnv = {};
  const cscLink = getFirstEnvValue(env, ["WIN_CSC_LINK", "AWB_WIN_CSC_LINK", "CSC_LINK"]);
  if (cscLink) {
    const normalizedCscLink = normalizeCodeSigningFileReference(cscLink, env, platform);
    if (isLocalCertificateReference(normalizedCscLink) && !existsSync(normalizedCscLink)) {
      throw new Error(
        [
          `Windows code signing certificate not found: ${normalizedCscLink}`,
          "Create or copy the trusted .pfx/.p12 certificate to that path, or update WIN_CSC_LINK/AWB_WIN_CSC_LINK.",
          "If you intended to use a base64 certificate payload or HTTPS URL, set WIN_CSC_LINK to that value directly."
        ].join(" ")
      );
    }
    signingEnv.WIN_CSC_LINK = normalizedCscLink;
  }

  const cscPassword = getFirstEnvValue(env, [
    "WIN_CSC_KEY_PASSWORD",
    "AWB_WIN_CSC_KEY_PASSWORD",
    "AWB_WIN_CERTIFICATE_PASSWORD",
    "CSC_KEY_PASSWORD"
  ]);
  if (cscPassword !== undefined) {
    signingEnv.WIN_CSC_KEY_PASSWORD = cscPassword;
  }

  return {
    enabled: true,
    cliArgs: buildWindowsSigningConfigArgs(env, platform),
    env: signingEnv,
    mode,
    reason: mode === "required"
      ? "Windows code signing was requested."
      : "Windows-specific code signing material was provided."
  };
};

const run = (command, args, env = process.env) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env,
      stdio: "inherit",
      shell: process.platform === "win32"
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`));
    });
  });

const createBuilderEnv = (env = process.env, windowsSigningConfig = undefined) => {
  const builderEnv = Object.fromEntries(
    Object.entries(env).filter(([key]) => !key.startsWith("npm_"))
  );

  builderEnv.NO_UPDATE_NOTIFIER = "true";
  builderEnv.npm_config_update_notifier = "false";
  builderEnv.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  if (windowsSigningConfig?.enabled) {
    Object.assign(builderEnv, windowsSigningConfig.env);
  }

  return builderEnv;
};

const stageApp = async () => {
  await rm(stageDir, { recursive: true, force: true });
  await mkdir(path.join(stageDir, "assets", "branding"), { recursive: true });

  await Promise.all([
    cp(path.join(rootDir, "dist"), path.join(stageDir, "dist"), { recursive: true }),
    cp(path.join(rootDir, "dist-electron"), path.join(stageDir, "dist-electron"), { recursive: true }),
    cp(path.join(rootDir, "assets", "branding", "interface_icon.png"), path.join(stageDir, "assets", "branding", "interface_icon.png")),
    cp(path.join(rootDir, "assets", "branding", "app.ico"), path.join(stageDir, "assets", "branding", "app.ico"))
  ]);

  const packageJson = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
  const packagedManifest = {
    name: packageJson.name,
    version: packageJson.version,
    description: packageJson.description,
    main: packageJson.main,
    type: packageJson.type,
    author: packageJson.author,
    license: packageJson.license
  };

  await writeFile(path.join(stageDir, "package.json"), `${JSON.stringify(packagedManifest, null, 2)}\n`);
};

export const buildTargetArgs = (target, outputDir, options = {}) => {
  const commonArgs = [
    path.join(rootDir, "node_modules", "electron-builder", "cli.js"),
    "--publish",
    "never",
    "--config.directories.app",
    stageDir,
    "--config.directories.output",
    outputDir
  ];

  if (target === "win") {
    const windowsSigningConfig = options.windowsSigningConfig ?? createWindowsSigningConfig("auto");
    return [
      ...commonArgs,
      "--win",
      "portable",
      "--x64",
      ...windowsSigningConfig.cliArgs
    ];
  }

  return [
    ...commonArgs,
    "--mac",
    "dmg",
    "--universal",
    "--config.mac.identity=null"
  ];
};

const collectDistributableArtifacts = async (outputDir, target) => {
  const extensions = target === "win" ? [".exe"] : [".dmg"];
  const artifacts = [];

  const walk = async (directoryPath) => {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.endsWith("-unpacked")) {
          await walk(entryPath);
        }
        continue;
      }

      if (extensions.some((extension) => entry.name.toLowerCase().endsWith(extension))) {
        artifacts.push(entryPath);
      }
    }
  };

  await walk(outputDir);
  return artifacts;
};

const copyArtifactsToDownloads = async (artifacts, downloadsDir) => {
  await mkdir(downloadsDir, { recursive: true });

  const copiedArtifacts = [];
  for (const artifactPath of artifacts) {
    const destinationPath = path.join(downloadsDir, path.basename(artifactPath));
    await cp(artifactPath, destinationPath, { force: true });
    copiedArtifacts.push(destinationPath);
  }

  return copiedArtifacts;
};

export const packageApp = async (argv = process.argv.slice(2)) => {
  const { compile, targets, windowsSigningMode } = parsePackageArgs(argv);
  assertTargetsCanBuildOnHost(targets);

  const downloadsDir = resolveDownloadsDir();
  const windowsSigningConfig = createWindowsSigningConfig(windowsSigningMode);
  const builderEnv = createBuilderEnv(process.env, windowsSigningConfig);

  if (targets.includes("win")) {
    console.log(`Windows code signing: ${windowsSigningConfig.enabled ? "enabled" : "disabled"} (${windowsSigningConfig.reason})`);
  }

  if (compile) {
    await run("npm", ["run", "build:app"]);
  }

  await stageApp();
  await rm(packageOutputRoot, { recursive: true, force: true });

  const copiedArtifacts = [];
  for (const target of targets) {
    const outputDir = path.join(packageOutputRoot, target);
    await mkdir(outputDir, { recursive: true });
    await run(process.execPath, buildTargetArgs(target, outputDir, { windowsSigningConfig }), builderEnv);

    const artifacts = await collectDistributableArtifacts(outputDir, target);
    if (artifacts.length === 0) {
      throw new Error(`No ${target} distributable artifact was produced in ${outputDir}`);
    }

    copiedArtifacts.push(...await copyArtifactsToDownloads(artifacts, downloadsDir));
  }

  console.log("Packaged distributable artifacts:");
  for (const artifactPath of copiedArtifacts) {
    const artifactStat = await stat(artifactPath);
    const sizeMb = (artifactStat.size / 1024 / 1024).toFixed(1);
    console.log(`- ${artifactPath} (${sizeMb} MB)`);
  }

  return copiedArtifacts;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await packageApp();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
