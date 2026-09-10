# Agent widgets

A widget is a small, glanceable card an agent maintains for the user's home screens: Agent Home, App Home, and the companion iOS app. It answers one question (what's next, today's macros, three KPIs) and refreshes itself from a script — no conversation, no LLM tokens. This document is the platform-side reference; the agent-facing guidance lives in `agent-container/skills/widgets/SKILL.md`.

## Model

- **An artifact is one unit that may expose a dashboard, a widget, or both, and each half is a named script.** Everything lives under `<workspace>/artifacts/<slug>/`. `scripts.start` makes it a dashboard (a long-running Bun server, the destination) and is run as `bun run start`; a `gamut.widget` block makes it a widget (a static snapshot, the glance) and `scripts.widget`, run as `bun run widget`, regenerates it. The block is the marker and the config, the script is the command — a widget with no `scripts.widget` is static, which is a supported shape. A dashboard with a widget shows the widget in place of its screenshot on Home, and tapping the widget opens the dashboard. A widget-only artifact has no server. One widget per artifact.
- **Widget = script-backed, not an agent turn.** The agent authors `widget.html` (the look) and `widget.ts` (the data). A refresh runs the script inside the agent container and re-renders; the agent only runs to *change* a widget. Never the running dashboard server: a refresh must not require anything to be up.
- **The script decides validity.** It writes `widget.json` → `{ "validUntil": ISO | null }` alongside `widget.html`. A stock widget is valid five minutes during trading hours but until the next open after close; a calendar widget until the next event. There is deliberately no TTL in the manifest. No `widget.json` → the platform assumes one hour and `refresh_widget` warns the agent.
- **Snapshots are cached on disk and served from the host.** `widget.html` and `snapshots/` sit in the bind-mounted workspace, so every surface shows the last snapshot instantly — container asleep, app relaunched, whatever.
- **Stale-while-revalidate, no scheduler.** Nothing refreshes on a timer. A stale widget refreshes when (1) the owning agent's home page loads, (2) any session of that agent settles, or (3) the user taps refresh. App Home never triggers a refresh — that would wake every container at launch.
- **`refreshOnTurnEnd` opts a widget into every turn.** Data the agent edits in conversation (a task list, a food log) has no honest `validUntil` — it changes when the agent says so. Such a widget declares `gamut.widget.refreshOnTurnEnd: true` and the after-run sweep re-renders it whether or not it is stale, at most once a minute.
- **A failed script opens a repair session.** A widget refreshes without an agent turn, so a broken script would fail silently behind an error badge. Instead the platform opens an automated session ("your script failed, here is the error, fix it"), guarded so a permanently broken widget costs one session per window, not one per refresh.

## Layout on disk

```
<workspace>/artifacts/<slug>/
  package.json        # manifest (schema below): scripts.widget, gamut.widget, + scripts.start if also a dashboard
  widget.ts           # what scripts.widget conventionally runs (any command works)
  widget.html         # the snapshot: static, responsive, data baked in
  widget.json         # written by the script: { validUntil }
  widget.log          # script output, capped like dashboard.log
  snapshots/
    snapshot.json     # { generatedAt, validUntil, validityDefaulted, htmlHash, renderedSizes, scriptRan, durationMs, lastError }
    small-light@2x.png … medium-dark@3x.png   # rasterized by the container for native surfaces
```

Manifest:

```json
{
  "name": "Nutrition",
  "description": "Meals, macros and targets",
  "scripts": {
    "start": "bun run serve.js",     // present → also a dashboard
    "widget": "bun run widget.ts"    // absent → the widget is static
  },
  "gamut": {
    "widget": { "size": "small", "timeoutSeconds": 30 } // present → exposes a widget
  }
}
```

`size` is `small` (1×1) or `medium` (2×1); `timeoutSeconds` is the script budget, clamped to 120 where the script is run; `refreshOnTurnEnd` opts into the every-turn sweep. The snapshot cannot be `index.html`: that is the React dashboard template's Vite entry.

Every field of the widget config falls back to its default rather than failing the parse (`.catch()` on both sides). The block is the marker that says the artifact has a widget at all, so a strict parse would turn one bad value into a widget that silently disappears — and, for a widget-only artifact, into a dashboard the container then tries to `start`.

The command lives in `scripts.widget` rather than a `gamut.widget.script` filename for the same reason the dashboard's does: it is a command, not a file, so `python3 -m tools.build` or a chain with flags needs no wrapper, and the container runs both halves through one mechanism. The trade-off is that a `widget.ts` nobody declared is inert — there is no filename convention doing it for you.

Schemas: `agent-container/src/widget-schema.ts` (container) and `src/shared/lib/widgets/widget-schema.ts` (host) — mirrored by hand because the container package cannot import `@shared`. Both derive the artifact's shape the same way (`artifact-kind.ts` / `artifactShapeOf`): dashboard = has `start` or is a legacy manifest with no widget block; widget = has `gamut.widget`.

## Staleness

`isWidgetStale()` in the shared schema: stale when there is no snapshot, when `widget.html`'s hash differs from `snapshot.htmlHash` (an agent run rewrote it), or when `validUntil` has passed. A scriptless widget has `validUntil: null` and only goes stale by hash. A failed refresh writes `lastError` and a five-minute `validUntil` so a broken script is retried on the next trigger, not on every page load. A `validUntil` already in the past is treated like a missing one.

## Container side

`agent-container/src/widget-manager.ts`
- `listWidgets()` scans `/workspace/artifacts` for artifacts with a `gamut.widget` block.
- `refreshWidget(slug)`: runs `bun install` once if the artifact declares dependencies and has no `node_modules`; deletes any stale `widget.json`; runs the script (`bun run widget`, cwd = artifact dir, env `WIDGET_SLUG` / `WIDGET_DIR` / `WIDGET_OUTPUT` / `WIDGET_META`, timeout from the manifest); hashes `widget.html`; rasterizes (`widget-rasterizer.ts`: one Chromium, small/medium × light/dark × 2x/3x); reads `widget.json` for validity; writes `snapshot.json` atomically; posts `widget-snapshot-ready` to the host. Serialized across widgets, deduplicated per widget. A failed script keeps the previous `widget.html`.
- `createWidget(slug, …)` adds a widget block and template files to an existing artifact, or scaffolds a widget-only one from `~/.claude/skills/widgets/templates/basic`. Template files are copied with `COPYFILE_EXCL` and an existing `widget.html` / `widget.ts` is kept and reported: the "already has a widget" guard reads the manifest, so anything that makes a manifest read as "no widget" would otherwise arrive here and overwrite hand-written files.
- `rasterizeWidget` is bounded by a timeout that closes the browser rather than only resolving early — otherwise a hung page leaves a Chromium rendering into `snapshots/` after `snapshot.json` has been written.
- The PNG has to show what the app shows, so the renders run under the app's restrictions: scripting off, `offline`, and the document handed over with `page.setContent` carrying the platform CSP (mirrored in `agent-container/src/widget-schema.ts`) instead of navigating to `file://`. A file navigation gives the document a directory to resolve against, and a sibling `chart.css` or PNG then appears in the preview while the app — same document, `default-src 'none'` — refuses it. No network policy catches that, because it never crosses the network. `data-theme` travels in the document for the same reason: setting it by evaluating in the page needs the scripting that is deliberately gone.

The dashboard manager skips widget-only artifacts and refuses to `start` one.

HTTP: `GET /widgets`, `POST /artifacts/:slug/widget/refresh`, `GET /artifacts/:slug/widget/logs` — registered before the dashboard proxy.
MCP (`widgets` server): `create_widget` (takes `refreshOnTurnEnd`), `refresh_widget`, `list_widgets`.

`refresh_widget` is the agent's QA loop, so it returns the rasterizer's real output: the declared size in light **and** dark at 2x by default (`previews: "all"` for both families, `"none"` to skip), plus the absolute path of every PNG written so the agent can read any of them — including the 3x renders the phone uses. It still warns on a `<script>` tag in `widget.html` and on a validity the script did not compute.

## Host side

`src/shared/lib/services/widget-service.ts` — filesystem reads, path containment, HTML scheme stamping, the iframe CSP, and `isWidgetOnlyArtifact()` for the dashboard lister.

Containment (`resolveWidgetPath`, the funnel every route goes through) is symlink-aware and anchored at the **workspace**, not at `artifacts/`. The agent writes into that bind mount, so both the leaf and the `artifacts` directory itself can be links: checking a link against its own target agrees with itself, and another agent's workspace reads as contained. The workspace is the one part the container cannot swap from inside.

`renderWidgetDocument()` prefixes the authored HTML with a standards-mode document, the platform's `<html data-theme>`, and an open `<head>` containing the platform CSP. The browser parses the policy before any authored content, so a `<head>` mentioned inside a comment, attribute, or template cannot swallow it. Keeping the head open preserves authored metadata and styles; later root attributes merge without replacing the requested theme. The card inlines this with `srcdoc` (see Renderer), so the response header no longer covers the frame. The platform policy is present **whether or not the author wrote one**, and additional authored policies can only restrict further. The container uses the same prefix for PNG rendering.
`src/shared/lib/services/artifact-service.ts` — `listArtifactsAndWidgets()`, the one scan the agents list uses. Dashboards and widgets are two halves of the same artifact, decided by one package.json, so that file is read once and both lists come out of it; listing them separately doubled the readdir and the manifest read of every artifact of every agent on every poll, warm ones included (the perf suite pins those op counts).
`src/shared/lib/services/widget-refresh-service.ts` — the triggers. Single-flight per widget; `refreshStale()` is throttled per agent (30 s) and wakes the container; the after-run sweep listens for `session_idle` on the persister's global stream, debounces 3 s, never wakes a sleeping container, takes every stale widget plus every `refreshOnTurnEnd` widget, and skips an opted-in one refreshed in the last 60 s.

`src/shared/lib/services/widget-repair-service.ts` — the failed-script session. It fires only when the container answered and the script failed (`snapshot.lastError`), never on a transport failure, a sleeping container or a refresh timeout — those are the platform's problem. The session is created exactly like a cron run (`metadata: { isAutomated: true }`, attributed to the agent owner via `getAgentOwnerUserId`, `automationStatus: 'running'` finalized by the persister) and carries `isWidgetRepair` + `widgetRepairSlug`, which put it in `isHiddenAutomatedSession` and serve as the dedupe key. Three guards, in order: skip while any session of the agent is active (the agent may be editing that widget, and its own `refresh_widget` already showed it the error) — or while another widget of the same agent is mid-way through opening one, held in memory because two widgets failing in the same sweep would both pass the busy check before either had a session to be busy with; skip while an earlier repair for the same widget is still `running`; skip inside a 6-hour per-widget cooldown. Both durable guards read session metadata from disk, so a restart cannot reset the count. An agent-initiated `refresh_widget` never opens one — it runs inside the container and returns the error to the agent directly.

Repair transcripts are available from **Agent Home → Called from Other Agents → Run History**, labeled **Invoked to fix widget** with the artifact slug underneath. Existing repairs appear there too, and repairs count toward the home entry even if no other agent has called this agent. New repair sessions use the same title; their transcript banner and breadcrumb link back to this history. They stay hidden from the normal session list unless promoted for user input. Repair provenance is separate from `invokedByAgentSlug`, so the caller permission controls still describe actual agents.

Routes (`src/api/routes/agents.ts`, all under the artifact and registered before the dashboard proxy):

| Route | Role | Notes |
|---|---|---|
| `GET /api/agents/:id/widgets` | read | filesystem only, never touches the container |
| `POST /api/agents/:id/widgets/refresh-stale` | user | the Agent Home mount trigger; returns slugs in flight. `user` because it can start a container, like `POST /:id/start` — every read-only widget route stays on the filesystem |
| `POST /api/agents/:id/artifacts/:slug/widget/refresh` | user | explicit refresh, waits for the outcome |
| `GET /api/agents/:id/artifacts/:slug/widget/html?scheme=` | read | snapshot document, CSP `default-src 'none'; style-src 'unsafe-inline'; img-src data:` |
| `GET /api/agents/:id/artifacts/:slug/widget/snapshot?family=&scale=&scheme=` | read | PNG for native surfaces (iOS); `x-widget-valid-until` header |

Deleting the artifact (`DELETE /artifacts/:slug`) deletes its widget. `ApiAgent.widgets` is attached by `enrichAgentsWithSummary` (one entry per artifact with a widget, `hasDashboard` says whether the same slug is also in `dashboards`), so App Home tiles need no extra query.

SSE (global): `widget_refresh_started`, `widget_snapshot_ready` (also relayed from the container via `agent-bootstrap` so agent-initiated refreshes reach open pages), `widget_refresh_failed`.

## Renderer

- `WidgetCard` (`src/renderer/components/widgets/widget-card.tsx`) — the snapshot in an `<iframe sandbox="">` (no scripts, no same-origin), **inlined with `srcdoc`** rather than framed by URL, keyed on `htmlHash`, spinner while refreshing, error badge on `lastError`, hover refresh button, "Open app" and a link to the dashboard when `hasDashboard`. The document is fetched with `useWidgetHtml`. Framing the API URL works only where the renderer and the API share an origin — the web build. A packaged desktop renderer is `file://` and `dev:electron` is a different port, and `frame-ancestors 'self'` (doing its job) blocks both; inlining removes the origin question, and the header still keeps third parties out of the URL.
- `HomeWidgets` (Agent Home right column) — **the** refresh trigger: on the first listing it calls `refresh-stale` once if anything is stale. Dashboards that have a widget are not listed a second time as screenshot cards.
- App Home — one tile per artifact, keyed `dash::<agent>::<slug>` for both kinds; an artifact with a widget renders the widget (default footprint from `size`) instead of the screenshot.

## iOS contract

WidgetKit cannot render HTML, so the phone is a PNG display: the timeline provider fetches `/artifacts/:slug/widget/snapshot?family=&scale=&scheme=`, caches in the App Group, and sets `.after(validUntil)` (header `x-widget-valid-until`). The existing silent APNs push can invalidate on `widget_snapshot_ready`. `widgetURL` is the `gamut://` deep link to the dashboard (when `hasDashboard`) or the agent.

## Mock runtime

`MockContainerClient` answers `POST /artifacts/:slug/widget/refresh` by hashing the seeded `widget.html`, taking `validUntil` from a seeded `widget.json` (else the one-hour fallback), and writing `snapshot.json` (no script, no Chromium); a `widget.mock-fail` file in the artifact dir simulates a failed script. See `e2e/specs/agent-widgets.spec.ts`.
