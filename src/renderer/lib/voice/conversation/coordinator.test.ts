import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VoiceAgentCoordinator, VOICE_TURN_START_TIMEOUT_MS, VOICE_INTERRUPT_TIMEOUT_MS } from './coordinator'
import type { VoiceAgentEvent, VoiceAgentSnapshot } from '../contracts/conversation'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function setup(initial: Partial<VoiceAgentSnapshot> = {}, expectTurn = false) {
  let snapshot: VoiceAgentSnapshot = { active: false, text: '', startedAt: null, toolsRunning: false, error: null, ...initial }
  const events: VoiceAgentEvent[] = []
  const dependencies = {
    snapshot: () => snapshot,
    send: vi.fn(async (_text: string) => true), interrupt: vi.fn(async (_signal?: AbortSignal) => {}),
    onEvent: vi.fn((event: VoiceAgentEvent) => events.push(event)), onState: vi.fn(), onIssue: vi.fn(),
  }
  const coordinator = new VoiceAgentCoordinator(dependencies)
  coordinator.start(expectTurn)
  const update = (next: Partial<VoiceAgentSnapshot>) => {
    snapshot = { ...snapshot, ...next }
    coordinator.update(snapshot)
  }
  const replies = () => events.filter((event) => event.type === 'reply')
  return { coordinator, dependencies, update, events, replies }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('shared voice agent coordinator', () => {
  it('serializes a replacement behind successful cancellation and suppresses old output in flight', async () => {
    const { coordinator, dependencies, update, replies } = setup({ active: true, startedAt: 1, text: 'Old answer' })
    const stop = deferred<void>()
    dependencies.interrupt.mockReturnValueOnce(stop.promise)
    const pending = coordinator.command({ type: 'submit', text: 'Use Thursday.' })
    update({ text: 'Old answer continuing' })
    expect(dependencies.send).not.toHaveBeenCalled()
    expect(replies()).toEqual([])
    stop.resolve()
    expect(await pending).toEqual({ accepted: true })
    update({ active: true, startedAt: 2 })
    expect(replies()).toEqual([])
    update({ text: 'Checking Thursday.' })
    expect(replies().at(-1)).toMatchObject({ text: 'Checking Thursday.', complete: false })
    coordinator.close()
  })

  it('blocks an already-queued replacement after failed cancellation and allows an explicit retry', async () => {
    const { coordinator, dependencies } = setup({ active: true, startedAt: 1 })
    const stop = deferred<void>()
    dependencies.interrupt.mockReturnValueOnce(stop.promise)
    const cancel = coordinator.command({ type: 'cancel' })
    const replace = coordinator.command({ type: 'submit', text: 'Replacement' })
    stop.reject(new Error('Cannot stop'))
    expect(await cancel).toEqual({ accepted: false, error: 'Cannot stop' })
    expect(await replace).toEqual({ accepted: false, error: 'Cannot stop' })
    expect(dependencies.send).not.toHaveBeenCalled()
    expect(await coordinator.command({ type: 'submit', text: 'Retry' })).toEqual({ accepted: true })
    expect(dependencies.interrupt).toHaveBeenCalledTimes(2)
    expect(dependencies.send).toHaveBeenCalledExactlyOnceWith('Retry')
    coordinator.close()
  })

  it('cancels an accepted request even before the stream reports active', async () => {
    const { coordinator, dependencies } = setup()
    await coordinator.command({ type: 'submit', text: 'First' })
    await coordinator.command({ type: 'submit', text: 'Correction' })
    expect(dependencies.interrupt).toHaveBeenCalledOnce()
    expect(dependencies.interrupt.mock.invocationCallOrder[0]).toBeLessThan(dependencies.send.mock.invocationCallOrder[1])
    coordinator.close()
  })

  it('suppresses late frames after cancellation and cancels any newly active turn before replacement', async () => {
    const { coordinator, dependencies, update, replies } = setup()
    await coordinator.command({ type: 'submit', text: 'First' })
    await coordinator.command({ type: 'cancel' })
    update({ active: true, startedAt: 1, text: 'Late cancelled response' })
    expect(replies()).toEqual([])
    await coordinator.command({ type: 'submit', text: 'Replacement' })
    expect(dependencies.interrupt).toHaveBeenCalledTimes(2)
    expect(dependencies.send).toHaveBeenLastCalledWith('Replacement')
    coordinator.close()
  })

  it('does not submit or publish after closing during cancellation', async () => {
    const { coordinator, dependencies, events } = setup({ active: true })
    const stop = deferred<void>()
    dependencies.interrupt.mockReturnValueOnce(stop.promise)
    const pending = coordinator.command({ type: 'submit', text: 'Must not send' })
    coordinator.close()
    const count = events.length
    stop.resolve()
    expect(await pending).toEqual({ accepted: false })
    expect(dependencies.send).not.toHaveBeenCalled()
    expect(events).toHaveLength(count)
  })

  it('does not execute queued work after the conversation closes', async () => {
    const { coordinator, dependencies } = setup()
    const send = deferred<boolean>()
    dependencies.send.mockReturnValueOnce(send.promise)
    const first = coordinator.command({ type: 'submit', text: 'First' })
    const queued = coordinator.command({ type: 'submit', text: 'Queued' })
    coordinator.close()
    send.resolve(true)
    expect(await first).toEqual({ accepted: false })
    expect(await queued).toEqual({ accepted: false })
    expect(dependencies.send).toHaveBeenCalledTimes(1)
  })

  it('orders cancellation after an in-flight send without cancelling work on disposal', async () => {
    const { coordinator, dependencies } = setup()
    const send = deferred<boolean>()
    dependencies.send.mockReturnValueOnce(send.promise)
    const first = coordinator.command({ type: 'submit', text: 'First' })
    const stop = coordinator.command({ type: 'cancel' })
    expect(dependencies.interrupt).not.toHaveBeenCalled()
    send.resolve(true)
    await first
    expect(await stop).toEqual({ accepted: true })
    expect(dependencies.interrupt).toHaveBeenCalledOnce()
    coordinator.close()
    expect(dependencies.interrupt).toHaveBeenCalledOnce()
  })

  it('observes a new turn that starts while send is pending, without replaying the old response', async () => {
    const { coordinator, dependencies, update, replies } = setup({ active: true, startedAt: 1, text: 'Old' })
    const send = deferred<boolean>()
    dependencies.send.mockReturnValueOnce(send.promise)
    const pending = coordinator.command({ type: 'submit', text: 'Next' })
    await vi.advanceTimersByTimeAsync(0)
    update({ active: true, startedAt: 2, text: 'New' })
    expect(replies()).toEqual([])
    send.resolve(true)
    await pending
    expect(replies()).toHaveLength(1)
    expect(replies()[0]).toMatchObject({ text: 'New' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(dependencies.onIssue).not.toHaveBeenCalledWith(expect.any(String))
    coordinator.close()
  })

  it('ignores history arriving while idle, then emits explicit segment boundaries and completion once', async () => {
    const { coordinator, update, replies } = setup()
    update({ text: 'Old persisted history' })
    expect(replies()).toEqual([])
    await coordinator.command({ type: 'submit', text: 'Go' })
    update({ active: true, startedAt: 10 })
    expect(replies()).toEqual([])
    update({ text: 'First' })
    const firstSegment = replies().at(-1)!.segment
    update({ text: 'First sentence' })
    expect(replies().at(-1)!.segment).toBe(firstSegment)
    update({ text: '' })
    const secondSegment = replies().at(-1)!.segment
    expect(secondSegment).not.toBe(firstSegment)
    update({ text: 'Second' })
    expect(replies().at(-1)!.segment).toBe(secondSegment)
    update({ active: false })
    expect(replies().at(-1)).toMatchObject({ text: 'Second', complete: true })
    const count = replies().length
    update({ active: false })
    expect(replies()).toHaveLength(count)
    coordinator.close()
  })

  it('reports a delayed acknowledgment and clears it when activity arrives without text', async () => {
    const { coordinator, dependencies, update } = setup()
    await coordinator.command({ type: 'submit', text: 'Slow startup' })
    await vi.advanceTimersByTimeAsync(VOICE_TURN_START_TIMEOUT_MS)
    expect(dependencies.onIssue).toHaveBeenLastCalledWith(expect.stringContaining('no agent activity'))
    update({ active: true, startedAt: 123 })
    expect(dependencies.onIssue).toHaveBeenLastCalledWith(null)
    coordinator.close()
  })

  it('does not warn during extended tool work or replay an unchanged stream error', async () => {
    const { coordinator, dependencies, update, events } = setup()
    await coordinator.command({ type: 'submit', text: 'Research' })
    update({ active: true, startedAt: 1, toolsRunning: true })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(dependencies.onIssue).not.toHaveBeenCalledWith(expect.any(String))
    update({ error: 'Provider unavailable' })
    update({ toolsRunning: false })
    expect(events.filter(event => event.type === 'error')).toHaveLength(1)
    coordinator.close()
  })

  it('does not invent a new pending request when work completes during a pause', async () => {
    const { coordinator, dependencies, update, replies } = setup({ active: true, startedAt: 1, text: 'Working' })
    coordinator.setPaused(true)
    update({ active: false, text: 'Finished while paused' })
    coordinator.setPaused(false)
    await vi.advanceTimersByTimeAsync(VOICE_TURN_START_TIMEOUT_MS)
    expect(dependencies.onState).toHaveBeenLastCalledWith({ active: false, awaiting: false, toolsUsed: false })
    expect(dependencies.onIssue).not.toHaveBeenCalledWith(expect.any(String))
    expect(replies()).toEqual([])
    coordinator.close()
  })

  it('acknowledges a request that starts and completes while speech is paused', async () => {
    const { coordinator, dependencies, update, replies } = setup()
    await coordinator.command({ type: 'submit', text: 'Research' })
    coordinator.setPaused(true)
    update({ active: true, startedAt: 1, text: 'Researching' })
    update({ active: false, text: 'Finished' })
    coordinator.setPaused(false)
    await vi.advanceTimersByTimeAsync(VOICE_TURN_START_TIMEOUT_MS)
    expect(dependencies.onIssue).not.toHaveBeenCalledWith(expect.any(String))
    expect(replies()).toEqual([])
    await coordinator.command({ type: 'submit', text: 'Next request' })
    expect(dependencies.interrupt).not.toHaveBeenCalled()
    coordinator.close()
  })

  it('recognizes a completed response first observed at resume', async () => {
    const { coordinator, dependencies } = setup()
    await coordinator.command({ type: 'submit', text: 'Research' })
    coordinator.setPaused(true)
    // The source changed before its subscription callback ran.
    Object.assign(dependencies.snapshot(), { text: 'Finished', active: false })
    coordinator.setPaused(false)
    await vi.advanceTimersByTimeAsync(VOICE_TURN_START_TIMEOUT_MS)
    expect(dependencies.onIssue).not.toHaveBeenCalledWith(expect.any(String))
    coordinator.close()
  })

  it('clears an existing delay warning when the response arrives during a pause', async () => {
    const { coordinator, dependencies, update } = setup()
    await coordinator.command({ type: 'submit', text: 'Research' })
    await vi.advanceTimersByTimeAsync(VOICE_TURN_START_TIMEOUT_MS)
    expect(dependencies.onIssue).toHaveBeenLastCalledWith(expect.stringContaining('no agent activity'))
    coordinator.setPaused(true)
    update({ active: false, text: 'Finished' })
    expect(dependencies.onIssue).toHaveBeenLastCalledWith(null)
    coordinator.setPaused(false)
    await vi.advanceTimersByTimeAsync(VOICE_TURN_START_TIMEOUT_MS)
    expect(dependencies.onIssue).toHaveBeenLastCalledWith(null)
    coordinator.close()
  })

  it('still warns after resume if a submitted request never received activity', async () => {
    const { coordinator, dependencies } = setup()
    await coordinator.command({ type: 'submit', text: 'Research' })
    coordinator.setPaused(true)
    await vi.advanceTimersByTimeAsync(VOICE_TURN_START_TIMEOUT_MS)
    expect(dependencies.onIssue).not.toHaveBeenCalledWith(expect.any(String))
    coordinator.setPaused(false)
    await vi.advanceTimersByTimeAsync(VOICE_TURN_START_TIMEOUT_MS)
    expect(dependencies.onIssue).toHaveBeenLastCalledWith(expect.stringContaining('no agent activity'))
    coordinator.close()
  })

  it('does not send after a card pauses a pending cancellation', async () => {
    const { coordinator, dependencies } = setup({ active: true })
    const stop = deferred<void>()
    dependencies.interrupt.mockReturnValueOnce(stop.promise)
    const pending = coordinator.command({ type: 'submit', text: 'Wait for card' })
    coordinator.setPaused(true)
    stop.resolve()
    expect(await pending).toEqual({ accepted: false })
    expect(dependencies.send).not.toHaveBeenCalled()
    coordinator.close()
  })
  it('drops a replacement paused during interruption without leaving a phantom request', async () => {
    const { coordinator, dependencies, update } = setup({ active: true, startedAt: 1 })
    const stop = deferred<void>()
    dependencies.interrupt.mockReturnValueOnce(stop.promise)
    const pending = coordinator.command({ type: 'submit', text: 'Replacement' })
    coordinator.setPaused(true)
    update({ active: false })
    stop.resolve()
    expect(await pending).toEqual({ accepted: false })
    coordinator.setPaused(false)
    await vi.advanceTimersByTimeAsync(VOICE_TURN_START_TIMEOUT_MS)
    expect(dependencies.send).not.toHaveBeenCalled()
    expect(dependencies.onIssue).not.toHaveBeenCalledWith(expect.any(String))
    expect(dependencies.onState).toHaveBeenLastCalledWith(expect.objectContaining({ awaiting: false }))
    coordinator.close()
  })

  it('drops queued unsent work while paused without inventing an acknowledgment wait', async () => {
    const { coordinator, dependencies, update } = setup({ active: true })
    const stop = deferred<void>()
    dependencies.interrupt.mockReturnValueOnce(stop.promise)
    const cancel = coordinator.command({ type: 'cancel' })
    const queued = coordinator.command({ type: 'submit', text: 'Queued' })
    coordinator.setPaused(true)
    update({ active: false })
    stop.resolve()
    await cancel
    expect(await queued).toEqual({ accepted: false })
    coordinator.setPaused(false)
    await vi.advanceTimersByTimeAsync(VOICE_TURN_START_TIMEOUT_MS)
    expect(dependencies.send).not.toHaveBeenCalled()
    expect(dependencies.onIssue).not.toHaveBeenCalledWith(expect.any(String))
    coordinator.close()
  })

  it('allows a fresh utterance after failed cancellation without first swallowing a request', async () => {
    const { coordinator, dependencies } = setup({ active: true })
    dependencies.interrupt.mockRejectedValueOnce(new Error('Temporary failure'))
    expect((await coordinator.command({ type: 'cancel' })).accepted).toBe(false)
    expect(await coordinator.command({ type: 'submit', text: 'Fresh request' })).toEqual({ accepted: true })
    expect(dependencies.send).toHaveBeenCalledExactlyOnceWith('Fresh request')
    coordinator.close()
  })

  it('never calls the backend interrupt endpoint for an idle playback tail', async () => {
    const { coordinator, dependencies } = setup()
    expect(await coordinator.command({ type: 'cancel' })).toEqual({ accepted: true })
    expect(dependencies.interrupt).not.toHaveBeenCalled()
    coordinator.close()
  })

  it('bounds a stalled interrupt and rejects queued replacements without submitting them', async () => {
    const { coordinator, dependencies } = setup({ active: true })
    dependencies.interrupt.mockImplementationOnce(() => new Promise(() => {}))
    const first = coordinator.command({ type: 'submit', text: 'First' })
    const queued = coordinator.command({ type: 'submit', text: 'Queued' })
    await vi.advanceTimersByTimeAsync(VOICE_INTERRUPT_TIMEOUT_MS)
    expect(await first).toMatchObject({ accepted: false, error: expect.stringContaining('confirm') })
    expect(await queued).toMatchObject({ accepted: false, error: expect.stringContaining('confirm') })
    expect(dependencies.send).not.toHaveBeenCalled()
    expect(dependencies.interrupt.mock.calls[0][0]?.aborted).toBe(true)
    expect(await coordinator.command({ type: 'submit', text: 'Retry' })).toEqual({ accepted: true })
    coordinator.close()
  })

  describe('chained speech policy', () => {
    const chained = { interruptTimeoutMs: 5_000, turnStartTimeoutMs: 8_000, sendAfterFailedInterrupt: true }
    function chainedSetup(initial: Partial<VoiceAgentSnapshot> = {}) {
      let snapshot: VoiceAgentSnapshot = { active: false, text: '', startedAt: null, toolsRunning: false, error: null, ...initial }
      const dependencies = {
        snapshot: () => snapshot,
        send: vi.fn(async (_text: string) => true), interrupt: vi.fn(async (_signal?: AbortSignal) => {}),
        onEvent: vi.fn(), onState: vi.fn(), onIssue: vi.fn(),
      }
      const coordinator = new VoiceAgentCoordinator(dependencies, chained)
      coordinator.start(false)
      const update = (next: Partial<VoiceAgentSnapshot>) => { snapshot = { ...snapshot, ...next }; coordinator.update(snapshot) }
      return { coordinator, dependencies, update }
    }

    it('sends the words after a bounded wait when the interrupt stalls', async () => {
      const { coordinator, dependencies } = chainedSetup({ active: true, startedAt: 1 })
      dependencies.interrupt.mockImplementationOnce(() => new Promise(() => {}))
      const pending = coordinator.command({ type: 'submit', text: 'Actually, Thursday.' })
      await vi.advanceTimersByTimeAsync(chained.interruptTimeoutMs)
      expect(await pending).toEqual({ accepted: true })
      expect(dependencies.send).toHaveBeenCalledExactlyOnceWith('Actually, Thursday.')
      expect(dependencies.onIssue).not.toHaveBeenCalledWith(expect.any(String))
      coordinator.close()
    })

    it('sends a replacement queued behind a failed cancel, and stays quiet about the failure', async () => {
      const { coordinator, dependencies } = chainedSetup({ active: true, startedAt: 1 })
      const stop = deferred<void>()
      dependencies.interrupt.mockReturnValueOnce(stop.promise)
      const cancel = coordinator.command({ type: 'cancel' })
      const replace = coordinator.command({ type: 'submit', text: 'Replacement' })
      stop.reject(new Error('Cannot stop'))
      expect(await cancel).toMatchObject({ accepted: false })
      expect(await replace).toEqual({ accepted: true })
      expect(dependencies.send).toHaveBeenCalledExactlyOnceWith('Replacement')
      expect(dependencies.onIssue).not.toHaveBeenCalledWith(expect.any(String))
      // The interrupted turn stays suppressed and the interrupt was retried before sending.
      expect(dependencies.interrupt).toHaveBeenCalledTimes(2)
      coordinator.close()
    })

    it('keeps the agent floor after a card until its turn resumes, then reads it', async () => {
      const { coordinator, dependencies, update } = chainedSetup({ active: true, startedAt: 1, text: 'Which account? ' })
      coordinator.setPaused(true)
      update({ active: false, text: '' })
      coordinator.setPaused(false)
      expect(dependencies.onState).toHaveBeenLastCalledWith(expect.objectContaining({ awaiting: true }))
      update({ active: true, startedAt: 2, text: 'Connected. ' })
      expect(dependencies.onState).toHaveBeenLastCalledWith(expect.objectContaining({ active: true, awaiting: false }))
      expect(dependencies.onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'reply', text: 'Connected. ' }))
      coordinator.close()
    })

    it('gives the floor back silently when the turn never resumes after a card', async () => {
      const { coordinator, dependencies, update } = chainedSetup({ active: true, startedAt: 1, text: 'Which account? ' })
      coordinator.setPaused(true)
      update({ active: false, text: '' })
      coordinator.setPaused(false)
      await vi.advanceTimersByTimeAsync(chained.turnStartTimeoutMs)
      expect(dependencies.onState).toHaveBeenLastCalledWith(expect.objectContaining({ awaiting: false }))
      expect(dependencies.onIssue).not.toHaveBeenCalledWith(expect.any(String))
      coordinator.close()
    })

    it('does not hold the floor when the reply finished during the card', async () => {
      const { coordinator, dependencies, update } = chainedSetup({ active: true, startedAt: 1, text: 'Working' })
      coordinator.setPaused(true)
      update({ active: false, text: 'All done.' })
      coordinator.setPaused(false)
      expect(dependencies.onState).toHaveBeenLastCalledWith(expect.objectContaining({ awaiting: false }))
      coordinator.close()
    })
  })

})
