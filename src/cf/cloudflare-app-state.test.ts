import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import type { DurableObjectNamespace, DurableObjectState, SqlStorage, SqlStorageValue, WorkerWebSocket } from 'cloudflare:workers'
import { describeAppStateConformance } from '@shared/lib/app-state/testing/conformance'
import { backgroundSettled } from '@shared/lib/background'
import { AppStateDurableObject, CloudflareAppState, type EventHub, type KeyPolicy } from './cloudflare-app-state'
import type { Env } from './index'

/** A Durable Object's `ctx.storage.sql` over an in-memory SQLite database. */
function memorySql(): SqlStorage {
  const db = new Database(':memory:')
  return {
    exec(query: string, ...bindings: SqlStorageValue[]) {
      const statement = db.prepare(query)
      let rows: unknown[] = []
      if (statement.reader) rows = statement.all(...bindings)
      else statement.run(...bindings)
      return { toArray: () => rows, one: () => rows[0] }
    },
  } as SqlStorage
}

/** An AppStateDurableObject whose clock the test moves. */
class TestObject extends AppStateDurableObject {
  clock = Date.UTC(2026, 10, 5)

  protected override now(): number {
    return this.clock
  }
}

function testObject(sql: SqlStorage = memorySql(), sockets: unknown[] = []): TestObject {
  const ctx = { id: { name: 'org', toString: () => 'org' }, storage: { sql, transactionSync: <T>(decide: () => T) => decide() }, getWebSockets: () => sockets, acceptWebSocket: () => {} }
  return new TestObject(ctx as unknown as DurableObjectState, {} as Env)
}

/** The object's methods as its stub calls them: later, on copies of the arguments and the answers. */
function namespaceOf(object: AppStateDurableObject): DurableObjectNamespace<AppStateDurableObject> {
  const stub = new Proxy({}, {
    get: (_target, name) => (...args: unknown[]) => Promise.resolve().then(() => {
      const method = Reflect.get(object, name) as (...methodArgs: unknown[]) => unknown
      return structuredClone(method.apply(object, structuredClone(args)))
    }),
  })
  return { getByName: () => stub } as unknown as DurableObjectNamespace<AppStateDurableObject>
}

/** The object's fan-out in memory: each publish reaches every connection subscribed to its channel. */
function memoryHub(): EventHub {
  const connections = new Set<{ channels: Set<string>; onEvent: (channel: string, json: string) => void }>()
  return {
    async publish(fullChannel, json) {
      for (const connection of [...connections]) if (connection.channels.has(fullChannel)) connection.onEvent(fullChannel, json)
    },
    async connect(fullChannels, onEvent) {
      const connection = { channels: new Set(fullChannels), onEvent }
      connections.add(connection)
      return { close: () => connections.delete(connection) }
    },
  }
}

describeAppStateConformance('CloudflareAppState', () => {
  const object = testObject()
  const objects = namespaceOf(object)
  const hub = memoryHub()
  return {
    open: (scope) => new CloudflareAppState(objects, { scope, hub }),
    advance: (ms) => {
      object.clock += ms
    },
    settled: () => backgroundSettled(),
  }
})

function socket(channels: string[]) {
  const sent: string[] = []
  return { sent, send: (message: string) => sent.push(message), deserializeAttachment: () => ({ channels }) } as unknown as WorkerWebSocket & { sent: string[] }
}

describe('AppStateDurableObject', () => {
  it('sends an event only to the sockets subscribed to its channel', () => {
    const sockets = [socket(['events:a', 'events:b']), socket(['events:b']), socket(['events:c'])]
    const object = testObject(memorySql(), sockets)

    expect(object.publish('events:b', '{"n":1}')).toEqual({ delivered: 2 })

    const message = JSON.stringify({ c: 'events:b', j: '{"n":1}' })
    expect(sockets.map((s) => s.sent)).toEqual([[message], [message], []])
  })

  it('accepts a subscription socket only on its path, with at least one channel', async () => {
    const object = testObject()
    const upgrade = { Upgrade: 'websocket' }
    expect((await object.fetch(new Request('https://app-state/other', { headers: upgrade }))).status).toBe(404)
    expect((await object.fetch(new Request('https://app-state/subscribe'))).status).toBe(404)
    expect((await object.fetch(new Request('https://app-state/subscribe', { headers: upgrade }))).status).toBe(400)
  })

  it('never issues a revision an earlier instance of the object issued', () => {
    const sql = memorySql()
    const policy: KeyPolicy = { name: 'test:lasting', consistency: 'strong', expiry: { ttlMs: null, onUpdate: 'keep' } }
    const first = testObject(sql)
    const before = first.write('k', '"a"', policy)

    const after = testObject(sql).write('k', '"a"', policy)

    expect(after.revision).not.toBe(before.revision)
    expect(first.compareAndSet('k', before.revision, '"b"', policy)).toMatchObject({ ok: false })
  })
})
