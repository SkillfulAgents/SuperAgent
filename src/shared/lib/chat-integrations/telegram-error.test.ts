import { describe, expect, it } from 'vitest'
import { GrammyError, HttpError } from 'grammy'
import { isTelegramBusy, isTelegramTemporary, telegramRetryAfter } from './telegram-error'

const answered = (error_code: number) => new GrammyError('Call failed!', { ok: false, error_code, description: 'x' }, 'sendRichMessage', {})

describe('Telegram error classes', () => {
  it.each([[429, true], [500, true], [502, true], [400, false], [404, false], [409, false]])('a %i answer is busy: %s', (code, busy) => {
    expect(isTelegramBusy(answered(code))).toBe(busy)
    expect(isTelegramTemporary(answered(code))).toBe(busy)
  })

  it('treats no answer as temporary but not busy, and other errors as neither', () => {
    const noAnswer = new HttpError("Network request for 'getMe' failed!", undefined)
    expect([isTelegramBusy(noAnswer), isTelegramTemporary(noAnswer)]).toEqual([false, true])
    expect([isTelegramBusy(new Error('x')), isTelegramTemporary(new Error('x'))]).toEqual([false, false])
  })

  it('reads the wait Telegram asked for, when it asked', () => {
    const rateLimited = new GrammyError('Call failed!', { ok: false, error_code: 429, description: 'x', parameters: { retry_after: 9 } }, 'editMessageText', {})
    expect([telegramRetryAfter(rateLimited), telegramRetryAfter(answered(502)), telegramRetryAfter(new Error('x'))]).toEqual([9, undefined, undefined])
  })
})
