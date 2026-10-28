import { ConnectionsView } from '@renderer/components/connections/connections-view'
import { useRouteLocation } from '@renderer/router/use-route-location'
import { useAgentSlug } from './use-agent-slug'

export function ConnectionsRoute() {
  const slug = useAgentSlug()
  const { view } = useRouteLocation()
  const detail = view.kind === 'connections' ? view.detail ?? null : null
  if (!slug) return null
  return <ConnectionsView agentSlug={slug} detail={detail} />
}
