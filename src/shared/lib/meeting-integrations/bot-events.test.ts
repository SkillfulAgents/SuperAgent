import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeetingRecord } from './store'

const mocks = vi.hoisted(() => ({
  getIntegrationSession: vi.fn(),
  parseScreenFrame: vi.fn(),
  offer: vi.fn(),
}))
vi.mock('../services/agent-integration-service', () => ({ getAgentIntegration: async () => ({ provider: 'recall' }) }))
vi.mock('../agent-integrations/store', () => ({ getIntegrationSession: mocks.getIntegrationSession }))
vi.mock('./providers', () => ({ meetingProviders: [{ definition: { provider: 'recall' }, parseScreenFrame: mocks.parseScreenFrame }] }))
vi.mock('./screenshots', () => ({ meetingScreenshots: { offer: mocks.offer } }))
vi.mock('./transcript-speakers', () => ({ meetingSpeakerStarted: vi.fn() }))

import { meetingScreenFrameReceiver } from './bot-events'

const meeting = { id: 'meeting-1', integrationId: 'integration-1', agentSlug: 'ada', sessionId: null } as MeetingRecord
const frame = { at: new Date('2026-11-05T10:00:00Z'), png: new Uint8Array([1, 2, 3]) }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getIntegrationSession.mockResolvedValue(null)
  mocks.parseScreenFrame.mockReturnValue(frame)
})

describe('meeting screenshot session routing', () => {
  it('uses the meeting’s recorded agent session for screenshots', async () => {
    const receive = await meetingScreenFrameReceiver({ ...meeting, sessionId: 'session-1' })
    await receive!({})
    expect(mocks.offer).toHaveBeenCalledWith({ ...meeting, sessionId: 'session-1' }, frame)
    expect(mocks.getIntegrationSession).not.toHaveBeenCalled()
  })

  it('waits for the durable session mapping when the socket opens during session startup', async () => {
    const receive = await meetingScreenFrameReceiver(meeting)
    await receive!({})
    expect(mocks.offer).not.toHaveBeenCalled()
    expect(mocks.getIntegrationSession).toHaveBeenCalledWith('integration-1', 'meeting-1')

    mocks.getIntegrationSession.mockResolvedValue({ sessionId: 'session-1' })
    await receive!({})
    await receive!({})
    expect(mocks.offer).toHaveBeenCalledTimes(2)
    expect(mocks.offer).toHaveBeenLastCalledWith({ ...meeting, sessionId: 'session-1' }, frame)
    expect(mocks.getIntegrationSession).toHaveBeenCalledTimes(2)
  })

  it('does not resolve a session or save a discarded camera frame', async () => {
    mocks.parseScreenFrame.mockReturnValue(null)
    const receive = await meetingScreenFrameReceiver(meeting)
    await receive!({})
    expect(mocks.offer).not.toHaveBeenCalled()
    expect(mocks.getIntegrationSession).not.toHaveBeenCalled()
  })
})
