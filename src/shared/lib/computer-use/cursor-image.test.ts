import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PNG } from 'pngjs'
import {
  CURSOR_IMAGE_SCALE,
  cursorImageFile,
  cursorImageMarkup,
  setCursorImageRenderer,
  withPngDensity,
} from './cursor-image'

const tinyPng = () => PNG.sync.write(new PNG({ width: 4, height: 2 }))

/** The chunk types of a PNG, in order. */
function chunkTypes(png: Buffer): string[] {
  const types: string[] = []
  let offset = 8
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset)
    types.push(png.toString('latin1', offset + 4, offset + 8))
    offset += 12 + length
  }
  return types
}

afterEach(() => setCursorImageRenderer(null))

describe('cursorImageMarkup', () => {
  it('draws the agent\'s name, escaped, in its colour', () => {
    const markup = cursorImageMarkup({ name: 'Bots <&> "Co"', avatar: { color: 'tonal-blue', shape: 'circle' } })
    expect(markup.html).toContain('Bots &lt;&amp;&gt; &quot;Co&quot;')
    expect(markup.html).not.toContain('<&>')
    expect(markup.html).toContain('#2B79FA')
  })

  it('writes dark text on a light chip and white text on a dark one', () => {
    expect(cursorImageMarkup({ name: 'A', avatar: { color: 'tonal-white', shape: 'hexagon' } }).html).toContain('color: #1D1D1F')
    expect(cursorImageMarkup({ name: 'A', avatar: { color: 'tonal-black', shape: 'triangle' } }).html).toContain('color: #FFFFFF')
  })

  it('stays inside the room agent-desktop gives a cursor image, right of and below the tip', () => {
    const { width, height, hotspot } = cursorImageMarkup({ name: 'x'.repeat(200) })
    expect(width - hotspot.x).toBeLessThanOrEqual(152)
    expect(height - hotspot.y).toBeLessThanOrEqual(172)
  })

  it('keys the image by what it draws', () => {
    const a = cursorImageMarkup({ name: 'Ana', avatar: { color: 'tonal-red', shape: 'bloom' } }).key
    expect(cursorImageMarkup({ name: 'Ana', avatar: { color: 'tonal-red', shape: 'bloom' } }).key).toBe(a)
    expect(cursorImageMarkup({ name: 'Ana', avatar: { color: 'tonal-teal', shape: 'bloom' } }).key).not.toBe(a)
    expect(cursorImageMarkup({ name: 'Bo', avatar: { color: 'tonal-red', shape: 'bloom' } }).key).not.toBe(a)
  })
})

describe('withPngDensity', () => {
  it('marks the density right after the header, and the PNG still reads', () => {
    const marked = withPngDensity(tinyPng(), 144)
    expect(chunkTypes(marked).slice(0, 2)).toEqual(['IHDR', 'pHYs'])
    const phys = marked.indexOf('pHYs')
    expect(marked.readUInt32BE(phys + 4)).toBe(5669)
    expect(marked.readUInt8(phys + 12)).toBe(1)
    expect(PNG.sync.read(marked).width).toBe(4)
  })

  it('replaces a density the PNG already has', () => {
    const twice = withPngDensity(withPngDensity(tinyPng(), 72), 144)
    expect(chunkTypes(twice).filter((type) => type === 'pHYs')).toHaveLength(1)
    expect(twice.readUInt32BE(twice.indexOf('pHYs') + 4)).toBe(5669)
  })

  it('refuses what is not a PNG', () => {
    expect(() => withPngDensity(Buffer.from('not a png at all, really not'), 144)).toThrow()
  })
})

describe('cursorImageFile', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('draws nothing without a renderer', async () => {
    expect(await cursorImageFile({ name: 'Ana' }, os.tmpdir())).toBeNull()
  })

  it('draws once per name and avatar, at twice the size, marked for Retina', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-image-'))
    dirs.push(dir)
    const renderer = vi.fn(async () => tinyPng())
    setCursorImageRenderer(renderer)

    const first = await cursorImageFile({ name: 'Ana', avatar: { color: 'tonal-red', shape: 'bloom' } }, dir)
    const again = await cursorImageFile({ name: 'Ana', avatar: { color: 'tonal-red', shape: 'bloom' } }, dir)

    expect(renderer).toHaveBeenCalledTimes(1)
    expect(again).toEqual(first)
    const png = fs.readFileSync(first!.path)
    expect(png.readUInt32BE(png.indexOf('pHYs') + 4)).toBe(Math.round((72 * CURSOR_IMAGE_SCALE) / 0.0254))
  })
})
