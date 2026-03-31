/**
 * Computer Use Executor
 *
 * Wraps the @skillful-agents/agent-computer SDK to execute commands on the host machine.
 * Used by both the message-persister (auto-execute path) and the API endpoint.
 */

import { AC, formatOutput } from '@skillful-agents/agent-computer'
import * as fs from 'fs'
import { createRequire } from 'module'
import * as path from 'path'
import { platform, arch } from 'os'

let acInstance: AC | null = null

/**
 * Resolve the ac-core binary path, rewriting asar paths for packaged Electron apps.
 * In packaged apps, node_modules live inside app.asar (a virtual FS). child_process.spawn
 * can't execute from inside asar, but asarUnpack extracts binaries to app.asar.unpacked.
 */
function resolveACBinaryPath(): string {
  const require = createRequire(import.meta.url)
  // Resolve the main entry point, then walk up to the package root
  const acEntry = require.resolve('@skillful-agents/agent-computer')
  // Entry is at <pkg>/dist/src/index.js — dirname gives dist/src, walk up 2 levels
  const acPkgDir = path.resolve(path.dirname(acEntry), '..', '..')
  const ext = platform() === 'win32' ? '.exe' : ''
  const key = `${platform()}-${arch() === 'arm64' ? 'arm64' : 'x64'}`
  const binaryPath = path.join(acPkgDir, 'bin', `ac-core-${key}${ext}`)
  return binaryPath.replace('app.asar', 'app.asar.unpacked')
}

function getAC(): AC {
  if (!acInstance) {
    acInstance = new AC({ binaryPath: resolveACBinaryPath() })
  }
  return acInstance
}

/**
 * Execute an AC command and return the formatted result as a string.
 */
export async function executeComputerUseCommand(
  method: string,
  params: Record<string, unknown>,
): Promise<string> {
  const ac = getAC()
  const result = await dispatchMethod(ac, method, params)
  return formatResult(method, result)
}

/**
 * Dispatch an AC SDK method call based on the method name.
 */
async function dispatchMethod(
  ac: AC,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (method) {
    // --- Observation ---
    case 'apps':
      return ac.apps()
    case 'windows':
      return ac.windows(params.app as string | undefined)
    case 'snapshot':
      return ac.snapshot({
        app: params.app as string | undefined,
        interactive: params.interactive as boolean | undefined,
        compact: params.compact as boolean | undefined,
        depth: params.depth as number | undefined,
      })
    case 'find':
      return ac.find(
        params.text as string,
        {
          role: params.role as string | undefined,
          app: params.app as string | undefined,
        },
      )
    case 'screenshot':
      return ac.screenshot({
        ref: params.ref as string | undefined,
      })
    case 'read':
      return ac.read(params.ref as string)
    case 'status':
      return ac.status()
    case 'displays':
      return ac.displays()
    case 'permissions':
      return ac.permissions()

    // --- Actions ---
    case 'click':
      return ac.click(
        params.ref as string,
        {
          right: params.right as boolean | undefined,
          double: params.double as boolean | undefined,
        },
      )
    case 'type':
      return ac.type(params.text as string)
    case 'fill':
      return ac.fill(params.ref as string, params.text as string)
    case 'key':
      return ac.key(params.combo as string, params.repeat as number | undefined)
    case 'scroll':
      return ac.scroll(
        params.direction as 'up' | 'down' | 'left' | 'right',
        {
          amount: params.amount as number | undefined,
          on: params.on as string | undefined,
        },
      )
    case 'select':
      return ac.select(params.ref as string, params.value as string)
    case 'hover':
      return ac.hover(params.ref as string)

    // --- App management ---
    case 'launch': {
      try {
        await ac.launch(params.name as string, { wait: true })
      } catch (launchErr: unknown) {
        const msg = launchErr instanceof Error ? launchErr.message : String(launchErr)
        // CDP errors mean the app is running but CDP (needed for Electron/Chromium apps)
        // couldn't connect — likely because the app was already open without CDP enabled.
        if (msg.includes('CDP')) {
          return {
            ok: false,
            launched: params.name,
            error: msg,
            hint: `The app "${params.name}" appears to be an Electron/Chromium app that was already running without CDP (remote debugging) enabled. `
              + `To fix this, use computer_run("relaunch", { name: "${params.name}" }) which will force-quit and relaunch the app with CDP enabled. `
              + `IMPORTANT: Ask the user for permission before relaunching, as it will force-quit the app and any unsaved work may be lost.`,
          }
        }
        throw launchErr
      }
      // Auto-grab the launched app so subsequent commands target it
      // and the user sees a visual halo indicating AI control.
      // Non-fatal: if grab fails (e.g., window not yet registered), launch still succeeds.
      let grabbed = false
      let snapshot: unknown = null
      try {
        await ac.grab(params.name as string)
        grabbed = true
        snapshot = await ac.snapshot({ interactive: true, compact: true })
      } catch {
        // Window may not be registered yet — agent can grab manually later
      }
      return snapshot
        ? { ok: true, launched: params.name, grabbed, snapshot: formatOutput(snapshot, true) }
        : { ok: true, launched: params.name, grabbed }
    }
    case 'relaunch': {
      await ac.relaunch(params.name as string, { wait: true })
      // Auto-grab after relaunch (same as launch)
      let grabbed = false
      let snapshot: unknown = null
      try {
        await ac.grab(params.name as string)
        grabbed = true
        snapshot = await ac.snapshot({ interactive: true, compact: true })
      } catch {
        // Window may not be registered yet
      }
      return snapshot
        ? { ok: true, relaunched: params.name, grabbed, snapshot: formatOutput(snapshot, true) }
        : { ok: true, relaunched: params.name, grabbed }
    }
    case 'quit':
      await ac.quit(params.name as string, {
        force: params.force as boolean | undefined,
      })
      return { ok: true, quit: params.name }
    case 'grab': {
      await ac.grab((params.app || params.ref) as string)
      // Auto-snapshot after grab to save a round-trip
      let snapshot: unknown = null
      try {
        snapshot = await ac.snapshot({ interactive: true, compact: true })
      } catch {
        // Non-fatal — agent can snapshot manually
      }
      const target = params.app || params.ref
      return snapshot
        ? { ok: true, grabbed: target, snapshot: formatOutput(snapshot, true) }
        : { ok: true, grabbed: target }
    }
    case 'ungrab':
      await ac.ungrab()
      return { ok: true, ungrabbed: true }

    // --- Menus ---
    case 'menuClick':
      await ac.menuClick(params.path as string, params.app as string | undefined)
      return { ok: true, clicked: params.path }

    // --- Dialogs ---
    case 'dialog': {
      const action = params.action as string | undefined
      if (action === 'accept') {
        await ac.dialogAccept(params.app as string | undefined)
        return { ok: true, action: 'accepted' }
      } else if (action === 'cancel') {
        await ac.dialogCancel(params.app as string | undefined)
        return { ok: true, action: 'cancelled' }
      } else {
        return ac.dialog(params.app as string | undefined)
      }
    }

    default:
      throw new Error(`Unknown computer use method: ${method}`)
  }
}

/**
 * Format the result of an AC command into a string suitable for the agent.
 * Uses the SDK's built-in text formatter for token efficiency.
 * Screenshots are special-cased to return base64 JSON for image blocks.
 */
function formatResult(method: string, result: unknown): string {
  if (result === undefined || result === null) {
    return `${method} completed successfully.`
  }

  // Screenshots return a file path — read and return as base64 image reference
  if (method === 'screenshot' && typeof result === 'object' && result !== null) {
    const screenshotResult = result as { path?: string; width?: number; height?: number }
    if (screenshotResult.path) {
      try {
        const imageData = fs.readFileSync(screenshotResult.path)
        // Clean up the temp file now that we've read it
        try { fs.unlinkSync(screenshotResult.path) } catch { /* best effort */ }
        const base64 = imageData.toString('base64')
        return JSON.stringify({
          type: 'screenshot',
          path: screenshotResult.path,
          width: screenshotResult.width,
          height: screenshotResult.height,
          base64,
          media_type: 'image/png',
        })
      } catch {
        return JSON.stringify(screenshotResult)
      }
    }
  }

  if (typeof result === 'string') return result
  return formatOutput(result, true)
}

/**
 * Look up which app owns a window reference by querying the AC daemon.
 * Returns the app name or undefined if the window can't be found.
 */
export async function resolveAppFromWindowRef(ref: string): Promise<string | undefined> {
  try {
    const ac = getAC()
    const { windows } = await ac.windows()
    const match = windows.find((w) => w.ref === ref)
    return match?.app
  } catch {
    return undefined
  }
}

/**
 * Ungrab any currently grabbed window. Safe to call even if nothing is grabbed.
 */
export async function ungrabAC(): Promise<void> {
  if (acInstance) {
    try {
      await acInstance.ungrab()
    } catch {
      // Ignore — nothing may be grabbed
    }
  }
}

/**
 * Ungrab + shut down the AC daemon. Call on app exit.
 */
export async function shutdownAC(): Promise<void> {
  if (acInstance) {
    try {
      await acInstance.ungrab()
    } catch {
      // Ignore ungrab errors
    }
    try {
      await acInstance.shutdown()
    } catch {
      // Ignore shutdown errors
    }
    acInstance = null
  }
}
