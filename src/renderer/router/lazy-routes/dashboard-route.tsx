import { useParams } from '@tanstack/react-router'
import { DashboardView } from '@renderer/components/dashboards/dashboard-view'
import { useAgentSlug } from './use-agent-slug'

export function DashboardRoute() {
  const slug = useAgentSlug()
  const { dashSlug } = useParams({ strict: false }) as { dashSlug?: string }
  if (!slug || !dashSlug) return null
  return <DashboardView key={`${slug}/${dashSlug}`} agentSlug={slug} dashboardSlug={dashSlug} />
}
