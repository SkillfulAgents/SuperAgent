import { z } from 'zod'
import {
  getOwnedBrowserLogin,
  listOutdatedAgentBrowserLogins,
  mapAgentToBrowserLogin,
} from '@shared/lib/services/browser-credential-service'
import { isAuthMode } from '@shared/lib/auth/mode'
import { decryptBrowserBundle } from './browser-vault-crypto'
import { browserTypeForSession, storageRequest, type ContainerFetch } from './browser-storage-client'

export class BrowserLoginNotFoundError extends Error {}

const syncQueues = new Map<string, Promise<void>>()

function logError(message: string, error: unknown): void {
  console.error(`[browser-vault] ${message}:`, error instanceof Error ? error.message : 'unknown error')
}

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
    logError(`Applied ${site} but could not reload the page`, error)
  })

  try {
    await mapAgentToBrowserLogin({ agentSlug: input.agentSlug, credentialId: credential.id, site, version: credential.version })
    return { site, linked: true }
  } catch (error) {
    logError(`Applied ${site} but could not link it to the agent`, error)
    return { site, linked: false }
  }
}

const browserStatusSchema = z.object({ active: z.boolean(), sessionId: z.string().nullable() })

/** Clear a site's cookies and web storage in an open browser. */
export async function clearSiteInAgentBrowser(client: ContainerFetch, site: string, origins: string[]): Promise<boolean> {
  const response = await client.fetch('/browser/status')
  if (!response.ok) return false
  const status = browserStatusSchema.parse(await response.json())
  if (!status.active || !status.sessionId) return false
  const result = z.object({ skipped: z.array(z.string()) }).parse(
    await storageRequest(client, 'clear', { sessionId: status.sessionId, site, origins }),
  )
  return result.skipped.length === 0
}

/**
 * Bring the agent's browser up to date with newer versions of the saved
 * logins it uses (a re-login elsewhere bumps the version). Runs when the
 * agent's browser opens; failures are logged and retried on the next open.
 * A version counts as applied once its cookies are written: web storage of
 * origins without an open tab is not retried, since each retry would replace
 * the cookies the site has refreshed since. Syncs for one agent run one after
 * another, and each call settles once its own run is done, so browser_open
 * can wait for it.
 */
export function syncAgentBrowserLogins(client: ContainerFetch, agentSlug: string, sessionId: string): Promise<void> {
  const run = (syncQueues.get(agentSlug) ?? Promise.resolve()).then(() => runSync(client, agentSlug, sessionId))
  const queued = run.catch(() => {})
  syncQueues.set(agentSlug, queued)
  void queued.then(() => {
    if (syncQueues.get(agentSlug) === queued) syncQueues.delete(agentSlug)
  })
  return run
}

async function runSync(client: ContainerFetch, agentSlug: string, sessionId: string): Promise<void> {
  // On a shared agent a member applied the login for this one time; a newer version needs them to apply it again.
  // Loaded lazily: the members service pulls in user profiles, which the message persister does not otherwise need.
  if (isAuthMode()) {
    const { countMembersWithMinRole } = await import('@shared/lib/services/agent-members-service')
    if (await countMembersWithMinRole(agentSlug, 'viewer') > 1) return
  }
  let applied = 0
  const browserType = await browserTypeForSession(client, sessionId)
  for (const credential of await listOutdatedAgentBrowserLogins(agentSlug, browserType)) {
    try {
      const bundle = decryptBrowserBundle(credential.bundle, credential)
      await storageRequest(client, 'restore', { sessionId, bundle })
      await mapAgentToBrowserLogin({ agentSlug, credentialId: credential.id, site: credential.site, version: credential.version })
      applied++
    } catch (error) {
      logError(`Could not sync ${credential.site}`, error)
    }
  }
  if (applied > 0) await reloadPage(client, sessionId).catch((error: unknown) => logError('Synced logins but could not reload the page', error))
}
