/**
 * The actor's interface is async and data-only, checked by the compiler:
 * every op returns a Promise, and every argument and result is data a
 * transport can carry. No function goes in, and no closure or handle comes out.
 * The exceptions are the ones a transport pipes rather than clones:
 *
 * - byte and event streams (`ReadableStream`), whose chunks are data;
 * - the container transport, `container.fetch`, whose request and response are its own;
 * - the advisory `AbortSignal` of the pure reads `messages.page`, `messages.delta` and `messages.media`.
 *
 * A violation fails `tsc`, naming the op. What it cannot see: an overloaded
 * op is checked by its last signature, and a generic one by its constraint.
 */
import { describe, expect, it } from 'vitest'
import type { ACTOR_GROUPS, AgentActor } from './types'

type Primitive = string | number | boolean | bigint | null | undefined | void

/**
 * True when T is data a transport can carry (structured-cloneable), or one of
 * the piped exceptions; `Allowed` is what this op may pass besides.
 */
type DataOnly<T, Allowed = never, Depth extends unknown[] = []> =
  Depth['length'] extends 12 ? true
    : unknown extends T ? true
    : T extends Primitive ? true
    : [T] extends [Allowed] ? true
    : T extends Date | Uint8Array ? true
    : T extends ReadableStream<infer C> ? DataOnly<C, Allowed, [...Depth, 1]>
    : T extends (...args: never[]) => unknown ? false
    : T extends AbortSignal ? false
    : T extends readonly (infer U)[] ? DataOnly<U, Allowed, [...Depth, 1]>
    : T extends ReadonlySet<infer U> ? DataOnly<U, Allowed, [...Depth, 1]>
    : T extends ReadonlyMap<infer K, infer V> ? (DataOnly<K, Allowed, [...Depth, 1]> | DataOnly<V, Allowed, [...Depth, 1]>) extends true ? true : false
    : T extends object ? (false extends { [K in keyof T]-?: DataOnly<T[K], Allowed, [...Depth, 1]> }[keyof T] ? false : true)
    : false

type ArgsDataOnly<A extends unknown[], Allowed> = false extends { [I in keyof A]: DataOnly<A[I], Allowed> }[number] ? false : true

/** Why an op is not async and data-only, or true. */
type OpVerdict<F, Name extends string, Allowed> = F extends (...args: infer A) => infer R
  ? R extends Promise<infer V>
    ? ArgsDataOnly<A, Allowed> extends true
      ? DataOnly<V> extends true ? true : `${Name}: result is not data`
      : `${Name}: an argument is not data`
    : `${Name}: does not return a Promise`
  : true

type AdvisorySignal = 'page' | 'delta' | 'media'

/** Every op of a group (and of its nested groups), each true or why not. */
type GroupVerdicts<G, Path extends string> = {
  // An optional op or group is checked as if it were there.
  [K in keyof G & string]-?: NonNullable<G[K]> extends (...args: never[]) => unknown
    ? `${Path}.${K}` extends 'container.fetch'
      ? true
      : OpVerdict<NonNullable<G[K]>, `${Path}.${K}`, K extends AdvisorySignal ? AbortSignal : never>
    : NonNullable<G[K]> extends object ? GroupVerdicts<NonNullable<G[K]>, `${Path}.${K}`> : true
}[keyof G & string]

type Groups = (typeof ACTOR_GROUPS)[number]
type Verdicts =
  | { [K in Groups]: GroupVerdicts<AgentActor[K], K> }[Groups]
  | OpVerdict<AgentActor['live'], 'live', never>

/** Fails to compile, naming each op, unless every verdict is true. */
const everyOpIsAsyncAndDataOnly: Exclude<Verdicts, true> extends never ? true : Exclude<Verdicts, true> = true

/** Every key of the actor that holds ops, which a transport must wrap. */
type GroupKeys = {
  [K in keyof AgentActor]-?: AgentActor[K] extends (...args: never[]) => unknown ? never : AgentActor[K] extends object ? K : never
}[keyof AgentActor]
type Unlisted = Exclude<GroupKeys, Groups>

/** Fails to compile, naming the group, unless `ACTOR_GROUPS` lists every one. */
const everyGroupIsListed: [Unlisted] extends [never] ? true : `${Unlisted}: not in ACTOR_GROUPS` = true

describe('the actor interface', () => {
  it('is async and data-only (checked by the compiler)', () => {
    expect(everyOpIsAsyncAndDataOnly).toBe(true)
    expect(everyGroupIsListed).toBe(true)
  })
})
