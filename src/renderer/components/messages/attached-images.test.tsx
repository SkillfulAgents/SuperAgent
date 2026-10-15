// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AttachedImages } from './attached-images'

// How one picture draws itself is sent-attachment-chip.test.tsx's business.
vi.mock('./sent-attachment-chip', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sent-attachment-chip')>()),
  SentAttachmentChip: ({ filePath }: { filePath: string }) => <div data-testid="file-pill" data-file-path={filePath} />,
}))

describe('AttachedImages', () => {
  const images = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `k${i}`, filePath: `/workspace/${i}.png` }))

  it('stacks up to three on the side it is aligned to', () => {
    render(<AttachedImages images={images(2)} agentSlug="a1" align="start" data-testid="imgs" />)
    const block = screen.getByTestId('imgs')
    expect(block).toHaveAttribute('data-image-layout', 'single')
    expect(block).toHaveClass('items-start')
    expect(screen.getAllByTestId('file-pill')).toHaveLength(2)
  })

  it('switches to the grid past three, pushed right only for the user', () => {
    const { rerender } = render(<AttachedImages images={images(4)} agentSlug="a1" align="end" data-testid="imgs" />)
    expect(screen.getByTestId('imgs')).toHaveAttribute('data-image-layout', 'grid')
    expect(screen.getByTestId('imgs')).toHaveClass('ml-auto')
    rerender(<AttachedImages images={images(4)} agentSlug="a1" align="start" data-testid="imgs" />)
    expect(screen.getByTestId('imgs')).not.toHaveClass('ml-auto')
  })
})
