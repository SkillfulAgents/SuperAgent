import type { EffortLevel } from '../container/types'
import type { ModelDefinition } from './model-catalog-schema'
import { DOUBAO_DEFAULT_MODELS } from './model-catalog-defaults'
import { PlanKeyLlmProvider } from './plan-key-provider'

// Endpoints and request shapes follow Volcengine's Agent Plan visual-model guide.
const DOUBAO_MEDIA_PROMPT = `Volcengine image and video generation is available in this session through the connected Agent Plan; it uses the plan's allowance. There are no dedicated tools: write Bash scripts (Node or Python) that follow these steps. Never print keys, credentials, base64 or full responses.
Credential: POST process.env.SUPERAGENT_HOST_API_URL (remove its trailing slash) + "/llm-runtime/resolve" with Authorization: Bearer <process.env.PROXY_TOKEN>, Content-Type: application/json and body {"sessionId": <process.env.GAMUT_SESSION_ID>}. Use proxy.credential.accessToken and proxy.baseUrl from the response.
Send every request to proxy.baseUrl with headers Authorization: Bearer <accessToken>, Content-Type: application/json. Never call Ark URLs without /api/plan: those bill pay-as-you-go. Image and video models must be enabled on the Agent Plan page of the Ark console, and plans include different models; if a model is not enabled or not in the plan, tell the user that. HTTP 401 means the plan rejected the key: tell the user to check the Agent Plan key in Settings → Model Providers. For other errors, report error.message.
Images: POST /images/generations with {"model":"doubao-seedream-5.0-lite","prompt":"A red square on a white background","size":"2K","output_format":"png","response_format":"b64_json","watermark":false}. doubao-seedream-5.0-pro gives higher quality. Decode each data[*].b64_json.
Videos: POST /contents/generations/tasks with {"model":"doubao-seedance-2.0","content":[{"type":"text","text":"Ocean waves moving gently"}],"ratio":"16:9","duration":5,"generate_audio":true,"watermark":false}. To start from an image, add {"type":"image_url","image_url":{"url":"<data URL or hosted URL>"}} to content. The response is {"id":"..."}; save it to a uniquely named file under /workspace/media/ and print it BEFORE polling. Poll GET /contents/generations/tasks/<id> every 10 seconds until status is succeeded (download content.video_url; it expires after 24 hours) or failed, cancelled or expired (report error.message). After about 4 minutes, return the saved id and resume polling in a later Bash call. Do not submit again after a timeout or network failure: the first request may already be charged. Submit one video at a time.
Save each result under /workspace/media/ with a unique filename and an extension matching its bytes, print only the saved paths, and deliver them with the existing file-delivery tool. Reuse saved files instead of regenerating.`
const DOUBAO_EFFORTS: EffortLevel[] = ['high']
const BLURB = 'Uses your Volcengine Agent Plan'
// Text models and context windows from Volcengine's Agent Plan setup guide.
const DOUBAO_MODELS: ModelDefinition[] = [
  { id: 'doubao-seed-evolving', label: 'Doubao Seed Evolving', family: 'doubao', icon: 'doubao', contextWindow: 1_024_000, isLatest: true, isDefault: true },
  { id: 'doubao-seed-2.1-pro', label: 'Doubao Seed 2.1 Pro', family: 'doubao', icon: 'doubao', contextWindow: 1_024_000 },
  { id: 'doubao-seed-2.1-lite', label: 'Doubao Seed 2.1 Lite', family: 'doubao', icon: 'doubao', contextWindow: 1_024_000 },
  { id: 'doubao-seed-2.0-mini', label: 'Doubao Seed 2.0 Mini', family: 'doubao', icon: 'doubao', contextWindow: 256_000 },
  { id: 'glm-5.3', label: 'GLM-5.3', family: 'glm', icon: 'zai', contextWindow: 1_024_000 },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', family: 'deepseek', icon: 'deepseek', contextWindow: 1_024_000 },
  { id: 'kimi-k3', label: 'Kimi K3', family: 'kimi', icon: 'kimi', contextWindow: 1_024_000 },
  { id: 'minimax-m3', label: 'MiniMax M3', family: 'minimax', icon: 'minimax', contextWindow: 1_024_000 },
].map(model => ({ ...model, blurb: BLURB, supportedEfforts: DOUBAO_EFFORTS, supportsWebSearch: false }))

export class DoubaoSubscriptionLlmProvider extends PlanKeyLlmProvider {
  readonly id = 'doubao-subscription' as const
  readonly name = 'Doubao Subscription'
  readonly catalogDefaultModels = DOUBAO_DEFAULT_MODELS
  protected readonly planName = 'Volcengine Agent Plan'
  protected readonly baseUrl = 'https://ark.cn-beijing.volces.com/api/plan/v3'
  // Volcengine documents only OpenAI-format endpoints for the Agent Plan.
  protected readonly format = 'responses' as const
  override readonly mediaPrompt = DOUBAO_MEDIA_PROMPT
  getBuiltinCatalog() { return DOUBAO_MODELS }
}
