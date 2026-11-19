# Halftone Canvas2D validation

The homepage Halftone renderer batches visible dots into 32 alpha bands. Each
non-empty band is emitted as one Canvas2D path and one `fill()`. Alpha uses the
band midpoint, so the maximum mathematical quantization error is `1 / 64`.

## Two surfaces, and when it animates

A halftone draws on one of two surfaces:

- **Canvas2D** (`halftone-renderer.ts`): every dot is computed in script and
  drawn as an arc. This is the path for cards, which follow the pointer (the
  pointer's influence eases per dot over time, so it needs per-dot state).
- **GPU** (`halftone-gpu.ts`): a vertex shader computes each dot and draws it as
  a point sprite, so a frame is a few uniforms and one draw call. This is the
  path for a halftone with `followPointer={false}`: Agent Home's and its
  sessions' full-view backdrop. It falls back to Canvas2D where hardware WebGL
  is missing or its context is lost.

The split is by size. Canvas2D costs the renderer's main thread (the field
maths) and the GPU process (rasterizing the arc paths) in proportion to the dot
count: about 4,000 dots on a card, about 62,000 on a 1734 × 1016 backdrop. The
benchmarks below time one card's draw on the main thread only, so they never
showed what the backdrop cost in both processes.

The two files hold the same field. A change to the shading or a motif in one is
made in the other; the GPU path was checked against the Canvas2D reference by
rendering both at the same instant (flow and pulse, with and without vignette,
and at a clock value of 5 × 10⁷) and comparing the ink in each dot's cell: the
mean difference was under 0.3% of full coverage and the largest 2.4%.

A halftone animates only while it is on screen, its document is not hidden, and
its window is the one in use, on the app's shared ambient frame loop
(`src/renderer/lib/ambient-frames.ts`, [docs/animations.md](animations.md)). A window left
open behind another app is not hidden, so without the last condition it kept
animating all day; there it is decoration, and holds its frame.

Measured in Electron 45 on an Apple silicon laptop at DPR 2, as a share of one
core, renderer process + GPU process:

| Fixture | Canvas2D | GPU |
| --- | --- | --- |
| Full-view backdrop, 1734 × 1016, idle | 22% + 20% | 4% + 5% |
| Sixteen 420 × 118 cards, idle | 16% + 15% | not used |

In a window that is not in use, whole screens with these on them read about
1% + 1.5% ([docs/animations.md](animations.md#measuring)).

A board of cards stays on Canvas2D because its cost is mostly not the dots:
sixteen canvases each presenting 30 frames a second cost the GPU process about
as much whichever way they are drawn (one WebGL context per card measured 22%,
one shared context handing frames to each card 31%), and a page may hold only
about sixteen live WebGL contexts.

## Performance benchmark

Run both required browser modes:

```sh
npm run benchmark:halftone
```

The command compares the former per-dot `beginPath()` / `fill()` path with 8,
16, 32, and 64 alpha bands. Every variant receives the same precomputed set of
4,326 dots, so field calculation is excluded. It measures one 576 × 276 card
and a board of eight such cards at DPR 2.

Defaults are 60 warmup frames followed by 180 samples. Override them when
iterating locally:

```sh
npm run benchmark:halftone -- --mode headless-software --warmups 20 --samples 60
```

`--mode` accepts `headed-gpu`, `headless-software`, or `all`. The default is
`all`. Chromium version, launch mode/flags, GPU feature status, machine
architecture, CPU, viewport, card dimensions, dot count, sample counts, median,
and p95 are written to a timestamped JSON file under
`test-results/halftone-benchmark/`. Use `--output <path>` to choose another
location.

The command exits unsuccessfully when an applicable decision gate fails:

- headed 32-band median improvement is less than 35%;
- headed p95 does not improve;
- headed eight-card p95 is 16.7 ms or higher;
- headless/software median or p95 regresses by more than 10%.

### Full-renderer benchmark

The batching benchmark deliberately isolates Canvas submission. To measure the
complete production path—including motif sampling, hover influence, vignette,
alpha bucketing, and Canvas drawing—run:

```sh
npm run benchmark:halftone:runtime
```

The runtime benchmark bundles the production `HalftoneFrameRenderer` into
Chromium and exercises one-card and eight-card flow fixtures, an eight-card
board with one hovered card, and one-card/eight-card pending-input pulse
fixtures. A same-size `resize()` fixture covers layout churn separately from
steady-state drawing, and a batched pointer-dispatch microcase compares one
global listener with the eight-listener card-board case. The command accepts
the same `--mode`, `--warmups`, `--samples`, and `--output` options as the
batching benchmark, plus `--label` for naming optimization iterations.

The initial runtime optimization pass used the same Chromium 145 / M2 Max
environment as the batching reference, with 60 warmups and 180 samples:

| Mode / fixture | Baseline median / p95 | Optimized median / p95 |
| --- | --- | --- |
| Headed, one flow card | 1.00 / 1.10 ms | 0.90 / 1.00 ms |
| Headed, eight flow cards | 8.70 / 9.00 ms | 8.10 / 8.40 ms |
| Headed, eight flow cards, one hovered | 8.60 / 8.90 ms | 8.10 / 8.40 ms |
| Headed, one pending-input pulse card | 1.20 / 1.50 ms | 1.10 / 1.30 ms |
| Headed, eight pending-input pulse cards | 10.30 / 10.90 ms | 8.80 / 9.40 ms |
| Software, eight flow cards | 8.50 / 8.90 ms | 8.10 / 8.40 ms |
| Software, eight pending-input pulse cards | 10.40 / 11.10 ms | 8.90 / 9.60 ms |

The retained changes precompute resize-stable grid/vignette values, calculate
pulse ring constants once per frame, and avoid same-size canvas/renderer
reinitialization. Same-size renderer resize dropped from 0.10 ms median /
0.20 ms p95 to below Chromium's timer resolution.

Two renderer experiments were reverted because they did not improve both
headed and software results: skipping inactive hover bookkeeping and caching
three pulse-distance arrays. A shared pointer listener was also rejected:
dispatching to eight listeners cost 1.40 µs/event versus 0.215 µs/event for
one—only about 0.15 ms total per second at 120 pointer events/second.

The headed run requests GPU rasterization and records Chromium's reported GPU
feature state. Confirm that `rasterization` is enabled in the JSON before
using a run as release evidence.

### Reference result

The initial passing reference run used Chromium 145.0.7632.6 on an Apple M2 Max
(`arm64`, macOS 15.6), a 1440 × 1100 viewport, and DPR 2. Chromium reported
headed rasterization as `enabled_force`; the explicit software run reported
`disabled_software`. Each result used 60 warmups and 180 samples.

| Mode / fixture | Per-dot median / p95 | 32-band median / p95 |
| --- | --- | --- |
| Headed, one card | 0.90 / 1.00 ms | 0.50 / 0.60 ms |
| Headed, eight cards | 7.10 / 7.40 ms | 4.10 / 4.40 ms |
| Software, one card | 0.80 / 0.90 ms | 0.50 / 0.60 ms |
| Software, eight cards | 6.50 / 6.80 ms | 4.10 / 4.30 ms |

The headed 32-band path reduced median per-card draw cost by 44.4% and p95 by
40.0%. Its eight-card p95 was 4.4 ms. The software path improved by 37.5% at
median and 33.3% at p95, so all automated shipping gates passed.

## Deterministic visual comparison

Run:

```sh
npm run test:halftone:visual
```

The Playwright suite renders the exact per-dot reference and the 32-band
candidate in Chromium with controlled motif, state, dimensions, timestamp,
seed, pointer position, and DPR. Its matrix includes:

- `flow_3d` in working and idle states;
- `pulse` in alert state;
- small and wide cards;
- two fixed timestamps;
- no pointer, centered pointer, and edge pointer;
- DPR 1 and DPR 2;
- zero-size recovery plus one-row and one-column grids.

Both transparent frames are composited over white, converted from sRGB to
luminance, and compared using average local 8 × 8-window SSIM. The required
threshold is 0.995. A JSON summary is attached to the Playwright result.
Reference, candidate, and amplified difference PNGs are attached for every
failing fixture.

The initial Chromium reference run covered 75 fixtures and observed a minimum
SSIM of 0.998532, above the required 0.995 threshold.
