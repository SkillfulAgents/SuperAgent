import { saveBrowserLogin } from '@shared/lib/services/browser-credential-service'
import { siteStorageBundleSchema } from '../../../../agent-container/src/browser-storage-bundle'
import { browserTypeForSession, storageRequest, type ContainerFetch } from './browser-storage-client'
import { siteOf } from './site'

/** What happened to the "Save login to my vault" request, as shown to the user. */
export type LoginSaveOutcome = 'saved' | 'updated' | 'failed'

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
