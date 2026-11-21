import { describe, expect, it } from 'vitest'
import { teamsActivitySchema, teamsIncomingMessage } from './teams-activity'

const tenant = '43d49dd5-750f-48a5-9a8e-5cecc581d6ef'
const app = '46e47d11-43c3-4154-a728-5d3526930a00'
const group = '5dbca410-9512-4671-9f3b-39ec6e3d4b7c'
const user = '7ad83929-114b-4fe9-87b6-ac19665afd27'
const clientChat = `19:${user}_${app}@unq.gbl.spaces`
const clientChannel = '19:8d5c018dd5c847c89f06dcaf49e8796f@thread.tacv2'
const bot = { id: '28:' + app, name: 'Agent' }
const originalId = '1795203201000'
const replyId = '1795203201200'
const personal = {
  type: 'message', id: originalId, channelId: 'msteams', serviceUrl: 'https://smba.trafficmanager.net/amer/',
  conversation: { id: 'a:connector-only', conversationType: 'personal', tenantId: tenant },
  from: { id: '29:member', aadObjectId: user }, recipient: bot, text: '<at>Agent</at> Hello',
  entities: [{ type: 'mention', mentioned: bot, text: '<at>Agent</at>' }],
}
const hints = (extra = {}) => teamsIncomingMessage(teamsActivitySchema.parse({ ...personal, ...extra }))!.display!

describe('Teams client deep links', () => {
  it('opens the installed bot in its tenant when the personal activity has only an opaque Bot Connector ID', () => {
    const display = hints()
    expect(display.messageUrl).toBeUndefined()
    const chat = new URL(display.conversationUrl!)
    expect(chat.origin + chat.pathname).toBe('https://teams.microsoft.com/l/chat/0/0')
    expect(chat.searchParams.get('users')).toBe('28:' + app)
    expect(chat.searchParams.get('tenantId')).toBe(tenant)
    expect(chat.searchParams.has('message')).toBe(false)
  })

  it('uses the client chat ID from channelData and contextType=chat for an exact personal thread reply', () => {
    const display = hints({ id: replyId, channelData: { chat: { id: clientChat }, replyChain: { id: originalId } } })
    const link = new URL(display.messageUrl!)
    expect(decodeURIComponent(link.pathname)).toBe(`/l/message/${clientChat}/${replyId}`)
    expect(link.searchParams.get('context')).toBe('{"contextType":"chat"}')
    expect(link.searchParams.has('parentMessageId')).toBe(false)
    expect(decodeURIComponent(new URL(display.conversationUrl!).pathname)).toBe(`/l/chat/${clientChat}/conversations`)
  })

  it('uses the public wire conversation ID for group chats and omits an unreachable group link', () => {
    const id = '19:group@thread.v2'
    const scope = { ...personal.conversation, conversationType: 'groupChat' }
    const display = hints({ conversation: { ...scope, id }, channelData: { chat: { id: 'a:connector' } } })
    const link = new URL(display.messageUrl!)
    expect(decodeURIComponent(link.pathname)).toBe(`/l/message/${id}/${originalId}`)
    expect(link.searchParams.get('context')).toBe('{"contextType":"chat"}')
    const unknown = hints({ conversation: { ...scope, id: 'a:opaque' } })
    expect(unknown.messageUrl).toBeUndefined()
    expect(unknown.conversationUrl).toBeUndefined()
  })

  it('offers the known conversation for a connector activity without a client message ID', () => {
    const display = hints({ id: 'f:opaque', channelData: { chat: { id: clientChat } } })
    expect(display.messageUrl).toBeUndefined()
    expect(decodeURIComponent(new URL(display.conversationUrl!).pathname)).toBe(`/l/chat/${clientChat}/conversations`)
  })

  it.each([originalId, replyId])('links the original channel thread and its precise target message %s', id => {
    const display = hints({ id,
      conversation: { ...personal.conversation, conversationType: 'channel', id: clientChannel + ';messageid=' + originalId },
      channelData: { channel: { id: clientChannel, name: 'Field Support' }, team: { id: '19:team@thread.tacv2', aadGroupId: group } },
    })
    const link = new URL(display.messageUrl!)
    expect(decodeURIComponent(link.pathname)).toBe(`/l/message/${clientChannel}/${id}`)
    expect(link.searchParams.get('parentMessageId')).toBe(originalId)
    expect(link.searchParams.get('tenantId')).toBe(tenant)
    expect(link.searchParams.get('groupId')).toBe(group)
    expect(link.searchParams.has('context')).toBe(false)
    expect(decodeURIComponent(new URL(display.conversationUrl!).pathname)).toBe(`/l/channel/${clientChannel}/Field Support`)
  })
})
