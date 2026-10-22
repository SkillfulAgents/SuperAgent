import { afterEach, describe, expect, it } from 'vitest'
import { createLocalSessionStore, setWorkspaceStore } from './local-session-store'
import type { StoreConfigOps, StoreFileOps } from './types'

const deps = { getAgentWorkspaceDir: (slug: string) => `/data/agents/${slug}/workspace` }

describe('createLocalSessionStore', () => {
  afterEach(() => setWorkspaceStore(null))

  it('uses the files and config documents a deployment supplies', () => {
    const files = { kind: 'supplied files' } as unknown as StoreFileOps
    const config = { kind: 'supplied config' } as unknown as StoreConfigOps
    const asked: string[] = []
    setWorkspaceStore((slug) => {
      asked.push(slug)
      return { files, config }
    })

    const store = createLocalSessionStore('research-a1', deps)

    expect(asked).toEqual(['research-a1'])
    expect(store.files).toBe(files)
    expect(store.config).toBe(config)
  })
})
