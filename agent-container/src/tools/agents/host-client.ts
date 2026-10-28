/**
 * Shared HTTP helper for x-agent tools.
 *
 * Calls back to the host's /api/x-agent/* endpoints using the container's
 * proxy token (PROXY_TOKEN env var). The host validates the token, resolves
 * the caller's agent slug, applies policies / interactive review, and returns
 * the result inline.
 */

import { z } from 'zod'
import { xAgentErrorResponseSchema } from './host-response-schemas'

export interface XAgentCallOptions {
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

export async function authenticatedHostResponse(
  op: string,
  body: Record<string, unknown>,
  opts: XAgentCallOptions = {},
): Promise<Response> {
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
    let errorMessage: string | undefined
    try {
      const parsed = xAgentErrorResponseSchema.safeParse(await response.json())
      if (parsed.success) errorMessage = parsed.data.error
    } catch {
      // Non-JSON error responses use the status fallback below.
    }
    throw new XAgentError(response.status, errorMessage ?? `x-agent ${op} failed (HTTP ${response.status})`)
  }
  return response
}

export async function callHost<T extends z.ZodType>(
  op: string,
  body: Record<string, unknown>,
  responseSchema: T,
  opts: XAgentCallOptions = {},
): Promise<z.infer<T>> {
  const response = await authenticatedHostResponse(op, body, opts)
  return responseSchema.parse(await response.json())
}

export function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  }
}
