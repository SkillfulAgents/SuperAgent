/**
 * Declaring namespaces and topics, and the encoding every AppState
 * implementation shares: key paths, the scope prefix, and values validated and
 * copied as JSON.
 */
import { createHash } from 'node:crypto'
import type { z } from 'zod'
import type {
  AppStateScope,
  Consistency,
  Expiry,
  ExpiryPolicy,
  Namespace,
  StateKey,
  Topic,
} from './contract'
import type { IncrementBounds } from './engine'

const SEGMENT = '[a-z][a-z0-9-]*'
const NAMESPACE_NAME = new RegExp(`^${SEGMENT}(?::${SEGMENT})*$`)
const TOPIC_NAME = new RegExp(`^events(?::${SEGMENT})+$`)

/**
 * Between a namespace or topic name and its key parts. Neither a name nor an
 * encoded part can hold it, so `pending` + (`oauth`, `flow`) and
 * `pending:oauth` + (`flow`) are different paths.
 */
const NAME_END = '/'

/** `{name}/{part}:{part}`: each part URI-encoded, so it holds neither `/` nor `:`. */
function pathOf(name: string, parts: readonly string[]): string {
  return `${name}${NAME_END}${encodeParts(parts, name)}`
}

function encodeParts(parts: readonly string[], what: string): string {
  if (parts.length === 0) throw new TypeError(`${what} needs at least one key part`)
  return parts
    .map((part) => {
      if (typeof part !== 'string' || part === '') throw new TypeError(`${what} key parts are non-empty strings`)
      return encodeURIComponent(part)
    })
    .join(':')
}

function assertTtl(ttlMs: number, what: string): void {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError(`${what}: a TTL is a positive number of milliseconds`)
}

export interface NamespaceDefinition<T, C extends Consistency> {
  name: string
  consistency: C
  schema: z.ZodType<T>
  expiry: ExpiryPolicy
}

/**
 * A namespace of keyed values. An eventual namespace is a disposable cache, so
 * it must expire its entries: `ttlMs` is the longest a value may be served.
 */
export function defineNamespace<T, C extends Consistency>(definition: NamespaceDefinition<T, C>): Namespace<T, C> {
  const { name, consistency, schema, expiry } = definition
  if (!NAMESPACE_NAME.test(name) || name === 'events' || name.startsWith('events:')) {
    throw new TypeError(`AppState namespace name ${JSON.stringify(name)} is not lowercase segments joined by ":" (and "events:" is for topics)`)
  }
  if (consistency !== 'strong' && consistency !== 'eventual') throw new TypeError(`${name}: unknown consistency ${String(consistency)}`)
  if (expiry.ttlMs === null) {
    if (consistency === 'eventual') throw new TypeError(`${name}: an eventual namespace must expire its entries`)
  } else {
    assertTtl(expiry.ttlMs, name)
  }
  if (expiry.onUpdate !== 'keep' && expiry.onUpdate !== 'reset') throw new TypeError(`${name}: onUpdate is "keep" or "reset"`)
  const namespace: Namespace<T, C> = {
    kind: 'namespace',
    name,
    consistency,
    schema,
    expiry: { ttlMs: expiry.ttlMs, onUpdate: expiry.onUpdate },
    key: (...parts) => ({ namespace, path: pathOf(name, parts) }),
  }
  return Object.freeze(namespace)
}

/** A topic of live events. Its channels are scoped like keys. */
export function defineTopic<E>(definition: { name: string; schema: z.ZodType<E> }): Topic<E> {
  const { name, schema } = definition
  if (!TOPIC_NAME.test(name)) {
    throw new TypeError(`AppState topic name ${JSON.stringify(name)} is not "events:" followed by lowercase segments joined by ":"`)
  }
  const topic: Topic<E> = {
    kind: 'topic',
    name,
    schema,
    channel: (...parts) => ({ topic, path: pathOf(name, parts) }),
  }
  return Object.freeze(topic)
}

/**
 * A key part for an identifier that must not appear in a key (a token, an
 * email, an IP, a URL): a SHA-256 digest of its canonical form, base64url.
 */
export function digestKeyPart(canonical: string): string {
  return createHash('sha256').update(canonical).digest('base64url')
}

/** `gamut:v1:{deploymentId}:tenant:{tenantId}:`, which every full key and channel starts with. */
export function scopePrefix(scope: AppStateScope): string {
  if (!scope.deploymentId || !scope.tenantId) throw new TypeError('An AppState scope names a deployment and a tenant')
  return `gamut:v1:${encodeURIComponent(scope.deploymentId)}:tenant:${encodeURIComponent(scope.tenantId)}:`
}

/** Validates a value and serializes it: what a backend stores or sends. */
export function encodeValue<T>(schema: z.ZodType<T>, value: T, what: string): string {
  const json = JSON.stringify(schema.parse(value))
  if (json === undefined) throw new TypeError(`AppState value for ${what} is not JSON`)
  return json
}

/** Parses and validates what a backend stored or sent: a fresh copy. */
export function decodeValue<T>(schema: z.ZodType<T>, json: string): T {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    throw new Error('An AppState value is not JSON', { cause: error })
  }
  return schema.parse(parsed)
}

/** The number checks an engine can enforce from a counter's limits alone: a format (`int()`) and bounds. */
const COUNTER_CHECKS = new Set(['number_format', 'greater_than', 'less_than'])

/**
 * The integers at the ends of what a counter's schema accepts, so an engine can
 * refuse a result past them before it writes. The engine never sees the schema,
 * so a counter's schema must be a plain number schema with only those checks:
 * any other rule (`multipleOf`, `refine`, a wrapper) could let a stored result
 * fail every later read, and is refused here instead.
 */
export function counterLimits(schema: z.ZodType<number>): IncrementBounds {
  const number = schema as z.ZodNumber
  const checks = number.def.type === 'number' ? number.def.checks ?? [] : null
  if (!checks || checks.some((check) => !COUNTER_CHECKS.has(check._zod.def.check))) {
    throw new TypeError('An AppState counter needs a plain number schema: int() and bounds only')
  }
  const { minValue, maxValue } = number
  return { min: limitOf(schema, minValue, 1), max: limitOf(schema, maxValue, -1) }
}

function limitOf(schema: z.ZodType<number>, bound: number | null | undefined, inward: 1 | -1): number | undefined {
  if (typeof bound !== 'number' || !Number.isFinite(bound)) return undefined
  const limit = inward > 0 ? Math.ceil(bound) : Math.floor(bound)
  // An exclusive bound (`positive()`, `lt(n)`) reports the value it excludes.
  return schema.safeParse(limit).success ? limit : limit + inward
}

/** Throws unless the key's namespace is strong; the conditional operations need one. */
export function assertStrong(key: StateKey<unknown>, operation: string): void {
  if (key.namespace.consistency !== 'strong') {
    throw new TypeError(`AppState ${operation} needs a strong namespace; ${key.namespace.name} is eventual`)
  }
}

/**
 * The expiry instant of a write, or null for none: `requested` if given,
 * otherwise the namespace's `onUpdate` for a live entry and its `ttlMs` for a
 * new one.
 */
export function resolveExpiry(
  namespace: Pick<Namespace<unknown>, 'name' | 'consistency' | 'expiry'>,
  requested: Expiry | undefined,
  current: { expiresAt: number | null } | undefined,
  now: number,
): number | null {
  const choice = requested ?? (current ? namespace.expiry.onUpdate : 'reset')
  let expiresAt: number | null
  if (choice === 'keep' && current) {
    expiresAt = current.expiresAt
  } else if (choice === 'keep' || choice === 'reset') {
    expiresAt = namespace.expiry.ttlMs === null ? null : now + namespace.expiry.ttlMs
  } else if (choice === 'never') {
    expiresAt = null
  } else if ('ttlMs' in choice) {
    assertTtl(choice.ttlMs, namespace.name)
    expiresAt = now + choice.ttlMs
  } else {
    if (!Number.isFinite(choice.at)) throw new RangeError(`${namespace.name}: an expiry instant is a finite epoch-ms number`)
    expiresAt = choice.at
  }
  if (expiresAt === null && namespace.consistency === 'eventual') {
    throw new TypeError(`${namespace.name}: an eventual namespace must expire its entries`)
  }
  return expiresAt
}

