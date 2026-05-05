import { useCallback } from 'react'
import { flushSync } from 'react-dom'
import { toast } from 'sonner'
import { useCreateAgent } from '@renderer/hooks/use-agents'
import { useSelection } from '@renderer/context/selection-context'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'

export const UNTITLED_AGENT_NAME = 'Untitled'

const ARRIVAL_NAME = 'new-agent-arrival'

// View Transitions API — Chromium-only at time of writing. Electron is fine;
// non-supporting browsers fall through to the instant swap.
type ViewTransitionDocument = Document & {
  startViewTransition?: (cb: () => void | Promise<void>) => { finished: Promise<void> }
}

/**
 * Immediately creates an Untitled agent and selects it. Replaces the old
 * "open the create-agent modal" flow — the user lands on the agent's home
 * page where the composer + creation aids handle the rest.
 *
 * `sourceElement` (when supplied) is the DOM node the new agent visually
 * springs from — its rect is used as the "old" snapshot for a Scale-style
 * view transition into AgentHome. Pass `null` (or call without args) to skip
 * the animation, e.g. when triggered from the Electron app menu.
 */
export function useCreateUntitledAgent() {
  const createAgent = useCreateAgent()
  const { setAgent, setJustCreatedSlug } = useSelection()
  const { track } = useAnalyticsTracking()

  const createUntitledAgent = useCallback(async (sourceElement?: HTMLElement | null) => {
    try {
      const agent = await createAgent.mutateAsync({ name: UNTITLED_AGENT_NAME })
      track('agent_created', { source: 'new', num_skills_added_at_creation: 0 })

      const doc = document as ViewTransitionDocument
      const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      const canAnimate = !!doc.startViewTransition && !!sourceElement && !prefersReducedMotion

      if (!canAnimate) {
        setAgent(agent.slug)
        return agent
      }

      // Tag the source so the browser captures its rect as the "old" snapshot.
      sourceElement!.style.viewTransitionName = ARRIVAL_NAME
      const tx = doc.startViewTransition!(() => {
        // flushSync guarantees the new render — including AgentHome claiming
        // the same name via justCreatedSlug — happens inside the transition
        // capture phase.
        flushSync(() => {
          sourceElement!.style.viewTransitionName = ''
          setJustCreatedSlug(agent.slug)
          setAgent(agent.slug)
        })
      })
      tx.finished.finally(() => setJustCreatedSlug(null))

      return agent
    } catch (error) {
      console.error('Failed to create untitled agent:', error)
      toast.error('Failed to create agent', {
        description: error instanceof Error ? error.message : 'Please try again.',
      })
      return null
    }
  }, [createAgent, setAgent, setJustCreatedSlug, track])

  return {
    createUntitledAgent,
    isPending: createAgent.isPending,
  }
}
