// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { getFileBrowserTabKey, useFilePreviewTabs, type FileBrowserTab } from './use-file-preview-tabs'

const directory: FileBrowserTab = { kind: 'folder', rootPath: '', displayName: 'Files', closable: false, expandedPaths: [], query: '' }
const file = (path: string): FileBrowserTab => ({ kind: 'file', filePath: path, displayName: path, version: 1, pdfPage: 1 })

describe('shared file preview tabs', () => {
  it('cannot close the pinned directory, including through the state API', () => {
    const { result } = renderHook(() => useFilePreviewTabs<FileBrowserTab>(getFileBrowserTabKey, [directory]))
    act(() => result.current.openTab(file('report.md')))
    act(() => result.current.closeTab(getFileBrowserTabKey(directory)))
    expect(result.current.openTabs).toHaveLength(2)
    expect(result.current.activeTabIndex).toBe(1)
    act(() => result.current.closeTab('file:report.md'))
    expect(result.current.openTabs).toEqual([directory])
    expect(result.current.activeTabIndex).toBe(0)
  })

  it('retains the active file when a preceding file closes and selects a neighbor when it closes', () => {
    const { result } = renderHook(() => useFilePreviewTabs<FileBrowserTab>(getFileBrowserTabKey, [directory]))
    act(() => {
      result.current.openTab(file('a.md'))
      result.current.openTab(file('b.md'))
      result.current.openTab(file('c.md'))
    })
    act(() => result.current.setActiveTabIndex(2))
    act(() => result.current.closeTab('file:a.md'))
    expect(result.current.openTabs[result.current.activeTabIndex]).toMatchObject({ filePath: 'b.md' })
    act(() => result.current.closeTab('file:b.md'))
    expect(result.current.openTabs[result.current.activeTabIndex]).toMatchObject({ filePath: 'c.md' })
  })
})
