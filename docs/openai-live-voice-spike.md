# Conversation voice architecture and OpenAI Live setup

This extends the existing OpenAI voice provider and the microphone experience inside an agent conversation. The Deepgram path and the separate creation/feedback voice-agent experience remain available.

## Try it

1. In **Settings → Voice**, select **OpenAI** and save an OpenAI project API key with GPT-Live access. The existing `OPENAI_API_KEY` environment fallback also works. In authenticated deployments this remains the existing administrator-managed workspace voice key, not a new per-member key store.
2. Ensure the app's existing LLM provider and **Summarizer model** are configured. Mapping uses `getEffectiveModels().summarizerModel`, the active provider's model resolution, and `createSummarizerText`; there is no separate voice summarizer setting.
3. Open an agent conversation and use its existing voice button. Use HTTPS or localhost and allow microphone access. GPT-Live currently uses the Marin voice.
4. Ask the agent to do something, correct the request while it works, and listen for the returned result. Exit voice mode to close the call.

Automated tests use mocked provider responses. Microphone quality, model access, end-to-end latency, and delegation behavior should also be checked in a live session after changes. Live API calls and summarizer requests use the configured paid accounts.

## Boundary

`useVoiceMode` selects one adapter through `createVoiceConversation`. `useConversationMode` owns the single React integration and agent-stream subscription. Inactive engines are never constructed.

`VoiceAgentCoordinator` owns agent command serialization, successful interruption before replacement, acknowledgment waiting, stale-response filtering, and response segment/completion events. Both engines emit typed `submit`/`cancel` commands and consume the same agent events. Closing a voice conversation prevents queued commands and post-interruption continuations from submitting; it does not cancel already-running agent work.

`ChainedConversationAdapter` owns utterance finalization, interruption word thresholds, ducking, listener reconnection, and the existing read-aloud pipeline. `OpenAILiveConversationAdapter` wraps Live media/mapping behind the same contract. Neither adapter imports agent mutations or subscribes to the agent stream.

Neutral history/transcript types live in `shared/lib/voice/conversation-types.ts`; renderer contracts live in `renderer/lib/voice/contracts/conversation.ts`. Provider protocol types remain in `live-types.ts`. The provider registry preserves concrete types, and each provider declares its conversation engine without API-layer casts. Host routes resolve the configured provider’s optional `getLiveConversation()` capability and delegate creation/mapping through its typed methods. Providers without that capability return a named unsupported-operation error. Each cleanup handle retains its creating provider’s close operation, so cleanup, retries, and expiry do not depend on later provider selection.

The common snapshot separates user and assistant speech activity. `working` consistently means an active backend turn with a ready, unpaused voice connection. Adapters supply hold eligibility/delay and control capabilities so the composer does not branch on engine names. Music is cut synchronously on either participant's speech activity for both engines.

The OpenAI implementation owns:

- Host-side Live session creation with the existing BYOK key; only the SDP answer and an opaque cleanup handle reach the renderer.
- WebRTC microphone/speaker tracks and the data channel. It waits for `session.started`; it does not send the WebSocket-only `session.start` command.
- Client-delegation and transcript mapping. A delegation event contains metadata, not an agent request. The adapter coalesces transcript fragments and asks the configured summarizer for a schema-constrained message, cancellation, clarification, or no action. Additional user fragments invalidate in-flight mappings. Duplicate delegation IDs are ignored.
- Spoken results. Short coherent updates go directly to Live commentary. Longer updates use the same summarizer. Appends are UTF-8-byte bounded below the API's 500-token limit and ordered; a replacement request invalidates older queued summaries.
- Microphone/playback cleanup, including exiting before the session-creation response arrives. Host cleanup handles are user-bound and calls have a one-hour backstop with a one-minute expiry warning. Page exit triggers best-effort cleanup. Failed hangups release the admission slot immediately, retain the upstream handle for bounded retries, and make a final attempt at expiry.

## Standard text-to-speech

OpenAI also provides read-aloud using `gpt-4o-mini-tts`, with Marin as the default and a selectable voice catalogue. `/api/voice/tts-session` returns transport-neutral initialization: Deepgram receives an ephemeral WebSocket token; OpenAI receives an HTTP connection descriptor without credentials. The legacy `/tts-token` endpoint remains a thin wrapper over the same initialization path for cached and remote token-based clients. The renderer chooses its TTS adapter from the returned transport; the player receives an adapter with its connection already bound.

Synthesis fetches on both the host and renderer have a 30-second header deadline and a fresh idle deadline for each pending chunk. Healthy streams have no total-duration cutoff, and downstream backpressure does not count as an upstream stall. Cancellation closes the underlying stream. Shared speech chunking preserves Unicode, using UTF-8 byte limits for Live and UTF-16 length limits for standard TTS; chat message splitting retains its separate paragraph-boundary policy. Provider-owned configuration errors return actionable 400s; upstream failures are logged and return safe 502 messages. Unsupported Live operations return responses directly so the parent API error handler cannot turn them into 500s.


The authenticated `/api/voice/tts` route validates and bounds text, voice, and speed, then delegates through the configured provider’s optional synthesis capability. The OpenAI key stays on the host; raw 24 kHz PCM streams to the existing speech player. The HTTP adapter serializes batches, splits unusually long input to the API limit, and cancels active/queued synthesis when playback stops. Provider changes reject stale synthesis requests instead of silently switching a running reader to another provider.

## Renderer organization

The renderer voice package lives under `src/renderer/lib/voice/`. See its [README](../src/renderer/lib/voice/README.md) for the dependency boundary. OpenAI and Deepgram each own their protocol adapters and settings metadata under `providers/`; only the `registry/` entrypoints select those implementations. React hooks consume contracts and shared services. The read-aloud controller is a plain service, while its hooks subscribe to the same singleton for controls and highlights.

## Current limits

- Agent submission still returns a boolean, and the existing stream exposes activity timestamps and cumulative text rather than durable command/turn/message IDs. Boundary inference is centralized in the coordinator; adding correlated IDs to the backend stream remains a follow-up.
- A correction to active work interrupts the current agent turn, waits for acknowledgment, then submits a normalized replacement request. This does not implement in-place steering. Explicit cancellation stops the current turn; background tasks and completed side effects are not undone.
- Interrupting Live's speech, including using the microphone button while the agent is busy, does not itself interrupt the agent. Live handles spoken turn-taking.
- Transcript coalescing is a heuristic, not an authoritative end-of-turn signal. The summarizer must preserve uncertainty and ask for clarification for incomplete requests. Evaluate delayed/overlapping transcript delivery with real audio before rollout.
- Ordinary agent requests and responses persist through the existing session pipeline. Raw Live transcript fragments and conversational backchannels appear in an ephemeral two-line rolling subtitle (blue for you, orange for the voice agent, with each speaker message on a new line); they are not separately persisted. Startup uses a bounded recent text history; media/attachments still enter through the existing agent composer.
- Request cards disable microphone input and mute playback until resumed. Live hides the Deepgram reading-speed control; the app's hold-music toggle remains available. Music is allowed only while the agent is active and neither participant is detected as speaking. Fresh input transcript fragments containing letters or numbers cut the loop. Once confirmed, microphone activity keeps speech active through delayed transcript fragments; the gate closes after 1.2 seconds without either words or microphone activity. Sustained background noise can delay that release, but cannot reopen the gate after music resumes. Audible assistant speech also resets confirmed input activity; fresh user words can open it again for an interruption. Microphone volume alone does not cut music, so speaker leakage and background noise do not trigger it; interruption waits for the first transcribed words. Whitespace, punctuation, and output subtitles do not trigger input speech. Playback detection cuts the loop without a fade and keeps the speaking state through 1.2-second sentence gaps, followed by the normal silence delay before music resumes. OpenAI read-aloud uses the separate Speech API and the existing player. On Safari, the player routes its PCM graph through a media stream and an audio element, prepared during the play gesture, to avoid silent Web Audio device output. Other browsers keep direct Web Audio output. The media element and its stream tracks are released when the playback context closes. Live reserves audio while connecting, active, or paused: it stops any current reader, hides the read-aloud action, and blocks new reads until the call closes. Hold music consumes the conversation adapter’s speaking state without separately polling the reader. Its selected voice and speed do not change Live conversation speech.
- Transient WebRTC disconnections have an eight-second recovery window; terminal failures end the voice connection. Reconnect by exiting and re-entering voice mode. Automatic resume and durable Live session recovery are not implemented. Cleanup handles live in one server process; multi-instance deployments need sticky routing or a shared registry.
- The client data channel can append voice instructions/context but cannot switch delegation to a managed Responses backend. Agent tools and permissions remain on the application's existing execution path.

## Validation

The regression suite covers both engines through the same `useVoiceMode` entry point, engine selection/teardown, music and subtitles, BYOK setup and route authorization, and provider media/mapping behavior. The initial home-page handoff remains acknowledged across voice restarts and frontend effect replays, so reconnecting after a completed turn does not restart its waiting warning. An unacknowledged handoff still waits through Strict Mode effect replay. Coordinator tests cover failed cancellation, corrections before activity arrives, serialized in-flight commands, disposal during cancellation/submission, late cancelled frames, message boundaries, delayed acknowledgment, and request-card suspension.

Intentional behavior change: Deepgram no longer sends a replacement after failed cancellation or an arbitrary cancellation wait timeout. Both engines require successful cancellation before proceeding. Cancellation is bounded to ten seconds and aborts its HTTP request on timeout; already-queued replacements fail safely, while a fresh utterance can retry. Idle speech tails do not call the agent interrupt endpoint. The shared acknowledgment grace period is 15 seconds and a late-activity warning clears when the stream recovers.

## API references

- [Live WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live)
- [Client delegation](https://developers.openai.com/api/docs/guides/live-delegation)
- [Session creation schema](https://developers.openai.com/api/reference/typescript/resources/live/methods/create)
- [Live prompting](https://developers.openai.com/api/docs/guides/live-prompting)

Pause/resume continues tracking request acknowledgment while suppressing spoken replies. Returning from a request card does not create a new pending turn merely because the agent was active before the pause. Live request bodies are limited by streamed byte count and parsed into typed route context without rebuilding the HTTP adapter's Request object; regression tests exercise chunked input through the development Node adapter.
