// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// Mock Radix Popover (Portal doesn't work in jsdom)
vi.mock('@renderer/components/ui/popover', () => ({
  Popover: ({ children, open, onOpenChange, ...props }: any) => (
    <div data-testid="popover" data-open={open} {...props}>
      {typeof children === 'function' ? children() : children}
      {/* Store onOpenChange so trigger can call it */}
      <input type="hidden" data-onchange={String(open)} ref={(el) => {
        if (el) (el as any).__onOpenChange = onOpenChange
      }} />
    </div>
  ),
  PopoverTrigger: ({ children, asChild, ...props }: any) => {
    if (asChild) return children
    return <div {...props}>{children}</div>
  },
  PopoverContent: ({ children, ...props }: any) => (
    <div data-testid="popover-content" {...props}>{children}</div>
  ),
}))

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  Check: ({ className }: any) => <span data-testid="check-icon" className={className} />,
  ChevronsUpDown: ({ className }: any) => <span data-testid="chevrons-icon" className={className} />,
  Search: ({ className }: any) => <span data-testid="search-icon" className={className} />,
}))

// Mock Button
vi.mock('@renderer/components/ui/button', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}))

// Mock cn
vi.mock('@shared/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

// We need to reset the cached timezones between tests since the module caches them
// Import after mocks
import { TimezonePicker } from './timezone-picker'

describe('TimezonePicker', () => {
  const mockOnValueChange = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows "Select timezone..." when no value is selected', () => {
    render(<TimezonePicker value="" onValueChange={mockOnValueChange} />)
    expect(screen.getByText('Select timezone...')).toBeInTheDocument()
  })

  it('displays the selected timezone with offset', () => {
    render(<TimezonePicker value="America/New_York" onValueChange={mockOnValueChange} />)
    // The label replaces underscores with spaces and shows offset
    const button = screen.getByRole('combobox')
    expect(button.textContent).toContain('America/New York')
  })

  it('shows placeholder when value is not in the IANA list', () => {
    // "UTC" is not in Intl.supportedValuesOf('timeZone'), so it won't match
    render(<TimezonePicker value="UTC" onValueChange={mockOnValueChange} />)
    const button = screen.getByRole('combobox')
    expect(button.textContent).toContain('Select timezone...')
  })

  it('displays Asia/Tokyo when selected', () => {
    render(<TimezonePicker value="Asia/Tokyo" onValueChange={mockOnValueChange} />)
    const button = screen.getByRole('combobox')
    expect(button.textContent).toContain('Asia/Tokyo')
  })

  it('renders timezone options in the dropdown', () => {
    render(<TimezonePicker value="" onValueChange={mockOnValueChange} />)
    // Should render timezone buttons — check for a few well-known ones
    expect(screen.getByText('America/New York')).toBeInTheDocument()
    expect(screen.getByText('Europe/London')).toBeInTheDocument()
    expect(screen.getByText('Asia/Tokyo')).toBeInTheDocument()
  })

  it('renders a search input', () => {
    render(<TimezonePicker value="" onValueChange={mockOnValueChange} />)
    expect(screen.getByPlaceholderText('Search timezone...')).toBeInTheDocument()
  })

  it('filters timezones based on search input', async () => {
    const user = userEvent.setup()
    render(<TimezonePicker value="" onValueChange={mockOnValueChange} />)

    const searchInput = screen.getByPlaceholderText('Search timezone...')
    await user.type(searchInput, 'Tokyo')

    // Should show Asia/Tokyo
    expect(screen.getByText('Asia/Tokyo')).toBeInTheDocument()
    // Should not show unrelated timezones
    expect(screen.queryByText('America/New York')).not.toBeInTheDocument()
    expect(screen.queryByText('Europe/London')).not.toBeInTheDocument()
  })

  it('shows "No timezone found." when search has no results', async () => {
    const user = userEvent.setup()
    render(<TimezonePicker value="" onValueChange={mockOnValueChange} />)

    const searchInput = screen.getByPlaceholderText('Search timezone...')
    await user.type(searchInput, 'xyznonexistent')

    expect(screen.getByText('No timezone found.')).toBeInTheDocument()
  })

  it('calls onValueChange when a timezone is clicked', async () => {
    const user = userEvent.setup()
    render(<TimezonePicker value="" onValueChange={mockOnValueChange} />)

    // Find and click "Asia/Tokyo" option
    const tokyoButton = screen.getByText('Asia/Tokyo').closest('button')!
    await user.click(tokyoButton)

    expect(mockOnValueChange).toHaveBeenCalledWith('Asia/Tokyo')
  })

  it('disables the trigger button when disabled prop is true', () => {
    render(<TimezonePicker value="UTC" onValueChange={mockOnValueChange} disabled />)
    const button = screen.getByRole('combobox')
    expect(button).toBeDisabled()
  })

  it('filters by offset string (e.g. "GMT+9")', async () => {
    const user = userEvent.setup()
    render(<TimezonePicker value="" onValueChange={mockOnValueChange} />)

    const searchInput = screen.getByPlaceholderText('Search timezone...')
    await user.type(searchInput, 'GMT+9')

    // Asia/Tokyo is UTC+9, should be in the results
    expect(screen.getByText('Asia/Tokyo')).toBeInTheDocument()
  })

  it('filters by IANA value with underscore (e.g. "New_York")', async () => {
    const user = userEvent.setup()
    render(<TimezonePicker value="" onValueChange={mockOnValueChange} />)

    const searchInput = screen.getByPlaceholderText('Search timezone...')
    await user.type(searchInput, 'New_York')

    expect(screen.getByText('America/New York')).toBeInTheDocument()
  })

  it('search is case insensitive', async () => {
    const user = userEvent.setup()
    render(<TimezonePicker value="" onValueChange={mockOnValueChange} />)

    const searchInput = screen.getByPlaceholderText('Search timezone...')
    await user.type(searchInput, 'tokyo')

    expect(screen.getByText('Asia/Tokyo')).toBeInTheDocument()
  })
})
