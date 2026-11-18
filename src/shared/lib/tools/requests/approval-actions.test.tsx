// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, screen } from '@testing-library/react'
import { renderWithProviders as render } from '@renderer/test/test-utils'
import userEvent from '@testing-library/user-event'
import { ApprovalActions } from './approval-actions'

describe('ApprovalActions', () => {
  it('shows only Deny and Allow when nothing can be remembered', () => {
    render(<ApprovalActions testIdPrefix="t" onDeny={vi.fn()} onAllow={vi.fn()} allowLabel="Allow" />)
    expect(screen.getByTestId('t-deny-btn')).toBeInTheDocument()
    expect(screen.getByTestId('t-allow-once-btn')).toHaveTextContent('Allow')
    expect(screen.getByTestId('t-allow-once-btn')).toHaveClass('bg-orange-600')
    expect(screen.queryByTestId('t-always-allow-btn')).not.toBeInTheDocument()
  })

  it('runs a single expanded grant and explains it on focus', async () => {
    const onSelect = vi.fn()
    render(
      <ApprovalActions
        testIdPrefix="t"
        onDeny={vi.fn()}
        onAllow={vi.fn()}
        allowLabel="Allow 15 min"
        expanded={{ label: 'Always Allow', hint: 'Every time, without asking', onSelect }}
      />,
    )
    expect(screen.getByTestId('t-allow-once-btn')).not.toHaveClass('bg-orange-600')
    expect(screen.queryByRole('tooltip')).toBeNull()
    act(() => screen.getByTestId('t-always-allow-btn').focus())
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Every time, without asking')
    await userEvent.setup().keyboard('{Enter}')
    expect(onSelect).toHaveBeenCalledOnce()
  })

  it('runs the picked option from an expanded menu and sends a typed deny reason', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    const onDeny = vi.fn()
    render(
      <ApprovalActions
        testIdPrefix="t"
        onDeny={onDeny}
        onAllow={vi.fn()}
        expanded={{ label: 'Always Allow', options: [{ label: 'This account', hint: 'This account, always', onSelect, testId: 't-account' }] }}
      />,
    )
    await user.click(screen.getByTestId('t-always-allow-btn'))
    act(() => screen.getByTestId('t-account').focus())
    expect(await screen.findByRole('tooltip')).toHaveTextContent('This account, always')
    await user.click(screen.getByTestId('t-account'))
    expect(onSelect).toHaveBeenCalledOnce()

    await user.click(screen.getByTestId('t-deny-btn-chevron'))
    await user.type(await screen.findByTestId('t-deny-btn-reason-input'), 'not now{Enter}')
    expect(onDeny).toHaveBeenCalledWith('not now')
  })
})
