import { useSearch } from '@tanstack/react-router'
import { ConnectionsView } from '@renderer/components/connections/connections-view'
import { useAgentSlug } from './use-agent-slug'

export function ConnectionsRoute() {
  const slug = useAgentSlug()
  const search = useSearch({ strict: false }) as {
    detail?: unknown
    source?: unknown
    connectionView?: unknown
  }
  const detailKey = typeof search.detail === 'string' ? search.detail : undefined
  const source: 'home' | 'list' | undefined =
    search.source === 'home' ? 'home' : search.source === 'list' ? 'list' : undefined
  const detailView = search.connectionView === 'logs' ? 'logs' as const : undefined
  const detail = detailKey && source
    ? { rowKey: detailKey, source, ...(detailView ? { view: detailView } : {}) }
    : null
  if (!slug) return null
  return <ConnectionsView agentSlug={slug} detail={detail} />
}
