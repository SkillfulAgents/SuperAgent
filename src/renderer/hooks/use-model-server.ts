import { useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import type { LlmProviderId } from '@shared/lib/llm-provider/provider-types'
import type { ModelDownload, ServerStatus } from '@shared/lib/llm-provider/server-status-schema'

const BASE = '/api/llm-connections'

/**
 * The connection whose model server to ask about: a saved one (`id`) as it is
 * being edited, or one not saved yet. Only what says where the server is.
 */
export interface ModelServerTarget {
  id?: string
  connection: { provider: LlmProviderId; userId: string | null; config: { apiKeys: Record<string, string> } }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await apiFetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const result = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new Error(result.error ?? 'Could not reach the app server')
  return result
}

/**
 * Polls, so the panel moves on its own: quickly while waiting for a person to
 * install or start the server, slowly once it answers. A changed model list
 * refreshes the saved connections, whose catalogs the server keeps in step.
 */
export function useServerStatus(target: ModelServerTarget) {
  const queryClient = useQueryClient()
  const query = useQuery<ServerStatus>({
    queryKey: ['server-status', target],
    queryFn: () => post<ServerStatus>('/server-status', target),
    refetchInterval: (current) => (current.state.data?.state === 'running' ? 10_000 : 3_000),
    retry: false,
  })
  const models = query.data?.state === 'running' ? query.data.models.map(model => model.id).join('\n') : undefined
  const seen = useRef(models)
  useEffect(() => {
    if (models === undefined || models === seen.current) return
    seen.current = models
    void queryClient.invalidateQueries({ queryKey: ['settings', 'llm-connections'] })
  }, [models, queryClient])
  return query
}

/**
 * What the server is downloading. A finished download leaves the list, so one
 * leaving means the installed models changed: read them again right away.
 */
export function useModelDownloads(target: ModelServerTarget) {
  const queryClient = useQueryClient()
  const query = useQuery<ModelDownload[]>({
    queryKey: ['model-downloads', target],
    queryFn: async () => (await post<{ data: ModelDownload[] }>('/model-downloads/list', target)).data,
    refetchInterval: (current) => (current.state.data?.some(download => download.state === 'running') ? 1_000 : 5_000),
  })
  const running = query.data?.filter(download => download.state === 'running').length
  const previous = useRef(running)
  useEffect(() => {
    if (running !== undefined && previous.current !== undefined && running < previous.current) {
      void queryClient.invalidateQueries({ queryKey: ['server-status'] })
      void queryClient.invalidateQueries({ queryKey: ['settings', 'llm-connections'] })
    }
    previous.current = running
  }, [running, queryClient])

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['model-downloads', target] })
  const start = useMutation({
    mutationFn: (model: string) => post('/model-downloads', { ...target, model }),
    onSuccess: refresh,
  })
  const cancel = useMutation({
    mutationFn: (model: string) => post('/model-downloads/cancel', { ...target, model }),
    onSuccess: refresh,
  })
  return { downloads: query.data ?? [], start, cancel }
}
