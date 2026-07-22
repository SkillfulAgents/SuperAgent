---
title: How do I get started with my first agent?
description: Quickstart: creating an agent and running your first task.
source_url: https://www.gamut.so/docs/using-superagent/getting-started/quickstart
---

This guide walks you through creating your first agent in SuperAgent and having a conversation with it. By the end, you will have an agent running in a container, ready to take on tasks.

## 1. Open SuperAgent

Launch the desktop app or navigate to your SuperAgent server in a browser (default: `http://localhost:47891`).

On first launch, SuperAgent will check that a container runtime (Docker, OrbStack, or Podman) is available and pull the agent container image. This may take a minute or two the first time.

## 2. Configure your API key

Before creating an agent, make sure your Anthropic API key is configured. Open **Settings** (gear icon in the sidebar) and enter your key under the **API Keys** section. If the key was set via the `ANTHROPIC_API_KEY` environment variable, it will already be detected.

## 3. Create a new agent

From the main screen, you will see a text input where you can describe what you want your agent to do. This is the fastest path to creating an agent:

1. Type a prompt describing the agent's purpose -- for example, `Summarize my unread emails every morning` or `Help me manage my GitHub issues`.
2. Click **Create Agent** (or press `Cmd+Enter` / `Ctrl+Enter`).

SuperAgent automatically generates a name for the agent based on your prompt, creates the agent, and starts your first session.

Alternatively, you can create an agent from a template or import one from a skillset. These options appear below the main prompt input.

## 4. Your first conversation

Once the agent is created, you land in a chat session. Behind the scenes, SuperAgent spins up a container for the agent and sends your initial message.

You will see the agent begin working. It reads your message, thinks through the task, and uses its available tools -- running shell commands, reading and writing files, browsing the web, or calling connected services. Each tool invocation appears inline in the conversation so you can follow along.

Try sending a follow-up message to refine the task, ask a question, or give the agent additional context. The conversation works like a chat -- the agent maintains context across the entire session.

## 5. Choose a model

By default, new agents start their first session on **Claude Opus** for the strongest reasoning. You can switch models per-message using the model selector in the message composer. The available model families are:

- **Opus** -- Most capable; best for complex, multi-step tasks.
- **Sonnet** -- Balanced speed and capability; good default for everyday work.
- **Haiku** -- Fastest and most affordable; suitable for simple, high-volume tasks.

The model you select is remembered for the session, so subsequent messages continue using it unless you change it again.

## 6. Explore the agent home

When you navigate back to your agent (click its name in the sidebar), you land on the **Agent Home** page. From here you can:

- **Start a new session** -- Type a new prompt to begin a fresh conversation.
- **Review past sessions** -- All previous sessions are listed with timestamps and summaries.
- **View dashboards** -- If the agent has created any dashboards, they appear as cards.
- **Check scheduled tasks** -- Any recurring or future tasks the agent has set up.
- **Manage connections** -- See which connected accounts and MCP servers are available to the agent.

## 7. Configure agent settings

Click the **Settings** icon on the agent home page to access agent-level configuration:

- **General** -- Rename the agent, export it, or delete it.
- **Secrets** -- Add environment variables (API keys, tokens) that are injected into the agent's container.
- **Agents** -- Control which other agents in your workspace this agent is allowed to invoke (multi-agent policies).

## What to try next

- **Connect an account** -- Go to the global [Connected Accounts](https://www.gamut.so/docs/using-superagent/integrations/connected-accounts) settings and link a service like Gmail, Slack, or GitHub. Then [map it to your agent](https://www.gamut.so/docs/using-superagent/integrations/mapping-accounts-to-agents) so it can act on your behalf.
- **Schedule a task** -- Ask the agent to perform a task on a recurring schedule. It will use the built-in scheduling tool to set up a cron job. See [Scheduled Tasks](https://www.gamut.so/docs/using-superagent/automation/scheduled-tasks).
- **Build a dashboard** -- Ask the agent to create an interactive dashboard for you. See [Dashboards](https://www.gamut.so/docs/using-superagent/apps/dashboards).
- **Install a skillset** -- Browse and install community skillsets to give your agent pre-built capabilities. See [Skillsets](https://www.gamut.so/docs/using-superagent/skillsets/overview).
- **Read the core concepts** -- Understand the [key abstractions](https://www.gamut.so/docs/using-superagent/getting-started/core-concepts) behind agents, sessions, containers, and tools.
