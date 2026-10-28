import { describe, it, expect } from 'vitest'
import { classifyResult } from './result-classification'

describe('classifyResult', () => {
  it('classifies legacy error subtypes', () => {
    expect(classifyResult({ subtype: 'error', error: 'boom' })).toMatchObject({
      isError: true,
      errorText: 'boom',
    })
    expect(classifyResult({ subtype: 'error_during_execution', message: 'exec failed' })).toMatchObject({
      isError: true,
      errorText: 'exec failed',
    })
  })

  it('classifies the modern success-subtype error shape (real 0.3.206 capture)', () => {
    // Verbatim field subset from the sdk206-error-turn-invalid-model fixture.
    const c = classifyResult({
      subtype: 'success',
      is_error: true,
      api_error_status: 404,
      terminal_reason: 'api_error',
      result: "There's an issue with the selected model (claude-nonexistent-9). It may not exist or you may not have access to it.",
      error: 'This session could not be resumed (it may have been corrupted by a previous crash). Please start a new session.',
    })
    expect(c.isError).toBe(true)
    expect(c.terminalReason).toBe('api_error')
    expect(c.apiErrorStatus).toBe(404)
    // Legacy carriers keep precedence when set (old containers still inject
    // the resume copy); once the container-side fallback guard ships, `error`
    // is absent for this shape and the model-facing text surfaces.
    expect(c.errorText).toContain('could not be resumed')
  })

  it('uses the result text when error/message are absent', () => {
    const c = classifyResult({
      subtype: 'success',
      is_error: true,
      terminal_reason: 'api_error',
      result: 'The selected model does not exist.',
    })
    expect(c.isError).toBe(true)
    expect(c.errorText).toBe('The selected model does not exist.')
  })

  it('treats error-indicating terminal_reason as an error even without is_error', () => {
    for (const reason of [
      'api_error',
      'budget_exhausted',
      'malformed_tool_use_exhausted',
      'structured_output_retry_exhausted',
      'tool_deferred_unavailable',
      'turn_setup_failed',
    ]) {
      expect(classifyResult({ subtype: 'success', terminal_reason: reason }).isError, reason).toBe(true)
    }
  })

  it('classifies gracefully interrupted turns as interrupts, not errors (real 0.3.206 capture)', () => {
    // Verbatim field subset from the sdk206-queued-message-interrupt-receipt
    // fixture: error-shaped (is_error + error_during_execution) but a
    // deliberate stop.
    const c = classifyResult({
      subtype: 'error_during_execution',
      is_error: true,
      terminal_reason: 'aborted_tools',
    })
    expect(c.isInterrupt).toBe(true)
    expect(c.isError).toBe(false)
    expect(c.errorText).toBeNull()

    expect(classifyResult({ subtype: 'error', terminal_reason: 'aborted_streaming' })).toMatchObject({
      isInterrupt: true,
      isError: false,
    })
  })

  it('keeps successful and unknown-reason turns as success (open-world)', () => {
    expect(classifyResult({ subtype: 'success', terminal_reason: 'completed' }).isError).toBe(false)
    // A future terminal_reason value we do not know must not flip a turn that
    // does not otherwise claim to be an error.
    expect(classifyResult({ subtype: 'success', terminal_reason: 'some_future_reason' }).isError).toBe(false)
    expect(classifyResult({ subtype: 'success' })).toMatchObject({
      isError: false,
      errorText: null,
      terminalReason: null,
    })
  })

  it('degrades malformed fields to absent instead of throwing', () => {
    const c = classifyResult({ subtype: 'success', is_error: 'yes', terminal_reason: 42, result: { odd: true } })
    expect(c.isError).toBe(false)
    expect(c.terminalReason).toBeNull()
    expect(classifyResult(null).isError).toBe(false)
    expect(classifyResult('not an object').isError).toBe(false)
  })

  it('falls back to generic copy for a textless error and carries fatal through', () => {
    const c = classifyResult({ subtype: 'error', fatal: true })
    expect(c.errorText).toBe('An error occurred during execution')
    expect(c.fatal).toBe(true)
  })
})
