import { describe, expect, it } from 'vitest'
import { isSystemMessageText } from '@shared/lib/utils/system-message'
import {
  VOICE_MODE_ENTERED_MESSAGE,
  VOICE_MODE_EXITED_MESSAGE,
  classifyVoiceModeNotice,
} from './voice-mode-messages'

describe('voice mode notices', () => {
  it('are system messages, so the container never counts them as a human turn', () => {
    expect(isSystemMessageText(VOICE_MODE_ENTERED_MESSAGE)).toBe(true)
    expect(isSystemMessageText(VOICE_MODE_EXITED_MESSAGE)).toBe(true)
  })

  it('classify by their first line', () => {
    expect(classifyVoiceModeNotice(VOICE_MODE_ENTERED_MESSAGE)).toBe('entered')
    expect(classifyVoiceModeNotice(VOICE_MODE_EXITED_MESSAGE)).toBe('exited')
  })

  it('leave other system messages and plain text alone', () => {
    expect(classifyVoiceModeNotice('[SYSTEM] This session is resuming as scheduled.')).toBeNull()
    expect(classifyVoiceModeNotice('The user switched to voice mode.')).toBeNull()
    expect(classifyVoiceModeNotice('')).toBeNull()
  })

  it('tell the agent what changes about the conversation', () => {
    expect(VOICE_MODE_ENTERED_MESSAGE).toMatch(/read aloud/)
    expect(VOICE_MODE_ENTERED_MESSAGE).toMatch(/brief/)
    expect(VOICE_MODE_ENTERED_MESSAGE).toMatch(/transcription/)
    expect(VOICE_MODE_ENTERED_MESSAGE).toMatch(/open question/)
    expect(VOICE_MODE_ENTERED_MESSAGE).toMatch(/file uploads/)
    expect(VOICE_MODE_EXITED_MESSAGE).toMatch(/normal/)
  })
})
