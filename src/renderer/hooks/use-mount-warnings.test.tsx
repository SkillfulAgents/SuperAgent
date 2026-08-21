// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useMountWarnings, setMountWarning } from './use-mount-warnings'

// useMountWarnings resolves the route (display) slug to the canonical id via the
// agents list before keying its query; stub the list so the resolver maps
// `my-agent-abc1234567` (display) -> `abc1234567` (canonical). The real
// resolveRouteAgentId is kept.
vi.mock('@renderer/hooks/use-agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/hooks/use-agents')>()
  return {
    ...actual,
    useAgents: () => ({ data: [{ slug: 'abc1234567', displaySlug: 'my-agent-abc1234567', name: 'My Agent' }] }),
  }
})

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

describe('useMountWarnings', () => {
  it('surfaces a warning written under the canonical id when subscribed via the display slug', () => {
    const client = new QueryClient()
    // The SSE handler writes under the canonical id (data.agentSlug).
    setMountWarning(client, {
      agentSlug: 'abc1234567',
      missingMounts: [{ folderName: 'data', hostPath: '/host/data' }],
    })

    // The banner subscribes with the route DISPLAY slug — it must still see it.
    const { result } = renderHook(() => useMountWarnings('my-agent-abc1234567'), {
      wrapper: makeWrapper(client),
    })

    expect(result.current.warning?.missingMounts[0]?.folderName).toBe('data')
  })

  it('dismiss clears the canonical-id entry', () => {
    const client = new QueryClient()
    setMountWarning(client, {
      agentSlug: 'abc1234567',
      missingMounts: [{ folderName: 'data', hostPath: '/host/data' }],
    })

    const { result } = renderHook(() => useMountWarnings('my-agent-abc1234567'), {
      wrapper: makeWrapper(client),
    })
    expect(result.current.warning).not.toBeNull()

    // dismiss must clear the CANONICAL-id entry (what the SSE handler wrote), not a
    // display-slug-keyed one — assert the cache directly to avoid the async observer
    // re-render under act().
    act(() => result.current.dismiss())
    expect(client.getQueryData(['mount-warnings', 'abc1234567'])).toBeNull()
  })
})
