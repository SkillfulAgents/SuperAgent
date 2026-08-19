---
title: How does the agent browse the web?
description: Browser options: the built-in container browser, Chrome integration, and Browserbase; logins, CAPTCHAs, and downloads.
source_url:
  - https://www.gamut.so/docs/using-superagent/browser-use/overview
  - https://www.gamut.so/docs/using-superagent/browser-use/built-in-browser
  - https://www.gamut.so/docs/using-superagent/browser-use/chrome-integration
  - https://www.gamut.so/docs/using-superagent/browser-use/browserbase
---

## Browser Use Overview

Superagent agents can control a full web browser to perform tasks that require interacting with websites. An agent can navigate to pages, click buttons, fill out forms, extract data, take screenshots, and run JavaScript -- all while you watch in real time through the browser panel in the Superagent UI.

### What Browser Use Enables

With browser access, your agents can:

- **Navigate the web** -- open URLs, follow links, search engines, and browse multi-page workflows.
- **Interact with web apps** -- click buttons, fill forms, select dropdowns, upload files, and submit data.
- **Extract information** -- read page content through accessibility snapshots, take screenshots, and run JavaScript to pull structured data.
- **Handle multi-step flows** -- complete checkout processes, fill multi-page forms, and navigate authenticated dashboards.
- **Request your help when needed** -- pause and ask you to log in, solve a CAPTCHA, or complete a 2FA challenge, then resume automatically.

### The Three Browser Options

Superagent offers three browser hosts. You choose which one to use in **Settings > Browser**.

| Browser Host | Description | Best For |
|---|---|---|
| **Built-in Browser** | A headless Chromium browser that runs inside the agent's container. Works out of the box with zero configuration. | Quick tasks, web scraping, form automation, testing. |
| **Google Chrome** | Connects to your local Chrome installation and can use your existing profiles, cookies, and logged-in sessions. | Tasks that need access to your authenticated accounts without re-logging in. |
| **Browserbase** | A cloud browser service that runs sessions on remote infrastructure with anti-detection and proxy support. | Scalable automation, avoiding IP blocks, stealth browsing. |

The default is the built-in browser. You can change the browser host at any time, and the change applies to all new browser sessions.

### When to Use Browser Automation

Browser automation is useful when your agent needs to interact with a website that does not offer an API, or when the task is inherently visual. Common scenarios include:

- Researching information across multiple websites.
- Filling out web forms on behalf of a user.
- Monitoring a web page for changes.
- Extracting data from sites that only render content in a browser.
- Testing a web application's user interface.
- Navigating internal tools that require authentication.

If a service provides a dedicated API or MCP integration, prefer that over browser automation -- APIs are faster, more reliable, and less fragile than UI-based interaction.

### The Browser Panel

When an agent opens a browser, a panel slides open on the right side of the chat interface. This panel provides a live view of what the agent sees and lets you interact directly.

#### Live Preview

The browser panel renders a real-time screencast of the browser viewport. Frames are streamed over a WebSocket connection and drawn to a canvas element, so you see exactly what the agent sees with minimal delay. The preview automatically scales to fit the panel width while preserving the browser's aspect ratio.

#### Tab Bar

When the agent has multiple tabs open, a tab bar appears at the top of the browser panel. Each tab shows its title, and the agent's currently active tab is marked with a blue indicator dot. You can:

- **Click a tab** to switch the preview to that tab.
- **Right-click a tab** to close it (except the agent's active tab).
- **Toggle auto-follow** using the eye icon -- when enabled, the preview automatically switches to whichever tab the agent is working in.

#### Activity Log

Below the browser preview is an activity log that lists every browser tool call the agent has made in the current session. Each entry shows the tool name (such as "Click", "Fill Input", or "Screenshot") along with a brief summary of its parameters. You can expand any entry to see the full result text. This log is useful for understanding what the agent did and debugging any issues.

#### Controls

A floating control pill at the bottom of the browser panel provides:

- **Pause / Resume** -- temporarily pause the agent's execution, interact with the browser yourself, then resume.
- **Stop** -- close the browser entirely. If the agent is actively running, you will see a confirmation dialog.
- **Expand / Collapse** -- widen the browser panel for a larger preview, or shrink it back to the default width.

#### Human-in-the-Loop Input

Some actions require your direct involvement -- logging into a site, solving a CAPTCHA, or completing two-factor authentication. When the agent encounters one of these, it calls the `request_browser_input` tool, which:

1. Shows an overlay on the browser preview with a pulsing "Your input needed" indicator.
2. Displays a message card in the chat explaining what the agent needs you to do.
3. Pauses the agent until you click **Done** (after completing the task in the browser) or **Dismiss** (to skip and continue the conversation).

This workflow means the agent can handle most of a browsing task autonomously and only involve you for the steps that truly require a human.

#### Resizable Panel

You can drag the left edge of the browser panel to resize it. The width is remembered across sessions. The minimum width is 320px and the maximum is 800px.

## Built-in Browser

The built-in browser is a headless Chromium instance that runs inside the agent's container. It is the default browser host and requires no setup -- every agent can use it immediately.

### How It Works

When an agent calls `browser_open`, Superagent launches a Chromium process inside the agent's container and connects to it via the Chrome DevTools Protocol (CDP). The browser runs headlessly (no visible window), but you can watch the agent's activity in real time through the browser panel in the Superagent UI.

The built-in browser:

- **Requires no configuration.** It is available to every agent out of the box.
- **Runs in an isolated container.** Each agent gets its own browser instance with its own profile directory.
- **Preserves cookies and sessions.** The browser uses a persistent profile, so sites remember the agent's login state across sessions.
- **Supports multiple tabs.** Agents can open, switch between, and close tabs. The maximum number of concurrent tabs is configurable in Settings (default: 10).

### Browser Tools

Agents interact with the browser through a set of MCP tools exposed by the `browser` MCP server. These tools are available automatically whenever an agent has browser access enabled.

#### Navigation and Lifecycle

| Tool | Description |
|---|---|
| `browser_open` | Open the browser and navigate to a URL. If a tab with the same URL already exists, switches to it instead of opening a duplicate. |
| `browser_close` | Close the browser and free all resources. Call this when browsing is complete. |

#### Page Inspection

| Tool | Description |
|---|---|
| `browser_snapshot` | Get an accessibility tree snapshot of the current page. Returns interactive elements with refs (like `@e1`, `@e2`) that can be used with other tools. Supports `interactive`, `compact`, and `json` modes. |
| `browser_screenshot` | Take a screenshot of the current viewport or the full scrollable page. Optionally annotate the screenshot with numbered labels on interactive elements that correspond to snapshot refs. |
| `browser_get_state` | Get the current URL, a screenshot, and an accessibility snapshot in a single call. Useful for quickly understanding what the browser is showing. |

#### Interaction

| Tool | Description |
|---|---|
| `browser_click` | Click an element by its ref (e.g., `@e1`). Refs come from `browser_snapshot`. |
| `browser_fill` | Clear an input field and type a new value into it, identified by ref. |
| `browser_select` | Select an option from a `<select>` dropdown by ref and value. |
| `browser_hover` | Hover over an element to trigger menus, tooltips, or hover states. |
| `browser_press` | Press a keyboard key such as `Enter`, `Tab`, `Escape`, or a key combo like `Control+a`. |
| `browser_scroll` | Scroll the page in a given direction (`up`, `down`, `left`, `right`) by an optional pixel amount. |
| `browser_upload` | Upload a local file to a `<input type="file">` element using a CSS selector. |
| `browser_wait` | Wait for a CSS selector to appear on the page before continuing. |

#### Advanced Operations

| Tool | Description |
|---|---|
| `browser_run` | Run any `agent-browser` CLI command for advanced operations not covered by the dedicated tools. |

The `browser_run` tool is a catch-all that exposes the full `agent-browser` command set. Some of the commands available through it include:

- **Navigation** -- `back`, `forward`, `reload`
- **Tab management** -- `tab`, `tab new`, `tab <n>`, `tab close`
- **JavaScript execution** -- `eval <js>` to run arbitrary JavaScript in the page context
- **Element queries** -- `get text/html/value/attr/title/url/count/box <ref>`
- **State checks** -- `is visible/enabled/checked <ref>`
- **Cookie and storage management** -- `cookies`, `cookies set/clear`, `storage local/session`
- **Frame switching** -- `frame <selector>`, `frame main`
- **Dialog handling** -- `dialog accept`, `dialog dismiss`
- **Browser settings** -- `set viewport/device/geo/offline/headers/media`
- **Network interception** -- `network route/unroute/requests`
- **Drag and drop** -- `drag <srcRef> <tgtRef>`
- **Double-click, focus, type** -- `dblclick`, `focus`, `type`

### Screenshots and Snapshots

Agents have two complementary ways to understand what is on the page:

**Screenshots** capture a visual image of the browser viewport (or the full scrollable page). They are returned as images that the model can see directly. Annotated screenshots overlay numbered labels on interactive elements, making it easy for the agent to visually identify what to click. Each label `[N]` corresponds to ref `@eN` from the accessibility snapshot.

**Accessibility snapshots** return a structured text representation of the page's interactive elements. Each element gets a ref like `@e1` that the agent uses with `browser_click`, `browser_fill`, and other interaction tools. Snapshots are more compact than screenshots and work well for form-heavy pages where the agent needs to identify specific input fields.

In practice, agents typically use `browser_snapshot` for most interactions and fall back to `browser_screenshot` when they need to understand the visual layout or debug rendering issues.

### JavaScript Execution

Agents can execute arbitrary JavaScript in the browser page context using `browser_run` with the `eval` command:

```
browser_run({ command: 'eval document.title' })
browser_run({ command: 'eval JSON.stringify(Array.from(document.querySelectorAll("table tr")).map(r => r.textContent))' })
```

This is useful for extracting data that is not easily accessible through the accessibility snapshot, or for triggering client-side behavior.

### Human-in-the-Loop

When the agent encounters an obstacle that requires human interaction -- such as a login page, CAPTCHA, or 2FA prompt -- it calls the `request_browser_input` tool. This pauses the agent, shows you the browser preview with an "input needed" overlay, and waits until you complete the action and click **Done**. After you finish, the agent takes a fresh snapshot and continues from the new page state.

### Common Use Cases

- **Web scraping** -- navigate to a site, extract structured data from tables or lists, and compile it into a report.
- **Form automation** -- fill out multi-step forms, upload documents, and submit applications.
- **Web app testing** -- open a URL, interact with UI elements, take screenshots, and verify expected behavior.
- **Research** -- search across multiple sites, read articles, and synthesize findings.
- **Account management** -- check dashboards, update settings, and download reports from web-based tools (after you log in for the agent).

### Limitations

- The built-in browser runs inside the container and does not have access to your local filesystem, extensions, or saved passwords. If you need authenticated access, consider using [Chrome Integration](https://www.gamut.so/docs/using-superagent/browser-use/chrome-integration) instead.
- Some websites employ bot detection that may block headless browsers. For sites with aggressive anti-bot measures, consider [Browserbase](https://www.gamut.so/docs/using-superagent/browser-use/browserbase) which offers stealth mode and residential proxies.
- The browser cannot access `localhost` URLs from the host machine, since it runs in an isolated container.

## Chrome Integration

Chrome integration lets your agents use your local Google Chrome browser instead of the built-in headless browser. This means agents can access websites where you are already logged in, using your existing cookies, saved passwords, and session data -- without needing to re-authenticate.

### When to Use Chrome Integration

Choose Chrome integration when:

- **You need authenticated access.** The agent needs to interact with a site where you are already logged in (email, internal tools, banking, SaaS dashboards), and you do not want to re-enter credentials.
- **You want to use your existing browser profile.** Your Chrome profile has specific cookies, local storage data, or extensions that the task requires.
- **You need to watch in real time.** Chrome opens a visible browser window on your machine (unless headless mode is enabled), so you can see exactly what the agent is doing alongside the in-app browser panel.

If the task does not require authenticated sessions or existing profile data, the [built-in browser](https://www.gamut.so/docs/using-superagent/browser-use/built-in-browser) is simpler and does not require Chrome to be installed.

### How It Works

When Chrome integration is selected and an agent opens the browser, Superagent:

1. **Detects your local Chrome installation.** Superagent looks for Chrome in standard installation paths on macOS, Windows, and Linux.
2. **Copies your selected profile's session data** (cookies, login data, local storage, session storage) into a dedicated working directory the first time it launches. Subsequent launches reuse this copy so the agent can accumulate its own session state without affecting your real Chrome profile.
3. **Launches Chrome with remote debugging enabled**, connecting via the Chrome DevTools Protocol (CDP). On macOS, Chrome is launched in the background so it does not steal focus from your current application.
4. **Streams the browser to the Superagent UI** so you can watch and interact through the browser panel, exactly as with the built-in browser.

The agent uses the same set of browser tools (`browser_open`, `browser_click`, `browser_fill`, and so on) regardless of which browser host is selected. Switching from the built-in browser to Chrome does not require any changes to your agent's instructions.

### Selecting a Chrome Profile

Chrome supports multiple user profiles, and Superagent can use any of them. When Chrome is detected, the settings page shows a profile selector populated from your Chrome installation's `Local State` file.

To select a profile:

1. Open **Settings > Browser**.
2. Set **Browser Host** to **Google Chrome**.
3. In the **Chrome Profile** dropdown, choose the profile you want agents to use. Each profile shows the display name and associated email address (if signed in).
4. Select **None** to use a fresh profile with no pre-existing session data.

Profile data is copied on first launch for each agent. After the initial copy, the agent maintains its own working profile directory. This means:

- Changes the agent makes (new cookies, storage entries) are isolated from your real Chrome profile.
- If you update your Chrome password or log out of a site, the agent's copy is not automatically updated. You may need to log in again through the agent's browser session, or delete the agent's browser data to trigger a fresh copy.

### Headless Mode

By default, Chrome integration opens a visible browser window on your machine. If you prefer Chrome to run without a visible window (for example, to prevent it from stealing focus while the agent browses), enable **Headless Mode** in the browser settings.

With headless mode enabled:

- Chrome runs invisibly in the background.
- The browser panel in the Superagent UI still shows the live preview.
- A realistic user-agent string is set automatically to reduce detection by websites that block headless browsers.
- The viewport is set to 1920x1080 for consistent rendering.

### Platform Support

Chrome integration works on all three platforms:

| Platform | Chrome Detection Paths |
|---|---|
| **macOS** | `/Applications/Google Chrome.app` and `~/Applications/Google Chrome.app` |
| **Linux** | `/usr/bin/google-chrome`, `/usr/bin/chromium-browser`, `/usr/bin/google-chrome-stable`, `/usr/bin/chromium`, `/opt/google/chrome/chrome`, snap installations |
| **Windows** | `C:\Program Files\Google\Chrome\Application\chrome.exe`, `%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe`, `C:\Program Files (x86)\...` |

If Chrome is not found at any of these paths, the Chrome option will appear disabled in the settings with the message "Chrome not found on this system".

### Downloads

When using Chrome integration, files downloaded by the browser are saved to a dedicated downloads directory for the agent, separate from your personal Downloads folder. This keeps agent-downloaded files organized and prevents them from mixing with your own downloads.

### Limitations and Security Considerations

- **Profile data is copied, not shared.** The agent works with a copy of your profile data. It cannot see changes you make to your real Chrome profile after the initial copy, and your real profile is not affected by the agent's activity.
- **Sensitive data exposure.** When you select a Chrome profile, the agent gains access to that profile's cookies and login sessions. Only select profiles whose sessions you are comfortable sharing with the agent.
- **One browser per agent.** Each agent instance gets its own Chrome process and working directory. Multiple agents can use Chrome simultaneously, each with their own isolated instance.
- **External close detection.** If you manually close the Chrome window that Superagent launched, the system detects this and notifies both the UI (the browser panel disappears) and the agent's container (so it can clean up its internal state).
- **Stale lock files.** If Chrome crashes, Superagent automatically cleans up lock files (`SingletonLock`, `SingletonSocket`, `SingletonCookie`) on the next launch so the browser can start cleanly.

## Browserbase

Browserbase is a cloud browser service that runs browser sessions on remote infrastructure. Superagent integrates with Browserbase as an alternative browser host, giving your agents access to anti-detection features, residential proxies, and persistent browser contexts without running Chrome locally.

### When to Use Browserbase

Choose Browserbase when:

- **You need stealth browsing.** Browserbase offers an advanced stealth mode with a custom Chromium build designed to avoid bot detection on sites that block standard headless browsers.
- **You need residential proxies.** Route traffic through residential IP addresses to reduce CAPTCHA challenges and avoid IP-based rate limiting. Proxies can be geo-targeted to specific countries, states, or cities.
- **You want persistent sessions across agents.** Browserbase contexts persist cookies and storage across sessions, so an agent can resume where it left off.
- **You are running Superagent on a server.** On headless servers where Chrome is not installed, Browserbase provides browser access without local dependencies.

For straightforward browsing tasks on sites without aggressive bot detection, the [built-in browser](https://www.gamut.so/docs/using-superagent/browser-use/built-in-browser) is simpler and has no additional cost. For tasks that need access to your local Chrome profiles and cookies, use [Chrome integration](https://www.gamut.so/docs/using-superagent/browser-use/chrome-integration) instead.

### Setup

Browserbase is available through two paths: bringing your own Browserbase account, or using the Platform-managed option.

#### Bring Your Own Account

1. Sign up at [browserbase.com](https://www.browserbase.com) and create a project.
2. Open **Settings > Browser** in Superagent.
3. Set **Browser Host** to **Browserbase**.
4. Enter your **API Key** and **Project ID** in the fields that appear.
5. Click **Connect**. Superagent validates the credentials against the Browserbase API before saving them.

Once validated, a green "Credentials saved" badge appears. You can update or remove saved credentials at any time.

Credentials can also be provided via environment variables instead of the settings UI. Superagent checks for:

- `BROWSERBASE_API_KEY`
- `BROWSERBASE_PROJECT_ID`

Environment variables take effect without needing to enter credentials in the UI. The settings page shows "Using environment variable" when this is the case.

#### Platform-Managed

If you are signed in to a Superagent Platform account, the **Platform** browser host option is available. This uses Browserbase through the Platform's managed proxy, so you do not need to configure API keys separately. Your Platform subscription covers the browser session costs.

The Platform option supports the same session settings (stealth mode, proxies) as the bring-your-own-account option.

### Session Settings

Both Browserbase and Platform-managed browser hosts support the following session settings, configurable in **Settings > Browser**.

#### Advanced Stealth Mode

When enabled, Browserbase uses a custom Chromium browser with modifications to avoid common bot detection techniques. This makes the browser appear more like a regular user's browser to anti-bot services.

You can optionally select an **Operating System** to emulate. This changes the user-agent string and browser environment signals to match the selected platform:

| Option | Effect |
|---|---|
| **Default (auto)** | Browserbase chooses automatically. |
| **Linux** | Linux user-agent and environment signals. |
| **Windows** | Windows user-agent and environment signals. |
| **macOS** | macOS user-agent and environment signals. |
| **Mobile** | Mobile device user-agent and environment signals. |
| **Tablet** | Tablet device user-agent and environment signals. |

Advanced stealth mode requires a Browserbase Scale plan.

#### Proxy Configuration

When proxies are enabled, browser traffic is routed through Browserbase's residential proxy network. This helps with:

- Avoiding IP-based rate limiting and blocks.
- Higher CAPTCHA success rates.
- Accessing geo-restricted content.

You can optionally specify a proxy location:

| Field | Format | Example |
|---|---|---|
| **Country Code** | Two-letter ISO code | `US` |
| **State** | Two-letter state code | `NY` |
| **City** | City name in uppercase | `NEW_YORK` |

Leave all location fields empty to use Browserbase's default (best-effort US proxy).

### Persistent Contexts

Browserbase sessions use persistent contexts that are tied to each agent. A context preserves cookies, local storage, and session storage across browser sessions. This means:

- If an agent logs into a website in one session, it remains logged in the next time it opens the browser.
- Each agent gets its own context, so agents do not share session data with each other.
- Contexts are stored in Browserbase's infrastructure and persist until you delete them.

The context mapping is saved locally so Superagent can reuse the same Browserbase context for each agent across multiple sessions.

### How It Works

When an agent opens the browser with Browserbase selected:

1. Superagent creates (or reuses) a Browserbase context for the agent.
2. A new Browserbase session is created with `keepAlive` enabled, so the session survives temporary disconnections.
3. Superagent connects to the session via its debug WebSocket URL, which supports multiple simultaneous connections (unlike the single-use connect URL).
4. The browser panel in the Superagent UI streams frames from the remote browser, just as it does for local browsers.

If an existing session is still running when the agent opens the browser again, Superagent reuses it instead of creating a new one.

### Tradeoffs vs. the Built-in Browser

| Aspect | Built-in Browser | Browserbase |
|---|---|---|
| **Setup** | None -- works out of the box. | Requires a Browserbase account or Platform subscription. |
| **Cost** | Free (included with Superagent). | Browserbase charges per session minute. |
| **Bot detection** | Standard headless Chromium; may be blocked by some sites. | Advanced stealth mode with custom Chromium build. |
| **Proxies** | No proxy support. | Residential proxies with geo-targeting. |
| **Latency** | Low -- browser runs locally in the container. | Higher -- browser runs on remote infrastructure with network overhead. |
| **Local access** | Cannot access host `localhost`. | Cannot access your local network. |
| **Persistent state** | Profile persists within the container. | Context persists in Browserbase's cloud across sessions. |
| **Dependencies** | None. | Network connection to Browserbase API and WebSocket endpoints. |

### Troubleshooting

- **"API key not configured"** -- Make sure you have entered both the API key and project ID in Settings, or set the corresponding environment variables.
- **"Failed to create Browserbase session"** -- Check that your API key is valid, your Browserbase project exists, and your account has available session capacity.
- **Stealth mode not working** -- Advanced stealth mode requires a Browserbase Scale plan. Check your Browserbase account tier.
- **Proxy location not taking effect** -- Verify that the country code is a valid two-letter ISO code and that Browserbase has proxy coverage in the requested location.
