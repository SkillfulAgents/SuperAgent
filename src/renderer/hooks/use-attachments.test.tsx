// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { StrictMode, type ReactNode } from 'react'
import type { Attachment } from '@renderer/components/messages/attachment-preview'
import { useAttachments } from './use-attachments'

describe('useAttachments initial attachments', () => {
  afterEach(() => vi.restoreAllMocks())

  it('recreates and later revokes a carried image preview', () => {
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

  it('keeps only the live restored image preview under StrictMode', () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:discarded-preview')
      .mockReturnValueOnce('blob:live-preview')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const attachment: Attachment = {
      type: 'file',
      id: 'image-1',
      file: new File(['image'], 'image.png', { type: 'image/png' }),
    }
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>

    const { result, unmount } = renderHook(() =>
      useAttachments({ initialAttachments: [attachment] }),
    { wrapper })

    expect(createObjectURL).toHaveBeenCalledTimes(2)
    expect(result.current.attachments[0]).toEqual({ ...attachment, preview: 'blob:live-preview' })
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:discarded-preview')
    expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:live-preview')

    unmount()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:live-preview')
  })

  it('restores drafted chips with their upload state, so finished uploads are reused', () => {
    const restored: Attachment = {
      type: 'file',
      id: 'restored',
      file: new File(['restored'], 'restored.txt'),
      upload: { status: 'done', path: '/workspace/restored.txt', agentSlug: 'agent-a' },
    }

    const { result } = renderHook(() => useAttachments({ initialAttachments: [restored] }))

    expect(result.current.attachments).toEqual([restored])
  })

  it('revokes previews created for images added after mount', () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:added-preview')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const file = new File(['image'], 'added.png', { type: 'image/png' })
    const { result, unmount } = renderHook(() => useAttachments())

    act(() => result.current.addFiles([{ file }]))
    expect(result.current.attachments[0]).toMatchObject({ preview: 'blob:added-preview' })
    unmount()

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:added-preview')
  })
})
