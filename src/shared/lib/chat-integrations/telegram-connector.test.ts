import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TelegramConnector } from './telegram-connector'
import type { IncomingMessage } from './base-connector'

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

  it('photo handler drops channel updates (no emit)', async () => {
    await capturedHandlers['message:photo'](photoCtx('channel'))
    expect(emitted).toHaveLength(0)
  })

  it('document handler drops channel updates (no emit)', async () => {
    await capturedHandlers['message:document'](docCtx('channel'))
    expect(emitted).toHaveLength(0)
  })
})
