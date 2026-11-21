import type { TeamsActivity } from './teams-activity'
import type { IntegrationMessageSource } from '../agent-integrations/message-display-schema'

const teamsOrigin = 'https://teams.microsoft.com'
const guid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i
const clientConversationId = /^19:[^\s/?#;]+$/
const messageId = /^[1-9]\d*$/
const chatContext = JSON.stringify({ contextType: 'chat' })

/** The web client addresses a chat by its 19: ID. The bot's a: ID only addresses the connector. */
export function teamsActivityLinks(activity: TeamsActivity, root?: string): { messageUrl?: string; conversationUrl?: string } {
  const scope = activity.conversation.conversationType
  const channel = scope === 'channel'
  const team = activity.channelData?.team
  const tenant = activity.channelData?.tenant?.id ?? activity.conversation.tenantId
  const query = new URLSearchParams()
  if (tenant && guid.test(tenant)) query.set('tenantId', tenant)
  const wireId = activity.conversation.id.split(';messageid=')[0]
  const candidates = channel
    ? [activity.channelData?.channel?.id, activity.channelData?.teamsChannelId, wireId]
    : [activity.channelData?.chat?.id, wireId]
  const clientId = candidates.find((id): id is string => !!id && clientConversationId.test(id))
  const bot = activity.recipient.id.replace(/^28:/i, '')
  if (!clientId) {
    if (scope !== 'personal' || !guid.test(bot)) return {}
    query.set('users', '28:' + bot)
    return { conversationUrl: teamsOrigin + '/l/chat/0/0?' + query }
  }

  const encoded = encodeURIComponent(clientId)
  let conversationUrl: string | undefined
  if (channel) {
    if (team?.aadGroupId && guid.test(team.aadGroupId)) query.set('groupId', team.aadGroupId)
    const name = activity.channelData?.channel?.name
    if (name && query.has('groupId')) conversationUrl = `${teamsOrigin}/l/channel/${encoded}/${encodeURIComponent(name)}?${query}`
    if (root && messageId.test(root)) query.set('parentMessageId', root)
  } else {
    conversationUrl = `${teamsOrigin}/l/chat/${encoded}/conversations?${query}`
    query.set('context', chatContext)
  }
  if (!activity.id || !messageId.test(activity.id)) return { conversationUrl }
  return { conversationUrl, messageUrl: `${teamsOrigin}/l/message/${encoded}/${activity.id}?${query}` }
}

/** Old cards may hold a bot-only conversation ID in an otherwise valid https URL. */
export function teamsCardLink(requestUrl: string | undefined, source: IntegrationMessageSource) {
  for (const value of [requestUrl, source.url]) {
    if (!value) continue
    try {
      const url = new URL(value)
      if (url.origin !== teamsOrigin || url.username || url.password) continue
      const [, l, kind, rawId, item] = url.pathname.split('/')
      if (l !== 'l' || !rawId || !item) continue
      const id = decodeURIComponent(rawId)
      if (kind === 'message' && clientConversationId.test(id) && messageId.test(item)) {
        if (source.kind === 'direct' || source.kind === 'group' ||
            (source.kind === 'thread' && /@(?:unq\.gbl\.spaces|thread\.v2)$/i.test(id))) {
          url.searchParams.delete('parentMessageId')
          url.searchParams.set('context', chatContext)
          return { href: url.href }
        }
        return { href: value }
      }
      if (kind === 'chat') {
        const bot = url.searchParams.get('users') ?? ''
        if ((id === '0' && item === '0' && bot.startsWith('28:') && guid.test(bot.slice(3))) ||
            (clientConversationId.test(id) && item === 'conversations')) return { href: value, chat: true }
      }
      if (kind === 'channel' && clientConversationId.test(id)) return { href: value }
    } catch { /* A malformed stored link can still have a usable source URL. */ }
  }
}
