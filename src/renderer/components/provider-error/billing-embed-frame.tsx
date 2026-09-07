import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'

import { Button } from '@renderer/components/ui/button'
import { useBillingEmbedSession, type BillingEmbedView } from '@renderer/hooks/use-billing-embed'
import { captureRendererException } from '@renderer/lib/error-reporting'
import { openExternalUrl } from '@renderer/lib/open-external'

// Must match the platform's /embed contract (apps/web/src/lib/billing-embed.ts).
export const BILLING_EMBED_MESSAGE_TYPE = 'gamut-billing-embed'
type BillingEmbedEvent = 'ready' | 'billing-updated' | 'session-expired' | 'resize'

const FRAME_MIN_HEIGHT = 64
const FRAME_MAX_HEIGHT = 640
// Until the page reports its height: about the size of the top-up panel.
const FRAME_DEFAULT_HEIGHT = 200

interface EmbedMessage {
  event: BillingEmbedEvent
  height?: number
}

function readEmbedMessage(data: unknown): EmbedMessage | null {
  if (typeof data !== 'object' || data === null) return null
  const record = data as { type?: unknown; event?: unknown; height?: unknown }
  if (record.type !== BILLING_EMBED_MESSAGE_TYPE) return null
  if (
    record.event !== 'ready' &&
    record.event !== 'billing-updated' &&
    record.event !== 'session-expired' &&
    record.event !== 'resize'
  ) {
    return null
  }
  return { event: record.event, height: typeof record.height === 'number' ? record.height : undefined }
}

function clampHeight(height: number): number {
  return Math.min(FRAME_MAX_HEIGHT, Math.max(FRAME_MIN_HEIGHT, Math.ceil(height)))
}

export interface BillingEmbedFrameProps {
  intent?: 'topup'
  /** Which chrome-less platform panel to load; it reports its height back. */
  view: BillingEmbedView
  /** External billing URL for the fallback button. */
  fallbackHref: string | null
  /** Fired on every `billing-updated` from the platform page. */
  onBillingUpdated: () => void
}

// Web paywall body: the platform's top-up panel inline, where the composer was.
// The iframe URL is a one-time session bootstrap minted by the host on mount.
// Anything that stops the embed from working falls back to opening billing
// externally, exactly like the Electron flow.
export function BillingEmbedFrame({ intent, view, fallbackHref, onBillingUpdated }: BillingEmbedFrameProps) {
  const session = useBillingEmbedSession()
  const [frameReady, setFrameReady] = useState(false)
  const [expired, setExpired] = useState(false)
  const [height, setHeight] = useState(FRAME_DEFAULT_HEIGHT)
  const requested = useRef(false)
  const { mutate } = session

  useEffect(() => {
    if (requested.current) return
    requested.current = true
    mutate({ intent, view })
  }, [intent, view, mutate])

  const platformOrigin = session.data?.platformOrigin ?? null
  useEffect(() => {
    if (!platformOrigin) return
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== platformOrigin) return
      const message = readEmbedMessage(event.data)
      if (!message) return
      if (message.event === 'ready') setFrameReady(true)
      else if (message.event === 'billing-updated') onBillingUpdated()
      else if (message.event === 'session-expired') setExpired(true)
      else if (message.event === 'resize' && message.height !== undefined) setHeight(clampHeight(message.height))
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [platformOrigin, onBillingUpdated])

  const sessionError = session.error
  useEffect(() => {
    if (!sessionError) return
    console.warn('[Paywall] billing embed unavailable:', sessionError)
    captureRendererException(sessionError, { tags: { area: 'paywall', op: 'billing-embed', code: sessionError.code } })
  }, [sessionError])

  const failure = expired ? 'This billing session has expired.' : sessionError?.message ?? null

  return (
    <div
      className="relative w-full overflow-hidden transition-[height] duration-150"
      style={{ height: failure ? undefined : height }}
      data-testid="billing-embed-body"
    >
      {failure ? (
        <div className="flex flex-col items-start gap-3 py-2">
          <p className="text-sm text-muted-foreground">{failure}</p>
          {fallbackHref && (
            <Button size="sm" onClick={() => void openExternalUrl(fallbackHref)}>
              Open billing in a new tab
            </Button>
          )}
        </div>
      ) : (
        <>
          {session.data && (
            <iframe
              title="Workspace billing"
              src={session.data.embedUrl}
              className="h-full w-full border-0 bg-transparent"
              referrerPolicy="strict-origin"
              data-testid="billing-embed-frame"
            />
          )}
          {!frameReady && (
            <div
              className="absolute inset-0 flex items-center justify-center gap-2 bg-card text-xs text-muted-foreground"
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
