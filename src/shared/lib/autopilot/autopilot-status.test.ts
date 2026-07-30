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

import { isAgentAutopilotEngaged } from './autopilot-status'
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
})
