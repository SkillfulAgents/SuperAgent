import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { isSharedVolumeMount } from './shared-volume'
import type { AgentMount } from '@shared/lib/types/mount'

function mount(hostPath: string, containerPath: string): AgentMount {
  return { id: 'm1', hostPath, containerPath, folderName: 'x', addedAt: '2026-01-01T00:00:00.000Z' }
}

describe('isSharedVolumeMount', () => {
  const saved = process.env.SUPERAGENT_DATA_DIR
  beforeEach(() => {
    process.env.SUPERAGENT_DATA_DIR = '/data'
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.SUPERAGENT_DATA_DIR
    else process.env.SUPERAGENT_DATA_DIR = saved
  })

  it('accepts the row the shared-volume add writes', () => {
    expect(isSharedVolumeMount(mount('/data/volumes/team-brain', '/mounts/team-brain'))).toBe(true)
  })

  it.each([
    ['an older folder row with a volume-like name', mount('/some/path/finance', '/mounts/finance')],
    ['another agent\'s workspace', mount('/data/agents/other/workspace', '/mounts/workspace')],
    ['a volume folder under a different name', mount('/data/volumes/secret', '/mounts/team-brain')],
    ['a path that climbs out', mount('/data/volumes/../agents/other/workspace', '/mounts/workspace')],
    ['a desktop-style -2 copy', mount('/data/volumes/team-brain', '/mounts/team-brain-2')],
  ])('refuses %s', (_label, row) => {
    expect(isSharedVolumeMount(row)).toBe(false)
  })
})
