export interface ProjectDraftEntry<T> {
  draft: T;
  dirty: boolean;
  sourceKey: string;
}

export type ProjectDraftMap<T> = Record<string, ProjectDraftEntry<T>>;

export const resolveProjectDraft = <T>(
  drafts: ProjectDraftMap<T>,
  projectId: string,
  sourceDraft: T,
  sourceKey: string
): ProjectDraftEntry<T> => {
  const current = drafts[projectId];
  if (current && (current.dirty || current.sourceKey === sourceKey)) {
    return current;
  }
  return { draft: sourceDraft, dirty: false, sourceKey };
};

export const hydrateProjectDraft = <T>(
  drafts: ProjectDraftMap<T>,
  projectId: string,
  sourceDraft: T,
  sourceKey: string
): ProjectDraftMap<T> => {
  const current = drafts[projectId];
  const resolved = resolveProjectDraft(drafts, projectId, sourceDraft, sourceKey);
  return current === resolved ? drafts : { ...drafts, [projectId]: resolved };
};

export const editProjectDraft = <T>(
  drafts: ProjectDraftMap<T>,
  projectId: string,
  sourceDraft: T,
  sourceKey: string,
  update: (current: T) => T
): ProjectDraftMap<T> => {
  const current = resolveProjectDraft(drafts, projectId, sourceDraft, sourceKey);
  return {
    ...drafts,
    [projectId]: {
      draft: update(current.draft),
      dirty: true,
      sourceKey: current.sourceKey
    }
  };
};

export const markProjectDraftClean = <T>(
  drafts: ProjectDraftMap<T>,
  projectId: string
): ProjectDraftMap<T> => {
  const current = drafts[projectId];
  if (!current || !current.dirty) {
    return drafts;
  }
  return {
    ...drafts,
    [projectId]: { ...current, dirty: false }
  };
};

export const projectScopedText = (
  values: Readonly<Record<string, string>>,
  projectId: string | undefined
): string => projectId ? values[projectId] ?? "" : "";

export const settingsSaveShouldClose = (goalCharterDirty: boolean): boolean => !goalCharterDirty;

export interface ProjectRequestIdentity {
  projectId: string;
  projectEpoch: number;
  requestId: number;
}

export const isCurrentProjectRequest = (
  request: ProjectRequestIdentity,
  currentProjectId: string | undefined,
  currentProjectEpoch: number,
  latestRequestId: number
): boolean =>
  request.projectId === currentProjectId &&
  request.projectEpoch === currentProjectEpoch &&
  request.requestId === latestRequestId;
