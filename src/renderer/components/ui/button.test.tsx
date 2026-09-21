// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Button } from './button'

describe('Button', () => {
  it('draws the spinner in the icon slot while loading, and beside the label without one', () => {
    const { rerender } = render(<Button icon={<svg data-testid="icon" />}>Go</Button>)
    expect(screen.getByTestId('icon')).toBeInTheDocument()
    expect(screen.getByRole('button').querySelector('.animate-spin')).toBeNull()

    rerender(<Button icon={<svg data-testid="icon" />} loading>Go</Button>)
    expect(screen.queryByTestId('icon')).toBeNull()
    expect(screen.getByRole('button').querySelectorAll('svg')).toHaveLength(1)

    rerender(<Button loading><svg data-testid="child-icon" />Go</Button>)
    expect(screen.getByTestId('child-icon')).toBeInTheDocument()
    expect(screen.getByRole('button').querySelectorAll('svg')).toHaveLength(2)
  })

  it('stays disabled while loading even when the caller passes disabled={false}', () => {
    render(<Button loading disabled={false}>Go</Button>)
    expect(screen.getByRole('button')).toBeDisabled()
  })
})
