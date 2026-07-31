import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const activeSessions: string[] = []
vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: {
    getActiveSessionIdsForAgent: vi.fn(() => activeSessions),
  },
}))

import {
  isAgentAutopilotEngaged,
  getAutopilotAuthorization,
  isAutopilotAuthorizationCurrent,
} from './autopilot-status'
import { updateSessionMetadata } from '@shared/lib/services/session-service'

const AGENT = 'status-test-agent'

describe('isAgentAutopilotEngaged', () => {
  let testDir: string
  let originalEnv: string | undefined

  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'autopilot-status-test-'))
    originalEnv = process.env.SUPERAGENT_DATA_DIR
    process.env.SUPERAGENT_DATA_DIR = testDir
    await fs.promises.mkdir(path.join(testDir, 'agents', AGENT, 'workspace'), { recursive: true })
    activeSessions.length = 0
  })

  afterEach(async () => {
    if (originalEnv) {
      process.env.SUPERAGENT_DATA_DIR = originalEnv
    } else {
      delete process.env.SUPERAGENT_DATA_DIR
    }
    await fs.promises.rm(testDir, { recursive: true, force: true })
  })

  it('false when the agent has no active sessions', async () => {
    expect(await isAgentAutopilotEngaged(AGENT)).toBe(false)
  })

  it('true when the only active session is engaged', async () => {
    await updateSessionMetadata(AGENT, 's1', { autopilot: { state: 'engaged' } })
    activeSessions.push('s1')
    expect(await isAgentAutopilotEngaged(AGENT)).toBe(true)
  })

  it('false for a lone interactive or merely-requested session', async () => {
    await updateSessionMetadata(AGENT, 's1', { autopilot: { state: 'requested' } })
    activeSessions.push('s1')
    expect(await isAgentAutopilotEngaged(AGENT)).toBe(false)
  })

  it('false when an interactive session is live alongside an engaged one (conservative on mixes)', async () => {
    await updateSessionMetadata(AGENT, 's1', { autopilot: { state: 'engaged' } })
    await updateSessionMetadata(AGENT, 's2', { name: 'interactive' })
    activeSessions.push('s1', 's2')
    expect(await isAgentAutopilotEngaged(AGENT)).toBe(false)
  })

  it('true when every active session is engaged', async () => {
    await updateSessionMetadata(AGENT, 's1', { autopilot: { state: 'engaged' } })
    await updateSessionMetadata(AGENT, 's2', { autopilot: { state: 'engaged' } })
    activeSessions.push('s1', 's2')
    expect(await isAgentAutopilotEngaged(AGENT)).toBe(true)
  })

  describe('authorization snapshot and revalidation', () => {
    const ERA = '2026-01-01T00:00:00.000Z'

    it('captures the engaged sessions with their era markers', async () => {
      await updateSessionMetadata(AGENT, 's1', {
        autopilot: { state: 'engaged', requestedAt: ERA },
      })
      activeSessions.push('s1')
      expect(await getAutopilotAuthorization(AGENT)).toEqual({
        sessions: [{ sessionId: 's1', requestedAt: ERA }],
      })
    })

    it('still current while nothing changed', async () => {
      await updateSessionMetadata(AGENT, 's1', {
        autopilot: { state: 'engaged', requestedAt: ERA },
      })
      activeSessions.push('s1')
      const authorization = (await getAutopilotAuthorization(AGENT))!
      expect(await isAutopilotAuthorizationCurrent(AGENT, authorization)).toBe(true)
    })

    it('invalidated when the user switches autopilot off mid-review', async () => {
      await updateSessionMetadata(AGENT, 's1', {
        autopilot: { state: 'engaged', requestedAt: ERA },
      })
      activeSessions.push('s1')
      const authorization = (await getAutopilotAuthorization(AGENT))!
      await updateSessionMetadata(AGENT, 's1', { autopilot: { state: 'off' } })
      expect(await isAutopilotAuthorizationCurrent(AGENT, authorization)).toBe(false)
    })

    it('invalidated when an interrupt opens a new era, even if re-engaged', async () => {
      await updateSessionMetadata(AGENT, 's1', {
        autopilot: { state: 'engaged', requestedAt: ERA },
      })
      activeSessions.push('s1')
      const authorization = (await getAutopilotAuthorization(AGENT))!
      // Interrupt restamps the era; the next task re-engages before the
      // pending review resolves. Same session, same state — different task.
      await updateSessionMetadata(AGENT, 's1', {
        autopilot: { state: 'engaged', requestedAt: '2026-02-01T00:00:00.000Z' },
      })
      expect(await isAutopilotAuthorizationCurrent(AGENT, authorization)).toBe(false)
    })

    it('invalidated when another session becomes active mid-review', async () => {
      await updateSessionMetadata(AGENT, 's1', {
        autopilot: { state: 'engaged', requestedAt: ERA },
      })
      activeSessions.push('s1')
      const authorization = (await getAutopilotAuthorization(AGENT))!
      await updateSessionMetadata(AGENT, 's2', {
        autopilot: { state: 'engaged', requestedAt: ERA },
      })
      activeSessions.push('s2')
      expect(await isAutopilotAuthorizationCurrent(AGENT, authorization)).toBe(false)
    })
  })
})
