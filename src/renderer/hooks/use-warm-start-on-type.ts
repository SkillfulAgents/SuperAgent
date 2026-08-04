import { useCallback, useEffect, useRef } from 'react'
import { useStartAgent } from '@renderer/hooks/use-agents'
import { useRuntimeStatus } from '@renderer/hooks/use-runtime-status'
import { captureRendererException } from '@renderer/lib/error-reporting'

export interface UseWarmStartOnTypeOptions {
  /** Existing agent slug (AgentHome). Null when the agent is created on demand. */
  agentSlug: string | null
  message: string
  enabled: boolean
  /** Create an agent when none exists yet (CreateAgentForm). Returns its slug. */
  ensureAgent?: () => Promise<string | null>
}

/**
 * One-shot: on the first user edit that leaves a non-empty message while the
 * runtime is READY, ensure an agent exists and fire POST /start. Restored
 * drafts do not trigger — only a change from the mount-time baseline does.
 * Submit can await the same in-flight work via awaitWarmStart().
 */
export function useWarmStartOnType({
  agentSlug,
  message,
  enabled,
  ensureAgent,
}: UseWarmStartOnTypeOptions) {
  const startAgent = useStartAgent()
  const startMutateRef = useRef(startAgent.mutate)
  startMutateRef.current = startAgent.mutate

  const { data: runtimeStatus } = useRuntimeStatus()
  const isReady = runtimeStatus?.runtimeReadiness?.status === 'READY'

  const slugRef = useRef<string | null>(agentSlug)
  const promiseRef = useRef<Promise<string | null> | null>(null)
  const startedRef = useRef(false)
  const ensureAgentRef = useRef(ensureAgent)
  ensureAgentRef.current = ensureAgent

  // Mount-time baseline — restored drafts must not count as "typing".
  const baselineRef = useRef(message)

  useEffect(() => {
    if (agentSlug) slugRef.current = agentSlug
  }, [agentSlug])

  const run = useCallback((): Promise<string | null> => {
    if (promiseRef.current) return promiseRef.current
    if (startedRef.current && slugRef.current) {
      return Promise.resolve(slugRef.current)
    }

    promiseRef.current = (async () => {
      try {
        let slug = slugRef.current
        if (!slug) {
          const created = await ensureAgentRef.current?.()
          if (!created) {
            promiseRef.current = null
            return null
          }
          slug = created
          slugRef.current = slug
        }
        startedRef.current = true
        startMutateRef.current(
          { slug, source: 'warm-start' },
          {
            onError: (error) => {
              console.warn('[warm-start] container start failed:', error)
              captureRendererException(error, {
                tags: { area: 'warm-start', op: 'start' },
              })
            },
          },
        )
        return slug
      } catch (error) {
        console.warn('[warm-start] ensure agent failed:', error)
        captureRendererException(error, {
          tags: { area: 'warm-start', op: 'ensure-agent' },
        })
        promiseRef.current = null
        return null
      }
    })()

    return promiseRef.current
  }, [])

  useEffect(() => {
    if (!enabled || !isReady) return
    if (!message.trim()) return
    // Only fire after the user changes the field from its mount-time value.
    if (message === baselineRef.current) return
    void run()
  }, [enabled, isReady, message, run])

  const awaitWarmStart = useCallback(async (): Promise<string | null> => {
    // Prefer an already-created warm agent even if the setting was toggled off
    // mid-draft, so submit does not create a second agent.
    if (promiseRef.current) return promiseRef.current
    if (startedRef.current && slugRef.current) return slugRef.current
    if (!enabled) return null
    if (isReady && message.trim()) return run()
    return null
  }, [enabled, isReady, message, run])

  return { awaitWarmStart }
}
