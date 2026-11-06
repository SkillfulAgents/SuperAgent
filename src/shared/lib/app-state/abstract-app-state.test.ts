import { backgroundSettled } from '@shared/lib/background'
import type { CounterBounds, EventSink, KeyPolicy } from './abstract-app-state'
import type { Expiry, Revision } from './contract'
import { LocalAppState, LocalAppStateBackend } from './local-app-state'
import { describeAppStateConformance } from './testing/conformance'

const nextTurn = () => new Promise((resolve) => setImmediate(resolve))

/** Local storage that answers each operation a turn later, as a remote authority does. */
class AnsweringLater extends LocalAppState {
  protected override async readEntries(fullKeys: readonly string[]) {
    await nextTurn()
    return super.readEntries(fullKeys)
  }
  protected override async writeEntry(fullKey: string, json: string, policy: KeyPolicy, expiry?: Expiry) {
    await nextTurn()
    return super.writeEntry(fullKey, json, policy, expiry)
  }
  protected override async removeEntry(fullKey: string) {
    await nextTurn()
    return super.removeEntry(fullKey)
  }
  protected override async insertEntry(fullKey: string, json: string, policy: KeyPolicy, expiry?: Expiry) {
    await nextTurn()
    return super.insertEntry(fullKey, json, policy, expiry)
  }
  protected override async compareAndSetEntry(fullKey: string, expected: Revision | null, json: string, policy: KeyPolicy, expiry?: Expiry) {
    await nextTurn()
    return super.compareAndSetEntry(fullKey, expected, json, policy, expiry)
  }
  protected override async incrementEntry(
    fullKey: string,
    delta: number,
    bounds: CounterBounds,
    limits: CounterBounds,
    policy: KeyPolicy,
    expiry?: Expiry,
  ) {
    await nextTurn()
    return super.incrementEntry(fullKey, delta, bounds, limits, policy, expiry)
  }
  protected override async consumeEntry(fullKey: string, revision?: Revision) {
    await nextTurn()
    return super.consumeEntry(fullKey, revision)
  }
  protected override async publishEvent(fullChannel: string, json: string) {
    await nextTurn()
    return super.publishEvent(fullChannel, json)
  }
  protected override async listen(fullChannels: readonly string[], sink: EventSink) {
    await nextTurn()
    const stop = await super.listen(fullChannels, sink)
    return async () => {
      await nextTurn()
      await stop()
    }
  }
}

describeAppStateConformance('AppState over storage that answers later', () => {
  let now = Date.parse('2026-11-04T12:00:00Z')
  const backend = new LocalAppStateBackend({ now: () => now })
  return {
    open: (scope) => new AnsweringLater(scope, backend),
    advance: (ms) => {
      now += ms
    },
    settled: async () => {
      await nextTurn()
      await backgroundSettled()
    },
  }
})
