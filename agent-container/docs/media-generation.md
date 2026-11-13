# Built-In Media Generation

Read this guide before generating or editing an image, video, speech, music,
3D asset, or talking-head clip through the Gamut platform service.

## Availability and Endpoint

This capability is available only when the system prompt advertises built-in
media generation. It uses the platform's Replicate-compatible proxy and does
not require the user to create a Replicate account or supply an API key.

Use:

```text
Base: $PLATFORM_BASE_URL/v1/replicate
Authorization: Bearer $PLATFORM_AUTH_TOKEN
```

Never print either environment variable.

## The Three Steps: List, Schema, Run

Always run them in this order, one command each. The list is the allowlist;
nothing outside it works, and there is no separate Gamut allowlist to consult.

### 1. List

```bash
curl -sSf "$PLATFORM_BASE_URL/v1/replicate/models?kind=image" \
  -H "Authorization: Bearer $PLATFORM_AUTH_TOKEN" \
  | jq -c '.data[] | {id, about: .description[:100], pricing}'
```

Always pass `kind`. Valid values are `image`, `video`, `audio`,
`talking_head`, `3d`, and `document`. The full response is large, so keep the
`jq` projection: each row is then one line with the model slug, what it does,
and its pricing.

Pick the row that matches the requested medium and transformation, and preserve
the user's stated style, aspect ratio, duration, fidelity, and file format.
Never invent a slug or substitute a model the list did not return — the table
is the menu, and it changes without notice.

### 2. Schema: `GET /models/{owner}/{name}`

```bash
curl -sSf "$PLATFORM_BASE_URL/v1/replicate/models/{owner}/{name}" \
  -H "Authorization: Bearer $PLATFORM_AUTH_TOKEN" \
  | jq -c '.latest_version.openapi_schema.components.schemas
      | with_entries(select(.key | test("^(Output|Status|WebhookEvent|Prediction.*|.*ValidationError)$") | not))
      | walk(if type == "object" then del(.title, ."x-order") else . end)'
```

`Input` lists the fields. A field that points to `#/components/schemas/<name>`
takes the allowed values listed under that name. Read them before building a
request. Only slugs from the list resolve here.

### 3. Run: `POST /models/{owner}/{name}/predictions`, wait, save

Create the prediction, wait for it, and save its output in one command. Send
`{"input": {...}}` shaped by the schema, and do not send `Prefer: wait`; it is
dropped.

```bash
N=fox-poster  # a short name for the saved files, no spaces
AUTH="Authorization: Bearer $PLATFORM_AUTH_TOKEN"
P=$(curl -sS -X POST "$PLATFORM_BASE_URL/v1/replicate/models/{owner}/{name}/predictions" \
  -H "$AUTH" -H "Content-Type: application/json" -d '{"input": {"prompt": "..."}}')
ID=$(jq -r '.id // empty' <<<"$P")
[ -n "$ID" ] || { echo "$P"; exit 1; }
echo "prediction $ID"; echo "$ID" > "/workspace/$N.prediction"
while [ "$(jq -r .status <<<"$P")" = starting ] || [ "$(jq -r .status <<<"$P")" = processing ]; do
  sleep 3; P=$(curl -fsS "$PLATFORM_BASE_URL/v1/replicate/predictions/$ID" -H "$AUTH") \
    || { echo "polling stopped; check later with GET /predictions/$ID"; exit 1; }
done
[ "$(jq -r .status <<<"$P" 2>/dev/null)" = succeeded ] || { echo "$P"; exit 1; }
jq -c '{id, model, status, output}' <<<"$P"
jq -r '.output | .. | strings | select(startswith("https://"))' <<<"$P" | nl -nln \
  | while read -r n url; do f=${url%%[?#]*}; curl -fsSL -o "/workspace/$N-$n-${f##*/}" "$url" || exit 1; done \
  || exit 1
ls -l /workspace/"$N"-* 2>/dev/null || true
```

Replace `N`, `{owner}/{name}`, and the input, and keep the rest
as is. The chat reads the `jq -c` line to show the user the model, status, and
output, so do not reword or drop it. The command prints the prediction id
first, then the finished prediction on one line, saves each output file to
`/workspace`, and lists the saved files. A refused request, a job that failed or
was canceled, or a download that failed prints the reason and stops.

Some models return text instead of files (OCR, transcripts). The finished
prediction line already carries it; save it with `jq -r .output` when the user
needs a file.

Video and other long jobs can run for minutes: run the command in the
background and wait for it. If a run is cut off before it prints the finished
prediction, do not create the job again. Read the id from
`/workspace/<N>.prediction`, check it with `GET /predictions/{id}`, and save the
outputs from there.

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

Output URLs expire, often in about an hour. The run command above downloads
every output file into `/workspace` as soon as the prediction succeeds, named
after `N` with the original extension.

For multiple outputs, save all requested variants and identify them clearly.
Use `mcp__user-input__deliver_file` when the user needs a downloadable asset.
Do not present an expiring remote URL as the final deliverable.

## Validation

- Confirm from the run command's file list that each saved file is non-empty.
- Inspect generated images before delivering them.
- For audio or video, verify the container/codec is usable when tooling permits.
- Report model or safety refusals accurately; do not silently switch the user's
  requested medium or subject.
