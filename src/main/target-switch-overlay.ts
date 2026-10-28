import { app, WebContentsView, nativeTheme, type BrowserWindow } from 'electron'

/**
 * The animation that covers a target switch.
 *
 * Switching Superagents reloads the renderer, and a reload is the whole reason
 * the switch is safe: every module-scoped cache, every open stream and every
 * memoized client dies with the document, so nothing has to remember to reset
 * itself. Keeping that means the transition cannot be animated from inside the
 * page — the page is what goes away.
 *
 * So it is animated from outside. A `WebContentsView` layered over the window's
 * content is its own document in its own process: the reload underneath cannot
 * touch it, and it resizes with the window without anyone syncing bounds. Under
 * the band sits a still of the outgoing view (`capturePage`), because for a
 * moment during the reload there is genuinely nothing to show — without it the
 * effect brackets a hole instead of crossing one.
 *
 * **It must fail open.** Every path here ends in the overlay being removed, and
 * a watchdog removes it even if no path runs: the overlay swallows input while
 * it is up, so one stuck on screen is a locked app. A switch that animates badly
 * is a blemish; a switch that never lets go is a bug report about the app
 * freezing.
 */

/**
 * How long the band may stay up without being dismissed.
 *
 * Long enough for a slow cold boot of the reloaded renderer, short enough that a
 * boot which never signals still hands the window back while the user is looking
 * at it.
 */
const WATCHDOG_MS = 4_000

/**
 * How long the band may stay up *after the reloaded document has loaded*.
 *
 * The renderer's own "I have painted" signal is the accurate one, but it depends
 * on the renderer reaching the code that sends it — a stale preload, a boot that
 * throws, a build without it. `did-finish-load` reaches main whatever the page
 * does, so it bounds the wait at something close to right instead of leaving the
 * watchdog to do it four seconds later.
 */
const PAINT_FALLBACK_MS = 900

/** How long the still is worth waiting for before switching without one. */
const CAPTURE_BUDGET_MS = 400

/**
 * Dev-only trace of the lifecycle, with the elapsed time from the click.
 *
 * Here because this feature fails in a way nobody can debug by looking: a band
 * that stays too long looks the same whether the capture stalled, the renderer
 * never signalled, or the reload itself was slow — and the only witness is
 * someone watching an animation. Four lines say which.
 */
let startedAt = 0
function trace(stage: string): void {
  if (app.isPackaged) return
  console.log(`[switch-overlay] +${Date.now() - startedAt}ms ${stage}`)
}

/**
 * Sweep timings, shared with the overlay document below.
 *
 * The band **loops**, but the loop is insurance rather than the effect: one
 * crossing is what a switch should look like, and `MIN_VISIBLE_MS` below is set
 * so that is all you normally see. The repeat matters when the wait runs long,
 * where a still that has stopped moving reads as the app having hung on the
 * click rather than as a transition.
 */
const SWEEP_MS = 900
const SWEEP_OUT_MS = 300

/**
 * The band begins part-way across rather than off-screen: started at zero it
 * spends its first quarter-second outside the window, which is exactly the
 * moment the click needs answering.
 */
const SWEEP_HEAD_START_MS = Math.round(SWEEP_MS / 4)

/**
 * The band stays up until its first crossing has finished, even when the new
 * view is ready sooner.
 *
 * A deliberate floor on the switch, which is a strange thing to add to something
 * we spent this long making faster — but a transition that flickers past reads
 * as a glitch, and the fastest leg (back to this computer, where nothing is
 * fetched from anywhere) is the one that suffers.
 *
 * Exactly one crossing, not one *cycle*: the wave enters already moving, so the
 * remainder of its animation is what is left to watch. Hold longer and the next
 * pass has started before the fade, which is how a single gesture turns into a
 * strobe. Further passes still happen when the wait genuinely runs long — that
 * is the loop earning its keep, not the effect repeating itself.
 */
const MIN_VISIBLE_MS = SWEEP_MS - SWEEP_HEAD_START_MS

/**
 * How long the still takes to dissolve off the new view underneath it.
 *
 * This is the moment the switch actually reads as having happened, and it is
 * deliberately *inside* the crossing rather than after it: the new view arrives
 * while the wave is still travelling, so the wave appears to have brought it.
 * Ending the still and the band together instead put the whole change in one
 * cut at the end, which is the thing it was covering for.
 *
 * It also doubles as the floor on the hold when the new view arrives late —
 * without it a boot that finished after the crossing would dissolve and dismiss
 * on the same frame, which is that cut again.
 */
const REVEAL_MS = 260

/**
 * The outgoing frame, at whatever resolution the display actually has.
 *
 * It used to be resized to CSS pixels to keep the data URL small. That is a
 * backing-store-sized mistake: on a Retina display the still is then stretched
 * 2× across the window it is standing in for, and a blurry copy of the UI is
 * more obviously wrong than no copy at all. `capturePage` already hands back the
 * device-resolution image — the fix is to stop touching it.
 *
 * PNG, not JPEG: the app's window is vibrant, so the capture carries real
 * transparency. Flattening that onto a JPEG's opaque background would paint the
 * translucent sidebar as a grey slab.
 */
async function captureBackdrop(window: BrowserWindow): Promise<string | null> {
  try {
    // Bounded around the encode as well as the capture: the caller is holding
    // the user's click until this returns, so a capture that is slow (or, on a
    // vibrant window, never answers at all) must cost the still rather than the
    // switch. A full-resolution PNG is the larger part of that time now.
    const encoded = (async () => {
      const image = await window.webContents.capturePage()
      return image.isEmpty() ? null : image.toDataURL()
    })()
    return await Promise.race([
      encoded,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), CAPTURE_BUDGET_MS)),
    ])
  } catch {
    return null
  }
}

/**
 * The band, in the palette of the app it is covering. The same luminous wash
 * that reads as light on a light UI is a flashbulb on a dark one, so the dark
 * variant lifts the surface instead of blowing past it.
 */
function bandGradient(dark: boolean): string {
  return dark
    ? `linear-gradient(
      90deg,
      rgba(56, 189, 248, 0) 0%,
      rgba(56, 189, 248, 0.14) 30%,
      rgba(125, 211, 252, 0.28) 46%,
      rgba(186, 230, 253, 0.40) 52%,
      rgba(125, 211, 252, 0.28) 58%,
      rgba(56, 189, 248, 0.14) 72%,
      rgba(56, 189, 248, 0) 100%
    )`
    : `linear-gradient(
      90deg,
      rgba(125, 211, 252, 0) 0%,
      rgba(125, 211, 252, 0.28) 30%,
      rgba(186, 230, 253, 0.62) 46%,
      rgba(240, 249, 255, 0.85) 52%,
      rgba(186, 230, 253, 0.62) 58%,
      rgba(125, 211, 252, 0.28) 72%,
      rgba(125, 211, 252, 0) 100%
    )`
}

function overlayDocument(backdrop: string | null, dark: boolean): string {
  // Inline, and loaded as a data URL: this document has to be on screen before
  // the reload it is covering, so it cannot wait on the app's dev server or a
  // file read. Nothing here is dynamic except the backdrop.
  return `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: transparent; }
  #stage { position: fixed; inset: 0; transition: opacity ${SWEEP_OUT_MS}ms ease-out; }
  #stage.dismissing { opacity: 0; }
  /* The still goes first, on its own, the moment the new view exists underneath
     it — so the change of contents happens *during* the crossing rather than as
     a cut when the band leaves. The band stays up over the new view for the rest
     of its pass, which is what makes the swap feel like something the wave did
     rather than something that happened after it. */
  #stage.revealing #backdrop { opacity: 0; }
  /* Held back from the live view it is standing in for — a pin-sharp copy of the
     UI that ignores clicks looks like the app has hung — but held back only in
     *colour*. Nothing here may move a pixel: this is a photograph of the window
     laid over the window, and the macOS traffic lights float above it and do not
     move with it, so a 1% scale that looked like depth on its own read as the
     whole UI jumping the moment the band arrived.

     object-fit is fill rather than cover: the still is the same rectangle as the
     surface it covers, and cover would rather crop it than trust that. */
  #backdrop {
    position: fixed; inset: 0; width: 100%; height: 100%;
    object-fit: fill;
    filter: saturate(0.88) brightness(0.96) blur(1px);
    transition: opacity ${REVEAL_MS}ms ease-in;
  }
  /* One band. A trailing second one filled the gaps between passes, which is
     only a virtue while waiting — on the switch this is built for it turned a
     single gesture into a flock. The loop covers a long wait; the first crossing
     is the effect. */
  .band {
    position: fixed; top: -10%; bottom: -10%; left: 0;
    width: 80vw;
    transform: translateX(-85vw) skewX(-8deg);
    /* Linear, and in viewport units at both ends. An eased sweep spends its
       middle third crossing most of the screen and is gone a third of the way
       into the hold, leaving a still that has stopped moving — the thing the
       band exists to avoid. At a constant speed the crossing lasts exactly as
       long as it is on screen, which is what MIN_VISIBLE_MS is derived from. */
    animation: sweep ${SWEEP_MS}ms linear infinite;
    animation-delay: -${SWEEP_HEAD_START_MS}ms;
  }
  /* Glow and edge are separate elements because the glow is blurred and the
     edge must not be: the crossing reads as an event because something crisp
     leads it, and a blur over the whole band takes exactly that away. */
  .band .glow { position: absolute; inset: 0; background: ${bandGradient(dark)}; filter: blur(10px); }
  .band .edge {
    position: absolute; top: 0; bottom: 0; right: 30%; width: 3px;
    background: rgba(255, 255, 255, ${dark ? 0.72 : 0.95});
    box-shadow: 0 0 34px 12px rgba(224, 242, 254, ${dark ? 0.45 : 0.8});
  }
  @keyframes sweep {
    from { transform: translateX(-85vw) skewX(-8deg); }
    to   { transform: translateX(105vw) skewX(-8deg); }
  }
  /* The band is decoration over a wait. Someone who has asked not to be moved
     still gets the backdrop, which is the part doing the real work. */
  @media (prefers-reduced-motion: reduce) {
    .band { display: none; }
  }
</style>
<div id="stage">
  ${backdrop ? `<img id="backdrop" src="${backdrop}" alt="">` : ''}
  <div class="band"><div class="glow"></div><div class="edge"></div></div>
</div>
<script>
  // Driven from main, which is the only side that knows when the new document
  // has painted — but the *choreography* is here, because it is all timing and
  // main would otherwise need a round trip per step. It is handed the one number
  // it cannot work out for itself: how much of the crossing is left to run.
  //
  // Executing a string is not a risk here: this document loads no remote content
  // and has no preload, so main is the only thing that can talk to it.
  // Two steps, because they happen at different moments: the still dissolves as
  // soon as there is a new view underneath it, and the band leaves when its
  // crossing is done. Main keeps the clock — it owns the watchdog and the floor,
  // and timing left in here would be skipped entirely by a document that failed
  // to load.
  window.__reveal = () => {
    document.getElementById('stage')?.classList.add('revealing')
  }
  window.__dismiss = () => new Promise((resolve) => {
    document.getElementById('stage')?.classList.add('dismissing')
    setTimeout(resolve, ${SWEEP_OUT_MS})
  })
</script>`
}

interface ActiveOverlay {
  view: WebContentsView
  window: BrowserWindow
  shownAt: number
  watchdog: NodeJS.Timeout
  fallback: NodeJS.Timeout | null
  onResize: () => void
  onLoaded: () => void
  detached: boolean
}

let active: ActiveOverlay | null = null

/**
 * Put the band over the window and hold it there.
 *
 * Awaited by the caller so the overlay is on screen before the reload starts —
 * the whole point is that the switch happens behind it. Never rejects: an
 * overlay that could not be built is a transition without an animation, not a
 * failed switch.
 */
export async function showTargetSwitchOverlay(window: BrowserWindow): Promise<void> {
  if (window.isDestroyed()) return
  // A second switch while one is animating: drop the first rather than stacking
  // views, so there is only ever one thing to take down.
  removeTargetSwitchOverlay()
  startedAt = Date.now()

  // Held outside the try because the window may already be wearing them by the
  // time something throws, and until the overlay object exists there is no
  // watchdog and no `active` — this catch is then the *only* thing that knows
  // they are there. A view left on the window covers everything and swallows
  // input, which is the one outcome this file exists to prevent.
  let view: WebContentsView | null = null
  let onResize: (() => void) | null = null

  try {
    const backdrop = await captureBackdrop(window)
    trace(backdrop ? 'captured' : 'no still')
    if (window.isDestroyed()) return

    view = new WebContentsView({
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    })
    const band = view
    band.setBackgroundColor('#00000000')

    const applyBounds = () => {
      const { width, height } = window.getContentBounds()
      band.setBounds({ x: 0, y: 0, width, height })
    }
    applyBounds()

    window.contentView.addChildView(band)
    const document = overlayDocument(backdrop, nativeTheme.shouldUseDarkColors)
    void band.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(document)}`)

    onResize = () => applyBounds()
    window.on('resize', onResize)

    // The reloaded document finishing its load is not the same as it having
    // something to show, which is why the renderer signals separately. But it is
    // the only signal that arrives without the renderer's cooperation, so it
    // starts a short clock: whatever the page is doing, the band comes off soon
    // after the page exists.
    const onLoaded = () => {
      trace('document loaded')
      overlay.fallback = setTimeout(() => {
        trace('lifting on load, no paint signal')
        void finishTargetSwitchOverlay()
      }, PAINT_FALLBACK_MS)
    }

    const overlay: ActiveOverlay = {
      view: band,
      window,
      shownAt: Date.now(),
      onResize,
      onLoaded,
      fallback: null,
      detached: false,
      // Bound to *this* overlay rather than to whatever is active when it fires:
      // the dismissal path clears `active` before it awaits the fade, and a
      // watchdog that only knew about "the active one" would find nothing to
      // rescue in exactly the case it exists for.
      watchdog: setTimeout(() => {
        trace('WATCHDOG — nothing ever lifted the band')
        detach(overlay)
      }, WATCHDOG_MS),
    }
    window.webContents.once('did-finish-load', onLoaded)
    active = overlay
    trace('band up')
  } catch {
    // Includes the window closing mid-capture. Leave the caller to switch
    // without an animation — but not behind a view that never got a watchdog.
    trace('failed to raise the band')
    const stray = view
    const listener = onResize
    if (listener) step(() => window.off('resize', listener))
    if (stray) {
      step(() => {
        if (!window.isDestroyed()) window.contentView.removeChildView(stray)
      })
      step(() => {
        if (!stray.webContents.isDestroyed()) stray.webContents.close()
      })
    }
  }
}

/**
 * Take the band away, having let the still fade off the newly painted view.
 *
 * Safe to call when nothing is up, twice, or after the window has gone — the
 * caller is a renderer signalling first paint, and it should never have to know
 * whether an overlay is there.
 */
export async function finishTargetSwitchOverlay(): Promise<void> {
  const overlay = active
  if (!overlay) return
  trace('paint signal')
  // Claim it first: the fade below is awaited, and a second switch arriving
  // during it must not find the same overlay to take down again. The watchdog
  // stays armed — see below.
  active = null
  // The load fallback, though, is disarmed now. It calls back in here without
  // naming an overlay, so left running through the hold it would find whatever
  // switch had started in the meantime and cut that one's animation short.
  if (overlay.fallback) {
    clearTimeout(overlay.fallback)
    overlay.fallback = null
  }

  // The still dissolves the moment there is a new view underneath it to dissolve
  // onto — not when the band leaves. That is the whole difference between the
  // switch looking like something the wave did and looking like a cut at the
  // end of it. Fired, not awaited: nothing downstream depends on the dissolve
  // having finished, and this call is on the path that uncovers the window.
  overlay.view.webContents.executeJavaScript('window.__reveal?.()').catch(() => undefined)

  // Then hold for the rest of the crossing. The floor lives here rather than in
  // the overlay document because main owns every other deadline in this file,
  // and a document that failed to load would simply skip one kept over there.
  const shownFor = Date.now() - overlay.shownAt
  const hold = Math.max(MIN_VISIBLE_MS - shownFor, REVEAL_MS)
  trace(`revealed; band holds ${hold}ms`)
  await new Promise((resolve) => setTimeout(resolve, hold))

  try {
    await Promise.race([
      overlay.view.webContents.executeJavaScript('window.__dismiss?.()'),
      // `executeJavaScript` against a document that never finished loading can
      // sit unresolved, and this await is the last thing between the user and
      // an uncoverable window. The fade is worth waiting for, but only for as
      // long as the fade takes.
      new Promise((resolve) => setTimeout(resolve, SWEEP_OUT_MS + 200)),
    ])
  } catch {
    // The document may not have loaded, or may already be gone.
  }
  detach(overlay)
}

/** Tear the overlay off now, without the fade. The watchdog's only behaviour. */
export function removeTargetSwitchOverlay(): void {
  const overlay = active
  if (!overlay) return
  active = null
  detach(overlay)
}

/**
 * Take one overlay off the window. Idempotent, because three different things
 * race to call it — the paint signal, the watchdog, and the next switch — and
 * whichever arrives first should simply win.
 */
function detach(overlay: ActiveOverlay): void {
  if (overlay.detached) return
  overlay.detached = true
  trace('band down')
  clearTimeout(overlay.watchdog)
  if (overlay.fallback) clearTimeout(overlay.fallback)
  if (active === overlay) active = null

  // Each step guarded on its own. Sharing one `try` means the first thing to
  // throw takes the rest of the teardown with it — and the step that matters,
  // taking the view off the window, is not the first one. This is the last code
  // that can uncover the window; it does not get to give up early.
  step(() => overlay.window.off('resize', overlay.onResize))
  step(() => overlay.window.webContents.off('did-finish-load', overlay.onLoaded))
  step(() => {
    if (!overlay.window.isDestroyed()) {
      overlay.window.contentView.removeChildView(overlay.view)
    }
  })
  step(() => {
    if (!overlay.view.webContents.isDestroyed()) {
      overlay.view.webContents.close()
    }
  })
}

function step(action: () => void): void {
  try {
    action()
  } catch {
    // Every one of these throws if the window went away first, which is a state
    // where there is nothing left to clean up anyway.
  }
}

/** Test seam: whether a band is currently up. */
export function _hasTargetSwitchOverlayForTest(): boolean {
  return active !== null
}
