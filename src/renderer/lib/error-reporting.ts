/**
 * Error reporting for the renderer process.
 *
 * This file is the ONLY place that loads @sentry/browser. To switch to a
 * different provider, replace the internals — callers never see Sentry.
 *
 * All exported functions are safe to call anywhere — they never throw,
 * so error reporting can never turn a soft failure into a crash.
 */

import { ERROR_REPORTING_INGEST_URL } from '@shared/lib/error-reporting/config'
import type { Breadcrumb, ErrorReportingUser } from '@shared/lib/error-reporting/types'
import { isElectron } from './env'

let errorReportingEnabled = true // null/undefined means true — default on for existing users
let errorReportingUser: ErrorReportingUser | null = null
let sentry: typeof import('./sentry-browser-provider') | null = null
let sentryLoad: Promise<typeof import('./sentry-browser-provider') | null> | null = null

function applyUser(provider: typeof import('./sentry-browser-provider')): void {
  try {
    provider.setUser(errorReportingUser
      ? { id: errorReportingUser.id, email: errorReportingUser.email }
      : null)
  } catch { /* never crash */ }
}

function loadSentry(): Promise<typeof import('./sentry-browser-provider') | null> {
  if (import.meta.env.DEV) return Promise.resolve(null)
  if (sentryLoad) return sentryLoad

  sentryLoad = import('./sentry-browser-provider')
    .then((provider) => {
      provider.init({
        dsn: ERROR_REPORTING_INGEST_URL,
        environment: isElectron() ? 'electron-renderer' : 'web',
        release: __APP_VERSION__,
        tracesSampleRate: 0,
        beforeSend(event) {
          if (!errorReportingEnabled) return null
          return event
        },
      })
      sentry = provider
      applyUser(provider)
      return provider
    })
    .catch((err) => {
      console.warn('[ErrorReporting] Failed to initialize renderer:', err)
      return null
    })
  return sentryLoad
}

export function initRendererErrorReporting(): void {
  // Start loading early, but never put the provider on the renderer's static
  // boot graph or make first render await it.
  void loadSentry()
}

export function setRendererErrorReportingEnabled(enabled: boolean): void {
  errorReportingEnabled = enabled
}

export function setRendererErrorReportingUser(user: ErrorReportingUser | null): void {
  errorReportingUser = user
  if (sentry) applyUser(sentry)
}

/**
 * Report a caught exception to Sentry from the renderer.
 *
 * Safe to call from anywhere (including error-boundary lifecycles) — it never
 * throws, and is a no-op in dev where Sentry is intentionally not initialized.
 */
export function captureRendererException(
  error: unknown,
  context?: {
    tags?: Record<string, string>
    extra?: Record<string, unknown>
    fingerprint?: string[]
  }
): void {
  void loadSentry().then((provider) => {
    if (!provider) return
    try {
      provider.captureException(error, {
        tags: context?.tags,
        extra: context?.extra,
        fingerprint: context?.fingerprint,
      })
    } catch { /* never crash */ }
  }).catch(() => {
    // loadSentry already degrades provider failures; this is defense-in-depth
    // against a future implementation changing that contract.
  })
}

/** Add a pre-sanitized renderer breadcrumb without exposing the provider. */
export function addRendererBreadcrumb(breadcrumb: Breadcrumb): void {
  void loadSentry().then((provider) => {
    if (!provider) return
    try {
      provider.addBreadcrumb(breadcrumb)
    } catch { /* never crash */ }
  }).catch(() => {})
}
