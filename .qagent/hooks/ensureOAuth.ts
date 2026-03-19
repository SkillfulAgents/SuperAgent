import type { SetupContext } from 'qagent'

/**
 * Registers an existing Composio GitHub connected account into SuperAgent.
 *
 * Requires COMPOSIO_API_KEY and COMPOSIO_USER_ID in env.
 */
export default async function ensureOAuth(ctx: SetupContext): Promise<void> {
  const { env } = ctx
  const baseUrl = (ctx.store.get('apiBaseUrl') as string | undefined) ?? ctx.baseUrl
  const composioKey = env.COMPOSIO_API_KEY
  const composioUserId = env.COMPOSIO_USER_ID

  if (!composioKey || !composioUserId) {
    throw new Error('ensureOAuth requires COMPOSIO_API_KEY and COMPOSIO_USER_ID in env')
  }

  const composioUrl = `https://backend.composio.dev/api/v3/connected_accounts?entityId=${encodeURIComponent(composioUserId)}&toolkit=github&status=ACTIVE`
  const composioRes = await fetch(composioUrl, {
    headers: { 'x-api-key': composioKey, 'Content-Type': 'application/json' },
  })

  if (!composioRes.ok) {
    throw new Error(`Composio API error: ${composioRes.status} ${await composioRes.text()}`)
  }

  const composioData = (await composioRes.json()) as {
    items?: Array<{ id: string; toolkit?: { slug?: string } }>
  }

  const connections = composioData.items ?? []
  const githubConn = connections.find((c) => c.toolkit?.slug === 'github')

  if (!githubConn) {
    throw new Error(
      `No active GitHub connection found in Composio for entity "${composioUserId}". ` +
        `Please connect GitHub via Composio first.`,
    )
  }

  console.log(`    Found Composio GitHub connection: ${githubConn.id}`)

  const listRes = await fetch(`${baseUrl}/api/connected-accounts`)
  if (!listRes.ok) {
    throw new Error(`Failed to list connected accounts: ${listRes.status}`)
  }

  const listData = await listRes.json()
  const accounts: Array<{ composioConnectionId: string }> = Array.isArray(listData)
    ? listData
    : (listData.accounts ?? [])
  const existing = accounts.find((a) => a.composioConnectionId === githubConn.id)

  if (existing) {
    console.log(`    GitHub connection already registered in SuperAgent.`)
    return
  }

  const registerRes = await fetch(`${baseUrl}/api/connected-accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      composioConnectionId: githubConn.id,
      toolkitSlug: 'github',
      displayName: 'GitHub',
    }),
  })

  if (!registerRes.ok) {
    throw new Error(`Failed to register GitHub connection: ${registerRes.status} ${await registerRes.text()}`)
  }

  console.log(`    GitHub connection registered successfully.`)
}
