import type { Element, ElementContent, Root, RootContent } from 'hast'
import type { Mention } from '@shared/lib/utils/mentions'

/** The element a mention becomes; agent-markdown draws it as a MentionChip. */
export const MENTION_TAG = 'mention-chip'

// Code shows what was typed, and a link's text is its own.
const SKIPPED_TAGS = new Set(['code', 'pre', 'a'])

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Rehype plugin: each `@Name` of a mention the message lists becomes a
 * `mention-chip` element carrying that mention, so a sent bubble draws the
 * chips its composer did. Longer names win, so `@Ann Lee` is not read as `@Ann`.
 */
export function rehypeMentions(options: { mentions: readonly Mention[]; agentSlug?: string }) {
  const byName = new Map(options.mentions.map((mention) => [mention.name, mention]))
  const names = [...byName.keys()].sort((a, b) => b.length - a.length)
  const pattern = names.length > 0 ? new RegExp(`@(${names.map(escapeRegExp).join('|')})`, 'g') : null

  const split = (value: string): ElementContent[] => {
    const parts: ElementContent[] = []
    let last = 0
    for (const match of value.matchAll(pattern!)) {
      if (match.index > last) parts.push({ type: 'text', value: value.slice(last, match.index) })
      parts.push({
        type: 'element',
        tagName: MENTION_TAG,
        properties: { dataMention: JSON.stringify(byName.get(match[1])), dataAgentSlug: options.agentSlug },
        children: [{ type: 'text', value: match[0] }],
      })
      last = match.index + match[0].length
    }
    if (last < value.length) parts.push({ type: 'text', value: value.slice(last) })
    return parts
  }

  const walk = (node: Root | Element) => {
    node.children = node.children.flatMap((child: RootContent): RootContent[] => {
      if (child.type === 'element') {
        if (!SKIPPED_TAGS.has(child.tagName)) walk(child)
        return [child]
      }
      return child.type === 'text' ? split(child.value) : [child]
    }) as Element['children']
  }

  return (tree: Root) => {
    if (pattern) walk(tree)
  }
}

/** The mention a `mention-chip` element carries. */
export function mentionOf(node: Element | undefined): { mention: Mention; agentSlug?: string } | null {
  const raw = node?.properties.dataMention
  if (typeof raw !== 'string') return null
  try {
    const agentSlug = node!.properties.dataAgentSlug
    return { mention: JSON.parse(raw) as Mention, agentSlug: typeof agentSlug === 'string' ? agentSlug : undefined }
  } catch {
    return null
  }
}
