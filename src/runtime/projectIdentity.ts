import path from "node:path";
import { PROJECT_FINGERPRINT_VERSION } from "@shared/constants";
import type { ProjectIdentity, ProjectKind } from "@shared/types";
import { stableStringify } from "@shared/utils";
import { sha256 } from "./hashUtils";

export interface ProjectIdentityInput {
  kind: ProjectKind;
  projectRoot: string;
  projectName: string;
  repositoryName?: string;
  gitRoot?: string;
  normalizedRemotes?: string[];
  rootCommit?: string;
  selectedSubpath?: string;
  manifestSignature: string;
  treeSignature: string;
}

export const createProjectIdentity = (input: ProjectIdentityInput): ProjectIdentity => {
  const normalizedRemotes = [...(input.normalizedRemotes ?? [])].sort();
  const selectedSubpath = input.selectedSubpath
    ? input.selectedSubpath.split(path.sep).join("/")
    : undefined;
  const repositoryName = input.repositoryName ?? input.projectName;
  const stableIdentity =
    input.kind === "git"
      ? {
          version: PROJECT_FINGERPRINT_VERSION,
          kind: input.kind,
          repositoryName,
          normalizedRemotes,
          rootCommit: input.rootCommit ?? null,
          selectedSubpath: selectedSubpath ?? "",
          fallbackGitRootName:
            normalizedRemotes.length === 0 && !input.rootCommit ? path.basename(input.gitRoot ?? input.projectRoot) : null
        }
      : {
          version: PROJECT_FINGERPRINT_VERSION,
          kind: input.kind,
          repositoryName,
          selectedSubpath: selectedSubpath ?? "",
          manifestSignature: input.manifestSignature,
          treeSignature: input.treeSignature
        };

  const fingerprint = sha256(stableStringify(stableIdentity));

  return {
    version: PROJECT_FINGERPRINT_VERSION,
    fingerprint,
    projectName: input.projectName,
    kind: input.kind,
    repositoryName,
    gitRoot: input.gitRoot,
    selectedSubpath,
    normalizedRemotes,
    rootCommit: input.rootCommit,
    manifestSignature: input.manifestSignature,
    treeSignature: input.treeSignature
  };
};
