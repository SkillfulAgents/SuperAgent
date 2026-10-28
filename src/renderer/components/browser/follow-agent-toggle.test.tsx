// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FollowAgentToggle } from './follow-agent-toggle'

describe('FollowAgentToggle', () => {
  it('is a checked switch while following', () => {
    render(<FollowAgentToggle autoFollow={true} onToggle={vi.fn()} />)
    const toggle = screen.getByRole('switch', { name: 'Auto-following agent (click to pin)' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
  })

  it('is an unchecked switch while pinned to a tab', () => {
    render(<FollowAgentToggle autoFollow={false} onToggle={vi.fn()} />)
    const toggle = screen.getByRole('switch', { name: 'Not following agent (click to follow)' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('toggles from the switch and from its label', async () => {
    const onToggle = vi.fn()
    const user = userEvent.setup()
    render(<FollowAgentToggle autoFollow={true} onToggle={onToggle} />)
    await user.click(screen.getByRole('switch'))
    await user.click(screen.getByText('Follow agent'))
    expect(onToggle).toHaveBeenCalledTimes(2)
  })
})
