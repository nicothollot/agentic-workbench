import { describe, expect, it } from "vitest";
import { decideRendererNavigation } from "@main/navigationPolicy";

describe("renderer navigation policy", () => {
  it("allows only the configured renderer document in production", () => {
    const allowed = "file:///C:/Program%20Files/Agentic%20Workbench/resources/app.asar/dist/index.html";

    expect(decideRendererNavigation(allowed, allowed)).toBe("allow");
    expect(decideRendererNavigation(`${allowed}?view=repositoryPathChat#answer`, allowed)).toBe("allow");
    expect(decideRendererNavigation("file:///C:/Windows/System32/drivers/etc/hosts", allowed)).toBe("block");
    expect(decideRendererNavigation("javascript:alert(1)", allowed)).toBe("block");
  });

  it("keeps dev navigation on the exact configured loopback document", () => {
    const allowed = "http://127.0.0.1:5173/";

    expect(decideRendererNavigation("http://127.0.0.1:5173/?view=repository#src", allowed)).toBe("allow");
    expect(decideRendererNavigation("http://127.0.0.1:5173/another-page", allowed)).toBe("open_external");
    expect(decideRendererNavigation("http://localhost:5173/", allowed)).toBe("open_external");
  });

  it("routes ordinary web destinations outside the privileged renderer", () => {
    const allowed = "file:///opt/workbench/dist/index.html";

    expect(decideRendererNavigation("https://example.com/docs", allowed)).toBe("open_external");
    expect(decideRendererNavigation("http://example.com/docs", allowed)).toBe("open_external");
    expect(decideRendererNavigation("mailto:operator@example.com", allowed)).toBe("block");
    expect(decideRendererNavigation("not a url", allowed)).toBe("block");
  });
});
