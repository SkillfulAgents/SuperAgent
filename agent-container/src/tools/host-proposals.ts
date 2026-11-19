/**
 * Host calls that wait for a person's decision (a proxy rule, a skill publish).
 *
 * The host answers a proposal at once with an id (202), and each /wait call holds
 * at most ~20 s, so no request outlives the proxies between a cloud agent and the
 * host.
 */

export type HostResult = { ok: boolean; status: number; data: unknown; json: boolean }

/** POST `/x-agent/<family>/<op>` with the agent's proxy token. Never throws: a failure is a result. */
export async function callHostOp(family: string, op: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<HostResult> {
  const baseUrl = process.env.SUPERAGENT_HOST_API_URL
  const token = process.env.PROXY_TOKEN
  if (!baseUrl || !token) return { ok: false, status: 500, data: { error: 'Host API is not configured in this container.' }, json: true }
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/x-agent/${family}/${op}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal,
    })
    try {
      return { ok: response.ok, status: response.status, data: await response.json(), json: true }
    } catch {
      return { ok: false, status: response.status, data: { error: `HTTP ${response.status}` }, json: false }
    }
  } catch (error) {
    return { ok: false, status: 0, data: { error: `Network error: ${error instanceof Error ? error.message : String(error)}` }, json: false }
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Longest the tool waits for a decision: preparing the card, then the user's 5 minutes. */
const PROPOSAL_DEADLINE_MS = 9 * 60_000

/**
 * Submit a proposal with `<family>/<op>` and poll `<family>/wait` until it settles.
 * Failures that are not the host's answer (network errors, a proxy's error page) are
 * retried: the proposal stays put while the tool keeps polling. If the call is
 * cancelled the proposal is withdrawn, and the host withdraws one nobody polls.
 */
export async function proposeToHost(family: string, op: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<HostResult> {
  const submitted = await callHostOp(family, op, body, signal)
  const proposalId = (submitted.data as { proposalId?: unknown } | null)?.proposalId
  if (submitted.status !== 202 || typeof proposalId !== 'string') return submitted
  const deadline = Date.now() + PROPOSAL_DEADLINE_MS
  for (let failures = 0; Date.now() < deadline && !signal?.aborted;) {
    const next = await callHostOp(family, 'wait', { proposalId }, signal)
    if (signal?.aborted) break
    if (next.status === 202) {
      failures = 0
      continue
    }
    if (!next.json || next.status >= 502) {
      if (++failures > 5) {
        void callHostOp(family, 'cancel', { proposalId })
        return next
      }
      await sleep(Math.min(1000 * 2 ** (failures - 1), 8000))
      continue
    }
    return next
  }
  void callHostOp(family, 'cancel', { proposalId })
  return signal?.aborted
    ? { ok: false, status: 0, data: { error: 'cancelled', message: 'The request was cancelled and withdrawn.' }, json: true }
    : { ok: false, status: 408, data: { error: 'review_timeout', message: 'No decision arrived in time. The request was withdrawn.' }, json: true }
}

/** The MCP request context the SDK passes to a tool handler (its signal fires on cancellation). */
export function signalOf(extra: unknown): AbortSignal | undefined {
  const signal = (extra as { signal?: unknown } | undefined)?.signal
  return signal instanceof AbortSignal ? signal : undefined
}
