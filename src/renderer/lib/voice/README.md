# Renderer voice

React hooks connect the UI and agent session to this package. Vendor protocols stay in `providers/`; shared code consumes the contracts below.

| Directory | Responsibility |
| --- | --- |
| `contracts/` | STT, TTS, voice-agent and agent-conversation interfaces; settings metadata types |
| `registry/` | Select implementations and expose settings metadata; the only entrypoints that import provider code |
| `providers/openai/` | Live session/media, transcript/delegation bridge, conversation adapter, transcription, voice-agent protocol, errors and settings metadata |
| `providers/deepgram/` | Transcription, TTS, voice-agent protocol and settings metadata, including the platform-backed option |
| `engines/` | Provider-independent chained STT + read-aloud conversation |
| `shared/` | Microphone capture, PCM conversion, WebSocket STT lifecycle, HTTP TTS, listener and read-aloud service |
| `shared/speech/` | Playback, segmentation, highlighting data, hold sound and browser audio workarounds |
| `coordinator.ts` | Agent activity, submission/cancellation and response boundaries |

The separate registry entrypoints avoid loading conversation engines when a consumer only needs dictation or read-aloud. They preserve the server's existing provider/engine identifiers and select TTS by its connection transport.

## Conversation contract

`VoiceConversationAdapter` consumes agent events and emits commands, snapshots and errors. The coordinator owns the agent loop; adapters own speech turn-taking and protocol mapping. UI controls use capabilities and snapshots rather than provider-specific branches. `ChainedConversationAdapter` composes the generic listener and reader; it is not itself a Deepgram protocol implementation.

The OpenAI conversation implementation is intentionally split into a contract adapter (`conversation.ts`), media/session lifecycle (`live-session.ts`) and protocol/mapping logic (`live-bridge.ts`). These layers are private to the provider directory.

## Audio and React

`shared/read-aloud.ts` owns the app-wide reader, streaming playback, credentials and exclusive audio ownership (`suspend()` returns a release function). Live holds that ownership while connecting, running or paused. `hooks/use-read-aloud.ts` contains only React subscriptions and highlighting effects. Providers and services never import React hooks.

Safari's output handling belongs to the shared speech player because it applies to every source of PCM audio. HTTP synthesis also stays shared: vendor credentials and synthesis details are handled by the host API.

## Extending a provider

Implement the relevant contracts in the provider directory, register the implementation in the corresponding registry entrypoint, and add provider tests alongside it. Generic session/UI code should not require new protocol branches. ESLint enforces provider imports through the registry and disallows React dependencies in voice services.

Cross-provider STT lifecycle tests live with the registry; protocol-specific Live and TTS tests live beside their implementations. Shared PCM/capture tests exercise the real helpers, not copies of their implementations.
