# Gamut Product Docs — Index

One file per question. Match the user's question (or your debugging need) against the lines below, then Read that file. Answer from the docs, not from memory. Every file has frontmatter with a `source_url` linking the human-readable page on www.gamut.so when one exists — share it when the user wants to read for themselves.

These docs describe the full product. Your actual tool list is authoritative for what is enabled for THIS agent.

## FAQ — about the product

- `faq/what-can-the-agent-do.md` — "what can you do", "what features do you have", "what should I ask you", "give me ideas", capability and feature overview
- `faq/what-is-gamut-and-how-does-it-work.md` — "what is this", "how does this work", "what's an agent/session/workspace", product intro and core concepts
- `faq/is-my-data-secure.md` — "is this safe", "is my data secure", "can you see my passwords", "where is my data stored", "what can you access", privacy, isolation, audit
- `faq/what-integrations-are-supported.md` — "do you support Notion/Stripe/…", "can you connect to X", "what integrations are there", directory of OAuth toolkits, chat platforms, MCP

## How-to — doing things with the product

- `how-to/get-started-with-your-first-agent.md` — "I'm new", "how do I start", first-agent quickstart
- `how-to/create-and-configure-agents.md` — "how do I create/configure/rename an agent", instructions, model, settings
- `how-to/connect-external-accounts-oauth.md` — "connect my Gmail/GitHub/Slack", "log into my account", OAuth accounts, account→agent mapping, proxy API calls, accounts vs MCP
- `how-to/use-secrets-and-api-keys.md` — "here's my API key", "how do I give you a token/password", storing and using secrets
- `how-to/use-remote-mcp-servers.md` — "add an MCP server", "connect this MCP", remote MCP tools
- `how-to/control-what-the-agent-can-access.md` — "limit what the agent can do", "require approval for sends", scope policies, MCP tool policies
- `how-to/schedule-recurring-and-one-time-tasks.md` — "every morning", "remind me later", "run this daily/weekly", cron and one-time scheduling
- `how-to/set-up-webhook-triggers.md` — "when I get an email…", "react to new PRs", "trigger on Stripe events", Composio triggers, custom webhook URLs, HMAC, filters
- `how-to/connect-slack-telegram-imessage.md` — "text me", "message me on Slack/Telegram/iMessage", "talk to you from my phone", chat integrations
- `how-to/browse-the-web.md` — "how does your browser work", "log in to a site", built-in browser, Chrome integration, Browserbase, CAPTCHAs, downloads
- `how-to/build-dashboards-and-artifacts.md` — "make me a dashboard", "where did my artifact go", "share this app", dashboards and artifacts lifecycle
- `how-to/create-and-manage-skills.md` — "what are skills", "reuse this next time", "install a skillset", creating, evolving, sharing skills
- `how-to/work-with-other-agents.md` — "ask my other agent", "agents talking to each other", cross-agent (x-agent) work and policies
- `how-to/mount-local-folders-and-volumes.md` — "access my local files", "mount a folder", volumes and mounts
- `how-to/manage-sessions-and-history.md` — "start a new session", "find an old conversation", sessions and history

## Platform — architecture, runtime, debugging (also for your own use)

- `platform/how-the-agent-container-works.md` — container filesystem layout, what persists, injected env vars, common failure shapes (missing env var, read-only paths, ports)
- `platform/where-am-i-running.md` — runtimes (desktop Docker/Lima/Apple, cloud MicroVM), sleep/wake lifecycle, persistence rules, networking, timezone
- `platform/self-hosting-setup-and-administration.md` — "how do I self-host", deployment options, LLM providers, runtime setup, usage/costs, audit logging, notifications
