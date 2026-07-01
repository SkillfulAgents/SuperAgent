import { describe, it, expect } from 'vitest'
import { consumeOrCancelAwaitingInput } from './resolve-awaiting-input'

interface Recorder {
  awaiting: boolean
  pending: Array<{ type: string; toolUseId: string }>
  answerResult: boolean
  calls: string[]
  answerArgs?: { chatId: string; toolUseId: string; text: string }
}

function makeDeps(over: Partial<Recorder> = {}) {
  const rec: Recorder = { awaiting: false, pending: [], answerResult: false, calls: [], ...over }
  const persister = {
    isSessionAwaitingInput: () => rec.awaiting,
    getPendingInputRequests: () => rec.pending,
    cancelAwaitingInput: async () => { rec.calls.push('cancel') },
  }
  const connector = {
    answerOpenQuestionWithText: async (chatId: string, toolUseId: string, text: string) => {
      rec.calls.push('answer')
      rec.answerArgs = { chatId, toolUseId, text }
      return rec.answerResult
    },
    dismissOpenCards: async () => { rec.calls.push('dismiss') },
  }
  return { rec, persister, connector }
}

const base = { sessionId: 's1', agentSlug: 'agent', chatId: 'c1' }

describe('consumeOrCancelAwaitingInput', () => {
  it('resolves an open question with plain text and consumes the message (no cancel/dismiss)', async () => {
    const { rec, persister, connector } = makeDeps({
      awaiting: true,
      pending: [{ type: 'user_question_request', toolUseId: 't1' }],
      answerResult: true,
    })
    const consumed = await consumeOrCancelAwaitingInput({ ...base, messageText: 'my answer', hasFiles: false, persister, connector })
    expect(consumed).toBe(true)
    expect(rec.calls).toEqual(['answer'])
    expect(rec.answerArgs).toEqual({ chatId: 'c1', toolUseId: 't1', text: 'my answer' })
  })

  it('resolves with the raw answerText, not the group-prefixed messageText, when both are given', async () => {
    const { rec, persister, connector } = makeDeps({
      awaiting: true,
      pending: [{ type: 'user_question_request', toolUseId: 't1' }],
      answerResult: true,
    })
    // messageText carries the `\[Alice]: ` sender prefix (for the fresh-turn forward); the answer
    // sent to the model must be the raw text only.
    const consumed = await consumeOrCancelAwaitingInput({
      ...base,
      messageText: '\\[Alice]: option nobody listed',
      answerText: 'option nobody listed',
      hasFiles: false,
      persister,
      connector,
    })
    expect(consumed).toBe(true)
    expect(rec.answerArgs?.text).toBe('option nobody listed')
  })

  it('cancels and dismisses when the open question declines the typed text', async () => {
    const { rec, persister, connector } = makeDeps({
      awaiting: true,
      pending: [{ type: 'user_question_request', toolUseId: 't1' }],
      answerResult: false,
    })
    const consumed = await consumeOrCancelAwaitingInput({ ...base, messageText: 'redirect me', hasFiles: false, persister, connector })
    expect(consumed).toBe(false)
    expect(rec.calls).toEqual(['answer', 'cancel', 'dismiss'])
  })

  it('does not attempt to answer with a file/non-text message — cancels and dismisses', async () => {
    const { rec, persister, connector } = makeDeps({
      awaiting: true,
      pending: [{ type: 'user_question_request', toolUseId: 't1' }],
    })
    const consumed = await consumeOrCancelAwaitingInput({ ...base, messageText: 'caption', hasFiles: true, persister, connector })
    expect(consumed).toBe(false)
    expect(rec.calls).toEqual(['cancel', 'dismiss'])
  })

  it('cancels and dismisses when awaiting a non-question request (e.g. secret)', async () => {
    const { rec, persister, connector } = makeDeps({
      awaiting: true,
      pending: [{ type: 'secret_request', toolUseId: 't9' }],
    })
    const consumed = await consumeOrCancelAwaitingInput({ ...base, messageText: 'hello', hasFiles: false, persister, connector })
    expect(consumed).toBe(false)
    expect(rec.calls).toEqual(['cancel', 'dismiss'])
  })

  it('cancels and dismisses (both no-ops downstream) when not awaiting input', async () => {
    const { rec, persister, connector } = makeDeps({ awaiting: false })
    const consumed = await consumeOrCancelAwaitingInput({ ...base, messageText: 'hi', hasFiles: false, persister, connector })
    expect(consumed).toBe(false)
    expect(rec.calls).toEqual(['cancel', 'dismiss'])
  })

  it('treats a whitespace-only message as non-text and does not answer', async () => {
    const { rec, persister, connector } = makeDeps({
      awaiting: true,
      pending: [{ type: 'user_question_request', toolUseId: 't1' }],
    })
    const consumed = await consumeOrCancelAwaitingInput({ ...base, messageText: '   ', hasFiles: false, persister, connector })
    expect(consumed).toBe(false)
    expect(rec.calls).toEqual(['cancel', 'dismiss'])
  })
})
