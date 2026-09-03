// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FileTabBar } from './file-tab-bar'
import type { PreviewTab } from '@renderer/context/file-preview-context'

const tabs: PreviewTab[] = [
  {
    kind: 'folder',
    rootPath: '/workspace/reports',
    agentSlug: 'test-agent',
    displayName: 'reports',
    expandedPaths: ['/workspace/reports'],
    query: '',
  },
  {
    kind: 'file',
    filePath: '/workspace/reports/summary.md',
    agentSlug: 'test-agent',
    displayName: 'summary.md',
    version: 0,
    pdfPage: 1,
  },
]

/**
 * jsdom has no layout, so give the tab group a fake geometry: `visible` px
 * wide, holding `content` px of tabs. Every tab reports `tabWidth` px.
 */
function fakeLayout({ visible, content, tabWidth }: { visible: number; content: number; tabWidth: number }) {
  const spies = [
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'file-tab-group' ? visible : 0
    }),
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'file-tab-group' ? content : 0
    }),
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'file-tab' ? tabWidth : 0
    }),
    vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid !== 'file-tab') return 0
      const siblings = Array.from(this.parentElement?.children ?? [])
      return siblings.indexOf(this) * (tabWidth + 1)
    }),
  ]
  return () => spies.forEach((s) => s.mockRestore())
}

function trackTransform() {
  return (screen.getByTestId('file-tab-group').firstElementChild as HTMLElement).style.transform
}

describe('FileTabBar', () => {
  afterEach(() => vi.restoreAllMocks())

  it('renders folder and file tabs, marks the active one, and selects by index', async () => {
    const user = userEvent.setup()
    const onTabClick = vi.fn()
    render(<FileTabBar tabs={tabs} activeIndex={0} onTabClick={onTabClick} onCloseTab={vi.fn()} />)

    const rendered = screen.getAllByTestId('file-tab')
    expect(rendered).toHaveLength(2)
    expect(rendered[0]).toHaveAttribute('data-tab-kind', 'folder')
    expect(rendered[0]).toHaveAttribute('data-active', 'true')
    expect(rendered[1]).not.toHaveAttribute('data-active')

    await user.click(rendered[1])
    expect(onTabClick).toHaveBeenCalledWith(1)
  })

  it('closes by discriminated key without selecting the tab', async () => {
    const user = userEvent.setup()
    const onTabClick = vi.fn()
    const onCloseTab = vi.fn()
    render(<FileTabBar tabs={tabs} activeIndex={1} onTabClick={onTabClick} onCloseTab={onCloseTab} />)

    await user.click(screen.getAllByTestId('file-tab-close')[0])
    expect(onCloseTab).toHaveBeenCalledWith('folder:/workspace/reports')
    expect(onTabClick).not.toHaveBeenCalled()
  })

  it('hides the arrows while every tab fits', () => {
    fakeLayout({ visible: 400, content: 300, tabWidth: 150 })
    render(<FileTabBar tabs={tabs} activeIndex={0} onTabClick={vi.fn()} onCloseTab={vi.fn()} />)
    expect(screen.queryByTestId('file-tab-arrows')).toBeNull()
    expect(screen.getByTestId('file-tab-bar')).not.toHaveAttribute('data-overflowing')
  })

  it('shows arrows on overflow, slides one tab per click, and disables at each end', () => {
    // two 100px tabs in a 120px group: 81px of overflow (100 + 1 gap + 100 - 120)
    fakeLayout({ visible: 120, content: 201, tabWidth: 100 })
    render(<FileTabBar tabs={tabs} activeIndex={0} onTabClick={vi.fn()} onCloseTab={vi.fn()} />)

    const earlier = screen.getByRole('button', { name: 'Earlier tabs' })
    const later = screen.getByRole('button', { name: 'Later tabs' })
    expect(screen.getByTestId('file-tab-bar')).toHaveAttribute('data-overflowing', 'true')
    expect(earlier).toBeDisabled()
    expect(later).toBeEnabled()
    expect(trackTransform()).toBe('translateX(-0px)')

    fireEvent.click(later)
    // one step is a tab width plus the gap, clamped to the overflow
    expect(trackTransform()).toBe('translateX(-81px)')
    expect(later).toBeDisabled()
    expect(earlier).toBeEnabled()

    fireEvent.click(earlier)
    expect(trackTransform()).toBe('translateX(-0px)')
    expect(earlier).toBeDisabled()
  })

  it('slides the active tab into view when it is selected off-screen', () => {
    fakeLayout({ visible: 120, content: 201, tabWidth: 100 })
    const { rerender } = render(<FileTabBar tabs={tabs} activeIndex={0} onTabClick={vi.fn()} onCloseTab={vi.fn()} />)
    expect(trackTransform()).toBe('translateX(-0px)')

    rerender(<FileTabBar tabs={tabs} activeIndex={1} onTabClick={vi.fn()} onCloseTab={vi.fn()} />)
    // second tab spans 101..201; revealing it in a 120px window means sliding to 81
    expect(trackTransform()).toBe('translateX(-81px)')
  })
})
