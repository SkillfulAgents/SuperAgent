import { beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ session: null as { externalId: string; integrationId: string } | null, meeting: null as { id: string; agentSlug: string; integrationId: string; botName: string } | null }))
vi.mock('../agent-integrations/store', () => ({ getIntegrationSessionBySessionId: async () => state.session }))
vi.mock('./store', () => ({ getMeeting: async () => state.meeting }))
import { meetingSpeakerStarted, nameMeetingVoiceSpeech } from './transcript-speakers'
import { nameVoiceSpeech } from '../voice/transcripts'

beforeEach(() => { state.session = null; state.meeting = null })
describe('meeting enrichment of voice speech', () => {
  it('preserves the common speaker identities for ordinary sessions', async () => {
    const pieces = nameVoiceSpeech([{ role: 'user', text: 'hi', at: 100 }, { role: 'assistant', text: 'hello', at: 200 }], 'Dana')
    expect(await nameMeetingVoiceSpeech('ada', 's1', pieces)).toEqual(pieces)
  })
  it('shares speaker changes between callbacks and speech requests and keeps bot speech named separately', async () => {
    state.session = { externalId: 'm1', integrationId: 'i1' }
    state.meeting = { id: 'm1', agentSlug: 'ada', integrationId: 'i1', botName: 'Ada (Gamut)' }
    await meetingSpeakerStarted('m1', 'Anna', 100)
    await meetingSpeakerStarted('m1', 'Bob', 300)
    const pieces = nameVoiceSpeech([
      ...[50, 200, 400].map(at => ({ at, role: 'user' as const, text: 'hi' })),
      { at: 500, role: 'assistant', text: 'hello' },
    ], 'Meeting initiator')
    expect((await nameMeetingVoiceSpeech('ada', 's1', pieces)).map(piece => piece.speaker)).toEqual(['Unknown participant', 'Anna', 'Bob', 'Ada (Gamut)'])
    expect(await nameMeetingVoiceSpeech('another-agent', 's1', pieces)).toEqual(pieces)
  })
})
