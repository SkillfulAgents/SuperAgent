// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '@renderer/test/test-utils'
import { OptionRow } from './option-row'

describe('OptionRow', () => {
  it('keeps the blurb collapsed at rest by default (revealed only on hover)', () => {
    renderWithProviders(
      <OptionRow label="Plain row" blurb="Default blurb" onClick={vi.fn()} testId="row" />,
    )
    const blurb = screen.getByText('Default blurb')
    expect(blurb.className).toContain('max-h-0')
    expect(blurb.className).toContain('opacity-0')
    expect(blurb.className).toContain('group-hover:max-h-16')
  })

  it('alwaysShowBlurb expands the blurb at rest without the selected tint or check', () => {
    renderWithProviders(
      <OptionRow
        label="Forward row"
        blurb="Always blurb"
        onClick={vi.fn()}
        testId="row"
        alwaysShowBlurb
        trailing={<span data-testid="chevron" />}
      />,
    )
    const blurb = screen.getByText('Always blurb')
    expect(blurb.className).toContain('max-h-16')
    expect(blurb.className).toContain('opacity-100')
    expect(blurb.className).not.toContain('max-h-0')
    // Not selected: the row is untinted (only the base hover:bg-accent, not the
    // standalone selected tint) and the trailing affordance shows (no check).
    expect(screen.getByTestId('row').className).not.toMatch(/(^|\s)bg-accent(\s|$)/)
    expect(screen.getByTestId('chevron')).toBeInTheDocument()
  })

  it('isSelected expands the blurb, tints the row, and shows the check instead of trailing', () => {
    renderWithProviders(
      <OptionRow
        label="Selected row"
        blurb="Selected blurb"
        onClick={vi.fn()}
        testId="row"
        isSelected
        trailing={<span data-testid="chevron" />}
      />,
    )
    const blurb = screen.getByText('Selected blurb')
    expect(blurb.className).toContain('max-h-16')
    expect(screen.getByTestId('row').className).toMatch(/(^|\s)bg-accent(\s|$)/)
    expect(screen.queryByTestId('chevron')).not.toBeInTheDocument()
  })
})
