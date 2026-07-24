/**
 * Abnormal-exit terminal frames + late-join replay of result, task snapshot, idle.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Frame = Record<string, unknown>

let queryFactory: () => ReturnType<typeof makeThrowingQuery> = () => makeThrowingQuery()

function makeThrowingQuery() {
  let step = 0
  return {
    [Symbol.asyncIterator]() {
      return this
    },
    next() {
      step++
      if (step === 1) {
        return Promise.resolve({
          value: { type: 'system', subtype: 'session_state_changed', state: 'running' },
          done: false,
        })
      }
      return Promise.reject(new Error('sdk transport exploded'))
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

function makeTurnWithBackgroundSnapshotQuery() {
  const frames: Frame[] = [
    { type: 'system', subtype: 'session_state_changed', state: 'running' },
    {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'wf-1' }],
    },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 10,
      num_turns: 1,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
    { type: 'system', subtype: 'background_tasks_changed', tasks: [] },
    { type: 'system', subtype: 'session_state_changed', state: 'idle' },
  ]
  let i = 0
  return {
    [Symbol.asyncIterator]() {
      return this
    },
    next() {
      if (i < frames.length) {
        return Promise.resolve({ value: frames[i++], done: false })
      }
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
    queryFactory = () => makeThrowingQuery()
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
    const replay = proc.getLateJoinReplay() as Frame[]
    expect(replay.some((f) => f.type === 'result')).toBe(true)
    expect(
      replay.some((f) => f.type === 'system' && f.subtype === 'session_state_changed' && f.state === 'idle')
    ).toBe(true)
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

    const replay = proc.getLateJoinReplay() as Frame[]
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
})
