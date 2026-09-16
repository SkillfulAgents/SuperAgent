import { BYOK_VOICE_MESSAGES, realtimeErrorMessage } from '@shared/lib/voice/openai-voice-messages'

export function friendlyRealtimeError(
  err: { code?: string; message?: string } | undefined,
  quotaExceeded = BYOK_VOICE_MESSAGES.quotaExceeded,
): string {
  return realtimeErrorMessage(err, quotaExceeded)
}
