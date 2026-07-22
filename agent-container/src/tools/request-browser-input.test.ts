import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { inputManager } from '../input-manager'
import { setBrowserState, resetBrowserState } from '../browser-state'

// The browser-close cleanup (`rejectByType('browser_input', …)`) only rejects
// pendings that already exist. If the close lands between the PreToolUse hook
// and createPendingWithType, the handler would create a fresh 24h pending for
// a browser that is already gone — recreating the original hang. The handler
// must therefore refuse to register a request while no browser is active; the
// check and the registration are one synchronous block, so a close processed
// on the same event loop can never interleave between them.
describe('requestBrowserInputTool browser-lifecycle guard', () => {
  beforeEach(() => {
    resetBrowserState()
  })

  afterEach(() => {
    resetBrowserState()
    // Drain any current toolUseId a failing test might leave behind
    inputManager.consumeCurrentToolUseId()
  })

  it('refuses to create a pending when no browser is active (close-before-registration race)', async () => {
    const toolUseId = `guard-closed-${Date.now()}`
    inputManager.setCurrentToolUseId(toolUseId)

    const { requestBrowserInputTool } = await import('./request-browser-input')
    const handler = (requestBrowserInputTool as any).handler

    const result = await handler({
      message: 'Log in to GitHub to finish the submission.',
      requirements: [],
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/browser/i)
    expect(inputManager.hasPending(toolUseId)).toBe(false)
  })

  it('creates a pending normally while the browser is active', async () => {
    setBrowserState({ active: true, sessionId: 'sess-1', cdpUrl: 'ws://127.0.0.1:9222' })
    const toolUseId = `guard-live-${Date.now()}`
    inputManager.setCurrentToolUseId(toolUseId)

    const { requestBrowserInputTool } = await import('./request-browser-input')
    const handler = (requestBrowserInputTool as any).handler

    const resultPromise = handler({
      message: 'Log in to GitHub to finish the submission.',
      requirements: [],
    })

    await vi.waitFor(() => {
      expect(inputManager.hasPending(toolUseId)).toBe(true)
    })

    inputManager.resolve(toolUseId, 'done')

    const result = await resultPromise
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('completed the requested browser interaction')
  })
})
