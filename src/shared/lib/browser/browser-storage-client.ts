// Host-side calls to the agent container's browser status and storage endpoints.
import { z } from 'zod'
import { getSettings } from '@shared/lib/config/settings'
import type { BrowserCredential } from '@shared/lib/db/schema'

export interface ContainerFetch {
  fetch(path: string, init?: RequestInit): Promise<Response>
}

const browserStatusSchema = z.object({
  active: z.boolean(),
  sessionId: z.string().nullable(),
  location: z.enum(['host', 'container']).nullable(),
})

export async function browserTypeForSession(client: ContainerFetch, sessionId: string): Promise<BrowserCredential['browserType']> {
  const response = await client.fetch('/browser/status')
  if (!response.ok) throw new Error(`Browser status failed with ${response.status}`)
  const status = browserStatusSchema.parse(await response.json())
  if (!status.active || status.sessionId !== sessionId || !status.location) throw new Error('Browser session changed')
  if (status.location === 'container') return 'container'
  const provider = getSettings().app?.hostBrowserProvider
  if (!provider) throw new Error('Host browser provider is not configured')
  return provider
}

export async function storageRequest(
  client: ContainerFetch,
  action: 'capture' | 'restore' | 'clear',
  body: object,
): Promise<unknown> {
  const response = await client.fetch(`/browser/storage/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const { error } = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(error ?? `Browser storage ${action} failed with ${response.status}`)
  }
  return response.json()
}
