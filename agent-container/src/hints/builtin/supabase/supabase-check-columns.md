---
name: supabase-check-columns
description: Read a table's columns before writing SQL against it
triggers:
  - event: PreToolUse
    tool: mcp__supabase__execute_sql
repeat: turn
---
Don't guess column names. For a table you haven't read yet, check `information_schema.columns` first, and its constraints before an insert or update.
