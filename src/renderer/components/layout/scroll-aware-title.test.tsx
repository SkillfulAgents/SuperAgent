// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ScrollAwareNavTitle,
  ScrollAwarePageTitle,
  ScrollAwareTitleProvider,
} from './scroll-aware-title'

interface ObserverRecord {
  callback: IntersectionObserverCallback
  disconnect: ReturnType<typeof vi.fn>
  observe: ReturnType<typeof vi.fn>
}

let observers: ObserverRecord[]

describe('scroll-aware title coordination', () => {
  beforeEach(() => {
    observers = []
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        callback: IntersectionObserverCallback
        disconnect = vi.fn()
        observe = vi.fn()

        constructor(callback: IntersectionObserverCallback) {
          this.callback = callback
          observers.push(this)
        }

        unobserve() {}
        takeRecords() { return [] }
        root = null
        rootMargin = '0px'
        thresholds = [0]
      },
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reveals the nav title only after the page title leaves view, then reverses', () => {
    render(
      <ScrollAwareTitleProvider>
        <ScrollAwareNavTitle data-testid="nav-title">Notifications</ScrollAwareNavTitle>
        <ScrollAwarePageTitle data-testid="page-title">
          <h1>Notifications</h1>
        </ScrollAwarePageTitle>
      </ScrollAwareTitleProvider>,
    )

    const navTitle = screen.getByTestId('nav-title')
    const pageTitle = screen.getByTestId('page-title')
    expect(navTitle).toHaveAttribute('data-scroll-aware-nav-title', 'hidden')
    expect(observers).toHaveLength(1)
    expect(observers[0].observe).toHaveBeenCalledWith(pageTitle)

    act(() => {
      observers[0].callback(
        [{ target: pageTitle, isIntersecting: false } as unknown as IntersectionObserverEntry],
        {} as IntersectionObserver,
      )
    })
    expect(navTitle).toHaveAttribute('data-scroll-aware-nav-title', 'visible')

    act(() => {
      observers[0].callback(
        [{ target: pageTitle, isIntersecting: true } as unknown as IntersectionObserverEntry],
        {} as IntersectionObserver,
      )
    })
    expect(navTitle).toHaveAttribute('data-scroll-aware-nav-title', 'hidden')
  })

  it('keeps the nav title visible when a route has no tracked page title', () => {
    const { rerender } = render(
      <ScrollAwareTitleProvider>
        <ScrollAwareNavTitle data-testid="nav-title">Agent name</ScrollAwareNavTitle>
        <ScrollAwarePageTitle data-testid="page-title">Agent name</ScrollAwarePageTitle>
      </ScrollAwareTitleProvider>,
    )

    expect(screen.getByTestId('nav-title')).toHaveAttribute(
      'data-scroll-aware-nav-title',
      'hidden',
    )

    rerender(
      <ScrollAwareTitleProvider>
        <ScrollAwareNavTitle data-testid="nav-title">Agent name</ScrollAwareNavTitle>
      </ScrollAwareTitleProvider>,
    )

    expect(screen.getByTestId('nav-title')).toHaveAttribute(
      'data-scroll-aware-nav-title',
      'visible',
    )
    expect(observers[0].disconnect).toHaveBeenCalled()
  })
})
