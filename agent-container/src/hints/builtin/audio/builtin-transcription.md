---
name: builtin-transcription
description: Points the agent to built-in audio transcription when it sets up a local Whisper model
triggers:
  - event: PreToolUse
    tool: Bash
    input:
      command: "*faster-whisper*"
  - event: PreToolUse
    tool: Bash
    input:
      command: "*faster_whisper*"
  - event: PreToolUse
    tool: Bash
    input:
      command: "*openai-whisper*"
  - event: PreToolUse
    tool: Bash
    input:
      command: whisper *
repeat: turn
requires: platform
---
The platform can transcribe audio for you (see "Built-in audio" in the system prompt): read `/opt/gamut/docs/audio.md` and use it instead of a local Whisper model. It needs no model download and no container CPU, and it is metered per audio minute. A local model is still fine when the user wants it.
