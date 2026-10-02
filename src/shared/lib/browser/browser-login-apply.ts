import { getOwnedBrowserLogin, mapAgentToBrowserLogin } from '@shared/lib/services/browser-credential-service'
import { decryptBrowserBundle } from './browser-vault-crypto'
import { browserTypeForSession, storageRequest, type ContainerFetch } from './browser-storage-client'

export class BrowserLoginNotFoundError extends Error {}

async function reloadPage(client: ContainerFetch, sessionId: string): Promise<void> {
  const response = await client.fetch('/browser/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, args: ['reload'] }),
  })
  if (!response.ok) throw new Error(`Browser reload failed with ${response.status}`)
}

/**
 * Write a saved login into the agent's browser and reload the current page.
 * The container's restore replaces the site's state as one unit and puts the
 * previous state back itself if the write fails. The agent mapping is recorded
 * only after the browser write succeeded; `linked: false` means the browser
 * has the login but the mapping could not be stored.
 */
export async function applyBrowserLogin(input: {
  client: ContainerFetch
  sessionId: string
  agentSlug: string
  userId: string | null
  credentialId: string
  /** Site of the sign-in page; a login saved for another site is not applied. */
  site: string
}): Promise<{ site: string; linked: boolean }> {
  const credential = await getOwnedBrowserLogin(input.userId, input.credentialId)
  if (!credential || credential.site !== input.site) throw new BrowserLoginNotFoundError()
  if (credential.browserType !== await browserTypeForSession(input.client, input.sessionId)) throw new BrowserLoginNotFoundError()
  const { site } = credential
  const bundle = decryptBrowserBundle(credential.bundle, credential)

  await storageRequest(input.client, 'restore', { sessionId: input.sessionId, bundle })

  // Restore changes storage only; the open page still renders the signed-out state until reloaded.
  await reloadPage(input.client, input.sessionId).catch((error: unknown) => {
    console.error(`[browser-vault] Applied ${site} but could not reload the page:`, error instanceof Error ? error.message : 'unknown error')
  })

  try {
    await mapAgentToBrowserLogin({ agentSlug: input.agentSlug, credentialId: credential.id, site, version: credential.version })
    return { site, linked: true }
  } catch (error) {
    console.error(`[browser-vault] Applied ${site} but could not link it to the agent:`, error instanceof Error ? error.message : 'unknown error')
    return { site, linked: false }
  }
}
