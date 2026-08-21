import { Outlet, useNavigate, useParams } from '@tanstack/react-router'
import { GlobalSettingsPage } from '@renderer/components/settings/global-settings-page'
import { useDialogs } from '@renderer/context/dialog-context'

// Global settings is a top-level route (`/settings`, `/settings/$tab`), sibling
// of the app shell, so it replaces the whole shell. This module is a separate
// lazy route boundary so settings and its tabs stay off the normal app boot.
function SettingsPageView({ tab }: { tab?: string }) {
  const { closeSettings, openWizard } = useDialogs()
  const navigate = useNavigate()
  return (
    <GlobalSettingsPage
      onClose={closeSettings}
      onOpenWizard={openWizard}
      initialSection={tab}
      // Switching tabs drives the URL → /settings/$tab, preserving `?from=` so
      // the close-target survives a tab switch. The nav items render as real
      // <a href> links to this target so cmd/middle-click opens a tab in a new
      // window (web); a plain click navigates in place.
      sectionLinkProps={(id) => ({ to: '/settings/$tab', params: { tab: id }, search: (prev) => prev })}
      onSectionChange={(id) => navigate({ to: '/settings/$tab', params: { tab: id }, search: (prev) => prev })}
    />
  )
}

export function SettingsLayout() {
  return <Outlet />
}

export function SettingsIndexRoute() {
  return <SettingsPageView />
}

export function SettingsTabRoute() {
  const { tab } = useParams({ strict: false }) as { tab?: string }
  return <SettingsPageView tab={tab} />
}
