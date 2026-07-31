import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  requestAutopilot,
  disengageAutopilot,
  engageAutopilot,
  pauseAutopilot,
  applyContinueVerdict,
} from './autopilot-service'
import { getSessionMetadata, updateSessionMetadata } from '@shared/lib/services/session-service'
import { autopilotEpochStartMs, normalizeAutopilotState } from './autopilot-schema'

const AGENT = 'autopilot-test-agent'
const SESSION = 'session-1'

describe('autopilot-service state machine', () => {
  let testDir: string
  let originalEnv: string | undefined

  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'autopilot-test-'))
    originalEnv = process.env.SUPERAGENT_DATA_DIR
    process.env.SUPERAGENT_DATA_DIR = testDir
    await fs.promises.mkdir(path.join(testDir, 'agents', AGENT, 'workspace'), { recursive: true })
    await updateSessionMetadata(AGENT, SESSION, { name: 'Test session' })
  })

  afterEach(async () => {
    if (originalEnv) {
      process.env.SUPERAGENT_DATA_DIR = originalEnv
    } else {
      delete process.env.SUPERAGENT_DATA_DIR
    }
    await fs.promises.rm(testDir, { recursive: true, force: true })
  })

  async function state(): Promise<string> {
    return normalizeAutopilotState((await getSessionMetadata(AGENT, SESSION))?.autopilot?.state)
  }

  const CONTRACT = {
    goal: 'Ship the report',
    success_criteria: ['Report file exists', 'Report emailed to the team'],
  }

  it('request: off → requested', async () => {
    expect(await requestAutopilot(AGENT, SESSION)).toBe(true)
    expect(await state()).toBe('requested')
    // idempotent
    expect(await requestAutopilot(AGENT, SESSION)).toBe(false)
  })

  it('request from paused clears the paused reason', async () => {
    await requestAutopilot(AGENT, SESSION)
    await engageAutopilot(AGENT, SESSION, CONTRACT)
    await pauseAutopilot(AGENT, SESSION, 'blocked on auth')
    expect(await requestAutopilot(AGENT, SESSION)).toBe(true)
    const meta = (await getSessionMetadata(AGENT, SESSION))?.autopilot
    expect(meta?.state).toBe('requested')
    expect(meta?.pausedReason).toBeUndefined()
  })

  it('engage requires requested state', async () => {
    expect(await engageAutopilot(AGENT, SESSION, CONTRACT)).toBe('not-requested')
    expect(await state()).toBe('off')
  })

  it('engage validates the contract at the boundary', async () => {
    await requestAutopilot(AGENT, SESSION)
    expect(await engageAutopilot(AGENT, SESSION, { goal: 'x' })).toBe('invalid-contract')
    expect(await engageAutopilot(AGENT, SESSION, { goal: '', success_criteria: ['a'] })).toBe('invalid-contract')
    expect(
      await engageAutopilot(AGENT, SESSION, { goal: 'x', success_criteria: [] })
    ).toBe('invalid-contract')
    expect(await state()).toBe('requested')
  })

  it('engage: requested → engaged, persists the contract and zeroes the iteration', async () => {
    await requestAutopilot(AGENT, SESSION)
    expect(await engageAutopilot(AGENT, SESSION, CONTRACT)).toBe('engaged')
    const meta = (await getSessionMetadata(AGENT, SESSION))?.autopilot
    expect(meta?.state).toBe('engaged')
    expect(meta?.goal?.goal).toBe('Ship the report')
    expect(meta?.goal?.success_criteria).toHaveLength(2)
    expect(meta?.iteration).toBe(0)
    expect(meta?.engagedAt).toBeTruthy()
    // double engage rejected
    expect(await engageAutopilot(AGENT, SESSION, CONTRACT)).toBe('not-requested')
  })

  it('request stamps the era marker and engage preserves it', async () => {
    await requestAutopilot(AGENT, SESSION)
    const requestedAt = (await getSessionMetadata(AGENT, SESSION))?.autopilot?.requestedAt
    expect(requestedAt).toBeTruthy()

    await engageAutopilot(AGENT, SESSION, CONTRACT)
    const meta = (await getSessionMetadata(AGENT, SESSION))?.autopilot
    // The user's task statement precedes engagement — the judges' evidence
    // and intent windows must start at the request, not the engagement.
    expect(meta?.requestedAt).toBe(requestedAt)
    expect(autopilotEpochStartMs(meta)).toBe(Date.parse(requestedAt as string))
  })

  it('user message while engaged disengages', async () => {
    await requestAutopilot(AGENT, SESSION)
    await engageAutopilot(AGENT, SESSION, CONTRACT)
    expect(await disengageAutopilot(AGENT, SESSION, 'user_message')).toBe(true)
    expect(await state()).toBe('off')
    // already off → no change
    expect(await disengageAutopilot(AGENT, SESSION, 'user_toggle')).toBe(false)
  })

  it('completed disengage only applies from engaged — a late done verdict must not kill a re-requested autopilot', async () => {
    await requestAutopilot(AGENT, SESSION)
    await engageAutopilot(AGENT, SESSION, CONTRACT)
    // User message lands mid-review with the switch still on: engaged → requested…
    await requestAutopilot(AGENT, SESSION)
    // …then the in-flight review's done verdict arrives late.
    expect(await disengageAutopilot(AGENT, SESSION, 'completed')).toBe(false)
    expect(await state()).toBe('requested')
  })

  it('completed disengage is a no-op from paused', async () => {
    await requestAutopilot(AGENT, SESSION)
    await engageAutopilot(AGENT, SESSION, CONTRACT)
    await pauseAutopilot(AGENT, SESSION, 'blocked on auth')
    expect(await disengageAutopilot(AGENT, SESSION, 'completed')).toBe(false)
    expect(await state()).toBe('paused')
  })

  it('user-driven disengage still applies from requested and paused', async () => {
    await requestAutopilot(AGENT, SESSION)
    expect(await disengageAutopilot(AGENT, SESSION, 'user_toggle')).toBe(true)
    expect(await state()).toBe('off')

    await requestAutopilot(AGENT, SESSION)
    await engageAutopilot(AGENT, SESSION, CONTRACT)
    await pauseAutopilot(AGENT, SESSION, 'blocked')
    expect(await disengageAutopilot(AGENT, SESSION, 'user_toggle')).toBe(true)
    expect(await state()).toBe('off')
  })

  it('pause only applies to an engaged session', async () => {
    expect(await pauseAutopilot(AGENT, SESSION, 'nope')).toBe(false)
    await requestAutopilot(AGENT, SESSION)
    expect(await pauseAutopilot(AGENT, SESSION, 'nope')).toBe(false)
    await engageAutopilot(AGENT, SESSION, CONTRACT)
    expect(await pauseAutopilot(AGENT, SESSION, 'blocked on a credential')).toBe(true)
    const meta = (await getSessionMetadata(AGENT, SESSION))?.autopilot
    expect(meta?.state).toBe('paused')
    expect(meta?.pausedReason).toBe('blocked on a credential')
  })

  describe('applyContinueVerdict guardrails', () => {
    beforeEach(async () => {
      await requestAutopilot(AGENT, SESSION)
      await engageAutopilot(AGENT, SESSION, { ...CONTRACT, max_iterations: 2 })
    })

    it('burns an iteration and records the verdict', async () => {
      const decision = await applyContinueVerdict(AGENT, SESSION, {
        verdict: 'continue',
        reasoning: 'report not yet emailed',
        missing: 'criterion 2: email',
      })
      expect(decision).toEqual({ action: 'continue', iteration: 1, maxIterations: 2 })
      const meta = (await getSessionMetadata(AGENT, SESSION))?.autopilot
      expect(meta?.iteration).toBe(1)
      expect(meta?.lastVerdict?.missing).toBe('criterion 2: email')
    })

    it('escalates at the iteration cap', async () => {
      await applyContinueVerdict(AGENT, SESSION, { verdict: 'continue', reasoning: 'r', missing: 'a' })
      await applyContinueVerdict(AGENT, SESSION, { verdict: 'continue', reasoning: 'r', missing: 'b' })
      const third = await applyContinueVerdict(AGENT, SESSION, {
        verdict: 'continue',
        reasoning: 'r',
        missing: 'c',
      })
      expect(third).toEqual({
        action: 'escalate',
        reason: 'iteration-cap',
        iteration: 3,
        maxIterations: 2,
      })
      expect(await state()).toBe('paused')
    })

    it('escalates when the missing fingerprint repeats (no progress)', async () => {
      await applyContinueVerdict(AGENT, SESSION, {
        verdict: 'continue',
        reasoning: 'r',
        missing: 'criterion 2: email',
      })
      const second = await applyContinueVerdict(AGENT, SESSION, {
        verdict: 'continue',
        reasoning: 'r',
        missing: '  Criterion 2: EMAIL ', // whitespace/case-insensitive compare
      })
      expect(second).toEqual({
        action: 'escalate',
        reason: 'no-progress',
        iteration: 2,
        maxIterations: 2,
      })
      expect(await state()).toBe('paused')
    })

    it('keys the no-progress guardrail on the criterion-index set, order-insensitive', async () => {
      const first = await applyContinueVerdict(AGENT, SESSION, {
        verdict: 'continue',
        reasoning: 'r',
        missing_criteria: [2, 1],
      })
      expect(first.action).toBe('continue')
      const second = await applyContinueVerdict(AGENT, SESSION, {
        verdict: 'continue',
        reasoning: 'different words entirely',
        missing_criteria: [1, 2],
      })
      expect(second).toEqual({
        action: 'escalate',
        reason: 'no-progress',
        iteration: 2,
        maxIterations: 2,
      })
      expect(await state()).toBe('paused')
    })

    it('reports not-engaged when the user intervened mid-review', async () => {
      await disengageAutopilot(AGENT, SESSION, 'user_message')
      const decision = await applyContinueVerdict(AGENT, SESSION, {
        verdict: 'continue',
        reasoning: 'r',
      })
      expect(decision).toEqual({ action: 'not-engaged' })
    })
  })
})
