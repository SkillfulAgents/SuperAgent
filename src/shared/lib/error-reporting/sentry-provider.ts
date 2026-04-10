/**
 * Sentry implementation of ErrorReportingProvider for the server/main process.
 *
 * This file is the ONLY place that imports @sentry/node. To switch to a
 * different provider (e.g., Datadog, Bugsnag), create a new file that
 * exports `createServerProvider` with the same signature and update the
 * import in index.ts.
 */

import * as Sentry from '@sentry/node'
import type { ErrorReportingProvider, ErrorReportingInitOptions, ErrorContext, ErrorReportingUser, Breadcrumb, SeverityLevel } from './types'
import { ERROR_REPORTING_INGEST_URL } from './config'
import { getSettings } from '../config/settings'
import { collectEnvironmentData } from './environment'
import { getTenantId } from '../analytics/tenant-id'
import { APP_VERSION } from '../config/version'

function mapSeverity(level: SeverityLevel): Sentry.SeverityLevel {
  return level as Sentry.SeverityLevel
}

/**
 * Create and initialize the server-side error reporting provider.
 *
 * Handles SDK init, tenant identification, and environment fingerprinting.
 * Called by the abstraction layer (index.ts) — never by entry points directly.
 */
export function createServerProvider(options: ErrorReportingInitOptions): ErrorReportingProvider {
  Sentry.init({
    dsn: ERROR_REPORTING_INGEST_URL,
    environment: options.environment,
    release: APP_VERSION,
    tracesSampleRate: 0,
    beforeSend(event) {
      try {
        const settings = getSettings()
        if (settings.shareErrorReports === false) {
          return null
        }
      } catch {
        // If we can't load settings, allow the event (fail-open for crash reports)
      }
      return event
    },
  })

  // Set tenant ID as the default user so all events are attributable
  try {
    Sentry.setUser({ id: getTenantId() })
  } catch {
    // Non-critical — events will still be sent, just without tenant ID
  }

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
      Sentry.setUser({ id: getTenantId() })
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
