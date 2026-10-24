/**
 * Unsupported CLI built-ins (SUP-1345): a send whose text would run one (for
 * example /clear, which starts a CLI session the host never sees) goes to the
 * CLI as a client-composed turn, which the CLI delivers to the model as typed.
 * The menu leaves those built-ins out, and a skill that has a built-in's alias
 * as its name keeps running.
 *
 * The SDK is mocked as a controllable stream: tests push the frames the CLI
 * would write and read what the process queued for it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SDKUserMessage, SlashCommand } from '@anthropic-ai/claude-agent-sdk'

type Frame = Record<string, unknown>

interface MockQuery {
  push: (frame: Frame) => void
  prompt: { drain: () => SDKUserMessage[] }
}

const queries: MockQuery[] = []
// What supportedCommands() answers, per query.
let supportedCommands: () => Promise<SlashCommand[]>

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  function makeQuery(args: { prompt: MockQuery['prompt']; options: { abortController: AbortController } }) {
    const signal = args.options.abortController.signal
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const buffered: Frame[] = []
    let waiting: { resolve: (r: IteratorResult<Frame>) => void; reject: (e: unknown) => void } | null = null
    const push = (frame: Frame) => {
      if (waiting) {
        const w = waiting
        waiting = null
        w.resolve({ value: frame, done: false })
      } else {
        buffered.push(frame)
      }
    }
    signal.addEventListener('abort', () => {
      if (waiting) {
        const w = waiting
        waiting = null
        w.reject(abortError)
      }
    })
    const query: MockQuery & Record<string, unknown> = {
      push,
      prompt: args.prompt,
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
      interrupt: () => Promise.resolve(),
      setModel: () => Promise.resolve(),
      supportedCommands: () => supportedCommands(),
    }
    queries.push(query)
    return query
  }

  return {
    query: vi.fn((args: { prompt: MockQuery['prompt']; options: { abortController: AbortController } }) => makeQuery(args)),
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
vi.mock('./tools/computer-use', () => ({ computerUseTools: [] }))
vi.mock('./file-hooks', () => ({ fileHooks: {}, resolveToolFilePath: () => '' }))
vi.mock('./input-manager', () => ({ inputManager: {}, HUMAN_INPUT_TTL_MS: 24 * 60 * 60 * 1000 }))

import { ClaudeCodeProcess } from './claude-code'

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

// Shaped like the CLI 2.1.303 initialize response: .claude/skills/reset with
// `name: Reset Board` is listed under its display title, with no aliases.
const CLI_COMMANDS: SlashCommand[] = [
  { name: 'weekly-report', description: 'Weekly report (project)', argumentHint: '' },
  { name: 'Reset Board', description: 'Reset the weekly board (project)', argumentHint: '' },
  { name: 'clear', description: 'Start a new session', argumentHint: '[name]', aliases: ['reset', 'new'], builtin: true },
  { name: 'compact', description: 'Free up context', argumentHint: '<instructions>', builtin: true },
  { name: 'model', description: 'Set the AI model', argumentHint: '<model>', builtin: true },
]

const initFrame = (slashCommands: string[]): Frame => ({
  type: 'system', subtype: 'init', session_id: 'sess-1', slash_commands: slashCommands, capabilities: [],
})

function sent(query: MockQuery) {
  return query.prompt.drain().map((message) => ({
    text: (message.message.content as Array<{ text: string }>)[0].text,
    clientComposed: message.client_composed === true,
  }))
}

describe('ClaudeCodeProcess unsupported CLI built-ins', () => {
  let proc: ClaudeCodeProcess | null = null

  beforeEach(() => {
    queries.length = 0
    supportedCommands = () => Promise.resolve(CLI_COMMANDS)
  })

  afterEach(async () => {
    await proc?.stop()
    proc = null
  })

  it("guards a cold session's first message, before system/init has listed anything", async () => {
    proc = new ClaudeCodeProcess({ sessionId: 's1', workingDirectory: '/tmp' })

    await proc.sendMessage('/clear')
    await proc.sendMessage('/weekly-report')

    expect(queries).toHaveLength(1)
    expect(sent(queries[0])).toEqual([
      { text: '/clear', clientComposed: true },
      { text: '/weekly-report', clientComposed: false },
    ])
  })

  it('keeps a skill named like a built-in alias in the menu and runnable', async () => {
    proc = new ClaudeCodeProcess({ sessionId: 's2', workingDirectory: '/tmp' })
    await proc.start()
    queries[0].push(initFrame(['weekly-report', 'reset', 'clear', 'compact', 'model']))
    await tick()

    expect(proc.slashCommands.map((command) => command.name)).toEqual(['weekly-report', 'reset', 'compact'])

    await proc.sendMessage('/reset weekly')
    await proc.sendMessage('/new')
    expect(sent(queries[0])).toEqual([
      { text: '/reset weekly', clientComposed: false },
      { text: '/new', clientComposed: true },
    ])
  })

  it('follows the latest system/init when that skill goes away', async () => {
    proc = new ClaudeCodeProcess({ sessionId: 's3', workingDirectory: '/tmp' })
    await proc.start()
    queries[0].push(initFrame(['weekly-report', 'reset', 'clear', 'compact', 'model']))
    await tick()
    supportedCommands = () => Promise.resolve(CLI_COMMANDS.filter((command) => command.name !== 'Reset Board'))
    queries[0].push(initFrame(['weekly-report', 'clear', 'compact', 'model']))
    await tick()

    await proc.sendMessage('/reset weekly')
    expect(sent(queries[0])).toEqual([{ text: '/reset weekly', clientComposed: true }])
  })

  it('still blocks /clear when the command list cannot be read', async () => {
    supportedCommands = () => Promise.reject(new Error('initialize failed'))
    proc = new ClaudeCodeProcess({ sessionId: 's4', workingDirectory: '/tmp' })
    await proc.start()

    await proc.sendMessage('/clear')
    await proc.sendMessage('/model opus')
    expect(sent(queries[0])).toEqual([
      { text: '/clear', clientComposed: true },
      { text: '/model opus', clientComposed: false },
    ])
  })

  it('a stop landing while the first slash command waits for the list restarts instead of losing it', async () => {
    let answer!: (commands: SlashCommand[]) => void
    supportedCommands = () => new Promise((resolve) => { answer = resolve })
    proc = new ClaudeCodeProcess({ sessionId: 's5', workingDirectory: '/tmp' })
    await proc.start()

    const send = proc.sendMessage('/clear')
    await tick()
    const stop = proc.stop()
    answer(CLI_COMMANDS)
    await send
    await stop

    expect(queries).toHaveLength(2)
    expect(sent(queries[1])).toEqual([{ text: '/clear', clientComposed: true }])
    expect(proc.isRunning()).toBe(true)
  })
})
