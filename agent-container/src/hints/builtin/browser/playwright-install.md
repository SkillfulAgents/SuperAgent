---
name: playwright-install
description: Refuses Playwright browser installs and points the agent to the preinstalled Chromium
triggers:
  - event: PreToolUse
    tool: Bash
    input:
      command: "*playwright* install *"
repeat: turn
deny: true
---
Chromium is preinstalled at `/opt/playwright-browsers/chromium-current`. Launch it with `executable_path` (Python) or `executablePath` (Node) set to that path instead of downloading a browser. If you need a browser that is not preinstalled (for example Firefox or WebKit), run the same command again; it will run.
