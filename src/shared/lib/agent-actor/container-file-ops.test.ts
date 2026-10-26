import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { registerWorkspaceFsRoutes } from '../../../../agent-container/src/workspace-fs'
import { createContainerFileOps } from './container-file-ops'
import { describeFileOpsContract } from './testing/file-ops-contract'
import { readAllBytes } from './testing/in-memory-file-ops'

/** The container's workspace routes over a temp directory, called in-process. */
function containerWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'container-workspace-'))
  const app = new Hono()
  registerWorkspaceFsRoutes(app, root)
  const files = createContainerFileOps(async (target, init) => app.request(`http://container${target}`, init))
  return { root, files, dispose: () => fs.rmSync(root, { recursive: true, force: true }) }
}

describeFileOpsContract('container workspace routes', containerWorkspace)

describe('container workspace routes', () => {
  it('a link that leads out of the workspace is refused for a confined read and delete', async () => {
    const { root, files, dispose } = containerWorkspace()
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'))
    try {
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret')
      fs.symlinkSync(outside, path.join(root, 'linked'))

      await expect(files.readSized('linked/secret.txt', { confined: true })).rejects.toMatchObject({ code: 'outside-workspace' })
      await expect(files.delete('linked/secret.txt', { confined: true })).rejects.toMatchObject({ code: 'outside-workspace' })
      expect(fs.existsSync(path.join(outside, 'secret.txt'))).toBe(true)

      // Not confined, a link is followed the way the filesystem follows it.
      const { stream } = await files.readSized('linked/secret.txt')
      expect(new TextDecoder().decode(await readAllBytes(stream))).toBe('secret')
    } finally {
      dispose()
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('leaves no staged file behind when a write fails', async () => {
    const { root, files, dispose } = containerWorkspace()
    try {
      await files.mkdir('dir')
      await expect(files.putDoc('dir', 'x')).rejects.toMatchObject({ code: 'not-a-file' })
      expect(fs.readdirSync(root)).toEqual(['dir'])
    } finally {
      dispose()
    }
  })
})
