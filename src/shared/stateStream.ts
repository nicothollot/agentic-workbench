import { z } from "zod";
import {
  agentStateSchema,
  dependencyRecordSchema,
  fileSummarySchema,
  interfaceCreationStateSchema,
  localProjectRecordSchema,
  projectCredentialsStateSchema,
  projectOverviewSchema,
  projectStatsSchema,
  projectWorkflowStateSchema,
  repoTreeNodeSchema,
  userInputRequestSchema,
  validationStatusSchema
} from "./schemas";
import { projectSnapshotSchema, rendererStateSchema } from "./ipc";
import type {
  AgentState,
  InterfaceCreationState,
  LoadedProjectView,
  LocalProjectRecord,
  ProjectCredentialsState,
  ProjectOverview,
  ProjectStats,
  ProjectWorkflowState,
  RepoTreeNode,
  UserInputRequestRecord,
  ValidationStatus,
  WorkbenchState
} from "./types";

export const RENDERER_STATE_PROTOCOL_VERSION = 2 as const;
export const RENDERER_DELTA_TYPICAL_BYTES = 64 * 1024;
export const RENDERER_DELTA_HARD_BYTES = 256 * 1024;

type ProjectRecordCore = Omit<
  LocalProjectRecord,
  | "workflow"
  | "interfaceCreation"
  | "overview"
  | "stats"
  | "dependencies"
  | "summaryCache"
  | "agents"
  | "userInputRequests"
  | "credentials"
>;

export type WorkbenchShellProjection = Omit<WorkbenchState, "projects" | "activeProjectId">;

export type RendererDeltaOperation =
  | { type: "shell.replace"; value: WorkbenchShellProjection }
  | { type: "active-project.set"; projectId?: string }
  | { type: "projects.order"; projectIds: string[] }
  | { type: "project.insert"; project: LoadedProjectView }
  | { type: "project.remove"; projectId: string }
  | { type: "project.view.replace"; projectId: string; validationStatus: ValidationStatus; candidates: LoadedProjectView["candidates"] }
  | { type: "project.tree.replace"; projectId: string; tree: RepoTreeNode[] }
  | { type: "project.core.replace"; projectId: string; value: ProjectRecordCore }
  | { type: "project.workflow.replace"; projectId: string; value: ProjectWorkflowState }
  | { type: "project.agents.reconcile"; projectId: string; upserts: AgentState[]; removedIds: string[]; order: string[] }
  | { type: "project.credentials.replace"; projectId: string; value: ProjectCredentialsState }
  | { type: "project.user-input.replace"; projectId: string; value: UserInputRequestRecord[] }
  | { type: "project.overview.replace"; projectId: string; value?: ProjectOverview }
  | { type: "project.stats.replace"; projectId: string; value?: ProjectStats }
  | { type: "project.dependencies.replace"; projectId: string; value: LocalProjectRecord["dependencies"] }
  | { type: "project.summary-cache.replace"; projectId: string; value: LocalProjectRecord["summaryCache"] }
  | { type: "project.interface-creation.replace"; projectId: string; value?: InterfaceCreationState };

export interface RendererSnapshotEnvelope {
  protocolVersion: typeof RENDERER_STATE_PROTOCOL_VERSION;
  streamId: string;
  revision: number;
  data: WorkbenchState;
}

export interface RendererDeltaEnvelope {
  protocolVersion: typeof RENDERER_STATE_PROTOCOL_VERSION;
  streamId: string;
  baseRevision: number;
  revision: number;
  operations: RendererDeltaOperation[];
}

const projectRecordCoreSchema = localProjectRecordSchema.omit({
  workflow: true,
  interfaceCreation: true,
  overview: true,
  stats: true,
  dependencies: true,
  summaryCache: true,
  agents: true,
  userInputRequests: true,
  credentials: true
});

const shellProjectionSchema = rendererStateSchema.omit({
  projects: true,
  activeProjectId: true
});

const rendererDeltaOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("shell.replace"), value: shellProjectionSchema }),
  z.object({ type: z.literal("active-project.set"), projectId: z.string().min(1).optional() }),
  z.object({ type: z.literal("projects.order"), projectIds: z.array(z.string().min(1)) }),
  z.object({ type: z.literal("project.insert"), project: projectSnapshotSchema }),
  z.object({ type: z.literal("project.remove"), projectId: z.string().min(1) }),
  z.object({
    type: z.literal("project.view.replace"),
    projectId: z.string().min(1),
    validationStatus: validationStatusSchema,
    // Candidate payloads are already validated as part of project snapshots.
    candidates: projectSnapshotSchema.shape.candidates
  }),
  z.object({ type: z.literal("project.tree.replace"), projectId: z.string().min(1), tree: z.array(repoTreeNodeSchema) }),
  z.object({ type: z.literal("project.core.replace"), projectId: z.string().min(1), value: projectRecordCoreSchema }),
  z.object({ type: z.literal("project.workflow.replace"), projectId: z.string().min(1), value: projectWorkflowStateSchema }),
  z.object({
    type: z.literal("project.agents.reconcile"),
    projectId: z.string().min(1),
    upserts: z.array(agentStateSchema),
    removedIds: z.array(z.string().min(1)),
    order: z.array(z.string().min(1))
  }),
  z.object({ type: z.literal("project.credentials.replace"), projectId: z.string().min(1), value: projectCredentialsStateSchema }),
  z.object({ type: z.literal("project.user-input.replace"), projectId: z.string().min(1), value: z.array(userInputRequestSchema) }),
  z.object({ type: z.literal("project.overview.replace"), projectId: z.string().min(1), value: projectOverviewSchema.optional() }),
  z.object({ type: z.literal("project.stats.replace"), projectId: z.string().min(1), value: projectStatsSchema.optional() }),
  z.object({ type: z.literal("project.dependencies.replace"), projectId: z.string().min(1), value: z.array(dependencyRecordSchema) }),
  z.object({ type: z.literal("project.summary-cache.replace"), projectId: z.string().min(1), value: z.array(fileSummarySchema) }),
  z.object({ type: z.literal("project.interface-creation.replace"), projectId: z.string().min(1), value: interfaceCreationStateSchema.optional() })
]);

export const rendererSnapshotEnvelopeSchema = z.object({
  protocolVersion: z.literal(RENDERER_STATE_PROTOCOL_VERSION),
  streamId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  data: rendererStateSchema
});

export const rendererDeltaEnvelopeSchema = z.object({
  protocolVersion: z.literal(RENDERER_STATE_PROTOCOL_VERSION),
  streamId: z.string().min(1),
  baseRevision: z.number().int().nonnegative(),
  revision: z.number().int().positive(),
  operations: z.array(rendererDeltaOperationSchema).max(10_000)
});

const equal = (left: unknown, right: unknown): boolean => {
  if (left === right) {
    return true;
  }
  return JSON.stringify(left) === JSON.stringify(right);
};

const shellProjection = (state: WorkbenchState): WorkbenchShellProjection => {
  // Runtime parsing deliberately strips project payloads. Zod's inferred
  // output is slightly wider for fields whose source schemas use defaults,
  // while a parsed WorkbenchState always contains those required fields.
  return shellProjectionSchema.parse(state) as WorkbenchShellProjection;
};

const projectRecordCore = (record: LocalProjectRecord): ProjectRecordCore => {
  return projectRecordCoreSchema.parse(record) as ProjectRecordCore;
};

const changedAgents = (
  previous: AgentState[],
  next: AgentState[]
): Pick<Extract<RendererDeltaOperation, { type: "project.agents.reconcile" }>, "upserts" | "removedIds" | "order"> | undefined => {
  const previousById = new Map(previous.map((agent) => [agent.id, agent]));
  const nextById = new Map(next.map((agent) => [agent.id, agent]));
  const upserts = next.filter((agent) => !equal(previousById.get(agent.id), agent));
  const removedIds = previous.filter((agent) => !nextById.has(agent.id)).map((agent) => agent.id);
  const order = next.map((agent) => agent.id);
  if (upserts.length === 0 && removedIds.length === 0 && equal(previous.map((agent) => agent.id), order)) {
    return undefined;
  }
  return { upserts, removedIds, order };
};

export const diffWorkbenchState = (previous: WorkbenchState, next: WorkbenchState): RendererDeltaOperation[] => {
  const operations: RendererDeltaOperation[] = [];
  const previousShell = shellProjection(previous);
  const nextShell = shellProjection(next);
  if (!equal(previousShell, nextShell)) {
    operations.push({ type: "shell.replace", value: nextShell });
  }

  if (previous.activeProjectId !== next.activeProjectId) {
    operations.push({ type: "active-project.set", projectId: next.activeProjectId });
  }

  const previousById = new Map(previous.projects.map((project) => [project.record.id, project]));
  const nextById = new Map(next.projects.map((project) => [project.record.id, project]));

  for (const projectId of previousById.keys()) {
    if (!nextById.has(projectId)) {
      operations.push({ type: "project.remove", projectId });
    }
  }

  for (const project of next.projects) {
    const projectId = project.record.id;
    const before = previousById.get(projectId);
    if (!before) {
      operations.push({ type: "project.insert", project });
      continue;
    }

    if (before.validationStatus !== project.validationStatus || !equal(before.candidates, project.candidates)) {
      operations.push({
        type: "project.view.replace",
        projectId,
        validationStatus: project.validationStatus,
        candidates: project.candidates
      });
    }
    if (!equal(before.tree, project.tree)) {
      operations.push({ type: "project.tree.replace", projectId, tree: project.tree });
    }
    const beforeCore = projectRecordCore(before.record);
    const nextCore = projectRecordCore(project.record);
    if (!equal(beforeCore, nextCore)) {
      operations.push({ type: "project.core.replace", projectId, value: nextCore });
    }
    if (!equal(before.record.workflow, project.record.workflow)) {
      operations.push({ type: "project.workflow.replace", projectId, value: project.record.workflow });
    }
    const agentChanges = changedAgents(before.record.agents, project.record.agents);
    if (agentChanges) {
      operations.push({ type: "project.agents.reconcile", projectId, ...agentChanges });
    }
    if (!equal(before.record.credentials, project.record.credentials)) {
      operations.push({ type: "project.credentials.replace", projectId, value: project.record.credentials });
    }
    if (!equal(before.record.userInputRequests, project.record.userInputRequests)) {
      operations.push({ type: "project.user-input.replace", projectId, value: project.record.userInputRequests });
    }
    if (!equal(before.record.overview, project.record.overview)) {
      operations.push({ type: "project.overview.replace", projectId, value: project.record.overview });
    }
    if (!equal(before.record.stats, project.record.stats)) {
      operations.push({ type: "project.stats.replace", projectId, value: project.record.stats });
    }
    if (!equal(before.record.dependencies, project.record.dependencies)) {
      operations.push({ type: "project.dependencies.replace", projectId, value: project.record.dependencies });
    }
    if (!equal(before.record.summaryCache, project.record.summaryCache)) {
      operations.push({ type: "project.summary-cache.replace", projectId, value: project.record.summaryCache });
    }
    if (!equal(before.record.interfaceCreation, project.record.interfaceCreation)) {
      operations.push({ type: "project.interface-creation.replace", projectId, value: project.record.interfaceCreation });
    }
  }

  const previousOrder = previous.projects.map((project) => project.record.id);
  const nextOrder = next.projects.map((project) => project.record.id);
  if (!equal(previousOrder, nextOrder)) {
    operations.push({ type: "projects.order", projectIds: nextOrder });
  }
  return operations;
};

const replaceProject = (
  state: WorkbenchState,
  projectId: string,
  updater: (project: LoadedProjectView) => LoadedProjectView
): WorkbenchState => ({
  ...state,
  projects: state.projects.map((project) => project.record.id === projectId ? updater(project) : project)
});

export const applyWorkbenchDelta = (state: WorkbenchState, envelope: RendererDeltaEnvelope): WorkbenchState => {
  let next = state;
  for (const operation of envelope.operations) {
    switch (operation.type) {
      case "shell.replace":
        next = { ...operation.value, projects: next.projects, activeProjectId: next.activeProjectId };
        break;
      case "active-project.set":
        next = { ...next, activeProjectId: operation.projectId };
        break;
      case "projects.order": {
        const byId = new Map(next.projects.map((project) => [project.record.id, project]));
        next = { ...next, projects: operation.projectIds.flatMap((id) => byId.get(id) ? [byId.get(id)!] : []) };
        break;
      }
      case "project.insert":
        next = {
          ...next,
          projects: [...next.projects.filter((project) => project.record.id !== operation.project.record.id), operation.project]
        };
        break;
      case "project.remove":
        next = { ...next, projects: next.projects.filter((project) => project.record.id !== operation.projectId) };
        break;
      case "project.view.replace":
        next = replaceProject(next, operation.projectId, (project) => ({
          ...project,
          validationStatus: operation.validationStatus,
          candidates: operation.candidates
        }));
        break;
      case "project.tree.replace":
        next = replaceProject(next, operation.projectId, (project) => ({ ...project, tree: operation.tree }));
        break;
      case "project.core.replace":
        next = replaceProject(next, operation.projectId, (project) => ({
          ...project,
          record: { ...project.record, ...operation.value }
        }));
        break;
      case "project.workflow.replace":
        next = replaceProject(next, operation.projectId, (project) => ({
          ...project,
          record: { ...project.record, workflow: operation.value }
        }));
        break;
      case "project.agents.reconcile":
        next = replaceProject(next, operation.projectId, (project) => {
          const agentsById = new Map(project.record.agents.map((agent) => [agent.id, agent]));
          for (const removedId of operation.removedIds) {
            agentsById.delete(removedId);
          }
          for (const agent of operation.upserts) {
            agentsById.set(agent.id, agent);
          }
          return {
            ...project,
            record: {
              ...project.record,
              agents: operation.order.flatMap((id) => agentsById.get(id) ? [agentsById.get(id)!] : [])
            }
          };
        });
        break;
      case "project.credentials.replace":
        next = replaceProject(next, operation.projectId, (project) => ({
          ...project,
          record: { ...project.record, credentials: operation.value }
        }));
        break;
      case "project.user-input.replace":
        next = replaceProject(next, operation.projectId, (project) => ({
          ...project,
          record: { ...project.record, userInputRequests: operation.value }
        }));
        break;
      case "project.overview.replace":
        next = replaceProject(next, operation.projectId, (project) => ({
          ...project,
          record: { ...project.record, overview: operation.value }
        }));
        break;
      case "project.stats.replace":
        next = replaceProject(next, operation.projectId, (project) => ({
          ...project,
          record: { ...project.record, stats: operation.value }
        }));
        break;
      case "project.dependencies.replace":
        next = replaceProject(next, operation.projectId, (project) => ({
          ...project,
          record: { ...project.record, dependencies: operation.value }
        }));
        break;
      case "project.summary-cache.replace":
        next = replaceProject(next, operation.projectId, (project) => ({
          ...project,
          record: { ...project.record, summaryCache: operation.value }
        }));
        break;
      case "project.interface-creation.replace":
        next = replaceProject(next, operation.projectId, (project) => ({
          ...project,
          record: { ...project.record, interfaceCreation: operation.value }
        }));
        break;
    }
  }
  return next;
};

export const validateRendererState = (state: unknown): WorkbenchState =>
  rendererStateSchema.parse(state) as WorkbenchState;

export const validateRendererSnapshotEnvelope = (value: unknown): RendererSnapshotEnvelope =>
  rendererSnapshotEnvelopeSchema.parse(value) as RendererSnapshotEnvelope;

export const validateRendererDeltaEnvelope = (value: unknown): RendererDeltaEnvelope =>
  rendererDeltaEnvelopeSchema.parse(value) as RendererDeltaEnvelope;

export const rendererEnvelopeBytes = (value: RendererSnapshotEnvelope | RendererDeltaEnvelope): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;
