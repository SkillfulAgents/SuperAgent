import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const broadcastGlobal = vi.fn()

import { announceWorkspaceChange, collapseScopes } from './workspace-changes'

describe('collapseScopes', () => {
  it('keeps a folder and drops what is under it', () => {
    expect(collapseScopes(['src', 'src/a.ts', 'dist/b.js'])).toEqual(['dist/b.js', 'src'])
  })

  it('climbs one level at a time, so separate top-level folders stay separate', () => {
    const paths = ['dist/a/1.js', 'dist/a/2.js', 'dist/b/3.js', 'src/x/4.ts', 'src/y/5.ts']
    expect(collapseScopes(paths, 2)).toEqual(['dist', 'src'])
  })

  it('keeps the deepest shared folder for many paths under one long chain', () => {
    const deep = Array.from({ length: 2_000 }, (_, i) => `d${i}`).join('/')
    expect(collapseScopes(Array.from({ length: 60 }, (_, i) => `${deep}/f${i}`), 50)).toEqual([deep])
  })

  it('becomes the whole workspace only when the top-level folders alone exceed the cap', () => {
    expect(collapseScopes(['a/1', 'b/2', 'c/3'], 2)).toEqual([''])
  })
})

describe('announceWorkspaceChange', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.runAllTimers()
    vi.useRealTimers()
    broadcastGlobal.mockClear()
  })

  it('sends the first change after half a second, then at most one event per second, scoped to the agent', () => {
    announceWorkspaceChange('agent-1', ['/workspace/notes.md'], broadcastGlobal)
    vi.advanceTimersByTime(499)
    expect(broadcastGlobal).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(broadcastGlobal).toHaveBeenLastCalledWith({ type: 'file_changed', agentSlug: 'agent-1', scopes: ['/workspace/notes.md'] })

    announceWorkspaceChange('agent-1', ['a.md'], broadcastGlobal)
    announceWorkspaceChange('agent-1', ['b.md'], broadcastGlobal)
    vi.advanceTimersByTime(999)
    expect(broadcastGlobal).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(broadcastGlobal).toHaveBeenLastCalledWith({ type: 'file_changed', agentSlug: 'agent-1', scopes: ['/workspace/a.md', '/workspace/b.md'] })
  })

  it('drops skipped folders and paths outside the workspace, and names the whole workspace as /workspace', () => {
    announceWorkspaceChange('agent-2', ['node_modules/x.js', 'app/node_modules/y.js', '.claude/projects/-workspace/s.jsonl', '.claude/file-history/a', '.browser-profile/Default/x', '/etc/passwd', '../up'], broadcastGlobal)
    vi.advanceTimersByTime(1_000)
    expect(broadcastGlobal).not.toHaveBeenCalled()

    announceWorkspaceChange('agent-2', ['/workspace'], broadcastGlobal)
    vi.advanceTimersByTime(1_000)
    expect(broadcastGlobal).toHaveBeenLastCalledWith({ type: 'file_changed', agentSlug: 'agent-2', scopes: ['/workspace'] })
  })

  it('collapses a queue past 500 paths to its folders', () => {
    announceWorkspaceChange('agent-3', Array.from({ length: 300 }, (_, i) => `a/${i}.md`), broadcastGlobal)
    announceWorkspaceChange('agent-3', Array.from({ length: 300 }, (_, i) => `b/${i}.md`), broadcastGlobal)
    vi.advanceTimersByTime(1_000)
    expect(broadcastGlobal).toHaveBeenLastCalledWith({ type: 'file_changed', agentSlug: 'agent-3', scopes: ['/workspace/a', '/workspace/b'] })
  })
})
