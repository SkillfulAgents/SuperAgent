# Animations

An animation that runs by itself costs CPU for as long as its screen is open,
whether or not anyone is looking. An idle Gamut window once held a renderer at
20% and the GPU process at 25% of a core, all day, for a dot backdrop and a few
avatars. These are the rules that came out of fixing it.

"Ambient" below means motion that keeps going without input: an avatar's glance,
a backdrop's drift, a spinner, a shimmer, a level meter. A transition or an
entrance that plays once and ends is not ambient, and only the third rule
applies to it.

## The rules

1. **Say what the animation is for, and let that decide what it does in the
   background.** "Background" means a window that is shown but not the one in
   use: open behind another app, or on a second display, which is where a
   desktop app spends most of its life. `document.hidden` stays false there, so
   an animation that only stops for a hidden document runs all day.

   | Kind | It is | Examples | In the background |
   | --- | --- | --- | --- |
   | `decoration` | Motion that carries no information | the halftone, the empty-home clouds, the wizard's ribbon, the team-brain drift, every CSS spinner and shimmer | held still: painted when it mounts and when a resize clears it, and nothing else |
   | `status` | A state someone may glance over to read | an agent's avatar, the activity orb | the slow clock, one paint a second, and a moment at full rate whenever the state changes |
   | `live` | Something the person is doing now, that goes on without the window's focus | the voice orb and bars, the recording waveform, the audio playhead, the read-aloud highlight, the microphone meter | its full rate, for as long as that activity runs |

   Nothing runs while the document is hidden. **Pause decoration, never
   information.**
2. **Paint at a stated rate.** 60 times a second at most, and 30 where the
   motion is slow (a drift, a glance, a meter). `requestAnimationFrame` follows
   the display, which on a current MacBook is 120 Hz, and every painted frame
   makes the whole window composite again.
3. **Make it cheap to draw, and measure it before shipping.** Run
   `scripts/measure-animation-cpu.cjs` on every screen the animation appears
   on. In the background a screen reads a percent or two at most. In use it
   reads what the motion is worth, and a small decoration is not worth a tenth
   of a core.

### Why only decoration stops

The first version of rule 1 stopped everything in the background, and each
animation that also carried information broke in its own way: an avatar frozen
on typing dots while its agent waited for an answer, a canvas that mounted
blank, a voice orb showing "listening" while the agent spoke, a playhead still
while the audio played.

So the stop is for decoration alone, where a held frame is exactly right, and
even there every subscriber is painted once when it joins, so nothing mounts
blank. Status keeps a slow clock on top of its wake: whatever it shows is
repainted within a second, whoever wrote it and whatever they forgot to wake.
That clock is what a background window still costs, about a percent of a core
per process (the table below), against 20% and more for one that never slows.

## How to keep them

### A loop driven from script

Subscribe to the app's ambient frame loop instead of calling
`requestAnimationFrame`, and say which kind it is:

```ts
import { subscribeToAmbientFrames } from '@renderer/lib/ambient-frames'

useEffect(() => subscribeToAmbientFrames((now) => draw(now), { kind: 'decoration', fps: 30 }), [])
```

It keeps rules 1 and 2 for you:

- One loop serves every subscriber, on the same display frames, so a screen
  with five animations composites as often as a screen with one. The rate is
  held on a display of any speed (four frames in five at 75 Hz).
- A subscriber is painted once as soon as it joins, whatever the clock, so
  nothing mounts blank.
- `fps` may be a function, for an animation whose pace changes with its state:
  an avatar asks for 30 while it glances and 60 while it follows the pointer.
- `measure` runs for every subscriber before any `tick`: read layout there and
  write styles in `tick`.
- A subscriber that throws is dropped and reported. The others keep their
  frames.

What a subscriber owes in return:

- **A tick that integrates time clamps its own step.** After a hold the next
  call comes however much later. The halftone takes at most a few frames' worth
  of drift per paint, so it picks up where it stopped and does not lurch.
- **A `decoration` whose picture a resize clears repaints it there and then**
  (in its `ResizeObserver`), and does not leave it to the next frame: held,
  there is none.
- **A `status` animation calls `wakeAmbientFrames(tick, ms)` when its state
  changes**, so the change starts at once and not a second late. One whose
  change takes time to play (an avatar: its blend, its dots coming out or
  gathering back) also asks from its own tick for as long as it is mid-change.
  That covers every way of arriving there: mounted that way, scrolled into
  view, changed while the document was hidden. An animation that steps by the
  time each frame adds would otherwise crawl through the change on the slow
  clock, a clamped step a second.
- **An entrance is not part of the decoration.** A fade-in driven by the same
  ticks stops with them, part-way or before it has begun. Held, show the thing
  in full (the empty Home's clouds do).
- **A `live` animation subscribes only while its activity runs** (while audio
  plays, while the recorder is open). That is what earns it the full rate.

Add your own conditions (on screen, reduced motion) by subscribing and
unsubscribing; `IntersectionObserver` is still yours to set up.

Decoration driven by a timer or by rendering (a carousel that turns every few
seconds) reads `useAmbientAnimationAllowed()`.

Every animated component has a row in `ambient-contract.test.tsx`, which mounts
it in a window that is not in use and holds it to its kind's contract:
decoration painted when it mounts and after a resize and otherwise costing
nothing, status and live painted again within their clock's beat and showing
their current state. A new one gets a row. One that needs a whole feature
mocked to mount keeps the same check beside its other tests instead (the audio
preview's playhead, the microphone test's meter, the read-aloud highlight).

### A CSS, SVG or video loop

Nothing to do: these are decoration. `installAmbientAnimationPause()`
(`ambient-styles.ts`, called by each renderer entry point) holds every looping
CSS animation, looping Web Animation, SVG `<animate>` loop and muted looping
video in the background, and resumes them where they stopped. It holds only
what loops or runs ten seconds or more, so an entrance that starts while the
window is in the background still finishes.

It holds a CSS animation by setting its playback rate to zero, never with
`pause()` and `play()`: those take an animation away from its
`animation-play-state` for good, and a ticker that pauses under the pointer
(`.home-title-ticker`, `.activity-summary-ticker`) would not pause again after
the window had been in the background once. At rate zero an animation asks for
no frames: sixty held loops measured 0% + 0%.

It looks at the whole page once, when the window goes into the background,
and after that only at the element each new CSS animation starts on. An SVG
loop or video that first appears while the window is in the background runs
until the next time, so a component that must agree with its own SVG clock
holds it itself (`team-brain-diagram.tsx`).

So a CSS loop must not be the only thing that says something: a spinner held
still next to "Loading…" is fine, a pulsing dot that is the whole of "needs
your attention" is not. Give that a state that reads without motion.

CSS cannot be capped to a frame rate, so rule 2 becomes: a CSS loop is for
something short-lived (a spinner while a request is out, a shimmer while a list
loads). Six spinners, two pulsing bars, a shimmer and an SVG loop measured
12% + 18% of a core between them at 120 Hz. Motion that stays on screen for minutes goes
through the frame loop.

### Drawing

What made the difference, measured:

- **Don't compute per element in script what the GPU can.** The halftone
  backdrop computed 62,000 dots in JavaScript and drew each as a Canvas2D arc:
  22% renderer + 20% GPU. The same field in a vertex shader, one draw call:
  4% + 5% (`docs/halftone-rendering.md`).
- **Give a small animated element its own layer** (`will-change: transform` on
  its root) while it animates, so its motion repaints its own pixels and not
  the sidebar it sits in, and take it away when it stops: a layer for something
  held still costs and saves nothing. For the avatar orbs this took the GPU
  process from 21% to 14%. Promoting
  each of an element's inner layers measured *worse* than promoting none: more
  layers to composite than paint saved.
- **A live `filter: blur()` over something that moves is re-run every frame;
  `clip-path` is free.** Twelve shaped avatars, knocking at 60 a second:
  6% + 22%; with their blurs off, 9% + 14%, the same as twelve circles, which
  have none; with their clip-paths off, no change. Idle at 30 a second:
  7% + 14% against 8% + 9%. So a blur is about a third of a shaped avatar's
  GPU cost, and the rest is what any twelve small things repainting cost: the
  loop alone, with nothing moving, is 4% + 2%.
- **Many small canvases cost more than one large one.** Each presents its own
  frames: sixteen cards cost the GPU process about the same however they are
  drawn.
- **Skip the frame when nothing changed.** Compare with the last painted state
  and return before touching styles or the canvas.

## Measuring

```sh
# A screen of the mock app
E2E_MOCK=true PORT=47897 npm run dev:web
npx electron scripts/measure-animation-cpu.cjs http://localhost:47897/ http://localhost:47897/agents/<slug>
```

It loads each URL in a real window on this machine's GPU and display (headless
Chromium rasterizes in software and measures something else), and prints the
renderer's and the GPU process's share of a core, the animation frames the page
ran, and the looping CSS animations still running, first with the window in the
background and then in use. Any URL works, including a `file://` page that
mounts one component.

With six agents seeded, at 1734 × 1016 on a 120 Hz Apple silicon laptop,
renderer + GPU process:

| Screen | In use | Background |
| --- | --- | --- |
| App Home (six cards) | 14% + 23% | 0.6% + 1.3% |
| Agent Home | 13% + 23% | 1.4% + 1.2% |
| A session | 8% + 9% | 0.7% + 1.1% |
| Notifications (sidebar only) | 9% + 9% | 0.5% + 0.9% |
| Settings | 0% + 0% | 0% + 0% |

Before any of this the backdrop alone was 22% + 20% and twelve avatars
11% + 29–37%, in the background as much as in use. What is left in the
background is the six avatars' slow clock. What is left in use is mostly the
avatars and the home cards' canvases. The in-use figures are taken with no pointer in the window; an avatar
following the pointer paints at 60 for as long as its gaze is travelling.

The tool counts its window as shown wherever it lands on the desktop. A window
another one covers completely is hidden to its page, which already costs
nothing and is not the case being measured.

## What is outside the loop, and why

- **The document title's activity indicator** (`use-document-title.ts`) animates
  for a tab in the background on purpose. It writes a string, and paints nothing.
- **Clocks that redraw text once a second** (elapsed timers, relative times)
  are information, not motion, and cost nothing measurable.
- **The agent's browser stream** (`use-browser-stream.ts`) paints frames as
  they arrive from the container: content someone may be watching from another
  window, at the pace it is sent.
- **Motion that parks itself**: the team-brain dot field, springs, scroll
  glides. They run while something is settling and stop.
- **Other documents**: a dashboard's or widget's frame, the dashboard window's
  chrome, the target-switch overlay. The loop and the CSS hold reach the app's
  own document only. An agent-written dashboard that animates forever keeps
  doing so in the background.
- **A Web Animation, SVG loop or video that first appears while the window is
  in the background** runs until the window next goes into the background: the
  hold looks when that happens and when a CSS animation starts, and does no
  other work while held.
