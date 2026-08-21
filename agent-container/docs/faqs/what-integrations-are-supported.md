---
title: What integrations are supported?
description: The four ways an agent reaches outside services — connected accounts (OAuth), chat platforms, remote MCP servers, and secrets/webhooks/browser.
---

There are four distinct ways an agent integrates with the outside world. Pick by what exists for the service in question — and note the agent's actual tool list decides what is enabled for a specific agent.

## Connected accounts (OAuth)

Managed OAuth with proxied, policy-controlled API access: tokens stay outside the container, hosts are allowlisted per provider, scopes are policy-controlled, and every call is audited. For these services, connecting an account is always preferred over pasting raw API keys.

Coverage spans Google Workspace, Microsoft, communication tools, developer tools, project management, CRM and support, storage and data, social, finance, and marketing/design/scheduling.

**As the agent:** do not recite a supported-service list from this file. The authoritative list of toolkit slugs is in your system prompt under "Requesting Connected Accounts (OAuth)", and `search_connected_account_services` returns the live catalog with descriptions. Use one of those to answer "do you support X?" or to pick a slug for `request_connected_account`.

## Chat integrations

Talk to the agent from **Slack**, **Telegram**, or **iMessage**. The agent can also send messages on those platforms on its own initiative — including from a scheduled task or a webhook-triggered session, with no chat conversation in progress.

## Remote MCP servers

Any service exposing a remote MCP (Model Context Protocol) endpoint can be connected, adding its tools to the agent. This is the extension point for services with no managed OAuth toolkit.

## Everything else

- **Secrets + direct APIs**: for services with an API key and no toolkit/MCP, store the key as a per-agent secret and call the API from code.
- **Webhooks in**: any service that can POST a webhook can trigger the agent, with signature verification.
- **The browser**: services with no API at all can still be automated through the agent's real browser.
