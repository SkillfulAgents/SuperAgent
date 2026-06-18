import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TelegramConnector } from './telegram-connector'
import type { IncomingMessage } from './base-connector'

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
