---
name: proxy-json-body
description: The connected-account proxy rejects form-encoded request bodies
triggers:
  - event: PreToolUse
    tool: Bash
    input:
      command: "*PROXY_BASE_URL* -d *"
  - event: PreToolUse
    tool: Bash
    input:
      command: "*PROXY_BASE_URL* --data*"
  - event: PreToolUse
    tool: Bash
    input:
      command: "* -d *PROXY_BASE_URL*"
  - event: PreToolUse
    tool: Bash
    input:
      command: "* --data*PROXY_BASE_URL*"
repeat: once
---
The connected-account proxy rejects form-encoded bodies, which `curl -d` sends unless told otherwise. Send a request body as JSON with `-H 'Content-Type: application/json'`.
