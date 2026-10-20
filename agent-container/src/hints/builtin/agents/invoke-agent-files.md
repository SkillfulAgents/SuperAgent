---
name: invoke-agent-files
description: Sends files to other agents as attachments and avoids messaging a busy session
triggers:
  - event: PreToolUse
    tool: mcp__agents__invoke_agent
repeat: turn
---
The other agent runs in its own workspace, so a `/workspace/...` path in your prompt means nothing to it. Send files in `attachments` (at most 10 per call; put more in a zip or tar). To add to an existing session, wait until it has finished its turn (`get_agent_session_transcript` with `sync`); a session that is still running rejects new messages.
