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
  Sync calls (`sync.statSync`, …) and `fs.createReadStream` are counted too
  (not delayed), so moving work onto an API the shim cannot slow down still
  shows up as a count change.
- **wall-clock** at `NFS_SIM_LATENCY_MS` (default 10) — catches serialised
  work that op counts cannot see (a `for … await` where a `Promise.all`
  belonged). Only enforced at the default latency; run with another value to
  explore. The default is deliberately high: wall ≈ latency × critical-path
  depth, so raising it grows the signal without growing the CPU noise of a
  shared runner.
- **bytes read** through `FileHandle#read`.

Every `[perf]` line in the run's log carries the numbers; they are also
appended to `perf-results.jsonl` (override with `PERF_RESULTS_FILE`), which
CI uploads as an artifact.

## Files

| File | Role |
|---|---|
| `nfs-shim.ts` | Wraps `fs.promises.*` and `FileHandle#read/stat/readFile` with latency + counters, and the sync entry points with counters. Installed once, disabled outside `measure()`. |
| `fixtures.ts` | Deterministic seeding (`PROFILES.small`, `PROFILES.big`), with hidden automations, metadata-only sessions, SDK subagent artifacts, artifacts, and a pre-written ownership index. |
| `harness.ts` | `bootPerfApp()` (seeds, boots the router, sends one unmeasured warm-up request), `measure()`, `expectWithinBudget()`. |
| `home-scenarios.ts` | The iOS home-page scenarios, parameterised by profile. |
| `*.perf.ts` | One file per profile: calls the scenario definition with that profile's budgets. Each file runs in its own fork, so profiles share no process state. |
| `../vitest.perf.config.ts` | Separate config: `perf/**/*.perf.ts`, single fork, no concurrency. |

## Changing budgets

Budgets live next to the scenario. Tighten them in the same PR as the
optimisation so the diff shows before/after. Loosen only with a reason in the
commit message.

To re-baseline after an intentional change:

```bash
PERF_RECORD=1 npm run test:perf   # reports overruns instead of failing
```

then copy the recorded counts into the budget exactly, and set wall-clock to
about 2× the recorded value. Op counts carry the precision; the wall budget
only has to catch a route that became serial (which multiplies wall, not
adds to it), so give it room for a busy runner.

## Adding a scenario

1. Seed what you need in `fixtures.ts` (keep it deterministic — PRNG, fixed
   timestamps via `utimes`, ownership index written up front).
2. `const { result, measurement } = await measure(() => perf.request(url))`.
3. Assert correctness on `result` first (this is the only place the whole
   chain runs on a real filesystem; the route unit tests mock the services).
4. `expectWithinBudget(label, measurement, budget)`.

## Agent avatar browser benchmark

`agent-avatar-fixture.tsx` is a separate renderer fixture, outside the API suite.
Run from the repository root with Playwright Chromium installed:

```bash
E2E_MOCK=true npx tsx scripts/benchmark-agent-avatars.ts --baseline 16884e2b6b77d3438feac08ac954155aaf686145 2>&1 | tee /tmp/avatar-perf.txt
```

The script bundles the fixture in memory, compares the selected revision's
avatar modules with the working tree, and writes validated samples to
`/tmp/agent-avatar-performance.json` (override with `--output`). It does not run
the app build. Each fixture alternates baseline/current order across three
trials, with a 2-second warm-up and a 1.5-second sample. Sidebar fixtures mount
40 or 200 rows in a 480px scroller with 10 avatars visible; the picker has all
28 avatars visible. Offscreen cases translate the entire sidebar outside the
viewport.

Results on 2026-10-12: production React, headless Chromium 145.0.7632.6, DPR 2,
Linux x64, AMD Ryzen Threadripper PRO 9965WX. Values are median main-thread
milliseconds per second, measured with Chromium's `TaskDuration` metric.

| Fixture | Stack tip | After cleanup |
|---|---:|---:|
| 40 idle, no pointer | 69.8 | 40.8 |
| 40 idle, stationary pointer | 53.5 | 18.4 |
| 40 idle, moving pointer | 114.6 | 77.5 |
| 200 idle, moving pointer | 226.2 | 65.1 |
| 200 idle, offscreen sidebar | 153.9 | 0.1 |
| 40 working, no pointer | 114.6 | 29.5 |
| 200 working, offscreen sidebar | 352.6 | 0.1 |
| 28-option picker, moving pointer | 76.8 | 64.4 |

Offscreen cases recorded zero component animation frames after cleanup.
Stationary-pointer bounds reads dropped from 3,600 to zero per sample; the
200-row moving-pointer case dropped from 18,000 to 900. Steady working dots
caused zero layouts, down from 65 per sample. These are component measurements,
not full-app latency or GPU/compositor measurements; wall-clock results vary
with the machine, browser and workload. The harness remains available for
repeat comparisons rather than enforcing these timing values as CI budgets.
