import fs from 'fs/promises'
import path from 'path'
import { BaseKeyManager, consoleKeyLog, type KeyLog, type ResolvedKey } from './base-key-manager'
import { KeyUnavailableError, type KeyProbes, type KeyPurpose } from './key-manager'
import { decodeKey, generateKeyBytes, encodeKey, readKeyFile, sameKey, writeFileExclusive } from './key-material'

/**
 * Key custody for the web server (and the Vite dev server): the deployment
 * provides the key, as an environment variable or a mounted secret file. An
 * install that sets neither keeps the plaintext key file in its data directory,
 * as every install did before KeyManager — made on first use when nothing is
 * sealed yet, never made again over sealed data. That legacy file is read only
 * here.
 */

interface PurposeConfig {
  /** The key itself, base64. */
  valueEnv: string
  /** A path to a file holding the key (a secret mount). */
  fileEnv: string
  /** The data-directory key file of installs that configure neither. */
  legacyFile: string
}

export const SERVER_KEY_CONFIG: Readonly<Record<KeyPurpose, PurposeConfig>> = {
  'browser-vault': { valueEnv: 'SUPERAGENT_VAULT_KEY', fileEnv: 'SUPERAGENT_VAULT_KEY_FILE', legacyFile: '.vault-key' },
}

export interface ServerKeyManagerOptions {
  /** The data directory of the scope this manager serves. */
  dataDir: string
  /** Read once, here: the manager's configuration does not follow later env changes. */
  env?: Readonly<Record<string, string | undefined>>
  probes: KeyProbes
  log?: KeyLog
}

type Configured =
  | { kind: 'none' }
  | { kind: 'value'; name: string; text: string }
  | { kind: 'file'; name: string; filePath: string }
  | { kind: 'both'; names: [string, string] }

const ASK_ADMIN = 'The Browser Vault key is not available on this server, so saved logins cannot be used or saved. Ask its administrator to check the vault key configuration.'
const MISMATCH = 'The Browser Vault key on this server does not open the saved logins. Ask its administrator to restore the key they were saved with, or delete those logins in Settings → Logins.'
const MISSING = 'Saved logins on this server were sealed with a vault key it does not have. Ask its administrator to restore that key, or delete those logins in Settings → Logins.'

export class ServerKeyManager extends BaseKeyManager {
  readonly name = 'server'
  private readonly dataDir: string
  private readonly configured: Readonly<Record<KeyPurpose, Configured>>

  constructor(options: ServerKeyManagerOptions) {
    super(options.probes, options.log ?? consoleKeyLog)
    this.dataDir = path.resolve(options.dataDir)
    const env = options.env ?? process.env
    this.configured = Object.fromEntries(
      (Object.keys(SERVER_KEY_CONFIG) as KeyPurpose[]).map((purpose) => [purpose, configuredFor(SERVER_KEY_CONFIG[purpose], env)]),
    ) as Record<KeyPurpose, Configured>
  }

  private legacyPath(purpose: KeyPurpose): string {
    return path.join(this.dataDir, SERVER_KEY_CONFIG[purpose].legacyFile)
  }

  protected async resolve(purpose: KeyPurpose, { create }: { create: boolean }): Promise<ResolvedKey | null> {
    const configured = this.configured[purpose]
    if (configured.kind !== 'none') return this.fromDeployment(purpose, configured)
    return this.fromLegacyFile(purpose, create)
  }

  private async fromDeployment(purpose: KeyPurpose, configured: Exclude<Configured, { kind: 'none' }>): Promise<ResolvedKey> {
    if (configured.kind === 'both') {
      throw new KeyUnavailableError(purpose, 'misconfigured', `Both ${configured.names.join(' and ')} are set: set one`, ASK_ADMIN)
    }
    let bytes: Buffer | null
    if (configured.kind === 'value') {
      bytes = decodeKey(configured.text)
    } else {
      let text: string
      try {
        text = await fs.readFile(configured.filePath, 'utf-8')
      } catch (error) {
        throw new KeyUnavailableError(purpose, 'misconfigured', `${configured.name} names a file that could not be read (${(error as NodeJS.ErrnoException).code ?? 'error'})`, ASK_ADMIN)
      }
      bytes = decodeKey(text)
    }
    // Never the value: only which setting is wrong.
    if (!bytes) throw new KeyUnavailableError(purpose, 'misconfigured', `${configured.name} does not hold a key (32 bytes, base64)`, ASK_ADMIN)
    await this.verifyAgainstData(purpose, bytes, configured.name, MISMATCH)

    const legacy = await readKeyFile(this.legacyPath(purpose))
    if (legacy.state === 'key') {
      this.log.warn(sameKey(legacy.bytes, bytes)
        ? `[keys] ${this.legacyPath(purpose)} holds the same key as ${configured.name} and is no longer read: it can be deleted`
        : `[keys] ${this.legacyPath(purpose)} holds a different key than ${configured.name} and is ignored`)
    }
    return { bytes, custody: 'deployment-secret' }
  }

  private async fromLegacyFile(purpose: KeyPurpose, create: boolean): Promise<ResolvedKey | null> {
    const keyPath = this.legacyPath(purpose)
    const { valueEnv, fileEnv } = SERVER_KEY_CONFIG[purpose]
    for (let attempt = 0; attempt < 2; attempt++) {
      const read = await readKeyFile(keyPath)
      if (read.state === 'key') {
        await this.verifyAgainstData(purpose, read.bytes, keyPath, MISMATCH)
        this.log.info(`[keys] Set ${valueEnv} or ${fileEnv} to keep the ${purpose} key out of the data directory (${keyPath})`)
        return { bytes: read.bytes, custody: 'plaintext-file' }
      }
      if (read.state === 'invalid') {
        throw new KeyUnavailableError(purpose, 'corrupt', `${keyPath} does not hold a key; it is never written over`, ASK_ADMIN)
      }
      if (read.state === 'unreadable') {
        throw new KeyUnavailableError(purpose, 'io', `${keyPath} could not be read (${read.code})`, ASK_ADMIN)
      }
      if (!create) return null
      const candidate = generateKeyBytes()
      if (await this.somethingSealed(purpose, candidate)) {
        throw new KeyUnavailableError(purpose, 'missing', `Data is sealed under ${purpose} but there is no key: set ${valueEnv} or ${fileEnv}, or restore ${keyPath}`, MISSING)
      }
      try {
        // Exclusive: two processes starting at once keep one key, not two.
        if (await writeFileExclusive(keyPath, encodeKey(candidate)) === 'created') return { bytes: candidate, custody: 'plaintext-file' }
      } catch (error) {
        throw new KeyUnavailableError(purpose, 'io', `${keyPath} could not be written (${(error as NodeJS.ErrnoException).code ?? 'error'})`, ASK_ADMIN)
      }
      // Another process made it first: use theirs.
    }
    throw new KeyUnavailableError(purpose, 'io', `${keyPath} kept changing while it was read`, ASK_ADMIN)
  }
}

function configuredFor(config: PurposeConfig, env: Readonly<Record<string, string | undefined>>): Configured {
  const value = env[config.valueEnv]?.trim()
  const file = env[config.fileEnv]?.trim()
  if (value && file) return { kind: 'both', names: [config.valueEnv, config.fileEnv] }
  if (value) return { kind: 'value', name: config.valueEnv, text: value }
  if (file) return { kind: 'file', name: config.fileEnv, filePath: path.resolve(file) }
  return { kind: 'none' }
}
