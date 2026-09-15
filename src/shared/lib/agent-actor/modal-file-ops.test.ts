import { describe, expect, it } from 'vitest'
import { DIRECTORY_MARKER, ModalFileOps } from './modal-file-ops'
import { describeFileOpsContract } from './testing/file-ops-contract'
import { ModalVolumeError, ModalVolumeFiles } from '@shared/lib/container/modal/modal-volume'
import { SandboxExecError, type LiveEntryKind, type LiveWorkspace } from '@shared/lib/container/modal/sandbox-workspace'
import { FakeVolumeControlPlane } from '@shared/lib/container/modal/testing/fake-volume-control-plane'

/** What the shell in the sandbox would have printed for the volume's refusal. */
function asShellFailure(error: unknown): never {
  if (error instanceof ModalVolumeError) {
    const stderr =
      error.code === 'is-a-directory' ? 'sh: cannot create: Is a directory'
      : error.code === 'not-a-directory' ? 'sh: cannot create: Not a directory'
      : error.message
    throw new SandboxExecError(1, stderr)
  }
  throw error
}

/**
 * A running sandbox's view of the workspace, in memory. Its writes reach the
 * fake volume too, the way a real sandbox's do once `sync` commits them, and
 * its failures look like a failed shell command, the way the real one's do.
 */
class FakeLiveWorkspace implements LiveWorkspace {
  readonly writes: Array<{ rel: string; mode: number }> = []
  readonly removals: Array<{ rel: string; recursive: boolean }> = []
  constructor(private readonly volume: Promise<ModalVolumeFiles>) {}
  async stat(rel: string): Promise<LiveEntryKind> {
    const entry = await (await this.volume).entry(rel)
    return entry?.kind === 'file' || entry?.kind === 'directory' ? entry.kind : null
  }
  async write(rel: string, bytes: Uint8Array, mode: number): Promise<void> {
    this.writes.push({ rel, mode })
    await (await this.volume).put(rel, bytes, { mode }).catch(asShellFailure)
  }
  async remove(rel: string, recursive: boolean): Promise<void> {
    this.removals.push({ rel, recursive })
    await (await this.volume).remove(rel, recursive).catch(asShellFailure)
  }
  async mkdir(rel: string, marker: string, mode: number): Promise<void> {
    await (await this.volume).put(`${rel}/${marker}`, new Uint8Array(0), { mode }).catch(asShellFailure)
  }
}

// The same contract when the sandbox runs and every write goes through it.
describeFileOpsContract(
  'ModalFileOps with a running sandbox',
  async () => {
    const fake = new FakeVolumeControlPlane()
    const volume = ModalVolumeFiles.ensure('fake', fake.deps)
    const live = new FakeLiveWorkspace(volume)
    return { files: new ModalFileOps(() => volume, { live: () => live }) }
  },
  { keepsModes: false },
)

// Real `ModalFileOps` and real `ModalVolumeFiles` protocol code, against an
// emulated volume: the contract every FileOps implementation passes, minus
// permission bits, which a volume listing does not report.
describeFileOpsContract(
  'ModalFileOps',
  async () => {
    const fake = new FakeVolumeControlPlane()
    const volume = ModalVolumeFiles.ensure('fake', fake.deps)
    return { files: new ModalFileOps(() => volume) }
  },
  { keepsModes: false },
)

describe('ModalFileOps — what is Modal about it', () => {
  async function make() {
    const fake = new FakeVolumeControlPlane()
    const volume = ModalVolumeFiles.ensure('fake', fake.deps)
    const live = new FakeLiveWorkspace(volume)
    let running = false
    const files = new ModalFileOps(() => volume, { live: () => (running ? live : null) })
    return { fake, files, live, wake: () => (running = true) }
  }

  it('an empty directory is a marker file on the volume that listings hide', async () => {
    const { fake, files } = await make()
    await files.mkdir('empty/dir')
    expect(fake.files.has(`empty/dir/${DIRECTORY_MARKER}`)).toBe(true)
    expect(await files.list('empty/dir')).toEqual([])
    expect(await files.list('empty')).toEqual([{ name: 'dir', path: 'empty/dir', kind: 'directory' }])
    // A directory that exists already gets no second marker.
    await files.putDoc('other/file.txt', 'x')
    await files.mkdir('other')
    expect(fake.files.has(`other/${DIRECTORY_MARKER}`)).toBe(false)
  })

  it('writes and deletes go through the sandbox while it runs, and to the volume while it sleeps', async () => {
    const { fake, files, live, wake } = await make()
    await files.putDoc('asleep.txt', 'a')
    expect(live.writes).toEqual([])
    expect(fake.calls).toContain('volumePutFiles2')

    wake()
    fake.calls.length = 0
    await files.putDoc('awake.txt', 'b')
    await files.write('bin/tool', new Uint8Array([1]), { mode: 0o755 })
    expect(live.writes).toEqual([
      { rel: 'awake.txt', mode: 0o666 },
      { rel: 'bin/tool', mode: 0o777 },
    ])
    // Reads still go to the volume, which the sandbox's sync brought up to date.
    expect(new TextDecoder().decode((await files.getDoc('awake.txt')) ?? new Uint8Array())).toBe('b')

    await files.delete('awake.txt')
    await files.delete('bin', { recursive: true })
    expect(live.removals).toEqual([
      { rel: 'awake.txt', recursive: false },
      { rel: 'bin', recursive: true },
    ])
    await expect(files.delete('never-there')).resolves.toBeUndefined()
    expect(live.removals).toHaveLength(2)
  })

  it('writes files the agent can edit: world-writable, keeping any execute bits asked for', async () => {
    const { fake, files } = await make()
    await files.putDoc('CLAUDE.md', '# me')
    await files.write('bin/tool', new Uint8Array([1]), { mode: 0o755 })
    await files.putDoc('.env', 'A=1', { mode: 0o666 })
    expect(fake.files.get('CLAUDE.md')?.mode).toBe(0o666)
    expect(fake.files.get('bin/tool')?.mode).toBe(0o777)
    expect(fake.files.get('.env')?.mode).toBe(0o666)
  })

  it('resolve is the normalized path: the volume has no links to follow', async () => {
    const { files } = await make()
    await files.putDoc('docs/readme.md', '#')
    expect(await files.resolve('/workspace/docs//readme.md')).toBe('docs/readme.md')
  })
})
