// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { DrawerShell } from './drawer-shell'

describe('DrawerShell', () => {
  it('marks the open drawer as an overlay when requested', () => {
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
    expect(shell.firstElementChild).not.toHaveClass('file-preview-responsive-resize-handle')
  })
})
