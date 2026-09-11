import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'

import { cn } from '@shared/lib/utils/cn'
import { Button } from '@renderer/components/ui/button'
import { buildBillingEmbedUrl, platformOriginFromBaseUrl, type BillingEmbedView } from '@renderer/lib/billing-embed'
import { openExternalUrl } from '@renderer/lib/open-external'

export const BILLING_EMBED_MESSAGE_TYPE = 'gamut-billing-embed'
type BillingEmbedEvent = 'ready' | 'billing-updated' | 'session-expired' | 'resize' | 'open-billing' | 'close' | 'cta-state'
const FRAME_MIN_HEIGHT = 64
const FRAME_MAX_HEIGHT = 640
const FRAME_DEFAULT_HEIGHT = 300
// The expanded launcher sits in the bottom-pinned composer footer, so it must fit the
// viewport minus the app header and card chrome; the embed document scrolls past this.
export const LAUNCHER_MAX_HEIGHT = 'calc(100dvh - 160px)'
const MAX_SEATS = 10_000
const MAX_SEAT_PRICE_CENTS = 100_000_00
export const FRAME_READY_TIMEOUT_MS = 15_000

/** The subscribe quote the platform CTA reports, so the host can draw the price block. */
export interface SubscribePlan {
  seats: number
  seatPriceCents: number
}

interface EmbedMessage {
  event: BillingEmbedEvent
  orgId: string | null
  height?: number
  hint?: string
  label?: string
  plan?: SubscribePlan
}

function readPlan(seats: unknown, seatPriceCents: unknown): SubscribePlan | undefined {
  if (typeof seats !== 'number' || !Number.isInteger(seats) || seats < 1 || seats > MAX_SEATS) return undefined
  if (typeof seatPriceCents !== 'number' || !Number.isInteger(seatPriceCents) || seatPriceCents < 0 || seatPriceCents > MAX_SEAT_PRICE_CENTS) return undefined
  return { seats, seatPriceCents }
}

function readEmbedMessage(data: unknown): EmbedMessage | null {
  if (typeof data !== 'object' || data === null) return null
  const record = data as {
    type?: unknown; event?: unknown; orgId?: unknown; height?: unknown; hint?: unknown; label?: unknown
    seats?: unknown; seatPriceCents?: unknown
  }
  if (record.type !== BILLING_EMBED_MESSAGE_TYPE) return null
  if (
    record.event !== 'ready' && record.event !== 'billing-updated' && record.event !== 'session-expired' &&
    record.event !== 'resize' && record.event !== 'open-billing' && record.event !== 'close' && record.event !== 'cta-state'
  ) return null
  return {
    event: record.event,
    orgId: typeof record.orgId === 'string' ? record.orgId : null,
    height: typeof record.height === 'number' && Number.isFinite(record.height) ? record.height : undefined,
    hint: typeof record.hint === 'string' && record.hint.length <= 300 ? record.hint : undefined,
    label: typeof record.label === 'string' && record.label.length <= 40 ? record.label : undefined,
    plan: readPlan(record.seats, record.seatPriceCents),
  }
}

function clampHeight(height: number): number {
  return Math.min(FRAME_MAX_HEIGHT, Math.max(FRAME_MIN_HEIGHT, Math.ceil(height)))
}

export interface BillingEmbedFrameProps {
  intent?: 'topup'
  cta?: 'add_card'
  launcher?: boolean
  // Launcher only: the frame now shows a panel, so it takes the full width and its reported height.
  expanded?: boolean
  // Launcher only: fill the column the host puts the CTA in (the subscribe price block).
  stretch?: boolean
  // Launcher only: the platform draws the CTA in brand blue; the host's size reference matches it.
  tone?: 'default' | 'brand'
  label?: string
  onOpenBilling?: () => void
  /** The platform panel asked to collapse back to the banner (its close control). */
  onClose?: () => void
  onHintChange?: (hint: string) => void
  /** Subscribe CTA only: the seat count and per-seat price the platform will bill. */
  onPlanChange?: (plan: SubscribePlan) => void
  view: BillingEmbedView
  orgId: string | null
  platformBaseUrl: string | null
  fallbackHref: string | null
  onBillingUpdated: () => void
  onOpenExternal: () => void
}

type Failure = 'no_org' | 'expired' | 'timeout'
const FAILURE_MESSAGE: Record<Failure, string> = {
  no_org: 'Could not open billing.',
  expired: 'This billing session has expired.',
  timeout: 'Billing is taking too long to load.',
}

export const BRAND_BUTTON_CLASS = 'bg-brand text-white hover:bg-brand/90'

export function BillingEmbedFrame({
  intent, cta, launcher = false, expanded = false, stretch = false, tone = 'default', label = 'Open billing',
  onOpenBilling, onClose, onHintChange, onPlanChange,
  view, orgId, platformBaseUrl, fallbackHref, onBillingUpdated, onOpenExternal,
}: BillingEmbedFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const platformOrigin = platformOriginFromBaseUrl(platformBaseUrl)
  const [frameReady, setFrameReady] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(orgId && platformOrigin ? null : 'no_org')
  const [height, setHeight] = useState(FRAME_DEFAULT_HEIGHT)
  const [attempt, setAttempt] = useState(0)
  // Frozen per attempt: changing `src` navigates the iframe to a new document, which
  // drops its storage-access grant and any panel it was showing.
  const buildSrc = useCallback(() => orgId && platformOrigin
    ? buildBillingEmbedUrl(platformBaseUrl, orgId, { view, intent, cta, surface: launcher ? 'cta' : undefined, parent: window.location.origin })
    : null, [orgId, platformOrigin, platformBaseUrl, view, intent, cta, launcher])
  const [src, setSrc] = useState(buildSrc)
  const [hint, setHint] = useState('')
  const [frameLabel, setFrameLabel] = useState(label)
  useEffect(() => {
    if (launcher) onHintChange?.(failure ? FAILURE_MESSAGE[failure] : hint)
  }, [failure, hint, launcher, onHintChange])

  const sendTheme = useCallback(() => {
    if (!platformOrigin || !orgId) return
    iframeRef.current?.contentWindow?.postMessage({
      type: 'gamut-billing-theme', orgId,
      theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
    }, platformOrigin)
  }, [platformOrigin, orgId])

  useEffect(() => {
    const observer = new MutationObserver(sendTheme)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [sendTheme])

  const retry = useCallback(() => {
    setFrameReady(false)
    setFailure(orgId && platformOrigin ? null : 'no_org')
    setHeight(FRAME_DEFAULT_HEIGHT)
    setHint('')
    setSrc(buildSrc())
    setAttempt(n => n + 1)
  }, [orgId, platformOrigin, buildSrc])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!platformOrigin || event.origin !== platformOrigin) return
      const frameWindow = iframeRef.current?.contentWindow
      if (!frameWindow || event.source !== frameWindow) return
      const message = readEmbedMessage(event.data)
      if (!message || message.orgId !== orgId) return
      if (message.event === 'ready') { setFrameReady(true); sendTheme() }
      else if (message.event === 'open-billing' && launcher && view === 'topup') onOpenBilling?.()
      else if (message.event === 'close' && launcher) onClose?.()
      else if (message.event === 'billing-updated') onBillingUpdated()
      else if (message.event === 'session-expired') setFailure('expired')
      else if (message.event === 'resize' && (!launcher || expanded) && message.height !== undefined) setHeight(clampHeight(message.height))
      else if (message.event === 'cta-state' && launcher) {
        if (message.hint !== undefined) setHint(message.hint)
        if (message.label) setFrameLabel(message.label)
        if (message.plan && view === 'subscribe') onPlanChange?.(message.plan)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [orgId, platformOrigin, onBillingUpdated, launcher, expanded, onOpenBilling, onClose, onPlanChange, view, sendTheme])

  useEffect(() => {
    if (frameReady || failure) return
    const timer = window.setTimeout(() => setFailure('timeout'), FRAME_READY_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [frameReady, failure, attempt])

  const openFallback = () => {
    if (!fallbackHref) return
    void openExternalUrl(fallbackHref)
    onOpenExternal()
  }

  // Same iframe element in both layouts; only the box around it changes.
  if (launcher) return (
    <div className={cn('flex min-w-0 flex-col gap-1', expanded || stretch ? 'w-full items-stretch' : 'items-end')}>
      {!onHintChange && (hint || failure) && <p className="max-w-xs text-right text-xs text-muted-foreground" data-testid="billing-cta-hint">{failure ? FAILURE_MESSAGE[failure] : hint}</p>}
      {failure ? (
        <Button size="sm" title={FAILURE_MESSAGE[failure]} disabled={!fallbackHref} onClick={openFallback}>Open billing in a new tab</Button>
      ) : (
        <div className={cn('relative', expanded || stretch ? 'w-full' : 'shrink-0')} style={expanded ? { height, maxHeight: LAUNCHER_MAX_HEIGHT } : undefined} data-testid="billing-cta-body" data-expanded={expanded}>
          <Button
            size="sm"
            className={cn(expanded ? 'hidden' : frameReady ? 'invisible' : '', stretch && 'w-full', tone === 'brand' && BRAND_BUTTON_CLASS)}
            disabled tabIndex={-1} aria-hidden="true" data-testid="billing-cta-size-reference"
          >
            {frameLabel}
          </Button>
          {src && <iframe key={attempt} ref={iframeRef} title="Open workspace billing" src={src} onLoad={sendTheme}
            className="absolute inset-0 block h-full w-full border-0 bg-transparent" style={{ visibility: frameReady ? 'visible' : 'hidden' }}
            referrerPolicy="strict-origin" data-testid="billing-cta-frame" />}
          {!frameReady && <span role="status" className="sr-only" data-testid="billing-embed-loading">Loading billing…</span>}
        </div>
      )}
    </div>
  )

  return (
    <div className="relative min-h-0 w-full overflow-hidden" style={{ height: failure ? undefined : height, maxHeight: 'calc(90dvh - 120px)' }} data-testid="billing-embed-body">
      {failure ? (
        <div className="flex flex-col items-start gap-3 py-2">
          <p className="text-sm text-muted-foreground">{FAILURE_MESSAGE[failure]}</p>
          <div className="flex items-center gap-2">
            {failure !== 'no_org' && <Button size="sm" variant="outline" onClick={retry}>Try again</Button>}
            {fallbackHref && <Button size="sm" onClick={openFallback}>Open billing in a new tab</Button>}
          </div>
        </div>
      ) : (
        <>
          {src && <iframe key={attempt} ref={iframeRef} title="Workspace billing" src={src} onLoad={sendTheme}
            className="block h-full w-full border-0 bg-transparent" referrerPolicy="strict-origin" data-testid="billing-embed-frame" />}
          {!frameReady && <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 bg-card/80 text-xs text-muted-foreground" data-testid="billing-embed-loading">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />Loading billing…
          </div>}
        </>
      )}
    </div>
  )
}
