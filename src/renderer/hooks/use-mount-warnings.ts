import { useCallback } from 'react'
import { useQueryClient, useQuery } from '@tanstack/react-query'

interface MountWarning {
  agentSlug: string
  missingMounts: { folderName: string; hostPath: string }[]
}

const QUERY_KEY_PREFIX = 'mount-warnings'

export function useMountWarnings(agentSlug: string | null) {
  const queryClient = useQueryClient()

  const { data: warning } = useQuery<MountWarning | null>({
    queryKey: [QUERY_KEY_PREFIX, agentSlug],
    queryFn: () => null,
    enabled: false, // Never fetches — data is set manually from SSE
    staleTime: Infinity,
  })

  const dismiss = useCallback(() => {
    if (agentSlug) {
      queryClient.setQueryData([QUERY_KEY_PREFIX, agentSlug], null)
    }
  }, [queryClient, agentSlug])

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
