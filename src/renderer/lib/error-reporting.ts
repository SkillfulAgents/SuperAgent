/**
 * Error reporting for the renderer process.
 *
 * This file is the ONLY place that imports @sentry/browser. To switch to a
 * different provider, replace the internals — callers never see Sentry.
 *
 * All exported functions are safe to call anywhere — they never throw,
 * so error reporting can never turn a soft failure into a crash.
 */

import * as Sentry from '@sentry/browser'
import { ERROR_REPORTING_INGEST_URL } from '@shared/lib/error-reporting/config'
import type { ErrorReportingUser } from '@shared/lib/error-reporting/types'
import { isElectron } from './env'

let errorReportingEnabled = true // null/undefined means true — default on for existing users

export function initRendererErrorReporting(): void {
  try {
    Sentry.init({
      dsn: ERROR_REPORTING_INGEST_URL,
      environment: isElectron() ? 'electron-renderer' : 'web',
      release: __APP_VERSION__,
      tracesSampleRate: 0,
      beforeSend(event) {
        if (!errorReportingEnabled) return null
        return event
      },
    })
  } catch (err) {
    console.warn('[ErrorReporting] Failed to initialize renderer:', err)
  }
}

export function setRendererErrorReportingEnabled(enabled: boolean): void {
  errorReportingEnabled = enabled
}

export function setRendererErrorReportingUser(user: ErrorReportingUser | null): void {
  try {
    if (user) {
      Sentry.setUser({ id: user.id, email: user.email })
    } else {
      Sentry.setUser(null)
    }
  } catch { /* never crash */ }
}
