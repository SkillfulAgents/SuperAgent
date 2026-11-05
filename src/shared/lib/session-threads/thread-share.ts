/**
 * The message that loops the agent into a thread. Thread replies never reach
 * its transcript, so "Send thread to agent" puts the parent and every reply in
 * the session composer as one ordinary message, opened with who was talking,
 * for the person to edit and send.
 */

export interface SharedThreadEntry {
  name: string
  text: string
  /** Workspace paths it was sent with: the agent can open them. */
  files?: readonly string[]
}

/** "West", "West and Graham", "West, Graham and Iddo". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * One person's part: their name, then what they wrote and the files they sent.
 * Plain paragraphs, not a > quote: the composer keeps Enter inside a quote to
 * continue it, and this lands in the composer to be sent with Enter.
 */
function entry(heading: string, { text, files = [] }: SharedThreadEntry): string {
  const body = [...(text.trim() ? [text.trim()] : []), ...files.map((path) => `Attached: \`${path}\``)]
  return [heading, ...body].join('\n')
}

export function formatThreadForAgent(parent: SharedThreadEntry, replies: readonly SharedThreadEntry[]): string {
  const people = [...new Set([parent.name, ...replies.map((reply) => reply.name)])]
  const who = people.length > 1 ? `${joinNames(people)} were` : `${people[0]} was`
  const lines = [
    `${who} side-chatting in a thread in this session and want to loop you in. Here is the thread:`,
    entry(`**${parent.name}** (the message the thread is on):`, parent),
    ...replies.map((reply) => entry(`**${reply.name}:**`, reply)),
  ]
  return lines.join('\n\n')
}
