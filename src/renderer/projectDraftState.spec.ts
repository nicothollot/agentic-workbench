import { describe, expect, it } from "vitest";
import {
  editProjectDraft,
  hydrateProjectDraft,
  isCurrentProjectRequest,
  markProjectDraftClean,
  projectScopedText,
  resolveProjectDraft,
  settingsSaveShouldClose,
  type ProjectDraftMap
} from "./projectDraftState";

interface Draft {
  summary: string;
}

describe("project draft state", () => {
  it("preserves a dirty draft across live snapshots and isolates it across project switches", () => {
    let drafts: ProjectDraftMap<Draft> = {};
    drafts = hydrateProjectDraft(drafts, "project-a", { summary: "Saved A" }, "a:1");
    drafts = editProjectDraft(drafts, "project-a", { summary: "Saved A" }, "a:1", () => ({ summary: "Unsaved A" }));
    drafts = hydrateProjectDraft(drafts, "project-a", { summary: "Live snapshot A" }, "a:2");
    drafts = hydrateProjectDraft(drafts, "project-b", { summary: "Saved B" }, "b:1");

    expect(resolveProjectDraft(drafts, "project-a", { summary: "Live snapshot A" }, "a:2")).toMatchObject({
      draft: { summary: "Unsaved A" },
      dirty: true
    });
    expect(resolveProjectDraft(drafts, "project-b", { summary: "Saved B" }, "b:1")).toMatchObject({
      draft: { summary: "Saved B" },
      dirty: false
    });
  });

  it("rehydrates clean drafts when the saved source changes", () => {
    let drafts: ProjectDraftMap<Draft> = {};
    drafts = hydrateProjectDraft(drafts, "project-a", { summary: "Saved A" }, "a:1");
    drafts = editProjectDraft(drafts, "project-a", { summary: "Saved A" }, "a:1", () => ({ summary: "Edited A" }));
    drafts = markProjectDraftClean(drafts, "project-a");
    drafts = hydrateProjectDraft(drafts, "project-a", { summary: "Persisted A" }, "a:2");

    expect(drafts["project-a"]).toEqual({
      draft: { summary: "Persisted A" },
      dirty: false,
      sourceKey: "a:2"
    });
  });

  it("scopes generation prompts and blocks stale async project results", () => {
    const prompts = { "project-a": "Build A", "project-b": "Build B" };
    expect(projectScopedText(prompts, "project-a")).toBe("Build A");
    expect(projectScopedText(prompts, "project-b")).toBe("Build B");
    expect(projectScopedText(prompts, "project-c")).toBe("");

    const request = { projectId: "project-a", projectEpoch: 4, requestId: 9 };
    expect(isCurrentProjectRequest(request, "project-a", 4, 9)).toBe(true);
    expect(isCurrentProjectRequest(request, "project-b", 5, 9)).toBe(false);
    expect(isCurrentProjectRequest(request, "project-a", 6, 9)).toBe(false);
    expect(isCurrentProjectRequest(request, "project-a", 4, 10)).toBe(false);
  });

  it("keeps Settings open while project charter edits are unsaved", () => {
    expect(settingsSaveShouldClose(false)).toBe(true);
    expect(settingsSaveShouldClose(true)).toBe(false);
  });
});
