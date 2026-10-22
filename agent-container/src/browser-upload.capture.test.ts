// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { recordFileInputChange } from './browser-upload'

function setFiles(input: HTMLInputElement, files: File[]): void {
  Object.defineProperty(input, 'files', { value: files, configurable: true })
}

describe('recordFileInputChange', () => {
  it('records the file even when the site clears the input in its own change handler', () => {
    const input = document.createElement('input')
    input.type = 'file'
    document.body.appendChild(input)

    let siteSawFiles = 0
    input.addEventListener('change', () => {
      siteSawFiles = input.files?.length ?? 0
      setFiles(input, [])
    })

    recordFileInputChange(input, 'upload-key')

    setFiles(input, [new File(['photo bytes'], 'living-room.jpg', { type: 'image/jpeg' })])
    input.dispatchEvent(new Event('change', { bubbles: true }))

    expect(siteSawFiles).toBe(1)
    expect((globalThis as Record<string, unknown>)['upload-key']).toEqual({
      count: 1,
      name: 'living-room.jpg',
      size: 11,
    })
  })

  it('ignores change events from other inputs', () => {
    const target = document.createElement('input')
    const other = document.createElement('input')
    document.body.append(target, other)

    recordFileInputChange(target, 'other-key')
    other.dispatchEvent(new Event('change', { bubbles: true }))

    expect((globalThis as Record<string, unknown>)['other-key']).toBeNull()
  })
})
