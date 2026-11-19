// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import { act, renderHook } from '@testing-library/react'
import type { Attachment } from '@renderer/components/messages/attachment-preview'
import { useAttachments } from './use-attachments'

describe('useAttachments initial attachments', () => {
  afterEach(() => vi.restoreAllMocks())

  it('waits for the uploaded inline URL instead of creating an unusable HEIC blob preview', () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:broken-heic')
    const attachment: Attachment = {
      type: 'file',
      id: 'image-1',
      file: new File(['heic'], 'image.heic', { type: 'image/heic' }),
    }

    const { result } = renderHook(() => useAttachments({ initialAttachments: [attachment] }))

    expect(createObjectURL).not.toHaveBeenCalled()
    expect(result.current.attachments[0]).toEqual(attachment)
  })

  it('makes the picture of an image chip it starts with, and revokes it on unmount', () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:new-preview')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const attachment: Attachment = {
      type: 'file',
      id: 'image-1',
      file: new File(['image'], 'image.png', { type: 'image/png' }),
    }

    const { result, unmount } = renderHook(() =>
      useAttachments({ initialAttachments: [attachment] }),
    )

    expect(createObjectURL).toHaveBeenCalledWith(attachment.file)
    expect(result.current.attachments[0]).toEqual({ ...attachment, preview: 'blob:new-preview' })
    unmount()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:new-preview')
  })

  it('starts with the chips as they were kept, upload state and failures included', () => {
    const file = new File(['x'], 'notes.txt', { type: 'text/plain' })
    const kept: Attachment[] = [
      { type: 'file', id: 'done', file, upload: { status: 'done', path: '/workspace/uploads/notes.txt', agentSlug: 'agent-a' } },
      { type: 'file', id: 'failed', file, error: 'Too large', errorRetryable: false },
      { type: 'mount', id: 'mount', folderName: 'project', hostPath: '/home/me/project' },
    ]
    const { result } = renderHook(() => useAttachments({ initialAttachments: kept }))
    expect(result.current.attachments).toEqual(kept)
  })

  it('keeps the preview the server serves for an uploaded HEIC', () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:broken-heic')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const attachment: Attachment = {
      type: 'file',
      id: 'image-1',
      file: new File(['heic'], 'image.heic', { type: 'image/heic' }),
      preview: '/api/agents/agent-a/files/uploads/image.heic?inline=1',
      upload: { status: 'done', path: '/workspace/uploads/image.heic', agentSlug: 'agent-a' },
    }
    const { result, unmount } = renderHook(() => useAttachments({ initialAttachments: [attachment] }))
    expect(result.current.attachments[0]).toEqual(attachment)
    unmount()
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(revokeObjectURL).not.toHaveBeenCalled()
  })

  it('shows a live picture under StrictMode, whose first cleanup revokes the first one made', () => {
    let made = 0
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:preview-${++made}`)
    const revoked: string[] = []
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => { revoked.push(url) })
    const attachment: Attachment = { type: 'file', id: 'image-1', file: new File(['image'], 'image.png', { type: 'image/png' }) }

    const { result, unmount } = renderHook(() => useAttachments({ initialAttachments: [attachment] }), { wrapper: StrictMode })

    const shown = result.current.attachments[0]
    expect(shown.type === 'file' && shown.preview).toBe('blob:preview-2')
    expect(revoked).toEqual(['blob:preview-1'])
    unmount()
    expect(revoked).toContain('blob:preview-2')
  })

  it('revokes on unmount the picture of a file added after it mounted', () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:added-later')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const { result, unmount } = renderHook(() => useAttachments())
    act(() => result.current.addFiles([{ file: new File(['image'], 'later.png', { type: 'image/png' }) }]))
    expect(revokeObjectURL).not.toHaveBeenCalled()
    unmount()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:added-later')
  })
})
