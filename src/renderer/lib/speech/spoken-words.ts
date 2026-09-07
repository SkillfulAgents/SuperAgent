/**
 * The bridge between a Markdown message and its spoken form.
 *
 * Text-to-speech needs plain prose (no fences, no image alt text, no raw
 * HTML), and the highlight that follows playback needs to know which rendered
 * word is which spoken word. Both are answered by ONE walk over the message's
 * HAST tree: `collectSpokenWords` gathers the prose words in document order,
 * and `rehypeSpokenWords` wraps those same words in indexed spans. Because the
 * two share the walker, the i-th span on screen is always the i-th word sent
 * to the synthesizer — no alignment heuristics.
 */

import type { Element, Parent, Root, RootContent, Text } from 'hast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'

export interface SpokenWord {
  text: string
  /** True when this word closes a block (paragraph, list item, heading, …). */
  blockEnd: boolean
}

/** Elements whose text is never spoken (and never wrapped). */
const SILENT_ELEMENTS = new Set(['pre', 'script', 'style', 'svg', 'img', 'video', 'audio'])

/** Elements whose end is a natural pause — the synthesizer gets a fresh batch after them. */
const BLOCK_ELEMENTS = new Set([
  'p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'tr', 'hr', 'br',
  'div', 'section', 'details', 'summary', 'dt', 'dd', 'figcaption',
])

const WHITESPACE = /^\s+$/u

interface WalkState {
  words: SpokenWord[]
  /** When set, text nodes are replaced by indexed spans (the rehype plugin). */
  wrap: boolean
  /**
   * Whether a word boundary separates the next text from the last word. False
   * right after a word: text that follows with no whitespace in between
   * (`**bold**,` or `` `code`. ``) is the same spoken word, split only by
   * inline markup.
   */
  gap: boolean
}

function wordSpan(text: string, index: number): Element {
  return {
    type: 'element',
    tagName: 'span',
    properties: { dataSpokenWord: index },
    children: [{ type: 'text', value: text }],
  }
}

function walkText(node: Text, state: WalkState): RootContent[] {
  const out: RootContent[] = []
  for (const part of node.value.split(/(\s+)/u)) {
    if (!part) continue
    if (WHITESPACE.test(part)) {
      state.gap = true
      out.push({ type: 'text', value: part })
      continue
    }
    let index = state.words.length
    if (!state.gap && index > 0) {
      // Continuation of the previous word across an inline element boundary.
      index -= 1
      state.words[index].text += part
    } else {
      state.words.push({ text: part, blockEnd: false })
    }
    state.gap = false
    out.push(state.wrap ? wordSpan(part, index) : { type: 'text', value: part })
  }
  return out
}

function walk(node: Parent, state: WalkState): void {
  const children: RootContent[] = []
  for (const child of node.children) {
    if (child.type === 'text') {
      children.push(...walkText(child, state))
      continue
    }
    if (child.type === 'element') {
      if (SILENT_ELEMENTS.has(child.tagName)) {
        state.gap = true
        children.push(child)
        continue
      }
      walk(child, state)
      if (BLOCK_ELEMENTS.has(child.tagName)) {
        if (state.words.length > 0) state.words[state.words.length - 1].blockEnd = true
        state.gap = true
      }
      children.push(child)
      continue
    }
    // raw HTML, comments, doctypes: kept for the renderer, never spoken
    state.gap = true
    children.push(child)
  }
  if (state.wrap) node.children = children
}

/** Prose words of a HAST tree in document order. */
export function collectSpokenWords(tree: Root): SpokenWord[] {
  const state: WalkState = { words: [], wrap: false, gap: true }
  walk(tree, state)
  return state.words
}

/**
 * Rehype plugin: wrap each spoken word in `<span data-spoken-word={i}>` so the
 * playback highlight can address it. Indices match `collectSpokenWords` /
 * `markdownToSpokenWords` on the same Markdown. A word split by inline markup
 * (`**bold**,`) yields several spans sharing one index.
 */
export function rehypeSpokenWords() {
  return (tree: Root) => {
    walk(tree, { words: [], wrap: true, gap: true })
  }
}

// Mirrors react-markdown's pipeline (remark-parse → GFM → remark-rehype with
// raw HTML kept as `raw` nodes) so the tree walked here is the tree rendered.
const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype, { allowDangerousHtml: true })

/** Spoken words of a Markdown message, in the order the renderer shows them. */
export function markdownToSpokenWords(markdown: string): SpokenWord[] {
  const tree = processor.runSync(processor.parse(markdown)) as Root
  return collectSpokenWords(tree)
}
