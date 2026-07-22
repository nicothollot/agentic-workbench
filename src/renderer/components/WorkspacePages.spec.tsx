import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ActivityWorkspace, PreviewWorkspace } from "./WorkspacePages";

describe("PreviewWorkspace", () => {
  it("presents captured evidence and keeps review explicit", async () => {
    const onComplete = vi.fn();
    const createObjectUrl = vi.fn(() => "blob:preview-artifact");
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });
    const view = render(
      <PreviewWorkspace
        status="ready"
        previewSessionId="session-1"
        previewGateReportId="report-1"
        preview={{
          readiness: { projectId: "project-1", status: "ready", message: "Ready", checkedAt: "2026-07-21T11:59:00.000Z" },
          activeSession: {
            id: "session-1",
            projectId: "project-1",
            projectFingerprint: "project-fingerprint",
            sourceRevision: "abc123def456",
            checkpointKind: "explicit",
            status: "ready",
            recipe: {
              id: "recipe-1",
              adapter: "vite",
              source: "detected",
              command: "npm",
              args: ["run", "dev", "--", "--port", "{port}"],
              cwd: ".",
              urlPath: "/",
              fingerprint: "recipe-fingerprint"
            },
            createdAt: "2026-07-21T11:59:00.000Z",
            updatedAt: "2026-07-21T12:00:00.000Z",
            readyAt: "2026-07-21T12:00:00.000Z",
            validatedUrl: "http://127.0.0.1:4173/",
            message: "Evidence ready",
            artifacts: [{
              id: "artifact-1",
              kind: "screenshot",
              mimeType: "image/png",
              sizeBytes: 2048,
              createdAt: "2026-07-21T12:00:00.000Z",
              viewport: { id: "desktop", width: 1440, height: 900 },
              label: "Desktop"
            }],
            console: [],
            network: [],
            blockedOrigins: []
          },
          latestReport: {
            id: "report-1",
            projectId: "project-1",
            cycleNumber: 1,
            checkpointKind: "explicit",
            sourceRevision: "abc123def456",
            recipeFingerprint: "recipe-fingerprint",
            verdict: "pass",
            deterministicResults: ["No blocking browser errors"],
            artifactIds: ["artifact-1"],
            blockingFindings: [],
            createdAt: "2026-07-21T12:00:00.000Z"
          }
        }}
        evidence={["Desktop capture passed", "No console errors"]}
        evidenceKind="browser"
        completedAt="2026-07-21T12:00:00.000Z"
        busy={false}
        onRequest={vi.fn()}
        onCancel={vi.fn()}
        onComplete={onComplete}
        onOpenBuild={vi.fn()}
        onLoadArtifact={() => Promise.resolve({
          metadata: {
            id: "artifact-1",
            kind: "screenshot",
            mimeType: "image/png",
            sizeBytes: 3,
            createdAt: "2026-07-21T12:00:00.000Z",
            label: "Desktop"
          },
          bytes: new Uint8Array([1, 2, 3])
        })}
      />
    );

    expect(screen.getByRole("heading", { name: "Preview and review" })).toBeInTheDocument();
    expect(screen.getByText("Desktop capture passed")).toBeInTheDocument();
    expect(screen.queryByText("Generate preview")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Load Desktop" }));
    expect(await screen.findByRole("img", { name: "Desktop browser capture" })).toHaveAttribute("src", "blob:preview-artifact");
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Approve and continue" }));
    expect(onComplete).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:preview-artifact");
  });

  it("shows the exact local command before granting project trust", async () => {
    const onGrantTrust = vi.fn();
    render(
      <PreviewWorkspace
        status="queued"
        preview={{
          activeSession: {
            id: "session-trust",
            projectId: "project-1",
            projectFingerprint: "project-fingerprint",
            sourceRevision: "abc123",
            checkpointKind: "explicit",
            status: "trust_required",
            recipe: {
              id: "recipe-1",
              adapter: "vite",
              source: "detected",
              command: "npm",
              args: ["run", "dev", "--", "--port", "{port}"],
              cwd: ".",
              urlPath: "/",
              fingerprint: "recipe-fingerprint"
            },
            createdAt: "2026-07-21T12:00:00.000Z",
            updatedAt: "2026-07-21T12:00:00.000Z",
            message: "Trust required",
            artifacts: [],
            console: [],
            network: [],
            blockedOrigins: []
          }
        }}
        evidence={[]}
        busy={false}
        onRequest={vi.fn()}
        onCancel={vi.fn()}
        onComplete={vi.fn()}
        onOpenBuild={vi.fn()}
        onGrantTrust={onGrantTrust}
      />
    );

    expect(screen.getByText('["npm","run","dev","--","--port","{port}"]')).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Trust command and start" }));
    expect(onGrantTrust).toHaveBeenCalledTimes(1);
  });
});

describe("ActivityWorkspace", () => {
  it("routes credential attention to Access and exposes detailed feeds", async () => {
    const onOpenAccess = vi.fn();
    const onOpenLogs = vi.fn();
    render(
      <ActivityWorkspace
        attention={[{ id: "credential", title: "API key required", detail: "Add a project credential.", meta: "Credentials", tone: "warning" }]}
        events={[{ id: "event", title: "Planning finished", detail: "A work package is ready.", meta: "12:00 · Agent", tone: "success" }]}
        runningAgents={0}
        totalRuns={1}
        onOpenTimeline={vi.fn()}
        onOpenRuns={vi.fn()}
        onOpenLogs={onOpenLogs}
        onOpenBuild={vi.fn()}
        onOpenAccess={onOpenAccess}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: /API key required/ }));
    expect(onOpenAccess).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Logs" }));
    expect(onOpenLogs).toHaveBeenCalledTimes(1);
  });
});
