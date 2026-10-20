---
name: create-rule
description: Gets proxy rules right on the first submit instead of resubmitting failing drafts
triggers:
  - event: PreToolUse
    tool: mcp__rules__create_api_rule
  - event: PreToolUse
    tool: mcp__rules__create_mcp_rule
repeat: turn
---
Before you submit a rule, check the three things that reject most drafts:
1. Every test input must match one of your patterns. For an API rule, set `method` and `path` in each test (unset fields default to a request your patterns don't match); for an MCP rule, set `tool`.
2. The host also sends your code requests with an empty body and with `{}`. Return false (review) whenever a field you need is missing or malformed.
3. A require rule only holds what its patterns match. Cover every endpoint or tool that does the same action, not just the one you used.
If the host rejects the draft, change exactly what its errors list before submitting again. After two rejections in a row, stop and tell the user what is blocking the rule.
