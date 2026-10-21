// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SlidesRenderer } from './slides-renderer'
import { NO_PREVIEW } from './unsupported-renderer'

const apiFetch = vi.hoisted(() => vi.fn())
vi.mock('@renderer/lib/api', () => ({ apiFetch }))
vi.mock('./pdf-renderer', () => ({
  PdfRenderer: ({ url, partLabel }: { url: string; partLabel?: string }) => (
    <div data-testid="pdf" data-url={url} data-part-label={partLabel} />
  ),
}))

const props = { filePath: '/workspace/out/q3.pptx', pageNumber: 1, onPageChange: () => {} }

afterEach(() => {
  vi.restoreAllMocks()
  apiFetch.mockReset()
})

describe('SlidesRenderer', () => {
  it('asks the agent for a PDF and shows it as slides, then frees it', async () => {
    apiFetch.mockResolvedValue(new Response('%PDF', { status: 200, headers: { 'Content-Type': 'application/pdf' } }))
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:deck')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    const { unmount } = render(<SlidesRenderer {...props} agentSlug="sales" />)

    const pdf = await screen.findByTestId('pdf')
    expect(pdf).toHaveAttribute('data-url', 'blob:deck')
    expect(pdf).toHaveAttribute('data-part-label', 'Slide')
    expect(apiFetch).toHaveBeenCalledWith('/api/agents/sales/files-pdf/out/q3.pptx', expect.objectContaining({ method: 'POST' }))
    unmount()
    expect(revoke).toHaveBeenCalledWith('blob:deck')
  })

  it.each([
    ['timeout', 'Took too long to preview.'],
    ['unreadable', "Can't read this file."],
  ])('says why a conversion failed: %s', async (reason, line) => {
    apiFetch.mockResolvedValue(Response.json({ reason }, { status: 422 }))

    render(<SlidesRenderer {...props} agentSlug="sales" />)

    expect(await screen.findByText(line)).toBeVisible()
  })

  it('does not blame the file type when the agent could not convert it', async () => {
    apiFetch.mockResolvedValue(Response.json({ error: 'Failed to convert file' }, { status: 500 }))

    render(<SlidesRenderer {...props} agentSlug="sales" />)

    expect(await screen.findByText("Couldn't preview this deck.")).toBeVisible()
  })

  it('says so when the user may not preview it', async () => {
    apiFetch.mockResolvedValue(Response.json({ error: 'Forbidden' }, { status: 403 }))

    render(<SlidesRenderer {...props} agentSlug="sales" />)

    expect(await screen.findByText("You don't have permission to preview this deck.")).toBeVisible()
  })

  it('does not ask without an agent to convert it', () => {
    render(<SlidesRenderer {...props} agentSlug="" downloadUrl="/volume/q3.pptx" />)

    expect(screen.getByText(NO_PREVIEW)).toBeVisible()
    expect(apiFetch).not.toHaveBeenCalled()
  })
})
