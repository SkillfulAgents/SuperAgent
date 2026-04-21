import { useCallback, useEffect, useRef, useState } from 'react'

const SCROLL_CONTAINER_SELECTOR = '[data-testid="message-list"]'
const HIGHLIGHT_NAME = 'session-search'
const CURRENT_HIGHLIGHT_NAME = 'session-search-current'

// Fallback shape for the CSS Custom Highlight API in case lib.dom.d.ts
// lacks it. Cast through unknown at call sites rather than redeclaring.
type HighlightCtor = new (...ranges: Range[]) => unknown
type HighlightsRegistry = {
  set: (name: string, highlight: unknown) => void
  delete: (name: string) => boolean
}

function getContainer(): HTMLElement | null {
  return document.querySelector<HTMLElement>(SCROLL_CONTAINER_SELECTOR)
}

function getHighlights(): HighlightsRegistry | null {
  const registry = (CSS as unknown as { highlights?: HighlightsRegistry }).highlights
  return registry ?? null
}

function getHighlightCtor(): HighlightCtor | null {
  const ctor = (window as unknown as { Highlight?: HighlightCtor }).Highlight
  return ctor ?? null
}

function clearRegisteredHighlights() {
  const registry = getHighlights()
  if (!registry) return
  registry.delete(HIGHLIGHT_NAME)
  registry.delete(CURRENT_HIGHLIGHT_NAME)
}

function findMatchRanges(container: HTMLElement, query: string): Range[] {
  const ranges: Range[] = []
  if (!query) return ranges
  const lowerQuery = query.toLowerCase()
  const qLen = query.length

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      const tag = parent.tagName
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA') {
        return NodeFilter.FILTER_REJECT
      }
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })

  let n: Node | null
  while ((n = walker.nextNode())) {
    const textNode = n as Text
    const text = textNode.nodeValue ?? ''
    const lower = text.toLowerCase()
    let idx = lower.indexOf(lowerQuery, 0)
    while (idx !== -1) {
      const range = document.createRange()
      range.setStart(textNode, idx)
      range.setEnd(textNode, idx + qLen)
      ranges.push(range)
      idx = lower.indexOf(lowerQuery, idx + qLen)
    }
  }

  return ranges
}

function registerHighlights(ranges: Range[], currentIndex: number) {
  const registry = getHighlights()
  const Ctor = getHighlightCtor()
  if (!registry || !Ctor) return
  clearRegisteredHighlights()
  if (ranges.length === 0) return

  const baseRanges: Range[] = []
  for (let i = 0; i < ranges.length; i++) {
    if (i !== currentIndex) baseRanges.push(ranges[i])
  }
  if (baseRanges.length > 0) {
    registry.set(HIGHLIGHT_NAME, new Ctor(...baseRanges))
  }
  if (currentIndex >= 0 && currentIndex < ranges.length) {
    registry.set(CURRENT_HIGHLIGHT_NAME, new Ctor(ranges[currentIndex]))
  }
}

function scrollRangeIntoView(range: Range, scrollContainer: HTMLElement) {
  const rect = range.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return
  const containerRect = scrollContainer.getBoundingClientRect()
  const topWithin = rect.top - containerRect.top
  // Only scroll if the match isn't comfortably inside the viewport already.
  const margin = 40
  if (topWithin >= margin && topWithin + rect.height <= scrollContainer.clientHeight - margin) return
  const targetTop =
    scrollContainer.scrollTop + topWithin - scrollContainer.clientHeight / 2 + rect.height / 2
  scrollContainer.scrollTo({ top: targetTop, behavior: 'smooth' })
}

export interface SessionSearch {
  open: boolean
  query: string
  totalMatches: number
  currentIndex: number
  setQuery: (q: string) => void
  next: () => void
  prev: () => void
  close: () => void
  inputRef: React.RefObject<HTMLInputElement>
}

/**
 * Find-in-session search using the CSS Custom Highlight API.
 * No DOM mutation — creates Range objects over React-managed text nodes and
 * registers them via CSS.highlights, so reconciliation can't conflict.
 */
export function useSessionSearch(active: boolean, resetKey: string | null): SessionSearch {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [totalMatches, setTotalMatches] = useState(0)
  const [currentIndex, setCurrentIndex] = useState(-1)
  const rangesRef = useRef<Range[]>([])
  const currentIndexRef = useRef(-1)
  currentIndexRef.current = currentIndex
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setOpen(false)
  }, [resetKey])

  useEffect(() => {
    if (!active) setOpen(false)
  }, [active])

  useEffect(() => {
    if (!active) return
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        setOpen(true)
        requestAnimationFrame(() => inputRef.current?.select())
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [active])

  useEffect(() => {
    if (open) return
    clearRegisteredHighlights()
    rangesRef.current = []
    setQuery('')
    setTotalMatches(0)
    setCurrentIndex(-1)
  }, [open])

  useEffect(() => {
    if (!open) return

    let observer: MutationObserver | null = null
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    let rafId: number | null = null

    const runHighlight = (container: HTMLElement) => {
      const ranges = findMatchRanges(container, query)
      rangesRef.current = ranges
      const prev = currentIndexRef.current
      const nextIndex =
        ranges.length === 0 ? -1 : prev < 0 ? 0 : Math.min(prev, ranges.length - 1)
      registerHighlights(ranges, nextIndex)
      setTotalMatches(ranges.length)
      setCurrentIndex(nextIndex)
    }

    const attach = () => {
      const container = getContainer()
      if (!container) {
        rafId = requestAnimationFrame(attach)
        return
      }
      runHighlight(container)
      observer = new MutationObserver(() => {
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => runHighlight(container), 150)
      })
      observer.observe(container, { childList: true, subtree: true, characterData: true })
    }

    attach()

    return () => {
      if (rafId != null) cancelAnimationFrame(rafId)
      if (debounceTimer) clearTimeout(debounceTimer)
      observer?.disconnect()
    }
  }, [open, query])

  // Repaint + scroll on current-index navigation
  useEffect(() => {
    if (!open) return
    registerHighlights(rangesRef.current, currentIndex)
    const container = getContainer()
    if (!container) return
    const range = rangesRef.current[currentIndex]
    if (range) scrollRangeIntoView(range, container)
  }, [open, currentIndex, totalMatches])

  const next = useCallback(() => {
    setCurrentIndex((i) => {
      const n = rangesRef.current.length
      return n === 0 ? -1 : (i + 1) % n
    })
  }, [])

  const prev = useCallback(() => {
    setCurrentIndex((i) => {
      const n = rangesRef.current.length
      if (n === 0) return -1
      return (i - 1 + n) % n
    })
  }, [])

  const close = useCallback(() => setOpen(false), [])

  return {
    open,
    query,
    setQuery,
    totalMatches,
    currentIndex,
    next,
    prev,
    close,
    inputRef,
  }
}
