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
  'Be my recruiter. Source senior backend engineers on LinkedIn, screen them against our hiring bar, and open personalized intros with the strongest candidates.',
  'You are my chief of staff. Stay across my Granola meetings, Linear issues, and Slack DMs, and brief me every Monday on what got decided and what is blocked.',
  'I need a bookkeeper. Reconcile the receipts in my Gmail against our QuickBooks ledger each month and flag anything missing, duplicated, or out of policy.',
  'Act as our product analyst. Watch new Linear issues and our support inbox, cluster the feedback into themes, and post a daily read on what users are struggling with in #product.',
]
