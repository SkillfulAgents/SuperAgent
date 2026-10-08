# Conversation voice architecture and OpenAI Live setup

This extends the existing OpenAI voice provider and the microphone experience inside an agent conversation. The Deepgram path remains available.

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
- Backend context. All streamed replies, including final answers, use `session.thinking.append`; longer updates still use the same summarizer. If summarization fails or returns empty text, the original update is sent as thinking so the finish cue cannot lose its outcome context. Appends are UTF-8-byte bounded below the API's 500-token limit and ordered. On reply completion, one `session.commentary.append` says “The backend agent has finished this turn.” It queues behind all pending text and summaries, including when completion adds no new text. Repeated completion snapshots do not repeat the cue. A replacement request, execution error, or closed session invalidates pending replies and cues; no completion cue is sent while paused for a request card. Clarifications, cancellations, execution errors, and application input requests retain direct commentary.
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
- Ordinary agent requests and responses persist through the existing session pipeline. Raw Live transcript fragments and conversational backchannels appear in an ephemeral two-line rolling subtitle (blue for you, orange for the voice agent, with each speaker message on a new line); they are not separately persisted. Startup seeds Live with recent user/assistant text (no tool calls): the renderer sends the newest turns that fit in 40 KiB of JSON (keeping `/live/*` bodies under the host's 128 KiB limit), then the host fills newest-first under a 7,000-token budget estimated with `tokenx` (o200k-calibrated), at most 128 turns, each clipped to its first 1,500 characters, staying under the API's 8,192-token `input` cap; media/attachments still enter through the existing agent composer.
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

### Agent context in Live instructions

Current session voice mode starts through `POST /api/voice/live/agents/:id/session`. The route resolves the agent's canonical ID and requires `AgentUser` access before reading its saved configuration. The host supplies its name, description, custom instructions, and the same workspace subagent/workflow policies passed to backend execution. Browser-supplied instruction fields are ignored. The generic `/live/session` route remains for older clients.

`buildLiveConversationPrompt` combines the voice delegation policy with a compact adaptation of the platform system prompt: account connection/discovery, authorization cards, MCP connections, secrets, research, files, code, artifacts, and scheduling. Unknown service availability is delegated to the backend. Voice must not infer that accounts are already connected or claim completion before a backend result.

Custom instructions are included as saved agent configuration, capped at 6,000 characters and explicitly marked when truncated. The backend retains the full instructions and resolves detailed constraints. This context is a startup snapshot; exiting and re-entering voice reloads changes. It does not enumerate account credentials, connected-account metadata, or tool schemas. Prompt tests and mocked transport tests verify propagation; spoken behavior still needs a live conversation check (for example, “Connect my Gmail account”).

The spoken-update policy asks Live to stay silent for routine progress, tool activity, repeated status, and next-step narration. It should speak for answers, outcomes, meaningful findings or plan changes, blockers, failures, and user decisions, preserving approvals, costs, and application input requests. Backend replies now arrive as thinking context. The application-owned completion cue asks Live to summarize any outcome not yet covered, finish an ongoing summary without restarting, or stay quiet if the user already heard the outcome (adding only missing important details). Turn completion does not imply every action succeeded. No early classification of final versus intermediate text is needed, and streaming continues throughout the turn. Speech selection and avoiding repetition remain model behavior guided by the prompt, not transport guarantees.

A prompt-only experiment on 2026-10-07 (PDT), before the transport change, used `gpt-live-1`, Marin, client delegation, and the primary WebSocket API. Each session received three routine updates, a final result, and an approval request disclosing a $12 cost. The original prompt, a spoken-update policy, and a stricter variant with an explicit silence policy prepended were compared using identical startup history and session-wide commentary. “Current prompt” in the experiment tables below refers to that tested spoken-update policy, before the completion protocol was added. A fourth session repeated it using a synthesized spoken request and the actual client delegation ID returned by Live.

| Prompt and request setup | Routine updates narrated | Final result and approval/cost request narrated |
| --- | --- | --- |
| Original prompt, startup history | 3/3 | 2/2 |
| Current prompt, startup history | 3/3 | 2/2 |
| Stronger silence policy, startup history | 3/3 | 2/2 |
| Current prompt, spoken request and real client delegation | 3/3 | 2/2 |

The probe streamed paced PCM audio continuously, verified every commentary acknowledgment, and recorded both audio and transcripts for at least 12 seconds after each acknowledgment. All four sessions closed successfully, totaling 297 voice seconds. For “Now building the contract,” the current prompt produced “Working on the contract”; the stronger prompt produced “Sure thing, I'm on it.” This small synthetic experiment does not establish that every possible prompt must fail, but the tested prompt changes did not solve the narration problem. They should not be treated as a working suppression mechanism.

A follow-up on the same date sent every test update through `session.thinking.append`, using synthetic spoken input and a real client delegation in all three sessions. Two sessions used the current default prompt; a third prepended a clearer policy that distinguished process updates from completed outcomes, material findings, blockers, and required user actions. The second and third sessions used fresh routine wording plus an exclusivity-clause finding and a rejected-login blocker.

| Thinking experiment | Routine updates narrated | Meaningful updates triggered speech |
| --- | --- | --- |
| Current prompt, original completion/approval examples | 0/3 | 2/2 |
| Current prompt, fresh finding/blocker examples | 3/3 | 2/2 |
| Clearer policy, same fresh examples | 1/3 | 2/2 |

All six meaningful updates triggered speech without another user utterance or commentary event. The first output transcript arrived 526–635 ms after sending each meaningful update. The probe observed each meaningful update for at least 20 seconds after acknowledgment, then allowed a further 15 seconds before sending a separate commentary positive control. Every control was spoken, all thinking appends were acknowledged, and all three sessions closed successfully, totaling 371 voice seconds. No additional transcripts appeared between the test windows and controls.

The first routine window in the first thinking session contained about 300 ms of audio consistent with the tail of the initial acknowledgment, with no new transcript; later sessions waited for two seconds of quiet before testing. Narration counts above concern the supplied updates. Speech triggering also does not establish faithful paraphrasing: the clearer-policy trial changed a finding from “I removed that clause” to “I'm removing it” and added that it had been flagged. These tests establish that thinking context can prompt meaningful spontaneous speech and permit silence, while routine filtering and factual fidelity remain inconsistent.

A further experiment on the same date streamed progress and final results entirely as thinking, then sent a separate completion cue. Final results were split into 100-character fragments, including splits inside words, with approximately one second between acknowledged fragments. Every session used synthetic spoken input and an actual client delegation. A completion-aware prompt asked Live to wait for the cue before summarizing, while still allowing questions, approvals, and blockers to be spoken early.

| Completion experiment | Observed behavior |
| --- | --- |
| Current prompt; delayed commentary `Done.` | Live spoke the final result before the cue, then said only “Ready for your review when you are.” |
| Completion-aware prompt; immediate commentary “The backend agent has finished this turn.” | Routine updates stayed quiet, but the final answer began before the cue and continued through it. This does not establish that the cue triggered a summary. |
| Completion-aware prompt; same commentary cue after a partial failure | Routine updates were narrated, and final speech again began before the cue. The continued answer described the login failure and preserved that nothing was sent or charged. |
| Current prompt; explicit `session.instructions.append` summary request after 2,025 ms of quiet | A fresh summary began 2,320 ms after the cue. It described the created contract draft and tracking link, the blocked signing step, and the account-card action needed from the user. It repeated information already spoken. |

The tested instruction was: “The backend agent has finished this turn. Give a concise spoken summary now, using the results already provided as context. State what was completed and what remains blocked or needs the user. Do not invent success or repeat routine progress.” All appends were acknowledged and all four sessions closed successfully, totaling 296 voice seconds. The instruction-cue result is one isolated trial, not a reliability estimate; commentary-cue speech must not be counted as a newly triggered summary when it merely continues an utterance already underway.

The acceptance criterion is that the user hears the outcome once, not that the completion cue starts a new summary. The “agent finished” commentary trials were good under that criterion: Live continued the summary already underway. The explicit instruction trial repeated information and is not the chosen implementation. The application uses thinking for streamed context and an ordered commentary completion cue, with startup instructions to fill in missing outcomes without repeating them. Those trials did not establish whether the commentary cue reliably elicits a summary when Live has stayed quiet throughout; nor do they guarantee routine-progress suppression.

A smoke test with the implemented startup prompt used the same synthetic spoken request, real client delegation, thinking fragments, and commentary finish cue over WebSocket. Live skipped “Now building the contract,” narrated the tracking-link progress and substantive clause change, and continued the final summary through the cue without restarting. It covered the draft, link, first signer, and unsent status. All seven appends were acknowledged and the session closed successfully after 68 voice seconds. This checks provider behavior; mocked renderer regressions separately cover streaming boundaries, delayed mapping, completion without new text, duplicate snapshots, cancellation, errors, and cues queued during connection or pause. The live test still narrated one of two routine updates.

### Live validation on 2026-10-08

Fourteen additional fresh `gpt-live-1` sessions used synthetic spoken requests, real client delegations, continuous paced PCM input, and the application prompt. Nine exercised the implemented prompt; five retested after the prompt changes described below. Every session closed successfully: 774 total voice seconds and 53 acknowledged application appends. Audio, transcripts, and event timing were recorded; interruption trials also supplied synthesized user speech during output. These were provider tests over WebSocket, with browser integration covered separately using mocked WebRTC and backend execution.

| Scenario | Observation |
| --- | --- |
| Rapid successful completion, before and after prompt changes | Each run covered the draft, link, first signer, and unsent/uncharged status once. Speech began around cue delivery, so these do not isolate the cue from fresh thinking context. |
| Completion after the summary ended | The cue followed at least two seconds of measured quiet. No transcript or audible PCM followed it during the observation window. |
| Partial failure and a blocker arriving after an earlier summary | Both communicated the failed signing login and account-card action without claiming signing succeeded. |
| Approval while paused | Preserved the $12 cost, approval card, and uncharged/unsent status; waited for user approval. |
| Seven rapid/repeated routine updates, then the result | All seven routine updates remained silent. A single outcome summary followed the cue. |
| Sparse incremental facts | Initially claimed the tracking link was prepared before that fact arrived, then repeated known outcomes after the cue. The retest avoided those two behaviors but still added a short closure. |
| Only progress, with no actual result | Initially fabricated that the draft and link were ready. After the prompt change, both independent retests stated that the outcome was unconfirmed or unavailable. One still narrated the routine progress. |
| Spoken “Stop talking. I'll read the result in the app.” | Both initial and updated prompts stopped the summary. The finish cue still elicited a short acknowledgment, despite the explicit silence instruction. |

The prompt now explicitly says the cue supplies no evidence of success, requires confirmed backend facts, explains what to say when only progress is available, forbids predicting results from partial fragments, and preserves user requests for silence across completion. The retests support the missing-result correction in those samples; they do not establish reliable suppression or factuality. Occasional progress narration, closure acknowledgments, and repeated facts remain observed model limitations. A finish cue after silence can elicit speech, but the initial missing-result trial also demonstrates why speech alone is not a passing outcome.

Fault injection also found a deterministic data-loss bug: a failed reply summarizer dropped the backend result while the completion cue still went through. The bridge now falls back to bounded original thinking text. Regression tests cover rejection, empty output, and cancellation while a failing summarizer is pending. Browser regressions cover two consecutive turns (one cue each), cancelling a running turn before a replacement, and four request-card types. The final focused suite has 103 passing tests; all six browser cases, typecheck, and lint pass (52 pre-existing lint warnings).

The temporary probe and schema-validated aggregate are in `/tmp/gamut-live-commentary-probe/`, with `validation-2026-10-08.json` preserving every run's prompt, observation, source report path, event timing, and transcript. Individual `/tmp/gamut-live-completion-results-*/` directories also retain WAV recordings. Browser commands pipe through `tee`; the combined run is preserved in `/tmp/gamut-voice-final-e2e.txt`.

### Capability prompt audit

The voice summary is an index for delegation, not an exhaustive inventory. The backend's full prompt, tools, skills, configuration, assigned integrations, and product FAQs remain authoritative. When uncertain, voice delegates the user's original question/task for a capability check, preserves whether they requested information or execution, and respects confirmed policy blocks.

Prompt audit against `agent-container/src/system-prompt.md`:

| Backend area | Voice-facing coverage |
| --- | --- |
| Memory, standing instructions, own session history, skills | Recall prior work and persist changes through the backend; never just promise to remember. |
| Files, mounts, bookmarks, browser, dashboards, widgets | Explain available work and deliverables; local-machine access depends on mounts/desktop support. |
| Accounts, MCP tools/resources, chat integrations | Discover/check existing access before setup; chat has a separate connection flow. |
| Scheduling, session resumes, triggers/webhooks | Delegate future work; backend chooses the mechanism and verifies platform-dependent triggers. |
| Cross-agent work, subagents, workflows | Respect approval, invocation, and supplied workspace policies. |
| Desktop control, media/audio, enrichment, X, structured search | Describe as conditional; verify runtime availability and preserve costs/approvals before promising work. |
| Product identity, capabilities, help, support, privacy/security | Delegate to the backend for current FAQs and enabled capabilities. |
| Secrets, browser login, authorization, file requests | Use application cards; do not solicit spoken credentials or treat approval waits as failures. |

Execution details (tool schemas, shell commands, endpoint lists, exact prices, memory formats, and rendering procedures) stay with the backend. The request-mapping prompt also classifies capability questions and recall/persistence requests as backend messages, without converting exploratory questions into authorization to act.

Live smoke-test examples: “What can you do?” should consult the backend FAQs; “What did we decide last week?” should search past sessions; “Remember to answer in Spanish” should persist through the backend; “Does this installation support video generation?” should check availability without creating a video; “Make me a daily widget” should delegate artifact work; “Can you access my spreadsheet on this computer?” should check actual access before claiming support or a limitation. These are manual behavioral checks, not guarantees established by prompt-string tests.
