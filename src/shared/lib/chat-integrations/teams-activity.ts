import { z } from 'zod'
import type { IncomingMessage } from './chat-agent-integration'
import { teamsActivityLinks } from './teams-deep-links'
import { isTeamsFileUrl, isTeamsInlineImageUrl } from './teams-files'
import { TEAMS_CHAT_SCOPES, teamsChatScope, type TeamsScope } from './teams-chat-scope'
export { teamsChatScope, type TeamsScope } from './teams-chat-scope'

const id = z.string().min(1).max(2048)
const account = z.object({ id, name: z.string().optional(), aadObjectId: z.string().uuid().optional() })
const scope = z.enum(TEAMS_CHAT_SCOPES)
export const teamsActivitySchema = z.object({
  type: z.string(), id: id.optional(), action: z.string().optional(), name: z.string().optional(),
  channelId: z.literal('msteams'), serviceUrl: z.string().url(), timestamp: z.union([z.string(), z.date()]).optional(),
  from: account, recipient: account, replyToId: id.optional(), text: z.string().optional(),
  conversation: z.object({ id, conversationType: scope, tenantId: id.optional(), name: z.string().optional() }),
  channelData: z.object({
    tenant: z.object({ id }).optional(), team: z.object({ id: id.optional(), name: z.string().optional(), aadGroupId: z.string().optional().catch(undefined) }).optional(),
    channel: z.object({ id, name: z.string().optional() }).optional(), chat: z.object({ id }).optional(),
    teamsChannelId: id.optional(), teamsTeamId: id.optional(), eventType: z.string().optional(), replyChain: z.object({ id }).optional(),
  }).optional(),
  entities: z.array(z.object({
    type: z.string(), text: z.string().optional(), mentioned: z.object({ id }).optional(),
  })).optional(),
  attachments: z.array(z.object({ name: z.string().optional(), contentType: z.string(), content: z.unknown().optional(), contentUrl: z.string().optional() })).optional(),
  membersRemoved: z.array(account).optional(), value: z.unknown().optional(),
})
export type TeamsActivity = z.infer<typeof teamsActivitySchema>
const encode = (value: string) => Buffer.from(value, 'utf8').toString('base64url')
export function teamsExternalId(scope: TeamsScope, conversationId: string, threadRoot?: string): string {
  return `teams:${scope}:${encode(conversationId)}${threadRoot ? '|' + encode(threadRoot) : ''}`
}
export function teamsParentChatId(chatId: string): string | undefined {
  return teamsChatScope(chatId) && chatId.includes('|') ? chatId.split('|')[0] : undefined
}
export function teamsScopeId(a: TeamsActivity): string {
  return a.channelData?.channel?.id || a.channelData?.teamsChannelId || a.channelData?.chat?.id || a.conversation.id.split(';messageid=')[0]
}
export function teamsThreadRoot(a: TeamsActivity): string | undefined {
  const chain = a.channelData?.replyChain?.id
  if (a.conversation.conversationType === 'channel') return chain || a.conversation.id.split(';messageid=')[1] || a.replyToId || a.id
  return chain && chain !== a.id ? chain : undefined
}
export function sameTeamsApp(a: string, b: string): boolean {
  return a.replace(/^28:/i, '').toLowerCase() === b.replace(/^28:/i, '').toLowerCase()
}
export function matchesTeamsInstallation(a: TeamsActivity, tenantId: string, appId: string): boolean {
  const tenants = [a.channelData?.tenant?.id, a.conversation.tenantId].filter((t): t is string => !!t)
  return tenants.length > 0 && tenants.every(t => t.toLowerCase() === tenantId.toLowerCase()) && sameTeamsApp(a.recipient.id, appId)
}

export function teamsIncomingMessage(a: TeamsActivity): IncomingMessage | undefined {
  if (a.type !== 'message' || !a.id || !a.from.aadObjectId || sameTeamsApp(a.from.id, a.recipient.id)) return
  const scopeType = a.conversation.conversationType
  const ownMentions = a.entities?.filter(e => e.type.toLowerCase() === 'mention' && e.mentioned && sameTeamsApp(e.mentioned.id, a.recipient.id)) ?? []
  if (scopeType !== 'personal' && !ownMentions.length) return
  let text = a.text ?? ''
  for (const mention of ownMentions) if (mention.text) text = text.replaceAll(mention.text, '')
  text = text.replace(/<at>([^<]*)<\/at>/gi, '@$1').trim()
  const files: NonNullable<IncomingMessage['files']> = []
  for (const attachment of a.attachments ?? []) {
    if (attachment.contentType.startsWith('image/') && attachment.contentUrl && isTeamsInlineImageUrl(attachment.contentUrl)) {
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[attachment.contentType]
      if (ext) files.push({ name: attachment.name || `image-${files.length + 1}.${ext}`, url: attachment.contentUrl, mimeType: attachment.contentType })
    }
    if (scopeType !== 'personal' || attachment.contentType !== 'application/vnd.microsoft.teams.file.download.info' || !attachment.name) continue
    const content = z.object({ downloadUrl: z.string() }).safeParse(attachment.content)
    if (content.success && isTeamsFileUrl(content.data.downloadUrl)) files.push({ name: attachment.name, url: content.data.downloadUrl })
  }
  if (!text && !files.length) return
  const scopeId = teamsScopeId(a)
  const root = teamsThreadRoot(a)
  const timestamp = a.timestamp instanceof Date ? a.timestamp : a.timestamp ? new Date(a.timestamp) : new Date()
  if (Number.isNaN(timestamp.getTime())) return
  const sender = a.from.name?.trim() || undefined
  const conversationName = a.conversation.name?.trim() || undefined
  const chatName = scopeType === 'personal' ? sender || conversationName :
    a.channelData?.channel?.name?.trim() || conversationName
  return {
    chatId: teamsExternalId(scopeType, scopeId, root), userId: a.from.aadObjectId.toLowerCase(), userName: sender, chatName,
    chatType: scopeType === 'personal' ? 'private' : 'group',
    externalMessageId: a.id, timestamp, text, ...(files.length ? { files } : {}),
    display: { ...teamsActivityLinks(a, root), workspace: a.channelData?.team?.name },
  }
}
