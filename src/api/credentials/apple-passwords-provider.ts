import type {
  CredentialLookupContext,
  CredentialProviderConnection,
  CredentialProviderItem,
  CredentialProviderResult,
  PairableCredentialProvider,
  RetrievedCredential,
  CredentialProviderRemediation,
} from './types'
import { CredentialBrokerError } from './types'
import {
  ApplePasswordsRuntime,
  ApplePasswordsRuntimeError,
  type ApplePasswordsRuntimeLike,
} from './apple-passwords-runtime'
import {
  APPLE_PASSWORDS_BROWSER_SUPPORT_URL,
  APPLE_PASSWORDS_CHROME_EXTENSION_URL,
  GOOGLE_CHROME_DOWNLOAD_URL,
} from '@shared/lib/credentials/apple-passwords-links'

interface ApplePasswordEntry {
  USR: string
  PWD?: string
  sites: string[]
  customTitle?: string
}

function entriesFromPayload(payload: unknown): ApplePasswordEntry[] {
  if (!payload || typeof payload !== 'object') {
    throw new CredentialBrokerError('provider_error', 'Apple Passwords returned an invalid response')
  }
  const value = payload as Record<string, unknown>
  if (value.STATUS === 3) return []
  if (value.STATUS !== 0) {
    throw new CredentialBrokerError('provider_error', 'Apple Passwords could not complete the request')
  }
  const rawEntries = Array.isArray(value.Entries)
    ? value.Entries
    : Object.entries(value)
      .filter(([key]) => /^Entry_\d+$/.test(key))
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
      .map(([, entry]) => entry)

  return rawEntries.flatMap((entry): ApplePasswordEntry[] => {
    if (!entry || typeof entry !== 'object') return []
    const item = entry as Record<string, unknown>
    if (typeof item.USR !== 'string' || !Array.isArray(item.sites)) return []
    const sites = item.sites.filter((site): site is string => typeof site === 'string')
    if (sites.length === 0) return []
    return [{
      USR: item.USR,
      sites,
      ...(typeof item.PWD === 'string' ? { PWD: item.PWD } : {}),
      ...(typeof item.customTitle === 'string' ? { customTitle: item.customTitle } : {}),
    }]
  })
}

function mapRuntimeError(error: unknown): CredentialBrokerError {
  if (error instanceof CredentialBrokerError) return error
  if (error instanceof ApplePasswordsRuntimeError) {
    if (error.code === 'not_paired' || error.code === 'pairing_failed') {
      return new CredentialBrokerError('provider_locked', error.message)
    }
    return new CredentialBrokerError('provider_error', error.message)
  }
  return new CredentialBrokerError('provider_error', 'Apple Passwords could not complete the request')
}

function remediationForRuntimeError(
  error: ApplePasswordsRuntimeError,
): CredentialProviderRemediation | undefined {
  switch (error.code) {
    case 'unsupported_platform':
      return {
        code: error.code,
        title: 'Apple Passwords requires macOS',
        instructions: ['Use this provider on a Mac running macOS Sonoma or later.'],
        action: {
          kind: 'open_url',
          label: 'View Apple instructions',
          url: APPLE_PASSWORDS_BROWSER_SUPPORT_URL,
        },
      }
    case 'chrome_missing':
      return {
        code: error.code,
        title: 'Install Google Chrome',
        instructions: [
          'Install Google Chrome, then return here and refresh the password-manager check.',
        ],
        action: {
          kind: 'open_url',
          label: 'Download Chrome',
          url: GOOGLE_CHROME_DOWNLOAD_URL,
        },
      }
    case 'extension_not_found':
      return {
        code: error.code,
        title: 'Install the iCloud Passwords extension',
        instructions: [
          'Open the extension in Chrome and choose Add to Chrome.',
          'Return here and refresh. The extension only needs to remain installed in a Chrome profile.',
        ],
        action: {
          kind: 'open_in_chrome',
          label: 'Install in Chrome',
          url: APPLE_PASSWORDS_CHROME_EXTENSION_URL,
        },
      }
    case 'native_host_missing':
      return {
        code: error.code,
        title: 'Apple Passwords support is unavailable',
        instructions: [
          'Update macOS, then open Passwords and choose Passwords → Get Browser Extension.',
        ],
        action: {
          kind: 'open_url',
          label: 'View Apple instructions',
          url: APPLE_PASSWORDS_BROWSER_SUPPORT_URL,
        },
      }
    default:
      return undefined
  }
}

function lookupHostname(context: CredentialLookupContext): string {
  try {
    return new URL(context.url).hostname
  } catch {
    throw new CredentialBrokerError('provider_error', 'Apple Passwords received an invalid website URL')
  }
}

export class ApplePasswordsProvider implements PairableCredentialProvider {
  readonly id = 'apple-passwords'
  readonly label = 'Apple Passwords'

  constructor(private readonly runtime: ApplePasswordsRuntimeLike = new ApplePasswordsRuntime()) {}

  async connectionStatus(): Promise<CredentialProviderConnection> {
    try {
      const state = await this.runtime.state()
      return state.state === 'SessionKeySet'
        ? { provider: this.id, providerLabel: this.label, status: 'connected' }
        : {
            provider: this.id,
            providerLabel: this.label,
            status: 'disconnected',
            message: 'Connect to use passwords saved on this Mac',
          }
    } catch (error) {
      if (error instanceof ApplePasswordsRuntimeError) {
        if (
          error.code === 'unsupported_platform' ||
          error.code === 'extension_not_found' ||
          error.code === 'native_host_missing' ||
          error.code === 'chrome_missing'
        ) {
          return {
            provider: this.id,
            providerLabel: this.label,
            status: 'unavailable',
            message: error.message,
            remediation: remediationForRuntimeError(error),
          }
        }
      }
      return {
        provider: this.id,
        providerLabel: this.label,
        status: 'error',
        message: 'Apple Passwords connection could not be checked',
      }
    }
  }

  async list(context: CredentialLookupContext): Promise<CredentialProviderResult> {
    try {
      const state = await this.runtime.state()
      if (state.state !== 'SessionKeySet') {
        return {
          status: 'locked',
          message: 'Connect Apple Passwords to show saved logins',
          items: [],
        }
      }
      const entries = entriesFromPayload(await this.runtime.list(lookupHostname(context)))
      return {
        status: 'ready',
        items: entries.map((entry, index) => ({
          providerKey: `${index}:${entry.USR}`,
          username: entry.USR,
          domain: entry.sites[0],
          ...(entry.customTitle ? { title: entry.customTitle } : {}),
        })),
      }
    } catch (error) {
      if (error instanceof ApplePasswordsRuntimeError) {
        if (
          error.code === 'unsupported_platform' ||
          error.code === 'extension_not_found' ||
          error.code === 'native_host_missing' ||
          error.code === 'chrome_missing'
        ) {
          return { status: 'unavailable', message: error.message, items: [] }
        }
        if (error.code === 'not_paired') {
          return { status: 'locked', message: 'Connect Apple Passwords to show saved logins', items: [] }
        }
      }
      return { status: 'error', message: 'Apple Passwords could not be queried', items: [] }
    }
  }

  async retrieve(context: CredentialLookupContext, item: CredentialProviderItem): Promise<RetrievedCredential> {
    try {
      const entries = entriesFromPayload(await this.runtime.retrieve(lookupHostname(context), item.username))
      const entry = entries.find((candidate) => candidate.USR === item.username && candidate.PWD !== 'Not Included')
      if (!entry?.PWD) {
        throw new CredentialBrokerError('provider_error', 'The selected password could not be retrieved')
      }
      return { username: entry.USR, password: entry.PWD }
    } catch (error) {
      throw mapRuntimeError(error)
    }
  }

  async beginPairing(): Promise<{ status: 'ready' | 'pin_required' }> {
    try {
      return await this.runtime.beginPairing()
    } catch (error) {
      throw mapRuntimeError(error)
    }
  }

  async completePairing(pin: string): Promise<void> {
    try {
      await this.runtime.completePairing(pin)
    } catch (error) {
      throw mapRuntimeError(error)
    }
  }

  async shutdown(): Promise<void> {
    await this.runtime.shutdown()
  }
}
