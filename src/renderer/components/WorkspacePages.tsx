import { useEffect, useState } from "react";
import type {
  PreviewArtifactMetadata,
  PreviewGateVerdict,
  PreviewSessionStatus,
  PreviewStateProjection,
  WorkflowPreviewStatus
} from "@shared/types";

export type ActivitySummaryItem = {
  id: string;
  title: string;
  detail: string;
  meta: string;
  tone?: "neutral" | "warning" | "danger" | "success";
};

type PreviewWorkspaceProps = {
  status: WorkflowPreviewStatus;
  preview?: PreviewStateProjection;
  reason?: string;
  evidence: string[];
  evidenceKind?: "legacy" | "browser";
  previewSessionId?: string;
  previewGateReportId?: string;
  requestedAt?: string;
  startedAt?: string;
  completedAt?: string;
  disabledReason?: string;
  busy: boolean;
  onRequest: () => void;
  onCancel: () => void;
  onComplete: () => void;
  onOpenBuild: () => void;
  onRefreshReadiness?: () => void;
  onGrantTrust?: () => void;
  onInstallBrowser?: () => void;
  onStart?: () => void;
  onStop?: (sessionId: string) => void;
  onRetry?: () => void;
  onOpenLocalBrowser?: (sessionId: string) => void;
  onCapture?: (sessionId: string) => void;
  onLoadArtifact?: (
    sessionId: string,
    artifactId: string
  ) => Promise<{ metadata: PreviewArtifactMetadata; bytes: Uint8Array }>;
};

const previewStatusCopy = (status: WorkflowPreviewStatus): { label: string; detail: string; tone: string } => {
  switch (status) {
    case "queued":
      return { label: "Queued", detail: "The browser checkpoint will begin when the current safe operation finishes.", tone: "warning" };
    case "active":
      return { label: "Capturing", detail: "The project is being inspected and evidence is being collected.", tone: "running" };
    case "ready":
      return { label: "Review ready", detail: "Review the captured evidence before allowing the workflow to continue.", tone: "warning" };
    case "completed":
      return { label: "Reviewed", detail: "The latest preview checkpoint was accepted and the workflow can continue.", tone: "success" };
    case "cancelled":
      return { label: "Cancelled", detail: "The last preview request was cancelled without changing the project.", tone: "idle" };
    case "failed":
      return { label: "Needs setup", detail: "The browser checkpoint could not complete. Review the failure and retry safely.", tone: "danger" };
    default:
      return { label: "Not started", detail: "Create a checkpoint when the current interface is ready to inspect.", tone: "idle" };
  }
};

const formatTime = (value?: string): string => {
  if (!value) {
    return "Not recorded";
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
};

const previewSessionStatusCopy = (status: PreviewSessionStatus): { label: string; detail: string; tone: string } => {
  switch (status) {
    case "trust_required":
      return { label: "Permission needed", detail: "Review the detected command before this project starts a local process.", tone: "warning" };
    case "starting":
      return { label: "Starting", detail: "The local preview server and isolated browser are starting.", tone: "running" };
    case "running":
      return { label: "Connected", detail: "The local preview is running and ready for inspection.", tone: "running" };
    case "capturing":
      return { label: "Capturing", detail: "Workbench is collecting browser evidence across the required viewports.", tone: "running" };
    case "ready":
      return { label: "Review ready", detail: "Fresh browser evidence is ready for review.", tone: "warning" };
    case "failed":
      return { label: "Preview failed", detail: "The preview stopped before it could produce a complete checkpoint.", tone: "danger" };
    case "stopped":
      return { label: "Stopped", detail: "The local server and browser session have been stopped.", tone: "idle" };
  }
};

const gateVerdictCopy = (verdict: PreviewGateVerdict): { label: string; tone: string } => {
  switch (verdict) {
    case "pass":
      return { label: "Checks passed", tone: "success" };
    case "needs_review":
      return { label: "Review required", tone: "warning" };
    case "fail":
      return { label: "Blocking findings", tone: "danger" };
    case "not_applicable":
      return { label: "Not required", tone: "idle" };
  }
};

const artifactKindLabel = (artifact: PreviewArtifactMetadata): string =>
  artifact.viewport
    ? `${artifact.viewport.id} · ${artifact.viewport.width} × ${artifact.viewport.height}`
    : artifact.kind;

const ArtifactPreview = ({
  sessionId,
  artifact,
  onLoad
}: {
  sessionId: string;
  artifact: PreviewArtifactMetadata;
  onLoad?: PreviewWorkspaceProps["onLoadArtifact"];
}) => {
  const [objectUrl, setObjectUrl] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string>();

  useEffect(() => () => {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
    }
  }, [objectUrl]);

  const load = async () => {
    if (!onLoad || loading || objectUrl) {
      return;
    }
    setLoading(true);
    setLoadError(undefined);
    try {
      const result = await onLoad(sessionId, artifact.id);
      const copiedBytes = new Uint8Array(result.bytes.byteLength);
      copiedBytes.set(result.bytes);
      setObjectUrl(URL.createObjectURL(new Blob([copiedBytes.buffer], { type: result.metadata.mimeType })));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  return (
    <article className="preview-artifact-card">
      <div className="preview-artifact-card__media">
        {objectUrl ? (
          <img src={objectUrl} alt={`${artifact.label} browser capture`} />
        ) : (
          <button type="button" onClick={() => void load()} disabled={!onLoad || loading} aria-label={`Load ${artifact.label}`}>
            <svg viewBox="0 0 64 48" aria-hidden="true"><rect x="5" y="5" width="54" height="38" rx="4" /><path d="m12 35 11-11 8 8 7-7 14 10M44 15h.01" /></svg>
            <span>{loading ? "Loading capture…" : "Load capture"}</span>
          </button>
        )}
      </div>
      <div className="preview-artifact-card__copy">
        <strong>{artifact.label}</strong>
        <span>{artifactKindLabel(artifact)}</span>
        {loadError ? <small role="alert">{loadError}</small> : null}
      </div>
    </article>
  );
};

export const PreviewWorkspace = ({
  status,
  preview,
  reason,
  evidence,
  evidenceKind,
  previewSessionId,
  previewGateReportId,
  requestedAt,
  startedAt,
  completedAt,
  disabledReason,
  busy,
  onRequest,
  onCancel,
  onComplete,
  onOpenBuild,
  onRefreshReadiness,
  onGrantTrust,
  onInstallBrowser,
  onStart,
  onStop,
  onRetry,
  onOpenLocalBrowser,
  onCapture,
  onLoadArtifact
}: PreviewWorkspaceProps) => {
  const statusCopy = previewStatusCopy(status);
  const readiness = preview?.readiness;
  const session = preview?.activeSession;
  const report = preview?.latestReport;
  const sessionCopy = session ? previewSessionStatusCopy(session.status) : undefined;
  const visibleCopy = sessionCopy ?? statusCopy;
  const screenshotArtifacts = session?.artifacts.filter((artifact) => artifact.kind === "screenshot") ?? [];
  const otherArtifacts = session?.artifacts.filter((artifact) => artifact.kind !== "screenshot") ?? [];
  const browserEvidenceReady = screenshotArtifacts.length > 0 || Boolean(session?.latestSnapshot);
  const canRequest = status === "none" || status === "completed" || status === "cancelled" || status === "failed";
  const canCancel = status === "queued";
  const canComplete = status === "ready";
  const browserGateReady = Boolean(
    canComplete &&
    session &&
    report &&
    previewSessionId === session.id &&
    previewGateReportId === report.id &&
    report.sourceRevision === session.sourceRevision &&
    report.artifactIds.length > 0 &&
    report.verdict !== "fail"
  );
  const canStop = Boolean(session && ["starting", "running", "capturing", "ready"].includes(session.status));
  const canRetry = Boolean(session && ["failed", "stopped"].includes(session.status));
  const gateCopy = report ? gateVerdictCopy(report.verdict) : undefined;
  const startHandler = onStart ?? onRequest;

  return (
    <section className="preview-workspace" aria-labelledby="preview-workspace-title">
      <header className="workspace-page-header">
        <div>
          <span className="eyebrow">Visual checkpoint</span>
          <h2 id="preview-workspace-title">Preview and review</h2>
          <p>Inspect browser evidence without exposing the target application or Node APIs inside the Workbench renderer.</p>
        </div>
        <span className={`status-chip status-chip--${visibleCopy.tone}`}>{visibleCopy.label}</span>
      </header>

      <div className="preview-workspace__layout">
        <article className="preview-canvas" aria-live="polite">
          <div className="preview-canvas__toolbar">
            <div className="preview-canvas__lights" aria-hidden="true"><span /><span /><span /></div>
            <span>Browser evidence</span>
            <span>{browserEvidenceReady ? `${screenshotArtifacts.length} capture${screenshotArtifacts.length === 1 ? "" : "s"}` : "Awaiting capture"}</span>
          </div>
          {browserEvidenceReady ? (
            <div className="preview-evidence-browser">
              {screenshotArtifacts.length ? (
                <div className="preview-artifact-grid" aria-label="Browser screenshots">
                  {screenshotArtifacts.map((artifact) => (
                    <ArtifactPreview key={`${session!.id}:${artifact.id}`} sessionId={session!.id} artifact={artifact} onLoad={onLoadArtifact} />
                  ))}
                </div>
              ) : null}
              {session?.latestSnapshot ? (
                <details className="preview-snapshot" open={!screenshotArtifacts.length}>
                  <summary>Accessible page snapshot <span>{session.latestSnapshot.elements.length} interactive elements</span></summary>
                  <div className="preview-snapshot__meta"><span>{session.latestSnapshot.title || "Untitled page"}</span><code>{session.latestSnapshot.url}</code></div>
                  <pre>{session.latestSnapshot.ariaSnapshot || "No accessibility tree was returned."}</pre>
                </details>
              ) : null}
              {evidence.length ? (
                <ol className="preview-evidence-list preview-evidence-list--compact">
                  {evidence.map((item, index) => <li key={`${index}:${item}`}><span>{String(index + 1).padStart(2, "0")}</span><p>{item}</p></li>)}
                </ol>
              ) : null}
            </div>
          ) : evidence.length ? (
            <div className="preview-legacy-evidence">
              <div className="preview-legacy-evidence__label"><span className="status-chip status-chip--idle">{evidenceKind === "browser" ? "Browser notes" : "Legacy notes"}</span><p>These notes are not a substitute for a fresh browser capture.</p></div>
              <ol className="preview-evidence-list">
                {evidence.map((item, index) => <li key={`${index}:${item}`}><span>{String(index + 1).padStart(2, "0")}</span><p>{item}</p></li>)}
              </ol>
            </div>
          ) : (
            <div className="preview-canvas__empty">
              <svg viewBox="0 0 64 64" aria-hidden="true">
                <rect x="7" y="11" width="50" height="38" rx="5" />
                <path d="M7 21h50M22 55h20M32 49v6" />
                <circle cx="14" cy="16" r="1" /><circle cx="19" cy="16" r="1" /><circle cx="24" cy="16" r="1" />
              </svg>
              <strong>{visibleCopy.label}</strong>
              <p>{disabledReason ?? session?.error ?? session?.message ?? reason ?? readiness?.message ?? visibleCopy.detail}</p>
            </div>
          )}
        </article>

        <aside className="preview-review-panel" aria-label="Preview checkpoint controls">
          <div>
            <span className="eyebrow">Checkpoint state</span>
            <h3>{visibleCopy.label}</h3>
            <p>{session?.error ?? session?.message ?? reason ?? readiness?.message ?? visibleCopy.detail}</p>
          </div>
          {readiness ? (
            <div className={`preview-readiness preview-readiness--${readiness.status}`}>
              <span>Environment</span>
              <strong>{readiness.status === "ready" ? "Ready to preview" : readiness.status === "browser_required" ? "Browser needed" : readiness.status === "recipe_required" ? "Preview command needed" : "Unavailable"}</strong>
              <p>{readiness.message}</p>
              {readiness.browserInstallCommand ? <code>{readiness.browserInstallCommand}</code> : null}
            </div>
          ) : null}
          {session?.status === "trust_required" ? (
            <div className="preview-trust-card">
              <div><span className="eyebrow">One-time project permission</span><strong>Allow this local command?</strong></div>
              <dl>
                <div><dt>Command and arguments</dt><dd><code>{JSON.stringify([session.recipe.command, ...session.recipe.args])}</code></dd></div>
                <div><dt>Folder</dt><dd><code>{session.recipe.cwd || "."}</code></dd></div>
                <div><dt>Detected as</dt><dd>{session.recipe.adapter} · {session.recipe.source}</dd></div>
              </dl>
              <p>Trust is scoped to this project and exact recipe fingerprint. A changed command requires permission again.</p>
            </div>
          ) : null}
          <dl className="preview-review-panel__facts">
            <div><dt>Requested</dt><dd>{formatTime(requestedAt ?? session?.createdAt)}</dd></div>
            <div><dt>Started</dt><dd>{formatTime(startedAt ?? session?.readyAt)}</dd></div>
            <div><dt>Last update</dt><dd>{formatTime(completedAt ?? session?.updatedAt)}</dd></div>
            {session ? <div><dt>Source revision</dt><dd><code>{session.sourceRevision.slice(0, 12)}</code></dd></div> : null}
          </dl>
          {disabledReason ? <div className="preview-review-panel__notice">{disabledReason}</div> : null}
          <div className="preview-review-panel__actions">
            {session?.status === "trust_required" && onGrantTrust ? <button className="primary-button" type="button" disabled={busy} onClick={onGrantTrust}>{busy ? "Starting…" : "Trust command and start"}</button> : null}
            {readiness?.status === "browser_required" && onInstallBrowser ? <button className="primary-button" type="button" disabled={busy} onClick={onInstallBrowser}>{busy ? "Installing…" : "Install preview browser"}</button> : null}
            {!session && canRequest ? <button className="primary-button" type="button" disabled={busy || Boolean(disabledReason) || readiness?.status === "browser_required" || readiness?.status === "recipe_required" || readiness?.status === "unavailable"} onClick={startHandler}>{busy ? "Working…" : "Start browser preview"}</button> : null}
            {canCancel ? <button className="secondary-button" type="button" disabled={busy} onClick={onCancel}>Cancel request</button> : null}
            {canRetry && onRetry ? <button className="primary-button" type="button" disabled={busy} onClick={onRetry}>{busy ? "Retrying…" : "Retry preview"}</button> : null}
            {canStop && session && onStop ? <button className="secondary-button" type="button" disabled={busy} onClick={() => onStop(session.id)}>Stop preview</button> : null}
            {session?.validatedUrl && onOpenLocalBrowser ? <button className="secondary-button" type="button" disabled={busy} onClick={() => onOpenLocalBrowser(session.id)}>Open in local browser</button> : null}
            {session && ["running", "ready"].includes(session.status) && onCapture ? <button className="secondary-button" type="button" disabled={busy} onClick={() => onCapture(session.id)}>Capture current view</button> : null}
            {canComplete ? <button className="primary-button" type="button" disabled={busy || !browserGateReady} onClick={onComplete}>{busy ? "Working…" : "Approve and continue"}</button> : null}
            {canComplete && !browserGateReady ? <p className="preview-review-panel__inline-note">A matching browser report with saved evidence is required before this checkpoint can be approved.</p> : null}
            {onRefreshReadiness ? <button className="quiet-button" type="button" disabled={busy} onClick={onRefreshReadiness}>Check preview setup</button> : null}
            <button className="secondary-button" type="button" onClick={onOpenBuild}>Open build details</button>
          </div>
          <p className="preview-review-panel__footnote">Browser sessions run through the privileged project runtime. This page only receives sanitized status and evidence.</p>
        </aside>
      </div>

      {session ? (
        <section className="preview-observability" aria-label="Preview diagnostics">
          <details open={session.console.some((entry) => entry.level === "error" || entry.level === "warning")}>
            <summary><span>Console</span><strong>{session.console.length}</strong></summary>
            {session.console.length ? <ol>{session.console.slice(-40).map((entry) => <li key={entry.id} data-level={entry.level}><span>{entry.level}</span><code>{entry.text}</code></li>)}</ol> : <p>No console messages captured.</p>}
          </details>
          <details open={session.network.some((entry) => entry.outcome !== "ok")}>
            <summary><span>Network</span><strong>{session.network.length}</strong></summary>
            {session.network.length ? <ol>{session.network.slice(-40).map((entry) => <li key={entry.id} data-level={entry.outcome === "ok" ? "info" : "error"}><span>{entry.status ?? entry.outcome}</span><code>{entry.method} {entry.url}</code>{entry.detail ? <small>{entry.detail}</small> : null}</li>)}</ol> : <p>No network requests captured.</p>}
          </details>
          <details>
            <summary><span>Other artifacts</span><strong>{otherArtifacts.length}</strong></summary>
            {otherArtifacts.length ? <ul className="preview-artifact-index">{otherArtifacts.map((artifact) => <li key={artifact.id}><span>{artifact.kind}</span><strong>{artifact.label}</strong><small>{Math.max(1, Math.round(artifact.sizeBytes / 1024))} KB · {formatTime(artifact.createdAt)}</small></li>)}</ul> : <p>No additional artifacts captured.</p>}
          </details>
        </section>
      ) : null}

      {report ? (
        <section className="preview-gate-report" aria-labelledby="preview-gate-title">
          <header><div><span className="eyebrow">Browser gate</span><h3 id="preview-gate-title">Checkpoint report</h3></div><span className={`status-chip status-chip--${gateCopy!.tone}`}>{gateCopy!.label}</span></header>
          <div className="preview-gate-report__meta"><span>Revision <code>{report.sourceRevision.slice(0, 12)}</code></span><span>{report.artifactIds.length} evidence artifacts</span><span>{formatTime(report.createdAt)}</span></div>
          {report.deterministicResults.length ? <ul>{report.deterministicResults.map((result) => <li key={result}>{result}</li>)}</ul> : null}
          {report.blockingFindings.length ? <div className="preview-gate-report__findings"><strong>Blocking findings</strong><ul>{report.blockingFindings.map((finding) => <li key={finding}>{finding}</li>)}</ul></div> : null}
          {report.agentSummary ? <p>{report.agentSummary}</p> : null}
        </section>
      ) : null}
    </section>
  );
};

type ActivityWorkspaceProps = {
  attention: ActivitySummaryItem[];
  events: ActivitySummaryItem[];
  runningAgents: number;
  totalRuns: number;
  onOpenTimeline: () => void;
  onOpenRuns: () => void;
  onOpenLogs: () => void;
  onOpenBuild: () => void;
  onOpenAccess: () => void;
};

export const ActivityWorkspace = ({
  attention,
  events,
  runningAgents,
  totalRuns,
  onOpenTimeline,
  onOpenRuns,
  onOpenLogs,
  onOpenBuild,
  onOpenAccess
}: ActivityWorkspaceProps) => (
  <section className="activity-workspace" aria-labelledby="activity-workspace-title">
    <header className="workspace-page-header">
      <div>
        <span className="eyebrow">Operational record</span>
        <h2 id="activity-workspace-title">Activity</h2>
        <p>A calm summary of what is running, what changed, and what needs your decision.</p>
      </div>
      <div className="activity-workspace__quick-actions" aria-label="Activity detail views">
        <button className="secondary-button" type="button" onClick={onOpenTimeline}>Timeline</button>
        <button className="secondary-button" type="button" onClick={onOpenRuns}>Runs</button>
        <button className="secondary-button" type="button" onClick={onOpenLogs}>Logs</button>
      </div>
    </header>

    <div className="activity-summary" aria-label="Activity summary">
      <div><span>Needs attention</span><strong>{attention.length}</strong><small>{attention.length ? "Review required" : "All clear"}</small></div>
      <div><span>Agents working</span><strong>{runningAgents}</strong><small>{runningAgents ? "Live now" : "No active run"}</small></div>
      <div><span>Recorded runs</span><strong>{totalRuns}</strong><small>Available for review</small></div>
    </div>

    <div className="activity-workspace__grid">
      <article className="activity-panel">
        <header><div><span className="eyebrow">Decision queue</span><h3>Needs attention</h3></div><span className="badge">{attention.length}</span></header>
        {attention.length ? (
          <div className="activity-list-modern">
            {attention.map((item) => (
              <button key={item.id} className={`activity-item activity-item--${item.tone ?? "neutral"}`} type="button" onClick={item.meta === "Credentials" ? onOpenAccess : onOpenBuild}>
                <span>{item.meta}</span><strong>{item.title}</strong><p>{item.detail}</p>
              </button>
            ))}
          </div>
        ) : (
          <div className="activity-empty"><span aria-hidden="true">✓</span><strong>No decision is waiting</strong><p>The autonomous cycle can continue within its current safety boundaries.</p></div>
        )}
      </article>

      <article className="activity-panel">
        <header><div><span className="eyebrow">Recent record</span><h3>Latest events</h3></div><span className="badge">{events.length}</span></header>
        {events.length ? (
          <ol className="activity-event-list">
            {events.map((item) => (
              <li key={item.id} className={`activity-event activity-event--${item.tone ?? "neutral"}`}>
                <span>{item.meta}</span><div><strong>{item.title}</strong><p>{item.detail}</p></div>
              </li>
            ))}
          </ol>
        ) : (
          <div className="activity-empty"><span aria-hidden="true">○</span><strong>No activity yet</strong><p>Events will appear after the first workflow action starts.</p></div>
        )}
      </article>
    </div>
  </section>
);
