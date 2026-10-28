// In group/channel contexts connectors prefix an incoming message with an escaped
// "\[sender]: " (e.g. Telegram/Slack) so the agent can attribute who spoke; the app
// does the same for messages sent to an agent with several members. The bubble
// lifts that prefix off instead of showing it inline. DMs are never prefixed.
//
// We require the leading backslash the connector always writes: a user's own text
// that happens to start "[TODO]: buy milk" is not a connector prefix, and stripping
// it would mislabel the sender and mangle the body. (Pre-escape legacy group
// transcripts carried an unescaped "[sender]: "; those now render the prefix inline
// rather than lifted - cosmetic only, and no worse than mis-lifting real user text.)
const SENDER_PREFIX = /^\\\[([^\]]+)\]:\s*/

/**
 * The attribution prefix written in front of a message the agent receives. A `]`
 * or line break in the name would end the prefix early, so each becomes a space.
 * A name with nothing left gets no prefix: an empty `\[]: ` would not parse back off.
 */
export function formatSenderPrefix(sender: string): string {
  const name = sender.replace(/[\]\r\n]/g, ' ').trim()
  return name ? `\\[${name}]: ` : ''
}

/**
 * Split a leading escaped "\[sender]: " prefix off message text. Returns the sender
 * (null when there's no prefix) and the text with the prefix removed. Only an escaped
 * prefix at the very start counts - unescaped brackets, and bracketed spans mid-text,
 * are left untouched (they're user content, not a connector-written attribution).
 */
export function parseSenderPrefix(text: string): { sender: string | null; cleanText: string } {
  const match = text.match(SENDER_PREFIX)
  if (!match) return { sender: null, cleanText: text }
  return { sender: match[1], cleanText: text.slice(match[0].length) }
}
