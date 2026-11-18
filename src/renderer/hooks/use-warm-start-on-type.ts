import { useCallback, useEffect, useRef } from 'react'
import { useStartAgent } from '@renderer/hooks/use-agents'
import { useRuntimeStatus } from '@renderer/hooks/use-runtime-status'
import { captureRendererException } from '@renderer/lib/error-reporting'

/**
 * How long a composer bound to a session waits before warming again. The
 * session's agent process is evicted after a few idle minutes and the
 * container sleeps after longer, so a reply typed after a pause needs a fresh
 * start; the cooldown keeps keystrokes from turning into a request each.
 */
export const WARM_START_SESSION_REFIRE_MS = 60_000

export interface UseWarmStartOnTypeOptions {
  /** Existing agent slug (AgentHome). Null when the agent is created on demand. */
  agentSlug: string | null
  /**
   * The session the composer sends into; null/absent for a new session. The
   * start then also resumes that session's agent process, and the composer
   * warms again once WARM_START_SESSION_REFIRE_MS has passed.
   */
  sessionId?: string | null
  message: string
  enabled: boolean
  /** Create an agent when none exists yet (CreateAgentForm). Returns its slug. */
  ensureAgent?: () => Promise<string | null>
}

/**
 * On the first user edit that leaves a non-empty message while the runtime is
 * READY, ensure an agent exists and fire POST /start. Restored drafts do not
 * trigger — only a change from the mount-time baseline does. Submit can await
 * the same in-flight work via awaitWarmStart().
 *
 * One-shot for a new session. A composer bound to a session fires again on a
 * later edit once the cooldown has passed, or right away for another session.
 */
export function useWarmStartOnType({
  agentSlug,
  sessionId = null,
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
  const sessionIdRef = useRef<string | null>(sessionId)
  sessionIdRef.current = sessionId
  const promiseRef = useRef<Promise<string | null> | null>(null)
  const startedRef = useRef(false)
  // What the last start warmed, and when — for the session re-warm.
  const lastStartRef = useRef<{ slug: string; sessionId: string | null; at: number } | null>(null)
  const ensureAgentRef = useRef(ensureAgent)
  ensureAgentRef.current = ensureAgent

  // Mount-time baseline — restored drafts / programmatic prefills must not
  // count as "typing". Call noteProgrammaticChange(next) before setMessage(next).
  const baselineRef = useRef(message)

  const noteProgrammaticChange = useCallback((next: string) => {
    baselineRef.current = next
  }, [])

  useEffect(() => {
    if (agentSlug) slugRef.current = agentSlug
  }, [agentSlug])

  const fireStart = useCallback((slug: string) => {
    const session = sessionIdRef.current
    startedRef.current = true
    lastStartRef.current = { slug, sessionId: session, at: Date.now() }
    startMutateRef.current(
      { slug, source: 'warm-start', ...(session ? { sessionId: session } : {}) },
      {
        onError: (error) => {
          console.warn('[warm-start] container start failed:', error)
          captureRendererException(error, {
            tags: { area: 'warm-start', op: 'start' },
          })
        },
      },
    )
  }, [])

  const run = useCallback((): Promise<string | null> => {
    const session = sessionIdRef.current
    const last = lastStartRef.current
    if (
      session && startedRef.current && slugRef.current && last &&
      (last.slug !== slugRef.current || last.sessionId !== session || Date.now() - last.at >= WARM_START_SESSION_REFIRE_MS)
    ) {
      fireStart(slugRef.current)
      return Promise.resolve(slugRef.current)
    }
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
        fireStart(slug)
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
  }, [fireStart])

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

  const warmStart = useCallback(() => {
    if (enabled && isReady) void run()
  }, [enabled, isReady, run])

  return { awaitWarmStart, noteProgrammaticChange, warmStart }
}
