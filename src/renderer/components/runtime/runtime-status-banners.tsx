import { AlertTriangle, Loader2, ShieldAlert, WifiOff } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { splitMessageSentences } from './sentence-split'

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
  // Render one sentence per line; splitter is abbreviation/decimal-aware so it
  // doesn't break inside "e.g.", version numbers, etc. (see sentence-split.ts).
  const sentences = splitMessageSentences(message || 'Container runtime not available.')
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

export type FirewallFixUiState = 'idle' | 'fixing' | 'declined' | 'failed'

/**
 * Windows Firewall is blocking container→host connections (browser launch,
 * tool proxies). The fix button triggers one UAC-elevated PowerShell run on
 * the host; the states mirror how that prompt can play out.
 */
export function FirewallBlockedSidebarBanner({
  fixState,
  onFix,
}: {
  fixState: FirewallFixUiState
  onFix: () => void
}) {
  return (
    <DestructiveBannerCard icon={<ShieldAlert className="h-4 w-4" />}>
      <div>Windows Firewall is blocking agent connections.</div>
      <div>Browser and connected tools can&apos;t reach this app.</div>
      {fixState === 'declined' && <div>Approval was declined — an administrator must click Yes.</div>}
      {fixState === 'failed' && <div>Automatic fix failed. Allow this app through Windows Firewall manually.</div>}
      <button
        type="button"
        onClick={onFix}
        disabled={fixState === 'fixing'}
        className="underline disabled:no-underline disabled:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
      >
        {fixState === 'fixing' ? 'Waiting for Windows approval…' : fixState === 'idle' ? 'Fix now →' : 'Try again →'}
      </button>
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
