// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { downloadBlob } from './download'

describe('downloadBlob', () => {
  afterEach(() => { vi.restoreAllMocks() })

  function setup(contentDisposition?: string) {
    const blob = new Blob(['hello'], { type: 'text/plain' })
    const headers = new Headers(contentDisposition ? { 'content-disposition': contentDisposition } : {})
    const fakeRes = { blob: () => Promise.resolve(blob), headers } as unknown as Response

    const fakeUrl = 'blob:http://localhost/fake-id'
    vi.spyOn(URL, 'createObjectURL').mockReturnValue(fakeUrl)
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    const clickSpy = vi.fn()
    const fakeAnchor = { href: '', download: '', click: clickSpy } as unknown as HTMLAnchorElement
    vi.spyOn(document, 'createElement').mockReturnValue(fakeAnchor as never)
    vi.spyOn(document.body, 'appendChild').mockImplementation(() => fakeAnchor as unknown as HTMLElement)
    vi.spyOn(document.body, 'removeChild').mockImplementation(() => fakeAnchor as unknown as HTMLElement)

    return { fakeRes, fakeAnchor, fakeUrl, clickSpy }
  }

  it('creates an anchor, clicks it, then cleans up (fallback name without a header)', async () => {
    const { fakeRes, fakeAnchor, fakeUrl, clickSpy } = setup()

    await downloadBlob(fakeRes, 'test-file.zip')

    expect(fakeAnchor.href).toBe(fakeUrl)
    expect(fakeAnchor.download).toBe('test-file.zip')
    expect(clickSpy).toHaveBeenCalledOnce()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(fakeUrl)
    expect(document.body.removeChild).toHaveBeenCalledWith(fakeAnchor)
  })

  it('prefers the decoded RFC 5987 filename* from Content-Disposition', async () => {
    const { fakeRes, fakeAnchor } = setup(
      `attachment; filename="My%20Agent-template.agent"; filename*=UTF-8''My%20Agent-template.agent`,
    )

    await downloadBlob(fakeRes, 'fallback.agent')

    expect(fakeAnchor.download).toBe('My Agent-template.agent')
  })

  it('decodes a percent-encoded quoted filename when filename* is absent', async () => {
    const { fakeRes, fakeAnchor } = setup('attachment; filename="pdf%20tools.skill"')

    await downloadBlob(fakeRes, 'fallback.skill')

    expect(fakeAnchor.download).toBe('pdf tools.skill')
  })

  it('uses a plain quoted filename verbatim when it is not percent-encoded', async () => {
    const { fakeRes, fakeAnchor } = setup('attachment; filename="100%.txt"')

    await downloadBlob(fakeRes, 'fallback.txt')

    expect(fakeAnchor.download).toBe('100%.txt')
  })
})
