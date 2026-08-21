import { createBrowserHistory, createHashHistory, type RouterHistory } from '@tanstack/react-router'
import { isElectron } from '@renderer/lib/env'

/**
 * Per-platform history. `__WEB__` is a compile-time define — `true` in
 * vite.config.ts, `false` in electron.vite.config.ts — so each bundle ships
 * exactly one branch and there is no first-render `window.electronAPI` race.
 *
 * - Web (Hono SPA fallback at server.ts) → browser/path history.
 * - ALL Electron (file:// prod AND http dev) → hash history, so the document URL
 *   stays pinned to the real index.html (path history 404s a file:// reload and
 *   breaks relative `./assets/...`).
 *
 * Two per-target defines, NOT a shared constant (decided 2026-06-15): the value
 * is intrinsic to which config builds the bundle, so there is nothing to
 * "share". The drift risk (both true / both false → Electron gets browser
 * history → blank window on file:// reload, slipping past typecheck) is closed
 * by the runtime tripwire below, which fires loudly at startup however the drift
 * arose — strictly more robust than centralizing the literal.
 */
export function createAppHistory(): RouterHistory {
  if (__WEB__ !== !isElectron()) {
    throw new Error(`__WEB__ (${__WEB__}) disagrees with runtime isElectron() — build-define drift`)
  }
  return __WEB__ ? createBrowserHistory() : createHashHistory()
}
