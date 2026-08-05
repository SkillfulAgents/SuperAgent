// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
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
})
