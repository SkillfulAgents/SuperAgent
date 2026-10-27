import type { EffortLevel } from '../container/types'
import type { ModelDefinition } from './model-catalog-schema'
import { QWEN_DEFAULT_MODELS } from './model-catalog-defaults'
import { PlanKeyLlmProvider } from './plan-key-provider'

// Endpoints and request shapes follow Alibaba's Token Plan multimodal integration guide.
const QWEN_MEDIA_PROMPT = `Alibaba Cloud image, video and speech generation is available in this session through the connected Token Plan; it uses the plan's credits. There are no dedicated tools: write Bash scripts (Node or Python) that follow these steps. Never print keys, credentials, base64 or full responses.
Credential: POST process.env.SUPERAGENT_HOST_API_URL (remove its trailing slash) + "/llm-runtime/resolve" with Authorization: Bearer <process.env.PROXY_TOKEN>, Content-Type: application/json and body {"sessionId": <process.env.GAMUT_SESSION_ID>}. The plan key is env.ANTHROPIC_AUTH_TOKEN in the response.
Send every request to https://token-plan.ap-southeast-1.maas.aliyuncs.com with headers Authorization: Bearer <plan key>, Content-Type: application/json. HTTP 401 means the plan rejected the key: tell the user to check the Token Plan key in Settings → Model Providers. For other errors, report the response's code and message.
Images: POST /api/v1/services/aigc/multimodal-generation/generation with {"model":"qwen-image-2.0","input":{"messages":[{"role":"user","content":[{"text":"A red square on a white background"}]}]},"parameters":{"size":"1024*1024"}}. Other image models: qwen-image-2.0-pro, wan2.7-image, wan2.7-image-pro. Individual plans may include only the wan2.7 models, so retry once with wan2.7-image when the model is not supported. Download each URL in output.choices[*].message.content[*].image.
Videos: POST /api/v1/services/aigc/video-generation/video-synthesis with the extra header X-DashScope-Async: enable and {"model":"happyhorse-1.1-t2v","input":{"prompt":"Ocean waves moving gently"},"parameters":{"resolution":"720P","ratio":"16:9","duration":5}}. The response has output.task_id; save it to a uniquely named file under /workspace/media/ and print it BEFORE polling. Poll GET /api/v1/tasks/<task_id> every 15 seconds until output.task_status is SUCCEEDED (download output.video_url) or FAILED (report output.message). After about 4 minutes, return the saved task_id and resume polling in a later Bash call. Do not submit again after a timeout or network failure: the first request may already be charged. Credits are charged when a task finishes and video uses far more credits than text, so submit one video at a time.
Speech: POST /api/v1/services/audio/tts/SpeechSynthesizer with {"model":"qwen-audio-3.0-tts-plus","input":{"text":"Hello","voice":"longanhuan_v3.6","format":"mp3","sample_rate":24000}}. The response body is the audio file.
Save each result under /workspace/media/ with a unique filename and an extension matching its bytes, print only the saved paths, and deliver them with the existing file-delivery tool. Reuse saved files instead of regenerating.`
const QWEN_EFFORTS: EffortLevel[] = ['high']
// Models from Alibaba's Token Plan (Individual) guide for Claude Code.
const QWEN_MODELS: ModelDefinition[] = [
  { id: 'qwen3.8-max', label: 'Qwen3.8 Max', isLatest: true, isDefault: true },
  { id: 'qwen3.8-flash', label: 'Qwen3.8 Flash' },
  { id: 'qwen3.7-max', label: 'Qwen3.7 Max' },
  { id: 'qwen3.6-flash', label: 'Qwen3.6 Flash' },
].map(model => ({
  ...model, family: 'qwen', icon: 'qwen', blurb: 'Uses your Alibaba Cloud Token Plan', supportedEfforts: QWEN_EFFORTS, supportsWebSearch: false,
}))

export class QwenSubscriptionLlmProvider extends PlanKeyLlmProvider {
  readonly id = 'qwen-subscription' as const
  readonly name = 'Qwen Subscription'
  readonly catalogDefaultModels = QWEN_DEFAULT_MODELS
  protected readonly planName = 'Alibaba Cloud Token Plan'
  // International (Singapore) plan endpoint; keys are region-specific.
  protected readonly baseUrl = 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic'
  protected readonly format = 'messages' as const
  override readonly mediaPrompt = QWEN_MEDIA_PROMPT
  getBuiltinCatalog() { return QWEN_MODELS }
}
