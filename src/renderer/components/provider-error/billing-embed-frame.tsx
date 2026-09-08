import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'

import { Button } from '@renderer/components/ui/button'
import {
  buildBillingEmbedUrl,
  platformOriginFromBaseUrl,
  type BillingEmbedView,
} from '@renderer/lib/billing-embed'
import { openExternalUrl } from '@renderer/lib/open-external'

export const BILLING_EMBED_MESSAGE_TYPE = 'gamut-billing-embed'
type BillingEmbedEvent = 'ready' | 'billing-updated' | 'session-expired' | 'resize' | 'open-billing'

const FRAME_MIN_HEIGHT = 64
const FRAME_MAX_HEIGHT = 640
const FRAME_DEFAULT_HEIGHT = 300
export const FRAME_READY_TIMEOUT_MS = 15_000

interface EmbedMessage {
  event: BillingEmbedEvent
  orgId: string | null
  height?: number
}

function readEmbedMessage(data: unknown): EmbedMessage | null {
  if (typeof data !== 'object' || data === null) return null
  const record = data as { type?: unknown; event?: unknown; orgId?: unknown; height?: unknown }
  if (record.type !== BILLING_EMBED_MESSAGE_TYPE) return null
  if (
    record.event !== 'ready' &&
    record.event !== 'billing-updated' &&
    record.event !== 'session-expired' &&
    record.event !== 'resize' &&
    record.event !== 'open-billing'
  ) {
    return null
  }
  return {
    event: record.event,
    orgId: typeof record.orgId === 'string' ? record.orgId : null,
    height: typeof record.height === 'number' && Number.isFinite(record.height) ? record.height : undefined,
  }
}

function clampHeight(height: number): number {
  return Math.min(FRAME_MAX_HEIGHT, Math.max(FRAME_MIN_HEIGHT, Math.ceil(height)))
}

export interface BillingEmbedFrameProps {
  intent?: 'topup'
  cta?: 'add_card'
  launcher?: boolean
  onOpenBilling?: () => void
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

export function BillingEmbedFrame({
  intent,
  cta,
  launcher = false,
  onOpenBilling,
  view,
  orgId,
  platformBaseUrl,
  fallbackHref,
  onBillingUpdated,
  onOpenExternal,
}: BillingEmbedFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const platformOrigin = platformOriginFromBaseUrl(platformBaseUrl)
  const [frameReady, setFrameReady] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(orgId && platformOrigin ? null : 'no_org')
  const [height, setHeight] = useState(FRAME_DEFAULT_HEIGHT)
  const [attempt, setAttempt] = useState(0)

  const retry = useCallback(() => {
    setFrameReady(false)
    setFailure(orgId && platformOrigin ? null : 'no_org')
    setHeight(FRAME_DEFAULT_HEIGHT)
    setAttempt((n) => n + 1)
  }, [orgId, platformOrigin])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!platformOrigin || event.origin !== platformOrigin) return
      const frameWindow = iframeRef.current?.contentWindow
      if (!frameWindow || event.source !== frameWindow) return
      const message = readEmbedMessage(event.data)
      if (!message) return
      if (orgId && message.orgId !== orgId) return
      if (message.event === 'ready') setFrameReady(true)
      else if (message.event === 'open-billing' && launcher) onOpenBilling?.()
      else if (message.event === 'billing-updated' && !launcher) onBillingUpdated()
      else if (message.event === 'session-expired') setFailure('expired')
      else if (message.event === 'resize' && message.height !== undefined) setHeight(clampHeight(message.height))
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [orgId, platformOrigin, onBillingUpdated, launcher, onOpenBilling])

  useEffect(() => {
    if (frameReady || failure) return
    const timer = window.setTimeout(() => setFailure('timeout'), FRAME_READY_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [frameReady, failure, attempt])

  const src =
    orgId && platformOrigin
      ? buildBillingEmbedUrl(platformBaseUrl, orgId, { view, intent, cta, surface: launcher ? 'cta' : undefined, parent: window.location.origin })
      : null

  if (failure && launcher) {
    return (
      <Button size="sm" title={FAILURE_MESSAGE[failure]} disabled={!fallbackHref} onClick={() => {
        if (!fallbackHref) return
        void openExternalUrl(fallbackHref)
        onOpenExternal()
      }}>
        Open billing in a new tab
      </Button>
    )
  }

  return (
    <div
      className={launcher ? 'relative w-36 shrink-0 overflow-hidden' : 'relative min-h-0 w-full overflow-hidden'}
      style={{ height: launcher ? 40 : failure ? undefined : height, maxHeight: launcher ? undefined : 'calc(90dvh - 120px)' }}
      data-testid={launcher ? 'billing-cta-body' : 'billing-embed-body'}
    >
      {failure ? (
        <div className="flex flex-col items-start gap-3 py-2">
          <p className="text-sm text-muted-foreground">{FAILURE_MESSAGE[failure]}</p>
          <div className="flex items-center gap-2">
            {failure !== 'no_org' && (
              <Button size="sm" variant="outline" onClick={retry}>
                Try again
              </Button>
            )}
            {fallbackHref && (
              <Button
                size="sm"
                onClick={() => {
                  void openExternalUrl(fallbackHref)
                  onOpenExternal()
                }}
              >
                Open billing in a new tab
              </Button>
            )}
          </div>
        </div>
      ) : (
        <>
          {src && (
            <iframe
              key={attempt}
              ref={iframeRef}
              title={launcher ? 'Open workspace billing' : 'Workspace billing'}
              src={src}
              className="block h-full w-full border-0 bg-transparent"
              referrerPolicy="strict-origin"
              data-testid={launcher ? 'billing-cta-frame' : 'billing-embed-frame'}
            />
          )}
          {!frameReady && (
            <div
              className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 bg-card/80 text-xs text-muted-foreground"
              data-testid="billing-embed-loading"
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              Loading billing…
            </div>
          )}
        </>
      )}
    </div>
  )
}
