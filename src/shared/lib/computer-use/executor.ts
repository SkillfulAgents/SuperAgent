/**
 * Computer Use Executor
 *
 * Runs agents' agent-desktop commands on this machine, as given, and hands
 * back what agent-desktop printed. Reached through the host port (see
 * host/local-host-port.ts). Around each command it does only what the app
 * owns:
 * - the session: each app session gets its own agent-desktop session, started
 *   on its first command, and agent-desktop resolves a ref only inside the
 *   session whose snapshot made it, so one session never acts on another's
 *   refs. The session carries the agent's cursor, in its colour and with its
 *   name, when the user shows cursors; the cursor is kept on screen from the
 *   session's first command of a turn until the turn ends (see
 *   cursor-keep-alive.ts).
 * - the target, for the per-app permission check: the executor remembers
 *   which app each snapshot and window belongs to, so a ref-only call
 *   (`click @s8f3k2p9:e5`) can be checked and shown in the activity indicator.
 * - physical input: `--headed` runs only when the user's settings allow it.
 * - time: a command that outlives its own budget is stopped.
 * - screenshots: the image comes back to the agent as an image (see
 *   screenshotOutput).
 */

import { getSettings } from '@shared/lib/config/settings'
import {
  buildCommandArgs,
  callTargets,
  ComputerUseArgumentError,
  OBSERVATION_COMMANDS,
  requestsHeaded,
  SYSTEM_TARGETS,
  type CallTargets,
  type ScreenPoint,
} from './commands'
import { commandLineOf } from './command-line'
import {
  AgentDesktopAbortedError,
  AgentDesktopTimeoutError,
  agentDesktopHome,
  commandTimeoutMs,
  displayListSchema,
  cursorOverlayDataSchema,
  launchDataSchema,
  permissionsDataSchema,
  runAgentDesktop,
  runAgentDesktopOrThrow,
  runAgentDesktopOutput,
  screenshotDataSchema,
  sessionStartDataSchema,
  snapshotDataSchema,
  windowListSchema,
  type AgentDesktopEnvelope,
} from './agent-desktop'
import { prepareScreenshot, type ScreenshotTarget } from './screenshot-frame'
import { computerUsePreferences } from './types'
import { CURSOR_IMAGE_SCALE, cursorImageFile, hasCursorImageRenderer } from './cursor-image'
import { cursorCommandDone, keepCursorOnScreen, letCursorRest } from './cursor-keep-alive'
import { sameApp } from './app-identity'
import { appAtPoint, frontmostApp, readScreenWindows, type ScreenWindows } from './screen-windows'
import { activateStartMenuApp, findStartMenuApp, startMenuApps, waitForActivatedWindow } from './windows-start-menu'
import { prepareWindowsHitTest, stopWindowsHitTest, windowsAtPoints, type WindowHit } from './windows-hit-test'
import { background } from '@shared/lib/background'
import type { AgentAvatar } from '@shared/lib/types/agent-avatar'
import * as path from 'path'

/** Who is running a command: the app session, and how its agent's cursor looks. */
export interface ComputerUseCaller {
  sessionId: string
  agentSlug: string
  /** The cursor's label: the agent's name. */
  label: string
  /** The cursor's colour, as a hex value: the agent's avatar colour. */
  accent?: string
  /** The agent's orb, drawn beside its name under the cursor. */
  avatar?: AgentAvatar | null
}

export interface ComputerUseResult {
  /** What the agent reads. */
  output: string
  /** The app the command acted in, when it is known. */
  app?: string
  /**
   * agent-desktop refused it for want of an OS permission, before it acted.
   * Not the agent's to handle: the app asks the user for the permission.
   */
  permissionDenied?: true
}

/** The cursor label's word limit, the CLI's own default made explicit. */
export const CURSOR_LABEL_MAX_WORDS = 6

/** An agent's name as its cursor label: the first six words. */
export function cursorLabel(name: string): string {
  return name.trim().split(/\s+/).slice(0, CURSOR_LABEL_MAX_WORDS).join(' ')
}

interface AppSession {
  agentDesktopSession: string
  agentSlug: string
  /** The cursor the session was last given, to tell when the settings or the agent changed. */
  cursor: string | null
}

const sessions = new Map<string, Promise<AppSession>>()

/** Snapshot id → app, and window id → app, as commands report them. Bounded; oldest first out. */
const MAX_REMEMBERED = 5000
const snapshotApps = new Map<string, string>()
const windowApps = new Map<string, string>()

function remember<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key)
  map.set(key, value)
  if (map.size > MAX_REMEMBERED) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
}

function cursorKey(caller: ComputerUseCaller, showCursor: boolean): string | null {
  return showCursor
    ? JSON.stringify({ label: cursorLabel(caller.label), accent: caller.accent ?? null, avatar: caller.avatar ?? null })
    : null
}

/**
 * The agent's own cursor image (arrow, orb and name chip), drawn on macOS and
 * Windows where this process can render one; null to use agent-desktop's arrow.
 *
 * On Windows the image is also what keeps agent-desktop from greeting: its
 * renderer (1.1.0) shows "Hey, let's play with this computer!" on `enable`
 * even with a `--label`, and shows nothing of its own only with `--image`.
 */
async function cursorImage(caller: ComputerUseCaller): Promise<{ path: string; hotspot: { x: number; y: number } } | null> {
  if ((process.platform !== 'darwin' && process.platform !== 'win32') || !hasCursorImageRenderer()) return null
  try {
    return await cursorImageFile(
      { name: cursorLabel(caller.label), avatar: caller.avatar },
      path.join(agentDesktopHome(), 'cursors'),
    )
  } catch (error) {
    console.warn('[ComputerUse] Could not draw the agent cursor image; using the plain cursor:', error)
    return null
  }
}

async function applyCursor(session: string, caller: ComputerUseCaller, showCursor: boolean): Promise<void> {
  if (!showCursor) {
    await runAgentDesktop(['--session', session, 'cursor-overlay', 'disable'])
    return
  }
  const accent = caller.accent ? [`--accent=${caller.accent}`] : []
  const image = await cursorImage(caller)
  if (image) {
    // The image carries the name, so agent-desktop draws no label of its own,
    // and with an image it shows no greeting either. macOS reads the PNG's
    // density and takes its hotspot in points. Windows ignores the density,
    // drawing one PNG pixel per physical pixel and taking the hotspot in PNG
    // pixels, both then scaled by --size: the display's scale over the
    // image's draws it at its size in points, as the system cursor is.
    const placement = process.platform === 'win32'
      ? [
        `--hotspot=${image.hotspot.x * CURSOR_IMAGE_SCALE},${image.hotspot.y * CURSOR_IMAGE_SCALE}`,
        `--size=${windowsCursorSize(await primaryDisplayScale())}`,
      ]
      : [`--hotspot=${image.hotspot.x},${image.hotspot.y}`]
    warnIfNotRendered(await runAgentDesktopOrThrow([
      '--session', session,
      'cursor-overlay', 'enable',
      `--image=${image.path}`,
      ...placement,
      ...accent,
    ]))
    return
  }
  // The accent colours the cursor's body, its ripple and its highlight.
  warnIfNotRendered(await runAgentDesktopOrThrow([
    '--session', session,
    'cursor-overlay', 'enable',
    `--label=${cursorLabel(caller.label)}`,
    `--max-words=${CURSOR_LABEL_MAX_WORDS}`,
    ...accent,
  ]))
}

/**
 * The primary display's scale (Windows' DPI setting: 1.5 at 150%), or 1 when
 * the display list cannot be read. A cursor on a display of another scale is
 * drawn at the primary's size: agent-desktop takes one size for the session.
 */
async function primaryDisplayScale(): Promise<number> {
  try {
    const displays = displayListSchema.safeParse((await runAgentDesktop(['list-displays'], { timeoutMs: WINDOW_LIST_TIMEOUT_MS })).data)
    if (!displays.success) return 1
    const primary = displays.data.find((display) => display.is_primary === true) ?? displays.data[0]
    return primary?.scale && primary.scale > 0 ? primary.scale : 1
  } catch {
    return 1
  }
}

/** The --size that draws the cursor image at its size in points on a Windows display of this scale, within agent-desktop's 0.5 to 4. */
export function windowsCursorSize(displayScale: number): number {
  return Math.min(4, Math.max(0.5, displayScale / CURSOR_IMAGE_SCALE))
}

/** `cursor-overlay enable` succeeds when no renderer came up to draw the cursor too; it says so in `rendered`. */
function warnIfNotRendered(data: unknown): void {
  if (cursorOverlayDataSchema.safeParse(data).data?.rendered === false) {
    console.warn('[ComputerUse] agent-desktop enabled the agent cursor but drew none (rendered: false)')
  }
}

async function startSession(caller: ComputerUseCaller, showCursor: boolean): Promise<AppSession> {
  const data = sessionStartDataSchema.parse(
    await runAgentDesktopOrThrow(['session', 'start', '--no-trace', `--name=${caller.label.slice(0, 128) || caller.agentSlug}`]),
  )
  const session: AppSession = { agentDesktopSession: data.session_id, agentSlug: caller.agentSlug, cursor: null }
  // Started in the seconds before the agent's first click needs it.
  if (process.platform === 'win32') background(prepareWindowsHitTest(), { name: 'computer-use.windows-hit-test' })
  if (showCursor) {
    try {
      await applyCursor(session.agentDesktopSession, caller, true)
      session.cursor = cursorKey(caller, true)
    } catch (error) {
      // A missing cursor is cosmetic; the commands still run.
      console.warn('[ComputerUse] Could not show the agent cursor:', error)
    }
  }
  return session
}

/** The agent-desktop session for an app session, started on first use and kept in step with the cursor settings. */
async function sessionFor(caller: ComputerUseCaller): Promise<AppSession> {
  const { showCursor } = computerUsePreferences((await getSettings()).computerUse)
  let pending = sessions.get(caller.sessionId)
  if (!pending) {
    // A start that failed is forgotten, so the next command tries again.
    pending = startSession(caller, showCursor).catch((error: unknown) => {
      sessions.delete(caller.sessionId)
      throw error
    })
    sessions.set(caller.sessionId, pending)
  }
  const session = await pending
  const wanted = cursorKey(caller, showCursor)
  if (wanted !== session.cursor) {
    try {
      await applyCursor(session.agentDesktopSession, caller, showCursor)
      session.cursor = wanted
    } catch (error) {
      console.warn('[ComputerUse] Could not update the agent cursor:', error)
    }
  }
  return session
}

/**
 * Commands that read the focused app when they name none. Such a call is
 * pinned to the app it was placed in (withFocusedApp), so focus moving
 * afterwards cannot point it elsewhere.
 */
const FOCUSED_APP_COMMANDS: ReadonlySet<string> = new Set(['snapshot', 'find'])

/** The name a window of this app itself is placed under: agents do not act in it. */
const THIS_APP = 'this app'

/**
 * The last read of the screen, kept briefly: a call is placed when its grant
 * is checked and again when it runs, moments apart for one a grant covers,
 * and the second need not ask again. Dropped once any command has run, which
 * may have changed what is on screen; a call the user approves runs long
 * after this has lapsed, so it is placed afresh.
 */
const SCREEN_REUSE_MS = 1_000
let recentScreen: { points: string; at: number; read: Promise<ScreenWindows | null> } | null = null

function screenFor(points: CallTargets['points']): Promise<ScreenWindows | null> {
  const asked = JSON.stringify(points ?? [])
  if (recentScreen && recentScreen.points === asked && Date.now() - recentScreen.at < SCREEN_REUSE_MS) return recentScreen.read
  const read = readScreenWindows(points)
  recentScreen = { points: asked, at: Date.now(), read }
  return read
}

/** What placing a call found: the apps it acts in, and whether some of it could not be placed. */
interface Placement {
  apps: Set<string>
  /** A point not over exactly one app, or a focused app the window list could not tell. */
  unplaced: boolean
}

/**
 * Where a call acts, from what it names and what earlier commands reported:
 * its app, its refs' snapshots, its windows, the window on top at the points
 * it acts at, the focused app for a call that acts in whatever has focus, or
 * a target that is not an app (the clipboard).
 */
async function placeCall(method: string, targets: CallTargets, reread = false): Promise<Placement> {
  const apps = new Set<string>()
  // One entry per app, however each part of the call spells it (sameApp).
  const add = (app: string) => { if (![...apps].some((known) => sameApp(known, app))) apps.add(app) }
  let unplaced = false
  if (targets.app) add(targets.app)
  if (targets.system) add(targets.system)
  for (const id of targets.snapshotIds) {
    const app = snapshotApps.get(id)
    if (app) add(app)
  }
  for (const id of targets.windowIds) {
    const app = windowApps.get(id) ?? (await lookUpWindowApp(id))
    if (app) add(app)
  }
  const hasPoints = (targets.points?.length ?? 0) > 0
  // On macOS the system itself says whose UI is at a point and which app has
  // focus (screen-windows). The window list is read only where that is not
  // available: it has no stacking order, and fails while the frontmost app is
  // slow to answer.
  const screen = hasPoints || targets.focused ? await screenFor(targets.points) : null
  // On Windows, Windows' own hit test says whose window is at each point
  // (windows-hit-test), and the window list names it as agent-desktop does.
  const [windows, hits] = await Promise.all([
    !screen && (hasPoints || targets.focused) ? listWindows() : Promise.resolve([]),
    process.platform === 'win32' && hasPoints ? windowsAtPoints(targets.points ?? []) : Promise.resolve(null),
  ])
  const observes = OBSERVATION_COMMANDS.has(method)
  for (const [index, point] of (targets.points ?? []).entries()) {
    let app: string | undefined
    if (screen) {
      const placed = appAtPoint(point, screen)
      // Where it cannot tell: the whole screen for a command that only looks,
      // nowhere for one that sends input.
      app = placed ? (placed.pid === process.pid ? THIS_APP : placed.name) : (observes ? SYSTEM_TARGETS.screen : undefined)
    } else if (hits) {
      app = appOfWindowHit(hits[index], windows, observes)
    } else {
      app = appAt(point, windows, observes)
    }
    if (app) add(app)
    else unplaced = true
  }
  if (targets.focused) {
    const frontmost = screen && frontmostApp(screen)
    const focused = screen
      ? frontmost && (frontmost.pid === process.pid ? THIS_APP : frontmost.name)
      : (() => { const window = windows.find((entry) => entry.is_focused); return window && ownerOf(window) })()
    if (focused) add(focused)
    else unplaced = true
  }
  if (apps.size > 1 && !reread && targets.windowIds.length > 0) {
    // A remembered window id may since belong to another window: ask again.
    for (const id of targets.windowIds) windowApps.delete(id)
    return placeCall(method, targets, true)
  }
  return { apps, unplaced }
}

/**
 * The app a call targets, for its permission check and the activity
 * indicator; undefined when some of it cannot be placed (the user is then
 * asked about the call itself). Refuses a call that acts in two apps, or in
 * this app's own windows.
 */
async function targetAppOf(method: string, targets: CallTargets): Promise<string | undefined> {
  const { apps, unplaced } = await placeCall(method, targets)
  if (apps.has(THIS_APP)) {
    // Placed by a point it names: the window there is this app's, which naming an app would not change.
    const byPoint = (targets.points?.length ?? 0) > 0 && !targets.app && !targets.focused
    throw new ComputerUseArgumentError(byPoint
      ? `${method} would land on this app's own window, which is at that point on screen; agents do not act in it. Nothing was sent.`
      : `${method} would act in this app's own window, which agents do not use. Nothing was sent. Name the app to act in (app).`)
  }
  if (apps.size > 1) {
    throw new ComputerUseArgumentError(`One call acts in one app; this one names ${[...apps].join(', ')}`)
  }
  return unplaced ? undefined : apps.values().next().value
}

/**
 * The app an approved call still acts in when it runs. A call that names its
 * app (or target) must name the one it was approved for. A call placed by
 * focus or by a point is placed again: approving it in this app's window
 * moves focus here, and another window can come over the point. A snapshot
 * or find is not, being pinned to its app. When the window list cannot tell,
 * the approval stands.
 */
async function confirmPlacement(method: string, targets: CallTargets, approved: string): Promise<string> {
  const named = targets.app ?? targets.system
  if (named !== undefined && !sameApp(named, approved)) {
    throw new ComputerUseArgumentError(`${method} names ${named}, but it was approved for ${approved}. Nothing was sent.`)
  }
  const moves = (targets.points?.length ?? 0) > 0 || (targets.focused && !FOCUSED_APP_COMMANDS.has(method))
  if (!moves) return approved
  const { apps } = await placeCall(method, targets)
  const now = [...apps].filter((app) => !sameApp(app, approved))
  if (now.length === 0) return approved
  const where = now.join(', ')
  throw new ComputerUseArgumentError(targets.focused
    ? `The focused app is now ${where}; this ${method} was approved for ${approved}. Nothing was sent. Pass app "${approved}" to send it there without focusing it, or look at the screen first.`
    : `The window at that point is now ${where}'s; this ${method} was approved for ${approved}. Nothing was sent. Take a new screenshot before acting at a point.`)
}

type WindowEntry = ReturnType<typeof windowListSchema.parse>[number]

/** How long placing a call waits on the window list (it can stall while a modal or panel is up). */
const WINDOW_LIST_TIMEOUT_MS = 2_000

/** A window's app, or THIS_APP for a window of this process (the app's own UI). */
function ownerOf(window: WindowEntry): string {
  return window.pid !== undefined && window.pid === process.pid ? THIS_APP : window.app_name
}

async function listWindows(): Promise<WindowEntry[]> {
  let listed: unknown
  try {
    listed = (await runAgentDesktop(['list-windows'], { timeoutMs: WINDOW_LIST_TIMEOUT_MS })).data
  } catch {
    return []
  }
  const windows = windowListSchema.safeParse(listed)
  if (!windows.success) return []
  for (const window of windows.data) remember(windowApps, window.id, window.app_name)
  return windows.data
}

/**
 * The app whose window is on top at a screen point, from the window list:
 * where the window server cannot be asked (see placeCall).
 *
 * On Windows the list comes front to back (agent-desktop enumerates with
 * EnumWindows, which walks the stacking order), so the first window covering
 * the point is the one on top. A maximized window behind everything (a chat
 * app, a terminal) covers every point, and without the order no point on
 * screen had one app. Elsewhere the list is not in stacking order, so: the
 * focused window when it covers the point (it is in front of every other),
 * else the one app whose shown windows cover it.
 *
 * A point no one app covers is the whole screen for a command that only
 * looks, and placed nowhere for one that sends input: the user is asked
 * about it.
 */
function appAt(point: ScreenPoint, windows: readonly WindowEntry[], observes: boolean): string | undefined {
  const under = windows.filter((window) => !window.minimized && window.visible !== false && window.bounds
    && point.x >= window.bounds.x && point.x < window.bounds.x + window.bounds.width
    && point.y >= window.bounds.y && point.y < window.bounds.y + window.bounds.height)
  if (process.platform === 'win32') {
    const top = under[0]
    return top ? ownerOf(top) : observes ? SYSTEM_TARGETS.screen : undefined
  }
  const focused = under.find((window) => window.is_focused)
  if (focused) return ownerOf(focused)
  const apps = new Set(under.map(ownerOf))
  if (apps.size === 1) return apps.values().next().value
  return observes ? SYSTEM_TARGETS.screen : undefined
}

/**
 * Window classes of the Windows shell itself (the taskbars, the desktop, the
 * tray's overflow, Start and search, the task switcher), whatever process
 * draws them: not an app's window to grant.
 */
const SHELL_WINDOW_CLASSES: ReadonlySet<string> = new Set([
  'Shell_TrayWnd',
  'Shell_SecondaryTrayWnd',
  'Progman',
  'WorkerW',
  'NotifyIconOverflowWindow',
  'TopLevelWindowForOverflowXamlIsland',
  'Windows.UI.Core.CoreWindow',
  'XamlExplorerHostIslandWindow',
])

/**
 * The app a click reaches, from Windows' hit test at the point: the listed
 * window it landed on, named as agent-desktop names it (a Store app by its
 * own name, not its frame host's). A popup or menu of an app, which the list
 * leaves out, is that app's when its process has windows listed under one
 * name, as a click on an app's menu is the app's. Not explorer.exe's: the
 * shell draws its own popups in that process. Anything else (the shell, the
 * bare desktop, a window no app is listed for) is the whole screen for a
 * command that only looks, and nowhere for one that sends input.
 */
function appOfWindowHit(hit: WindowHit, windows: readonly WindowEntry[], observes: boolean): string | undefined {
  const nowhere = observes ? SYSTEM_TARGETS.screen : undefined
  if (!hit.hwnd || SHELL_WINDOW_CLASSES.has(hit.className)) return nowhere
  const listed = windows.find((window) => window.id === `w-${hit.hwnd}`)
  if (listed) return listed.minimized ? nowhere : ownerOf(listed)
  const owners = new Set(windows.filter((window) => window.pid === hit.pid).map(ownerOf))
  const [owner] = owners
  return owners.size === 1 && !sameApp(owner, 'explorer.exe') ? owner : nowhere
}

async function lookUpWindowApp(windowId: string): Promise<string | undefined> {
  await listWindows()
  return windowApps.get(windowId)
}

/** Learn which app the snapshots and windows a result reports belong to. */
function rememberTargets(method: string, envelope: AgentDesktopEnvelope, app: string | undefined): string | undefined {
  if (!envelope.ok) return app
  const data = envelope.data
  if (method === 'list-windows') {
    const windows = windowListSchema.safeParse(data)
    if (windows.success) for (const window of windows.data) remember(windowApps, window.id, window.app_name)
    return app
  }
  if (method === 'launch') {
    const launched = launchDataSchema.safeParse(data)
    const name = (launched.success && launched.data.app) || app
    if (launched.success && launched.data.window && name) remember(windowApps, launched.data.window.id, name)
    return name
  }
  if (method === 'batch') {
    // A batch's entries report snapshots of their own, wherever in its result.
    rememberNestedSnapshots(data, app, 0)
    return app
  }
  // snapshot, find and drill-downs report the snapshot that owns their refs.
  const snapshot = snapshotDataSchema.safeParse(data)
  if (snapshot.success) {
    const name = snapshot.data.app ?? app
    if (name) {
      remember(snapshotApps, snapshot.data.snapshot_id, name)
      if (snapshot.data.window) remember(windowApps, snapshot.data.window.id, name)
    }
    return name
  }
  return app
}

function rememberNestedSnapshots(value: unknown, app: string | undefined, depth: number): void {
  if (!value || typeof value !== 'object' || depth > 6) return
  if (Array.isArray(value)) {
    for (const item of value) rememberNestedSnapshots(item, app, depth + 1)
    return
  }
  const snapshot = snapshotDataSchema.safeParse(value)
  const name = snapshot.success ? snapshot.data.app ?? app : undefined
  if (snapshot.success && name) remember(snapshotApps, snapshot.data.snapshot_id, name)
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'tree') rememberNestedSnapshots(child, app, depth + 1)
  }
}

/** A flag's value in a command line: `--app=x` or `--app x`. */
function flagValue(commandArgs: readonly string[], name: string): string | undefined {
  for (let i = 0; i < commandArgs.length; i++) {
    if (commandArgs[i] === '--') return undefined
    if (commandArgs[i].startsWith(`${name}=`)) return commandArgs[i].slice(name.length + 1)
    if (commandArgs[i] === name) return commandArgs[i + 1]
  }
  return undefined
}

/** The windows a screenshot may show, by what the command named. */
async function screenshotTarget(commandArgs: readonly string[]): Promise<{ target: ScreenshotTarget | null; reason?: string }> {
  const app = flagValue(commandArgs, '--app')
  const windowId = flagValue(commandArgs, '--window-id')
  // A screenshot that names nothing captures the main display, as --screen 0 does.
  const screenArg = flagValue(commandArgs, '--screen') ?? (!app && !windowId ? '0' : undefined)
  if (screenArg !== undefined) {
    const screen = Number(screenArg)
    const displays = displayListSchema.safeParse((await runAgentDesktop(['list-displays'], { timeoutMs: WINDOW_LIST_TIMEOUT_MS })).data)
    const display = displays.success && Number.isInteger(screen) ? displays.data[screen] : undefined
    return display
      ? { target: { kind: 'screen', bounds: display.bounds, label: `display ${screen}` } }
      : { target: null, reason: 'its display was not found in the display list' }
  }
  if (!windowId && !app) return { target: null, reason: 'it names no window' }
  const listed = await runAgentDesktop(['list-windows', ...(app && !windowId ? [`--app=${app}`] : [])], { timeoutMs: WINDOW_LIST_TIMEOUT_MS })
  const windows = windowListSchema.safeParse(listed.data)
  if (!windows.success) return { target: null, reason: 'the window list could not be read' }
  for (const window of windows.data) remember(windowApps, window.id, window.app_name)
  const candidates = windows.data
    .filter((window) => (windowId ? window.id === windowId : !window.minimized))
    .flatMap((window) => (window.bounds ? [{ id: window.id, app: window.app_name, bounds: window.bounds, ...(window.is_focused && { focused: true }) }] : []))
  return { target: { kind: 'window', candidates } }
}

/** A number as the note prints it: at most four decimals. */
function decimal(value: number): string {
  return String(Math.round(value * 10_000) / 10_000)
}

/**
 * A screenshot as the agent gets it: an image the model can take (the
 * window's transparent shadow cropped off, shrunk to the model's limits),
 * and one line saying which screen points it shows, since the image is no
 * longer the size agent-desktop captured. The container turns the JSON into
 * an image block and the line.
 */
async function screenshotOutput(
  envelope: AgentDesktopEnvelope,
  { target, reason }: { target: ScreenshotTarget | null; reason?: string },
): Promise<string | null> {
  if (!envelope.ok) return null
  const shot = screenshotDataSchema.safeParse(envelope.data)
  if (!shot.success) return null
  let prepared: ReturnType<typeof prepareScreenshot>
  try {
    prepared = prepareScreenshot(Buffer.from(shot.data.data, 'base64'), target, reason, shot.data.scale_factor)
  } catch (error) {
    console.warn('[ComputerUse] Could not read a screenshot:', error)
    return null
  }
  const { width, height, frame } = prepared
  let note = `This image is ${width}×${height} pixels.`
  if (frame) {
    const { x, y } = frame.area
    const sx = decimal(frame.area.width / width)
    const sy = decimal(frame.area.height / height)
    note = `This image is ${width}×${height} pixels and shows ${frame.label}, at screen points x ${decimal(x)}–${decimal(x + frame.area.width)}, y ${decimal(y)}–${decimal(y + frame.area.height)}: the pixel (px, py) is the screen point (${decimal(x)} + px × ${sx}, ${decimal(y)} + py × ${sy}).`
  } else if (prepared.unalignedReason) {
    note = `This image is ${width}×${height} pixels; where it is on screen is not known (${prepared.unalignedReason}).`
  }  return JSON.stringify({
    type: 'screenshot',
    base64: prepared.png.toString('base64'),
    media_type: 'image/png',
    width,
    height,
    note,
  })
}

/**
 * A result with the base64 of every screenshot in it replaced by a note, or
 * null when it has none: a screenshot that did not come back as an image
 * (inside a batch, or unreadable) would reach the agent as megabytes of text.
 */
function withoutScreenshotData(envelope: AgentDesktopEnvelope, isScreenshot: boolean): AgentDesktopEnvelope | null {
  let left = 0
  const strip = (value: unknown, inScreenshot: boolean, depth: number): unknown => {
    if (!value || typeof value !== 'object' || depth > 8) return value
    if (Array.isArray(value)) return value.map((item) => strip(item, inScreenshot, depth + 1))
    const record = value as Record<string, unknown>
    const screenshot = inScreenshot || record.command === 'screenshot'
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(record)) {
      if (key === 'data' && screenshot && typeof child === 'string' && child.length > 256) {
        left++
        out[key] = `[image left out: ${child.length} characters of base64. Take the screenshot as its own computer_screenshot call to see it.]`
      } else {
        out[key] = strip(child, screenshot, depth + 1)
      }
    }
    return out
  }
  const stripped = strip(envelope, isScreenshot, 0) as AgentDesktopEnvelope
  return left > 0 ? stripped : null
}

/**
 * Resolve the app a call targets, before it runs, for the permission check.
 * Undefined when the call names no app the executor can place.
 */
export async function resolveComputerUseTargetApp(
  method: string,
  params: Record<string, unknown>,
): Promise<string | undefined> {
  const placed = await placeComputerUseCall(method, params)
  return typeof placed === 'string' ? placed : undefined
}

/**
 * Where a computer-use call acts, for its permission check: the app; nothing
 * when it cannot be placed (the user is asked about the call itself); or the
 * reason the executor will refuse it whatever the user decides (it would act
 * in this app's own window, or in two apps), so the check refuses it at once
 * instead of asking for an approval that cannot be used.
 */
export async function placeComputerUseCall(
  method: string,
  params: Record<string, unknown>,
): Promise<string | undefined | { refused: string }> {
  try {
    ;({ method, params } = commandLineOf(method, params))
    return await targetAppOf(method, callTargets(method, params))
  } catch (error) {
    return error instanceof ComputerUseArgumentError ? { refused: error.message } : undefined
  }
}

/**
 * Each session's commands, run one at a time in the order they arrive. An
 * agent that issues several tool calls at once (click 1, click 2, click 3)
 * means them in order, and concurrent agent-desktop processes acting on one
 * window see each other's focus and pointer moves as occlusion. Sessions of
 * different agents still run side by side; agent-desktop serializes their
 * input itself.
 */
const sessionQueues = new Map<string, Promise<unknown>>()

/**
 * Each app session's agent, how many times its computer use was ended, and
 * the commands it has running. Ending it (endComputerUseSessions) stops
 * those, and drops the ones still queued from before the end.
 */
interface SessionWork {
  agentSlug: string
  ended: number
  running: Set<AbortController>
}
const sessionWork = new Map<string, SessionWork>()

function workOf(caller: ComputerUseCaller): SessionWork {
  let work = sessionWork.get(caller.sessionId)
  if (!work) {
    work = { agentSlug: caller.agentSlug, ended: 0, running: new Set() }
    sessionWork.set(caller.sessionId, work)
  }
  return work
}

function inSessionOrder<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
  const previous = sessionQueues.get(sessionId) ?? Promise.resolve()
  const next = previous.then(run, run)
  // The queue's tail settles either way, and forgets an idle session.
  const tail: Promise<void> = next.then(() => forget(), () => forget())
  const forget = () => {
    if (sessionQueues.get(sessionId) === tail) sessionQueues.delete(sessionId)
  }
  sessionQueues.set(sessionId, tail)
  return next
}

/** Options for one command. */
export interface ComputerUseCommandOptions {
  /** The latest time (epoch ms) it may start; still queued then, it is dropped unrun. */
  startBy?: number
  /** The app the call was placed in when it was approved; it is not placed again. */
  app?: string
}

/** Run one computer-use command for an app session, after the session's earlier ones. */
export function executeComputerUseCommand(
  method: string,
  params: Record<string, unknown>,
  caller: ComputerUseCaller,
  options: ComputerUseCommandOptions = {},
): Promise<ComputerUseResult> {
  const work = workOf(caller)
  const ended = work.ended
  return inSessionOrder(caller.sessionId, async () => {
    if (work.ended !== ended) {
      throw new ComputerUseArgumentError(`${method} was not run: computer use for this session was ended (the app was taken back, or the session stopped) before its turn. Nothing was done.`)
    }
    if (options.startBy !== undefined && Date.now() > options.startBy) {
      const waited = Math.round((Date.now() - options.startBy) / 1000)
      throw new ComputerUseArgumentError(`${method} was not run: it was still waiting behind this session's earlier commands ${waited}s past its start time. Nothing was done; you can try it again.`)
    }
    const stop = new AbortController()
    work.running.add(stop)
    try {
      return await runCommand(method, params, caller, options.app, stop.signal)
    } finally {
      work.running.delete(stop)
      cursorCommandDone(caller.sessionId)
    }
  })
}

/** Whether the user lets agents send physical input (`--headed`). */
async function physicalInputAllowed(): Promise<boolean> {
  return computerUsePreferences((await getSettings()).computerUse).inputMode === 'headed'
}

/**
 * Run one agent-desktop command within the budget its own flags give it. A
 * command that outlives that is stopped and answered as agent-desktop answers
 * a timeout: delivery unknown for an action, so the agent re-reads the UI
 * instead of acting twice.
 */
async function runInBudget(
  session: string,
  commandArgs: readonly string[],
  signal?: AbortSignal,
): Promise<{ stdout: string; envelope: AgentDesktopEnvelope | null }> {
  const timeoutMs = commandTimeoutMs(commandArgs)
  try {
    const output = await runAgentDesktopOutput(['--session', session, ...commandArgs], { timeoutMs, ...(signal && { signal }) })
    // Help and version print text, not an envelope.
    const printsText = commandArgs[0] === 'help' || commandArgs.some((arg) => arg === '--help' || arg === '-h' || arg === '--version' || arg === '-V')
    if (output.envelope || printsText) {
      const stdout = output.stdout || `agent-desktop ${commandArgs[0] ?? ''} exited with code ${output.code} and printed nothing${output.stderr ? `: ${output.stderr.trim().slice(0, 500)}` : ''}`
      return { stdout, envelope: output.envelope }
    }
    // It stopped without its result (a crash): answered as a failure whose
    // delivery is unknown for an action, so the agent re-reads the UI rather
    // than doing it again another way.
    const command = commandArgs[0] ?? ''
    const detail = output.stderr.trim().split('\n').find((line) => line.trim()) ?? output.stdout.trim().slice(0, 300)
    const envelope: AgentDesktopEnvelope = {
      ok: false,
      command,
      error: {
        code: 'INTERNAL',
        message: `agent-desktop ${command} exited with code ${output.code} without a result${detail ? `: ${detail.slice(0, 500)}` : ''}`,
        disposition: OBSERVATION_COMMANDS.has(command)
          ? { delivery: 'not_delivered', retry: 'safe' }
          : { delivery: 'delivered_unverified', retry: 'unsafe' },
      },
    }
    return { stdout: JSON.stringify(envelope), envelope }
  } catch (error) {
    if (!(error instanceof AgentDesktopTimeoutError) && !(error instanceof AgentDesktopAbortedError)) throw error
    const command = commandArgs[0] ?? ''
    const envelope: AgentDesktopEnvelope = {
      ok: false,
      command,
      error: error instanceof AgentDesktopAbortedError ? {
        code: 'CANCELLED',
        message: 'the app stopped it: computer use for this session was ended (the app was taken back, or the session stopped)',
        disposition: OBSERVATION_COMMANDS.has(command)
          ? { delivery: 'not_delivered', retry: 'safe' }
          : { delivery: 'delivered_unverified', retry: 'unsafe' },
      } : {
        code: 'TIMEOUT',
        message: `agent-desktop gave no result within ${timeoutMs / 1000}s, so the app stopped it`,
        disposition: OBSERVATION_COMMANDS.has(command)
          ? { delivery: 'not_delivered', retry: 'safe' }
          : { delivery: 'delivered_unverified', retry: 'unsafe' },
      },
    }
    return { stdout: JSON.stringify(envelope), envelope }
  }
}

async function runCommand(
  method: string,
  params: Record<string, unknown>,
  caller: ComputerUseCaller,
  placedIn?: string,
  signal?: AbortSignal,
): Promise<ComputerUseResult> {
  ;({ method, params } = commandLineOf(method, params))
  let commandArgs = buildCommandArgs(method, params)
  if (requestsHeaded(commandArgs) && !(await physicalInputAllowed())) {
    throw new ComputerUseArgumentError('--headed (physical input) is off in this app\'s settings (Settings → Computer Use → Physical Input: Never). Run the command without it, or tell the user if the task needs physical input.')
  }
  const targets = callTargets(method, params)
  const targetApp = placedIn === undefined ? await targetAppOf(method, targets) : await confirmPlacement(method, targets, placedIn)
  commandArgs = withFocusedApp(method, commandArgs, targets, targetApp)
  const appSession = await sessionFor(caller)
  const session = appSession.agentDesktopSession
  // agent-desktop fades an idle cursor after a few seconds; a shown one is
  // kept on screen until the turn ends (endComputerUseTurn).
  if (appSession.cursor !== null) keepCursorOnScreen(caller.sessionId, session, agentDesktopHome(), requestsHeaded(commandArgs))
  else letCursorRest(caller.sessionId)
  // agent-desktop does not say where the window it captured is, so the window
  // list is read for that, alongside the capture rather than after it: the
  // two reads are then as close in time as they can be.
  const placeScreenshot = (args: readonly string[]) => screenshotTarget(args).catch(() => ({ target: null, reason: 'the window list could not be read' }))
  let placing = method === 'screenshot' ? placeScreenshot(commandArgs) : null
  let { stdout, envelope } = await runInBudget(session, commandArgs, signal).finally(() => { recentScreen = null })
  if (process.platform === 'win32' && envelope?.error?.code === 'APP_NOT_FOUND') {
    if (method === 'launch') {
      const launched = await launchFromStartMenu(commandArgs, envelope, signal)
      if (launched) ({ stdout, envelope } = launched)
    } else if (method === 'screenshot') {
      const byWindow = await screenshotArgsByWindow(commandArgs)
      if (byWindow) {
        placing = placeScreenshot(byWindow)
        ;({ stdout, envelope } = await runInBudget(session, byWindow, signal))
      }
    }
  }
  if (envelope?.error?.code === 'PERM_DENIED') {
    believedUntil.accessibility = 0
    believedUntil.screen_recording = 0
    // A batch's earlier entries may have acted, so its result goes back as it is.
    if (method !== 'batch') return { output: stdout, permissionDenied: true }
  }
  const app = envelope ? rememberTargets(method, envelope, targetApp) : targetApp

  if (placing && envelope) {
    const output = await screenshotOutput(envelope, await placing)
    if (output) return { output, ...(app && { app }) }
  }
  // A screenshot that did not come back as an image goes back without its data.
  const stripped = envelope && (method === 'screenshot' || method === 'batch')
    ? withoutScreenshotData(envelope, method === 'screenshot')
    : null
  return { output: stripped ? JSON.stringify(stripped) : stdout, ...(app && { app }) }
}

/** How long a launch from the Start menu waits for the app's window. */
const START_MENU_LAUNCH_WAIT_MS = 20_000

/** The name a `launch` command line launches: its one positional argument. */
function launchName(commandArgs: readonly string[]): string | undefined {
  const separator = commandArgs.indexOf('--')
  if (separator !== -1) return commandArgs[separator + 1]
  const last = commandArgs.at(-1)
  return commandArgs.length > 1 && last !== undefined && !last.startsWith('-') ? last : undefined
}

/**
 * A Windows app agent-desktop could not launch by that name, launched by the
 * name the Start menu shows (Calculator, Spotify, Settings): agent-desktop
 * launches only paths and executables in the Windows directory, which no
 * Store app has. Answers as `launch` does, with the window that came up;
 * null when the Start menu has no app by that name.
 */
async function launchFromStartMenu(
  commandArgs: readonly string[],
  failed: AgentDesktopEnvelope,
  signal?: AbortSignal,
): Promise<{ stdout: string; envelope: AgentDesktopEnvelope } | null> {
  const name = launchName(commandArgs)
  // A path is agent-desktop's to launch: it failed because nothing is there.
  if (!name || name.includes('\\') || name.includes('/')) return null
  const entry = findStartMenuApp(name, await startMenuApps().catch(() => []))
  if (!entry || signal?.aborted) return null
  const before = await listWindows()
  const startMenu = { name: entry.name, app_id: entry.appId }
  // Already running: activating its Start menu entry would open another
  // window of it (Chrome, Explorer), taking focus from the one the user had.
  // Its windows are the answer instead, and nothing is started or raised.
  const running = before.filter((window) => [name, entry.name, entry.appId].some((known) => sameApp(known, window.app_name)))
  if (running.length > 0) {
    const shown = running.find((window) => window.is_focused) ?? running.find((window) => !window.minimized) ?? running[0]
    const envelope: AgentDesktopEnvelope = {
      ...(failed.version !== undefined && { version: failed.version }),
      ok: true,
      command: 'launch',
      data: {
        app: shown.app_name,
        window: { id: shown.id, ...(shown.title !== undefined && { title: shown.title }) },
        windows: running.map((window) => ({ id: window.id, ...(window.title !== undefined && { title: window.title }), ...(window.minimized && { minimized: true }) })),
        start_menu: startMenu,
        already_running: true,
        note: `${shown.app_name} was already running, with ${running.length === 1 ? 'this window' : `these ${running.length} windows`}; no new instance was started and no window was brought forward.`,
      },
    }
    return { stdout: JSON.stringify(envelope), envelope }
  }
  activateStartMenuApp(entry)
  const window = await waitForActivatedWindow(before, listWindows, START_MENU_LAUNCH_WAIT_MS, signal)
  const envelope: AgentDesktopEnvelope = {
    ...(failed.version !== undefined && { version: failed.version }),
    ok: true,
    command: 'launch',
    data: window
      ? { app: window.app_name, window: { id: window.id, ...(window.title !== undefined && { title: window.title }) }, start_menu: startMenu }
      : { app: entry.name, start_menu: startMenu, note: `Started from the Start menu; no window of it appeared within ${START_MENU_LAUNCH_WAIT_MS / 1000}s` },
  }
  return { stdout: JSON.stringify(envelope), envelope }
}

/**
 * A screenshot of a Windows app agent-desktop could not capture by its name
 * (a Store app, whose window a frame host owns), as a capture of that app's
 * window: the focused one, else the first. Null when no window is the app's.
 */
async function screenshotArgsByWindow(commandArgs: readonly string[]): Promise<string[] | null> {
  const app = flagValue(commandArgs, '--app')
  if (!app || flagValue(commandArgs, '--window-id') !== undefined || flagValue(commandArgs, '--screen') !== undefined) return null
  const windows = (await listWindows()).filter((window) => !window.minimized && sameApp(window.app_name, app))
  const window = windows.find((candidate) => candidate.is_focused) ?? windows[0]
  if (!window) return null
  const [command, ...rest] = commandArgs
  const withoutApp = rest.filter((token, i) => !token.startsWith('--app=') && token !== '--app' && rest[i - 1] !== '--app')
  return [command, `--window-id=${window.id}`, ...withoutApp]
}

/**
 * A snapshot or find that names no app reads the focused one. The call is
 * pinned to the app it was placed in (and permitted for), so a change of
 * focus in between cannot point it at another.
 */
function withFocusedApp(method: string, commandArgs: string[], targets: CallTargets, app: string | undefined): string[] {
  const unscoped = FOCUSED_APP_COMMANDS.has(method) && targets.focused === true
  if (!unscoped || !app) return commandArgs
  const [command, ...rest] = commandArgs
  return [command, `--app=${app}`, ...rest]
}

/**
 * End the agent-desktop sessions of an agent, or of one app session: their
 * cursors go with them, a command they have running is stopped, and one still
 * queued from before is dropped unrun.
 */
export async function endComputerUseSessions(filter: { agentSlug?: string; sessionId?: string } = {}): Promise<void> {
  recentScreen = null
  for (const [sessionId, work] of sessionWork) {
    if (filter.sessionId && filter.sessionId !== sessionId) continue
    if (filter.agentSlug && filter.agentSlug !== work.agentSlug) continue
    work.ended++
    for (const stop of work.running) stop.abort()
    letCursorRest(sessionId)
  }
  const ending: Promise<unknown>[] = []
  for (const [sessionId, pending] of sessions) {
    ending.push(pending.then(async (session) => {
      if (filter.sessionId && filter.sessionId !== sessionId) return
      if (filter.agentSlug && filter.agentSlug !== session.agentSlug) return
      sessions.delete(sessionId)
      await runAgentDesktop(['session', 'end', session.agentDesktopSession])
    }).catch(() => {
      // A session that never started, or a CLI that is gone: nothing to end.
    }))
  }
  await Promise.all(ending)
  // With no session left, nothing will place a point: the hit test's helper can go.
  if (sessions.size === 0) stopWindowsHitTest()
}

/**
 * An app session's turn ended: its cursor is no longer kept on screen, and
 * agent-desktop fades it as it does any idle cursor. The agent-desktop
 * session stays, for the refs of the session's next turn.
 */
export function endComputerUseTurn(sessionId: string): void {
  letCursorRest(sessionId)
}

/** End every session on app exit. */
export async function shutdownComputerUse(): Promise<void> {
  await endComputerUseSessions()
}

const PERMISSIONS_BELIEVED_MS = 60_000
/** Until when each permission is believed granted without asking again. */
const believedUntil = { accessibility: 0, screen_recording: 0 }

/**
 * Check the macOS permissions a computer-use call needs, through
 * agent-desktop: Accessibility for every call, and Screen Recording for one
 * that takes a screenshot. Returns the permission report when one it needs is
 * missing, or null when it can run (or the check cannot tell). Runs before
 * every call, so a grant is believed for a minute, and until a command
 * reports PERM_DENIED.
 */
export async function checkComputerUsePermissions(needs: { screenRecording?: boolean } = {}): Promise<{ accessibility: boolean; screen_recording: boolean } | null> {
  const now = Date.now()
  if (now < believedUntil.accessibility && (!needs.screenRecording || now < believedUntil.screen_recording)) return null
  try {
    const data = permissionsDataSchema.parse(await runAgentDesktopOrThrow(['permissions']))
    const granted = (state?: string) => state === undefined || state === 'granted' || state === 'not_required'
    const report = { accessibility: granted(data.accessibility?.state), screen_recording: granted(data.screen_recording?.state) }
    const until = Date.now() + PERMISSIONS_BELIEVED_MS
    if (report.accessibility) believedUntil.accessibility = until
    if (report.screen_recording) believedUntil.screen_recording = until
    return report.accessibility && (report.screen_recording || !needs.screenRecording) ? null : report
  } catch {
    // If the check itself fails, don't block: the command will report it.
    return null
  }
}
