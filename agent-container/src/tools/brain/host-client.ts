import type { ZodType } from 'zod'
import { curatorLookupSchema } from './schemas'

export class BrainHostError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'BrainHostError'
  }
}

async function brainFetch<T>(
  op: string,
  schema: ZodType<T>,
  init: { method: 'GET' } | { method: 'POST'; body: Record<string, unknown> },
): Promise<T> {
  const baseUrl = process.env.SUPERAGENT_HOST_API_URL
  const token = process.env.PROXY_TOKEN
  if (!baseUrl) {
    throw new BrainHostError(500, 'SUPERAGENT_HOST_API_URL not set')
  }
  if (!token) {
    throw new BrainHostError(500, 'PROXY_TOKEN not set')
  }
  const url = `${baseUrl.replace(/\/$/, '')}/brain/agent/${op}`
  let response: Response
  try {
    response = await fetch(url, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.method === 'POST' ? { body: JSON.stringify(init.body) } : {}),
    })
  } catch (error) {
    throw new BrainHostError(0, `Network error calling brain ${op}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) {
    let errorBody: { error?: string } = {}
    try {
      errorBody = (await response.json()) as { error?: string }
    } catch {
      // ignore
    }
    throw new BrainHostError(response.status, errorBody.error ?? `brain ${op} failed (HTTP ${response.status})`)
  }
  return schema.parse(await response.json())
}

export async function callBrainHost<T>(
  op: string,
  body: Record<string, unknown>,
  schema: ZodType<T>,
): Promise<T> {
  return brainFetch(op, schema, { method: 'POST', body })
}

export async function getBrainCurator(): Promise<string | null> {
  const data = await brainFetch('curator', curatorLookupSchema, { method: 'GET' })
  return data.agentSlug
}

export function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  }
}
