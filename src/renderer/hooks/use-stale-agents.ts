import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { useAgents } from './use-agents'
import type { ApiAgent, ApiStaleAgents, StaleAgentEntry } from '@shared/lib/types/api'

export const STALE_AGENTS_KEY = ['stale-agents'] as const

export interface StaleAgentRow extends StaleAgentEntry {
  name: string
  /** Mid-turn: a restart will interrupt it. Shown as a marker, never a skip. */
  working: boolean
}

/** Join host entries against the live agent list; an unknown slug shows as itself. */
export function describeStaleAgents(entries: StaleAgentEntry[], agents: ApiAgent[]): StaleAgentRow[] {
  return entries.map((entry) => {
    const agent = agents.find((a) => a.slug === entry.slug)
    return { ...entry, name: agent?.name ?? entry.slug, working: agent?.hasActiveSessions === true }
  })
}

/**
 * The host's record of agents still on a pre-change container env, plus the
 * one action that clears it. The record only changes on the host: it is
 * refetched on agent status events and after every auth success (see
 * global-notification-handler and use-platform-auth).
 */
export function useStaleAgents() {
  const queryClient = useQueryClient()
  const { data: agents = [] } = useAgents()

  const query = useQuery<ApiStaleAgents | null>({
    queryKey: STALE_AGENTS_KEY,
    queryFn: async () => {
      const res = await apiFetch('/api/settings/stale-agents')
      if (!res.ok) throw new Error('Failed to fetch stale agents')
      return res.json()
    },
    // A run's end emits no event of its own (the failing start emits stopped
    // and then nothing). A window that did not click keeps up by polling only
    // while the host says a run is in flight.
    refetchInterval: (query) => (query.state.data?.running ? 2000 : false),
  })

  const restart = useMutation({
    // The notice renders the error inline; no global toast on top (see useStartAgent).
    meta: { skipGlobalErrorToast: true },
    mutationFn: async () => {
      const res = await apiFetch('/api/settings/stale-agents/restart', { method: 'POST' })
      // 409 is "a run is already in flight" and carries the current record.
      if (!res.ok && res.status !== 409) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Failed to restart agents')
      }
      const record = (await res.json()) as ApiStaleAgents | null
      // Written here, not in onSuccess: the call outlives an unmounted tab,
      // and a later mount must see how the run ended.
      queryClient.setQueryData(STALE_AGENTS_KEY, record)
      // A 409 is another caller's run in progress: progress to show, not a result of ours.
      return res.status === 409 ? null : record
    },
  })

  const record = query.data ?? null
  return {
    record,
    rows: describeStaleAgents(record?.agents ?? [], agents),
    /** The run this mount asked for, as the host answered it. Feedback, not state: gone on remount. */
    lastRun: restart.data ? describeStaleAgents(restart.data.agents, agents) : null,
    restartAll: () => restart.mutate(),
    isRestarting: restart.isPending || record?.running === true,
    restartError: restart.error?.message ?? null,
  }
}
