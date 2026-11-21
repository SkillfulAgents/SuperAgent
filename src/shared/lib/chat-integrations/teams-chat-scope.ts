/** The scope in a stored Teams chat key is also readable by the inbox, without decoding provider IDs. */
export const TEAMS_CHAT_SCOPES = ['personal', 'groupChat', 'channel'] as const
export type TeamsScope = typeof TEAMS_CHAT_SCOPES[number]
const externalIdPattern = /^teams:(personal|groupChat|channel):[A-Za-z0-9_-]+(?:\|[A-Za-z0-9_-]+)?$/

export function teamsChatScope(chatId: string): TeamsScope | undefined {
  return externalIdPattern.exec(chatId)?.[1] as TeamsScope | undefined
}

export const TEAMS_SCOPE_LABEL: Record<TeamsScope, string> = {
  personal: 'Teams direct chat',
  groupChat: 'Teams group chat',
  channel: 'Teams channel',
}
