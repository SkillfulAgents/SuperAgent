# Browser Integration PRD

## Overview

Give agents the ability to spin up a headless browser, interact with web pages, and extract information — while streaming the browser viewport live to the user and allowing the user to "take over" (click, type, scroll) when needed.

**Primary use case**: Agent navigates to a site, encounters a login wall or sensitive step, asks user to take over, user interacts via live preview, agent resumes automation.

## Approach: Tool-proxied `agent-browser`

We use the `agent-browser` npm package as the underlying engine, but **all browser actions are exposed as tool-proxy endpoints on the container API**, not as raw CLI commands.

### `agent-browser` provides:
- **CLI**: `agent-browser open`, `snapshot`, `click`, `fill`, etc.
- **Accessibility-tree snapshots with refs**: Optimized for LLM navigation (`snapshot -i --json` → refs like `@e1`, `@e2`)
- **Streaming via WebSocket**: `AGENT_BROWSER_STREAM_PORT=<port>` broadcasts JPEG frames from CDP screencast
- **Input injection**: Same WS accepts mouse/keyboard/touch events for user interaction
- **Daemon architecture**: Browser persists between CLI commands — no startup cost per action
- **Persistent profiles**: `--profile` flag for cookie/session persistence

### Why tool-proxy instead of raw CLI

The agent doesn't call `agent-browser` directly. Instead, the container API exposes tool endpoints (`/browser/open`, `/browser/snapshot`, `/browser/click`, etc.) that:
1. **Execute the underlying `agent-browser` CLI** and return the result
2. **Track browser lifecycle** — the API knows exactly when a browser starts/stops because it mediates every action
3. **Associate browser to session** — each tool call includes a `sessionId`, so the API knows which session owns the browser
4. **Emit SSE events** — `browser_active` events are emitted on the session's stream at the moment of `open`/`close`, no PID-file watching needed
5. **Extensible** — adding new browser capabilities (e.g., cookie management, network interception) is just a new endpoint, no agent prompt changes needed

Claude Code invokes these via the container's HTTP API (through hooks that intercept tool calls), which is already the pattern for secrets, file requests, and connected accounts.

### Why `agent-browser` over raw Playwright

- Snapshot/ref workflow is purpose-built for LLM agents (we'd have to build this ourselves)
- Streaming server + input injection already implemented
- Daemon means fast sequential commands (browser stays alive between actions)

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ React UI                                                │
│  ┌───────────────────────────────────┐                  │
│  │ BrowserPreview component          │                  │
│  │  - <canvas> renders JPEG frames   │                  │
│  │  - Captures mouse/keyboard events │                  │
│  │  - Collapsible panel in session   │                  │
│  └──────────┬────────────────────────┘                  │
│             │ WebSocket (frames + input)                  │
└─────────────┼───────────────────────────────────────────┘
              │
┌─────────────┼───────────────────────────────────────────┐
│ Main App Server (Hono)                                   │
│  /api/agents/:slug/browser/stream  → WS proxy            │
│  /api/agents/:slug/browser/status  → HTTP proxy          │
│  /api/agents/:slug/browser/:action → HTTP proxy (tools)  │
└─────────────┼───────────────────────────────────────────┘
              │
┌─────────────┼───────────────────────────────────────────┐
│ Container API Server (agent-container)                   │
│  /browser/stream   → WS proxy to agent-browser stream    │
│  /browser/status   → returns current browser state       │
│  /browser/open     → tool: start browser, navigate       │
│  /browser/close    → tool: stop browser                  │
│  /browser/snapshot → tool: get accessibility snapshot     │
│  /browser/click    → tool: click element by ref          │
│  /browser/fill     → tool: fill input by ref             │
│  /browser/scroll   → tool: scroll page                   │
│  /browser/wait     → tool: wait for navigation/selector  │
│  ...future tools                                         │
│                                                          │
│  Each tool endpoint:                                     │
│   1. Executes `agent-browser <cmd>` subprocess           │
│   2. Returns CLI output as JSON                          │
│   3. Emits lifecycle events on session WS stream         │
└─────────────┼───────────────────────────────────────────┘
              │ subprocess (within container)
┌─────────────┼───────────────────────────────────────────┐
│ agent-browser daemon + Chromium (headless)               │
│  StreamServer on port 9223 (internal only)               │
└─────────────────────────────────────────────────────────┘
```

Everything runs inside the container. The stream port is internal — not exposed to the host. The container API mediates all browser actions and tracks lifecycle.

---

## Container Changes

### Dockerfile additions

```dockerfile
# Install Chromium dependencies (needed by Playwright)
RUN apt-get update && apt-get install -y \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libdbus-1-3 libxkbcommon0 \
    libatspi2.0-0 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 \
    libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

# Install agent-browser and Chromium
RUN npm install -g agent-browser && \
    agent-browser install
```

### Environment variables set at container start

```
AGENT_BROWSER_STREAM_PORT=9223      # Streaming WebSocket port
AGENT_BROWSER_ARGS=--no-sandbox     # Required for Docker
AGENT_BROWSER_PROFILE=/workspace/.browser-profile  # Persistent cookies/sessions
```

## Container API Changes (`agent-container/src/server.ts`)

### Browser state tracking

The container server maintains a simple in-memory state:

```typescript
interface BrowserState {
  active: boolean
  sessionId: string | null  // Which session owns the browser
}
let browserState: BrowserState = { active: false, sessionId: null }
```

When `open` is called, `browserState` is set and a `browser_active` event is emitted on the owning session's WS stream. When `close` is called (or the session ends), the inverse happens.

### Tool endpoints

All tool endpoints follow the same pattern: accept JSON body, execute `agent-browser <cmd>`, return structured result. They are `POST` requests scoped to a session.

**`POST /browser/open`** — Start browser and navigate
```json
// Request
{ "sessionId": "abc123", "url": "https://example.com" }
// Response
{ "success": true }
```
- Runs `agent-browser open <url> --profile /workspace/.browser-profile`
- Sets `browserState = { active: true, sessionId }`
- Emits `{ type: "browser_active", active: true }` on session's WS stream

**`POST /browser/close`** — Stop browser
```json
{ "sessionId": "abc123" }
```
- Runs `agent-browser close`
- Sets `browserState = { active: false, sessionId: null }`
- Emits `{ type: "browser_active", active: false }` on session's WS stream

**`POST /browser/snapshot`** — Get accessibility tree snapshot
```json
// Request
{ "sessionId": "abc123", "interactive": true, "compact": true }
// Response — the raw agent-browser snapshot output
{ "refs": [...], "tree": "..." }
```
- Runs `agent-browser snapshot -i -c --json`

**`POST /browser/click`** — Click element by ref
```json
{ "sessionId": "abc123", "ref": "@e1" }
```

**`POST /browser/fill`** — Fill input by ref
```json
{ "sessionId": "abc123", "ref": "@e2", "value": "hello" }
```

**`POST /browser/scroll`** — Scroll page
```json
{ "sessionId": "abc123", "direction": "down", "amount": 500 }
```

**`POST /browser/wait`** — Wait for condition
```json
{ "sessionId": "abc123", "for": "networkidle" }
```

Each endpoint validates that `sessionId` matches `browserState.sessionId` (or browser is not active). This prevents one session from interfering with another's browser.

### Status endpoint

**`GET /browser/status`** — Check if browser is running
```json
{ "active": true, "sessionId": "abc123" }
```
Returns the current `browserState`. No subprocess execution.

### Stream endpoint

**`WS /browser/stream`** — Proxy WebSocket to agent-browser stream server
- On upgrade: connect to `ws://localhost:9223` inside container
- Bidirectional pipe: frames from agent-browser → client, input events from client → agent-browser
- If browser is not active, return error and close

```typescript
// In server.on('upgrade', ...) handler:
if (pathname === '/browser/stream') {
  if (!browserState.active) {
    socket.destroy()
    return
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    const upstream = new WebSocket('ws://localhost:9223')
    upstream.on('message', (data) => ws.send(data))
    ws.on('message', (data) => upstream.send(data))
    upstream.on('close', () => ws.close())
    ws.on('close', () => upstream.close())
    upstream.on('error', () => ws.close())
  })
}
```

---

## Main App Server Changes

### New API routes

**`GET /api/agents/:slug/browser/status`** — Proxy to container's `/browser/status`

```typescript
// In src/api/routes/agents.ts
app.get('/:slug/browser/status', async (c) => {
  const client = await containerManager.getClient(slug)
  const response = await client.fetch('/browser/status')
  return c.json(await response.json())
})
```

**`WS /api/agents/:slug/browser/stream`** — Proxy WebSocket to container

In the main app's HTTP server, handle WS upgrade for this path. Connect to the container's `/browser/stream` WebSocket and pipe bidirectionally.

This follows the same pattern as the existing session stream, but for browser frames instead of SDK messages.

---

## Frontend Changes

### New SSE event: `browser_active`

Emitted by the container when the agent calls `/browser/open` or `/browser/close` tool endpoints. Propagated through the existing session WS stream → main app SSE stream.

```json
{ "type": "browser_active", "active": true }
{ "type": "browser_active", "active": false }
```

On initial page load, the frontend also checks `GET /api/agents/:slug/browser/status` to sync state (in case the browser was already running before the SSE connection was established).

### StreamState additions

```typescript
interface StreamState {
  // ... existing fields ...
  browserActive: boolean  // Whether browser is running
}
```

### `BrowserPreview` component

A collapsible panel shown in the session view when `browserActive` is true.

**Layout**: Appears below the message input area (or as a side panel). Collapsed by default to a small bar showing "Browser active — click to expand". Expands to show the viewport.

**Rendering**:
- Connect to `ws://<apiBase>/api/agents/<slug>/browser/stream`
- Receive `{ type: "frame", data: "<base64 jpeg>", metadata: {...} }` messages
- Render to a `<canvas>` element, scaling to fit the panel width while maintaining aspect ratio
- Use `metadata.deviceWidth` / `deviceHeight` to compute coordinate mapping for input

**Input capture** (when expanded and focused):
- `onMouseDown/Up/Move` → send `input_mouse` messages with coordinates mapped to viewport space
- `onKeyDown/Up` → send `input_keyboard` messages
- `onWheel` → send `input_mouse` wheel events
- Disable when collapsed

**Coordinate mapping**:
```typescript
const scaleX = metadata.deviceWidth / canvas.clientWidth
const scaleY = metadata.deviceHeight / canvas.clientHeight
const x = event.offsetX * scaleX
const y = event.offsetY * scaleY
```

**States**:
1. **Hidden**: `browserActive` is false — nothing shown
2. **Collapsed bar**: Browser is active, user hasn't expanded — shows "🌐 Browser active" with expand button
3. **Expanded**: Shows live viewport, captures input
4. **Agent stopped**: Container not running — hidden entirely

### Agent takeover flow

1. Agent encounters a login page or sensitive action
2. Agent sends a message to the user: "Please log in to amex.com — I've opened the browser for you"
   - This is just a regular text message from the agent. No special event type needed initially.
   - The agent can use the existing `AskUserQuestion` tool to ask the user to take over, then wait for confirmation before resuming.
3. User sees the browser preview, expands it, interacts directly
4. User tells the agent "I've logged in, continue" (or answers the question)
5. Agent calls `browser_snapshot()` to see the new page state and continues

No special "takeover mode" protocol is needed — the streaming + input injection is always available when the browser is active. The agent just needs to pause and ask.

---

## Agent System Prompt / Skill

Create a skill (similar to the planned dashboard skill) that teaches the agent how to use the browser tools. The agent calls these as tool-use through the container API (hooked via Claude Code's PreToolUse/PostToolUse hooks). From the agent's perspective, these are just tools it can invoke.

```markdown
## Browser Automation

You have browser tools for web automation. The user can see your browser
live and interact with it directly.

### Available tools
- `browser_open(url)` — Open browser and navigate to URL
- `browser_snapshot(interactive?, compact?)` — Get accessibility tree with element refs (@e1, @e2, ...)
- `browser_click(ref)` — Click element by ref
- `browser_fill(ref, value)` — Fill input by ref
- `browser_scroll(direction, amount?)` — Scroll the page
- `browser_wait(for)` — Wait for navigation/networkidle/selector
- `browser_close()` — Close the browser

### Core workflow
1. `browser_open("https://example.com")` — Navigate to page
2. `browser_snapshot(interactive=true)` — Get interactive elements with refs
3. `browser_click("@e1")` / `browser_fill("@e2", "text")` — Interact using refs
4. Re-snapshot after page changes to get updated refs

### When you need user input
If you encounter a login page, CAPTCHA, or sensitive action:
1. Tell the user what you need them to do (they can see and interact with the browser live)
2. Use AskUserQuestion to ask them to confirm when done
3. After confirmation, re-snapshot to see the updated page

### Tips
- Use interactive + compact snapshot to reduce output — you usually only need buttons, links, inputs
- Use `browser_wait("networkidle")` after navigation to ensure page is loaded
- The browser preserves cookies/sessions — user logs in once, you can reuse the session later
- Close the browser with `browser_close()` when done to free resources
```

---

## Implementation Plan

### Phase 1: Container — Install browser and build tool endpoints

1. **Update Dockerfile**: Add Chromium deps, install `agent-browser`, download Chromium
2. **Set env vars**: `AGENT_BROWSER_STREAM_PORT`, `AGENT_BROWSER_ARGS`, `AGENT_BROWSER_PROFILE` in container start
3. **Add browser state tracking** to container server (in-memory `BrowserState`)
4. **Add tool endpoints**: `/browser/open`, `/browser/close`, `/browser/snapshot`, `/browser/click`, `/browser/fill`, `/browser/scroll`, `/browser/wait`
5. **Add `/browser/status` endpoint**
6. **Add `/browser/stream` WS proxy**
7. **Emit `browser_active` events** on session WS stream from `open`/`close` endpoints
8. **Test**: Call tool endpoints via curl, verify browser starts, stream serves frames

### Phase 2: Main app server — Proxy all browser endpoints

9. **Add `GET /api/agents/:slug/browser/status`** route — proxies to container
10. **Add `POST /api/agents/:slug/browser/:action`** routes — proxy tool calls to container
11. **Add WS upgrade handler for `/api/agents/:slug/browser/stream`** — proxies WebSocket to container
12. **Forward `browser_active` WS events** through to SSE stream
13. **Test**: Connect to WS from CLI tool (e.g., `wscat`), verify frames arrive

### Phase 3: Frontend — Browser preview component

14. **Add `browserActive` to StreamState** + handle `browser_active` SSE event + initial `/browser/status` check
15. **Build `BrowserPreview` component**:
    - WebSocket connection to stream endpoint
    - Canvas rendering of JPEG frames
    - Mouse/keyboard input capture and forwarding
    - Collapse/expand toggle
16. **Integrate into session view**: Show below message area when `browserActive` is true
17. **Test**: Run agent, have it open a browser, verify live preview + user interaction works

### Phase 4: Agent awareness

18. **Wire up Claude Code hooks**: PreToolUse/PostToolUse hooks that route `browser_*` tool calls to the container API endpoints
19. **Create browser skill**: Add to agent's skill directory so it knows the available browser tools
20. **Test end-to-end**: Ask agent to browse a site, verify the full flow (agent browses → user sees live → user takes over → agent resumes)

### Phase 5: Polish

21. **Browser lifecycle**: Auto-close browser when session ends / agent goes idle for too long
22. **Error handling**: Stream disconnection recovery, browser crash handling
23. **Loading states**: Show spinner while connecting to stream, handle slow frame rates gracefully
24. **Resource cleanup**: Kill Chromium when container stops (should happen naturally with container teardown)

---

## Decisions

1. **Image size strategy**: Accept the ~684MB increase. Chromium is a core capability, not optional.

2. **Browser detection**: Solved by the tool-proxy design. The container API knows the browser is active because it handles the `open` and `close` calls. It emits `browser_active` SSE events at those moments. Frontend checks `/browser/status` on initial load to sync.

3. **Multiple browsers per agent**: Single browser session per agent. One session owns the browser at a time; tool endpoints enforce this via `sessionId` validation.

4. **Persistent profiles**: Enabled by default. Profile stored at `/workspace/.browser-profile` (volume-mounted), so cookies/logins survive container restarts. User logs in once, agent reuses the session later.

5. **Streaming bandwidth**: Always stream when browser is active. This primarily runs locally so bandwidth is not a concern.
