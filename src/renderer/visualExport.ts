import type { VisualExportCaptureTarget, VisualExportTab } from "@shared/types";

export interface VisualExportScrollMetrics {
  totalHeight: number;
  maxScrollY: number;
  scrollViewportHeight: number;
  captureViewportWidth: number;
  captureViewportHeight: number;
}

const MAX_VISUAL_EXPORT_PAGES_PER_TAB = 250;

export const getVisualExportScrollMetrics = (
  scrollContainer: HTMLElement,
  captureViewport: { width: number; height: number }
): VisualExportScrollMetrics => {
  const scrollViewportHeight = Math.max(1, Math.ceil(scrollContainer.clientHeight));
  const totalHeight = Math.max(scrollViewportHeight, Math.ceil(scrollContainer.scrollHeight));

  return {
    totalHeight,
    maxScrollY: Math.max(0, totalHeight - scrollViewportHeight),
    scrollViewportHeight,
    captureViewportWidth: Math.max(1, Math.ceil(captureViewport.width)),
    captureViewportHeight: Math.max(1, Math.ceil(captureViewport.height))
  };
};

export const buildVisualExportCaptureTargets = (
  tab: VisualExportTab,
  metrics: VisualExportScrollMetrics
): VisualExportCaptureTarget[] => {
  const positions = [0];
  for (
    let scrollY = metrics.scrollViewportHeight;
    scrollY < metrics.maxScrollY && positions.length < MAX_VISUAL_EXPORT_PAGES_PER_TAB - 1;
    scrollY += metrics.scrollViewportHeight
  ) {
    positions.push(scrollY);
  }
  if (metrics.maxScrollY > 0 && positions.at(-1) !== metrics.maxScrollY) {
    positions.push(metrics.maxScrollY);
  }

  const pageCount = positions.length;
  return positions.map((scrollY, pageIndex) => ({
    tab,
    pageIndex,
    pageCount,
    scrollY,
    cropTop: 0,
    sliceHeight: metrics.captureViewportHeight,
    viewportWidth: metrics.captureViewportWidth,
    viewportHeight: metrics.captureViewportHeight
  }));
};
