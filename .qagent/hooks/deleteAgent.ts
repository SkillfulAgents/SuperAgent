import type { SetupContext } from 'qagent'

/**
 * Deletes the agent that was created by ensureAgent.
 * Reads agentSlug from ctx.store.
 */
export default async function deleteAgent(ctx: SetupContext): Promise<void> {
  const { store } = ctx
  const baseUrl = (store.get('apiBaseUrl') as string | undefined) ?? ctx.baseUrl
  const slug = store.get('agentSlug') as string | undefined

  if (!slug) {
    console.log(`    [teardown] No agentSlug in store, skipping agent deletion.`)
    return
  }

  console.log(`    Deleting agent "${slug}" via API...`)
  const res = await fetch(`${baseUrl}/api/agents/${slug}`, { method: 'DELETE' })

  if (!res.ok && res.status !== 404) {
    console.warn(`    Warning: failed to delete agent ${slug}: ${res.status}`)
  } else {
    console.log(`    Agent deleted.`)
  }
}
