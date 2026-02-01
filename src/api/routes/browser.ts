import { Hono } from 'hono'
import { hostBrowserManager } from '../../main/host-browser-manager'
import { getSettings } from '@shared/lib/config/settings'

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

export default browser
