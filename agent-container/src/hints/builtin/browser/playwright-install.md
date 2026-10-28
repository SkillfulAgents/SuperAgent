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
repeat: always
deny: true
---
Chromium is preinstalled. Launch it with `executable_path` (Python) or `executablePath` (Node) set to `/opt/playwright-browsers/chromium-current` instead of installing a browser.
