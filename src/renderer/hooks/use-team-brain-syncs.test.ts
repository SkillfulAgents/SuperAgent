// @vitest-environment jsdom

import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

// Two summaries in `_brain/syncs/`, one of which the drive won't serve.
const summary = (at: string) => `---\ntype: team-brain-sync\nat: ${at}\n---\n## Changes\n- Filed.\n`
const apiFetch = vi.fn(async (url: string, _init?: RequestInit) => {
  const path = new URL(url, 'http://x').searchParams.get('path')
  if (url.includes('/folders')) {
    return new Response(JSON.stringify({ entries: [
      { name: 'a.md', path: '_brain/syncs/a.md', type: 'file', mtimeMs: 2 },
      { name: 'b.md', path: '_brain/syncs/b.md', type: 'file', mtimeMs: 1 },
    ] }))
  }
  return path?.endsWith('a.md') ? new Response('busy', { status: 503 }) : new Response(summary('2026-10-23T00:00:00-07:00'))
})
vi.mock('@renderer/lib/api', () => ({ apiFetch: (url: string, init?: RequestInit) => apiFetch(url, init) }))

import { useTeamBrainSyncs } from './use-team-brain-syncs'

describe('useTeamBrainSyncs', () => {
  it('shows the summaries it can read, and reads only the head of each', async () => {
    const client = new QueryClient()
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
    const { result } = renderHook(() => useTeamBrainSyncs('brain', 'vol'), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(result.current.data?.map((sync) => sync.id)).toEqual(['_brain/syncs/b.md'])
    expect(new Headers(apiFetch.mock.calls.find(([url]) => url.includes('b.md'))?.[1]?.headers).get('Range')).toBe('bytes=0-262143')
  })

  it('reads as unreadable when the only file it could read is not a summary', async () => {
    apiFetch.mockImplementation(async (url: string) => {
      if (url.includes('/folders')) {
        return new Response(JSON.stringify({ entries: [
          { name: 'a.md', path: '_brain/syncs/a.md', type: 'file', mtimeMs: 2 },
          { name: 'notes.md', path: '_brain/syncs/notes.md', type: 'file', mtimeMs: 1 },
        ] }))
      }
      return url.includes('a.md') ? new Response('busy', { status: 503 }) : new Response('# Notes, not a sync')
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
    const { result } = renderHook(() => useTeamBrainSyncs('brain', 'vol'), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))
  })

  it('reads as unreadable, not as no syncs, when no summary file can be read', async () => {
    apiFetch.mockImplementation(async (url: string) => (url.includes('/folders')
      ? new Response(JSON.stringify({ entries: [{ name: 'a.md', path: '_brain/syncs/a.md', type: 'file', mtimeMs: 2 }] }))
      : new Response('busy', { status: 503 })))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
    const { result } = renderHook(() => useTeamBrainSyncs('brain', 'vol'), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))
  })
})
