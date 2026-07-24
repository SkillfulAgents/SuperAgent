/**
 * Abnormal-exit terminal frames + late-join replay of result, task snapshot, idle.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Frame = Record<string, unknown>

function makeQuery(frames: Frame[], terminalError?: Error) {
  let index = 0
  return {
    [Symbol.asyncIterator]() {
      return this
    },
    next() {
      if (index < frames.length) {
        return Promise.resolve({ value: frames[index++], done: false })
      }
      if (terminalError) return Promise.reject(terminalError)
      return Promise.resolve({ value: undefined, done: true })
    },
    return() {
      return Promise.resolve({ value: undefined, done: true })
    },
    throw(err?: unknown) {
      return Promise.reject(err)
    },
    interrupt: () => Promise.resolve(),
    setModel: () => Promise.resolve(),
  }
}

function replayFrames(proc: ClaudeCodeProcess): Frame[] {
  return proc.getLateJoinReplay().filter(
    (frame): frame is Frame => typeof frame === 'object' && frame !== null
  )
}

const running = { type: 'system', subtype: 'session_state_changed', state: 'running' }
const idle = { type: 'system', subtype: 'session_state_changed', state: 'idle' }
const successResult = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 10,
  num_turns: 1,
  usage: { input_tokens: 0, output_tokens: 0 },
}
const errorResult = {
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  duration_ms: 10,
  num_turns: 1,
  usage: { input_tokens: 0, output_tokens: 0 },
}

let queryFactory: () => ReturnType<typeof makeQuery> = () =>
  makeQuery([running], new Error('sdk transport exploded'))

function makeTurnWithBackgroundSnapshotQuery() {
  return makeQuery([
    running,
    {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'wf-1' }],
    },
    successResult,
    { type: 'system', subtype: 'background_tasks_changed', tasks: [] },
    idle,
  ])
}

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(() => queryFactory()),
}))

vi.mock('./mcp-server', () => ({
  createUserInputMcpServer: () => ({}),
  createBrowserMcpServer: () => ({}),
  createComputerUseMcpServer: () => ({}),
  createDashboardsMcpServer: () => ({}),
  createAgentsMcpServer: () => ({}),
  createChatMcpServer: () => ({}),
}))
vi.mock('./tools/browser', () => ({ createBrowserTools: () => [] }))
vi.mock('./tools/computer-use', () => ({ computerUseTools: [] }))
vi.mock('./file-hooks', () => ({ fileHooks: {}, resolveToolFilePath: () => '' }))
vi.mock('./input-manager', () => ({ inputManager: {}, HUMAN_INPUT_TTL_MS: 24 * 60 * 60 * 1000 }))

import { ClaudeCodeProcess } from './claude-code'

async function runToAbnormalExit(): Promise<{ frames: Frame[]; proc: ClaudeCodeProcess }> {
  const proc = new ClaudeCodeProcess({ sessionId: 'terminal-frames', workingDirectory: '/tmp' })
  const frames: Frame[] = []
  proc.on('message', (m: Frame) => frames.push(m))
  await proc.start()
  await vi.waitFor(
    () => {
      expect(frames.some((f) => f.type === 'result')).toBe(true)
    },
    { timeout: 3000 }
  )
  return { frames, proc }
}

describe('abnormal-exit terminal frames', () => {
  beforeEach(() => {
    queryFactory = () => makeQuery([running], new Error('sdk transport exploded'))
  })

  it('emits a terminal session_state_changed after the synthetic error result', async () => {
    const { frames } = await runToAbnormalExit()
    const resultIdx = frames.findIndex((f) => f.type === 'result')
    const terminalAfter = frames
      .slice(resultIdx + 1)
      .some((f) => f.type === 'system' && f.subtype === 'session_state_changed' && f.state === 'idle')
    expect(terminalAfter).toBe(true)
  })

  it('makes the synthetic error result recoverable via late-join replay', async () => {
    const { proc } = await runToAbnormalExit()
    const replay = replayFrames(proc)
    expect(replay.some((f) => f.type === 'result')).toBe(true)
    expect(
      replay.some((f) => f.type === 'system' && f.subtype === 'session_state_changed' && f.state === 'idle')
    ).toBe(true)
  })

  it('emits a synthetic result when a new turn throws after the prior turn reported an error', async () => {
    queryFactory = () =>
      makeQuery([running, errorResult, running], new Error('second turn transport exploded'))
    const proc = new ClaudeCodeProcess({ sessionId: 'consecutive-errors', workingDirectory: '/tmp' })
    const frames: Frame[] = []
    proc.on('message', (message: Frame) => frames.push(message))

    await proc.start()
    await vi.waitFor(
      () => {
        expect(
          frames.some((frame) =>
            frame.type === 'system' && frame.subtype === 'session_state_changed' && frame.state === 'idle'
          )
        ).toBe(true)
      },
      { timeout: 3000 }
    )

    expect(frames.filter((frame) => frame.type === 'result')).toHaveLength(2)
  })
})

describe('late-join replay background task snapshot', () => {
  it('includes the latest background_tasks_changed before idle', async () => {
    queryFactory = () => makeTurnWithBackgroundSnapshotQuery()
    const proc = new ClaudeCodeProcess({ sessionId: 'replay-bg', workingDirectory: '/tmp' })
    const frames: Frame[] = []
    proc.on('message', (m: Frame) => frames.push(m))
    await proc.start()
    await vi.waitFor(
      () => {
        expect(
          frames.some((f) => f.type === 'system' && f.subtype === 'session_state_changed' && f.state === 'idle')
        ).toBe(true)
      },
      { timeout: 3000 }
    )

    const replay = replayFrames(proc)
    const snapIdx = replay.findIndex((f) => f.type === 'system' && f.subtype === 'background_tasks_changed')
    const idleIdx = replay.findIndex(
      (f) => f.type === 'system' && f.subtype === 'session_state_changed' && f.state === 'idle'
    )
    const resultIdx = replay.findIndex((f) => f.type === 'result')
    expect(resultIdx).toBeGreaterThanOrEqual(0)
    expect(snapIdx).toBeGreaterThan(resultIdx)
    expect(idleIdx).toBeGreaterThan(snapIdx)
    expect((replay[snapIdx].tasks as unknown[]).length).toBe(0)
  })

  it('clears a dead process background-task snapshot when the query is replaced', async () => {
    queryFactory = () =>
      makeQuery([
        running,
        { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'dead-task' }] },
        successResult,
        idle,
      ])
    const proc = new ClaudeCodeProcess({ sessionId: 'query-replacement-bg', workingDirectory: '/tmp' })
    const frames: Frame[] = []
    proc.on('message', (message: Frame) => frames.push(message))
    await proc.start()
    await vi.waitFor(() => expect(proc.isRunning()).toBe(false))

    queryFactory = () => makeQuery([running, successResult, idle])
    await proc.sendMessage('start the replacement query')
    await vi.waitFor(() => expect(proc.isRunning()).toBe(false))

    const snapshots = frames.filter(
      (frame) => frame.type === 'system' && frame.subtype === 'background_tasks_changed'
    )
    expect(snapshots.at(-1)?.tasks).toEqual([])
    const replaySnapshot = replayFrames(proc).find(
      (frame) => frame.type === 'system' && frame.subtype === 'background_tasks_changed'
    )
    expect(replaySnapshot?.tasks).toEqual([])
  })
})

describe('late-join replay new-turn evidence', () => {
  it('replays running when a successor turn started after the previous result', async () => {
    queryFactory = () => makeQuery([running, successResult, running])
    const proc = new ClaudeCodeProcess({ sessionId: 'replay-successor-running', workingDirectory: '/tmp' })
    await proc.start()
    await vi.waitFor(() => expect(proc.isRunning()).toBe(false))

    expect(proc.getLateJoinReplay()).toEqual([
      expect.objectContaining({
        type: 'system',
        subtype: 'session_state_changed',
        state: 'running',
        replayed: true,
      }),
    ])
  })
})
