import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'

/**
 * Integration tools a managing person may invoke from the integration page.
 * The same named operations serve the agent through the x-agent routes, so a
 * family defines each operation once.
 */
export const integrationToolKeys = {
  result: (integrationId: string, tool: string, input: unknown) => ['agent-integration-tool', integrationId, tool, input] as const,
}

async function invokeIntegrationTool<T>(integrationId: string, tool: string, input?: unknown): Promise<T> {
  const response = await apiFetch(`/api/agent-integrations/${encodeURIComponent(integrationId)}/tools/${encodeURIComponent(tool)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input }),
  })
  const payload = await response.json().catch(() => null) as { result?: T; error?: string } | null
  if (!response.ok) throw new Error(payload?.error ?? `Could not run ${tool}`)
  return payload?.result as T
}

export function useInvokeIntegrationTool<T = unknown>(integrationId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: ({ tool, input }: { tool: string; input?: unknown }) => invokeIntegrationTool<T>(integrationId, tool, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agent-integration-tool', integrationId] }),
  })
}

/** A read-only tool polled as a query, e.g. a family's "list" operations. */
export function useIntegrationToolQuery<T>(integrationId: string, tool: string, input?: unknown, options: { refetchIntervalMs?: number; enabled?: boolean } = {}) {
  return useQuery<T>({
    queryKey: integrationToolKeys.result(integrationId, tool, input ?? null),
    queryFn: () => invokeIntegrationTool<T>(integrationId, tool, input),
    refetchInterval: options.refetchIntervalMs,
    enabled: options.enabled ?? true,
  })
}
