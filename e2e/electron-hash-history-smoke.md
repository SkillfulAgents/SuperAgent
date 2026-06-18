# Electron hash-history smoke gate (manual)

**Why this is manual.** The automated E2E suite runs in `E2E_MOCK` **web** mode —
Playwright drives the Vite HTTP dev server, so it exercises **browser history**
(`createBrowserHistory`, real `/agents/$slug` paths). It can NOT validate the
**Electron** path: under packaged `file://`, the app uses **hash history**
(`createHashHistory`) because `file://` has no server to resolve clean paths. The
two histories are selected at build time by the `__WEB__` define
(`src/renderer/router/history.ts`), and only a real `loadFile` build proves the
hash branch wires up. (The auto-updater harness
`SUPERAGENT_TEST_UPDATES=1 SUPERAGENT_FAKE_VERSION=0.0.1 npm run dev:electron`
proves build wiring but NOT hash history — `dev:electron` still serves over http.)

Run this checklist before shipping a release that touches routing.

## Build

```sh
npm run dist:mac        # packaged build → app loads via loadFile (file://), hash history
# or, for a quicker non-packaged check of the production renderer:
npm run build:electron && npx electron-vite preview
```

Open the app, then open DevTools (View → Toggle Developer Tools, or ⌥⌘I).

## Checklist

1. **Hash URLs are in use.** Navigate into an agent, then a session. In the
   DevTools console, run `location.href`. It must read
   `file://…/index.html#/agents/<slug>` (and `…#/agents/<slug>/sessions/<id>`),
   i.e. the route lives in the **hash**, not the path. A bare `file://…/index.html`
   with the route in the path = the hash branch is NOT active (regression).

2. **Reload preserves the route.** On a session/task/
   dashboard/connections/api-logs/notifications/settings route, press **⌘R**. The
   same view must come back — NOT a reset to home. Repeat on `/notifications` and
   `/settings/<tab>`.

3. **Back / forward.** Use the in-app breadcrumb + the trackpad/▲▼ history
   gestures: agent → session → back returns to the agent; forward re-enters the
   session. No blank screen, no double-render.

4. **`superagent://` deep-link IPC.** With the app running, trigger a protocol
   deep-link (e.g. from a terminal):
   ```sh
   open "superagent://agent/<an-existing-slug>"
   ```
   The app must focus and route to that agent. Also verify a deep-link fired
   **before** the window is ready still routes once it opens (pending-protocol
   flush → `router.navigate`).

5. **Unknown / no-access agent.** `open "superagent://agent/does-not-exist"` (or
   manually edit the hash to `#/agents/nope`) → the ambiguous **"Agent not
   available"** screen renders inside the shell (sidebar stays). No crash.

6. **External links.** A `mailto:`/`https:`/`tel:` link in agent output opens in
   the system browser/handler (not inside the Electron window); an internal
   `<AppLink>` navigates in-window without spawning a new window.

If all six pass, the Electron hash-history path is good. Note the build commit in
the release PR.
