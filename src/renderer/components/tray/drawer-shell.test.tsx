// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { DrawerShell, slideOverWidth } from './drawer-shell'

describe('DrawerShell', () => {
  it('marks the drawer for a full-width overlay only at the responsive breakpoint', () => {
    const { container } = render(
      <DrawerShell isOpen storageKey="test-tray-width" responsiveFullWidth>
        <div>Preview</div>
      </DrawerShell>,
    )

    const shell = container.firstElementChild as HTMLElement
    expect(shell).toHaveClass('file-preview-responsive-overlay')
    expect(shell).not.toHaveClass('file-preview-responsive-overlay-closed')
    expect(shell.firstElementChild).toHaveClass('file-preview-responsive-resize-handle')
  })

  it('can overlay wide content independently of its responsive behavior', () => {
    const { container } = render(
      <DrawerShell isOpen storageKey="test-tray-width-wide" wideOverlay>
        <div>Preview</div>
      </DrawerShell>,
    )

    const shell = container.firstElementChild as HTMLElement
    expect(shell).toHaveClass('file-preview-wide-overlay')
    expect(shell).not.toHaveClass('file-preview-responsive-overlay')
  })

  it('combines wide and responsive overlays for the agent home file preview', () => {
    const { container } = render(
      <DrawerShell
        isOpen
        storageKey="test-tray-width-agent-home"
        responsiveFullWidth
        wideOverlay
      >
        <div>Preview</div>
      </DrawerShell>,
    )

    expect(container.firstElementChild).toHaveClass(
      'file-preview-responsive-overlay',
      'file-preview-wide-overlay',
    )
  })

  it('keeps a requested overlay mounted off-canvas while closed', () => {
    const { container } = render(
      <DrawerShell isOpen={false} storageKey="test-tray-width-closed" responsiveFullWidth>
        <div>Preview</div>
      </DrawerShell>,
    )

    const shell = container.firstElementChild as HTMLElement
    expect(shell).toHaveClass(
      'file-preview-responsive-overlay',
      'file-preview-responsive-overlay-closed',
    )
  })

  it('retains the resizable side-drawer layout by default', () => {
    const { container } = render(
      <DrawerShell isOpen storageKey="test-tray-width-default">
        <div>Preview</div>
      </DrawerShell>,
    )

    const shell = container.firstElementChild as HTMLElement
    expect(shell).not.toHaveClass('file-preview-responsive-overlay')
    expect(shell).not.toHaveClass('file-preview-wide-overlay')
    expect(shell.firstElementChild).not.toHaveClass('file-preview-responsive-resize-handle')
  })
})

describe('slideOverWidth', () => {
  it('leaves the drawer beside the content while the content keeps 240px', () => {
    expect(slideOverWidth(450, 1200)).toBe(0)
    expect(slideOverWidth(800, 1040)).toBe(0)
  })

  it('reaches over the content by exactly what would take it under 240px', () => {
    expect(slideOverWidth(800, 904)).toBe(136)
  })

  it('reaches at most 240px when the drawer fills its host', () => {
    expect(slideOverWidth(800, 700)).toBe(240)
  })

  it('reaches over the whole host when the host is narrower than 240px', () => {
    expect(slideOverWidth(450, 200)).toBe(200)
  })

  it('reaches nothing before the host is measured', () => {
    expect(slideOverWidth(800, 0)).toBe(0)
  })
})
