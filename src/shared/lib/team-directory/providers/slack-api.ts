/**
 * The few Slack Web API calls the directory makes, over plain fetch: a form
 * POST with the token as a bearer, Slack's `{ ok, error }` envelope, and its
 * rate limit (429 with Retry-After) waited out a few times before giving up.
 */
import { z } from 'zod'

const SLACK_API = 'https://slack.com/api'
const REQUEST_TIMEOUT_MS = 15_000
const RATE_LIMIT_RETRIES = 3
/** Longer waits are answered with an error rather than holding a search. */
const MAX_RETRY_AFTER_MS = 30_000

const envelopeSchema = z.object({ ok: z.boolean(), error: z.string().optional() })

export class SlackApiError extends Error {
  constructor(readonly method: string, readonly code: string) {
    super(`Slack ${method} failed: ${code}`)
    this.name = 'SlackApiError'
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export interface SlackCallResult<T> {
  body: T
  headers: Headers
}

/** Calls `method`, parsing its answer with `schema`. Throws `SlackApiError` on `ok: false`. */
export async function slackCall<T>(
  method: string,
  token: string,
  params: Record<string, string | number | undefined>,
  schema: z.ZodType<T>,
): Promise<SlackCallResult<T>> {
  const form = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) form.set(key, String(value))
  }
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${SLACK_API}/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (response.status === 429) {
      const waitMs = Math.max(1, Number(response.headers.get('retry-after')) || 1) * 1000
      if (attempt >= RATE_LIMIT_RETRIES || waitMs > MAX_RETRY_AFTER_MS) throw new SlackApiError(method, 'ratelimited')
      await sleep(waitMs)
      continue
    }
    if (!response.ok) throw new SlackApiError(method, `http_${response.status}`)
    const json: unknown = await response.json()
    const envelope = envelopeSchema.parse(json)
    if (!envelope.ok) throw new SlackApiError(method, envelope.error ?? 'unknown_error')
    return { body: schema.parse(json), headers: response.headers }
  }
}
