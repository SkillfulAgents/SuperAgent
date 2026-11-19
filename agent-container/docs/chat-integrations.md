# Chat Integrations

Read this guide before configuring or using an external chat integration.

Agent integrations give this agent its own identity on an external service: a
chat bot (Telegram, Slack, iMessage), its own Email inbox, or its own Linear or
GitHub app. They are separate from OAuth connected accounts (which act as the
user) and remote MCP servers; use the `mcp__chat__*` tools for setup and
delivery.

## Discover and Configure

1. Call `mcp__chat__list_agent_integrations` to inspect configured integrations,
   status, capabilities, and active chats.
2. If a provider is not configured, call
   `mcp__chat__list_available_integration_providers`. It lists every provider
   this host supports with its setup steps and the fields it needs.
3. Follow the provider's steps. Offer to do the setup yourself in your browser
   (create the bot or app, copy what it gives you); the user only logs in when a
   login page appears. For a value only the user has, use the secret-request
   flow when available; never echo a token back.
4. Call `mcp__chat__add_agent_integration` with the provider and its fields.
   Some providers are connected when it returns. Others return a next step to
   finish in your browser, ending with `mcp__chat__authorize_agent_integration`:
   open the link it returns and approve it. If the page the service sends you
   back to does not load, call `authorize_agent_integration` again with
   `redirect_url` set to that page's address.
5. List integrations again to confirm that setup succeeded.

Do the setup yourself by default. Hand it to the user with
`mcp__user-input__request_integration_setup` instead when the provider listing
marks the provider "one click", when the user wants to do it themselves or will
not log in to the service in your browser, when only they can get past a step
(single sign-on, a second factor, an admin's approval), or when you have no
browser. It opens the provider's setup form for them in this session, starting
from the values you suggest, and returns once the integration is connected.
Choose before step 4: the form creates the integration itself.

Do not use `request_connected_account` or remote-MCP discovery for this flow.

## Email

Email integrations send from the agent’s own inbox. They do not require Gmail or
Outlook OAuth. Inspect `list_agent_integrations` first and follow its instructions;
`CONNECTED_ACCOUNTS` contains only OAuth accounts, not agent integrations.

For a **new email**, call `send_chat_message` with:

```json
{
  "integration_id": "<email integration ID>",
  "message": "Hello, world!",
  "email": {
    "to": ["recipient@example.com"],
    "subject": "Hello, world!",
    "idempotency_key": "hello-world-unique-send-1"
  }
}
```

Use an address provided by the user, or call `list_chat_users` if you need to
identify the recipient. Its permitted contacts are bounded and may be incomplete.
Do not call `list_chat_channels` for a new email: no existing thread is required.
Do not use `user_id` or `chat_id` for email.

To reply to an existing email, find its `reply_to_message_id` with
`list_chat_channels` and pass it as `email.reply_to_message_id` with a new
idempotency key. Up to 20 recent conversations are listed. Optional email fields
include `cc`, `bcc`, `reply_all`, and `attachment_paths` (workspace file paths).
Every recipient must pass the current access policy.

In a session started by incoming email, your response is sent back automatically;
do not also send it with the tool. Use `deliver_file` to attach files to that reply.

Reuse the same idempotency key and identical payload when retrying a send.
A queued response means accepted, not delivered. If the tool schema has no
`email` parameter, report that the agent runtime needs updating; do not try chat
IDs as a workaround. To create an inbox, call `add_agent_integration` with
provider `platform-email`.

## Resolve the Destination for Other Chat Providers

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

`mcp__chat__send_chat_message` does not require an active chat session. It is
the way to reach the user proactively from a session they are not watching — a
scheduled task, a webhook-triggered run, or a long autonomous job. Use it when
such a session produces a result the user asked for, hits a decision only the
user can make, or fails in a way that needs attention. Pick the destination the
same way as in an interactive session: resolve it explicitly rather than
relying on the single-active-chat default.

The optional `context` field is an internal note and is not delivered. Use it
to preserve useful trigger or workflow context for later agent turns, never to
hide content the user intended to send.

After sending, report the provider and destination without exposing sensitive
IDs unnecessarily. If delivery fails, inspect the integration status before
attempting reconfiguration.
