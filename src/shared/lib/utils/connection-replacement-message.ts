import { SYSTEM_MESSAGE_PREFIX } from './system-message'

export interface ConnectionReplacementNotice {
  kind: 'connected-accounts' | 'remote-mcps'
  name: string
  previousId: string
  replacementId: string
}

const PREFIX = `${SYSTEM_MESSAGE_PREFIX}Connection to `

/** Shared with the transcript renderer, including messages already on disk. */
export function buildConnectionReplacementMessage(change: ConnectionReplacementNotice): string {
  const reference = change.kind === 'connected-accounts' ? 'account' : 'MCP'
  const instructions = change.kind === 'connected-accounts'
    ? 'Update scripts, cached account IDs, and proxy URLs that reference the previous account ID.'
    : 'Use the replacement MCP tools now available. Update scripts, cached MCP IDs, and tool references that use the previous connection.'
  return `${PREFIX}${JSON.stringify(change.name)} was replaced. Previous ${reference} ID: ${change.previousId}. New ${reference} ID: ${change.replacementId}. ${instructions} Continue the user’s task with the new connection and its access permissions. Before retrying an interrupted write, check whether it already completed.`
}

export function parseConnectionReplacementMessage(text: string): ConnectionReplacementNotice | null {
  if (!text.startsWith(PREFIX)) return null
  // Names are JSON strings (including escaped quotes); both ID labels must
  // name the same connection type. Unrelated system messages remain hidden.
  const match = /^("(?:[^"\\]|\\.)*") was replaced\. Previous (account|MCP) ID: (\S+)\. New \2 ID: (\S+)\.(?:\s|$)/.exec(text.slice(PREFIX.length))
  if (!match) return null
  try {
    const name: unknown = JSON.parse(match[1])
    if (typeof name !== 'string' || !name.trim()) return null
    return {
      kind: match[2] === 'account' ? 'connected-accounts' : 'remote-mcps',
      name,
      previousId: match[3],
      replacementId: match[4],
    }
  } catch {
    return null
  }
}
