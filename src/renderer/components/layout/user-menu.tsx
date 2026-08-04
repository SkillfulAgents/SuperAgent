import {
  BookOpen,
  Calendar,
  ChevronDown,
  CircleFadingArrowUp,
  CircleHelp,
  Cloud,
  KeyRound,
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { useDialogs } from '@renderer/context/dialog-context'
import { useUpdateStatus } from '@renderer/context/update-status-context'
import { useUser } from '@renderer/context/user-context'
import { usePlatformAuthStatus, usePlatformConnect } from '@renderer/hooks/use-platform-auth'
import { useSettings, type LlmProviderId } from '@renderer/hooks/use-settings'
import { useTargetSwitch } from '@renderer/hooks/use-target-switch'
import { useUpdateUserSettings, useUserSettings } from '@renderer/hooks/use-user-settings'
import { hasInteractiveLogin } from '@renderer/lib/auth-mode'

// Mirrors the platform web app's account menu (SkillfulAgents/platform PR #173).

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

// BYOK (no account) presentation: `short` is the trigger subline, `detail`
// the menu-header second line. `platform` shouldn't appear without a
// connected account, but the map stays total so a mid-transition render
// (defaults applied before the auth query refetches) doesn't mislabel.
const PROVIDER_LABELS: Record<LlmProviderId, { short: string; detail: string }> = {
  anthropic: { short: 'Anthropic API key', detail: 'Using your own Anthropic API key' },
  openrouter: { short: 'OpenRouter', detail: 'Using your own OpenRouter key' },
  bedrock: { short: 'AWS Bedrock', detail: 'Using AWS Bedrock credentials' },
  generic: { short: 'Custom endpoint', detail: 'Using a custom API endpoint' },
  platform: { short: 'Gamut platform', detail: 'Using Gamut platform credits' },
}

function openExternal(url: string) {
  if (window.electronAPI?.openExternal) {
    void window.electronAPI.openExternal(url)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

function AvatarCircle({ size = 32, children }: { size?: number; children: React.ReactNode }) {
  return (
    <div
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted text-xs font-semibold"
      style={{ width: size, height: size }}
    >
      {children}
    </div>
  )
}

function AccountAvatar({
  name,
  image,
  size = 32,
}: {
  name: string
  image?: string | null
  size?: number
}) {
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
      className="relative flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-border/60 bg-muted text-xs font-semibold"
      style={{ width: size, height: size }}
    >
      {initials}
      {image && (
        <img
          src={image}
          alt=""
          className="absolute inset-0 size-full object-cover"
          onError={(event) => event.currentTarget.remove()}
        />
      )}
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
      <DropdownMenuRadioGroup
        value={theme}
        onValueChange={(value) => updateUserSettings.mutate({ theme: value as typeof theme })}
        className="flex items-center gap-0.5 rounded-md bg-muted/60 p-0.5"
      >
        {THEME_OPTIONS.map((opt) => {
          const active = theme === opt.value
          return (
            <DropdownMenuRadioItem
              key={opt.value}
              value={opt.value}
              aria-label={`${opt.label} theme`}
              disabled={isLoading}
              onSelect={(event) => event.preventDefault()}
              className={cn(
                'flex size-6 cursor-pointer items-center justify-center rounded p-1 transition-colors [&>span]:hidden',
                active
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <opt.icon className="size-4" aria-hidden="true" />
            </DropdownMenuRadioItem>
          )
        })}
      </DropdownMenuRadioGroup>
    </div>
  )
}

// Sidebar-footer account menu, mirroring the platform web app's user menu.
//
// Auth mode always presents the Better Auth user as the core identity. A
// linked platform account enriches that identity and enables billing actions.
// Non-auth mode presents the local provider/settings workspace fallback.
export function UserMenu() {
  const { isAuthMode, user } = useUser()
  const { openSettings } = useDialogs()
  const { data: settings } = useSettings({ enabled: !isAuthMode })
  const { data: platformAuth } = usePlatformAuthStatus()
  const { handleConnect } = usePlatformConnect()
  const { switching, switchTo } = useTargetSwitch()
  const updateStatus = useUpdateStatus()
  const updateAvailable = updateStatus.state === 'available' || updateStatus.state === 'downloaded'
  const showUseThisComputer = isAuthMode && !!user && !hasInteractiveLogin()

  const hasAuthIdentity = isAuthMode && !!user
  const providerLabels = PROVIDER_LABELS[settings?.llmProvider ?? 'anthropic']
  const displayName = hasAuthIdentity
    ? (user.name.trim() || user.email)
    : 'Personal'
  const email = hasAuthIdentity
    ? (platformAuth?.connected && platformAuth.email ? platformAuth.email : user.email)
    : null
  const avatarUrl = hasAuthIdentity ? user.image : null
  const upgradeUrl = hasAuthIdentity && platformAuth?.connected && platformAuth.platformBaseUrl && platformAuth.orgId
    ? `${platformAuth.platformBaseUrl}/dashboard/organizations/${platformAuth.orgId}?tab=billing`
    : null
  const canConnectPlatform = !isAuthMode && !platformAuth?.connected && !!platformAuth?.platformBaseUrl

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
          {hasAuthIdentity ? (
            <AccountAvatar name={displayName} image={avatarUrl} />
          ) : (
            <AvatarCircle>
              <KeyRound className="size-3.5 text-muted-foreground" aria-hidden="true" />
            </AvatarCircle>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">{displayName}</p>
            {hasAuthIdentity ? (
              upgradeUrl ? (
                <p className="truncate text-xs text-brand">Upgrade to Pro</p>
              ) : (
                <p className="truncate text-xs text-muted-foreground">{user.email}</p>
              )
            ) : (
              <p className="truncate text-xs text-muted-foreground">{providerLabels.short}</p>
            )}
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
          <p className="truncate text-xs text-muted-foreground">
            {hasAuthIdentity ? email : providerLabels.detail}
          </p>
        </div>

        {/* Sized to match the app's small outline buttons, like the platform
            account menu's upgrade CTA. In non-auth mode this slot is the
            deliberately quiet platform-connect hook. */}
        {upgradeUrl ? (
          <DropdownMenuItem
            onSelect={() => openExternal(upgradeUrl)}
            data-testid="upgrade-to-pro-button"
            className="mx-1 mb-2 mt-1 h-8 justify-center rounded-md border border-input bg-background px-3 text-xs font-medium focus:bg-sidebar-accent focus:text-sidebar-accent-foreground"
          >
            <CircleFadingArrowUp className="size-3.5" aria-hidden="true" />
            Upgrade to Pro
          </DropdownMenuItem>
        ) : (
          canConnectPlatform && (
            <DropdownMenuItem
              onSelect={() => void handleConnect()}
              data-testid="connect-platform-button"
              className="mx-1 mb-2 mt-1 h-8 justify-center rounded-md border border-input bg-background px-3 text-xs font-medium focus:bg-sidebar-accent focus:text-sidebar-accent-foreground"
            >
              <Cloud className="size-3.5" aria-hidden="true" />
              Connect Gamut account
            </DropdownMenuItem>
          )
        )}

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

        {showUseThisComputer && (
          <DropdownMenuItem
            onSelect={() => void switchTo('local')}
            disabled={switching}
            data-testid="switch-to-local-button"
            className="focus:bg-sidebar-accent focus:text-sidebar-accent-foreground"
          >
            <span className="flex-1">Use this computer</span>
            <Monitor className="size-4 text-muted-foreground" aria-hidden="true" />
          </DropdownMenuItem>
        )}

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
