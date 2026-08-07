---
name: media-generation
description: Generate images, video, music, speech and more via Replicate models — use whenever the user asks for media generation/editing. Requires the owner's Replicate key; if refused for a missing key, ask the user to add one in Settings → Media Generation.
---

# Media Generation (Replicate)

Generate images, video, music, speech, and related media through the host Replicate lane. The key stays on the host; authenticate with the existing proxy token.

```bash
BASE="$SUPERAGENT_HOST_API_URL/replicate"
AUTH="Authorization: Bearer $PROXY_TOKEN"
```

## Workflow

1. **Catalog** — approved models by category. The `official` flag decides which create path to use.

```bash
curl -sH "$AUTH" "$BASE/catalog"
```

2. **Schema** — read the chosen model's input format from `latest_version.openapi_schema`.

```bash
curl -sH "$AUTH" "$BASE/v1/models/{owner}/{name}"
```

3. **Create** — prefer a sync wait so short runs finish in one call. Use a curl timeout of at least 75s (Prefer wait is 55s).

Official models:

```bash
curl -sH "$AUTH" -H "Content-Type: application/json" -H "Prefer: wait=55" --max-time 90 \
  -d '{"input":{...}}' \
  "$BASE/v1/models/{owner}/{name}/predictions"
```

Community models (qualified version form required):

```bash
curl -sH "$AUTH" -H "Content-Type: application/json" -H "Prefer: wait=55" --max-time 90 \
  -d '{"version":"{owner}/{name}:{latest_version.id}","input":{...}}' \
  "$BASE/v1/predictions"
```

4. **Poll** if status is not terminal (`succeeded` / `failed` / `canceled`):

```bash
curl -sH "$AUTH" "$BASE/v1/predictions/{id}"
```

Poll about every 5 seconds until terminal.

5. **Download outputs immediately** into the workspace. Replicate deletes delivery URLs after about 1 hour.

```bash
mkdir -p /workspace/output
curl -o /workspace/output/<file> <each output URL>
```

6. **Deliver** each saved file to the user with `deliver_file`.

## Caps and refusals

- Runs auto-cancel at 10 minutes. A `canceled` status means the cap was hit: report it, do not retry forever.
- A `429` is Replicate throttling the owner's account, not a refusal. Wait the number of seconds in the response's `retry_after` field, then retry once. If it keeps throttling, tell the user their Replicate account is rate limited — a balance under $5 drops the limit to 6 creates per minute.
- If the lane refuses with a missing-key message, ask the user to add a Replicate API key in Settings → Media Generation.
- Webhooks are stripped by the lane. Vendor search and collections are not exposed — use the catalog as the model list.
