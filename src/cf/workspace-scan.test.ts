import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scan, watchTree } from '../../agent-container/cloudflare/workspace-scan.mjs'

type Entry = { path: string; kind: string }

let root = ''
afterEach(async () => {
  await chmod(join(root, 'reports'), 0o755).catch(() => {})
  await rm(root, { recursive: true, force: true })
})

async function workspace(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'workspace-scan-'))
  await mkdir(join(root, 'reports'))
  await writeFile(join(root, 'reports', 'q3.csv'), 'region,revenue\nwest,120\n')
  await mkdir(join(root, 'drafts'))
  await mkdir(join(root, '.bun-cache'))
  await writeFile(join(root, '.bun-cache', 'module.js'), 'export {}')
  await symlink('reports/q3.csv', join(root, 'latest.csv'))
  return root
}

describe('scan', () => {
  it('lists files, symlinks and empty folders, without the excluded top-level folders', async () => {
    const { entries } = await scan(await workspace(), new Set(['.bun-cache']), new Map())

    expect((entries as Entry[]).map(({ path, kind }) => `${kind} ${path}`).sort()).toEqual(['dir drafts', 'file reports/q3.csv', 'symlink latest.csv'])
  })

  it('fails when a folder cannot be read, instead of listing it as empty', async () => {
    const dir = await workspace()
    await chmod(join(dir, 'reports'), 0o000)

    await expect(scan(dir, new Set(), new Map())).rejects.toMatchObject({ code: 'EACCES' })
  })
})

describe('watchTree', () => {
  const stops: Array<() => void> = []
  afterEach(() => stops.splice(0).forEach((stop) => stop()))

  const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

  /**
   * Starts a watch and returns `changed(rel, write)`: whether a change under `rel` is reported after
   * `write`. macOS starts reporting a moment after a folder's watch begins, so a watch counts as
   * started once a probe write in `ready` is reported.
   */
  async function watching(dir: string, ready = '') {
    const reported: string[] = []
    stops.push(watchTree(dir, new Set(['.bun-cache']), (rel: string) => reported.push(rel)))
    const under = (rel: string, from: number) => reported.slice(from).some((p) => p === rel || p.startsWith(`${rel}/`))
    const changed = async (rel: string, write: () => Promise<unknown>) => {
      const before = reported.length
      await write()
      for (let i = 0; i < 100 && !under(rel, before); i++) await settle()
      return under(rel, before)
    }
    await live(changed, dir, ready)
    return changed
  }

  async function live(changed: (rel: string, write: () => Promise<unknown>) => Promise<boolean>, dir: string, folder: string) {
    const probe = folder ? `${folder}/.probe` : '.probe'
    for (let i = 0; i < 10; i++) if (await changed(probe, () => writeFile(join(dir, probe), String(i)))) return
    throw new Error(`the watch of ${folder || 'the workspace'} never started`)
  }

  it('reports every safe write of a file, not only the first ones', async () => {
    const dir = await workspace()
    const changed = await watching(dir, 'reports')

    for (let i = 0; i < 5; i++) {
      const reported = await changed('reports/sessions.json', async () => {
        await writeFile(join(dir, 'reports', `.sessions.json.${i}.tmp`), `{"sessions":${i}}`)
        await rename(join(dir, 'reports', `.sessions.json.${i}.tmp`), join(dir, 'reports', 'sessions.json'))
      })
      expect(reported, `safe write ${i + 1}`).toBe(true)
    }
  })

  it('watches a folder made after it started', async () => {
    const dir = await workspace()
    const changed = await watching(dir)
    expect(await changed('notes', () => mkdir(join(dir, 'notes')))).toBe(true)
    await live(changed, dir, 'notes')

    expect(await changed('notes/leads.md', () => writeFile(join(dir, 'notes', 'leads.md'), '# Leads'))).toBe(true)
  })

  it('leaves out the excluded top-level folders', async () => {
    const dir = await workspace()
    const changed = await watching(dir)

    expect(await changed('.bun-cache', () => writeFile(join(dir, '.bun-cache', 'module.js'), 'export const a = 1'))).toBe(false)
  })
})
