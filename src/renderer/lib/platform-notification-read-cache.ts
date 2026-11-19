import type { QueryClient } from '@tanstack/react-query'
import { apiFetch } from './api'

/** Every entry point (inbox, detail, OS click) reconciles even a lost response. */
export async function readPlatformNotifications(client: QueryClient, ids?: string[]) {
  const workspace = client.getQueryCache().find({ queryKey: ['agents'], exact: true })
  try {
    const response = await apiFetch(`/api/platform-notifications/${ids ? 'read' : 'read-all'}`, {
      method: 'POST',
      ...(ids ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) } : {}),
    })
    if (!response.ok) throw new Error('Failed to mark platform notifications read')
    return await response.json()
  } finally {
    // The platform returns an updated-row count, not a complete projection;
    // reread both the rows and the badge, including after a partially failed bulk ack.
    if (!workspace || client.getQueryCache().get(workspace.queryHash) === workspace) {
      const queries = new Set(client.getQueryCache().findAll({ queryKey: ['platform-notifications'] }))
      // Also restart initial loads: invalidateQueries otherwise lets a
      // pending GET without cached data publish its pre-write unread count.
      await client.cancelQueries({ predicate: query => queries.has(query) })
      client.invalidateQueries({ predicate: query => queries.has(query) })
    }
  }
}
