// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveRequest, VoiceTranscriptEntry } from '@shared/lib/voice/live-types'

interface Callbacks {
  onRequest: (request: LiveRequest) => Promise<boolean>
  onReady: () => void
  onClosed: () => void
  onSpeaking: (value: boolean) => void
  onInputSpeaking: (value: boolean) => void
  onUtterance: (text: string) => void
  onTranscript: (entries: VoiceTranscriptEntry[]) => void
}
const mocks = vi.hoisted(() => ({
  stopMusic: vi.fn(),
  fadeMusic: vi.fn(),
  stream: { activeStartTime: null as number | null, isActive: false, streamingMessage: null as string | null, error: null as string | null },
  interrupt: vi.fn(async () => ({})),
  instances: [] as Array<{ callbacks: Callbacks; close: ReturnType<typeof vi.fn>; updateReply: ReturnType<typeof vi.fn>; setPaused: ReturnType<typeof vi.fn>; pressMic: ReturnType<typeof vi.fn> }>,
}))
vi.mock('@renderer/lib/voice/shared/speech/hold-sound', () => ({ holdSound: { stopImmediately: mocks.stopMusic, stop: mocks.fadeMusic } }))
vi.mock('./use-message-stream', () => ({ useMessageStream: () => mocks.stream }))
vi.mock('./use-messages', () => ({ useInterruptSession: () => ({ mutateAsync: mocks.interrupt }) }))
vi.mock('@renderer/lib/voice/providers/openai/live-session', () => ({
  OpenAILiveConversation: class {
    analyser = null
    close = vi.fn()
    updateReply = vi.fn()
    setPaused = vi.fn()
    setBusy = vi.fn()
    resetReply = vi.fn()
    nextReplySegment = vi.fn()
    pressMic = vi.fn()
    start = vi.fn()
    constructor(public callbacks: Callbacks) { mocks.instances.push(this) }
  },
}))
vi.mock('./use-voice-input', () => ({ useVoiceConversationEngine: () => 'openai-live' }))
import { useVoiceMode } from './use-voice-mode'

function setup() {
  const send = vi.fn(async () => true)
  const hook = renderHook(({ active, paused }) => useVoiceMode({ sessionId: 's1', agentSlug: 'agent', active, paused, send }), { initialProps: { active: true, paused: false } })
  const adapter = mocks.instances.at(-1)!
  act(() => adapter.callbacks.onReady())
  return { ...hook, adapter, send }
}
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); mocks.instances.length = 0; mocks.stream = { activeStartTime: null, isActive: false, streamingMessage: null, error: null }; mocks.interrupt.mockResolvedValue({}) })

afterEach(() => vi.useRealTimers())

describe('Live session hook', () => {
  it('sends normalized requests and forwards the new streamed reply', async () => {
    const { adapter, send, rerender, unmount } = setup()
    await act(async () => { expect(await adapter.callbacks.onRequest({ action: 'message', text: 'Find Thursday.' })).toBe(true) })
    expect(send).toHaveBeenCalledWith('Find Thursday.')
    mocks.stream = { ...mocks.stream, isActive: true, streamingMessage: 'Checking Thursday.' }
    rerender({ active: true, paused: false })
    expect(adapter.updateReply).toHaveBeenLastCalledWith('Checking Thursday.', false)
    unmount()
  })

  it('keeps spoken subtitles across phases and clears them on a new voice session', () => {
    const { adapter, result, rerender, unmount } = setup()
    const spoken: VoiceTranscriptEntry[] = [
      { role: 'user', text: 'Hello.' }, { role: 'assistant', text: 'Hi there.' },
    ]
    act(() => { adapter.callbacks.onTranscript(spoken); adapter.callbacks.onSpeaking(true) })
    expect(result.current.transcript).toEqual(spoken)
    act(() => { adapter.callbacks.onUtterance(''); adapter.callbacks.onSpeaking(false) })
    expect(result.current.transcript).toEqual(spoken)
    rerender({ active: false, paused: false })
    rerender({ active: true, paused: false })
    expect(result.current.transcript).toEqual([])
    act(() => adapter.callbacks.onTranscript(spoken))
    expect(result.current.transcript).toEqual([])
    unmount()
  })

  it('waits for successful interruption before replacing work and suppresses old output meanwhile', async () => {
    mocks.stream = { ...mocks.stream, isActive: true, streamingMessage: 'Old answer' }
    let acknowledge!: () => void
    mocks.interrupt.mockImplementationOnce(() => new Promise((resolve) => { acknowledge = () => resolve({}) }))
    const { adapter, send, rerender, unmount } = setup()
    let pending!: Promise<boolean>
    act(() => { pending = adapter.callbacks.onRequest({ action: 'message', text: 'Use Thursday.' }) })
    mocks.stream = { ...mocks.stream, streamingMessage: 'Old answer continuing' }
    rerender({ active: true, paused: false })
    expect(send).not.toHaveBeenCalled()
    expect(adapter.updateReply).not.toHaveBeenCalled()
    await act(async () => { acknowledge(); await pending })
    expect(send).toHaveBeenCalledExactlyOnceWith('Use Thursday.')
    unmount()
  })

  it('does not send a replacement when cancellation fails', async () => {
    mocks.stream.isActive = true
    mocks.interrupt.mockRejectedValueOnce(new Error('Cancellation failed'))
    const { adapter, send, result, unmount } = setup()
    await act(async () => { expect(await adapter.callbacks.onRequest({ action: 'message', text: 'Thursday.' })).toBe(false) })
    expect(send).not.toHaveBeenCalled()
    expect(result.current.error).toBe('Cancellation failed')
    unmount()
  })

  it('recognizes a new turn even if React never renders the intermediate idle state', async () => {
    mocks.stream = { ...mocks.stream, isActive: true, activeStartTime: 100, streamingMessage: 'Previous answer' }
    const { adapter, result, rerender, unmount } = setup()
    await act(async () => { await adapter.callbacks.onRequest({ action: 'message', text: 'Change the plan.' }) })
    mocks.stream = { ...mocks.stream, activeStartTime: 200 }
    rerender({ active: true, paused: false })
    // Extended thinking/tool work can go far longer than fifteen seconds.
    act(() => vi.advanceTimersByTime(60_000))
    expect(result.current.error).toBeNull()
    expect(result.current.working).toBe(true)
    expect(adapter.updateReply).not.toHaveBeenCalledWith('Previous answer', false)
    unmount()
  })

  it('clears a delayed-activity warning when the agent starts, without requiring text', async () => {
    const { adapter, result, rerender, unmount } = setup()
    await act(async () => { await adapter.callbacks.onRequest({ action: 'message', text: 'Research this.' }) })
    expect(result.current.working).toBe(false)
    act(() => vi.advanceTimersByTime(15_000))
    expect(result.current.error).toContain('no agent activity')
    mocks.stream = { ...mocks.stream, isActive: true, activeStartTime: 200 }
    rerender({ active: true, paused: false })
    expect(result.current.error).toBeNull()
    expect(result.current.working).toBe(true)
    mocks.stream = { ...mocks.stream, isActive: false, streamingMessage: 'Found it.' }
    rerender({ active: true, paused: false })
    expect(adapter.updateReply).toHaveBeenLastCalledWith('Found it.', true)
    expect(result.current.working).toBe(false)
    unmount()
  })

  it('cuts music at speech onset and allows holds only while a ready agent is working', () => {
    const { adapter, result, rerender, unmount } = setup()
    expect(result.current.working).toBe(false)
    mocks.stream.isActive = true
    rerender({ active: true, paused: false })
    expect(result.current.working).toBe(true)
    act(() => adapter.callbacks.onSpeaking(true))
    // The reply becoming audible fades the loop; only the person's voice cuts it.
    expect(mocks.fadeMusic).toHaveBeenCalledOnce()
    expect(mocks.stopMusic).not.toHaveBeenCalled()
    expect(result.current.phase).toBe('speaking')
    expect(mocks.interrupt).not.toHaveBeenCalled()
    rerender({ active: true, paused: true })
    expect(result.current.working).toBe(false)
    rerender({ active: true, paused: false })
    act(() => adapter.callbacks.onClosed())
    expect(result.current.working).toBe(false)
    unmount()
  })

  it('cuts hold music for user speech and keeps it suppressed until both sides are silent', () => {
    mocks.stream.isActive = true
    const { adapter, result, unmount } = setup()
    act(() => adapter.callbacks.onInputSpeaking(true))
    expect(mocks.stopMusic).toHaveBeenCalledOnce()
    expect(result.current.speechActive).toBe(true)
    act(() => adapter.callbacks.onSpeaking(true))
    act(() => adapter.callbacks.onSpeaking(false))
    expect(result.current.speechActive).toBe(true)
    act(() => adapter.callbacks.onInputSpeaking(false))
    expect(result.current.speechActive).toBe(false)
    expect(mocks.interrupt).not.toHaveBeenCalled()
    unmount()
  })

  it('pauses for a request card and rejects callbacks after unmount', async () => {
    const { adapter, send, rerender, unmount } = setup()
    rerender({ active: true, paused: true })
    expect(adapter.setPaused).toHaveBeenLastCalledWith(true)
    await act(async () => { expect(await adapter.callbacks.onRequest({ action: 'message', text: 'Hello' })).toBe(false) })
    unmount()
    expect(adapter.close).toHaveBeenCalledOnce()
    expect(await adapter.callbacks.onRequest({ action: 'message', text: 'Hello' })).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('keeps the agent running when the mic is used to stop speaking', () => {
    mocks.stream.isActive = true
    const { result, adapter, unmount } = setup()
    act(() => result.current.pressMic())
    expect(adapter.pressMic).toHaveBeenCalledWith(true)
    expect(mocks.interrupt).not.toHaveBeenCalled()
    unmount()
  })
})
