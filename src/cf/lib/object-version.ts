/**
 * After a deploy, new Worker isolates run the new code at once, but a Durable Object that keeps
 * getting requests can run the previous code for minutes. So before an isolate first calls an
 * object, it tells the object its own deploy time. An object on older code answers that it is
 * restarting, then restarts, and the caller's next call reaches the new code. Compared by time,
 * not by id: during a rollout an older Worker can still reach a newer object, which must not
 * restart for it.
 *
 * A restart ends every call the object is running. An object doing long work (an agent's running
 * session, the org's services) does not restart for a caller: it keeps its code until Cloudflare's
 * deferred code update moves it, when it hibernates or after `max_delay` (300 s by default).
 */
import type { DurableObjectNamespace, DurableObjectState } from 'cloudflare:workers'

/** Every Durable Object class in src/cf answers this. */
export interface VersionedObject {
  /** True when the caller runs newer code: this object restarts once it has answered. */
  checkVersion(callerVersion: string): boolean
}

/** The deploy this code belongs to, from the Worker's `version_metadata` binding. */
export interface VersionMetadata {
  readonly id: string
  readonly timestamp: string
}

// An object that restarted can still answer once more before the restart lands.
const MAX_CHECKS = 3

// Objects this isolate checked, by namespace: a check is once per isolate, per object, per version.
const checked = new WeakMap<object, Set<string>>()

/**
 * Resolves once the object runs this isolate's code or newer; get its stub after. A stub is never
 * handed back from here: awaiting a value that answers `then` would wait on it as a promise.
 */
export async function reachCurrentCode<T extends VersionedObject>(
  objects: DurableObjectNamespace<T>,
  name: string,
  version: string | undefined,
): Promise<void> {
  if (!version) return
  const names = checkedNames(objects)
  const key = `${name}@${version}`
  if (!names.has(key)) {
    try {
      for (let check = 0; check < MAX_CHECKS && (await (objects.getByName(name) as unknown as AsyncVersioned).checkVersion(version)); check++) {
        // The next call goes to the restarted object.
      }
      names.add(key)
    } catch (error) {
      // An object on code from before checkVersion existed: the call goes on, and the next one checks again.
      console.warn(`[object-version] checking ${name} failed; the call goes on unchecked:`, error)
    }
  }
}

type AsyncVersioned = { checkVersion(callerVersion: string): Promise<boolean> }

function checkedNames(objects: object): Set<string> {
  let names = checked.get(objects)
  if (!names) checked.set(objects, (names = new Set()))
  return names
}

/** What an object answers a call that carried the caller's version, when it restarts and did not run the call. */
export const RESTARTING = { restarting: true } as const
export type Restarting = typeof RESTARTING
/** What it answers when it made the check and ran the call. */
export interface Checked<R> {
  checked: true
  outcome: R
}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const isRestarting = (answer: unknown): answer is Restarting => isRecord(answer) && answer.restarting === true
const isChecked = <R>(answer: unknown): answer is Checked<R> => isRecord(answer) && answer.checked === true

/**
 * A call that makes the check itself, so an isolate's first call to an object is one round trip,
 * not a check and then the call. `call` gets the caller's version until the object is known to run
 * this code or newer: an object on older code answers RESTARTING without running the call, and the
 * call is made again on the restarted object. After that `call` gets no version.
 * An object on code from before calls carried a version runs the call and answers it bare: the
 * call stands, and the object is checked the separate way for the next one.
 */
export async function callOnCurrentCode<T extends VersionedObject, R>(
  objects: DurableObjectNamespace<T>,
  name: string,
  version: string | undefined,
  call: (object: T, callerVersion?: string) => Promise<R | Restarting | Checked<R>>,
): Promise<R> {
  const object = () => objects.getByName(name) as unknown as T
  const names = checkedNames(objects)
  const key = `${name}@${version}`
  if (!version || names.has(key)) return (await call(object())) as R
  for (let check = 0; check < MAX_CHECKS; check++) {
    const answer = await call(object(), version)
    if (isRestarting(answer)) continue
    if (isChecked<R>(answer)) {
      names.add(key)
      return answer.outcome
    }
    await reachCurrentCode(objects, name, version)
    return answer
  }
  // Still restarting after every try: the call goes on, as reachCurrentCode lets it.
  names.add(key)
  return (await call(object())) as R
}

/** When an object may restart for a newer caller: false while it does work a restart would end. */
export type MayRestart = () => boolean

/** For an object's method that takes the caller's version: runs it once the check passes. */
export async function checkedCall<R>(ctx: DurableObjectState, own: VersionMetadata | undefined, callerVersion: string, run: () => Promise<R>, mayRestart?: MayRestart): Promise<Restarting | Checked<R>> {
  if (restartIfOlder(ctx, own, callerVersion, mayRestart)) return RESTARTING
  return { checked: true, outcome: await run() }
}

/**
 * For an object's `checkVersion`: restarts it once this call has answered when the caller runs newer
 * code, unless `mayRestart` says it is busy: then it answers on its own code.
 */
export function restartIfOlder(ctx: DurableObjectState, own: VersionMetadata | undefined, callerVersion: string, mayRestart?: MayRestart): boolean {
  if (!(Date.parse(callerVersion) > Date.parse(own?.timestamp ?? ''))) return false
  if (mayRestart && !mayRestart()) return false
  console.warn(`[${ctx.id.name ?? ctx.id.toString()}] running code from ${own?.timestamp}, a caller runs newer code: restarting`)
  setTimeout(() => ctx.abort('newer code deployed'), 0)
  return true
}
