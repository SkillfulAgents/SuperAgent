import { useState, useEffect } from 'react'

/**
 * Format milliseconds into a human-readable elapsed time string.
 * Examples: "5s", "1m 23s", "1h 5m"
 */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return `${minutes}m ${seconds}s`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${hours}h ${remainingMinutes}m`
}

/**
 * Hook that returns a formatted elapsed time string.
 *
 * - If `startTime` is null, returns null (no timer).
 * - If `endTime` is provided, returns a static elapsed value (completed timer).
 * - If `endTime` is omitted/null, ticks every second (live timer).
 */
function toTimestamp(d: Date | string): number {
  return typeof d === 'string' ? new Date(d).getTime() : d.getTime()
}

export function useElapsedTimer(startTime: Date | string | null, endTime?: Date | string | null): string | null {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!startTime || endTime) return
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [startTime, endTime])

  if (!startTime) return null

  const end = endTime ? toTimestamp(endTime) : now
  const elapsed = Math.max(0, end - toTimestamp(startTime))
  return formatElapsed(elapsed)
}
