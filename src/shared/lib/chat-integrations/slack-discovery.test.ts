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
import { AgentIntegrationRegistry, THREADS_PER_CHANNEL } from '../agent-integrations/registry'
import type { AgentIntegrationRecord } from '../agent-integrations/types'
import { chatProviders } from './providers'

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
    expect(SlackConnector.classifyChatId?.({ chatId: 'D0AAA111' })).toBe(classifySlackChatId('D0AAA111'))
    expect(SlackConnector.classifyChatId?.({ chatId: 'C0BBB222|1.2' })).toBe(classifySlackChatId('C0BBB222|1.2'))
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

describe('Slack threads fold into their channel', () => {
  const registry = new AgentIntegrationRegistry(chatProviders)
  const now = Date.now()
  const slack = (): AgentIntegrationRecord => ({
    id: 'int-1', agentSlug: 'a', provider: 'slack', name: null, status: 'active', config: '{}',
    errorMessage: null, createdByUserId: null, model: null, llmProviderId: null, effort: null, speed: null, createdAt: new Date(now), version: 0, updatedAt: new Date(now),
  })
  const at = (externalChatId: string, displayName: string | null, hoursAgo = 0) => {
    const time = new Date(now - hoursAgo * 60 * 60 * 1000)
    return { externalChatId, displayName, updatedAt: time, createdAt: time }
  }

  it('lists a channel\'s threads under it, newest first, any age', async () => {
    const sessions = [at('C0DEALS|2.0', '#deals — b', 3), at('C0DEALS|1.0', '#deals — old', 300), at('C0DEALS|3.0', '#deals — c', 1)]
    const [deals] = await registry.conversations(slack(), sessions, { threads: true })
    expect(deals.threads!.map(t => t.externalId)).toEqual(['C0DEALS|3.0', 'C0DEALS|2.0', 'C0DEALS|1.0'])
    expect(deals.threads![0].type).toBe('thread')
    // Not asked for threads: the channel alone.
    expect((await registry.conversations(slack(), sessions))[0].threads).toBeUndefined()
  })

  it('keeps at most the newest THREADS_PER_CHANNEL threads of a busy channel', async () => {
    const sessions = Array.from({ length: THREADS_PER_CHANNEL + 3 }, (_, i) => at(`C0DEALS|${i}.0`, null, i * 0.01))
    const [deals] = await registry.conversations(slack(), sessions, { threads: true })
    expect(deals.threads).toHaveLength(THREADS_PER_CHANNEL)
    expect(deals.threads![0].externalId).toBe('C0DEALS|0.0')
  })

  it('folds only a well-formed thread id', () => {
    expect(SlackConnector.parentChatId('C0DEALS|1000.001')).toBe('C0DEALS')
    for (const id of ['C0DEALS', 'D0ALICE', '|1000.001', '', '|']) expect(SlackConnector.parentChatId(id)).toBeUndefined()
  })

  it('lists each channel once, whatever threads it has, and leaves DMs alone', async () => {
    const conversations = await registry.conversations(slack(), [
      at('C0DEALS|1000.001', '#deals — Nov 2, 3:04 PM'),
      at('C0DEALS|1000.002', '#deals — Nov 2, 3:09 PM'),
      at('C0OPS|1000.003', '#ops — Nov 2, 4:00 PM'),
      at('C0OPS', '#ops'),
      at('D0ALICE', 'Alice'),
    ])
    expect(conversations).toEqual([
      { externalId: 'C0DEALS', displayName: '#deals', type: classifySlackChatId('C0DEALS') },
      { externalId: 'C0OPS', displayName: '#ops', type: classifySlackChatId('C0OPS') },
      { externalId: 'D0ALICE', displayName: 'Alice', type: classifySlackChatId('D0ALICE') },
    ])
  })
})
