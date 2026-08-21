import { Hono } from 'hono'
import type { Context } from 'hono'
import { getActiveProvider, setOnExternalClose } from '../../main/host-browser'
import { getSettings } from '@shared/lib/config/settings'
import { containerManager } from '@shared/lib/container/container-manager'
import { messagePersister } from '@shared/lib/container/message-persister'
import { IsAgent } from '../middleware/auth'
import { captureException } from '@shared/lib/error-reporting'
import { hostBrowserRequestSchema, browserLaunchErrorReportSchema } from './browser-schema'

const browser = new Hono()

/**
 * Resolve the agent a host-browser request may act on, bound to the IsAgent
 * proxy token (SUP-216). The token uniquely identifies the agent, so the
 * effective instanceId/agentId is ALWAYS the token's slug — never the raw
 * body.agentId. If the body carries a different agentId, the request is a
 * cross-agent attempt and is rejected with 403.
 */
async function resolveTokenBoundAgentId(
  c: Context,
): Promise<{ agentId: string; raw: unknown } | { error: Response }> {
  const tokenAgentId = c.get('agentSlug' as never) as string | undefined
  if (!tokenAgentId) {
    // IsAgent() should always stash this; fail closed if it did not.
    return { error: c.json({ error: 'Unauthorized' }, 401) }
  }

  const raw = await c.req.json().catch(() => ({}))
  const parsed = hostBrowserRequestSchema.safeParse(raw)
  if (!parsed.success) {
    return { error: c.json({ error: 'Invalid request body' }, 400) }
  }

  if (parsed.data.agentId && parsed.data.agentId !== tokenAgentId) {
    return { error: c.json({ error: 'Forbidden: agentId does not match token agent' }, 403) }
  }

  return { agentId: tokenAgentId, raw }
}

// POST /api/browser/launch-host-browser - Launch browser on host for CDP connection
browser.post('/launch-host-browser', IsAgent(), async (c) => {
  try {
    const resolved = await resolveTokenBoundAgentId(c)
    if ('error' in resolved) return resolved.error
    const agentId = resolved.agentId

    const provider = getActiveProvider()
    if (!provider) {
      return c.json({ error: 'No host browser provider configured' }, 400)
    }

    const settings = getSettings()
    const options: Record<string, string> = {}
    if (settings.app?.chromeProfileId) {
      options.chromeProfileId = settings.app.chromeProfileId
    }
    if (settings.app?.chromeHeadless) {
      options.chromeHeadless = 'true'
    }

    const connectionInfo = await provider.launch(agentId, options, agentId)
    return c.json(connectionInfo)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to launch browser'
    console.error('[Browser] Failed to launch host browser:', message)
    return c.json({ error: message }, 503)
  }
})

// POST /api/browser/report-launch-error - A container reports a browser-launch
// failure that happened on its side AFTER launch-host-browser succeeded (e.g.
// it cannot resolve or reach the CDP endpoint). The host is the only side with
// Sentry, so relay it — otherwise the failure exists only in the agent's tool
// result and never reaches error tracking.
browser.post('/report-launch-error', IsAgent(), async (c) => {
  const resolved = await resolveTokenBoundAgentId(c)
  if ('error' in resolved) return resolved.error

  const parsed = browserLaunchErrorReportSchema.safeParse(resolved.raw)
  if (!parsed.success) {
    return c.json({ error: 'Invalid request body' }, 400)
  }

  const { stage, message } = parsed.data
  console.error(`[Browser] Container launch failure (${stage}) for ${resolved.agentId}: ${message}`)
  captureException(new Error(message), {
    tags: { component: 'browser', operation: 'container-launch-failure', stage },
    extra: { agentId: resolved.agentId },
  })
  return c.json({ success: true })
})

// POST /api/browser/stop-host-browser - Stop the host browser process for a specific agent
browser.post('/stop-host-browser', IsAgent(), async (c) => {
  try {
    const resolved = await resolveTokenBoundAgentId(c)
    if ('error' in resolved) return resolved.error
    const agentId = resolved.agentId

    const provider = getActiveProvider()
    if (provider) {
      await provider.stop(agentId)
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
    const resolved = await resolveTokenBoundAgentId(c)
    if ('error' in resolved) return resolved.error
    const agentId = resolved.agentId

    const provider = getActiveProvider()
    if (!provider?.getDebugInfo) {
      return c.json({ pages: [] })
    }

    const debugInfo = await provider.getDebugInfo(agentId)
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

  // Broadcast to all frontend SSE clients with the agentSlug so UI can scope it
  messagePersister.broadcastGlobal({ type: 'browser_active', active: false, agentSlug: instanceId })

  // Notify the affected container to clean up its internal browser state.
  try {
    const client = containerManager.getClient(instanceId)
    await client.fetch('/browser/notify-closed', { method: 'POST' })
  } catch {
    // Non-critical — frontend is already notified
  }
})

export default browser
