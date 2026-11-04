import { execFile } from 'child_process'
import fs from 'fs'
import {
  BrowserWindow,
  desktopCapturer,
  screen,
  systemPreferences,
  type Display,
  type NativeImage,
} from 'electron'
import {
  chipOnOverlay,
  screenshotFileName,
  type CaptureRect,
  type QuickDispatchCaptureResult,
} from '@shared/lib/quick-dispatch-capture'

/**
 * The launcher's computer-use screenshot, and the shutter that carries it into
 * the composer.
 *
 * Turning the toggle on takes a screenshot of the display the launcher is on.
 * The click is answered at once: a white flash in a borderless, click-through
 * overlay above everything, and the shutter sound. The capture runs under the
 * flash. Neither window is in the picture: the overlay is always
 * content-protected, and the launcher is for the length of the capture only, so
 * a screen share still shows it. When the picture arrives it fills the screen
 * under the fading flash, settles into a framed photo, and flies into its
 * attachment chip, whose place the renderer reports once the chip has rendered.
 *
 * The capture itself takes 150-400 ms, which is why the flash goes first. The
 * overlay window is built when the person points at the toggle
 * (`prepareQuickDispatchCapture`), so the flash doesn't wait on a new renderer
 * either, and is kept, hidden, until the launcher closes.
 *
 * **It must fail open.** The overlay sits above every window, so every path
 * ends with it hidden and the launcher unprotected, and a watchdog makes sure.
 */

/** A capture that takes longer than this is given up on. */
const CAPTURE_TIMEOUT_MS = 3_000
/** How long the overlay waits for the renderer to say where the chip is before it fades out instead. */
const TARGET_WAIT_MS = 1_500
/** No run outlives this, whatever else happens. */
const WATCHDOG_MS = 6_000

/** macOS's own screenshot sound. */
const MAC_SHUTTER_SOUND = '/System/Library/Components/CoreAudio.component/Contents/SharedSupport/SystemSounds/system/Screen Capture.aif'

/** The overlay window, kept hidden between captures while the launcher is open. */
interface Overlay {
  readonly window: BrowserWindow
  displayId: number
  /** Settles once its current document has loaded. */
  loaded: Promise<void>
}

interface CaptureRun {
  readonly launcher: BrowserWindow
  readonly overlay: Overlay
  readonly display: Display
  readonly watchdog: ReturnType<typeof setTimeout>
  /** Settles with where the chip is (or null) once the renderer says. */
  readonly target: Promise<CaptureRect | null>
  readonly resolveTarget: (rect: CaptureRect | null) => void
  /** The overlay is on screen and the shutter has sounded. */
  revealed: boolean
  ended: boolean
}

let overlay: Overlay | null = null
let run: CaptureRun | null = null

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Whether macOS has refused this app Screen Recording. A capture without it
 * comes back as the wallpaper alone, so it must not be offered as the screen.
 * 'not-determined' is not a refusal yet: the first capture asks.
 */
function screenAccessRefused(): boolean {
  if (process.platform !== 'darwin') return false
  const status = systemPreferences.getMediaAccessStatus('screen')
  return status === 'denied' || status === 'restricted'
}

function screenAccessGranted(): boolean {
  return process.platform !== 'darwin' || systemPreferences.getMediaAccessStatus('screen') === 'granted'
}

/** The display's picture at its full pixel size, or null. */
async function grabDisplay(display: Display): Promise<NativeImage | null> {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * display.scaleFactor),
      height: Math.round(display.size.height * display.scaleFactor),
    },
  })
  // display_id is empty on some Linux setups; with one screen there is no doubt.
  const source = sources.find((s) => s.display_id === String(display.id)) ?? (sources.length === 1 ? sources[0] : undefined)
  const image = source?.thumbnail
  return image && !image.isEmpty() ? image : null
}

/** Load a fresh overlay document: each capture starts from one. */
function loadDocument(target: Overlay): void {
  const { webContents } = target.window
  target.loaded = new Promise<void>((resolve) => {
    webContents.once('did-finish-load', () => resolve())
    webContents.once('did-fail-load', () => resolve())
  })
  void target.window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(OVERLAY_DOCUMENT)}`).catch(() => undefined)
}

/** The overlay window over `display`, built if there is none yet. */
function overlayOn(display: Display): Overlay {
  if (overlay && !overlay.window.isDestroyed()) {
    if (overlay.displayId !== display.id) {
      overlay.window.setBounds(display.bounds)
      overlay.displayId = display.id
    }
    return overlay
  }
  const window = new BrowserWindow({
    ...display.bounds,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // Never key: the launcher hides when it loses focus.
    focusable: false,
    skipTaskbar: true,
    enableLargerThanScreen: true,
    roundedCorners: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      // The fallback shutter sound plays without a gesture.
      autoplayPolicy: 'no-user-gesture-required',
    },
  })
  // The flash is on screen while the capture runs: it must not be in the picture.
  window.setContentProtection(true)
  window.setIgnoreMouseEvents(true)
  // Above the launcher ('floating') and the menu bar.
  window.setAlwaysOnTop(true, 'screen-saver')
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  // macOS may have kept the frame off the menu bar at construction.
  window.setBounds(display.bounds)
  overlay = { window, displayId: display.id, loaded: Promise.resolve() }
  loadDocument(overlay)
  return overlay
}

function inOverlay(current: CaptureRun, code: string): Promise<unknown> {
  const { window } = current.overlay
  return window.isDestroyed() ? Promise.resolve() : window.webContents.executeJavaScript(code)
}

function playShutterSound(window: BrowserWindow): void {
  if (process.platform === 'darwin' && fs.existsSync(MAC_SHUTTER_SOUND)) {
    execFile('afplay', [MAC_SHUTTER_SOUND], () => undefined)
    return
  }
  window.webContents.executeJavaScript('window.__click?.()').catch(() => undefined)
}

/** Put the overlay on screen and sound the shutter, once per run. */
function reveal(current: CaptureRun): void {
  if (current.revealed || current.ended || current.overlay.window.isDestroyed()) return
  current.revealed = true
  current.overlay.window.showInactive()
  playShutterSound(current.overlay.window)
}

function endRun(ending: CaptureRun): void {
  if (ending.ended) return
  ending.ended = true
  clearTimeout(ending.watchdog)
  ending.resolveTarget(null)
  if (!ending.launcher.isDestroyed()) {
    ending.launcher.setContentProtection(false)
    // Whatever happened to the flight, the chip is shown again.
    ending.launcher.webContents.send('quick-dispatch:capture-landed')
  }
  if (!ending.overlay.window.isDestroyed()) {
    ending.overlay.window.hide()
    loadDocument(ending.overlay)
  }
  if (run === ending) run = null
}

/** Answer the click: the flash, before there is a picture. */
async function flash(current: CaptureRun): Promise<void> {
  await current.overlay.loaded
  if (current.ended) return
  await inOverlay(current, 'window.__flash()')
  reveal(current)
}

/** The picture fills the screen under the fading flash and settles into a framed photo. */
async function showPicture(current: CaptureRun, image: NativeImage): Promise<void> {
  // At the display's full resolution; JPEG, because a full-size PNG takes
  // longer to encode than the capture took.
  const src = `data:image/jpeg;base64,${image.toJPEG(88).toString('base64')}`
  await current.overlay.loaded
  if (current.ended) return
  await inOverlay(current, `window.__show(${JSON.stringify(src)})`)
  reveal(current)
}

/** Fly the photo onto the chip once the renderer says where it is, or fade it out. */
async function land(current: CaptureRun): Promise<void> {
  const chip = await Promise.race([current.target, delay(TARGET_WAIT_MS).then(() => null)])
  if (current.ended) return
  const rect = chip ? chipOnOverlay(chip, current.launcher.getContentBounds(), current.display.bounds) : null
  await inOverlay(current, rect ? `window.__fly(${JSON.stringify(rect)})` : 'window.__dismiss()')
}

/**
 * Build the overlay ahead of a capture, so the flash needn't wait on a new
 * renderer: the person is pointing at the toggle.
 */
export function prepareQuickDispatchCapture(launcher: BrowserWindow): void {
  if (!run) overlayOn(screen.getDisplayMatching(launcher.getBounds()))
}

/**
 * Take the screenshot for the launcher and play the shutter. Resolves with the
 * picture (at the display's size in points, as a PNG) once it is on screen,
 * while the animation plays on; the renderer then reports where the chip is
 * with `setQuickDispatchCaptureTarget`.
 */
export async function captureQuickDispatchScreen(launcher: BrowserWindow): Promise<QuickDispatchCaptureResult> {
  if (run) endRun(run)
  if (screenAccessRefused()) return { ok: false, reason: 'permission' }

  const display = screen.getDisplayMatching(launcher.getBounds())
  let resolveTarget: (rect: CaptureRect | null) => void = () => undefined
  const target = new Promise<CaptureRect | null>((resolve) => { resolveTarget = resolve })
  const current: CaptureRun = {
    launcher,
    overlay: overlayOn(display),
    display,
    target,
    resolveTarget,
    revealed: false,
    ended: false,
    watchdog: setTimeout(() => endRun(current), WATCHDOG_MS),
  }
  run = current

  // Out of the picture while it stays on screen.
  launcher.setContentProtection(true)
  // Not before a first capture: its permission prompt would come up under the flash.
  if (screenAccessGranted()) {
    flash(current).catch((error) => console.warn('[QuickDispatch] Capture flash failed:', error))
  }

  let image: NativeImage | null = null
  try {
    image = await Promise.race([grabDisplay(display), delay(CAPTURE_TIMEOUT_MS).then(() => null)])
  } catch (error) {
    console.warn('[QuickDispatch] Screen capture failed:', error)
  }
  if (!launcher.isDestroyed()) launcher.setContentProtection(false)
  // Checked after the capture too: the first one is what asks for the permission.
  const granted = screenAccessGranted()
  if (!image || current.ended || !granted) {
    inOverlay(current, 'window.__dismiss()')
      .catch(() => undefined)
      .finally(() => endRun(current))
    return { ok: false, reason: granted ? 'failed' : 'permission' }
  }

  try {
    await showPicture(current, image)
  } catch (error) {
    console.warn('[QuickDispatch] Capture picture failed:', error)
  }
  // Encoded once the picture is on screen: it takes longer than the capture did.
  const png = image.resize({ width: display.size.width, height: display.size.height, quality: 'best' }).toPNG()
  land(current)
    .catch((error) => console.warn('[QuickDispatch] Capture animation failed:', error))
    .finally(() => endRun(current))
  return { ok: true, png: new Uint8Array(png), name: screenshotFileName(new Date()) }
}

/** The renderer's report of where the screenshot's chip is (null: it isn't there), in the launcher's viewport. */
export function setQuickDispatchCaptureTarget(chip: CaptureRect | null): void {
  run?.resolveTarget(chip)
}

/** The launcher is going away: end any animation and close the overlay. */
export function releaseQuickDispatchCapture(): void {
  if (run) endRun(run)
  if (overlay && !overlay.window.isDestroyed()) overlay.window.destroy()
  overlay = null
}

/**
 * The overlay: the flash, the picture, and the two moves. Inline, and loaded as
 * a data URL, so it is ready before the capture; the picture arrives through
 * `__show`, which keeps it out of the URL.
 */
const OVERLAY_DOCUMENT = `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: transparent; }
  #shot {
    position: fixed; left: 0; top: 0; width: 100vw; height: 100vh;
    box-sizing: border-box; border: 0 solid #fff; background: #fff;
    overflow: hidden; opacity: 0;
  }
  #shot img { display: block; width: 100%; height: 100%; object-fit: cover; }
  #flash { position: fixed; inset: 0; background: #fff; opacity: 0; pointer-events: none; }
</style>
<div id="shot"><img id="img" alt=""></div>
<div id="flash"></div>
<script>
  const shot = document.getElementById('shot');
  const img = document.getElementById('img');
  const flash = document.getElementById('flash');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const FLASH = 0.85;
  let flashed = false;
  let border = 10;
  let intro = Promise.resolve();
  const framedAt = (W, H) => {
    const inset = Math.round(Math.min(W, H) * 0.06);
    border = Math.max(10, Math.round(Math.min(W, H) * 0.016));
    return {
      left: inset + 'px', top: inset + 'px', width: (W - 2 * inset) + 'px', height: (H - 2 * inset) + 'px',
      borderWidth: border + 'px', borderRadius: '12px', boxShadow: '0 24px 80px rgba(0, 0, 0, 0.45)',
    };
  };
  const fadeOut = (el, ms) => el.animate([{ opacity: getComputedStyle(el).opacity }, { opacity: 0 }], { duration: ms, fill: 'forwards' }).finished;

  // The click's answer, before the picture exists: the screen goes white and holds.
  window.__flash = () => {
    flashed = true;
    flash.animate([{ opacity: 0 }, { opacity: FLASH }], { duration: 50, easing: 'ease-out', fill: 'forwards' });
  };

  window.__show = async (src) => {
    img.src = src;
    try { await img.decode(); } catch {}
    const W = innerWidth, H = innerHeight;
    const framed = framedAt(W, H);
    shot.style.opacity = '1';
    flash.animate([{ opacity: flashed ? getComputedStyle(flash).opacity : FLASH }, { opacity: 0 }], { duration: 280, easing: 'ease-out', fill: 'forwards' });
    if (reduce) { Object.assign(shot.style, framed); return; }
    intro = shot.animate([
      { left: '0px', top: '0px', width: W + 'px', height: H + 'px', borderWidth: '0px', borderRadius: '0px', boxShadow: '0 0 0 rgba(0, 0, 0, 0)' },
      framed,
    ], { duration: 380, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'forwards' }).finished.then(() => undefined);
  };

  window.__fly = async (to) => {
    await intro;
    if (reduce) { await fadeOut(shot, 150); return; }
    await new Promise((resolve) => setTimeout(resolve, 220));
    const from = shot.getBoundingClientRect();
    await shot.animate([
      { left: from.left + 'px', top: from.top + 'px', width: from.width + 'px', height: from.height + 'px',
        borderWidth: border + 'px', borderRadius: '12px', boxShadow: '0 24px 80px rgba(0, 0, 0, 0.45)' },
      { left: to.x + 'px', top: to.y + 'px', width: to.width + 'px', height: to.height + 'px',
        borderWidth: '1.5px', borderRadius: '6px', boxShadow: '0 2px 6px rgba(0, 0, 0, 0.2)' },
    ], { duration: 520, easing: 'cubic-bezier(0.32, 0.72, 0, 1)', fill: 'forwards' }).finished;
    await fadeOut(shot, 90);
  };

  window.__dismiss = async () => {
    await intro;
    await Promise.all([fadeOut(shot, 200), fadeOut(flash, 200)]);
  };

  // A shutter where the system has none to play: two short bursts of filtered noise.
  window.__click = () => {
    try {
      const ctx = new AudioContext();
      const burst = (at, seconds, frequency, gain) => {
        const length = Math.floor(ctx.sampleRate * seconds);
        const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 3);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = frequency;
        filter.Q.value = 0.8;
        const level = ctx.createGain();
        level.gain.value = gain;
        source.connect(filter).connect(level).connect(ctx.destination);
        source.start(ctx.currentTime + at);
      };
      burst(0, 0.05, 2600, 0.5);
      burst(0.07, 0.06, 1800, 0.4);
    } catch {}
  };
</script>`
