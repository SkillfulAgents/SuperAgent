import type { ErrorReportingProvider, ErrorReportingInitOptions, ErrorContext, ErrorReportingUser, Breadcrumb } from './types'
// To switch providers, change this import to a different provider module:
import { createServerProvider } from './sentry-provider'

export type { ErrorReportingProvider, ErrorReportingInitOptions, ErrorContext, ErrorReportingUser, Breadcrumb, SeverityLevel } from './types'

let provider: ErrorReportingProvider | null = null

/**
 * Initialize error reporting for the server/main process.
 *
 * Call once at startup. Subsequent calls are no-ops (safe for multi-init paths
 * like Electron main -> startup.ts).
 */
export function initErrorReporting(options: ErrorReportingInitOptions): void {
  if (provider) return
  try {
    provider = createServerProvider(options)
  } catch (err) {
    console.warn('[ErrorReporting] Failed to initialize:', err)
  }
}

export function getErrorReporter(): ErrorReportingProvider | null {
  return provider
}

/**
 * All public functions below are safe to call from catch blocks —
 * they never throw, so error reporting can never turn a soft failure
 * into a crash.
 */

export function captureException(error: unknown, context?: ErrorContext): string | undefined {
  try { return provider?.captureException(error, context) } catch { return undefined }
}

export function captureMessage(message: string, context?: ErrorContext): string | undefined {
  try { return provider?.captureMessage(message, context) } catch { return undefined }
}

export function setErrorReportingUser(user: ErrorReportingUser | null): void {
  try { provider?.setUser(user) } catch { /* never crash */ }
}

export function addErrorBreadcrumb(breadcrumb: Breadcrumb): void {
  try { provider?.addBreadcrumb(breadcrumb) } catch { /* never crash */ }
}

export function setErrorContext(name: string, context: Record<string, unknown>): void {
  try { provider?.setContext(name, context) } catch { /* never crash */ }
}

export function setErrorTag(key: string, value: string): void {
  try { provider?.setTag(key, value) } catch { /* never crash */ }
}

export function flushErrorReporting(timeoutMs?: number): Promise<boolean> {
  try { return provider?.flush(timeoutMs) ?? Promise.resolve(true) } catch { return Promise.resolve(false) }
}
