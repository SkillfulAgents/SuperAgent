/**
 * Format a playback position (in seconds) as a clock-style `m:ss` string, or
 * `h:mm:ss` once past an hour. Shared by every media surface so the clock and
 * a comment agree on the whole seconds. `hundredths` appends floored hundredths of a
 * second (`3:21.40`). Negative or non-finite inputs collapse to zero.
 */
export function formatMediaTime(seconds: number, { hundredths = false } = {}): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  let ss = s.toString().padStart(2, '0')
  if (hundredths) {
    // From the fraction alone, so the whole seconds never move. The tolerance absorbs
    // float error such as 0.29 * 100 = 28.999999999999996, and the cap keeps a
    // rounded-up fraction from printing `.100`.
    const cs = Math.min(99, Math.floor((seconds - total) * 100 + 1e-6))
    ss += `.${cs.toString().padStart(2, '0')}`
  }
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${ss}`
  return `${m}:${ss}`
}

/** A comment's time, with hundredths so two comments a frame apart read differently; the running clock uses whole seconds. */
export function formatCommentTime(seconds: number): string {
  return formatMediaTime(seconds, { hundredths: true })
}
