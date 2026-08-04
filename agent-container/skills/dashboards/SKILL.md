---
name: dashboards
description: Create interactive web dashboards to visualize data and provide UI elements to the user
---

# Creating Dashboards

You can create web dashboards that are served to the user through the Gamut UI. Dashboards are full web applications (HTML/JS/React/Svelte/etc.) that run as servers inside the container.

## Available Tools

- **`create_dashboard`** — Scaffold a new dashboard project with the correct structure and boilerplate
- **`start_dashboard`** — Start a dashboard server (or restart it after code changes)
- **`list_dashboards`** — List all dashboards and their status
- **`get_dashboard_logs`** — Read stdout/stderr logs from a dashboard (useful for debugging)
- **Browser tools** — Open the running dashboard with `browser_open(..., location="container")`, inspect its rendered/accessibility state, exercise controls, and check client-side errors

## Quick Start (React)

1. Copy the template: `cp -r ~/.claude/skills/dashboards/templates/react-vite /workspace/artifacts/<slug>`
2. Update `package.json` with the dashboard's `name` and `description`
3. Edit `src/App.jsx` to build the UI (add API routes in `serve.js` if needed). Build dashboard-scoped URLs with `window.__GAMUT_DASHBOARD__.url('api/data')`.
4. Use `start_dashboard` to build and start the server; inspect its screenshot and note the returned port
5. Open `http://localhost:<port>` with `browser_open(..., location="container")`, exercise the important interactions, and check browser errors
6. Iterate until both visual and functional checks pass; close the browser when validation is complete

## Directory Structure

Dashboards live in `/workspace/artifacts/<slug>/`:

```
/workspace/artifacts/my-dashboard/
├── package.json        # Must have name, description, and start script
├── index.js            # Entry point (for plain dashboards)
└── dashboard.log       # Auto-generated stdout/stderr log
```

## Requirements

- **`package.json`** must have `name`, `description`, and a `start` script
- The server **must listen on the port provided via `DASHBOARD_PORT` environment variable**
- Use `bun` as the runtime (it's pre-installed)

## Plain Dashboard Example (Bun.serve)

```javascript
// index.js
const port = process.env.DASHBOARD_PORT || 3000;

const server = Bun.serve({
  port,
  fetch(req) {
    return new Response(`
      <!DOCTYPE html>
      <html>
        <body>
          <h1>My Dashboard</h1>
          <div id="chart"></div>
          <script>
            // Your interactive JavaScript here
          </script>
        </body>
      </html>
    `, { headers: { 'Content-Type': 'text/html' } });
  },
});

console.log(`Server running on port ${port}`);
```

## React Dashboard (Recommended)

A pre-configured React + Vite template is available. To create a new React dashboard:

```bash
cp -r ~/.claude/skills/dashboards/templates/react-vite /workspace/artifacts/<slug>
```

Then update `package.json` with the dashboard's `name` and `description`, and edit `src/App.jsx` to build the UI.

The template structure:

```
/workspace/artifacts/<slug>/
├── package.json        # Update name + description
├── gamut-dashboard.js  # Gamut base-path + Vite/HMR adapter
├── vite.config.js      # Uses the Gamut adapter
├── serve.js            # Static server with API route support
├── index.html
└── src/
    ├── main.jsx
    └── App.jsx          # Edit this to build your dashboard
```

React dashboards are **built to static files** (`vite build`) and served via `serve.js` by default. The start script runs `bun run build && bun run serve.js`. The included adapter also supports the Vite dev server and keeps HMR beneath the artifact mount.

**CRITICAL:** Keep `gamutDashboard()` in `vite.config.js`. The dashboard manager supplies `DASHBOARD_BASE_PATH`; in development the adapter applies it to Vite's entry modules and HMR client. Production assets, dynamic imports, CSS/worker URLs, fonts, and images remain relative, while `serve.js` and the injected runtime provide a stable document/router base. This keeps one production build relocatable.

### Adding API routes to a React dashboard

Edit `serve.js` to add API routes inside the `fetch` handler, before the static file fallback:

```javascript
// In serve.js, inside the fetch handler:
if (url.pathname === '/api/data') {
  const data = { items: [1, 2, 3] };
  return Response.json(data);
}

// Static files are served automatically for all other paths
return serveStatic(req, url.pathname);
```

## URL Paths & Proxying

Dashboards are served through a proxy chain:
```
Browser → Main App (/api/agents/:id/artifacts/:slug/) → Container → Dashboard Server
```

Gamut strips the public artifact prefix before forwarding requests to the dashboard server. It communicates that mount through `DASHBOARD_BASE_PATH` in the process, `X-Forwarded-Prefix` on HTTP/WebSocket requests, and `window.__GAMUT_DASHBOARD__` in browser HTML.

Use the injected helper for dashboard-owned URLs. It stays correct on nested client routes and when another trusted proxy adds its own prefix:

```javascript
const { basePath, routerBasePath, url } = window.__GAMUT_DASHBOARD__;

fetch(url('api/data'));
image.src = url('assets/chart.png');

// React Router and similar SPA routers need the runtime router base, which is
// intentionally separate from Vite's build-time asset base.
// <BrowserRouter basename={routerBasePath}>...</BrowserRouter>
```

Root-relative application URLs such as `/api/data` still target the Gamut host and must not be used for dashboard-owned routes.

### Third-party Vite apps and OpenSlide

Frameworks that accept a base at startup can consume the manager-provided value directly:

```ts
// open-slide.config.ts
import type { OpenSlideConfig } from '@open-slide/core';

const config: OpenSlideConfig = {
  // OpenSlide uses this value for both Vite assets and BrowserRouter.
  base: process.env.DASHBOARD_BASE_PATH || '/',
  port: Number(process.env.DASHBOARD_PORT) || 5173,
};

export default config;
```

OpenSlide's built-in Vite configuration cannot install Gamut's prefix-restoring
middleware. Opt its dashboard server into mounted upstream paths so HTTP modules
and HMR WebSockets both reach Vite beneath the same absolute base:

```json
{
  "scripts": { "start": "open-slide dev" },
  "gamut": { "upstreamPath": "mounted" }
}
```

The default upstream-path mode is `stripped`, which keeps existing dashboard
servers receiving root-local paths such as `/api/data`. Use `mounted` only when
the framework requires inbound requests to retain `DASHBOARD_BASE_PATH`.

For an app-owned React Router, prefer the injected runtime value:

```tsx
<BrowserRouter basename={window.__GAMUT_DASHBOARD__?.routerBasePath ?? '/'}>
  <App />
</BrowserRouter>
```

Do not patch generated bundles after Vite hashes them and do not add a query string to only one copy of an entry module. Both approaches violate module/cache identity and can leave stale router code or duplicate React instances.

## Interactive Validation

- **Validate every dashboard in container Chromium.** After `start_dashboard`, open its localhost URL with `browser_open(url="http://localhost:<port>", location="container")`. The explicit location forces the bundled browser that can reach private container ports.
- **Test behavior, not just appearance.** Exercise the primary controls and workflows, inspect rendered and accessibility state, and check browser console/errors for client-side failures.
- **Use both diagnostic surfaces.** Use `get_dashboard_logs` for server failures and browser diagnostics for rendering or client-side failures.
- **Close the browser when validation is complete.**

## Built-in APIs

The following APIs are automatically available in all dashboards (injected by the platform):

- **Speech Recognition** — The standard `SpeechRecognition` Web API for voice-to-text. See `~/.claude/skills/dashboards/SPEECH_RECOGNITION.md` for full documentation and examples.
- **LLM (Anthropic SDK)** — An Anthropic SDK-compatible `Anthropic` client for calling Claude. No API keys needed. See `~/.claude/skills/dashboards/LLM_API.md` for full documentation and examples.

## Best Practices

- **Keep dependencies minimal** — fewer deps means faster installs and starts
- **Always use `process.env.DASHBOARD_PORT`** — never hardcode ports
- **Use the dashboard URL helper** — `window.__GAMUT_DASHBOARD__.url(...)` keeps URLs inside the mount
- **Use Bun APIs** — `Bun.serve()`, `Bun.file()`, etc. are fast and built-in
- **Check logs on errors** — use `get_dashboard_logs` to debug crashes
- **Restart after changes** — use `start_dashboard` after modifying source code
- **Verify interactively** — use `browser_open(..., location="container")` after every restart and exercise the changed behavior
- **Static assets** — serve them from the same directory or use inline styles/scripts for simplicity
