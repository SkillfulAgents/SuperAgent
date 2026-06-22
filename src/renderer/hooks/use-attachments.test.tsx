// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useAttachments } from './use-attachments'
import type { Attachment } from '@renderer/components/messages/attachment-preview'

beforeEach(() => {
  // jsdom doesn't implement object URLs; the hook mints previews for carried images.
  global.URL.createObjectURL = vi.fn(() => 'blob:fresh-url')
  global.URL.revokeObjectURL = vi.fn()
})

describe('useAttachments initialAttachments hydration', () => {
  it('starts empty when nothing is carried over', () => {
    const { result } = renderHook(() => useAttachments())
    expect(result.current.attachments).toEqual([])
  })

  it('mints a fresh preview for a carried image whose preview was stripped', () => {
    const initial: Attachment[] = [
      { type: 'file', id: 'img', file: new File(['x'], 'a.png', { type: 'image/png' }) },
    ]
    const { result } = renderHook(() => useAttachments({ initialAttachments: initial }))
    const a = result.current.attachments[0]
    expect(a.type === 'file' && a.preview).toBe('blob:fresh-url')
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
  })

  it('does not mint previews for non-image files', () => {
    const initial: Attachment[] = [
      { type: 'file', id: 'txt', file: new File(['x'], 'b.txt', { type: 'text/plain' }) },
    ]
    const { result } = renderHook(() => useAttachments({ initialAttachments: initial }))
    const a = result.current.attachments[0]
    expect(a.type === 'file' && a.preview).toBeUndefined()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('carries folders and mounts through untouched', () => {
    const initial: Attachment[] = [
      { type: 'folder', id: 'fld', folderName: 'docs', folderPath: '/host/docs', files: [], totalSize: 0 },
      { type: 'mount', id: 'mnt', folderName: 'repo', hostPath: '/host/repo' },
    ]
    const { result } = renderHook(() => useAttachments({ initialAttachments: initial }))
    expect(result.current.attachments).toEqual(initial)
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })
})
