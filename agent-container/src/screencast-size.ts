/** Largest frame edge streamed, so a 5K full-screen preview can't push multi-MB frames through the container. */
const MAX_SCREENCAST_EDGE = 2560;
const MIN_VIEWER_WIDTH = 64;
/**
 * Smaller moves keep the running width. A full-screen card's width follows the frame's aspect ratio, which
 * Chrome's rounding nudges with each frame size, so reacting to every pixel can restart the screencast in a loop.
 */
const VIEWER_WIDTH_MARGIN = 32;

/** A viewer-reported width as a bounded integer, or undefined when it isn't a usable number. */
export function clampViewerWidth(value: unknown): number | undefined {
  const width = Math.round(Number(value));
  if (!Number.isFinite(width) || width <= 0) return undefined;
  return Math.min(Math.max(width, MIN_VIEWER_WIDTH), MAX_SCREENCAST_EDGE);
}

export function viewerWidthMoved(current: number | undefined, next: number): boolean {
  return current === undefined || Math.abs(next - current) >= VIEWER_WIDTH_MARGIN;
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
