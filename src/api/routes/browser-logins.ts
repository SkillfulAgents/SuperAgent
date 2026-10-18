import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { agentRegistry } from '@shared/lib/agent-actor'
import { getViewerUserId } from '@shared/lib/auth/ownership'
import {
  agentsHoldingBrowserLogin,
  browserHoldsLogin,
  clearSiteInAgentBrowser,
  forgetInstalledBrowserLogin,
  withAgentBrowserLock,
} from '@shared/lib/browser/browser-login-apply'
import {
  deleteBrowserLogin,
  listManagedBrowserLogins,
  renameBrowserLogin,
  unmapBrowserLogin,
  type BrowserLoginClearScope,
} from '@shared/lib/services/browser-credential-service'
import { Authenticated } from '../middleware/auth'

const browserLogins = new Hono()
browserLogins.use('*', Authenticated())

const renameBodySchema = z.object({ name: z.string().trim().min(1).max(200) }).strict()

/** Sign the agent's open browser out of `site`; false when it could not be cleared. Call under the agent's lock. */
async function clearSiteForAgent(agentSlug: string, scope: BrowserLoginClearScope): Promise<boolean> {
  const { site } = scope
  const container = agentRegistry.get(agentSlug).container
  const cleared = container.status().status === 'running' &&
    await clearSiteInAgentBrowser(container, scope).catch((error: unknown) => {
      console.error(`[browser-logins] Could not clear ${site} for ${agentSlug}:`, error instanceof Error ? error.message : error)
      return false
    })
  if (cleared) forgetInstalledBrowserLogin(agentSlug, site)
  return cleared
}

// GET /api/browser-logins - The caller's saved browser logins (metadata only)
browserLogins.get('/', async (c) => {
  return c.json({ logins: await listManagedBrowserLogins(getViewerUserId(c)) })
})

// PATCH /api/browser-logins/:id - Rename
browserLogins.patch('/:id', zValidator('json', renameBodySchema), async (c) => {
  const renamed = await renameBrowserLogin(getViewerUserId(c), c.req.param('id'), c.req.valid('json').name)
  return renamed ? c.json({ success: true }) : c.json({ error: 'Saved login not found' }, 404)
})

// DELETE /api/browser-logins/:id - Delete and sign the agents using it out of the site
browserLogins.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const deleted = await deleteBrowserLogin(getViewerUserId(c), id)
  if (!deleted) return c.json({ error: 'Saved login not found' }, 404)
  // The mappings are gone, so a sync queued after this clear finds nothing to restore. Work already queued on an
  // agent (a sync, or an apply of this login or of a replacement) finishes first; the clear then runs only if the
  // agent's browser still holds this login.
  const notCleared: string[] = []
  for (const agentSlug of new Set([...deleted.agentSlugs, ...agentsHoldingBrowserLogin(id)])) {
    const cleared = await withAgentBrowserLock(agentSlug, async () =>
      !browserHoldsLogin(agentSlug, deleted.site, id, deleted.agentSlugs.includes(agentSlug)) ||
      clearSiteForAgent(agentSlug, deleted))
    if (!cleared) notCleared.push(agentSlug)
  }
  return c.json({ success: true, notCleared })
})

// DELETE /api/browser-logins/:id/agents/:agentSlug - Stop an agent using the login and sign it out of the site
browserLogins.delete('/:id/agents/:agentSlug', async (c) => {
  const agentSlug = c.req.param('agentSlug')
  // Unmap and clear as one step for the agent, so no sync or apply can run between them.
  const result = await withAgentBrowserLock(agentSlug, async () => {
    const login = await unmapBrowserLogin(getViewerUserId(c), c.req.param('id'), agentSlug)
    if (!login) return null
    return { cleared: await clearSiteForAgent(agentSlug, login) }
  })
  if (!result) return c.json({ error: 'Saved login not found' }, 404)
  return c.json({ success: true, notCleared: result.cleared ? [] : [agentSlug] })
})

export default browserLogins
