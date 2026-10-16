// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { describeAnchor, locateAnchor, placeMarkers, refineAnchor, resolveAnchor } from './anchor'
import type { CommentSurface } from './kinds'
import type { PointerAt, SelectionAt } from './kinds/types'

function box(rect: [number, number, number, number], tag = 'div'): HTMLElement {
  const el = document.createElement(tag)
  el.getBoundingClientRect = () => new DOMRect(...rect)
  document.body.append(el)
  return el
}
const at = (on: 'click' | 'mouse', target: Element, clientX = 0, clientY = 0): PointerAt => ({ on, target, clientX, clientY })
function media(currentTime: number, duration: number): HTMLMediaElement {
  return Object.defineProperties(document.createElement('audio'), {
    currentTime: { value: currentTime, writable: true },
    duration: { value: duration },
  })
}

describe('resolveAnchor', () => {
  it('opens a cell only on a cell; the toolbar keeps its click, and keys elsewhere comment on the file', () => {
    const grid = box([0, 0, 100, 100])
    const td = box([0, 0, 10, 10], 'td')
    td.setAttribute('data-comment-cell', '2:1')
    grid.append(td)
    const toolbar = box([0, 0, 100, 10])
    const surface: CommentSurface = { cell: { grid: { current: grid }, cellAt: (row, col) => ({ row, col, column: 'Email', value: 'x' }) } }

    expect(resolveAnchor(surface, at('click', td))).toEqual({ kind: 'cell', cell: { row: 2, col: 1, column: 'Email', value: 'x' } })
    expect(resolveAnchor(surface, at('click', toolbar))).toBeNull()
    expect(resolveAnchor(surface, { on: 'elsewhere' })).toEqual({ kind: 'file' })
  })

  it('never opens audio on a click, so the waveform keeps seeking; a key over it takes the hovered time', () => {
    const track = box([0, 0, 200, 50])
    const surface: CommentSurface = { time: { media: { current: media(5, 60) }, track: { current: track } } }

    expect(resolveAnchor(surface, at('click', track, 100))).toBeNull()
    expect(resolveAnchor(surface, at('mouse', track, 100))).toEqual({ kind: 'time', seconds: 30 })
    expect(resolveAnchor(surface, { on: 'elsewhere' })).toEqual({ kind: 'time', seconds: 5, point: undefined })
  })

  it('puts a video comment at the playhead and the clicked point; moving it keeps its time', () => {
    const frame = box([0, 0, 200, 100])
    const video = media(4, 60)
    const surface: CommentSurface = { time: { media: { current: video }, track: { current: box([0, 0, 1, 1]) }, frame: { current: frame } } }

    const opened = resolveAnchor(surface, at('click', frame, 50, 30))
    expect(opened).toEqual({ kind: 'time', seconds: 4, point: { x: 25, y: 30 } })
    video.currentTime = 9
    expect(refineAnchor(surface, at('click', frame, 100, 50), opened!)).toEqual({ kind: 'time', seconds: 4, point: { x: 50, y: 50 } })
  })

  it('pins an image at the mouse, or at its center when the mouse is elsewhere', () => {
    const image = box([0, 0, 200, 100])
    const surface: CommentSurface = { point: { current: image } }

    expect(resolveAnchor(surface, at('mouse', image, 150, 25))).toEqual({ kind: 'point', x: 75, y: 25 })
    expect(resolveAnchor(surface, { on: 'elsewhere' })).toEqual({ kind: 'point', x: 50, y: 50 })
  })
})

describe('locateAnchor', () => {
  it('shows a video pin only near the playhead, and always while the comment is open; the tick sits at its time', () => {
    const frame = box([0, 0, 200, 100])
    const track = box([0, 0, 200, 8])
    const video = media(10, 40)
    const surface: CommentSurface = { time: { media: { current: video }, track: { current: track }, frame: { current: frame } } }
    const anchor = { kind: 'time', seconds: 20, point: { x: 30, y: 40 } } as const

    expect(locateAnchor(surface, anchor, false)).toEqual([{ host: track, x: 50, y: 100 }])
    expect(locateAnchor(surface, anchor, true)).toEqual([{ host: frame, x: 30, y: 40 }, { host: track, x: 50, y: 100 }])
    video.currentTime = 20.3
    expect(locateAnchor(surface, anchor, false)[0]).toEqual({ host: frame, x: 30, y: 40 })
  })

  it('places no saved tick before the length is known, and puts an open comment under the timeline middle', () => {
    const track = box([0, 0, 200, 8])
    const surface: CommentSurface = { time: { media: { current: media(0, NaN) }, track: { current: track } } }
    expect(locateAnchor(surface, { kind: 'time', seconds: 3 }, false)).toEqual([])
    expect(locateAnchor(surface, { kind: 'time', seconds: 3 }, true)).toEqual([{ host: track, x: 50, y: 100 }])
  })

  it('shares one marker per cell, but keeps two pins on one spot as two', () => {
    const grid = box([0, 0, 100, 100])
    const td = box([0, 0, 10, 10], 'td')
    td.setAttribute('data-comment-cell', '1:0')
    grid.append(td)
    const image = box([0, 0, 100, 100])
    const surface: CommentSurface = { cell: { grid: { current: grid }, cellAt: () => undefined }, point: { current: image } }
    const cell = { kind: 'cell', cell: { row: 1, col: 0, column: 'A' } } as const
    const pin = { kind: 'point', x: 10, y: 10 } as const

    const placed = placeMarkers(surface, [cell, pin, cell, pin], null)
    expect(placed.map(p => p.numbers)).toEqual([[1, 3], [2], [4]])
    expect(placeMarkers(surface, [cell], cell).map(p => p.isOpen)).toEqual([false, true])
  })
})

describe('text comments', () => {
  /** A file whose blocks carry their source lines, like the markdown and text viewers render it. */
  function file(blocks: [string, string][]): { root: HTMLElement; els: HTMLElement[]; surface: CommentSurface } {
    const root = box([0, 0, 100, 100])
    const els = blocks.map(([lines, text]) => {
      const p = document.createElement('p')
      p.setAttribute('data-comment-lines', lines)
      p.textContent = text
      root.append(p)
      return p
    })
    return { root, els, surface: { text: { blocks: { current: root } } } }
  }
  function select(start: Node, startOffset: number, end: Node, endOffset: number, text: string): SelectionAt {
    const range = document.createRange()
    range.setStart(start, startOffset)
    range.setEnd(end, endOffset)
    return { on: 'selection', range, text }
  }

  it('gives a selection the lines of every block it covers, but not the block its end only touches', () => {
    const { els: [intro, body, next], surface } = file([['1-1', 'Intro'], ['3-4', 'Body text'], ['6-6', 'Next']])

    expect(resolveAnchor(surface, select(intro.firstChild!, 2, body.firstChild!, 4, 'tro\nBody'))).toEqual({ kind: 'text', quote: 'tro\nBody', lines: { start: 1, end: 4 } })
    // A triple-click ends at the start of the next block.
    expect(resolveAnchor(surface, select(body.firstChild!, 0, next, 0, 'Body text\n'))).toEqual({ kind: 'text', quote: 'Body text', lines: { start: 3, end: 4 } })
  })

  it('takes the innermost block a selection covers, not the list item around it', () => {
    const { root, surface } = file([])
    const item = document.createElement('li')
    item.setAttribute('data-comment-lines', '5-7')
    const para = document.createElement('p')
    para.setAttribute('data-comment-lines', '7-7')
    para.textContent = 'Second para'
    item.append(para)
    root.append(item)

    expect(resolveAnchor(surface, select(para.firstChild!, 0, para.firstChild!, 6, 'Second'))).toEqual({ kind: 'text', quote: 'Second', lines: { start: 7, end: 7 } })
  })

  it('spans a parent list item and its child when the selection covers both', () => {
    const { root, surface } = file([])
    const parent = document.createElement('li')
    parent.setAttribute('data-comment-lines', '1-2')
    parent.append('Parent')
    const child = document.createElement('li')
    child.setAttribute('data-comment-lines', '2-2')
    child.textContent = 'Child'
    parent.append(child)
    root.append(parent)

    expect(resolveAnchor(surface, select(parent.firstChild!, 0, child.firstChild!, 5, 'Parent\nChild'))).toEqual({ kind: 'text', quote: 'Parent\nChild', lines: { start: 1, end: 2 } })
  })

  it('quotes a block without the comment pins drawn inside it', () => {
    const { els: [block], surface } = file([['4-4', 'Ship it.']])
    const pin = document.createElement('span')
    pin.setAttribute('data-comment-marker', '')
    pin.textContent = '1'
    block.append(pin)

    expect(resolveAnchor(surface, at('mouse', block))).toEqual({ kind: 'text', quote: 'Ship it.', lines: { start: 4, end: 4 } })
  })

  it('tells the second "Ship it." from the first, and puts its marker there', () => {
    const { els: [, second], surface } = file([['2-2', 'Ship it.'], ['9-9', 'Ship it.']])

    const anchor = resolveAnchor(surface, at('mouse', second))
    expect(anchor).toEqual({ kind: 'text', quote: 'Ship it.', lines: { start: 9, end: 9 } })
    expect(locateAnchor(surface, anchor!, false)).toEqual([{ host: second, x: 100, y: 0 }])
    expect(describeAnchor(anchor!)).toBe('Line 9: > "Ship it."')
  })

  it('leaves a key between blocks to the whole file, and a quote without lines out of the file', () => {
    const { root, surface } = file([['1-1', 'Intro']])

    expect(resolveAnchor(surface, at('mouse', root))).toBeNull()
    expect(resolveAnchor(surface, { on: 'elsewhere' })).toEqual({ kind: 'file' })
    expect(locateAnchor(surface, { kind: 'text', quote: 'Intro' }, false)).toEqual([])
  })

  it('caps a long quote and escapes its quotes, like a cell value', () => {
    expect(describeAnchor({ kind: 'text', quote: 'x'.repeat(250), lines: { start: 1, end: 1 } })).toBe(`Line 1: > "${'x'.repeat(200)}…"`)
    expect(describeAnchor({ kind: 'text', quote: 'say "hi"' })).toBe('> "say \\"hi\\""')
  })

  it('puts a PDF comment on its page: a selection keeps its quote, anything else is the page', () => {
    const root = box([0, 0, 100, 100])
    root.textContent = 'Total due'
    const surface: CommentSurface = { text: { blocks: { current: root } }, part: { label: 'Page', value: 3 } }

    const quoted = resolveAnchor(surface, select(root.firstChild!, 0, root.firstChild!, 5, 'Total'))!
    const page = resolveAnchor(surface, { on: 'elsewhere' })!
    expect(describeAnchor(quoted)).toBe('Page 3: > "Total"')
    expect(describeAnchor(page)).toBe('Page 3')
  })
})
