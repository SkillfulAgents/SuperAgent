/**
 * After a deploy, new Worker isolates run the new code at once, but a Durable Object that keeps
 * getting requests can run the previous code for minutes. So before an isolate first calls an
 * object, it tells the object its own deploy time. An object on older code answers that it is
 * restarting, then restarts, and the caller's next call reaches the new code. Compared by time,
 * not by id: during a rollout an older Worker can still reach a newer object, which must not
 * restart for it.
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
  let names = checked.get(objects)
  if (!names) checked.set(objects, (names = new Set()))
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

/** For an object's `checkVersion`: restarts it once this call has answered when the caller runs newer code. */
export function restartIfOlder(ctx: DurableObjectState, own: VersionMetadata | undefined, callerVersion: string): boolean {
  if (!(Date.parse(callerVersion) > Date.parse(own?.timestamp ?? ''))) return false
  console.warn(`[${ctx.id.name ?? ctx.id.toString()}] running code from ${own?.timestamp}, a caller runs newer code: restarting`)
  setTimeout(() => ctx.abort('newer code deployed'), 0)
  return true
}
