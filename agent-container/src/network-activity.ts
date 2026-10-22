/**
 * Network activity — what an action asked the server for, from agent-browser's
 * request log (`network requests`), which lists a request the moment it is
 * issued and its status once it has completed (verified on 0.39.1).
 *
 * The settle (action-settle.ts) uses it to decide how long a late result is
 * worth waiting for: a click that issued requests has results on the way; a
 * click that issued none (a radio in a form, a tab that only swaps panels)
 * gets one short second look instead of the full recheck (bench, IRS wizard:
 * 13 radio clicks at 1.2 s each, none of which loaded anything).
 *
 * The log is cleared as each action starts — it keeps every request of the
 * session otherwise (1,500 fetches read back as 860 KB), so reading it whole
 * twice per action would grow without bound.
 */

import { z } from 'zod'
import { TELEMETRY } from './traffic-capture'

export interface NetworkActivity {
  /** Requests (xhr/fetch, telemetry left out) issued since the log was cleared. */
  issued: number
  /** Of those, the ones with no response yet. */
  pending: number
}

const requestLogSchema = z.object({
  data: z.object({
    requests: z.array(z.object({
      url: z.string(),
      status: z.number().nullable().optional(),
    }).passthrough()),
  }),
})

/** Read `network requests --json` output; null when it is not the log (an error, or output cut off). */
export function parseNetworkActivity(stdout: string): NetworkActivity | null {
  try {
    const log = requestLogSchema.safeParse(JSON.parse(stdout.trim()))
    if (!log.success) return null
    const own = log.data.data.requests.filter(r => !TELEMETRY.test(r.url))
    return { issued: own.length, pending: own.filter(r => typeof r.status !== 'number').length }
  } catch {
    return null
  }
}
