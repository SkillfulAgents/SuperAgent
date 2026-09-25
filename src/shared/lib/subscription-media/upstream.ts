import { z } from 'zod'
import { MediaRequestError, type MediaCredentialSource } from './types'

type Credential = Awaited<ReturnType<MediaCredentialSource>>

const errorSchema = z.object({
  error: z.union([z.string(), z.object({ message: z.string() })]).optional(),
  detail: z.union([z.string(), z.object({ message: z.string() })]).optional(),
})
const text = (value: string | { message: string } | undefined) => typeof value === 'string' ? value : value?.message

/** Sends with the current credential and retries once with a refreshed one after a 401. */
export async function sendWithCredential(credential: MediaCredentialSource, send: (current: Credential) => Promise<Response>): Promise<Response> {
  const first = await credential()
  const response = await send(first)
  if (response.status !== 401) return response
  await response.body?.cancel()
  return send(await credential(first.generation))
}

/** Limit, entitlement and rejected-prompt reasons help the agent; other bodies stay private. */
export async function upstreamMediaError(providerName: string, response: Response, kind: 'image' | 'video' = 'image'): Promise<MediaRequestError> {
  const parsed = errorSchema.safeParse(await response.json().catch(() => null))
  const detail = parsed.success ? text(parsed.data.error) ?? text(parsed.data.detail) : undefined
  const reason = detail ? `: ${detail.slice(0, 500)}` : ''
  if (response.status === 429) return new MediaRequestError(429, `${providerName} ${kind} limit reached${reason}`)
  if (response.status === 402 || response.status === 403) return new MediaRequestError(403, `${providerName} ${kind} generation is not available for this account${reason}`)
  if (response.status === 400 || response.status === 422) return new MediaRequestError(400, `${providerName} rejected the ${kind} request${reason}`)
  return new MediaRequestError(502, `${providerName} ${kind} generation failed (${response.status})`)
}
