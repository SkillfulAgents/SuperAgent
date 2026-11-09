import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import type { KoffiFunc } from 'koffi'
import { webAuthResultSchema, type WebAuthResult } from './web-auth-session-schema'

/** Built by scripts/build-spotlight-bridge.sh from native/macos/WebAuthBridge.swift. */
const WEB_AUTH_BRIDGE_FILE = 'libWebAuthBridge.dylib'

function webAuthBridgePath(): string {
  const dir = app.isPackaged
    ? path.join(process.resourcesPath, 'web-auth-bridge')
    : path.join(app.getAppPath(), 'build', 'web-auth-bridge')
  return path.join(dir, WEB_AUTH_BRIDGE_FILE)
}

interface WebAuthBridge {
  start: KoffiFunc<(url: string, scheme: string) => string>
  cancel: KoffiFunc<() => void>
}

let bridge: Promise<WebAuthBridge | null> | null = null

function loadBridge(): Promise<WebAuthBridge | null> {
  bridge ??= (async () => {
    if (process.platform !== 'darwin') return null
    const file = webAuthBridgePath()
    if (!fs.existsSync(file)) return null
    try {
      // Imported here: koffi throws on import where it has no native addon.
      const { load } = await import('koffi')
      const lib = load(file)
      return {
        // `str!` frees the returned string after converting it.
        start: lib.func('str! web_auth_start(str url, str scheme)') as WebAuthBridge['start'],
        cancel: lib.func('void web_auth_cancel()') as WebAuthBridge['cancel'],
      }
    } catch (error) {
      console.error('[WebAuth] Failed to load the sign-in bridge:', error)
      return null
    }
  })()
  return bridge
}

/**
 * Whether `url` is the platform's own login page (`buildPlatformLoginUrl`), the
 * only page the sign-in sheet opens. The renderer supplies the URL, and a sheet
 * that reads as "sign in to Gamut" must not be pointed anywhere else.
 */
export function isPlatformLoginUrl(url: unknown, platformBaseUrl: string): url is string {
  if (typeof url !== 'string') return false
  try {
    const parsed = new URL(url)
    const base = new URL(platformBaseUrl)
    return parsed.origin === base.origin && parsed.pathname === '/auth/superagent'
  } catch {
    return false
  }
}

/** Decodes what the bridge returned; anything unexpected reads as an error. */
export function parseWebAuthResult(raw: unknown): WebAuthResult {
  if (typeof raw !== 'string') return { error: 'the sign-in session returned nothing' }
  try {
    const parsed = webAuthResultSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : { error: 'the sign-in session returned an unexpected result' }
  } catch {
    return { error: 'the sign-in session returned an unexpected result' }
  }
}

/**
 * Runs one sign-in in an ASWebAuthenticationSession sheet on the app's window
 * and resolves when it ends: with the callback URL the page reached on
 * `callbackScheme`, as cancelled, or with an error. Resolves null when there is
 * no bridge (not macOS, or a dev checkout that never built it), so the caller
 * can fall back to the browser.
 */
export async function runWebAuthSession(url: string, callbackScheme: string): Promise<WebAuthResult | null> {
  const loaded = await loadBridge()
  if (!loaded) return null
  return new Promise((resolve) => {
    // koffi runs it on a worker thread; the call returns when the sheet closes.
    loaded.start.async(url, callbackScheme, (err: unknown, raw: unknown) => {
      resolve(err ? { error: err instanceof Error ? err.message : String(err) } : parseWebAuthResult(raw))
    })
  })
}

/** Closes the sign-in sheet that is up, if any; its `runWebAuthSession` resolves cancelled. */
export async function cancelWebAuthSession(): Promise<void> {
  const loaded = await bridge
  loaded?.cancel()
}
