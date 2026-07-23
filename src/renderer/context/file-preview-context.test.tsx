// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { FilePreviewProvider, useFilePreview } from './file-preview-context'

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
        version: 0,
        pdfPage: 1,
      })
      expect(result.current.isOpen).toBe(true)
      expect(result.current.activeTabIndex).toBe(0)
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
      expect(result.current.openTabs[0]).toMatchObject({ version: 0 })

      act(() => result.current.openFile('/workspace/report.md', 'agent-1'))
      expect(result.current.openTabs[0]).toMatchObject({ version: 1 })

      act(() => result.current.openFile('/workspace/report.md', 'agent-1'))
      expect(result.current.openTabs[0]).toMatchObject({ version: 2 })
    })
  })

  describe('PDF pagination', () => {
    it('keeps a separate page for each open file', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      act(() => result.current.openFile('/workspace/long.pdf', 'agent-1'))
      act(() => result.current.openFile('/workspace/short.pdf', 'agent-1'))

      act(() => result.current.setPdfPage('/workspace/long.pdf', 8))
      act(() => result.current.setPdfPage('/workspace/short.pdf', 2))

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

      act(() => result.current.setPdfPage('/workspace/report.pdf', 0))

      expect(result.current.openTabs[0]).toMatchObject({ pdfPage: 1 })
    })
  })

  describe('folder tabs', () => {
    it('opens a folder once and restores it when reopened', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })

      act(() => result.current.openFolder('/workspace/reports/', 'agent-1'))
      act(() => result.current.toggleFolder('/workspace/reports', '/workspace/reports/2026'))
      act(() => result.current.setFolderQuery('/workspace/reports', 'july'))
      act(() => result.current.selectFolderEntry('/workspace/reports', '/workspace/reports/2026/july.md'))
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
      act(() => result.current.selectFolderEntry('/workspace/reports', oldPath))
      act(() => result.current.openFile(oldPath, 'agent-1'))
      act(() => result.current.addComment({ filePath: oldPath, text: 'keep me' }))
      act(() => result.current.renameFilePath(oldPath, newPath))

      expect(result.current.openTabs[0]).toMatchObject({ selectedPath: newPath })
      expect(result.current.openTabs[1]).toMatchObject({
        filePath: newPath,
        displayName: 'new.md',
        version: 1,
      })
      expect(result.current.comments.get(oldPath)).toBeUndefined()
      expect(result.current.comments.get(newPath)?.[0]).toMatchObject({
        filePath: newPath,
        text: 'keep me',
      })
    })

    it('removes an open file tab and clears folder selection after deletion', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      const filePath = '/workspace/reports/old.md'

      act(() => result.current.openFolder('/workspace/reports', 'agent-1'))
      act(() => result.current.selectFolderEntry('/workspace/reports', filePath))
      act(() => result.current.openFile(filePath, 'agent-1'))
      act(() => result.current.addComment({ filePath, text: 'remove me' }))
      act(() => result.current.setActiveTab(0))
      act(() => result.current.removeFilePath(filePath))

      expect(result.current.openTabs).toHaveLength(1)
      expect(result.current.openTabs[0]).toMatchObject({ kind: 'folder' })
      expect(result.current.openTabs[0]).toHaveProperty('selectedPath', undefined)
      expect(result.current.comments.get(filePath)).toBeUndefined()
    })

    it('rebases expanded state, open files, folder tabs, and comments after a directory rename', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      const oldPath = '/workspace/reports/drafts'
      const newPath = '/workspace/reports/archive'
      const filePath = `${oldPath}/notes.md`

      act(() => result.current.openFolder('/workspace/reports', 'agent-1'))
      act(() => result.current.toggleFolder('/workspace/reports', oldPath))
      act(() => result.current.selectFolderEntry('/workspace/reports', filePath))
      act(() => result.current.openFile(filePath, 'agent-1'))
      act(() => result.current.addComment({ filePath, text: 'move me' }))
      act(() => result.current.openFolder(oldPath, 'agent-1'))
      act(() => result.current.renameDirectoryPath(oldPath, newPath))

      expect(result.current.openTabs[0]).toMatchObject({
        rootPath: '/workspace/reports',
        expandedPaths: ['/workspace/reports', newPath],
        selectedPath: `${newPath}/notes.md`,
      })
      expect(result.current.openTabs[1]).toMatchObject({
        filePath: `${newPath}/notes.md`,
        displayName: 'notes.md',
        version: 1,
      })
      expect(result.current.openTabs[2]).toMatchObject({
        rootPath: newPath,
        displayName: 'archive',
        expandedPaths: [newPath],
      })
      expect(result.current.comments.get(filePath)).toBeUndefined()
      expect(result.current.comments.get(`${newPath}/notes.md`)?.[0]).toMatchObject({
        filePath: `${newPath}/notes.md`,
        text: 'move me',
      })
    })

    it('closes descendant tabs and clears tree state after a directory deletion', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      const directoryPath = '/workspace/reports/drafts'
      const filePath = `${directoryPath}/notes.md`

      act(() => result.current.openFolder('/workspace/reports', 'agent-1'))
      act(() => result.current.toggleFolder('/workspace/reports', directoryPath))
      act(() => result.current.selectFolderEntry('/workspace/reports', filePath))
      act(() => result.current.openFile(filePath, 'agent-1'))
      act(() => result.current.addComment({ filePath, text: 'remove me' }))
      act(() => result.current.openFolder(directoryPath, 'agent-1'))
      act(() => result.current.removeDirectoryPath(directoryPath))

      expect(result.current.openTabs).toHaveLength(1)
      expect(result.current.openTabs[0]).toMatchObject({
        kind: 'folder',
        rootPath: '/workspace/reports',
        expandedPaths: ['/workspace/reports'],
        selectedPath: undefined,
      })
      expect(result.current.activeTabIndex).toBe(0)
      expect(result.current.comments.get(filePath)).toBeUndefined()
    })
  })

  describe('closeTab', () => {
    it('removes the tab', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      act(() => result.current.openFile('/workspace/a.md', 'agent-1'))
      act(() => result.current.openFile('/workspace/b.md', 'agent-1'))
      act(() => result.current.closeTab('file:/workspace/a.md'))

      expect(result.current.openTabs).toHaveLength(1)
      expect(result.current.openTabs[0]).toMatchObject({ filePath: '/workspace/b.md' })
    })

    it('closes tray when last tab is closed', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      act(() => result.current.openFile('/workspace/a.md', 'agent-1'))
      act(() => result.current.closeTab('file:/workspace/a.md'))

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

      act(() => result.current.closeTab('file:/workspace/a.md'))
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
      act(() => result.current.closeTab('file:/workspace/b.md'))

      // Should stay at index 1 (now c) or go to 0 if at end
      expect(result.current.activeTabIndex).toBeLessThan(result.current.openTabs.length)
    })

    it('clears comments for the closed file', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      act(() => result.current.openFile('/workspace/a.md', 'agent-1'))
      act(() => result.current.addComment({ filePath: '/workspace/a.md', text: 'test' }))
      expect(result.current.comments.get('/workspace/a.md')).toHaveLength(1)

      act(() => result.current.closeTab('file:/workspace/a.md'))
      expect(result.current.comments.get('/workspace/a.md')).toBeUndefined()
    })
  })

  describe('session change', () => {
    it('clears all state when session changes', () => {
      const { result, rerender } = renderHook(() => useFilePreview(), { wrapper })
      act(() => result.current.openFile('/workspace/a.md', 'agent-1'))
      act(() => result.current.addComment({ filePath: '/workspace/a.md', text: 'note' }))

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
    it('ignores comments when the preview is read-only', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper: readOnlyWrapper })

      expect(result.current.commentsEnabled).toBe(false)
      act(() => result.current.addComment({ filePath: '/workspace/a.md', text: 'fix this' }))

      expect(result.current.comments.size).toBe(0)
    })

    it('adds a comment with generated id', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      act(() => result.current.addComment({ filePath: '/workspace/a.md', text: 'fix this', selectedText: 'broken code' }))

      const comments = result.current.comments.get('/workspace/a.md')!
      expect(comments).toHaveLength(1)
      expect(comments[0].text).toBe('fix this')
      expect(comments[0].selectedText).toBe('broken code')
      expect(comments[0].id).toMatch(/^comment-/)
    })

    it('adds image annotation comment with coordinates', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      act(() => result.current.addComment({ filePath: '/workspace/img.png', text: 'misaligned', x: 45, y: 72 }))

      const comments = result.current.comments.get('/workspace/img.png')!
      expect(comments[0].x).toBe(45)
      expect(comments[0].y).toBe(72)
    })

    it('removes a specific comment', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      act(() => result.current.addComment({ filePath: '/workspace/a.md', text: 'first' }))
      act(() => result.current.addComment({ filePath: '/workspace/a.md', text: 'second' }))

      const id = result.current.comments.get('/workspace/a.md')![0].id
      act(() => result.current.removeComment('/workspace/a.md', id))

      const remaining = result.current.comments.get('/workspace/a.md')!
      expect(remaining).toHaveLength(1)
      expect(remaining[0].text).toBe('second')
    })

    it('clears all comments for a file', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      act(() => result.current.addComment({ filePath: '/workspace/a.md', text: 'first' }))
      act(() => result.current.addComment({ filePath: '/workspace/a.md', text: 'second' }))
      act(() => result.current.clearComments('/workspace/a.md'))

      expect(result.current.comments.get('/workspace/a.md')).toBeUndefined()
    })
  })

  it('throws when used outside provider', () => {
    expect(() => renderHook(() => useFilePreview())).toThrow(/FilePreviewProvider/)
  })
})
