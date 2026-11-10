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

  // Resolves once a change under `rel` is reported after this call.
  function watching(dir: string) {
    const reported: string[] = []
    stops.push(watchTree(dir, new Set(['.bun-cache']), (rel: string) => reported.push(rel)))
    return async (rel: string, write: () => Promise<void>) => {
      const before = reported.length
      await write()
      for (let i = 0; i < 100 && !reported.slice(before).some((p) => p === rel || p.startsWith(`${rel}/`)); i++) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      return reported.slice(before).some((p) => p === rel || p.startsWith(`${rel}/`))
    }
  }

  it('reports every safe write of a file, not only the first ones', async () => {
    const dir = await workspace()
    const changed = watching(dir)

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
    const changed = watching(dir)
    await changed('notes', () => mkdir(join(dir, 'notes')))

    expect(await changed('notes/leads.md', () => writeFile(join(dir, 'notes', 'leads.md'), '# Leads'))).toBe(true)
  })

  it('leaves out the excluded top-level folders', async () => {
    const dir = await workspace()
    const changed = watching(dir)

    expect(await changed('.bun-cache', () => writeFile(join(dir, '.bun-cache', 'module.js'), 'export const a = 1'))).toBe(false)
  })
})
