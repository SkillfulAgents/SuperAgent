/**
 * Format a playback position (in seconds) as a clock-style `m:ss` string, or
 * `h:mm:ss` once past an hour. Shared by the video renderer, the comment
 * overlay, and the comment bar so a timestamp reads identically everywhere.
 * Negative or non-finite inputs collapse to `0:00`.
 */
export function formatMediaTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = s.toString().padStart(2, '0')
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${ss}`
  return `${m}:${ss}`
}
