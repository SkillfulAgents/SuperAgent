// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { SessionTimeFlag, formatSessionTimeLabel } from './session-time-flag'

vi.mock('@renderer/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}))

describe('SessionTimeFlag', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 17, 14, 0, 0))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    [new Date(2026, 7, 17, 13, 50, 0), 'Today at 1:50 PM'],
    [new Date(2026, 7, 16, 9, 5, 0), 'Yesterday at 9:05 AM'],
    [new Date(2026, 7, 14, 12, 0, 0), '3 days ago'],
    [new Date(2026, 7, 3, 12, 0, 0), '2 weeks ago'],
  ] as const)('formats %s as %s', (date, expected) => {
    expect(formatSessionTimeLabel(date)).toBe(expected)
  })

  it('shows the exact local timestamp in its tooltip', () => {
    const date = new Date(2026, 7, 17, 13, 50, 30)

    render(<SessionTimeFlag date={date} />)

    expect(screen.getByTestId('session-time-flag')).toHaveTextContent('Today at 1:50 PM')
    expect(screen.getByText('Aug 17, 2026, 1:50:30 PM')).toBeInTheDocument()
  })
})
