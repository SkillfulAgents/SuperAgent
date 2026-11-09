/**
 * Team directories: a workspace's people as another system lists them (Slack
 * first). Gamut asks each connected directory for everyone in it, caches the
 * list, and does all searching, merging and ranking itself, so a provider only
 * lists people (and, optionally, messages them).
 *
 * Nothing outside `providers/` may know which provider it is talking to: a
 * second provider implements `TeamDirectoryProvider` and registers itself.
 */
import type { z } from 'zod'
import type { VerificationProfile } from '@shared/lib/services/webhook-endpoint-schema'

/** One person as a directory lists them. Bots, guests and deactivated accounts are never listed. */
export interface DirectoryUser {
  provider: string
  /** The directory's workspace (Slack team or enterprise id). */
  tenantId: string
  /** The person's id in that workspace. */
  remoteId: string
  name: string
  email?: string
  /** Whether the provider vouches that `email` is the person's. Only a verified email merges people or names a Gamut account. */
  emailVerified: boolean
  avatarUrl?: string
}

/**
 * What `notifyUser` sends: one line saying what happened, an optional quote
 * (the message someone was mentioned in), and a link into Gamut. Plain text:
 * the provider formats and escapes it.
 */
export interface DirectoryMessage {
  headline: string
  quote?: string
  link: { label: string; url: string }
}

/** A connected directory, opened with its credentials. */
export interface TeamDirectory {
  /** Everyone in the directory. Filtering happens in Gamut, never in the provider. */
  listUsers(): Promise<DirectoryUser[]>
  /** Sends a person a message outside Gamut (a Slack DM). Absent when the provider cannot. */
  notifyUser?(user: DirectoryUser, message: DirectoryMessage): Promise<void>
}

/** A field of a provider's connect form. */
export interface DirectoryCredentialField {
  key: string
  label: string
  placeholder?: string
  /** Rendered as a password input. */
  secret?: boolean
}

/** What the Settings tab shows for a provider: the renderer draws the form from this alone. */
export interface DirectoryProviderInfo {
  id: string
  label: string
  description: string
  fields: DirectoryCredentialField[]
  /** How to get the credentials, in order. */
  steps: string[]
  /** A page that does most of the setup (Slack's "create an app" with a manifest). */
  setupLink?: { label: string; href: string }
}

/** What verifying credentials learned about the workspace they open. */
export interface DirectoryTenant {
  tenantId: string
  tenantName: string
  /** What works but is limited (a missing optional scope), for the admin. */
  notices?: string[]
}

export interface StoredDirectoryConnection<C> {
  id: string
  tenantId: string
  credentials: C
}

/**
 * A kind of directory. Registered once (`registry.ts`); everything that uses a
 * directory goes through this, so a new provider needs nothing else.
 */
export interface TeamDirectoryProvider<C = unknown> {
  info: DirectoryProviderInfo
  /** What the connect form posts; stored sealed. */
  credentialsSchema: z.ZodType<C>
  /**
   * Checks the credentials and names their workspace. Throws
   * `DirectoryConnectError` with a message for the admin when they cannot be used.
   */
  verify(credentials: C): Promise<DirectoryTenant>
  open(connection: StoredDirectoryConnection<C>): TeamDirectory
  /** Present when the directory can also create agents' own apps in its workspace. */
  provisioning?: AgentIdentityProvisioning<any>
}

/**
 * Creating each agent its own app, with its own name, handle and icon, in the
 * directory's workspace (Slack first). Its credentials are separate from the
 * directory's and may rotate; the host keeps them fresh
 * (team-directory/provisioning.ts).
 */
export interface AgentIdentityProvisioning<P> {
  /** The agent integration provider whose apps this creates: 'slack'. */
  integrationProvider: string
  /** The form for its credentials, drawn as the directory's own is. */
  info: Omit<DirectoryProviderInfo, 'id' | 'label'>
  credentialsSchema: z.ZodType<P>
  /**
   * Checks credentials an admin pasted and returns what to store, rotated
   * already where the provider rotates. With `tenant`, they must be for that
   * workspace (a directory already connected); without, they name their own
   * (a directory being connected with them). Throws `DirectoryConnectError`
   * for the admin.
   */
  verify(credentials: P, tenant?: { tenantId: string }): Promise<P>
  /** When stored credentials should be rotated before they are next used. */
  needsRotation?(credentials: P, now: number): boolean
  /** Fresh credentials. Throws `ProvisioningCredentialsError` when they can't be renewed (the chain is broken). */
  rotate?(credentials: P): Promise<P>
  open(credentials: P): AgentIdentityProvisioner
  /**
   * Present when these credentials alone can connect the directory: the host
   * creates the directory's own app with them, a person installs it, and the
   * install (`AgentIdentityProvisioner.completeInstall`) gives the directory's
   * credentials. The admin pastes one token instead of making an app by hand.
   */
  createDirectoryApp?(credentials: P, input: { redirectUrl: string }): Promise<CreatedDirectoryApp>
}

/** The directory's own app, created but not installed yet. */
export interface CreatedDirectoryApp {
  /** What installing and deleting it needs; never sent to a client. */
  app: ProvisionedAppRecord
  /** The URL that installs it; the host adds its own `state`. */
  installUrl: string
}

/** What an agent's app is made from. */
export interface AgentAppIdentity {
  name: string
  description?: string
  /** Hex, the app's background. */
  backgroundColor?: string
  /** A square PNG of at least 512px: the agent's avatar. */
  icon?: Uint8Array
}

/**
 * An agent's app as the provider created it: what it needs to install, rename
 * or delete it again. Stored in the integration's config; never sent to a client.
 */
export type ProvisionedAppRecord = Record<string, unknown>

export interface CreatedAgentApp {
  app: ProvisionedAppRecord
  /** Config fields the integration's runtime needs from the app (Slack's signing secret). */
  config: Record<string, unknown>
  /** The URL that installs it; the host adds its own `state`. */
  installUrl: string
  /** The relay endpoint's signature check, once the app has a secret. */
  verification?: VerificationProfile
  /** Whether the icon was set. A failure doesn't fail the app: it can be set again later. */
  iconSet: boolean
  /** Where its settings are, for a person: Slack's app page. */
  settingsUrl?: string
}

export interface AgentIdentityProvisioner {
  createApp(input: AgentAppIdentity & { webhookUrl: string; redirectUrl: string }): Promise<CreatedAgentApp>
  /**
   * Finishes the install the person approved. For an agent's app, returns the
   * config fields that connect the integration (Slack's bot token); for the
   * directory's own app, the directory's credentials.
   */
  completeInstall(app: ProvisionedAppRecord, code: string, redirectUrl: string): Promise<Record<string, unknown>>
  deleteApp(app: ProvisionedAppRecord): Promise<void>
  /** Renames the app (name and handle) and sets a new icon; what is absent stays. */
  updateApp(app: ProvisionedAppRecord, input: Partial<AgentAppIdentity>): Promise<{ iconSet?: boolean }>
}

/** Provisioning credentials that can't be renewed: an admin must add new ones. */
export class ProvisioningCredentialsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProvisioningCredentialsError'
  }
}

/** Credentials a provider refused, with a message an admin can act on. */
export class DirectoryConnectError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DirectoryConnectError'
  }
}
