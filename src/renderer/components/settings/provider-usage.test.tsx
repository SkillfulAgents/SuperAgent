// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { UsageBars } from './provider-usage'
import { usageSnapshot } from '@shared/lib/llm-provider/usage-schema'

describe('provider allowance display', () => {
  for (const compact of [true, false]) {
    it(`shows all windows in the effort-slider blue and real zero balances (compact=${compact})`, () => {
      render(<UsageBars compact={compact} usage={usageSnapshot([
        ...[0, 80, 81, 95, 96, 110].map(usedPercent => ({ kind: 'window' as const, id: String(usedPercent), label: `Window ${usedPercent}`, usedPercent })),
        { kind: 'balance', id: 'credits', label: 'Prepaid credits', remaining: 0, unit: 'USD' },
      ])} />)
      expect(screen.getAllByRole('progressbar')).toHaveLength(6)
      for (const percent of [0, 80, 81, 95, 96, 110]) {
        expect(screen.getByRole('progressbar', { name: `Window ${percent} usage` }).firstChild).toHaveClass('bg-[#0099FF]')
      }
      expect(screen.getByRole('progressbar', { name: 'Window 110 usage' })).toHaveAttribute('aria-valuenow', '100')
      expect(screen.getByText('$0.00')).toBeVisible()
    })
  }
  it('hides unsupported and failed usage completely', () => {
    const { container, rerender } = render(<UsageBars />)
    expect(container).toBeEmptyDOMElement()
    for (const status of ['unsupported', 'unavailable'] as const) {
      rerender(<UsageBars usage={{ status, limits: [], observedAt: '' }} />)
      expect(container).toBeEmptyDOMElement()
    }
  })
})
