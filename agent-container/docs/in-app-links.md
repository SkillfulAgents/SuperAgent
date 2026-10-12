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
- Some tabs are hidden for some users (the "Who sees it" column). If the tab
  is missing for this user, Settings opens on its first tab, so also name the
  tab in words. "Admins" tabs are hidden for non-admins in signed-in
  workspaces; for those, also say: "If you don't see Settings → Browser Use,
  ask a workspace admin to change it."

Quote control names exactly as written below, so the user can find them.
These are the main controls, not every field; some appear only after an
earlier choice (for example, "Headless Mode" appears only when Google Chrome is the
browser host).

| Tab ID | Settings label | Who sees it | Main controls |
|---|---|---|---|
| `general` | General | Everyone | "Appearance" (Light / Dark / System), "Timezone", "Session Auto-Delete", "API Log Auto-Delete", "Software Updates", "Include pre-release versions", "Share Anonymous Analytics", "Share Error Reports", "Setup Wizard" |
| `notifications` | Notifications | Everyone | Alerts for when an agent finishes, needs input, or a scheduled task begins; product announcements |
| `platform` | Account | Everyone | "Gamut Account" ("Connect Account"), "Subscription", "Organization credits", "Billing", "Cloud Agents" |
| `experiments` | Experiments | Everyone | On/off switches for experimental features |
| `connections` | Connections | Everyone | Connected accounts list, "Default API Request Policy", "Default MCP Tool Policy" |
| `volumes` | Volumes | Everyone | "Add volume", saved volumes list |
| `global-guidance` | Global Guidance | Everyone | "Global guidance" text given to every agent (read-only for non-admins) |
| `llm` | Model Providers | Everyone | "Provider connections" (add a provider and its key), default models, "Summarizer" |
| `voice` | Voice | Everyone | "Voice Provider", "API Key", "Default Voice", "Speed", "Hold sound in voice mode" |
| `usage` | Usage | Everyone | "Usage period", spend and token charts, "Breakdown" |
| `skillsets` | Skillsets | Admins | Add, refresh, or remove skillset repositories; "Repository token (optional)" |
| `web` | Web Search | Admins | "Web provider" (Gamut / Native / Exa / Parallel), "Exa API Key" |
| `browser` | Browser Use | Admins | "Browser Agent Model", "Max Browser Tabs", Password Managers, "Browser host" (Container (built-in) / Google Chrome / Browserbase / Platform); under Google Chrome: "Chrome Profile", "Headless Mode"; under Browserbase or Platform: "Advanced Stealth Mode", "Enable Proxies", "Operating System" |
| `computer-use` | Computer Use | Admins, local app only | "Persistent Permissions" |
| `capabilities` | Subagents | Admins | "Launch policies" for Task-tool subagents and Workflow multi-agent runs |
| `account-provider` | Account Provider | Admins | "Provider" (Composio / Nango), "Nango Secret Key" |
| `runtime` | Container Runtime | Admins | "Container Runtime" (runner), "VM Memory", "Memory Limit", "CPU Limit", "Idle Timeout", "Warm start on typing", "Auto-resume mid-turn sessions", "Agent Limits" ("Max Turns", "Max Budget (USD)", "Max Output Tokens", "Max Thinking Tokens"), "Custom Environment Variables", "Agent Image", "Data Location" |
| `audit-log` | Audit Log | Admins | Activity list filtered by user, action, and object |
| `mobile` | Mobile | Signed-in workspaces only | "Pair the mobile app", "Paired devices" |
