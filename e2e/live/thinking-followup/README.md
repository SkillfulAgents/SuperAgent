# Real background-wait thinking regression

Runs the real app, Docker container, Anthropic API, Bash process, SSE connection,
persisted transcript, and Chromium UI. No mock runtime or intercepted responses.
This makes billable LLM calls (a warm-up, a diagnostic, and a status follow-up).

Prerequisites: Docker, installed workspace dependencies and Playwright Chromium,
and a source install with an Anthropic key in `settings.json`. Pass its directory
explicitly with the required `--source=/path/to/install` argument.
Only the key is copied into a private temporary directory, with a fresh database.
The source install is read-only. The probe removes its own container and temporary
credential directory on completion or failure.

```sh
docker build -t superagent-container:thinking-followup agent-container
npx tsx e2e/live/thinking-followup/run.ts --source=/path/to/install --expect=fixed
```

Optional arguments: `--image=...`, `--model=claude-sonnet-4-6`, `--port=3476`,
`--output=test-results/live-thinking-fixed`.
The host uses the specified port and agent containers start at port 5900.

The diagnostic asks the real model to run two short Bash commands and a real
`sleep 600` with `run_in_background=true`, then finish its foreground turn.
The probe requires nonempty persisted reasoning, observes the background-wait
event, sends `status ?` through the composer, and waits for the real reply.
It compares the cards below the follow-up with the current turn's persisted
thinking. The expected difference is zero. The background job must still be
keeping the session active throughout this check.

To confirm the original failure, run this same probe on the unfixed renderer
with `--expect=bug`. That mode requires every old thinking card to reappear;
it succeeds only when the bug is reproduced. The real model may choose different
numbers of thinking blocks, so the assertions derive their counts from the
persisted transcript rather than assuming a fixed number.

The output directory contains before/after screenshots, video, host logs, and
`proof.json` with model, container image digest, session IDs, card counts, and
sanitized SSE metadata. Proof excludes credentials and reasoning text.
