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

## Styling — Read DESIGN.md First

**Before writing any UI, read the design system at `~/.claude/skills/dashboards/DESIGN.md`.** It defines the canonical color palette, type scale, spacing, radii, and component recipes that every dashboard must follow. Dashboards render inside the Superagent app shell, so they need to feel continuous with it — improvising styles produces a foreign-looking widget.

Hard rules from DESIGN.md:
- Use the tokens (e.g. `var(--color-primary)`, `var(--space-4)`) — **never hardcode hex colors or pixel sizes** in component code.
- Respect `prefers-color-scheme: dark`. Both the React template's `src/tokens.css` and the plain template's inline CSS already do this.
- Don't add a CSS framework (Tailwind, Bootstrap, MUI). The token CSS is the framework.
- Color is reserved for data and status — not decoration. Use `chart1`–`chart5` for data viz; never invent additional hues.

### Per-dashboard overrides

Every scaffolded dashboard ships its own `DESIGN.md` at the dashboard root, which `extends` the system DESIGN.md. To customize a single dashboard:

1. Edit token values in the dashboard's `DESIGN.md` YAML front matter.
2. Update the matching CSS variables in the dashboard's stylesheet (`src/tokens.css` for React, the inline `<style>` block for plain) — they must stay in sync.
3. Add prose under the `## Local Notes` section explaining *why* the override exists, so future edits keep the intent.

Do **not** edit `~/.claude/skills/dashboards/DESIGN.md` itself — that's the system default.

## Quick Start (React)

1. Copy the template: `cp -r ~/.claude/skills/dashboards/templates/react-vite /workspace/artifacts/<slug>`
2. Update `package.json` with the dashboard's `name` and `description`
3. Read `DESIGN.md` (now in the dashboard root) for the design rules
4. Edit `src/App.jsx` to build the UI, using tokens from `src/tokens.css` (`var(--color-*)`, `.sa-card`, `.sa-button`, etc.). Add API routes in `serve.js` if needed. **All fetch calls in the frontend MUST use relative URLs** — `fetch('api/data')` not `fetch('/api/data')` — absolute paths will 404.
5. Use `start_dashboard` to build and start the server
6. The user can view the dashboard in the Superagent UI

## Directory Structure

Dashboards live in `/workspace/artifacts/<slug>/`:

```
/workspace/artifacts/my-dashboard/
├── package.json        # Must have name, description, and start script
├── DESIGN.md           # Per-dashboard design tokens (extends the system DESIGN.md)
├── index.js            # Entry point (for plain dashboards)
└── dashboard.log       # Auto-generated stdout/stderr log
```

## Requirements

- **`package.json`** must have `name`, `description`, and a `start` script
- The server **must listen on the port provided via `DASHBOARD_PORT` environment variable**
- Use `bun` as the runtime (it's pre-installed)

## Plain Dashboard Example (Bun.serve)

The `create_dashboard` tool with `framework: 'plain'` scaffolds an `index.js` that already inlines the design tokens. Extend it like this:

```javascript
// index.js
const port = process.env.DASHBOARD_PORT || 3000;

const server = Bun.serve({
  port,
  fetch(req) {
    return new Response(html, { headers: { 'Content-Type': 'text/html' } });
  },
});

const html = `<!DOCTYPE html>
<html>
  <head>
    <title>My Dashboard</title>
    <style>
      /* Design tokens (kept in sync with DESIGN.md) */
      :root {
        --color-background: #ffffff;
        --color-foreground: #0a0a0a;
        --color-primary: #171717;
        /* ...etc, see scaffolded index.js for the full set */
      }
      body { font-family: Inter, system-ui, sans-serif; background: var(--color-background); color: var(--color-foreground); }
      .sa-card { border: 1px solid var(--color-border); border-radius: 8px; padding: 24px; }
    </style>
  </head>
  <body>
    <div class="sa-page">
      <h1>My Dashboard</h1>
      <section class="sa-card">...</section>
    </div>
  </body>
</html>`;
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
├── DESIGN.md           # Per-dashboard design tokens — edit to override
├── vite.config.js      # Pre-configured with base: './' (DO NOT remove this)
├── serve.js            # Static server with API route support
├── index.html
└── src/
    ├── main.jsx
    ├── tokens.css      # Design tokens as CSS variables + .sa-* component recipes
    └── App.jsx         # Edit this to build your dashboard
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

## Important Limitations

- **Do NOT use the browser tool to view your own dashboards.** The browser runs outside the container and cannot access `localhost` URLs served inside it. Dashboard requests will fail. The user views dashboards through the Superagent UI — you do not need to verify them visually. Use `get_dashboard_logs` to debug issues instead.

## Best Practices

- **Read DESIGN.md before designing** — system at `~/.claude/skills/dashboards/DESIGN.md`, plus the dashboard's local `DESIGN.md` for any overrides
- **Use design tokens, not raw values** — `var(--color-primary)`, not `#171717`; `var(--space-4)`, not `16px`
- **Keep dependencies minimal** — fewer deps means faster installs and starts
- **Always use `process.env.DASHBOARD_PORT`** — never hardcode ports
- **Always use relative URLs** — absolute paths bypass the dashboard proxy (see above)
- **Use Bun APIs** — `Bun.serve()`, `Bun.file()`, etc. are fast and built-in
- **Check logs on errors** — use `get_dashboard_logs` to debug crashes
- **Restart after changes** — use `start_dashboard` after modifying source code
