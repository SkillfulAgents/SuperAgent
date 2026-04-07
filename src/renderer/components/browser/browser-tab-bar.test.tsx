// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BrowserTabBar, type BrowserTabInfo } from './browser-tab-bar'

const makeTabs = (count: number): BrowserTabInfo[] =>
  Array.from({ length: count }, (_, i) => ({
    targetId: `target-${i}`,
    index: i,
    url: `https://example.com/${i}`,
    title: `Tab ${i}`,
    active: i === 0,
  }))

describe('BrowserTabBar', () => {
  const defaultProps = {
    tabs: makeTabs(3),
    viewingTargetId: 'target-0',
    autoFollow: true,
    onTabClick: vi.fn(),
    onToggleAutoFollow: vi.fn(),
  }

  it('renders all tabs', () => {
    render(<BrowserTabBar {...defaultProps} />)
    expect(screen.getByText('Tab 0')).toBeInTheDocument()
    expect(screen.getByText('Tab 1')).toBeInTheDocument()
    expect(screen.getByText('Tab 2')).toBeInTheDocument()
  })

  it('falls back to url when title is empty', () => {
    const tabs: BrowserTabInfo[] = [
      { targetId: 't1', index: 0, url: 'https://foo.com', title: '', active: false },
    ]
    render(<BrowserTabBar {...defaultProps} tabs={tabs} />)
    expect(screen.getByText('https://foo.com')).toBeInTheDocument()
  })

  it('falls back to Tab N+1 when both title and url are empty', () => {
    const tabs: BrowserTabInfo[] = [
      { targetId: 't1', index: 2, url: '', title: '', active: false },
    ]
    render(<BrowserTabBar {...defaultProps} tabs={tabs} />)
    expect(screen.getByText('Tab 3')).toBeInTheDocument()
  })

  it('highlights the viewing tab with bg-background class', () => {
    render(<BrowserTabBar {...defaultProps} viewingTargetId="target-1" />)
    const viewingButton = screen.getByText('Tab 1').closest('button')!
    expect(viewingButton.className).toContain('bg-background')

    const otherButton = screen.getByText('Tab 2').closest('button')!
    expect(otherButton.className).not.toContain('bg-background')
  })

  it('shows agent-active indicator (blue dot) on active tab', () => {
    render(<BrowserTabBar {...defaultProps} />)
    // Tab 0 is active — should have a bg-blue-500 dot
    const activeButton = screen.getByText('Tab 0').closest('button')!
    const dot = activeButton.querySelector('.bg-blue-500')
    expect(dot).toBeInTheDocument()

    // Tab 1 is not active — no dot
    const inactiveButton = screen.getByText('Tab 1').closest('button')!
    expect(inactiveButton.querySelector('.bg-blue-500')).toBeNull()
  })

  it('calls onTabClick with correct targetId', async () => {
    const onTabClick = vi.fn()
    const user = userEvent.setup()
    render(<BrowserTabBar {...defaultProps} onTabClick={onTabClick} />)

    await user.click(screen.getByText('Tab 2'))
    expect(onTabClick).toHaveBeenCalledWith('target-2')
  })

  it('shows Eye icon and blue text when autoFollow is true', () => {
    render(<BrowserTabBar {...defaultProps} autoFollow={true} />)
    const toggleButton = screen.getByTitle('Auto-following agent (click to pin)')
    expect(toggleButton.className).toContain('text-blue-500')
  })

  it('shows EyeOff icon when autoFollow is false', () => {
    render(<BrowserTabBar {...defaultProps} autoFollow={false} />)
    const toggleButton = screen.getByTitle('Not following agent (click to follow)')
    expect(toggleButton).toBeInTheDocument()
  })

  it('calls onToggleAutoFollow when toggle button is clicked', async () => {
    const onToggleAutoFollow = vi.fn()
    const user = userEvent.setup()
    render(<BrowserTabBar {...defaultProps} onToggleAutoFollow={onToggleAutoFollow} />)

    await user.click(screen.getByTitle('Auto-following agent (click to pin)'))
    expect(onToggleAutoFollow).toHaveBeenCalledOnce()
  })

  it('shows loading spinner when loading is true', () => {
    const { container } = render(<BrowserTabBar {...defaultProps} loading={true} />)
    const spinner = container.querySelector('.animate-spin')
    expect(spinner).toBeInTheDocument()
  })

  it('does not show loading spinner when loading is false', () => {
    const { container } = render(<BrowserTabBar {...defaultProps} loading={false} />)
    const spinner = container.querySelector('.animate-spin')
    expect(spinner).not.toBeInTheDocument()
  })

  it('right-click on tab shows context menu with Close tab', async () => {
    const user = userEvent.setup()
    render(<BrowserTabBar {...defaultProps} onCloseTab={vi.fn()} />)

    await user.pointer({ keys: '[MouseRight]', target: screen.getByText('Tab 1') })
    expect(await screen.findByText('Close tab')).toBeInTheDocument()
  })

  it('Close tab is disabled on the agent-active tab', async () => {
    const user = userEvent.setup()
    render(<BrowserTabBar {...defaultProps} onCloseTab={vi.fn()} />)

    // Tab 0 is the active tab (active: true)
    await user.pointer({ keys: '[MouseRight]', target: screen.getByText('Tab 0') })
    const menuItem = await screen.findByText('Close tab')
    expect(menuItem.closest('[data-disabled]')).toBeTruthy()
  })

  it('Close tab calls onCloseTab for non-active tab', async () => {
    const onCloseTab = vi.fn()
    const user = userEvent.setup()
    render(<BrowserTabBar {...defaultProps} onCloseTab={onCloseTab} />)

    // Tab 1 is not the active tab
    await user.pointer({ keys: '[MouseRight]', target: screen.getByText('Tab 1') })
    await user.click(await screen.findByText('Close tab'))
    expect(onCloseTab).toHaveBeenCalledWith('target-1')
  })
})
