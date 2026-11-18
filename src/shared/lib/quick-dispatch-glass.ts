/**
 * Shared by the main process, which draws Liquid Glass behind the
 * quick-dispatch launcher on macOS 26+ (src/main/quick-dispatch-glass.ts), and
 * the launcher renderer, which shapes its card to match. Dependency-free so the
 * renderer can import it.
 */

/** Corner radius of the glass and of the card drawn on it, in points. */
export const QUICK_DISPATCH_GLASS_RADIUS = 26

/** The launcher URL carries `?material=glass` when the window is drawn with glass. */
export const QUICK_DISPATCH_MATERIAL_PARAM = 'material'
export const QUICK_DISPATCH_GLASS_MATERIAL = 'glass'
