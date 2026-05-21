/**
 * Shared HTTP helper for x-agent tools.
 *
 * Calls back to the host's /api/x-agent/* endpoints using the container's
 * proxy token (PROXY_TOKEN env var). The host validates the token, resolves
 * the caller's agent slug, applies policies / interactive review, and returns
 * the result inline.
 */

interface XAgentCallOptions {
  // Calling Claude session ID. The host uses this to enforce policies that depend
  // on per-session state (e.g. blocking already-invoked sessions from re-invoking).
  // Passed under reserved key `_callerSessionId` in the request body.
  callerSessionId?: string
}

export class XAgentError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'XAgentError'
  }
}

export async function callHost<T>(
  op: string,
  body: Record<string, unknown>,
  opts: XAgentCallOptions = {},
): Promise<T> {
  const baseUrl = process.env.SUPERAGENT_HOST_API_URL
  const token = process.env.PROXY_TOKEN
  if (!baseUrl) {
    throw new XAgentError(500, 'SUPERAGENT_HOST_API_URL not set')
  }
  if (!token) {
    throw new XAgentError(500, 'PROXY_TOKEN not set')
  }
  const url = `${baseUrl.replace(/\/$/, '')}/x-agent/${op}`
  const finalBody = opts.callerSessionId
    ? { ...body, _callerSessionId: opts.callerSessionId }
    : body
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(finalBody),
    })
  } catch (error) {
    throw new XAgentError(0, `Network error calling x-agent ${op}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) {
    let errorBody: { error?: string } = {}
    try {
      errorBody = (await response.json()) as { error?: string }
    } catch {
      // ignore
    }
    throw new XAgentError(response.status, errorBody.error ?? `x-agent ${op} failed (HTTP ${response.status})`)
  }
  return (await response.json()) as T
}

export function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  }
}
