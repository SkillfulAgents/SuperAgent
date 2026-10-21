---
name: customer-io-schema-first
description: Look up a Customer.io endpoint's schema before calling it
triggers:
  - event: PreToolUse
    tool: mcp__customer_io__cio_read_api
  - event: PreToolUse
    tool: mcp__customer_io__cio_write_api
repeat: turn
---
For an endpoint you haven't used yet, read it with `cio_schema` first and use its exact parameter and body names; guessed names are rejected.
