/**
 * The agent's cursor, as computer use draws it on the user's screen: a small
 * arrow in the agent's colour, and below it a chip with the agent's orb and
 * name, like a collaborator's cursor in a shared document.
 *
 * agent-desktop draws a cursor from a PNG (`cursor-overlay enable --image`).
 * This module lays the cursor out as an HTML page; whoever can render HTML on
 * this machine (Electron's main process, see src/main/computer-use-cursor.ts)
 * registers itself here and turns the page into the PNG. With no renderer
 * registered, the executor falls back to agent-desktop's own arrow and label.
 *
 * The page is drawn at twice its size and the PNG marked 144 DPI, so macOS
 * reads it at its size in points and draws it sharp on Retina screens.
 */

import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { crc32 } from 'zlib'
import type { AgentAvatar } from '@shared/lib/types/agent-avatar'
import { GHOST_ORB, OFFERED_ORBS, type OrbAppearance } from '@shared/lib/types/agent-avatar-orbs'
import { orbShape, shapePath, shapePose, type OrbShape } from '@shared/lib/types/agent-avatar-shapes'

/** Pixels per point in the rendered PNG. */
export const CURSOR_IMAGE_SCALE = 2

/** Bump when the drawing changes, so cached images are drawn again. */
const LAYOUT_VERSION = 3

// Layout, in points. agent-desktop keeps the cursor inside a 240 pt square with
// the tip 88 pt from its left and 172 pt from its bottom, and shrinks an image
// that reaches past it: 152 pt of room right of the tip, 68 pt above it.
const PAD = 4
const WIDTH = 155
const HEIGHT = 42
const CHIP_LEFT = PAD + 7
const CHIP_TOP = PAD + 13
const CHIP_HEIGHT = 21
const ORB_SIZE = 15
const MAX_NAME_WIDTH = WIDTH - CHIP_LEFT - 3 - ORB_SIZE - 5 - 9 - 4

/** The click point in the image, in points: the arrow's tip. */
const HOTSPOT = { x: PAD + 0.5, y: PAD + 0.5 }

export interface CursorImageRequest {
  /** The agent's name, as the chip shows it. */
  name: string
  avatar?: AgentAvatar | null
}

export interface CursorImageMarkup {
  html: string
  /** The page's size in CSS pixels (points); render it at CURSOR_IMAGE_SCALE pixels per point. */
  width: number
  height: number
  hotspot: { x: number; y: number }
  /** Stands for everything drawn: the same key draws the same image. */
  key: string
}

export type CursorImageRenderer = (markup: CursorImageMarkup) => Promise<Buffer>

let renderer: CursorImageRenderer | null = null

/** Called once by the process that can render HTML (Electron's main process). */
export function setCursorImageRenderer(next: CursorImageRenderer | null): void {
  renderer = next
}

export function hasCursorImageRenderer(): boolean {
  return renderer !== null
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function orbFor(avatar: AgentAvatar | null | undefined): OrbAppearance {
  return (avatar && OFFERED_ORBS.find((orb) => orb.name === avatar.color)) || GHOST_ORB
}

/** Relative luminance of a #RRGGBB colour, 0 (black) to 1 (white). */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * The orb at rest, looking up and left toward the cursor's tip: the
 * rim-coloured body, the core's glow, and the half-size face in its
 * gradient, as the app's avatar draws them.
 */
function orbSvg(orb: OrbAppearance, shape: OrbShape, size: number): string {
  const pose = shapePose(shape, { phi: 225, distance: 0.55 }, size, orb.hold)
  const outline = shapePath(shape, size)
  const half = size / 2
  const glowRadius = (size * 228) / 240 / 2
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="overflow:visible">
  <defs>
    <clipPath id="orb-body"><path d="${outline}"/></clipPath>
    <radialGradient id="orb-glow">
      <stop offset="0%" stop-color="${orb.core}"/>
      <stop offset="${orb.hold}%" stop-color="${orb.core}"/>
      <stop offset="100%" stop-color="${orb.core}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="orb-face" x1="0" y1="0" x2="1" y2="1">
      <stop offset="25%" stop-color="${orb.faceA}"/>
      <stop offset="75%" stop-color="${orb.faceB}"/>
    </linearGradient>
  </defs>
  <path d="${outline}" fill="#FFFFFF" stroke="#FFFFFF" stroke-width="3" stroke-linejoin="round"/>
  <g clip-path="url(#orb-body)">
    <rect width="${size}" height="${size}" fill="${orb.rim}"/>
    <circle cx="${(half + pose.glowX).toFixed(2)}" cy="${(half + pose.glowY).toFixed(2)}" r="${glowRadius.toFixed(2)}" fill="url(#orb-glow)"/>
    <g transform="translate(${(half + pose.faceX).toFixed(2)} ${(half + pose.faceY).toFixed(2)}) scale(0.5) translate(${-half} ${-half})">
      <path d="${outline}" fill="url(#orb-face)"/>
    </g>
  </g>
</svg>`
}

/** The cursor as an HTML page, with what the PNG needs to say about it. */
export function cursorImageMarkup(request: CursorImageRequest): CursorImageMarkup {
  const orb = orbFor(request.avatar)
  const shape = orbShape(request.avatar?.shape)
  const name = request.name.trim() || 'Agent'
  const chip = orb.rim
  const ink = luminance(chip) > 0.5 ? '#1D1D1F' : '#FFFFFF'

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
  body { width: ${WIDTH}px; height: ${HEIGHT}px; position: relative;
    font: 600 11.5px/1 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased; }
  .arrow { position: absolute; left: ${PAD}px; top: ${PAD}px; overflow: visible;
    filter: drop-shadow(0 1px 1.5px rgba(0,0,0,.35)); }
  .chip { position: absolute; left: ${CHIP_LEFT}px; top: ${CHIP_TOP}px; height: ${CHIP_HEIGHT}px;
    box-sizing: border-box; display: flex; align-items: center; gap: 5px;
    padding: 0 9px 0 3px; border-radius: ${CHIP_HEIGHT / 2}px;
    background: ${chip}; color: ${ink};
    box-shadow: 0 1px 3px rgba(0,0,0,.28), inset 0 0 0 0.5px rgba(255,255,255,.35); }
  .orb { width: ${ORB_SIZE}px; height: ${ORB_SIZE}px; flex: none; display: block; }
  .name { max-width: ${MAX_NAME_WIDTH}px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    letter-spacing: -0.1px; padding-bottom: 0.5px; }
</style></head><body>
<svg class="arrow" width="12" height="16" viewBox="0 0 12 16">
  <path d="M0.5 0.5 L0.5 13.4 C0.5 14 1.2 14.3 1.65 13.9 L4.75 10.9 L9.9 10.9 C10.5 10.9 10.8 10.2 10.35 9.8 Z"
    fill="${orb.rim}" stroke="#FFFFFF" stroke-width="1.5" stroke-linejoin="round"/>
</svg>
<div class="chip"><span class="orb">${orbSvg(orb, shape, ORB_SIZE)}</span><span class="name">${escapeHtml(name)}</span></div>
</body></html>`

  const key = createHash('sha256')
    .update(JSON.stringify({ v: LAYOUT_VERSION, name, avatar: request.avatar ?? null }))
    .digest('hex')
    .slice(0, 20)
  return { html, width: WIDTH, height: HEIGHT, hotspot: HOTSPOT, key }
}

/**
 * Mark a PNG's density, so macOS takes `dpi / 72` pixels for each point. Any
 * density chunk it already has is replaced; the new one follows the header.
 */
export function withPngDensity(png: Buffer, dpi: number): Buffer {
  const signature = 8
  if (png.length < signature + 25 || png.toString('latin1', 12, 16) !== 'IHDR') {
    throw new Error('Not a PNG with a header chunk')
  }
  const chunks: Buffer[] = [png.subarray(0, signature)]
  let offset = signature
  let inserted = false
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('latin1', offset + 4, offset + 8)
    const end = offset + 12 + length
    if (type !== 'pHYs') chunks.push(png.subarray(offset, end))
    if (type === 'IHDR' && !inserted) {
      const data = Buffer.alloc(9)
      const perMetre = Math.round(dpi / 0.0254)
      data.writeUInt32BE(perMetre, 0)
      data.writeUInt32BE(perMetre, 4)
      data.writeUInt8(1, 8)
      const typeAndData = Buffer.concat([Buffer.from('pHYs', 'latin1'), data])
      const chunk = Buffer.alloc(12 + data.length)
      chunk.writeUInt32BE(data.length, 0)
      typeAndData.copy(chunk, 4)
      chunk.writeUInt32BE(crc32(typeAndData) >>> 0, 8 + data.length)
      chunks.push(chunk)
      inserted = true
    }
    offset = end
  }
  return Buffer.concat(chunks)
}

/**
 * The agent's cursor as a PNG file under `dir`, drawn once per name and
 * avatar; null when no renderer is registered or drawing fails.
 */
export async function cursorImageFile(
  request: CursorImageRequest,
  dir: string,
): Promise<{ path: string; hotspot: { x: number; y: number } } | null> {
  if (!renderer) return null
  const markup = cursorImageMarkup(request)
  const file = path.join(dir, `cursor-${markup.key}.png`)
  if (!fs.existsSync(file)) {
    const png = withPngDensity(await renderer(markup), 72 * CURSOR_IMAGE_SCALE)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const temporary = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temporary, png, { mode: 0o600 })
    fs.renameSync(temporary, file)
  }
  return { path: file, hotspot: markup.hotspot }
}
