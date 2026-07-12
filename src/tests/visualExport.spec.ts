import { describe, expect, it } from "vitest";
import { buildVisualExportCaptureTargets, getVisualExportScrollMetrics } from "@renderer/visualExport";

describe("visual export capture planning", () => {
  it("measures the nested workspace scroll port instead of the document", () => {
    const scrollContainer = document.createElement("div");
    Object.defineProperties(scrollContainer, {
      clientHeight: { value: 600 },
      scrollHeight: { value: 1_850 }
    });

    expect(getVisualExportScrollMetrics(scrollContainer, { width: 1_440, height: 900 })).toEqual({
      totalHeight: 1_850,
      maxScrollY: 1_250,
      scrollViewportHeight: 600,
      captureViewportWidth: 1_440,
      captureViewportHeight: 900
    });
  });

  it("captures the top, intermediate screens, and exact bottom of a tall tab", () => {
    const targets = buildVisualExportCaptureTargets(
      { id: "settings", label: "Settings" },
      {
        totalHeight: 1_850,
        maxScrollY: 1_250,
        scrollViewportHeight: 600,
        captureViewportWidth: 1_440,
        captureViewportHeight: 900
      }
    );

    expect(targets.map((target) => target.scrollY)).toEqual([0, 600, 1_200, 1_250]);
    expect(targets.every((target) => target.pageCount === 4)).toBe(true);
    expect(targets.every((target) => target.sliceHeight === 900 && target.cropTop === 0)).toBe(true);
  });

  it("creates one full-window capture for a short tab", () => {
    expect(buildVisualExportCaptureTargets(
      { id: "overview", label: "Overview" },
      {
        totalHeight: 600,
        maxScrollY: 0,
        scrollViewportHeight: 600,
        captureViewportWidth: 1_280,
        captureViewportHeight: 800
      }
    )).toEqual([expect.objectContaining({ pageIndex: 0, pageCount: 1, scrollY: 0, sliceHeight: 800 })]);
  });
});
