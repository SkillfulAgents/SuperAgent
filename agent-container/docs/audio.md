# Built-In Audio (Deepgram and OpenAI)

Read this guide before transcribing audio, generating speech, or analyzing text
through the Gamut platform. Two audio providers are available through the
proxy: Deepgram and OpenAI. Pick one per task using the comparison below.

## Availability and Endpoints

Use this capability only when the system prompt advertises built-in audio.
The platform supplies the provider credentials; do not ask the user for a
Deepgram or OpenAI account or API key.

Use:

```text
Deepgram base: $ANTHROPIC_BASE_URL/v1/deepgram
OpenAI base:   $ANTHROPIC_BASE_URL/v1/openai
Authorization: Bearer $ANTHROPIC_AUTH_TOKEN
```

Never print either environment variable. Use the supplied token unchanged; do
not substitute a vendor key or construct an acting-member token yourself.

## Choosing a Provider

| Need | Use | Why |
|---|---|---|
| Transcribe a file you have on disk, plain text result | Either; OpenAI `whisper-1` is cheaper per minute | $0.006/min vs $0.0077/min |
| Transcribe from a URL without downloading | Deepgram `/listen` | OpenAI only accepts an uploaded file |
| Large recording (over 25 MB) | Deepgram `/listen` | OpenAI rejects uploads over 25 MB; split the file otherwise |
| Speaker labels | Either: Deepgram `diarize=true`, or OpenAI `gpt-4o-transcribe-diarize` | Deepgram labels every word; OpenAI returns speaker segments in `diarized_json` |
| Multichannel, word timing, keyword boosting | Deepgram `/listen` | Structured `results.channels[].alternatives[].words` with `multichannel` |
| Subtitles (`srt` / `vtt`) directly | OpenAI `/audio/transcriptions` with `whisper-1` | `response_format=srt` or `vtt` |
| Text to speech, lowest cost | OpenAI `tts-1` | $0.015 per 1,000 chars |
| Text to speech with style control ("speak calmly", "whisper") | OpenAI `gpt-4o-mini-tts` with `instructions` | Deepgram voices take no style prompt |
| Text to speech matching the app's Deepgram voices | Deepgram `/speak` | `aura-2-*` voice models |
| Text analysis (sentiment, topics, intents, summary) | Deepgram `/read` | OpenAI has no equivalent on this lane |
| Live transcription token | Deepgram `/auth/grant` | The OpenAI realtime and Live routes are for the app, not for agents |

When the user has no preference and the task is a plain file transcript or a
short spoken message, use OpenAI. When the task needs structure (speakers,
timing, channels) or the audio is only reachable by URL, use Deepgram.

## What You Can Call

Paths below are relative to each base. Both proxies add the vendor's `/v1`
prefix upstream; do not add a second `/v1` after `/deepgram` or `/openai`.

### Deepgram

| Call | Method | Path | Metering rate |
|---|---|---|---|
| Transcribe recorded audio or video | POST | `/listen` | Depends on model and audio duration; see below |
| Generate speech from text | POST | `/speak` | $0.03 per 1,000 input characters |
| Analyze text | POST | `/read` | $0.002 per request |
| Obtain a short-lived token for live transcription | POST | `/auth/grant` | No per-request usage charge on the grant itself |

### OpenAI

| Call | Method | Path | Metering rate |
|---|---|---|---|
| Transcribe an uploaded audio file | POST | `/audio/transcriptions` | $0.006 per audio minute, every model |
| Generate speech from text | POST | `/audio/speech` | Per 1,000 input characters by model; see below |

Nothing outside the proxies' allowlists works. Deepgram management APIs and
every other OpenAI endpoint (chat, models, files, realtime, live) return `404`
here. Deepgram `GET /projects` exists for legacy credential checks but returns
a masked empty project list; do not use it to discover projects or
capabilities.

## Transcribe a File with Deepgram

Send the audio bytes, not a multipart upload or a base64-encoded JSON body.
Match `Content-Type` to the actual file format.

```bash
curl --fail-with-body -sS \
  "$ANTHROPIC_BASE_URL/v1/deepgram/listen?model=nova-3&smart_format=true" \
  -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" \
  -H "Content-Type: audio/wav" \
  --data-binary @/workspace/uploads/audio.wav \
  -o /workspace/transcript.json
```

Alternatively, send `Content-Type: application/json` with a body of
`{"url":"..."}` using an actual audio URL supplied by the user or obtained for
the task. Deepgram must be able to fetch that URL. Do not send private audio to
an unrelated hosting service merely to obtain a public URL.

The transcript is at `results.channels[0].alternatives[0].transcript` for a
single-channel result. Read all returned channels when transcribing
multichannel audio. Word-level timing is in the alternative's `words` array.
Add `diarize=true` for speaker labels on each word.

The proxy streams the audio upload but buffers the transcription response.
Wait for the completed JSON response; this is not a live transcription stream.
`callback` and `callback_method` are not supported.

## Transcribe a File with OpenAI

Send a multipart form with the audio in `file` and the model in `model`. A URL
is not accepted; the file must be local. OpenAI limits uploads to 25 MB and
accepts flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, and webm.

```bash
curl --fail-with-body -sS \
  "$ANTHROPIC_BASE_URL/v1/openai/audio/transcriptions" \
  -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" \
  -F "file=@/workspace/uploads/audio.mp3" \
  -F "model=whisper-1" \
  -F "response_format=json" \
  -o /workspace/transcript.json
```

The transcript is in `text`. Use `model=whisper-1` for file work: it is the
model that supports `response_format=srt`, `vtt`, and `verbose_json` (segment
and word timestamps via `timestamp_granularities[]`). With `json` or
`verbose_json` it also returns the audio duration, so the charge is exact;
`srt`, `vtt`, and `text` responses carry no duration and are charged from the
upload size instead. `gpt-4o-transcribe` and `gpt-4o-mini-transcribe` support
`response_format=json` only and carry no duration. For speaker labels use
`model=gpt-4o-transcribe-diarize` with `response_format=diarized_json`, and
add `chunking_strategy=auto` when the audio is longer than 30 seconds. Set
`language` (ISO-639-1) when you know it; it improves accuracy and speed.

## Generate Speech with Deepgram

`/speak` accepts JSON with a `text` field and returns audio bytes, not JSON.
Choose a supported Deepgram voice model explicitly.

```bash
curl --fail-with-body -sS \
  "$ANTHROPIC_BASE_URL/v1/deepgram/speak?model=aura-2-thalia-en&encoding=mp3" \
  -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"Your report is ready."}' \
  -o /workspace/speech.mp3
```

## Generate Speech with OpenAI

`/audio/speech` accepts JSON with `model`, `input`, and `voice`, and returns
audio bytes, not JSON. `input` is capped at 4,096 characters per request;
split longer text and concatenate the files. `response_format` may be `mp3`
(default), `opus`, `aac`, `flac`, `wav`, or `pcm`. Voices: `marin`, `cedar`,
`alloy`, `ash`, `ballad`, `coral`, `echo`, `fable`, `nova`, `onyx`, `sage`,
`shimmer`, `verse`.

```bash
curl --fail-with-body -sS \
  "$ANTHROPIC_BASE_URL/v1/openai/audio/speech" \
  -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini-tts","input":"Your report is ready.","voice":"marin","instructions":"Speak warmly and at an unhurried pace."}' \
  -o /workspace/speech.mp3
```

`instructions` (delivery style) works only with `gpt-4o-mini-tts`. `tts-1`
and `tts-1-hd` ignore it. `speed` (0.25 to 4.0) works on all three. Use the
plain `gpt-4o-mini-tts` alias, not a dated snapshot such as
`gpt-4o-mini-tts-2025-12-15`: the platform prices unknown model names at the
highest rate.

For either provider, check that the request succeeded before treating the
output file as audio; an error response may have been written to it. Deliver
generated files with the file-delivery tool.

## Live Transcription

WebSocket transcription is not supported through this proxy. Live clients
obtain a short-lived token from Deepgram `POST /auth/grant`, then connect
directly to Deepgram using that token. The grant TTL is capped at 900 seconds.
The OpenAI `realtime/client_secrets` and `live/sessions` routes are reserved
for the Gamut app's own voice mode; do not call them from an agent.

Use recorded transcription for file tasks. Do not obtain or expose grant
tokens unless the task specifically needs live transcription; never print
or persist them in guides, logs, or user-facing output.

## Every Paid Operation Costs Money

Transcription is metered per audio minute by provider and model:

| Provider | Model | Per audio minute |
|---|---|---|
| Deepgram | `nova-3`, `nova-3-general`, `nova-3-medical` | $0.0077 |
| Deepgram | `nova-3-multilingual` | $0.0092 |
| Deepgram | `nova-2` | $0.0058 |
| Deepgram | any other model | $0.0092 |
| OpenAI | any model (`whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `gpt-4o-transcribe-diarize`, ...) | $0.006 |

Speech generation is metered per 1,000 input characters:

| Provider | Model | Per 1,000 characters |
|---|---|---|
| Deepgram | any `aura-*` voice | $0.03 |
| OpenAI | `tts-1` | $0.015 |
| OpenAI | `gpt-4o-mini-tts` | $0.02 |
| OpenAI | `tts-1-hd` or any other model | $0.03 |

These are platform metering rates, not a complete model-availability list.
When duration metadata is missing from a transcription response, the platform
estimates duration from the upload size with a minimum of one minute; on the
OpenAI lane that is every response except `whisper-1` with `json` or
`verbose_json`. Deepgram text analysis uses a flat $0.002 per request.

Process only the audio or text the task needs. Reuse saved transcripts rather
than resubmitting the same recording. Before long recordings, large batches,
or substantial speech generation, estimate the cost and get the user's OK.

## Limits and Errors

- JSON bodies for Deepgram `/auth/grant`, `/speak`, `/read` and OpenAI
  `/audio/speech` are capped at 1,000,000 bytes. This proxy cap does not apply
  to Deepgram `/listen` or OpenAI `/audio/transcriptions` uploads; upstream
  vendor limits still apply (OpenAI: 25 MB).
- `400`: inspect the response. Remove unsupported callback parameters, fix a
  malformed multipart form, or correct the request. An acting-member error is
  a platform configuration problem; do not invent a member ID.
- `401` / `403`: authentication or access failed. Do not request a vendor key
  to work around platform access controls.
- `402`: platform billing access is blocked. Report the billing requirement
  rather than retrying.
- `404`: the method or path is unsupported. Do not invent alternate paths.
- `413`: the request body is too large.
- `429`: honor `Retry-After` if provided; otherwise back off and retry once.
  Do not loop on rate limits.
- `503` with `configuration_error` on the OpenAI lane: OpenAI voice is not
  configured on this proxy. Use Deepgram if it fits the task; do not ask for
  a key.
- Other upstream failures: report the returned error without exposing tokens.
  Do not blindly replay a paid request after a timeout; it may have completed.
