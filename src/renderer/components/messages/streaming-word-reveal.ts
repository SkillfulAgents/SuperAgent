/**
 * Rehype plugin that gives each prose token in a live Markdown tail its own
 * reveal hook. Existing spans keep their position as text is appended, so React
 * only mounts (and animates) the words that just arrived.
 *
 * Code-like elements are deliberately left alone: blurring individual tokens
 * makes code shimmer and can disturb its whitespace-sensitive presentation.
 * Text without a source position (nodes a plugin generated rather than parsed,
 * e.g. GFM footnote scaffolding) is also left alone — it has no offset to batch
 * by, and lumping it into batch 0 would retroactively shift that batch's delays.
 */

interface HastNode {
  type?: string
  tagName?: string
  value?: unknown
  properties?: Record<string, unknown>
  children?: unknown[]
  position?: {
    start?: { offset?: number }
  }
}

const STATIC_TEXT_ELEMENTS = new Set(['code', 'pre', 'kbd', 'samp'])
const WHITESPACE = /^\s+$/u
// Preserve a natural word cadence for small chunks, but compress large chunks
// into a short wave so the UI never falls noticeably behind the stream.
const MAX_WORD_STAGGER_MS = 36
const MAX_BATCH_WAVE_MS = 320

export interface StreamingWordRevealOptions {
  /** Source offsets where each received stream batch begins. */
  batchStarts?: readonly number[]
}

interface RevealSpan {
  node: HastNode
  batch: number
}

function isHastNode(value: unknown): value is HastNode {
  return typeof value === 'object' && value !== null
}

function batchForOffset(offset: number, batchStarts: readonly number[]): number {
  let low = 0
  let high = batchStarts.length - 1

  while (low <= high) {
    const middle = (low + high) >> 1
    if (batchStarts[middle] <= offset) low = middle + 1
    else high = middle - 1
  }

  return Math.max(0, high)
}

function revealedText(
  value: string,
  sourceStart: number,
  batchStarts: readonly number[],
  spans: RevealSpan[],
): HastNode[] {
  let relativeOffset = 0

  return value.split(/(\s+)/u).filter(Boolean).map((part) => {
    const partOffset = sourceStart + relativeOffset
    relativeOffset += part.length
    if (WHITESPACE.test(part)) return { type: 'text', value: part }

    const node: HastNode = {
      type: 'element',
      tagName: 'span',
      properties: { className: ['streaming-word-reveal'] },
      children: [{ type: 'text', value: part }],
    }

    spans.push({ node, batch: batchForOffset(partOffset, batchStarts) })
    return node
  })
}

function wrapTextChildren(
  node: HastNode,
  batchStarts: readonly number[],
  spans: RevealSpan[],
  insideStaticText = false,
): void {
  if (!Array.isArray(node.children)) return

  const keepStatic = insideStaticText || (node.tagName ? STATIC_TEXT_ELEMENTS.has(node.tagName) : false)
  const children: unknown[] = []

  for (const child of node.children) {
    if (!isHastNode(child)) {
      children.push(child)
      continue
    }

    const sourceStart = child.position?.start?.offset
    if (
      !keepStatic &&
      child.type === 'text' &&
      typeof child.value === 'string' &&
      typeof sourceStart === 'number'
    ) {
      children.push(...revealedText(child.value, sourceStart, batchStarts, spans))
      continue
    }

    wrapTextChildren(child, batchStarts, spans, keepStatic)
    children.push(child)
  }

  node.children = children
}

function applyBatchDelays(spans: RevealSpan[]): void {
  const totals = new Map<number, number>()
  const ordinals = new Map<number, number>()

  for (const span of spans) totals.set(span.batch, (totals.get(span.batch) ?? 0) + 1)

  for (const span of spans) {
    const total = totals.get(span.batch) ?? 1
    const ordinal = ordinals.get(span.batch) ?? 0
    const step = total > 1
      ? Math.min(MAX_WORD_STAGGER_MS, MAX_BATCH_WAVE_MS / (total - 1))
      : 0
    const delay = Math.round(ordinal * step)

    span.node.properties = {
      ...span.node.properties,
      style: `animation-delay: ${delay}ms`,
    }
    ordinals.set(span.batch, ordinal + 1)
  }
}

export function rehypeStreamingWordReveal(options: StreamingWordRevealOptions = {}) {
  return (tree: unknown) => {
    if (!isHastNode(tree)) return

    const batchStarts = options.batchStarts?.length ? options.batchStarts : [0]
    const spans: RevealSpan[] = []
    wrapTextChildren(tree, batchStarts, spans)
    applyBatchDelays(spans)
  }
}
