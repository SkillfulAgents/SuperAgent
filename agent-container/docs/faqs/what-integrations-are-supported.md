---
title: What integrations are supported?
description: The four ways an agent reaches outside services — connected accounts (OAuth), chat platforms, remote MCP servers, and secrets/webhooks/browser.
---

There are four distinct ways an agent integrates with the outside world. Pick by what exists for the service in question — and note the agent's actual tool list decides what is enabled for a specific agent.

## Connected accounts (OAuth)

Managed OAuth with proxied, policy-controlled API access: tokens stay outside the container, hosts are allowlisted per provider, and every call is audited. Services with endpoint permission maps support per-scope policies; other requests follow the account-wide policy or the global API policy. For these services, connecting an account is always preferred over pasting raw API keys.

Coverage spans Google Workspace, Microsoft, communication tools, developer tools, project management, CRM and support, storage and data, social, finance, and marketing/design/scheduling.

**As the agent:** use `search_connected_account_services` for the available catalog with descriptions. Use it to answer "do you support X?" or to pick a slug for `request_connected_account`; examples in the system prompt are not an exhaustive list.

Some services ask for an account ID, tenant, or region on Composio's hosted connection page. These details do not require asking the user for an OAuth client ID or secret. Product editions matter: `notebook_lm` connects NotebookLM Enterprise in a Google Cloud project, `whatsapp` connects WhatsApp Business, and `facebook` connects Facebook Pages. Available API operations also depend on the permissions granted by the provider. Connecting an account does not automatically add a chat integration or a mounted storage volume.

## Chat integrations

Talk to the agent from **Slack**, **Telegram**, or **iMessage**. The agent can also send messages on those platforms on its own initiative — including from a scheduled task or a webhook-triggered session, with no chat conversation in progress.

## Meetings

The agent can attend **Zoom**, **Google Meet** and **Microsoft Teams** calls as a participant: speaking when addressed, answering in the call chat, or just listening and taking notes. Ask it to join with the invite link, or send it in from its Meetings integration page. This needs a deployment the internet can reach and a Platform connection (or a Recall.ai key); when neither is there the agent says meetings are unavailable on this host.

## Remote MCP servers

Any service exposing a remote MCP (Model Context Protocol) endpoint can be connected, adding its tools to the agent. This is the extension point for services with no managed OAuth toolkit.

## Everything else

- **Secrets + direct APIs**: for services with an API key and no toolkit/MCP, store the key as a per-agent secret and call the API from code.
- **Webhooks in**: any service that can POST a webhook can trigger the agent, with signature verification.
- **The browser**: services with no API at all can still be automated through the agent's real browser.
