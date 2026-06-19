// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders, userEvent } from '@renderer/test/test-utils'
import { CarriedSummaryCard } from './carried-summary-card'

describe('CarriedSummaryCard', () => {
  it('renders collapsed by default (body hidden) and has no dismiss control', () => {
    renderWithProviders(<CarriedSummaryCard summary={'## Goal\nFix login'} />)
    expect(screen.getByTestId('carried-summary-card')).toBeInTheDocument()
    expect(screen.queryByTestId('carried-summary-body')).not.toBeInTheDocument()
    expect(screen.queryByTestId('carried-summary-dismiss')).not.toBeInTheDocument()
  })

  it('expands to show the summary markdown on click', async () => {
    const user = userEvent.setup()
    renderWithProviders(<CarriedSummaryCard summary={'## Goal\nFix login'} />)
    await user.click(screen.getByTestId('carried-summary-toggle'))
    expect(screen.getByTestId('carried-summary-body')).toHaveTextContent('Fix login')
  })
})
