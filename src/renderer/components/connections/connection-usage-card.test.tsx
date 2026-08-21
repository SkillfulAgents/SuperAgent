// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConnectionUsageCard } from './connection-usage-card'
import type { UnifiedRow } from './unified-rows'

const mockUseConnectionActivityStats = vi.fn()
vi.mock('@renderer/hooks/use-activity-stats', () => ({
  useConnectionActivityStats: () => mockUseConnectionActivityStats(),
}))

const row: UnifiedRow = {
  key: 'account-account-1',
  id: 'account-1',
  name: 'Work GitHub',
  iconFallback: 'oauth',
  type: 'oauth',
  granted: true,
  toolkit: 'github',
}

describe('ConnectionUsageCard', () => {
  beforeAll(() => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
  })

  beforeEach(() => {
    mockUseConnectionActivityStats.mockReturnValue({
      data: {
        days: 14,
        connectionById: {
          [row.key]: [
            { date: '2026-07-07', succeeded: 2, failed: 0 },
            { date: '2026-07-20', succeeded: 3, failed: 1 },
          ],
        },
      },
    })
  })

  it('shows connection-wide usage and opens logs', async () => {
    const onViewLogs = vi.fn()
    render(<ConnectionUsageCard row={row} onViewLogs={onViewLogs} />)

    expect(screen.getByText('6 calls')).toBeInTheDocument()
    expect(screen.getByText('5 succeeded')).toBeInTheDocument()
    expect(screen.getByText('1 failed')).toBeInTheDocument()
    expect(screen.getByRole('img', {
      name: 'Work GitHub activity: 6 calls over 2 days, 5 succeeded and 1 failed.',
    })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'View logs' }))
    expect(onViewLogs).toHaveBeenCalledTimes(1)
  })
})
