import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SlackConnector } from './slack-connector'
import { TelegramConnector } from './telegram-connector'

// ── Slack ──────────────────────────────────────────────────────────────

describe('SlackConnector.finalizeStreamingMessage', () => {
  let connector: SlackConnector
  let mockUpdate: ReturnType<typeof vi.fn>
  let mockPostMessage: ReturnType<typeof vi.fn>

  beforeEach(() => {
    connector = new SlackConnector({ botToken: 'xoxb-fake', appToken: 'xapp-fake' }, 'int-test')
    mockUpdate = vi.fn().mockResolvedValue({ ok: true })
    mockPostMessage = vi.fn().mockResolvedValue({ ok: true, ts: '1234.5678' })
    // Inject mock Slack app
    ;(connector as any).app = {
      client: {
        chat: { update: mockUpdate, postMessage: mockPostMessage },
        reactions: { remove: vi.fn().mockResolvedValue({}) },
      },
    }
  })

  it('updates the existing message for short text', async () => {
    await connector.finalizeStreamingMessage('C123', '1000.001', 'short reply')

    expect(mockUpdate).toHaveBeenCalledTimes(1)
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'C123',
      ts: '1000.001',
    }))
    expect(mockPostMessage).not.toHaveBeenCalled()
  })

  it('splits long messages: updates first chunk, posts the rest', async () => {
    const longText = 'a'.repeat(2000) + '\n\n' + 'b'.repeat(2000)

    await connector.finalizeStreamingMessage('C123', '1000.001', longText)

    expect(mockUpdate).toHaveBeenCalledTimes(1)
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'C123',
      ts: '1000.001',
    }))
    expect(mockPostMessage).toHaveBeenCalledTimes(1)
    expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'C123',
      mrkdwn: true,
    }))
  })

  it('does not truncate — full content is preserved across chunks', async () => {
    const para1 = 'a'.repeat(2500)
    const para2 = 'b'.repeat(2500)
    const longText = `${para1}\n\n${para2}`

    await connector.finalizeStreamingMessage('C123', '1000.001', longText)

    const updateText: string = mockUpdate.mock.calls[0][0].text
    const postText: string = mockPostMessage.mock.calls[0][0].text
    const combined = updateText + postText

    expect(combined).not.toContain('truncated')
    expect(combined).toContain('a'.repeat(2500))
    expect(combined).toContain('b'.repeat(2500))
  })

  it('preserves thread_ts for follow-up chunks in threaded conversations', async () => {
    // Simulate a thread context by using a composite chatId
    const longText = 'a'.repeat(2000) + '\n\n' + 'b'.repeat(2000)

    await connector.finalizeStreamingMessage('C123|1000.001', '1000.002', longText)

    expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({
      thread_ts: '1000.001',
    }))
  })

  it('handles three chunks correctly', async () => {
    const longText = 'a'.repeat(2500) + '\n\n' + 'b'.repeat(2500) + '\n\n' + 'c'.repeat(2500)

    await connector.finalizeStreamingMessage('C123', '1000.001', longText)

    expect(mockUpdate).toHaveBeenCalledTimes(1)
    expect(mockPostMessage).toHaveBeenCalledTimes(2)
  })
})

// ── Telegram ───────────────────────────────────────────────────────────

describe('TelegramConnector.finalizeStreamingMessage', () => {
  let connector: TelegramConnector
  let raw: { editMessageText: ReturnType<typeof vi.fn>; sendRichMessage: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    connector = new TelegramConnector({ botToken: 'fake:token' })
    raw = {
      editMessageText: vi.fn().mockResolvedValue(true),
      sendRichMessage: vi.fn().mockResolvedValue({ message_id: 999 }),
    }
    ;(connector as any).bot = {
      api: { raw, editMessageText: vi.fn(), sendMessage: vi.fn() },
    }
  })

  it('edits the existing message rich for short text', async () => {
    await connector.finalizeStreamingMessage('12345', '100', 'short reply')
    expect(raw.editMessageText).toHaveBeenCalledTimes(1)
    expect(raw.editMessageText).toHaveBeenCalledWith(expect.objectContaining({
      chat_id: 12345,
      message_id: 100,
      rich_message: expect.objectContaining({ markdown: 'short reply' }),
    }))
    expect(raw.sendRichMessage).not.toHaveBeenCalled()
  })

  it('splits content over the rich ceiling: edits the first chunk rich, sends the rest rich', async () => {
    const longText = 'a'.repeat(20000) + '\n\n' + 'b'.repeat(20000) // > 32768
    await connector.finalizeStreamingMessage('12345', '100', longText)
    expect(raw.editMessageText).toHaveBeenCalledTimes(1)
    expect(raw.sendRichMessage).toHaveBeenCalledTimes(1)
  })

  it('does not truncate — full content is preserved across rich chunks', async () => {
    const para1 = 'a'.repeat(20000)
    const para2 = 'b'.repeat(20000)
    const longText = `${para1}\n\n${para2}`
    await connector.finalizeStreamingMessage('12345', '100', longText)
    const editMd: string = raw.editMessageText.mock.calls[0][0].rich_message.markdown
    const sendMd: string = raw.sendRichMessage.mock.calls[0][0].rich_message.markdown
    const combined = editMd + sendMd
    expect(combined).not.toContain('truncated')
    expect(combined).toContain('a'.repeat(20000))
    expect(combined).toContain('b'.repeat(20000))
  })

  it('fallback (richMessages off): splits a >4096 reply across edit + sends, no truncation', async () => {
    // HTML fallback edits cap at 4096, not the 32768 rich ceiling. A rich-sized
    // first chunk would overflow the edit and silently drop the tail — guard that
    // the reply is split to the HTML limit and delivered in full instead.
    const fallback = new TelegramConnector({ botToken: 'fake:token', richMessages: false })
    const editHtml = vi.fn().mockResolvedValue(true)
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 22 })
    ;(fallback as any).bot = {
      api: { raw: { editMessageText: vi.fn(), sendRichMessage: vi.fn() }, editMessageText: editHtml, sendMessage },
    }

    const longText = 'a'.repeat(3000) + '\n\n' + 'b'.repeat(3000) // > 4096, under the 32768 rich ceiling

    await fallback.finalizeStreamingMessage('12345', '100', longText)

    // chunk[0] edits the streamed message; the overflow goes out as new messages
    expect(editHtml).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls.length).toBeGreaterThan(0)

    // every message stays within Telegram's 4096 single-message limit
    const bodies = [editHtml.mock.calls[0][2] as string, ...sendMessage.mock.calls.map((call) => call[1] as string)]
    for (const body of bodies) expect(body.length).toBeLessThanOrEqual(4096)

    // nothing dropped: both ends of the reply survive across the split
    const combined = bodies.join('')
    expect(combined).toContain('a'.repeat(3000))
    expect(combined).toContain('b'.repeat(3000))
  })
})

describe('TelegramConnector.sendRichOrHtml', () => {
  let connector: TelegramConnector
  let mockSendRich: ReturnType<typeof vi.fn>
  let mockSendMessage: ReturnType<typeof vi.fn>

  beforeEach(() => {
    connector = new TelegramConnector({ botToken: 'fake:token' })
    mockSendRich = vi.fn().mockResolvedValue({ message_id: 11 })
    mockSendMessage = vi.fn().mockResolvedValue({ message_id: 22 })
    ;(connector as any).bot = {
      api: { raw: { sendRichMessage: mockSendRich }, sendMessage: mockSendMessage },
    }
  })

  it('sends rich and returns its message id', async () => {
    const id = await (connector as any).sendRichOrHtml('123', 'hello')
    expect(mockSendRich).toHaveBeenCalledWith(expect.objectContaining({
      chat_id: 123,
      rich_message: { markdown: 'hello' },
    }))
    expect(id).toBe('11')
    expect(mockSendMessage).not.toHaveBeenCalled()
  })

  it('falls back to legacy HTML when the rich send throws', async () => {
    mockSendRich.mockRejectedValueOnce(new Error('rich rejected'))
    const id = await (connector as any).sendRichOrHtml('123', '**hi**')
    expect(mockSendMessage).toHaveBeenCalledWith('123', expect.stringContaining('<strong>hi</strong>'), expect.objectContaining({ parse_mode: 'HTML' }))
    expect(id).toBe('22')
  })

  it('re-splits the HTML fallback to the 4096 sink limit for long bodies', async () => {
    // Body is chunked for the 32768 rich ceiling; the HTML sink caps at 4096, so a
    // long fallback must split into multiple sends instead of being rejected.
    mockSendRich.mockRejectedValue(new Error('rich rejected'))
    const long = 'a'.repeat(5000) + '\n\n' + 'b'.repeat(5000)
    await (connector as any).sendRichOrHtml('123', long)
    expect(mockSendMessage.mock.calls.length).toBeGreaterThan(1)
    for (const call of mockSendMessage.mock.calls) {
      expect((call[1] as string).length).toBeLessThanOrEqual(4096)
    }
  })
})

describe('TelegramConnector.editRichOrHtml', () => {
  let connector: TelegramConnector
  let mockEditRich: ReturnType<typeof vi.fn>
  let mockEditHtml: ReturnType<typeof vi.fn>

  beforeEach(() => {
    connector = new TelegramConnector({ botToken: 'fake:token' })
    mockEditRich = vi.fn().mockResolvedValue(true)
    mockEditHtml = vi.fn().mockResolvedValue(true)
    ;(connector as any).bot = {
      api: { raw: { editMessageText: mockEditRich }, editMessageText: mockEditHtml },
    }
  })

  it('edits rich and does not touch the HTML path on success', async () => {
    await (connector as any).editRichOrHtml('123', '50', 'hello')
    expect(mockEditRich).toHaveBeenCalledWith(expect.objectContaining({
      chat_id: 123, message_id: 50, rich_message: { markdown: 'hello' },
    }))
    expect(mockEditHtml).not.toHaveBeenCalled()
  })

  it('falls back to legacy HTML when the rich edit throws', async () => {
    mockEditRich.mockRejectedValueOnce(new Error('rich rejected'))
    await (connector as any).editRichOrHtml('123', '50', '**hi**')
    expect(mockEditHtml).toHaveBeenCalledWith('123', 50, expect.stringContaining('<strong>hi</strong>'), expect.objectContaining({ parse_mode: 'HTML' }))
  })

  it('treats "message is not modified" as success without an HTML fallback', async () => {
    mockEditRich.mockRejectedValueOnce(new Error('Bad Request: message is not modified'))
    await (connector as any).editRichOrHtml('123', '50', 'same')
    expect(mockEditHtml).not.toHaveBeenCalled()
  })
})

describe('TelegramConnector.sendMessage (rich)', () => {
  it('sends the body as a rich message split at the 32768 ceiling', async () => {
    const connector = new TelegramConnector({ botToken: 'fake:token' })
    const mockSendRich = vi.fn().mockResolvedValue({ message_id: 7 })
    ;(connector as any).bot = { api: { raw: { sendRichMessage: mockSendRich }, sendMessage: vi.fn() } }

    const id = await connector.sendMessage('500', { text: '# Brief\n\n| a | b |\n|---|---|\n| 1 | 2 |' })

    expect(mockSendRich).toHaveBeenCalledTimes(1)
    expect(mockSendRich).toHaveBeenCalledWith(expect.objectContaining({
      chat_id: 500,
      rich_message: expect.objectContaining({ markdown: expect.stringContaining('| a | b |') }),
    }))
    expect(id).toBe('7')
  })
})

describe('TelegramConnector.sendUserRequestCard (rich)', () => {
  let connector: TelegramConnector
  let mockSendRich: ReturnType<typeof vi.fn>
  beforeEach(() => {
    connector = new TelegramConnector({ botToken: 'fake:token' })
    mockSendRich = vi.fn().mockResolvedValue({ message_id: 5 })
    ;(connector as any).bot = { api: { raw: { sendRichMessage: mockSendRich }, sendMessage: vi.fn() } }
  })

  it('sends a single question as rich with an inline keyboard', async () => {
    await connector.sendUserRequestCard('123', {
      type: 'user_question_request',
      toolUseId: 't1',
      questions: [{ question: 'Pick one', header: 'Choice', options: [{ label: 'A' }, { label: 'B' }] }],
    } as any)
    const call = mockSendRich.mock.calls[0][0]
    expect(call.rich_message.markdown).toContain('Pick one')
    expect(call.reply_markup.inline_keyboard.length).toBe(2)
  })

  it('sends tool_status as rich', async () => {
    await connector.sendUserRequestCard('123', {
      type: 'tool_status', toolUseId: 't2', toolName: 'Bash', summary: 'ran ls', status: 'success',
    } as any)
    expect(mockSendRich.mock.calls[0][0].rich_message.markdown).toContain('Bash')
  })

  it('escapes interpolated values so they cannot break the markdown', async () => {
    await connector.sendUserRequestCard('123', {
      type: 'secret_request', toolUseId: 't3', secretName: 'weird`name', reason: 'needs **admin** rights',
    } as any)
    const md: string = mockSendRich.mock.calls[0][0].rich_message.markdown
    // secretName with a backtick is fenced so it can't close the code span.
    expect(md).toContain('``weird`name``')
    // reason's asterisks are escaped, not rendered as bold.
    expect(md).toContain('needs \\*\\*admin\\*\\* rights')
  })
})

describe('TelegramConnector.handleCallbackQuery', () => {
  it('confirms the answer via the rich edit path, with the value escaped', async () => {
    const connector = new TelegramConnector({ botToken: 'fake:token' })
    const editRich = vi.fn().mockResolvedValue(true)
    const editHtml = vi.fn().mockResolvedValue(true)
    ;(connector as any).bot = { api: { raw: { editMessageText: editRich }, editMessageText: editHtml } }

    // Register a single-question callback and grab its callback_data id.
    const cbId = (connector as any).registerCallback('tool-1', { question: 'Pick one', answer: 'a*b' })
    const ctx = {
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
      editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
      callbackQuery: { data: cbId, message: { text: 'Question?', message_id: 50 } },
      chat: { id: 123 },
    }

    await (connector as any).handleCallbackQuery(ctx)

    // Edited through the rich path (rich_message), never the HTML sink.
    expect(editRich).toHaveBeenCalledTimes(1)
    expect(editHtml).not.toHaveBeenCalled()
    const call = editRich.mock.calls[0][0]
    // The answer's asterisk is escaped so it can't render as bold.
    expect(call.rich_message.markdown).toContain('✅ **a\\*b**')
    // No reply_markup on the text edit, so Telegram removes the keyboard.
    expect(call.reply_markup).toBeUndefined()
  })
})

describe('TelegramConnector streaming (group, rich)', () => {
  let connector: TelegramConnector
  let raw: { sendRichMessage: ReturnType<typeof vi.fn>; editMessageText: ReturnType<typeof vi.fn>; sendRichMessageDraft: ReturnType<typeof vi.fn> }
  beforeEach(() => {
    connector = new TelegramConnector({ botToken: 'fake:token' })
    raw = {
      sendRichMessage: vi.fn().mockResolvedValue({ message_id: 100 }),
      editMessageText: vi.fn().mockResolvedValue(true),
      sendRichMessageDraft: vi.fn().mockResolvedValue(true),
    }
    ;(connector as any).bot = { api: { raw, sendMessage: vi.fn(), editMessageText: vi.fn() } }
  })

  it('creates the message with sendRichMessage on first update (negative chat id)', async () => {
    const id = await connector.sendStreamingUpdate('-1001', 'partial')
    expect(raw.sendRichMessage).toHaveBeenCalledWith(expect.objectContaining({ chat_id: -1001 }))
    expect(raw.sendRichMessageDraft).not.toHaveBeenCalled()
    expect(id).toBe('100')
  })

  it('edits rich on subsequent updates', async () => {
    await connector.sendStreamingUpdate('-1001', 'more', '100')
    expect(raw.editMessageText).toHaveBeenCalledWith(expect.objectContaining({ chat_id: -1001, message_id: 100 }))
  })

  it('finalizes by editing the persisted message rich', async () => {
    await connector.finalizeStreamingMessage('-1001', '100', 'final brief')
    expect(raw.editMessageText).toHaveBeenCalledWith(expect.objectContaining({
      message_id: 100,
      rich_message: expect.objectContaining({ markdown: 'final brief' }),
    }))
  })
})

describe('TelegramConnector streaming (DM, draft)', () => {
  let connector: TelegramConnector
  let raw: { sendRichMessageDraft: ReturnType<typeof vi.fn>; sendRichMessage: ReturnType<typeof vi.fn> }
  beforeEach(() => {
    connector = new TelegramConnector({ botToken: 'fake:token' })
    raw = {
      sendRichMessageDraft: vi.fn().mockResolvedValue(true),
      sendRichMessage: vi.fn().mockResolvedValue({ message_id: 200 }),
    }
    ;(connector as any).bot = { api: { raw, sendMessage: vi.fn() } }
  })

  it('streams via sendRichMessageDraft and returns a draft sentinel (positive chat id)', async () => {
    const id = await connector.sendStreamingUpdate('999', 'partial brief')
    expect(raw.sendRichMessageDraft).toHaveBeenCalledWith(expect.objectContaining({
      chat_id: 999,
      rich_message: { markdown: 'partial brief' },
    }))
    expect(raw.sendRichMessageDraft.mock.calls[0][0].draft_id).toBeGreaterThan(0)
    expect(id).toBe('draft:999')
  })

  it('reuses the same draft_id across updates for the same chat', async () => {
    await connector.sendStreamingUpdate('999', 'a')
    await connector.sendStreamingUpdate('999', 'a b', 'draft:999')
    const first = raw.sendRichMessageDraft.mock.calls[0][0].draft_id
    const second = raw.sendRichMessageDraft.mock.calls[1][0].draft_id
    expect(second).toBe(first)
  })

  it('commits the draft with sendRichMessage on finalize and clears state', async () => {
    await connector.sendStreamingUpdate('999', 'partial')
    await connector.finalizeStreamingMessage('999', 'draft:999', 'final brief')
    expect(raw.sendRichMessage).toHaveBeenCalledWith(expect.objectContaining({
      chat_id: 999, rich_message: expect.objectContaining({ markdown: 'final brief' }),
    }))
    expect((connector as any).activeDrafts.has('999')).toBe(false)
  })
})

describe('TelegramConnector.startWorking / stopWorking', () => {
  it('shows the native <tg-thinking> draft in a DM', async () => {
    const connector = new TelegramConnector({ botToken: 'fake:token' })
    const sendRichMessageDraft = vi.fn().mockResolvedValue(true)
    const sendChatAction = vi.fn().mockResolvedValue(true)
    ;(connector as any).bot = { api: { raw: { sendRichMessageDraft }, sendChatAction } }

    await connector.startWorking('999')
    expect(sendRichMessageDraft).toHaveBeenCalledWith(expect.objectContaining({
      chat_id: 999,
      rich_message: { html: '<tg-thinking>✨ Thinking…</tg-thinking>' },
    }))
    // A draft (native thinking block), not the group typing action.
    expect(sendChatAction).not.toHaveBeenCalled()
    await connector.stopWorking('999') // clear the keep-alive timer
  })

  it('keeps the draft alive on a heartbeat and stops re-sending after stopWorking', async () => {
    vi.useFakeTimers()
    try {
      const connector = new TelegramConnector({ botToken: 'fake:token' })
      const sendRichMessageDraft = vi.fn().mockResolvedValue(true)
      ;(connector as any).bot = { api: { raw: { sendRichMessageDraft }, sendChatAction: vi.fn() } }

      await connector.startWorking('999')
      expect(sendRichMessageDraft).toHaveBeenCalledTimes(1) // sent right away

      await vi.advanceTimersByTimeAsync(1000)
      expect(sendRichMessageDraft).toHaveBeenCalledTimes(2) // re-sent to keep alive

      // Same draft id, so the streaming response (which reuses it) replaces the indicator.
      const first = (sendRichMessageDraft.mock.calls[0][0] as any).draft_id
      const second = (sendRichMessageDraft.mock.calls[1][0] as any).draft_id
      expect(second).toBe(first)

      await connector.stopWorking('999')
      await vi.advanceTimersByTimeAsync(5000)
      expect(sendRichMessageDraft).toHaveBeenCalledTimes(2) // no further sends after stop
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses the typing action in a group', async () => {
    const connector = new TelegramConnector({ botToken: 'fake:token' })
    const sendRichMessageDraft = vi.fn().mockResolvedValue(true)
    const sendChatAction = vi.fn().mockResolvedValue(true)
    ;(connector as any).bot = { api: { raw: { sendRichMessageDraft }, sendChatAction } }

    await connector.startWorking('-1001')
    expect(sendChatAction).toHaveBeenCalledWith('-1001', 'typing')
    expect(sendRichMessageDraft).not.toHaveBeenCalled()
    await connector.stopWorking('-1001') // clear the keep-alive timer
  })
})

describe('TelegramConnector.sendStreamingUpdate (DM, real message edit)', () => {
  // The tool-status pill path: the manager posts a real (non-draft) message via
  // sendMessage, then calls sendStreamingUpdate with that real id to flip ⏳→✅.
  // In a DM this must EDIT the real message, not spawn a throwaway draft.
  let connector: TelegramConnector
  let raw: {
    sendRichMessageDraft: ReturnType<typeof vi.fn>
    editMessageText: ReturnType<typeof vi.fn>
    sendRichMessage: ReturnType<typeof vi.fn>
  }
  beforeEach(() => {
    connector = new TelegramConnector({ botToken: 'fake:token' })
    raw = {
      sendRichMessageDraft: vi.fn().mockResolvedValue(true),
      editMessageText: vi.fn().mockResolvedValue(true),
      sendRichMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    }
    ;(connector as any).bot = { api: { raw, sendMessage: vi.fn(), editMessageText: vi.fn() } }
  })

  it('edits a real (non-draft) message id in a DM instead of spawning a draft', async () => {
    const id = await connector.sendStreamingUpdate('999', '🔧 Bash ✅', '12345')
    expect(raw.editMessageText).toHaveBeenCalledWith(expect.objectContaining({ chat_id: 999, message_id: 12345 }))
    expect(raw.sendRichMessageDraft).not.toHaveBeenCalled()
    expect(id).toBe('12345')
  })

  it('still uses the draft path for the streaming-response flow (no id, then draft sentinel)', async () => {
    const first = await connector.sendStreamingUpdate('999', 'partial')
    expect(first).toBe('draft:999')
    await connector.sendStreamingUpdate('999', 'partial more', first)
    expect(raw.sendRichMessageDraft).toHaveBeenCalledTimes(2)
    expect(raw.editMessageText).not.toHaveBeenCalled()
  })
})
