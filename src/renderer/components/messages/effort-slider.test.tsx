// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EffortSlider } from './effort-slider'
import { EFFORT_LEVELS, type EffortLevel } from '@shared/lib/container/types'

const ALL = [...EFFORT_LEVELS] as EffortLevel[]
const STD: EffortLevel[] = ['low', 'medium', 'high']

describe('EffortSlider', () => {
  it('renders a tick per allowed level, labeling only the Faster/Smarter poles', () => {
    render(<EffortSlider levels={ALL} value="medium" onChange={vi.fn()} />)
    for (const level of ALL) expect(screen.getByTestId(`effort-option-${level}`)).toBeInTheDocument()
    expect(screen.getByText('Faster')).toBeInTheDocument()
    expect(screen.getByText('Smarter')).toBeInTheDocument()
    // No per-level names on the bar — they live in aria labels only.
    expect(screen.queryByText('Med')).not.toBeInTheDocument()
    expect(screen.queryByText('X-High')).not.toBeInTheDocument()
    expect(screen.getByTestId('effort-option-xhigh')).toHaveAccessibleName('X-High')
  })

  it('only renders the levels it is given (3-effort model has no xhigh/max)', () => {
    render(<EffortSlider levels={STD} value="medium" onChange={vi.fn()} />)
    expect(screen.getByTestId('effort-option-high')).toBeInTheDocument()
    expect(screen.queryByTestId('effort-option-xhigh')).not.toBeInTheDocument()
    expect(screen.queryByTestId('effort-option-max')).not.toBeInTheDocument()
  })

  it('clicking a stop fires onChange then onCommit for that level', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const onCommit = vi.fn()
    render(<EffortSlider levels={ALL} value="medium" onChange={onChange} onCommit={onCommit} />)
    await user.click(screen.getByTestId('effort-option-max'))
    expect(onChange).toHaveBeenCalledWith('max')
    expect(onCommit).toHaveBeenCalledWith('max')
  })

  it('exposes the thumb as a slider with the active index and label', () => {
    render(<EffortSlider levels={ALL} value="high" onChange={vi.fn()} />)
    const thumb = screen.getByRole('slider')
    expect(thumb).toHaveAttribute('aria-valuenow', '2') // high = index 2 of low/medium/high/…
    expect(thumb).toHaveAttribute('aria-valuemax', '4') // 5 levels → 0..4
    expect(thumb).toHaveAttribute('aria-valuetext', 'High')
  })

  it('arrow keys step the value via onChange without committing (popover stays open)', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const onCommit = vi.fn()
    render(<EffortSlider levels={ALL} value="medium" onChange={onChange} onCommit={onCommit} />)
    const thumb = screen.getByRole('slider')
    thumb.focus()
    await user.keyboard('{ArrowRight}')
    expect(onChange).toHaveBeenLastCalledWith('high')
    await user.keyboard('{ArrowLeft}{ArrowLeft}')
    expect(onChange).toHaveBeenLastCalledWith('low')
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('keeps a calm light-gray fill, overlaying the rainbow only at Max', () => {
    const { rerender } = render(<EffortSlider levels={ALL} value="high" onChange={vi.fn()} />)
    // The base fill is always the calm gray; the rainbow is a separate overlay.
    expect(screen.getByTestId('effort-fill').className).toContain('bg-foreground/15')
    expect(screen.queryByTestId('effort-fill-rainbow')).not.toBeInTheDocument()

    rerender(<EffortSlider levels={ALL} value="max" onChange={vi.fn()} />)
    // At Max the gray crossfades out (inverse mask) as the rainbow fades in.
    expect(screen.getByTestId('effort-fill').className).toContain('effort-fill-fade')
    expect(screen.getByTestId('effort-fill-rainbow').className).toContain('effort-rainbow')
  })

  it('does not step past the ends', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<EffortSlider levels={STD} value="high" onChange={onChange} />)
    screen.getByRole('slider').focus()
    await user.keyboard('{ArrowRight}') // already at the top
    expect(onChange).not.toHaveBeenCalled()
  })
})
