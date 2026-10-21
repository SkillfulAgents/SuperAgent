---
name: sentry-search-no-boolean
description: Sentry issue search does not support OR/AND
triggers:
  - event: PreToolUse
    tool: mcp__sentry__search_issues
    input:
      query: "* OR *"
  - event: PreToolUse
    tool: mcp__sentry__search_issues
    input:
      query: "* AND *"
repeat: turn
---
Sentry issue search rejects `OR` and `AND` in the query. If this call fails with that error, make one call per project or value instead.
