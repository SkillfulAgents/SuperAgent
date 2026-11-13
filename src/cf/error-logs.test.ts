import { describe, expect, it, vi } from 'vitest'
import { errorText, logErrorsAsText } from './error-logs'

describe('logErrorsAsText', () => {
  it("writes a logged error's name and message, not only its stack", () => {
    const error = vi.fn()
    const target = { error, warn: vi.fn() }
    logErrorsAsText(target)

    target.error('Failed to send message:', new TypeError('Session not found'))

    const [label, text] = error.mock.calls[0]
    expect(label).toBe('Failed to send message:')
    expect(text).toMatch(/^TypeError: Session not found\n\s+at /)
  })

  it('leaves arguments that are not errors as they are', () => {
    const warn = vi.fn()
    const target = { error: vi.fn(), warn }
    logErrorsAsText(target)

    target.warn('[workspace] refused upload', { status: 409 })

    expect(warn).toHaveBeenCalledWith('[workspace] refused upload', { status: 409 })
  })
})

describe('errorText', () => {
  it('adds the cause', () => {
    const error = new Error('Workspace restore failed', { cause: new Error('blob for a.txt: 404') })

    expect(errorText(error)).toMatch(/^Error: Workspace restore failed\n[\s\S]*\nCaused by: Error: blob for a.txt: 404/)
  })

  it('adds the heading to a stack that lacks it, as an error rebuilt from another isolate can have', () => {
    const error = new Error('Session not found')
    error.stack = '    at notSent (delivery.ts:374:10)'

    expect(errorText(error)).toBe('Error: Session not found\n    at notSent (delivery.ts:374:10)')
  })
})
