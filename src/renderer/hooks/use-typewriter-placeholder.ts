import { useEffect, useState } from 'react'

interface Timings {
  typeMs?: number
  deleteMs?: number
  holdFullMs?: number
  holdEmptyMs?: number
}

export function useTypewriterPlaceholder(examples: readonly string[], timings?: Timings): string {
  const [displayed, setDisplayed] = useState('')

  useEffect(() => {
    if (examples.length === 0) return

    const TYPE_MS = timings?.typeMs ?? 25
    const DELETE_MS = timings?.deleteMs ?? 12
    const HOLD_FULL_MS = timings?.holdFullMs ?? 2000
    const HOLD_EMPTY_MS = timings?.holdEmptyMs ?? 350

    let cancelled = false
    let timeoutId: ReturnType<typeof setTimeout>

    const run = (exampleIdx: number, charIdx: number, deleting: boolean) => {
      if (cancelled) return
      const fullText = examples[exampleIdx]

      if (!deleting && charIdx <= fullText.length) {
        setDisplayed(fullText.slice(0, charIdx))
        if (charIdx === fullText.length) {
          timeoutId = setTimeout(() => run(exampleIdx, charIdx, true), HOLD_FULL_MS)
        } else {
          timeoutId = setTimeout(() => run(exampleIdx, charIdx + 1, false), TYPE_MS)
        }
      } else if (deleting && charIdx >= 0) {
        setDisplayed(fullText.slice(0, charIdx))
        if (charIdx === 0) {
          timeoutId = setTimeout(
            () => run((exampleIdx + 1) % examples.length, 0, false),
            HOLD_EMPTY_MS,
          )
        } else {
          timeoutId = setTimeout(() => run(exampleIdx, charIdx - 1, true), DELETE_MS)
        }
      }
    }

    run(0, 0, false)

    return () => {
      cancelled = true
      clearTimeout(timeoutId)
    }
  }, [examples, timings?.typeMs, timings?.deleteMs, timings?.holdFullMs, timings?.holdEmptyMs])

  return displayed
}

/** Stable empty reference so callers can pass `DISABLED` when they don't want the effect to run. */
export const DISABLED: readonly string[] = []

export const DEFAULT_AGENT_PROMPT_EXAMPLES: readonly string[] = [
  'Search LinkedIn for senior backend engineers in NYC with 5+ years of Python experience. Reach out to the top 10 candidates with personalized intro messages.',
  'Every Monday morning, pull highlights from my Granola meetings, Linear issues, and Slack DMs. Send me a briefing of key decisions and blockers from last week.',
  'At the end of every month, reconcile expenses from my Gmail receipts against our QuickBooks ledger. Flag anything missing, duplicated, or out of policy.',
  'Every morning, scan new Linear issues and customer feedback from our support inbox. Cluster them into themes and post a daily summary in our #product Slack channel.',
]
