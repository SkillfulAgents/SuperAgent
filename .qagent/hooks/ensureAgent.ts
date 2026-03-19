import type { SetupContext } from 'qagent'

const POLL_INTERVAL_MS = 3000
const START_TIMEOUT_MS = 120_000

function generateAgentName(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  const hour = String(now.getHours()).padStart(2, '0')
  const min = String(now.getMinutes()).padStart(2, '0')
  const sec = String(now.getSeconds()).padStart(2, '0')
  const rand = Math.random().toString(36).slice(2, 6)
  return `QA-${now.getFullYear()}${month}${day}-${hour}${min}${sec}-${rand}`
}

/**
 * Creates an agent via the SuperAgent API, starts its container, and waits
 * until it reaches "running" state.
 *
 * Stores `agentName` and `agentSlug` in ctx.store for use by teardown hooks.
 */
export default async function ensureAgent(ctx: SetupContext): Promise<void> {
  const { store } = ctx
  const baseUrl = (store.get('apiBaseUrl') as string | undefined) ?? ctx.baseUrl
  const agentName = generateAgentName()

  console.log(`    Creating agent "${agentName}" via API...`)

  const createRes = await fetch(`${baseUrl}/api/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: agentName }),
  })

  if (!createRes.ok) {
    throw new Error(`Failed to create agent: ${createRes.status} ${await createRes.text()}`)
  }

  const agent = (await createRes.json()) as { slug: string; name: string; status: string }
  console.log(`    Agent created: slug=${agent.slug}, status=${agent.status}`)

  const startRes = await fetch(`${baseUrl}/api/agents/${agent.slug}/start`, { method: 'POST' })
  if (!startRes.ok) {
    throw new Error(`Failed to start agent: ${startRes.status} ${await startRes.text()}`)
  }

  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    const statusRes = await fetch(`${baseUrl}/api/agents/${agent.slug}`)
    if (statusRes.ok) {
      const current = (await statusRes.json()) as { status: string }
      if (current.status === 'running' || current.status === 'idle') {
        console.log(`    Agent is ${current.status}.`)
        store.set('agentName', agentName)
        store.set('agentSlug', agent.slug)
        return
      }
      console.log(`    Waiting for agent... (status: ${current.status})`)
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }

  throw new Error(`Agent "${agentName}" did not reach running state within ${START_TIMEOUT_MS / 1000}s`)
}
