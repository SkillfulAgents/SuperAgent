/**
 * Unit tests for the autopilot preflight reminder on outbound user messages.
 *
 * The SDK `query()` function is mocked and its `prompt` iterable captured so
 * we can inspect the exact SDKUserMessage content blocks the process enqueues:
 *   - While autopilot is 'requested', a real user message carries a second
 *     text block with the preflight <system-reminder>.
 *   - [SYSTEM]-prefixed injections, no-response appends (shouldQuery: false),
 *     and every other autopilot state send the plain single-block message.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type PromptIterable = AsyncIterable<{ message: { content: Array<{ type: string; text: string }> } }>
const prompts: PromptIterable[] = []

// Stub the SDK before importing ClaudeCodeProcess.
vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  function makeQuery() {
    const iter: AsyncIterableIterator<never> & { interrupt: () => Promise<void>; setModel: () => Promise<void> } = {
      [Symbol.asyncIterator]() {
        return this
      },
      next() {
        return new Promise<IteratorResult<never>>(() => {
          /* pending forever — abort handled via AbortController in process */
        })
      },
      return() {
        return Promise.resolve({ value: undefined, done: true } as IteratorResult<never>)
      },
      throw(err?: unknown) {
        return Promise.reject(err)
      },
      interrupt() {
        return Promise.resolve()
      },
      setModel() {
        return Promise.resolve()
      },
    }
    return iter
  }

  return {
    query: vi.fn((args: { prompt: PromptIterable; options: Record<string, unknown> }) => {
      prompts.push(args.prompt)
      return makeQuery()
    }),
  }
})

// MCP server factories are invoked during createQuery; stub them to return
// empty servers. createUserInputMcpServer records its calls so the wiring of
// the autopilotRequested force-load flag can be asserted.
const userInputMcpServerCalls: Array<unknown[]> = []
vi.mock('./mcp-server', () => ({
  createUserInputMcpServer: (...args: unknown[]) => {
    userInputMcpServerCalls.push(args)
    return {}
  },
  createBrowserMcpServer: () => ({}),
  createComputerUseMcpServer: () => ({}),
  createDashboardsMcpServer: () => ({}),
  createAgentsMcpServer: (_getCallerSessionId: () => string) => ({}),
  createChatMcpServer: () => ({}),
}))

vi.mock('./tools/browser', () => ({
  createBrowserTools: () => [],
}))

vi.mock('./tools/computer-use', () => ({
  computerUseTools: [],
}))

vi.mock('./file-hooks', () => ({
  fileHooks: {},
  resolveToolFilePath: () => '',
}))

vi.mock('./input-manager', () => ({
  inputManager: {},
  HUMAN_INPUT_TTL_MS: 24 * 60 * 60 * 1000,
}))

import { ClaudeCodeProcess } from './claude-code'

async function nextMessage(prompt: PromptIterable) {
  const { value } = await prompt[Symbol.asyncIterator]().next()
  return value as { message: { content: Array<{ type: string; text: string }> } }
}

describe('autopilot preflight reminder on outbound messages', () => {
  beforeEach(() => {
    prompts.length = 0
  })

  it("appends the reminder block to a real user message while 'requested'", async () => {
    const process = new ClaudeCodeProcess({
      sessionId: 'reminder-1',
      workingDirectory: '/tmp',
      autopilotState: 'requested',
    })
    await process.start()

    await process.sendMessage('Summarize my unread emails')
    const msg = await nextMessage(prompts[0])

    expect(msg.message.content).toHaveLength(2)
    expect(msg.message.content[0]).toEqual({ type: 'text', text: 'Summarize my unread emails' })
    expect(msg.message.content[1].text).toContain('<system-reminder>')
    expect(msg.message.content[1].text).toContain('mcp__user-input__engage_autopilot')
  })

  it('sends a plain single-block message when autopilot is off (undefined)', async () => {
    const process = new ClaudeCodeProcess({
      sessionId: 'reminder-2',
      workingDirectory: '/tmp',
    })
    await process.start()

    await process.sendMessage('hello')
    const msg = await nextMessage(prompts[0])

    expect(msg.message.content).toHaveLength(1)
  })

  it("sends a plain message while 'engaged' (nudges must not re-trigger preflight)", async () => {
    const process = new ClaudeCodeProcess({
      sessionId: 'reminder-3',
      workingDirectory: '/tmp',
      autopilotState: 'engaged',
    })
    await process.start()

    await process.sendMessage('[SYSTEM] Reviewer: criteria 2 not yet met, continue.')
    const msg = await nextMessage(prompts[0])

    expect(msg.message.content).toHaveLength(1)
  })

  it("skips [SYSTEM] injections and no-response appends even while 'requested'", async () => {
    const process = new ClaudeCodeProcess({
      sessionId: 'reminder-4',
      workingDirectory: '/tmp',
      autopilotState: 'requested',
    })
    await process.start()

    await process.sendMessage('[SYSTEM] The remote MCP server "x" has been registered.')
    await process.sendMessage('chat append', undefined, { shouldQuery: false })

    const iter = prompts[0][Symbol.asyncIterator]()
    const first = (await iter.next()).value as { message: { content: unknown[] } }
    const second = (await iter.next()).value as { message: { content: unknown[] } }
    expect(first.message.content).toHaveLength(1)
    expect(second.message.content).toHaveLength(1)
  })
})

describe('engage_autopilot force-load wiring', () => {
  // The factory's alwaysLoad option only matters if the query build actually
  // passes it — this was once dead code (the options argument was dropped).
  beforeEach(() => {
    userInputMcpServerCalls.length = 0
  })

  it("passes autopilotRequested: true to the user-input server while 'requested'", async () => {
    const process = new ClaudeCodeProcess({
      sessionId: 'wiring-1',
      workingDirectory: '/tmp',
      autopilotState: 'requested',
    })
    await process.start()

    expect(userInputMcpServerCalls).toHaveLength(1)
    expect(userInputMcpServerCalls[0][1]).toEqual({ autopilotRequested: true })
  })

  it('passes autopilotRequested: false in every other state', async () => {
    const process = new ClaudeCodeProcess({
      sessionId: 'wiring-2',
      workingDirectory: '/tmp',
      autopilotState: 'engaged',
    })
    await process.start()

    expect(userInputMcpServerCalls).toHaveLength(1)
    expect(userInputMcpServerCalls[0][1]).toEqual({ autopilotRequested: false })
  })
})
