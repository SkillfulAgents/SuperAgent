import type { ErrorReportingProvider, ErrorContext, ErrorReportingUser, Breadcrumb } from './types'
import { background } from '../background'

export type { ErrorReportingProvider, ErrorReportingInitOptions, ErrorContext, ErrorReportingUser, Breadcrumb, SeverityLevel } from './types'

let provider: ErrorReportingProvider | null = null
/** Whether {@link attachErrorReportingIdentity} has already given the provider the tenant id and settings context. */
let identityAttached = false

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
 *
 * What the process knows itself is attached before this returns. The disk
 * space and the container runner's version need the file system and another
 * program, so they follow in the background and startup does not wait for
 * them. Once it has succeeded, a later call does nothing: `initializeServices`
 * calls it again for a reporter whose first attempt failed.
 */
export async function attachErrorReportingIdentity(): Promise<void> {
  const reporter = provider
  if (!reporter || identityAttached) return
  try {
    const [{ getTenantId }, { getSettings }, { collectSettingsEnvironmentData, probeSettingsEnvironmentData }] = await Promise.all([
      import('../analytics/tenant-id'),
      import('../config/settings'),
      import('./environment'),
    ])
    reporter.setTenantId(await getTenantId())
    const settings = await getSettings()
    const known = collectSettingsEnvironmentData(settings)
    reporter.setContext('environment_settings', known)
    identityAttached = true
    background(async () => {
      const probed = await probeSettingsEnvironmentData(settings)
      reporter.setContext('environment_settings', { ...known, ...probed })
    }, { name: 'error-reporting.settings-environment-probe' })
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
