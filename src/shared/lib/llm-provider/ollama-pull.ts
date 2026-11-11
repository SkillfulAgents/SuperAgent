import { z } from 'zod'
import { appState, defineNamespace, digestKeyPart, reduceRecord } from '../app-state'
import { Task, taskManager, type TaskContext, type TaskResult } from '../background-work'
import { modelDownloadSchema, type ModelDownload } from './server-status-schema'

/**
 * The catalog sync's task type. A finished pull asks for a pass by this name
 * rather than importing the sync, which reads connections: the provider calls
 * into this file, and connections read providers.
 */
export const OLLAMA_CATALOG_SYNC_TASK = 'ollama.catalog-sync'

const PROGRESS_WRITE_INTERVAL_MS = 500
// A pull is one long read of a stream, so this bounds silence, not the download.
const PULL_STALL_TIMEOUT_MS = 2 * 60_000

const pullsSchema = z.record(z.string(), modelDownloadSchema)
type Pulls = z.infer<typeof pullsSchema>

// One record per server, because the dialog asks "what is this server pulling?".
// Progress keeps renewing it, so only a pull whose process died ever expires.
const pullsByServer = defineNamespace({
  name: 'ollama:pulls',
  consistency: 'strong',
  schema: pullsSchema,
  expiry: { ttlMs: 10 * 60_000, onUpdate: 'reset' },
})
const pullsKey = (baseUrl: string) => pullsByServer.key(digestKeyPart(baseUrl))
const jobId = (baseUrl: string, model: string) => `ollama-pull:${digestKeyPart(baseUrl)}:${digestKeyPart(model)}`

function withoutModel(pulls: Pulls, model: string): Pulls | null {
  const rest = Object.fromEntries(Object.entries(pulls).filter(([name]) => name !== model))
  return Object.keys(rest).length ? rest : null
}

/** Only while the pull is still on record: a write already on its way when Cancel cleared it must not bring it back. */
async function writePull(baseUrl: string, pull: ModelDownload): Promise<void> {
  await reduceRecord(pullsKey(baseUrl), current => (current?.[pull.model]
    ? { result: undefined, value: { ...current, [pull.model]: pull } }
    : { result: undefined }))
}

async function clearPull(baseUrl: string, model: string): Promise<void> {
  await reduceRecord(pullsKey(baseUrl), current => ({ result: undefined, value: current ? withoutModel(current, model) : null }))
}

export async function listOllamaPulls(baseUrl: string): Promise<ModelDownload[]> {
  return Object.values((await appState().get(pullsKey(baseUrl)))?.value ?? {})
}

const pullLineSchema = z.object({
  status: z.string().optional(),
  error: z.string().optional(),
  digest: z.string().optional(),
  total: z.number().optional(),
  completed: z.number().optional(),
})

function parsePullLine(line: string) {
  try {
    return pullLineSchema.parse(JSON.parse(line))
  } catch {
    throw new Error('Ollama sent a response this app could not read')
  }
}

/** One NDJSON line per update, and the error arrives as a line too, under a 200. */
async function* pullLines(response: Response) {
  if (!response.body) return
  const decoder = new TextDecoder()
  let buffered = ''
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffered += decoder.decode(chunk, { stream: true })
    const lines = buffered.split('\n')
    buffered = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim()) yield parsePullLine(line)
    }
  }
  if (buffered.trim()) yield parsePullLine(buffered)
}

/** Run a pull to its end; progress goes to AppState. Resolves on success, throws with Ollama's reason otherwise. */
async function runPull(baseUrl: string, model: string, signal: AbortSignal): Promise<void> {
  // Ollama resumes from the blobs a stopped pull left, so Cancel loses nothing already downloaded.
  const stall = new AbortController()
  let stallTimer = setTimeout(() => stall.abort(), PULL_STALL_TIMEOUT_MS)
  try {
    const response = await fetch(`${baseUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
      signal: AbortSignal.any([signal, stall.signal]),
    })
    // Each layer reports on its own; the bar is the sum of those seen so far.
    const layers = new Map<string, { total: number; completed: number }>()
    let lastWrite = 0
    for await (const line of pullLines(response)) {
      clearTimeout(stallTimer)
      stallTimer = setTimeout(() => stall.abort(), PULL_STALL_TIMEOUT_MS)
      if (line.error) throw new Error(line.error)
      if (line.digest && line.total) layers.set(line.digest, { total: line.total, completed: line.completed ?? 0 })
      if (Date.now() - lastWrite < PROGRESS_WRITE_INTERVAL_MS) continue
      lastWrite = Date.now()
      const sizes = [...layers.values()]
      await writePull(baseUrl, {
        model,
        state: 'running',
        // A digest in the line is noise to a person; the bar already says which step.
        phase: (line.status ?? '').replace(/ (sha256:)?[0-9a-f]{12,}$/i, ''),
        completedBytes: sizes.reduce((sum, layer) => sum + layer.completed, 0),
        totalBytes: sizes.reduce((sum, layer) => sum + layer.total, 0),
      })
    }
    if (!response.ok) throw new Error(`Ollama returned ${response.status}`)
  } finally {
    clearTimeout(stallTimer)
  }
}

const payloadSchema = z.object({ baseUrl: z.string(), model: z.string() })
type PullPayload = z.infer<typeof payloadSchema>

class OllamaPullTask extends Task<PullPayload> {
  readonly type = 'ollama.pull'
  readonly payloadSchema = payloadSchema

  async execute({ baseUrl, model }: PullPayload, ctx: TaskContext): Promise<TaskResult<PullPayload>> {
    try {
      await runPull(baseUrl, model, ctx.signal)
    } catch (error) {
      // Cancelled: whoever cancelled clears the record.
      if (!ctx.signal.aborted) {
        await writePull(baseUrl, {
          model,
          state: 'failed',
          phase: '',
          completedBytes: 0,
          totalBytes: 0,
          error: error instanceof Error ? error.message : 'The download failed',
        })
      }
      return { kind: 'done' }
    }
    // The model is on disk whatever happens next; the recurring sync catches a miss here.
    await taskManager().at(Date.now(), `${OLLAMA_CATALOG_SYNC_TASK}:after-pull`, { taskType: OLLAMA_CATALOG_SYNC_TASK, payload: {} })
      .catch((error: unknown) => console.warn('[ollama] Catalog sync after pull failed:', error))
    await clearPull(baseUrl, model)
    return { kind: 'done' }
  }
}
export const ollamaPullTask = new OllamaPullTask()

/** Start pulling, or do nothing if this server is already pulling this model. */
export async function startOllamaPull(baseUrl: string, model: string): Promise<void> {
  // A record with no job behind it would refuse every retry until it expired.
  if (!taskManager().handles(ollamaPullTask.type)) throw new Error('Downloads are not available yet. Try again in a moment.')
  const started = await reduceRecord(pullsKey(baseUrl), (current) => {
    if (current?.[model]?.state === 'running') return { result: false }
    return {
      result: true,
      value: { ...current, [model]: { model, state: 'running' as const, phase: 'starting', completedBytes: 0, totalBytes: 0 } },
    }
  })
  if (!started) return
  try {
    await taskManager().at(Date.now(), jobId(baseUrl, model), { taskType: ollamaPullTask.type, payload: { baseUrl, model } })
  } catch (error) {
    await clearPull(baseUrl, model)
    throw error
  }
}

/** Stop a running pull, or dismiss a failed one. */
export async function cancelOllamaPull(baseUrl: string, model: string): Promise<void> {
  await taskManager().cancel(jobId(baseUrl, model))
  await clearPull(baseUrl, model)
}
