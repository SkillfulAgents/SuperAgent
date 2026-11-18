import { useState } from 'react'
import { ChevronDown, ChevronRight, KeyRound, Loader2, UserPlus, Users } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@renderer/components/ui/dropdown-menu'
import { Input } from '@renderer/components/ui/input'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { cn } from '@shared/lib/utils/cn'
import type { LoginVaultInfo, VaultOffer } from './login-request'
import type { LoginViaProvider } from './use-login-request'

/**
 * The sign-in form's vault parts: the choice among the user's saved accounts
 * for the site, "Save for later", and "Or sign in with Google, …". Metadata
 * only: a saved value never reaches the renderer, it goes from the vault into
 * the page on the host.
 */

/** Said wherever saving or using an account here shares it with the others who can use the agent (its members and admins). */
export function sharedAgentNotice(otherMembers: number, site: string): string {
  return `${otherMembers} other ${otherMembers === 1 ? 'person' : 'people'} can use this agent. They will be able to have it sign in to ${site} as you.`
}

function SharedNotice({ otherMembers, site }: { otherMembers: number; site: string }) {
  if (otherMembers === 0) return null
  return (
    <p className="flex items-start gap-1.5 text-2xs text-amber-700 dark:text-amber-400" data-testid="login-shared-notice">
      <Users className="mt-0.5 h-3 w-3 shrink-0" />
      {sharedAgentNotice(otherMembers, site)}
    </p>
  )
}

/** What a saved account holds, in a few words. */
export function describeOffer(offer: Pick<VaultOffer, 'parts' | 'via' | 'rejected'>): string {
  if (offer.via) return `Signs in with ${offer.via.name} (${offer.via.username})`
  const parts = offer.parts.map((part) => (part === 'password' ? 'password' : part.replace(/^text:/, '')))
  const saved = parts.length ? `Saved: ${parts.join(', ')}` : 'Username only'
  return offer.rejected ? `${saved} · the site turned it down` : saved
}

/**
 * The form's first step when the user has saved accounts for the site: one
 * click uses one (and lets this agent use it from now on); "Use a different
 * account" goes on to the fields.
 */
export function AccountChooser({
  offers,
  site,
  otherMembers,
  disabled,
  pendingId,
  onUse,
  onDifferent,
}: {
  offers: VaultOffer[]
  site: string
  otherMembers: number
  disabled: boolean
  /** The account being signed in with, while that runs. */
  pendingId: string | null
  onUse: (offer: VaultOffer) => void
  onDifferent: () => void
}) {
  const row = 'flex w-full items-center gap-3 px-2.5 py-2 text-left hover:bg-muted disabled:opacity-50'
  return (
    <div className="space-y-1.5" data-testid="login-vault-accounts">
      {offers.some((offer) => !offer.granted) && <SharedNotice otherMembers={otherMembers} site={site} />}
      <div className="divide-y divide-border overflow-hidden rounded-md border border-border bg-background">
        {offers.map((offer) => (
          <button
            key={offer.id}
            type="button"
            onClick={() => onUse(offer)}
            disabled={disabled}
            className={row}
            data-testid={`login-vault-account-${offer.id}`}
          >
            <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-foreground">{offer.label || offer.username}</span>
              <span className="block truncate text-2xs text-muted-foreground">
                {offer.label ? `${offer.username} · ` : ''}
                {describeOffer(offer)}
              </span>
            </span>
            {pendingId === offer.id
              ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="Signing in" />
              : <span className="shrink-0 text-2xs font-medium text-blue-600 dark:text-blue-400">Use</span>}
          </button>
        ))}
        <button type="button" onClick={onDifferent} disabled={disabled} className={row} data-testid="login-different-account">
          <UserPlus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 text-xs text-foreground">Use a different account</span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
      </div>
    </div>
  )
}

/** "Save for later": the account goes to the user's vault, and this agent may use it. */
export function SaveForLater({
  checked,
  onCheckedChange,
  site,
  username,
  askUsername,
  usernameValue,
  onUsernameChange,
  otherMembers,
  disabled,
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  site: string
  /** Whose account it is, when already known. */
  username: string | null
  /** The page shows no username field and none is known: ask for it to save. */
  askUsername: boolean
  usernameValue: string
  onUsernameChange: (value: string) => void
  otherMembers: number
  disabled: boolean
}) {
  return (
    <div className="space-y-1.5 rounded-md border border-border bg-muted/30 p-2.5" data-testid="login-save-section">
      <label className="flex items-start gap-2 text-xs text-foreground">
        <Checkbox
          checked={checked}
          onCheckedChange={(value) => onCheckedChange(value === true)}
          disabled={disabled}
          className="mt-0.5"
          data-testid="login-save"
          aria-describedby="login-save-hint"
        />
        <span className="min-w-0">
          <span className="block font-medium">Save for later</span>
          <span id="login-save-hint" className="block text-2xs text-muted-foreground">
            Saves {username ? <span className="break-all">{username}</span> : 'this account'} to your vault for {site}, so this agent can sign in again without asking you.
          </span>
        </span>
      </label>
      {checked && askUsername && (
        <Input
          value={usernameValue}
          onChange={(event) => onUsernameChange(event.target.value)}
          placeholder="Username or email of this account"
          aria-label="Username or email of this account"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="off"
          disabled={disabled}
          className="h-8 bg-background text-xs"
          data-testid="login-save-username"
        />
      )}
      {checked && <SharedNotice otherMembers={otherMembers} site={site} />}
    </div>
  )
}

/** Brand icons of the sign-in providers, by provider id; the black ones turn white in the dark theme. */
const PROVIDER_ICONS: Record<string, { slug: string; invert?: boolean }> = {
  google: { slug: 'google' },
  microsoft: { slug: 'microsoft' },
  'microsoft-work': { slug: 'microsoft' },
  apple: { slug: 'apple', invert: true },
  github: { slug: 'github', invert: true },
  facebook: { slug: 'facebook' },
  linkedin: { slug: 'linkedin' },
  x: { slug: 'twitter', invert: true },
  slack: { slug: 'slack' },
}

function ProviderIcon({ providerId, className }: { providerId: string; className?: string }) {
  const icon = PROVIDER_ICONS[providerId]
  if (!icon) return <KeyRound className={cn('text-muted-foreground', className)} />
  return <ServiceIcon slug={icon.slug} className={cn(icon.invert && 'dark:invert', className)} />
}

/** The user's saved accounts on sites that are no known provider: a company's own sign-in, say. */
function otherSavedAccounts(info: LoginVaultInfo): LoginVaultInfo['providerAccounts'] {
  return info.providerAccounts.filter((account) => account.providerId === null)
}

/** The ways to sign in through another account that the form offers. */
export interface ProviderChoices {
  /** The page's own buttons ("Sign in with Google"), in its order, as the agent listed them. */
  shown: LoginVaultInfo['providers']
  /** Every other provider: the agent may have missed a button, or it is on a later page. */
  more: LoginVaultInfo['providers']
  /** The user has saved accounts on other sites (a company's own sign-in). */
  otherSaved: boolean
}

export function providerChoices(info: LoginVaultInfo, site: string, pageProviders: readonly string[]): ProviderChoices {
  // Never the site itself: not GitHub on github.com's own sign-in page.
  const providers = info.providers.filter((provider) => provider.site !== site)
  const shown = [...new Set(pageProviders)].flatMap((id) => providers.filter((provider) => provider.id === id))
  return { shown, more: providers.filter((provider) => !shown.includes(provider)), otherSaved: otherSavedAccounts(info).length > 0 }
}

/** Picking one asks which account there (SignInViaPanel); null picks among the user's saved accounts on other sites. */
type PickProvider = (providerId: string | null) => void

function MoreProviders({ choices, onPick }: { choices: ProviderChoices; onPick: PickProvider }) {
  return (
    <DropdownMenuContent align="start">
      {choices.more.map((provider) => (
        <DropdownMenuItem key={provider.id} className="text-xs" onSelect={() => onPick(provider.id)} data-testid={`login-via-provider-${provider.id}`}>
          <ProviderIcon providerId={provider.id} className="h-3.5 w-3.5" />
          {provider.name}
        </DropdownMenuItem>
      ))}
      {choices.otherSaved && choices.more.length > 0 && <DropdownMenuSeparator />}
      {choices.otherSaved && (
        <DropdownMenuItem className="text-xs" onSelect={() => onPick(null)} data-testid="login-via-saved">
          <KeyRound className="text-muted-foreground" />
          Another saved account
        </DropdownMenuItem>
      )}
    </DropdownMenuContent>
  )
}

/** "Or sign in with" the page's own buttons; the other providers under More. */
export function SignInWithProviders({ choices, lead, disabled, onPick }: { choices: ProviderChoices; lead: string; disabled: boolean; onPick: PickProvider }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="login-via-providers">
      <span className="mr-1 text-xs text-muted-foreground">{lead}</span>
      {choices.shown.map((provider) => (
        <Button
          key={provider.id}
          type="button"
          variant="outline"
          size="xs"
          className="gap-1.5 px-2 font-normal"
          onClick={() => onPick(provider.id)}
          disabled={disabled}
          data-testid={`login-via-provider-${provider.id}`}
        >
          <ProviderIcon providerId={provider.id} className="h-3.5 w-3.5" />
          {provider.name}
        </Button>
      ))}
      {(choices.more.length > 0 || choices.otherSaved) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="xs" className="gap-1 px-2 font-normal text-muted-foreground" disabled={disabled} data-testid="login-via-more">
              More
              <ChevronDown className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <MoreProviders choices={choices} onPick={onPick} />
        </DropdownMenu>
      )}
    </div>
  )
}

/** For a page that shows no such buttons: every provider, out of the way. */
export function OtherWaysToSignIn({ choices, disabled, onPick }: { choices: ProviderChoices; disabled: boolean; onPick: PickProvider }) {
  if (choices.more.length === 0 && !choices.otherSaved) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="link"
          size="xs"
          className="h-auto gap-1 px-0 text-xs text-muted-foreground"
          disabled={disabled}
          data-testid="login-via-more"
        >
          Other ways to sign in
          <ChevronDown className="h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <MoreProviders choices={choices} onPick={onPick} />
    </DropdownMenu>
  )
}

/**
 * Which account of the picked provider the user signs in to the site with:
 * a saved one, or one named. Without a provider, one of the user's saved
 * accounts on other sites. The agent clicks the provider's button itself and
 * is told which account to pick.
 */
export function SignInViaPanel({
  info,
  site,
  providerId,
  busy,
  error,
  onSignInVia,
  onBack,
}: {
  info: LoginVaultInfo | undefined
  site: string
  providerId: string | null
  busy: boolean
  error?: string
  onSignInVia: (provider: LoginViaProvider) => void
  onBack: () => void
}) {
  const [username, setUsername] = useState('')
  const provider = info?.providers.find((candidate) => candidate.id === providerId)
  const saved = !info ? [] : provider ? info.providerAccounts.filter((account) => account.providerId === provider.id) : otherSavedAccounts(info)
  const back = (
    <Button type="button" variant="ghost" size="xs" onClick={onBack} disabled={busy} data-testid="login-via-back">
      Back to the form
    </Button>
  )
  return (
    <div className="space-y-3 pt-4" data-testid="login-via">
      <p className="flex items-center gap-2 text-sm text-foreground">
        {provider && <ProviderIcon providerId={provider.id} className="h-4 w-4 shrink-0" />}
        {provider ? `Which ${provider.name} account do you sign in to ${site} with?` : `Which account do you sign in to ${site} with?`}
      </p>
      {saved.length > 0 && (
        <div className="space-y-1.5">
          {saved.map((account) => (
            <button
              key={account.id}
              type="button"
              onClick={() => onSignInVia({ accountId: account.id })}
              disabled={busy}
              className="flex w-full items-center gap-3 rounded-md border border-border bg-background px-2.5 py-2 text-left hover:bg-muted disabled:opacity-50"
              data-testid={`login-via-account-${account.id}`}
            >
              <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-foreground">{account.username}</span>
                {!provider && <span className="block truncate text-2xs text-muted-foreground">{account.providerName}</span>}
              </span>
              <span className="shrink-0 text-2xs font-medium text-blue-600 dark:text-blue-400">Use</span>
            </button>
          ))}
        </div>
      )}
      {provider ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (username.trim()) onSignInVia({ providerId: provider.id, username: username.trim() })
          }}
        >
          {saved.length > 0 && <div className="text-xs font-medium text-foreground">Or another account</div>}
          <Input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="Email or username"
            aria-label={`Email or username of the ${provider.name} account`}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
            className="h-9 bg-background text-xs"
            data-testid="login-via-username"
          />
          <SharedNotice otherMembers={info?.otherMembers ?? 0} site={site} />
          <p className="text-2xs text-muted-foreground">
            Saved to your vault for {site}. The agent clicks the site&apos;s {provider.name.replace(/ \(.*\)$/, '')} button and picks only this account.
          </p>
          {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
          <div className="flex items-center justify-between gap-2">
            {back}
            <Button
              type="submit"
              size="xs"
              className="min-w-24 bg-blue-600 text-white hover:bg-blue-700"
              loading={busy}
              disabled={busy || !username.trim()}
              data-testid="login-via-submit"
            >
              Continue
            </Button>
          </div>
        </form>
      ) : (
        <>
          <SharedNotice otherMembers={info?.otherMembers ?? 0} site={site} />
          {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
          <div className="flex items-center gap-2">{back}</div>
        </>
      )}
    </div>
  )
}
