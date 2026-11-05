import { lazy } from 'react'

const RELOADED_VERSION_KEY = 'lazy_with_reload:version'

/** Fired on `window` just before the reload, so a view can save what it was opening. */
export const RELOADING_EVENT = 'lazy-with-reload:reloading'

// What a browser reports when a lazy file is gone: the router's three module messages, plus Vite's CSS preload.
const MISSING_FILE_MESSAGES = [
  'Failed to fetch dynamically imported module',
  'error loading dynamically imported module',
  'Importing a module script failed',
  'Unable to preload CSS for',
]

export function shouldReload(error: unknown, online: boolean, reloadedVersion: string | null, version: string): boolean {
  if (!online || reloadedVersion === version || !(error instanceof Error)) return false
  return MISSING_FILE_MESSAGES.some((message) => error.message.startsWith(message))
}

export function reloadOnMissingFile(error: unknown): Promise<never> {
  if (!shouldReload(error, navigator.onLine, sessionStorage.getItem(RELOADED_VERSION_KEY), __APP_VERSION__)) throw error
  sessionStorage.setItem(RELOADED_VERSION_KEY, __APP_VERSION__)
  window.dispatchEvent(new Event(RELOADING_EVENT))
  window.location.reload()
  return new Promise(() => {})
}

/** `lazy` that reloads once per build when the view's files are gone after an upgrade. */
export const lazyWithReload: typeof lazy = (importer) => lazy(() => importer().catch(reloadOnMissingFile))
