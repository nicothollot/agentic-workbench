import { describe, expect, it } from "vitest";
import {
  isPersistedWorkspaceRoute,
  normalizeWorkspaceTab,
  parseRememberedWorkspaceRoute,
  workspaceRouteStorageKey
} from "./workspaceRouting";

describe("workspace routing", () => {
  it("normalizes legacy center tabs without losing supported destinations", () => {
    expect(normalizeWorkspaceTab("settings")).toBe("settings");
    expect(normalizeWorkspaceTab("reports")).toBe("workflow");
    expect(normalizeWorkspaceTab("agents")).toBe("history");
    expect(normalizeWorkspaceTab("diff")).toBe("repository");
    expect(normalizeWorkspaceTab("unknown")).toBe("overview");
  });

  it("keeps renderer-only guided routes local", () => {
    expect(parseRememberedWorkspaceRoute("preview")).toBe("preview");
    expect(parseRememberedWorkspaceRoute("activity")).toBe("activity");
    expect(isPersistedWorkspaceRoute("preview")).toBe(false);
    expect(isPersistedWorkspaceRoute("workflow")).toBe(true);
  });

  it("rejects corrupt remembered routes and scopes keys by project", () => {
    expect(parseRememberedWorkspaceRoute("not-a-route")).toBeUndefined();
    expect(parseRememberedWorkspaceRoute(null)).toBeUndefined();
    expect(workspaceRouteStorageKey("project-1")).toBe("catc.workspaceRoute.project-1");
  });
});
