export const nowIso = (): string => new Date().toISOString();

export const unixSecondsNow = (): number => Math.floor(Date.now() / 1000);

export const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(",")}}`;
};

export const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

export const toPosixRelativePath = (value: string): string => value.replace(/\\/g, "/");

export const unique = <T>(values: Iterable<T>): T[] => [...new Set(values)];

export const safeJsonParse = <T>(value: string): T | null => {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
};

export const coalesce = <T>(...values: Array<T | null | undefined>): T | undefined =>
  values.find((value) => value !== null && value !== undefined);
