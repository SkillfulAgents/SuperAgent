import { z } from 'zod'
import { appState, defineNamespace } from '@shared/lib/app-state'
import type { ApiAgent } from '@shared/lib/types/api'

// A tab can lose its POST response while the host is still creating its agent.
// The request belongs to the signed-in user and remembers only the agent ID.
const requests = defineNamespace({
  name: 'flow:agent-creation',
  consistency: 'strong',
  schema: z.object({ slug: z.string().nullable() }),
  expiry: { ttlMs: 24 * 60 * 60_000, onUpdate: 'reset' },
})

export async function createAgentOnce(userId: string, requestId: string | undefined, create: () => Promise<ApiAgent>) {
  if (!requestId) return { created: await create() }
  const state = appState()
  const key = requests.key(userId, requestId)
  const claim = await state.insertIfAbsent(key, { slug: null })
  if (!claim.inserted) return { existingSlug: claim.current.value.slug }

  let agent: ApiAgent
  try {
    agent = await create()
  } catch (error) {
    await state.consume(key, { revision: claim.entry.revision })
    throw error
  }
  await state.compareAndSet(key, claim.entry.revision, { slug: agent.slug })
  return { created: agent }
}
