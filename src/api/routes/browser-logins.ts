import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { agentRegistry } from '@shared/lib/agent-actor'
import { getViewerUserId } from '@shared/lib/auth/ownership'
import { clearSiteInAgentBrowser } from '@shared/lib/browser/browser-login-apply'
import {
  deleteBrowserLogin,
  listManagedBrowserLogins,
  renameBrowserLogin,
  unmapBrowserLogin,
} from '@shared/lib/services/browser-credential-service'
import { Authenticated } from '../middleware/auth'

const browserLogins = new Hono()
browserLogins.use('*', Authenticated())

const renameBodySchema = z.object({ name: z.string().trim().min(1).max(200) }).strict()

/** Sign each agent's open browser out of `site`; returns the agents whose browser could not be cleared. */
async function clearSiteForAgents(agentSlugs: string[], site: string, origins: string[]): Promise<string[]> {
  const notCleared: string[] = []
  for (const agentSlug of agentSlugs) {
    const container = agentRegistry.get(agentSlug).container
    const cleared = container.status().status === 'running' &&
      await clearSiteInAgentBrowser(container, site, origins).catch((error: unknown) => {
        console.error(`[browser-logins] Could not clear ${site} for ${agentSlug}:`, error instanceof Error ? error.message : error)
        return false
      })
    if (!cleared) notCleared.push(agentSlug)
  }
  return notCleared
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
  const deleted = await deleteBrowserLogin(getViewerUserId(c), c.req.param('id'))
  if (!deleted) return c.json({ error: 'Saved login not found' }, 404)
  const notCleared = await clearSiteForAgents(deleted.agentSlugs, deleted.site, deleted.origins)
  return c.json({ success: true, notCleared })
})

// DELETE /api/browser-logins/:id/agents/:agentSlug - Stop an agent using the login and sign it out of the site
browserLogins.delete('/:id/agents/:agentSlug', async (c) => {
  const agentSlug = c.req.param('agentSlug')
  const login = await unmapBrowserLogin(getViewerUserId(c), c.req.param('id'), agentSlug)
  if (!login) return c.json({ error: 'Saved login not found' }, 404)
  const notCleared = await clearSiteForAgents([agentSlug], login.site, login.origins)
  return c.json({ success: true, notCleared })
})

export default browserLogins
