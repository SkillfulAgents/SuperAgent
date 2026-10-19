/**
 * Frame limits for a viewer canvas `viewerWidth` device px wide. Chrome only scales frames down,
 * so a page rendered at 1x stays at its own width and a Retina host Chrome can send up to 2x.
 * The page itself is never touched: its pixel ratio must not change with the viewer's size.
 */
export function screencastSize(viewerWidth: number | undefined): { maxWidth: number; maxHeight?: number } {
  return viewerWidth ? { maxWidth: viewerWidth } : { maxWidth: 1280, maxHeight: 720 };
}
