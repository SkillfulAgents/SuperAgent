# Grok Subscription Responses live validation

This suite runs real Grok inference through the built production proxy and bundled
Claude Agent SDK/`ClaudeCodeProcess`. It executes Bash, Read, Edit, deferred MCP
tools, Chromium screenshots, native hosted WebSearch, continuation and session
resume. A direct image request and a Read image result exercise both image paths.

The same-name parallel MCP fetch regression uses three local HTTP pages and a
small test host bridge. The model, MCP calls, HTTP page fetches, tool-result replay
and final synthesis are real; the external web vendor is not part of that case.
Hosted WebSearch separately exercises live internet search. No email or chat
message is sent. Every turn asserts actual `text_delta` events and valid block
indices, covering the missing-stream failure that motivated PR #1186.

Use a dedicated local Grok test connection. Preparation uses the app credential
service, including its persisted refresh if needed, and writes an access-only
runtime with owner-only permissions. The runtime is sensitive; keep it outside
the repository and remove it after the run. Never print or commit it.

From the repository root, with dependencies installed:

```bash
docker build -t superagent-container:grok-responses ./agent-container
mkdir -p /tmp/grok-responses-live/results
chmod 700 /tmp/grok-responses-live
SUPERAGENT_DATA_DIR=/path/to/test-app-data npx tsx e2e/live/grok-responses/prepare.ts \
  --connection <grok-connection-id> --out /tmp/grok-responses-live/runtime.json
set -o pipefail
docker run --rm --name grok-responses-live --shm-size=1g \
  -v /tmp/grok-responses-live/runtime.json:/run/grok-runtime.json:ro \
  -v "$PWD/e2e/live/grok-responses:/tests:ro" \
  -v /tmp/grok-responses-live/results:/results \
  superagent-container:grok-responses node /tests/run.cjs \
  2>&1 | tee /tmp/grok-responses-live/e2e.log
```

The image's `claude` user (UID 1000) must be able to read the runtime and write the
results directory. `report.json` contains per-case assertions/evidence, session
ID, SDK version, structural upstream counters, and the fixture URLs fetched.
It contains no credentials. The suite fails on tool errors, malformed stream
indices, a turn without text deltas, missing parallel tool-call groups, or any
Grok request to `/messages`. Assertions use actual tool inputs and file contents,
not just the model's claim that it completed the work.

The test runtime needs a token valid for the duration of the run. The local test
host bridge does not implement credential refresh; refresh/reconnect behavior
is covered by the app/proxy integration tests.
