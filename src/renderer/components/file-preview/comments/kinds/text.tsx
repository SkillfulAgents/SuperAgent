import { useEffect, type RefObject } from 'react'
import { CommentPin } from '../comment-pin'
import { quoted, type AnchorKindSpec, type MarkerProps, type PointerAt } from './types'

export interface Lines {
  start: number
  end: number
}
export interface TextAnchor {
  kind: 'text'
  quote: string
  /** Source lines, when the blocks it touches carry them. */
  lines?: Lines
}
export interface TextSurface {
  /** Blocks inside it carry `data-comment-lines="start-end"`. */
  blocks: RefObject<HTMLElement | null>
}

const MARK = '[data-comment-lines]'
const HIGHLIGHT = 'file-comment'

function linesOf(el: Element): Lines | null {
  const [start, end] = (el.getAttribute('data-comment-lines') ?? '').split('-').map(Number)
  return start > 0 && end >= start ? { start, end } : null
}

function marks({ blocks }: TextSurface): Element[] {
  return [...(blocks.current?.querySelectorAll(MARK) ?? [])]
}

/** The marks holding text the selection actually covers: each selected text node's closest mark. */
function selectedMarks({ blocks }: TextSurface, range: Range): Element[] {
  const root = blocks.current
  if (!root) return []
  const found = new Set<Element>()
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node instanceof Text) || !range.intersectsNode(node)) continue
    const start = node === range.startContainer ? range.startOffset : 0
    const end = node === range.endContainer ? range.endOffset : node.data.length
    const mark = node.parentElement?.closest(MARK)
    if (mark && !node.parentElement?.closest('[data-comment-marker]') && node.data.slice(start, end).trim()) found.add(mark)
  }
  return [...found]
}

function span(all: Lines[]): Lines | undefined {
  if (!all.length) return undefined
  return { start: Math.min(...all.map(l => l.start)), end: Math.max(...all.map(l => l.end)) }
}

/** A block's own text: no comment pins, and no copies of it (KaTeX draws an equation twice and keeps its TeX source). */
function textOf(block: Element): string {
  const copy = block.cloneNode(true)
  if (copy instanceof Element) copy.querySelectorAll('[data-comment-marker], [aria-hidden="true"], annotation').forEach(el => el.remove())
  return (copy.textContent ?? '').trim()
}

function blockUnder(surface: TextSurface, at: PointerAt): TextAnchor | null {
  const block = at.target.closest(MARK)
  const lines = block && surface.blocks.current?.contains(block) ? linesOf(block) : null
  return block && lines ? { kind: 'text', quote: textOf(block), lines } : null
}

/** The marked blocks inside the comment's lines. */
function blocksOf(surface: TextSurface, lines: Lines): Element[] {
  return marks(surface).filter(el => {
    const own = linesOf(el)
    return own != null && own.start >= lines.start && own.end <= lines.end
  })
}

// One highlight shared by every comment's blocks (CSS Custom Highlight API, as in session search).
const highlighted = new Set<Range>()

function paint(ranges: Range[]): () => void {
  // jsdom has neither.
  if (typeof Highlight === 'undefined' || !('highlights' in CSS)) return () => {}
  const redraw = () => {
    if (highlighted.size) CSS.highlights.set(HIGHLIGHT, new Highlight(...highlighted))
    else CSS.highlights.delete(HIGHLIGHT)
  }
  ranges.forEach(r => highlighted.add(r))
  redraw()
  return () => {
    ranges.forEach(r => highlighted.delete(r))
    redraw()
  }
}

function TextMarker({ slice, anchor, site, numbers }: MarkerProps<TextAnchor, TextSurface>) {
  // The pin's host is the first block: a re-rendered file replaces it, and the highlight follows.
  useEffect(() => {
    if (!anchor.lines) return
    return paint(blocksOf(slice, anchor.lines).map(el => {
      const range = document.createRange()
      range.selectNodeContents(el)
      return range
    }))
  }, [slice, anchor.lines, site.host])
  return (
    <span data-comment-marker className="select-none">
      <CommentPin x={site.x} y={site.y} number={numbers[0]} />
    </span>
  )
}

export const textKind: AnchorKindSpec<TextAnchor, TextSurface> = {
  fromSelection: (surface, { range, text }) => {
    const quote = text.trim()
    if (!quote) return null
    const lines = span(selectedMarks(surface, range).map(linesOf).filter(l => l != null))
    return lines ? { kind: 'text', quote, lines } : { kind: 'text', quote }
  },
  fromMouse: blockUnder,
  describe: ({ quote, lines }) => {
    const where = !lines ? '' : lines.start === lines.end ? `Line ${lines.start}` : `Lines ${lines.start}-${lines.end}`
    if (!quote) return where
    return where ? `${where}: > ${quoted(quote)}` : `> ${quoted(quote)}`
  },
  locate: (surface, { lines }) => {
    const first = lines && blocksOf(surface, lines)[0]
    return first ? [{ host: first, x: 100, y: 0 }] : []
  },
  Marker: TextMarker,
}
