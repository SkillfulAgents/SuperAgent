import { parseMinimaxUsage } from './usage-schema'
import type { EffortLevel } from '../container/types'
import { MINIMAX_DEFAULT_MODELS } from './model-catalog-defaults'
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { BaseLlmProvider } from './base-llm-provider'
import type { ModelDefinition } from './model-catalog-schema'
import { MINIMAX_HEADERS, MINIMAX_HOSTS, minimaxRegion } from './minimax-oauth'
import type { LlmProxyConfig } from '../../../../agent-container/src/llm-proxy-schema'
import { inferErrorStatus, extractErrorMessage } from './error-presentation'

// Endpoints and models follow the official MiniMax CLI (mmx). MiniMax-H3 video is pay-as-you-go only.
const MINIMAX_MEDIA_PROMPT = `MiniMax image, speech and video generation is available in this session through the connected MiniMax Token Plan; it uses that plan's allowance. There are no dedicated tools: write Bash scripts (Node or Python) that follow these steps. Never print tokens, credentials, base64, hex audio or full responses.
Credential: POST process.env.SUPERAGENT_HOST_API_URL (remove its trailing slash) + "/llm-runtime/resolve" with Authorization: Bearer <process.env.PROXY_TOKEN>, Content-Type: application/json and body {"sessionId": <process.env.GAMUT_SESSION_ID>}. Use proxy.credential.accessToken and proxy.credential.generation from the response. The API base is proxy.baseUrl with its trailing "/anthropic/v1" removed.
Send every request to the API base with headers Authorization: Bearer <accessToken>, Content-Type: application/json. MiniMax can report errors with HTTP 200: treat a non-zero base_resp.status_code as a failure. If a request returns HTTP 401 or status_code 1004, resolve again with {"sessionId": ..., "rejectedGeneration": <generation>} and retry once. Do not retry generation after a timeout or network failure: the first request may already have used allowance. Status_code 2056 means the plan's usage window is exhausted. For other errors, report base_resp.status_msg.
Images: POST /v1/image_generation with {"model":"image-01","prompt":"A red square on a white background","aspect_ratio":"1:1","n":1,"response_format":"base64"}. aspect_ratio is one of 1:1, 16:9, 4:3, 3:2, 2:3, 3:4, 9:16, 21:9; n is 1-9. For a character reference add "subject_reference":[{"type":"character","image_file":"<PNG or JPEG data URL encoded from a local file>"}]. Decode each entry of data.image_base64.
Speech: POST /v1/t2a_v2 with {"model":"speech-2.8-hd","text":"Hello","voice_setting":{"voice_id":"English_expressive_narrator"},"audio_setting":{"format":"mp3","sample_rate":32000,"bitrate":128000,"channel":1},"output_format":"hex"}. Text is up to 10,000 characters. data.audio is hex-encoded audio.
Videos: POST /v1/video_generation with {"model":"MiniMax-Hailuo-2.3","prompt":"Ocean waves moving gently"}. Optional: "duration" (6 or 10; 10 only at 768P), "resolution" ("768P" or "1080P"), "first_frame_image" (data URL). The response is {"task_id":"..."}; save it to a uniquely named file under /workspace/media/ and print it BEFORE polling. Poll GET /v1/query/video_generation?task_id=<task_id> every 10 seconds until status is Success (with file_id) or Fail. Then GET /v1/files/retrieve?file_id=<file_id> and download file.download_url without the Authorization header. After about 4 minutes, return the saved task_id and resume polling in a later Bash call; on polling or download errors keep polling the saved task_id instead of starting another video. Video allowance depends on the plan tier; do not use MiniMax-H3, which the plan does not cover.
Save each result under /workspace/media/ with a unique filename and an extension matching its bytes (.mp3 for speech, .mp4 for video), print only the saved paths, and deliver them with the existing file-delivery tool. Reuse saved files instead of regenerating.`
// The Messages API does not advertise effort tiers. One level satisfies the catalog.
const MINIMAX_EFFORTS: EffortLevel[] = ['high']
// M3's documented context is 1M (MiniMax's Claude Code guide sets the compact window there).
const MINIMAX_MODELS: ModelDefinition[] = [
  { id: 'MiniMax-M3', label: 'MiniMax M3', contextWindow: 1_000_000, supportsImageInput: true, isLatest: true, isDefault: true },
].map(model => ({
  ...model, family: 'minimax', icon: 'minimax', blurb: 'Uses your MiniMax Token Plan', supportedEfforts: MINIMAX_EFFORTS, supportsWebSearch: false,
}))
// Text models from the public Messages API. M2 does not accept image input.
const MINIMAX_SEARCH_MODELS: ModelDefinition[] = [
  ...MINIMAX_MODELS,
  ...['MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed', 'MiniMax-M2.1', 'MiniMax-M2.1-highspeed', 'MiniMax-M2']
    .map(id => ({ id, label: id.replace('MiniMax-', 'MiniMax '), family: 'minimax', icon: 'minimax', supportedEfforts: MINIMAX_EFFORTS, supportsWebSearch: false, supportsImageInput: false })),
]

export class MinimaxSubscriptionLlmProvider extends BaseLlmProvider {
  readonly id = 'minimax-subscription' as const
  readonly name = 'MiniMax Subscription'
  readonly defaultModelOptions = []
  readonly catalogDefaultModels = MINIMAX_DEFAULT_MODELS
  protected readonly settingsKeyField = undefined
  protected readonly envVarName = ''
  override readonly toolSearchEnv = 'true' as const
  override readonly mediaPrompt = MINIMAX_MEDIA_PROMPT
  override readonly supportsModelSearch = true
  override readonly supportsUsage = true

  override getEffectiveApiKey() { return this.configuration?.oauth?.accessToken }
  override getApiKeyStatus() {
    return this.getEffectiveApiKey() ? { isConfigured: true, source: 'settings' as const } : { isConfigured: false, source: 'none' as const }
  }
  private get apiBase() { return MINIMAX_HOSTS[minimaxRegion(this.configuration?.oauth?.region)].api }
  private async credential(rejectedGeneration?: number) {
    if (!this.configuration?.resolveCredential) throw new Error('Reconnect MiniMax in Settings → Model Providers')
    return this.configuration.resolveCredential(rejectedGeneration)
  }
  getBuiltinCatalog() { return MINIMAX_MODELS }
  async getContainerEnvVars() { return {} }
  override async getContainerProxyConfig(): Promise<LlmProxyConfig> {
    const { accessToken, expiresAt, generation, accountId } = await this.credential()
    return {
      format: 'messages', baseUrl: `${this.apiBase}/anthropic/v1`, credentialHeader: 'x-api-key',
      // MiniMax reads the token from x-api-key. Published images ignore credentialHeader and forward this snapshot.
      headers: { ...MINIMAX_HEADERS, 'x-api-key': accessToken },
      credential: { accessToken, expiresAt, generation, accountId },
    }
  }
  private async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    let credential = await this.credential()
    const send = () => {
      const headers = new Headers(init?.headers)
      // The Messages endpoint authenticates with this header, not Authorization.
      headers.set('x-api-key', credential.accessToken)
      headers.delete('authorization')
      for (const [key, value] of Object.entries(MINIMAX_HEADERS)) headers.set(key, value)
      return fetch(input, { ...init, headers, redirect: 'error' })
    }
    let response = await send()
    if (response.status === 401) {
      await response.body?.cancel()
      credential = await this.credential(credential.generation)
      response = await send()
    }
    return response
  }
  createClient(): Anthropic {
    return new Anthropic({ apiKey: '', authToken: 'app-managed', baseURL: `${this.apiBase}/anthropic`, fetch: (input, init) => this.fetch(input, init) })
  }
  private async allowance(accessToken: string) {
    const response = await fetch(`${this.apiBase}/v1/token_plan/remains`, {
      headers: { ...MINIMAX_HEADERS, authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000), redirect: 'error',
    })
    if (!response.ok) { await response.body?.cancel(); throw new Error('Could not load MiniMax usage') }
    const body: unknown = await response.json()
    const status = z.object({ base_resp: z.object({ status_code: z.number() }).optional() }).parse(body).base_resp?.status_code
    if (status) throw new Error('Could not load MiniMax usage')
    return body
  }
  override async getUsage() {
    const accessToken = this.configuration?.oauth?.accessToken
    if (!accessToken) throw new Error('MiniMax usage credentials unavailable')
    return parseMinimaxUsage(await this.allowance(accessToken))
  }
  async validateKey() {
    try { await this.allowance(await this.credential().then(credential => credential.accessToken)); return { valid: true } }
    catch { return { valid: false, error: 'Reconnect MiniMax in Settings → Model Providers' } }
  }
  override async searchModels(query: string) {
    const needle = query.toLowerCase()
    return MINIMAX_SEARCH_MODELS.filter(model => model.id.toLowerCase().includes(needle) || model.label.toLowerCase().includes(needle))
  }
  protected override parseErrorResponseOverride(status: number | undefined, body: unknown) {
    const actual = status ?? inferErrorStatus(extractErrorMessage(body))
    if (actual === 401) return { severity: 'error' as const, icon: 'info' as const, message: '**MiniMax sign-in expired or invalid.** Reconnect in Settings → Model Providers.' }
    if (actual === 402 || actual === 403) return { severity: 'error' as const, icon: 'info' as const, message: '**MiniMax subscription access was denied.** Check the connected account’s Token Plan.' }
    return null
  }
}
