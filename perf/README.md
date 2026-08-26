# API perf suite (simulated NFS)

`npm run test:perf` — boots the real API router in-process against a seeded
temp data dir and measures specific routes with an artificial per-call
filesystem latency, so that code which is fine on a laptop but slow on
NFS-class volumes (EFS, S3 Files) goes red here.

Runs in CI on its own runner (`.github/workflows/perf.yml`), one worker,
serial tests.

## What is measured

Each scenario records, for one request:

- **fs op counts** per operation (`stat`, `readdir`, `readFile`, `open`,
  `handle.read`, …) — deterministic for a given fixture, pinned exactly.
  This is the primary signal: "this route stats every transcript" is a count.
- **wall-clock** at `NFS_SIM_LATENCY_MS` (default 2) — catches serialised work
  that op counts cannot see (a `for … await` where a `Promise.all` belonged).
  Only enforced at the default latency; run with another value to explore.
- **bytes read** through `FileHandle#read`.

Every `[perf]` line in the run's log carries the numbers; they are also
appended to `perf-results.jsonl` (uploaded as a CI artifact).

## Files

| File | Role |
|---|---|
| `nfs-shim.ts` | Wraps `fs.promises.*` and `FileHandle#read/stat/readFile` with latency + counters. Installed once, disabled outside `measure()`. |
| `fixtures.ts` | Deterministic seeding (`PROFILES.small`, `PROFILES.big`), with hidden automations, metadata-only sessions, SDK subagent artifacts, artifacts, and a pre-written ownership index. |
| `harness.ts` | `bootPerfApp()`, `measure()`, `expectWithinBudget()`. |
| `*.perf.ts` | Scenarios with inline budgets. |
| `../vitest.perf.config.ts` | Separate config: `perf/**/*.perf.ts`, single fork, no concurrency. |

## Changing budgets

Budgets live next to the scenario. Tighten them in the same PR as the
optimisation so the diff shows before/after. Loosen only with a reason in the
commit message.

To re-baseline after an intentional change:

```bash
PERF_RECORD=1 npm run test:perf   # reports overruns instead of failing
```

then copy the recorded counts into the budget and give wall-clock ~1.5×
headroom.

## Adding a scenario

1. Seed what you need in `fixtures.ts` (keep it deterministic — PRNG, fixed
   timestamps via `utimes`, ownership index written up front).
2. `const { result, measurement } = await measure(() => perf.request(url))`.
3. Assert correctness on `result` first (this is the only place the whole
   chain runs on a real filesystem; the route unit tests mock the services).
4. `expectWithinBudget(label, measurement, budget)`.
