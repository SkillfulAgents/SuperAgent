import { beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ session: null as { externalId: string; integrationId: string } | null, meeting: null as { id: string; agentSlug: string; integrationId: string; botName: string } | null }))
vi.mock('../agent-integrations/store', () => ({ getIntegrationSessionBySessionId: async () => state.session }))
vi.mock('./store', () => ({ getMeeting: async () => state.meeting }))
import { meetingSpeakerStarted, nameVoiceSpeech } from './transcript-speakers'

beforeEach(() => { state.session = null; state.meeting = null })
describe('meeting enrichment of voice speech', () => {
  it('uses User/Assistant for ordinary sessions', async () => {
    expect((await nameVoiceSpeech('ada', 's1', [{ role: 'user', text: 'hi', at: 100 }, { role: 'assistant', text: 'hello', at: 200 }])).map(piece => piece.speaker)).toEqual(['User', 'Assistant'])
  })
  it('shares speaker changes between callbacks and speech requests and keeps bot speech named separately', async () => {
    state.session = { externalId: 'm1', integrationId: 'i1' }
    state.meeting = { id: 'm1', agentSlug: 'ada', integrationId: 'i1', botName: 'Ada (Gamut)' }
    await meetingSpeakerStarted('m1', 'Anna', 100)
    await meetingSpeakerStarted('m1', 'Bob', 300)
    const pieces = [50, 200, 400].map(at => ({ at, role: 'user' as const, text: 'hi' }))
    expect((await nameVoiceSpeech('ada', 's1', [...pieces, { at: 500, role: 'assistant', text: 'hello' }])).map(piece => piece.speaker)).toEqual(['Unknown participant', 'Anna', 'Bob', 'Ada (Gamut)'])
    expect((await nameVoiceSpeech('another-agent', 's1', pieces)).map(piece => piece.speaker)).toEqual(['User', 'User', 'User'])
  })
})
