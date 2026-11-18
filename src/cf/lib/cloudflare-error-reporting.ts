/**
 * Error reporting on Cloudflare, next to sentry-provider.ts for Electron and the web server. The
 * Sentry Node SDK does not run in a Worker, so each report goes to the same ingest endpoint from
 * here, as one envelope. The send is background work, so the request that reported it stays alive
 * until it is out.
 *
 * One isolate serves many signed-in users at the same time, so nothing about a user or a request
 * is kept between calls: a report carries the deployment's tenant id, its tags and its contexts.
 */
import { background } from '@shared/lib/background'
import { APP_VERSION } from '@shared/lib/config/version'
import { attachErrorReportingIdentity } from '@shared/lib/error-reporting'
import { ERROR_REPORTING_INGEST_URL } from '@shared/lib/error-reporting/config'
import type { ErrorContext, ErrorReportingInitOptions, ErrorReportingProvider, SeverityLevel } from '@shared/lib/error-reporting/types'

export interface CloudflareErrorReporterOptions extends ErrorReportingInitOptions {
  /** Where reports go; the app's ingest endpoint by default. */
  ingestUrl?: string
  /** Sends one envelope; `fetch` by default. */
  send?: (url: string, init: RequestInit) => Promise<Response>
  /** False when the org turned error reports off; read for every report. The org's setting by default. */
  allowed?: () => Promise<boolean>
  /** Gives the reporter the tenant id and the settings context once the database can be read. */
  identify?: () => Promise<void>
}

const MAX_CAUSES = 3
const FRAME = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/

/** The reporter for this isolate, or null when it could not be made. Entry points pass it to `initErrorReporting`. */
export function createCloudflareErrorReporter(options: CloudflareErrorReporterOptions): ErrorReportingProvider | null {
  try {
    return new CloudflareErrorReporter(options)
  } catch (error) {
    console.warn('[ErrorReporting] Failed to initialize:', error)
    return null
  }
}

class CloudflareErrorReporter implements ErrorReportingProvider {
  private readonly endpoint: string
  private readonly auth: string
  private readonly tags = new Map<string, string>()
  private readonly contexts = new Map<string, Record<string, unknown>>()
  private readonly sending = new Set<Promise<void>>()
  private tenantId: string | null = null

  constructor(private readonly options: CloudflareErrorReporterOptions) {
    const ingest = new URL(options.ingestUrl ?? ERROR_REPORTING_INGEST_URL)
    this.endpoint = `${ingest.protocol}//${ingest.host}/api/${ingest.pathname.replace(/^\/+/, '')}/envelope/`
    this.auth = `Sentry sentry_version=7, sentry_client=superagent-cloudflare, sentry_key=${ingest.username}`
  }

  captureException(error: unknown, context?: ErrorContext): string {
    return this.report({ exception: { values: exceptionValues(error) } }, context, 'error')
  }

  captureMessage(message: string, context?: ErrorContext): string {
    return this.report({ message }, context, 'info')
  }

  // Not kept: the next call in this isolate can belong to another user.
  setUser(): void {}

  setTenantId(tenantId: string): void {
    this.tenantId = tenantId
  }

  // Not kept, as a user is not: a later report could carry another request's trail.
  addBreadcrumb(): void {}

  setContext(name: string, context: Record<string, unknown>): void {
    this.contexts.set(name, context)
  }

  setTag(key: string, value: string): void {
    this.tags.set(key, value)
  }

  async flush(timeoutMs = 5000): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs)
    })
    const sent = Promise.all([...this.sending]).then(() => true)
    return Promise.race([sent, timedOut]).finally(() => clearTimeout(timer))
  }

  private report(body: Record<string, unknown>, context: ErrorContext | undefined, level: SeverityLevel): string {
    const eventId = crypto.randomUUID().replaceAll('-', '')
    const event = {
      event_id: eventId,
      timestamp: Date.now() / 1000,
      platform: 'javascript',
      level: context?.level ?? level,
      environment: this.options.environment,
      release: APP_VERSION,
      tags: { ...Object.fromEntries(this.tags), ...context?.tags },
      extra: context?.extra,
      fingerprint: context?.fingerprint,
      ...body,
    }
    // Never rejects: a report that cannot be sent must not become a failure of its own.
    const sending: Promise<void> = this.send(event).catch(() => {}).finally(() => this.sending.delete(sending))
    this.sending.add(sending)
    background(sending, { name: 'error-reporting.send' })
    return eventId
  }

  private async send(event: Record<string, unknown>): Promise<void> {
    // A report before the database opened (a failed boot) goes out without the tenant; a later one asks again.
    if (!this.tenantId) await (this.options.identify ?? attachErrorReportingIdentity)()
    if (!(await (this.options.allowed ?? reportsAllowed)())) return
    const full = { ...event, user: this.tenantId ? { id: this.tenantId } : undefined, contexts: Object.fromEntries(this.contexts) }
    const envelope = [{ event_id: event.event_id, sent_at: new Date().toISOString() }, { type: 'event' }, full].map(jsonLine).join('')
    const response = await (this.options.send ?? fetch)(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-sentry-envelope', 'x-sentry-auth': this.auth },
      body: envelope,
    })
    await response.body?.cancel()
  }
}

/** The org's consent, read for every report. Settings that cannot be read allow it, so a failed boot is reported. */
async function reportsAllowed(): Promise<boolean> {
  try {
    // Loaded here, not at the top: error reporting is part of the database's boot graph, and settings are read through the database.
    const { getSettings } = await import('@shared/lib/config/settings')
    return (await getSettings()).shareErrorReports !== false
  } catch {
    return true
  }
}

/** The error and its causes, the first cause first, as the ingest endpoint reads a chain. */
function exceptionValues(error: unknown): Record<string, unknown>[] {
  const chain: unknown[] = []
  for (let current = error; chain.length <= MAX_CAUSES && current !== undefined && current !== null; current = current instanceof Error ? current.cause : undefined) {
    chain.push(current)
  }
  return chain.reverse().map((item) => {
    if (!(item instanceof Error)) return { type: 'Error', value: typeof item === 'string' ? item : jsonText(item) }
    return { type: item.name, value: item.message, stacktrace: { frames: stackFrames(item.stack) } }
  })
}

/** The stack's frames, the caller first. */
function stackFrames(stack: string | undefined): Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = []
  for (const line of (stack ?? '').split('\n')) {
    const match = FRAME.exec(line)
    if (match) frames.push({ function: match[1] ?? '?', filename: match[2], lineno: Number(match[3]), colno: Number(match[4]), in_app: true })
  }
  return frames.reverse()
}

/** One line of an envelope. A value JSON cannot carry (a cycle, a bigint) is written as text. */
function jsonLine(value: unknown): string {
  return `${jsonText(value)}\n`
}

function jsonText(value: unknown): string {
  const seen = new WeakSet<object>()
  try {
    return JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'bigint') return item.toString()
      if (item instanceof Error) return `${item.name}: ${item.message}`
      if (item && typeof item === 'object') {
        if (seen.has(item)) return '[circular]'
        seen.add(item)
      }
      return item
    }) ?? 'undefined'
  } catch {
    return JSON.stringify(String(value))
  }
}

/**
 * Workers Logs keep only the stack frames of an error passed to console, without its name and
 * message, so the log says where something failed but not why. Errors logged with console.error
 * and console.warn are written as text instead: name, message, stack, then each cause.
 */
export function logErrorsAsText(target: Pick<Console, 'error' | 'warn'> = console): void {
  for (const level of ['error', 'warn'] as const) {
    const write = target[level].bind(target)
    target[level] = (...args: unknown[]) => write(...args.map((arg) => (arg instanceof Error ? errorText(arg) : arg)))
  }
}

export function errorText(error: Error, causes = 0): string {
  const heading = `${error.name}: ${error.message}`
  const text = error.stack?.startsWith(heading) ? error.stack : `${heading}\n${error.stack ?? ''}`.trimEnd()
  return error.cause instanceof Error && causes < MAX_CAUSES ? `${text}\nCaused by: ${errorText(error.cause, causes + 1)}` : text
}
