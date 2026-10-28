import { useMemo } from 'react'
import cronstrue from 'cronstrue'

/**
 * Human-readable description of a cron expression; falls back to the raw
 * expression if parsing fails.
 */
export function humanizeCron(expression: string): string {
  try {
    return cronstrue.toString(expression, {
      use24HourTimeFormat: false,
      verbose: true,
    })
  } catch {
    return expression
  }
}

/** Hook form of {@link humanizeCron} for memoized component use. */
export function useHumanizedCron(expression: string | null | undefined): string | null {
  return useMemo(() => (expression ? humanizeCron(expression) : null), [expression])
}
