import type { ConversationCarryOver } from '@shared/lib/agent-actor/local-transcript-ops'

/** System-prompt context for a chat session that replaces an earlier one; null when there is nothing to carry. */
export function carryOverPrompt(carry: ConversationCarryOver): string | null {
  if (!carry.summary && carry.recent.length === 0) return null
  const parts = [
    '<previous_conversation>',
    'This chat continues an earlier conversation with the same person. Use it as background for the new message.',
  ]
  if (carry.summary) parts.push('<summary>', carry.summary, '</summary>')
  if (carry.recent.length > 0) {
    parts.push('<last_messages>')
    for (const turn of carry.recent) parts.push(`${turn.role === 'user' ? 'User' : 'You'}: ${turn.text}`)
    parts.push('</last_messages>')
  }
  parts.push('</previous_conversation>')
  return parts.join('\n')
}
