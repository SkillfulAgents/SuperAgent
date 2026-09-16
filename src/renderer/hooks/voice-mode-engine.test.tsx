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
import { useVoiceMode } from './use-voice-mode'

beforeEach(() => {
  vi.useFakeTimers()
  mocks.engine = 'openai-live'
  mocks.stream = { isActive: false, streamingMessage: null, activeStartTime: null, streamingToolUses: [], error: null }
  mocks.create.mockReset().mockImplementation(() => ({
    capabilities: { speechSpeed: false, spokenTranscript: false }, analyser: null,
    start: vi.fn(async () => {}), close: vi.fn(), setPaused: vi.fn(), acceptAgentEvent: vi.fn(), pressMic: vi.fn(),
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
      type: 'state', state: { active: false, awaiting: false, toolsUsed: false },
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
