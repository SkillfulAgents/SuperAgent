---
title: How do I talk to the agent from Slack, Telegram, or iMessage?
description: Chat integrations: connecting messaging platforms so the agent can receive and send messages outside the app.
source_url:
  - https://www.gamut.so/docs/using-superagent/chat-integrations/overview
  - https://www.gamut.so/docs/using-superagent/chat-integrations/slack
  - https://www.gamut.so/docs/using-superagent/chat-integrations/telegram
  - https://www.gamut.so/docs/using-superagent/chat-integrations/imessage
---

## Chat Integrations Overview

Chat integrations let you connect a Superagent agent to an external messaging platform so it can receive and respond to messages directly inside the chat app. Instead of interacting with your agent only through the Superagent desktop UI, you (and others) can message it from Telegram, Slack, or iMessage.

### Supported Platforms

- **Telegram** — Connect a Telegram bot to your agent. Anyone who messages the bot gets a response from the agent.
- **Slack** — Connect a Slack bot to your agent. The bot can respond to direct messages and channel conversations, with fine-grained control over when and how it replies.
- **iMessage** — Connect your phone number to an agent through the iMessage gateway service. Send a text, get a response.

### How It Works

When you set up a chat integration, Superagent creates a persistent connection between the messaging platform and your agent:

1. **A message arrives** from the external platform (a Telegram DM, a Slack message, an iMessage text).
2. **Superagent routes the message** to the configured agent. If no session exists for that conversation yet, a new agent session is created automatically.
3. **The agent processes the message** using its configured tools, skills, and system prompt, just as it would for messages sent from the desktop UI.
4. **The response streams back** to the chat platform. For Telegram and Slack, the response is streamed progressively (the message updates as the agent types). For iMessage, the full response is sent once complete.

The agent has access to all of its normal capabilities during a chat integration session: connected accounts, MCP servers, browser use, file handling, and multi-agent delegation all work as expected. A few actions that require the desktop UI (such as OAuth authorization flows or browser input) will prompt the user to open Superagent on their computer.

### Sessions

Each unique conversation in the external chat creates a corresponding session in Superagent. For example:

- Each Telegram user who DMs the bot gets their own session.
- Each Slack user who DMs the bot, or each channel the bot is active in, gets a session.
- An iMessage conversation gets a session.

Sessions are visible in the Superagent sidebar under the integration, and you can view the full message history in the desktop app. These sessions are read-only in the UI since messages can only be sent from the connected chat platform.

#### Session Timeout

You can optionally configure a session timeout (in hours). When the timeout elapses since the last message in a conversation, the next incoming message will start a fresh session instead of continuing the old one. This is useful for agents that should treat each interaction as independent after a period of inactivity.

If no timeout is set, the same session persists indefinitely for each conversation.

#### Clearing Sessions

You can manually clear a session at any time, either from the Superagent UI or by sending `/clear` in the chat. The next message will start a fresh session.

### Common Settings

All chat integrations share these options:

- **Bot Name** — A display name for the integration, shown in the Superagent sidebar.
- **Show Tool Calls** — When enabled, the bot posts a message in the chat each time the agent invokes a tool, so the user can see what the agent is doing.
- **Session Timeout** — Number of hours of inactivity after which the next message starts a new session. Leave blank to keep a single continuous session.
- **Model and Effort** — Override the model or effort level used for this integration's sessions.

### Next Steps

- [Set up a Telegram bot](https://www.gamut.so/docs/using-superagent/chat-integrations/telegram)
- [Set up a Slack bot](https://www.gamut.so/docs/using-superagent/chat-integrations/slack)
- [Set up iMessage](https://www.gamut.so/docs/using-superagent/chat-integrations/imessage)

## Slack

The Slack integration connects a Slack bot to your agent using Socket Mode (WebSocket-based, no public URL required). The bot can respond to direct messages, participate in channels, reply in threads, and handle interactive prompts with Block Kit buttons.

### Prerequisites

- A Slack workspace where you have permission to create apps.
- An agent already created in Superagent.

### Creating a Slack App

Superagent provides two setup paths: **quick setup** using an app manifest, or **manual setup** where you configure each setting yourself.

#### Quick Setup (Recommended)

1. Go to [api.slack.com/apps](https://api.slack.com/apps).
2. Click **Create New App** and select **From an app manifest**.
3. Select your workspace.
4. In the Superagent setup dialog, copy the generated manifest (the dialog provides a copy button). Paste it into Slack's manifest editor, replacing the default content.
5. Click through to create the app.
6. In **Basic Information**, scroll to **App-Level Tokens**. Click **Generate Tokens and Scopes**.
7. Name the token (e.g., "superagent"), click **Add Scope**, select `connections:write`, then click **Generate**.
8. Copy the generated `xapp-...` token. This is your **App-Level Token**.
9. Go to **OAuth & Permissions**. Click **Install to Workspace** (or reinstall if updating). Authorize the app.
10. Copy the **Bot User OAuth Token** (`xoxb-...`). This is your **Bot Token**.

#### Manual Setup

If you prefer to configure the app yourself:

1. Go to [api.slack.com/apps](https://api.slack.com/apps). Click **Create New App** and select **From scratch**. Choose your workspace.
2. **Settings > Socket Mode** -- Toggle Socket Mode ON.
3. **Basic Information > App-Level Tokens** -- Generate a token with the `connections:write` scope. Copy the `xapp-...` token.
4. **OAuth & Permissions > Bot Token Scopes** -- Add all required scopes:
   - `chat:write`
   - `im:history`, `im:read`, `im:write`
   - `channels:history`, `channels:read`
   - `groups:history`, `groups:read`
   - `mpim:history`, `mpim:read`
   - `users:read`
   - `files:read`, `files:write`
   - `reactions:write`
5. **Event Subscriptions** -- Toggle ON. Under **Subscribe to bot events**, add:
   - `message.im`
   - `message.channels`
   - `message.groups`
   - `message.mpim`
6. **Interactivity & Shortcuts** -- Toggle ON.
7. **App Home > Show Tabs** -- Check "Messages Tab" and "Allow users to send Slash commands and messages from the messages tab".
8. **OAuth & Permissions** -- Click **Install to Workspace**. Copy the `xoxb-...` Bot Token.

### Connecting to Superagent

1. Open your agent in Superagent.
2. Open the chat integrations setup and select **Slack**.
3. Paste the **App-Level Token** (`xapp-...`) and **Bot Token** (`xoxb-...`).
4. Optionally click **Verify token** to confirm both tokens are valid. Superagent validates the bot token via `auth.test` and the app token via `apps.connections.open`.
5. Configure channel behavior settings (see below).
6. Click **Connect**.

Superagent opens a WebSocket connection to Slack via Socket Mode. Once connected, the bot appears online in your workspace.

#### Channel ID (Optional)

The Channel ID field is optional. If left empty, the bot will respond to any DM or channel it is invited to. You can specify a channel ID to restrict the bot to a single channel.

### Channel Behavior Settings

These settings control how the bot behaves in channels (they do not affect DMs, where the bot always responds to every message):

#### Only Trigger on @mention

When enabled, the bot only responds to channel messages that @mention it. Messages without a mention are ignored.

Once the bot responds in a thread, it will continue to respond to follow-up messages in that same thread even without being mentioned again. This provides a natural conversation flow: mention the bot to start, then continue the discussion in the thread.

DMs are never filtered regardless of this setting.

#### Reply in Thread

When enabled, the bot replies in a thread rather than posting to the channel directly. This keeps the main channel clean while allowing detailed conversations in threads.

For top-level channel messages, the bot creates a new thread anchored to the original message. For messages already in a thread, the bot replies in that thread.

#### New Session per Thread

Available when "Reply in thread" is enabled. When turned on, each Slack thread gets its own independent agent session. This means the agent starts fresh in each thread with no memory of other threads.

When turned off, all messages in a channel (across all threads) share a single agent session, so the agent has context from previous conversations.

### How Messages Flow

```
Slack user sends message (DM or channel)
        |
        v
Slack Socket Mode (WebSocket)
        |
        v
Message routing (mention filter, thread logic)
        |
        v
Superagent routes to agent session
        |
        v
Agent processes message (tools, skills, etc.)
        |
        v
Response streams back to Slack
(message updates in place as text arrives)
```

- **Text messages** are forwarded to the agent. Slack-specific mention syntax (`<@U123>`) is resolved to real user names before being sent to the agent.
- **File uploads** are downloaded (requires the `files:read` scope) and attached to the message. If the download fails, the bot posts a warning and continues with the text portion.
- **Interactive buttons** (Block Kit) are used for questions, approval prompts, and other interactive events.
- **Typing indicator** -- Slack does not support typing indicators for bots. As a workaround, Superagent adds a thinking_face reaction to the user's last message while the agent is working, and removes it once the response is sent.
- **Thread context** -- When the bot joins an existing thread mid-conversation, it fetches earlier messages in the thread so the agent has full context.
- **Markdown formatting** in agent responses is converted to Slack mrkdwn format (bold, italic, code blocks, lists, links).

### Sessions

Each unique conversation gets its own session:

- Each user who DMs the bot gets a dedicated session.
- Each channel the bot is active in gets a session (or each thread, if "New session per thread" is enabled).
- In group contexts, messages are prefixed with the sender's name so the agent knows who is speaking.

Sessions are visible in the Superagent sidebar. If multiple sessions exist, a dropdown lets you switch between them to view the conversation history.

Send `/clear` in the chat at any time to reset the session.

### Managing the Integration

Once connected, you can manage the integration from the Superagent sidebar:

- **Pause / Resume** -- Temporarily stop the bot without deleting the integration.
- **Show Tool Calls** -- Toggle visibility of tool invocation messages in the chat.
- **Session Timeout** -- Set an inactivity timeout for automatic session rotation.
- **Model and Effort** -- Override the AI model or effort level.
- **Only on @mention** -- Toggle the mention-only filter.
- **Reply in Thread** -- Toggle threaded replies.
- **New Session per Thread** -- Toggle per-thread session isolation (only available when Reply in Thread is on).
- **Rename / Delete** -- Rename or permanently remove the integration.

## Telegram

The Telegram integration connects a Telegram bot to your agent. Anyone who messages the bot receives responses from the agent in real-time, with streaming message updates as the agent works.

### Prerequisites

- A Telegram account.
- An agent already created in Superagent.

### Creating a Telegram Bot

Telegram bots are created through [@BotFather](https://t.me/BotFather), Telegram's official bot management tool.

1. Open Telegram and start a chat with **@BotFather**.
2. Send `/newbot` to BotFather.
3. Choose a display name for your bot (e.g., "My Assistant").
4. Choose a username for your bot. It must end in `bot` (e.g., `my_assistant_bot`).
5. BotFather will reply with your **bot token** -- a string that looks like `123456789:ABCdefGHIjklMNO...`. Copy this token.

Keep the bot token secret. Anyone with this token can control your bot.

### Connecting to Superagent

1. Open your agent in Superagent.
2. Open the chat integrations setup and select **Telegram**.
3. Paste your **bot token** into the Bot Token field.
4. Optionally click **Verify token** to confirm the token is valid. Superagent will display the bot's name and username on success.
5. Configure any additional settings (bot name, show tool calls, session timeout).
6. Click **Connect**.

Superagent will start long-polling the Telegram Bot API for incoming messages. Once connected, the integration appears in the sidebar under your agent.

#### Chat ID (Optional)

The Chat ID field is optional and auto-detected. When someone sends the bot a message, Superagent automatically captures the Telegram chat ID and uses it for routing. You do not need to fill this in unless you have an advanced use case.

### Messaging Your Bot

After the integration is connected:

1. Open Telegram and find your bot by its username (e.g., `@my_assistant_bot`).
2. Send `/start` to begin a conversation. The bot will reply with a greeting.
3. Send any message. The agent will process it and the response will appear in the chat, updating progressively as the agent streams its output.

### How Messages Flow

```
Telegram user sends message
        |
        v
Telegram Bot API (long polling)
        |
        v
Superagent routes to agent session
        |
        v
Agent processes message (tools, skills, etc.)
        |
        v
Response streams back to Telegram
(message updates in place as text arrives)
```

- **Text messages** are forwarded to the agent as-is.
- **Photos and documents** are downloaded and attached to the message sent to the agent. The agent can view images and read file contents.
- **Inline keyboard buttons** are used for interactive prompts (e.g., approval requests, multiple-choice questions).
- **Long responses** are automatically split into multiple messages if they exceed Telegram's 4096-character limit.
- **Markdown formatting** in agent responses is converted to Telegram-compatible HTML (bold, italic, code blocks, lists, tables).

### Sessions

Each unique Telegram chat (each user who DMs the bot, or each group the bot is in) gets its own session in Superagent. In group chats, messages are prefixed with the sender's name so the agent can attribute who said what.

Send `/clear` at any time to reset the session. The bot will confirm, and your next message will start a new conversation.

### Managing the Integration

Once connected, you can manage the integration from the Superagent sidebar:

- **Pause / Resume** -- Temporarily stop the bot from receiving messages without deleting the integration.
- **Show Tool Calls** -- Toggle whether the bot posts messages showing each tool the agent invokes.
- **Session Timeout** -- Set or change the inactivity timeout for automatic session rotation.
- **Model and Effort** -- Override the AI model or effort level used for this integration.
- **Rename** -- Change the display name shown in the sidebar.
- **Delete** -- Permanently remove the integration and disconnect the bot. Existing session history is preserved.

## iMessage

The iMessage integration connects your phone number to an agent through the iMessage gateway service. You can text the agent from your iPhone and receive responses as regular iMessage conversations.

### Prerequisites

- An iPhone with iMessage enabled.
- An agent already created in Superagent.

### How the Gateway Works

The iMessage integration uses a cloud gateway service that bridges iMessage messages to Superagent. When you set up the integration, Superagent connects to the gateway over WebSocket. Incoming messages from your phone number are forwarded to the agent, and the agent's responses are sent back through the gateway to your iMessage conversation.

Unlike Telegram and Slack, iMessage does not support progressive streaming. The agent's full response is sent as a single message once processing is complete. While the agent is working, a typing indicator is shown in the conversation.

### Setup

1. Open your agent in Superagent.
2. Open the chat integrations setup and select **iMessage**.
3. From your iPhone, text `/setup` to **+1 (205) 396-7934**. You will receive a reply with a 6-digit code (the code expires after 15 minutes).
4. In the Superagent setup form, enter your phone number in E.164 format (e.g., `+15551234567`) and the 6-digit code.
5. Configure any additional settings (bot name, show tool calls, session timeout).
6. Click **Connect**.

Superagent will exchange the code for an authentication token and establish a WebSocket connection to the gateway. If the code has expired, text `/setup` to the same number again to get a new one.

### Limitations

- **One integration per phone number** -- Only one agent can be connected to iMessage at a time. If you need multiple agents accessible via iMessage, set up a single dedicated iMessage agent and configure it to delegate to your other agents.
- **No streaming** -- iMessage has a limit on message edits, so responses are sent as complete messages rather than streaming progressively.
- **Interactive prompts** -- Questions with options are rendered as numbered lists. Reply with the number of your choice or type a free-text answer. Approval requests (e.g., permission to use a tool) are handled via tapback reactions: thumbs up to allow, thumbs down to deny.
- **Voice notes** -- Voice notes sent to the agent are automatically transcribed (when a speech-to-text provider is configured) and forwarded as text.

### How Messages Flow

```
iPhone user sends iMessage
        |
        v
iMessage Gateway (WebSocket)
        |
        v
Superagent routes to agent session
        |
        v
Agent processes message (tools, skills, etc.)
        |
        v
Complete response sent back via gateway
(typing indicator shown while agent works)
```

- **Text messages** are forwarded to the agent.
- **Images and file attachments** are downloaded and passed to the agent.
- **Tapback reactions** on the agent's messages are interpreted as interactive responses (thumbs up = allow, thumbs down = deny).
- **The agent can react** to your messages using tapback reactions (heart, thumbs up, thumbs down, haha, emphasize, question mark) when appropriate.

### Sessions

Each iMessage conversation maps to a session in Superagent. The session is visible in the Superagent sidebar, where you can view the full message history.

Send `/clear` in the iMessage conversation to reset the session. The next message will start a fresh conversation with the agent.

### Reconnection

If the WebSocket connection to the gateway is lost (e.g., due to a network interruption), Superagent automatically attempts to reconnect with exponential backoff. Messages sent while the connection is down will be queued by the gateway and delivered once the connection is restored.

### Managing the Integration

Once connected, you can manage the integration from the Superagent sidebar:

- **Pause / Resume** -- Temporarily stop receiving messages without deleting the integration.
- **Show Tool Calls** -- Toggle visibility of tool invocation messages.
- **Session Timeout** -- Set an inactivity timeout for automatic session rotation.
- **Model and Effort** -- Override the AI model or effort level.
- **Rename / Delete** -- Rename or permanently remove the integration.
