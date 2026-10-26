// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { SidePanelIcon } from './side-panel-icon'

afterEach(cleanup)

const panelOf = (container: HTMLElement) => container.querySelector('.side-panel-icon-panel')!

describe('SidePanelIcon', () => {
  it('draws a closed panel as a line against the window’s right edge, and an open one as a panel grown to the left', () => {
    const { container, rerender } = render(<SidePanelIcon open={false} />)
    const svg = container.querySelector('svg')!
    expect(svg).toHaveAttribute('data-state', 'closed')
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg).toHaveClass('lucide')
    expect(panelOf(container)).toHaveAttribute('x', '16')
    expect(panelOf(container)).toHaveAttribute('width', '1')

    rerender(<SidePanelIcon open />)
    expect(svg).toHaveAttribute('data-state', 'open')
    expect(panelOf(container)).toHaveAttribute('x', '11')
    expect(panelOf(container)).toHaveAttribute('width', '6')
  })

  it('takes a size like a Lucide icon', () => {
    const { container } = render(<SidePanelIcon open={false} className="h-4 w-4" />)
    expect(container.querySelector('svg')).toHaveClass('lucide', 'h-4', 'w-4')
  })
})
