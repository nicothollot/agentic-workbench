import { app, BrowserWindow, dialog, ipcMain, nativeImage, safeStorage, shell } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { APP_ID, APP_NAME } from "@shared/constants";
import { getPreloadEntryPath, getRendererEntryPath } from "@shared/electronAppPaths";
import {
  advanceWorkflowStageRequestSchema,
  agentDetailRequestSchema,
  agentListRequestSchema,
  agentTranscriptRequestSchema,
  approveRecommendationRequestSchema,
  approvalDecisionRequestSchema,
  codexUpdateRunRequestSchema,
  createScopedGoalRequestSchema,
  createAgentRequestSchema,
  credentialEntryDeleteRequestSchema,
  credentialEntrySaveRequestSchema,
  credentialRequestSubmitToAgentSchema,
  credentialRequestUpdateSchema,
  chooseFolderRequestSchema,
  downloadInterfaceRequestSchema,
  downloadLogsRequestSchema,
  detectUltimateGoalRequestSchema,
  exportInterfaceRequestSchema,
  fileSummaryRequestSchema,
  autopilotStrategyRequestSchema,
  generateGoalCharterDraftRequestSchema,
  goalCharterRequestSchema,
  importUltimateGoalTextRequestSchema,
  importInterfaceRequestSchema,
  layoutUpdateRequestSchema,
  openProjectShellRequestSchema,
  cycleAgentListRequestSchema,
  projectLoadRequestSchema,
  projectLogFeedRequestSchema,
  projectOpenRequestSchema,
  projectRepositoryChildrenRequestSchema,
  projectRepositoryExcludedPathsRequestSchema,
  projectRepositorySearchRequestSchema,
  projectRepositorySummaryRequestSchema,
  projectRepositoryViewRequestSchema,
  repositoryPathQuestionRequestSchema,
  repositoryPathSummaryRequestSchema,
  repositoryPathWindowRequestSchema,
  repositoryRescanRequestSchema,
  repositoryScanSettingsRequestSchema,
  openWorkflowRepairAgentRequestSchema,
  projectSelectionDecisionSchema,
  polishGoalCharterFieldRequestSchema,
  refreshOverviewRequestSchema,
  goalChangeDecisionRequestSchema,
  goalChangeProposalRequestSchema,
  plannerCycleRecordRequestSchema,
  manageUserInputRequestAttachmentsSchema,
  requestWorkflowPreviewRequestSchema,
  revalidateWorkflowRepairRequestSchema,
  retryWorkflowGoalRequestSchema,
  runRecommendationRequestSchema,
  setAutopilotPolicyRequestSchema,
  setWorkflowModeRequestSchema,
  strategicPlanRequestSchema,
  submitUserInputRequestResponseSchema,
  requestHumanInterventionRequestSchema,
  resolveHumanInterventionRequestSchema,
  updateAutopilotStrategyRequestSchema,
  updateGoalCharterRequestSchema,
  updateUltimateGoalRequestSchema,
  uiStateUpdateRequestSchema,
  workflowCycleDetailRequestSchema,
  workflowCycleListRequestSchema,
  workflowPreviewCheckpointRequestSchema,
  visualExportCaptureRequestSchema,
  visualExportSessionRequestSchema,
  visualExportStartRequestSchema
} from "@shared/ipc";
import type { VisualExportCaptureTarget, VisualExportTab, WorkbenchState } from "@shared/types";
import { appSettingsSchema } from "@shared/schemas";
import { AppService } from "@runtime/appService";

let mainWindow: BrowserWindow | undefined;
let appService: AppService | undefined;
let quitRequested = false;
const secondaryWindows = new Set<BrowserWindow>();

type VisualExportCapture = {
  target: VisualExportCaptureTarget;
  png: Buffer;
  width: number;
  height: number;
  capturedAt: string;
};

type VisualExportSession = {
  projectId: string;
  destinationPath: string;
  tabs: VisualExportTab[];
  captures: VisualExportCapture[];
};

const visualExportSessions = new Map<string, VisualExportSession>();

const interfaceIconPath = (): string =>
  path.join(app.getAppPath(), "assets", "branding", "interface_icon.png");

const windowIconPath = (): string =>
  app.isPackaged
    ? path.join(process.resourcesPath, "app.ico")
    : path.join(__dirname, "../../assets/branding/app.ico");

const toSafeFileStem = (value: string): string => {
  const normalized = value.trim().replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
  return normalized || "project";
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");

const visualExportPageSize = (capture: VisualExportCapture): Electron.Size => ({
  width: Math.min(20, Math.max(6, capture.target.viewportWidth / 100)),
  height: Math.min(20, Math.max(4, capture.target.viewportHeight / 100))
});

const buildVisualExportHtml = (
  pages: Array<VisualExportCapture & { imageUrl: string }>,
  pageSize: Electron.Size
): string => {
  const pageWidth = `${pageSize.width}in`;
  const pageHeight = `${pageSize.height}in`;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    @page { size: ${pageWidth} ${pageHeight}; margin: 0; }
    html, body {
      margin: 0;
      padding: 0;
      width: ${pageWidth};
      background: #ffffff;
    }
    .visual-page {
      width: ${pageWidth};
      height: ${pageHeight};
      page-break-after: always;
      overflow: hidden;
      background: #f0e7da;
      display: flex;
      align-items: flex-start;
      justify-content: flex-start;
    }
    .visual-page:last-child {
      page-break-after: auto;
    }
    .visual-page img {
      width: 100%;
      height: auto;
      display: block;
    }
  </style>
</head>
<body>
${pages.map((page) => `  <section class="visual-page" aria-label="${escapeHtml(page.target.tab.label)} ${page.target.pageIndex + 1} of ${page.target.pageCount}">
    <img src="${page.imageUrl}" alt="${escapeHtml(page.target.tab.label)} ${page.target.pageIndex + 1} of ${page.target.pageCount}" />
  </section>`).join("\n")}
</body>
</html>
`;
};

const waitForCapturedPaint = async (window: BrowserWindow): Promise<void> => {
  await window.webContents.executeJavaScript(
    "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))"
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
};

const writeVisualExportPdf = async (captures: VisualExportCapture[], destinationPath: string): Promise<void> => {
  if (captures.length === 0) {
    throw new Error("No interface visuals were captured.");
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), "awb-visual-export-"));
  const pdfWindow = new BrowserWindow({
    width: captures[0].target.viewportWidth,
    height: captures[0].target.viewportHeight,
    show: false,
    backgroundColor: "#ffffff",
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });

  try {
    const pages: Array<VisualExportCapture & { imageUrl: string }> = [];
    for (const [index, capture] of captures.entries()) {
      const imagePath = path.join(tempDir, `visual-${index}.png`);
      await writeFile(imagePath, capture.png);
      pages.push({
        ...capture,
        imageUrl: pathToFileURL(imagePath).href
      });
    }

    const pageSize = visualExportPageSize(captures[0]);
    const htmlPath = path.join(tempDir, "visual-export.html");
    await writeFile(htmlPath, buildVisualExportHtml(pages, pageSize), "utf8");
    await pdfWindow.loadFile(htmlPath);
    await pdfWindow.webContents.executeJavaScript(`
      Promise.all(Array.from(document.images).map((image) => {
        if (image.complete) {
          return true;
        }
        return new Promise((resolve) => {
          image.addEventListener("load", () => resolve(true), { once: true });
          image.addEventListener("error", () => resolve(false), { once: true });
        });
      })).then(() => true);
    `);
    await waitForCapturedPaint(pdfWindow);

    const pdf = await pdfWindow.webContents.printToPDF({
      printBackground: true,
      displayHeaderFooter: false,
      pageSize,
      margins: {
        marginType: "none"
      }
    });
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await writeFile(destinationPath, pdf);
  } finally {
    if (!pdfWindow.isDestroyed()) {
      pdfWindow.destroy();
    }
    await rm(tempDir, { recursive: true, force: true });
  }
};

const dockIcon = () => {
  const iconPath = interfaceIconPath();
  if (!existsSync(iconPath)) {
    return undefined;
  }

  const icon = nativeImage.createFromPath(iconPath);
  return icon.isEmpty() ? undefined : icon;
};

if (process.platform === "win32") {
  // Windows needs the AppUserModelId so the taskbar associates the app with the custom icon.
  app.setAppUserModelId(APP_ID);
}

const sendState = (state: WorkbenchState): void => {
  mainWindow?.webContents.send("state:updated", state);
};

const requestAppQuit = async (): Promise<void> => {
  if (quitRequested) {
    return;
  }

  quitRequested = true;
  try {
    await appService?.dispose();
  } catch {
    // Best effort during shutdown.
  }
  app.quit();
  const forceExitTimer = setTimeout(() => {
    app.exit(0);
  }, 1000);
  forceExitTimer.unref();
};

const attachWindowDiagnostics = (window: BrowserWindow, preloadEntryPath: string, rendererEntryPath: string): void => {
  console.info(`[main] preload entry: ${preloadEntryPath} (exists: ${existsSync(preloadEntryPath)})`);
  if (!process.env.VITE_DEV_SERVER_URL) {
    console.info(`[main] renderer entry: ${rendererEntryPath} (exists: ${existsSync(rendererEntryPath)})`);
  }

  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) {
      return;
    }
    console.error(`[main] renderer failed to load (${errorCode}): ${errorDescription} -> ${validatedURL}`);
  });

  window.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[main] renderer process gone: ${details.reason}`);
  });

  if (app.isPackaged) {
    window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
      const log = level >= 2 ? console.error : console.warn;
      log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    });
  }
};

const createMainWindow = async (): Promise<void> => {
  const icon = dockIcon();
  const appPath = app.getAppPath();
  const preloadEntryPath = getPreloadEntryPath(appPath);
  const rendererEntryPath = getRendererEntryPath(appPath);
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1040,
    minHeight: 720,
    title: APP_NAME,
    icon: windowIconPath(),
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#f0e7da",
    webPreferences: {
      preload: preloadEntryPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      devTools: true
    }
  });

  attachWindowDiagnostics(mainWindow, preloadEntryPath, rendererEntryPath);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.once("ready-to-show", () => {
    if (mainWindow && !mainWindow.isMaximized()) {
      mainWindow.maximize();
    }
    mainWindow?.show();
  });

  if (process.platform === "darwin" && icon) {
    app.dock?.setIcon(icon);
  }

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    await mainWindow.loadURL(devServerUrl);
  } else {
    await mainWindow.loadFile(rendererEntryPath);
  }

  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
};

const createRepositoryPathWindow = async (projectId: string, relativePath: string, initialQuestion?: string): Promise<void> => {
  const appPath = app.getAppPath();
  const preloadEntryPath = getPreloadEntryPath(appPath);
  const rendererEntryPath = getRendererEntryPath(appPath);
  const repositoryWindow = new BrowserWindow({
    width: 780,
    height: 860,
    minWidth: 560,
    minHeight: 620,
    parent: mainWindow,
    modal: false,
    title: `${relativePath} · ${APP_NAME}`,
    icon: windowIconPath(),
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#071526",
    webPreferences: {
      preload: preloadEntryPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      devTools: true
    }
  });

  secondaryWindows.add(repositoryWindow);
  attachWindowDiagnostics(repositoryWindow, preloadEntryPath, rendererEntryPath);
  repositoryWindow.once("ready-to-show", () => repositoryWindow.show());
  repositoryWindow.on("closed", () => {
    secondaryWindows.delete(repositoryWindow);
  });
  repositoryWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  const query = {
    view: "repositoryPathChat",
    projectId,
    repositoryPath: relativePath,
    ...(initialQuestion ? { initialQuestion } : {})
  };
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    const url = new URL(devServerUrl);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    await repositoryWindow.loadURL(url.toString());
  } else {
    await repositoryWindow.loadFile(rendererEntryPath, { query });
  }
};

const registerIpc = (): void => {
  ipcMain.handle("app:getState", () => appService?.getRendererState());
  ipcMain.handle("github:refreshStatus", async () => await appService?.refreshGitHubStatus());
  ipcMain.handle("settings:get", () => appService?.getState().settings);
  ipcMain.handle("settings:update", async (_event, payload) => appService?.updateSettings(appSettingsSchema.partial().parse(payload)));
  ipcMain.handle("app:showLauncher", () => appService?.showLauncher());
  ipcMain.handle("app:openDevTools", () => {
    if (!mainWindow) {
      return false;
    }

    mainWindow.webContents.openDevTools({ mode: "detach", activate: true });
    return true;
  });
  ipcMain.handle("app:checkRuntimeReadiness", async () => await appService?.refreshRuntimeReadiness("manual runtime readiness check"));
  ipcMain.handle("app:getCodexReadiness", () => appService?.getCodexReadiness());
  ipcMain.handle("app:refreshCodexReadiness", async () => await appService?.refreshCodexReadiness("manual Codex readiness check"));
  ipcMain.handle("app:checkCodexUpdate", async () => await appService?.checkCodexUpdate());
  ipcMain.handle("app:runCodexUpdate", async (_event, payload) => {
    const parsed = codexUpdateRunRequestSchema.parse(payload);
    return await appService?.runCodexUpdate(parsed);
  });
  ipcMain.handle("app:getExecutionEnvironmentStatus", () => appService?.getExecutionEnvironmentStatus());
  ipcMain.handle("project:load", async (_event, payload) => {
    const parsed = projectLoadRequestSchema.parse(payload);
    return await appService?.loadProject(parsed.inputPath, parsed.intent, parsed.creationMode);
  });
  ipcMain.handle("project:open", async (_event, payload) => appService?.openProject(projectOpenRequestSchema.parse(payload).projectId));
  ipcMain.handle("project:selectInterface", async (_event, payload) => {
    const parsed = projectSelectionDecisionSchema.parse(payload);
    return await appService?.selectPendingInterface(parsed.source, parsed.path, parsed.freshBehavior);
  });
  ipcMain.handle("project:exportInterface", async (_event, payload) => {
    const parsed = exportInterfaceRequestSchema.parse(payload);
    return await appService?.exportInterface(parsed.projectId, parsed.destinationPath);
  });
  ipcMain.handle("project:downloadInterface", async (_event, payload) => {
    const parsed = downloadInterfaceRequestSchema.parse(payload);
    const project = appService?.getState().projects.find((entry) => entry.record.id === parsed.projectId);
    const suggestedName = `${toSafeFileStem(project?.record.identity.projectName ?? "project")}-interface.json`;
    const fileResult = await dialog.showSaveDialog({
      title: "Download a shareable interface file",
      defaultPath: path.join(app.getPath("downloads"), suggestedName),
      filters: [
        {
          name: "JSON",
          extensions: ["json"]
        }
      ]
    });
    if (fileResult.canceled || !fileResult.filePath) {
      return null;
    }

    return await appService?.downloadInterface(parsed.projectId, fileResult.filePath);
  });
  ipcMain.handle("project:downloadLogs", async (_event, payload) => {
    const parsed = downloadLogsRequestSchema.parse(payload);
    const project = appService?.getState().projects.find((entry) => entry.record.id === parsed.projectId);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const suggestedName = `${toSafeFileStem(project?.record.identity.projectName ?? "project")}-review-log-${timestamp}.json`;
    const fileResult = await dialog.showSaveDialog({
      title: "Download workflow logs for review",
      defaultPath: path.join(app.getPath("downloads"), suggestedName),
      filters: [
        {
          name: "JSON",
          extensions: ["json"]
        }
      ]
    });
    if (fileResult.canceled || !fileResult.filePath) {
      return null;
    }

    return await appService?.downloadLogs(parsed.projectId, fileResult.filePath);
  });
  ipcMain.handle("project:startVisualExport", (_event, payload) => {
    const parsed = visualExportStartRequestSchema.parse(payload);
    if (!mainWindow) {
      throw new Error("The workbench window is not available.");
    }
    if (!appService) {
      throw new Error("The workbench service is not available.");
    }
    if (!appService.getState().projects.some((entry) => entry.record.id === parsed.projectId)) {
      throw new Error("Unknown project for visual export.");
    }

    const exportId = randomUUID();
    visualExportSessions.set(exportId, {
      projectId: parsed.projectId,
      destinationPath: appService.createVisualExportDestination(parsed.projectId),
      tabs: parsed.tabs,
      captures: []
    });
    return { exportId };
  });
  ipcMain.handle("project:captureVisualExportPage", async (_event, payload) => {
    const parsed = visualExportCaptureRequestSchema.parse(payload);
    const session = visualExportSessions.get(parsed.exportId);
    if (!session) {
      throw new Error("Visual export session is no longer available.");
    }
    if (!mainWindow) {
      throw new Error("The workbench window is not available.");
    }

    await waitForCapturedPaint(mainWindow);
    const image = await mainWindow.webContents.capturePage();
    const size = image.getSize();
    const scaleY = size.height / parsed.target.viewportHeight;
    const cropTop = Math.max(0, Math.round(parsed.target.cropTop * scaleY));
    const cropHeight = Math.min(size.height - cropTop, Math.max(1, Math.round(parsed.target.sliceHeight * scaleY)));
    if (cropHeight <= 0) {
      throw new Error(`Could not crop ${parsed.target.tab.label} visual slice ${parsed.target.pageIndex + 1}.`);
    }
    const croppedImage = cropTop > 0 || cropHeight < size.height
      ? image.crop({
        x: 0,
        y: cropTop,
        width: size.width,
        height: cropHeight
      })
      : image;
    const croppedSize = croppedImage.getSize();
    const capture: VisualExportCapture = {
      target: parsed.target,
      png: croppedImage.toPNG(),
      width: croppedSize.width,
      height: croppedSize.height,
      capturedAt: new Date().toISOString()
    };
    session.captures = [...session.captures, capture];
  });
  ipcMain.handle("project:finishVisualExport", async (_event, payload) => {
    const parsed = visualExportSessionRequestSchema.parse(payload);
    const session = visualExportSessions.get(parsed.exportId);
    if (!session) {
      throw new Error("Visual export session is no longer available.");
    }

    const orderedCaptures = session.tabs.flatMap((tab) => {
      const captures = session.captures
        .filter((capture) => capture.target.tab.id === tab.id)
        .sort((left, right) => left.target.pageIndex - right.target.pageIndex);
      if (captures.length === 0) {
        throw new Error(`The ${tab.label} tab was not captured.`);
      }
      return captures;
    });
    await writeVisualExportPdf(orderedCaptures, session.destinationPath);
    visualExportSessions.delete(parsed.exportId);
    return session.destinationPath;
  });
  ipcMain.handle("project:cancelVisualExport", (_event, payload) => {
    const parsed = visualExportSessionRequestSchema.parse(payload);
    visualExportSessions.delete(parsed.exportId);
  });
  ipcMain.handle("project:importInterface", async (_event, payload) => {
    const parsed = importInterfaceRequestSchema.parse(payload);
    return await appService?.importInterface(parsed.projectRootPath, parsed.importPath, parsed.allowMismatch);
  });
  ipcMain.handle("project:refreshOverview", async (_event, payload) => {
    const parsed = refreshOverviewRequestSchema.parse(payload);
    await appService?.refreshOverview(parsed.projectId);
  });
  ipcMain.handle("project:getFileSummary", async (_event, payload) => {
    const parsed = fileSummaryRequestSchema.parse(payload);
    return await appService?.getFileSummary(parsed.projectId, parsed.relativePath);
  });
  ipcMain.handle("project:getRepositoryView", (_event, payload) => {
    const parsed = projectRepositoryViewRequestSchema.parse(payload);
    return appService?.getRepositoryView(parsed.projectId);
  });
  ipcMain.handle("project:getRepositorySummary", async (_event, payload) => {
    const parsed = projectRepositorySummaryRequestSchema.parse(payload);
    return await appService?.getRepositorySummary(parsed.projectId);
  });
  ipcMain.handle("project:listRepositoryChildren", async (_event, payload) => {
    const parsed = projectRepositoryChildrenRequestSchema.parse(payload);
    return await appService?.listRepositoryChildren(parsed.projectId, parsed.parentPath, {
      cursor: parsed.cursor,
      limit: parsed.limit
    });
  });
  ipcMain.handle("project:searchRepositoryFiles", async (_event, payload) => {
    const parsed = projectRepositorySearchRequestSchema.parse(payload);
    return await appService?.searchRepositoryFiles(parsed.projectId, parsed.query, { limit: parsed.limit });
  });
  ipcMain.handle("project:getRepositoryScanStatus", (_event, payload) => {
    const parsed = projectRepositoryViewRequestSchema.parse(payload);
    return appService?.getRepositoryScanStatus(parsed.projectId);
  });
  ipcMain.handle("project:getRepositoryScanLimits", (_event, payload) => {
    const parsed = projectRepositoryViewRequestSchema.parse(payload);
    return appService?.getRepositoryScanLimits(parsed.projectId);
  });
  ipcMain.handle("project:updateRepositoryScanSettings", async (_event, payload) => {
    const parsed = repositoryScanSettingsRequestSchema.parse(payload);
    return await appService?.updateRepositoryScanSettings(parsed.projectId, parsed.settings);
  });
  ipcMain.handle("project:listExcludedPaths", (_event, payload) => {
    const parsed = projectRepositoryExcludedPathsRequestSchema.parse(payload);
    return appService?.listExcludedPaths(parsed.projectId, {
      cursor: parsed.cursor,
      limit: parsed.limit
    });
  });
  ipcMain.handle("project:rescanRepository", async (_event, payload) => {
    const parsed = repositoryRescanRequestSchema.parse(payload);
    return await appService?.rescanRepository(parsed.projectId, parsed.options);
  });
  ipcMain.handle("project:summarizeRepositoryPath", async (_event, payload) => {
    const parsed = repositoryPathSummaryRequestSchema.parse(payload);
    return await appService?.summarizeRepositoryPath(parsed.projectId, parsed.relativePath, parsed.model, {
      reasoningMode: parsed.reasoningMode,
      reasoningEffort: parsed.reasoningEffort
    });
  });
  ipcMain.handle("project:askRepositoryPath", async (_event, payload) => {
    const parsed = repositoryPathQuestionRequestSchema.parse(payload);
    return await appService?.askRepositoryPath(parsed.projectId, parsed.relativePath, parsed.question, parsed.model, {
      reasoningMode: parsed.reasoningMode,
      reasoningEffort: parsed.reasoningEffort
    });
  });
  ipcMain.handle("project:openRepositoryPathWindow", async (_event, payload) => {
    const parsed = repositoryPathWindowRequestSchema.parse(payload);
    await createRepositoryPathWindow(parsed.projectId, parsed.relativePath, parsed.initialQuestion);
  });
  ipcMain.handle("project:listAgents", (_event, payload) => {
    const parsed = agentListRequestSchema.parse(payload);
    return appService?.listAgents(parsed.projectId, parsed.scope, parsed.offset, parsed.limit);
  });
  ipcMain.handle("project:getAgent", (_event, payload) => {
    const parsed = agentDetailRequestSchema.parse(payload);
    return appService?.getAgent(parsed.projectId, parsed.agentId);
  });
  ipcMain.handle("project:listWorkflowCycles", (_event, payload) => {
    const parsed = workflowCycleListRequestSchema.parse(payload);
    return appService?.listWorkflowCycles(parsed.projectId, { cursor: parsed.cursor, limit: parsed.limit });
  });
  ipcMain.handle("project:getWorkflowCycle", (_event, payload) => {
    const parsed = workflowCycleDetailRequestSchema.parse(payload);
    return appService?.getWorkflowCycle(parsed.projectId, parsed.cycleId);
  });
  ipcMain.handle("project:listCycleAgents", (_event, payload) => {
    const parsed = cycleAgentListRequestSchema.parse(payload);
    return appService?.listCycleAgents(parsed.projectId, parsed.cycleId);
  });
  ipcMain.handle("project:getAgentTranscript", async (_event, payload) => {
    const parsed = agentTranscriptRequestSchema.parse(payload);
    return await appService?.getAgentTranscript(parsed.projectId, parsed.agentId);
  });
  ipcMain.handle("project:getAgentFullOutput", async (_event, payload) => {
    const parsed = agentTranscriptRequestSchema.parse(payload);
    return await appService?.getAgentFullOutput(parsed.projectId, parsed.agentId);
  });
  ipcMain.handle("project:getLogFeed", (_event, payload) => {
    const parsed = projectLogFeedRequestSchema.parse(payload);
    return appService?.getProjectLogFeed(parsed.projectId, parsed);
  });
  ipcMain.handle("project:updateLayout", (_event, payload) => {
    const parsed = layoutUpdateRequestSchema.parse(payload);
    appService?.updateLayout(parsed.projectId, parsed);
  });
  ipcMain.handle("project:updateUiState", async (_event, payload) => {
    const parsed = uiStateUpdateRequestSchema.parse(payload);
    await appService?.updateUiState(parsed.projectId, parsed);
  });
  ipcMain.handle("project:openProjectShell", async (_event, payload) => {
    const parsed = openProjectShellRequestSchema.parse(payload);
    return await appService?.openProjectShell(parsed.projectId);
  });
  ipcMain.handle("workflow:openRepairAgent", async (_event, payload) => {
    const parsed = openWorkflowRepairAgentRequestSchema.parse(payload);
    return await appService?.openWorkflowRepairAgent(parsed.projectId);
  });
  ipcMain.handle("credentials:saveEntry", async (_event, payload) => {
    const parsed = credentialEntrySaveRequestSchema.parse(payload);
    return await appService?.saveCredentialEntry(parsed.projectId, parsed);
  });
  ipcMain.handle("credentials:deleteEntry", async (_event, payload) => {
    const parsed = credentialEntryDeleteRequestSchema.parse(payload);
    return await appService?.deleteCredentialEntry(parsed.projectId, parsed.entryId);
  });
  ipcMain.handle("credentials:updateRequest", async (_event, payload) => {
    const parsed = credentialRequestUpdateSchema.parse(payload);
    return await appService?.updateCredentialRequest(parsed.projectId, parsed.requestId, parsed.status, parsed.notes);
  });
  ipcMain.handle("credentials:submitRequestToAgent", async (_event, payload) => {
    const parsed = credentialRequestSubmitToAgentSchema.parse(payload);
    return await appService?.submitCredentialRequestToAgent(parsed.projectId, parsed.requestId);
  });
  ipcMain.handle("workflow:updateUltimateGoal", async (_event, payload) => {
    const parsed = updateUltimateGoalRequestSchema.parse(payload);
    return await appService?.updateUltimateGoal(parsed.projectId, parsed.goal, parsed.confirm);
  });
  ipcMain.handle("workflow:detectUltimateGoal", async (_event, payload) => {
    const parsed = detectUltimateGoalRequestSchema.parse(payload);
    return await appService?.detectUltimateGoal(parsed.projectId);
  });
  ipcMain.handle("workflow:importUltimateGoalText", async (_event, payload) => {
    const parsed = importUltimateGoalTextRequestSchema.parse(payload);
    const fileResult = await dialog.showOpenDialog({
      title: "Select an Ultimate Goal text file",
      properties: ["openFile"],
      filters: [
        {
          name: "Text",
          extensions: ["txt"]
        }
      ]
    });
    if (fileResult.canceled || fileResult.filePaths.length === 0) {
      return null;
    }
    return await appService?.importUltimateGoalText(parsed.projectId, fileResult.filePaths[0]);
  });
  ipcMain.handle("workflow:getGoalCharter", (_event, payload) => {
    const parsed = goalCharterRequestSchema.parse(payload);
    return appService?.getGoalCharter(parsed.projectId);
  });
  ipcMain.handle("workflow:updateGoalCharter", async (_event, payload) => {
    const parsed = updateGoalCharterRequestSchema.parse(payload);
    return await appService?.updateGoalCharter(parsed.projectId, parsed.patch);
  });
  ipcMain.handle("workflow:polishGoalCharterField", async (_event, payload) => {
    const parsed = polishGoalCharterFieldRequestSchema.parse(payload);
    return await appService?.polishGoalCharterField(parsed.projectId, {
      field: parsed.field,
      value: parsed.value,
      currentDraft: parsed.currentDraft,
      model: parsed.model,
      reasoningEffort: parsed.reasoningEffort
    });
  });
  ipcMain.handle("workflow:generateGoalCharterDraft", async (_event, payload) => {
    const parsed = generateGoalCharterDraftRequestSchema.parse(payload);
    return await appService?.generateGoalCharterDraft(parsed.projectId, {
      prompt: parsed.prompt,
      currentDraft: parsed.currentDraft,
      model: parsed.model,
      reasoningEffort: parsed.reasoningEffort
    });
  });
  ipcMain.handle("workflow:getAutopilotStrategy", (_event, payload) => {
    const parsed = autopilotStrategyRequestSchema.parse(payload);
    return appService?.getAutopilotStrategy(parsed.projectId);
  });
  ipcMain.handle("workflow:updateAutopilotStrategy", async (_event, payload) => {
    const parsed = updateAutopilotStrategyRequestSchema.parse(payload);
    return await appService?.updateAutopilotStrategy(parsed.projectId, parsed.strategy);
  });
  ipcMain.handle("workflow:listAutopilotPresets", () => appService?.listAutopilotPresets());
  ipcMain.handle("workflow:generateStrategicPlan", (_event, payload) => {
    const parsed = strategicPlanRequestSchema.parse(payload);
    return appService?.generateStrategicPlan(parsed.projectId);
  });
  ipcMain.handle("workflow:selectNextWorkPackage", (_event, payload) => {
    const parsed = strategicPlanRequestSchema.parse(payload);
    return appService?.selectNextWorkPackage(parsed.projectId);
  });
  ipcMain.handle("workflow:proposeGoalChange", async (_event, payload) => {
    const parsed = goalChangeProposalRequestSchema.parse(payload);
    return await appService?.proposeGoalChange(parsed.projectId, parsed.proposal);
  });
  ipcMain.handle("workflow:acceptGoalChange", async (_event, payload) => {
    const parsed = goalChangeDecisionRequestSchema.parse(payload);
    return await appService?.acceptGoalChange(parsed.projectId, parsed.proposalId);
  });
  ipcMain.handle("workflow:rejectGoalChange", async (_event, payload) => {
    const parsed = goalChangeDecisionRequestSchema.parse(payload);
    return await appService?.rejectGoalChange(parsed.projectId, parsed.proposalId, parsed.decisionNotes);
  });
  ipcMain.handle("workflow:listChecklistChanges", (_event, payload) => {
    const parsed = strategicPlanRequestSchema.parse(payload);
    return appService?.listChecklistChanges(parsed.projectId);
  });
  ipcMain.handle("workflow:getPlannerDecision", (_event, payload) => {
    const parsed = plannerCycleRecordRequestSchema.parse(payload);
    return appService?.getPlannerDecision(parsed.projectId, parsed.cycleId);
  });
  ipcMain.handle("workflow:getCycleRetrospective", (_event, payload) => {
    const parsed = plannerCycleRecordRequestSchema.parse(payload);
    return appService?.getCycleRetrospective(parsed.projectId, parsed.cycleId);
  });
  ipcMain.handle("workflow:approveRecommendation", async (_event, payload) => {
    const parsed = approveRecommendationRequestSchema.parse(payload);
    return await appService?.approveRecommendation(parsed.projectId, parsed.recommendationId);
  });
  ipcMain.handle("workflow:createScopedGoal", async (_event, payload) => {
    const parsed = createScopedGoalRequestSchema.parse(payload);
    return await appService?.createScopedGoal(parsed.projectId);
  });
  ipcMain.handle("workflow:retryGoal", async (_event, payload) => {
    const parsed = retryWorkflowGoalRequestSchema.parse(payload);
    return await appService?.retryWorkflowGoal(parsed.projectId);
  });
  ipcMain.handle("workflow:revalidateRepair", async (_event, payload) => {
    const parsed = revalidateWorkflowRepairRequestSchema.parse(payload);
    return await appService?.revalidateWorkflowRepair(parsed.projectId);
  });
  ipcMain.handle("workflow:setMode", async (_event, payload) => {
    const parsed = setWorkflowModeRequestSchema.parse(payload);
    return await appService?.setWorkflowMode(parsed.projectId, parsed.workflowMode);
  });
  ipcMain.handle("workflow:requestPreview", async (_event, payload) => {
    const parsed = requestWorkflowPreviewRequestSchema.parse(payload);
    return await appService?.requestWorkflowPreview(parsed.projectId, parsed.reason, parsed.remainingCycles);
  });
  ipcMain.handle("workflow:cancelPreview", async (_event, payload) => {
    const parsed = workflowPreviewCheckpointRequestSchema.parse(payload);
    return await appService?.cancelWorkflowPreview(parsed.projectId);
  });
  ipcMain.handle("workflow:completePreview", async (_event, payload) => {
    const parsed = workflowPreviewCheckpointRequestSchema.parse(payload);
    return await appService?.completeWorkflowPreview(parsed.projectId);
  });
  ipcMain.handle("workflow:setAutopilotPolicy", async (_event, payload) => {
    const parsed = setAutopilotPolicyRequestSchema.parse(payload);
    return await appService?.setAutopilotPolicy(parsed.projectId, parsed.policy);
  });
  ipcMain.handle("workflow:advanceStage", async (_event, payload) => {
    const parsed = advanceWorkflowStageRequestSchema.parse(payload);
    return await appService?.advanceWorkflowStage(parsed.projectId);
  });
  ipcMain.handle("workflow:recover", (_event, payload) => {
    const parsed = advanceWorkflowStageRequestSchema.parse(payload);
    return appService?.recoverWorkflow(parsed.projectId);
  });
  ipcMain.handle("workflow:clearStaleLock", async (_event, payload) => {
    const parsed = advanceWorkflowStageRequestSchema.parse(payload);
    return await appService?.clearStaleWorkflowLock(parsed.projectId);
  });
  ipcMain.handle("workflow:requestHumanIntervention", async (_event, payload) => {
    const parsed = requestHumanInterventionRequestSchema.parse(payload);
    return await appService?.requestHumanIntervention(parsed.projectId, parsed);
  });
  ipcMain.handle("workflow:resolveHumanIntervention", async (_event, payload) => {
    const parsed = resolveHumanInterventionRequestSchema.parse(payload);
    return await appService?.resolveHumanIntervention(parsed.projectId, parsed.interventionId, parsed.status, parsed.resolutionNotes);
  });
  ipcMain.handle("workflow:submitUserInputRequest", async (_event, payload) => {
    const parsed = submitUserInputRequestResponseSchema.parse(payload);
    return await appService?.submitUserInputRequest(parsed.projectId, parsed.requestId, parsed.answers);
  });
  ipcMain.handle("workflow:addUserInputRequestAttachments", async (_event, payload) => {
    const parsed = manageUserInputRequestAttachmentsSchema.parse(payload);
    const fileResult = await dialog.showOpenDialog({
      title: "Select files for the agent",
      properties: ["openFile", "multiSelections"]
    });
    if (fileResult.canceled || fileResult.filePaths.length === 0) {
      return appService?.getState().projects.find((entry) => entry.record.id === parsed.projectId)?.record.userInputRequests
        .find((request) => request.id === parsed.requestId);
    }
    return await appService?.addUserInputRequestAttachments(parsed.projectId, parsed.requestId, fileResult.filePaths);
  });
  ipcMain.handle("workflow:openUserInputRequestInbox", async (_event, payload) => {
    const parsed = manageUserInputRequestAttachmentsSchema.parse(payload);
    const hostPath = await appService?.getUserInputRequestInboxHostPath(parsed.projectId, parsed.requestId);
    if (!hostPath) {
      return;
    }
    const error = await shell.openPath(hostPath);
    if (error) {
      throw new Error(error);
    }
  });
  ipcMain.handle("project:revalidate", async (_event, projectId: string) => await appService?.revalidateProject(projectId));
  ipcMain.handle("agent:create", async (_event, payload) => {
    const parsed = createAgentRequestSchema.parse(payload);
    return await appService?.createAgent(parsed.projectId, parsed.category, parsed.name, parsed.prompt, parsed.model, {
      reasoningMode: parsed.reasoningMode,
      effort: parsed.reasoningEffort
    });
  });
  ipcMain.handle("agent:approve", async (_event, payload) => {
    const parsed = approvalDecisionRequestSchema.parse(payload);
    await appService?.approve(parsed.projectId, parsed.agentId, parsed.approvalId, parsed.decision);
  });
  ipcMain.handle("agent:runIntegrity", async (_event, projectId: string) => await appService?.runIntegrity(projectId));
  ipcMain.handle("agent:runMerge", async (_event, projectId: string) => await appService?.runMerge(projectId));
  ipcMain.handle("agent:runRecommendation", async (_event, payload) => {
    const parsed = runRecommendationRequestSchema.parse(payload);
    return await appService?.runRecommendation(parsed.projectId, false, parsed.customFocus);
  });
  ipcMain.handle("app:quit", async () => {
    await requestAppQuit();
  });
  ipcMain.handle("app:chooseFolder", async (_event, payload) => {
    const options = chooseFolderRequestSchema.parse(payload);
    const result = await dialog.showOpenDialog({
      title: options.title ?? "Select a repository or workspace folder",
      buttonLabel: options.buttonLabel,
      message: options.message,
      properties: ["openDirectory"]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });
  ipcMain.handle("app:chooseImportBundle", async () => {
    const folderResult = await dialog.showOpenDialog({
      title: "Select the target project folder",
      properties: ["openDirectory"]
    });
    if (folderResult.canceled || folderResult.filePaths.length === 0) {
      return null;
    }

    const fileResult = await dialog.showOpenDialog({
      title: "Select a portable interface file",
      properties: ["openFile"],
      filters: [
        {
          name: "JSON",
          extensions: ["json"]
        }
      ]
    });
    if (fileResult.canceled || fileResult.filePaths.length === 0) {
      return null;
    }

    return {
      projectRootPath: folderResult.filePaths[0],
      importPath: fileResult.filePaths[0]
    };
  });
  ipcMain.handle("app:importInterfaceBundle", async () => {
    const folderResult = await dialog.showOpenDialog({
      title: "Select the target project folder",
      properties: ["openDirectory"]
    });
    if (folderResult.canceled || folderResult.filePaths.length === 0) {
      return null;
    }

    const fileResult = await dialog.showOpenDialog({
      title: "Select a portable interface file",
      properties: ["openFile"],
      filters: [
        {
          name: "JSON",
          extensions: ["json"]
        }
      ]
    });
    if (fileResult.canceled || fileResult.filePaths.length === 0) {
      return null;
    }

    return await appService?.importInterfaceFromExternalPath(folderResult.filePaths[0], fileResult.filePaths[0]);
  });
};

void app.whenReady().then(async () => {
  appService = new AppService(app.getPath("userData"), safeStorage);
  await appService.initialize({ deferStartupWork: true });
  appService.on("stateChanged", (state) => sendState(state));
  registerIpc();
  await createMainWindow();
  sendState(appService.getRendererState());
  void appService.runDeferredStartupWork();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    void requestAppQuit();
  }
});
