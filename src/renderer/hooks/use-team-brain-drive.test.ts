// @vitest-environment jsdom

import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

// The drive: a top with two folders, one of which its drive won't list (a busy Google Drive answers 503).
const apiFetch = vi.fn(async (url: string) => {
  const path = new URL(url, 'http://x').searchParams.get('path')
  if (path === 'busy') return new Response(JSON.stringify({ error: 'Google Drive is busy.' }), { status: 503 })
  const entries =
    path === ''
      ? [
          { name: 'busy', path: 'busy', type: 'directory' },
          { name: 'fine', path: 'fine', type: 'directory' },
        ]
      : path === 'fine'
        ? [{ name: 'sub', path: 'fine/sub', type: 'directory' }]
        : [{ name: 'page.md', path: `${path}/page.md`, type: 'file' }]
  return new Response(JSON.stringify({ root: '', path, entries }))
})
vi.mock('@renderer/lib/api', () => ({ apiFetch: (url: string) => apiFetch(url) }))

import { useTeamBrainDrive } from './use-team-brain-drive'

describe('useTeamBrainDrive', () => {
  it('shows the rest of the tree when one folder cannot be listed, and says so', async () => {
    const client = new QueryClient()
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
    const { result } = renderHook(() => useTeamBrainDrive('brain', 'vol', new Set()), { wrapper })
    await waitFor(() => expect(result.current.ready).toBe(true))
    // The healthy side still goes a level deeper.
    await waitFor(() => expect(result.current.drive[1].children?.[0].children).toHaveLength(1))
    expect(result.current.drive[0]).toMatchObject({ id: 'busy', children: undefined })
    expect(result.current.error).toBe('Google Drive is busy.')
  })
})
