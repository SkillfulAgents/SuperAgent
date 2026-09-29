import { useEffect, useRef } from 'react'
import type { TodoCard } from './todo-schema'
import { todoActions } from './todo-store'

/**
 * Pretend agents, so the prototype feels inhabited. While an item is running,
 * something happens every few seconds: progress lines, then a hand-back (a
 * question first, output to review the second time), and finally the run
 * finishes. A recurring job's finished run leaves it idle until the next one.
 */
export function useSimulatedAgents(cards: TodoCard[]) {
  const timers = useRef(new Map<string, number[]>())

  useEffect(() => {
    const working = new Set(cards.filter((c) => c.column === 'working').map((c) => c.id))

    for (const [id, handles] of timers.current) {
      if (!working.has(id)) {
        handles.forEach((h) => window.clearTimeout(h))
        timers.current.delete(id)
      }
    }

    for (const card of cards) {
      if (card.column !== 'working' || timers.current.has(card.id)) continue
      const agent = card.agents[0]?.name ?? 'The agent'
      const handles: number[] = []
      const at = (ms: number, fn: () => void) => handles.push(window.setTimeout(fn, ms))

      at(2500, () => todoActions.progress(card.id, `${agent} is reading the brief…`))
      at(6000, () => todoActions.progress(card.id, `${agent} is gathering context and drafting…`))
      if (card.simStep === 0) {
        at(11000, () =>
          todoActions.requestAttention(card.id, 'question', 'Quick check before I go further.', [{
            question: `How should I approach "${card.title}"?`,
            header: 'Approach',
            options: [
              { label: 'Fast first pass', description: 'Get something usable back quickly, then iterate.' },
              { label: 'Thorough', description: 'Take longer and cover every case before reporting back.' },
              { label: 'Ask as I go', description: 'Check in whenever there is a judgement call.' },
            ],
          }]),
        )
      } else if (card.simStep === 1) {
        at(11000, () =>
          todoActions.requestAttention(card.id, 'review', `First pass is ready for "${card.title}". Take a look and tell me if it hits the mark.`),
        )
      } else {
        at(9000, () =>
          todoActions.markDone(card.id, card.source === 'recurring' ? `${agent} finished this run.` : `${agent} finished and wrapped up.`),
        )
      }
      timers.current.set(card.id, handles)
    }
  }, [cards])

  useEffect(() => {
    const current = timers.current
    return () => {
      for (const handles of current.values()) handles.forEach((h) => window.clearTimeout(h))
      current.clear()
    }
  }, [])
}
