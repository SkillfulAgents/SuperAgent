// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Settings, Bell, Users } from 'lucide-react'
import { renderWithProviders, screen, within, userEvent } from '@renderer/test/test-utils'
import { SettingsDialog, SettingsDialogTab, SettingsDialogGroup } from './settings-dialog'

// --- Mocks ---

let mockIsMobile = false

vi.mock('@renderer/hooks/use-mobile', () => ({
  useIsMobile: () => mockIsMobile,
}))

vi.mock('@renderer/components/ui/dialog', () => ({
  Dialog: ({ children, open }: any) => open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  DialogTitle: ({ children, className }: any) => <h2 className={className}>{children}</h2>,
  DialogDescription: ({ children, className }: any) => <p className={className}>{children}</p>,
}))

vi.mock('@renderer/components/ui/sidebar', () => ({
  SidebarProvider: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  Sidebar: ({ children, className }: any) => <nav className={className}>{children}</nav>,
  SidebarContent: ({ children }: any) => <div>{children}</div>,
  SidebarGroup: ({ children }: any) => <div>{children}</div>,
  SidebarGroupContent: ({ children }: any) => <div>{children}</div>,
  SidebarGroupLabel: ({ children }: any) => <span data-testid="group-label">{children}</span>,
  SidebarMenu: ({ children }: any) => <ul>{children}</ul>,
  SidebarMenuItem: ({ children }: any) => <li>{children}</li>,
  SidebarMenuButton: ({ children, onClick, isActive: _, ...props }: any) => (
    <button onClick={onClick} {...props}>{children}</button>
  ),
}))

// --- Helpers ---

const defaultProps = {
  open: true,
  onOpenChange: vi.fn(),
  title: 'Settings',
  description: 'Test settings dialog',
}

function renderSimpleDialog(props: Record<string, any> = {}) {
  return renderWithProviders(
    <SettingsDialog {...defaultProps} {...props}>
      <SettingsDialogTab id="general" label="General" icon={<Settings className="h-4 w-4" />}>
        <div data-testid="general-content">General content</div>
      </SettingsDialogTab>
      <SettingsDialogTab id="notifications" label="Notifications" icon={<Bell className="h-4 w-4" />}>
        <div data-testid="notifications-content">Notifications content</div>
      </SettingsDialogTab>
    </SettingsDialog>
  )
}

// --- Tests ---

beforeEach(() => {
  mockIsMobile = false
  defaultProps.onOpenChange = vi.fn()
})

describe('SettingsDialog', () => {
  describe('desktop', () => {
    it('renders the first tab content by default', () => {
      renderSimpleDialog()
      expect(screen.getByTestId('general-content')).toBeInTheDocument()
      expect(screen.queryByTestId('notifications-content')).not.toBeInTheDocument()
    })

    it('renders sidebar nav items', () => {
      renderSimpleDialog()
      expect(screen.getByTestId('settings-nav-general')).toBeInTheDocument()
      expect(screen.getByTestId('settings-nav-notifications')).toBeInTheDocument()
    })

    it('switches tab on sidebar click', async () => {
      const user = userEvent.setup()
      renderSimpleDialog()

      await user.click(screen.getByTestId('settings-nav-notifications'))

      expect(screen.queryByTestId('general-content')).not.toBeInTheDocument()
      expect(screen.getByTestId('notifications-content')).toBeInTheDocument()
    })

    it('shows breadcrumb with active tab label', () => {
      renderSimpleDialog()
      const header = screen.getByRole('banner')
      expect(within(header).getByText('General')).toBeInTheDocument()
      expect(within(header).getByText('/')).toBeInTheDocument()
    })

    it('renders breadcrumb title as plain text (not a button)', () => {
      renderSimpleDialog()
      const header = screen.getByRole('banner')
      const breadcrumbTitle = within(header).getByText('Settings')
      expect(breadcrumbTitle.tagName).toBe('SPAN')
    })

    it('does not render when open is false', () => {
      renderSimpleDialog({ open: false })
      expect(screen.queryByTestId('general-content')).not.toBeInTheDocument()
    })
  })

  describe('mobile', () => {
    beforeEach(() => {
      mockIsMobile = true
    })

    // Helper: the sidebar is still in the DOM (jsdom doesn't apply CSS `hidden`),
    // so nav testids are duplicated. Query within <main> to target the mobile nav.
    function getMobileMain() {
      return screen.getByRole('main')
    }

    it('shows nav list initially instead of tab content', () => {
      renderSimpleDialog()
      const main = getMobileMain()
      // Mobile nav items visible
      expect(within(main).getByText('General')).toBeInTheDocument()
      expect(within(main).getByText('Notifications')).toBeInTheDocument()
      // Tab content not visible
      expect(screen.queryByTestId('general-content')).not.toBeInTheDocument()
      expect(screen.queryByTestId('notifications-content')).not.toBeInTheDocument()
    })

    it('shows tab content after tapping a nav item', async () => {
      const user = userEvent.setup()
      renderSimpleDialog()

      const main = getMobileMain()
      await user.click(within(main).getByTestId('settings-nav-general'))

      expect(screen.getByTestId('general-content')).toBeInTheDocument()
    })

    it('goes back to nav list when tapping breadcrumb title', async () => {
      const user = userEvent.setup()
      renderSimpleDialog()

      const main = getMobileMain()
      // Navigate to a tab
      await user.click(within(main).getByTestId('settings-nav-general'))
      expect(screen.getByTestId('general-content')).toBeInTheDocument()

      // Tap the breadcrumb title to go back
      await user.click(screen.getByRole('button', { name: 'Settings' }))

      // Back to nav list
      expect(screen.queryByTestId('general-content')).not.toBeInTheDocument()
      expect(within(getMobileMain()).getByTestId('settings-nav-general')).toBeInTheDocument()
      expect(within(getMobileMain()).getByTestId('settings-nav-notifications')).toBeInTheDocument()
    })

    it('renders breadcrumb title as a button', async () => {
      const user = userEvent.setup()
      renderSimpleDialog()

      const main = getMobileMain()
      await user.click(within(main).getByTestId('settings-nav-general'))

      const breadcrumbTitle = screen.getByRole('button', { name: 'Settings' })
      expect(breadcrumbTitle.tagName).toBe('BUTTON')
    })
  })

  describe('initialTab', () => {
    it('opens to the specified tab', () => {
      renderSimpleDialog({ initialTab: 'notifications' })
      expect(screen.getByTestId('notifications-content')).toBeInTheDocument()
      expect(screen.queryByTestId('general-content')).not.toBeInTheDocument()
    })

    it('falls back to first tab if initialTab is invalid', () => {
      renderSimpleDialog({ initialTab: 'nonexistent' })
      expect(screen.getByTestId('general-content')).toBeInTheDocument()
    })

    it('skips mobile nav list when initialTab is set', () => {
      mockIsMobile = true
      renderSimpleDialog({ initialTab: 'notifications' })
      // Should show tab content directly, not the nav list
      expect(screen.getByTestId('notifications-content')).toBeInTheDocument()
    })
  })

  describe('groups', () => {
    function renderGroupedDialog() {
      return renderWithProviders(
        <SettingsDialog {...defaultProps}>
          <SettingsDialogGroup label="User Settings">
            <SettingsDialogTab id="general" label="General" icon={<Settings className="h-4 w-4" />}>
              <div data-testid="general-content">General content</div>
            </SettingsDialogTab>
          </SettingsDialogGroup>
          <SettingsDialogGroup label="Admin Settings">
            <SettingsDialogTab id="users" label="Users" icon={<Users className="h-4 w-4" />}>
              <div data-testid="users-content">Users content</div>
            </SettingsDialogTab>
          </SettingsDialogGroup>
        </SettingsDialog>
      )
    }

    it('renders group labels in the sidebar', () => {
      renderGroupedDialog()
      const labels = screen.getAllByTestId('group-label')
      expect(labels).toHaveLength(2)
      expect(labels[0]).toHaveTextContent('User Settings')
      expect(labels[1]).toHaveTextContent('Admin Settings')
    })

    it('renders group labels in mobile nav', () => {
      mockIsMobile = true
      renderGroupedDialog()
      const main = screen.getByRole('main')
      expect(within(main).getByText('User Settings')).toBeInTheDocument()
      expect(within(main).getByText('Admin Settings')).toBeInTheDocument()
    })

    it('can navigate between tabs in different groups', async () => {
      const user = userEvent.setup()
      renderGroupedDialog()

      // First tab (from first group) is active by default
      expect(screen.getByTestId('general-content')).toBeInTheDocument()

      // Click tab from second group
      await user.click(screen.getByTestId('settings-nav-users'))
      expect(screen.getByTestId('users-content')).toBeInTheDocument()
      expect(screen.queryByTestId('general-content')).not.toBeInTheDocument()
    })
  })

  describe('fragments and conditional tabs', () => {
    it('handles tabs wrapped in fragments', () => {
      renderWithProviders(
        <SettingsDialog {...defaultProps}>
          <SettingsDialogTab id="general" label="General" icon={<Settings className="h-4 w-4" />}>
            <div data-testid="general-content">General content</div>
          </SettingsDialogTab>
          <>
            <SettingsDialogTab id="users" label="Users" icon={<Users className="h-4 w-4" />}>
              <div data-testid="users-content">Users content</div>
            </SettingsDialogTab>
          </>
        </SettingsDialog>
      )

      expect(screen.getByTestId('settings-nav-general')).toBeInTheDocument()
      expect(screen.getByTestId('settings-nav-users')).toBeInTheDocument()
    })

    it('handles groups with fragment-wrapped tabs', () => {
      const extraTabs = (
        <>
          <SettingsDialogTab id="users" label="Users" icon={<Users className="h-4 w-4" />}>
            <div data-testid="users-content">Users content</div>
          </SettingsDialogTab>
        </>
      )

      renderWithProviders(
        <SettingsDialog {...defaultProps}>
          <SettingsDialogGroup label="Admin">
            <SettingsDialogTab id="general" label="General" icon={<Settings className="h-4 w-4" />}>
              <div data-testid="general-content">General content</div>
            </SettingsDialogTab>
            {extraTabs}
          </SettingsDialogGroup>
        </SettingsDialog>
      )

      expect(screen.getByTestId('settings-nav-general')).toBeInTheDocument()
      expect(screen.getByTestId('settings-nav-users')).toBeInTheDocument()
    })
  })

  describe('footer', () => {
    it('renders the active tab footer', () => {
      renderWithProviders(
        <SettingsDialog {...defaultProps}>
          <SettingsDialogTab id="general" label="General" icon={<Settings className="h-4 w-4" />} footer={<div data-testid="save-footer">Save</div>}>
            <div>General content</div>
          </SettingsDialogTab>
          <SettingsDialogTab id="notifications" label="Notifications" icon={<Bell className="h-4 w-4" />}>
            <div>Notifications content</div>
          </SettingsDialogTab>
        </SettingsDialog>
      )

      expect(screen.getByTestId('save-footer')).toBeInTheDocument()
    })

    it('does not render footer for tabs without one', async () => {
      const user = userEvent.setup()
      renderWithProviders(
        <SettingsDialog {...defaultProps}>
          <SettingsDialogTab id="general" label="General" icon={<Settings className="h-4 w-4" />} footer={<div data-testid="save-footer">Save</div>}>
            <div>General content</div>
          </SettingsDialogTab>
          <SettingsDialogTab id="notifications" label="Notifications" icon={<Bell className="h-4 w-4" />}>
            <div>Notifications content</div>
          </SettingsDialogTab>
        </SettingsDialog>
      )

      await user.click(screen.getByTestId('settings-nav-notifications'))
      expect(screen.queryByTestId('save-footer')).not.toBeInTheDocument()
    })
  })

  describe('overlay', () => {
    it('renders overlay when provided', () => {
      renderSimpleDialog({
        overlay: <div data-testid="permission-overlay">No access</div>,
      })
      expect(screen.getByTestId('permission-overlay')).toBeInTheDocument()
    })

    it('does not render overlay when not provided', () => {
      renderSimpleDialog()
      expect(screen.queryByTestId('permission-overlay')).not.toBeInTheDocument()
    })
  })

  describe('data-testid and navTestIdPrefix', () => {
    it('applies data-testid to dialog content', () => {
      renderSimpleDialog({ 'data-testid': 'my-settings-dialog' })
      expect(screen.getByTestId('my-settings-dialog')).toBeInTheDocument()
    })

    it('uses custom navTestIdPrefix for nav items', () => {
      renderWithProviders(
        <SettingsDialog {...defaultProps} navTestIdPrefix="agent-settings">
          <SettingsDialogTab id="general" label="General" icon={<Settings className="h-4 w-4" />}>
            <div>General content</div>
          </SettingsDialogTab>
        </SettingsDialog>
      )
      expect(screen.getByTestId('agent-settings-nav-general')).toBeInTheDocument()
    })
  })
})
