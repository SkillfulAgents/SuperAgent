import { accessSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { appState, defineNamespace, digestKeyPart } from '../app-state'
import { findsHostApps } from '../facts/capabilities'
import { getServerFacts } from '../facts/server-facts'
import { isLoopbackUrl } from './container-url'
import { MIN_AGENT_CONTEXT_TOKENS, MIN_OLLAMA_VERSION } from './ollama-schema'
import type { InstalledModel, ServerStatus } from './server-status-schema'

const PROBE_TIMEOUT_MS = 3_000

const versionSchema = z.object({ version: z.string().optional() })
const tagsSchema = z.object({
  models: z.array(z.object({
    model: z.string().min(1),
    size: z.number().optional(),
    digest: z.string().optional(),
    // Newer servers list these here; older ones only answer /api/show.
    capabilities: z.array(z.string()).nullish(),
  })).nullish(),
})
const showSchema = z.object({
  capabilities: z.array(z.string()).nullish(),
  model_info: z.record(z.string(), z.unknown()).nullish(),
})
const psSchema = z.object({
  models: z.array(z.object({ model: z.string().optional(), name: z.string().optional(), context_length: z.number().optional() })).nullish(),
})

const modelInfoSchema = z.object({ capabilities: z.array(z.string()).nullable(), contextLength: z.number().nullable() })
type ModelInfo = z.infer<typeof modelInfoSchema>

// A model's digest names its content, so what /api/show said about it holds. A
// status poll would otherwise ask once per installed model, every few seconds.
const modelInfoCache = defineNamespace({
  name: 'ollama:model-info',
  consistency: 'eventual',
  schema: modelInfoSchema,
  expiry: { ttlMs: 24 * 60 * 60_000, onUpdate: 'reset' },
})

async function getJson<T>(baseUrl: string, pathname: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${pathname}`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), ...init })
  if (!response.ok) throw new Error(`${pathname} returned ${response.status}`)
  return schema.parse(await response.json())
}

async function modelInfo(baseUrl: string, model: string, digest: string | undefined): Promise<ModelInfo> {
  const key = digest ? modelInfoCache.key(digestKeyPart(digest)) : undefined
  const cached = key ? await appState().get(key) : null
  if (cached) return cached.value
  const show = await getJson(baseUrl, '/api/show', showSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  })
  const contextEntry = Object.entries(show.model_info ?? {}).find(([name]) => name.endsWith('.context_length'))?.[1]
  const info: ModelInfo = {
    capabilities: show.capabilities ?? null,
    contextLength: typeof contextEntry === 'number' ? contextEntry : null,
  }
  if (key) await appState().set(key, info)
  return info
}

function unusableReason(capabilities: readonly string[] | null): InstalledModel['unusableReason'] {
  // Servers too old to report capabilities are refused by the version check, not here.
  if (!capabilities?.length) return undefined
  if (!capabilities.includes('completion')) return 'embedding-only'
  return capabilities.includes('tools') ? undefined : 'no-tools'
}

/** Compares dotted release numbers; a pre-release suffix counts as its release. */
export function isOlderOllamaVersion(version: string, minimum: string = MIN_OLLAMA_VERSION): boolean {
  const parts = (value: string) => value.replace(/^v/, '').split(/[.-]/).slice(0, 3).map(part => Number.parseInt(part, 10) || 0)
  const [a, b] = [parts(version), parts(minimum)]
  for (let index = 0; index < 3; index++) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) < (b[index] ?? 0)
  }
  return false
}

/** What the server at `baseUrl` has installed. Throws when it cannot be asked. */
export async function listInstalledOllamaModels(baseUrl: string): Promise<{
  models: InstalledModel[]
  smallContext?: { model: string; tokens: number }
}> {
  const [tags, ps] = await Promise.all([
    getJson(baseUrl, '/api/tags', tagsSchema),
    getJson(baseUrl, '/api/ps', psSchema).catch(() => ({ models: [] })),
  ])
  // What a loaded model actually got. model_info is the most the model can
  // take; the server's own setting decides, and the excess is truncated silently.
  const loadedContext = new Map<string, number>()
  for (const loaded of ps.models ?? []) {
    const name = loaded.model ?? loaded.name
    if (name && loaded.context_length) loadedContext.set(name, loaded.context_length)
  }
  const models = await Promise.all((tags.models ?? []).map(async (listed): Promise<InstalledModel> => {
    const info = await modelInfo(baseUrl, listed.model, listed.digest).catch((): ModelInfo => ({ capabilities: null, contextLength: null }))
    const capabilities = listed.capabilities?.length ? listed.capabilities : info.capabilities
    const contextWindow = loadedContext.get(listed.model) ?? info.contextLength ?? undefined
    const reason = unusableReason(capabilities)
    return {
      id: listed.model,
      label: listed.model.replace(/:latest$/, ''),
      ...(listed.size ? { sizeBytes: listed.size } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      supportsThinking: capabilities?.includes('thinking') ?? false,
      supportsImageInput: capabilities?.includes('vision') ?? false,
      ...(reason ? { unusableReason: reason } : {}),
    }
  }))
  const small = [...loadedContext].find(([, tokens]) => tokens < MIN_AGENT_CONTEXT_TOKENS)
  return { models, ...(small ? { smallContext: { model: small[0], tokens: small[1] } } : {}) }
}

/** Where the installers and package managers put it, plus anything on PATH. */
function ollamaInstallCandidates(): string[] {
  const home = homedir()
  const onPath = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
    .map(dir => path.join(dir, process.platform === 'win32' ? 'ollama.exe' : 'ollama'))
  switch (process.platform) {
    case 'darwin':
      return ['/Applications/Ollama.app', path.join(home, 'Applications/Ollama.app'), '/usr/local/bin/ollama', '/opt/homebrew/bin/ollama', ...onPath]
    case 'win32':
      return [path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData/Local'), 'Programs/Ollama/ollama.exe'), ...onPath]
    default:
      return ['/usr/local/bin/ollama', '/usr/bin/ollama', ...onPath]
  }
}

function ollamaInstallFound(): boolean {
  if (!findsHostApps(getServerFacts())) return false
  return ollamaInstallCandidates().some((candidate) => {
    try {
      accessSync(candidate)
      return true
    } catch {
      return false
    }
  })
}

function describeProbeError(error: unknown, baseUrl: string): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return `${baseUrl} did not answer within ${PROBE_TIMEOUT_MS / 1000}s`
  if (error instanceof z.ZodError || error instanceof SyntaxError) return `${baseUrl} answered, but not like an Ollama server`
  if (error instanceof Error && error.message.includes(' returned ')) return `${baseUrl}${error.message}`
  return `Could not connect to ${baseUrl}`
}

export async function getOllamaStatus(baseUrl: string): Promise<ServerStatus> {
  let version: string | undefined
  try {
    version = (await getJson(baseUrl, '/api/version', versionSchema)).version
    const { models, smallContext } = await listInstalledOllamaModels(baseUrl)
    return {
      state: 'running',
      baseUrl,
      ...(version ? { version } : {}),
      upgradeRequired: version ? isOlderOllamaVersion(version) : false,
      models,
      ...(smallContext ? { smallContext } : {}),
    }
  } catch (error) {
    const state = !isLoopbackUrl(baseUrl) ? 'unreachable' : ollamaInstallFound() ? 'stopped' : 'not-found'
    return { state, baseUrl, error: describeProbeError(error, baseUrl) }
  }
}
