# In-App Settings Links

When the fix for a user's problem is a setting they change themselves, link
straight to the right Settings tab instead of describing the menu path. In the
app's chat, a Markdown link to `/settings/<tab>` opens Settings on that tab.

```markdown
Browser use is turned off for this workspace. [Open Browser Use settings](/settings/browser)
```

Rules:

- Write the path exactly as `/settings/<tab>`, using a tab ID from the table
  below. No host, no query string, no trailing slash. Any other path is treated
  as a normal web link.
- The link only opens Settings. You cannot change settings yourself, so tell
  the user what to change once they are there.
- Links work only in the app's chat. In Slack, email, Telegram, or other chat
  integrations, name the place in words instead, e.g. "Settings → Browser Use".
- Some tabs exist only for admins or only in some setups (marked below). If the
  tab is missing for this user, Settings opens on its first tab, so also name
  the tab in words.

Quote control names exactly as written below, so the user can find them.
These are the main controls, not every field; some appear only after an
earlier choice (for example, Browserbase fields appear only when Browserbase is
the browser host).

| Tab ID | Settings label | Main controls |
|---|---|---|
| `general` | General | "Appearance" (Light / Dark / System), "Timezone", "Session Auto-Delete", "API Log Auto-Delete", "Software Updates", "Include pre-release versions", "Share Anonymous Analytics", "Share Error Reports", "Setup Wizard" |
| `notifications` | Notifications | Alerts for when an agent finishes, needs input, or a scheduled task begins; product announcements |
| `platform` | Account | "Gamut Account" ("Connect Account"), "Subscription", "Organization credits", "Billing", "Cloud Agents" |
| `experiments` | Experiments | On/off switches for experimental features |
| `connections` | Connections | Connected accounts list, "Default API Request Policy", "Default MCP Tool Policy" |
| `volumes` | Volumes | "Add volume", saved volumes list |
| `global-guidance` | Global Guidance | "Global guidance" text given to every agent (read-only for non-admins) |
| `llm` | Model Providers | "Provider connections" (add a provider and its key), default models, "Summarizer" |
| `voice` | Voice | "Voice Provider", "API Key", "Default Voice", "Speed", "Hold sound in voice mode" |
| `usage` | Usage | "Usage period", spend and token charts, "Breakdown" |
| `skillsets` | Skillsets | Add, refresh, or remove skillset repositories; "Repository token (optional)" (admin) |
| `web` | Web Search | "Web provider" (Gamut / Native / Exa / Parallel), "Exa API Key" (admin) |
| `browser` | Browser Use | "Browser host" (container built-in, Chrome profile, or Browserbase), "Headless Mode", "Max Browser Tabs", "Browser Agent Model"; Browserbase: "API Key", "Project ID", "Enable Proxies", "Advanced Stealth Mode", "Operating System" (admin) |
| `computer-use` | Computer Use | "Persistent Permissions" (admin, local app only) |
| `capabilities` | Subagents | "Launch policies" for Task-tool subagents and Workflow multi-agent runs (admin) |
| `account-provider` | Account Provider | "Provider" (Composio / Nango), "Nango Secret Key" (admin) |
| `runtime` | Container Runtime | "Container Runtime" (runner), "VM Memory", "Memory Limit", "CPU Limit", "Idle Timeout", "Warm start on typing", "Auto-resume mid-turn sessions", "Agent Limits" ("Max Turns", "Max Budget (USD)", "Max Output Tokens", "Max Thinking Tokens"), "Custom Environment Variables", "Agent Image", "Data Location" (admin) |
| `audit-log` | Audit Log | Activity list filtered by user, action, and object (admin) |
| `mobile` | Mobile | "Pair the mobile app", "Paired devices" (signed-in workspaces only) |
