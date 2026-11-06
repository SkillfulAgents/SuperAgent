/**
 * The parts of the Workers runtime src/cf uses, typed as its `cloudflare:workers` module.
 * @cloudflare/workers-types replaces the DOM library the app is type-checked with, so the two
 * cannot share one program; these declarations keep src/cf in the app's type check.
 */
declare module 'cloudflare:workers' {
  export interface ExecutionContext {
    waitUntil(promise: Promise<unknown>): void
    passThroughOnException(): void
    readonly props: unknown
  }

  export interface ExportedHandler<Env> {
    fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>
  }

  export interface Fetcher {
    fetch(request: Request): Promise<Response>
  }

  export interface D1PreparedStatement {
    bind(...values: unknown[]): D1PreparedStatement
    raw<T = unknown[]>(): Promise<T[]>
  }

  export interface D1Database {
    prepare(query: string): D1PreparedStatement
    batch(statements: D1PreparedStatement[]): Promise<unknown[]>
  }

  export type SqlStorageValue = ArrayBuffer | string | number | null

  export interface SqlStorageCursor<T> {
    toArray(): T[]
    one(): T
  }

  export interface SqlStorage {
    exec<T extends Record<string, SqlStorageValue> = Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]): SqlStorageCursor<T>
  }

  /** A WebSocket as the runtime hands it out: this end accepts it, and it can carry a hibernation attachment. */
  export interface WorkerWebSocket extends WebSocket {
    accept(): void
    serializeAttachment(value: unknown): void
    deserializeAttachment(): unknown
  }

  export interface DurableObjectStorage {
    readonly sql: SqlStorage
    getAlarm(): Promise<number | null>
    setAlarm(scheduledTime: number): Promise<void>
    deleteAlarm(): Promise<void>
  }

  export interface DurableObjectState {
    readonly id: { readonly name?: string; toString(): string }
    readonly storage: DurableObjectStorage
    acceptWebSocket(socket: WorkerWebSocket): void
    getWebSockets(): WorkerWebSocket[]
  }

  /** A Durable Object's methods as its stub calls them: each one answers asynchronously. */
  export type DurableObjectStub<T> = {
    [K in keyof T as T[K] extends (...args: never[]) => unknown ? K : never]: T[K] extends (...args: infer A) => infer R
      ? (...args: A) => Promise<Awaited<R>>
      : never
  }

  export interface DurableObjectNamespace<T> {
    getByName(name: string): DurableObjectStub<T>
  }

  export abstract class DurableObject<Env = unknown> {
    protected readonly ctx: DurableObjectState
    protected readonly env: Env
    constructor(ctx: DurableObjectState, env: Env)
  }
}

declare const WebSocketPair: {
  new (): { 0: import('cloudflare:workers').WorkerWebSocket; 1: import('cloudflare:workers').WorkerWebSocket }
}
