import { registrableDomain } from './site'

/**
 * Accounts people sign in to other sites with ("Continue with Google"). A
 * site's account points at one of these (`via`); the provider's own sign-in
 * form is on a site of its domain (accounts.google.com), where the vault
 * finds the provider account too.
 */
export interface SignInProvider {
  id: string
  name: string
  /** The registrable domain of the provider's sign-in page. */
  site: string
}

export const SIGN_IN_PROVIDERS: readonly SignInProvider[] = [
  { id: 'google', name: 'Google', site: 'google.com' },
  { id: 'microsoft', name: 'Microsoft', site: 'live.com' },
  { id: 'microsoft-work', name: 'Microsoft (work or school)', site: 'microsoftonline.com' },
  { id: 'apple', name: 'Apple', site: 'apple.com' },
  { id: 'github', name: 'GitHub', site: 'github.com' },
  { id: 'facebook', name: 'Facebook', site: 'facebook.com' },
  { id: 'linkedin', name: 'LinkedIn', site: 'linkedin.com' },
  { id: 'x', name: 'X', site: 'x.com' },
  { id: 'slack', name: 'Slack', site: 'slack.com' },
]

/** The provider a site belongs to (accounts.google.com → Google), if it is one. */
export function providerOf(site: string): SignInProvider | null {
  const domain = registrableDomain(site)
  return SIGN_IN_PROVIDERS.find((provider) => provider.site === domain) ?? null
}

/** What to call an account's site when it is someone's sign-in provider: "Google", or the site itself. */
export function providerName(site: string): string {
  return providerOf(site)?.name.replace(/ \(.*\)$/, '') ?? site
}
