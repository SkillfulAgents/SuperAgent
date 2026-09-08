import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { getApiBaseUrl } from '@renderer/lib/env'
import { invalidateAgentWidgets, patchAgentWidget } from '@renderer/lib/agent-cache'
import type { ApiAgentWidget, WidgetScheme } from '@shared/lib/widgets/widget-schema'

export type { ApiAgentWidget }

/**
 * Widgets of one agent, read from the host filesystem (never wakes the
 * container). Live state arrives over SSE — see global-notification-handler —
 * so the poll is only a safety net.
 */
export function useAgentWidgets(agentSlug: string | null) {
  return useQuery<ApiAgentWidget[]>({
    queryKey: ['widgets', agentSlug],
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${encodeURIComponent(agentSlug!)}/widgets`)
      if (!res.ok) throw new Error('Failed to fetch widgets')
      const data: unknown = await res.json()
      return Array.isArray(data) ? (data as ApiAgentWidget[]) : []
    },
    enabled: !!agentSlug,
    staleTime: 30_000,
    refetchInterval: 120_000,
  })
}

/**
 * The Agent Home mount trigger: ask the host to refresh every stale widget of
 * this agent. Fire-and-forget on the server; results come back as SSE.
 */
export function useRefreshStaleWidgets() {
  return useMutation({
    mutationFn: async (agentSlug: string) => {
      const res = await apiFetch(`/api/agents/${encodeURIComponent(agentSlug)}/widgets/refresh-stale`, {
        method: 'POST',
      })
      if (!res.ok) throw new Error('Failed to refresh widgets')
      return res.json() as Promise<{ refreshing: string[] }>
    },
  })
}

/** Explicit refresh of one widget (the card's refresh button). */
export function useRefreshWidget() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ agentSlug, widgetSlug }: { agentSlug: string; widgetSlug: string }) => {
      patchAgentWidget(queryClient, agentSlug, widgetSlug, { refreshing: true })
      const res = await apiFetch(
        `/api/agents/${encodeURIComponent(agentSlug)}/artifacts/${encodeURIComponent(widgetSlug)}/widget/refresh`,
        { method: 'POST' },
      )
      const body = await res.json().catch(() => ({})) as { ok?: boolean; error?: string }
      if (!res.ok || !body.ok) throw new Error(body.error || 'Failed to refresh widget')
      return body
    },
    onSettled: (_data, _error, { agentSlug, widgetSlug }) => {
      patchAgentWidget(queryClient, agentSlug, widgetSlug, { refreshing: false })
      invalidateAgentWidgets(queryClient, agentSlug)
    },
  })
}

/**
 * Snapshot document URL for the in-app iframe. The html hash is part of the
 * URL so a refreshed widget is a new document, not a cached one.
 */
export function widgetHtmlUrl(agentSlug: string, widget: ApiAgentWidget, scheme: WidgetScheme): string {
  const params = new URLSearchParams({ scheme, v: widget.htmlHash ?? 'none' })
  return `${getApiBaseUrl()}/api/agents/${encodeURIComponent(agentSlug)}/artifacts/${encodeURIComponent(widget.slug)}/widget/html?${params}`
}
