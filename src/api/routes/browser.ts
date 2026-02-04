import { Hono } from 'hono'
import { hostBrowserManager } from '../../main/host-browser-manager'
import { getSettings } from '@shared/lib/config/settings'
import { containerManager } from '@shared/lib/container/container-manager'
import { messagePersister } from '@shared/lib/container/message-persister'

const browser = new Hono()

// POST /api/browser/launch-host-browser - Launch browser on host for CDP connection
browser.post('/launch-host-browser', async (c) => {
  try {
    const settings = getSettings()
    const profileId = settings.app?.chromeProfileId || undefined
    const { port } = await hostBrowserManager.ensureRunning(profileId)
    return c.json({ port })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to launch browser'
    console.error('[Browser] Failed to launch host browser:', message)
    return c.json({ error: message }, 503)
  }
})

// POST /api/browser/stop-host-browser - Stop the host browser process
browser.post('/stop-host-browser', async (c) => {
  try {
    hostBrowserManager.stop()
    return c.json({ success: true })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to stop browser'
    console.error('[Browser] Failed to stop host browser:', message)
    return c.json({ error: message }, 500)
  }
})

// When the host browser exits externally (user closed Chrome), broadcast
// browser_active: false directly to all frontend SSE clients and also
// attempt to notify containers so they can clean up their internal state.
hostBrowserManager.onExternalExit = async () => {
  console.log('[Browser] Host browser closed externally')

  // Immediately broadcast to all frontend SSE clients so the preview disappears
  messagePersister.broadcastGlobal({ type: 'browser_active', active: false })

  // Also try to notify containers to clean up their internal browser state.
  // This may 404 if the container doesn't have the endpoint yet — that's OK,
  // the frontend is already updated via the SSE broadcast above.
  try {
    const runningAgents = await containerManager.getRunningAgentIds()
    for (const agentId of runningAgents) {
      try {
        const client = containerManager.getClient(agentId)
        await client.fetch('/browser/notify-closed', { method: 'POST' })
      } catch {
        // Expected to fail until container is rebuilt with the new endpoint
      }
    }
  } catch {
    // Non-critical — frontend is already notified
  }
}

export default browser
