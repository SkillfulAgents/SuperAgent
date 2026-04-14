import { useMemo } from 'react'
import cronstrue from 'cronstrue'

/**
 * Returns a human-readable description of a cron expression.
 * Falls back to the raw expression if parsing fails.
 */
export function useHumanizedCron(expression: string | null | undefined): string | null {
  return useMemo(() => {
    if (!expression) return null
    try {
      return cronstrue.toString(expression, {
        use24HourTimeFormat: false,
        verbose: true,
      })
    } catch {
      return expression
    }
  }, [expression])
}
