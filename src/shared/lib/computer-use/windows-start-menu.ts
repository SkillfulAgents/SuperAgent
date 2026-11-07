/**
 * Launching a Windows app by the name the Start menu shows it under.
 *
 * agent-desktop's `launch` takes an absolute path or an executable under the
 * Windows directory, so a Store app (Calculator, Spotify, Settings) has no name
 * it can launch. The Start menu lists every app with its AppUserModelID, and
 * the shell starts any of them from `shell:AppsFolder\<id>`. Only an id read
 * from that list is ever started this way, never one the agent wrote.
 */

import { execFile, spawn } from 'child_process'
import { z } from 'zod'
import { sameApp } from './app-identity'

/** An app in the Start menu: its display name and its AppUserModelID. */
export interface StartMenuApp {
  name: string
  appId: string
}

const startAppsSchema = z.union([
  z.array(z.object({ Name: z.string(), AppID: z.string() })),
  z.object({ Name: z.string(), AppID: z.string() }).transform((app) => [app]),
])

/** How long the list is kept: apps are installed rarely, and reading it takes over a second. */
const START_MENU_TTL_MS = 5 * 60_000

let cached: { at: number; apps: Promise<StartMenuApp[]> } | null = null

function readStartMenu(): Promise<StartMenuApp[]> {
  const script = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress'
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(error)
      try {
        resolve(startAppsSchema.parse(JSON.parse(stdout.trim() || '[]')).map((app) => ({ name: app.Name, appId: app.AppID })))
      } catch (parseError) {
        reject(parseError)
      }
    })
  })
}

/** The Start menu's apps, read again once the list is a few minutes old. */
export function startMenuApps(): Promise<StartMenuApp[]> {
  if (!cached || Date.now() - cached.at > START_MENU_TTL_MS) {
    const apps = readStartMenu()
    cached = { at: Date.now(), apps }
    apps.catch(() => { cached = null })
  }
  return cached.apps
}

/** For tests: forget the list read before. */
export function forgetStartMenu(): void {
  cached = null
}

/** The Start menu entry a launch name means: its display name or its id, in any case. */
export function findStartMenuApp(name: string, apps: readonly StartMenuApp[]): StartMenuApp | undefined {
  const wanted = name.trim().toLowerCase()
  return apps.find((app) => app.name.toLowerCase() === wanted)
    ?? apps.find((app) => app.appId.toLowerCase() === wanted)
    ?? apps.find((app) => sameApp(app.name, name, 'win32'))
}

/** Start an app through the shell, as the Start menu does. */
export function activateStartMenuApp(app: StartMenuApp): void {
  // explorer.exe hands the activation to the running shell and exits (with code 1): nothing to wait on.
  const child = spawn('explorer.exe', [`shell:AppsFolder\\${app.appId}`], { detached: true, stdio: 'ignore', windowsHide: true })
  child.on('error', () => { /* reported by the window that never comes */ })
  child.unref()
}

/** A window as the wait below reads it from `list-windows`. */
export interface ListedWindow {
  id: string
  app_name: string
  title?: string
  is_focused?: boolean
  minimized?: boolean
}

/** Windows of the shell itself, which an activation can show on its way to the app's own. */
const SHELL_IMAGES = ['explorer.exe', 'ShellExperienceHost.exe', 'StartMenuExperienceHost.exe', 'SearchHost.exe']

/** The process that owns every Store app's window frame. */
const FRAME_HOST = 'ApplicationFrameHost.exe'

/**
 * The window an activation brought up: a window that was not there before, or,
 * for an app already running (the shell brings it forward instead), one that
 * has taken focus. Null when none did before the time was up.
 */
export async function waitForActivatedWindow(
  before: readonly ListedWindow[],
  listWindows: () => Promise<ListedWindow[]>,
  timeoutMs: number,
  signal?: AbortSignal,
  pollMs = 250,
): Promise<ListedWindow | null> {
  const known = new Set(before.map((window) => window.id))
  const wasFocused = before.find((window) => window.is_focused)?.id
  const deadline = Date.now() + timeoutMs
  let framed: ListedWindow | null = null
  for (;;) {
    const windows = (await listWindows()).filter((window) => !window.minimized && !SHELL_IMAGES.some((image) => sameApp(image, window.app_name, 'win32')))
    const found = windows.find((window) => !known.has(window.id)) ?? windows.find((window) => window.is_focused && window.id !== wasFocused)
    // A Store app's frame shows before the app is in it, named for the frame
    // host every Store app shares: wait for the window to name its app.
    if (found && !sameApp(found.app_name, FRAME_HOST, 'win32')) return found
    if (found) framed = found
    if (Date.now() >= deadline || signal?.aborted) return framed
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}
