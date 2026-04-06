import { Hono } from 'hono'
import { getActiveProvider, setOnExternalClose } from '../../main/host-browser'
import { getSettings } from '@shared/lib/config/settings'
import { containerManager } from '@shared/lib/container/container-manager'
import { messagePersister } from '@shared/lib/container/message-persister'
import { IsAgent } from '../middleware/auth'

const browser = new Hono()

/** Build a composite instanceId from agentId and optional sessionId */
function buildInstanceId(agentId: string, sessionId?: string): string {
  return sessionId ? `${agentId}:${sessionId}` : agentId
}

/** Parse a composite instanceId back to [agentId, sessionId] */
function parseInstanceId(instanceId: string): { agentId: string; sessionId?: string } {
  const colonIdx = instanceId.indexOf(':')
  if (colonIdx === -1) return { agentId: instanceId }
  return { agentId: instanceId.slice(0, colonIdx), sessionId: instanceId.slice(colonIdx + 1) }
}

// POST /api/browser/launch-host-browser - Launch browser on host for CDP connection
browser.post('/launch-host-browser', IsAgent(), async (c) => {
  try {
    const body = await c.req.json<{ agentId?: string; sessionId?: string }>().catch(() => ({} as { agentId?: string; sessionId?: string }))
    const agentId = body.agentId || 'default'
    const instanceId = buildInstanceId(agentId, body.sessionId)

    const provider = getActiveProvider()
    if (!provider) {
      return c.json({ error: 'No host browser provider configured' }, 400)
    }

    const settings = getSettings()
    const options: Record<string, string> = {}
    if (settings.app?.chromeProfileId) {
      options.chromeProfileId = settings.app.chromeProfileId
    }

    const connectionInfo = await provider.launch(instanceId, options, agentId)
    return c.json(connectionInfo)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to launch browser'
    console.error('[Browser] Failed to launch host browser:', message)
    return c.json({ error: message }, 503)
  }
})

// POST /api/browser/stop-host-browser - Stop the host browser process for a specific agent session
browser.post('/stop-host-browser', IsAgent(), async (c) => {
  try {
    const body = await c.req.json<{ agentId?: string; sessionId?: string }>().catch(() => ({} as { agentId?: string; sessionId?: string }))
    const agentId = body.agentId || 'default'
    const instanceId = buildInstanceId(agentId, body.sessionId)

    const provider = getActiveProvider()
    if (provider) {
      await provider.stop(instanceId)
    }
    return c.json({ success: true })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to stop browser'
    console.error('[Browser] Failed to stop host browser:', message)
    return c.json({ error: message }, 500)
  }
})

// POST /api/browser/debug-info - Get fresh debug/screencast connection info for an active browser session
browser.post('/debug-info', IsAgent(), async (c) => {
  try {
    const body = await c.req.json<{ agentId?: string; sessionId?: string }>().catch(() => ({} as { agentId?: string; sessionId?: string }))
    const agentId = body.agentId || 'default'
    const instanceId = buildInstanceId(agentId, body.sessionId)

    const provider = getActiveProvider()
    if (!provider?.getDebugInfo) {
      return c.json({ pages: [] })
    }

    const debugInfo = await provider.getDebugInfo(instanceId)
    return c.json(debugInfo || { pages: [] })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to get debug info'
    console.error('[Browser] Failed to get debug info:', message)
    return c.json({ error: message }, 500)
  }
})

// When a host browser instance closes externally (e.g. user closed Chrome),
// notify that agent's container so it can clean up its internal state, and
// broadcast to frontend SSE clients so the preview disappears.
setOnExternalClose(async (instanceId: string) => {
  console.log(`[Browser] Host browser for instance ${instanceId} closed externally`)
  const { agentId, sessionId } = parseInstanceId(instanceId)

  // Broadcast to all frontend SSE clients with the agentSlug so UI can scope it
  messagePersister.broadcastGlobal({ type: 'browser_active', active: false, agentSlug: agentId, sessionId })

  // Notify the affected container to clean up its internal browser state.
  try {
    const client = containerManager.getClient(agentId)
    await client.fetch('/browser/notify-closed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
  } catch {
    // Non-critical — frontend is already notified
  }
})

export default browser
