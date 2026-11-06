import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scan } from '../../agent-container/cloudflare/workspace-scan.mjs'

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
