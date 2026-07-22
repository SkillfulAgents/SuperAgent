---
title: What integrations are supported?
description: Directory of supported connected-account services (OAuth), chat platforms, remote MCP servers, and other integration paths.
---

There are four distinct ways an agent integrates with the outside world. Pick by what exists for the service in question — and note the agent's actual tool list decides what is enabled for a specific agent.

## Connected accounts (OAuth)

Managed OAuth with proxied, policy-controlled API access ([how it works](../how-to/connect-external-accounts-oauth.md)). Supported toolkits include:

- **Google Workspace**: `gmail`, `googlecalendar`, `googledrive`, `googlesheets`, `googledocs`, `googleslides`, `googlemeet`, `googletasks`, `youtube`
- **Microsoft**: `outlook`, `microsoft_teams`
- **Communication**: `slack`, `discord`, `zoom`
- **Developer tools**: `github`, `gitlab`, `bitbucket`, `sentry`
- **Project management**: `notion`, `linear`, `confluence`, `asana`, `monday`, `clickup`, `trello`
- **CRM & support**: `hubspot`, `salesforce`, `zendesk`, `intercom`
- **Storage & data**: `airtable`, `dropbox`, `box`
- **Social**: `linkedin`, `instagram`
- **Finance**: `stripe`, `quickbooks`, `xero`
- **Marketing / design / scheduling**: `mailchimp`, `figma`, `calendly`, `typeform`

For these services, connecting an account is always preferred over pasting raw API keys — tokens stay outside the container and access is scoped and audited.

## Chat integrations

Talk to the agent from **Slack**, **Telegram**, or **iMessage**; the agent can also proactively message the user there (e.g. from a scheduled task). See [connect-slack-telegram-imessage](../how-to/connect-slack-telegram-imessage.md).

## Remote MCP servers

Any service exposing a remote MCP (Model Context Protocol) endpoint can be connected, adding its tools to the agent. This is the extension point for services not in the toolkit list above. See [use-remote-mcp-servers](../how-to/use-remote-mcp-servers.md).

## Everything else

- **Secrets + direct APIs**: for services with an API key and no toolkit/MCP, store the key as a per-agent secret and call the API from code. See [use-secrets-and-api-keys](../how-to/use-secrets-and-api-keys.md).
- **Webhooks in**: any service that can POST a webhook can trigger the agent, with signature verification. See [set-up-webhook-triggers](../how-to/set-up-webhook-triggers.md).
- **The browser**: services with no API at all can still be automated through the agent's real browser. See [browse-the-web](../how-to/browse-the-web.md).
