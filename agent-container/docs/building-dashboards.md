# Building Dashboards

Read this guide before creating, editing, or debugging a Gamut dashboard.
Dashboards are interactive web applications served from the agent container and
shown to the user as persistent artifacts.

## When to Build a Dashboard

Use a dashboard when the user needs a rich visual artifact rather than a chat
response or downloadable static file—for example:

- interactive charts, filters, or tables;
- a reusable tracker, calculator, or data explorer;
- a multi-view report with controls;
- a visual interface over generated or fetched data.

When the dashboard-builder specialist is available, delegate dashboard creation
and substantial edits to it. The guide remains authoritative for the lifecycle,
proxy constraints, and validation expectations.

## Lifecycle Tools

- `create_dashboard` scaffolds `/workspace/artifacts/<slug>/` using either the
  plain or React framework.
- `start_dashboard` starts or restarts the server and returns status, a
  validation URL, and normally a screenshot.
- `list_dashboards` resolves existing slugs and current status.
- `get_dashboard_logs` returns server stdout/stderr and can clear old logs.

Always call `start_dashboard` after creating or changing a dashboard. Its
screenshot is a quick visual check, not the end of validation.

## Choose a Framework

Use `framework: "plain"` for a focused dashboard that fits naturally in a
small Bun server with HTML, CSS, and JavaScript. It is fast to create and has
few dependencies.

Use `framework: "react"` for complex interactive state, reusable components,
multi-view navigation, or form-heavy interfaces. The scaffold contains React,
Vite, a static server, and Gamut's base-path adapter.

Do not replace an existing dashboard's framework merely because another one is
preferred for new work.

## Required Runtime Contract

Dashboards live under:

```text
/workspace/artifacts/<slug>/
```

Every dashboard needs a `package.json` with `name`, `description`, and a
working `start` script. Its server must listen on the port from
`process.env.DASHBOARD_PORT`; never hardcode a port.

Use Bun as the runtime. Install added dependencies inside the dashboard
directory with `bun add <package>` or `bun install`.

### Plain Dashboard

A plain scaffold uses `Bun.serve`:

```javascript
const port = Number(process.env.DASHBOARD_PORT)

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/api/data') {
      return Response.json({ items: [] })
    }
    if (url.pathname === '/') {
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    }
    return new Response('Not Found', { status: 404 })
  },
})
```

Leading slashes are correct inside server-side route matching because the
dashboard manager normalizes the upstream request before it reaches the server.

### React Dashboard

The React scaffold normally contains:

```text
/workspace/artifacts/<slug>/
├── package.json
├── gamut-dashboard.js
├── vite.config.js
├── serve.js
├── index.html
└── src/
    ├── main.jsx
    └── App.jsx
```

Keep `gamutDashboard()` in `vite.config.js`. The adapter applies the runtime
base path to Vite entry modules and HMR while keeping the production build
relocatable. Do not patch generated bundles after Vite hashes them.

Add API routes in `serve.js` before its static-file fallback. Use the server's
local route path there, then use the injected URL helper from browser code.

## Base Paths and Dashboard-Owned URLs

The user's browser reaches a dashboard through a proxy mount similar to:

```text
Browser → Gamut artifact route → agent container → dashboard server
```

The public path is not `/`. Root-relative browser URLs such as `/api/data`,
`/assets/logo.svg`, or `/details` target the Gamut host and commonly fail after
mounting.

Use the injected runtime helper for dashboard-owned URLs:

```javascript
const { url, routerBasePath } = window.__GAMUT_DASHBOARD__

const response = await fetch(url('api/data'))
image.src = url('assets/logo.svg')
```

Configure client routers with `routerBasePath`:

```jsx
<BrowserRouter basename={window.__GAMUT_DASHBOARD__?.routerBasePath ?? '/'}>
  <App />
</BrowserRouter>
```

Use the helper for fetches, images, downloads, worker URLs, and dashboard-owned
links. Static build assets should remain relative unless the scaffold adapter
handles them.

The default upstream mode strips the artifact prefix and sends
`X-Forwarded-Prefix`. Use mounted upstream paths only for a framework that must
receive the base path in its inbound URL, and configure that through the
dashboard's supported `gamut.upstreamPath` setting rather than ad-hoc rewrites.

## Development Workflow

1. Resolve or choose a stable, URL-safe slug.
2. Call `create_dashboard` for a new artifact; inspect existing files before an
   edit.
3. Implement the smallest coherent dashboard that satisfies the request.
4. Add dependencies with Bun when necessary.
5. Call `start_dashboard` and inspect status, URL, screenshot, and any lint
   findings.
6. Open the exact returned URL with `browser_open(location="container")`.
7. Exercise primary controls, responsive behavior, routing, loading/empty/error
   states, and at least one meaningful edge case.
8. Check `browser_run("errors")`, relevant console output, and
   `get_dashboard_logs`.
9. Fix issues, restart, and repeat until visual and functional checks pass.
10. Close the validation browser when finished.

Do not trim the base path from the validation URL returned by `start_dashboard`.
The explicit container location forces the bundled Chromium that can reach the
private dashboard port.

## Design and Accessibility

- Build mobile-first responsive layouts with grid or flexbox.
- Establish clear hierarchy through typography, spacing, and grouping.
- Use a small, consistent set of CSS custom properties for color, spacing,
  radius, and typography.
- Meet WCAG AA contrast and never communicate state through color alone.
- Use semantic HTML, proper headings, associated labels, and ARIA only when
  native semantics are insufficient.
- Provide loading, empty, error, and stale-data states rather than blank areas.
- Keep dependencies proportional to the dashboard; simple visualizations do
  not need a large application framework.
- Make important metrics understandable without requiring hover.

For charts, select a representation that matches the question and keep axes,
units, legends, and tooltips unambiguous. Test interaction and keyboard access,
not only the initial render.

## Data and API Patterns

Keep secrets and privileged API calls on the dashboard server. Expose only the
data needed by the browser through dashboard-owned API routes.

For periodic updates, fetch through the runtime URL helper:

```javascript
async function refresh() {
  const response = await fetch(window.__GAMUT_DASHBOARD__.url('api/data'))
  if (!response.ok) throw new Error(`Request failed: ${response.status}`)
  render(await response.json())
}

refresh()
setInterval(refresh, 30_000)
```

Handle failed requests and avoid overlapping refreshes when a request can take
longer than its interval.

## Built-In Browser APIs

Dashboards can use platform-provided browser APIs without asking the user for a
new key:

- Speech recognition uses the standard `SpeechRecognition` or
  `webkitSpeechRecognition` interface. Detailed examples are in
  `~/.claude/skills/dashboards/SPEECH_RECOGNITION.md`.
- The injected Anthropic-compatible client can call the user's configured LLM
  provider. Detailed examples and limits are in
  `~/.claude/skills/dashboards/LLM_API.md`.

Do not expose platform tokens or route these built-in APIs through a public
third-party proxy.

## Debugging

When a dashboard fails:

1. Inspect `get_dashboard_logs` for syntax errors, missing modules, port
   failures, and crash loops.
2. Inspect the `start_dashboard` screenshot for blank or malformed rendering.
3. Open the returned URL in container Chromium and check browser errors.
4. Exercise the failing interaction while observing network, console, and
   rendered state.

Common causes:

- not listening on `DASHBOARD_PORT`;
- failing to install a new dependency;
- using root-relative browser URLs instead of the injected helper;
- using the host browser for a private container URL;
- configuring a router with `/` rather than `routerBasePath`;
- assuming the screenshot proves controls or client routing work;
- restarting repeatedly without fixing a crash loop's root cause.

Clear logs before a fresh reproduction when old output makes diagnosis
ambiguous.

## Completion Checklist

- The dashboard starts successfully after the final change.
- The returned screenshot has no obvious layout or content failure.
- The exact returned URL works in container Chromium.
- Primary controls and routes were exercised.
- Loading, empty, and error behavior are present where relevant.
- Browser diagnostics and server logs contain no unexplained errors.
- Dashboard-owned URLs use the runtime helper.
- The validation browser is closed when no longer needed.
- The final response names the dashboard slug and current status.
