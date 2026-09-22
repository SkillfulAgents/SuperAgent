import { MessageNotAcceptedError } from '../container/message-dispatch-error'
import { z } from 'zod'
import { captureException } from '../error-reporting'
import { InvalidDeliveryEnvelope, parseDeliveryEnvelope } from './delivery-schema'
import { deliveryStore, type DeliveryRecord } from './delivery-store'
import type { IntegrationInputEvent, IntegrationRoute } from './types'

const MAX_ATTEMPTS = 5
const RETRY_DELAYS = [1_000, 5_000, 30_000, 120_000]
export class DeliveryCancelled extends Error {}
export class PermanentDeliveryError extends Error {}
export interface DeliveryAttempt {
  readonly id: string
  /** Persist intent BEFORE invoking anything that can accept agent work. */
  handoff<T>(sessionId: string | undefined, send: () => Promise<T>, beforeSend?: () => void): Promise<T>
  /** A family may consume an input as an answer instead of starting a turn. */
  consume(sessionId: string, consume: () => Promise<boolean>, beforeSend?: () => void): Promise<boolean>
  bind(sessionId: string | null): Promise<void>
  /** Persist successful route notices independently of later dispatch retries. */
  notifyRoute(send: () => Promise<void>): Promise<void>
  /** Setup after acceptance survives transport replacement, but not cancellation. */
  assertOwned(): Promise<void>
  assertCurrent(): void
}
interface DeliveryHost {
  connectedIds(): readonly string[]
  dispatch(row: DeliveryRecord, attempt: DeliveryAttempt): Promise<void>
  reconcile(row: DeliveryRecord): Promise<boolean>
  notice(row: DeliveryRecord, beforeSend: () => Promise<void>): Promise<void>
}
function permanent(error: unknown): boolean {
  if (error instanceof PermanentDeliveryError || error instanceof InvalidDeliveryEnvelope || error instanceof z.ZodError) return true
  const status = typeof error === 'object' && error ? Reflect.get(error, 'status') ?? Reflect.get(error, 'statusCode') : undefined
  return [400, 401, 403, 404, 422].includes(status)
}

/** One durable handoff scheduler for every family. It never observes turn completion. */
export class IntegrationDeliveryQueue {
  private running = false
  private epoch = 0
  private timer?: ReturnType<typeof setTimeout>
  private timerAt = Infinity
  private pumping = false
  private repump = false
  private lastPrune = 0
  private active = new Map<string, Promise<void>>()
  constructor(private readonly host: DeliveryHost, private readonly store = deliveryStore) {}

  async start() { await this.store.recover(); this.running = true; this.epoch++; this.wake() }
  stop() { this.running = false; this.epoch++; clearTimeout(this.timer); this.timer = undefined; this.timerAt = Infinity; this.active.clear() }
  async accept(integrationId: string, event: IntegrationInputEvent, route: IntegrationRoute) {
    const accepted = await this.store.accept(integrationId, event, route)
    this.wake()
    return accepted
  }
  cancelSession(rowId: string) { return this.store.cancelSession(rowId) }
  cancel(integrationId: string, externalId?: string, exceptId?: string) { return this.store.cancel(integrationId, externalId, exceptId) }
  wake(delay = 0) {
    if (!this.running || this.timerAt <= Date.now() + delay) return
    clearTimeout(this.timer)
    this.timerAt = Date.now() + delay
    this.timer = setTimeout(() => {
      this.timerAt = Infinity
      void this.pump().catch(error => { this.report(error, 'schedule'); this.wake(5_000) })
    }, delay)
    this.timer.unref?.()
  }
  private async pump() {
    if (!this.running) return
    if (this.pumping) { this.repump = true; return }
    this.pumping = true
    try {
      if (Date.now() - this.lastPrune > 60 * 60 * 1000) {
        await this.store.prune()
        this.lastPrune = Date.now()
      }
      const rows = await this.store.due(this.host.connectedIds())
      if (!this.running) return
      for (const row of rows) {
        const key = JSON.stringify([row.integrationId, row.externalId, row.noticeState === 'pending' ? 'notice' : 'input'])
        if (this.active.has(key) || !this.host.connectedIds().includes(row.integrationId)) continue
        const delay = row.nextAttemptAt.getTime() - Date.now()
        if (delay > 0) {
          // Reserve this wake before another awaited query can cross the deadline
          // and mistake newly due work for a blocked lane's 30-second fallback.
          this.wake(Math.min(delay, 30_000))
          continue
        }
        const work = this.process(row).catch(error => this.report(error, 'process', row)).finally(() => {
          if (this.active.get(key) === work) this.active.delete(key)
          this.wake()
        })
        this.active.set(key, work)
      }
      // Offline rows must not mask a connected installation's earlier retry.
      // Connect/input/completion wakes immediately; this only schedules local work.
      const next = await this.store.nextDue(this.host.connectedIds())
      if (next) this.wake(next.at.getTime() > Date.now() ? Math.min(next.at.getTime() - Date.now(), 30_000) : 30_000)
      // Providers can reconnect internally without a manager connect callback.
      // Keep checking local offline work, but never let it postpone a live retry.
      else if (await this.store.nextDue()) this.wake(30_000)
    } finally {
      this.pumping = false
      if (this.repump) { this.repump = false; this.wake() }
    }
  }
  private async process(row: DeliveryRecord) {
    if (row.nextAttemptAt.getTime() > Date.now()) return
    const owner = crypto.randomUUID()
    const epoch = this.epoch
    const alive = () => {
      if (!this.running || this.epoch !== epoch) throw new DeliveryCancelled()
    }
    const current = () => {
      alive()
      if (!this.host.connectedIds().includes(row.integrationId)) throw new DeliveryCancelled()
    }
    if (row.state === 'sending') {
      if (await this.store.adopt(row, owner)) await this.reconcile({ ...row, owner }, owner)
      return
    }
    const notice = row.noticeState === 'pending'
    if (!(await this.store.claim(row, owner, notice))) return
    const attempts = (notice ? row.noticeAttempts : row.attempts) + 1
    if (notice) {
      if (attempts > MAX_ATTEMPTS) { await this.store.change(row.id, owner, { noticeState: 'failed', envelope: null }); return }
      try {
        current()
        await this.host.notice(row, async () => {
          current()
          if (!await this.store.ownsNotice(row.id, owner)) throw new DeliveryCancelled()
          current()
        })
        await this.store.change(row.id, owner, { noticeState: 'sent', envelope: null })
      } catch (error) {
        if (error instanceof DeliveryCancelled) {
          await this.store.change(row.id, owner, { noticeState: 'pending', owner: null, nextAttemptAt: this.retryAt(attempts) })
          return
        }
        const terminal = permanent(error) || attempts >= MAX_ATTEMPTS
        await this.store.change(row.id, owner, { noticeState: terminal ? 'failed' : 'pending',
          nextAttemptAt: this.retryAt(attempts), ...(terminal ? { envelope: null } : {}) })
        if (terminal) this.report(error, 'notice-exhausted', { ...row, noticeAttempts: attempts })
      }
      return
    }
    if (attempts > MAX_ATTEMPTS) {
      await this.store.change(row.id, owner, { state: 'failed', error: 'Dispatch retry budget exhausted', noticeState: 'pending', nextAttemptAt: new Date() })
      return
    }
    let handedOff = false
    let acknowledged = false
    const handoff = async <T>(sessionId: string | undefined, send: () => Promise<T>, beforeSend?: () => void): Promise<T> => {
      current()
      if (!(await this.store.handoff(row.id, owner, sessionId))) throw new DeliveryCancelled()
      current()
      // Checks after the write are still preparation: no runtime call has begun.
      // Keep a cancellation here retryable instead of treating it as an unknown send.
      beforeSend?.()
      handedOff = true
      row.sessionId = sessionId ?? null
      try {
        const result = await send()
        acknowledged = true
        return result
      }
      catch (error) {
        if (error instanceof MessageNotAcceptedError) {
          handedOff = false
          if (!(await this.store.change(row.id, owner, { state: 'preparing' }))) throw new DeliveryCancelled()
        }
        throw error
      }
    }
    try {
      current()
      await this.host.dispatch(row, { id: row.id, assertCurrent: current,
        handoff,
        assertOwned: async () => {
          alive()
          if (!await this.store.ownsInput(row.id, owner)) throw new DeliveryCancelled()
          alive()
        },
        bind: async sessionId => {
          // Recording accepted work must survive a connector rebuild/offline gap.
          // The owner and persisted installation status still fence pause/cancel.
          alive()
          if (!(await this.store.change(row.id, owner, { sessionId }))) throw new DeliveryCancelled()
          row.sessionId = sessionId
        },
        notifyRoute: async send => {
          const envelope = parseDeliveryEnvelope(row.envelope)
          if (!envelope.route.notice) return
          current()
          await send()
          delete envelope.route.notice
          const saved = JSON.stringify(envelope)
          if (!(await this.store.change(row.id, owner, { envelope: saved }))) throw new DeliveryCancelled()
          row.envelope = saved
        },
        consume: async (sessionId, consume, beforeSend) => {
          const consumed = await handoff(sessionId, consume, beforeSend)
          if (!consumed) {
            handedOff = false
            acknowledged = false
            if (!(await this.store.change(row.id, owner, { state: 'preparing' }))) throw new DeliveryCancelled()
          }
          return consumed
        },
      })
      await this.store.change(row.id, owner, { state: 'delivered', envelope: null })
    } catch (error) {
      if (acknowledged) {
        // New-session registration/stream attachment happens after creation
        // accepted the first input. Its failure cannot undo that evidence.
        const changed = await this.store.change(row.id, owner, { state: 'delivered', envelope: null })
        if (changed && !(error instanceof DeliveryCancelled)) this.report(error, 'after-handoff', row)
        return
      }
      if (error instanceof DeliveryCancelled) {
        // Pause/cancel writes fence the owner. A host shutdown leaves recovery
        // to the next start; a transport rebuild may safely retry preparation.
        await this.store.change(row.id, owner, { ...(handedOff ? {} : { state: 'pending' as const }), owner: null, nextAttemptAt: this.retryAt(attempts) })
        return
      }
      if (handedOff) { await this.reconcile({ ...row, owner }, owner, error); return }
      const terminal = permanent(error) || attempts >= MAX_ATTEMPTS
      await this.store.change(row.id, owner, { state: terminal ? 'failed' : 'pending',
        error: terminal ? 'Dispatch failed' : 'Dispatch will retry', noticeState: terminal ? 'pending' : 'none',
        nextAttemptAt: terminal ? new Date() : this.retryAt(attempts) })
      if (terminal) this.report(error, 'dispatch-exhausted', { ...row, attempts })
    }
  }
  private async reconcile(row: DeliveryRecord, owner: string, error?: unknown) {
    // Positive evidence only. Absence of a transcript entry is NOT evidence
    // that the runtime rejected the send (it may still be queued in memory).
    let accepted = false
    try { accepted = await this.host.reconcile(row) } catch { /* Unknown; never replay. */ }
    const changed = await this.store.change(row.id, owner, accepted
      ? { state: 'delivered', envelope: null }
      : { state: 'uncertain', error: 'Runtime acceptance could not be confirmed', noticeState: 'pending', nextAttemptAt: new Date() })
    if (changed && !accepted) this.report(error ?? new Error('Runtime acceptance could not be confirmed'), 'handoff-uncertain', row)
  }
  private retryAt(attempt: number) { return new Date(Date.now() + RETRY_DELAYS[Math.min(attempt - 1, RETRY_DELAYS.length - 1)]) }
  private report(error: unknown, operation: string, row?: DeliveryRecord) {
    captureException(error, { tags: { component: 'integration-delivery', operation },
      extra: row ? { deliveryId: row.id, integrationId: row.integrationId, attempts: row.attempts, noticeAttempts: row.noticeAttempts } : undefined })
  }
}
