import { useState } from 'react'
import { AlertCircle, ArrowUpRight, LayoutGrid, Loader2, RefreshCw } from 'lucide-react'
import { AppLink } from '@renderer/components/ui/app-link'
import { useIsDark } from '@renderer/hooks/use-theme'
import { useRefreshWidget, useWidgetHtml, type ApiAgentWidget } from '@renderer/hooks/use-widgets'
import { cn } from '@shared/lib/utils/cn'

/**
 * One home-screen widget. The snapshot HTML is shown in a sandboxed iframe
 * with no script or network allowance — the platform's contract with widget
 * authors is "static, data baked in", and this is where it is enforced.
 *
 * `fill` fills a widget-grid tile on App Home; `push` sizes itself for the
 * Agent Home right column (square for small, 2:1 for medium). An artifact
 * that is also a dashboard shows its widget instead of a screenshot, and
 * the card links to that dashboard.
 */
export function WidgetCard({
  widget,
  agentSlug,
  variant = 'push',
  className,
}: {
  widget: ApiAgentWidget
  agentSlug: string
  variant?: 'fill' | 'push'
  className?: string
}) {
  const isDark = useIsDark()
  const refresh = useRefreshWidget()
  const [frameLoaded, setFrameLoaded] = useState(false)
  const scheme = isDark ? 'dark' : 'light'
  // Inlined, not framed by URL: the renderer's origin is not the API's origin
  // in either Electron build, and the document's own frame-ancestors would
  // block it there. It arrives with its CSP in a meta tag.
  const { data: html } = useWidgetHtml(agentSlug, widget, scheme)
  const src = widget.hasHtml && html ? html : null
  const refreshing = widget.refreshing || refresh.isPending
  const errorText = widget.lastError

  const surface = (
    <>
      {src ? (
        <iframe
          key={`${widget.htmlHash ?? 'none'}:${scheme}`}
          srcDoc={src}
          title={widget.name}
          // Empty sandbox: no scripts, no same-origin, no forms, no popups.
          sandbox=""
          loading="lazy"
          onLoad={() => setFrameLoaded(true)}
          className={cn(
            'pointer-events-none absolute inset-0 h-full w-full border-0 bg-transparent transition-opacity duration-200',
            frameLoaded ? 'opacity-100' : 'opacity-0',
          )}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center bg-muted/40">
          <LayoutGrid className="h-8 w-8 text-muted-foreground/50" />
        </div>
      )}
      {src && !frameLoaded && (
        <div className="absolute inset-0 flex items-center justify-center bg-muted/30">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/60" />
        </div>
      )}
      {refreshing && (
        <div
          className="absolute left-2 top-2 z-20 flex h-6 w-6 items-center justify-center rounded-full bg-background/80 shadow-sm backdrop-blur"
          data-testid="widget-refreshing"
          aria-label="Refreshing"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        </div>
      )}
      {!refreshing && errorText && (
        <div
          className="absolute left-2 top-2 z-20 flex h-6 w-6 items-center justify-center rounded-full bg-background/80 text-destructive shadow-sm backdrop-blur"
          title={`Last refresh failed: ${errorText}`}
          data-testid="widget-error"
        >
          <AlertCircle className="h-3.5 w-3.5" />
        </div>
      )}
    </>
  )

  const actionVisibility = 'opacity-0 transition-opacity duration-200 group-hover/card:opacity-100 group-focus-within/card:opacity-100'
  const frameClass = cn(
    'group/card relative block h-full w-full overflow-hidden rounded-card border bg-card text-left shadow-sm transition-[box-shadow,border-color] duration-150 hover:border-accent-foreground/20',
    className,
  )
  const testId = `widget-card-${widget.slug}`

  // The card is a link (the widget IS this artifact's glance: tapping it opens
  // the dashboard half, or the agent), but the refresh button cannot live
  // inside an <a>. So the link is an overlay filling the card, with the button
  // stacked above it — no interactive element nested in another.
  const link = widget.hasDashboard ? (
    <AppLink
      to="/agents/$slug/dashboards/$dashSlug"
      params={{ slug: agentSlug, dashSlug: widget.slug }}
      draggable={false}
      data-widget-drag-surface=""
      aria-label={`Open ${widget.name}`}
      className={cn('absolute inset-0 z-10 flex items-end justify-end', variant === 'fill' ? 'p-2.5' : 'p-3')}
    >
      <span
        className={cn(
          'inline-flex h-6 items-center gap-1 rounded-control border border-input bg-background px-2 text-xs font-medium shadow-sm [&_svg]:size-3.5',
          actionVisibility,
        )}
      >
        Open app
        <ArrowUpRight />
      </span>
    </AppLink>
  ) : variant === 'fill' ? (
    <AppLink
      to="/agents/$slug"
      params={{ slug: agentSlug }}
      draggable={false}
      data-widget-drag-surface=""
      aria-label={`Open ${widget.name}`}
      className="absolute inset-0 z-10"
    />
  ) : null

  return (
    <div
      data-testid={testId}
      className={frameClass}
      // Without the link there is no named element on the card at all — the
      // design has no visible title — so the group carries the name itself.
      {...(link ? {} : { role: 'group', 'aria-label': widget.name })}
    >
      {surface}
      {link}
      <button
        type="button"
        aria-label={`Refresh ${widget.name}`}
        disabled={refreshing}
        onClick={(event) => {
          event.stopPropagation()
          refresh.mutate({ agentSlug, widgetSlug: widget.slug })
        }}
        className={cn(
          'absolute z-20 inline-flex h-6 w-6 items-center justify-center rounded-control border border-input bg-background text-muted-foreground shadow-sm hover:text-foreground [&_svg]:size-3.5',
          variant === 'fill' ? 'bottom-2.5 left-2.5' : 'bottom-3 left-3',
          actionVisibility,
        )}
      >
        <RefreshCw className={cn(refreshing && 'animate-spin opacity-50')} />
      </button>
    </div>
  )
}
