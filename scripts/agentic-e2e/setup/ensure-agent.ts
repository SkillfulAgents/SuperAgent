/**
 * ensureAgent: Creates an agent via API, starts its container, and waits until it's running.
 * Returns the agent slug for later cleanup.
 *
 * deleteAgent: Removes an agent via API (stops container + deletes data).
 */

const POLL_INTERVAL_MS = 3000
const START_TIMEOUT_MS = 120_000

export async function ensureAgent(baseUrl: string, agentName: string): Promise<string> {
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

  console.log(`    Starting agent container...`)
  const startRes = await fetch(`${baseUrl}/api/agents/${agent.slug}/start`, {
    method: 'POST',
  })

  if (!startRes.ok) {
    throw new Error(`Failed to start agent: ${startRes.status} ${await startRes.text()}`)
  }

  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    const statusRes = await fetch(`${baseUrl}/api/agents/${agent.slug}`)
    if (statusRes.ok) {
      const current = (await statusRes.json()) as { status: string }
      if (current.status === 'running') {
        console.log(`    Agent is running.`)
        return agent.slug
      }
      console.log(`    Waiting for agent... (status: ${current.status})`)
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }

  throw new Error(`Agent "${agentName}" did not reach running state within ${START_TIMEOUT_MS / 1000}s`)
}

export async function deleteAgent(baseUrl: string, slug: string): Promise<void> {
  console.log(`    Deleting agent "${slug}" via API...`)
  const res = await fetch(`${baseUrl}/api/agents/${slug}`, { method: 'DELETE' })
  if (!res.ok && res.status !== 404) {
    console.warn(`    Warning: failed to delete agent ${slug}: ${res.status}`)
  } else {
    console.log(`    Agent deleted.`)
  }
}
