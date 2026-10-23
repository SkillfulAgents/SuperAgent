/**
 * Who a message @-mentions. The composer writes `@Name` where each chip stood
 * and lists the mentions in a block after the text, so the agent knows who
 * each name is and how to reach them. The bubble draws the names back as
 * chips from the same block, and the server reads it to notify the teammates
 * it tags. Typed text cannot forge it: the composer escapes a typed `[`.
 */
export type Mention =
  | { kind: 'user'; id: string; name: string; email?: string }
  /** `slug` is the one the agents tools take: list_agents prints the display slug. */
  | { kind: 'agent'; slug: string; name: string }
  /**
   * A chat: `id` is its session id. With `agentSlug` it is another agent's chat,
   * read with the agents tools; without, one of this agent's, read from its history.
   */
  | { kind: 'chat'; id: string; name: string; agentSlug?: string }

const MARKER = '[Mentioned:]'
/** The agent can call a tagged agent directly, without searching for it first. */
const AGENT_HINT = '(call it by this slug with the agents tools, no need to list agents first)'
const SILENT_NOTE = '(This message only notifies the teammates it tags. It is not a request to you, so do not act on it.)'
const USER_LINE = /^- @(.+): teammate(?:, ([^\s()]+))? \(user id ([A-Za-z0-9_-]+)\)$/
const AGENT_LINE = /^- @(.+): agent, slug ([a-z0-9-]+)(?: \(.*\))?$/
const CHAT_LINE = /^- @(.+): chat in this agent, session id ([A-Za-z0-9_-]+)(?: \(.*\))?$/
const OTHER_CHAT_LINE = /^- @(.+): chat in agent ([a-z0-9-]+), session id ([A-Za-z0-9_-]+)(?: \(.*\))?$/

/** A name on one line: a line break would end its entry early. */
export function mentionName(name: string): string {
  return name.replace(/\s+/g, ' ').trim()
}

function formatLine(mention: Mention): string {
  const name = mentionName(mention.name)
  if (mention.kind === 'agent') return `- @${name}: agent, slug ${mention.slug} ${AGENT_HINT}`
  if (mention.kind === 'chat' && mention.agentSlug) return `- @${name}: chat in agent ${mention.agentSlug}, session id ${mention.id} (read it with get_agent_session_transcript)`
  if (mention.kind === 'chat') return `- @${name}: chat in this agent, session id ${mention.id} (read it with: python3 /opt/gamut/bin/read-session.py ${mention.id})`
  const email = mention.email && /^[^\s()]+$/.test(mention.email) ? `, ${mention.email}` : ''
  return `- @${name}: teammate${email} (user id ${mention.id})`
}

/**
 * Append the mentions block. A silent message (one that opens on a teammate)
 * only notifies them: the agent reads it with its next turn and is told it was
 * not addressed.
 */
export function appendMentions(message: string, mentions: readonly Mention[], { silent = false } = {}): string {
  if (mentions.length === 0) return message
  const block = [MARKER, ...mentions.map(formatLine), ...(silent ? [SILENT_NOTE] : [])].join('\n')
  return message ? `${message}\n\n${block}` : block
}

export interface ParsedMentions {
  /** The message text with the block removed. */
  cleanText: string
  mentions: Mention[]
  silent: boolean
}

const NO_MENTIONS = { mentions: [], silent: false }

/** Where the last marker line starts, after a blank line, or -1. */
function blockStart(text: string): number {
  const at = text.lastIndexOf(`\n\n${MARKER}\n`)
  if (at !== -1) return at + 2
  return text.startsWith(`${MARKER}\n`) ? 0 : -1
}

/**
 * Lift the mentions block off the end of message text. The composer writes it
 * last, so a block with anything after it (one quoted in a code block, say)
 * is part of the message.
 */
export function parseMentions(text: string): ParsedMentions {
  const start = blockStart(text)
  if (start === -1) return { cleanText: text, ...NO_MENTIONS }

  const mentions: Mention[] = []
  let silent = false
  const lines = text.slice(start + MARKER.length + 1).split('\n')
  let end = 0
  for (const line of lines) {
    const user = USER_LINE.exec(line)
    const agent = !user && AGENT_LINE.exec(line)
    const chat = !user && !agent && CHAT_LINE.exec(line)
    const otherChat = !user && !agent && !chat && OTHER_CHAT_LINE.exec(line)
    if (user) mentions.push({ kind: 'user', id: user[3], name: user[1], ...(user[2] ? { email: user[2] } : {}) })
    else if (agent) mentions.push({ kind: 'agent', slug: agent[2], name: agent[1] })
    else if (chat) mentions.push({ kind: 'chat', id: chat[2], name: chat[1] })
    else if (otherChat) mentions.push({ kind: 'chat', id: otherChat[3], name: otherChat[1], agentSlug: otherChat[2] })
    else if (line === SILENT_NOTE && mentions.length > 0) silent = true
    else break
    end++
  }
  if (mentions.length === 0 || lines.slice(end).join('\n').trim()) return { cleanText: text, ...NO_MENTIONS }
  return { cleanText: text.slice(0, start).trimEnd(), mentions, silent }
}
