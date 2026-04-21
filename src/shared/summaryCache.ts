import type { FileSummary } from "./types";

export class SummaryCache {
  private readonly entries = new Map<string, FileSummary>();

  constructor(initialEntries: FileSummary[] = []) {
    initialEntries.forEach((entry) => {
      this.entries.set(entry.relativePath, entry);
    });
  }

  get(relativePath: string, contentHash: string): FileSummary | undefined {
    const entry = this.entries.get(relativePath);
    if (!entry || entry.contentHash !== contentHash) {
      return undefined;
    }
    return entry;
  }

  upsert(summary: FileSummary): void {
    this.entries.set(summary.relativePath, summary);
  }

  invalidate(relativePath: string): void {
    this.entries.delete(relativePath);
  }

  list(): FileSummary[] {
    return [...this.entries.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }
}
