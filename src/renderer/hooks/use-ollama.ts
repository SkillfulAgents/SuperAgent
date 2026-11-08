import { useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import type { OllamaPullState, OllamaStatus } from '@shared/lib/llm-provider/ollama-schema'

const BASE = '/api/llm-connections/ollama'

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
 * install or start Ollama, slowly once it answers. Asking also syncs the catalog
 * on the server, so a changed model list refreshes the saved connections.
 */
export function useOllamaStatus(baseUrl: string, options?: { enabled?: boolean }) {
  const queryClient = useQueryClient()
  const query = useQuery<OllamaStatus>({
    queryKey: ['ollama-status', baseUrl],
    queryFn: () => post<OllamaStatus>('/status', { baseUrl }),
    enabled: options?.enabled !== false,
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
 * What this server is pulling. A finished pull leaves the list, so one leaving
 * means the installed models changed: read them again right away.
 */
export function useOllamaPulls(baseUrl: string, options?: { enabled?: boolean }) {
  const queryClient = useQueryClient()
  const query = useQuery<OllamaPullState[]>({
    queryKey: ['ollama-pulls', baseUrl],
    queryFn: async () => (await post<{ data: OllamaPullState[] }>('/pulls/list', { baseUrl })).data,
    enabled: options?.enabled !== false,
    refetchInterval: (current) => (current.state.data?.some(pull => pull.state === 'running') ? 1_000 : 5_000),
  })
  const running = query.data?.filter(pull => pull.state === 'running').length
  const previous = useRef(running)
  useEffect(() => {
    if (running !== undefined && previous.current !== undefined && running < previous.current) {
      void queryClient.invalidateQueries({ queryKey: ['ollama-status', baseUrl] })
      void queryClient.invalidateQueries({ queryKey: ['settings', 'llm-connections'] })
    }
    previous.current = running
  }, [running, baseUrl, queryClient])

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['ollama-pulls', baseUrl] })
  const start = useMutation({
    mutationFn: (model: string) => post('/pulls', { baseUrl, model }),
    onSuccess: refresh,
  })
  const cancel = useMutation({
    mutationFn: (model: string) => post('/pulls/cancel', { baseUrl, model }),
    onSuccess: refresh,
  })
  return { pulls: query.data ?? [], start, cancel }
}
