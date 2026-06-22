// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CompactBoundaryItem } from './compact-boundary-item'
import { createCompactBoundary } from '@renderer/test/factories'

describe('CompactBoundaryItem', () => {
  it('returns null when neither boundary nor isCompacting', () => {
    const { container } = render(<CompactBoundaryItem />)
    expect(container.innerHTML).toBe('')
  })

  it('shows compacting indicator when isCompacting=true', () => {
    render(<CompactBoundaryItem isCompacting />)
    expect(screen.getByText('Compacting conversation...')).toBeInTheDocument()
  })

  it('shows "Compacted" label for completed boundary', () => {
    const boundary = createCompactBoundary({ summary: 'A summary' })
    render(<CompactBoundaryItem boundary={boundary} />)
    expect(screen.getByText('Compacted')).toBeInTheDocument()
  })

  it('shows summary when expanded', async () => {
    const user = userEvent.setup()
    const boundary = createCompactBoundary({ summary: 'Discussed project setup.' })
    render(<CompactBoundaryItem boundary={boundary} />)

    // Summary not visible initially
    expect(screen.queryByText('Discussed project setup.')).not.toBeInTheDocument()

    // Click to expand
    await user.click(screen.getByText('Compacted'))
    expect(screen.getByText('Discussed project setup.')).toBeInTheDocument()
    expect(screen.getByText('Compaction Summary')).toBeInTheDocument()
  })

  it('hides summary when collapsed again', async () => {
    const user = userEvent.setup()
    const boundary = createCompactBoundary({ summary: 'Some details' })
    render(<CompactBoundaryItem boundary={boundary} />)

    await user.click(screen.getByText('Compacted'))
    expect(screen.getByText('Some details')).toBeInTheDocument()

    await user.click(screen.getByText('Compacted'))
    expect(screen.queryByText('Some details')).not.toBeInTheDocument()
  })

  it('does not render summary section when boundary has no summary', async () => {
    const user = userEvent.setup()
    const boundary = createCompactBoundary({ summary: '' })
    render(<CompactBoundaryItem boundary={boundary} />)

    await user.click(screen.getByText('Compacted'))
    expect(screen.queryByText('Compaction Summary')).not.toBeInTheDocument()
  })

  it('shows a "View original conversation" link for a branch card and calls onViewSource with the source id', async () => {
    const user = userEvent.setup()
    const onViewSource = vi.fn()
    const boundary = createCompactBoundary({
      summary: 'Carried-over context.',
      trigger: 'branch',
      label: 'Continued from previous conversation',
      fromSessionId: 'sess-src',
    })
    render(<CompactBoundaryItem boundary={boundary} onViewSource={onViewSource} />)

    await user.click(screen.getByText('Continued from previous conversation'))
    await user.click(screen.getByText('View original conversation'))
    expect(onViewSource).toHaveBeenCalledWith('sess-src')
  })

  it('does not show the link when the boundary has no fromSessionId', async () => {
    const user = userEvent.setup()
    const boundary = createCompactBoundary({ summary: 'A summary' })
    render(<CompactBoundaryItem boundary={boundary} onViewSource={vi.fn()} />)

    await user.click(screen.getByText('Compacted'))
    expect(screen.queryByText('View original conversation')).not.toBeInTheDocument()
  })

  it('prefers compacting indicator over boundary when both are set', () => {
    const boundary = createCompactBoundary()
    render(<CompactBoundaryItem boundary={boundary} isCompacting />)
    expect(screen.getByText('Compacting conversation...')).toBeInTheDocument()
    expect(screen.queryByText('Compacted')).not.toBeInTheDocument()
  })
})
