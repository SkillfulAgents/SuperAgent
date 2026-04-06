// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { downloadBlob } from './download'

describe('downloadBlob', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('creates an anchor, clicks it, then cleans up', async () => {
    const blob = new Blob(['hello'], { type: 'text/plain' })
    const fakeRes = { blob: () => Promise.resolve(blob) } as unknown as Response

    const fakeUrl = 'blob:http://localhost/fake-id'
    vi.spyOn(URL, 'createObjectURL').mockReturnValue(fakeUrl)
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    const clickSpy = vi.fn()
    const fakeAnchor = { href: '', download: '', click: clickSpy } as unknown as HTMLAnchorElement
    vi.spyOn(document, 'createElement').mockReturnValue(fakeAnchor as never)
    vi.spyOn(document.body, 'appendChild').mockImplementation(() => fakeAnchor as unknown as HTMLElement)
    vi.spyOn(document.body, 'removeChild').mockImplementation(() => fakeAnchor as unknown as HTMLElement)

    await downloadBlob(fakeRes, 'test-file.zip')

    expect(fakeAnchor.href).toBe(fakeUrl)
    expect(fakeAnchor.download).toBe('test-file.zip')
    expect(clickSpy).toHaveBeenCalledOnce()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(fakeUrl)
    expect(document.body.removeChild).toHaveBeenCalledWith(fakeAnchor)
  })
})
