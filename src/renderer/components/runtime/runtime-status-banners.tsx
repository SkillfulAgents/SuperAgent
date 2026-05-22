import { AlertCircle, AlertTriangle, Loader2, WifiOff, X } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'

// Sidebar banners — sit above the SuperAgent wordmark, full sidebar width.

/**
 * Wraps any combination of sidebar banners with consistent horizontal padding,
 * a small inter-banner gap (so stacked banners don't compound their margins),
 * and a trailing space below the group before the wordmark.
 *
 * Render only when at least one banner is visible to avoid a stray padded div.
 */
export function SidebarBannerStack({ children }: { children: React.ReactNode }) {
  return <div className="px-2 pb-6 flex flex-col gap-2">{children}</div>
}

// Destructive banner shell — two flex columns (icon circle + text), both
// vertically centered in the row. Built without the Alert primitive so we
// don't fight its grid layout when we need a non-svg icon wrapper.
function DestructiveBannerCard({
  icon,
  children,
  onClick,
}: {
  icon: React.ReactNode
  children: React.ReactNode
  onClick?: () => void
}) {
  return (
    <div
      role={onClick ? 'button' : 'alert'}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      } : undefined}
      className={cn(
        'flex items-center gap-3 rounded-lg shadow-md bg-background pl-3 pr-4 py-2 text-destructive',
        onClick && 'cursor-pointer hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
      )}
    >
      <div className="flex items-center justify-center h-7 w-7 rounded-full bg-destructive/10 shrink-0">
        {icon}
      </div>
      <div className="text-xs flex-1 min-w-0">{children}</div>
    </div>
  )
}

export function OfflineSidebarBanner() {
  return (
    <DestructiveBannerCard icon={<WifiOff className="h-4 w-4" />}>
      <div>No internet connection.</div>
      <div>Some features may be unavailable.</div>
    </DestructiveBannerCard>
  )
}

export function RuntimeUnavailableSidebarBanner({
  message,
  onOpenSettings,
}: {
  message?: string
  onOpenSettings?: () => void
}) {
  // Split on ". " so multi-sentence messages render one sentence per line.
  const sentences = (message || 'Container runtime not available.').split(/(?<=\.)\s+/)
  return (
    <DestructiveBannerCard
      icon={<AlertTriangle className="h-4 w-4" />}
      onClick={onOpenSettings}
    >
      {sentences.map((sentence, i) => (
        <div key={i}>{sentence}</div>
      ))}
      <div className="underline">Open settings →</div>
    </DestructiveBannerCard>
  )
}

// Loading banner shell — text on the left, spinner on the right, both
// vertically centered. Built without the Alert primitive so the icon can
// trail the text (Alert's grid forces the svg into column 1).
function LoadingBannerCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-lg shadow-md bg-background pl-4 pr-3 py-2">
      <div className="text-xs flex-1 min-w-0">{children}</div>
      <Loader2 className="h-4 w-4 animate-spin shrink-0 text-muted-foreground" />
    </div>
  )
}

export function RuntimeCheckingSidebarBanner({ message }: { message?: string }) {
  return <LoadingBannerCard>{message || 'Starting runtime...'}</LoadingBannerCard>
}

export function RuntimePullingSidebarBanner({
  message,
  percent,
}: {
  message?: string
  percent?: number | null
}) {
  return (
    <LoadingBannerCard>
      {message || 'Preparing agent image...'}
      {percent != null && <span className="ml-1">({percent}%)</span>}
    </LoadingBannerCard>
  )
}

// Chat-top banners — sit above the chat content, full chat width.

export function PullingImageChatBanner({
  status,
  percent,
}: {
  status: string
  percent: number | null
}) {
  return (
    <div className="shrink-0 border-b bg-muted/30 px-4 py-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span>Pulling agent image... {status}</span>
        {percent != null && <span>({percent}%)</span>}
      </div>
      {percent != null && (
        <div className="mt-1 h-1 w-full bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-primary transition-all duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
    </div>
  )
}

export function AgentStartErrorChatBanner({ error }: { error: string }) {
  return (
    <div className="shrink-0 border-b bg-destructive/10 px-4 py-2">
      <div className="flex items-center gap-2 text-xs text-destructive select-text">
        <AlertCircle className="h-3 w-3 shrink-0" />
        <span>Failed to start agent: {error}</span>
      </div>
    </div>
  )
}

// ---------- Floating chat-top toasts ----------

/**
 * Wraps a chat-top toast in an absolutely-positioned slot so it floats over
 * the chat content rather than pushing it down. Place this inside a `relative`
 * ancestor — ContentShell wraps its children in such a container.
 *
 * `pointer-events-none` on the slot lets clicks pass through to the chat;
 * the inner toast gets `pointer-events-auto` so it can still be interacted with.
 */
export function ChatTopToastSlot({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute -top-3 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
      <div className="pointer-events-auto">{children}</div>
    </div>
  )
}

/**
 * Pulling/loading toast — spinner + message + optional progress %. Visual
 * chrome mirrors Sonner's toast styling (bg-background border-border shadow-lg).
 */
export function PullingImageChatToast({
  status,
  percent,
}: {
  status: string
  percent: number | null
}) {
  // Suppress the sub-detail when it would duplicate the headline (status like
  // "Starting pulling...") or the percent badge ("42% complete").
  const headline = 'Pulling agent image...'
  const detail = (() => {
    const trimmed = status?.trim() ?? ''
    if (!trimmed) return null
    if (/^(starting\s+(pulling|building)|pulling|building)/i.test(trimmed)) return null
    if (percent != null && /\d+\s*%/.test(trimmed)) return null
    return trimmed
  })()

  const hasSubLine = detail != null || percent != null
  return (
    <div className="relative bg-background border border-border shadow-lg rounded-lg overflow-hidden min-w-[280px]">
      <div className="px-4 py-3">
        <div className="text-xs font-normal leading-tight">{headline}</div>
        {hasSubLine && (
          <div className="text-xs text-muted-foreground mt-0.5 leading-snug flex items-center justify-between gap-2">
            <span className="truncate">{detail}</span>
            {percent != null && (
              <span className="tabular-nums shrink-0">{percent}%</span>
            )}
          </div>
        )}
      </div>
      {percent != null && (
        <div className="h-0.5 w-full bg-muted">
          <div
            className="h-full bg-primary transition-all duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
    </div>
  )
}

/**
 * Agent start error toast — destructive accent on the icon, dismissible.
 */
export function AgentStartErrorChatToast({
  error,
  onDismiss,
}: {
  error: string
  onDismiss?: () => void
}) {
  return (
    <div className="bg-background border border-border shadow-lg rounded-lg min-w-[280px] max-w-[420px]">
      <div className="flex items-center gap-2.5 px-4 py-3">
        <div className="flex items-center justify-center h-7 w-7 rounded-full bg-destructive/10 shrink-0">
          <AlertCircle className="h-4 w-4 text-destructive" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-normal text-destructive leading-tight">Failed to start agent</div>
          <div className="text-xs text-muted-foreground mt-0.5 leading-snug select-text">{error}</div>
        </div>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="shrink-0 h-5 w-5 inline-flex items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/5 -mr-1"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}
