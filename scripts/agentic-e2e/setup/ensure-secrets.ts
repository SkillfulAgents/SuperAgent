/**
 * ensureSecrets: Pre-injects API keys into SuperAgent and marks setup as completed.
 * Reads ANTHROPIC_API_KEY, COMPOSIO_API_KEY, COMPOSIO_USER_ID from environment.
 *
 * This runs BEFORE the QA agent starts, so the agent never needs to enter keys manually.
 * Feature files for settings-global should skip key-entry steps accordingly.
 */
export async function ensureSecrets(baseUrl: string): Promise<void> {
  const settingsUrl = `${baseUrl}/api/settings`

  const check = await fetch(settingsUrl)
  if (!check.ok) {
    throw new Error(`Cannot reach SuperAgent at ${baseUrl}: GET /api/settings returned ${check.status}`)
  }

  const apiKeys: Record<string, string> = {}
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  const composioKey = process.env.COMPOSIO_API_KEY
  const composioUserId = process.env.COMPOSIO_USER_ID

  if (anthropicKey) apiKeys.anthropicApiKey = anthropicKey
  if (composioKey) apiKeys.composioApiKey = composioKey
  if (composioUserId) apiKeys.composioUserId = composioUserId

  const payload: Record<string, unknown> = {
    app: { setupCompleted: true },
    // Set maxOutputTokens to 0 (falsy) so the container code skips constructing
    // options.env, which would otherwise override process.env and drop the API key.
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
