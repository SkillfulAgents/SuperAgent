---
title: How do I create and configure agents?
description: Creating agents and configuring their name, instructions, model, and settings.
source_url: https://www.gamut.so/docs/using-superagent/agents/creating-and-configuring
---

Agents are the core building blocks of Superagent. Each agent is an autonomous AI assistant that runs inside its own container, with its own system prompt, secrets, files, and session history.

## Creating an Agent

There are three ways to create a new agent.

### From a Prompt

The fastest way is to type a prompt directly into the creation form. Superagent will automatically derive a name from your prompt, create the agent, and start a first session with your message.

1. Open the "Create Agent" view.
2. Type a description of what you want the agent to do (e.g., "Monitor my GitHub PRs and summarize them daily").
3. Click **Create Agent** or press `Cmd+Enter` / `Ctrl+Enter`.

The first session of a brand-new agent defaults to the **Opus** model for the strongest initial performance. You can change the model for subsequent sessions.

### From a Template

Templates are pre-built agent configurations shared through [Skillsets](https://www.gamut.so/docs/using-superagent/skillsets). When you install a template, Superagent creates a new agent with pre-configured instructions, skills, and optionally an onboarding session that walks you through setup.

1. Click **Browse Templates** in the creation aids section.
2. Select a template and follow the install dialog.

### From an Import

You can import an agent from a previously exported `.zip` file. This restores the full agent workspace, including instructions, skills, and optionally secrets.

## Agent Name and Description

Every agent has a **name** and an optional **description**. The name is shown in the sidebar and used to identify the agent throughout the UI.

- **Name** -- displayed in the sidebar, agent home, and session headers. You can rename an agent at any time by clicking the name on the agent home page or editing it in Settings > General.
- **Description** -- stored in the `CLAUDE.md` frontmatter. Provides a short summary of what the agent does.

## System Prompt

The system prompt defines how the agent behaves. It is stored as the body of a `CLAUDE.md` file in the agent's workspace directory. The format is standard Markdown, and the default template looks like this:

```markdown
# Agent Instructions

You are a helpful AI assistant.

## Preferences

<!-- Add your preferences here -- the agent will also append what it learns -->

## Project Notes

<!-- Add project context here -- the agent will also add notes as it learns -->
```

To edit the system prompt:

1. Open the agent home page.
2. Click **System Prompt** in the Extras panel on the right, or open **Settings** and select the system prompt view.
3. Edit the Markdown content in the dialog.
4. Click **Save**.

The system prompt is appended to the default Claude Code system prompt. You can use it to specify the agent's personality, domain knowledge, preferred tools, coding standards, or any behavioral rules.

## Model Selection

Each message you send can target a specific model family. The model selector appears in the composer toolbar next to the effort selector. The available models are:

| Model | Description |
| ------------- | ------------------------------------------------- |
| **Opus 4.7** | Most capable. Best for complex, long-horizon work. |
| **Sonnet 4.6** | Balanced speed and capability. |
| **Haiku 4.5** | Fastest and cheapest. Good for quick or simple tasks. |

The first session of a new agent defaults to Opus. After that, Superagent remembers the model you last used per session and seeds the selector accordingly. You can also set a default model in the app-wide settings, which is used as the fallback when no prior session context exists.

## Effort Level

The effort level controls how much thinking the agent does before responding. It is selected per message alongside the model:

| Level | Description |
| -------------- | -------------------------------------------- |
| **Low** | Fastest. Minimal thinking, terse answers. |
| **Medium** | Balanced thinking and response depth. |
| **High** | Default. Thorough planning and explanations. |
| **Extra High** | Deep reasoning for long-horizon work (Opus only). |
| **Max** | Highest effort (Opus only). |

Extra High and Max are only available when the Opus model is selected. If you switch to a model that does not support the current effort level, it automatically resets to High.

## Settings Dialog

Open agent settings by clicking the gear icon on the agent home page. The settings dialog has several tabs:

### General

- **Agent Name** -- rename the agent.
- **Template Status** -- if the agent was installed from a skillset template, shows whether it is up to date, locally modified, or has updates available. You can force-sync, submit changes back to the skillset, or publish as a new template.
- **Export** -- export the agent as a shareable template (instructions and skills only) or as a full agent archive (includes secrets and workspace data).
- **Session Auto-Delete** -- override the app-wide auto-delete policy for this agent. Inactive sessions older than the configured number of days are automatically removed. Starred sessions are always preserved.
- **Danger Zone** -- permanently delete the agent and all its data.

### Secrets

Manage encrypted environment variables that are injected into the agent's container. See [Secrets](https://www.gamut.so/docs/using-superagent/agents/secrets) for details.

### Agents (Cross-Agent Policies)

Configure policies for how other agents can invoke this agent using the multi-agent tool. See [Multi-Agent](https://www.gamut.so/docs/using-superagent/multi-agent) for details.

### Access (Auth Mode Only)

When running Superagent with authentication enabled, the Access tab lets owners manage role-based permissions. Agents support three roles:

- **Owner** -- full control, including settings, secrets, and deletion.
- **User** -- can create sessions and send messages.
- **Viewer** -- read-only access to view session history.

## Agent Home Page

The agent home page is the central hub for interacting with an agent. It includes:

- **Composer** -- type a message to start a new session. Supports file attachments, voice input, and drag-and-drop.
- **Sessions list** -- all past sessions, sortable by newest or oldest, with search filtering. See [Sessions](https://www.gamut.so/docs/using-superagent/agents/sessions).
- **Bookmarks** -- links and files pinned by the agent during conversations.
- **Triggers** -- scheduled tasks and webhook triggers for automation. See [Automation](https://www.gamut.so/docs/using-superagent/automation).
- **Connections** -- connected OAuth accounts for external services. See [Integrations](https://www.gamut.so/docs/using-superagent/integrations).
- **Skills** -- installed skill extensions.
- **Volumes** -- mounted host folders. See [Volumes and Mounts](https://www.gamut.so/docs/using-superagent/agents/volumes-and-mounts).
