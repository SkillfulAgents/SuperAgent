/**
 * What is on screen, from macOS itself: whose UI is at a screen point, the
 * shown windows in stacking order (front first) and the frontmost app.
 *
 * Placing a call that acts at a screen point, or in whatever app has focus,
 * needs to know whose window that is. agent-desktop's `list-windows` answers
 * with every app's windows in no stacking order, and stalls or fails outright
 * while the frontmost app is slow to answer, which left every such call
 * placed nowhere. Asked here instead, in one read:
 *
 * - Accessibility's own hit test (`AXUIElementCopyElementAtPosition`): the
 *   app a click at the point reaches. It sees through click-through overlays
 *   (the Dock's whole-display window, a screenshot or recording overlay, the
 *   agent's cursor), knows a window's resize border, and answers the menu
 *   bar, the Dock and the desktop as what they are. One message to one app,
 *   answered in milliseconds even by an app whose whole tree takes minutes.
 * - The window server's window list, which needs no permission and waits on
 *   no app: the names agent-desktop uses for apps, and a cautious answer for
 *   a point the hit test could not answer (`windowAt`).
 *
 * Read with JavaScript for Automation through `osascript`, which every Mac
 * has: no helper to build or ship. Other platforms have no reader here and
 * keep the window list.
 */
import { execFile } from 'child_process'
import { z } from 'zod'
import type { ScreenPoint } from './commands'

type Area = { x: number; y: number; width: number; height: number }

/** One shown window: who owns it and where it is, in screen points from the main display's top left. */
export interface ScreenWindow {
  pid: number
  /** The owning app's name as the window server reports it, which is the name agent-desktop uses. */
  owner: string
  /** Opacity, 0 to 1. */
  alpha: number
  /** The window level: 0 for an app's ordinary windows, higher for menus, panels and overlays. */
  layer: number
  bounds: Area
}

/** Whose UI accessibility found at one of the points asked about. */
export interface ScreenHit {
  x: number
  y: number
  /** Absent when the hit test could not answer (no Accessibility permission, or the app did not reply). */
  pid?: number
  /** The app's name as macOS shows it, when it is a running app. */
  name?: string
}

export interface ScreenWindows {
  /** The app that has focus, if macOS names one. */
  frontmost?: { pid: number; name: string }
  /** Front to back. */
  windows: ScreenWindow[]
  /** Each display's whole area, and the part apps' windows get: without the menu bar and the Dock. */
  displays: Array<{ frame: Area; usable: Area }>
  /** One per point asked about, in order. */
  hits: ScreenHit[]
}

const areaSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })

const screenWindowsSchema = z.object({
  displays: z.array(z.object({ frame: areaSchema, usable: areaSchema })),
  frontmost: z.object({ pid: z.number(), name: z.string() }).nullable().optional(),
  windows: z.array(z.object({
    pid: z.number(),
    owner: z.string().optional(),
    alpha: z.number().optional(),
    layer: z.number().optional(),
    bounds: z.object({ X: z.number(), Y: z.number(), Width: z.number(), Height: z.number() }),
  })),
  hits: z.array(z.object({
    x: z.number(),
    y: z.number(),
    pid: z.number().nullable().optional(),
    name: z.string().nullable().optional(),
  })).optional(),
})

/**
 * Takes the points as one JSON argument (`[[x, y], ...]`).
 * CGWindowListCopyWindowInfo is documented to return windows front to back.
 */
const SCRIPT = `
ObjC.import('CoreGraphics')
ObjC.import('AppKit')
ObjC.import('ApplicationServices')
ObjC.bindFunction('AXUIElementCreateSystemWide', ['id', []])
ObjC.bindFunction('AXUIElementSetMessagingTimeout', ['int', ['id', 'float']])
ObjC.bindFunction('AXUIElementCopyElementAtPosition', ['int', ['id', 'float', 'float', 'id *']])
ObjC.bindFunction('AXUIElementGetPid', ['int', ['id', 'int *']])
function run(argv) {
  const listed = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID)
  const windows = ObjC.deepUnwrap(ObjC.castRefToObject(listed))
  const front = $.NSWorkspace.sharedWorkspace.frontmostApplication
  // AppKit measures up from the main display's bottom left; windows are measured down from its top left.
  const screens = ObjC.unwrap($.NSScreen.screens)
  const mainHeight = screens.length ? screens[0].frame.size.height : 0
  const area = (r) => ({ x: r.origin.x, y: mainHeight - (r.origin.y + r.size.height), width: r.size.width, height: r.size.height })
  const points = argv.length ? JSON.parse(argv[0]) : []
  const system = points.length ? $.AXUIElementCreateSystemWide() : null
  if (system) $.AXUIElementSetMessagingTimeout(system, 1.0)
  const hits = points.map(([x, y]) => {
    const hit = { x, y, pid: null, name: null }
    try {
      const element = Ref()
      if ($.AXUIElementCopyElementAtPosition(system, x, y, element) !== 0) return hit
      const pid = Ref()
      if ($.AXUIElementGetPid(element[0], pid) !== 0) return hit
      hit.pid = pid[0]
      const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(hit.pid)
      if (!app.isNil() && !app.localizedName.isNil()) hit.name = ObjC.unwrap(app.localizedName)
    } catch (error) {}
    return hit
  })
  return JSON.stringify({
    displays: screens.map((s) => ({ frame: area(s.frame), usable: area(s.visibleFrame) })),
    frontmost: front.isNil() ? null : { pid: front.processIdentifier, name: ObjC.unwrap(front.localizedName) },
    windows: windows.map((w) => ({ pid: w.kCGWindowOwnerPID, owner: w.kCGWindowOwnerName, alpha: w.kCGWindowAlpha, layer: w.kCGWindowLayer, bounds: w.kCGWindowBounds })),
    hits,
  })
}`

/** The hit test waits up to a second on each point's app; the rest answers at once. */
const READ_TIMEOUT_MS = 3_000

/** Read and check the reader's output; undefined for anything it should not have printed. */
export function parseScreenWindows(output: string): ScreenWindows | undefined {
  let json: unknown
  try {
    json = JSON.parse(output)
  } catch {
    return undefined
  }
  const parsed = screenWindowsSchema.safeParse(json)
  if (!parsed.success) return undefined
  return {
    ...(parsed.data.frontmost && { frontmost: parsed.data.frontmost }),
    displays: parsed.data.displays,
    windows: parsed.data.windows.map((window) => ({
      pid: window.pid,
      owner: window.owner ?? '',
      alpha: window.alpha ?? 1,
      layer: window.layer ?? 0,
      bounds: { x: window.bounds.X, y: window.bounds.Y, width: window.bounds.Width, height: window.bounds.Height },
    })),
    hits: (parsed.data.hits ?? []).map((hit) => ({
      x: hit.x,
      y: hit.y,
      ...(typeof hit.pid === 'number' && { pid: hit.pid }),
      ...(hit.name && { name: hit.name }),
    })),
  }
}

/**
 * What is on screen, and whose UI is at each of `points`; null where it
 * cannot be read this way (not macOS, or the read failed).
 */
export async function readScreenWindows(points: readonly ScreenPoint[] = []): Promise<ScreenWindows | null> {
  if (process.platform !== 'darwin') return null
  const asked = JSON.stringify(points.map((point) => [point.x, point.y]))
  const output = await new Promise<string | null>((resolve) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SCRIPT, asked], { timeout: READ_TIMEOUT_MS }, (error, stdout) => {
      resolve(error ? null : stdout)
    })
  })
  return (output !== null && parseScreenWindows(output)) || null
}

/**
 * Owners whose windows are not what a click at a point reaches:
 * - agent-desktop: its cursor overlay, a small click-through window exactly
 *   where the agent last acted, in front of everything.
 * - Dock: it keeps an invisible window over each whole display, in front of
 *   every app's windows.
 * - Window Server: the menu bar's strip.
 * The Dock and the menu bar themselves are told by where they are (inUsableArea).
 */
const PASSED_THROUGH_OWNERS: ReadonlySet<string> = new Set(['agent-desktop', 'Dock', 'Window Server'])

const covers = (area: Area, point: ScreenPoint, margin = 0): boolean =>
  point.x >= area.x - margin && point.x < area.x + area.width + margin
  && point.y >= area.y - margin && point.y < area.y + area.height + margin

/**
 * How far past its frame a window can still take a click: its resize border.
 * Measured at 4 points on every side (accessibility's own hit test, macOS
 * 27); one more is allowed for.
 */
const RESIZE_BORDER = 5

/** Whether a point is where apps' windows are: on a display, and not on its menu bar or Dock. */
function inUsableArea(point: ScreenPoint, displays: ScreenWindows['displays']): boolean {
  const display = displays.find((entry) => covers(entry.frame, point))
  return display !== undefined && covers(display.usable, point)
}

/**
 * The app window on top at a screen point, from the window list alone: the
 * answer for a point accessibility's hit test could not answer. The list
 * cannot say which windows let a click through, so this names an app only
 * where nothing puts it in doubt, and otherwise none (the user is asked):
 * - none on the menu bar or the Dock, off every display, or on the bare desktop;
 * - none when another app's panel, menu or overlay (any window above the
 *   ordinary level) is in front at the point, since it may or may not take
 *   the click;
 * - none just outside the frame of another app's window in front, whose
 *   resize border may take it.
 * Fully transparent windows, windows no app name is known for and
 * PASSED_THROUGH_OWNERS are left out.
 */
export function windowAt(point: ScreenPoint, screen: Pick<ScreenWindows, 'windows' | 'displays'>): ScreenWindow | undefined {
  if (!inUsableArea(point, screen.displays)) return undefined
  const candidates = screen.windows.filter((window) => window.alpha > 0 && window.owner !== '' && !PASSED_THROUGH_OWNERS.has(window.owner))
  const near = candidates.find((window) => covers(window.bounds, point, RESIZE_BORDER))
  const at = candidates.find((window) => window.layer === 0 && covers(window.bounds, point))
  return at && near && at.pid === near.pid ? at : undefined
}

/** A process's app name as agent-desktop spells it: the window server's, when the process has a window on screen. */
function nameOfProcess(pid: number, screen: Pick<ScreenWindows, 'windows'>, otherwise: string | undefined): string | undefined {
  return screen.windows.find((window) => window.pid === pid && window.owner !== '')?.owner ?? otherwise
}

/** The app a point was placed in. */
export interface PlacedApp {
  pid: number
  name: string
}

/**
 * The app a click at a screen point reaches: accessibility's hit test when
 * it answered for this point, else what the window list can safely say
 * (`windowAt`). Undefined when neither can tell.
 */
export function appAtPoint(point: ScreenPoint, screen: ScreenWindows): PlacedApp | undefined {
  const hit = screen.hits.find((entry) => entry.x === point.x && entry.y === point.y)
  if (hit?.pid !== undefined) {
    const name = nameOfProcess(hit.pid, screen, hit.name)
    // A process with no window on screen and no app name (a system agent): not an app to grant.
    return name ? { pid: hit.pid, name } : undefined
  }
  const top = windowAt(point, screen)
  return top && { pid: top.pid, name: top.owner }
}

/** The app that has focus, named as agent-desktop spells it. */
export function frontmostApp(screen: ScreenWindows): PlacedApp | undefined {
  if (!screen.frontmost) return undefined
  return { pid: screen.frontmost.pid, name: nameOfProcess(screen.frontmost.pid, screen, screen.frontmost.name) ?? screen.frontmost.name }
}
