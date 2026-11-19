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
set -o pipefail
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

### 2. Read the schema with `GET /models/{owner}/{name}`

Replace `fox-poster` with a short name for this run. Keep the printed directory
for step 3. The helper saves the model's output schema there for the downloader.

```bash
set -euo pipefail
RUN=$(mktemp -d /workspace/fox-poster.XXXXXXXX)
printf 'Run directory %s\n' "$RUN"
curl -sSf "$PLATFORM_BASE_URL/v1/replicate/models/{owner}/{name}" \
  -H "Authorization: Bearer $PLATFORM_AUTH_TOKEN" \
  | node /app/dist/scripts/media-output.js schema "$RUN" \
  | jq -c 'with_entries(select(.key | test("^(Status|WebhookEvent|Prediction.*|.*ValidationError)$") | not))
      | walk(if type == "object" then del(.title, ."x-order") else . end)'
```

`Input` lists the fields. A field that points to `#/components/schemas/<name>`
takes the allowed values listed under that name. Read them before building a
request. Only slugs from the list resolve here.

### 3. Run with `POST /models/{owner}/{name}/predictions`

Use the directory from step 2, the selected model slug, and an input shaped by
its schema. The platform drops `Prefer: wait`, so poll using the ID from the
create response.

```bash
set -euo pipefail
RUN=/workspace/fox-poster.REPLACE_ME
test -r "$RUN/.model-schema.json"
AUTH="Authorization: Bearer $PLATFORM_AUTH_TOKEN"
P=$(curl -sS -X POST "$PLATFORM_BASE_URL/v1/replicate/models/{owner}/{name}/predictions" \
  -H "$AUTH" -H "Content-Type: application/json" -d '{"input": {"prompt": "..."}}')
ID=$(jq -er '.id | strings | select(test("^[a-zA-Z0-9_-]+$"))' <<<"$P") || { printf '%s\n' "$P"; exit 1; }
printf 'Prediction directory %s/%s\n' "$RUN" "$ID"
mkdir -- "$RUN/$ID"
while jq -e '.status == "starting" or .status == "processing"' <<<"$P" >/dev/null; do
  sleep 3
  P=$(curl -fsS "$PLATFORM_BASE_URL/v1/replicate/predictions/$ID" -H "$AUTH")
done
jq -c '{id, model, input: {prompt: .input.prompt}, status, error, output}' <<<"$P"
[ "$(jq -r .status <<<"$P")" = succeeded ] || exit 1
node /app/dist/scripts/media-output.js save "$RUN" <<<"$P"
```

Keep the `jq -c` line intact. Chat uses it to display the prediction, including
failed, canceled, and aborted jobs. Each saved file gets a line with its size
and path. For a text deliverable, use the model's output schema. For example,
use `jq -r '.output | join("")'` for transcript chunks or `jq -r '.output.text'`
for an OCR result.

For a long run, start step 3 in the background. When Bash returns a task ID,
wait for that task and read its output file for the prediction directory.
Run this short **foreground** command with that directory to give the chat
row the completed prediction. If Bash was interrupted, the subdirectory under
the run directory from step 2 also preserves the prediction ID.

```bash
set -euo pipefail
DIR=/workspace/fox-poster.REPLACE_ME/PREDICTION_ID
ID=${DIR##*/}
P=$(curl -fsS "$PLATFORM_BASE_URL/v1/replicate/predictions/$ID" \
  -H "Authorization: Bearer $PLATFORM_AUTH_TOKEN")
jq -c '{id, model, input: {prompt: .input.prompt}, status, error, output}' <<<"$P"
case "$(jq -r .status <<<"$P")" in failed|canceled|aborted) exit 1 ;; esac
```

To resume an interrupted run, poll that same ID until it reaches a terminal
state. To recover its files, append
`node /app/dist/scripts/media-output.js save "${DIR%/*}" <<<"$P"` to the
successful poll. Creating another prediction starts another billable job.

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

Output URLs expire, often in about an hour. The run command saves files from
the schema's URI fields under the prediction directory. Downloads use HTTPS
on the Replicate delivery host. Other URLs remain available in the prediction.

For multiple outputs, save all requested variants and identify them clearly.
Use `mcp__user-input__deliver_file` when the user needs a downloadable asset.
Do not present an expiring remote URL as the final deliverable.

## Validation

- Confirm from the run command's file list that each saved file is non-empty.
- Inspect generated images before delivering them.
- For audio or video, verify the container/codec is usable when tooling permits.
- Report model or safety refusals accurately; do not silently switch the user's
  requested medium or subject.
