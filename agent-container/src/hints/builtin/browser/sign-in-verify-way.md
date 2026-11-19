---
name: sign-in-verify-way
description: Reminds the agent after a sign-in step that a page asking how to verify it goes through request_login's ways
triggers:
  - event: PostToolUse
    tool: mcp__user-input__request_login
repeat: turn
---
When a sign-in asks to verify it's you (a list of ways, or one way such as a passkey or a phone prompt with "Try another way": open that list first), the way is not yours to pick and not a question for `AskUserQuestion`: call `request_login` on that page with its ways in `ways` (each with its ref, the page's words and its `method`) and the username you are signing in with. The vault picks a way it holds, or the user picks one, and it is clicked for you. When the page's only way is a prompt on the user's device with nothing to click, call it with that one way and no ref: it returns once the page moves on. Don't click a way yourself, nor hand the browser over with `request_browser_input` before one was picked.
