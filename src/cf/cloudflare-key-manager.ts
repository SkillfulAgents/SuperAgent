/**
 * Key custody on Cloudflare, on BaseKeyManager. Desktop keeps the key in the OS secure store and
 * the server reads it from its environment; a Worker reads it from a secret set on its script.
 * A Worker has no disk to keep a key it made, so a missing secret is an error, never a new key.
 * Secrets Store can replace the secret later without changing any caller.
 */
import { BaseKeyManager, consoleKeyLog, type KeyLog, type ResolvedKey } from '@shared/lib/keys/base-key-manager'
import { KeyUnavailableError, type KeyProbes, type KeyPurpose } from '@shared/lib/keys/key-manager'
import { decodeKey } from '@shared/lib/keys/key-material'
import { SERVER_KEY_CONFIG } from '@shared/lib/keys/server-key-manager'
import type { Env } from './index'

export interface CloudflareKeyManagerOptions {
  /** The Worker's bindings, its secrets among them. */
  env: Pick<Env, 'SUPERAGENT_VAULT_KEY'>
  probes: KeyProbes
  log?: KeyLog
}

const ASK_ADMIN = 'The Browser Vault key is not set on this server, so saved logins cannot be used or saved. Ask its administrator to set it.'
const MISMATCH = 'The Browser Vault key on this server does not open the saved logins. Ask its administrator to restore the key they were saved with, or delete those logins in Settings → Logins.'

export class CloudflareKeyManager extends BaseKeyManager {
  readonly name = 'cloudflare'
  private readonly env: Readonly<Record<string, string | undefined>>

  constructor(options: CloudflareKeyManagerOptions) {
    super(options.probes, options.log ?? consoleKeyLog)
    this.env = options.env
  }

  protected async resolve(purpose: KeyPurpose, { create }: { create: boolean }): Promise<ResolvedKey | null> {
    const secret = SERVER_KEY_CONFIG[purpose].valueEnv
    const text = this.env[secret]?.trim()
    if (!text) {
      if (!create) return null
      throw new KeyUnavailableError(purpose, 'missing', `Set the Worker secret ${secret}: a Worker cannot keep a key it makes`, ASK_ADMIN)
    }
    const bytes = decodeKey(text)
    if (!bytes) throw new KeyUnavailableError(purpose, 'misconfigured', `${secret} does not hold a key (32 bytes, base64)`, ASK_ADMIN)
    await this.verifyAgainstData(purpose, bytes, `the Worker secret ${secret}`, MISMATCH)
    return { bytes, custody: 'deployment-secret' }
  }
}
