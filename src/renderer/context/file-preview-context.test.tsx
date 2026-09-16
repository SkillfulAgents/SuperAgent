// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { FilePreviewProvider, getPreviewTabKey, getWorkspaceFileKey, useFilePreview, type FileTab } from './file-preview-context'

// Mock the route-derived location — FilePreviewProvider reads useRouteLocation and
// watches view.kind/view.id for session changes.
let mockView = { kind: 'session' as const, id: 'session-1' }
vi.mock('@renderer/router/use-route-location', () => ({
  useRouteLocation: () => ({ selectedAgentSlug: 'agent-1', view: mockView }),
}))

function wrapper({ children }: { children: ReactNode }) {
  return createElement(FilePreviewProvider, null, children)
}

function readOnlyWrapper({ children }: { children: ReactNode }) {
  return <FilePreviewProvider commentsEnabled={false}>{children}</FilePreviewProvider>
}

beforeEach(() => {
  mockView = { kind: 'session', id: 'session-1' }
})

describe('FilePreviewContext', () => {
  describe('openFile', () => {
    it('adds a tab and sets isOpen', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      expect(result.current.openTabs).toHaveLength(0)
      expect(result.current.isOpen).toBe(false)

      act(() => result.current.openFile('/workspace/report.md', 'agent-1'))

      expect(result.current.openTabs).toHaveLength(1)
      expect(result.current.openTabs[0]).toMatchObject({
        kind: 'file',
        filePath: '/workspace/report.md',
        displayName: 'report.md',
        pdfPage: 1,
      })
      expect((result.current.openTabs[0] as FileTab).version).toBeGreaterThan(0)
      expect(result.current.isOpen).toBe(true)
      expect(result.current.activeTabIndex).toBe(0)
    })

    // A path is not an identity on its own: two agents can each have a
    // /workspace/report.md, and a drawer that outlives one agent would
    // otherwise show the first agent's bytes under the second's name.
    it('keeps two agents\' identically-named files in separate tabs', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      act(() => result.current.openFile('/workspace/report.md', 'agent-1'))
      act(() => result.current.openFile('/workspace/report.md', 'agent-2'))

      expect(result.current.openTabs).toHaveLength(2)
      expect(result.current.openTabs[0]).toMatchObject({ agentSlug: 'agent-1' })
      expect(result.current.openTabs[1]).toMatchObject({ agentSlug: 'agent-2' })
      expect(getPreviewTabKey(result.current.openTabs[0]))
        .not.toBe(getPreviewTabKey(result.current.openTabs[1]))

      // and closing one leaves the other alone
      act(() => result.current.closeTab(getPreviewTabKey(result.current.openTabs[0])))
      expect(result.current.openTabs).toHaveLength(1)
      expect(result.current.openTabs[0]).toMatchObject({ agentSlug: 'agent-2' })
    })

    it('leaves another agent\'s tab untouched when a file is renamed or deleted', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      act(() => result.current.openFile('/workspace/report.md', 'agent-1'))
      act(() => result.current.openFile('/workspace/report.md', 'agent-2'))

      act(() => result.current.renameFilePath('/workspace/report.md', '/workspace/final.md', 'agent-1'))
      expect(result.current.openTabs[0]).toMatchObject({ filePath: '/workspace/final.md' })
      expect(result.current.openTabs[1]).toMatchObject({ filePath: '/workspace/report.md' })

      act(() => result.current.removeFilePath('/workspace/report.md', 'agent-2'))
      expect(result.current.openTabs).toHaveLength(1)
      expect(result.current.openTabs[0]).toMatchObject({ agentSlug: 'agent-1' })
    })

    it('switches to existing tab without duplicating', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      act(() => result.current.openFile('/workspace/a.md', 'agent-1'))
      act(() => result.current.openFile('/workspace/b.md', 'agent-1'))
      act(() => result.current.openFile('/workspace/a.md', 'agent-1'))

      expect(result.current.openTabs).toHaveLength(2)
      expect(result.current.activeTabIndex).toBe(0)
    })

    it('bumps version on re-delivery of same file', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      act(() => result.current.openFile('/workspace/report.md', 'agent-1'))
      const first = (result.current.openTabs[0] as FileTab).version

      act(() => result.current.openFile('/workspace/report.md', 'agent-1'))
      const second = (result.current.openTabs[0] as FileTab).version
      expect(second).toBeGreaterThan(first)

      act(() => result.current.openFile('/workspace/report.md', 'agent-1'))
      expect((result.current.openTabs[0] as FileTab).version).toBeGreaterThan(second)
    })

    it('seeds the version from the clock so a reload never reuses a cached file URL', () => {
      const start = Date.now()
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      act(() => result.current.openFile('/workspace/report.md', 'agent-1'))

      // A session-local counter would restart at 0 after a reload and resolve to
      // a URL an intermediary may still hold the previous body for.
      expect((result.current.openTabs[0] as FileTab).version).toBeGreaterThanOrEqual(start)
    })
  })

  describe('PDF pagination', () => {
    it('keeps a separate page for each open file', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      act(() => result.current.openFile('/workspace/long.pdf', 'agent-1'))
      act(() => result.current.openFile('/workspace/short.pdf', 'agent-1'))

      act(() => result.current.setPdfPage('/workspace/long.pdf', 'agent-1', 8))
      act(() => result.current.setPdfPage('/workspace/short.pdf', 'agent-1', 2))

      expect(result.current.openTabs[0]).toMatchObject({ pdfPage: 8 })
      expect(result.current.openTabs[1]).toMatchObject({ pdfPage: 2 })

      act(() => result.current.setActiveTab(0))
      expect(result.current.openTabs[result.current.activeTabIndex]).toMatchObject({ pdfPage: 8 })
      act(() => result.current.setActiveTab(1))
      expect(result.current.openTabs[result.current.activeTabIndex]).toMatchObject({ pdfPage: 2 })
    })

    it('clamps page updates to the first page', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      act(() => result.current.openFile('/workspace/report.pdf', 'agent-1'))

      act(() => result.current.setPdfPage('/workspace/report.pdf', 'agent-1', 0))

      expect(result.current.openTabs[0]).toMatchObject({ pdfPage: 1 })
    })
  })

  describe('folder tabs', () => {
    // Two agents can have a browser open on the same root, so every folder
    // mutation has to name the agent as well as the path — otherwise expanding
    // a directory in one tab expands it in the other.
    it('keeps two agents\' browsers on the same root independent', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      const root = '/workspace/reports'
      act(() => result.current.openFolder(root, 'agent-1'))
      act(() => result.current.openFolder(root, 'agent-2'))
      expect(result.current.openTabs).toHaveLength(2)

      act(() => result.current.toggleFolder(root, 'agent-1', `${root}/drafts`))
      act(() => result.current.setFolderQuery(root, 'agent-1', 'july'))
      act(() => result.current.selectFolderEntry(root, 'agent-1', `${root}/july.md`))

      expect(result.current.openTabs[0]).toMatchObject({
        agentSlug: 'agent-1',
        expandedPaths: [root, `${root}/drafts`],
        query: 'july',
        selectedPath: `${root}/july.md`,
      })
      expect(result.current.openTabs[1]).toMatchObject({
        agentSlug: 'agent-2',
        expandedPaths: [root],
        query: '',
      })
      expect(result.current.openTabs[1]).not.toHaveProperty('selectedPath', `${root}/july.md`)
    })

    it('opens a folder once and restores it when reopened', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })

      act(() => result.current.openFolder('/workspace/reports/', 'agent-1'))
      act(() => result.current.toggleFolder('/workspace/reports', 'agent-1', '/workspace/reports/2026'))
      act(() => result.current.setFolderQuery('/workspace/reports', 'agent-1', 'july'))
      act(() => result.current.selectFolderEntry('/workspace/reports', 'agent-1', '/workspace/reports/2026/july.md'))
      act(() => result.current.openFile('/workspace/other.md', 'agent-1'))
      act(() => result.current.openFolder('/workspace/reports', 'agent-1'))

      expect(result.current.openTabs).toHaveLength(2)
      expect(result.current.activeTabIndex).toBe(0)
      expect(result.current.openTabs[0]).toMatchObject({
        kind: 'folder',
        rootPath: '/workspace/reports',
        query: 'july',
        selectedPath: '/workspace/reports/2026/july.md',
        expandedPaths: ['/workspace/reports', '/workspace/reports/2026'],
      })
    })

    it('updates folder selection, open tabs, and comments after a file rename', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      const oldPath = '/workspace/reports/old.md'
      const newPath = '/workspace/reports/new.md'

      act(() => result.current.openFolder('/workspace/reports', 'agent-1'))
      act(() => result.current.selectFolderEntry('/workspace/reports', 'agent-1', oldPath))
      act(() => result.current.openFile(oldPath, 'agent-1'))
      act(() => result.current.addComment({ filePath: oldPath, agentSlug: 'agent-1', text: 'keep me' }))
      act(() => result.current.renameFilePath(oldPath, newPath, 'agent-1'))

      expect(result.current.openTabs[0]).toMatchObject({ selectedPath: newPath })
      expect(result.current.openTabs[1]).toMatchObject({
        filePath: newPath,
        displayName: 'new.md',
      })
      expect((result.current.openTabs[1] as FileTab).version).toBeGreaterThan(0)
      expect(result.current.comments.get(getWorkspaceFileKey('agent-1', oldPath))).toBeUndefined()
      expect(result.current.comments.get(getWorkspaceFileKey('agent-1', newPath))?.[0]).toMatchObject({
        filePath: newPath,
        text: 'keep me',
      })
    })

    it('removes an open file tab and clears folder selection after deletion', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      const filePath = '/workspace/reports/old.md'

      act(() => result.current.openFolder('/workspace/reports', 'agent-1'))
      act(() => result.current.selectFolderEntry('/workspace/reports', 'agent-1', filePath))
      act(() => result.current.openFile(filePath, 'agent-1'))
      act(() => result.current.addComment({ filePath, agentSlug: 'agent-1', text: 'remove me' }))
      act(() => result.current.setActiveTab(0))
      act(() => result.current.removeFilePath(filePath, 'agent-1'))

      expect(result.current.openTabs).toHaveLength(1)
      expect(result.current.openTabs[0]).toMatchObject({ kind: 'folder' })
      expect(result.current.openTabs[0]).toHaveProperty('selectedPath', undefined)
      expect(result.current.comments.get(getWorkspaceFileKey('agent-1', filePath))).toBeUndefined()
    })

    it('rebases expanded state, open files, folder tabs, and comments after a directory rename', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      const oldPath = '/workspace/reports/drafts'
      const newPath = '/workspace/reports/archive'
      const filePath = `${oldPath}/notes.md`

      act(() => result.current.openFolder('/workspace/reports', 'agent-1'))
      act(() => result.current.toggleFolder('/workspace/reports', 'agent-1', oldPath))
      act(() => result.current.selectFolderEntry('/workspace/reports', 'agent-1', filePath))
      act(() => result.current.openFile(filePath, 'agent-1'))
      act(() => result.current.addComment({ filePath, agentSlug: 'agent-1', text: 'move me' }))
      act(() => result.current.openFolder(oldPath, 'agent-1'))
      act(() => result.current.renameDirectoryPath(oldPath, newPath, 'agent-1'))

      expect(result.current.openTabs[0]).toMatchObject({
        rootPath: '/workspace/reports',
        expandedPaths: ['/workspace/reports', newPath],
        selectedPath: `${newPath}/notes.md`,
      })
      expect(result.current.openTabs[1]).toMatchObject({
        filePath: `${newPath}/notes.md`,
        displayName: 'notes.md',
      })
      expect((result.current.openTabs[1] as FileTab).version).toBeGreaterThan(0)
      expect(result.current.openTabs[2]).toMatchObject({
        rootPath: newPath,
        displayName: 'archive',
        expandedPaths: [newPath],
      })
      expect(result.current.comments.get(getWorkspaceFileKey('agent-1', filePath))).toBeUndefined()
      expect(result.current.comments.get(getWorkspaceFileKey('agent-1', `${newPath}/notes.md`))?.[0]).toMatchObject({
        filePath: `${newPath}/notes.md`,
        text: 'move me',
      })
    })

    it('closes descendant tabs and clears tree state after a directory deletion', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      const directoryPath = '/workspace/reports/drafts'
      const filePath = `${directoryPath}/notes.md`

      act(() => result.current.openFolder('/workspace/reports', 'agent-1'))
      act(() => result.current.toggleFolder('/workspace/reports', 'agent-1', directoryPath))
      act(() => result.current.selectFolderEntry('/workspace/reports', 'agent-1', filePath))
      act(() => result.current.openFile(filePath, 'agent-1'))
      act(() => result.current.addComment({ filePath, agentSlug: 'agent-1', text: 'remove me' }))
      act(() => result.current.openFolder(directoryPath, 'agent-1'))
      act(() => result.current.removeDirectoryPath(directoryPath, 'agent-1'))

      expect(result.current.openTabs).toHaveLength(1)
      expect(result.current.openTabs[0]).toMatchObject({
        kind: 'folder',
        rootPath: '/workspace/reports',
        expandedPaths: ['/workspace/reports'],
        selectedPath: undefined,
      })
      expect(result.current.activeTabIndex).toBe(0)
      expect(result.current.comments.get(getWorkspaceFileKey('agent-1', filePath))).toBeUndefined()
    })
  })

  describe('closeTab', () => {
    it('removes the tab', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      act(() => result.current.openFile('/workspace/a.md', 'agent-1'))
      act(() => result.current.openFile('/workspace/b.md', 'agent-1'))
      act(() => result.current.closeTab(getPreviewTabKey(result.current.openTabs[0])))

      expect(result.current.openTabs).toHaveLength(1)
      expect(result.current.openTabs[0]).toMatchObject({ filePath: '/workspace/b.md' })
    })

    it('closes tray when last tab is closed', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      act(() => result.current.openFile('/workspace/a.md', 'agent-1'))
      act(() => result.current.closeTab(getPreviewTabKey(result.current.openTabs[0])))

      expect(result.current.openTabs).toHaveLength(0)
      expect(result.current.isOpen).toBe(false)
    })

    it('adjusts activeFileIndex when closing before active', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      act(() => result.current.openFile('/workspace/a.md', 'agent-1'))
      act(() => result.current.openFile('/workspace/b.md', 'agent-1'))
      act(() => result.current.openFile('/workspace/c.md', 'agent-1'))
      // Active is c (index 2)
      expect(result.current.activeTabIndex).toBe(2)

      act(() => result.current.closeTab(getPreviewTabKey(result.current.openTabs[0])))
      // c is now at index 1
      expect(result.current.activeTabIndex).toBe(1)
      expect(result.current.openTabs[result.current.activeTabIndex]).toMatchObject({ filePath: '/workspace/c.md' })
    })

    it('adjusts activeFileIndex when closing active tab', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      act(() => result.current.openFile('/workspace/a.md', 'agent-1'))
      act(() => result.current.openFile('/workspace/b.md', 'agent-1'))
      act(() => result.current.openFile('/workspace/c.md', 'agent-1'))
      // Switch to b (index 1)
      act(() => result.current.setActiveTab(1))
      act(() => result.current.closeTab(getPreviewTabKey(result.current.openTabs[1])))

      // Should stay at index 1 (now c) or go to 0 if at end
      expect(result.current.activeTabIndex).toBeLessThan(result.current.openTabs.length)
    })

    it('clears comments for the closed file', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      act(() => result.current.openFile('/workspace/a.md', 'agent-1'))
      act(() => result.current.addComment({ filePath: '/workspace/a.md', agentSlug: 'agent-1', text: 'test' }))
      expect(result.current.comments.get(getWorkspaceFileKey('agent-1', '/workspace/a.md'))).toHaveLength(1)

      act(() => result.current.closeTab(getPreviewTabKey(result.current.openTabs[0])))
      expect(result.current.comments.get(getWorkspaceFileKey('agent-1', '/workspace/a.md'))).toBeUndefined()
    })
  })

  describe('session change', () => {
    it('clears all state when session changes', () => {
      const { result, rerender } = renderHook(() => useFilePreview(), { wrapper })
      act(() => result.current.openFile('/workspace/a.md', 'agent-1'))
      act(() => result.current.addComment({ filePath: '/workspace/a.md', agentSlug: 'agent-1', text: 'note' }))

      expect(result.current.openTabs).toHaveLength(1)
      expect(result.current.isOpen).toBe(true)

      // Change session
      mockView = { kind: 'session', id: 'session-2' }
      rerender()

      expect(result.current.openTabs).toHaveLength(0)
      expect(result.current.isOpen).toBe(false)
      expect(result.current.comments.size).toBe(0)
    })
  })

  describe('comments', () => {
    // Comments hang off a tab, so they are keyed the way tabs are. Keying them
    // by path alone while tabs carried the agent was the worse of both worlds:
    // the tabs separated and the feedback behind them still aliased.
    it('keeps two agents\' comments on the same path apart', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      const filePath = '/workspace/report.md'
      act(() => result.current.openFile(filePath, 'agent-1'))
      act(() => result.current.openFile(filePath, 'agent-2'))

      act(() => result.current.addComment({ filePath, agentSlug: 'agent-1', text: 'only on one' }))

      expect(result.current.commentsFor(filePath, 'agent-1')).toHaveLength(1)
      expect(result.current.commentsFor(filePath, 'agent-2')).toHaveLength(0)
    })

    it('clears only the closed tab\'s comments', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      const filePath = '/workspace/report.md'
      act(() => result.current.openFile(filePath, 'agent-1'))
      act(() => result.current.openFile(filePath, 'agent-2'))
      act(() => result.current.addComment({ filePath, agentSlug: 'agent-1', text: 'keep me' }))
      act(() => result.current.addComment({ filePath, agentSlug: 'agent-2', text: 'and me' }))

      act(() => result.current.closeTab(getPreviewTabKey(result.current.openTabs[0])))

      expect(result.current.commentsFor(filePath, 'agent-1')).toHaveLength(0)
      expect(result.current.commentsFor(filePath, 'agent-2')).toHaveLength(1)
    })

    it('moves only the renamed agent\'s comments, and drops only its deleted ones', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      const filePath = '/workspace/drafts/report.md'
      act(() => result.current.openFile(filePath, 'agent-1'))
      act(() => result.current.openFile(filePath, 'agent-2'))
      act(() => result.current.addComment({ filePath, agentSlug: 'agent-1', text: 'mine' }))
      act(() => result.current.addComment({ filePath, agentSlug: 'agent-2', text: 'theirs' }))

      act(() => result.current.renameFilePath(filePath, '/workspace/drafts/final.md', 'agent-1'))
      expect(result.current.commentsFor('/workspace/drafts/final.md', 'agent-1')[0])
        .toMatchObject({ text: 'mine', filePath: '/workspace/drafts/final.md' })
      expect(result.current.commentsFor(filePath, 'agent-2')[0]).toMatchObject({ text: 'theirs' })

      act(() => result.current.removeDirectoryPath('/workspace/drafts', 'agent-1'))
      expect(result.current.commentsFor('/workspace/drafts/final.md', 'agent-1')).toHaveLength(0)
      expect(result.current.commentsFor(filePath, 'agent-2')).toHaveLength(1)
    })

    // The comment bar submits into one session's draft, so a comment that came
    // back for the wrong agent would be pasted into the wrong composer.
    it('reports comments for the agent that owns them', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      act(() => result.current.addComment({
        filePath: '/workspace/a.md', agentSlug: 'agent-2', text: 'theirs',
      }))
      expect(result.current.commentsFor('/workspace/a.md', 'agent-1')).toEqual([])
      expect(result.current.commentsFor('/workspace/a.md', 'agent-2')[0])
        .toMatchObject({ agentSlug: 'agent-2', text: 'theirs' })
    })

    it('ignores comments when the preview is read-only', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper: readOnlyWrapper })

      expect(result.current.commentsEnabled).toBe(false)
      act(() => result.current.addComment({ filePath: '/workspace/a.md', agentSlug: 'agent-1', text: 'fix this' }))

      expect(result.current.comments.size).toBe(0)
    })

    it('adds a comment with generated id', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      act(() => result.current.addComment({ filePath: '/workspace/a.md', agentSlug: 'agent-1', text: 'fix this', selectedText: 'broken code' }))

      const comments = result.current.comments.get(getWorkspaceFileKey('agent-1', '/workspace/a.md'))!
      expect(comments).toHaveLength(1)
      expect(comments[0].text).toBe('fix this')
      expect(comments[0].selectedText).toBe('broken code')
      expect(comments[0].id).toMatch(/^comment-/)
    })

    it('adds image annotation comment with coordinates', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      act(() => result.current.addComment({ filePath: '/workspace/img.png', agentSlug: 'agent-1', text: 'misaligned', x: 45, y: 72 }))

      const comments = result.current.comments.get(getWorkspaceFileKey('agent-1', '/workspace/img.png'))!
      expect(comments[0].x).toBe(45)
      expect(comments[0].y).toBe(72)
    })

    it('removes a specific comment', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      act(() => result.current.addComment({ filePath: '/workspace/a.md', agentSlug: 'agent-1', text: 'first' }))
      act(() => result.current.addComment({ filePath: '/workspace/a.md', agentSlug: 'agent-1', text: 'second' }))

      const id = result.current.comments.get(getWorkspaceFileKey('agent-1', '/workspace/a.md'))![0].id
      act(() => result.current.removeComment('/workspace/a.md', 'agent-1', id))

      const remaining = result.current.comments.get(getWorkspaceFileKey('agent-1', '/workspace/a.md'))!
      expect(remaining).toHaveLength(1)
      expect(remaining[0].text).toBe('second')
    })

    it('clears all comments for a file', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      act(() => result.current.addComment({ filePath: '/workspace/a.md', agentSlug: 'agent-1', text: 'first' }))
      act(() => result.current.addComment({ filePath: '/workspace/a.md', agentSlug: 'agent-1', text: 'second' }))
      act(() => result.current.clearComments('/workspace/a.md', 'agent-1'))

      expect(result.current.comments.get(getWorkspaceFileKey('agent-1', '/workspace/a.md'))).toBeUndefined()
    })
  })

  it('throws when used outside provider', () => {
    expect(() => renderHook(() => useFilePreview())).toThrow(/FilePreviewProvider/)
  })
})
