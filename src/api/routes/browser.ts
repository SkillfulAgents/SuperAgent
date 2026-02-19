import { Hono } from 'hono'
import path from 'path'
import { hostBrowserManager } from '../../main/host-browser-manager'
import { getSettings } from '@shared/lib/config/settings'
import { getAgentWorkspaceDir } from '@shared/lib/config/data-dir'
import { containerManager } from '@shared/lib/container/container-manager'
import { messagePersister } from '@shared/lib/container/message-persister'

const browser = new Hono()

// POST /api/browser/launch-host-browser - Launch browser on host for CDP connection
browser.post('/launch-host-browser', async (c) => {
  try {
    const body = await c.req.json<{ agentId?: string }>().catch(() => ({} as { agentId?: string }))
    // Fall back to 'default' for backward compat with containers that don't send agentId yet
    const agentId = body.agentId || 'default'

    const settings = getSettings()
    const profileId = settings.app?.chromeProfileId || undefined
    const { port } = await hostBrowserManager.ensureRunning(agentId, profileId)
    const downloadDir = path.join(getAgentWorkspaceDir(agentId), 'downloads')
    return c.json({ port, downloadDir })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to launch browser'
    console.error('[Browser] Failed to launch host browser:', message)
    return c.json({ error: message }, 503)
  }
})

// POST /api/browser/stop-host-browser - Stop the host browser process for a specific agent
browser.post('/stop-host-browser', async (c) => {
  try {
    const body = await c.req.json<{ agentId?: string }>().catch(() => ({} as { agentId?: string }))
    // Fall back to 'default' for backward compat with containers that don't send agentId yet
    const agentId = body.agentId || 'default'

    hostBrowserManager.stopAgent(agentId)
    return c.json({ success: true })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to stop browser'
    console.error('[Browser] Failed to stop host browser:', message)
    return c.json({ error: message }, 500)
  }
})

// When a specific agent's host browser exits externally (user closed Chrome),
// notify that agent's container so it can clean up its internal state, and
// broadcast to frontend SSE clients so the preview disappears.
hostBrowserManager.onExternalExit = async (agentId: string) => {
  console.log(`[Browser] Host browser for agent ${agentId} closed externally`)

  // Broadcast to all frontend SSE clients with the agentSlug so UI can scope it
  messagePersister.broadcastGlobal({ type: 'browser_active', active: false, agentSlug: agentId })

  // Notify the affected container to clean up its internal browser state.
  try {
    const client = containerManager.getClient(agentId)
    await client.fetch('/browser/notify-closed', { method: 'POST' })
  } catch {
    // Non-critical — frontend is already notified
  }
}

export default browser
