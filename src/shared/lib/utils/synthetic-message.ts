/**
 * The CLI writes assistant entries of its own when a turn ends without a
 * model response, for example right after an interrupt. They carry
 * `message.model: "<synthetic>"`. Two kinds exist:
 *
 * - Placeholders such as "No response requested." — pure transcript noise,
 *   nothing the model said, nothing the person needs to see.
 * - API errors ("API Error: 529 Overloaded ...") — also synthetic, but
 *   flagged `isApiErrorMessage: true` and rendered as an error card.
 *
 * Only the first kind is hidden. Match on the model tag and the flag, never
 * on the placeholder text.
 */
export const SYNTHETIC_MODEL = '<synthetic>'

export interface SyntheticCandidate {
  type?: unknown
  message?: { model?: unknown } | null
  isApiErrorMessage?: unknown
}

/** True for a CLI-authored assistant placeholder that stands in for a missing response. */
export function isSyntheticPlaceholderMessage(entry: SyntheticCandidate): boolean {
  return (
    entry.type === 'assistant' &&
    entry.message?.model === SYNTHETIC_MODEL &&
    entry.isApiErrorMessage !== true
  )
}
