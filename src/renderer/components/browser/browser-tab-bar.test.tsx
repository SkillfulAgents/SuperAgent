// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
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

  it('raises the viewing tab as a card (bg-background on the tab shell)', () => {
    render(<BrowserTabBar {...defaultProps} viewingTargetId="target-1" />)
    const viewingTab = screen.getByText('Tab 1').closest('[data-testid="browser-tab"]')!
    expect(viewingTab.className).toContain('bg-background')
    expect(viewingTab).toHaveAttribute('data-active')

    const otherTab = screen.getByText('Tab 2').closest('[data-testid="browser-tab"]')!
    expect(otherTab).not.toHaveAttribute('data-active')
  })

  it('renders the trailing control at the right end of the strip', () => {
    render(<BrowserTabBar {...defaultProps} trailing={<button>hide</button>} />)
    expect(screen.getByText('hide')).toBeInTheDocument()
  })

  it('renders the strip with no tabs so the drawer controls stay reachable', () => {
    render(<BrowserTabBar {...defaultProps} tabs={[]} trailing={<button>hide</button>} />)
    expect(screen.getByTestId('browser-tab-bar')).toBeInTheDocument()
    expect(screen.getByText('hide')).toBeInTheDocument()
    expect(screen.queryByTestId('browser-tab')).toBeNull()
  })

  it('shows a per-tab close on every tab but the agent-active one', async () => {
    const onCloseTab = vi.fn()
    const user = userEvent.setup()
    render(<BrowserTabBar {...defaultProps} onCloseTab={onCloseTab} />)

    expect(screen.queryByLabelText('Close Tab 0')).toBeNull()
    await user.click(screen.getByLabelText('Close Tab 1'))
    expect(onCloseTab).toHaveBeenCalledWith('target-1')
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

  it('shows the favicon when the tab has one and a globe when it does not', () => {
    const tabs: BrowserTabInfo[] = [
      { targetId: 't1', index: 0, url: 'https://github.com', title: 'GitHub', faviconUrl: 'https://github.com/favicon.svg', active: true },
      { targetId: 't2', index: 1, url: 'https://example.com', title: 'Example', active: false },
    ]
    render(<BrowserTabBar {...defaultProps} tabs={tabs} />)
    const icon = screen.getByTestId('browser-tab-favicon')
    expect(icon).toHaveAttribute('src', 'https://github.com/favicon.svg')
    expect(screen.getAllByTestId('browser-tab-globe')).toHaveLength(1)
  })

  it('falls back to the globe when the favicon fails to load', () => {
    const tabs: BrowserTabInfo[] = [
      { targetId: 't1', index: 0, url: 'https://internal.test', title: 'Internal', faviconUrl: 'https://internal.test/favicon.ico', active: true },
    ]
    render(<BrowserTabBar {...defaultProps} tabs={tabs} />)
    fireEvent.error(screen.getByTestId('browser-tab-favicon'))
    expect(screen.queryByTestId('browser-tab-favicon')).toBeNull()
    expect(screen.getByTestId('browser-tab-globe')).toBeInTheDocument()
  })
  it('shows Eye icon and blue text when autoFollow is true', () => {
    render(<BrowserTabBar {...defaultProps} autoFollow={true} />)
    const toggleButton = screen.getByTitle('Auto-following agent (click to pin)')
    expect(toggleButton.className).toContain('text-blue-500')
  })

  it('shows EyeOff icon when autoFollow is false', () => {
    render(<BrowserTabBar {...defaultProps} autoFollow={false} />)
    expect(screen.getByTitle('Not following agent (click to follow)')).toBeInTheDocument()
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
    expect(container.querySelector('.animate-spin')).toBeInTheDocument()
  })

  it('does not show loading spinner when loading is false', () => {
    const { container } = render(<BrowserTabBar {...defaultProps} loading={false} />)
    expect(container.querySelector('.animate-spin')).not.toBeInTheDocument()
  })
})
