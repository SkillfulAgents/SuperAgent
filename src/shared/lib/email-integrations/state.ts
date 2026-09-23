import { z } from 'zod'
import { readIntegrationState, listIntegrationStateKeys } from '../agent-integrations/state-store'

export async function emailThreadRoute(integrationId: string, id: string): Promise<string> {
  const seen = new Set<string>()
  while (!seen.has(id)) {
    seen.add(id)
    const next = await readIntegrationState(integrationId, `route:${id}`, z.string())
    if (!next) return id
    id = next
  }
  throw new Error('Invalid email thread redirect')
}

export function pendingEmailReplies(integrationId: string) {
  return listIntegrationStateKeys(integrationId, { prefix: 'reply-job:', readyBefore: Date.now(), limit: 5 })
}
