// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { SidebarProvider } from './sidebar'

/**
 * The stored width is not ours: this key lives in a localStorage keyed on the
 * app name, so every local build — shipped, dev, and any branch — writes to the
 * same one. A value from outside the current bounds has to be survivable, since
 * a sidebar narrower than the drag minimum cannot be widened *or* reproduced by
 * the person looking at it.
 */
function widthOf(): string {
  return screen.getByTestId('provider').style.getPropertyValue('--sidebar-width')
}

function renderProvider() {
  render(<SidebarProvider data-testid="provider" />)
}

afterEach(() => {
  localStorage.clear()
})

describe('SidebarProvider stored width', () => {
  it('uses the stored width when it is in range', () => {
    localStorage.setItem('sidebar_width', '360')
    renderProvider()
    expect(widthOf()).toBe('360px')
  })

  it('raises a stored width below the drag minimum', () => {
    localStorage.setItem('sidebar_width', '272')
    renderProvider()
    expect(widthOf()).toBe('288px')
  })

  it('lowers a stored width above the drag maximum', () => {
    localStorage.setItem('sidebar_width', '900')
    renderProvider()
    expect(widthOf()).toBe('480px')
  })

  it('falls back to the default when the stored value is not a width', () => {
    localStorage.setItem('sidebar_width', 'wide')
    renderProvider()
    expect(widthOf()).toBe('288px')
  })
})
