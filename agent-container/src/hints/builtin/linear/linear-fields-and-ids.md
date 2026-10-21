---
name: linear-fields-and-ids
description: Linear list_issues field names and issue identifiers
triggers:
  - event: PreToolUse
    tool: mcp__linear__list_issues
  - event: PreToolUse
    tool: mcp__linear__get_issue
repeat: turn
---
`list_issues` `fields` takes only the names in its schema. Issue ids are `<TEAM KEY>-<number>`: if one isn't found, check the team key with `list_teams` before trying other ids.
