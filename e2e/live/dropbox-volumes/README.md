# Live Dropbox volume validation

This suite uses an existing platform/Composio Dropbox connection. It creates
`/gamut-test`, a dedicated agent with that folder as its **only** mount, and a
unique child directory for each run. It never uses the selected source volume's
folder. Every remote path and mounted path is constrained to the test directory;
the suite rechecks the saved attachment and definition before running.

Run against a development API using the same data directory and platform URLs:

```bash
export SUPERAGENT_DATA_DIR=/path/to/dev/data
export PLATFORM_BASE_URL=https://platform.gamutagents.com
export PLATFORM_PROXY_URL=https://platformproxy.gamutagents.com
export PLATFORM_AUTH_ISSUER_URL=https://auth.gamutagents.com
export DROPBOX_TEST_API=http://127.0.0.1:3514/api
export DROPBOX_TEST_SOURCE_VOLUME_ID=<existing-dropbox-definition-id>
set -o pipefail
npx tsx e2e/live/dropbox-volumes/run.ts --init 2>&1 | tee /tmp/dropbox-init.log
npx tsx e2e/live/dropbox-volumes/run.ts 2>&1 | tee /tmp/dropbox-live.log
```

The API must allow the local test client to create/start agents. Start the app
with a current agent image and sign into the platform/connect Dropbox first.
No LLM session is created: a bundled Node worker performs filesystem operations
inside the actual agent container. Writes pass through FUSE, rclone, the app's
WebDAV routes, the volume adapter, platform proxy, Composio, and Dropbox.

The suite waits for rclone's upload queue to drain, then independently checks
Dropbox metadata and downloads the bytes for SHA-256 comparison. It covers empty
files, binary and UTF-8 data, 512 KiB chunk boundaries, 5/32/160 MiB files, partial
edits, overwrites, append/truncate/sparse extension, copies, file and directory
renames, editor saves, Git commits, concurrent uploads and namespace operations,
HTTP ranges and errors, external edits, directory pagination, cold scans, and
container shutdown/restart. Unsupported links and destructive type conflicts
must fail without changing existing files.

State and validated JSON reports go to `/tmp/gamut-dropbox-live` (override with
`DROPBOX_TEST_OUTPUT`). Reports contain per-case results/timings and remote
download checksums. The agent and test files are retained for inspection.
Each invocation gets its own report. Run `npx tsx e2e/live/dropbox-volumes/summarize.ts`
to collect the latest result of each case into `validation.json`, retaining links
to every earlier attempt, including failures.

Use `--new-run` to create a fresh child directory on the same test mount.
`--phase=sizes`, `core`, `large`, `lifecycle`, `edges`, or `scan` runs one group;
groups share the current run's fixtures. Run sizes before lifecycle, and core
before edges/scan. Core and large can run concurrently: each ignores the other's
long-running upload when waiting for its own writes. Lifecycle and scan wait for
the complete queue. Keep each phase's output with `tee` as above.

`--case=<substring>` selects a particular case. `--resume-uploads` on the large
phase waits for an already queued upload and verifies it without rewriting the
160 MiB fixture. A safe stop may return 409 while cloud uploads remain; the
lifecycle test checks the cached bytes survive that refusal, then drains and
retries. Avoid editing API modules during a run: the development module loader
can invalidate initialized provider state until the API is restarted.

Rate-limit, account-revocation, transport-failure and interrupted-commit cases
are covered by the automated adapter/client/route tests. The live suite does
not revoke the user's connection or deliberately rate-limit their account.
