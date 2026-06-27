import type { ReactNode } from "react";

export type CommandCenterTone = "idle" | "running" | "paused" | "blocked" | "completed" | "not-started" | "pending" | "warning" | "error" | "success";

export interface CommandCenterItem {
  label: string;
  value: string;
  detail?: string;
  tone?: CommandCenterTone;
}

export interface CommandCenterHealthItem {
  label: string;
  tone: CommandCenterTone;
}

export interface CommandCenterProps {
  projectName: string;
  projectContext: string;
  currentFocus: string;
  focusSummary?: string;
  focusChips?: CommandCenterHealthItem[];
  phaseDetails?: CommandCenterItem[];
  currentPhase: string;
  activeAgent: string;
  statusLabel: string;
  statusTone: CommandCenterTone;
  whyThisMatters: string;
  whyDetails?: CommandCenterItem[];
  progress: CommandCenterItem[];
  changes: CommandCenterItem[];
  attention: CommandCenterItem[];
  attentionEmpty?: string;
  lastResult: string;
  nextStep: string;
  health: CommandCenterHealthItem[];
  primaryAction?: ReactNode;
  onOpenWorkflow: () => void;
  onOpenHistory: () => void;
  onOpenRepository: () => void;
  onOpenSettings: () => void;
}

const ToneBadge = ({ label, tone }: { label: string; tone: CommandCenterTone }) => (
  <span className={`command-center-badge command-center-badge--${tone}`}>{label}</span>
);

const CommandCenterList = ({
  items,
  empty,
  expandable = false
}: {
  items: CommandCenterItem[];
  empty: string;
  expandable?: boolean;
}) => (
  <div className="command-center-list">
    {items.length ? items.map((item) => (
      <div key={`${item.label}:${item.value}`} className={`command-center-list__item ${item.tone ? `command-center-list__item--${item.tone}` : ""}`}>
        <span>{item.label}</span>
        <strong>{item.value}</strong>
        {item.detail ? (
          expandable ? (
            <details className="command-center-inline-details">
              <summary>Details</summary>
              <p>{item.detail}</p>
            </details>
          ) : <p>{item.detail}</p>
        ) : null}
      </div>
    )) : (
      <p className="command-center-empty">{empty}</p>
    )}
  </div>
);

export const CommandCenter = ({
  projectName,
  projectContext,
  currentFocus,
  focusSummary,
  focusChips = [],
  phaseDetails,
  currentPhase,
  activeAgent,
  statusLabel,
  statusTone,
  whyThisMatters,
  whyDetails = [],
  progress,
  changes,
  attention,
  attentionEmpty = "No validation, hygiene, checklist, or planner blocker is currently recorded.",
  lastResult,
  nextStep,
  health,
  primaryAction,
  onOpenWorkflow,
  onOpenHistory,
  onOpenRepository,
  onOpenSettings
}: CommandCenterProps) => (
  <section className="command-center" aria-label="Command Center">
    <div className="command-center__hero">
      <div>
        <div className="eyebrow">Command Center</div>
        <h2>{projectName}</h2>
        <p>{projectContext}</p>
      </div>
      <div className="command-center__hero-status">
        <ToneBadge label={statusLabel} tone={statusTone} />
        {primaryAction}
      </div>
    </div>

    <div className="command-center__grid">
      <article className="command-center-card command-center-card--focus">
        <div className="command-center-card__header">
          <span>Current focus</span>
          <ToneBadge label={statusLabel} tone={statusTone} />
        </div>
        <h3>{currentFocus}</h3>
        {focusSummary ? <p className="command-center-card__lead">{focusSummary}</p> : null}
        {focusChips.length ? (
          <div className="command-center-health">
            {focusChips.map((item) => <ToneBadge key={`${item.label}:${item.tone}`} label={item.label} tone={item.tone} />)}
          </div>
        ) : null}
        <div className="command-center-card__facts">
          {(phaseDetails ?? [
            { label: "Current phase", value: currentPhase },
            { label: "Active agent", value: activeAgent }
          ]).map((item) => (
            <div key={`${item.label}:${item.value}`}>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
              {item.detail ? <p>{item.detail}</p> : null}
            </div>
          ))}
        </div>
      </article>

      <article className="command-center-card">
        <div className="command-center-card__header">
          <span>Why this matters</span>
        </div>
        <p>{whyThisMatters}</p>
        {whyDetails.length ? <CommandCenterList items={whyDetails} empty="" expandable /> : null}
      </article>

      <article className="command-center-card">
        <div className="command-center-card__header">
          <span>Progress</span>
          <button className="command-center-link" type="button" onClick={onOpenWorkflow}>Workflow</button>
        </div>
        <CommandCenterList items={progress} empty="No workflow progress has been recorded yet." />
      </article>

      <article className="command-center-card">
        <div className="command-center-card__header">
          <span>What changed so far</span>
          <button className="command-center-link" type="button" onClick={onOpenHistory}>History</button>
        </div>
        <CommandCenterList items={changes} empty="No changed files or commands have been recorded yet." />
      </article>

      <article className={`command-center-card ${attention.length ? "command-center-card--attention" : "command-center-card--clear"}`}>
        <div className="command-center-card__header">
          <span>Needs your attention</span>
          <ToneBadge label={attention.length ? `${attention.length} item${attention.length === 1 ? "" : "s"}` : "Clear"} tone={attention.length ? "warning" : "success"} />
        </div>
        <CommandCenterList items={attention} empty={attentionEmpty} />
      </article>

      <article className="command-center-card">
        <div className="command-center-card__header">
          <span>Last result</span>
          <button className="command-center-link" type="button" onClick={onOpenHistory}>Details</button>
        </div>
        <p>{lastResult}</p>
      </article>

      <article className="command-center-card">
        <div className="command-center-card__header">
          <span>Next step</span>
          <button className="command-center-link" type="button" onClick={onOpenWorkflow}>Open</button>
        </div>
        <p>{nextStep}</p>
      </article>

      <article className="command-center-card command-center-card--health">
        <div className="command-center-card__header">
          <span>Project health</span>
          <button className="command-center-link" type="button" onClick={onOpenSettings}>Settings</button>
        </div>
        <div className="command-center-health">
          {health.map((item) => <ToneBadge key={`${item.label}:${item.tone}`} label={item.label} tone={item.tone} />)}
        </div>
        <button className="secondary-button secondary-button--compact" type="button" onClick={onOpenRepository}>Repository details</button>
      </article>
    </div>
  </section>
);
