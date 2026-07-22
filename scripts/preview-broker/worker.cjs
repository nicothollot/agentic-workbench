"use strict";

const { createReadStream } = require("node:fs");
const { mkdir, realpath, stat, unlink, writeFile } = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const PROTOCOL_VERSION = 1;
const MAX_INPUT_LINE_BYTES = 1024 * 1024;
const MAX_EVENT_TEXT = 8_000;
const MAX_CONSOLE_ENTRIES = 500;
const MAX_NETWORK_ENTRIES = 1_000;
const MAX_SERVER_OUTPUT_BYTES = 256 * 1024;
const MAX_ARTIFACTS = 100;
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const MAX_SESSION_ARTIFACT_BYTES = 200 * 1024 * 1024;
const DEFAULT_START_TIMEOUT_MS = 120_000;
const BROWSER_LAUNCH_PROBE_TIMEOUT_MS = 7_500;
const VIEWPORTS = [
  { id: "desktop", width: 1440, height: 900 },
  { id: "tablet", width: 768, height: 1024 },
  { id: "mobile", width: 390, height: 844 }
];

let browser;
let context;
let page;
let targetProcess;
let targetProcessGroupId;
let staticServer;
let activeUrl;
let artifactDir;
let artifactSequence = 0;
let eventSequence = 0;
let snapshotSequence = 0;
let stopping = false;
let elementReferences = new Map();
let artifactBytes = 0;
let serverOutputBytes = 0;
let serverOutputTruncated = false;
let consoleTruncated = false;
let networkTruncated = false;
let inputBuffer = "";
let commandQueue = Promise.resolve();
const consoleEntries = [];
const networkEntries = [];
const artifacts = [];

const now = () => new Date().toISOString();
const compact = (value, limit = MAX_EVENT_TEXT) => {
  const text = String(value ?? "").replace(/\u0000/g, "");
  return text.length <= limit ? text : `${text.slice(0, limit)}…[truncated]`;
};
const emit = (event, params = {}) => {
  process.stdout.write(`${JSON.stringify({ event, params: { ...params, timestamp: now() } })}\n`);
};
const respond = (id, result) => process.stdout.write(`${JSON.stringify({ id, result })}\n`);
const respondError = (id, code, message, data) => process.stdout.write(`${JSON.stringify({ id, error: { code, message, data } })}\n`);
const respondAndExit = (id, result) => {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`, () => process.exit(0));
};

const safeArtifactName = (value) => String(value || "artifact").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "artifact";
const nextId = (prefix) => `${prefix}-${Date.now()}-${++artifactSequence}`;

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isWithin = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};
const validateUrlPath = (value) => {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || value.length > 1_000) {
    throw Object.assign(new Error("Preview urlPath must be a bounded project-relative URL path."), { code: "INVALID_RECIPE" });
  }
  return value;
};
const validateRecipe = (value) => {
  if (!isPlainObject(value)) throw Object.assign(new Error("Preview recipe must be an object."), { code: "INVALID_RECIPE" });
  const adapters = new Set(["vite", "next", "cra", "astro", "static", "custom"]);
  if (!adapters.has(value.adapter)) throw Object.assign(new Error("Preview recipe adapter is invalid."), { code: "INVALID_RECIPE" });
  if (typeof value.command !== "string" || value.command.length < 1 || value.command.length > 512 || /\s|[;&|`$<>\r\n\0]/.test(value.command)) {
    throw Object.assign(new Error("Preview command must be one bounded executable."), { code: "INVALID_RECIPE" });
  }
  if (!Array.isArray(value.args) || value.args.length > 64 || value.args.some((arg) => typeof arg !== "string" || arg.length > 2_000 || arg.includes("\0"))) {
    throw Object.assign(new Error("Preview recipe arguments are invalid."), { code: "INVALID_RECIPE" });
  }
  if (typeof value.cwd !== "string" || value.cwd.length < 1 || value.cwd.length > 1_000 || value.cwd.includes("\0")) {
    throw Object.assign(new Error("Preview recipe cwd is invalid."), { code: "INVALID_RECIPE" });
  }
  const normalizedCwd = value.cwd.replace(/\\/g, "/");
  if (normalizedCwd.startsWith("/") || /^[A-Za-z]:\//.test(normalizedCwd) || normalizedCwd.split("/").includes("..")) {
    throw Object.assign(new Error("Preview recipe cwd must remain project-relative."), { code: "INVALID_RECIPE" });
  }
  const usesStaticServer = value.adapter === "static" && value.command === "__awb_static__";
  if (value.adapter !== "cra" && !usesStaticServer && !value.args.some((arg) => arg.includes("{port}"))) {
    throw Object.assign(new Error("Preview recipe must consume the broker's {port} token."), { code: "INVALID_RECIPE" });
  }
  return { ...value, urlPath: validateUrlPath(value.urlPath || "/") };
};

const validateStartParams = (value) => {
  if (!isPlainObject(value)) throw Object.assign(new Error("Preview start parameters are invalid."), { code: "INVALID_REQUEST" });
  if (typeof value.projectRoot !== "string" || !path.isAbsolute(value.projectRoot) || value.projectRoot.length > 4_000 || value.projectRoot.includes("\0")) {
    throw Object.assign(new Error("Preview projectRoot must be an absolute path."), { code: "INVALID_REQUEST" });
  }
  if (typeof value.artifactDir !== "string" || !path.isAbsolute(value.artifactDir) || value.artifactDir.length > 4_000 || value.artifactDir.includes("\0")) {
    throw Object.assign(new Error("Preview artifactDir must be an absolute path."), { code: "INVALID_REQUEST" });
  }
  const timeout = value.startTimeoutMs === undefined ? DEFAULT_START_TIMEOUT_MS : value.startTimeoutMs;
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 180_000) {
    throw Object.assign(new Error("Preview start timeout is outside the allowed range."), { code: "INVALID_REQUEST" });
  }
  return { projectRoot: value.projectRoot, artifactDir: value.artifactDir, recipe: validateRecipe(value.recipe), startTimeoutMs: timeout };
};

const allocatePort = async () => await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.unref();
  server.once("error", reject);
  server.listen({ host: "127.0.0.1", port: 0 }, () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : undefined;
    server.close((error) => error ? reject(error) : resolve(port));
  });
});

const sanitizeEnvironment = (port, adapter) => {
  const allowed = [
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE",
    "TMPDIR", "TMP", "TEMP", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "NVM_DIR"
  ];
  const env = {};
  for (const key of allowed) {
    if (typeof process.env[key] === "string") {
      env[key] = process.env[key];
    }
  }
  env.BROWSER = "none";
  env.CI = "1";
  env.AWB_PREVIEW = "1";
  env.HOST = "127.0.0.1";
  env.PORT = String(port);
  return env;
};

const recordServerOutput = (stream, chunk) => {
  if (serverOutputTruncated) return;
  const text = String(chunk);
  const remaining = MAX_SERVER_OUTPUT_BYTES - serverOutputBytes;
  if (remaining <= 0) {
    serverOutputTruncated = true;
    emit("server.output", { stream, text: "[preview server output truncated]" });
    return;
  }
  const bounded = Buffer.from(text).subarray(0, remaining).toString("utf8");
  serverOutputBytes += Buffer.byteLength(bounded);
  emit("server.output", { stream, text: compact(bounded) });
  if (Buffer.byteLength(text) > remaining) {
    serverOutputTruncated = true;
    emit("server.output", { stream, text: "[preview server output truncated]" });
  }
};

const contentType = (filePath) => {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": case ".mjs": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".woff2": return "font/woff2";
    default: return "application/octet-stream";
  }
};

const startStaticServer = async (root, port) => await new Promise((resolve, reject) => {
  staticServer = http.createServer(async (request, response) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { "Allow": "GET, HEAD" }).end("Method Not Allowed");
        return;
      }
      const requestUrl = new URL(request.url || "/", `http://127.0.0.1:${port}`);
      let relative = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, "") || "index.html";
      if (relative.split("/").includes("..")) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      let filePath = path.resolve(root, relative);
      if (!isWithin(root, filePath)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      let fileStat;
      try {
        fileStat = await stat(filePath);
      } catch {
        filePath = path.resolve(root, "index.html");
        fileStat = await stat(filePath);
      }
      if (fileStat.isDirectory()) {
        filePath = path.join(filePath, "index.html");
      }
      const resolvedFilePath = await realpath(filePath);
      if (!isWithin(root, resolvedFilePath)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      fileStat = await stat(resolvedFilePath);
      if (!fileStat.isFile()) {
        response.writeHead(404).end("Not Found");
        return;
      }
      response.writeHead(200, {
        "Content-Type": contentType(resolvedFilePath),
        "Content-Length": fileStat.size,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      const stream = createReadStream(resolvedFilePath);
      stream.on("error", () => response.destroy());
      stream.pipe(response);
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(500).end(compact(error instanceof Error ? error.message : error));
      } else {
        response.destroy();
      }
    }
  });
  staticServer.once("error", reject);
  staticServer.listen(port, "127.0.0.1", () => resolve());
});

const startTarget = async (projectRoot, recipe, port) => {
  const resolvedProjectRoot = await realpath(projectRoot);
  const cwd = await realpath(path.resolve(resolvedProjectRoot, recipe.cwd === "." ? "" : recipe.cwd));
  if (!isWithin(resolvedProjectRoot, cwd)) {
    throw Object.assign(new Error("Preview cwd escaped the trusted project root."), { code: "INVALID_CWD" });
  }
  if (recipe.adapter === "static" && recipe.command === "__awb_static__") {
    await startStaticServer(cwd, port);
    emit("server.started", { adapter: "static", port });
    return;
  }

  const args = recipe.args.map((argument) => String(argument).replaceAll("{port}", String(port)));
  targetProcess = spawn(recipe.command, args, {
    cwd,
    env: sanitizeEnvironment(port, recipe.adapter),
    detached: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  targetProcessGroupId = targetProcess.pid;
  targetProcess.stdout.setEncoding("utf8");
  targetProcess.stderr.setEncoding("utf8");
  targetProcess.stdout.on("data", (chunk) => recordServerOutput("stdout", chunk));
  targetProcess.stderr.on("data", (chunk) => recordServerOutput("stderr", chunk));
  targetProcess.on("exit", (code, signal) => emit("server.exit", { code, signal }));
  await new Promise((resolve, reject) => {
    targetProcess.once("spawn", resolve);
    targetProcess.once("error", reject);
  });
};

const waitForServer = async (url, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  let lastError = "No response";
  while (Date.now() < deadline) {
    if (targetProcess && (targetProcess.exitCode !== null || targetProcess.signalCode !== null)) {
      const outcome = targetProcess.exitCode === null ? `signal ${targetProcess.signalCode}` : `code ${targetProcess.exitCode}`;
      throw Object.assign(new Error(`Preview server exited with ${outcome}.`), { code: "SERVER_EXITED" });
    }
    try {
      const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(2_000) });
      await response.body?.cancel();
      if (response.status < 500) {
        emit("server.ready", { url, status: response.status });
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw Object.assign(new Error(`Preview server did not become ready: ${lastError}`), { code: "SERVER_TIMEOUT" });
};

const isAllowedRequest = (value, websocket = false) => {
  try {
    const parsed = new URL(value);
    if (!websocket && (parsed.protocol === "data:" || parsed.protocol === "blob:")) {
      return true;
    }
    const allowed = new URL(activeUrl);
    const allowedProtocols = websocket ? new Set(["ws:", "wss:"]) : new Set(["http:", "https:"]);
    return allowedProtocols.has(parsed.protocol) &&
      parsed.hostname === "127.0.0.1" &&
      parsed.port === allowed.port;
  } catch {
    return false;
  }
};

const recordConsole = (level, text) => {
  if (consoleEntries.length >= MAX_CONSOLE_ENTRIES) {
    if (!consoleTruncated) {
      consoleTruncated = true;
      const truncated = {
        id: `console-${++eventSequence}`,
        level: "warning",
        text: "Additional browser console entries were suppressed after the session limit was reached.",
        timestamp: now()
      };
      consoleEntries[MAX_CONSOLE_ENTRIES - 1] = truncated;
      emit("console", truncated);
    }
    return;
  }
  const entry = { id: `console-${++eventSequence}`, level, text: compact(text), timestamp: now() };
  consoleEntries.push(entry);
  emit("console", entry);
};

const recordNetwork = (entry) => {
  if (networkEntries.length >= MAX_NETWORK_ENTRIES) {
    if (!networkTruncated) {
      networkTruncated = true;
      const truncated = {
        id: `network-${++eventSequence}`,
        timestamp: now(),
        url: activeUrl,
        method: "LIMIT",
        outcome: "blocked",
        detail: "Additional browser network entries were suppressed after the session limit was reached."
      };
      networkEntries[MAX_NETWORK_ENTRIES - 1] = truncated;
      emit("network", truncated);
    }
    return;
  }
  const value = {
    id: `network-${++eventSequence}`,
    timestamp: now(),
    ...entry,
    url: compact(entry.url, 4_000),
    method: compact(entry.method, 80),
    detail: entry.detail === undefined ? undefined : compact(entry.detail)
  };
  networkEntries.push(value);
  emit("network", value);
};

const attachPagePolicy = async () => {
  await context.route("**/*", async (route) => {
    const request = route.request();
    if (!isAllowedRequest(request.url())) {
      recordNetwork({ url: request.url(), method: request.method(), outcome: "blocked", detail: "External origin blocked by preview policy." });
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  if (typeof context.routeWebSocket === "function") {
    await context.routeWebSocket(/.*/, (webSocketRoute) => {
      if (isAllowedRequest(webSocketRoute.url(), true)) {
        webSocketRoute.connectToServer();
      } else {
        recordNetwork({ url: webSocketRoute.url(), method: "WEBSOCKET", outcome: "blocked", detail: "External WebSocket blocked by preview policy." });
        void webSocketRoute.close();
      }
    });
  }
  page.on("console", (message) => {
    const type = message.type();
    const level = type === "error" ? "error" : type === "warning" || type === "warn" ? "warning" : type === "info" ? "info" : "log";
    recordConsole(level, message.text());
  });
  page.on("pageerror", (error) => recordConsole("error", `Uncaught page error: ${error.message}`));
  page.on("requestfailed", (request) => recordNetwork({
    url: request.url(), method: request.method(), outcome: "failed", detail: request.failure()?.errorText
  }));
  page.on("response", (response) => {
    if (response.status() >= 400) {
      recordNetwork({ url: response.url(), method: response.request().method(), status: response.status(), outcome: "failed" });
    }
  });
  page.on("download", (download) => {
    recordNetwork({ url: download.url(), method: "DOWNLOAD", outcome: "blocked", detail: "Downloads are disabled in preview sessions." });
    void download.cancel();
  });
  page.on("popup", (popup) => {
    recordNetwork({ url: popup.url(), method: "POPUP", outcome: "blocked", detail: "Popups are disabled in preview sessions." });
    void popup.close();
  });
  page.on("dialog", (dialog) => void dialog.dismiss());
};

const writeArtifact = async (kind, label, mimeType, data, viewport) => {
  if (artifacts.length >= MAX_ARTIFACTS) {
    throw Object.assign(new Error(`Preview session reached its ${MAX_ARTIFACTS} artifact limit.`), { code: "ARTIFACT_LIMIT" });
  }
  const sizeBytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
  if (sizeBytes > MAX_ARTIFACT_BYTES) {
    throw Object.assign(new Error("A preview artifact exceeded the 20 MB per-artifact limit."), { code: "ARTIFACT_LIMIT" });
  }
  if (artifactBytes + sizeBytes > MAX_SESSION_ARTIFACT_BYTES) {
    throw Object.assign(new Error("The preview session exceeded its 200 MB artifact budget."), { code: "ARTIFACT_LIMIT" });
  }
  const id = nextId(kind);
  const extension = mimeType === "image/png" ? ".png" : ".json";
  const fileName = `${safeArtifactName(id)}${extension}`;
  const filePath = path.join(artifactDir, fileName);
  try {
    await writeFile(filePath, data, { flag: "wx", mode: 0o600 });
    const fileStat = await stat(filePath);
    artifactBytes += fileStat.size;
    const metadata = {
      id,
      kind,
      mimeType,
      sizeBytes: fileStat.size,
      createdAt: now(),
      viewport,
      label: compact(label, 200),
      fileName
    };
    artifacts.push(metadata);
    emit("artifact", metadata);
    return metadata;
  } catch (error) {
    await unlink(filePath).catch(() => undefined);
    throw error;
  }
};

const captureScreenshot = async (viewport = VIEWPORTS[0], label = viewport.id) => {
  if (!isPlainObject(viewport) || !["desktop", "tablet", "mobile", "custom"].includes(viewport.id) ||
      !Number.isInteger(viewport.width) || viewport.width < 240 || viewport.width > 7_680 ||
      !Number.isInteger(viewport.height) || viewport.height < 240 || viewport.height > 4_320 ||
      (viewport.deviceScaleFactor !== undefined && viewport.deviceScaleFactor !== 1)) {
    throw Object.assign(new Error("Screenshot viewport is outside the allowed range."), { code: "INVALID_ACTION" });
  }
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.waitForTimeout(100);
  const data = await page.screenshot({ type: "png", fullPage: false, animations: "disabled" });
  return await writeArtifact("screenshot", label, "image/png", data, viewport);
};

const captureSnapshot = async () => {
  snapshotSequence += 1;
  await Promise.allSettled([...elementReferences.values()].map((handle) => handle.dispose()));
  elementReferences = new Map();
  const body = page.locator("body");
  let ariaSnapshot = "";
  try {
    ariaSnapshot = compact(await body.ariaSnapshot({ timeout: 5_000 }), 200_000);
  } catch {
    ariaSnapshot = compact(await body.innerText({ timeout: 5_000 }), 200_000);
  }
  const interactive = page.locator("a,button,input,select,textarea,[role],[tabindex]");
  const count = Math.min(await interactive.count(), 500);
  const elements = [];
  for (let index = 0; index < count; index += 1) {
    const locator = interactive.nth(index);
    if (!await locator.isVisible().catch(() => false)) continue;
    const handle = await locator.elementHandle({ timeout: 1_000 }).catch(() => null);
    if (!handle) continue;
    const ref = `s${snapshotSequence}e${index + 1}`;
    const tag = await handle.evaluate((element) => element.tagName.toLowerCase()).catch(() => "unknown");
    const role = await handle.getAttribute("role") || undefined;
    const inputType = await handle.getAttribute("type") || undefined;
    const name = compact(
      await handle.getAttribute("aria-label") ||
      await handle.getAttribute("title") ||
      await handle.innerText().catch(() => "") ||
      await handle.getAttribute("placeholder") || "",
      500
    ) || undefined;
    elementReferences.set(ref, handle);
    elements.push({ ref, role, name, tag, inputType });
  }
  const snapshot = { url: page.url(), title: await page.title(), ariaSnapshot, elements, capturedAt: now() };
  await writeArtifact("accessibility", "Accessibility snapshot", "application/json", `${JSON.stringify(snapshot, null, 2)}\n`);
  return snapshot;
};

const requireElement = (ref) => {
  const locator = elementReferences.get(ref);
  if (!locator) {
    throw Object.assign(new Error(`Unknown or stale preview element reference: ${ref}`), { code: "STALE_ELEMENT_REFERENCE" });
  }
  return locator;
};

const validateAction = (value) => {
  if (!isPlainObject(value) || typeof value.type !== "string") {
    throw Object.assign(new Error("Preview action must be an object with a type."), { code: "INVALID_ACTION" });
  }
  const requireRef = () => {
    if (typeof value.ref !== "string" || value.ref.length < 1 || value.ref.length > 200) {
      throw Object.assign(new Error("Preview action element reference is invalid."), { code: "INVALID_ACTION" });
    }
  };
  switch (value.type) {
    case "navigate":
      if (typeof value.url !== "string" || value.url.length < 1 || value.url.length > 2_000) throw Object.assign(new Error("Preview navigation URL is invalid."), { code: "INVALID_ACTION" });
      break;
    case "click": requireRef(); break;
    case "fill":
      requireRef();
      if (typeof value.value !== "string" || value.value.length > 20_000) throw Object.assign(new Error("Preview fill value is invalid."), { code: "INVALID_ACTION" });
      break;
    case "select":
      requireRef();
      if (!Array.isArray(value.values) || value.values.length > 100 || value.values.some((entry) => typeof entry !== "string" || entry.length > 1_000)) {
        throw Object.assign(new Error("Preview select values are invalid."), { code: "INVALID_ACTION" });
      }
      break;
    case "press":
      if (value.ref !== undefined) requireRef();
      if (typeof value.key !== "string" || value.key.length < 1 || value.key.length > 80) throw Object.assign(new Error("Preview key is invalid."), { code: "INVALID_ACTION" });
      break;
    case "scroll":
      if (!Number.isFinite(value.deltaY) || Math.abs(value.deltaY) > 100_000 ||
          (value.deltaX !== undefined && (!Number.isFinite(value.deltaX) || Math.abs(value.deltaX) > 100_000))) {
        throw Object.assign(new Error("Preview scroll distance is invalid."), { code: "INVALID_ACTION" });
      }
      break;
    case "wait":
      if (!Number.isInteger(value.milliseconds) || value.milliseconds < 0 || value.milliseconds > 30_000) throw Object.assign(new Error("Preview wait duration is invalid."), { code: "INVALID_ACTION" });
      break;
    case "screenshot":
      if (value.label !== undefined && (typeof value.label !== "string" || value.label.length < 1 || value.label.length > 120)) throw Object.assign(new Error("Screenshot label is invalid."), { code: "INVALID_ACTION" });
      if (value.viewport !== undefined) captureScreenshotViewportValidation(value.viewport);
      break;
    case "snapshot": break;
    default: throw Object.assign(new Error("Unsupported preview action."), { code: "INVALID_ACTION" });
  }
  return value;
};

const captureScreenshotViewportValidation = (viewport) => {
  if (!isPlainObject(viewport) || !["desktop", "tablet", "mobile", "custom"].includes(viewport.id) ||
      !Number.isInteger(viewport.width) || viewport.width < 240 || viewport.width > 7_680 ||
      !Number.isInteger(viewport.height) || viewport.height < 240 || viewport.height > 4_320 ||
      (viewport.deviceScaleFactor !== undefined && viewport.deviceScaleFactor !== 1)) {
    throw Object.assign(new Error("Screenshot viewport is outside the allowed range; deviceScaleFactor must be 1."), { code: "INVALID_ACTION" });
  }
};

const settleAndSnapshot = async () => {
  await page.waitForLoadState("domcontentloaded", { timeout: 2_000 }).catch(() => undefined);
  await page.waitForTimeout(100);
  return await captureSnapshot();
};

const performAction = async (rawAction) => {
  if (!page) throw Object.assign(new Error("No preview browser session is active."), { code: "SESSION_INACTIVE" });
  const action = validateAction(rawAction);
  switch (action.type) {
    case "navigate": {
      const destination = new URL(action.url, activeUrl).toString();
      if (!isAllowedRequest(destination)) throw Object.assign(new Error("Navigation outside the active localhost preview is blocked."), { code: "NAVIGATION_BLOCKED" });
      await page.goto(destination, { waitUntil: "domcontentloaded", timeout: 30_000 });
      return await settleAndSnapshot();
    }
    case "click": await requireElement(action.ref).click({ timeout: 10_000 }); return await settleAndSnapshot();
    case "fill": await requireElement(action.ref).fill(action.value, { timeout: 10_000 }); return await settleAndSnapshot();
    case "select": await requireElement(action.ref).selectOption(action.values, { timeout: 10_000 }); return await settleAndSnapshot();
    case "press": await (action.ref ? requireElement(action.ref) : page.locator("body")).press(action.key, { timeout: 10_000 }); return await settleAndSnapshot();
    case "scroll": await page.mouse.wheel(action.deltaX || 0, action.deltaY); return await settleAndSnapshot();
    case "wait": await page.waitForTimeout(action.milliseconds); return await captureSnapshot();
    case "screenshot": return await captureScreenshot(action.viewport || VIEWPORTS[0], action.label || "Manual capture");
    case "snapshot": return await captureSnapshot();
    default: throw Object.assign(new Error("Unsupported preview action."), { code: "INVALID_ACTION" });
  }
};

const start = async (rawParams) => {
  if (page) throw Object.assign(new Error("A preview session is already active in this worker."), { code: "SESSION_ACTIVE" });
  try {
    const params = validateStartParams(rawParams);
    await mkdir(params.artifactDir, { recursive: true });
    artifactDir = await realpath(params.artifactDir);
    const projectRoot = await realpath(params.projectRoot);
    const port = await allocatePort();
    activeUrl = new URL(params.recipe.urlPath, `http://127.0.0.1:${port}`).toString();
    const parsedActiveUrl = new URL(activeUrl);
    if (parsedActiveUrl.protocol !== "http:" || parsedActiveUrl.hostname !== "127.0.0.1" || parsedActiveUrl.port !== String(port)) {
      throw Object.assign(new Error("Preview recipe produced a non-loopback URL."), { code: "INVALID_RECIPE" });
    }
    emit("session.phase", { phase: "starting_server", url: activeUrl });
    await startTarget(projectRoot, params.recipe, port);
    await waitForServer(activeUrl, params.startTimeoutMs);

    let playwright;
    try {
      playwright = require("playwright-core");
    } catch (error) {
      throw Object.assign(new Error(`Playwright runtime is unavailable: ${error instanceof Error ? error.message : String(error)}`), { code: "BROWSER_RUNTIME_MISSING" });
    }
    emit("session.phase", { phase: "launching_browser" });
    try {
      // The explicit bundled "chromium" channel keeps readiness checks and
      // execution on the same managed executable (new headless mode).
      browser = await playwright.chromium.launch({ headless: true, channel: "chromium" });
    } catch (error) {
      throw Object.assign(new Error(`Chromium is unavailable: ${error instanceof Error ? error.message : String(error)}`), { code: "BROWSER_MISSING" });
    }
    context = await browser.newContext({
      viewport: { width: VIEWPORTS[0].width, height: VIEWPORTS[0].height },
      acceptDownloads: false,
      serviceWorkers: "block"
    });
    page = await context.newPage();
    await attachPagePolicy();
    await page.goto(activeUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const initialSnapshot = await captureSnapshot();
    for (const viewport of VIEWPORTS) await captureScreenshot(viewport, `${viewport.id} checkpoint`);
    await page.setViewportSize({ width: VIEWPORTS[0].width, height: VIEWPORTS[0].height });
    emit("session.ready", { url: activeUrl });
    return {
      protocolVersion: PROTOCOL_VERSION,
      url: activeUrl,
      snapshot: initialSnapshot,
      artifacts,
      console: consoleEntries,
      network: networkEntries
    };
  } catch (error) {
    await stop();
    throw error;
  }
};

const stopTarget = async () => {
  if (staticServer) {
    await new Promise((resolve) => staticServer.close(() => resolve()));
    staticServer = undefined;
  }
  if (targetProcess) {
    let groupSignaled = false;
    if (targetProcessGroupId) {
      try {
        process.kill(-targetProcessGroupId, "SIGTERM");
        groupSignaled = true;
      } catch {
        // Fall back to the exact child below when process groups are unavailable.
      }
    }
    if (!groupSignaled && targetProcess.exitCode === null && targetProcess.signalCode === null) {
      targetProcess.kill("SIGTERM");
    }
    await Promise.race([
      targetProcess.exitCode !== null || targetProcess.signalCode !== null
        ? Promise.resolve()
        : new Promise((resolve) => targetProcess.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000))
    ]);
    if (targetProcessGroupId) {
      try { process.kill(-targetProcessGroupId, "SIGKILL"); } catch {}
    } else if (targetProcess.exitCode === null && targetProcess.signalCode === null) {
      targetProcess.kill("SIGKILL");
    }
  }
  targetProcess = undefined;
  targetProcessGroupId = undefined;
};

const stop = async () => {
  if (stopping) return;
  stopping = true;
  try { await context?.close(); } catch {}
  try { await browser?.close(); } catch {}
  page = undefined;
  context = undefined;
  browser = undefined;
  await Promise.allSettled([...elementReferences.values()].map((handle) => handle.dispose()));
  elementReferences = new Map();
  await stopTarget();
  stopping = false;
  emit("session.stopped", {});
};

const handle = async (message) => {
  if (!isPlainObject(message)) {
    emit("protocol.error", { message: "Preview protocol messages must be JSON objects." });
    return;
  }
  const { id, method, params = {} } = message;
  if (!Number.isSafeInteger(id) || id < 1 || typeof method !== "string" || method.length < 1 || method.length > 100) {
    emit("protocol.error", { message: "Preview protocol request id or method is invalid." });
    return;
  }
  if (message.protocolVersion !== PROTOCOL_VERSION) {
    respondError(id, "PROTOCOL_MISMATCH", `Expected preview protocol ${PROTOCOL_VERSION}.`);
    return;
  }
  try {
    switch (method) {
      case "ping": {
        let browserReady = false;
        let browserInstalled = false;
        let browserExecutable;
        let browserError;
        let probeBrowser;
        try {
          const playwright = require("playwright-core");
          browserExecutable = playwright.chromium.executablePath();
          browserInstalled = Boolean(browserExecutable && (await stat(browserExecutable)).isFile());
          if (browserInstalled) {
            // Readiness must exercise the same managed channel and launch path
            // as a real preview. An executable can exist while WSL libraries or
            // sandbox dependencies are still missing.
            probeBrowser = await playwright.chromium.launch({
              headless: true,
              channel: "chromium",
              timeout: BROWSER_LAUNCH_PROBE_TIMEOUT_MS
            });
            browserReady = true;
          }
        } catch (error) {
          browserError = compact(error instanceof Error ? error.message : error);
        } finally {
          await probeBrowser?.close().catch(() => undefined);
        }
        respond(id, { protocolVersion: PROTOCOL_VERSION, node: process.version, browserReady, browserInstalled, browserExecutable, browserError });
        break;
      }
      case "start": respond(id, await start(params)); break;
      case "action": respond(id, await performAction(isPlainObject(params) ? params.action : undefined)); break;
      case "snapshot": {
        if (!page) throw Object.assign(new Error("No preview browser session is active."), { code: "SESSION_INACTIVE" });
        respond(id, await captureSnapshot());
        break;
      }
      case "console": respond(id, consoleEntries); break;
      case "network": respond(id, networkEntries); break;
      case "stop":
        await stop();
        respondAndExit(id, { stopped: true });
        break;
      default: respondError(id, "METHOD_NOT_FOUND", `Unknown preview broker method: ${method}`);
    }
  } catch (error) {
    respondError(id, error.code || "PREVIEW_ERROR", error instanceof Error ? error.message : String(error));
  }
};

const enqueueLine = (line) => {
  if (Buffer.byteLength(line) > MAX_INPUT_LINE_BYTES) {
    emit("protocol.error", { message: "Input line exceeded the preview protocol limit." });
    return;
  }
  try {
    const message = JSON.parse(line);
    commandQueue = commandQueue.then(() => handle(message)).catch((error) => {
      emit("worker.error", { message: compact(error instanceof Error ? error.message : error) });
    });
  } catch (error) {
    emit("protocol.error", { message: compact(error instanceof Error ? error.message : error) });
  }
};

// Node 22 can mark process.stdin ended immediately when fd 0 is the Unix
// socket created for a spawned child's piped stdio. Reading fd 0 explicitly
// keeps the JSONL transport alive until the parent actually closes the pipe.
const protocolInput = createReadStream(null, { fd: 0, autoClose: false });
protocolInput.setEncoding("utf8");
protocolInput.on("data", (chunk) => {
  inputBuffer += chunk;
  if (Buffer.byteLength(inputBuffer) > MAX_INPUT_LINE_BYTES * 2) {
    emit("protocol.error", { message: "Buffered input exceeded the preview protocol limit." });
    void stop().finally(() => process.exit(1));
    return;
  }
  let newline = inputBuffer.indexOf("\n");
  while (newline >= 0) {
    const line = inputBuffer.slice(0, newline).trim();
    inputBuffer = inputBuffer.slice(newline + 1);
    if (line) enqueueLine(line);
    newline = inputBuffer.indexOf("\n");
  }
});
protocolInput.on("end", () => {
  // A pipe can deliver its final request and EOF in the same turn. Drain the
  // serialized protocol queue before cleanup so the final response is not
  // discarded by an eager process.exit(). Once cleanup completes there are no
  // referenced handles left, and exitCode lets Node flush stdout naturally.
  void commandQueue
    .catch(() => undefined)
    .then(() => stop())
    .then(() => {
      process.exitCode = 0;
    });
});
process.on("SIGTERM", () => void stop().finally(() => process.exit(0)));
process.on("SIGINT", () => void stop().finally(() => process.exit(0)));
process.on("uncaughtException", (error) => {
  emit("worker.error", { message: compact(error.message) });
  void stop().finally(() => process.exit(1));
});
process.on("unhandledRejection", (error) => {
  emit("worker.error", { message: compact(error instanceof Error ? error.message : error) });
  void stop().finally(() => process.exit(1));
});
