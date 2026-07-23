// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { DrawerShell } from './drawer-shell'

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
