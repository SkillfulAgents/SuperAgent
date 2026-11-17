// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { HomeSidePanel, SIDE_PANEL_BESIDE_PAGE } from './home-side-panel'

const originalMatchMedia = window.matchMedia

function mockWidth(beside: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: beside && query === SIDE_PANEL_BESIDE_PAGE,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia
}

describe('HomeSidePanel', () => {
  afterEach(() => {
    window.matchMedia = originalMatchMedia
  })

  it.each([
    ['beside the page, from the right', true, 'intro-step-side'],
    ['below the page, up from the bottom', false, 'intro-step-4'],
  ])('joins the new-agent intro %s', (_where, beside, step) => {
    mockWidth(beside)
    render(<HomeSidePanel><div /></HomeSidePanel>)
    expect(screen.getByTestId('agent-home-side-panel')).toHaveClass('intro-step', step)
  })
})
