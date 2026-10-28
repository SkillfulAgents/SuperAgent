// @vitest-environment jsdom
import * as React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('@renderer/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}))

vi.mock('@renderer/hooks/use-fullscreen', () => ({
  useFullScreen: () => false,
}))

vi.mock('@renderer/lib/env', () => ({
  isElectron: () => false,
  getPlatform: () => 'web',
}))

vi.mock('@renderer/lib/open-external', () => ({
  openExternalUrl: vi.fn(),
}))

vi.mock('@renderer/components/ui/sidebar', () => {
  const Passthrough = ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <div {...props}>{children}</div>
  )
  return {
    SidebarProvider: Passthrough,
    Sidebar: Passthrough,
    SidebarContent: Passthrough,
    SidebarGroup: Passthrough,
    SidebarGroupContent: Passthrough,
    SidebarGroupLabel: Passthrough,
    SidebarHeader: Passthrough,
    SidebarInset: Passthrough,
    SidebarMenu: Passthrough,
    SidebarMenuButton: ({
      children,
      onClick,
      ...props
    }: React.PropsWithChildren<{ onClick?: () => void } & Record<string, unknown>>) => (
      <button type="button" onClick={onClick} {...props}>
        {children}
      </button>
    ),
    SidebarMenuItem: Passthrough,
  }
})

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}))

vi.mock('@renderer/components/ui/app-link', () => ({
  AppLink: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <a {...props}>{children}</a>
  ),
}))

vi.mock('@renderer/components/layout/settings-page', () => ({
  SettingsPageContainer: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  PageTitle: ({ title }: { title: string }) => <h1>{title}</h1>,
}))

import { SettingsPage, type SettingsPageSection } from './settings-page'

function section(id: string, externalHref?: string): SettingsPageSection {
  return {
    id,
    label: id,
    icon: null,
    externalHref,
    render: () => <div data-testid={`${id}-content`}>{id}</div>,
  }
}

describe('SettingsPage external-section fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('redirects when the deep-linked section becomes external-only', () => {
    const onSectionChange = vi.fn()
    const { rerender } = render(
      <SettingsPage
        groups={[{ sections: [section('users'), section('general')] }]}
        initialSection="users"
        onClose={() => {}}
        onSectionChange={onSectionChange}
      />,
    )

    expect(screen.getByTestId('users-content')).toBeInTheDocument()

    rerender(
      <SettingsPage
        groups={[{ sections: [section('users', 'https://platform.example/team'), section('general')] }]}
        initialSection="users"
        onClose={() => {}}
        onSectionChange={onSectionChange}
      />,
    )

    expect(screen.queryByTestId('users-content')).not.toBeInTheDocument()
    expect(screen.getByTestId('general-content')).toBeInTheDocument()
    expect(onSectionChange).toHaveBeenCalledWith('general')
  })

  it('syncs the URL when the initial section is already external on first paint', () => {
    const onSectionChange = vi.fn()
    render(
      <SettingsPage
        groups={[{ sections: [section('users', 'https://platform.example/team'), section('general')] }]}
        initialSection="users"
        onClose={() => {}}
        onSectionChange={onSectionChange}
      />,
    )

    expect(screen.getByTestId('general-content')).toBeInTheDocument()
    expect(onSectionChange).toHaveBeenCalledWith('general')
  })
})
