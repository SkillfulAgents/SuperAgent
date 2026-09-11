import {
  ONEPASSWORD_CLI_GUIDE_URL,
  ONEPASSWORD_DOWNLOAD_URL,
} from '@shared/lib/credentials/onepassword-links'
import { OpError } from '@shared/lib/onepassword/op-client'
import {
  OnePasswordRuntime,
  type OnePasswordRuntimeState,
  type RuntimeCandidate,
  type RuntimeSearchHit,
} from './onepassword-runtime'
import type {
  CredentialLookupContext,
  CredentialProviderConnection,
  CredentialProviderItem,
  CredentialProviderRemediation,
  CredentialProviderResult,
  ManagedCredentialProvider,
  PairableCredentialProvider,
  RetrievedCredential,
  SearchableCredentialProvider,
} from './types'
import { CredentialBrokerError } from './types'

export interface OnePasswordRuntimeLike {
  prerequisites(): { opInstalled: boolean; appInstalled: boolean }
  state(): OnePasswordRuntimeState
  isWarming(): boolean
  connect(): Promise<void>
  listCandidates(pageUrl: string): RuntimeCandidate[]
  searchItems(query: string, limit?: number): RuntimeSearchHit[]
  retrieve(providerKey: string): Promise<RetrievedCredential>
  shutdown(): Promise<void>
}

function mapRuntimeError(error: unknown): CredentialBrokerError {
  if (error instanceof CredentialBrokerError) return error
  if (error instanceof OpError) {
    if (error.code === 'unlock_denied' || error.code === 'not_signed_in' || error.code === 'cli_integration_off') {
      return new CredentialBrokerError('provider_locked', error.message)
    }
    if (error.code === 'item_unreadable') {
      return new CredentialBrokerError('provider_error', 'Refresh the available credentials and try again')
    }
    return new CredentialBrokerError('provider_error', error.message)
  }
  return new CredentialBrokerError('provider_error', '1Password could not complete the request')
}

function remediationFor(prereqs: { opInstalled: boolean; appInstalled: boolean }): CredentialProviderRemediation {
  const appStep = 'Download and install the 1Password desktop app, then sign in.'
  const cliSteps = [
    'Install the 1Password command-line tool (op).',
    'In 1Password, turn on Settings → Developer → Integrate with 1Password CLI.',
  ]
  const refresh = 'Return here and refresh.'
  const instructions = [
    ...(!prereqs.appInstalled ? [appStep] : []),
    ...(!prereqs.opInstalled ? cliSteps : []),
    refresh,
  ]
  const downloadApp = !prereqs.appInstalled
  return {
    code: !prereqs.appInstalled && !prereqs.opInstalled ? 'onepassword_missing' : !prereqs.appInstalled ? 'app_missing' : 'cli_missing',
    title: 'Set up 1Password',
    instructions,
    action: {
      kind: 'open_url',
      label: downloadApp ? 'Download 1Password' : 'Install the 1Password CLI',
      url: downloadApp ? ONEPASSWORD_DOWNLOAD_URL : ONEPASSWORD_CLI_GUIDE_URL,
    },
  }
}

function mapCandidate(candidate: RuntimeCandidate): CredentialProviderItem {
  return {
    providerKey: candidate.providerKey,
    ...(candidate.username ? { username: candidate.username } : {}),
    ...(candidate.host ? { domain: candidate.host } : {}),
    ...(candidate.title ? { title: candidate.title } : {}),
  }
}

function mapSearchHit(hit: RuntimeSearchHit): CredentialProviderItem {
  return {
    providerKey: hit.providerKey,
    ...(hit.username ? { username: hit.username } : {}),
    ...(hit.title ? { title: hit.title } : {}),
  }
}

export class OnePasswordProvider implements
  PairableCredentialProvider,
  SearchableCredentialProvider,
  ManagedCredentialProvider
{
  readonly id = 'onepassword'
  readonly label = '1Password'

  constructor(private readonly runtime: OnePasswordRuntimeLike = new OnePasswordRuntime()) {}

  isWarming(): boolean {
    return this.runtime.isWarming()
  }

  async connectionStatus(): Promise<CredentialProviderConnection> {
    const prereqs = this.runtime.prerequisites()
    const installable = process.platform === 'darwin'
    if (!prereqs.opInstalled || !prereqs.appInstalled) {
      return {
        provider: this.id,
        providerLabel: this.label,
        installable,
        status: 'unavailable',
        remediation: remediationFor(prereqs),
      }
    }

    const state = this.runtime.state()
    if (state.state === 'ready' || state.state === 'building') {
      return {
        provider: this.id,
        providerLabel: this.label,
        installable,
        status: 'connected',
      }
    }
    if (state.state === 'failed') {
      return {
        provider: this.id,
        providerLabel: this.label,
        installable,
        status: 'disconnected',
        message: state.message,
      }
    }
    return {
      provider: this.id,
      providerLabel: this.label,
      installable,
      status: 'disconnected',
      message: "You'll approve access in the 1Password app when needed",
    }
  }

  async list(context: CredentialLookupContext): Promise<CredentialProviderResult> {
    const prereqs = this.runtime.prerequisites()
    if (!prereqs.opInstalled || !prereqs.appInstalled) {
      return { status: 'unavailable', items: [] }
    }

    const state = this.runtime.state()
    if (state.state === 'building') {
      return { status: 'warming', items: [] }
    }
    if (state.state === 'failed') {
      return {
        status: 'locked',
        message: `1Password couldn't load your logins: ${state.message}. Check again.`,
        items: [],
      }
    }
    if (state.state !== 'ready') {
      return {
        status: 'locked',
        message: 'Check your password manager to show saved logins for this page',
        items: [],
      }
    }

    try {
      return {
        status: 'ready',
        items: this.runtime.listCandidates(context.url).map(mapCandidate),
      }
    } catch (error) {
      if (error instanceof OpError) {
        if (error.code === 'unlock_denied' || error.code === 'not_signed_in' || error.code === 'cli_integration_off') {
          return { status: 'locked', message: error.message, items: [] }
        }
        return { status: 'error', message: error.message, items: [] }
      }
      return { status: 'error', message: '1Password could not be queried', items: [] }
    }
  }

  async search(query: string): Promise<CredentialProviderItem[]> {
    try {
      return this.runtime.searchItems(query).map(mapSearchHit)
    } catch (error) {
      throw mapRuntimeError(error)
    }
  }

  async retrieve(_context: CredentialLookupContext, item: CredentialProviderItem): Promise<RetrievedCredential> {
    try {
      return await this.runtime.retrieve(item.providerKey)
    } catch (error) {
      throw mapRuntimeError(error)
    }
  }

  async beginPairing(): Promise<{ status: 'ready' | 'pin_required' }> {
    try {
      await this.runtime.connect()
      return { status: 'ready' }
    } catch (error) {
      throw mapRuntimeError(error)
    }
  }

  async completePairing(_pin: string): Promise<void> {
    throw new CredentialBrokerError('provider_error', '1Password does not use a pairing code')
  }

  async shutdown(): Promise<void> {
    await this.runtime.shutdown()
  }
}
