import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const stageDir = path.join(rootDir, ".electron-builder", "app");
const packageOutputRoot = path.join(rootDir, ".electron-builder", "out");
const packageMetadata = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));

const appTargets = new Set(["win", "win-portable", "mac"]);
const windowsLocalExecutableArgs = ["--config.win.signAndEditExecutable=false"];
const packagingCredentialEnvKeys = [
  "AWB_SIGN_WINDOWS",
  "AWB_WIN_CSC_KEY_PASSWORD",
  "AWB_WIN_CSC_LINK",
  "AWB_WIN_PUBLISHER_NAME",
  "CSC_KEY_PASSWORD",
  "CSC_LINK",
  "CSC_NAME",
  "WIN_CSC_KEY_PASSWORD",
  "WIN_CSC_LINK"
];
const expectedBuilderInfoFilters = [
  /file signing skipped via signExts configuration/
];

const readElectronPackageVersion = () => {
  const electronPackagePath = path.join(rootDir, "node_modules", "electron", "package.json");
  const electronPackage = JSON.parse(readFileSync(electronPackagePath, "utf8"));
  return electronPackage.version;
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

  for (const arg of argv) {
    if (arg === "--win" || arg === "--windows" || arg === "--win-unpacked") {
      targets.add("win");
      continue;
    }
    if (arg === "--win-portable" || arg === "--windows-portable") {
      targets.add("win-portable");
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

    throw new Error(`Unknown package argument: ${arg}`);
  }

  return {
    compile,
    targets: targets.size > 0 ? [...targets] : resolveDefaultPackageTargets()
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

const createFilteredWriter = (destination, filters) => {
  let buffered = "";

  return {
    flush() {
      if (buffered.length > 0 && !filters.some((filter) => filter.test(buffered))) {
        destination.write(buffered);
      }
      buffered = "";
    },
    write(chunk) {
      buffered += chunk.toString();
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";

      for (const line of lines) {
        if (!filters.some((filter) => filter.test(line))) {
          destination.write(`${line}\n`);
        }
      }
    }
  };
};

const run = (command, args, env = process.env, options = {}) =>
  new Promise((resolve, reject) => {
    const outputFilters = options.outputFilters ?? [];
    const child = spawn(command, args, {
      cwd: rootDir,
      env,
      stdio: outputFilters.length > 0 ? ["inherit", "pipe", "pipe"] : "inherit",
      shell: process.platform === "win32"
    });
    const stdoutWriter = outputFilters.length > 0 ? createFilteredWriter(process.stdout, outputFilters) : undefined;
    const stderrWriter = outputFilters.length > 0 ? createFilteredWriter(process.stderr, outputFilters) : undefined;

    child.stdout?.on("data", (chunk) => stdoutWriter?.write(chunk));
    child.stderr?.on("data", (chunk) => stderrWriter?.write(chunk));

    child.on("error", reject);
    child.on("exit", (code) => {
      stdoutWriter?.flush();
      stderrWriter?.flush();
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`));
    });
  });

const tryRun = (command, args, env = process.env) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env,
      stdio: "ignore",
      shell: process.platform === "win32"
    });

    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });

const walkFiles = async (directoryPath, visitor) => {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(entryPath, visitor);
      continue;
    }
    await visitor(entryPath);
  }
};

export const createBuilderEnv = (env = process.env) => {
  const builderEnv = Object.fromEntries(
    Object.entries(env).filter(([key]) => !key.startsWith("npm_"))
  );

  builderEnv.NO_UPDATE_NOTIFIER = "true";
  builderEnv.npm_config_update_notifier = "false";
  for (const key of packagingCredentialEnvKeys) {
    delete builderEnv[key];
  }
  builderEnv.CSC_IDENTITY_AUTO_DISCOVERY = "false";

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

export const buildTargetArgs = (target, outputDir) => {
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
    return [
      ...commonArgs,
      "--win",
      "dir",
      "--x64",
      ...windowsLocalExecutableArgs
    ];
  }

  if (target === "win-portable") {
    return [
      ...commonArgs,
      "--win",
      "portable",
      "--x64",
      ...windowsLocalExecutableArgs
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
  if (target === "win") {
    const unpackedDir = path.join(outputDir, "win-unpacked");
    if (directoryExists(unpackedDir)) {
      return [unpackedDir];
    }
    return [];
  }

  const extensions = target === "win-portable" ? [".exe"] : [".dmg"];
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

export const buildArtifactCopyFallbackPath = (destinationPath, attempt = 1, now = new Date()) => {
  const extension = path.extname(destinationPath);
  const baseName = path.basename(destinationPath, extension);
  const timestamp = now.toISOString().replace(/\D/g, "").slice(0, 14);
  const attemptSuffix = attempt > 1 ? `-${attempt}` : "";
  return path.join(path.dirname(destinationPath), `${baseName}-${timestamp}${attemptSuffix}${extension}`);
};

const buildDirectoryCopyFallbackPath = (destinationPath, attempt = 1, now = new Date()) => {
  const timestamp = now.toISOString().replace(/\D/g, "").slice(0, 14);
  const attemptSuffix = attempt > 1 ? `-${attempt}` : "";
  return path.join(path.dirname(destinationPath), `${path.basename(destinationPath)}-${timestamp}${attemptSuffix}`);
};

const isLockedDestinationError = (error) =>
  error && typeof error === "object" && ["EACCES", "EPERM"].includes(error.code);

const copyArtifactToDownloads = async (artifactPath, downloadsDir) => {
  const artifactName = path.basename(artifactPath) === "win-unpacked"
    ? `${packageMetadata.build?.productName ?? packageMetadata.name}-${packageMetadata.version}-windows-x64-unpacked`
    : path.basename(artifactPath);
  const destinationPath = path.join(downloadsDir, artifactName);

  try {
    await rm(destinationPath, { recursive: true, force: true });
    await cp(artifactPath, destinationPath, { recursive: true, force: true });
    return destinationPath;
  } catch (error) {
    if (!isLockedDestinationError(error)) {
      throw error;
    }

    const sourceStat = await stat(artifactPath);
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const fallbackPath = sourceStat.isDirectory()
        ? buildDirectoryCopyFallbackPath(destinationPath, attempt)
        : buildArtifactCopyFallbackPath(destinationPath, attempt);
      try {
        await cp(artifactPath, fallbackPath, { errorOnExist: true, force: false, recursive: true });
        console.warn(`Could not replace ${destinationPath}; copied artifact to ${fallbackPath} instead.`);
        return fallbackPath;
      } catch (fallbackError) {
        if (fallbackError && typeof fallbackError === "object" && fallbackError.code === "EEXIST") {
          continue;
        }
        throw fallbackError;
      }
    }

    throw new Error(`Could not copy ${artifactPath} to ${downloadsDir}: fallback artifact names already exist.`);
  }
};

const copyArtifactsToDownloads = async (artifacts, downloadsDir) => {
  await mkdir(downloadsDir, { recursive: true });

  const copiedArtifacts = [];
  for (const artifactPath of artifacts) {
    copiedArtifacts.push(await copyArtifactToDownloads(artifactPath, downloadsDir));
  }

  return copiedArtifacts;
};

const findOfficialElectronZip = async (version, cacheRoot = process.env.ELECTRON_CACHE) => {
  const cacheCandidates = [
    cacheRoot,
    path.join(os.homedir(), ".cache", "electron"),
    path.join(os.homedir(), "AppData", "Local", "electron", "Cache")
  ].filter(Boolean);
  const expectedName = `electron-v${version}-win32-x64.zip`;

  for (const candidate of cacheCandidates) {
    if (!directoryExists(candidate)) {
      continue;
    }

    let found;
    await walkFiles(candidate, async (filePath) => {
      if (!found && path.basename(filePath) === expectedName) {
        found = filePath;
      }
    });

    if (found) {
      return found;
    }
  }

  return undefined;
};

const extractOfficialWindowsElectronExecutable = async (zipPath) => {
  const extractDir = await mkdtemp(path.join(os.tmpdir(), "awb-electron-win-"));
  const extractCommands = process.platform === "win32"
    ? [
        ["tar", ["-xf", zipPath, "-C", extractDir, "electron.exe"]],
        ["powershell.exe", [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "Add-Type -AssemblyName System.IO.Compression.FileSystem; " +
            `$zip = [IO.Compression.ZipFile]::OpenRead('${zipPath.replaceAll("'", "''")}'); ` +
            `$entry = $zip.GetEntry('electron.exe'); ` +
            `[IO.Compression.ZipFileExtensions]::ExtractToFile($entry, '${path.join(extractDir, "electron.exe").replaceAll("'", "''")}', $true); ` +
            "$zip.Dispose();"
        ]]
      ]
    : [
        ["unzip", ["-q", zipPath, "electron.exe", "-d", extractDir]],
        ["bsdtar", ["-xf", zipPath, "-C", extractDir, "electron.exe"]]
      ];

  for (const [command, args] of extractCommands) {
    if (await tryRun(command, args)) {
      const executablePath = path.join(extractDir, "electron.exe");
      if (existsSync(executablePath)) {
        return executablePath;
      }
    }
  }

  throw new Error(`Unable to extract electron.exe from ${zipPath}`);
};

export const resolveOfficialWindowsElectronExecutable = async () => {
  const localWindowsExecutable = path.join(rootDir, "node_modules", "electron", "dist", "electron.exe");
  if (existsSync(localWindowsExecutable)) {
    return localWindowsExecutable;
  }

  const electronVersion = readElectronPackageVersion();
  const zipPath = await findOfficialElectronZip(electronVersion);
  if (!zipPath) {
    throw new Error(`Could not find cached official Electron Windows zip for v${electronVersion}. Run the Windows package build once to populate the Electron cache.`);
  }

  return await extractOfficialWindowsElectronExecutable(zipPath);
};

export const patchWindowsExecutableWithOfficialElectron = async (unpackedDir) => {
  const executableName = `${packageMetadata.build?.productName ?? packageMetadata.name}.exe`;
  const appExecutablePath = path.join(unpackedDir, executableName);
  const officialExecutablePath = await resolveOfficialWindowsElectronExecutable();
  await cp(officialExecutablePath, appExecutablePath, { force: true });
  return appExecutablePath;
};

const artifactSizeBytes = async (artifactPath) => {
  const artifactStat = await stat(artifactPath);
  if (!artifactStat.isDirectory()) {
    return artifactStat.size;
  }

  let total = 0;
  const walk = async (directoryPath) => {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else {
        total += (await stat(entryPath)).size;
      }
    }
  };
  await walk(artifactPath);
  return total;
};

export const packageApp = async (argv = process.argv.slice(2)) => {
  const { compile, targets } = parsePackageArgs(argv);
  assertTargetsCanBuildOnHost(targets);

  const downloadsDir = resolveDownloadsDir();
  const builderEnv = createBuilderEnv(process.env);

  if (compile) {
    await run("npm", ["run", "build:app"]);
  }

  await stageApp();
  await rm(packageOutputRoot, { recursive: true, force: true });

  const copiedArtifacts = [];
  for (const target of targets) {
    const outputDir = path.join(packageOutputRoot, target);
    await mkdir(outputDir, { recursive: true });
    await run(process.execPath, buildTargetArgs(target, outputDir), builderEnv, {
      outputFilters: target === "win" ? expectedBuilderInfoFilters : []
    });
    if (target === "win") {
      await patchWindowsExecutableWithOfficialElectron(path.join(outputDir, "win-unpacked"));
    }

    const artifacts = await collectDistributableArtifacts(outputDir, target);
    if (artifacts.length === 0) {
      throw new Error(`No ${target} distributable artifact was produced in ${outputDir}`);
    }

    copiedArtifacts.push(...await copyArtifactsToDownloads(artifacts, downloadsDir));
  }

  console.log("Packaged distributable artifacts:");
  for (const artifactPath of copiedArtifacts) {
    const sizeMb = ((await artifactSizeBytes(artifactPath)) / 1024 / 1024).toFixed(1);
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
