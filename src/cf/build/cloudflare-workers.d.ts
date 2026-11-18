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
    /** Runs `closure` as one transaction: it commits all its writes, or none if it throws. */
    transactionSync<T>(closure: () => T): T
    getAlarm(): Promise<number | null>
    setAlarm(scheduledTime: number): Promise<void>
    deleteAlarm(): Promise<void>
  }

  export interface DurableObjectState {
    readonly id: { readonly name?: string; toString(): string }
    readonly storage: DurableObjectStorage
    acceptWebSocket(socket: WorkerWebSocket): void
    getWebSockets(): WorkerWebSocket[]
    /** Keeps the object alive until the work settles. */
    waitUntil(promise: Promise<unknown>): void
    abort(reason?: string): void
  }

  /** A Durable Object's methods as its stub calls them: each one answers asynchronously. */
  export type DurableObjectStub<T> = {
    [K in keyof T as T[K] extends (...args: never[]) => unknown ? K : never]: T[K] extends (...args: infer A) => infer R
      ? (...args: A) => Promise<Awaited<R>>
      : never
  }

  export interface DurableObjectNamespace<T> {
    /** `locationHint`: where a new object is made (object-location.ts); an object that exists ignores it. */
    getByName(name: string, options?: { locationHint?: string }): DurableObjectStub<T>
  }

  export interface R2ObjectBody {
    readonly body: ReadableStream<Uint8Array>
    arrayBuffer(): Promise<ArrayBuffer>
  }

  export interface R2Objects {
    objects: Array<{ key: string; size: number }>
    truncated: boolean
    cursor?: string
  }

  export interface R2Bucket {
    get(key: string, options?: { range?: { offset?: number; length?: number } }): Promise<R2ObjectBody | null>
    head(key: string): Promise<unknown | null>
    put(key: string, value: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array | string, options?: { sha256?: string }): Promise<unknown>
    delete(keys: string | string[]): Promise<void>
    list(options?: { prefix?: string; cursor?: string }): Promise<R2Objects>
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
