import { estimateTokenCount } from 'tokenx'
import { VOICE_HISTORY_MAX_MESSAGES, type VoiceHistory } from './conversation-types'

export interface VoiceHistoryLimits {
  maxMessages: number
  tokenBudget: number
  perMessageChars: number
  perMessageOverheadTokens: number
}

// GPT-Live caps startup `input` at 8,192 tokens. tokenx ~12% MAPE vs o200k;
// 7,000 stayed under the cap on 1,996 sessions (max framed 8,174).
export const VOICE_HISTORY_LIMITS: VoiceHistoryLimits = {
  maxMessages: VOICE_HISTORY_MAX_MESSAGES,
  tokenBudget: 7000,
  perMessageChars: 1500,
  perMessageOverheadTokens: 4,
}

export const VOICE_HISTORY_TRUNCATION_MARKER = ' […]'

/** Keep the head of an over-long turn; the answer usually leads, caveats trail. */
export function clipVoiceHistoryTurn(content: string, maxChars: number): string {
  const text = content.trim()
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars).trimEnd() + VOICE_HISTORY_TRUNCATION_MARKER
}

/** Newest-first fill under the token budget and message cap, returned oldest-first. */
export function windowVoiceHistory(history: VoiceHistory, limits = VOICE_HISTORY_LIMITS): VoiceHistory {
  const kept: VoiceHistory = []
  let used = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const content = clipVoiceHistoryTurn(history[i].content, limits.perMessageChars)
    if (!content) continue
    const cost = estimateTokenCount(content) + limits.perMessageOverheadTokens
    if (kept.length >= limits.maxMessages || used + cost > limits.tokenBudget) break
    used += cost
    kept.push({ role: history[i].role, content })
  }
  return kept.reverse()
}
