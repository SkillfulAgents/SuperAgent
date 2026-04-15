We want to add a feature to allow users to chat with their agent from within off-platfrom messaging tools - initially Slack and Telegram.
Users will be able to set such connections, and then have a session within the agent that is fully controlled from that remote messenger.

Critical architectural decisions:
- We want to follow a very polymorphic design, to allow easily adding additional integrations down the road. We should have a base `ChatClientConnector` class with common methods like `initializeSubscription`, `showTyping` or `sendMessage`, and implement classes for different chat apps.
  - Please refer to the Vercel Chat SDK as a good example of interface design here (specifically function names etc). We won't use it directly (because we don't want to use webhooks), but it is a good example.
- We won't be using webhooks - but rather WS subscriptions / SSE / Long Polling. We operate a desktop app (Electron), and need to work without exposing ports!
- Every integration is tied to a session -> every integration should send messages in a singular session
- Agents can have multiple integrations of the same or different types


Integration points:
- Agent Settings -> add a new **Chat Integration** tab. This tab will show all chat integrations, and allow users to add additional ones.
- Users can add new chat integrations. They will be given two options: `Slack` an `Telegram`. After selecting one, they'll be shown instructions on how to set it up, and inputs for the relevant secrets they need for the integration.
  - As an integration setting, users can choose wether or not to send tool calls as well or just pure agent messages
- We shall manage chat integrations in the SQLite DB. 
- We should have a global ChatIntegrationManager that starts when the app starts (to subscribe to any integrations and dispatch events) and tear down on app shutdown
- Each Chat Integration will have a `current session` field -> the session it is connected to
- Be mindful of Auth Mode in designing this -> should work there too (integrations there are per agent, every agent owner can manage, every user / viewer can see)
- In the left nav - show chat integrations like we show Scheduled jobs / triggers. Clicking on a scheduled session should show it's thread, but with the send box disabled

## Telegram
We should use the Bot (BotFather) interface. 
- Use streaming where possible
- Show typing indicator
- Use long polling with a reasonable timeout.
- On first poll, if multiple messages are recieved, send them together in one chained message to the agent

## Slack
Have the user create an app + bot token (give clear instructions)
- Use streaming
- Show typing indicator if possible

## User request items
You'll need to intercept user request items and send them to the chat apps as rich cards. For now focus on:
- Questions
- Approvals
- Secret Reqursts
- File Request & Delivery

Account and MCP connections to come later

Also, we should send a compacted view for tool use.

For the tool identification and extraction - see if we can reuse / extarct logic from the rendering pipeline.

## Testing
Testing for this feature will be critical. You plan should include creating a ROBUST testing harness that uses a mock chat integration to test the feature throughout.

---

# Technical Analysis & Implementation Details

## 1. Base Architecture — `ChatClientConnector`

### 1.1 Tool Definitions (DONE — prep refactor completed)

Every tool now has a single-source-of-truth definition file in `src/shared/lib/tool-definitions/`. This covers ALL tools (not just user-request tools): Bash, Read, Write, Glob, Grep, WebSearch, WebFetch, TodoWrite, Task, AskUserQuestion, all `mcp__user-input__*` tools, browser tools, and dashboard tools.

**Structure:**

```
src/shared/lib/tool-definitions/
  types.ts                        — ToolDefinition interface, formatToolName(), UserRequestEvent union, Question/QuestionOption
  bash.ts                         — BashInput type + bashDef (displayName, iconName, parseInput, getSummary)
  read.ts                         — ReadInput type + readDef + getDisplayPath()
  write.ts                        — WriteInput type + writeDef
  glob.ts                         — GlobInput type + globDef
  grep.ts                         — GrepInput type + grepDef
  web-search.ts                   — WebSearchInput type + webSearchDef
  web-fetch.ts                    — WebFetchInput type + webFetchDef
  todo-write.ts                   — TodoWriteInput/Todo types + todoWriteDef
  task.ts                         — TaskInput type + taskDef
  ask-user-question.ts            — AskUserQuestionInput type + askUserQuestionDef
  request-secret.ts               — RequestSecretInput type + requestSecretDef
  request-file.ts                 — RequestFileInput type + requestFileDef
  deliver-file.ts                 — DeliverFileInput type + deliverFileDef + getFilename()
  request-connected-account.ts    — RequestConnectedAccountInput type + requestConnectedAccountDef
  request-remote-mcp.ts           — RequestRemoteMcpInput type + requestRemoteMcpDef
  request-browser-input.ts        — RequestBrowserInputInput type + requestBrowserInputDef
  request-script-run.ts           — RequestScriptRunInput type + requestScriptRunDef + SCRIPT_TYPE_LABELS
  schedule-task.ts                — ScheduleTaskInput type + scheduleTaskDef + cronToHuman()
  browser-tools.ts                — 12 browser tool defs (browserOpenDef, browserClickDef, etc.)
  dashboard-tools.ts              — 4 dashboard tool defs + CreateDashboardInput/DashboardSlugInput types
  registry.ts                     — getToolDefinition(name), getRegisteredDefinitionNames()
  registry.test.ts                — 43 tests: formatToolName, cronToHuman, getSummary for all tools, registry completeness
```

**Each definition file exports a `*Def` object:**
```ts
// Example: src/shared/lib/tool-definitions/request-secret.ts
export interface RequestSecretInput { secretName?: string; reason?: string }

function parseInput(input: unknown): RequestSecretInput { ... }
function getSummary(input: unknown): string | null { ... }

export const requestSecretDef = { displayName: 'Request Secret', iconName: 'KeyRound', parseInput, getSummary } as const
```

**Consumers import from the definition file — no duplication:**
- **Renderer** (`tool-renderers/request-secret.tsx`): imports `requestSecretDef` + `RequestSecretInput`, wraps with JSX
- **MessagePersister**: imports `type RequestSecretInput` for JSON.parse type assertions
- **ChatIntegrationManager** (future): imports `requestSecretDef` for summary + card rendering — `toChatCard()` will be added to each definition file when chat integrations are built
- **Registry**: `getToolDefinition(name)` lookup for backend consumers that don't know the specific tool at compile time

**Registry completeness is enforced by tests:** every renderer must have a matching definition, and every definition must have a matching renderer (with an explicit allow-list for backend-only tools like `request_browser_input`).

### 1.2 Abstract Class Design

Place in `src/shared/lib/chat-integrations/base-connector.ts`. The abstract class wraps the lifecycle that every provider must implement, while the manager (see §2) handles orchestration.

```ts
import type { UserRequestEvent } from '@shared/lib/tool-definitions/types'

export type ChatIntegrationStatus = 'active' | 'paused' | 'error' | 'disconnected'

export interface IncomingMessage {
  externalMessageId: string    // Platform-specific ID (Telegram update_id, Slack message ts)
  text: string
  chatId: string               // Telegram chat_id or Slack channel_id
  userId: string               // Telegram user_id or Slack user_id
  files?: { name: string; url: string; mimeType?: string }[]
  timestamp: Date
}

export interface OutgoingMessage {
  text: string
  parseMode?: 'html' | 'markdown'
  replyToExternalId?: string
  card?: UserRequestEvent        // Same discriminated union used by SSE broadcasts
}

export abstract class ChatClientConnector {
  abstract readonly provider: 'telegram' | 'slack'

  /** Establish connection (long-poll loop / WebSocket). Resolves once healthy. */
  abstract connect(): Promise<void>

  /** Tear down connection gracefully. */
  abstract disconnect(): Promise<void>

  /** Send a text message (final, complete). */
  abstract sendMessage(chatId: string, message: OutgoingMessage): Promise<string>

  /**
   * Streaming: send or update a "draft" message with partial content.
   * Returns the external message ID to use for subsequent updates.
   * First call creates the message; subsequent calls edit it.
   */
  abstract sendStreamingUpdate(chatId: string, text: string, existingMessageId?: string): Promise<string>

  /** Finalize a streaming message (optional cleanup). */
  abstract finalizeStreamingMessage(chatId: string, messageId: string, finalText: string): Promise<void>

  /** Show typing / processing indicator. */
  abstract showTypingIndicator(chatId: string): Promise<void>

  /**
   * Send a rich card for user-request items.
   * The event is the same UserRequestEvent discriminated union used by SSE —
   * each connector pattern-matches on event.type and renders natively.
   */
  abstract sendUserRequestCard(chatId: string, event: UserRequestEvent): Promise<string>

  /** Handle a user response to an interactive card (button click, text reply). */
  abstract onInteractiveResponse?: (callback: (toolUseId: string, response: unknown) => void) => void

  /** Whether the connection is healthy right now. */
  abstract isConnected(): boolean
}
```

### 1.3 Why These Method Signatures

- **`sendStreamingUpdate` + `finalizeStreamingMessage`**: Both Telegram and Slack require a "send placeholder → edit with accumulated text" flow. The method pair captures this: the first call posts a "Thinking..." message, later calls edit it, and `finalize` does the last edit (important for Telegram where editing with identical text throws an error).
- **`sendUserRequestCard(event: UserRequestEvent)`**: The event is the exact same discriminated union that `MessagePersister` already broadcasts over SSE. No translation layer, no new types — the chat integration manager receives SSE events and passes them straight through. Each connector pattern-matches on `event.type` and renders natively (Slack Block Kit, Telegram inline keyboards, etc.).
- **`onInteractiveResponse`**: Slack button clicks and Telegram `callback_query` events both need to resolve the pending `InputManager` request. The callback-based design lets the manager wire this up without knowing provider internals.

---

## 2. ChatIntegrationManager — Global Lifecycle

### 2.1 File Location & Singleton Pattern

Place in `src/shared/lib/chat-integrations/chat-integration-manager.ts`. Follow the `TaskScheduler` singleton pattern (globalThis for HMR persistence):

```ts
class ChatIntegrationManager {
  private connectors: Map<string, { connector: ChatClientConnector; integrationId: string; sessionId: string }> = new Map()
  private isRunning = false

  async start(): Promise<void> { /* load all active integrations from DB, call connect() */ }
  stop(): void { /* disconnect all, clear map */ }
  async addIntegration(id: string): Promise<void> { /* load from DB, connect, subscribe */ }
  async removeIntegration(id: string): Promise<void> { /* disconnect, unsubscribe */ }
  async pauseIntegration(id: string): Promise<void> { /* disconnect, update DB status */ }
  async resumeIntegration(id: string): Promise<void> { /* load from DB, reconnect */ }
}

const globalForManager = globalThis as unknown as { chatIntegrationManager: ChatIntegrationManager | undefined }
export const chatIntegrationManager = globalForManager.chatIntegrationManager ?? new ChatIntegrationManager()
if (process.env.NODE_ENV !== 'production') { globalForManager.chatIntegrationManager = chatIntegrationManager }
```

### 2.2 Startup / Shutdown Integration

In `src/shared/lib/startup.ts`:
- `initializeServices()`: Add `chatIntegrationManager.start()` after `taskScheduler.start()` (non-blocking `.catch()`)
- `shutdownServices()`: Add `chatIntegrationManager.stop()` before `containerManager.stopAll()`

### 2.3 Message Flow: External Chat → Agent

```
User sends message in Telegram/Slack
  → ChatClientConnector receives via long-poll / WebSocket
  → ChatIntegrationManager.handleIncomingMessage(integrationId, incomingMessage)
      → containerManager.ensureRunning(agentSlug)
      → client.sendMessage(sessionId, text)
      → messagePersister.subscribeToSession(sessionId, ...) // if not already subscribed
```

### 2.4 Message Flow: Agent → External Chat

Subscribe to the session's SSE broadcast in `MessagePersister` by calling `messagePersister.addSSEClient(sessionId, callback)`. The callback processes SDK stream events:

```
MessagePersister SSE callback fires
  → ChatIntegrationManager.handleOutgoingEvent(integrationId, sseEvent)
      → Filter by event type:
        • 'stream_delta' → connector.sendStreamingUpdate(chatId, accumulatedText, lastMsgId)
        • 'stream_end' → connector.finalizeStreamingMessage(chatId, lastMsgId, fullText)
        • tool_use detected (via message transform) → if showToolCalls, format compacted card
        • user-input tool detected → connector.sendUserRequestCard(chatId, card)
        • 'session_idle' → optional: send "Agent finished" status message
```

### 2.5 User Request Item Forwarding

After the prep refactor (§1.1), the `MessagePersister` already broadcasts typed `UserRequestEvent` objects over SSE. The `ChatIntegrationManager` subscribes via `messagePersister.addSSEClient(sessionId, callback)` and receives these events directly — **no detection or parsing needed**, just forward:

```ts
handleSSEEvent(integrationId: string, event: unknown) {
  const data = event as { type: string }

  // User request events — pass straight through to the connector
  if (['question', 'secret_request', 'file_request', 'file_delivery', 'approval'].includes(data.type)) {
    const connector = this.connectors.get(integrationId)
    connector.sendUserRequestCard(chatId, data as UserRequestEvent)
    return
  }

  // Tool status events (compacted view, when showToolCalls is enabled)
  if (data.type === 'tool_status') {
    // Already a UserRequestEvent variant — forward as-is
    connector.sendUserRequestCard(chatId, data as UserRequestEvent)
    return
  }

  // Streaming text, session lifecycle, etc. — handled elsewhere
}
```

The `tool_status` variant of `UserRequestEvent` needs to be **emitted** by the manager itself when it sees tool_use content blocks in the stream (since MessagePersister doesn't currently broadcast tool summaries as distinct events). Use `getToolDefinition(name)?.getSummary(input)` from `@shared/lib/tool-definitions/registry` and `formatToolName(name)` from `@shared/lib/tool-definitions/types` — both are already extracted and tested.

### 7.2 Response Resolution

When the user responds in the external chat (text reply or button click):
1. The connector fires the `onInteractiveResponse` callback with `toolUseId` and the response value
2. The manager pattern-matches on the original event type to call the correct resolution endpoint:
   - **Questions**: `POST /api/agents/:slug/sessions/:sid/messages` with the answer text
   - **Secrets**: `POST /api/agents/:slug/sessions/:sid/provide-secret` with `{ toolUseId, value }`
   - **Files**: `POST /api/agents/:slug/sessions/:sid/provide-file` with multipart upload
   - **Approvals**: Resolve via container endpoint `POST /inputs/:toolUseId/resolve`

### 7.3 Tool Definitions (already extracted — see §1.1)

All tool types, `parseInput`, `getSummary`, `formatToolName`, and `getToolDefinition` are in `src/shared/lib/tool-definitions/`. When building chat integrations, add a `toChatCard()` method to each definition file — it will live alongside the type and summary it belongs with.

---

## 3. Database Schema

### 3.1 New Table: `chat_integrations`

Add to `src/shared/lib/db/schema.ts`:

```ts
export const chatIntegrations = sqliteTable('chat_integrations', {
  id: text('id').primaryKey(),
  agentSlug: text('agent_slug').notNull(),
  provider: text('provider', { enum: ['telegram', 'slack'] }).notNull(),
  name: text('name'),  // User-defined label

  // Provider credentials (encrypted or stored as-is — see Risk §R3)
  config: text('config').notNull(),  // JSON: { botToken, chatId } or { botToken, appToken, channelId }

  // Session binding
  currentSessionId: text('current_session_id'),  // Active session ID (null if none yet)

  // Behavior settings
  showToolCalls: integer('show_tool_calls', { mode: 'boolean' }).notNull().default(false),

  // Status
  status: text('status', { enum: ['active', 'paused', 'error', 'disconnected'] })
    .notNull().default('active'),
  errorMessage: text('error_message'),

  // Ownership (auth mode)
  createdByUserId: text('created_by_user_id'),

  // Timestamps
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => ({
  agentSlugIdx: index('chat_integrations_agent_slug_idx').on(table.agentSlug),
  statusIdx: index('chat_integrations_status_idx').on(table.status),
}))
```

### 3.2 Migration

Create a new migration file under `/migrations/` (follow the existing numeric naming pattern). The migration is a simple `CREATE TABLE` — no data transformation needed.

---

## 4. Telegram Integration — Technical Details

### 4.1 Library Choice: **grammY**

Use `grammy` (npm). Rationale:
- First-class TypeScript (designed for it, unlike telegraf's retrofitted types)
- `bot.start()` handles long-polling with automatic offset tracking and reconnection
- `bot.stop()` integrates cleanly with Electron shutdown lifecycle
- Active maintenance, fastest to adopt new Bot API features
- Supports `sendMessageDraft` (Bot API 9.3+) for native streaming if available

### 4.2 Long Polling Configuration

```ts
// In TelegramConnector.connect():
this.bot = new Bot(this.config.botToken)

this.bot.on('message:text', (ctx) => this.handleIncomingMessage(ctx))
this.bot.on('callback_query:data', (ctx) => this.handleCallbackQuery(ctx))

// grammY handles offset tracking, timeout defaults to 30s
await this.bot.start({
  allowed_updates: ['message', 'callback_query'],
  drop_pending_updates: false,  // Process queued messages on startup (spec requirement: chain them)
})
```

**30-second timeout** is the standard. grammY manages this internally.

### 4.3 Streaming Strategy

**Primary (Bot API 9.3+, March 2026)**: Use `sendMessageDraft` for flicker-free progressive rendering:
```
draft("Thinking...") → draft(partial1) → draft(partial2) → ... → sendMessage(final)
```

**Fallback**: `sendMessage` → repeated `editMessageText` with 1-second throttle:
- Must track `message_id` from the initial send
- Must check that text actually changed before editing (Telegram returns `Bad Request: message is not modified` otherwise)
- Throttle to ~1 edit/second to stay within rate limits

### 4.4 On-Startup Multi-Message Handling

When `drop_pending_updates` is `false`, grammY delivers all queued updates on first `getUpdates`. The spec says to chain these into one agent message:

```ts
private pendingFirstPollMessages: Map<string, { texts: string[]; timer: NodeJS.Timeout }> = new Map()

handleIncomingMessage(ctx) {
  const chatId = String(ctx.chat.id)
  if (!this.hasCompletedFirstPoll) {
    // Buffer messages during first poll, flush after 500ms of no new messages
    const pending = this.pendingFirstPollMessages.get(chatId) || { texts: [], timer: null }
    pending.texts.push(ctx.message.text)
    clearTimeout(pending.timer)
    pending.timer = setTimeout(() => {
      const combined = pending.texts.join('\n\n---\n\n')
      this.emit('message', { chatId, text: combined, ... })
      this.pendingFirstPollMessages.delete(chatId)
    }, 500)
    this.pendingFirstPollMessages.set(chatId, pending)
    return
  }
  // Normal flow: forward immediately
  this.emit('message', { chatId, text: ctx.message.text, ... })
}
```

### 4.5 User Request Cards (Telegram)

**Questions** → Inline keyboard with one button per option:
```ts
await bot.api.sendMessage(chatId, `🤖 The agent needs your input:\n\n${questions.map((q, i) => `${i+1}. ${q}`).join('\n')}`, {
  parse_mode: 'HTML',
  reply_markup: { inline_keyboard: questions.map(q => [{ text: q, callback_data: `answer:${toolUseId}:${q}` }]) }
})
```

**Approvals** → Two-button confirm/deny:
```ts
reply_markup: { inline_keyboard: [[
  { text: '✅ Approve', callback_data: `approve:${toolUseId}` },
  { text: '❌ Deny', callback_data: `deny:${toolUseId}` },
]] }
```

**File Delivery** → Send file via `sendDocument`:
```ts
await bot.api.sendDocument(chatId, new InputFile(filePath), { caption: 'Agent delivered a file' })
```

**File Request** → Text prompt asking user to upload; handle `message:document` event to resolve.

**Secret Request** → Text prompt; the next text message from the user resolves it.

**callback_data limit**: 64 bytes max. Use short keys like `a:${toolUseId.slice(0,8)}` and maintain a lookup map for full IDs.

### 4.6 Telegram Rate Limits & Mitigations

| Limit | Value | Mitigation |
|---|---|---|
| Per-chat send | ~1 msg/sec | Throttle streaming edits to 1/sec |
| Global send | ~30 msg/sec | Unlikely to hit with single-user bot |
| `editMessageText` | Same as send | Always check text changed before editing |
| Message length | 4096 chars | Split long messages at paragraph boundaries |
| `callback_data` | 64 bytes | Use short encoded keys + lookup map |

### 4.7 Telegram Markup Recommendation

Use **HTML parse mode**, not MarkdownV2. MarkdownV2 requires escaping 18+ special characters and is extremely fragile with dynamic content. HTML only needs `<`, `>`, `&` escaped.

### 4.8 BotFather Setup Instructions (for Settings UI)

Display these steps in the "Chat Integrations" settings tab when user selects Telegram:
1. Open Telegram, search for `@BotFather`
2. Send `/newbot`, choose a display name and username (must end with `bot`)
3. Copy the **Bot Token** (format: `123456789:ABCdefGHI...`)
4. Paste it below
5. Open a chat with your new bot and send `/start` (to establish a chat ID)

After pasting the token, the app should call `getMe()` to validate it and display the bot's username as confirmation.

---

## 5. Slack Integration — Technical Details

### 5.1 Key Technology: Socket Mode

Socket Mode uses WebSocket instead of webhooks — exactly what we need for Electron. The app opens a WebSocket connection to Slack via `apps.connections.open`, and Slack pushes all events through it.

### 5.2 Library: `@slack/bolt`

Use `@slack/bolt` with Socket Mode. It handles WebSocket connection lifecycle, reconnection, and envelope acknowledgment.

```ts
import { App as SlackApp } from '@slack/bolt'

this.slackApp = new SlackApp({
  token: this.config.botToken,       // xoxb-...
  appToken: this.config.appToken,    // xapp-...
  socketMode: true,
})

this.slackApp.message(async ({ message, say }) => {
  if (message.subtype) return  // skip edits, bot messages, etc.
  this.emit('message', { chatId: message.channel, text: message.text, ... })
})

this.slackApp.action(/^(approve|deny|answer):/, async ({ ack, action, body }) => {
  await ack()  // MUST ack within 3 seconds
  this.handleInteractiveAction(action, body)
})

await this.slackApp.start()
```

### 5.3 Tokens Required

| Token | Prefix | Purpose | How to get |
|---|---|---|---|
| Bot Token | `xoxb-` | Call Web API (send messages, upload files) | OAuth & Permissions → Install to Workspace |
| App-Level Token | `xapp-` | Establish Socket Mode WebSocket | Basic Information → App-Level Tokens → `connections:write` scope |

### 5.4 Required Scopes

Bot Token Scopes: `chat:write`, `app_mentions:read`, `channels:read`, `im:history`, `im:read`, `im:write`, `files:read`, `files:write`, `reactions:write`

Event Subscriptions: `message.im` (DMs to bot), `app_mention` (optional)

### 5.5 Streaming Strategy

Post-then-update with throttled `chat.update`:

```ts
// Post initial "thinking" message
const initial = await this.slackApp.client.chat.postMessage({
  channel: channelId,
  text: ':hourglass_flowing_sand: Thinking...',
})

// Update every ~1.5 seconds with accumulated text
let lastUpdate = 0
for await (const chunk of agentStream) {
  accumulated += chunk
  if (Date.now() - lastUpdate > 1500) {
    await this.slackApp.client.chat.update({
      channel: channelId, ts: initial.ts, text: accumulated,
    })
    lastUpdate = Date.now()
  }
}

// Final update
await this.slackApp.client.chat.update({
  channel: channelId, ts: initial.ts, text: accumulated,
})
```

### 5.6 Typing Indicator

Slack does **NOT** support typing indicators for bots. Workarounds:
1. **Emoji reaction** (fast, lightweight): Add `:thinking_face:` reaction to the user's message while processing, remove when done
2. **"Thinking..." placeholder message**: Already handled by the streaming flow above
3. **Combine both**: React immediately, then post the thinking message, then stream updates

### 5.7 User Request Cards (Slack Block Kit)

**Questions** → Section + Buttons:
```ts
blocks: [
  { type: 'section', text: { type: 'mrkdwn', text: '*The agent needs your input:*' } },
  { type: 'actions', elements: questions.map((q, i) => ({
    type: 'button', text: { type: 'plain_text', text: q },
    action_id: `answer:${toolUseId}:${i}`, value: q,
  })) },
]
```

**Approvals** → Primary/Danger button pair:
```ts
{ type: 'actions', elements: [
  { type: 'button', text: { type: 'plain_text', text: 'Approve' }, style: 'primary', action_id: `approve:${toolUseId}` },
  { type: 'button', text: { type: 'plain_text', text: 'Deny' }, style: 'danger', action_id: `deny:${toolUseId}` },
] }
```

**File Delivery** → Upload via `files.uploadV2`:
```ts
await this.slackApp.client.files.uploadV2({
  channel_id: channelId,
  file: Buffer.from(fileContent),
  filename: 'report.pdf',
  initial_comment: 'Agent delivered a file',
})
```

**File Request** → Prompt message; handle `message` event with `files` array to resolve.

**Secret Request** → Ephemeral message (only visible to requester) asking for the value.

### 5.8 Slack Rate Limits & Mitigations

| API Method | Tier | Limit | Mitigation |
|---|---|---|---|
| `chat.postMessage` | Special | 1/sec/channel | Queue messages per channel |
| `chat.update` | Tier 3 | ~50/min | Throttle streaming to 1.5s intervals |
| `reactions.add` | Tier 2 | ~20/min | Unlikely to hit |
| `files.uploadV2` | Tier 2 | ~20/min | Unlikely to hit for file delivery |

### 5.9 Slack App Setup Instructions (for Settings UI)

1. Go to **api.slack.com/apps** → "Create New App" → "From scratch"
2. Enable **Socket Mode** (Settings → Socket Mode → ON)
3. Generate **App-Level Token** (Basic Information → App-Level Tokens → add `connections:write` scope)
4. Set **Bot Token Scopes** (OAuth & Permissions → add scopes listed above)
5. **Subscribe to events** (Event Subscriptions → ON → add `message.im`, `app_mention`)
6. Enable **Interactivity** (Interactivity & Shortcuts → ON)
7. **Install to Workspace** → copy the `xoxb-` Bot Token

After pasting both tokens, the app should call `auth.test` to validate and display the bot name + workspace.

---

## 6. Integration into the Existing App

### 6.1 Settings Tab

**File**: New `src/renderer/components/agents/settings/chat-integrations-tab.tsx`

**Registration** in `agent-settings-dialog.tsx` (after "MCPs" tab, line ~121):
```tsx
import { MessageCircle } from 'lucide-react'
import { ChatIntegrationsTab } from './settings/chat-integrations-tab'

<SettingsDialogTab id="chat-integrations" label="Chat" icon={<MessageCircle className="h-4 w-4" />}>
  <ChatIntegrationsTab agentSlug={agent.slug} />
</SettingsDialogTab>
```

**Tab UI**:
- List existing integrations (name, provider icon, status badge, connected session info)
- "Add Integration" button → opens provider selection (Telegram / Slack)
- Per-integration: setup instructions, credential inputs, toggle for `showToolCalls`
- Each integration row: pause/resume, delete, edit credentials, view connected session

**Permission model**: Follow existing pattern — wrap with `inert` attribute when `isAuthMode && !isOwner`. Viewers can see integrations but not modify.

### 6.2 Sidebar Navigation

Add a `ChatIntegrationsGroup` / `ChatIntegrationSubItem` in `app-sidebar.tsx`, following the exact same pattern as `WebhookTriggersGroup` / `WebhookTriggerSubItem` (lines 237-341):

- Icon: `<MessageCircle className="h-3 w-3" />` (or provider-specific icons)
- Click behavior: `selectChatIntegration(integrationId)` → selects the integration's `currentSessionId` and displays the session thread with the send box disabled
- Status indicator: green dot for active, yellow for paused, red for error
- Group behavior: if >1 integration, show collapsible group; if exactly 1, show inline

### 6.3 Selection Context

In `src/renderer/context/selection-context.tsx`, add:
```ts
selectedChatIntegrationId: string | null
selectChatIntegration: (id: string | null) => void
handleChatIntegrationDeleted: (id: string) => void
```

Follow the mutual-exclusion pattern: selecting a chat integration clears session/task/trigger/dashboard selections.

### 6.4 Main Content Area

When a chat integration is selected, render the session thread (using the existing `SessionView` component) with these modifications:
- **Send box disabled** (read-only view of the external chat session)
- **Banner at top**: "This session is controlled from [Telegram/Slack]. Messages can only be sent from the connected chat."
- **Integration status badge**: Shows connection health

### 6.5 API Routes

New route file: `src/api/routes/chat-integrations.ts`, mounted as `app.route('/api/chat-integrations', chatIntegrations)` in `src/api/index.ts`.

Endpoints:
- `GET /api/chat-integrations?agentSlug=X` — list integrations for agent
- `POST /api/chat-integrations` — create integration (validates credentials inline)
- `PATCH /api/chat-integrations/:id` — update settings / pause / resume
- `DELETE /api/chat-integrations/:id` — remove integration
- `POST /api/chat-integrations/:id/test` — validate credentials without saving
- `GET /api/chat-integrations/:id/status` — real-time connection health

### 6.6 React Query Hooks

New file: `src/renderer/hooks/use-chat-integrations.ts`
- `useChatIntegrations(agentSlug)` — list integrations
- `useChatIntegration(id)` — single integration
- `useCreateChatIntegration()`
- `useUpdateChatIntegration()`
- `useDeleteChatIntegration()`
- `useTestChatIntegrationCredentials()`

Follow the existing hook patterns in `use-scheduled-tasks.ts` and `use-webhook-triggers.ts`.

### 6.7 Notification Types

Add to the `notifications` table enum: `'session_chat_integration'`. Trigger notifications when:
- Chat integration connects/disconnects
- Integration encounters an error
- User sends a message via external chat (for other viewers in auth mode)

---

## 7. User Request Item Interception

### 7.1 Detection Strategy

The `MessagePersister` SSE stream already broadcasts all SDK messages. The `ChatIntegrationManager` subscribes via `messagePersister.addSSEClient(sessionId, callback)` and processes events:

```ts
handleSSEEvent(integrationId: string, event: unknown) {
  const data = event as any

  // Tool use detection (from raw stream)
  if (data.type === 'message' && data.content?.type === 'tool_use') {
    const toolName = data.content.name
    const toolInput = data.content.input
    const toolUseId = data.content.id

    switch (toolName) {
      case 'AskUserQuestion':
        this.forwardUserRequest(integrationId, {
          type: 'question', toolUseId,
          metadata: { questions: toolInput.questions },
        })
        break
      case 'mcp__user-input__request_secret':
        this.forwardUserRequest(integrationId, {
          type: 'secret_request', toolUseId,
          metadata: { secretName: toolInput.secretName, reason: toolInput.reason },
        })
        break
      case 'mcp__user-input__request_file':
        this.forwardUserRequest(integrationId, {
          type: 'file_request', toolUseId,
          metadata: { fileType: toolInput.fileType },
        })
        break
      case 'mcp__user-input__deliver_file':
        this.forwardUserRequest(integrationId, {
          type: 'file_delivery', toolUseId,
          metadata: { filePath: toolInput.filePath },
        })
        break
    }
  }
}
```

### 7.2 Response Resolution

When the user responds in the external chat (text reply or button click):
1. The connector fires the `onInteractiveResponse` callback with `toolUseId` and the response value
2. The manager calls the appropriate API endpoint to resolve:
   - **Questions**: `POST /api/agents/:slug/sessions/:sid/messages` with the answer text (SDK handles it as a normal user message, since AskUserQuestion blocks via `canUseTool`)
   - **Secrets**: `POST /api/agents/:slug/sessions/:sid/provide-secret` with `{ toolUseId, value }`
   - **Files**: `POST /api/agents/:slug/sessions/:sid/provide-file` with multipart upload
   - **Approvals**: Resolve via container endpoint `POST /inputs/:toolUseId/resolve`

### 7.3 Tool Call Compact View

For non-user-input tool calls (when `showToolCalls` is enabled), send a formatted single-line status:

**Telegram (HTML)**:
```html
🔧 <b>Read File</b> — <code>src/index.ts</code> ✅
🔧 <b>Edit File</b> — <code>src/app.ts:42</code> ⏳
```

**Slack (mrkdwn)**:
```
🔧 *Read File* — `src/index.ts` :white_check_mark:
🔧 *Edit File* — `src/app.ts:42` :hourglass:
```

Reuse the `formatToolName()` function from `src/renderer/components/messages/tool-call-item.tsx:14` for consistent naming. The `getSummary()` method from tool renderers (in `src/renderer/components/messages/tool-renderers/index.ts`) can provide the one-line summary — extract these to a shared utility so they can be used from the backend.

---

## 8. Testing Harness

### 8.1 MockChatClientConnector

Create `src/shared/lib/chat-integrations/mock-connector.ts`:

```ts
import type { UserRequestEvent } from '@shared/lib/tool-definitions/types'

export class MockChatClientConnector extends ChatClientConnector {
  readonly provider = 'mock' as any
  
  sentMessages: OutgoingMessage[] = []
  sentEvents: UserRequestEvent[] = []          // Same type as SSE broadcasts
  streamUpdates: { chatId: string; text: string; messageId?: string }[] = []
  
  private messageHandlers: ((msg: IncomingMessage) => void)[] = []
  private interactiveHandlers: ((toolUseId: string, response: unknown) => void)[] = []
  
  // Simulate incoming message from "user"
  simulateIncomingMessage(text: string, chatId = 'mock-chat-1') { ... }
  
  // Simulate button click / interactive response
  simulateInteractiveResponse(toolUseId: string, response: unknown) { ... }
  
  // Assertions — typed against the shared union
  getLastSentMessage(): OutgoingMessage | undefined { ... }
  getLastSentEvent(): UserRequestEvent | undefined { ... }
  getEventsOfType<T extends UserRequestEvent['type']>(type: T): Extract<UserRequestEvent, { type: T }>[] { ... }
  getSentMessageCount(): number { ... }
  
  // Interface implementation (record calls for assertions)
  async connect() { this.connected = true }
  async disconnect() { this.connected = false }
  async sendMessage(chatId, msg) { this.sentMessages.push(msg); return 'mock-msg-id' }
  async sendStreamingUpdate(chatId, text, existingId?) { ... }
  async sendUserRequestCard(chatId, event) { this.sentEvents.push(event); return 'mock-card-id' }
  async showTypingIndicator() { /* no-op */ }
  // ...
}
```

### 8.2 Test Categories

1. **Unit tests** — `ChatIntegrationManager` logic (start/stop/add/remove, message routing)
2. **Unit tests** — Each connector in isolation (TelegramConnector, SlackConnector) using mocked APIs
3. **Integration tests** — Full flow with `MockChatClientConnector`:
   - User sends message → agent receives → agent responds → mock receives response
   - Agent asks question → mock receives card → mock simulates answer → agent continues
   - Agent requests secret → mock receives prompt → mock provides value → agent uses it
   - Agent delivers file → mock receives file
   - Streaming: verify throttled updates arrive in order
4. **E2E tests** — Using the existing Playwright harness with `E2E_MOCK=true`:
   - Create integration via settings UI
   - Verify sidebar shows integration
   - Verify session thread displays correctly (read-only)
   - Delete integration, verify cleanup

### 8.3 Piping E2E Output

Per CLAUDE.md: `E2E_MOCK=true npx playwright test 2>&1 | tee /tmp/e2e-results.txt`

---

## 9. Risks & Mitigations

### R1: Long-polling / WebSocket stability in long-running Electron process

**Risk**: Telegram long-polling or Slack Socket Mode connections may drop silently over hours/days without proper detection, leaving integrations appearing "active" but actually dead.

**Mitigation**:
- **Telegram**: grammY handles reconnection automatically. Add a heartbeat check: if no `getUpdates` response in 60s, force-reconnect. Log all connection state transitions.
- **Slack**: Bolt SDK handles WebSocket reconnection. Monitor `apps.connections.open` failures. Add a periodic `auth.test` call (every 5 min) as a health check.
- **Both**: Expose connection health via the `GET /api/chat-integrations/:id/status` endpoint. Show status in sidebar icon and settings tab. If disconnected for >5 minutes, set status to `'error'` in DB and notify user.

### R2: Rate limiting during streaming

**Risk**: Rapid message edits during agent streaming can trigger rate limits (Telegram: ~1/sec, Slack: `chat.update` ~50/min), causing message delivery failures or temporary bans.

**Mitigation**:
- Telegram: Throttle `editMessageText` to 1 call/sec minimum. Use `sendMessageDraft` (Bot API 9.3+) where available — it's designed for higher-frequency updates.
- Slack: Throttle `chat.update` to 1 call/1.5sec. Buffer accumulated text and only send diffs.
- Both: Implement exponential backoff on 429 responses. Queue edits and drop intermediate ones (only the latest accumulated text matters).

### R3: Credential storage security

**Risk**: Bot tokens stored in plaintext in SQLite could be exposed if the database file is accessed directly.

**Mitigation**:
Acceptable risk for this version.

### R4: Session lifecycle mismatch

**Risk**: The integration's `currentSessionId` points to a session that has been deleted, or the agent container has stopped. Incoming messages would fail silently.

**Mitigation**:
- On every incoming message, verify:
  1. Agent exists (`agentExists(agentSlug)`)
  2. Container is running (`containerManager.ensureRunning()` — starts it if needed)
  3. Session exists and is valid
- If session is invalid, auto-create a new one (similar to how `TaskScheduler.executeTask()` works) and update `currentSessionId` in DB.
- Send a status message to the external chat: "Starting a new session..."

### R5: Concurrent message handling

**Risk**: If the user sends multiple rapid messages in Telegram/Slack before the agent responds, they could race with each other or cause the agent to process them out of order.

**Mitigation**:
- Implement a per-integration message queue with serial processing. Each incoming message is queued and only sent to the agent after the previous one's `sendMessage()` resolves.
- For the first-poll batch case (Telegram), concatenate as specified. For rapid subsequent messages, queue them.

### R6: Auth mode permission enforcement

**Risk**: In auth mode, a `viewer` or `user` role could potentially manage integrations they shouldn't have access to, or integrations could leak data across users.

**Mitigation**:
- API routes must check `canAdminAgent(agentSlug)` for create/update/delete operations (same as all other settings).
- Read operations: all roles can view integrations (consistent with viewing scheduled tasks/triggers).
- Store `createdByUserId` for audit trail.
- The `agentAcl` check already protects the underlying agent — an integration inherits its agent's ACL.

### R7: Large message handling

**Risk**: Agent responses can be very long (multi-page code, etc.). Telegram has a 4096-char limit; Slack has practical limits around 4000 chars for text and 3000 per section block.

**Mitigation**:
- Implement message splitting: break at paragraph/newline boundaries when approaching limits.
- Telegram: Split into multiple `sendMessage` calls with a 1-second delay between them.
- Slack: Use Block Kit with multiple section blocks if needed, falling back to multiple messages if block limits are exceeded.
- For very long outputs (>10K chars): send the first chunk inline, then upload the full output as a file attachment.

### R8: Electron shutdown ordering

**Risk**: If `chatIntegrationManager.stop()` is called after `containerManager.stopAll()`, in-flight message resolution (e.g., pending secret request) could fail because the container is already gone.

**Mitigation**:
- Stop chat integrations **before** stopping containers in `shutdownServices()`.
- In the disconnect flow, don't try to resolve pending requests — just drop them. The container will handle cleanup.
- Match the existing pattern: `reviewManager.rejectAll()` is called first in shutdown.

### R9: Verifying credentials before saving

**Risk**: User enters invalid tokens → integration is created in DB → manager tries to connect → immediate failure → poor UX.

**Mitigation**:
- The `POST /api/chat-integrations/:id/test` endpoint validates credentials before saving:
  - Telegram: call `getMe()` with the token, verify response
  - Slack: call `auth.test` with bot token, call `apps.connections.open` with app token
- Only persist to DB after validation passes.
- Show bot identity (name, avatar) in the UI as confirmation.

### R10: Memory leaks from SSE subscriptions

**Risk**: Each active integration holds an SSE subscription via `messagePersister.addSSEClient()`. If integrations are created/deleted frequently without proper cleanup, callbacks accumulate.

**Mitigation**:
- `addSSEClient` returns an `unsubscribe` function — the manager must store and call it on disconnect/delete.
- In `ChatIntegrationManager.stop()`, iterate all connectors and unsubscribe before clearing the map.
- Add a periodic check: if a connector's session no longer exists, auto-unsubscribe.

### R11: File handling complexity

**Risk**: File request/delivery requires transferring files between the agent container filesystem and the external chat platform, which adds complexity (file size limits, format restrictions, container mount paths).

**Mitigation**:
- **Telegram file limits**: 50 MB upload, 20 MB download (standard API). For larger files, return an error message to the chat.
- **Slack file limits**: Use `files.uploadV2` (the v1 `files.upload` is deprecated). Standard upload limits apply.
- **Container → external**: The delivered file path is inside the container. Use the existing `ContainerClient.fetch()` to read the file, then upload to the platform.
- **External → container**: Download from platform API, write to the container workspace via `ContainerClient.fetch('PUT /workspace/files/...')` or equivalent.
- Phase this out of v1 if too complex — start with text-only and add file support in a follow-up.


# Stages:

1. Prep refactor (§1.1) — Extract shared UserRequestEvent types + formatToolName/getSummary to shared utils. Mechanical, low-risk, reviewable independently. Pays off even without the rest of the feature.
2. Core infrastructure — DB schema/migration, ChatIntegrationManager skeleton, API routes, React Query hooks, ChatClientConnector base class, mock connector.
3. Telegram connector — First real provider. Validates the full loop end-to-end: incoming messages, streaming responses, user request cards, interactive responses.
4. UI — Settings tab, sidebar navigation, selection context, read-only session view.
5. Slack connector — Second provider. Should slot in cleanly if the abstractions held up with Telegram.
6. Polish — File handling (or defer), message splitting edge cases, credential encryption.