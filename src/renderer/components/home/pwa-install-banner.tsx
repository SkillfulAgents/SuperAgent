import { useState } from 'react'
import { Download, Share, X } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useIsMobile } from '@renderer/hooks/use-mobile'
import { usePwaInstall } from '@renderer/hooks/use-pwa-install'
import { isElectron } from '@renderer/lib/env'
import './pwa-install-banner.css'

const DISMISS_KEY = 'pwa-install-banner-dismissed-at'
// A dismissal means "not now", not "never" — re-surface the nudge a week later
// rather than hiding it forever.
const REPROMPT_AFTER_MS = 7 * 24 * 60 * 60 * 1000

function dismissedRecently(): boolean {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY))
    // Missing/garbage parses to 0/NaN — both fail `> 0`, so the banner shows.
    return at > 0 && Date.now() - at < REPROMPT_AFTER_MS
  } catch {
    return false
  }
}

/**
 * "Install Gamut" banner for the mobile web/PWA build, shown on the home page.
 * Hidden on desktop/Electron, once the app is installed (standalone), and after
 * the user dismisses it. On Chromium it offers a real one-tap install; on iOS
 * Safari it coaches the manual Share → Add to Home Screen flow (iOS has no
 * install API). Desktop renders nothing, so this never affects the desktop app.
 */
export function PwaInstallBanner() {
  const isMobile = useIsMobile()
  const { isStandalone, canPrompt, promptInstall, method } = usePwaInstall()
  const [dismissed, setDismissed] = useState(dismissedRecently)

  // Mobile web only, and only when there's actually something to install.
  if (isElectron() || isStandalone || dismissed || !isMobile) return null

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()))
    } catch {
      // Private mode / storage disabled — just hide for this session.
    }
    setDismissed(true)
  }

  return (
    <div className="pwa-banner">
      {/* Two raw HDR-video layers: a blurred halo that bleeds out, and a sharp
          fill for the box surface. Rendering the HDR video DIRECTLY is the only
          thing that reaches EDR on-device — a backdrop-filter/overlay clamps it.
          The card below sits over the box video with NO z-index, so it never
          creates a stacking context that would flatten the HDR beneath it. */}
      <video
        className="pwa-banner__halo"
        src="/hdr-glow.mp4"
        autoPlay
        muted
        loop
        playsInline
        aria-hidden="true"
        tabIndex={-1}
      />
      <video
        className="pwa-banner__box"
        src="/hdr-glow.mp4"
        autoPlay
        muted
        loop
        playsInline
        aria-hidden="true"
        tabIndex={-1}
      />
      <div className="pwa-banner__card relative flex items-center gap-3 p-3 shadow-sm">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Download className="h-5 w-5" />
      </div>

      <div className="min-w-0 flex-1 pr-6">
        <p className="text-sm font-medium">Install Gamut</p>
        <p className="text-xs text-muted-foreground">
          {method === 'prompt' ? (
            'Add it to your home screen for a faster, full-screen app.'
          ) : method === 'ios-safari' ? (
            <>
              Tap{' '}
              <Share className="inline h-3.5 w-3.5 -translate-y-px" aria-label="the Share button" />{' '}
              below, then <span className="font-medium text-foreground">Add to Home Screen</span>.
            </>
          ) : method === 'ios-other' ? (
            <>
              Open this page in <span className="font-medium text-foreground">Safari</span>, then Add
              to Home Screen.
            </>
          ) : (
            <>
              Open your browser menu and choose{' '}
              <span className="font-medium text-foreground">Add to Home Screen</span>.
            </>
          )}
        </p>
      </div>

      {canPrompt && (
        <Button
          size="sm"
          className="shrink-0"
          onClick={() => {
            void promptInstall()
          }}
        >
          <Download className="mr-1 h-4 w-4" />
          Install
        </Button>
      )}

      <button
        type="button"
        aria-label="Dismiss install banner"
        onClick={dismiss}
        className="absolute right-2 top-2 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </button>
      </div>
      {/* Colored HDR gradient clipped to the rounded border ring — on EDR it makes
          the outline glow in HDR too (the SDR gradient border looks dull next to
          the ultrawhite box). The video fills the wrapper; the wrapper's
          content-box mask carves a rounded ring. Painted last → on top; the SDR
          ::after border is the non-HDR fallback. */}
      <div className="pwa-banner__outline" aria-hidden="true">
        <video src="/hdr-outline.mp4" autoPlay muted loop playsInline tabIndex={-1} />
      </div>
    </div>
  )
}
