# Built-In Media Generation

Read this guide before generating an image, video, or audio asset through the
Gamut platform service.

## Availability and Endpoint

This capability is available only when the system prompt advertises built-in
media generation. It uses the platform's Replicate-compatible proxy and does
not require the user to create a Replicate account or supply an API key.

Use:

```text
Base: $ANTHROPIC_BASE_URL/v1/replicate
Authorization: Bearer $ANTHROPIC_AUTH_TOKEN
```

Never print either environment variable.

## Discover Models

List the currently allowed models before choosing one:

```bash
curl -sS "$ANTHROPIC_BASE_URL/v1/replicate/models/_/_" \
  -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN"
```

If listing is refused, the platform error includes the available models. Use
only an exact returned model slug; do not guess slugs or substitute an
unadvertised model.

Choose a model that matches the requested medium and transformation. Preserve
the user's stated style, aspect ratio, duration, fidelity, and file-format
requirements. Confirm with the user before generating video or music.

## Create and Poll

Create a prediction with:

```text
POST /models/{owner}/{name}/predictions
```

Send the model-specific input in the JSON body. Add `Prefer: wait` when a short
synchronous wait is appropriate. If the response is still processing, poll:

```text
GET /predictions/{id}
```

Do not invent alternate paths when the platform rejects a request. Inspect the
returned error and the allowed-model response instead.

## Save Outputs Immediately

Output URLs expire, often in about an hour. Download every output the user may
need into `/workspace` as soon as the prediction succeeds. Use descriptive
filenames and retain the original extension when possible.

For multiple outputs, save all requested variants and identify them clearly.
Use `mcp__user-input__deliver_file` when the user needs a downloadable asset.
Do not present an expiring remote URL as the final deliverable.

## Validation

- Confirm that the downloaded file exists and is non-empty.
- Inspect generated images before delivering them.
- For audio or video, verify the container/codec is usable when tooling permits.
- Report model or safety refusals accurately; do not silently switch the user's
  requested medium or subject.
