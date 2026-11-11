/**
 * The computer-use command line: what agents may run, and what it acts on.
 *
 * Every call arrives as an agent-desktop command and its arguments
 * (`{ argv }`, see ./command-line), and runs as given. This module refuses
 * only what the app keeps for itself: the session, the cursor and tracing,
 * paths on the host (a screenshot or clipboard file), and launching an app
 * with a debugging port, arguments or environment.
 *
 * It also answers what a call acts on, for the per-app permission check: the
 * app it names, the window it names, the snapshot its ref came from, the
 * points it acts at, or a target that is not an app (the clipboard, the whole
 * screen, notifications).
 */

/** Commands that read nothing from an app: the read-only permission level. */
export const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  'list-apps',
  'list-windows',
  'list-displays',
  'status',
  'version',
  'skills',
  'help',
])

/** Commands that read the UI or the machine and send no input. */
export const OBSERVATION_COMMANDS: ReadonlySet<string> = new Set([
  ...READ_ONLY_COMMANDS,
  'snapshot',
  'find',
  'get',
  'is',
  'screenshot',
  'list-surfaces',
  'list-notifications',
  'clipboard-get',
  'wait',
])

/**
 * Commands the app runs itself: the session, its cursor, its traces, and the
 * OS permissions (checked before every call, and asked of the user).
 */
const DENIED_COMMANDS: ReadonlySet<string> = new Set(['session', 'trace', 'cursor-overlay', 'permissions'])

/** Global flags the app sets (the session) or refuses (traces and debug files written on the host). */
const HOST_GLOBAL_FLAGS: ReadonlySet<string> = new Set([
  '--session',
  '--agent-id',
  '--trace',
  '--trace-strict',
  '--screenshot',
  '--debug',
])

/**
 * Flags refused on one command:
 * - launch: a debugging port, arguments, environment or working directory turn
 *   "open an app" into running arbitrary code, which is the host-shell
 *   permission, not this one.
 * - press: `--force` sends the shortcuts agent-desktop blocks (quit, log out).
 * - clipboard: a path on the host to write the clipboard's image to, or to
 *   read a file onto the clipboard from.
 */
const DENIED_COMMAND_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  launch: new Set(['--cdp', '--arg', '--env', '--cwd']),
  press: new Set(['--force']),
  'clipboard-get': new Set(['--out']),
  'clipboard-set': new Set(['--image', '--file-url']),
}

/** The same refusals in a batch entry's args, which name flags without dashes. */
const DENIED_BATCH_ARGS: Readonly<Record<string, readonly string[]>> = {
  launch: ['cdp', 'arg', 'args', 'env', 'cwd'],
  press: ['force'],
  'clipboard-get': ['out'],
  'clipboard-set': ['image', 'file_url', 'file_urls'],
  screenshot: ['path', 'output_path'],
}

/** A ref from a snapshot: `@<snapshot id>:e<N>`. */
const QUALIFIED_REF = /^@([A-Za-z0-9_-]+):e\d+$/

/**
 * Commands that, naming no app, act in the focused one: snapshot and find
 * read it, press and the key commands type into it. The machine places them
 * at that app before they are judged.
 */
export const ACTS_IN_FOCUSED_APP: ReadonlySet<string> = new Set(['snapshot', 'find', 'press', 'key-down', 'key-up'])

/** The snapshot a qualified ref came from, or undefined for anything else. */
export function snapshotIdOfRef(ref: string): string | undefined {
  return QUALIFIED_REF.exec(ref)?.[1]
}

export class ComputerUseArgumentError extends Error {}

type Params = Record<string, unknown>

/** The flag part of a token: `--app=x` and `--app` are both `--app`. */
function flagName(token: string): string | undefined {
  if (!token.startsWith('-') || token === '--' || token === '-') return undefined
  const eq = token.indexOf('=')
  return eq === -1 ? token : token.slice(0, eq)
}

/**
 * Flags that take a value as the following token, so the scan below does not
 * count that value as a positional. Only the ones whose value could otherwise
 * be mistaken for a screenshot path matter; others are harmless either way.
 */
const VALUE_FLAGS: ReadonlySet<string> = new Set(['--app', '--window-id', '--screen', '--timeout-ms'])

/** The arguments before `--`: everything after it is a positional, never a flag. */
function flagPart(argv: readonly string[]): readonly string[] {
  const end = argv.indexOf('--')
  return end === -1 ? argv : argv.slice(0, end)
}

/** Check one command's arguments (without the command) against what agents may pass. */
function checkArgs(command: string, argv: readonly string[]): void {
  const denied = DENIED_COMMAND_FLAGS[command]
  const flags = flagPart(argv)
  let positionals = argv.length - flags.length - (flags.length < argv.length ? 1 : 0)
  for (let i = 0; i < flags.length; i++) {
    const token = flags[i]
    const name = flagName(token)
    if (name === undefined) {
      positionals++
      continue
    }
    if (HOST_GLOBAL_FLAGS.has(name)) {
      throw new ComputerUseArgumentError(`${name} is set by the app, not by an agent`)
    }
    if (denied?.has(name)) {
      throw new ComputerUseArgumentError(`${command} ${name} is not available to agents`)
    }
    // A value given as the next token is not a positional.
    if (!token.includes('=') && i + 1 < flags.length && !flags[i + 1].startsWith('-') && VALUE_FLAGS.has(name)) i++
  }
  // A path would write the image anywhere on the host; without one it comes back to the agent.
  if (command === 'screenshot' && positionals > 0) {
    throw new ComputerUseArgumentError('screenshot takes no output path: the image comes back to you')
  }
}

/** A `batch` entry, as the CLI reads it. */
interface BatchEntry {
  command: string
  args?: Record<string, unknown>
}

/** batch flags that take no value; any other flag written without `=` takes the next token. */
const BATCH_SWITCHES: ReadonlySet<string> = new Set(['--stop-on-error', '--headed', '--verbose', '-v', '--help', '-h'])

/**
 * The batch's entries: its one positional, the JSON array. A second token that
 * looks like an array (a flag's value, say) is refused rather than guessed at,
 * so the entries checked here are the ones agent-desktop runs.
 */
function parseBatch(argv: readonly string[]): BatchEntry[] {
  if (argv.filter((token) => token.trim().startsWith('[')).length > 1) {
    throw new ComputerUseArgumentError('batch takes one JSON array of entries; this call has more than one argument that looks like one')
  }
  const json = positionalsOf(argv, BATCH_SWITCHES)[0]
  if (json === undefined || !json.trim().startsWith('[')) throw new ComputerUseArgumentError('batch needs its JSON array of entries')
  let entries: unknown
  try {
    entries = JSON.parse(json)
  } catch {
    throw new ComputerUseArgumentError('batch entries must be a JSON array')
  }
  if (!Array.isArray(entries)) throw new ComputerUseArgumentError('batch entries must be a JSON array')
  return entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || typeof (entry as BatchEntry).command !== 'string') {
      throw new ComputerUseArgumentError('each batch entry needs a command')
    }
    return entry as BatchEntry
  })
}

function checkBatch(argv: readonly string[]): void {
  for (const entry of parseBatch(argv)) {
    if (DENIED_COMMANDS.has(entry.command)) {
      throw new ComputerUseArgumentError(`${entry.command} is managed by the app and not available to agents`)
    }
    if ('session' in entry) throw new ComputerUseArgumentError('batch entries take the session the app sets')
    const args = entry.args ?? {}
    for (const key of DENIED_BATCH_ARGS[entry.command] ?? []) {
      if (key in args) throw new ComputerUseArgumentError(`${entry.command} ${key} is not available to agents`)
    }
  }
}

/** A call's arguments, as `{ argv }` carries them. */
export function argvOf(params: Params): string[] {
  const argv = params.argv
  if (!Array.isArray(argv) || argv.some((token) => typeof token !== 'string')) {
    throw new ComputerUseArgumentError('argv must be a list of strings')
  }
  return argv as string[]
}

/**
 * The command line for one call, without the session the app adds:
 * `[command, ...argv]`. Throws `ComputerUseArgumentError` for anything an
 * agent may not run.
 */
export function buildCommandArgs(method: string, params: Params): string[] {
  if (method === 'run') {
    throw new ComputerUseArgumentError('agent_desktop needs the command first, then its arguments, e.g. ["snapshot", "--app", "Finder"]')
  }
  if (DENIED_COMMANDS.has(method)) {
    throw new ComputerUseArgumentError(`${method} is managed by the app and not available to agents`)
  }
  const argv = argvOf(params)
  checkArgs(method, argv)
  // `batch --help` runs nothing, so it has no entries to check.
  if (method === 'batch' && !argv.includes('--help') && !argv.includes('-h')) checkBatch(argv)
  return [method, ...argv]
}

/** Whether a command line asks for physical input (`--headed`, before any `--`). */
export function requestsHeaded(commandArgs: readonly string[]): boolean {
  return flagPart(commandArgs).includes('--headed')
}

/**
 * What a call acts on that is not one app, named as the permission prompt
 * shows it. A grant for one of these covers it alone: a grant for the
 * clipboard does not let an agent click anywhere on screen.
 */
export const SYSTEM_TARGETS = {
  clipboard: 'Clipboard',
  screen: 'Entire screen',
  notifications: 'Notifications',
} as const

const SYSTEM_TARGET_NAMES: ReadonlySet<string> = new Set(Object.values(SYSTEM_TARGETS))

/** Whether an app name is one of SYSTEM_TARGETS rather than an app. */
export function isSystemTarget(name: string): boolean {
  return SYSTEM_TARGET_NAMES.has(name)
}

const NOTIFICATION_COMMANDS: ReadonlySet<string> = new Set([
  'list-notifications', 'dismiss-notification', 'dismiss-all-notifications', 'notification-action',
])

/**
 * `--surface` values that are the OS shell's, not an app's: reading one reads
 * no app (and needs no `--app`). The notification ones are Notifications;
 * the rest are judged as the whole screen.
 */
const SHELL_SURFACES: ReadonlySet<string> = new Set([
  'desktop', 'dock', 'spotlight', 'menu-bar-extras', 'notification-center',
  'taskbar', 'start-menu', 'system-tray', 'system-tray-overflow', 'quick-settings', 'action-center',
])
const NOTIFICATION_SURFACES: ReadonlySet<string> = new Set(['notification-center', 'action-center'])

/** A point on screen, as `--xy` takes it. */
export interface ScreenPoint {
  x: number
  y: number
}

/** What a call names, for finding the app it targets. */
export interface CallTargets {
  app?: string
  windowIds: string[]
  snapshotIds: string[]
  /** Screen points it acts at (`--xy`, `--from-xy`, `--to-xy`): the window on top at each is its target. */
  points?: ScreenPoint[]
  /** What it acts on beyond any app: the clipboard, the whole screen, notifications. */
  system?: string
  /**
   * It acts in whatever app has focus: a snapshot, find, press or key command
   * (or a batch entry of one) that names no app, window or ref.
   */
  focused?: boolean
}

const POINT_FLAGS: ReadonlySet<string> = new Set(['--xy', '--from-xy', '--to-xy'])

function parsePoint(value: unknown): ScreenPoint | undefined {
  if (Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number')) {
    return { x: value[0] as number, y: value[1] as number }
  }
  if (typeof value !== 'string') return undefined
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(value)
  return match ? { x: Number(match[1]), y: Number(match[2]) } : undefined
}

/** `mouse-wheel --x <X> --y <Y>`: its point, given as two flags. */
function pointOfXY(x: unknown, y: unknown): ScreenPoint | undefined {
  const nx = typeof x === 'number' ? x : typeof x === 'string' && x.trim() ? Number(x) : NaN
  const ny = typeof y === 'number' ? y : typeof y === 'string' && y.trim() ? Number(y) : NaN
  return Number.isFinite(nx) && Number.isFinite(ny) ? { x: nx, y: ny } : undefined
}

/** Switches of launch and close-app (and every command's global ones); any other flag written without `=` takes the next token. */
const APP_COMMAND_SWITCHES: ReadonlySet<string> = new Set([
  '--activate', '--no-attach', '--force', '--headed', '--verbose', '-v', '--help', '-h', '--trace-strict', '--debug',
])

/**
 * A command line's positionals: everything after `--`, and before it every
 * token that is neither a flag nor the value of one (a flag not in
 * `switches`, written without `=`, takes the next token).
 */
function positionalsOf(argv: readonly string[], switches: ReadonlySet<string>): string[] {
  const flags = flagPart(argv)
  const positionals: string[] = []
  for (let i = 0; i < flags.length; i++) {
    const token = flags[i]
    const name = flagName(token)
    if (name === undefined) {
      positionals.push(token)
      continue
    }
    if (!token.includes('=') && !switches.has(name)) i++
  }
  return [...positionals, ...argv.slice(flags.length + 1)]
}

/** What one command (a call, or one batch entry) names, read from its flags or its entry's args. */
interface Named {
  app?: string
  windowIds: string[]
  snapshotIds: string[]
  points: ScreenPoint[]
  surface?: string
  screen: boolean
  notification: boolean
}

function namedInTokens(command: string, argv: readonly string[]): Named {
  const named: Named = { windowIds: [], snapshotIds: [], points: [], screen: false, notification: false }
  const flags = flagPart(argv)
  let wheelX: string | undefined
  let wheelY: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    const snapshotId = snapshotIdOfRef(token)
    if (snapshotId) {
      named.snapshotIds.push(snapshotId)
      continue
    }
    if (i >= flags.length) continue
    const name = flagName(token)
    if (name === undefined) continue
    if (name === '--screen') named.screen = true
    if (name === '--notification') named.notification = true
    const value = token.includes('=') ? token.slice(token.indexOf('=') + 1) : flags[i + 1]
    if (!value) continue
    // A ref given as a flag's value (--root, --element, --from, --to) names its snapshot too.
    const valueSnapshot = token.includes('=') ? snapshotIdOfRef(value) : undefined
    if (valueSnapshot) named.snapshotIds.push(valueSnapshot)
    if (name === '--app') {
      if (named.app !== undefined && named.app !== value) {
        throw new ComputerUseArgumentError(`One call acts in one app; this one names ${named.app} and ${value}. Send one call per app.`)
      }
      named.app = value
    } else if (name === '--window-id') named.windowIds.push(value)
    else if (name === '--surface') named.surface = value
    else if (POINT_FLAGS.has(name)) {
      const point = parsePoint(value)
      if (point) named.points.push(point)
    } else if (command === 'mouse-wheel' && name === '--x') wheelX = value
    else if (command === 'mouse-wheel' && name === '--y') wheelY = value
  }
  const wheel = pointOfXY(wheelX, wheelY)
  if (wheel) named.points.push(wheel)
  // launch and close-app name their app as the positional.
  if ((command === 'launch' || command === 'close-app') && named.app === undefined) {
    const positionals = positionalsOf(argv, APP_COMMAND_SWITCHES)
    if (positionals.length > 1) {
      throw new ComputerUseArgumentError(`${command} takes one app; this call names ${positionals.join(', ')}. Write a flag's value as --flag=value, or send one call per app.`)
    }
    if (positionals[0]) named.app = positionals[0]
  }
  return named
}

function namedInEntry(command: string, args: Record<string, unknown>): Named {
  const named: Named = {
    windowIds: [],
    snapshotIds: [],
    points: [],
    screen: args.screen !== undefined && args.screen !== null && args.screen !== false,
    notification: Boolean(args.notification),
  }
  for (const [key, value] of Object.entries(args)) {
    if (key === 'xy' || key === 'from_xy' || key === 'to_xy') {
      const point = parsePoint(value)
      if (point) named.points.push(point)
      continue
    }
    if (typeof value !== 'string') continue
    const snapshotId = snapshotIdOfRef(value)
    if (snapshotId) named.snapshotIds.push(snapshotId)
    else if (key === 'app') named.app = value
    else if (key === 'window_id') named.windowIds.push(value)
    else if (key === 'surface') named.surface = value
  }
  if (command === 'mouse-wheel') {
    const wheel = pointOfXY(args.x, args.y)
    if (wheel) named.points.push(wheel)
  }
  return named
}

/** What one command acts on, by the rules for its kind. */
function targetsOf(command: string, named: Named): CallTargets {
  let system: string | undefined
  let app = named.app
  if (command.startsWith('clipboard-')) system = SYSTEM_TARGETS.clipboard
  else if (NOTIFICATION_COMMANDS.has(command) || (command === 'wait' && named.notification)) {
    system = SYSTEM_TARGETS.notifications
    // There `--app` filters the notifications; it names no app to act in.
    app = undefined
  } else if (command === 'open-system-surface') system = SYSTEM_TARGETS.screen
  else if (named.surface !== undefined && SHELL_SURFACES.has(named.surface)) {
    system = NOTIFICATION_SURFACES.has(named.surface) ? SYSTEM_TARGETS.notifications : SYSTEM_TARGETS.screen
  } else if (command === 'screenshot' && (named.screen || (!app && named.windowIds.length === 0))) {
    // A screenshot that names no app or window captures the whole main display.
    system = SYSTEM_TARGETS.screen
  }
  if (app !== undefined && system !== undefined) {
    throw new ComputerUseArgumentError(`One call acts in one app or on one target; this ${command} names ${app} and ${system}. Send one call per app or target.`)
  }
  const focused = ACTS_IN_FOCUSED_APP.has(command) && app === undefined && system === undefined
    && named.windowIds.length === 0 && named.snapshotIds.length === 0
  return {
    ...(app !== undefined && { app }),
    windowIds: named.windowIds,
    snapshotIds: named.snapshotIds,
    ...(named.points.length > 0 && { points: named.points }),
    ...(system !== undefined && { system }),
    ...(focused && { focused: true }),
  }
}

/**
 * The batch's entries' targets as one call's: one app or system target at
 * most (with the refs, windows and points, which the machine places), and an
 * entry that acts in whatever app has focus only when no entry names one.
 */
function mergeTargets(entries: ReadonlyArray<{ command: string; targets: CallTargets }>): CallTargets {
  const merged: CallTargets = { windowIds: [], snapshotIds: [] }
  const named = new Set<string>()
  let focusedEntry: string | undefined
  for (const { command, targets } of entries) {
    if (targets.app !== undefined) named.add(targets.app)
    if (targets.system !== undefined) named.add(targets.system)
    if (targets.focused) focusedEntry ??= command
    merged.windowIds.push(...targets.windowIds)
    merged.snapshotIds.push(...targets.snapshotIds)
    if (targets.points) (merged.points ??= []).push(...targets.points)
  }
  if (named.size > 1) {
    throw new ComputerUseArgumentError(`One call acts in one app or on one target; this batch names ${[...named].join(', ')}. Send one call (or batch) per app or target.`)
  }
  const [only] = named
  if (only !== undefined && focusedEntry !== undefined) {
    throw new ComputerUseArgumentError(`This batch acts in ${only}, and its ${focusedEntry} entry, which names no app, acts in whatever app has focus. Name the app on every entry (app), or send one call per app.`)
  }
  if (only !== undefined) {
    if (isSystemTarget(only)) merged.system = only
    else merged.app = only
  }
  if (focusedEntry !== undefined) merged.focused = true
  return merged
}

/** The app, windows, snapshots, points and system targets a command line names, wherever it names them. */
export function callTargets(method: string, params: Params): CallTargets {
  if (!Array.isArray(params.argv)) return { windowIds: [], snapshotIds: [] }
  const argv = argvOf(params)
  if (method === 'batch') {
    // `batch --help` runs nothing, so it has no entries to read.
    if (argv.includes('--help') || argv.includes('-h')) return { windowIds: [], snapshotIds: [] }
    return mergeTargets(parseBatch(argv).map((entry) => ({
      command: entry.command,
      targets: targetsOf(entry.command, namedInEntry(entry.command, entry.args ?? {})),
    })))
  }
  return targetsOf(method, namedInTokens(method, argv))
}

/**
 * Whether the call takes a screenshot, which needs the Screen Recording
 * permission as well as Accessibility.
 */
export function capturesScreen(method: string, params: Params): boolean {
  if (!Array.isArray(params.argv)) return method === 'screenshot'
  const argv = argvOf(params)
  const flags = flagPart(argv)
  if (flags.includes('--help') || flags.includes('-h')) return false
  if (method !== 'batch') return method === 'screenshot'
  try {
    return parseBatch(argv).some((entry) => entry.command === 'screenshot')
  } catch {
    return false
  }
}

/** `wait` flags that look inside an app (or at notifications); without them a wait watches nothing private. */
const WAIT_TARGET_FLAGS: ReadonlySet<string> = new Set([
  '--app', '--element', '--text', '--menu', '--menu-closed', '--notification',
])

/**
 * The permission level a command needs. Help, and listing apps and windows,
 * need only the read-only level; so does a `wait` for a duration, a window
 * title or a desktop event, which reveals no more than the window list.
 */
export function permissionLevelOf(method: string, params: Params = {}): 'list_apps_windows' | 'use_application' {
  if (READ_ONLY_COMMANDS.has(method)) return 'list_apps_windows'
  if (!Array.isArray(params.argv)) return 'use_application'
  const flags = flagPart(argvOf(params))
  if (flags.includes('--help') || flags.includes('-h')) return 'list_apps_windows'
  if (method === 'wait') {
    const looksInside = argvOf(params).some((token) => {
      const name = flagName(token)
      return (name !== undefined && WAIT_TARGET_FLAGS.has(name)) || snapshotIdOfRef(token) !== undefined
    })
    if (!looksInside) return 'list_apps_windows'
  }
  return 'use_application'
}
