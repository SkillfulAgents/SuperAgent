import { useCallback } from 'react'
import { useQueryClient, useQuery } from '@tanstack/react-query'
import { useAgents, resolveRouteAgentId } from '@renderer/hooks/use-agents'

interface MountWarning {
  agentSlug: string
  missingMounts: { folderName: string; hostPath: string }[]
  /** Optional extra context (e.g. macOS cloud-storage hint) shown in the banner. */
  hint?: string
}

const QUERY_KEY_PREFIX = 'mount-warnings'

export function useMountWarnings(agentSlug: string | null) {
  const queryClient = useQueryClient()

  // The caller passes the route param (a display slug), but the SSE handler writes
  // warnings under the canonical id (setMountWarning ← data.agentSlug). Resolve so
  // the subscription keys on the same id — otherwise the missing-mount banner
  // silently never shows on a pretty display-slug route.
  const { data: agents } = useAgents()
  const resolvedSlug = agentSlug ? resolveRouteAgentId(agentSlug, agents) ?? agentSlug : null

  const { data: warning } = useQuery<MountWarning | null>({
    queryKey: [QUERY_KEY_PREFIX, resolvedSlug],
    queryFn: () => null,
    enabled: false, // Never fetches — data is set manually from SSE
    staleTime: Infinity,
  })

  const dismiss = useCallback(() => {
    if (resolvedSlug) {
      queryClient.setQueryData([QUERY_KEY_PREFIX, resolvedSlug], null)
    }
  }, [queryClient, resolvedSlug])

  return { warning: warning ?? null, dismiss }
}

/**
 * Called from the global SSE handler to set mount warnings.
 */
export function setMountWarning(
  queryClient: ReturnType<typeof useQueryClient>,
  data: MountWarning
) {
  queryClient.setQueryData([QUERY_KEY_PREFIX, data.agentSlug], data)
}
