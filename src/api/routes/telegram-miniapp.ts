import { Hono } from 'hono'
import { setCookie } from 'hono/cookie'
import { miniAppSessionRequestSchema } from './telegram-miniapp-schema'
import { getChatIntegration } from '@shared/lib/services/chat-integration-service'
import { parseChatIntegrationConfig, type TelegramConfig } from '@shared/lib/chat-integrations/config-schema'
import { verifyInitData } from '@shared/lib/telegram/init-data'
import {
  signDashboardCookie,
  DASHBOARD_COOKIE_NAME,
  DASHBOARD_COOKIE_TTL_SECONDS,
} from '@shared/lib/telegram/dashboard-cookie'
import { getOrCreateAuthSecret } from '@shared/lib/auth/secret'
import { getChatIntegrationSession } from '@shared/lib/services/chat-integration-session-service'
import { listArtifactsFromFilesystem } from '@shared/lib/services/artifact-service'
import { buildDashboardArtifactPath } from '@shared/lib/dashboard-url'

const app = new Hono()

app.post('/session', async (c) => {
  // 1. Parse + validate JSON body
  let rawBody: unknown
  try {
    rawBody = await c.req.json()
  } catch {
    return c.json({ ok: false, reason: 'bad_request' }, 400)
  }
  const parsed = miniAppSessionRequestSchema.safeParse(rawBody)
  if (!parsed.success) {
    return c.json({ ok: false, reason: 'bad_request' }, 400)
  }
  const { initData, integrationId, agentSlug: bodyAgentSlug, dashboardSlug } = parsed.data

  // 2. Look up integration
  const integration = getChatIntegration(integrationId)
  if (!integration) {
    return c.json({ ok: false, reason: 'not_found' }, 404)
  }

  // 3. Confirm it's telegram
  if (integration.provider !== 'telegram') {
    return c.json({ ok: false, reason: 'not_telegram' }, 400)
  }

  // 4. Extract bot token from config (config is a JSON string in DB)
  const tgConfig = parseChatIntegrationConfig('telegram', integration.config) as TelegramConfig | null
  if (!tgConfig?.botToken) {
    return c.json({ ok: false, reason: 'bad_integration' }, 400)
  }
  const { botToken } = tgConfig

  // 5. Verify Telegram initData signature + freshness
  const verifyResult = verifyInitData(initData, botToken, 86400)
  if (!verifyResult.ok) {
    return c.json({ ok: false, reason: verifyResult.reason }, 401)
  }

  // 6. Extract Telegram user id
  const tgUserId = verifyResult.data.user?.id
  if (tgUserId === undefined) {
    return c.json({ ok: false, reason: 'not_bound' }, 403)
  }

  // 7. Confirm user is bound to this integration (DM: externalChatId === String(tgUserId))
  const session = getChatIntegrationSession(integrationId, String(tgUserId))
  if (!session) {
    return c.json({ ok: false, reason: 'not_bound' }, 403)
  }

  // 8. Defense-in-depth: body's agentSlug must match the integration's authoritative agentSlug
  if (bodyAgentSlug !== integration.agentSlug) {
    return c.json({ ok: false, reason: 'agent_mismatch' }, 400)
  }

  // 9. Confirm the dashboard belongs to the agent
  let artifacts: Awaited<ReturnType<typeof listArtifactsFromFilesystem>>
  try {
    artifacts = await listArtifactsFromFilesystem(integration.agentSlug)
  } catch (err) {
    console.error('[telegram-miniapp] failed to list artifacts for agent', integration.agentSlug, err)
    artifacts = []
  }
  if (!artifacts.some(a => a.slug === dashboardSlug)) {
    return c.json({ ok: false, reason: 'dashboard_not_found' }, 404)
  }

  // 10. Owner must be present to act on their behalf
  if (!integration.createdByUserId) {
    return c.json({ ok: false, reason: 'no_owner' }, 401)
  }

  // 11. Mint the scoped dashboard cookie
  const exp = Math.floor(Date.now() / 1000) + DASHBOARD_COOKIE_TTL_SECONDS
  const token = signDashboardCookie(
    {
      userId: integration.createdByUserId,
      agentSlug: integration.agentSlug,
      integrationId: integration.id,
      exp,
    },
    getOrCreateAuthSecret(),
  )

  // 12. Set cookie — secure only on https so local http round-trips still work
  const secure = new URL(c.req.url).protocol === 'https:'
  setCookie(c, DASHBOARD_COOKIE_NAME, token, {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/api',
    maxAge: DASHBOARD_COOKIE_TTL_SECONDS,
  })

  // 13. Respond with the artifact path the Mini App should load
  return c.json({ ok: true, artifactPath: buildDashboardArtifactPath(integration.agentSlug, dashboardSlug) })
})

export default app
