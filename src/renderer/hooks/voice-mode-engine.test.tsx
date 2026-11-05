// @vitest-environment jsdom
import { StrictMode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VoiceConversationEngine } from '@renderer/lib/voice/contracts/conversation'
const mocks = vi.hoisted(() => ({
  engine: 'chained' as VoiceConversationEngine | null,
  stream: { isActive: false, streamingMessage: null as string | null, activeStartTime: null as number | null, streamingToolUses: [], error: null },
  create: vi.fn(),
}))
vi.mock('./use-voice-input', () => ({ useVoiceConversationEngine: () => mocks.engine }))
vi.mock('./use-message-stream', () => ({ useMessageStream: () => mocks.stream }))
vi.mock('./use-messages', () => ({ useInterruptSession: () => ({ mutateAsync: vi.fn() }) }))
vi.mock('@renderer/lib/voice/registry/conversation', () => ({ createVoiceConversation: mocks.create }))
const transcripts = vi.hoisted(() => ({ instances: [] as Array<{ start: ReturnType<typeof vi.fn>; flush: ReturnType<typeof vi.fn>; append: ReturnType<typeof vi.fn> }> }))
vi.mock('@renderer/lib/voice/services/transcript-relay', () => ({ VoiceTranscriptRelay: class {
  start = vi.fn(async (): Promise<{ path: string }> => ({ path: `/workspace/sessions/s1/transcript-${transcripts.instances.indexOf(this)}.md` }))
  flush = vi.fn(async () => {})
  append = vi.fn()
  attach = () => () => {}
  constructor() { transcripts.instances.push(this) }
} }))
import { useVoiceMode } from './use-voice-mode'

beforeEach(() => {
  vi.useFakeTimers()
  transcripts.instances.length = 0
  mocks.engine = 'openai-live'
  mocks.stream = { isActive: false, streamingMessage: null, activeStartTime: null, streamingToolUses: [], error: null }
  mocks.create.mockReset().mockImplementation(() => ({
    capabilities: { speechSpeed: false, spokenTranscript: false, transcript: 'agent-session' }, analyser: null,
    start: vi.fn(async () => {}), close: vi.fn(), setPaused: vi.fn(), setMicrophoneMuted: vi.fn(), setOutputMuted: vi.fn(), acceptAgentEvent: vi.fn(), pressMic: vi.fn(),
  }))
})

afterEach(() => vi.useRealTimers())

describe('session voice engine selection', () => {
  it.each(['chained', 'openai-live', null] as const)('constructs only the selected engine: %s', (engine) => {
    mocks.engine = engine
    const { unmount } = renderHook(() => useVoiceMode({ sessionId: 's1', agentSlug: 'a1', active: true, send: async () => true }))
    expect(mocks.create).toHaveBeenCalledTimes(engine ? 1 : 0)
    if (engine) expect(mocks.create).toHaveBeenCalledWith(engine, expect.objectContaining({ sessionId: 's1', agentSlug: 'a1' }), expect.anything())
    unmount()
    if (engine) expect(mocks.create.mock.results[0].value.close).toHaveBeenCalledOnce()
  })

  it('does not construct or stop an audio engine while voice is inactive', () => {
    mocks.engine = 'openai-live'
    const { unmount } = renderHook(() => useVoiceMode({ sessionId: 's1', agentSlug: 'a1', active: false, send: async () => true }))
    unmount()
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('closes the old engine before starting its replacement', () => {
    mocks.engine = 'chained'
    const { rerender, unmount } = renderHook(() => useVoiceMode({ sessionId: 's1', agentSlug: 'a1', active: true, send: async () => true }))
    const first = mocks.create.mock.results[0].value
    mocks.engine = 'openai-live'
    rerender()
    const second = mocks.create.mock.results[1].value
    expect(first.close.mock.invocationCallOrder[0]).toBeLessThan(second.start.mock.invocationCallOrder[0])
    unmount()
  })

  it.each(['reopen', 'replace engine'] as const)('does not replay the initial handoff after a completed turn: %s', (restart) => {
    const { result, rerender, unmount } = renderHook(({ active }) => useVoiceMode({
      sessionId: 's1', agentSlug: 'a1', active, startWithAgentTurn: true, send: async () => true,
    }), { initialProps: { active: true } })
    mocks.stream = { ...mocks.stream, isActive: true, activeStartTime: 1, streamingMessage: 'Hello' }
    rerender({ active: true })
    mocks.stream = { ...mocks.stream, isActive: false, activeStartTime: null }
    rerender({ active: true })
    if (restart === 'reopen') rerender({ active: false })
    else mocks.engine = 'chained'
    rerender({ active: true })
    act(() => vi.advanceTimersByTime(16_000))
    expect(result.current.error).toBeNull()
    const latestEngine = mocks.create.mock.results.at(-1)!.value
    expect(latestEngine.acceptAgentEvent).toHaveBeenCalledWith({
      type: 'state', state: { active: false, awaiting: false, toolsUsed: false, background: false },
    })
    unmount()
  })

  it('preserves an unacknowledged initial handoff through Strict Mode effect replay', () => {
    const { result, unmount } = renderHook(() => useVoiceMode({
      sessionId: 's1', agentSlug: 'a1', active: true, startWithAgentTurn: true, send: async () => true,
    }), { wrapper: StrictMode })
    expect(mocks.create).toHaveBeenCalledTimes(2)
    act(() => vi.advanceTimersByTime(16_000))
    expect(result.current.error).toContain('no agent activity')
    unmount()
  })

  it('allows a fresh initial handoff for another session', () => {
    mocks.stream.isActive = true
    const { result, rerender, unmount } = renderHook(({ sessionId }) => useVoiceMode({
      sessionId, agentSlug: 'a1', active: true, startWithAgentTurn: true, send: async () => true,
    }), { initialProps: { sessionId: 's1' } })
    mocks.stream.isActive = false
    rerender({ sessionId: 's2' })
    act(() => vi.advanceTimersByTime(16_000))
    expect(result.current.error).toContain('no agent activity')
    unmount()
  })

})

describe('adapter transcript ownership', () => {
  it('creates and announces a separate transcript based on capability, even for an engine with a different name', async () => {
    mocks.engine = 'chained'
    const factory = mocks.create.getMockImplementation()!
    mocks.create.mockImplementation((...args) => ({ ...factory(...args), capabilities: { speechSpeed: false, spokenTranscript: true, transcript: 'separate' } }))
    const notice = vi.fn(async () => {})
    const send = vi.fn(async () => true)
    const { rerender, unmount } = renderHook(({ active }) => useVoiceMode({ sessionId: 's1', agentSlug: 'a1', active, send, onStarted: notice }), { initialProps: { active: true }, wrapper: StrictMode })
    await act(async () => {})
    expect(transcripts.instances).toHaveLength(1)
    expect(notice).toHaveBeenCalledExactlyOnceWith('/workspace/sessions/s1/transcript-0.md')
    const events = mocks.create.mock.calls.at(-1)![2]
    act(() => events.onSpeech({ role: 'user', text: 'Earlier context' }))
    expect(transcripts.instances[0].append).toHaveBeenCalledWith({ role: 'user', text: 'Earlier context' })
    await act(async () => { await events.onCommand({ type: 'submit', text: 'What did I say?' }) })
    expect(transcripts.instances[0].flush.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0])
    rerender({ active: false })
    rerender({ active: true })
    await act(async () => {})
    expect(transcripts.instances).toHaveLength(2)
    expect(notice).toHaveBeenLastCalledWith('/workspace/sessions/s1/transcript-1.md')
    unmount()
  })

  it('creates no file and passes no path when the adapter uses the agent session transcript', async () => {
    const notice = vi.fn(async () => {})
    const { unmount } = renderHook(() => useVoiceMode({ sessionId: 's1', agentSlug: 'a1', active: true, send: async () => true, onStarted: notice }))
    await act(async () => {})
    expect(transcripts.instances).toHaveLength(0)
    expect(notice).toHaveBeenCalledExactlyOnceWith(undefined)
    unmount()
  })
})
