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

  export interface SyncKvStorage {
    get<T = unknown>(key: string): T | undefined
    put<T>(key: string, value: T): void
    delete(key: string): boolean
  }

  export interface DurableObjectStorage {
    readonly sql: SqlStorage
    readonly kv: SyncKvStorage
    /** Runs `closure` as one transaction: it commits all its writes, or none if it throws. */
    transactionSync<T>(closure: () => T): T
    getAlarm(): Promise<number | null>
    setAlarm(scheduledTime: number): Promise<void>
    deleteAlarm(): Promise<void>
  }

  export interface DurableObjectId {
    readonly name?: string
    toString(): string
  }

  export interface ContainerStartOptions {
    /** One of the two: an image the Worker config names, or a container snapshot's handle. */
    image?: string
    containerSnapshot?: { id: string; name: string; size: number }
    instance?: string
    enableInternet: boolean
    entrypoint?: string[]
    env?: Record<string, string>
  }

  /** `ctx.container` of a Durable Object whose container app uses the durable_object scheduling policy. */
  export interface Container {
    readonly running: boolean
    /** The digest-pinned images the Worker config names, by name. */
    readonly images: Record<string, string>
    start(options: ContainerStartOptions): void
    /** Resolves when the container exits, rejects when it fails or exits nonzero. */
    monitor(): Promise<void>
    destroy(reason?: unknown): Promise<void>
    signal(signal: number): void
    setInactivityTimeout(durationMs: number): Promise<void>
    getTcpPort(port: number): Fetcher
    interceptOutboundHttp(host: string, fetcher: Fetcher): Promise<void>
    /** Runs a command in the running container. */
    exec(argv: string[], options?: { stderr?: 'combined' | 'ignore' }): Promise<{ output(): Promise<{ stdout: ArrayBuffer }> }>
  }

  export interface DurableObjectState {
    readonly id: DurableObjectId
    readonly storage: DurableObjectStorage
    readonly container?: Container
    /** The Worker's exported entrypoints, as fetchers that carry `props`. */
    readonly exports: Record<string, (options: { props: unknown }) => Fetcher>
    blockConcurrencyWhile<T>(closure: () => Promise<T>): Promise<T>
    acceptWebSocket(socket: WorkerWebSocket): void
    abort(reason?: string): void
    getWebSockets(): WorkerWebSocket[]
    /** Keeps the object alive until the work settles. */
    waitUntil(promise: Promise<unknown>): void
  }

  /** A Durable Object's methods as its stub calls them: each one answers asynchronously. A stub got by name carries that name. */
  export type DurableObjectStub<T> = { readonly name?: string } & {
    [K in keyof T as T[K] extends (...args: never[]) => unknown ? K : never]: T[K] extends (...args: infer A) => infer R
      ? (...args: A) => Promise<Awaited<R>>
      : never
  }

  export interface DurableObjectNamespace<T> {
    /** `locationHint`: where a new object is made (object-location.ts); an object that exists ignores it. */
    getByName(name: string, options?: { locationHint?: string }): DurableObjectStub<T>
    idFromString(id: string): DurableObjectId
    get(id: DurableObjectId): DurableObjectStub<T>
  }

  export abstract class WorkerEntrypoint<Env = unknown, Props = unknown> {
    protected readonly ctx: ExecutionContext & { readonly props: Props }
    protected readonly env: Env
    constructor(ctx: ExecutionContext, env: Env)
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

  export interface R2UploadedPart {
    partNumber: number
    etag: string
  }

  export interface R2MultipartUpload {
    uploadPart(partNumber: number, value: ArrayBuffer | Uint8Array): Promise<R2UploadedPart>
    complete(parts: R2UploadedPart[]): Promise<unknown>
    abort(): Promise<void>
  }

  export interface R2Bucket {
    createMultipartUpload(key: string): Promise<R2MultipartUpload>
    get(key: string, options?: { range?: { offset?: number; length?: number } }): Promise<R2ObjectBody | null>
    head(key: string): Promise<unknown | null>
    put(key: string, value: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array | string, options?: { sha256?: string }): Promise<unknown>
    delete(keys: string | string[]): Promise<void>
    list(options?: { prefix?: string; cursor?: string }): Promise<R2Objects>
  }

  export interface ImagesBinding {
    input(stream: ReadableStream<Uint8Array>): ImageTransformer
  }

  export interface ImageTransformer {
    output(options: { format: 'image/jpeg' | 'image/png'; quality?: number }): Promise<{ response(): Response }>
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

/** A pass-through stream that tells R2 its length, so R2 can store a stream it has not seen whole. */
declare class FixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor(length: number)
}

/** A writable that hashes what is written to it; `digest` settles once it is closed. */
interface DigestStream extends WritableStream<Uint8Array> {
  readonly digest: Promise<ArrayBuffer>
}

interface Crypto {
  DigestStream: new (algorithm: 'SHA-256') => DigestStream
}
