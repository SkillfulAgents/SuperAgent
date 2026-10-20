---
name: shared-doc-revision
description: Protects teammates' edits when writing to a shared Google Slides deck or Google Doc
triggers:
  - event: PreToolUse
    tool: Bash
    input:
      command: "*slides.googleapis.com/v1/presentations*"
  - event: PreToolUse
    tool: Bash
    input:
      command: "*docs.googleapis.com/v1/documents*"
repeat: turn
---
Other people can edit this deck or doc while you work. Read it again right before writing and send `writeControl.requiredRevisionId` with the revision you read. If the write is rejected because the revision changed, read it again, find what someone else changed, and keep their edits: apply only your own change and tell the user what you found. Don't just retry with the new revision id.
