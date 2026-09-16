// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyLazyTextToClipboard, copyTextToClipboard } from './clipboard'

function stubClipboard(value: unknown) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value })
}

describe('copyTextToClipboard', () => {
  afterEach(() => {
    stubClipboard(undefined)
    vi.unstubAllGlobals()
  })

  it('writes through the async clipboard API when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard({ writeText })

    await copyTextToClipboard('hello')

    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('falls back to a selection copy outside secure contexts', async () => {
    stubClipboard(undefined)
    const execCommand = vi.fn().mockReturnValue(true)
    document.execCommand = execCommand

    await copyTextToClipboard('hello')

    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('reports a blocked selection copy and still cleans up', async () => {
    stubClipboard(undefined)
    document.execCommand = vi.fn().mockReturnValue(false)

    await expect(copyTextToClipboard('hello')).rejects.toThrow('blocked')
    expect(document.querySelector('textarea')).toBeNull()
  })
})

describe('copyLazyTextToClipboard', () => {
  beforeEach(() => {
    vi.stubGlobal('ClipboardItem', class {
      constructor(public readonly items: Record<string, Promise<Blob>>) {}
    })
  })

  afterEach(() => {
    stubClipboard(undefined)
    vi.unstubAllGlobals()
  })

  it('hands the pending text to ClipboardItem so the user gesture survives the fetch', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    stubClipboard({ write, writeText: vi.fn() })
    let resolveText: (text: string) => void = () => {}
    const loadText = vi.fn(() => new Promise<string>(resolve => { resolveText = resolve }))

    const copying = copyLazyTextToClipboard(loadText)
    // The write is issued before the text exists — that is the whole point.
    await vi.waitFor(() => expect(write).toHaveBeenCalled())
    resolveText('file body')
    await copying

    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
  })

  it('retries with writeText when the engine rejects a promise-valued ClipboardItem', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard({ write: vi.fn().mockRejectedValue(new Error('not implemented')), writeText })
    const loadText = vi.fn().mockResolvedValue('file body')

    await copyLazyTextToClipboard(loadText)

    expect(writeText).toHaveBeenCalledWith('file body')
    expect(loadText).toHaveBeenCalledTimes(1)
  })

  it('surfaces the loader error rather than the clipboard error', async () => {
    stubClipboard({ write: vi.fn().mockRejectedValue(new Error('NotAllowedError')), writeText: vi.fn() })

    await expect(
      copyLazyTextToClipboard(() => Promise.reject(new Error('is not a text file'))),
    ).rejects.toThrow('is not a text file')
  })
})
