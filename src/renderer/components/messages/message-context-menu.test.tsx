// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@renderer/test/test-utils'
import { MessageContextMenu } from './message-context-menu'

const openExternalUrl = vi.hoisted(() => vi.fn())
vi.mock('@renderer/lib/open-external', () => ({ openExternalUrl }))

function renderMenu() {
  renderWithProviders(
    <MessageContextMenu text="reply">
      <div>
        <a href="https://example.com/brief">Creative Brief</a>
        <a href="mailto:a@b.co">Mail</a>
        <span>Plain text</span>
      </div>
    </MessageContextMenu>
  )
}

describe('MessageContextMenu', () => {
  it('opens the right-clicked web link in a new tab', () => {
    renderMenu()
    fireEvent.contextMenu(screen.getByText('Creative Brief'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open link in new tab' }))
    expect(openExternalUrl).toHaveBeenCalledWith('https://example.com/brief')
  })

  it('omits the option when the right-click is not on a web link', () => {
    renderMenu()
    fireEvent.contextMenu(screen.getByText('Plain text'))
    expect(screen.getByRole('menuitem', { name: 'Copy' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Open link in new tab' })).not.toBeInTheDocument()
  })

  it('omits the option for non-web links', () => {
    renderMenu()
    fireEvent.contextMenu(screen.getByText('Mail'))
    expect(screen.queryByRole('menuitem', { name: 'Open link in new tab' })).not.toBeInTheDocument()
  })
})
