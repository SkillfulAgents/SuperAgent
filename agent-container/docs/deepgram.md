# Built-In Deepgram Audio

Read this guide before transcribing audio, generating speech, or analyzing text
through the Gamut platform's Deepgram proxy.

## Availability and Endpoint

Use this capability only when the system prompt advertises built-in Deepgram
access. The platform supplies the Deepgram credentials; do not ask the user for
a Deepgram account or API key.

Use:

```text
Base: $ANTHROPIC_BASE_URL/v1/deepgram
Authorization: Bearer $ANTHROPIC_AUTH_TOKEN
```

Never print either environment variable. Use the supplied token unchanged; do
not substitute a Deepgram key or construct an acting-member token yourself.

## What You Can Call

Paths below are relative to the base above. The proxy adds Deepgram's `/v1`
prefix upstream; do not add a second `/v1` after `/deepgram`.

| Call | Method | Path | Metering rate |
|---|---|---|---|
| Transcribe recorded audio or video | POST | `/listen` | Depends on model and audio duration; see below |
| Generate speech from text | POST | `/speak` | $0.03 per 1,000 input characters |
| Analyze text | POST | `/read` | $0.002 per request |
| Obtain a short-lived token for live transcription | POST | `/auth/grant` | No per-request usage charge on the grant itself |

Nothing outside the proxy's allowlist works. Management APIs are not available.
`GET /projects` exists for legacy credential checks but returns a masked empty
project list; do not use it to discover projects or capabilities.

## Transcribe a File

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

The proxy streams the audio upload but buffers the transcription response.
Wait for the completed JSON response; this is not a live transcription stream.
`callback` and `callback_method` are not supported.

## Generate Speech

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

Check that the request succeeded before treating the output file as audio;
an error response may have been written to it. Deliver generated files with
the file-delivery tool.

## Live Transcription

WebSocket transcription is not supported through this proxy. Live clients
obtain a short-lived token from `POST /auth/grant`, then connect directly to
Deepgram using that token. The grant TTL is capped at 900 seconds.

Use recorded transcription for file tasks. Do not obtain or expose grant
tokens unless the task specifically needs live transcription; never print
or persist them in guides, logs, or user-facing output.

## Every Paid Operation Costs Money

Recorded transcription is metered from the returned audio duration and the
requested model:

| Model | Per audio minute |
|---|---|
| `nova-3`, `nova-3-general`, `nova-3-medical` | $0.0077 |
| `nova-3-multilingual` | $0.0092 |
| `nova-2` | $0.0058 |

These are platform metering rates, not a complete model-availability list.
Unknown models use a fallback rate of $0.0092 per minute. If duration metadata
is missing, the platform estimates duration from the upload size with a
minimum of one minute. Text analysis currently uses a flat per-request rate.

Process only the audio or text the task needs. Reuse saved transcripts rather
than resubmitting the same recording. Before long recordings, large batches,
or substantial speech generation, estimate the cost and get the user's OK.

## Limits and Errors

- JSON bodies for `/auth/grant`, `/speak`, and `/read` are capped at 1,000,000
  bytes. This proxy cap does not apply to `/listen` audio uploads; upstream
  Deepgram limits still apply.
- `400`: inspect the response. Remove unsupported callback parameters, or
  correct the request. An acting-member error is a platform configuration
  problem; do not invent a member ID.
- `401` / `403`: authentication or access failed. Do not request a vendor key
  to work around platform access controls.
- `402`: platform billing access is blocked. Report the billing requirement
  rather than retrying.
- `404`: the method or path is unsupported. Do not invent alternate paths.
- `413`: the request body is too large.
- `429`: honor `Retry-After` if provided; otherwise back off and retry once.
  Do not loop on rate limits.
- Other upstream failures: report the returned error without exposing tokens.
  Do not blindly replay a paid request after a timeout; it may have completed.
