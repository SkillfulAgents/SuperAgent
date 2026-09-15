import Anthropic from '@anthropic-ai/sdk'
import { BaseLlmProvider, type AgentIdentity } from './base-llm-provider'
import { orgBillingUrl, parsePlatformErrorResponse } from './platform-error-presentation'
import type { ProviderErrorPresentation } from './error-presentation'
import { rewriteLoopbackForContainer } from './container-url'
import type { ModelDefinition } from './model-catalog-schema'
import { PLATFORM_CATALOG, PLATFORM_DEFAULT_MODEL_OPTIONS } from './builtin-catalogs'
import { PLATFORM_CATALOG_DEFAULT_MODELS } from './model-catalog-defaults'
import { attribution, type Attribution } from '@shared/lib/platform-attribution'
import { captureMessage } from '@shared/lib/error-reporting'
import { getPlatformAccessToken, getPlatformAuthStatus } from '@shared/lib/services/platform-auth-service'
import { getPlatformBaseUrl, getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import type { ApiKeyStatus } from '../config/settings'

// Display names are user-controlled free text headed for an HTTP header via
// an env file: collapse control chars (the env-file writer drops \r\n outright,
// silently corrupting multi-word values otherwise) and cap by code point so a
// later slice can't split a surrogate pair.
export function sanitizeAgentName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const flattened = name.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/ {2,}/g, ' ').trim()
  return Array.from(flattened).slice(0, 200).join('')
}

// Same wire names the container folds into ANTHROPIC_CUSTOM_HEADERS
// (agent-container/src/attribution-headers.ts); the proxy decodes the name unconditionally.
const AGENT_ID_HEADER = 'X-Superagent-Agent-Id'
const AGENT_NAME_HEADER = 'X-Superagent-Agent-Name'
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/** Per-agent attribution headers for a host-direct proxy request; empty without an id. */
export function agentAttributionHeaders(agent?: AgentIdentity): Record<string, string> {
  const id = (agent?.id ?? '').trim().replace(/[^A-Za-z0-9._-]/g, '')
  if (!id) return {}
  const headers: Record<string, string> = { [AGENT_ID_HEADER]: id }
  const name = agent?.name ? sanitizeAgentName(agent.name).replace(LONE_SURROGATE, '\uFFFD') : ''
  if (name) headers[AGENT_NAME_HEADER] = encodeURIComponent(name)
  return headers
}

type NoMemberOp = 'container.env.no_member' | 'host.client.no_member'
const NO_MEMBER_MESSAGE: Record<NoMemberOp, string> = {
  'container.env.no_member': 'platform container env built without acting member',
  'host.client.no_member': 'platform host client built without acting member',
}

export class PlatformLlmProvider extends BaseLlmProvider {
  readonly id = 'platform' as const
  readonly name = 'Platform'
  readonly defaultModelOptions = PLATFORM_DEFAULT_MODEL_OPTIONS
  readonly catalogDefaultModels = PLATFORM_CATALOG_DEFAULT_MODELS
  // Not used — getApiKeyStatus/getEffectiveApiKey are both overridden to
  // read the platform token instead of a settings-stored API key.
  // The platform proxy handles deferred tool loading for the non-Anthropic
  // models it serves: it expands the CLI's `tool_reference` blocks on the
  // Anthropic-wire upstreams, and the Responses codec rebuilds every tool
  // (dropping `defer_loading`) for the xAI/OpenAI ones.
  override readonly toolSearchEnv = 'true' as const
  protected readonly settingsKeyField = 'anthropicApiKey' as const
  protected readonly envVarName = 'PLATFORM_TOKEN'

  override getApiKeyStatus(): ApiKeyStatus {
    const token = getPlatformAccessToken()
    if (token) {
      return { isConfigured: true, source: 'settings' }
    }
    if (process.env[this.envVarName]) {
      return { isConfigured: true, source: 'env' }
    }
    return { isConfigured: false, source: 'none' }
  }

  override getEffectiveApiKey(): string | undefined {
    return getPlatformAccessToken() ?? process.env[this.envVarName] ?? undefined
  }

  // Ambient scope, else the agent owner, else the stored member (SUP-805). A bare
  // org JWT is admitted by the proxy as org_runtime and bills to no seat, so
  // report it whenever the token requires an acting member.
  private resolveAttribution(agent: AgentIdentity | undefined, op: NoMemberOp): Attribution | null {
    const auth = agent ? attribution.forAgent(agent.id) : attribution.current()
    if (!auth && attribution.requiresActingMember()) {
      console.warn(`[PlatformLlmProvider] No acting member resolved for agent ${agent?.id ?? '(none)'} (${op}); using bare org token`)
      captureMessage(NO_MEMBER_MESSAGE[op], {
        level: 'warning',
        tags: { area: 'platform-attribution', op },
        extra: { agentId: agent?.id ?? null },
      })
    }
    return auth
  }

  // Attribution is fixed at construction: use the client inside the same ambient
  // scope it was built in; do not cache it across requests or users.
  createClient(agent?: AgentIdentity): Anthropic {
    const apiKey = this.getEffectiveApiKey()
    if (!apiKey) throw new Error('Platform token not configured. Please log in to the platform.')
    const auth = this.resolveAttribution(agent, 'host.client.no_member')
    return new Anthropic({
      apiKey: '',
      baseURL: getPlatformProxyBaseUrl(),
      authToken: auth?.bearerToken() ?? apiKey,
      defaultHeaders: agentAttributionHeaders(agent),
    })
  }

  getBuiltinCatalog(): ModelDefinition[] {
    return PLATFORM_CATALOG
  }

  getContainerEnvVars(agent?: AgentIdentity): Record<string, string | undefined> {
    const proxyUrl = getPlatformProxyBaseUrl()
    const containerUrl = rewriteLoopbackForContainer(proxyUrl)

    // The token is baked once per container start and shared by every session
    // in it, so an empty ambient scope here (scheduler / trigger / recovery
    // start) must still resolve a member.
    const auth = this.resolveAttribution(agent, 'container.env.no_member')
    const authToken = auth?.bearerToken() ?? this.getEffectiveApiKey()

    // Agent identity rides into the container as plain env vars; the container
    // folds them into ANTHROPIC_CUSTOM_HEADERS itself (see agent-container/src/
    // attribution-headers.ts) because the env file transport strips newlines,
    // which the multi-header ANTHROPIC_CUSTOM_HEADERS format needs.
    const agentName = agent?.name && sanitizeAgentName(agent.name)

    return {
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_BASE_URL: containerUrl,
      ANTHROPIC_AUTH_TOKEN: authToken,
      ...(agent && {
        SUPERAGENT_AGENT_ID: agent.id,
        ...(agentName && { SUPERAGENT_AGENT_NAME: agentName }),
      }),
    }
  }

  protected override parseErrorResponseOverride(
    status: number | undefined,
    body: unknown,
  ): ProviderErrorPresentation | null {
    const auth = getPlatformAuthStatus()
    const billingUrl = auth.connected ? orgBillingUrl(getPlatformBaseUrl(), auth.orgId) : null
    return parsePlatformErrorResponse(status, body, billingUrl)
  }

  async validateKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const client = new Anthropic({
        apiKey: '',
        baseURL: getPlatformProxyBaseUrl(),
        authToken: apiKey,
      })
      await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'Hi' }],
      })
      return { valid: true }
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : 'Platform token validation failed' }
    }
  }
}
