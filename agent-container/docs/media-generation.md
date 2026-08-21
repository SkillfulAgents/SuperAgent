# Built-In Media Generation

Read this guide before generating or editing an image, video, speech, music,
3D asset, or talking-head clip through the Gamut platform service.

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

## The Three Calls: List, Schema, Create

Always run them in this order. The list is the allowlist; nothing outside it
works, and there is no separate Gamut allowlist to consult.

### 1. List

```bash
curl -sS "$ANTHROPIC_BASE_URL/v1/replicate/models?kind=image" \
  -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN"
```

Always pass `kind`. Valid values are `image`, `video`, `audio`,
`talking_head`, `3d`, and `document`. Each returned row carries the model slug,
its kind, and what a run costs.

Pick the row that matches the requested medium and transformation, and preserve
the user's stated style, aspect ratio, duration, fidelity, and file format.
Never invent a slug or substitute a model the list did not return — the table
is the menu, and it changes without notice.

### 2. Schema

```text
GET /models/{owner}/{name}
```

Read the input fields before building a request. Only slugs from the list
resolve here.

### 3. Create

```text
POST /models/{owner}/{name}/predictions
```

Send `{"input": {...}}` shaped by the schema. Add `Prefer: wait` for images and
speech, which finish quickly; omit it for video or anything else long-running,
and poll instead:

```text
GET /predictions/{id}
```

A `403` means the slug is not on the current list — go back to step 1 rather
than retrying or guessing a variant. Do not invent alternate paths when the
platform rejects a request.

## Confirm Cost Before Expensive Runs

Before video, music, 3D, talking-head, or voice cloning, tell the user what the
run costs — the figure is in the model's list row — and get an explicit OK.
Quote the cost from the row you actually intend to use; do not estimate it or
carry over a figure from a different model.

Images and ordinary speech do not need a cost confirmation unless the user
asked to be consulted.

## Supplying Source Media

When a model's schema takes a media input, pass a reachable `http(s)` URL to
the file itself — not a page that embeds it, and not a text description. A link
to a viewer page fails or produces garbage, because the model fetches the URL
directly.

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
