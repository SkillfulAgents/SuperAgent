---
name: sign-in-verify-way
description: Reminds the agent after a sign-in step that the way to verify it is the user's to choose
triggers:
  - event: PostToolUse
    tool: mcp__user-input__request_login
repeat: turn
---
When a sign-in asks to verify it's you and offers more than one way (a list of ways, or one way such as a passkey or a phone prompt with "Try another way"), the way is the user's to choose: open that list, ask with `AskUserQuestion`, one option per way in the page's words, and click the one picked (a web-browser subagent reports the ways to its parent instead). Don't hand the browser over with `request_browser_input` before the user picked.
