/**
 * Draws agents' computer-use cursors (see shared/lib/computer-use/cursor-image.ts)
 * in an offscreen window of this process: the page lays out once, transparent,
 * and its painted frame becomes the PNG agent-desktop draws on the user's screen.
 *
 * An offscreen window never appears on screen, but it must not be created
 * hidden (`show: false`): a hidden page stops painting and no frame arrives.
 */
import { BrowserWindow, type NativeImage } from 'electron'
import { CURSOR_IMAGE_SCALE, setCursorImageRenderer, type CursorImageMarkup } from '@shared/lib/computer-use/cursor-image'

const RENDER_TIMEOUT_MS = 5_000

async function renderCursorImage(markup: CursorImageMarkup): Promise<Buffer> {
  const width = Math.ceil(markup.width * CURSOR_IMAGE_SCALE)
  const height = Math.ceil(markup.height * CURSOR_IMAGE_SCALE)
  // Offscreen frames come at one pixel per CSS pixel: zoom the page instead.
  const window = new BrowserWindow({
    width,
    height,
    useContentSize: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    skipTaskbar: true,
    focusable: false,
    webPreferences: { offscreen: true, javascript: false, sandbox: true, zoomFactor: CURSOR_IMAGE_SCALE },
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const frame = await Promise.race([
      new Promise<NativeImage>((resolve, reject) => {
        let loaded = false
        window.webContents.on('paint', (_event, _dirty, image) => {
          // The first frames can come before the page has laid out, or empty.
          if (loaded && !image.isEmpty()) resolve(image)
        })
        window.webContents.setFrameRate(30)
        window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(markup.html)}`).then(() => {
          loaded = true
          window.webContents.invalidate()
        }, reject)
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('The cursor image did not render in time')), RENDER_TIMEOUT_MS)
      }),
    ])
    const size = frame.getSize()
    const exact = size.width === width && size.height === height
      ? frame
      : frame.resize({ width, height, quality: 'best' })
    return exact.toPNG()
  } finally {
    clearTimeout(timer)
    window.destroy()
  }
}

/** Let computer use draw agents' cursors from this process. */
export function registerComputerUseCursorRenderer(): void {
  setCursorImageRenderer(renderCursorImage)
}
