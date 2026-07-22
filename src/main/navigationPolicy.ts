export type RendererNavigationDecision = "allow" | "open_external" | "block";

const parseUrl = (value: string): URL | undefined => {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};

const sameRendererDocument = (candidate: URL, allowed: URL): boolean => {
  if (candidate.username || candidate.password) {
    return false;
  }
  if (allowed.protocol === "file:") {
    return candidate.protocol === "file:" &&
      candidate.host === allowed.host &&
      candidate.pathname === allowed.pathname;
  }
  return candidate.protocol === allowed.protocol &&
    candidate.origin === allowed.origin &&
    candidate.pathname === allowed.pathname;
};

/**
 * Renderer windows may reload or update their query/hash on the one document
 * they were created for. Every other main-frame destination is kept out of the
 * privileged Electron renderer; ordinary web links can be opened externally.
 */
export const decideRendererNavigation = (
  targetUrl: string,
  allowedDocumentUrl: string
): RendererNavigationDecision => {
  const target = parseUrl(targetUrl);
  const allowed = parseUrl(allowedDocumentUrl);
  if (!target || !allowed) {
    return "block";
  }
  if (sameRendererDocument(target, allowed)) {
    return "allow";
  }
  return target.protocol === "https:" || target.protocol === "http:"
    ? "open_external"
    : "block";
};
