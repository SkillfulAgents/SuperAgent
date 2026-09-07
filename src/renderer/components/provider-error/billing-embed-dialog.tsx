import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'

import { Button } from '@renderer/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { useBillingEmbedSession } from '@renderer/hooks/use-billing-embed'
import { captureRendererException } from '@renderer/lib/error-reporting'
import { openExternalUrl } from '@renderer/lib/open-external'

// Must match the platform's /embed contract (apps/web/src/lib/billing-embed.ts).
export const BILLING_EMBED_MESSAGE_TYPE = 'gamut-billing-embed'
type BillingEmbedEvent = 'ready' | 'billing-updated' | 'session-expired'

function readEmbedEvent(data: unknown): BillingEmbedEvent | null {
  if (typeof data !== 'object' || data === null) return null
  const record = data as { type?: unknown; event?: unknown }
  if (record.type !== BILLING_EMBED_MESSAGE_TYPE) return null
  return record.event === 'ready' || record.event === 'billing-updated' || record.event === 'session-expired'
    ? record.event
    : null
}

export interface BillingEmbedDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  intent?: 'topup'
  /** External billing URL for the fallback button. */
  fallbackHref: string | null
  /** Fired on every `billing-updated` from the platform page. */
  onBillingUpdated: () => void
}

// Web paywall: the platform billing page inside the app. The iframe URL is a
// one-time session bootstrap minted by the host, so it is requested on open and
// discarded on close. Anything that stops the embed from working falls back to
// opening billing externally, exactly like the Electron flow.
export function BillingEmbedDialog({ open, onOpenChange, intent, fallbackHref, onBillingUpdated }: BillingEmbedDialogProps) {
  const session = useBillingEmbedSession()
  const [frameReady, setFrameReady] = useState(false)
  const [expired, setExpired] = useState(false)
  const requested = useRef(false)
  const { mutate, reset } = session

  useEffect(() => {
    if (!open) {
      requested.current = false
      setFrameReady(false)
      setExpired(false)
      reset()
      return
    }
    if (requested.current) return
    requested.current = true
    mutate({ intent })
  }, [open, intent, mutate, reset])

  const platformOrigin = session.data?.platformOrigin ?? null
  useEffect(() => {
    if (!open || !platformOrigin) return
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== platformOrigin) return
      const embedEvent = readEmbedEvent(event.data)
      if (embedEvent === 'ready') setFrameReady(true)
      else if (embedEvent === 'billing-updated') onBillingUpdated()
      else if (embedEvent === 'session-expired') setExpired(true)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [open, platformOrigin, onBillingUpdated])

  const sessionError = session.error
  useEffect(() => {
    if (!sessionError) return
    console.warn('[Paywall] billing embed unavailable:', sessionError)
    captureRendererException(sessionError, { tags: { area: 'paywall', op: 'billing-embed', code: sessionError.code } })
  }, [sessionError])

  const failure = expired ? 'This billing session has expired.' : sessionError?.message ?? null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(88vh,820px)] w-[min(96vw,880px)] max-w-none flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b px-5 py-3 text-left">
          <DialogTitle className="text-sm font-medium">Billing</DialogTitle>
          <DialogDescription className="text-xs">Manage usage credit for this workspace.</DialogDescription>
        </DialogHeader>
        <div className="relative min-h-0 flex-1 bg-background" data-testid="billing-embed-body">
          {failure ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <p className="text-sm text-muted-foreground">{failure}</p>
              {fallbackHref && (
                <Button
                  size="sm"
                  onClick={() => {
                    void openExternalUrl(fallbackHref)
                    onOpenChange(false)
                  }}
                >
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
                  className="h-full w-full border-0"
                  referrerPolicy="strict-origin"
                  data-testid="billing-embed-frame"
                />
              )}
              {!frameReady && (
                <div
                  className="absolute inset-0 flex items-center justify-center gap-2 bg-background text-xs text-muted-foreground"
                  data-testid="billing-embed-loading"
                >
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  Loading billing…
                </div>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
