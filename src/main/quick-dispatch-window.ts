import { app, BrowserWindow, screen } from 'electron'
import path from 'path'
import { installPopupHandler } from './dashboard-window'

// The quick-dispatch launcher: a frameless, translucent, always-on-top panel
// (Spotlight/Raycast style) that floats over whatever the user is doing. It is
// created ONCE (hidden) and then shown/hidden by the global shortcut, so it
// appears instantly. Kept in its own module + handle so it never collides with
// the main window's `mainWindow`-null-on-close recreation logic (index.ts).

const QUICK_WIDTH = 720
// Initial size before the renderer reports its real height; kept close to the
// real content so there's no first-paint jump.
const INITIAL_HEIGHT = 100
// Floor for the content-driven resize. Must be SMALL — the real panel is only
// ~106px, so a large floor (the old 132) leaves an empty "chin" below it.
const MIN_HEIGHT = 48

let quickWindow: BrowserWindow | null = null

// When a native picker (file/folder dialog) is open, the BrowserWindow blurs
// even though the user hasn't left the launcher — suppress the blur-to-hide so
// the panel doesn't vanish mid-pick. The renderer toggles this around opening
// pickers and clears it when focus returns.
let suppressBlurHide = false

// Dev ergonomics: clicking the terminal/devtools blurs (and would hide) the
// panel, making it impossible to inspect. Set QUICK_DISPATCH_NO_BLUR_HIDE=1 to
// keep it visible on blur while testing.
const blurHideDisabled = process.env.QUICK_DISPATCH_NO_BLUR_HIDE === '1'

function buildQuickDispatchWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: QUICK_WIDTH,
    height: INITIAL_HEIGHT,
    frame: false,
    // Native vibrancy (macOS) / acrylic (Windows) = real whole-window frost.
    // The window grows to fit FULL-WIDTH dropdowns (Raycast-style), so the
    // frosted area is always filled by the menu — never an empty frosted gap.
    // (CSS backdrop-blur can't frost the desktop here, so native is the only
    // real-frost option; whole-window is fine because menus fill the growth.)
    transparent: process.platform === 'linux',
    ...(process.platform === 'linux' && { backgroundColor: '#00000000' }),
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    hasShadow: true,
    roundedCorners: true,
    alwaysOnTop: true,
    useContentSize: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
    ...(process.platform === 'darwin' && {
      // Translucent behind-window frost (Raycast look). The file-drop bug was the
      // window LEVEL, not the material — with 'floating' (see setAlwaysOnTop
      // below) drops work. If 'under-window' (behind-window blend → more
      // transparent backing) ever regresses drops, fall back to a within-window
      // material ('hud' / 'menu' / 'popover' / 'sidebar').
      vibrancy: 'under-window' as const,
      visualEffectState: 'active' as const,
    }),
    ...(process.platform === 'win32' && {
      backgroundMaterial: 'acrylic' as const,
    }),
  })

  // Float above normal windows on every Space (macOS), like a launcher.
  // The level MUST stay low-ish: macOS does not deliver file drag-and-drop to
  // windows at very high levels. The original 'screen-saver' level made the
  // launcher a non-drop-target, so Finder drags fell straight through to the
  // window behind. 'floating' still floats above normal windows AND accepts drops.
  win.setAlwaysOnTop(true, 'floating')
  // `skipTransformProcessType: true` keeps the regular (foreground) process type
  // (setVisibleOnAllWorkspaces otherwise flips to accessory/UIElement, hiding the
  // dock icon).
  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  })

  // Belt-and-suspenders: re-assert the dock icon in case any other panel trait
  // still nudges the app toward accessory policy at pre-warm (before first show).
  if (process.platform === 'darwin') {
    void app.dock?.show()
  }

  // Trusted first-party content, but deny window.open and route any external
  // links through the same scheme-validated opener as the rest of the app.
  installPopupHandler(win.webContents)

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/quick-dispatch.html`)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/quick-dispatch.html'))
  }

  // Debug aid: the launcher is frameless with no menu, so devtools is otherwise
  // unreachable. When blur-to-hide is disabled for inspection, pop it detached.
  if (blurHideDisabled) {
    win.webContents.once('did-finish-load', () => {
      if (!win.isDestroyed()) win.webContents.openDevTools({ mode: 'detach' })
    })
  }

  win.on('blur', () => {
    if (blurHideDisabled || suppressBlurHide) return
    // Defer one tick so a focus that bounces straight back (e.g. a native
    // dialog dismissed) cancels the hide.
    setTimeout(() => {
      if (
        !suppressBlurHide &&
        quickWindow &&
        !quickWindow.isDestroyed() &&
        !quickWindow.isFocused()
      ) {
        quickWindow.hide()
      }
    }, 80)
  })

  // The panel is hidden (not destroyed) between uses, so its composer state
  // survives. Tell the renderer to reset when it hides so the next open is
  // fresh — fires for every dismiss path (Esc, blur, post-dispatch).
  win.on('hide', () => {
    if (!win.isDestroyed()) win.webContents.send('quick-dispatch:reset')
  })

  win.on('closed', () => {
    quickWindow = null
  })

  return win
}

/** Lazily create the (hidden) launcher window and return it. */
export function getQuickDispatchWindow(): BrowserWindow {
  if (!quickWindow || quickWindow.isDestroyed()) {
    quickWindow = buildQuickDispatchWindow()
  }
  return quickWindow
}

/** Pre-create the hidden window at startup so the first open is instant. */
export function prewarmQuickDispatchWindow(): void {
  getQuickDispatchWindow()
}

function positionQuickWindow(win: BrowserWindow): void {
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const { x, y, width, height } = display.workArea
  const [winW] = win.getSize()
  const winX = Math.round(x + (width - winW) / 2)
  // Anchor in the upper third — classic launcher placement.
  const winY = Math.round(y + height * 0.22)
  win.setPosition(winX, winY)
}

export function showQuickDispatchWindow(): void {
  const win = getQuickDispatchWindow()
  suppressBlurHide = false
  positionQuickWindow(win)
  win.show()
  win.focus()
  // Re-assert the dock icon in case showing the all-workspaces panel re-flipped
  // the activation policy (see buildQuickDispatchWindow).
  if (process.platform === 'darwin') {
    void app.dock?.show()
  }
  // Tell the renderer to focus the input and re-measure its height.
  win.webContents.send('quick-dispatch:shown')
}

export function hideQuickDispatchWindow(): void {
  if (quickWindow && !quickWindow.isDestroyed() && quickWindow.isVisible()) {
    quickWindow.hide()
  }
}

export function toggleQuickDispatchWindow(): void {
  const win = getQuickDispatchWindow()
  if (win.isVisible() && win.isFocused()) {
    // Already open: a second shortcut press toggles dictation rather than hiding
    // the panel (Esc / click-away still dismiss it). The renderer decides
    // start-vs-stop from the current voice state.
    win.webContents.send('quick-dispatch:toggle-dictation')
  } else {
    showQuickDispatchWindow()
  }
}

export function closeQuickDispatchWindow(): void {
  if (quickWindow && !quickWindow.isDestroyed()) {
    quickWindow.destroy()
  }
  quickWindow = null
}

/** Suppress (or restore) the blur-to-hide while a native picker is open. */
export function setQuickDispatchModal(open: boolean): void {
  suppressBlurHide = open
}

/** Resize the panel's content height to hug its contents (renderer-driven). */
export function setQuickDispatchContentHeight(height: number): void {
  if (!quickWindow || quickWindow.isDestroyed()) return
  const clamped = Math.max(MIN_HEIGHT, Math.min(Math.round(height), 900))
  const [, currentH] = quickWindow.getContentSize()
  if (currentH === clamped) return

  // Capture the top edge BEFORE resizing. On macOS, setContentSize anchors the
  // window's bottom-left (Cocoa's origin is bottom-left), so growing the content
  // pushes the TOP upward — which shoves the text input off the top of the
  // screen when a menu opens. Re-pin the top afterward so the panel always grows
  // DOWNWARD from a fixed anchor (Raycast-style), respecting any user drag.
  const { x, y: topBefore } = quickWindow.getBounds()
  quickWindow.setContentSize(QUICK_WIDTH, clamped)

  // Hold the original top, but clamp so the (possibly taller) window stays fully
  // within the display's work area.
  const { workArea } = screen.getDisplayNearestPoint({ x, y: topBefore })
  const maxTop = workArea.y + workArea.height - clamped - 8
  const top = Math.max(workArea.y + 8, Math.min(topBefore, maxTop))
  quickWindow.setPosition(x, Math.round(top))
}

// --- JS window drag (frameless move without a CSS drag region, which would be
// inert to file drops). The renderer tracks the cursor and reports deltas; we
// move the window relative to its position at drag-start.
//
// We snapshot the SIZE at drag-start and re-assert it on every move via
// setBounds (not setPosition). On Windows with fractional display scaling
// (125%/150%), setPosition round-trips content-size ⇄ window-size ⇄ DIP ⇄
// physical px and re-rounds each call, so a stream of setPosition calls during a
// drag makes the window creep larger (vertically or horizontally) until release
// (Electron #10862). Pinning width+height every move cancels that drift.
let dragOrigin: { x: number; y: number; width: number; height: number } | null = null

/** Begin a window drag: remember where/how big the window was at drag start. */
export function startQuickDispatchDrag(): void {
  if (!quickWindow || quickWindow.isDestroyed()) return
  const [x, y] = quickWindow.getPosition()
  const [width, height] = quickWindow.getSize()
  dragOrigin = { x, y, width, height }
}

/** Move the window to its drag-start position offset by the cursor delta. */
export function moveQuickDispatchDrag(dx: number, dy: number): void {
  if (!quickWindow || quickWindow.isDestroyed() || !dragOrigin) return
  quickWindow.setBounds({
    x: Math.round(dragOrigin.x + dx),
    y: Math.round(dragOrigin.y + dy),
    width: dragOrigin.width,
    height: dragOrigin.height,
  })
}

/** End the current window drag. */
export function endQuickDispatchDrag(): void {
  dragOrigin = null
}

// Files awaiting attachment, delivered PULL-style: the renderer drains this on
// mount AND on the `attach-pending` ping. Pull (not push) so a file queued
// before the renderer registered its listener is never lost to a timing race —
// the mount-time drain always catches it. See openQuickDispatchWithFile.
const pendingAttachPaths: string[] = []

/** Return and clear the queued attach paths (renderer calls this to drain). */
export function drainQuickDispatchAttachPaths(): string[] {
  const paths = pendingAttachPaths.slice()
  pendingAttachPaths.length = 0
  return paths
}

/**
 * Show the launcher and queue a file (dropped on the dock icon / "Open With")
 * for the renderer to attach. Queue first, then nudge the renderer with a ping;
 * even if the ping is missed on a cold launch, the renderer's mount-time drain
 * picks up the already-queued path.
 */
export function openQuickDispatchWithFile(filePath: string): void {
  const win = getQuickDispatchWindow()
  pendingAttachPaths.push(filePath)
  const deliver = () => {
    showQuickDispatchWindow()
    win.webContents.send('quick-dispatch:attach-pending')
  }
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', deliver)
  } else {
    deliver()
  }
}
