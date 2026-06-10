import type { RepositoryChildrenResponse, RepositorySearchResponse, RepositoryTreeEntry } from "@shared/types";

export const REPOSITORY_ROOT_PARENT = "";

export interface RepositoryTreeRow extends RepositoryTreeEntry {
  depth: number;
  expanded: boolean;
  loading: boolean;
}

export type RepositoryChildrenByParent = Record<string, RepositoryChildrenResponse>;

export const buildRepositoryTreeRows = ({
  childrenByParent,
  expandedPaths,
  loadingParents = {},
  searchResults,
  query
}: {
  childrenByParent: RepositoryChildrenByParent;
  expandedPaths: Iterable<string>;
  loadingParents?: Record<string, boolean>;
  searchResults?: RepositorySearchResponse | null;
  query?: string;
}): RepositoryTreeRow[] => {
  const normalizedQuery = query?.trim() ?? "";
  if (normalizedQuery && searchResults) {
    return searchResults.results.map((entry) => ({
      ...entry,
      depth: 0,
      expanded: false,
      loading: false
    }));
  }

  const expanded = new Set(expandedPaths);
  const rows: RepositoryTreeRow[] = [];
  const visitedParents = new Set<string>();

  const pushChildren = (parentPath: string, depth: number): void => {
    if (visitedParents.has(parentPath)) {
      return;
    }
    visitedParents.add(parentPath);
    const page = childrenByParent[parentPath];
    if (!page) {
      return;
    }

    for (const child of page.children) {
      const childExpanded = child.type === "directory" && expanded.has(child.path);
      rows.push({
        ...child,
        depth,
        expanded: childExpanded,
        loading: Boolean(loadingParents[child.path])
      });
      if (childExpanded) {
        pushChildren(child.path, depth + 1);
      }
    }
  };

  pushChildren(REPOSITORY_ROOT_PARENT, 0);
  return rows;
};
