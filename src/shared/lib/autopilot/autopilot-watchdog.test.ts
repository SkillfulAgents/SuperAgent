import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// Singleton seams. Partial mocks (importOriginal) so newly added exports on
// these modules don't silently break the mock shape.
vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: {
    addGlobalNotificationClient: vi.fn(() => () => {}),
    broadcastSessionUpdate: vi.fn(),
    broadcastSessionEvent: vi.fn(),
    wasSessionInterrupted: vi.fn(() => false),
    isSubscribed: vi.fn(() => true),
    subscribeToSession: vi.fn(),
    markSessionActive: vi.fn(),
    markSessionIdle: vi.fn(),
    isSessionActive: vi.fn(() => false),
  },
}))
vi.mock('@shared/lib/services/agent-service', () => ({
  listAgents: vi.fn(async () => []),
}))
vi.mock('@shared/lib/container/container-manager', () => ({
  containerManager: {
    ensureRunning: vi.fn(),
  },
}))
vi.mock('@shared/lib/notifications/notification-manager', () => ({
  notificationManager: {
    triggerSessionWaitingInput: vi.fn(async () => {}),
    triggerSessionComplete: vi.fn(async () => {}),
  },
}))
vi.mock('@shared/lib/llm-provider/helpers', () => ({
  getConfiguredLlmClient: vi.fn(() => ({})),
  createSummarizerText: vi.fn(),
}))
vi.mock('@shared/lib/llm-provider', () => ({
  resolveActiveProviderModel: vi.fn(() => 'claude-haiku-4-5'),
}))
vi.mock('@shared/lib/config/settings', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    getEffectiveModels: vi.fn(() => ({ summarizerModel: 'haiku' })),
  }
})

import { autopilotWatchdog, buildTranscriptExcerpt } from './autopilot-watchdog'
import { messagePersister } from '@shared/lib/container/message-persister'
import { containerManager } from '@shared/lib/container/container-manager'
import { notificationManager } from '@shared/lib/notifications/notification-manager'
import { createSummarizerText } from '@shared/lib/llm-provider/helpers'
import { requestAutopilot, engageAutopilot } from './autopilot-service'
import { listAgents } from '@shared/lib/services/agent-service'
import { getSessionMetadata, updateSessionMetadata } from '@shared/lib/services/session-service'
import { getSessionJsonlPath } from '@shared/lib/utils/file-storage'
import { normalizeAutopilotState } from './autopilot-schema'
import type { JsonlMessageEntry, JsonlSystemEntry } from '@shared/lib/types/agent'

const AGENT = 'watchdog-test-agent'
const SESSION = 'session-w1'

type GlobalEventHandler = (data: unknown) => void

describe('autopilot-watchdog', () => {
  let testDir: string
  let originalEnv: string | undefined
  let emit: GlobalEventHandler
  let fakeClient: { sendMessage: ReturnType<typeof vi.fn> }

  beforeEach(async () => {
    vi.clearAllMocks()
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'watchdog-test-'))
    originalEnv = process.env.SUPERAGENT_DATA_DIR
    process.env.SUPERAGENT_DATA_DIR = testDir
    await fs.promises.mkdir(path.join(testDir, 'agents', AGENT, 'workspace'), { recursive: true })
    await updateSessionMetadata(AGENT, SESSION, { name: 'Watchdog test' })

    fakeClient = { sendMessage: vi.fn(async () => {}) }
    vi.mocked(containerManager.ensureRunning).mockResolvedValue(
      fakeClient as unknown as Awaited<ReturnType<typeof containerManager.ensureRunning>>
    )
    // clearAllMocks keeps mockReturnValue overrides from earlier tests — pin
    // the defaults these paths branch on.
    vi.mocked(messagePersister.wasSessionInterrupted).mockReturnValue(false)
    vi.mocked(messagePersister.isSessionActive).mockReturnValue(false)

    autopilotWatchdog.start()
    const calls = vi.mocked(messagePersister.addGlobalNotificationClient).mock.calls
    emit = calls[calls.length - 1][0] as GlobalEventHandler
  })

  afterEach(async () => {
    autopilotWatchdog.stop()
    if (originalEnv) {
      process.env.SUPERAGENT_DATA_DIR = originalEnv
    } else {
      delete process.env.SUPERAGENT_DATA_DIR
    }
    await fs.promises.rm(testDir, { recursive: true, force: true })
  })

  async function engage(maxIterations?: number): Promise<void> {
    await requestAutopilot(AGENT, SESSION)
    await engageAutopilot(AGENT, SESSION, {
      goal: 'Finish the task',
      success_criteria: ['Everything works'],
      ...(maxIterations ? { max_iterations: maxIterations } : {}),
    })
  }

  async function currentState(): Promise<string> {
    return normalizeAutopilotState((await getSessionMetadata(AGENT, SESSION))?.autopilot?.state)
  }

  async function readReviewEntries(): Promise<Array<Record<string, unknown>>> {
    const jsonlPath = getSessionJsonlPath(AGENT, SESSION)
    const raw = await fs.promises.readFile(jsonlPath, 'utf-8').catch(() => '')
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.subtype === 'autopilot_review')
      .map((e) => JSON.parse(e.content))
  }

  // The handler is fire-and-forget from the event callback; drain it by
  // waiting for the finished broadcast.
  async function emitIdleAndSettle(): Promise<void> {
    emit({ type: 'session_idle', sessionId: SESSION, agentSlug: AGENT })
    await vi.waitFor(() => {
      const events = vi.mocked(messagePersister.broadcastSessionEvent).mock.calls.map((c) => c[1])
      expect(events).toContainEqual({ type: 'autopilot_review', status: 'finished' })
    })
  }

  it('ignores idle events for sessions not engaged', async () => {
    emit({ type: 'session_idle', sessionId: SESSION, agentSlug: AGENT })
    await new Promise((r) => setTimeout(r, 50))
    expect(createSummarizerText).not.toHaveBeenCalled()
  })

  it('done verdict: disengages and records the decision', async () => {
    await engage()
    vi.mocked(createSummarizerText).mockResolvedValue(
      JSON.stringify({ verdict: 'done', reasoning: 'All criteria satisfied.' })
    )
    await emitIdleAndSettle()

    expect(await currentState()).toBe('off')
    const reviews = await readReviewEntries()
    expect(reviews).toHaveLength(1)
    expect(reviews[0].verdict).toBe('done')
    expect(fakeClient.sendMessage).not.toHaveBeenCalled()
    expect(notificationManager.triggerSessionWaitingInput).not.toHaveBeenCalled()
  })

  it('done verdict with explicit null nudge/missing still counts as done', async () => {
    // The judge prompt marks nudge/missing "REQUIRED for continue", so on done
    // models often emit them as nulls — that must not escalate a clean done.
    await engage()
    vi.mocked(createSummarizerText).mockResolvedValue(
      JSON.stringify({ verdict: 'done', reasoning: 'All satisfied.', nudge: null, missing: null })
    )
    await emitIdleAndSettle()

    expect(await currentState()).toBe('off')
    const reviews = await readReviewEntries()
    expect(reviews[reviews.length - 1].verdict).toBe('done')
    expect(notificationManager.triggerSessionWaitingInput).not.toHaveBeenCalled()
  })

  it('continue verdict: increments the iteration and dispatches a [SYSTEM] nudge', async () => {
    await engage()
    // Fences must be stripped before parsing.
    vi.mocked(createSummarizerText).mockResolvedValue(
      '```json\n' +
        JSON.stringify({
          verdict: 'continue',
          reasoning: 'Not verified yet.',
          nudge: 'Run the verification and report results.',
          missing: 'verification not run',
        }) +
        '\n```'
    )
    await emitIdleAndSettle()

    expect(await currentState()).toBe('engaged')
    expect((await getSessionMetadata(AGENT, SESSION))?.autopilot?.iteration).toBe(1)
    expect(messagePersister.markSessionActive).toHaveBeenCalledWith(SESSION, AGENT)
    expect(fakeClient.sendMessage).toHaveBeenCalledTimes(1)
    const [sessionArg, messageArg, , optionsArg] = fakeClient.sendMessage.mock.calls[0]
    expect(sessionArg).toBe(SESSION)
    expect(messageArg).toContain('[SYSTEM]')
    expect(messageArg).toContain('Run the verification and report results.')
    expect(optionsArg).toEqual({ shouldQuery: true })
    const reviews = await readReviewEntries()
    expect(reviews[0].verdict).toBe('continue')
  })

  it('blocked verdict: pauses and notifies', async () => {
    await engage()
    vi.mocked(createSummarizerText).mockResolvedValue(
      JSON.stringify({ verdict: 'blocked', reasoning: 'OAuth token expired.' })
    )
    await emitIdleAndSettle()

    const meta = (await getSessionMetadata(AGENT, SESSION))?.autopilot
    expect(meta?.state).toBe('paused')
    expect(meta?.pausedReason).toBe('OAuth token expired.')
    expect(notificationManager.triggerSessionWaitingInput).toHaveBeenCalledWith(
      SESSION,
      AGENT,
      'autopilot'
    )
    expect(fakeClient.sendMessage).not.toHaveBeenCalled()
  })

  it('prose-wrapped verdict JSON: extracted and honored', async () => {
    await engage()
    vi.mocked(createSummarizerText).mockResolvedValue(
      'Here is my assessment of the session:\n' +
        JSON.stringify({ verdict: 'done', reasoning: 'All criteria satisfied.' }) +
        '\nLet me know if you need anything else.'
    )
    await emitIdleAndSettle()

    expect(await currentState()).toBe('off')
    const reviews = await readReviewEntries()
    expect(reviews[0].verdict).toBe('done')
  })

  it('unparseable judge output: escalates to paused', async () => {
    await engage()
    vi.mocked(createSummarizerText).mockResolvedValue('sure, sounds done to me!')
    await emitIdleAndSettle()

    expect(await currentState()).toBe('paused')
    const reviews = await readReviewEntries()
    expect(reviews[0].verdict).toBe('escalated')
    expect(notificationManager.triggerSessionWaitingInput).toHaveBeenCalled()
  })

  it('iteration cap: escalates instead of continuing', async () => {
    await engage(1)
    vi.mocked(createSummarizerText).mockResolvedValue(
      JSON.stringify({ verdict: 'continue', reasoning: 'r', nudge: 'n', missing: 'a' })
    )
    await emitIdleAndSettle()
    expect(await currentState()).toBe('engaged') // 1/1 used

    vi.mocked(createSummarizerText).mockResolvedValue(
      JSON.stringify({ verdict: 'continue', reasoning: 'r', nudge: 'n', missing: 'b' })
    )
    vi.mocked(messagePersister.broadcastSessionEvent).mockClear()
    fakeClient.sendMessage.mockClear()
    await emitIdleAndSettle()

    expect(await currentState()).toBe('paused')
    expect(fakeClient.sendMessage).not.toHaveBeenCalled()
    const reviews = await readReviewEntries()
    expect(reviews[reviews.length - 1].verdict).toBe('escalated')
  })

  it('user interrupt: suspends back to requested without consulting the judge', async () => {
    await engage()
    vi.mocked(messagePersister.wasSessionInterrupted).mockReturnValue(true)
    emit({ type: 'session_idle', sessionId: SESSION, agentSlug: AGENT })
    await vi.waitFor(async () => {
      expect(await currentState()).toBe('requested')
    })
    expect(createSummarizerText).not.toHaveBeenCalled()
  })

  it('input request while engaged: mechanical pause without judge or duplicate notification', async () => {
    await engage()
    emit({ type: 'session_awaiting_input', sessionId: SESSION, agentSlug: AGENT })
    await vi.waitFor(async () => {
      expect(await currentState()).toBe('paused')
    })
    expect(createSummarizerText).not.toHaveBeenCalled()
    // The input request's own "Action Required" notification covers the user.
    expect(notificationManager.triggerSessionWaitingInput).not.toHaveBeenCalled()
    const reviews = await readReviewEntries()
    expect(reviews[0].verdict).toBe('blocked')
  })

  it('session error while engaged: pauses AND notifies', async () => {
    await engage()
    emit({ type: 'session_error', sessionId: SESSION, agentSlug: AGENT })
    await vi.waitFor(async () => {
      expect(await currentState()).toBe('paused')
    })
    expect(notificationManager.triggerSessionWaitingInput).toHaveBeenCalledWith(
      SESSION,
      AGENT,
      'autopilot'
    )
  })

  it('done verdict: announces completion once via session-complete', async () => {
    // Per-stop "Session Complete" pings are suppressed while engaged, so the
    // watchdog owns the single completion notification.
    await engage()
    vi.mocked(createSummarizerText).mockResolvedValue(
      JSON.stringify({ verdict: 'done', reasoning: 'All criteria satisfied.' })
    )
    await emitIdleAndSettle()
    expect(notificationManager.triggerSessionComplete).toHaveBeenCalledWith(SESSION, AGENT)
  })

  it('two idle events for one stop run a single review', async () => {
    // Double idle emission is real (state-event idle + a reconnect's
    // finalizeIdle); the in-flight claim must happen before the first await
    // or both events reach the judge — double-burned iteration, two nudges.
    await engage()
    let resolveJudge!: (v: string) => void
    vi.mocked(createSummarizerText).mockImplementation(
      () => new Promise<string>((resolve) => { resolveJudge = resolve })
    )
    emit({ type: 'session_idle', sessionId: SESSION, agentSlug: AGENT })
    emit({ type: 'session_idle', sessionId: SESSION, agentSlug: AGENT })
    await vi.waitFor(() => expect(createSummarizerText).toHaveBeenCalledTimes(1))
    resolveJudge(
      JSON.stringify({ verdict: 'continue', reasoning: 'r', nudge: 'keep going', missing: 'm' })
    )
    await vi.waitFor(() => {
      const events = vi.mocked(messagePersister.broadcastSessionEvent).mock.calls.map((c) => c[1])
      expect(events).toContainEqual({ type: 'autopilot_review', status: 'finished' })
    })

    expect(createSummarizerText).toHaveBeenCalledTimes(1)
    expect(fakeClient.sendMessage).toHaveBeenCalledTimes(1)
    expect((await getSessionMetadata(AGENT, SESSION))?.autopilot?.iteration).toBe(1)
  })

  it('nudge is aborted when the user takes the session over mid-dispatch', async () => {
    // The continue verdict is applied under the metadata lock, but the
    // container round-trip before the send is not — a user message in that
    // window must not be followed by a stale autonomy-restarting nudge.
    await engage()
    vi.mocked(createSummarizerText).mockResolvedValue(
      JSON.stringify({ verdict: 'continue', reasoning: 'r', nudge: 'n', missing: 'm' })
    )
    vi.mocked(containerManager.ensureRunning).mockImplementation(async () => {
      await requestAutopilot(AGENT, SESSION) // user message with the switch on lands here
      return fakeClient as unknown as Awaited<ReturnType<typeof containerManager.ensureRunning>>
    })
    await emitIdleAndSettle()

    expect(fakeClient.sendMessage).not.toHaveBeenCalled()
    expect(await currentState()).toBe('requested')
  })

  it('a done verdict landing after a user re-request leaves requested intact', async () => {
    await engage()
    vi.mocked(createSummarizerText).mockImplementation(async () => {
      await requestAutopilot(AGENT, SESSION) // user intervenes while the judge runs
      return JSON.stringify({ verdict: 'done', reasoning: 'All satisfied.' })
    })
    await emitIdleAndSettle()

    expect(await currentState()).toBe('requested')
    // No contradictory "goal complete" card, no completion ping.
    expect(await readReviewEntries()).toHaveLength(0)
    expect(notificationManager.triggerSessionComplete).not.toHaveBeenCalled()
  })

  describe('restart reconciliation', () => {
    function reconcile(): Promise<void> {
      return (
        autopilotWatchdog as unknown as { reconcileAfterRestart(): Promise<void> }
      ).reconcileAfterRestart()
    }

    it('reviews sessions left engaged across a restart', async () => {
      await engage()
      vi.mocked(listAgents).mockResolvedValue([{ slug: AGENT }] as Awaited<ReturnType<typeof listAgents>>)
      vi.mocked(createSummarizerText).mockResolvedValue(
        JSON.stringify({ verdict: 'continue', reasoning: 'r', nudge: 'keep going', missing: 'm' })
      )
      await reconcile()

      expect(fakeClient.sendMessage).toHaveBeenCalledTimes(1)
      expect((await getSessionMetadata(AGENT, SESSION))?.autopilot?.iteration).toBe(1)
    })

    it('skips engaged sessions that are already streaming again', async () => {
      await engage()
      vi.mocked(listAgents).mockResolvedValue([{ slug: AGENT }] as Awaited<ReturnType<typeof listAgents>>)
      vi.mocked(messagePersister.isSessionActive).mockReturnValue(true)
      await reconcile()

      expect(createSummarizerText).not.toHaveBeenCalled()
      expect(await currentState()).toBe('engaged')
    })

    it('leaves requested and off sessions alone', async () => {
      await requestAutopilot(AGENT, SESSION)
      vi.mocked(listAgents).mockResolvedValue([{ slug: AGENT }] as Awaited<ReturnType<typeof listAgents>>)
      await reconcile()

      expect(createSummarizerText).not.toHaveBeenCalled()
      expect(await currentState()).toBe('requested')
    })
  })
})

describe('buildTranscriptExcerpt', () => {
  function userEntry(text: string): JsonlMessageEntry {
    return {
      uuid: `u-${text}`,
      type: 'user',
      message: { role: 'user', content: text },
      timestamp: new Date().toISOString(),
    } as unknown as JsonlMessageEntry
  }

  it('formats roles, tools and system banners and keeps the newest within budget', () => {
    const assistant = {
      uuid: 'a1',
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Working on it.' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
        ],
      },
      timestamp: new Date().toISOString(),
    } as unknown as JsonlMessageEntry
    const system = {
      uuid: 's1',
      type: 'system',
      subtype: 'informational',
      content: 'hook warning',
      isMeta: false,
      timestamp: new Date().toISOString(),
    } as unknown as JsonlSystemEntry

    const excerpt = buildTranscriptExcerpt([userEntry('Do the thing'), assistant, system])
    expect(excerpt).toContain('USER: Do the thing')
    expect(excerpt).toContain('AGENT: Working on it.')
    expect(excerpt).toContain('[tool: Bash]')
    expect(excerpt).toContain('[system] hook warning')
  })

  it('drops the oldest entries when over budget and says so', () => {
    const entries = Array.from({ length: 200 }, (_, i) => userEntry(`message ${i} ${'x'.repeat(500)}`))
    const excerpt = buildTranscriptExcerpt(entries)
    expect(excerpt).toContain('earlier entries omitted')
    expect(excerpt).toContain('message 199')
    expect(excerpt).not.toContain('message 0 ')
  })
})
