import { VOICE_HISTORY_MAX_BYTES, VOICE_HISTORY_MAX_MESSAGE_CHARS, VOICE_HISTORY_MAX_MESSAGES, type VoiceHistory } from './conversation-types'

const utf8 = new TextEncoder()

/** Newest-first fill under the transport caps, returned oldest-first; the host trims to the model's token budget. */
export function boundVoiceHistoryTransport(history: VoiceHistory): VoiceHistory {
  const kept: VoiceHistory = []
  let bytes = '[]'.length
  for (let i = history.length - 1; i >= 0 && kept.length < VOICE_HISTORY_MAX_MESSAGES; i--) {
    const entry = { role: history[i].role, content: history[i].content.slice(0, VOICE_HISTORY_MAX_MESSAGE_CHARS) }
    const cost = utf8.encode(JSON.stringify(entry)).byteLength + ','.length
    if (bytes + cost > VOICE_HISTORY_MAX_BYTES) break
    bytes += cost
    kept.push(entry)
  }
  return kept.reverse()
}
