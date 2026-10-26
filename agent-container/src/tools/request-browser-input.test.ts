import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { inputManager } from '../input-manager'
import { setBrowserState, resetBrowserState } from '../browser-state'
import { ANOTHER_WAY_PATTERN, parseAnotherWay } from './request-browser-input'

/** The page as the handler reads it through the eval route: what "Try another way" control it shows, if any. */
function pageShows(found: { name: string; page: string } | null) {
  // The CLI prints the script's string result JSON-quoted. A fresh response per
  // call: a body reads once, and a second read would look like an unread page.
  const output = JSON.stringify(found ? JSON.stringify(found) : '')
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ success: true, output }), { status: 200 }))
}

// Every test reads the page; by default it shows no other way to verify.
beforeEach(() => {
  pageShows(null)
})

afterEach(() => {
  vi.restoreAllMocks()
})

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
    setBrowserState({ active: true, sessionId: 'sess-1', cdpUrl: 'ws://127.0.0.1:9222', location: 'host' })
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

  it('tells the agent to submit the login after credentials are autofilled', async () => {
    setBrowserState({ active: true, sessionId: 'sess-1', cdpUrl: 'ws://127.0.0.1:9222' })
    const toolUseId = `guard-autofill-${Date.now()}`
    inputManager.setCurrentToolUseId(toolUseId)

    const { requestBrowserInputTool } = await import('./request-browser-input')
    const handler = (requestBrowserInputTool as any).handler
    const resultPromise = handler({
      message: 'Log in to GitHub to finish the submission.',
      requirements: [],
    })

    await vi.waitFor(() => expect(inputManager.hasPending(toolUseId)).toBe(true))
    inputManager.resolve(toolUseId, 'credentials_filled')

    const result = await resultPromise
    expect(result.content[0].text).toContain('Click the login or sign-in button')
    expect(result.content[0].text).toContain('call request_browser_input again')
  })
})

// A sign-in's verification page that offers other ways ("Try another way"):
// the way is the user's to choose, so the first hand-over there is refused
// unless the user was just asked a question.
describe('requestBrowserInputTool verification guard', () => {
  beforeEach(() => {
    resetBrowserState()
    setBrowserState({ active: true, sessionId: 'sess-1', cdpUrl: 'ws://127.0.0.1:9222', location: 'host' })
  })

  afterEach(() => {
    vi.useRealTimers()
    resetBrowserState()
    inputManager.consumeCurrentToolUseId()
  })

  async function handOver(id: string, sessionId?: string) {
    inputManager.setCurrentToolUseId(id, sessionId)
    const { requestBrowserInputTool } = await import('./request-browser-input')
    return (requestBrowserInputTool as any).handler({ message: 'Use the passkey to finish signing in.', requirements: [] })
  }

  async function answered(result: Promise<any>, id: string) {
    await vi.waitFor(() => expect(inputManager.hasPending(id)).toBe(true))
    inputManager.resolve(id, 'done')
    return result
  }

  it('refuses the first hand-over on a page that shows "Try another way", and says why', async () => {
    pageShows({ name: 'Try another way', page: 'https://accounts.example.com/challenge/passkey' })
    const id = `verify-refused-${Date.now()}`
    const result = await handOver(id)

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('the page shows "Try another way"')
    expect(result.content[0].text).toContain('AskUserQuestion')
    expect(inputManager.hasPending(id)).toBe(false)
  })

  it('hands over the second call on the same page in the same session, not in another', async () => {
    const page = 'https://accounts.example.com/challenge/second'
    pageShows({ name: 'Try another way', page })
    expect((await handOver(`verify-first-${Date.now()}`, 'sess-a')).isError).toBe(true)

    // Another session on the same page is refused once in its own right.
    expect((await handOver(`verify-other-first-${Date.now()}`, 'sess-b')).isError).toBe(true)

    const id = `verify-second-${Date.now()}`
    const result = await answered(handOver(id, 'sess-a'), id)
    expect(result.isError).toBeUndefined()
  })

  it('hands over at once when the page shows no other way', async () => {
    const id = `verify-none-${Date.now()}`
    const result = await answered(handOver(id), id)
    expect(result.isError).toBeUndefined()
  })

  it('hands over at once when the page cannot be read', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'))
    const id = `verify-unread-${Date.now()}`
    const result = await answered(handOver(id), id)
    expect(result.isError).toBeUndefined()
  })

  it('hands over at once when the user just answered a question in the session, and refuses again ten minutes on', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const question = `question-${Date.now()}`
    const answer = inputManager.createPendingWithType(question, 'question', { questions: [] }, 'sess-asked')
    inputManager.resolve(question, { 'Which way?': 'Use your passkey' })
    await answer

    pageShows({ name: 'Try another way', page: 'https://accounts.example.com/challenge/asked' })
    const id = `verify-asked-${Date.now()}`
    expect((await answered(handOver(id, 'sess-asked'), id)).isError).toBeUndefined()

    vi.setSystemTime(Date.now() + 11 * 60 * 1000)
    pageShows({ name: 'Try another way', page: 'https://accounts.example.com/challenge/later' })
    expect((await handOver(`verify-later-${Date.now()}`, 'sess-asked')).isError).toBe(true)
  })

  it('does not count a question answered in another session', async () => {
    const question = `question-other-${Date.now()}`
    const answer = inputManager.createPendingWithType(question, 'question', { questions: [] }, 'sess-other')
    inputManager.resolve(question, { 'Anything?': 'Yes' })
    await answer

    pageShows({ name: 'Try another way', page: 'https://accounts.example.com/challenge/other-session' })
    const result = await handOver(`verify-other-${Date.now()}`, 'sess-mine')
    expect(result.isError).toBe(true)
  })
})

describe('ANOTHER_WAY_PATTERN', () => {
  it.each([
    'Try another way',
    'Sign in another way',
    'Other ways to sign in',
    'More ways to verify',
    'Use a different verification option',
    'Choose another method',
    'Verify with something else',
  ])('names a list of ways: %s', (name) => {
    expect(ANOTHER_WAY_PATTERN.test(name)).toBe(true)
  })

  it.each([
    'Use another payment method',
    'Try again',
    'Sign in with Google',
    'Use another account',
    'Next',
  ])('does not name one: %s', (name) => {
    expect(ANOTHER_WAY_PATTERN.test(name)).toBe(false)
  })
})

describe('parseAnotherWay', () => {
  it('reads the result whether or not the CLI quoted it again', () => {
    const found = { name: 'Try another way', page: 'https://accounts.example.com/x' }
    expect(parseAnotherWay(JSON.stringify(JSON.stringify(found)))).toEqual(found)
    expect(parseAnotherWay(JSON.stringify(found))).toEqual(found)
  })

  it('reads no control as none', () => {
    expect(parseAnotherWay('""')).toBeNull()
    expect(parseAnotherWay('')).toBeNull()
    expect(parseAnotherWay('not json')).toBeNull()
    expect(parseAnotherWay(JSON.stringify({ name: '' }))).toBeNull()
  })
})
