import { SYSTEM_MESSAGE_PREFIX } from '@shared/lib/utils/system-message'

/**
 * The two notices the app sends the agent when the user switches voice mode
 * on and off. Both are ordinary `[SYSTEM]` user turns appended to the
 * transcript without starting a turn, so the agent reads them with the next
 * thing the user says. The transcript draws each as a dashed boundary line.
 *
 * The first line is the marker the renderer classifies on: keep it stable.
 */
export const VOICE_MODE_ENTERED_MARKER = `${SYSTEM_MESSAGE_PREFIX}The user switched to voice mode.`
export const VOICE_MODE_EXITED_MARKER = `${SYSTEM_MESSAGE_PREFIX}The user left voice mode.`

export const VOICE_MODE_ENTERED_MESSAGE = `${VOICE_MODE_ENTERED_MARKER}
From now on the user is talking to you and your replies are read aloud by text-to-speech.
- Keep replies brief and conversational: a few spoken sentences, no headings, tables, code blocks, or bullet lists unless the user asks for them.
- The user's messages are speech transcriptions: expect misheard words, missing punctuation, and names spelled phonetically. Work out what was meant before asking them to repeat.
- Prefer asking an open question in your reply over the structured question tool.
- You can still ask for file uploads, secrets, and other input when a task needs them.`

export const VOICE_MODE_EXITED_MESSAGE = `${VOICE_MODE_EXITED_MARKER}
The user is typing again and reading your replies on screen. Go back to your normal reply style and tools.`

export type VoiceModeNotice = 'entered' | 'exited'

/** Which voice-mode notice `text` is, or null for any other message. */
export function classifyVoiceModeNotice(text: string): VoiceModeNotice | null {
  if (text.startsWith(VOICE_MODE_ENTERED_MARKER)) return 'entered'
  if (text.startsWith(VOICE_MODE_EXITED_MARKER)) return 'exited'
  return null
}
