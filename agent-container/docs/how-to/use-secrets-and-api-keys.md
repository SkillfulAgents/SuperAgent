---
title: How do I give the agent secrets and API keys?
description: Storing encrypted environment variables (API keys, tokens, passwords) and how the agent requests and uses them.
source_url: https://www.gamut.so/docs/using-superagent/agents/secrets
---

Secrets let you provide sensitive values -- such as API keys, tokens, and passwords -- to an agent without hardcoding them in the system prompt or session messages. Secrets are stored as environment variables in the agent's workspace and injected into the container at runtime.

## How Secrets Work

Each agent has an isolated `.env` file in its workspace directory. When the agent's container starts, all secrets defined in this file are loaded as environment variables. The agent can then access them through standard environment variable reads (e.g., `process.env.MY_API_KEY` in Node.js or `os.environ["MY_API_KEY"]` in Python).

Secrets are scoped to a single agent. Other agents cannot read or access them.

## When Agents Need Secrets

Common scenarios where you would configure secrets include:

- **Third-party API keys** -- keys for services like GitHub, Jira, Slack, or any REST API the agent needs to call.
- **Database credentials** -- connection strings or passwords for databases the agent queries.
- **Custom tool authentication** -- tokens required by skills or tools installed on the agent.
- **Service accounts** -- credentials for cloud platforms (AWS, GCP, etc.) when using direct API access rather than connected accounts.

Some skills declare **required environment variables** during installation. When you install such a skill, you will be prompted to provide the necessary secrets.

Agents can also request secrets at runtime using the **Request Secret** tool. When the agent determines it needs a credential that is not yet configured, it prompts you in the chat to provide the value.

## Managing Secrets

### Opening the Secrets Tab

1. Navigate to the agent's home page.
2. Click the gear icon to open **Settings**, then select the **Secrets** tab.

Alternatively, click **Secrets** in the Extras panel on the right side of the agent home page.

### Adding a Secret

1. In the Secrets tab, fill in the **Add New Secret** form:
   - **Key Name** -- a human-readable label (e.g., "My API Key"). This is converted to an environment variable name automatically.
   - **Value** -- the secret value. Click the eye icon to toggle visibility.
2. Review the generated environment variable name shown below the Key Name field.
3. Click **Add Secret**.

### Key Name to Environment Variable Conversion

Superagent automatically converts your human-readable key name into a valid environment variable name:

| Key Name | Environment Variable |
| ------------------- | -------------------- |
| My API Key | `MY_API_KEY` |
| github-token | `GITHUB_TOKEN` |
| Slack Bot Token | `SLACK_BOT_TOKEN` |
| db.password | `DB_PASSWORD` |

The rules are:

1. Convert to uppercase.
2. Replace any non-alphanumeric characters with underscores.
3. Trim leading and trailing underscores.
4. Collapse consecutive underscores.

Duplicate environment variable names are rejected. If you see a "(duplicate)" warning, choose a different key name.

### Updating a Secret

1. Find the secret in the **Existing Secrets** list.
2. Click **Update** next to the secret.
3. Enter the new value in the field that appears.
4. Click **Save**.

Secret values are never displayed in the UI after being saved. They are always shown as masked dots.

### Removing a Secret

1. Find the secret in the **Existing Secrets** list.
2. Click the trash icon.

The secret is removed immediately. The agent will no longer have access to this environment variable in new sessions.

## Storage Format

Secrets are persisted in a standard `.env` file inside the agent's workspace:

```bash
# Superagent Secrets
# Format: ENV_VAR=value  # Display Name

GITHUB_TOKEN=ghp_abc123  # GitHub Token
SLACK_BOT_TOKEN="xoxb-my-token"  # Slack Bot Token
DB_PASSWORD=s3cret
```

Values containing spaces, quotes, hash characters, or newlines are automatically wrapped in double quotes with proper escaping. The human-readable key name is stored as an inline comment when it differs from the environment variable name.

## Security Considerations

- Secrets are stored on disk in the agent's workspace directory. They are not encrypted at rest by Superagent itself -- rely on your operating system's disk encryption for at-rest protection.
- The **Export Full Agent** feature in Settings > General includes secrets in the exported archive. The export dialog warns about this. Only share full agent exports with trusted parties.
- The **Export as Template** feature does not include secrets. Templates are safe to share.
- In multi-user (auth mode) deployments, only agent owners can view and manage secrets.

## As the agent

- Before requesting anything, check the environment variables already available (listed at the start of the conversation) — the secret may already exist.
- Request a missing credential with `mcp__user-input__request_secret` (`secretName` in UPPER_SNAKE_CASE, e.g. `GITHUB_TOKEN`; optional `reason`). The user is prompted in the UI; on approval the value is saved to `/workspace/.env` and persists for future sessions.
- Secrets load as environment variables. In Python, always run via `uv run --env-file .env script.py` and read with `os.environ["NAME"]`; in Node, `process.env.NAME`; in shell, `$NAME`.
- For services in the connected-accounts catalog, request an account instead of a raw API key — see [connect-external-accounts-oauth](connect-external-accounts-oauth.md).
