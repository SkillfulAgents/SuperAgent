import { z } from 'zod'
import { getSettings } from '@shared/lib/config/settings'
import type { BrowserCredential } from '@shared/lib/db/schema'
import { saveBrowserLogin } from '@shared/lib/services/browser-credential-service'
import { siteStorageBundleSchema } from '../../../../agent-container/src/browser-storage-bundle'
import { siteOf } from './site'

interface ContainerFetch {
  fetch(path: string, init?: RequestInit): Promise<Response>
}

/** What happened to the "Save login to my vault" request, as shown to the user. */
export type LoginSaveOutcome = 'saved' | 'updated' | 'failed'

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

async function storageRequest(client: ContainerFetch, action: 'capture', body: object): Promise<unknown> {
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

/**
 * Capture and store the login the user just completed on `url`'s site: the
 * page the sign-in request opened on, so an SSO detour elsewhere does not
 * change the site. Capture only reads the browser, so every failure leaves it
 * untouched; the caller still completes the request whatever this returns.
 */
export async function saveLoginAfterBrowserInput(input: {
  client: ContainerFetch
  sessionId: string
  agentSlug: string
  userId: string | null
  url: string | null
}): Promise<LoginSaveOutcome> {
  const site = input.url ? siteOf(input.url) : null
  if (!site) return 'failed'

  try {
    const bundle = siteStorageBundleSchema.parse(
      await storageRequest(input.client, 'capture', { sessionId: input.sessionId, site }),
    )
    const result = await saveBrowserLogin({
      userId: input.userId,
      agentSlug: input.agentSlug,
      browserType: await browserTypeForSession(input.client, input.sessionId),
      bundle,
    })
    return result.status === 'created' ? 'saved' : 'updated'
  } catch (error) {
    console.error(`[browser-vault] Login for ${site} not saved:`, error instanceof Error ? error.message : 'unknown error')
    return 'failed'
  }
}
