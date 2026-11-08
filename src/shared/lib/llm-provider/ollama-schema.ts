import { z } from 'zod'
import { isHostOnlyHostname } from './container-url'

/** Pure: the renderer imports this file, so nothing here may touch the host. */

export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434'
/** First Ollama release that serves the Anthropic Messages API agents speak. */
export const MIN_OLLAMA_VERSION = '0.14.0'
/** Below this an agent's system prompt and tools alone can overflow the window, and Ollama truncates silently. */
export const MIN_AGENT_CONTEXT_TOKENS = 32_768

/**
 * The URL a person typed, as the API origin: `localhost:11434`,
 * `http://box.lan:11434/` and `http://box.lan:11434/v1` all name one server. No
 * scheme and no port means Ollama's own port. Throws with the fix for anything
 * else, including a name only the host's resolver knows: validation runs on the
 * host, so it would pass there and then fail from every agent container.
 */
export function normalizeOllamaBaseUrl(value: string | undefined): string {
  const raw = value?.trim()
  if (!raw) return DEFAULT_OLLAMA_BASE_URL
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
  let url: URL
  try {
    url = new URL(hasScheme ? raw : `http://${raw}`)
  } catch {
    throw new Error('Enter a URL such as http://localhost:11434')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('The URL must start with http:// or https://')
  if (url.search || url.hash || url.username || url.password) throw new Error('The URL cannot include credentials, a query string or a fragment')
  if (isHostOnlyHostname(url.hostname)) {
    throw new Error(`Agent containers cannot resolve "${url.hostname}". Use its fully-qualified domain name or IP address.`)
  }
  if (!hasScheme && !url.port) url.port = '11434'
  const path = url.pathname.replace(/\/+$/, '').replace(/\/(v1|api)$/i, '')
  return `${url.origin}${path}`
}

export const OLLAMA_LIBRARY_URL = 'https://ollama.com/search?c=tools'

/**
 * What `ollama pull` takes: `qwen3.8`, `qwen3.8:27b`, `someone/model:tag`,
 * `hf.co/org/repo:Q4_K_M`. Checked before it reaches Ollama, which would
 * otherwise answer a typo with a manifest error.
 */
export const ollamaModelNameSchema = z.string().trim()
  .min(1, 'Enter a model name')
  .max(200, 'That name is too long')
  .regex(/^[a-zA-Z0-9][\w.-]*(\/[a-zA-Z0-9][\w.-]*)*(:\w[\w.-]*)?$/, 'Use a name from ollama.com, such as qwen3.8 or qwen3.8:27b')
  // A cloud tag runs on Ollama's servers: there is nothing to download.
  .refine(name => !/:(.+-)?cloud$/i.test(name), 'Cloud models run on ollama.com and can\'t be downloaded')

export const ollamaInstalledModelSchema = z.object({
  /** The name Ollama answers to, always with its tag. Also the catalog id and wire value. */
  id: z.string(),
  label: z.string(),
  sizeBytes: z.number().optional(),
  contextWindow: z.number().optional(),
  supportsThinking: z.boolean(),
  supportsImageInput: z.boolean(),
  /** Why agents cannot run this model. Absent: it goes in the catalog. */
  unusableReason: z.enum(['no-tools', 'embedding-only']).optional(),
})
export type OllamaInstalledModel = z.infer<typeof ollamaInstalledModelSchema>

export const ollamaStatusSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('running'),
    baseUrl: z.string(),
    version: z.string().optional(),
    /** The server answers but predates the Messages API. */
    upgradeRequired: z.boolean(),
    models: z.array(ollamaInstalledModelSchema),
    /** A loaded model whose context is too small for agents, when there is one. */
    smallContext: z.object({ model: z.string(), tokens: z.number() }).optional(),
  }),
  z.object({
    /**
     * `stopped`: an install was found on this machine. `not-found`: none was
     * found (or the app may not look). `unreachable`: the URL is another
     * machine, so nothing can be said about what is installed there.
     */
    state: z.enum(['stopped', 'not-found', 'unreachable']),
    baseUrl: z.string(),
    error: z.string(),
  }),
])
export type OllamaStatus = z.infer<typeof ollamaStatusSchema>

export const ollamaPullStateSchema = z.object({
  model: z.string(),
  state: z.enum(['running', 'failed']),
  /** Ollama's last status line, e.g. `verifying sha256 digest`. */
  phase: z.string(),
  completedBytes: z.number(),
  totalBytes: z.number(),
  error: z.string().optional(),
})
export type OllamaPullState = z.infer<typeof ollamaPullStateSchema>
