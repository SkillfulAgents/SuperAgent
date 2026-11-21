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
import { isTelegramTemporary } from '../chat-integrations/telegram-error'
import { collectEnvironmentData, probeEnvironmentData } from './environment'
import { background } from '../background'
import { APP_VERSION } from '../config/version'

function mapSeverity(level: SeverityLevel): Sentry.SeverityLevel {
  return level as Sentry.SeverityLevel
}

/**
 * Routes whose request bodies carry credentials: a sign-in form's values,
 * a secret, a password manager's verification code, an integration's tokens.
 * The HTTP integration buffers incoming bodies and attaches them to any event
 * captured while the request is handled; these never go along.
 */
export const CREDENTIAL_BODY_ROUTE = /\/sessions\/[^/?#]+\/(fill-login|fill-login-credential|provide-secret|browser-credentials\/verify)(?:[?#]|$)|\/api\/(agent|chat)-integrations(?:[/?#]|$)|\/api\/x-agent\/chat\/add(?:[?#]|$)/

/** Drop a captured request body from an event raised while handling a credential route. */
export function scrubCredentialRequestBody<T extends { request?: { url?: string; data?: unknown } }>(event: T): T {
  const url = event.request?.url
  if (url && CREDENTIAL_BODY_ROUTE.test(url) && event.request) delete event.request.data
  return event
}

/** A Telegram bot token, `<bot id>:<secret>`, bare or inside an API URL's `bot<token>` segment. */
const TELEGRAM_BOT_TOKEN = /(\d{6,}):[\w-]{30,}/g

/** The text with every Telegram bot token's secret replaced; the bot id stays. */
export function redactBotTokens(text: string): string {
  return text.replace(TELEGRAM_BOT_TOKEN, '$1:[redacted]')
}

/** A signed file URL's token (`/api/signed-files/<token>`): the path segment is the credential. */
const SIGNED_FILE_TOKEN = /(\/api\/signed-files\/)[^/?#\s"'<>]+/g

/** The text with every signed file URL's token replaced. */
export function redactSignedFileTokens(text: string): string {
  return text.replace(SIGNED_FILE_TOKEN, '$1[redacted]')
}

/** Every credential this module looks for in a string, redacted. */
function redactCredentials(text: string): string {
  return redactSignedFileTokens(redactBotTokens(text))
}

/** Redact credentials in every string of an event the SDK is about to send (the request's URL among them). */
function redactCredentialsInEvent<T extends object>(event: T): T {
  for (const [key, value] of Object.entries(event)) {
    if (typeof value === 'string') Reflect.set(event, key, redactCredentials(value))
    else if (value && typeof value === 'object') redactCredentialsInEvent(value)
  }
  return event
}

/** Redact credentials in a breadcrumb; a console breadcrumb's raw arguments go, its message holds their text. */
function scrubBreadcrumb(breadcrumb: Sentry.Breadcrumb): Sentry.Breadcrumb {
  const data = breadcrumb.data && { ...breadcrumb.data }
  if (data) {
    if (breadcrumb.category === 'console') delete data.arguments
    if (typeof data.url === 'string') data.url = redactCredentials(data.url)
  }
  return { ...breadcrumb, message: breadcrumb.message && redactCredentials(breadcrumb.message), data }
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
    // Structured logs bypass beforeSend; preserve the existing collection policy.
    enableLogs: false,
    // Keep AI spans on the existing transaction path, not the new standalone stream.
    streamGenAiSpans: false,
    integrations: (defaults) => [
      ...defaults.filter((integration) => integration.name !== 'Http'),
      Sentry.httpIntegration({
        ignoreIncomingRequestBody: (url) => CREDENTIAL_BODY_ROUTE.test(url),
      }),
    ],
    // Consent is read fresh for every event, never from an earlier read.
    async beforeSend(event, hint) {
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
      // A throw here makes the SDK send its own report, unscrubbed; dropping the event is safe.
      try {
        // Telegram being busy or unreachable is reported as a warning.
        if (isTelegramTemporary(hint.originalException)) event.level = 'warning'
        return redactCredentialsInEvent(scrubCredentialRequestBody(event))
      } catch {
        return null
      }
    },
    // The SDK's own failure reports skip beforeSend but carry the breadcrumbs. A throw
    // here would reach whatever recorded the breadcrumb.
    beforeBreadcrumb(breadcrumb) {
      try {
        return scrubBreadcrumb(breadcrumb)
      } catch {
        return null
      }
    },
  })

  // Attach the environment fingerprint: what the process knows itself now, so
  // a report from an early failure has it, and what another program has to
  // answer once it does. Nothing here spawns synchronously.
  try {
    const envData = collectEnvironmentData()
    Sentry.setContext('environment_info', envData)
    background(async () => {
      const probed = await probeEnvironmentData()
      if (Object.keys(probed).length > 0) Sentry.setContext('environment_info', { ...envData, ...probed })
    }, { name: 'error-reporting.environment-probe' })
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
