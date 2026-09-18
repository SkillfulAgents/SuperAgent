import { VOICE_HISTORY_MAX_MESSAGES, type VoiceHistory } from './conversation-types'

export interface VoiceHistoryLimits {
  maxMessages: number
  tokenBudget: number
  perMessageChars: number
  perMessageOverheadTokens: number
}

// GPT-Live caps startup `input` at 8,192 tokens; the budget leaves room for
// per-message framing the API may count and for encoding differences.
export const VOICE_HISTORY_LIMITS: VoiceHistoryLimits = {
  maxMessages: VOICE_HISTORY_MAX_MESSAGES,
  tokenBudget: 7500,
  perMessageChars: 1500,
  perMessageOverheadTokens: 4,
}

export const VOICE_HISTORY_TRUNCATION_MARKER = ' […]'

type Tokenizer = { countTokens: (text: string) => number }
let tokenizer: Promise<Tokenizer> | null = null

// 2.3 MB of BPE ranks: load on the first voice session, not at API boot.
function loadTokenizer(): Promise<Tokenizer> {
  tokenizer ??= import('gpt-tokenizer/encoding/o200k_base')
  return tokenizer
}

/** Keep the head of an over-long turn; the answer usually leads, caveats trail. */
export function clipVoiceHistoryTurn(content: string, maxChars: number): string {
  const text = content.trim()
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars).trimEnd() + VOICE_HISTORY_TRUNCATION_MARKER
}

/** Newest-first fill under the token budget and message cap, returned oldest-first. */
export async function windowVoiceHistory(history: VoiceHistory, limits = VOICE_HISTORY_LIMITS): Promise<VoiceHistory> {
  const { countTokens } = await loadTokenizer()
  const kept: VoiceHistory = []
  let used = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const content = clipVoiceHistoryTurn(history[i].content, limits.perMessageChars)
    if (!content) continue
    const cost = countTokens(content) + limits.perMessageOverheadTokens
    if (kept.length >= limits.maxMessages || used + cost > limits.tokenBudget) break
    used += cost
    kept.push({ role: history[i].role, content })
  }
  return kept.reverse()
}
