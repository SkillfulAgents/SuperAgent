---
title: What is Gamut and how does it work?
description: Product introduction and core concepts: agents, sessions, workspaces, and how the pieces fit together.
source_url:
  - https://www.gamut.so/docs/using-superagent/getting-started/introduction
  - https://www.gamut.so/docs/using-superagent/getting-started/core-concepts
---

## What is SuperAgent

SuperAgent is a platform for building and running personal AI agents. You create agents, give them instructions, connect them to your accounts, and let them work autonomously in the background -- inside secure, containerized sandboxes.

### How it works

Each agent you create in SuperAgent runs inside its own isolated container (Docker, Podman, or other supported runtimes). Inside that container, the agent is powered by Claude, Anthropic's large language model. The agent has access to a set of tools -- a shell, file system, web browser, and any external services you connect -- and uses them to carry out the tasks you describe in natural language.

You interact with agents through a chat interface. You can send messages, ask questions, assign tasks, and watch the agent work in real time. Agents remember context across sessions, learn your preferences over time, and can be scheduled to run tasks on their own.

### Key capabilities

#### Containerized execution

Every agent runs in its own sandboxed container. The agent can execute code, install packages, read and write files, and run shell commands -- all without direct access to your host machine. This keeps your system secure while giving agents the freedom to get work done.

#### Connected accounts

SuperAgent integrates with dozens of external services through OAuth -- Gmail, Slack, GitHub, Linear, Salesforce, Google Drive, and many more. You connect an account once, and any agent you authorize can use it. API calls are proxied outside the container, so agents never see your OAuth tokens. You get an audit trail of every action taken on your behalf.

#### Browser automation

When no API is available, agents can open a web browser inside their container to interact with websites directly. You can watch the browser session in real time, and the agent can ask you for input when it encounters CAPTCHAs or login screens.

#### Scheduled tasks and triggers

Agents can schedule recurring or one-time tasks using cron expressions or specific dates. You can also set up webhook triggers that start an agent session when an external event occurs. This lets agents serve you autonomously in the background without manual prompting.

#### Dashboards and artifacts

Agents can build interactive dashboards -- small web apps rendered inside SuperAgent -- to surface information, charts, or controls. Agents can also deliver files and other artifacts directly to you during a conversation.

#### Multi-agent orchestration

Agents can discover, create, and invoke other agents in the same workspace. This lets you decompose complex workflows across specialized agents that collaborate to complete a task.

#### Skillsets

As agents develop reusable capabilities, you can package them into skillsets -- shared skill libraries backed by Git repositories. Install a skillset to give any agent instant access to a curated set of skills, and publish your own to share with your team.

### Deployment options

SuperAgent runs in two modes:

- **Desktop app** -- Download for Mac or Windows and run locally. The desktop app bundles everything and manages containers through Docker Desktop, OrbStack, or Podman.
- **Web app / server** -- Run SuperAgent as a Docker container or from source and access it through your browser. Supports multi-user auth mode with role-based access control for team deployments.

### Prerequisites

To run SuperAgent, you need:

1. **A container runtime** -- [Docker Desktop](https://docs.docker.com/desktop/), [OrbStack](https://orbstack.dev/), or [Podman](https://podman.io/).
2. **An Anthropic API key** -- Get one from the [Anthropic Console](https://platform.claude.com/settings/keys).
3. **A Composio API key** (optional) -- Required for connected accounts (OAuth integrations). Get one from [Composio](https://platform.composio.dev).

### Next steps

- [Quickstart](https://www.gamut.so/docs/using-superagent/getting-started/quickstart) -- Create your first agent and start a conversation.
- [Core Concepts](https://www.gamut.so/docs/using-superagent/getting-started/core-concepts) -- Understand the key abstractions: agents, sessions, containers, tools, and policies.

## Core Concepts

SuperAgent is built around a small set of concepts that compose together. Understanding them will help you get the most out of the platform.

### Agents

An agent is the central unit in SuperAgent. Each agent has a name, a description, and a set of **instructions** that define its behavior -- essentially a system prompt written in Markdown.

On disk, every agent is stored as a directory containing a `CLAUDE.md` file. This file holds YAML frontmatter (name, creation date, description) followed by the agent's instructions in the body. The agent learns and evolves over time by appending preferences and project notes to this file.

```markdown
---
name: Email Assistant
description: Manages and summarizes my inbox
createdAt: 2025-03-15T10:00:00.000Z
---

# Agent Instructions

You are a helpful email assistant.

## Preferences

- Always summarize in bullet points
- Flag anything from my manager as high priority
```

Agents can be configured, exported, shared as templates, and installed from [skillsets](https://www.gamut.so/docs/using-superagent/skillsets/overview). For detailed guidance, see [Creating and Configuring Agents](https://www.gamut.so/docs/using-superagent/agents/creating-and-configuring).

### Sessions

A session is a single conversation with an agent. Each session gets its own thread of messages and maintains context from start to finish. You can have many sessions with the same agent -- each one is independent.

Sessions are stored as JSONL (JSON Lines) files, where each line represents a message, tool invocation, or system event. Session metadata (name, starred status, creation date, model used) is tracked alongside the JSONL data.

Sessions can be created in several ways:

- **Manually** -- You type a message on the agent's home page.
- **Scheduled** -- A scheduled task fires and creates a session automatically.
- **Webhook-triggered** -- An external event triggers a new session.
- **Agent-invoked** -- Another agent invokes this one via multi-agent orchestration.

See [Sessions](https://www.gamut.so/docs/using-superagent/agents/sessions) for more detail.

### Containers

Every agent runs inside an isolated container. SuperAgent manages the full container lifecycle -- building the image, starting and stopping containers, health-checking, and resource cleanup.

Supported container runtimes include:

- **Docker** (via Docker Desktop or standalone daemon)
- **OrbStack** (macOS)
- **Podman**
- **Lima** (lightweight Linux VMs on macOS)
- **Apple Containers** (macOS native)
- **WSL2** (Windows)

Inside the container, the agent runs a Node.js server built on the Claude Agent SDK. This server manages Claude Code sessions, tool execution, file I/O, and communication with the SuperAgent host. Each container is wired up with:

- The agent's workspace directory (mounted from the host)
- Environment variables (API keys, secrets)
- A proxy token for calling connected account APIs
- Access to configured MCP servers

Containers are started on demand when you send a message and can be stopped manually or automatically when idle. The host monitors container health and recovers from crashes.

### Connected accounts

Connected accounts let agents interact with external services like Gmail, Slack, GitHub, Google Calendar, Salesforce, and dozens more. SuperAgent brokers OAuth connections through [Composio](https://composio.dev), so you authenticate once and then grant access to specific agents.

The key security property: **agents never see your OAuth tokens**. When an agent needs to call an external API, the request is proxied through the SuperAgent host, which injects the real credentials outside the container. This means a compromised or misbehaving agent cannot leak your tokens.

Each connected account can be mapped to one or more agents. You control which API scopes are allowed, reviewed, or blocked using [scope policies](https://www.gamut.so/docs/using-superagent/integrations/scope-policies). Every proxied API call is logged in an audit trail.

For setup details, see [Connected Accounts](https://www.gamut.so/docs/using-superagent/integrations/connected-accounts) and [Mapping Accounts to Agents](https://www.gamut.so/docs/using-superagent/integrations/mapping-accounts-to-agents).

### Tools

Tools are the actions an agent can take. SuperAgent provides a rich set of built-in tools, and you can extend agents with external tool servers.

#### Built-in tools

These are available to every agent out of the box:

| Tool | Description |
|------|-------------|
| **Bash** | Execute shell commands inside the container |
| **Read** | Read file contents |
| **Write** | Write or overwrite files |
| **Glob** | Find files by pattern |
| **Grep** | Search file contents |
| **WebFetch** | Fetch a URL and return its content |
| **WebSearch** | Search the web |
| **Task** (sub-agent) | Spawn a sub-agent to handle a subtask in parallel |
| **Browser tools** | Open pages, click, fill forms, scroll, take screenshots |
| **Dashboard tools** | Create, start, and manage interactive dashboards |
| **Schedule Task** | Create one-time or recurring scheduled tasks |
| **Deliver File** | Send a file from the container to the user |
| **Ask User** | Pause and ask the user a question |

#### MCP servers

Agents can also use tools exposed by [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) servers. You can connect remote MCP servers -- either community-hosted or self-hosted -- and configure per-tool policies for them. See [Remote MCP Servers](https://www.gamut.so/docs/using-superagent/integrations/remote-mcp-servers) and [MCP Tool Policies](https://www.gamut.so/docs/using-superagent/integrations/mcp-tool-policies).

### Policies

Policies give you fine-grained control over what agents are allowed to do. There are two main types:

#### Scope policies (connected accounts)

For each connected account, you can set a policy per API scope:

- **Allow** -- The agent can call this API scope without approval.
- **Review** -- The agent's request is paused and you are notified to approve or reject it.
- **Block** -- The agent is prevented from using this scope entirely.

This lets you grant broad read access while requiring approval for write operations, for example. See [Scope Policies](https://www.gamut.so/docs/using-superagent/integrations/scope-policies).

#### Tool policies (MCP servers)

Similarly, for each MCP server, you can set per-tool policies that allow, require review, or block specific tools. See [MCP Tool Policies](https://www.gamut.so/docs/using-superagent/integrations/mcp-tool-policies).

#### Cross-agent policies

When using multi-agent orchestration, you can control which agents are allowed to invoke which other agents. See [X-Agent Policies](https://www.gamut.so/docs/using-superagent/multi-agent/x-agent-policies).

### Skillsets

Skillsets are reusable collections of agent capabilities backed by Git repositories. A skillset contains an index of skills -- each skill is essentially a directory of files (instructions, scripts, templates) that gets installed into an agent's workspace.

Skillsets enable:

- **Sharing** -- Package what an agent has learned and share it with your team.
- **Templates** -- Create new agents from a skillset template, complete with pre-configured instructions and onboarding flows.
- **Version tracking** -- Skills track which version they were installed from and can be updated when the upstream skillset changes.

SuperAgent supports skillsets hosted on GitHub (cloned via Git) and on public URLs. See [Skillsets](https://www.gamut.so/docs/using-superagent/skillsets/overview) for the full guide.
