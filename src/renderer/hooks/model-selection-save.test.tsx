// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { apiFetch } from '@renderer/lib/api'
import { useUpdateAgentPreferences } from './use-agent-preferences'
import { useUpdateAgentIntegration } from './use-agent-integrations'
import { useUpdateScheduledTaskRuntimeOptions } from './use-scheduled-tasks'
import { useUpdateWebhookTriggerRuntimeOptions } from './use-webhook-triggers'

vi.mock('@renderer/lib/api', () => ({ apiFetch: vi.fn() }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const cases = [
  ['agent default', () => {
    const mutation = useUpdateAgentPreferences('agent')
    return { pending: mutation.isPending, save: () => mutation.mutate({ defaultLlmProviderId: 'next', defaultModel: 'haiku' }) }
  }],
  ['integration', () => {
    const mutation = useUpdateAgentIntegration()
    return { pending: mutation.isPending, save: () => mutation.mutate({ id: 'item', llmProviderId: 'next', model: 'haiku' }) }
  }],
  ['schedule', () => {
    const mutation = useUpdateScheduledTaskRuntimeOptions()
    return { pending: mutation.isPending, save: () => mutation.mutate({ taskId: 'item', agentSlug: 'agent', llmProviderId: 'next', model: 'haiku' }) }
  }],
  ['webhook', () => {
    const mutation = useUpdateWebhookTriggerRuntimeOptions()
    return { pending: mutation.isPending, save: () => mutation.mutate({ triggerId: 'item', agentSlug: 'agent', llmProviderId: 'next', model: 'haiku' }) }
  }],
] as const

it.each(cases)('%s keeps the picker pending after save until the authoritative selection refreshes', async (_name, useSave) => {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
  let release!: () => void
  const refresh = new Promise<void>(resolve => { release = resolve })
  const invalidate = vi.spyOn(client, 'invalidateQueries').mockReturnValue(refresh)
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ id: 'item', agentSlug: 'agent', llmProviderId: 'next', model: 'haiku' })))
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const { result } = renderHook(useSave, { wrapper })
  try {
    act(() => result.current.save())
    await waitFor(() => expect(invalidate).toHaveBeenCalled())
    expect(result.current.pending).toBe(true)
    await act(async () => { release(); await refresh })
    await waitFor(() => expect(result.current.pending).toBe(false))
  } finally {
    release()
    client.clear()
  }
})
