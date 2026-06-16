import { useSelection } from '@renderer/context/selection-context'
import { useNavigate } from '@tanstack/react-router'
import { getApiBaseUrl } from '@renderer/lib/env'
import { SquareMousePointer, ArrowUpRight } from 'lucide-react'
import type { ApiAgentDashboard } from '@shared/lib/types/api'

function CardContent({ screenshotUrl }: { screenshotUrl: string | null }) {
  return screenshotUrl ? (
    <img
      src={screenshotUrl}
      alt=""
      className="absolute inset-0 h-full w-full object-cover object-top"
      loading="lazy"
      draggable={false}
    />
  ) : (
    <div className="absolute inset-0 flex items-center justify-center bg-muted/40">
      <SquareMousePointer className="h-8 w-8 text-muted-foreground/50" />
    </div>
  )
}

export function DashboardCard({
  dashboard,
  agentSlug,
  variant = 'push',
}: {
  dashboard: ApiAgentDashboard
  agentSlug: string
  variant?: 'overlay' | 'push'
}) {
  const { setAgent } = useSelection()
  const navigate = useNavigate()

  const handleClick = () => {
    setAgent(agentSlug, { kind: 'dashboard', slug: dashboard.slug })
    void navigate({ to: '/agents/$slug', params: { slug: agentSlug } })
  }

  const screenshotUrl = dashboard.hasScreenshot
    ? `${getApiBaseUrl()}/api/agents/${encodeURIComponent(agentSlug)}/artifacts/${encodeURIComponent(dashboard.slug)}/screenshot.png`
    : null

  if (variant === 'overlay') {
    return (
      <div className="relative h-24 group z-0 hover:z-20 [transition:z-index_0s_420ms] hover:[transition:z-index_0s]">
        <button
          onClick={handleClick}
          className="absolute inset-x-0 top-0 h-24 group-hover:h-40 group-hover:scale-x-[1.04] group-hover:shadow-lg rounded-lg border bg-card hover:border-accent-foreground/20 text-left overflow-hidden origin-top [transition:transform_150ms_ease-out,height_300ms_cubic-bezier(0.2,0.8,0.2,1)_120ms,box-shadow_250ms_ease-out,border-color_200ms_ease-out]"
        >
          <CardContent screenshotUrl={screenshotUrl} />
          <div className="relative z-10 flex h-full flex-col items-end justify-end p-3 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
            <span className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-3 h-8 text-xs font-medium shadow-sm [&_svg]:size-4">
              Open app
              <ArrowUpRight />
            </span>
          </div>
        </button>
      </div>
    )
  }

  return (
    <div className="group">
      <button
        onClick={handleClick}
        className="relative w-full h-24 group-hover:h-40 group-hover:shadow-lg rounded-lg border bg-card hover:border-accent-foreground/20 text-left overflow-hidden [transition:height_300ms_cubic-bezier(0.2,0.8,0.2,1),box-shadow_250ms_ease-out,border-color_200ms_ease-out]"
      >
        <CardContent screenshotUrl={screenshotUrl} />
        <div className="relative z-10 flex h-full flex-col items-end justify-end p-3 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
          <span className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-3 h-8 text-xs font-medium shadow-sm [&_svg]:size-4">
            Open app
            <ArrowUpRight />
          </span>
        </div>
      </button>
    </div>
  )
}
