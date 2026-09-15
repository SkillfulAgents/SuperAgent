/**
 * Move an agent from this machine to Modal: stop its local container, copy
 * its workspace onto a fresh Modal volume, and record the placement so the
 * next handle for it is a Modal actor and the next container start is a
 * sandbox.
 *
 * The whole workspace goes, transcripts included, so the agent resumes its
 * sessions there. The browser profile and the package caches do not: they
 * are large, regenerable, and specific to the machine they were built on.
 * The host directory stays as it is; it becomes the transcript mirror's home.
 */
import fs from 'fs'
import path from 'path'
import { getAgentWorkspaceDir } from '@shared/lib/config/data-dir'
import { ModalVolumeFiles } from '@shared/lib/container/modal/modal-volume'
import { agentWritableMode } from './modal-file-ops'
import { modalVolumeNameFor, readAgentPlacement, writeAgentPlacement, type ModalAgentPlacement } from './placement'
import type { AgentRegistry } from './types'

const SKIPPED_DIRECTORIES = new Set(['.browser-profile', '.bun-cache', 'node_modules'])
const UPLOAD_CONCURRENCY = 6

export interface MoveToModalResult {
  placement: ModalAgentPlacement
  filesUploaded: number
  bytesUploaded: number
}

export class AgentAlreadyOnModalError extends Error {
  constructor(readonly slug: string) {
    super(`Agent ${slug} already runs on Modal`)
    this.name = 'AgentAlreadyOnModalError'
  }
}

async function* walkFiles(root: string, dir = root): AsyncGenerator<{ absolute: string; relative: string }> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue
      yield* walkFiles(root, absolute)
    } else if (entry.isFile()) {
      yield { absolute, relative: path.relative(root, absolute).split(path.sep).join('/') }
    }
    // Links and special files stay behind: the volume has neither.
  }
}

export async function moveAgentToModal(slug: string, registry: AgentRegistry): Promise<MoveToModalResult> {
  if (readAgentPlacement(slug).runtime === 'modal') throw new AgentAlreadyOnModalError(slug)

  // The local container must be down before the placement changes hands:
  // afterwards the agent's runtime client is the Modal one and could not stop it.
  await registry.get(slug).container.stop()
  registry.evict(slug)

  const volumeName = modalVolumeNameFor(slug)
  const volume = await ModalVolumeFiles.ensure(volumeName)

  const files: Array<{ absolute: string; relative: string }> = []
  for await (const file of walkFiles(getAgentWorkspaceDir(slug))) files.push(file)

  let bytesUploaded = 0
  const queue = [...files]
  const workers = Array.from({ length: Math.min(UPLOAD_CONCURRENCY, queue.length) }, async () => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      const [bytes, stat] = await Promise.all([fs.promises.readFile(file.absolute), fs.promises.stat(file.absolute)])
      await volume.put(file.relative, bytes, { mode: agentWritableMode(stat.mode & 0o777) })
      bytesUploaded += bytes.byteLength
    }
  })
  await Promise.all(workers)

  const placement: ModalAgentPlacement = { runtime: 'modal', volumeName }
  await writeAgentPlacement(slug, placement)
  return { placement, filesUploaded: files.length, bytesUploaded }
}
