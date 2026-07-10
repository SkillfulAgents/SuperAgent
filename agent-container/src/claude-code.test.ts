import { describe, it, expect } from 'vitest'
import { resultNeedsResumeErrorFallback } from './claude-code'

describe('resultNeedsResumeErrorFallback', () => {
  it('wants the fallback only when the error result carries no text at all', () => {
    expect(resultNeedsResumeErrorFallback({})).toBe(true)
    expect(resultNeedsResumeErrorFallback({ error: '', message: '', result: '' })).toBe(true)
  })

  it('keeps existing error/message text untouched', () => {
    expect(resultNeedsResumeErrorFallback({ error: 'boom' })).toBe(false)
    expect(resultNeedsResumeErrorFallback({ message: 'exec failed' })).toBe(false)
  })

  it('respects result text — the modern is_error shape explains itself there', () => {
    // e.g. terminal_reason: api_error from a nonexistent model puts the
    // human-readable explanation in `result`; injecting the "session
    // corrupted" copy next to it would surface the wrong error to the host.
    expect(
      resultNeedsResumeErrorFallback({
        result: "There's an issue with the selected model (claude-nonexistent-9).",
      })
    ).toBe(false)
  })
})
