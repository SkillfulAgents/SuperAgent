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
The platform can transcribe audio for you: read `/opt/gamut/docs/audio.md` and use it instead of a local Whisper model.
