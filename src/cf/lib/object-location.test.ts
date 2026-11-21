import { describe, expect, it } from 'vitest'
import type { Env } from '../index'
import { nearStorage } from './object-location'

const NAMESPACES = ['AGENT', 'APP_STATE', 'TASK_MANAGER'] as const

/** The bindings of one isolate, recording how each object was asked for. */
function bindings(location?: string) {
  const asked: Array<{ namespace: string; name: string; options: unknown }> = []
  const namespace = (binding: string) => ({
    getByName: (name: string, options?: unknown) => {
      asked.push({ namespace: binding, name, options })
      return {}
    },
  })
  const env = { ...Object.fromEntries(NAMESPACES.map((binding) => [binding, namespace(binding)])), DB: { database: true }, STORAGE_LOCATION: location } as unknown as Env
  return { env, asked }
}

describe('nearStorage', () => {
  it('asks for every object with the location the deployment names', () => {
    const { env, asked } = bindings('wnam')
    const near = nearStorage(env)
    for (const binding of NAMESPACES) near[binding].getByName('org')
    expect(asked).toEqual(NAMESPACES.map((namespace) => ({ namespace, name: 'org', options: { locationHint: 'wnam' } })))
  })

  it('leaves the other bindings as they are', () => {
    const { env } = bindings('wnam')
    expect(nearStorage(env).DB).toBe(env.DB)
  })

  it('hands back the same namespace each time, so an object checked once stays checked', () => {
    const { env } = bindings('wnam')
    for (const binding of NAMESPACES) expect(nearStorage(env)[binding]).toBe(nearStorage(env)[binding])
  })

  it('hands the bindings back as they are when the deployment names no location', () => {
    for (const location of [undefined, '', '  ']) {
      const { env, asked } = bindings(location)
      expect(nearStorage(env)).toBe(env)
      env.TASK_MANAGER.getByName('org')
      expect(asked).toEqual([{ namespace: 'TASK_MANAGER', name: 'org', options: undefined }])
    }
  })
})
