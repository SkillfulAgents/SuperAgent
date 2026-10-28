/**
 * Durable record of fatal main-process errors.
 *
 * The uncaughtException/unhandledRejection handlers in index.ts quit the app,
 * and the Sentry event they capture is lost whenever the network is down at
 * that moment (the transport has no offline queue). This module writes the
 * fatal to disk *synchronously, before any async work*, so the record survives
 * a dead network, a hung flush, or a second error during shutdown. The next
 * launch reports the marker to Sentry and deletes it only once the flush
 * confirms delivery.
 */

import fs from 'fs'
import path from 'path'
import { inspect } from 'util'
import { getDataDir } from '@shared/lib/config/data-dir'
import { APP_VERSION } from '@shared/lib/config/version'
import { captureMessage, flushErrorReporting, getErrorReporter } from '@shared/lib/error-reporting'
import { crashMarkerSchema, type CrashMarker, type CrashMarkerEntry } from './crash-marker-schema'

const MARKER_FILENAME = 'fatal-crash-marker.json'
// A fatal during shutdown often triggers pile-on rejections from torn-down
// services; keep the earliest few, which include the original cause.
const MAX_ENTRIES = 5
const MAX_REPORT_ATTEMPTS = 5
const MAX_MESSAGE_LENGTH = 2000
const MAX_STACK_LENGTH = 8000
const REPORT_FLUSH_TIMEOUT_MS = 10_000

export function getCrashMarkerPath(): string {
  return path.join(getDataDir(), MARKER_FILENAME)
}

/**
 * Normalize a fatal reason into an Error without destroying context.
 * unhandledRejection reasons are frequently not Errors — some dependencies
 * reject with plain objects or literally `undefined` — and stringifying those
 * as `new Error(String(reason))` yields the useless "Error: undefined".
 */
export function toReportableError(reason: unknown): Error {
  if (reason instanceof Error) return reason
  return new Error(`Non-Error fatal reason: ${inspect(reason, { depth: 4 }).slice(0, MAX_MESSAGE_LENGTH)}`)
}

function readMarker(): CrashMarker | null {
  try {
    return crashMarkerSchema.parse(JSON.parse(fs.readFileSync(getCrashMarkerPath(), 'utf8')))
  } catch {
    return null
  }
}

/**
 * Record a fatal error to disk. Synchronous and non-throwing — this runs
 * inside the fatal handlers, before flush/shutdown, and must never make a
 * bad situation worse. If a marker already exists (pile-on fatals in the same
 * shutdown, or an undelivered marker from a previous run), the entry is
 * appended up to MAX_ENTRIES so the original cause is never displaced.
 */
export function recordFatalError(type: CrashMarkerEntry['type'], reason: unknown): void {
  try {
    const error = toReportableError(reason)
    const entry: CrashMarkerEntry = {
      timestamp: new Date().toISOString(),
      type,
      name: error.name,
      message: error.message.slice(0, MAX_MESSAGE_LENGTH),
      stack: error.stack?.slice(0, MAX_STACK_LENGTH),
    }
    const existing = readMarker()
    const marker: CrashMarker = existing
      ? {
          ...existing,
          entries:
            existing.entries.length >= MAX_ENTRIES ? existing.entries : [...existing.entries, entry],
        }
      : { version: 1, appVersion: APP_VERSION, reportAttempts: 0, entries: [entry] }
    fs.mkdirSync(getDataDir(), { recursive: true })
    fs.writeFileSync(getCrashMarkerPath(), JSON.stringify(marker, null, 2))
  } catch {
    // Never throw from a fatal handler.
  }
}

/**
 * If the previous session died in a fatal handler, report it now and delete
 * the marker once the flush confirms delivery. Call at startup, after
 * initErrorReporting. Non-throwing; a failed delivery keeps the marker for
 * the next launch (bounded by MAX_REPORT_ATTEMPTS).
 */
export async function reportCrashMarkerFromLastRun(): Promise<void> {
  try {
    if (!fs.existsSync(getCrashMarkerPath())) return
    const marker = readMarker()
    if (!marker) {
      // Unparseable — nothing recoverable, don't retry forever.
      fs.unlinkSync(getCrashMarkerPath())
      return
    }
    // Error reporting never initialized (dev mode, or init failure): leave the
    // marker alone rather than consuming it unreported — flush() reports
    // success when there is no provider.
    if (!getErrorReporter()) return
    if (marker.reportAttempts >= MAX_REPORT_ATTEMPTS) {
      fs.unlinkSync(getCrashMarkerPath())
      return
    }
    // Persist the attempt count before trying so a crash loop during startup
    // still burns down the retry budget.
    fs.writeFileSync(
      getCrashMarkerPath(),
      JSON.stringify({ ...marker, reportAttempts: marker.reportAttempts + 1 }, null, 2),
    )
    const first = marker.entries[0]
    captureMessage(`Previous session ended by fatal ${first.type}: ${first.message}`, {
      level: 'fatal',
      tags: { type: first.type, crashedLastSession: 'true' },
      extra: {
        crashedAppVersion: marker.appVersion,
        reportAttempts: marker.reportAttempts + 1,
        entries: marker.entries,
      },
    })
    const delivered = await flushErrorReporting(REPORT_FLUSH_TIMEOUT_MS)
    if (delivered) {
      fs.unlinkSync(getCrashMarkerPath())
    }
  } catch {
    // Keep the marker for the next launch.
  }
}
