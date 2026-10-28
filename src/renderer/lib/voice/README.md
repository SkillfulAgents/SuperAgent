# Renderer voice

React hooks connect the UI and agent session to this package. Vendor protocols stay in `providers/`; everything else consumes the contracts below. The layering is a convention kept by review, not by tooling.

| Directory | Responsibility | May import |
| --- | --- | --- |
| `contracts/` | STT, TTS and agent-conversation interfaces; settings metadata types | nothing in this package |
| `shared/` | Leaf utilities: microphone capture, PCM conversion, WebSocket STT lifecycle, HTTP TTS, and `speech/` (playback, segmentation, highlighting data, hold sound, browser audio workarounds) | `contracts/` |
| `providers/openai/`, `providers/deepgram/` | Vendor protocols: transcription, TTS, Live session/media and mapping, errors, settings metadata | `contracts/`, `shared/`, `services/` |
| `registry/` | Select implementations by provider or engine and expose settings metadata; the only place that imports provider code | everything |
| `services/` | App-wide services that compose providers through the registry: the read-aloud singleton and the microphone listener | `contracts/`, `shared/`, `registry/` |
| `conversation/` | In-session voice: the coordinator that owns the agent loop, and the provider-independent chained engine (listener + read-aloud) | `contracts/`, `services/` |
| `orb/` | The dot-orb renderer behind the voice-mode mic: lattice, projection, the designed states and their motion, level helpers. Plain maths on a 2D context; `components/messages/voice-orb.tsx` owns the canvas and the clock | nothing in this package |

A **conversation** (`contracts/conversation.ts`) is voice inside an agent session: the coordinator drives the agent, and an engine handles speech turn-taking. The `VoiceAgent*` names in that contract (`VoiceAgentCoordinator`, `VoiceAgentState`) refer to the session's agent, not a separate spoken assistant.

## Registry entrypoints

There is one entrypoint per capability (`stt`, `tts`, `conversation`, `catalog`) rather than one per provider, so a consumer that only needs dictation or read-aloud never loads the Live session code. Each entrypoint is a `Record` over the provider or engine union checked with `satisfies`, so adding a member to the union without an implementation is a type error. TTS is selected by the connection transport the host reports; the websocket branch is the Deepgram speak protocol today. `catalog.ts` owns the platform option because which vendor backs it is the host's decision.

## Conversation contract

`VoiceConversationAdapter` consumes agent events and emits commands, snapshots and errors. The coordinator owns the agent loop; adapters own speech turn-taking and protocol mapping, and hand the coordinator a `turnPolicy` for their timing and leniency. UI controls use capabilities and snapshots rather than provider-specific branches. `ChainedConversationAdapter` composes the listener and reader services; it is not itself a Deepgram protocol implementation.

The OpenAI conversation implementation is split into a contract adapter (`conversation.ts`), media/session lifecycle (`live-session.ts`) and protocol/mapping logic (`live-bridge.ts`). These layers are private to the provider directory.

## Audio and React

`services/read-aloud.ts` owns the app-wide reader, streaming playback, credentials and exclusive audio ownership (`suspend()` returns a release function). Live holds that ownership while connecting, running or paused. `hooks/use-read-aloud.ts` contains only React subscriptions and highlighting effects. Nothing under `lib/voice/` imports React or a hook.

Safari's output handling belongs to the shared speech player because it applies to every source of PCM audio. HTTP synthesis also stays shared: vendor credentials and synthesis details are handled by the host API.

## Extending a provider

Implement the relevant contracts in the provider directory, add the provider to each registry record (the compiler lists the ones you missed), add its settings metadata to `catalog.ts`, and keep provider tests beside the implementation. Generic session and UI code should not need new protocol branches.

Tests sit beside what they exercise: the shared WebSocket STT lifecycle cases live in `shared/`, run against both vendor adapters; registry tests cover selection only; Live and TTS protocol tests live beside their implementations.
