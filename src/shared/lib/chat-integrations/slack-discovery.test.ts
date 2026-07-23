/**
 * Slack directory discovery tests.
 *
 * The discovery primitives exist so an agent can reach a person or channel it
 * has never talked to (instead of guessing a target from its session list and
 * misrouting DMs). Covers chat-id classification, the capped/paginated
 * users/channels listings, and DM resolution via conversations.open.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SlackConnector, classifySlackChatId } from './slack-connector'
import { TelegramConnector } from './telegram-connector'
import { IMessageConnector } from './imessage-connector'

// ── Chat id classification ─────────────────────────────────────────────

describe('classifySlackChatId', () => {
  it('classifies by conversation-id prefix', () => {
    expect(classifySlackChatId('D0AAA111')).toBe('dm')
    expect(classifySlackChatId('C0BBB222')).toBe('channel')
    expect(classifySlackChatId('G0CCC333')).toBe('group')
  })

  it('classifies composite thread ids as threads regardless of prefix', () => {
    expect(classifySlackChatId('C0BBB222|1784571878.344849')).toBe('thread')
    expect(classifySlackChatId('G0CCC333|1784571878.344849')).toBe('thread')
  })

  it('returns undefined for unrecognized shapes', () => {
    expect(classifySlackChatId('U0DDD444')).toBeUndefined()
    expect(classifySlackChatId('')).toBeUndefined()
  })
})

// ── Capability statics ─────────────────────────────────────────────────

describe('discovery capability statics', () => {
  it('slack advertises all three discovery capabilities', () => {
    expect(SlackConnector.discoveryCapabilities).toEqual(['list_users', 'list_channels', 'dm_by_user_id'])
    expect(SlackConnector.classifyChatId).toBe(classifySlackChatId)
  })

  it('telegram and imessage advertise none (graceful degradation)', () => {
    expect(TelegramConnector.discoveryCapabilities).toBeUndefined()
    expect(IMessageConnector.discoveryCapabilities).toBeUndefined()
    expect(TelegramConnector.prototype.listChatUsers).toBeUndefined()
    expect(IMessageConnector.prototype.resolveDirectChat).toBeUndefined()
  })
})

// ── Directory listings ─────────────────────────────────────────────────

describe('SlackConnector directory discovery', () => {
  let connector: SlackConnector
  let mockUsersList: ReturnType<typeof vi.fn>
  let mockConversationsList: ReturnType<typeof vi.fn>
  let mockConversationsOpen: ReturnType<typeof vi.fn>

  beforeEach(() => {
    connector = new SlackConnector({ botToken: 'xoxb-fake', appToken: 'xapp-fake' })
    mockUsersList = vi.fn()
    mockConversationsList = vi.fn()
    mockConversationsOpen = vi.fn()
    ;(connector as any).app = {
      client: {
        users: { list: mockUsersList },
        conversations: { list: mockConversationsList, open: mockConversationsOpen },
      },
    }
  })

  it('listChatUsers returns people only: filters deleted accounts, bots, and Slackbot', async () => {
    mockUsersList.mockResolvedValue({
      ok: true,
      members: [
        { id: 'U001', name: 'mike', real_name: 'Mike Reid', profile: { real_name: 'Mike Reid', title: 'Office Manager' } },
        { id: 'U002', name: 'gone', deleted: true },
        { id: 'U003', name: 'botuser', is_bot: true },
        { id: 'USLACKBOT', name: 'slackbot' },
        { id: 'U004', name: 'iddo' },
      ],
    })

    const page = await connector.listChatUsers()

    expect(page.truncated).toBe(false)
    expect(page.items).toEqual([
      { id: 'U001', name: 'Mike Reid', title: 'Office Manager' },
      { id: 'U004', name: 'iddo' },
    ])
  })

  it('listChatUsers follows pagination cursors across pages', async () => {
    mockUsersList
      .mockResolvedValueOnce({
        ok: true,
        members: [{ id: 'U001', name: 'one' }],
        response_metadata: { next_cursor: 'cursor-2' },
      })
      .mockResolvedValueOnce({
        ok: true,
        members: [{ id: 'U002', name: 'two' }],
        response_metadata: { next_cursor: '' },
      })

    const page = await connector.listChatUsers()

    expect(mockUsersList).toHaveBeenCalledTimes(2)
    expect(mockUsersList.mock.calls[1][0]).toMatchObject({ cursor: 'cursor-2' })
    expect(page.items.map((u) => u.id)).toEqual(['U001', 'U002'])
  })

  it('listChatUsers caps the listing, flags truncation, and stops paging', async () => {
    const members = Array.from({ length: 501 }, (_, n) => ({ id: `U${n}`, name: `user-${n}` }))
    mockUsersList.mockResolvedValue({
      ok: true,
      members,
      response_metadata: { next_cursor: 'cursor-more' },
    })

    const page = await connector.listChatUsers()

    expect(page.items).toHaveLength(500)
    expect(page.truncated).toBe(true)
    // Once capped there is nothing more to fetch — the extra cursor is ignored
    expect(mockUsersList).toHaveBeenCalledTimes(1)
  })

  it('listChatChannels maps names with # and carries privacy/membership flags', async () => {
    mockConversationsList.mockResolvedValue({
      ok: true,
      channels: [
        { id: 'C001', name: 'office', is_private: false, is_member: true },
        { id: 'C002', name: 'leadership', is_private: true, is_member: false },
        { id: 'C003' }, // no name — skipped
      ],
    })

    const page = await connector.listChatChannels()

    expect(page.truncated).toBe(false)
    expect(page.items).toEqual([
      { id: 'C001', name: '#office', isPrivate: false, isMember: true },
      { id: 'C002', name: '#leadership', isPrivate: true, isMember: false },
    ])
    expect(mockConversationsList).toHaveBeenCalledWith(expect.objectContaining({
      exclude_archived: true,
      types: 'public_channel,private_channel',
    }))
  })

  it('resolveDirectChat returns the opened 1:1 channel id', async () => {
    mockConversationsOpen.mockResolvedValue({ ok: true, channel: { id: 'D0BHN1ST84X' } })

    await expect(connector.resolveDirectChat('U001')).resolves.toBe('D0BHN1ST84X')
    expect(mockConversationsOpen).toHaveBeenCalledWith({ users: 'U001' })
  })

  it('resolveDirectChat throws when Slack returns no channel', async () => {
    mockConversationsOpen.mockResolvedValue({ ok: true })

    await expect(connector.resolveDirectChat('U001')).rejects.toThrow(/did not return a DM channel/)
  })

  it('directory methods require a connected app', async () => {
    const cold = new SlackConnector({ botToken: 'xoxb-fake', appToken: 'xapp-fake' })
    await expect(cold.listChatUsers()).rejects.toThrow('Slack app not connected')
    await expect(cold.listChatChannels()).rejects.toThrow('Slack app not connected')
    await expect(cold.resolveDirectChat('U001')).rejects.toThrow('Slack app not connected')
  })
})
