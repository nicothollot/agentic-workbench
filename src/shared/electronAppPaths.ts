export const getRendererBase = (command: string): string => (command === "serve" ? "/" : "./");

const joinAppPath = (basePath: string, ...segments: string[]): string => {
  const separator = basePath.includes("\\") ? "\\" : "/";
  const trimmedBase = basePath.replace(/[\\/]+$/, "");
  const trimmedSegments = segments.map((segment) => segment.replace(/^[\\/]+|[\\/]+$/g, ""));
  return [trimmedBase, ...trimmedSegments].join(separator);
};

export const getRendererEntryPath = (appPath: string): string => joinAppPath(appPath, "dist", "index.html");

export const getPreloadEntryPath = (appPath: string): string => joinAppPath(appPath, "dist-electron", "preload", "index.cjs");
