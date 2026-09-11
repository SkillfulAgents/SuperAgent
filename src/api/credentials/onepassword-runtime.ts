import fs from 'fs'
import path from 'path'
import { getEnhancedPath } from '@shared/lib/container/base-container-client'
import {
  listAccounts,
  listLoginItems,
  OpError,
  readLoginFields,
  type OpErrorCode,
} from '@shared/lib/onepassword/op-client'
import {
  buildCredentialIndex,
  matchCandidates,
  searchItemsByTitle,
  type CredentialCandidate,
  type CredentialIndex,
  type VaultSearchHit,
} from '@shared/lib/onepassword/credential-index'
import type { OpAccount, OpLoginItem } from '@shared/lib/onepassword/op-schema'
import type { RetrievedCredential } from './types'

export type OnePasswordRuntimeState =
  | { state: 'none' }
  | { state: 'building' }
  | { state: 'ready'; builtAt: number }
  | { state: 'failed'; code: OpErrorCode; message: string }

export interface RuntimeCandidate extends CredentialCandidate {
  providerKey: string
}

export interface RuntimeSearchHit extends VaultSearchHit {
  providerKey: string
}

type IndexedLogin = OpLoginItem & { accountUuid: string }

export interface OnePasswordOps {
  listAccounts(signal?: AbortSignal): Promise<OpAccount[]>
  listLoginItems(accountUuid: string, signal?: AbortSignal): Promise<OpLoginItem[]>
  readLoginFields(itemId: string, accountUuid: string, signal?: AbortSignal): Promise<{ username: string; password: string }>
  opBinaryPresent(): boolean
  appPresent(): boolean
}

const ONE_PASSWORD_APP = '/Applications/1Password.app'

function pathHasOp(): boolean {
  return getEnhancedPath().split(path.delimiter).some((dir) => (
    dir.length > 0 && fs.existsSync(path.join(dir, process.platform === 'win32' ? 'op.exe' : 'op'))
  ))
}

const defaultOps: OnePasswordOps = {
  listAccounts,
  listLoginItems,
  readLoginFields,
  opBinaryPresent: pathHasOp,
  appPresent: () => fs.existsSync(ONE_PASSWORD_APP),
}

function providerKeyOf(accountUuid: string, itemId: string): string {
  return `${accountUuid}:${itemId}`
}

function splitProviderKey(providerKey: string): { accountUuid: string; itemId: string } | null {
  const separator = providerKey.indexOf(':')
  if (separator <= 0 || separator === providerKey.length - 1) return null
  return {
    accountUuid: providerKey.slice(0, separator),
    itemId: providerKey.slice(separator + 1),
  }
}

export class OnePasswordRuntime {
  private epoch = 0
  private stateValue: OnePasswordRuntimeState = { state: 'none' }
  private connecting: Promise<void> | null = null
  private buildController: AbortController | null = null
  private retrieveControllers = new Set<AbortController>()
  private items = new Map<string, IndexedLogin>()
  private index: CredentialIndex | null = null

  constructor(private readonly ops: OnePasswordOps = defaultOps) {}

  prerequisites(): { opInstalled: boolean; appInstalled: boolean } {
    return {
      opInstalled: this.ops.opBinaryPresent(),
      appInstalled: this.ops.appPresent(),
    }
  }

  state(): OnePasswordRuntimeState {
    return this.stateValue
  }

  isWarming(): boolean {
    return this.stateValue.state === 'building'
  }

  connect(): Promise<void> {
    if (this.connecting) return this.connecting
    if (this.stateValue.state === 'building') return Promise.resolve()

    const myEpoch = this.epoch
    const controller = new AbortController()
    this.buildController = controller
    this.stateValue = { state: 'building' }

    this.connecting = this.ops.listAccounts(controller.signal)
      .then((accounts) => {
        if (myEpoch !== this.epoch) return
        void this.build(accounts, myEpoch, controller.signal).catch((error) => {
          if (myEpoch !== this.epoch) return
          const failure = error instanceof OpError
            ? error
            : new OpError('unknown', error instanceof Error ? error.message : '1Password could not load your logins')
          this.stateValue = { state: 'failed', code: failure.code, message: failure.message }
          this.buildController = null
        })
      })
      .catch((error) => {
        if (myEpoch !== this.epoch) throw error
        const failure = error instanceof OpError
          ? error
          : new OpError('unknown', error instanceof Error ? error.message : '1Password could not connect')
        this.stateValue = { state: 'failed', code: failure.code, message: failure.message }
        throw failure
      })
      .finally(() => {
        if (myEpoch === this.epoch) this.connecting = null
      })

    return this.connecting
  }

  listCandidates(pageUrl: string): RuntimeCandidate[] {
    if (this.stateValue.state !== 'ready' || !this.index) {
      throw new OpError('unknown', '1Password logins are not ready')
    }
    return matchCandidates(this.index, pageUrl).map((candidate) => ({
      ...candidate,
      providerKey: candidate.itemId,
    }))
  }

  searchItems(query: string, limit = 20): RuntimeSearchHit[] {
    if (this.stateValue.state !== 'ready') {
      throw new OpError('unknown', '1Password logins are not ready')
    }
    const indexed = [...this.items.values()].map((item) => ({
      ...item,
      id: providerKeyOf(item.accountUuid, item.id),
    }))
    return searchItemsByTitle(indexed, query, limit).map((hit) => ({
      ...hit,
      providerKey: hit.itemId,
    }))
  }

  async retrieve(providerKey: string): Promise<RetrievedCredential> {
    const parts = splitProviderKey(providerKey)
    if (!parts || !this.items.has(providerKey)) {
      throw new OpError('unknown', 'The selected login is no longer available')
    }
    const controller = new AbortController()
    this.retrieveControllers.add(controller)
    try {
      return await this.ops.readLoginFields(parts.itemId, parts.accountUuid, controller.signal)
    } catch (error) {
      if (error instanceof OpError && error.code === 'item_unreadable') {
        this.evict(providerKey)
      }
      throw error
    } finally {
      this.retrieveControllers.delete(controller)
    }
  }

  evict(providerKey: string): void {
    this.items.delete(providerKey)
    this.rebuildIndex()
  }

  async shutdown(): Promise<void> {
    this.epoch++
    this.buildController?.abort()
    for (const controller of this.retrieveControllers) controller.abort()
    this.retrieveControllers.clear()
    this.connecting = null
    this.buildController = null
    this.items.clear()
    this.index = null
    this.stateValue = { state: 'none' }
  }

  private async build(accounts: OpAccount[], myEpoch: number, signal: AbortSignal): Promise<void> {
    const errors: OpError[] = []
    let successes = 0
    const collected: IndexedLogin[] = []

    for (const account of accounts) {
      if (myEpoch !== this.epoch) return
      try {
        const items = await this.ops.listLoginItems(account.account_uuid, signal)
        successes++
        for (const item of items) {
          collected.push({ ...item, accountUuid: account.account_uuid })
        }
      } catch (error) {
        if (error instanceof OpError) errors.push(error)
        else throw error
      }
    }

    if (myEpoch !== this.epoch) return
    if (successes === 0) {
      const first = errors[0] ?? new OpError('unknown', 'No 1Password logins could be loaded')
      this.stateValue = { state: 'failed', code: first.code, message: first.message }
      this.buildController = null
      return
    }

    this.items = new Map(collected.map((item) => [providerKeyOf(item.accountUuid, item.id), item]))
    this.rebuildIndex()
    this.stateValue = { state: 'ready', builtAt: Date.now() }
    this.buildController = null
  }

  private rebuildIndex(): void {
    this.index = buildCredentialIndex([...this.items.values()].map((item) => ({
      ...item,
      id: providerKeyOf(item.accountUuid, item.id),
    })))
  }
}
