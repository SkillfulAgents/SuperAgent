// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { locateAnchor, placeMarkers, refineAnchor, resolveAnchor, selectionToAnchor } from './anchor'
import type { CommentSurface } from './kinds'
import type { PointerAt } from './kinds/types'

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

describe('selectionToAnchor', () => {
  it('keeps the precedence the comment list always used: cell, text, time, point, file', () => {
    const cell = { row: 1, col: 0, column: 'Name', value: 'Ada' }
    expect(selectionToAnchor({ text: 'Ada', cell })).toEqual({ kind: 'cell', cell })
    expect(selectionToAnchor({ text: 'teh', timestamp: 3, x: 1, y: 2 })).toEqual({ kind: 'text', quote: 'teh' })
    expect(selectionToAnchor({ text: '', timestamp: 3, x: 1, y: 2 })).toEqual({ kind: 'time', seconds: 3, point: { x: 1, y: 2 } })
    expect(selectionToAnchor({ text: '', x: 1, y: 2 })).toEqual({ kind: 'point', x: 1, y: 2 })
    expect(selectionToAnchor({ text: '' })).toEqual({ kind: 'file' })
  })
})
