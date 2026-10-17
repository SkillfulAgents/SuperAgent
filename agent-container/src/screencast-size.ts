const MAX_RENDER_SCALE = 2;

/**
 * Pixel ratio to render the page at and the largest frame to stream, for a viewer canvas
 * `viewerWidth` device px wide showing a page `cssWidth`×`cssHeight` CSS px in a Chrome
 * that renders at `nativeScale` by itself.
 */
export function screencastSize(viewerWidth: number | undefined, cssWidth: number, cssHeight: number, nativeScale = 1) {
  // Quarter steps, so resizing a panel re-renders the page only every quarter step.
  const scale = viewerWidth
    ? Math.min(MAX_RENDER_SCALE, Math.max(1, Math.ceil((viewerWidth / cssWidth) * 4) / 4))
    : 1;
  const renderWidth = Math.round(cssWidth * scale);
  return {
    // A host Chrome window on a Retina screen already renders at 2x; never force it lower.
    override: scale > nativeScale ? scale : null,
    maxWidth: viewerWidth ? Math.min(renderWidth, viewerWidth) : renderWidth,
    maxHeight: Math.round(cssHeight * scale),
  };
}

export interface PageMetrics {
  lastDeviceWidth: number;
  lastDeviceHeight: number;
  nativeScale: number;
}

/**
 * What a tab switch keeps from the tab it leaves. Tabs share one window, so its CSS size and
 * Chrome's own ratio size the new tab's first screencast before its first frame or ratio reply.
 */
export function keptAcrossTabSwitch(prev: PageMetrics | null): PageMetrics {
  return {
    lastDeviceWidth: prev?.lastDeviceWidth ?? 0,
    lastDeviceHeight: prev?.lastDeviceHeight ?? 0,
    nativeScale: prev?.nativeScale ?? 1,
  };
}
