/**
 * Sentry implementation of ErrorReportingProvider for the server/main process.
 *
 * This file is the ONLY place that imports @sentry/node. To switch to a
 * different provider (e.g., Datadog, Bugsnag), create a new file that
 * creates an ErrorReportingProvider and pass it to `initErrorReporting`
 * from the entry points.
 */

import * as Sentry from '@sentry/node'
import type { ErrorReportingProvider, ErrorReportingInitOptions, ErrorContext, ErrorReportingUser, Breadcrumb, SeverityLevel } from './types'
import { ERROR_REPORTING_INGEST_URL } from './config'
import { collectEnvironmentData } from './environment'
import { APP_VERSION } from '../config/version'

function mapSeverity(level: SeverityLevel): Sentry.SeverityLevel {
  return level as Sentry.SeverityLevel
}

/**
 * Routes whose request bodies carry credentials: a sign-in form's values,
 * a secret, a password manager's verification code. The HTTP integration
 * buffers incoming bodies and attaches them to any event captured while the
 * request is handled; these never go along.
 */
export const CREDENTIAL_BODY_ROUTE = /\/sessions\/[^/?#]+\/(fill-login|fill-login-credential|provide-secret|browser-credentials\/verify)(?:[?#]|$)/

/** Drop a captured request body from an event raised while handling a credential route. */
export function scrubCredentialRequestBody<T extends { request?: { url?: string; data?: unknown } }>(event: T): T {
  const url = event.request?.url
  if (url && CREDENTIAL_BODY_ROUTE.test(url) && event.request) delete event.request.data
  return event
}

/**
 * Create and initialize the server-side error reporting provider.
 *
 * Handles SDK init, tenant identification, and environment fingerprinting.
 * Entry points pass it to `initErrorReporting`. Null when the SDK could not start.
 */
export function createServerProvider(options: ErrorReportingInitOptions): ErrorReportingProvider | null {
  try {
    return startServerProvider(options)
  } catch (err) {
    console.warn('[ErrorReporting] Failed to initialize:', err)
    return null
  }
}

function startServerProvider(options: ErrorReportingInitOptions): ErrorReportingProvider {
  Sentry.init({
    dsn: ERROR_REPORTING_INGEST_URL,
    environment: options.environment,
    release: APP_VERSION,
    tracesSampleRate: 0,
    integrations: (defaults) => [
      ...defaults.filter((integration) => integration.name !== 'Http'),
      Sentry.httpIntegration({
        ignoreIncomingRequestBody: (url) => CREDENTIAL_BODY_ROUTE.test(url),
      }),
    ],
    // Consent is read fresh for every event, never from an earlier read.
    async beforeSend(event) {
      try {
        // Loaded here, not at the top: error reporting is part of the
        // database's boot graph, and settings reads go through the database.
        const { getSettings } = await import('../config/settings')
        const settings = await getSettings()
        if (settings.shareErrorReports === false) {
          return null
        }
      } catch {
        // Settings unreadable, or not available yet (a boot failure before the
        // database opened): allow the event (fail-open for crash reports).
      }
      return scrubCredentialRequestBody(event)
    },
  })

  // Collect and attach environment fingerprint data
  try {
    const envData = collectEnvironmentData()
    Sentry.setContext('environment_info', envData)
  } catch {
    // Non-critical
  }

  return new SentryServerProvider()
}

class SentryServerProvider implements ErrorReportingProvider {
  /** The deployment's tenant id once the entry point attached it; events before that have no user. */
  private tenantId: string | null = null

  setTenantId(tenantId: string): void {
    this.tenantId = tenantId
    // The default user, so every event is attributable to the deployment.
    Sentry.setUser({ id: tenantId })
  }
  captureException(error: unknown, context?: ErrorContext): string | undefined {
    return Sentry.captureException(error, {
      tags: context?.tags,
      extra: context?.extra,
      fingerprint: context?.fingerprint,
      level: context?.level ? mapSeverity(context.level) : undefined,
    })
  }

  captureMessage(message: string, context?: ErrorContext): string | undefined {
    return Sentry.captureMessage(message, {
      tags: context?.tags,
      extra: context?.extra,
      fingerprint: context?.fingerprint,
      level: context?.level ? mapSeverity(context.level) : undefined,
    })
  }

  setUser(user: ErrorReportingUser | null): void {
    if (user) {
      Sentry.setUser({ id: user.id, email: user.email })
    } else {
      Sentry.setUser(this.tenantId ? { id: this.tenantId } : null)
    }
  }

  addBreadcrumb(breadcrumb: Breadcrumb): void {
    Sentry.addBreadcrumb({
      category: breadcrumb.category,
      message: breadcrumb.message,
      level: breadcrumb.level ? mapSeverity(breadcrumb.level) : undefined,
      data: breadcrumb.data,
    })
  }

  setContext(name: string, context: Record<string, unknown>): void {
    Sentry.setContext(name, context)
  }

  setTag(key: string, value: string): void {
    Sentry.setTag(key, value)
  }

  async flush(timeoutMs = 5000): Promise<boolean> {
    return Sentry.flush(timeoutMs)
  }
}
