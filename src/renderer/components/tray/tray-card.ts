/**
 * The drawer is one white card, 8px in from its column's sides and bottom, with a very faint edge and a very soft
 * shadow. Above it the tabs stand on the page, Chrome-style (DrawerTabStrip's `floating`), and the front tab joins
 * it. A body draws no card of its own: it fills TRAY_BODY_CLASS.
 */
export const TRAY_PANEL_CLASS =
  'relative flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden rounded-card border border-black/5 bg-background dark:border-white/5 ' +
  // A very soft lift off the page: tight, so the drawer's 8px gutter holds it before its edge would clip it.
  'shadow-[0_1px_2px_rgba(15,23,42,0.04),0_2px_6px_-1px_rgba(15,23,42,0.04)] dark:shadow-[0_1px_2px_rgba(0,0,0,0.2)]'

export const TRAY_BODY_CLASS = 'flex flex-1 min-h-0 flex-col'
