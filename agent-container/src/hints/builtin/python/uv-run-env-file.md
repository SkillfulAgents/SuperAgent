---
name: uv-run-env-file
description: Reminds the agent to load /workspace/.env when running Python with uv
triggers:
  - event: PreToolUse
    match: Bash(uv run *)
---
Secrets are stored in `/workspace/.env`. Run Python scripts with `uv run --env-file .env ...` so they can read them from environment variables.
