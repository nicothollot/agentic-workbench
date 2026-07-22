import type { WorkspaceVisualTabId } from "@shared/types";

export type WorkspaceRouteId = WorkspaceVisualTabId | "preview" | "activity";

const persistedTabs = new Set<WorkspaceVisualTabId>([
  "overview",
  "workflow",
  "history",
  "runs",
  "logs",
  "repository",
  "credentials",
  "settings"
]);

export const isPersistedWorkspaceRoute = (route: string): route is WorkspaceVisualTabId =>
  persistedTabs.has(route as WorkspaceVisualTabId);

export const normalizeWorkspaceTab = (tab?: string): WorkspaceVisualTabId => {
  if (tab && isPersistedWorkspaceRoute(tab)) {
    return tab;
  }
  if (tab === "reports") {
    return "workflow";
  }
  if (tab === "agents") {
    return "history";
  }
  if (tab === "file" || tab === "diff") {
    return "repository";
  }
  return "overview";
};

export const parseRememberedWorkspaceRoute = (value?: string | null): WorkspaceRouteId | undefined => {
  if (!value) {
    return undefined;
  }
  if (value === "preview" || value === "activity" || isPersistedWorkspaceRoute(value)) {
    return value;
  }
  return undefined;
};

export const workspaceRouteStorageKey = (projectId: string): string => `catc.workspaceRoute.${projectId}`;
