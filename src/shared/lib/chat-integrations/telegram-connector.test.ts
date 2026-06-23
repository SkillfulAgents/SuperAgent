import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TelegramConnector, renderDashboardCard } from './telegram-connector'
import type { IncomingMessage } from './base-connector'
import { getPlatformBaseUrl } from '@shared/lib/platform-auth/config'

// ── grammY mock ────────────────────────────────────────────────────────────────
// The photo/document handlers are inline closures registered inside connect(),
// not methods like handleTextMessage — so they can only be driven via the
// registry. We mock grammY's Bot to capture the handlers connect() registers and
// to stub api.getFile. The text-handler describes never call connect(), so they
// never touch the mock.
const { capturedHandlers, getFileMock } = vi.hoisted(() => ({
  capturedHandlers: {} as Record<string, (ctx: any) => unknown>,
  getFileMock: vi.fn(),
}))

vi.mock('grammy', () => ({
  Bot: class {
    api = { getFile: getFileMock }
    on(event: string, handler: (ctx: any) => unknown): void { capturedHandlers[event] = handler }
    start(opts: { onStart?: () => void }): Promise<void> { opts?.onStart?.(); return Promise.resolve() }
    async stop(): Promise<void> {}
  },
}))

vi.mock('@shared/lib/platform-auth/config', async (orig) => ({
  ...(await orig<typeof import('@shared/lib/platform-auth/config')>()),
  getPlatformBaseUrl: vi.fn(),
}))

// ── Minimal ctx mock ──────────────────────────────────────────────────────────

function makeCtx(overrides: {
  type: string
  chatId?: number
  userId?: number
  firstName?: string
  text?: string
  messageId?: number
  title?: string
}): unknown {
  return {
    chat: {
      id: overrides.chatId ?? 123,
      type: overrides.type,
      title: overrides.title,
    },
    from: {
      id: overrides.userId ?? 456,
      first_name: overrides.firstName ?? 'Alice',
    },
    message: {
      text: overrides.text ?? 'hello',
      message_id: overrides.messageId ?? 1,
      date: 0,
    },
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConnector(): TelegramConnector {
  // Token format doesn't matter for unit tests — we never connect()
  return new TelegramConnector({ botToken: 'fake:TOKEN' })
}

function callHandleText(connector: TelegramConnector, ctx: unknown): void {
  // handleTextMessage is private; cast to any to reach the test seam
  ;(connector as any).handleTextMessage(ctx)
}

function collectEmits(connector: TelegramConnector): IncomingMessage[] {
  const msgs: IncomingMessage[] = []
  connector.onMessage((m) => msgs.push(m))
  return msgs
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TelegramConnector — chatType propagation', () => {
  let connector: TelegramConnector
  let emitted: IncomingMessage[]

  beforeEach(() => {
    connector = makeConnector()
    emitted = collectEmits(connector)
    // Skip first-poll buffering so messages emit immediately
    ;(connector as any).hasCompletedFirstPoll = true
  })

  it('emits chatType=private for a private chat message', () => {
    callHandleText(connector, makeCtx({ type: 'private' }))
    expect(emitted).toHaveLength(1)
    expect(emitted[0].chatType).toBe('private')
  })

  it('emits chatType=group for a group chat message', () => {
    callHandleText(connector, makeCtx({ type: 'group', title: 'My Group' }))
    expect(emitted).toHaveLength(1)
    expect(emitted[0].chatType).toBe('group')
  })

  it('emits chatType=supergroup for a supergroup message', () => {
    callHandleText(connector, makeCtx({ type: 'supergroup', title: 'My Supergroup' }))
    expect(emitted).toHaveLength(1)
    expect(emitted[0].chatType).toBe('supergroup')
  })

  it('drops channel updates (returns without emitting)', () => {
    callHandleText(connector, makeCtx({ type: 'channel' }))
    expect(emitted).toHaveLength(0)
  })
})

describe('TelegramConnector — /start routing', () => {
  let connector: TelegramConnector
  let emitted: IncomingMessage[]

  beforeEach(() => {
    connector = makeConnector()
    emitted = collectEmits(connector)
    ;(connector as any).hasCompletedFirstPoll = true
  })

  it('emits /start as a normal IncomingMessage (no early-return greeting)', () => {
    callHandleText(connector, makeCtx({ type: 'private', text: '/start' }))
    expect(emitted).toHaveLength(1)
    expect(emitted[0].text).toBe('/start')
    expect(emitted[0].chatType).toBe('private')
  })

  it('does not call ctx.reply for /start (greeting removed from connector)', () => {
    const ctx = makeCtx({ type: 'private', text: '/start' }) as any
    ctx.reply = vi.fn()
    callHandleText(connector, ctx)
    expect(ctx.reply).not.toHaveBeenCalled()
  })
})

describe('TelegramConnector — first-poll batch flush', () => {
  let connector: TelegramConnector
  let emitted: IncomingMessage[]

  beforeEach(() => {
    connector = makeConnector()
    emitted = collectEmits(connector)
    // Simulate first-poll window so messages buffer
    ;(connector as any).hasCompletedFirstPoll = false
  })

  it('flushBatch includes userName, chatName, and chatType from the buffered message', () => {
    const ctx = makeCtx({
      type: 'group',
      chatId: 999,
      userId: 111,
      firstName: 'Bob',
      title: 'Team Chat',
      text: 'buffered message',
      messageId: 42,
    })

    callHandleText(connector, ctx)

    // Manually flush (bypasses the setTimeout)
    ;(connector as any).flushBatch('999', '111', '42')

    expect(emitted).toHaveLength(1)
    const msg = emitted[0]
    expect(msg.text).toBe('buffered message')
    expect(msg.chatType).toBe('group')
    expect(msg.userName).toBe('Bob')
    expect(msg.chatName).toBe('Team Chat')
    expect(msg.chatId).toBe('999')
    expect(msg.userId).toBe('111')
  })

  it('batches multiple messages and carries chatType through the combined emit', () => {
    const ctx1 = makeCtx({ type: 'private', chatId: 200, userId: 300, firstName: 'Eve', text: 'first', messageId: 10 })
    const ctx2 = makeCtx({ type: 'private', chatId: 200, userId: 300, firstName: 'Eve', text: 'second', messageId: 11 })

    callHandleText(connector, ctx1)
    callHandleText(connector, ctx2)
    ;(connector as any).flushBatch('200', '300', '11')

    expect(emitted).toHaveLength(1)
    expect(emitted[0].chatType).toBe('private')
    expect(emitted[0].text).toContain('first')
    expect(emitted[0].text).toContain('second')
  })
})

describe('TelegramConnector — media handlers (photo/document)', () => {
  let connector: TelegramConnector
  let emitted: IncomingMessage[]

  beforeEach(async () => {
    // Fake timers so the connect() poll loop + onStart's first-poll timer settle
    // deterministically without dangling into other tests.
    vi.useFakeTimers()
    for (const k of Object.keys(capturedHandlers)) delete capturedHandlers[k]
    getFileMock.mockReset().mockResolvedValue({ file_path: 'files/x' })
    connector = makeConnector()
    emitted = collectEmits(connector)
    const p = connector.connect()
    // Drives the 100ms connect() poll (resolves once connected) and onStart's
    // ~1000ms first-poll completion timer.
    await vi.advanceTimersByTimeAsync(1100)
    await p
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  function photoCtx(type: string): unknown {
    return {
      chat: { id: 123, type, title: type === 'private' ? undefined : 'My Group' },
      from: { id: 456, first_name: 'Alice' },
      message: { photo: [{ file_id: 'small' }, { file_id: 'large' }], caption: 'pic', message_id: 9, date: 0 },
    }
  }

  function docCtx(type: string): unknown {
    return {
      chat: { id: 123, type, title: type === 'private' ? undefined : 'My Group' },
      from: { id: 456, first_name: 'Bob' },
      message: { document: { file_id: 'd1', file_name: 'report.pdf', mime_type: 'application/pdf' }, caption: '', message_id: 11, date: 0 },
    }
  }

  for (const type of ['private', 'group', 'supergroup'] as const) {
    it(`photo handler emits chatType=${type}`, async () => {
      await capturedHandlers['message:photo'](photoCtx(type))
      expect(emitted).toHaveLength(1)
      expect(emitted[0].chatType).toBe(type)
      expect(emitted[0].files?.[0]?.mimeType).toBe('image/jpeg')
    })

    it(`document handler emits chatType=${type}`, async () => {
      await capturedHandlers['message:document'](docCtx(type))
      expect(emitted).toHaveLength(1)
      expect(emitted[0].chatType).toBe(type)
      expect(emitted[0].files?.[0]?.name).toBe('report.pdf')
    })
  }
})

describe('TelegramConnector.sendDashboardCard', () => {
  let connector: TelegramConnector
  let sendMessage: ReturnType<typeof vi.fn>

  beforeEach(() => {
    // richMessages: false routes sendRichOrHtml straight to the mocked sendMessage
    // (the HTML sink), so we assert the rendered card without stubbing the rich API.
    connector = new TelegramConnector({ botToken: 'x', richMessages: false })
    sendMessage = vi.fn().mockResolvedValue({ message_id: 1 })
    ;(connector as any).bot = { api: { sendMessage } }
  })

  it('sends a web_app button with the correct URL when base URL is set', async () => {
    vi.mocked(getPlatformBaseUrl).mockReturnValue('https://host.example')

    const delivery = await connector.sendDashboardCard('chat1', {
      integrationId: 'int1',
      agentSlug: 'sales',
      dashboardSlug: 'weekly-report',
      name: 'Weekly',
      allowButton: true,
    })

    expect(delivery).toBe('button')
    expect(sendMessage).toHaveBeenCalledOnce()

    const [chatIdArg, textArg, optsArg] = sendMessage.mock.calls[0]
    expect(chatIdArg).toBe('chat1')
    expect(textArg).toContain('Weekly')
    expect(optsArg.parse_mode).toBe('HTML')

    const button = optsArg.reply_markup.inline_keyboard[0][0]
    expect(button.text).toBe('📊 Open dashboard') // default icon when no emoji supplied
    const webAppUrl: string = button.web_app.url
    expect(webAppUrl).toContain('https://host.example/api/telegram-miniapp')
    expect(webAppUrl).toContain('i=int1')
    expect(webAppUrl).toContain('a=sales')
    expect(webAppUrl).toContain('d=weekly-report')
  })

  it('sends plain text with no web_app button when base URL is unset', async () => {
    vi.mocked(getPlatformBaseUrl).mockReturnValue('')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const delivery = await connector.sendDashboardCard('chat1', {
      integrationId: 'int1',
      agentSlug: 'sales',
      dashboardSlug: 'weekly-report',
      name: 'Weekly',
      allowButton: true,
    })

    expect(delivery).toBe('text')
    expect(sendMessage).toHaveBeenCalledOnce()

    const [chatIdArg, textArg, optsArg] = sendMessage.mock.calls[0]
    expect(chatIdArg).toBe('chat1')
    expect(textArg).toContain('Weekly')
    // No web_app button — reply_markup is absent on the text-fallback path
    expect(optsArg?.reply_markup).toBeUndefined()

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('public HTTPS base URL'),
    )

    warnSpy.mockRestore()
  })

  it('sends plain text with no web_app button when the base URL is not https', async () => {
    // A web_app button requires an https URL; an http base would dead-end on tap,
    // so treat it the same as no base URL and fall back to the plain-text card.
    vi.mocked(getPlatformBaseUrl).mockReturnValue('http://host.example')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const delivery = await connector.sendDashboardCard('chat1', {
      integrationId: 'int1',
      agentSlug: 'sales',
      dashboardSlug: 'weekly-report',
      name: 'Weekly',
      allowButton: true,
    })

    expect(delivery).toBe('text')
    expect(sendMessage).toHaveBeenCalledOnce()
    const [, , optsArg] = sendMessage.mock.calls[0]
    expect(optsArg?.reply_markup).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('public HTTPS base URL'),
    )

    warnSpy.mockRestore()
  })

  it('sends plain text with no button when allowButton is false even if base URL is set', async () => {
    // No integration owner to act as -> the button would dead-end on tap, so the
    // connector must fall back to plain text despite a configured base URL.
    vi.mocked(getPlatformBaseUrl).mockReturnValue('https://host.example')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const delivery = await connector.sendDashboardCard('chat1', {
      integrationId: 'int1',
      agentSlug: 'sales',
      dashboardSlug: 'weekly-report',
      name: 'Weekly',
      allowButton: false,
    })

    expect(delivery).toBe('text')
    expect(sendMessage).toHaveBeenCalledOnce()
    const [chatIdArg, textArg, optsArg] = sendMessage.mock.calls[0]
    expect(chatIdArg).toBe('chat1')
    expect(textArg).toContain('Weekly')
    expect(optsArg?.reply_markup).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no owner'))

    warnSpy.mockRestore()
  })

  it('includes the agent-supplied emoji + caption in the card text', async () => {
    vi.mocked(getPlatformBaseUrl).mockReturnValue('https://host.example')

    await connector.sendDashboardCard('chat1', {
      integrationId: 'int1',
      agentSlug: 'sales',
      dashboardSlug: 'weekly-report',
      name: 'World Cup 2026 Tracker',
      allowButton: true,
      emoji: '⚽',
      caption: 'Live group standings + bracket',
    })

    const [, textArg, optsArg] = sendMessage.mock.calls[0]
    expect(textArg).toContain('⚽')
    expect(textArg).toContain('World Cup 2026 Tracker')
    expect(textArg).toContain('Live group standings + bracket')
    // The contextual emoji also rides the button label.
    expect(optsArg.reply_markup.inline_keyboard[0][0].text).toBe('⚽ Open dashboard')
  })
})

describe('renderDashboardCard', () => {
  it('renders a bold "<emoji> <name>" title with an italic caption on its own line (blank line so Telegram does not collapse it)', () => {
    expect(renderDashboardCard('Weekly', '⚽', 'Live standings')).toBe('**⚽ Weekly**\n\n_Live standings_')
  })

  it('defaults to a chart emoji when none is supplied', () => {
    expect(renderDashboardCard('Weekly')).toBe('**📊 Weekly**')
  })

  it('omits the blurb line when the caption is blank', () => {
    expect(renderDashboardCard('Weekly', '⚽', '   ')).toBe('**⚽ Weekly**')
  })

  it('escapes markdown metacharacters in the agent-supplied name/caption', () => {
    const out = renderDashboardCard('a*b', '📊', 'c_d')
    expect(out).toContain('a\\*b')
    expect(out).toContain('c\\_d')
  })
})
