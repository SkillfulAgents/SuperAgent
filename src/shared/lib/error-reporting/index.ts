import type { ErrorReportingProvider, ErrorContext, ErrorReportingUser, Breadcrumb } from './types'

export type { ErrorReportingProvider, ErrorReportingInitOptions, ErrorContext, ErrorReportingUser, Breadcrumb, SeverityLevel } from './types'

let provider: ErrorReportingProvider | null = null

/**
 * Sets the process's error reporter. Each entry point creates the one its runtime can run
 * (Electron and the web server: `createServerProvider`) and passes it here, once, at startup;
 * null (a reporter that could not start) leaves reporting off. Later calls are no-ops.
 */
export function initErrorReporting(reporter: ErrorReportingProvider | null): void {
  provider ??= reporter
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

/**
 * Attach what reports need from the database: the tenant id (the user of
 * events with no signed-in user) and the settings part of the environment
 * fingerprint. Error reporting starts before the database opens so a failed
 * boot can still be reported; the entry point calls this once app records are
 * installed. Never throws.
 */
export async function attachErrorReportingIdentity(): Promise<void> {
  if (!provider) return
  try {
    const [{ getTenantId }, { getSettings }, { collectSettingsEnvironmentData }] = await Promise.all([
      import('../analytics/tenant-id'),
      import('../config/settings'),
      import('./environment'),
    ])
    provider.setTenantId(await getTenantId())
    provider.setContext('environment_settings', collectSettingsEnvironmentData(await getSettings()))
  } catch (err) {
    console.warn('[ErrorReporting] Could not attach the tenant identity:', err)
  }
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
