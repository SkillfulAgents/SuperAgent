import type { ReactNode } from 'react'
import { safeHref } from './markdown-url-transform'

// Agents write prose, not markdown, into request-card titles, so a URL there
// arrives bare. Match the schemes the renderer is willing to link at all — the
// rest of the policy (blanking javascript:/file:/data:) stays in safeHref, so
// this regex decides *where a URL starts*, never *whether it is safe*.
//
// Today the two agree, so the safeHref call below cannot reject anything this
// regex produces. It is kept as the structural gate anyway: widening the scheme
// list here must not be able to widen what gets linked without going through the
// one policy the markdown renderer also obeys.
//
// The body stops at whitespace and at the characters prose wraps a URL in —
// <https://x>, "https://x", `https://x` — none of which are legal raw in a URL.
// A single quote is deliberately still allowed: it is a legal sub-delim that
// ?$filter=eq(name,'J') needs.
const URL_CANDIDATE = /(?:https?:\/\/|(?:mailto|tel|sms):)[^\s<>"`]+/gi

function countOf(text: string, ch: string): number {
  let n = 0
  for (const c of text) if (c === ch) n++
  return n
}

/**
 * Drop the prose punctuation a URL collected on its right edge.
 *
 * Sentence punctuation always goes. A bracket goes only when it is unbalanced,
 * so https://en.wikipedia.org/wiki/Foo_(bar) survives whole while the stray ")"
 * in "(see https://example.com/a)" is handed back to the prose.
 */
function trimTrailingPunctuation(url: string): string {
  let end = url.length
  while (end > 0) {
    const ch = url[end - 1]
    if ('.,;:!?'.includes(ch)) {
      end--
      continue
    }
    const kept = url.slice(0, end)
    const isProse =
      ch === ')' ? countOf(kept, '(') < countOf(kept, ')')
      : ch === ']' ? countOf(kept, '[') < countOf(kept, ']')
      : false
    if (!isProse) break
    end--
  }
  return url.slice(0, end)
}

/**
 * Turn bare URLs in plain agent prose into anchors, leaving every other
 * character untouched.
 *
 * Returns the input string unchanged when it holds no linkable URL, so callers
 * that render prose without URLs produce byte-identical DOM to before.
 *
 * Deliberately not markdown: these strings are shown in compact cards where
 * emphasis, headings and tables would be noise, and where markdown's collapsing
 * of single newlines would drop line breaks `whitespace-pre-line` preserves.
 * Anchor attributes match the markdown renderer's (message-item.tsx) so both
 * reach the Electron shell opener through setWindowOpenHandler.
 */
export function linkify(text: string): ReactNode {
  const nodes: ReactNode[] = []
  let lastIndex = 0
  let key = 0

  for (const match of text.matchAll(URL_CANDIDATE)) {
    const raw = match[0]
    const index = match.index
    const candidate = trimTrailingPunctuation(raw)
    const href = safeHref(candidate)
    if (!href) continue

    if (index > lastIndex) nodes.push(text.slice(lastIndex, index))
    nodes.push(
      <a
        key={key++}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="hover:underline text-blue-500"
      >
        {candidate}
      </a>
    )
    lastIndex = index + candidate.length
  }

  if (nodes.length === 0) return text
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex))
  return nodes
}
