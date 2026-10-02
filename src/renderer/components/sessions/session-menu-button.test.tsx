// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { createRef } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SessionMenuButton } from './session-menu-button'

function renderButton(props: Partial<React.ComponentProps<typeof SessionMenuButton>> = {}) {
  const triggerRef = createRef<HTMLAnchorElement>()
  const onContextMenu = vi.fn((e: React.MouseEvent) => e.preventDefault())
  const onTriggerClick = vi.fn()
  // A link, like the sidebar row: the button's click must not navigate it.
  render(
    <a href="/agents/test-agent" ref={triggerRef} onContextMenu={onContextMenu} onClick={onTriggerClick}>
      row
      <SessionMenuButton triggerRef={triggerRef} sessionName="Session One" menuOpen={false} {...props} />
    </a>
  )
  return { onContextMenu, onTriggerClick }
}

describe('SessionMenuButton', () => {
  it('replays a click as a contextmenu event on the menu trigger', async () => {
    const { onContextMenu, onTriggerClick } = renderButton()
    await userEvent.click(screen.getByRole('button', { name: 'Options for Session One' }))
    expect(onContextMenu).toHaveBeenCalledTimes(1)
    // The click itself must not leak to the row (which may be a link).
    expect(onTriggerClick).not.toHaveBeenCalled()
  })

  it('anchors the menu under the button by default and beside it on request', async () => {
    const rect = { left: 100, right: 120, top: 10, bottom: 30 } as DOMRect
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect)

    const below = renderButton()
    await userEvent.click(screen.getByRole('button', { name: 'Options for Session One' }))
    expect(below.onContextMenu.mock.calls[0][0]).toMatchObject({ clientX: 100, clientY: 34 })

    const beside = renderButton({ anchor: 'beside', sessionName: 'Other' })
    await userEvent.click(screen.getByRole('button', { name: 'Options for Other' }))
    expect(beside.onContextMenu.mock.calls[0][0]).toMatchObject({ clientX: 120, clientY: 30 })

    vi.restoreAllMocks()
  })

  it('reports the open menu through aria-expanded', () => {
    renderButton({ menuOpen: true })
    const button = screen.getByRole('button', { name: 'Options for Session One' })
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(button).toHaveAttribute('aria-haspopup', 'menu')
  })
})
