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
      expect(result.current.openFiles).toHaveLength(0)
      expect(result.current.isOpen).toBe(false)

      act(() => result.current.openFile('/workspace/report.md', 'agent-1'))

      expect(result.current.openFiles).toHaveLength(1)
      expect(result.current.openFiles[0].filePath).toBe('/workspace/report.md')
      expect(result.current.openFiles[0].displayName).toBe('report.md')
      expect(result.current.openFiles[0].version).toBe(0)
      expect(result.current.openFiles[0].pdfPage).toBe(1)
      expect(result.current.isOpen).toBe(true)
      expect(result.current.activeFileIndex).toBe(0)
    })

    it('switches to existing tab without duplicating', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      act(() => result.current.openFile('/workspace/a.md', 'agent-1'))
      act(() => result.current.openFile('/workspace/b.md', 'agent-1'))
      act(() => result.current.openFile('/workspace/a.md', 'agent-1'))

      expect(result.current.openFiles).toHaveLength(2)
      expect(result.current.activeFileIndex).toBe(0)
    })

    it('bumps version on re-delivery of same file', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      act(() => result.current.openFile('/workspace/report.md', 'agent-1'))
      expect(result.current.openFiles[0].version).toBe(0)

      act(() => result.current.openFile('/workspace/report.md', 'agent-1'))
      expect(result.current.openFiles[0].version).toBe(1)

      act(() => result.current.openFile('/workspace/report.md', 'agent-1'))
      expect(result.current.openFiles[0].version).toBe(2)
    })
  })

  describe('PDF pagination', () => {
    it('keeps a separate page for each open file', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      act(() => result.current.openFile('/workspace/long.pdf', 'agent-1'))
      act(() => result.current.openFile('/workspace/short.pdf', 'agent-1'))

      act(() => result.current.setPdfPage('/workspace/long.pdf', 8))
      act(() => result.current.setPdfPage('/workspace/short.pdf', 2))

      expect(result.current.openFiles[0].pdfPage).toBe(8)
      expect(result.current.openFiles[1].pdfPage).toBe(2)

      act(() => result.current.setActiveFile(0))
      expect(result.current.openFiles[result.current.activeFileIndex].pdfPage).toBe(8)
      act(() => result.current.setActiveFile(1))
      expect(result.current.openFiles[result.current.activeFileIndex].pdfPage).toBe(2)
    })

    it('clamps page updates to the first page', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      act(() => result.current.openFile('/workspace/report.pdf', 'agent-1'))

      act(() => result.current.setPdfPage('/workspace/report.pdf', 0))

      expect(result.current.openFiles[0].pdfPage).toBe(1)
    })
  })

  describe('closeFile', () => {
    it('removes the tab', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      act(() => result.current.openFile('/workspace/a.md', 'agent-1'))
      act(() => result.current.openFile('/workspace/b.md', 'agent-1'))
      act(() => result.current.closeFile('/workspace/a.md'))

      expect(result.current.openFiles).toHaveLength(1)
      expect(result.current.openFiles[0].filePath).toBe('/workspace/b.md')
    })

    it('closes tray when last tab is closed', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      act(() => result.current.openFile('/workspace/a.md', 'agent-1'))
      act(() => result.current.closeFile('/workspace/a.md'))

      expect(result.current.openFiles).toHaveLength(0)
      expect(result.current.isOpen).toBe(false)
    })

    it('adjusts activeFileIndex when closing before active', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      act(() => result.current.openFile('/workspace/a.md', 'agent-1'))
      act(() => result.current.openFile('/workspace/b.md', 'agent-1'))
      act(() => result.current.openFile('/workspace/c.md', 'agent-1'))
      // Active is c (index 2)
      expect(result.current.activeFileIndex).toBe(2)

      act(() => result.current.closeFile('/workspace/a.md'))
      // c is now at index 1
      expect(result.current.activeFileIndex).toBe(1)
      expect(result.current.openFiles[result.current.activeFileIndex].filePath).toBe('/workspace/c.md')
    })

    it('adjusts activeFileIndex when closing active tab', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      act(() => result.current.openFile('/workspace/a.md', 'agent-1'))
      act(() => result.current.openFile('/workspace/b.md', 'agent-1'))
      act(() => result.current.openFile('/workspace/c.md', 'agent-1'))
      // Switch to b (index 1)
      act(() => result.current.setActiveFile(1))
      act(() => result.current.closeFile('/workspace/b.md'))

      // Should stay at index 1 (now c) or go to 0 if at end
      expect(result.current.activeFileIndex).toBeLessThan(result.current.openFiles.length)
    })

    it('clears comments for the closed file', () => {
      const { result } = renderHook(() => useFilePreview(), { wrapper })
      act(() => result.current.openFile('/workspace/a.md', 'agent-1'))
      act(() => result.current.addComment({ filePath: '/workspace/a.md', text: 'test' }))
      expect(result.current.comments.get('/workspace/a.md')).toHaveLength(1)

      act(() => result.current.closeFile('/workspace/a.md'))
      expect(result.current.comments.get('/workspace/a.md')).toBeUndefined()
    })
  })

  describe('session change', () => {
    it('clears all state when session changes', () => {
      const { result, rerender } = renderHook(() => useFilePreview(), { wrapper })
      act(() => result.current.openFile('/workspace/a.md', 'agent-1'))
      act(() => result.current.addComment({ filePath: '/workspace/a.md', text: 'note' }))

      expect(result.current.openFiles).toHaveLength(1)
      expect(result.current.isOpen).toBe(true)

      // Change session
      mockView = { kind: 'session', id: 'session-2' }
      rerender()

      expect(result.current.openFiles).toHaveLength(0)
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
