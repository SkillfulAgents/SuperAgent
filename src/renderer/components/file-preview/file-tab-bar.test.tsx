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

const scrollPositions = new WeakMap<HTMLElement, number>()

/**
 * jsdom has no layout and no scrolling: give the tab group a fake geometry —
 * `visible` px wide holding `content` px of tabs, each `tabWidth` px — and a
 * `scrollLeft` that actually moves, so what the tests exercise is the
 * component's own arithmetic rather than a no-op.
 */
function fakeLayout({ visible, content, tabWidth }: { visible: number; content: number; tabWidth: number }) {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === 'file-tab-group' ? visible : 0
  })
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === 'file-tab-group' ? content : 0
  })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === 'file-tab' ? tabWidth : 0
  })
  vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testid !== 'file-tab') return 0
    const siblings = Array.from(this.parentElement?.children ?? [])
    return siblings.indexOf(this) * (tabWidth + 1)
  })
  vi.spyOn(HTMLElement.prototype, 'scrollLeft', 'get').mockImplementation(function (this: HTMLElement) {
    return scrollPositions.get(this) ?? 0
  })

  const max = Math.max(0, content - visible)
  function scrollTo(this: HTMLElement, options: ScrollToOptions) {
    scrollPositions.set(this, Math.min(Math.max(options.left ?? 0, 0), max))
    this.dispatchEvent(new Event('scroll'))
  }
  HTMLElement.prototype.scrollTo = scrollTo as HTMLElement['scrollTo']
  HTMLElement.prototype.scrollBy = function (this: HTMLElement, options: ScrollToOptions) {
    scrollTo.call(this, { left: (scrollPositions.get(this) ?? 0) + (options.left ?? 0) })
  } as HTMLElement['scrollBy']
}

function scrollLeft() {
  return screen.getByTestId('file-tab-group').scrollLeft
}

describe('FileTabBar', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    // Drop the shadowing assignments so the prototype's own methods return.
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollBy
  })

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

  // Every other tab collapses to icon + close; the one the user is reading keeps
  // room for its name.
  it('holds a wider floor for the active tab than for the rest', () => {
    render(<FileTabBar tabs={tabs} activeIndex={1} onTabClick={vi.fn()} onCloseTab={vi.fn()} />)
    const [inactive, active] = screen.getAllByTestId('file-tab')
    expect(active.className).toContain('min-w-[9.5rem]')
    expect(inactive.className).toContain('min-w-[4.25rem]')
  })

  it('hides the arrows while every tab fits', () => {
    fakeLayout({ visible: 400, content: 300, tabWidth: 150 })
    render(<FileTabBar tabs={tabs} activeIndex={0} onTabClick={vi.fn()} onCloseTab={vi.fn()} />)
    expect(screen.queryByTestId('file-tab-arrows')).toBeNull()
    expect(screen.getByTestId('file-tab-bar')).not.toHaveAttribute('data-overflowing')
  })

  it('shows arrows on overflow, scrolls one tab per click, and disables at each end', () => {
    // two 100px tabs in a 120px group: 81px of overflow (100 + 1 gap + 100 - 120)
    fakeLayout({ visible: 120, content: 201, tabWidth: 100 })
    render(<FileTabBar tabs={tabs} activeIndex={0} onTabClick={vi.fn()} onCloseTab={vi.fn()} />)

    const earlier = screen.getByRole('button', { name: 'Earlier tabs' })
    const later = screen.getByRole('button', { name: 'Later tabs' })
    expect(screen.getByTestId('file-tab-bar')).toHaveAttribute('data-overflowing', 'true')
    expect(earlier).toBeDisabled()
    expect(later).toBeEnabled()
    expect(scrollLeft()).toBe(0)

    fireEvent.click(later)
    // one step is a tab width plus the gap, clamped to the overflow
    expect(scrollLeft()).toBe(81)
    expect(later).toBeDisabled()
    expect(earlier).toBeEnabled()

    fireEvent.click(earlier)
    expect(scrollLeft()).toBe(0)
    expect(earlier).toBeDisabled()
  })

  it('scrolls the active tab into view when it is selected off-screen', () => {
    fakeLayout({ visible: 120, content: 201, tabWidth: 100 })
    const { rerender } = render(<FileTabBar tabs={tabs} activeIndex={0} onTabClick={vi.fn()} onCloseTab={vi.fn()} />)
    expect(scrollLeft()).toBe(0)

    rerender(<FileTabBar tabs={tabs} activeIndex={1} onTabClick={vi.fn()} onCloseTab={vi.fn()} />)
    // second tab spans 101..201; revealing it in a 120px window means scrolling to 81
    expect(scrollLeft()).toBe(81)
  })

  // A clipped tab is still in the tab order, so tabbing to one must bring it
  // into the strip rather than move focus somewhere invisible.
  it('scrolls a tab into view when it takes focus without being selected', () => {
    fakeLayout({ visible: 120, content: 201, tabWidth: 100 })
    render(<FileTabBar tabs={tabs} activeIndex={0} onTabClick={vi.fn()} onCloseTab={vi.fn()} />)
    expect(scrollLeft()).toBe(0)

    fireEvent.focus(screen.getAllByTestId('file-tab')[1])
    expect(scrollLeft()).toBe(81)
  })

  describe('leading-tab flush', () => {
    it('reports flush while the first tab is active and the strip is unscrolled', () => {
      fakeLayout({ visible: 400, content: 300, tabWidth: 150 })
      const onLeadingTabFlush = vi.fn()
      render(
        <FileTabBar
          tabs={tabs}
          activeIndex={0}
          onTabClick={vi.fn()}
          onCloseTab={vi.fn()}
          onLeadingTabFlush={onLeadingTabFlush}
        />,
      )
      expect(onLeadingTabFlush).toHaveBeenLastCalledWith(true)
    })

    it('reports not flush when a later tab is active', () => {
      fakeLayout({ visible: 400, content: 300, tabWidth: 150 })
      const onLeadingTabFlush = vi.fn()
      render(
        <FileTabBar
          tabs={tabs}
          activeIndex={1}
          onTabClick={vi.fn()}
          onCloseTab={vi.fn()}
          onLeadingTabFlush={onLeadingTabFlush}
        />,
      )
      expect(onLeadingTabFlush).toHaveBeenLastCalledWith(false)
    })

    it('reports not flush once the strip is scrolled off its first tab', () => {
      fakeLayout({ visible: 120, content: 201, tabWidth: 100 })
      const onLeadingTabFlush = vi.fn()
      render(
        <FileTabBar
          tabs={tabs}
          activeIndex={0}
          onTabClick={vi.fn()}
          onCloseTab={vi.fn()}
          onLeadingTabFlush={onLeadingTabFlush}
        />,
      )
      expect(onLeadingTabFlush).toHaveBeenLastCalledWith(true)

      fireEvent.click(screen.getByRole('button', { name: 'Later tabs' }))
      expect(onLeadingTabFlush).toHaveBeenLastCalledWith(false)
    })
  })
})
