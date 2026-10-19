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

const MARKER = '[Mentioned:]'
/** The agent can call a tagged agent directly, without searching for it first. */
const AGENT_HINT = '(call it by this slug with the agents tools, no need to list agents first)'
const SILENT_NOTE = '(This message only notifies the teammates it tags. It is not a request to you, so do not act on it.)'
const USER_LINE = /^- @(.+): teammate(?:, ([^\s()]+))? \(user id ([A-Za-z0-9_-]+)\)$/
const AGENT_LINE = /^- @(.+): agent, slug ([a-z0-9-]+)(?: \(.*\))?$/

/** A name on one line: a line break would end its entry early. */
export function mentionName(name: string): string {
  return name.replace(/\s+/g, ' ').trim()
}

function formatLine(mention: Mention): string {
  const name = mentionName(mention.name)
  if (mention.kind === 'agent') return `- @${name}: agent, slug ${mention.slug} ${AGENT_HINT}`
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

/** Where the block's marker line starts, or -1. */
function blockStart(text: string): number {
  if (text.startsWith(`${MARKER}\n`)) return 0
  const at = text.indexOf(`\n${MARKER}\n`)
  return at === -1 ? -1 : at + 1
}

/** Lift the mentions block out of message text, wherever the app's other blocks put it. */
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
    if (user) mentions.push({ kind: 'user', id: user[3], name: user[1], ...(user[2] ? { email: user[2] } : {}) })
    else if (agent) mentions.push({ kind: 'agent', slug: agent[2], name: agent[1] })
    else if (line === SILENT_NOTE && mentions.length > 0) silent = true
    else break
    end++
  }
  if (mentions.length === 0) return { cleanText: text, ...NO_MENTIONS }

  const before = text.slice(0, start).trimEnd()
  const after = lines.slice(end).join('\n').trim()
  return { cleanText: [before, after].filter(Boolean).join('\n\n'), mentions, silent }
}
