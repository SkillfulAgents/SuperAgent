# Voice Agents
I want to intorduce the concept of voice agents into the app. The idea is simple -> have a realtime, voice based agent that we can use to interview the user in a more natural way, and outputs a prompt that we pass into the regular agent...

Initially, we will introduce these in two places:
- Create Agent: give the user a "Talk to me" option to be interviewed about the agent they want.
    - Voice agent outputs a name for the new agent + a detailed prompt to pass to it on first run
- Improve Agent: give the agent a button, after a response from the agent, where they can provide feedback
    - Voice agent gets existing conversation as context (without tool uses)
    - Voice agent interviews user for feedback, outputs a prompt back to main agent to imptove

## Technical Integration
We have existing integrations with STT providers in the platform (OpenAI, Deepgram). Both of these services offer S2S capabilities (OpenAI via Realtime, Deepgram via Voice Agent). We should extend the SttProvider classes to expose agent capabilities. These should be able to handle arbitrary system prompt, get an output type (prompt, agent name + prompt etc) and optionally receive additional tools to be exposed to the agent.

In the UI, we should also create a generic Voice Agent component, which will render a nice speech indication (to show when user is talking and when agent is responding) + have pause / stop / restart capabilities.

## Misc Notes:
- Keep all voice agent prompts as standalone markdown files for easy editing / review down the road
- We should always use Voice Agents terminology to avoid confusion with regular agents.

---

## Provider S2S Capabilities

### OpenAI Realtime API

**Endpoint:** `wss://api.openai.com/v1/realtime?model=gpt-realtime`

**Authentication:** Ephemeral client tokens via `POST /v1/realtime/client_secrets` (we already do this for STT transcription — same endpoint, different session config). Token is short-lived (~1 min) and scoped to the session config provided at creation time.

**Audio format:** PCM16, 24kHz, mono, base64-encoded over WebSocket (same as current OpenAI STT adapter).

**Session lifecycle:**
1. Client opens WebSocket with ephemeral token via subprotocol `['realtime', 'openai-insecure-api-key.<token>']`
2. Server emits `session.created`
3. Client sends `session.update` with full config: instructions (system prompt), voice, tools, turn detection, modalities
4. Client streams audio via `input_audio_buffer.append` (base64 chunks)
5. Server detects turn end via VAD, generates response, streams audio back via `response.audio.delta`
6. Session auto-expires after 60 minutes. End by closing the WebSocket.

**Turn detection options:**
- `server_vad` — silence-based (threshold, silence_duration_ms, prefix_padding_ms)
- `semantic_vad` — model-understands-when-user-is-done (eagerness: low/medium/high)
- `null` — push-to-talk (client manually commits audio buffer)

**Tool / function calling:**
- Define tools in `session.update` with standard JSON schema format
- Model calls a tool → server streams `response.function_call_arguments.delta/done` with `call_id`, `name`, `arguments`
- Client responds via `conversation.item.create` (type `function_call_output` with `call_id`) + `response.create` to continue
- `tool_choice`: `auto` | `none` | `required` | specific function

**Getting structured output:** The Realtime API does NOT support `response_format` / structured outputs. The reliable way to extract structured data is via function calling:
- Define a tool like `submit_results({ agent_name: string, prompt: string })`
- Instruct the model in the system prompt to call this tool when the interview is complete
- Parse the JSON from `response.function_call_arguments.done`

**Key server events for the UI:**
| Event | Maps to |
|---|---|
| `input_audio_buffer.speech_started` | User is speaking |
| `input_audio_buffer.speech_stopped` | User stopped speaking |
| `response.audio.delta` | Agent audio chunk (base64) to play |
| `response.audio.done` | Agent finished speaking |
| `response.audio_transcript.delta/done` | Agent speech as text |
| `conversation.item.input_audio_transcription.completed` | User speech as text |
| `response.function_call_arguments.done` | Structured output ready |

**Injecting conversation context (for Improve Agent):** Use `conversation.item.create` to add items (role: user/assistant with text content) before starting the voice session. This gives the agent full context of the prior conversation.

---

### Deepgram Voice Agent API

**Endpoint:** `wss://agent.deepgram.com/v1/agent/converse`

**Authentication:** Two methods:
- `Authorization: Bearer <API_KEY>` header on WebSocket handshake (server-side)
- `Sec-WebSocket-Protocol` header (browser environments where custom headers aren't supported)
Token minting: can use the existing Deepgram token endpoint (`POST /v1/auth/grant` with TTL).

**Audio format:**
- Input: raw PCM16 binary frames, 16kHz, mono (same as current Deepgram STT adapter — no base64)
- Output: raw PCM16 binary frames, 24kHz (needs WAV header prepended for browser playback)

**Session lifecycle:**
1. Client opens WebSocket (with auth)
2. Client sends `Settings` message (JSON) immediately — this is the only chance for initial config
3. Client streams raw audio as binary frames
4. Server streams audio back as binary frames, plus JSON events for state changes
5. Send `KeepAlive` every 5 seconds to prevent timeout
6. End by closing the WebSocket. No explicit end-session message.

**Configuration (Settings message):**
- `agent.think.prompt` — system prompt (25k char limit for managed LLMs)
- `agent.think.provider` — LLM backend: `open_ai`, `anthropic`, `google`, `groq`, etc.
- `agent.speak.provider` — TTS: `deepgram` (Aura 2), `eleven_labs`, `cartesia`, `open_ai`
- `agent.listen.provider` — STT: `deepgram` with Nova 3
- `agent.greeting` — optional initial greeting the agent speaks
- `agent.context.messages` — prior conversation history for context injection

**Turn detection (Flux):**
- `eot_threshold` (0.5–0.9, default 0.7) — confidence needed to declare end-of-turn
- `eager_eot_threshold` (0.3–0.9) — speculative early response
- `eot_timeout_ms` (500–10000, default 5000) — force end-of-turn after silence

**Tool / function calling:**
- Define functions in `agent.think.functions` with JSON schema
- **Client-side functions:** omit `endpoint` field → server sends `FunctionCallRequest` to client
- **Server-side functions:** include `endpoint` → Deepgram calls your URL directly
- Client responds with `FunctionCallResponse` containing `id`, `name`, `content` (JSON string)

**Getting structured output:** Same strategy as OpenAI — define a client-side function like `submit_results` and instruct the agent to call it when done. Parse the `arguments` field from `FunctionCallRequest`.

**Key server events for the UI:**
| Event | Maps to |
|---|---|
| `UserStartedSpeaking` | User is speaking |
| `AgentThinking` | Agent is processing |
| `AgentStartedSpeaking` | Agent begins responding (includes latency metrics) |
| `AgentAudioDone` | Agent finished sending audio |
| `ConversationText` | Transcript (role: user/assistant, content: text) |
| `FunctionCallRequest` | Structured output ready (client-side function) |

**Injecting conversation context (for Improve Agent):** Use `agent.context.messages` in the Settings message to pass prior conversation history.

---

## Proposed Interface: Voice Agent Adapter

### Extending BaseSttProvider (server-side, `src/shared/lib/stt/`)

Add optional voice agent support to the existing provider base class:

```typescript
// In stt-provider.ts — add to BaseSttProvider
abstract class BaseSttProvider {
  // ... existing STT methods ...

  /** Whether this provider supports Voice Agent (S2S) sessions */
  supportsVoiceAgent(): boolean {
    return false
  }

  /** Mint a token for a Voice Agent session. Providers override this. */
  async mintVoiceAgentToken(_apiKey: string): Promise<string> {
    throw new Error('Voice Agent not supported by this provider')
  }
}
```

OpenAI overrides `mintVoiceAgentToken` to call `POST /v1/realtime/client_secrets` with a `session` config of type `"realtime"` (vs the current `"transcription"` type). Deepgram can reuse the existing token minting (same key works for both STT and Voice Agent).

### New API Route

```
GET /api/stt/voice-agent-token?provider=[deepgram|openai]
  Returns: { provider: SttProvider; token: string }
  Purpose: Get ephemeral token for Voice Agent WebSocket connection
```

### VoiceAgentAdapter Interface (client-side, `src/renderer/lib/voice-agent.ts`)

New file alongside the existing `stt.ts`:

```typescript
/** Configuration passed when starting a Voice Agent session */
export interface VoiceAgentConfig {
  /** System prompt / instructions for the agent */
  systemPrompt: string
  /** Optional tools the agent can call */
  tools?: VoiceAgentTool[]
  /** Optional prior conversation messages for context (Improve Agent flow) */
  conversationContext?: { role: 'user' | 'assistant'; content: string }[]
  /** Optional voice selection (provider-specific) */
  voice?: string
  /** Optional greeting the agent speaks first */
  greeting?: string
}

export interface VoiceAgentTool {
  name: string
  description: string
  parameters: Record<string, unknown> // JSON Schema
}

/** Events emitted by the Voice Agent adapter */
export type VoiceAgentEvent =
  | { type: 'connected' }
  | { type: 'user_speaking' }
  | { type: 'user_stopped_speaking' }
  | { type: 'agent_thinking' }
  | { type: 'agent_audio'; audio: ArrayBuffer }
  | { type: 'agent_audio_done' }
  | { type: 'transcript'; role: 'user' | 'assistant'; text: string; final: boolean }
  | { type: 'function_call'; id: string; name: string; arguments: string }
  | { type: 'error'; message: string }
  | { type: 'disconnected' }

/** Adapter interface for provider-specific Voice Agent WebSocket logic */
export interface VoiceAgentAdapter {
  /** Sample rate for input audio (16000 for Deepgram, 24000 for OpenAI) */
  readonly inputSampleRate: number
  /** Sample rate for output audio */
  readonly outputSampleRate: number

  /** Open WebSocket and configure the agent session */
  connect(token: string, config: VoiceAgentConfig): Promise<void>
  /** Send a chunk of audio from the microphone */
  sendAudio(chunk: ArrayBuffer): void
  /** Respond to a function call from the agent */
  respondToFunctionCall(callId: string, result: string): void
  /** Register event listener */
  onEvent(cb: (event: VoiceAgentEvent) => void): void
  /** Close the session */
  close(): void
}
```

### Provider Implementations

**`OpenAIVoiceAgentAdapter`** — `src/renderer/lib/voice-agent-openai.ts`
- Connects to `wss://api.openai.com/v1/realtime?model=gpt-realtime`
- Sends `session.update` after connection with instructions, tools, `semantic_vad` turn detection
- Audio: base64-encoded PCM16 at 24kHz (reuses existing `arrayBufferToBase64` from `stt.ts`)
- Injects conversation context via `conversation.item.create` messages
- Maps OpenAI events → `VoiceAgentEvent`

**`DeepgramVoiceAgentAdapter`** — `src/renderer/lib/voice-agent-deepgram.ts`
- Connects to `wss://agent.deepgram.com/v1/agent/converse`
- Auth via `Sec-WebSocket-Protocol` header (browsers don't support custom `Authorization` headers on WebSocket handshake)
- Sends `Settings` message immediately after connection
- Audio: raw PCM16 binary at 16kHz input / 24kHz output (reuses existing `float32ToInt16` from `stt.ts`)
- Injects conversation context via `agent.context.messages` in Settings
- Sends `KeepAlive` every 5 seconds
- Maps Deepgram events → `VoiceAgentEvent`

### Platform Provider & Deepgram Voice Agent

The platform proxy (`apps/proxy`, Cloudflare Worker) is HTTP-only — it cannot proxy WebSocket connections. It strips the `connection` header and uses `fetch()` with `duplex: "half"` streaming. No WebSocket upgrade support.

**Approach:** Same pattern as current STT — mint an ephemeral Deepgram token via the existing platform proxy (`POST /v1/deepgram/auth/grant`), then connect directly to Deepgram's WebSocket endpoint with that token. The proxy is only used for token minting, not for the voice session itself.

The `PlatformSttProvider.mintVoiceAgentToken()` implementation can reuse the existing `mintEphemeralToken()` since the same Deepgram token works for both STT and Voice Agent endpoints.

### Factory

```typescript
// In voice-agent.ts
export function createVoiceAgentAdapter(provider: SttProvider): VoiceAgentAdapter {
  switch (provider) {
    case 'deepgram':
    case 'platform':
      return new DeepgramVoiceAgentAdapter()
    case 'openai':
      return new OpenAIVoiceAgentAdapter()
  }
}
```

### React Hook: `useVoiceAgent`

New hook in `src/renderer/hooks/use-voice-agent.ts`:

```typescript
export function useVoiceAgent(config: VoiceAgentConfig) {
  // States: 'idle' | 'connecting' | 'active' | 'error'
  // Tracks: who is currently speaking ('user' | 'agent' | 'none')
  // Manages: adapter lifecycle, audio capture, audio playback, transcript log
  // Exposes:
  //   - start(): connect and begin session
  //   - stop(): end session and return final results
  //   - pause(): stop sending audio (mute)
  //   - resume(): resume sending audio
  //   - transcript: running transcript of the conversation
  //   - speakingState: 'user' | 'agent' | 'none'
  //   - onFunctionCall: callback for when agent calls a tool
  //   - analyserRef: for waveform visualization
}
```

### Voice Agent UI Component

`src/renderer/components/ui/voice-agent.tsx`:
- Renders speech visualization (waveform or pulsing indicator) for both user and agent
- Shows running transcript
- Controls: pause/mute, stop (end session), restart
- Accepts `VoiceAgentConfig` + `onResult` callback
- Internally uses `useVoiceAgent` hook

---

## Implementation Order

1. **Voice Agent Adapter interface + types** — `voice-agent.ts` (types & factory)
2. **OpenAI adapter** — `voice-agent-openai.ts` (connect, audio, events, function calls)
3. **Deepgram adapter** — `voice-agent-deepgram.ts` (connect, audio, events, function calls)
4. **Server-side token route** — extend `stt.ts` routes + provider `mintVoiceAgentToken`
5. **`useVoiceAgent` hook** — audio capture + playback + state management
6. **Voice Agent UI component** — visualization + controls
7. **Voice Agent prompts** — standalone markdown files for Create Agent and Improve Agent flows
8. **Create Agent integration** — "Talk to me" button in agent creation flow
9. **Improve Agent integration** — feedback button after agent responses