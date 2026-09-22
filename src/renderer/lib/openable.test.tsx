// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { openableProps } from './openable'

function Row({ open, download }: { open: () => void; download?: () => void }) {
  return (
    <div {...openableProps(open)} data-testid="row">
      <span>report.xlsx</span>
      <a href="/download" data-testid="download" onClick={(e) => { e.stopPropagation(); download?.() }}>
        Download
      </a>
    </div>
  )
}

describe('openableProps', () => {
  it('gives the element button semantics', () => {
    render(<Row open={vi.fn()} />)
    const row = screen.getByTestId('row')
    expect(row).toHaveAttribute('role', 'button')
    expect(row).toHaveAttribute('tabindex', '0')
  })

  it.each(['Enter', ' '])('opens on %s', (key) => {
    const open = vi.fn()
    render(<Row open={open} />)
    fireEvent.keyDown(screen.getByTestId('row'), { key })
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('ignores keys that do not activate a button', () => {
    const open = vi.fn()
    render(<Row open={open} />)
    fireEvent.keyDown(screen.getByTestId('row'), { key: 'a' })
    fireEvent.keyDown(screen.getByTestId('row'), { key: 'Tab' })
    expect(open).not.toHaveBeenCalled()
  })

  // The regression from #945: without the target guard the row's handler runs on
  // a key event bubbling up from the nested link and preventDefault()s it, so
  // Enter on Download opened the drawer instead of downloading.
  it('leaves Enter on a nested control to that control', () => {
    const open = vi.fn()
    render(<Row open={open} />)
    const event = fireEvent.keyDown(screen.getByTestId('download'), { key: 'Enter', bubbles: true })
    expect(open).not.toHaveBeenCalled()
    expect(event).toBe(true) // not preventDefault()ed, so the link still navigates
  })

  // Clicks are deliberately unguarded: clicking the icon or the name has to open
  // the row. A nested control opts out with its own stopPropagation().
  it('opens on a click anywhere inside, unless a child stops it', () => {
    const open = vi.fn()
    const download = vi.fn()
    render(<Row open={open} download={download} />)

    fireEvent.click(screen.getByText('report.xlsx'))
    expect(open).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('download'))
    expect(download).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('keeps activation off a clickable ancestor when asked', () => {
    const open = vi.fn()
    const outer = vi.fn()
    render(
      // Standing in for the collapsed tool row the pill sits inside, which is
      // itself a clickable element.
      <div role="button" tabIndex={0} onClick={outer} onKeyDown={outer}>
        <span {...openableProps(open, { stopPropagation: true })} data-testid="pill">notes.txt</span>
      </div>,
    )

    fireEvent.click(screen.getByTestId('pill'))
    fireEvent.keyDown(screen.getByTestId('pill'), { key: 'Enter' })
    expect(open).toHaveBeenCalledTimes(2)
    expect(outer).not.toHaveBeenCalled()
  })
})
