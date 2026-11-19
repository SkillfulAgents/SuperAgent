/**
 * AskUserQuestion goes through canUseTool, which parks on the input manager
 * until the host answers or declines. A decline the person chose (the card's
 * Decline, `unanswered: 'skipped'`) ends the question as an annotated answer
 * when the CLI advertises `ask_user_question_unanswered_v1`: the model reads
 * the reason in `answers`, the transcript records how it ended. Any other
 * rejection, or a CLI without the capability, keeps the deny.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type Frame = Record<string, unknown>

const queryCalls: Array<{ options: Record<string, unknown> }> = []
const pushers: Array<(frame: Frame) => void> = []

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  function makeQuery(args: { options: { abortController: AbortController } }) {
    const signal = args.options.abortController.signal
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const buffered: Frame[] = []
    let waiting: { resolve: (r: IteratorResult<Frame>) => void; reject: (e: unknown) => void } | null = null
    pushers.push((frame) => {
      if (waiting) {
        const w = waiting
        waiting = null
        w.resolve({ value: frame, done: false })
      } else {
        buffered.push(frame)
      }
    })
    signal.addEventListener('abort', () => {
      if (waiting) {
        const w = waiting
        waiting = null
        w.reject(abortError)
      }
    })
    return {
      [Symbol.asyncIterator]() {
        return this
      },
      next() {
        return new Promise<IteratorResult<Frame>>((resolve, reject) => {
          if (buffered.length > 0) resolve({ value: buffered.shift()!, done: false })
          else if (signal.aborted) reject(abortError)
          else waiting = { resolve, reject }
        })
      },
      return() {
        return Promise.resolve({ value: undefined, done: true } as IteratorResult<Frame>)
      },
      throw(err?: unknown) {
        return Promise.reject(err)
      },
      interrupt: async () => ({ still_queued: [] }),
      setModel: () => Promise.resolve(),
      supportedCommands: () => Promise.resolve([]),
    }
  }
  return {
    query: vi.fn((args: { options: { abortController: AbortController } }) => {
      queryCalls.push(args as unknown as { options: Record<string, unknown> })
      return makeQuery(args)
    }),
  }
})

vi.mock('./mcp-server', () => ({
  createUserInputMcpServer: () => ({}),
  createBrowserMcpServer: () => ({}),
  createComputerUseMcpServer: () => ({}),
  createDashboardsMcpServer: () => ({}),
  createAgentsMcpServer: () => ({}),
  createChatMcpServer: () => ({}),
  createMeetingsMcpServer: () => ({}),
  createRulesMcpServer: () => ({}),
  createWidgetsMcpServer: () => ({}),
}))
vi.mock('./tools/browser', () => ({ createBrowserTools: () => [] }))
vi.mock('./tools/computer-use', () => ({ COMPUTER_USE_SERVER: 'agent-desktop', COMPUTER_USE_TOOL_PREFIX: 'mcp__agent-desktop__', computerUseTools: [] }))
vi.mock('./file-hooks', () => ({ fileHooks: {}, resolveToolFilePath: () => '' }))

import { ClaudeCodeProcess } from './claude-code'
import { inputManager } from './input-manager'

type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { toolUseID: string; signal: AbortSignal },
) => Promise<Record<string, unknown>>

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

const QUESTIONS = [
  { question: 'Which color?', header: 'Color', options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }], multiSelect: false },
]

async function startProcess(capabilities: string[]) {
  const proc = new ClaudeCodeProcess({ sessionId: 's1', workingDirectory: '/tmp' })
  await proc.start()
  pushers[0]({ type: 'system', subtype: 'init', session_id: 'sess-1', slash_commands: [], capabilities })
  await tick()
  return { proc, canUseTool: queryCalls[0].options.canUseTool as CanUseTool }
}

/** Ask, then let the host settle the pending question with `settle`. */
async function ask(canUseTool: CanUseTool, toolUseID: string, settle: () => void) {
  const answer = canUseTool('AskUserQuestion', { questions: QUESTIONS }, { toolUseID, signal: new AbortController().signal })
  await tick(5)
  settle()
  return answer
}

describe('ClaudeCodeProcess AskUserQuestion decline', () => {
  let proc: ClaudeCodeProcess | null = null

  beforeEach(() => {
    queryCalls.length = 0
    pushers.length = 0
  })

  afterEach(async () => {
    await proc?.stop()
    proc = null
  })

  it('answers a skipped question with its reason, annotated unanswered', async () => {
    let canUseTool: CanUseTool
    ;({ proc, canUseTool } = await startProcess(['ask_user_question_unanswered_v1']))

    const result = await ask(canUseTool, 'ask-1', () => inputManager.reject('ask-1', 'Not now, thanks', 'skipped'))

    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: {
        questions: QUESTIONS,
        answers: { 'Which color?': 'Not now, thanks' },
        annotations: { 'Which color?': { unanswered: 'skipped' } },
      },
    })
  })

  it('keeps the deny when the CLI does not advertise the capability', async () => {
    let canUseTool: CanUseTool
    ;({ proc, canUseTool } = await startProcess(['interrupt_receipt_v1']))

    const result = await ask(canUseTool, 'ask-2', () => inputManager.reject('ask-2', 'Not now, thanks', 'skipped'))

    expect(result).toEqual({ behavior: 'deny', message: 'Not now, thanks' })
  })

  it('keeps the deny for a rejection that was not the person declining', async () => {
    let canUseTool: CanUseTool
    ;({ proc, canUseTool } = await startProcess(['ask_user_question_unanswered_v1']))

    const result = await ask(canUseTool, 'ask-3', () => inputManager.reject('ask-3', 'Superseded: the user sent a new message.'))

    expect(result).toEqual({ behavior: 'deny', message: 'Superseded: the user sent a new message.' })
  })

  it('passes answers through unchanged', async () => {
    let canUseTool: CanUseTool
    ;({ proc, canUseTool } = await startProcess(['ask_user_question_unanswered_v1']))

    const result = await ask(canUseTool, 'ask-4', () => inputManager.resolve('ask-4', { 'Which color?': 'Blue' }))

    expect(result).toEqual({ behavior: 'allow', updatedInput: { questions: QUESTIONS, answers: { 'Which color?': 'Blue' } } })
  })
})
