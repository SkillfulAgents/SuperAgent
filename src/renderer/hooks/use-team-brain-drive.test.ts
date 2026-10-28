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

import { TREE_BUDGET } from '@renderer/lib/team-brain/team-brain-budget'
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

  it('knows the record’s groups only once _brain is listed, and says when it can’t be', async () => {
    const brainAnswers = async (status: number) => {
      apiFetch.mockImplementation(async (url: string) => {
        const path = new URL(url, 'http://x').searchParams.get('path')
        if (path === '_brain' && status !== 200) return new Response(JSON.stringify({ error: 'gone' }), { status })
        const entries =
          path === ''
            ? [{ name: '_brain', path: '_brain', type: 'directory' }, { name: 'INDEX.md', path: 'INDEX.md', type: 'file' }]
            : path === '_brain'
              ? [{ name: 'archive', path: '_brain/archive', type: 'directory' }, { name: 'syncs', path: '_brain/syncs', type: 'directory' }]
              : []
        return new Response(JSON.stringify({ root: '', path, entries }))
      })
      const client = new QueryClient()
      const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
      return renderHook(() => useTeamBrainDrive('brain', 'vol', new Set()), { wrapper })
    }
    const listed = await brainAnswers(200)
    await waitFor(() => expect(listed.result.current.recordGroups.status).toBe('listed'))
    const groups = listed.result.current.recordGroups
    expect(groups.status === 'listed' && [...groups.present].sort()).toEqual(['about', 'archive'])
    listed.unmount()
    const refused = await brainAnswers(403)
    await waitFor(() => expect(refused.result.current.recordGroups.status).toBe('failed'))
    // The record listed ahead of being shown reports no error of its own to the tree.
    expect(refused.result.current.error).toBeNull()
    refused.unmount()
    // A top that can't be listed can't say what the record holds either: it reads as failed, not as still to come.
    apiFetch.mockImplementation(async () => new Response(JSON.stringify({ error: 'gone' }), { status: 403 }))
    const client = new QueryClient()
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
    const top = renderHook(() => useTeamBrainDrive('brain', 'vol', new Set()), { wrapper })
    await waitFor(() => expect(top.result.current.recordGroups.status).toBe('failed'))
  })

  it('lists _brain on a top too wide for the tree to walk, with a group saved on', async () => {
    apiFetch.mockImplementation(async (url: string) => {
      const path = new URL(url, 'http://x').searchParams.get('path')
      const entries =
        path === ''
          ? [{ name: '_brain', path: '_brain', type: 'directory' }, ...Array.from({ length: TREE_BUDGET + 1 }, (_, i) => ({ name: `p${i}.md`, path: `p${i}.md`, type: 'file' }))]
          : path === '_brain'
            ? [{ name: 'team.md', path: '_brain/team.md', type: 'file' }]
            : []
      return new Response(JSON.stringify({ root: '', path, entries }))
    })
    const client = new QueryClient()
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
    const { result } = renderHook(() => useTeamBrainDrive('brain', 'vol', new Set(), new Set(['about'] as const)), { wrapper })
    await waitFor(() => expect(result.current.recordGroups.status).toBe('listed'))
  })
})
