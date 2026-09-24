import { createHash } from 'node:crypto'
import { z } from 'zod'
import { subagentModelCatalogSchema, modelContextWindowsSchema } from './subagent-model-catalog'

export const connectionRuntimeSchema = z.object({
  llmProviderId: z.string().min(1),
  generation: z.number().int(),
  provider: z.string(),
  model: z.string(),
  browserModel: z.string(),
  dashboardBuilderModel: z.string(),
  modelPromptHints: z.array(z.string()),
  subagentModels: subagentModelCatalogSchema,
  modelContextWindows: modelContextWindowsSchema,
  env: z.record(z.string(), z.string()),
})
export type ConnectionRuntime = z.infer<typeof connectionRuntimeSchema>

export function runtimeFingerprint(runtime: ConnectionRuntime): string {
  return createHash('sha256').update(JSON.stringify(runtime)).digest('hex')
}

// Only memory holds credentials. Warm-profile files contain the connection
// and generation, so a profile can never claim another account's subprocess.
const runtimes = new Map<string, ConnectionRuntime>()
export function rememberConnectionRuntime(runtime: ConnectionRuntime): void {
  const fingerprint = runtimeFingerprint(runtime)
  // Bound the credential cache and replace every previous credential for this
  // account, including environment/Platform changes without a DB generation.
  for (const [key, cached] of runtimes) {
    if (
      cached.llmProviderId === runtime.llmProviderId &&
      (cached.generation !== runtime.generation ||
        JSON.stringify(cached.env) !== JSON.stringify(runtime.env))
    )
      runtimes.delete(key)
  }
  runtimes.set(fingerprint, runtime)
  if (runtimes.size > 32) runtimes.delete(runtimes.keys().next().value!)
}
export function cachedConnectionRuntime(
  id: string | undefined,
  generation?: number,
  model?: string,
  fingerprint?: string
): ConnectionRuntime | undefined {
  const runtime = fingerprint ? runtimes.get(fingerprint) : undefined
  return runtime?.llmProviderId === id &&
    runtime?.generation === generation &&
    runtime?.model === model
    ? runtime
    : undefined
}
export async function resolveSessionRuntime(sessionId: string): Promise<ConnectionRuntime> {
  return requestRuntime('resolve', { sessionId })
}

export async function resolvePrewarmRuntime(): Promise<ConnectionRuntime> {
  return requestRuntime('prewarm', {})
}

async function requestRuntime(path: string, body: object): Promise<ConnectionRuntime> {
  const base = process.env.SUPERAGENT_HOST_API_URL
  const token = process.env.PROXY_TOKEN
  if (!base || !token) throw new Error('Host credential service is not configured')
  const response = await fetch(`${base.replace(/\/$/, '')}/llm-runtime/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`Cannot resolve LLM provider (${response.status})`)
  const runtime = connectionRuntimeSchema.parse(await response.json())
  rememberConnectionRuntime(runtime)
  return runtime
}

export function withoutProviderCredentials<T extends string | undefined>(
  env: Record<string, T>
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !/^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY)$|AWS_BEARER_TOKEN_BEDROCK$)/.test(
          key
        )
    )
  )
}
