import { app, BrowserWindow, dialog, ipcMain, nativeImage, safeStorage, shell } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { APP_ID, APP_NAME } from "@shared/constants";
import { getPreloadEntryPath, getRendererEntryPath } from "@shared/electronAppPaths";
import {
  advanceWorkflowStageRequestSchema,
  agentDetailRequestSchema,
  agentListRequestSchema,
  approveRecommendationRequestSchema,
  approvalDecisionRequestSchema,
  createScopedGoalRequestSchema,
  createAgentRequestSchema,
  credentialEntryDeleteRequestSchema,
  credentialEntrySaveRequestSchema,
  credentialRequestSubmitToAgentSchema,
  credentialRequestUpdateSchema,
  downloadInterfaceRequestSchema,
  downloadLogsRequestSchema,
  detectUltimateGoalRequestSchema,
  exportInterfaceRequestSchema,
  fileSummaryRequestSchema,
  importUltimateGoalTextRequestSchema,
  importInterfaceRequestSchema,
  layoutUpdateRequestSchema,
  openProjectShellRequestSchema,
  projectLoadRequestSchema,
  projectLogFeedRequestSchema,
  projectOpenRequestSchema,
  projectSelectionDecisionSchema,
  refreshOverviewRequestSchema,
  manageUserInputRequestAttachmentsSchema,
  retryWorkflowGoalRequestSchema,
  runRecommendationRequestSchema,
  submitUserInputRequestResponseSchema,
  requestHumanInterventionRequestSchema,
  resolveHumanInterventionRequestSchema,
  updateUltimateGoalRequestSchema,
  uiStateUpdateRequestSchema
} from "@shared/ipc";
import type { WorkbenchState } from "@shared/types";
import { appSettingsSchema } from "@shared/schemas";
import { AppService } from "@runtime/appService";

let mainWindow: BrowserWindow | undefined;
let appService: AppService | undefined;
let quitRequested = false;

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
  ipcMain.handle("project:load", async (_event, payload) => {
    const parsed = projectLoadRequestSchema.parse(payload);
    return await appService?.loadProject(parsed.inputPath, parsed.intent);
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
  ipcMain.handle("project:listAgents", (_event, payload) => {
    const parsed = agentListRequestSchema.parse(payload);
    return appService?.listAgents(parsed.projectId, parsed.scope, parsed.offset, parsed.limit);
  });
  ipcMain.handle("project:getAgent", (_event, payload) => {
    const parsed = agentDetailRequestSchema.parse(payload);
    return appService?.getAgent(parsed.projectId, parsed.agentId);
  });
  ipcMain.handle("project:getLogFeed", (_event, payload) => {
    const parsed = projectLogFeedRequestSchema.parse(payload);
    return appService?.getProjectLogFeed(parsed.projectId, parsed);
  });
  ipcMain.handle("project:updateLayout", async (_event, payload) => {
    const parsed = layoutUpdateRequestSchema.parse(payload);
    await appService?.updateLayout(parsed.projectId, parsed);
  });
  ipcMain.handle("project:updateUiState", async (_event, payload) => {
    const parsed = uiStateUpdateRequestSchema.parse(payload);
    await appService?.updateUiState(parsed.projectId, parsed);
  });
  ipcMain.handle("project:openProjectShell", async (_event, payload) => {
    const parsed = openProjectShellRequestSchema.parse(payload);
    return await appService?.openProjectShell(parsed.projectId);
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
  ipcMain.handle("workflow:advanceStage", async (_event, payload) => {
    const parsed = advanceWorkflowStageRequestSchema.parse(payload);
    return await appService?.advanceWorkflowStage(parsed.projectId);
  });
  ipcMain.handle("workflow:recover", async (_event, payload) => {
    const parsed = advanceWorkflowStageRequestSchema.parse(payload);
    return await appService?.recoverWorkflow(parsed.projectId);
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
  ipcMain.handle("app:chooseFolder", async () => {
    const result = await dialog.showOpenDialog({
      title: "Select a GitHub repository or a folder for a new GitHub workspace",
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
  await appService.initialize();
  appService.on("stateChanged", (state) => sendState(state));
  registerIpc();
  await createMainWindow();
  sendState(appService.getRendererState());

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
