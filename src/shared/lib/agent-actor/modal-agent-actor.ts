/**
 * An agent whose container is a Modal sandbox and whose workspace is a Modal
 * volume.
 *
 * The container, session, message, input and usage ops are the same
 * closures the local actor uses: they act through the agent's
 * `ContainerRuntime` (whose client is the Modal runtime client for this
 * agent) and through the host-side session state, which does not move. What
 * differs is where the files are: `files` and `config` go to the volume, and
 * the transcript reads go through a mirror that pulls the volume's copies
 * down before the session service reads them from the host path.
 */
import type { AgentActor, AgentSlug, ConfigOps, ContainerOps, FileOps, InputOps, MessageOps, SessionOps, UsageOps } from './types'
import { createConfigOps } from './config-ops'
import {
  createContainerOps,
  createInputOps,
  createMessageOps,
  createSessionOps,
  createUsageOps,
  type LocalActorDeps,
} from './local-agent-actor'
import { ModalFileOps } from './modal-file-ops'
import { TranscriptMirror } from './modal-transcript-mirror'
import type { ModalAgentPlacement } from './placement'
import { ModalVolumeFiles } from '@shared/lib/container/modal/modal-volume'
import { liveWorkspaceFor } from '@shared/lib/container/modal/sandbox-workspace'

export class ModalAgentActor implements AgentActor {
  readonly container: ContainerOps
  readonly sessions: SessionOps
  readonly messages: MessageOps
  readonly inputs: InputOps
  readonly usage: UsageOps
  readonly files: FileOps
  readonly config: ConfigOps

  constructor(
    readonly slug: AgentSlug,
    deps: LocalActorDeps,
    readonly placement: ModalAgentPlacement,
  ) {
    let volume: Promise<ModalVolumeFiles> | null = null
    const getVolume = (): Promise<ModalVolumeFiles> =>
      (volume ??= ModalVolumeFiles.ensure(placement.volumeName).catch((error: unknown) => {
        volume = null
        throw error
      }))

    // While the sandbox runs, writes go through it (see ModalFileOps). The
    // runtime's cached status is the same answer `container.status()` gives.
    const live = () =>
      deps.containerHost.runtime(slug).getCachedInfo().status === 'running' ? liveWorkspaceFor(slug) : null

    this.files = new ModalFileOps(getVolume, { live })
    this.config = createConfigOps(this.files)
    this.container = createContainerOps(slug, deps)

    const mirror = new TranscriptMirror(slug, getVolume)
    this.sessions = mirroredSessionOps(slug, createSessionOps(slug, deps), mirror)
    this.messages = mirroredMessageOps(slug, createMessageOps(slug, deps), mirror)
    this.inputs = createInputOps(slug, deps)
    this.usage = createUsageOps(slug, deps)
  }
}

/** Run the mirror before a read. A mirror failure leaves the read on the last copy rather than failing it. */
async function syncQuietly(mirror: TranscriptMirror, slug: string): Promise<void> {
  try {
    await mirror.sync()
  } catch (error) {
    console.warn(`[agent-actor] Transcript mirror for ${slug} could not sync; reading the last copy:`, error)
  }
}

function synced<A extends unknown[], R>(mirror: TranscriptMirror, slug: string, fn: (...args: A) => Promise<R>) {
  return async (...args: A): Promise<R> => {
    await syncQuietly(mirror, slug)
    return fn(...args)
  }
}

function mirroredSessionOps(slug: string, ops: SessionOps, mirror: TranscriptMirror): SessionOps {
  return {
    ...ops,
    list: synced(mirror, slug, ops.list),
    listFromSummary: synced(mirror, slug, ops.listFromSummary),
    listByIds: synced(mirror, slug, ops.listByIds),
    get: synced(mirror, slug, ops.get),
    summary: synced(mirror, slug, ops.summary),
    exists: synced(mirror, slug, ops.exists),
    isKnown: synced(mirror, slug, ops.isKnown),
    usage: synced(mirror, slug, ops.usage),
    byScheduledTask: synced(mirror, slug, ops.byScheduledTask),
    byWebhookTrigger: synced(mirror, slug, ops.byWebhookTrigger),
    forScheduledExecution: synced(mirror, slug, ops.forScheduledExecution),
    subagents: synced(mirror, slug, ops.subagents),
    subagentTranscript: synced(mirror, slug, ops.subagentTranscript),
    workflowTree: synced(mirror, slug, ops.workflowTree),
    workflowAgentTranscript: synced(mirror, slug, ops.workflowAgentTranscript),
    // The files are the authority for a delete: the volume's copy goes too,
    // or the next pass would bring the session back.
    delete: async (sessionId) => {
      await syncQuietly(mirror, slug)
      const deleted = await ops.delete(sessionId)
      await mirror.removeSession(sessionId)
      return deleted
    },
    deleteMany: async (sessionIds) => {
      await syncQuietly(mirror, slug)
      const deleted = await ops.deleteMany(sessionIds)
      for (const sessionId of sessionIds) await mirror.removeSession(sessionId)
      return deleted
    },
  }
}

function mirroredMessageOps(slug: string, ops: MessageOps, mirror: TranscriptMirror): MessageOps {
  return {
    ...ops,
    list: synced(mirror, slug, ops.list),
    withCompact: synced(mirror, slug, ops.withCompact),
    page: synced(mirror, slug, ops.page),
    delta: synced(mirror, slug, ops.delta),
    findLastEntry: synced(mirror, slug, ops.findLastEntry),
    rawLog: synced(mirror, slug, ops.rawLog),
    media: synced(mirror, slug, ops.media),
    rawEntries: (sessionId) =>
      (async function* () {
        await syncQuietly(mirror, slug)
        yield* ops.rawEntries(sessionId)
      })(),
  }
}
