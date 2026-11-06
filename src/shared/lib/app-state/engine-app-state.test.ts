import { backgroundSettled } from '@shared/lib/background'
import { createAppState } from './engine-app-state'
import type { AppStateEngine } from './engine'
import { LocalAppStateBackend } from './local-app-state'
import { describeAppStateConformance } from './testing/conformance'

/** The local engine, answering each call a turn later, as an engine across the network does. */
function answeringLater(engine: LocalAppStateBackend): AppStateEngine {
  const later = <A extends unknown[], R>(call: (...args: A) => R) => async (...args: A): Promise<R> => {
    await new Promise((resolve) => setImmediate(resolve))
    return call(...args)
  }
  return {
    read: later((key) => engine.read(key)),
    readMany: later((keys) => engine.readMany(keys)),
    write: later((key, json, policy, expiry) => engine.write(key, json, policy, expiry)),
    remove: later((key) => engine.remove(key)),
    insertIfAbsent: later((key, json, policy, expiry) => engine.insertIfAbsent(key, json, policy, expiry)),
    compareAndSet: later((key, expected, json, policy, expiry) => engine.compareAndSet(key, expected, json, policy, expiry)),
    increment: later((key, delta, bounds, policy, expiry) => engine.increment(key, delta, bounds, policy, expiry)),
    consume: later((key, revision) => engine.consume(key, revision)),
    publish: later((channel, json) => engine.publish(channel, json)),
    subscribe: later((channels, subscriber) => {
      const stop = engine.subscribe(channels, subscriber)
      return later(stop)
    }),
  }
}

describeAppStateConformance('AppState over an engine that answers later', () => {
  let now = Date.parse('2026-11-04T12:00:00Z')
  const engine = answeringLater(new LocalAppStateBackend({ now: () => now }))
  return {
    open: (scope) => createAppState({ scope, engine }),
    advance: (ms) => {
      now += ms
    },
    settled: async () => {
      await new Promise((resolve) => setImmediate(resolve))
      await backgroundSettled()
    },
  }
})
