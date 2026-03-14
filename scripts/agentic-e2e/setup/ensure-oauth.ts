/**
 * ensureOAuth: Registers an existing Composio GitHub connected account into SuperAgent.
 *
 * Requires:
 *   - COMPOSIO_API_KEY in env (Composio platform API key)
 *   - COMPOSIO_USER_ID in env (Composio entity/user ID)
 *
 * Strategy:
 *   1. Query Composio API to find an active GitHub connection for the entity.
 *   2. Register that connection in SuperAgent via POST /api/connected-accounts.
 *   3. If the connection is already registered, skip.
 */
export async function ensureOAuth(baseUrl: string): Promise<void> {
  const composioKey = process.env.COMPOSIO_API_KEY
  const composioUserId = process.env.COMPOSIO_USER_ID

  if (!composioKey || !composioUserId) {
    throw new Error('ensureGitHub requires COMPOSIO_API_KEY and COMPOSIO_USER_ID in env')
  }

  // Fetch connected accounts from Composio
  const composioUrl = `https://backend.composio.dev/api/v1/connectedAccounts?entityId=${encodeURIComponent(composioUserId)}&toolkit=github&status=ACTIVE`
  const composioRes = await fetch(composioUrl, {
    headers: {
      'x-api-key': composioKey,
      Accept: 'application/json',
    },
  })

  if (!composioRes.ok) {
    throw new Error(`Composio API error: ${composioRes.status} ${await composioRes.text()}`)
  }

  const composioData = (await composioRes.json()) as {
    items?: Array<{ id: string; appName?: string; appUniqueId?: string; connectionParams?: { scope?: string } }>
  }

  const connections = composioData.items ?? []
  const githubConn = connections.find((c) => c.appName === 'github' || c.appUniqueId === 'github')

  if (!githubConn) {
    throw new Error(
      `No active GitHub connection found in Composio for entity "${composioUserId}". ` +
      `Please connect GitHub via Composio first.`,
    )
  }

  console.log(`    Found Composio GitHub connection: ${githubConn.id}`)

  // Check if already registered in SuperAgent
  const listRes = await fetch(`${baseUrl}/api/connected-accounts`)
  if (!listRes.ok) {
    throw new Error(`Failed to list connected accounts: ${listRes.status}`)
  }

  const listData = await listRes.json()
  const accounts: Array<{ composioConnectionId: string }> = Array.isArray(listData) ? listData : (listData.accounts ?? [])
  const existing = accounts.find((a) => a.composioConnectionId === githubConn.id)

  if (existing) {
    console.log(`    GitHub connection already registered in SuperAgent.`)
    return
  }

  // Register in SuperAgent
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
