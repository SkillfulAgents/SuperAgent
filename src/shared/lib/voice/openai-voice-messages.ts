import type { VoiceProvider } from '../config/settings'

export interface OpenaiVoiceMessages {
  missingKey: string
  authFailed: string
  quotaExceeded: string
  liveSessionHint: string
}

export const BYOK_VOICE_MESSAGES: OpenaiVoiceMessages = {
  missingKey: 'Add your OpenAI API key in Settings > Voice.',
  authFailed: 'OpenAI rejected the API key. Check your key and permissions in Settings > Voice.',
  quotaExceeded: 'OpenAI API quota exceeded. Please check your OpenAI account balance and billing settings.',
  liveSessionHint: 'Check your key, GPT-Live access, and billing.',
}

export const PLATFORM_VOICE_MESSAGES: OpenaiVoiceMessages = {
  missingKey: 'Connect your platform account in Settings > Account to use voice.',
  authFailed: 'Platform voice authentication failed. Sign in again and check your voice access.',
  quotaExceeded: 'Voice is unavailable right now: workspace balance or rate limit reached. Check billing and try again shortly.',
  liveSessionHint: 'Check your platform voice access and workspace balance.',
}

export function voiceMessagesFor(provider: VoiceProvider): OpenaiVoiceMessages {
  return provider === 'platform' ? PLATFORM_VOICE_MESSAGES : BYOK_VOICE_MESSAGES
}

export function realtimeErrorMessage(
  err: { code?: string; message?: string } | undefined,
  quotaExceeded: string,
): string {
  const code = err?.code || ''
  const msg = err?.message || 'OpenAI Realtime error'
  if (code === 'insufficient_quota' || code === 'billing_hard_limit_reached' ||
      code === 'rate_limit_exceeded' || /quota|billing|insufficient/i.test(msg)) {
    return quotaExceeded
  }
  return msg
}
