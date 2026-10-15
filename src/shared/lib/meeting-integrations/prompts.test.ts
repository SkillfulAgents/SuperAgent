import { describe, expect, it } from 'vitest'
import { buildLiveConversationPrompt } from '../../prompts/voice-live'
import {
  meetingJoinBrief, meetingLiveSetting, meetingRecordingDisclosure, meetingRosterInstruction, meetingSessionSystemPrompt,
  MEETING_SESSION_SYSTEM_PROMPT, MEETING_LISTEN_LIVE_POLICY, MEETING_SILENT_LIVE_POLICY,
} from './prompts'
import { MEETING_INSTRUCTIONS_MAX_CHARS } from './schemas'
import type { MeetingRecord } from './store'

const meeting = {
  id: 'm1', integrationId: 'i1', agentSlug: 'agent', meetingUrl: 'https://zoom.us/j/4158496404?pwd=s3cret', platform: 'zoom', botName: 'Ada (Gamut)', mode: 'voice',
  botId: null, status: 'joining', statusDetail: null, sessionId: null, context: 'Take notes and answer deck questions', participantTokenHash: 'h',
  createdByUserId: 'alice', requestedAt: new Date(), joinedAt: null, endedAt: null, updatedAt: new Date(),
} satisfies MeetingRecord

describe('meeting prompts', () => {
  it('briefs the agent with the platform and purpose but never the invite link', () => {
    const brief = meetingJoinBrief(meeting, 'Ada')
    expect(brief).toContain('Zoom call as a voice participant')
    expect(brief).toContain('Take notes and answer deck questions')
    expect(brief).toContain('"Ada"')
    expect(brief).not.toContain('zoom.us')
    expect(brief).not.toContain('s3cret')
  })

  it('briefs a silent or listening agent on where its words go instead', () => {
    const silent = meetingJoinBrief({ ...meeting, mode: 'silent' }, 'Ada')
    expect(silent).toContain('silent participant')
    expect(silent).toContain("posted into the call's chat")
    expect(silent).not.toContain('spoken aloud')
    const listen = meetingJoinBrief({ ...meeting, mode: 'listen' }, 'Ada')
    expect(listen).toContain('listening in on a Zoom call')
    expect(listen).toContain('Nobody in the call hears or sees your output')
    expect(listen).toContain('who said what')
  })

  it('describes the room for the Live model: policy, name, brief and who is there', () => {
    const setting = meetingLiveSetting(meeting, [{ id: '1', name: 'Iddo', isHost: true }, { id: '2', name: 'Maya', isHost: false }])
    expect(setting.policy.turnTaking).toContain('Never backchannel')
    expect(setting.instructions).toContain('Zoom call under the name "Ada (Gamut)"')
    expect(setting.instructions).toContain('"Take notes and answer deck questions"')
    expect(setting.instructions).toContain('in the call now: Iddo (host), Maya. Group setting')
    expect(setting.instructions).not.toContain('zoom.us')
    expect(setting.voice).toBeUndefined()
    // Through the generic prompt it replaces the one-on-one rules.
    const prompt = buildLiveConversationPrompt({ name: 'Ada', instructions: '', capabilityPolicies: { subagents: 'allow', workflows: 'allow' }, setting })
    expect(prompt).toContain('Default to silence')
    expect(prompt).toContain('Answer once, then the floor returns to the room')
    expect(prompt).not.toContain('Use moderate backchannels')
    expect(prompt).toContain('A thinking update on its own never triggers speech')
    expect(prompt).toContain('If the room has already heard the outcome, stay silent')
  })

  it('picks the mute policies for silent and listening bots and carries the chosen voice', () => {
    const silent = meetingLiveSetting({ ...meeting, mode: 'silent' }, [{ id: '1', name: 'Iddo', isHost: true }], { voice: 'cinder' })
    expect(silent.policy).toBe(MEETING_SILENT_LIVE_POLICY)
    expect(silent.policy.turnTaking).toContain('you never speak')
    expect(silent.policy.spokenUpdates).toContain('Never speak it')
    expect(silent.voice).toBe('cinder')
    // One person in the room does not turn a silent bot into a conversation partner.
    expect(silent.instructions).toContain('You never speak; keep listening')
    expect(silent.instructions).not.toContain('one-on-one')
    const listen = meetingLiveSetting({ ...meeting, mode: 'listen' }, [])
    expect(listen.policy).toBe(MEETING_LISTEN_LIVE_POLICY)
    expect(listen.policy.turnTaking).toContain('without waiting to be addressed')
    expect(listen.voice).toBeUndefined()
  })

  it('relaxes the room rules for a single person and asks for silence in an empty room', () => {
    expect(meetingRosterInstruction([{ name: 'Iddo', isHost: true }])).toContain('only Iddo (host) and you are in the call now. Treat this as a one-on-one conversation')
    expect(meetingRosterInstruction([])).toContain('nobody else is in the call right now')
    expect(meetingLiveSetting({ ...meeting, context: null }, []).instructions).not.toContain('asked for this meeting:')
  })

  it('carries the installation\'s standing instructions into the session prompt and the room description, ahead of the brief for this call', () => {
    expect(meetingSessionSystemPrompt(undefined)).toBe(MEETING_SESSION_SYSTEM_PROMPT)
    expect(meetingSessionSystemPrompt('   ')).toBe(MEETING_SESSION_SYSTEM_PROMPT)
    const standing = 'Always introduce yourself as the notes bot. Never quote prices.'
    const session = meetingSessionSystemPrompt(standing)
    expect(session.startsWith(MEETING_SESSION_SYSTEM_PROMPT)).toBe(true)
    expect(session).toContain(`Standing instructions for every meeting you join:\n${standing}`)

    const setting = meetingLiveSetting(meeting, [], { instructions: standing })
    const standingAt = setting.instructions.indexOf('Never quote prices')
    const briefAt = setting.instructions.indexOf('Take notes and answer deck questions')
    expect(standingAt).toBeGreaterThan(-1)
    expect(briefAt).toBeGreaterThan(standingAt)
    expect(meetingLiveSetting(meeting, []).instructions).not.toContain('Standing instructions')

    // Oversized text is cut, not refused: the bound is the prompt budget, not validation.
    const long = 'x'.repeat(MEETING_INSTRUCTIONS_MAX_CHARS + 500)
    expect(meetingSessionSystemPrompt(long)).not.toContain('x'.repeat(MEETING_INSTRUCTIONS_MAX_CHARS + 1))
    expect(meetingLiveSetting(meeting, [], { instructions: long }).instructions).not.toContain('x'.repeat(MEETING_INSTRUCTIONS_MAX_CHARS + 1))
  })

  it('tells the agent where its replies go in each mode', () => {
    expect(meetingSessionSystemPrompt(null, 'voice')).toContain('spoken into the call')
    expect(meetingSessionSystemPrompt(null, 'silent')).toContain('posted into the meeting chat as text')
    expect(meetingSessionSystemPrompt(null, 'silent')).toContain('deliver_file')
    const listen = meetingSessionSystemPrompt('Flag numbers that sound off.', 'listen')
    expect(listen).toContain('Nothing you write reaches the call')
    expect(listen).toContain('do not post into the meeting chat')
    expect(listen).toContain('Flag numbers that sound off.')
  })

  it('tells the room what joined, how it takes part, and that audio is kept', () => {
    const line = meetingRecordingDisclosure('Ada (Gamut)')
    expect(line).toContain("I'm Ada (Gamut), an AI assistant")
    expect(line).toContain('I take part by voice')
    expect(line).toMatch(/record this call's audio/)
    expect(line).toMatch(/kept for 7 days/)
    expect(meetingRecordingDisclosure('Ada', 'silent')).toContain('I answer in this chat rather than out loud and record')
    expect(meetingRecordingDisclosure('Ada', 'listen')).toContain('I only listen and record')
    expect(meetingRecordingDisclosure('Ada', 'listen')).not.toContain('by voice')
  })
})
