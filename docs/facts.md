# Facts and capabilities

Where the app runs decides what it may offer: the OS, whether it is the desktop
app or a browser, whether it came from the Mac App Store. Those are **facts**.
What a call site asks is a **capability**: "may this window open a folder
picker?", "can the agents' machine run computer use?". Gating on facts directly
is how a codebase fills up with `isElectron() && platform === 'darwin' && !…`,
each a slightly different guess at the same question.

## Two halves

The window and the agents are not always on the same computer, so the facts come
in two halves (`src/shared/lib/facts/facts-schema.ts`):

| Half | Describes | Fields |
| --- | --- | --- |
| `ClientFacts` | the app the person is looking at, and its computer | `shell` (`electron` / `browser`), `os` (null in a browser), `distribution` (null in a browser) |
| `ServerFacts` | the machine running the API and the agents | `os`, `distribution` (adds `deployment` for a web deployment) |

| Configuration | Client | Server |
| --- | --- | --- |
| Desktop app → its own API | this install | this install (main hosts the API) |
| Desktop app → cloud workspace | this install | the deployment |
| Web build | the browser | the deployment |

Whether the two are the same computer is the API target, `targetIsRemote()`.

A web deployment serves many browsers, so **server code reads server facts
only** (`getServerFacts()`). There is no "the client" from the server's side.

## Where a renderer gets them

`initApiBaseUrl()` settles them once, before the first render, with no request
of its own (`src/renderer/lib/facts.ts`):

- **Web, production:** `src/web/web-build.ts` inlines the server's facts into the
  HTML it serves, as a `<script type="application/json" id="server-facts">`
  block.
- **Web, dev:** the `server-facts` plugin in `vite.config.ts` does the same.
- **Electron:** main answers `get-facts` for the target the renderer settled
  (`src/main/facts.ts`). For the local API main *is* the server. For a cloud
  workspace main answers from the deployment's facts as it last heard them
  (`src/shared/lib/services/cloud-server-facts.ts`): the workspace's maintenance
  cycle asks `GET /api/server-facts` in the background, on start, on connect and
  every half hour, and keeps the answer in settings.

Boot never waits on a request for facts. The web server and main already hold
them, and a cloud renderer's boot waits on the deployment enough as it is.

`clientFacts()` and `serverFacts()` throw if read before boot settles them.
`serverFacts()` is null when the server didn't say: a cloud workspace older than
the endpoint, or one the desktop app hasn't heard from yet (a boot that beats
the first fetch after connecting).

## Rules

- **Combine facts only in a capability.** `src/shared/lib/facts/capabilities.ts`
  holds pure functions of server facts, asked by the server of
  `getServerFacts()` and by a renderer of `serverFacts()`, so both sides apply
  one rule. `src/renderer/lib/capabilities.ts` holds the renderer's, including
  `canUseHostFeatures()`. Each capability says which half it asks about.
- **Reading one fact to choose *how* is fine,** for example which setup steps to
  show for the server's OS. Deciding *whether* a feature exists is a capability.
- **Read a fact only where it is decided.** `process.mas` and
  `process.windowsStore` are read only in `server-facts.ts` (lint rule
  `no-restricted-properties`).
- **Only facts safe for an anonymous visitor** go in `ServerFacts`: the login
  page is the same HTML, and the endpoint is public.
- **Only facts that can't change without a new build or deploy.** The web build's
  service worker precaches `index.html` and serves it for every later
  navigation, so a page may hold the facts from when the worker was installed.
  Anything that can change at runtime stays an API read.

## Adding a fact

1. Add it to `serverFactsSchema` (or `ClientFacts`) and compute it in
   `server-facts.ts` (or `main/facts.ts`).
2. Make a new `ServerFacts` field optional, or give it a `.catch()` default. A
   renderer parses what an older or newer server sends: unknown keys are dropped,
   but a missing required field makes the whole half null.
3. Renderers receive it with no further wiring.
