import { AppLink } from '@renderer/components/ui/app-link'
import { getApiBaseUrl } from '@renderer/lib/env'
import { SquareMousePointer, ArrowUpRight } from 'lucide-react'
import type { ApiAgentDashboard } from '@shared/lib/types/api'

function CardContent({ screenshotUrl, objectClass = 'object-top' }: { screenshotUrl: string | null; objectClass?: string }) {
  return screenshotUrl ? (
    <img
      src={screenshotUrl}
      alt=""
      className={`absolute inset-0 h-full w-full object-cover ${objectClass}`}
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
  align = 'top',
}: {
  dashboard: ApiAgentDashboard
  agentSlug: string
  variant?: 'fill' | 'push'
  /** Screenshot crop anchor for the fill variant (Small tiles read better top-left). */
  align?: 'top' | 'top-left'
}) {
  const linkProps = {
    to: '/agents/$slug/dashboards/$dashSlug',
    params: { slug: agentSlug, dashSlug: dashboard.slug },
  } as const

  const screenshotUrl = dashboard.hasScreenshot
    ? `${getApiBaseUrl()}/api/agents/${encodeURIComponent(agentSlug)}/artifacts/${encodeURIComponent(dashboard.slug)}/screenshot.png`
    : null

  if (variant === 'fill') {
    // Fills its container (a widget-grid tile) — the screenshot is just the card.
    return (
      <AppLink
        {...linkProps}
        className="group relative block h-full w-full overflow-hidden rounded-lg border bg-card text-left shadow-sm transition-[box-shadow,border-color] duration-150 hover:border-accent-foreground/20 group-hover/widget:shadow-md"
      >
        <CardContent screenshotUrl={screenshotUrl} objectClass={align === 'top-left' ? 'object-left-top' : 'object-top'} />
        <div className="relative z-10 flex h-full flex-col items-end justify-end p-2.5 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
          <span className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-2 h-6 text-xs font-medium shadow-sm [&_svg]:size-3.5">
            Open app
            <ArrowUpRight />
          </span>
        </div>
      </AppLink>
    )
  }

  return (
    <div className="group">
      <AppLink
        {...linkProps}
        className="relative block w-full h-24 group-hover:h-40 group-hover:shadow-lg rounded-lg border bg-card hover:border-accent-foreground/20 text-left overflow-hidden [transition:height_300ms_cubic-bezier(0.2,0.8,0.2,1),box-shadow_250ms_ease-out,border-color_200ms_ease-out]"
      >
        <CardContent screenshotUrl={screenshotUrl} />
        <div className="relative z-10 flex h-full flex-col items-end justify-end p-3 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
          <span className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-3 h-8 text-xs font-medium shadow-sm [&_svg]:size-4">
            Open app
            <ArrowUpRight />
          </span>
        </div>
      </AppLink>
    </div>
  )
}
