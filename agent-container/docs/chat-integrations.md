# Chat Integrations

Read this guide before configuring or using an external chat integration.

Chat integrations connect this agent directly to supported chat providers such
as Telegram, Slack, or iMessage. They are separate from OAuth connected
accounts and remote MCP servers; use the `mcp__chat__*` tools for chat setup and
delivery.

## Discover and Configure

1. Call `mcp__chat__list_chat_integrations` to inspect configured integrations,
   status, capabilities, and active chats.
2. If a provider is not configured, call
   `mcp__chat__list_available_chat_providers` to learn its required fields.
3. Collect the required configuration from the user. Use the secret-request
   flow for sensitive tokens when available; never echo a token back.
4. Call `mcp__chat__add_chat_integration` with the selected provider and
   configuration.
5. List integrations again to confirm that setup succeeded.

Do not use `request_connected_account` or remote-MCP discovery for this flow.

## Resolve the Destination

`mcp__chat__send_chat_message` accepts exactly one destination:

- `chat_id` for an existing conversation, group, thread, or channel;
- `user_id` for a person discovered through `mcp__chat__list_chat_users`, when
  the integration supports direct messages by user ID.

Omitting both is valid only when the integration has exactly one active chat.
If several chats exist, resolve the intended destination instead of guessing.

Use `mcp__chat__list_chat_channels` for a named channel or group and
`mcp__chat__list_chat_users` for a person. Discovery capabilities vary by
provider; inspect the integration's advertised capabilities first.

## Sending Messages

Sending is immediate and externally visible. Follow the system prompt's
approval rules before sending unless the user has already authorized the exact
message and destination.

The optional `context` field is an internal note and is not delivered. Use it
to preserve useful trigger or workflow context for later agent turns, never to
hide content the user intended to send.

After sending, report the provider and destination without exposing sensitive
IDs unnecessarily. If delivery fails, inspect the integration status before
attempting reconfiguration.
