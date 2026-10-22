/** Largest frame edge streamed, so a 5K full-screen preview can't push multi-MB frames through the container. */
export const MAX_SCREENCAST_EDGE = 2560;
const MIN_VIEWER_WIDTH = 64;

/** A viewer-reported width as a bounded integer, or undefined when it isn't a usable number. */
export function clampViewerWidth(value: unknown): number | undefined {
  const width = Math.round(Number(value));
  if (!Number.isFinite(width) || width <= 0) return undefined;
  return Math.min(Math.max(width, MIN_VIEWER_WIDTH), MAX_SCREENCAST_EDGE);
}

/**
 * Frame limits for a viewer canvas `viewerWidth` device px wide. Chrome only scales frames down,
 * so a page rendered at 1x stays at its own width and a Retina host Chrome can send up to 2x.
 * The page itself is never touched: its pixel ratio must not change with the viewer's size.
 */
export function screencastSize(viewerWidth: number | undefined): { maxWidth: number; maxHeight: number } {
  return viewerWidth
    ? { maxWidth: viewerWidth, maxHeight: MAX_SCREENCAST_EDGE }
    : { maxWidth: 1280, maxHeight: 720 };
}

/**
 * Whether moving the width cap from `oldWidth` to `newWidth` leaves frames unchanged.
 * A frame narrower than its cap is the page's raw width, and a cap at or above that can't change it.
 */
export function sameFrameWidth(oldWidth: number, newWidth: number, frameWidth: number | undefined): boolean {
  return frameWidth !== undefined && frameWidth < oldWidth && frameWidth <= newWidth;
}

/** Pixel width from a JPEG's start-of-frame header, or undefined if none is found. */
export function jpegWidth(jpeg: Buffer): number | undefined {
  let offset = 2;
  while (offset + 9 <= jpeg.length) {
    if (jpeg[offset] !== 0xff) return undefined;
    const marker = jpeg[offset + 1];
    // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC), which share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return jpeg.readUInt16BE(offset + 7);
    }
    offset += 2 + jpeg.readUInt16BE(offset + 2);
  }
  return undefined;
}
