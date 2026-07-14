// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EffortSlider, EffortSection } from './effort-slider'
import { EFFORT_LEVELS, type EffortLevel } from '@shared/lib/container/types'

const ALL = [...EFFORT_LEVELS] as EffortLevel[]
const STD: EffortLevel[] = ['low', 'medium', 'high']

describe('EffortSlider', () => {
  it('renders a tick per allowed level, labeling only the Faster/Smarter poles', () => {
    render(<EffortSlider levels={ALL} value="medium" onChange={vi.fn()} />)
    for (const level of ALL) expect(screen.getByTestId(`effort-option-${level}`)).toBeInTheDocument()
    expect(screen.getByText('Faster')).toBeInTheDocument()
    expect(screen.getByText('Smarter')).toBeInTheDocument()
    // No per-level names on the bar — they live in aria labels only, spelled
    // out in full for screen readers.
    expect(screen.queryByText('Medium')).not.toBeInTheDocument()
    expect(screen.queryByText('Extra High')).not.toBeInTheDocument()
    expect(screen.getByTestId('effort-option-xhigh')).toHaveAccessibleName('Extra High')
  })

  it('only renders the levels it is given (3-effort model has no xhigh/max)', () => {
    render(<EffortSlider levels={STD} value="medium" onChange={vi.fn()} />)
    expect(screen.getByTestId('effort-option-high')).toBeInTheDocument()
    expect(screen.queryByTestId('effort-option-xhigh')).not.toBeInTheDocument()
    expect(screen.queryByTestId('effort-option-max')).not.toBeInTheDocument()
  })

  it('activating a stop (keyboard/AT click) fires onChange for that level, but not for the current one', () => {
    const onChange = vi.fn()
    render(<EffortSlider levels={ALL} value="medium" onChange={onChange} />)
    // fireEvent.click = a bare click with no pointer gesture, i.e. keyboard/AT
    // activation (a real pointer press is captured by the track, which
    // retargets the click away from the tick).
    fireEvent.click(screen.getByTestId('effort-option-max'))
    expect(onChange).toHaveBeenCalledWith('max')
    fireEvent.click(screen.getByTestId('effort-option-medium'))
    expect(onChange).toHaveBeenCalledTimes(1) // re-activating the current value is a no-op
  })

  it('exposes the thumb as a slider with the active index and label', () => {
    render(<EffortSlider levels={ALL} value="high" onChange={vi.fn()} />)
    const thumb = screen.getByRole('slider')
    expect(thumb).toHaveAttribute('aria-valuenow', '2') // high = index 2 of low/medium/high/…
    expect(thumb).toHaveAttribute('aria-valuemax', '4') // 5 levels → 0..4
    expect(thumb).toHaveAttribute('aria-valuetext', 'High')
  })

  it('arrow keys step the value via onChange', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<EffortSlider levels={ALL} value="medium" onChange={onChange} />)
    const thumb = screen.getByRole('slider')
    thumb.focus()
    await user.keyboard('{ArrowRight}')
    expect(onChange).toHaveBeenLastCalledWith('high')
    await user.keyboard('{ArrowLeft}{ArrowLeft}')
    expect(onChange).toHaveBeenLastCalledWith('low')
  })

  it('keeps a blue fill, overlaying the rainbow only at Max', () => {
    const { rerender } = render(<EffortSlider levels={ALL} value="high" onChange={vi.fn()} />)
    // The base fill is always the blue fill; the rainbow is a separate overlay.
    expect(screen.getByTestId('effort-fill').className).toContain('bg-[#0099FF]')
    expect(screen.queryByTestId('effort-fill-rainbow')).not.toBeInTheDocument()

    rerender(<EffortSlider levels={ALL} value="max" onChange={vi.fn()} />)
    // At Max the blue crossfades out (inverse mask) as the rainbow fades in.
    expect(screen.getByTestId('effort-fill').className).toContain('effort-fill-fade')
    expect(screen.getByTestId('effort-fill-rainbow').className).toContain('effort-rainbow')
  })

  it('the rainbow overlay never hit-tests over the tick buttons', () => {
    render(<EffortSlider levels={ALL} value="max" onChange={vi.fn()} />)
    // Decorative only — without this, the overlay covers every tick at Max and
    // intercepts clicks targeted at the effort-option-* buttons.
    expect(screen.getByTestId('effort-fill-rainbow').className).toContain('pointer-events-none')
  })

  it('a drag previews once per level crossed and settles ONE onChange on release', () => {
    const onChange = vi.fn()
    const onPreview = vi.fn()
    render(<EffortSlider levels={ALL} value="low" onChange={onChange} onPreview={onPreview} />)
    const track = screen.getByTestId('effort-slider').querySelector('.touch-none') as HTMLElement
    // jsdom has no layout; 120px wide − 2×10px track-radius = stops at x=10,35,60,85,110.
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 120 } as DOMRect)
    fireEvent.pointerDown(track, { clientX: 10 }) // the current stop — no preview
    fireEvent.pointerMove(track, { clientX: 12 }) // still 'low'
    expect(onPreview).not.toHaveBeenCalled()
    fireEvent.pointerMove(track, { clientX: 60 }) // 'high'
    fireEvent.pointerMove(track, { clientX: 61 }) // still 'high' — deduped
    expect(onPreview).toHaveBeenCalledTimes(1)
    expect(onPreview).toHaveBeenLastCalledWith('high')
    fireEvent.pointerMove(track, { clientX: 110 }) // 'max'
    expect(onPreview).toHaveBeenCalledTimes(2)
    // Nothing persisted mid-drag — intermediate writes would race the final one.
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.pointerUp(track)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('max')
  })

  it('a drag can start on a tick dot — the press bubbles to the track', () => {
    const onChange = vi.fn()
    const onPreview = vi.fn()
    render(<EffortSlider levels={ALL} value="medium" onChange={onChange} onPreview={onPreview} />)
    const track = screen.getByTestId('effort-slider').querySelector('.touch-none') as HTMLElement
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 120 } as DOMRect)
    // Press ON the medium tick (x=35 == its stop), then drag to the far end.
    fireEvent.pointerDown(screen.getByTestId('effort-option-medium'), { clientX: 35 })
    fireEvent.pointerMove(track, { clientX: 110 })
    expect(onPreview).toHaveBeenLastCalledWith('max')
    fireEvent.pointerUp(track)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith('max')
  })

  it('a cancelled drag discards the preview and settles nothing', () => {
    const onChange = vi.fn()
    const onPreview = vi.fn()
    render(<EffortSlider levels={ALL} value="medium" onChange={onChange} onPreview={onPreview} />)
    const track = screen.getByTestId('effort-slider').querySelector('.touch-none')!
    fireEvent.pointerDown(track, { clientX: 0 })
    expect(onPreview).toHaveBeenLastCalledWith('low') // unmocked 0-width rect → leftmost stop
    fireEvent.pointerCancel(track)
    expect(onPreview).toHaveBeenLastCalledWith(null) // aborted → discard
    fireEvent.pointerMove(track, { clientX: 50 }) // post-cancel hover changes nothing
    fireEvent.pointerUp(track)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('EffortSection: the header tracks the drag preview but persists only the release', () => {
    const onChange = vi.fn()
    render(<EffortSection levels={ALL} value="low" onChange={onChange} />)
    const track = screen.getByTestId('effort-slider').querySelector('.touch-none') as HTMLElement
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 120 } as DOMRect)
    fireEvent.pointerDown(track, { clientX: 60 }) // 'high'
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuetext', 'High')
    fireEvent.pointerMove(track, { clientX: 110 }) // 'max'
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuetext', 'Max')
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.pointerUp(track)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('max')
  })

  it('EffortSection: releasing back where the drag started persists nothing', () => {
    const onChange = vi.fn()
    render(<EffortSection levels={ALL} value="low" onChange={onChange} />)
    const track = screen.getByTestId('effort-slider').querySelector('.touch-none') as HTMLElement
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 120 } as DOMRect)
    fireEvent.pointerDown(track, { clientX: 10 })
    fireEvent.pointerMove(track, { clientX: 110 }) // out to 'max'…
    fireEvent.pointerMove(track, { clientX: 10 }) // …and back to 'low'
    fireEvent.pointerUp(track)
    expect(onChange).not.toHaveBeenCalled()
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
