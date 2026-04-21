import type { ProjectIdentity, ValidationSnapshot, ValidationStatus } from "./types";

export const calculateValidationStatus = (
  currentIdentity: ProjectIdentity,
  savedIdentity: ProjectIdentity,
  currentSnapshot: ValidationSnapshot,
  savedSnapshot: ValidationSnapshot
): ValidationStatus => {
  if (currentIdentity.fingerprint !== savedIdentity.fingerprint) {
    return "incompatible";
  }

  if (!savedSnapshot.lastValidatedAt) {
    return "unvalidated";
  }

  const gitMatches =
    !currentSnapshot.gitHead ||
    !savedSnapshot.gitHead ||
    (currentSnapshot.gitHead === savedSnapshot.gitHead && currentSnapshot.branch === savedSnapshot.branch);

  const manifestMatches =
    !currentSnapshot.manifestHash ||
    !savedSnapshot.manifestHash ||
    currentSnapshot.manifestHash === savedSnapshot.manifestHash;

  const treeMatches =
    !currentSnapshot.treeHash ||
    !savedSnapshot.treeHash ||
    currentSnapshot.treeHash === savedSnapshot.treeHash;

  if (gitMatches && manifestMatches && treeMatches) {
    return "exact";
  }

  return "stale";
};
