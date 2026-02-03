---
description: Create interactive web dashboards to visualize data and provide UI elements to the user
---

# Creating Dashboards

You can create web dashboards that are served to the user through the Superagent UI. Dashboards are full web applications (HTML/JS/React/Svelte/etc.) that run as servers inside the container.

## Available Tools

- **`create_dashboard`** — Scaffold a new dashboard project with the correct structure and boilerplate
- **`start_dashboard`** — Start a dashboard server (or restart it after code changes)
- **`list_dashboards`** — List all dashboards and their status
- **`get_dashboard_logs`** — Read stdout/stderr logs from a dashboard (useful for debugging)

## Quick Start (React)

1. Copy the template: `cp -r ~/.claude/skills/dashboards/templates/react-vite /workspace/artifacts/<slug>`
2. Update `package.json` with the dashboard's `name` and `description`
3. Edit `src/App.jsx` to build the UI (add API routes in `serve.js` if needed). **All fetch calls in the frontend MUST use relative URLs** — `fetch('api/data')` not `fetch('/api/data')` — absolute paths will 404.
4. Use `start_dashboard` to build and start the server
5. The user can view the dashboard in the Superagent UI

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
├── vite.config.js      # Pre-configured with base: './' (DO NOT remove this)
├── serve.js            # Static server with API route support
├── index.html
└── src/
    ├── main.jsx
    └── App.jsx          # Edit this to build your dashboard
```

React dashboards are **built to static files** (`vite build`) and served via `serve.js`. The start script runs `bun run build && bun run serve.js`. Vite's dev server cannot be used because dashboards are served through a proxy chain.

**CRITICAL:** `vite.config.js` must include `base: './'` so that built asset paths are relative. Without this, the built HTML will reference `/assets/...` (absolute), which bypasses the proxy chain and 404s. The template already has this configured — do not remove it.

### Adding API routes to a React dashboard

Edit `serve.js` to add API routes inside the `fetch` handler, before the static file fallback:

```javascript
// In serve.js, inside the fetch handler:
if (url.pathname === '/api/data') {
  const data = { items: [1, 2, 3] };
  return Response.json(data);
}

// Static files are served automatically for all other paths
return serveStatic(url.pathname);
```

## URL Paths & Proxying

Dashboards are served through a proxy chain:
```
Browser → Main App (/api/agents/:id/artifacts/:slug/) → Container → Dashboard Server
```

**IMPORTANT: Always use relative URLs in dashboard code.** The dashboard is served under a subpath, so absolute paths (starting with `/`) will bypass the proxy and hit the main app instead.

```javascript
// CORRECT — relative paths are proxied to your dashboard server
fetch('api/data')
fetch('./api/data')

// WRONG — absolute paths bypass the proxy, hitting the main app
fetch('/api/data')
```

This applies to all fetches, image sources, link hrefs, etc.

## Best Practices

- **Keep dependencies minimal** — fewer deps means faster installs and starts
- **Always use `process.env.DASHBOARD_PORT`** — never hardcode ports
- **Always use relative URLs** — absolute paths bypass the dashboard proxy (see above)
- **Use Bun APIs** — `Bun.serve()`, `Bun.file()`, etc. are fast and built-in
- **Check logs on errors** — use `get_dashboard_logs` to debug crashes
- **Restart after changes** — use `start_dashboard` after modifying source code
- **Static assets** — serve them from the same directory or use inline styles/scripts for simplicity
