import type { SetupContext } from 'qagent'

/**
 * Pre-injects API keys into SuperAgent and marks initial setup as completed.
 * Reads ANTHROPIC_API_KEY, COMPOSIO_API_KEY, COMPOSIO_USER_ID from environment.
 *
 * This runs BEFORE the QA agent starts, so the agent never needs to enter keys manually.
 */
export default async function ensureSecrets(ctx: SetupContext): Promise<void> {
  const { env } = ctx
  const apiBase = (ctx.store.get('apiBaseUrl') as string | undefined) ?? ctx.baseUrl
  const settingsUrl = `${apiBase}/api/settings`

  const check = await fetch(settingsUrl)
  if (!check.ok) {
    throw new Error(`Cannot reach SuperAgent at ${apiBase}: GET /api/settings returned ${check.status}`)
  }

  const apiKeys: Record<string, string> = {}
  if (env.ANTHROPIC_API_KEY) apiKeys.anthropicApiKey = env.ANTHROPIC_API_KEY
  if (env.COMPOSIO_API_KEY) apiKeys.composioApiKey = env.COMPOSIO_API_KEY
  if (env.COMPOSIO_USER_ID) apiKeys.composioUserId = env.COMPOSIO_USER_ID

  const payload: Record<string, unknown> = {
    app: { setupCompleted: true },
    agentLimits: { maxOutputTokens: 0 },
  }
  if (Object.keys(apiKeys).length > 0) {
    payload.apiKeys = apiKeys
    console.log(`    Injecting keys: ${Object.keys(apiKeys).join(', ')}`)
  } else {
    console.log(`    No API keys in env, setting setupCompleted only`)
  }

  const res = await fetch(settingsUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    throw new Error(`Failed to configure app: ${res.status} ${await res.text()}`)
  }
}
