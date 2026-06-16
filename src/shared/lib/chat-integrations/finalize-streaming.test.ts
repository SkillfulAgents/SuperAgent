import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SlackConnector } from './slack-connector'
import { TelegramConnector } from './telegram-connector'

// ── Slack ──────────────────────────────────────────────────────────────

describe('SlackConnector.finalizeStreamingMessage', () => {
  let connector: SlackConnector
  let mockUpdate: ReturnType<typeof vi.fn>
  let mockPostMessage: ReturnType<typeof vi.fn>

  beforeEach(() => {
    connector = new SlackConnector({ botToken: 'xoxb-fake', appToken: 'xapp-fake' })
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
  let mockEditMessageText: ReturnType<typeof vi.fn>
  let mockSendMessage: ReturnType<typeof vi.fn>

  beforeEach(() => {
    connector = new TelegramConnector({ botToken: 'fake:token' })
    mockEditMessageText = vi.fn().mockResolvedValue(true)
    mockSendMessage = vi.fn().mockResolvedValue({ message_id: 999 })
    // Inject mock bot
    ;(connector as any).bot = {
      api: {
        editMessageText: mockEditMessageText,
        sendMessage: mockSendMessage,
      },
    }
  })

  it('edits the existing message for short text', async () => {
    await connector.finalizeStreamingMessage('12345', '100', 'short reply')

    expect(mockEditMessageText).toHaveBeenCalledTimes(1)
    expect(mockEditMessageText).toHaveBeenCalledWith('12345', 100, expect.any(String), expect.objectContaining({
      parse_mode: 'HTML',
    }))
    expect(mockSendMessage).not.toHaveBeenCalled()
  })

  it('splits long messages: edits first chunk, sends the rest', async () => {
    // Telegram limit is 4096
    const longText = 'a'.repeat(3000) + '\n\n' + 'b'.repeat(3000)

    await connector.finalizeStreamingMessage('12345', '100', longText)

    expect(mockEditMessageText).toHaveBeenCalledTimes(1)
    expect(mockSendMessage).toHaveBeenCalledTimes(1)
    expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.any(String), expect.objectContaining({
      parse_mode: 'HTML',
    }))
  })

  it('does not truncate — full content is preserved across chunks', async () => {
    const para1 = 'a'.repeat(3500)
    const para2 = 'b'.repeat(3500)
    const longText = `${para1}\n\n${para2}`

    await connector.finalizeStreamingMessage('12345', '100', longText)

    const editText: string = mockEditMessageText.mock.calls[0][2]
    const sendText: string = mockSendMessage.mock.calls[0][1]
    const combined = editText + sendText

    expect(combined).not.toContain('truncated')
    expect(combined).toContain('a'.repeat(3500))
    expect(combined).toContain('b'.repeat(3500))
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
})
