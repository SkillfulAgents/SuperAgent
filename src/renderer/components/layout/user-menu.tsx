import {
  BookOpen,
  Calendar,
  ChevronDown,
  CircleFadingArrowUp,
  CircleHelp,
  LogOut,
  Mail,
  MessagesSquare,
  Monitor,
  Moon,
  Settings,
  Sun,
} from 'lucide-react'

import { cn } from '@shared/lib/utils/cn'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { useDialogs } from '@renderer/context/dialog-context'
import { useUpdateStatus } from '@renderer/context/update-status-context'
import { useUser } from '@renderer/context/user-context'
import { useUpdateUserSettings, useUserSettings } from '@renderer/hooks/use-user-settings'

// Mirrors the platform web app's account menu (SkillfulAgents/platform PR #173).
// TODO(iddo): derive the org-specific billing URL from platform auth instead of
// this hardcoded org — see usePlatformBillingUrl in
// components/messages/insufficient-balance-card.tsx for the existing pattern.
const UPGRADE_URL =
  'https://platform.gamutagents.com/dashboard/organizations/org_76b6535b-dbbb-46b2-84c1-2a6372d5b45e?tab=billing'

const SUPPORT_EMAIL = 'support@gamut.so'
const SUPPORT_CALL_URL = 'https://cal.com/graham-cummings-gamut/agentonboarding'
const DOCS_URL = 'https://www.gamut.so/docs'
const SLACK_COMMUNITY_URL =
  'https://join.slack.com/t/gamut-org/shared_invite/zt-43pmy0p1w-DJ_gLMx_nWNKxQpKjsnbWQ'

const HELP_LINKS = [
  { key: 'docs', label: 'Gamut docs', href: DOCS_URL, icon: BookOpen },
  { key: 'slack', label: 'Chat with the community', href: SLACK_COMMUNITY_URL, icon: MessagesSquare },
  { key: 'contact', label: 'Contact us', href: `mailto:${SUPPORT_EMAIL}`, icon: Mail },
  { key: 'support_call', label: 'Book a support call', href: SUPPORT_CALL_URL, icon: Calendar },
] as const

function openExternal(url: string) {
  if (window.electronAPI?.openExternal) {
    void window.electronAPI.openExternal(url)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

function AvatarInitials({ name, size = 32 }: { name: string; size?: number }) {
  const initials = name
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

  return (
    <div
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted text-xs font-semibold"
      style={{ width: size, height: size }}
    >
      {initials}
    </div>
  )
}

// Account-menu Help submenu: docs, community, support email, and call booking.
function HelpMenu() {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="focus:bg-sidebar-accent focus:text-sidebar-accent-foreground data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground">
        <CircleHelp className="size-4 text-muted-foreground" aria-hidden="true" />
        <span className="flex-1">Help</span>
      </DropdownMenuSubTrigger>

      <DropdownMenuSubContent
        sideOffset={8}
        className="border-sidebar-border/60 bg-popover shadow-lg shadow-black/5"
      >
        {HELP_LINKS.map(({ key, label, href, icon: Icon }) => (
          <DropdownMenuItem
            key={key}
            onSelect={() => openExternal(href)}
            className="focus:bg-sidebar-accent focus:text-sidebar-accent-foreground"
          >
            <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
            {label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

const THEME_OPTIONS = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
] as const

// Account-menu theme row: a segmented Light/Dark/System toggle that flips the
// theme live without closing the menu. Persists via the same user-settings
// mutation as the Settings → General appearance picker.
function AppearanceRow() {
  const { data: userSettings, isLoading } = useUserSettings()
  const updateUserSettings = useUpdateUserSettings()
  const theme = userSettings?.theme ?? 'system'

  return (
    <div className="flex items-center justify-between gap-2 px-2 py-1.5">
      <span className="text-sm">Appearance</span>
      <div className="flex items-center gap-0.5 rounded-md bg-muted/60 p-0.5">
        {THEME_OPTIONS.map((opt) => {
          const active = theme === opt.value
          return (
            <button
              key={opt.value}
              type="button"
              aria-label={`${opt.label} theme`}
              aria-pressed={active}
              disabled={isLoading}
              onClick={() => updateUserSettings.mutate({ theme: opt.value })}
              className={cn(
                'flex items-center justify-center rounded p-1 transition-colors',
                active
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <opt.icon className="size-4" aria-hidden="true" />
            </button>
          )
        })}
      </div>
    </div>
  )
}

// Sidebar-footer account menu, mirroring the platform web app's user menu.
export function UserMenu() {
  const { isAuthMode, user, signOut } = useUser()
  const { openSettings } = useDialogs()
  const updateStatus = useUpdateStatus()
  const updateAvailable = updateStatus.state === 'available' || updateStatus.state === 'downloaded'

  // TODO(iddo): source identity from the connected platform account (name,
  // email, avatar). The auth-mode session user is used when present so
  // multi-user deployments keep showing the signed-in user.
  const displayName = user?.name ?? 'Test Taskew'
  const email = user?.email ?? 'west.askew+1098@gmail.com'

  const handleSignOut = () => {
    // Auth-mode sign-out keeps working as before.
    // TODO(iddo): wire platform-account sign out for the desktop app.
    if (isAuthMode && user) void signOut()
  }

  return (
    /* modal={false}: a modal menu can leave `pointer-events: none` stuck on
       <body> when it closes mid-navigation (e.g. Settings opening a route),
       making the whole sidebar unclickable. */
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Account menu"
          data-testid="user-menu-trigger"
          className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-foreground/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/30 data-[state=open]:bg-foreground/5"
        >
          <AvatarInitials name={displayName} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">{displayName}</p>
            <p className="truncate text-xs text-brand">Upgrade to Pro</p>
          </div>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={6}
        className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-56 border-sidebar-border/60 bg-popover shadow-lg shadow-black/5"
      >
        <div className="px-2 pb-1.5 pt-1">
          <p className="truncate text-sm font-medium text-foreground">{displayName}</p>
          <p className="truncate text-xs text-muted-foreground">{email}</p>
        </div>

        {/* Sized to match the app's small outline buttons, like the platform
            account menu's upgrade CTA. */}
        <DropdownMenuItem
          onSelect={() => openExternal(UPGRADE_URL)}
          data-testid="upgrade-to-pro-button"
          className="mx-1 mb-2 mt-1 h-8 justify-center rounded-md border border-input bg-background px-3 text-xs font-medium focus:bg-sidebar-accent focus:text-sidebar-accent-foreground"
        >
          <CircleFadingArrowUp className="size-3.5" aria-hidden="true" />
          Upgrade to Pro
        </DropdownMenuItem>

        <DropdownMenuSeparator className="bg-sidebar-border/60" />

        <DropdownMenuItem
          onSelect={() => openSettings()}
          data-testid="settings-button"
          className="focus:bg-sidebar-accent focus:text-sidebar-accent-foreground"
        >
          <Settings className="size-4 text-muted-foreground" aria-hidden="true" />
          <span className="flex-1">Settings</span>
        </DropdownMenuItem>

        <HelpMenu />

        <DropdownMenuSeparator className="bg-sidebar-border/60" />

        <AppearanceRow />

        <DropdownMenuSeparator className="bg-sidebar-border/60" />

        <DropdownMenuItem
          onSelect={handleSignOut}
          data-testid="sign-out-button"
          className="focus:bg-sidebar-accent focus:text-sidebar-accent-foreground"
        >
          <span className="flex-1">Sign out</span>
          <LogOut className="size-4 text-muted-foreground" aria-hidden="true" />
        </DropdownMenuItem>

        <DropdownMenuItem
          onSelect={() => openSettings('general')}
          data-testid="sidebar-version"
          title={updateAvailable ? `Update available: v${updateStatus.version}` : undefined}
          className="justify-between py-1 text-xs text-muted-foreground focus:bg-sidebar-accent focus:text-sidebar-accent-foreground"
        >
          <span>v{__APP_VERSION__}</span>
          {updateAvailable && (
            <span className="h-2 w-2 rounded-full bg-blue-500" aria-label="Update available" />
          )}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
