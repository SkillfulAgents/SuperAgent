---
name: playwright-install
description: Refuses Playwright browser installs and points the agent to the preinstalled Chromium
triggers:
  - event: PreToolUse
    tool: Bash
    input:
      command: "*playwright install *"
  - event: PreToolUse
    tool: Bash
    input:
      command: "*playwright@* install *"
repeat: turn
deny: true
---
Chromium is preinstalled. Don't run `playwright install` for any browser, `chromium-headless-shell` included. Launch it with `executable_path` (Python) or `executablePath` (Node) set to `/opt/playwright-browsers/chromium-current`.
