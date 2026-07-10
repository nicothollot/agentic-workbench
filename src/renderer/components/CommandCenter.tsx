import { useMemo, useState, type ReactNode } from "react";

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

export interface CommandCenterPipelineStep {
  id: string;
  title: string;
  description: string;
  status: string;
  displayStatus: string;
  displayStatusLabel: string;
  isCurrent: boolean;
  isBlocked: boolean;
  currentActivity?: string;
  currentSubstep?: string;
  updatedAt?: string;
}

export interface CommandCenterTimelineEvent {
  id: string;
  timestamp: string;
  title: string;
  detail?: string;
  source: string;
  status: string;
  stepId?: string;
}

export interface CommandCenterProps {
  projectName: string;
  projectContext: string;
  goal: string;
  cycleLabel: string;
  autopilotLabel: string;
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
  pipeline: CommandCenterPipelineStep[];
  timeline: CommandCenterTimelineEvent[];
  primaryAction?: ReactNode;
  onOpenWorkflow: () => void;
  onOpenHistory: () => void;
  onOpenRepository: () => void;
  onOpenSettings: () => void;
}

const toneForStep = (step: CommandCenterPipelineStep): "blocked" | "active" | "completed" | "pending" => {
  if (step.isBlocked || step.status === "failed" || step.displayStatus === "failed") {
    return "blocked";
  }
  if (step.isCurrent || ["running", "waiting", "recovering", "starting", "repairing", "retrying_validation"].includes(step.displayStatus)) {
    return "active";
  }
  if (step.status === "completed" || ["completed", "fixed"].includes(step.displayStatus)) {
    return "completed";
  }
  return "pending";
};

const compactTime = (timestamp: string): string => {
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime())
    ? timestamp
    : parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

const StatusPill = ({ label, tone }: { label: string; tone: CommandCenterTone }) => (
  <span className={`mission-status mission-status--${tone}`}><span aria-hidden="true" />{label}</span>
);

const EvidenceList = ({ items, empty }: { items: CommandCenterItem[]; empty: string }) => (
  <div className="mission-evidence-list">
    {items.length ? items.map((item) => (
      <div key={`${item.label}:${item.value}`} className={`mission-evidence mission-evidence--${item.tone ?? "pending"}`}>
        <span>{item.label}</span>
        <strong>{item.value}</strong>
        {item.detail ? <p>{item.detail}</p> : null}
      </div>
    )) : <p className="mission-empty">{empty}</p>}
  </div>
);

export const CommandCenter = ({
  projectName,
  projectContext,
  goal,
  cycleLabel,
  autopilotLabel,
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
  attentionEmpty = "Nothing needs your attention right now.",
  lastResult,
  nextStep,
  health,
  pipeline,
  timeline,
  primaryAction,
  onOpenWorkflow,
  onOpenHistory,
  onOpenRepository,
  onOpenSettings
}: CommandCenterProps) => {
  const defaultStepId = pipeline.find((step) => step.isCurrent)?.id ?? pipeline[0]?.id;
  const [selectedStepId, setSelectedStepId] = useState<string | null | undefined>(defaultStepId);
  const [selectedEventId, setSelectedEventId] = useState<string | undefined>(timeline[0]?.id);
  const resolvedStepId = selectedStepId === null
    ? null
    : pipeline.some((step) => step.id === selectedStepId)
      ? selectedStepId
      : defaultStepId;
  const selectedStep = resolvedStepId ? pipeline.find((step) => step.id === resolvedStepId) : undefined;
  const filteredTimeline = useMemo(
    () => resolvedStepId ? timeline.filter((event) => !event.stepId || event.stepId === resolvedStepId) : timeline,
    [resolvedStepId, timeline]
  );
  const visibleTimeline = filteredTimeline.slice(0, 10);
  const selectedEvent = visibleTimeline.find((event) => event.id === selectedEventId) ?? visibleTimeline[0];
  const repairActive = pipeline.some((step) => step.displayStatus === "repairing" || step.displayStatus === "retrying_validation");

  return (
    <section className="mission-control" aria-label="Mission control overview">
      <header className="mission-hero">
        <div className="mission-hero__copy">
          <div className="eyebrow">Mission control</div>
          <div className="mission-hero__title-row">
            <h2>{projectName}</h2>
            <StatusPill label={statusLabel} tone={statusTone} />
          </div>
          <p className="mission-hero__goal"><span>Ultimate goal</span>{goal}</p>
          <p className="mission-hero__context">{projectContext}</p>
        </div>
        <div className="mission-hero__actions">{primaryAction}</div>
        <div className="mission-hero__facts" aria-label="Current mission facts">
          <div><span>Cycle</span><strong>{cycleLabel}</strong></div>
          <div><span>Phase</span><strong>{currentPhase}</strong></div>
          <div><span>Active agent</span><strong>{activeAgent}</strong></div>
          <div><span>Automation</span><strong>{autopilotLabel}</strong></div>
        </div>
      </header>

      <section className="mission-panel mission-panel--pipeline" aria-label="Mission pipeline">
        <div className="mission-panel__heading">
          <div><span className="eyebrow">Live execution map</span><h3>From goal to integrated result</h3></div>
          <span className="mission-panel__hint">Select a stage to inspect it</span>
        </div>
        <div className="mission-pipeline" aria-label="Workflow stages">
          {pipeline.map((step, index) => {
            const tone = toneForStep(step);
            return (
              <button
                key={step.id}
                className={`mission-pipeline__step mission-pipeline__step--${tone} ${selectedStep?.id === step.id ? "mission-pipeline__step--selected" : ""}`}
                type="button"
                aria-current={step.isCurrent ? "step" : undefined}
                aria-pressed={selectedStep?.id === step.id}
                onClick={() => setSelectedStepId(step.id)}
              >
                <span className="mission-pipeline__index">{String(index + 1).padStart(2, "0")}</span>
                <span className="mission-pipeline__copy"><strong>{step.title}</strong><small>{step.displayStatusLabel}</small></span>
                <span className="mission-pipeline__state" aria-label={tone} />
              </button>
            );
          })}
        </div>
        {repairActive ? <div className="mission-repair-loop"><span aria-hidden="true">↳</span><strong>Repair loop active</strong><span>Integrity has routed work back through Coding; validation will run again automatically.</span></div> : null}
        {selectedStep ? (
          <div className="mission-stage-detail" aria-live="polite">
            <div><span>{selectedStep.displayStatusLabel}</span><strong>{selectedStep.title}</strong></div>
            <p>{selectedStep.currentActivity ?? selectedStep.description}</p>
            <small>{selectedStep.currentSubstep ?? (selectedStep.updatedAt ? `Updated ${compactTime(selectedStep.updatedAt)}` : "Waiting for workflow activity")}</small>
          </div>
        ) : <p className="mission-empty">The workflow pipeline will appear after the goal is initialized.</p>}
      </section>

      <section className="mission-brief-grid" aria-label="Current mission brief">
        <article className="mission-brief mission-brief--now">
          <div className="mission-brief__heading"><span>Now</span>{focusChips.slice(0, 2).map((chip) => <StatusPill key={chip.label} label={chip.label} tone={chip.tone} />)}</div>
          <h3>{currentFocus}</h3>
          <p>{focusSummary ?? "Waiting for the next durable workflow update."}</p>
          <div className="mission-brief__facts">
            {(phaseDetails ?? [{ label: "Current phase", value: currentPhase }, { label: "Active agent", value: activeAgent }]).slice(0, 3).map((item) => (
              <div key={`${item.label}:${item.value}`}><span>{item.label}</span><strong>{item.value}</strong></div>
            ))}
          </div>
        </article>
        <article className="mission-brief mission-brief--next">
          <div className="mission-brief__heading"><span>Next</span></div>
          <h3>Planned handoff</h3>
          <p>{nextStep}</p>
          <div className="mission-brief__result"><span>Latest result</span><strong>{lastResult}</strong></div>
          <button className="mission-link" type="button" onClick={onOpenWorkflow}>Open workflow <span aria-hidden="true">→</span></button>
        </article>
        <article className={`mission-brief mission-brief--attention ${attention.length ? "mission-brief--alert" : "mission-brief--clear"}`}>
          <div className="mission-brief__heading"><span>Needs you</span><StatusPill label={attention.length ? `${attention.length} open` : "Clear"} tone={attention.length ? "warning" : "success"} /></div>
          {attention.length ? (
            <div className="mission-attention-list">
              {attention.slice(0, 3).map((item) => <div key={`${item.label}:${item.value}`}><span>{item.label}</span><strong>{item.value}</strong>{item.detail ? <p>{item.detail}</p> : null}</div>)}
            </div>
          ) : <p className="mission-empty">{attentionEmpty}</p>}
          <button className="mission-link" type="button" onClick={onOpenWorkflow}>Review attention <span aria-hidden="true">→</span></button>
        </article>
      </section>

      <section className="mission-timeline-layout">
        <article className="mission-panel mission-panel--timeline">
          <div className="mission-panel__heading">
            <div><span className="eyebrow">Causal timeline</span><h3>How the project reached this point</h3></div>
            <div className="mission-timeline__filters">
              <button className={resolvedStepId === null ? "is-active" : ""} type="button" onClick={() => setSelectedStepId(null)}>All</button>
              {selectedStep ? <button className="is-active" type="button" onClick={() => setSelectedStepId(selectedStep.id)}>{selectedStep.title}</button> : null}
            </div>
          </div>
          {visibleTimeline.length ? (
            <div className="mission-timeline">
              {visibleTimeline.map((event) => (
                <button key={event.id} className={`mission-timeline__event ${selectedEvent?.id === event.id ? "is-selected" : ""}`} type="button" onClick={() => setSelectedEventId(event.id)}>
                  <span className={`mission-timeline__dot mission-timeline__dot--${event.status}`} />
                  <time dateTime={event.timestamp}>{compactTime(event.timestamp)}</time>
                  <span><strong>{event.title}</strong><small>{event.source.replaceAll("_", " ")}</small></span>
                </button>
              ))}
            </div>
          ) : <p className="mission-empty">No events are attached to this stage yet. Choose All to inspect the full timeline.</p>}
          <button className="mission-link" type="button" onClick={onOpenHistory}>Open full history <span aria-hidden="true">→</span></button>
        </article>
        <aside className="mission-panel mission-event-inspector" aria-live="polite">
          <span className="eyebrow">Selected event</span>
          {selectedEvent ? (
            <>
              <div className="mission-event-inspector__meta"><StatusPill label={selectedEvent.status.replaceAll("_", " ")} tone={selectedEvent.status === "failed" || selectedEvent.status === "blocked" ? "error" : selectedEvent.status === "completed" ? "success" : "pending"} /><time>{compactTime(selectedEvent.timestamp)}</time></div>
              <h3>{selectedEvent.title}</h3>
              <p>{selectedEvent.detail ?? "No additional evidence was attached to this event."}</p>
              <small>Source · {selectedEvent.source.replaceAll("_", " ")}</small>
            </>
          ) : <p className="mission-empty">Select a timeline event to inspect its evidence.</p>}
        </aside>
      </section>

      <details className="mission-evidence-drawer">
        <summary><span><span className="eyebrow">Evidence</span><strong>Progress, changes, and project health</strong></span><span>Expand</span></summary>
        <div className="mission-evidence-grid">
          <section><h3>Progress</h3><EvidenceList items={progress} empty="No progress evidence has been recorded." /></section>
          <section><h3>Changes</h3><EvidenceList items={changes} empty="No changed files or commands have been recorded." /><button className="mission-link" type="button" onClick={onOpenRepository}>Repository details →</button></section>
          <section><h3>Why this work</h3><p>{whyThisMatters}</p>{whyDetails.length ? <EvidenceList items={whyDetails} empty="" /> : null}</section>
          <section><h3>Health</h3><div className="mission-health">{health.map((item) => <StatusPill key={item.label} label={item.label} tone={item.tone} />)}</div><button className="mission-link" type="button" onClick={onOpenSettings}>Settings →</button></section>
        </div>
      </details>
    </section>
  );
};
