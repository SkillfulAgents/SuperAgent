import { capturesOwnWindow } from '@renderer/lib/capabilities'
import type { CommentPin } from './dashboard-comment-message'

/** The longest edge sent to the agent: a vision model scales anything larger down to about this anyway. */
const MAX_EDGE = 1600

/** Set on the root while capturing: the app's floating layers hide (globals.css). */
const CAPTURING = 'data-capturing-dashboard'

/** Two frames: the next one applies a change, the one after is drawn with it. */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

/**
 * A PNG of the frame as it is on screen, or null where the window can't
 * capture itself or the capture fails. The app's tooltips, menus and toasts
 * can sit over the frame (the header button's tooltip, the right-click menu);
 * they are hidden for the capture, so it shows the dashboard alone.
 */
export async function captureDashboardFrame(frame: HTMLIFrameElement | null): Promise<Blob | null> {
  if (!frame || !capturesOwnWindow()) return null
  const root = document.documentElement
  root.setAttribute(CAPTURING, '')
  try {
    await nextPaint()
    const rect = frame.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return null
    const png = await window.electronAPI?.captureRegion?.({
      x: Math.max(0, rect.left),
      y: Math.max(0, rect.top),
      width: rect.width,
      height: rect.height,
    })
    return png?.byteLength ? new Blob([new Uint8Array(png)], { type: 'image/png' }) : null
  } catch {
    return null
  } finally {
    root.removeAttribute(CAPTURING)
  }
}

/**
 * The capture as the agent gets it: scaled to fit `MAX_EDGE`, with a ring
 * where the comment is pinned. The ring is hollow so what it marks stays
 * visible, magenta so it reads as the app's mark on any dashboard. Falls back
 * to the capture as taken.
 */
export async function prepareScreenshot(png: Blob, pin: CommentPin | null): Promise<Blob> {
  if (typeof createImageBitmap !== 'function') return png
  try {
    const image = await createImageBitmap(png)
    const scale = Math.min(1, MAX_EDGE / Math.max(image.width, image.height))
    if (scale === 1 && !pin) {
      image.close()
      return png
    }
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(image.width * scale)
    canvas.height = Math.round(image.height * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) return png
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
    image.close()
    if (pin) {
      const unit = Math.max(1, Math.min(canvas.width, canvas.height) / 600)
      const x = (pin.x / 100) * canvas.width
      const y = (pin.y / 100) * canvas.height
      const radius = 16 * unit
      ctx.lineWidth = 6 * unit
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)'
      ctx.beginPath()
      ctx.arc(x, y, radius, 0, Math.PI * 2)
      ctx.stroke()
      ctx.lineWidth = 3 * unit
      ctx.strokeStyle = '#ff00d4'
      ctx.beginPath()
      ctx.arc(x, y, radius, 0, Math.PI * 2)
      ctx.stroke()
    }
    const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    return out ?? png
  } catch {
    return png
  }
}
