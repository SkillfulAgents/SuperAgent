# Real container runtime smoke

This opt-in harness exercises a running, isolated **real application → Docker
agent → model → tools** stack. It makes paid model calls. It does not build the
application, modify provider credentials, or use `E2E_MOCK`.

Start an isolated app with a scratch `SUPERAGENT_DATA_DIR`, a dedicated port and
agent port range, Docker socket access, and the candidate agent image configured
as its container image. For a Docker-hosted app, the scratch data directory must
be mounted at the same absolute path inside and outside the app: the Docker
daemon resolves the agent workspace bind mounts on the host. Do not use the
default compose file against your personal data directory.

Create a provider connection in that scratch app before running. Both an
Anthropic API connection and a Claude Subscription connection are supported by
the app's normal session flow. Pass its **connection ID**, not a credential, via
`CONTAINER_SMOKE_PROVIDER_ID`. The runner does not read provider settings or
credential files. Select a model supported by that connection with
`CONTAINER_SMOKE_MODEL` or `--model` (default: `claude-haiku-5-5`; use the exact
catalog ID offered by your connection). A Claude
Subscription run validates agent SDK calls; it does not claim to validate the
separate direct-API summarizer or dashboard LLM API.

With repository dependencies and Playwright Chromium already installed:

```bash
set -o pipefail
CONTAINER_SMOKE_PROVIDER_ID=YOUR_SCRATCH_CONNECTION_ID \
  npx tsx e2e/live/container-runtime/run.ts \
  --base-url=http://127.0.0.1:47931 \
  --image=superagent-container:runtime-refresh \
  --output=/tmp/container-refresh/runtime-proof \
  2>&1 | tee /tmp/container-refresh/runtime-smoke.log
```

The output parent directory must exist before `tee` starts. The runner accepts
only loopback app URLs, creates one uniquely named test agent, and deletes that
agent on completion or failure. The preconfigured provider and app remain.
Use a clean output directory per run. Docker access, browser sandbox permissions,
and outbound access to the selected model and public PyPI are required.

The default exact version assertions are Node 22.23.4, Python 3.11.17, uv 0.13.5,
Bun 1.4.3, rclone 1.75.2, global TypeScript 5.5.4, and ts-node 10.9.2. Override them with
`--node`, `--python`, `--uv`, `--bun`, `--rclone`, `--typescript`, and `--ts-node`
when intentionally testing another candidate. `--timeout-ms` sets the per-phase
timeout (default ten minutes), not the total run duration.

The global compiler is ts-node's fallback for quick scripts without a project
configuration. TypeScript 5.9.3 can silently skip such scripts with ts-node 10.9.2,
so it stays on 5.5.4 independently of the app/agent build compiler. The smoke test
runs plain `ts-node file.ts` without flags or configuration, verifies stdout and
file side effects for scripts, CommonJS require and imports with an enum, and
checks that a type error fails before execution. Project-local compilers remain
available to projects that explicitly install them.
The pin covers normal typechecked execution; unconfigured `--transpile-only`
still needs compatible module/module-resolution settings to avoid TS5109.

## HTTP transport upgrades

Use `--transport=true` against the **production Docker app**, whose Node adapter
is part of the candidate. The Vite dev server has its own adapter dependency and
does not prove the production adapter upgrade. Also pass `--app-container`,
`--app-image-id=sha256:...`, and `--agent-image-id=sha256:...` with the exact image
IDs from the candidate builds. For example, add these flags to the command above:

```text
--transport=true --app-container=http-transport-refresh-app
--app-image-id=sha256:APP_IMAGE_ID --agent-image-id=sha256:AGENT_IMAGE_ID
```

The optional checks verify Hono 4.13.13 and `@hono/node-server` 2.1.5 installed in
both images, plus app `@hono/zod-validator` 0.9.1. A temporary static nonce file
binds the tested URL to the inspected app container and is removed immediately.
A deterministic Bun dashboard
fixture in the test agent exercises multipart upload/download with encoded
filenames, HEAD and byte ranges, malformed JSON validation, chunked proxy bodies,
methods/query strings, incremental SSE and cancellation through both proxy hops,
and a browser WebSocket with text/binary frames, subprotocol and close-code
preservation. The fixture also verifies that the host credential header never
reaches the dashboard. Its server and files are removed by the existing agent
cleanup, and the schema-validated proof records both image IDs and the results.
The memories route currently returns 500 for malformed JSON because its error
handler replaces the parser's 400 response; valid JSON that fails the schema
returns 400. Both behaviors were verified with the old dependencies and are
asserted explicitly here. Incremental SSE uses a release barrier after receiving
the complete first event, so it does not depend on network chunk boundaries or
a fixed delay between events.

## What it proves

- The app launches the selected real image. The runner records its immutable
  image ID and proves app stop/start replaces the container while preserving the
  workspace.
- A real agent receives a task from the browser composer, writes its own Python
  project and uv lockfile, installs a pinned dependency, and executes SQLite,
  TOML, timezone and package code. The runner executes that project independently
  offline, checks its venv's exact Python version and managed interpreter path,
  then repeats after replacement. The same live session resumes and
  reruns the existing environment without changing its source or lockfile.
- A second real session writes TypeScript for a Bun dashboard and widget, uses
  the actual dashboard and widget tools, and leaves a working artifact. The
  browser interacts with the dashboard through the app proxy. A platform widget
  refresh must execute its script and generate all eight Chromium PNG variants;
  each PNG's signature, pixel dimensions and content endpoint are checked.
- A deterministic fixture, copied into only the test's container, independently
  checks Python stdlib/SSL/ctypes/compression/SQLite/timezone data, original distro
  interpreter and compatibility aliases, nonroot `pip install --user`, stdlib
  venv (including `--copies`), uv venv/project/tool/uvx, a native NumPy wheel, Node HTTP/fetch, tsc,
  ts-node, Bun package install/TypeScript/HTTP, archive round trips, ffmpeg/ffprobe,
  PDF text extraction, local rclone copy/check and the Python session helpers.
  Persisted environments, packages and files are checked after replacement with
  no downloads or installation.

The fixture's `six==1.17.0`, `wheel==0.45.1`, and `numpy==2.2.6` are pinned test
inputs, not application dependencies. The NumPy probe exercises a binary wheel
and basic array/linear-algebra operations; it is not a comprehensive numerical
compatibility suite. Local rclone copy is not a FUSE/mount test: run the separate
`agent-container/src/volume-mounts.e2e.test.ts` integration suite for that. Legacy
venvs created with the *previous image* require a separate old-to-new-image
check; this harness checks persistence across replacement with the candidate.

## Existing copied Python environments

Existing symlinked venvs continue to resolve through the preserved interpreter
paths. Environments created in the old image with `python3 -m venv --copies`
retain a copy of Python 3.11.0rc1 and require an interpreter refresh. Inside the
updated agent container, replace the path below with the existing environment:

```bash
UV_PYTHON_DOWNLOADS=never uv venv --allow-existing \
  --python /usr/local/bin/python3.11 /workspace/path/to/.venv
```

This replaces the interpreter links while preserving installed site-packages.
It was verified offline with an old copied environment containing NumPy 2.2.6,
including its native array and linear-algebra code. A plain
`python3 -m venv --upgrade` does not repair this layout change. Newly created
`--copies` environments are supported by the updated image.

## Evidence

`proof.json` is schema-validated and records versions, image IDs, successful
checks, source/lock hashes, session IDs, SSE event counts, widget raster metadata,
and duration. The directory also contains deterministic logs, the agent's small
test programs, screenshots and eight widget PNGs. It deliberately excludes full
Docker inspection, environment dumps, provider settings and raw model/tool
transcripts. A failure preserves its fixture log and available browser capture
before cleanup. Keep the `tee` log with those artifacts.
