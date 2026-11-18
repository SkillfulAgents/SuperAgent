/**
 * Cloudflare makes a Durable Object near the caller that first asks for it, and the object does
 * not move after that. The org's database does not move either. So an object first asked for from
 * another region pays a cross-region round trip on every query it makes, for as long as it lives.
 * A deployment that says where its database is (STORAGE_LOCATION: Cloudflare's location hint, such
 * as "wnam") has every object asked for with that hint, and a new object is made near the
 * database, whoever asks for it first. The hint is a request: Cloudflare can place the object
 * elsewhere, and an object that exists stays where it is.
 */
import type { DurableObjectNamespace } from 'cloudflare:workers'
import type { Env } from '../index'

// One hinted namespace per binding: a caller remembers the objects it checked by namespace (object-version.ts).
const hintedNamespaces = new WeakMap<object, unknown>()

function hinted<T>(objects: DurableObjectNamespace<T>, location: string): DurableObjectNamespace<T> {
  let near = hintedNamespaces.get(objects) as DurableObjectNamespace<T> | undefined
  if (!near) {
    near = {
      getByName: (name) => objects.getByName(name, { locationHint: location }),
    }
    hintedNamespaces.set(objects, near)
  }
  return near
}

/**
 * The bindings, with each Durable Object namespace asking for its objects near the deployment's
 * database. Called where the bindings enter: the Worker's handler and each object's constructor.
 * A deployment that names no location gets its bindings back as they are.
 */
export function nearStorage(env: Env): Env {
  const location = env.STORAGE_LOCATION?.trim()
  if (!location) return env
  return {
    ...env,
    APP_STATE: hinted(env.APP_STATE, location),
    TASK_MANAGER: hinted(env.TASK_MANAGER, location),
  }
}
