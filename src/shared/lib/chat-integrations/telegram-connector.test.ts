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

interface CapturedResponse { toolUseId: string; response: any; chatId?: string }

function collectInteractiveResponses(connector: TelegramConnector): CapturedResponse[] {
  const out: CapturedResponse[] = []
  connector.onInteractiveResponse((toolUseId, response, chatId) => out.push({ toolUseId, response, chatId }))
  return out
}

/** Attach a fake grammY bot that captures rich sends/edits, so sendUserRequestCard works. */
function attachFakeBot(connector: TelegramConnector): { sent: any[] } {
  const sent: any[] = []
  ;(connector as any).bot = {
    api: {
      raw: {
        sendRichMessage: vi.fn(async (args: any) => { sent.push(args); return { message_id: 1000 + sent.length } }),
        editMessageText: vi.fn(async () => ({})),
      },
      sendMessage: vi.fn(async () => ({ message_id: 1 })),
      editMessageText: vi.fn(async () => ({})),
      editMessageReplyMarkup: vi.fn(async () => ({})),
    },
  }
  return { sent }
}

/** A callback_query ctx. Rich messages carry no `.text`, so we omit it by default. */
function makeCbCtx(data: string, opts: { messageId?: number; chatId?: number; text?: string } = {}): any {
  return {
    callbackQuery: { data, message: { message_id: opts.messageId ?? 1001, text: opts.text } },
    chat: { id: opts.chatId ?? 123 },
    answerCallbackQuery: vi.fn(async () => {}),
    editMessageReplyMarkup: vi.fn(async () => {}),
  }
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

// ── Working indicator: dumb (no self-heartbeat) ─────────────────────────────────
// The manager's per-session tick drives keep-alive now, so startWorking renders
// the labeled draft once per call and never installs its own setInterval.
describe('startWorking (dumb, no self-heartbeat)', () => {
  function makeDmConnector() {
    const connector = new TelegramConnector({ botToken: 'fake:token' })
    const sendRichMessageDraft = vi.fn().mockResolvedValue(true)
    ;(connector as unknown as { bot: unknown }).bot = {
      api: { raw: { sendRichMessageDraft }, sendChatAction: vi.fn() },
    }
    return { connector, sendRichMessageDraft }
  }

  it('renders exactly once per startWorking and never re-sends on a timer', async () => {
    vi.useFakeTimers()
    try {
      const { connector, sendRichMessageDraft } = makeDmConnector()
      await connector.startWorking('999', 'working') // positive id → private DM → native draft
      expect(sendRichMessageDraft).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(5000)
      expect(sendRichMessageDraft).toHaveBeenCalledTimes(1) // no heartbeat re-sends
    } finally {
      vi.useRealTimers()
    }
  })

  it('stopWorking resolves and leaves the draft id intact for stream reuse', async () => {
    const { connector } = makeDmConnector()
    await connector.startWorking('999', 'working')
    await expect(connector.stopWorking('999')).resolves.toBeUndefined()
  })
})

describe('TelegramConnector — AskUserQuestion multi-select', () => {
  let connector: TelegramConnector
  let sent: any[]
  let responses: CapturedResponse[]

  beforeEach(() => {
    connector = makeConnector()
    responses = collectInteractiveResponses(connector)
    sent = attachFakeBot(connector).sent
  })

  function multiSelectEvent(): any {
    return {
      type: 'user_question_request',
      toolUseId: 'tu-multi',
      questions: [{
        question: 'Pick your stack',
        multiSelect: true,
        options: [{ label: 'Redis' }, { label: 'S3' }, { label: 'Postgres' }],
      }],
    }
  }

  it('renders one option button per choice plus a Done button for a multiSelect question', async () => {
    await (connector as any).sendUserRequestCard('123', multiSelectEvent())
    const kb = sent[0].reply_markup.inline_keyboard
    expect(kb).toHaveLength(4) // 3 options + Done
    expect(kb.slice(0, 3).map((row: any) => row[0].text)).toEqual(['Redis', 'S3', 'Postgres'])
    expect(kb[3][0].text).toBe('Done')
  })

  it('single-select question renders tap-to-resolve buttons with no Done (unchanged)', async () => {
    await (connector as any).sendUserRequestCard('123', {
      type: 'user_question_request',
      toolUseId: 'tu-single',
      questions: [{ question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }] }],
    })
    const kb = sent[0].reply_markup.inline_keyboard
    expect(kb.map((row: any) => row[0].text)).toEqual(['A', 'B'])
  })

  it('tapping a multiSelect option toggles a checkmark and does not resolve', async () => {
    await (connector as any).sendUserRequestCard('123', multiSelectEvent())
    const kb = sent[0].reply_markup.inline_keyboard
    const ctx = makeCbCtx(kb[0][0].callback_data) // Redis
    await (connector as any).handleCallbackQuery(ctx)
    expect(ctx.editMessageReplyMarkup).toHaveBeenCalled()
    const newKb = ctx.editMessageReplyMarkup.mock.calls[0][0].reply_markup.inline_keyboard
    expect(newKb[0][0].text).toBe('✅ Redis')
    expect(responses).toHaveLength(0)
  })

  it('Done resolves with the checked options joined by ", "', async () => {
    await (connector as any).sendUserRequestCard('123', multiSelectEvent())
    const kb = sent[0].reply_markup.inline_keyboard
    await (connector as any).handleCallbackQuery(makeCbCtx(kb[0][0].callback_data)) // Redis
    await (connector as any).handleCallbackQuery(makeCbCtx(kb[1][0].callback_data)) // S3
    await (connector as any).handleCallbackQuery(makeCbCtx(kb[3][0].callback_data)) // Done
    expect(responses).toHaveLength(1)
    expect(responses[0].toolUseId).toBe('tu-multi')
    expect(responses[0].response.answer).toBe('Redis, S3')
  })

  it('re-tapping a checked option unchecks it (callback is not consumed on tap)', async () => {
    await (connector as any).sendUserRequestCard('123', multiSelectEvent())
    const kb = sent[0].reply_markup.inline_keyboard
    const redisCb = kb[0][0].callback_data
    await (connector as any).handleCallbackQuery(makeCbCtx(redisCb)) // check
    const ctx2 = makeCbCtx(redisCb)
    await (connector as any).handleCallbackQuery(ctx2) // uncheck
    const newKb = ctx2.editMessageReplyMarkup.mock.calls[0][0].reply_markup.inline_keyboard
    expect(newKb[0][0].text).toBe('Redis') // ✅ removed
    expect(responses).toHaveLength(0)
  })

  it('Done with nothing checked shows a toast and does not resolve', async () => {
    await (connector as any).sendUserRequestCard('123', multiSelectEvent())
    const kb = sent[0].reply_markup.inline_keyboard
    const doneCtx = makeCbCtx(kb[3][0].callback_data)
    await (connector as any).handleCallbackQuery(doneCtx)
    expect(responses).toHaveLength(0)
    expect(doneCtx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('at least one') }),
    )
  })

  it('text overrides checked boxes on a multiSelect single-question card', async () => {
    await (connector as any).sendUserRequestCard('123', multiSelectEvent())
    const kb = sent[0].reply_markup.inline_keyboard
    await (connector as any).handleCallbackQuery(makeCbCtx(kb[0][0].callback_data)) // check Redis
    const ok = await (connector as any).answerOpenQuestionWithText('123', 'tu-multi', 'use whatever you think best')
    expect(ok).toBe(true)
    expect(responses).toHaveLength(1)
    expect(responses[0].response.answer).toBe('use whatever you think best') // text wins, not 'Redis'
  })
})

describe('TelegramConnector — typed message answers an open question (Other)', () => {
  let connector: TelegramConnector
  let sent: any[]
  let responses: CapturedResponse[]

  beforeEach(() => {
    connector = makeConnector()
    responses = collectInteractiveResponses(connector)
    sent = attachFakeBot(connector).sent
  })

  function singleQuestionEvent(toolUseId = 'tu-q'): any {
    return {
      type: 'user_question_request',
      toolUseId,
      questions: [{ question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'MySQL' }] }],
    }
  }

  it('resolves a single-question card with the typed text as the answer and returns true', async () => {
    await (connector as any).sendUserRequestCard('123', singleQuestionEvent())
    const ok = await (connector as any).answerOpenQuestionWithText('123', 'tu-q', 'actually use SQLite')
    expect(ok).toBe(true)
    expect(responses).toHaveLength(1)
    expect(responses[0].toolUseId).toBe('tu-q')
    expect(responses[0].response.answer).toBe('actually use SQLite')
  })

  it('returns false when no question card is open for the chat', async () => {
    const ok = await (connector as any).answerOpenQuestionWithText('123', 'tu-q', 'hi')
    expect(ok).toBe(false)
    expect(responses).toHaveLength(0)
  })

  it('returns false when the toolUseId does not match the open card (race / stale)', async () => {
    await (connector as any).sendUserRequestCard('123', singleQuestionEvent('tu-q'))
    const ok = await (connector as any).answerOpenQuestionWithText('123', 'a-different-tooluse', 'hi')
    expect(ok).toBe(false)
    expect(responses).toHaveLength(0)
  })

  it('returns false for a multi-question card (v1 falls through to cancel)', async () => {
    await (connector as any).sendUserRequestCard('123', {
      type: 'user_question_request',
      toolUseId: 'tu-mq',
      questions: [
        { question: 'Q1', options: [{ label: 'A' }] },
        { question: 'Q2', options: [{ label: 'B' }] },
      ],
    })
    const ok = await (connector as any).answerOpenQuestionWithText('123', 'tu-mq', 'hi')
    expect(ok).toBe(false)
    expect(responses).toHaveLength(0)
  })

  it('a tapped single-select answer clears the open card so a later text is not consumed', async () => {
    await (connector as any).sendUserRequestCard('123', singleQuestionEvent('tu-q'))
    const kb = sent[0].reply_markup.inline_keyboard
    await (connector as any).handleCallbackQuery(makeCbCtx(kb[0][0].callback_data)) // tap Postgres
    const ok = await (connector as any).answerOpenQuestionWithText('123', 'tu-q', 'too late')
    expect(ok).toBe(false) // card already resolved by the tap
  })

  it('a single-select tap claims the card synchronously so a racing typed answer is rejected', async () => {
    await (connector as any).sendUserRequestCard('123', singleQuestionEvent('tu-q'))
    const kb = sent[0].reply_markup.inline_keyboard
    // Kick off the tap WITHOUT awaiting, then race a typed "Other" answer during its awaits.
    const tap = (connector as any).handleCallbackQuery(makeCbCtx(kb[0][0].callback_data)) // Postgres
    const racingText = await (connector as any).answerOpenQuestionWithText('123', 'tu-q', 'racing other')
    await tap
    expect(racingText).toBe(false) // the tap already owns the resolution
    expect(responses).toHaveLength(1) // exactly one resolution, not two
    expect(responses[0].response.answer).toBe('Postgres')
  })

  it('a fast tap on two different single-select options resolves only once (siblings invalidated)', async () => {
    await (connector as any).sendUserRequestCard('123', singleQuestionEvent('tu-q')) // Postgres / MySQL
    const kb = sent[0].reply_markup.inline_keyboard
    await (connector as any).handleCallbackQuery(makeCbCtx(kb[0][0].callback_data)) // Postgres
    await (connector as any).handleCallbackQuery(makeCbCtx(kb[1][0].callback_data)) // MySQL (stale sibling)
    expect(responses).toHaveLength(1)
    expect(responses[0].response.answer).toBe('Postgres')
  })

  it('a stale sibling tap on the last sub-question of a multi-question card does not double-emit', async () => {
    await (connector as any).sendUserRequestCard('123', {
      type: 'user_question_request',
      toolUseId: 'tu-mq',
      questions: [
        { question: 'Q1', options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'Q2', options: [{ label: 'C' }, { label: 'D' }] },
      ],
    })
    const q1 = sent[0].reply_markup.inline_keyboard
    const q2 = sent[1].reply_markup.inline_keyboard
    await (connector as any).handleCallbackQuery(makeCbCtx(q1[0][0].callback_data, { messageId: 1001 })) // Q1 = A
    await (connector as any).handleCallbackQuery(makeCbCtx(q2[0][0].callback_data, { messageId: 1002 })) // Q2 = C → completes
    await (connector as any).handleCallbackQuery(makeCbCtx(q2[1][0].callback_data, { messageId: 1002 })) // Q2 = D (stale)
    expect(responses).toHaveLength(1) // only the combined _all emit
  })
})

describe('TelegramConnector — dismissOpenCards (cancel strips abandoned cards)', () => {
  let connector: TelegramConnector
  let sent: any[]
  let responses: CapturedResponse[]

  beforeEach(() => {
    connector = makeConnector()
    responses = collectInteractiveResponses(connector)
    sent = attachFakeBot(connector).sent
  })

  function singleQuestionEvent(toolUseId = 'tu-q'): any {
    return {
      type: 'user_question_request',
      toolUseId,
      questions: [{ question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'MySQL' }] }],
    }
  }
  function multiSelectEvent(): any {
    return {
      type: 'user_question_request',
      toolUseId: 'tu-multi',
      questions: [{ question: 'Pick your stack', multiSelect: true, options: [{ label: 'Redis' }, { label: 'S3' }] }],
    }
  }

  it('strips a single-question card and clears it so a later tap/text cannot resolve', async () => {
    await (connector as any).sendUserRequestCard('123', singleQuestionEvent('tu-q'))
    const kb = sent[0].reply_markup.inline_keyboard
    await (connector as any).dismissOpenCards('123')
    expect((connector as any).bot.api.editMessageReplyMarkup).toHaveBeenCalledWith(123, 1001, { reply_markup: { inline_keyboard: [] } })
    expect(await (connector as any).answerOpenQuestionWithText('123', 'tu-q', 'late')).toBe(false)
    await (connector as any).handleCallbackQuery(makeCbCtx(kb[0][0].callback_data)) // stale tap
    expect(responses).toHaveLength(0)
  })

  it('strips a multiSelect single-question card and clears its toggle state', async () => {
    await (connector as any).sendUserRequestCard('123', multiSelectEvent())
    const kb = sent[0].reply_markup.inline_keyboard // [Redis, S3, Done]
    await (connector as any).dismissOpenCards('123')
    expect((connector as any).bot.api.editMessageReplyMarkup).toHaveBeenCalled()
    // Toggle state + callbacks are gone: a stale toggle or Done tap resolves nothing.
    await (connector as any).handleCallbackQuery(makeCbCtx(kb[0][0].callback_data)) // stale Redis toggle
    await (connector as any).handleCallbackQuery(makeCbCtx(kb[2][0].callback_data)) // stale Done
    expect(responses).toHaveLength(0)
    expect(await (connector as any).answerOpenQuestionWithText('123', 'tu-multi', 'late')).toBe(false)
  })

  it('strips every sub-card of a multi-question card and invalidates their callbacks', async () => {
    await (connector as any).sendUserRequestCard('123', {
      type: 'user_question_request',
      toolUseId: 'tu-mq',
      questions: [
        { question: 'Q1', options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'Q2', options: [{ label: 'C' }, { label: 'D' }] },
      ],
    })
    const q1 = sent[0].reply_markup.inline_keyboard
    await (connector as any).dismissOpenCards('123')
    const strippedIds = (connector as any).bot.api.editMessageReplyMarkup.mock.calls.map((c: any) => c[1])
    expect(strippedIds).toContain(1001)
    expect(strippedIds).toContain(1002)
    // Callbacks invalidated: a stale tap on a sub-card option resolves nothing (no deadlocked re-answer).
    await (connector as any).handleCallbackQuery(makeCbCtx(q1[0][0].callback_data, { messageId: 1001 }))
    expect(responses).toHaveLength(0)
  })

  it('is a no-op when no card is open for the chat', async () => {
    await (connector as any).dismissOpenCards('123')
    expect((connector as any).bot.api.editMessageReplyMarkup).not.toHaveBeenCalled()
    expect(responses).toHaveLength(0)
  })

  it('only dismisses cards for the given chat, leaving other chats intact', async () => {
    await (connector as any).sendUserRequestCard('123', singleQuestionEvent('tu-a'))
    await (connector as any).sendUserRequestCard('999', singleQuestionEvent('tu-b'))
    await (connector as any).dismissOpenCards('123')
    expect(await (connector as any).answerOpenQuestionWithText('999', 'tu-b', 'ok')).toBe(true)
  })
})

describe('TelegramConnector — secret/file requests route to the desktop-only fallback', () => {
  let connector: TelegramConnector
  let sent: any[]

  beforeEach(() => {
    connector = makeConnector()
    sent = attachFakeBot(connector).sent
  })

  it('renders a secret_request as the desktop-only fallback, not a "reply with the secret" prompt', async () => {
    await (connector as any).sendUserRequestCard('123', { type: 'secret_request', toolUseId: 'tu-s', secretName: 'OPENAI_API_KEY' })
    const md = sent[0].rich_message.markdown as string
    expect(md).toContain("isn't safe to provide in chat")
    expect(md).not.toMatch(/reply with the secret value/i)
    expect(sent[0].reply_markup).toBeUndefined() // no prompt keyboard — the secret can't be typed in
  })

  it('renders a file_request as the desktop-only fallback', async () => {
    await (connector as any).sendUserRequestCard('123', { type: 'file_request', toolUseId: 'tu-f', description: 'a CSV export' })
    const md = sent[0].rich_message.markdown as string
    expect(md).toContain("isn't supported in chat")
    expect(md).not.toMatch(/please (upload|send) the file/i)
  })
})
