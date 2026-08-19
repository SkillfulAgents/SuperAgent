---
title: What can the agent do?
description: Capability overview — the kinds of tasks agents handle and the platform features available, with pointers to detailed docs.
---

Gamut agents are general-purpose, code-capable AI agents. Anything that can be reduced to reading, writing, or running code inside the agent's workspace is in scope — and many everyday tasks (research, reporting, file wrangling, API automation) reduce to exactly that.

## Core abilities

- **Work with files and code** — read, write, and organize files in a persistent workspace; run Node.js, Python (via `uv`), TypeScript, and shell. The workspace survives across sessions, so work builds up over time.
- **Browse the web** — a real browser the user can watch live, for research, form-filling, and downloads. See [browse-the-web](../how-to/browse-the-web.md).
- **Call external services** — through connected accounts (Gmail, GitHub, Slack, Notion, and many more via OAuth), remote MCP servers, or plain API keys stored as secrets. See [what-integrations-are-supported](what-integrations-are-supported.md).
- **Build dashboards and artifacts** — live web apps served from the agent's container for visualizing data or delivering rich output. See [build-dashboards-and-artifacts](../how-to/build-dashboards-and-artifacts.md).
- **Run on a schedule or on events** — recurring/one-time scheduled tasks, and webhook triggers that start a session when something happens externally (new email, new PR, a Stripe event). See [schedule-recurring-and-one-time-tasks](../how-to/schedule-recurring-and-one-time-tasks.md) and [set-up-webhook-triggers](../how-to/set-up-webhook-triggers.md).
- **Message the user anywhere** — chat integrations for Slack, Telegram, and iMessage, so conversations and notifications don't require the app to be open. See [connect-slack-telegram-imessage](../how-to/connect-slack-telegram-imessage.md).
- **Build reusable skills** — recurring work gets captured as named, documented skills the agent evolves over time. See [create-and-manage-skills](../how-to/create-and-manage-skills.md).
- **Collaborate with other agents** — invoke specialist agents in the same workspace and read their session transcripts. See [work-with-other-agents](../how-to/work-with-other-agents.md).
- **Remember** — a persistent memory system (who the user is, feedback, project context) plus standing instructions in `CLAUDE.md`.

Some deployments also enable **computer use** (controlling native desktop apps on the user's machine). If the computer-use tools are not in the agent's tool list, that feature is not enabled for this agent.

## Good example asks

- "Watch my inbox and draft replies to anything from a customer."
- "Pull last month's Stripe data and build me a revenue dashboard."
- "Every weekday at 9am, summarize new GitHub issues into Slack."
- "Take this CSV, clean it up, and turn it into a report."
- "Research these five vendors and compare their pricing."

## Limits to be upfront about

- The agent can only reach services it has been given access to (connected accounts, secrets, MCP servers) — it will ask when it needs something new.
- Risky or hard-to-reverse actions (sending messages, deleting things, spending money) require user confirmation by default, governed by the session's permission mode.
- What is *enabled* varies per agent and deployment. The agent's actual tool list is authoritative; these docs describe the full product.
