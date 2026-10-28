# Built-In Audio

Read this guide before transcribing audio or generating speech through the
Gamut platform's OpenAI audio proxy.

## Availability and Endpoint

Use this capability only when the system prompt advertises built-in audio.
The platform supplies the credentials; do not ask the user for an OpenAI
account or API key.

Use:

```text
Base: $PLATFORM_BASE_URL/v1/openai
Authorization: Bearer $PLATFORM_AUTH_TOKEN
```

Never print either environment variable. Use the supplied token unchanged; do
not substitute a vendor key or construct an acting-member token yourself.

## What You Can Call

Paths below are relative to the base above. The proxy adds OpenAI's `/v1`
prefix upstream; do not add a second `/v1` after `/openai`.

| Call | Method | Path | Metering rate |
|---|---|---|---|
| Transcribe an uploaded audio file | POST | `/audio/transcriptions` | $0.006 per audio minute, every model |
| Generate speech from text | POST | `/audio/speech` | Per 1,000 input characters by model; see below |

Nothing outside the proxy's allowlist works. Every other OpenAI endpoint
(chat, models, files, realtime, live) returns `404` here.

## Transcribe a File

Send a multipart form with the audio in `file` and the model in `model`. A URL
is not accepted; download the file first, then upload it. OpenAI limits
uploads to 25 MB and accepts flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, and
webm. Split larger files and transcribe the parts.

```bash
curl --fail-with-body -sS \
  "$PLATFORM_BASE_URL/v1/openai/audio/transcriptions" \
  -H "Authorization: Bearer $PLATFORM_AUTH_TOKEN" \
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

## Generate Speech

`/audio/speech` accepts JSON with `model`, `input`, and `voice`, and returns
audio bytes, not JSON. `input` is capped at 4,096 characters per request;
split longer text and concatenate the files. `response_format` may be `mp3`
(default), `opus`, `aac`, `flac`, `wav`, or `pcm`. Voices: `marin`, `cedar`,
`alloy`, `ash`, `ballad`, `coral`, `echo`, `fable`, `nova`, `onyx`, `sage`,
`shimmer`, `verse`.

```bash
curl --fail-with-body -sS \
  "$PLATFORM_BASE_URL/v1/openai/audio/speech" \
  -H "Authorization: Bearer $PLATFORM_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini-tts","input":"Your report is ready.","voice":"marin","instructions":"Speak warmly and at an unhurried pace."}' \
  -o /workspace/speech.mp3
```

`instructions` (delivery style) works only with `gpt-4o-mini-tts`. `tts-1`
and `tts-1-hd` ignore it. `speed` (0.25 to 4.0) works on all three. Use the
plain `gpt-4o-mini-tts` alias, not a dated snapshot such as
`gpt-4o-mini-tts-2025-12-15`: the platform prices unknown model names at the
highest rate.

Check that the request succeeded before treating the output file as audio;
an error response may have been written to it. Deliver generated files with
the file-delivery tool.

## Live Transcription

WebSocket, realtime, and live transcription are not available to agents.
`realtime/client_secrets` and `live/sessions` are reserved for the app's own
voice mode; do not call them. Use recorded transcription for file tasks.

## Every Paid Operation Costs Money

Transcription is metered per audio minute:

| Model | Per audio minute |
|---|---|
| any model (`whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `gpt-4o-transcribe-diarize`, ...) | $0.006 |

Speech generation is metered per 1,000 input characters:

| Model | Per 1,000 characters |
|---|---|
| `tts-1` | $0.015 |
| `gpt-4o-mini-tts` | $0.02 |
| `tts-1-hd` or any other model | $0.03 |

These are platform metering rates, not a complete model-availability list.
When duration metadata is missing from a transcription response, the platform
estimates duration from the upload size with a minimum of one minute: every
response except `whisper-1` with `json` or `verbose_json`.

Process only the audio the task needs. Reuse saved transcripts rather than
resubmitting the same recording. Before long recordings, large batches, or
substantial speech generation, estimate the cost and get the user's OK.

## Limits and Errors

- JSON bodies for `/audio/speech` are capped at 1,000,000 bytes. This proxy
  cap does not apply to `/audio/transcriptions` uploads; upstream vendor
  limits still apply (25 MB).
- `400`: inspect the response. Fix a malformed multipart form, or correct the
  request. An acting-member error is a platform configuration problem; do not
  invent a member ID.
- `401` / `403`: authentication or access failed. Do not request a vendor key
  to work around platform access controls.
- `402`: platform billing access is blocked. Report the billing requirement
  rather than retrying.
- `404`: the method or path is unsupported. Do not invent alternate paths.
- `413`: the request body is too large.
- `429`: honor `Retry-After` if provided; otherwise back off and retry once.
  Do not loop on rate limits.
- `503` with `configuration_error`: OpenAI voice is not configured on this
  proxy. Report the configuration error; do not ask for a key.
- Other upstream failures: report the returned error without exposing tokens.
  Do not blindly replay a paid request after a timeout; it may have completed.
