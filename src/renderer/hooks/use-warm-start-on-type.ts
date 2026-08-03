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
 * One-shot: on first non-empty message while the runtime is READY, ensure an
 * agent exists and fire POST /start. Submit can await the same in-flight work
 * via awaitWarmStart() so create-on-submit does not race a second agent.
 */
export function useWarmStartOnType({
  agentSlug,
  message,
  enabled,
  ensureAgent,
}: UseWarmStartOnTypeOptions) {
  const startAgent = useStartAgent()
  const { data: runtimeStatus } = useRuntimeStatus()
  const isReady = runtimeStatus?.runtimeReadiness?.status === 'READY'

  const slugRef = useRef<string | null>(agentSlug)
  const promiseRef = useRef<Promise<string | null> | null>(null)
  const startedRef = useRef(false)
  const ensureAgentRef = useRef(ensureAgent)
  ensureAgentRef.current = ensureAgent

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
          if (!created) return null
          slug = created
          slugRef.current = slug
        }
        startedRef.current = true
        startAgent.mutate(slug, {
          onError: (error) => {
            console.warn('[warm-start] container start failed:', error)
            captureRendererException(error, {
              tags: { area: 'warm-start', op: 'start' },
            })
          },
        })
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
  }, [startAgent])

  useEffect(() => {
    if (!enabled || !isReady || !message.trim()) return
    void run()
  }, [enabled, isReady, message, run])

  const awaitWarmStart = useCallback(async (): Promise<string | null> => {
    if (!enabled) return null
    if (promiseRef.current) return promiseRef.current
    if (startedRef.current && slugRef.current) return slugRef.current
    if (isReady && message.trim()) return run()
    return null
  }, [enabled, isReady, message, run])

  return { awaitWarmStart }
}
