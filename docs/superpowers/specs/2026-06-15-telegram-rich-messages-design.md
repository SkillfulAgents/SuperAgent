# Telegram Rich Messages — Design Spec

- Date: 2026-06-15
- Branch: `feat/telegram-rich-messages`
- Status: Design approved + grilled. Ready for implementation plan.
- Linear: adopt Telegram Bot API 10.1 Rich Messages in the Telegram connector

## 1. Motivation

Telegram Bot API 10.1 (2026-06-11) shipped a **Rich Messages** system. Upstream
`grammY` support has landed: `grammy 1.44.0` / `@grammyjs/types 3.28.0`
(PRs `grammyjs/types#81` and `grammyjs/grammY#911`, both merged 2026-06-14). The
ticket's "blocked on upstream" status is **stale**.

Today the connector renders the agent's markdown into a limited Telegram HTML
subset via `markdownToTelegramHtml` (`src/shared/lib/chat-integrations/telegram-connector.ts:44-100`)
and sends with `{ parse_mode: 'HTML' }`, carrying a **monospace `<pre>` ASCII
table hack** (lines 61-82). Goal: upgrade outbound rendering to Rich Messages,
**uniformly across every outbound surface**, and delete the hack. The Telegram
connector delivers polished **end briefs / summaries** (final output), not agent
process — so this is a rendering upgrade, not a feature expansion.

## 2. Authoritative facts (primary sources)

Verified against the live spec (`core.telegram.org/bots/api`,
`#rich-message-formatting-options`) and `@grammyjs/types@3.28.0`.

### Input shape
`InputRichMessage` = exactly one of `html` | `markdown` (string), plus `is_rtl?`,
`skip_entity_detection?`. You pass a **markdown (or HTML) string**; Telegram parses
it server-side into `RichBlock*`. **No client-side block assembly.** The ~40
`RichBlock*` / `RichText*` classes are the *read* model, not the send model.

### Rich Markdown
- **"Compatible with GitHub Flavored Markdown where possible and can contain
  arbitrary HTML."** Agents already emit GFM, so the `markdown` field is a near
  pass-through.
- In-scope constructs map natively: pipe tables (`|:--|--:|` alignment), `#`..
  `######` headings, `-`/`*`/`+`/`1.`/`- [ ]` lists, fenced code, `>` blockquotes,
  `**bold** *italic* ~~strike~~ `code` [x](url)`, `==marked==`, `||spoiler||`.
- Entities (bare URLs, @mentions, #hashtags, $cashtags, /commands, emails, phone,
  bank-card numbers) auto-detected unless `skip_entity_detection: true`. Entities
  inside code spans are exempt.

### Limits (per rich message)
32768 UTF-8 chars; 500 blocks; 16 nesting levels; 50 media; **20 columns/table**;
table cells inline-only.

### Methods
- `sendRichMessage` — any bot, **any chat**, **not** business-gated, **accepts
  `reply_markup`**. Returns the sent `Message`. This is the canonical/persisting send.
- `sendRichMessageDraft` — **private chats only**, ephemeral **~30s preview**,
  whole-snapshot under a non-zero `draft_id` (same id → animated), returns `true`,
  **does not persist** (must finalize with `sendRichMessage`).
- `editMessageText` — gained `rich_message?` (mutually exclusive with `text`);
  edits a persisted rich message in place. Progressive-update mechanism for groups.
- `<tg-thinking>` (`RichBlockThinking`) — an animated **"Thinking…" placeholder**.
  **Draft-only** (can't appear in a persisted message). Carries no content; it is a
  loading indicator, not reasoning. Used here purely as a "working…" animation.

### Undocumented (do not assume)
- **Old-client degradation**: what a pre-10.1 client renders is undocumented; there
  is **no fallback/plain-text field** on `InputRichMessage`.
- How an incomplete block renders mid-stream (only "animated" is documented).
- **A bot cannot detect a recipient's client version** — the `User` object exposes
  no app/client-version field (verified). Per-recipient routing is impossible.

## 3. Scope

### In scope (v1)
- Render the agent's final markdown as Rich Messages on **every outbound body**
  (replies/briefs, request-card text, `tool_status`) by passing GFM markdown to
  `rich_message.markdown`. Delete the `<pre>` table hack.
- **Animated live streaming in DMs** via `sendRichMessageDraft` (behind a flag),
  including a `<tg-thinking>` "Thinking…" animation while the agent is working.
- Retain `markdownToTelegramHtml` as a switchable legacy fallback + automatic
  error-retry target.

### Out of scope / deferred
- `RichBlockThinking` as *reasoning content*, `RichBlockDetails`, math blocks — the
  "Thinking…" animation uses the empty placeholder only; no agent reasoning is shown.
- Changing interactive **mechanics** (inline keyboards, callback routing, the 64-byte
  `callback_data` workaround). Only message-*body* rendering changes. The 64-byte cap
  is a real Telegram limit, unrelated to rich messages, and is **not** removed.

## 4. Design

### 4.1 Entity detection (Q1)
Default `skip_entity_detection: false` (auto-detection ON — matches current behavior,
code spans exempt, gives clickable URLs/mentions). Expose as a config field so it can
be flipped if technical prose produces ugly false positives (cashtag/card/command).

### 4.2 Send + converter (Q2, Q5)
New module `src/shared/lib/chat-integrations/telegram-rich-message.ts`:
- `markdownToRichMessage(md: string): InputRichMessage` — returns `{ markdown: md }`
  for one message (passthrough; GFM-compatible). The sole place for any
  GFM↔Rich-Markdown normalization that testing surfaces (none assumed up front).
- `splitForRichLimits(md: string): string[]` — chunks bodies over **32768** chars on
  block/paragraph boundaries (mirrors today's 4096 split in `finalizeStreamingMessage`,
  at the 8× ceiling so it rarely fires). Char length is the only limit we measure
  ourselves.
- **Structural limits (500 blocks, 20 columns) are NOT pre-enforced** — that would
  require parsing markdown into blocks (the work we deleted). On overflow,
  `sendRichMessage` rejects → §4.5 error-retry resends via legacy HTML (no such limits).
- **Passthrough is pure**: raw `<`/`>`/`&` and inline HTML go straight to Telegram
  (only a safe tag whitelist is honored; no script execution). Stray-bracket
  mis-render is a pre-ship test; add minimal targeted escaping outside code spans
  **only if** it actually mis-renders.

### 4.3 Validation
New `telegram-rich-message-schema.ts`: Zod schema for `InputRichMessage`, `.parse()`d
at the send boundary (project convention: validate at boundaries).

### 4.4 Uniform rendering
All outbound bodies route through `markdownToRichMessage`. Request cards become
**rich body + existing inline keyboard** (`reply_markup` composes with `sendRichMessage`).
Callback routing untouched.

### 4.5 Fallback (Q3)
- `markdownToTelegramHtml` retained behind a **global config flag** (default rich).
  Flag = manual rollback switch (instant, no deploy). It is **not** a per-recipient
  degrade — that's impossible (no client-version detection).
- **Automatic error-retry**: wrap every rich send; on throw, log + resend that message
  via the legacy `parse_mode: 'HTML'` path. Covers malformed payloads / structural-limit
  rejections on a young API. Does **not** cover old-client rendering (that throws no
  error; it's Telegram's server-side concern, accepted as an untrappable tail risk).

### 4.6 Streaming — chat-type-aware (Q4, Q7)
Two paths, selected by chat type. The connector picks based on `ctx.chat.type` /
`chat_id` sign.

**Private chats (DM) — animated draft path. Behind `richDraftStreaming` flag (default ON).**
1. **Thinking phase** (agent working, no reply text yet, or a mid-stream gap during a
   tool call): send a draft containing a `<tg-thinking>` "Thinking…" animation. The
   1/sec throttle re-send keeps the ephemeral 30s preview alive; during long gaps the
   "Thinking…" animation is what shows (replaces a content keep-alive).
2. **Streaming phase**: each throttle tick (`>= 1000ms`, per `chat-integration-manager.ts:1212`),
   `sendRichMessageDraft(chat_id, draft_id, { markdown: accumulatedText })`; reusing the
   same non-zero `draft_id` animates the diff.
3. **Finalize**: `sendRichMessage(chat_id, { markdown: finalText })` to persist. The
   draft never persists; the real message is this final send.
- State: drafts return `true` (no `message_id` mid-stream); the persisted `message_id`
  exists only after finalize. The connector tracks `draft_id` internally, decoupled from
  the manager's `currentMessageId`.

**Groups/channels — edit path. Also the DM fallback when the flag is OFF.**
1. **Thinking phase**: existing `sendChatAction('typing')` indicator.
2. **Streaming**: first `sendRichMessage` to create the message, then `editMessageText`
   + `rich_message` at each throttle tick (Q4 option **A**, default). The streaming
   renderer is a **one-line constant**; option **B** (stream via legacy HTML, finalize
   rich) is the one-line fallback if pre-ship shows partial-rich edits flicker.
3. **Finalize**: final `editMessageText` + `rich_message`.

### 4.7 Dependency bump
`package.json`: `grammy ^1.42.0` → `^1.44.0` (pulls `@grammyjs/types 3.28.0`
transitively). `npm install` in the worktree (no `node_modules` present yet).

## 5. Testing (Q6)
- **Golden corpus**: a set of **real agent briefs** (pulled from actual sessions, not
  synthetic) covering in-scope constructs — tables w/ alignment, nested inline, task
  lists, fenced code, headings, blockquotes, links, strikethrough, spoiler/highlight.
  Assert each converts + sends without throwing and yields the expected structure.
  Explicitly assert `#`→section-heading is intended (was bold in the legacy path).
- `telegram-rich-message.test.ts`: passthrough, 32768 block-boundary split, Zod accept/reject.
- Update `finalize-streaming.test.ts`: rich finalize; DM draft path (mock
  `sendRichMessageDraft` + `sendRichMessage`); group edit path; error-retry → legacy on throw.
- Keep `telegram-markdown.test.ts` (now the legacy fallback path).
- Optional later: a real-bot smoke test (needs a test token; not in CI v1).

## 6. Risks & pre-ship checks
1. **Old-client degradation** — undocumented, untrappable. Mitigation: penetration bet +
   global rollback flag. Best-effort test on an old build if reachable (likely impractical).
2. **Partial-rich rendering** — group edit path (A) re-renders incomplete markdown each
   tick. Pre-ship: stream a brief with a table, watch mid-stream render; flip to B if janky.
3. **Stray `<`/`>`/`&` in prose** — pre-ship: confirm `a < b`-style text renders; add
   minimal escaping only if needed.
4. **Structural-limit behavior** — pre-ship: send a >20-column table, confirm Telegram
   **400s** (so error-retry fires) rather than silently truncating.
5. **Draft 30s ephemerality** — confirm the 1/sec re-send + Thinking… animation keep the
   DM preview alive across long tool-call gaps.
6. **"Thinking" signal wiring** — confirm the streaming events let the connector tell
   "agent working but not emitting text" (pre-stream and mid-stream gaps) to drive the
   Thinking… animation / typing indicator. Verify in the plan; likely the existing
   typing-indicator trigger.

## 7. Non-goals restated
No agent-process/reasoning streaming (the "Thinking…" placeholder shows no content), no
`RichBlockDetails`/math, no change to button/callback mechanics. Same outbound surface,
upgraded rendering, hack deleted.

## 8. Open implementation wrinkles for the plan
- HTML→rich edit-switch on the same message (group path), and reconciling a stream that
  split into multiple legacy messages (4096) vs a single rich finalize (32768).
- Draft streaming state model vs the base-connector `sendStreamingUpdate(...) → msgId`
  contract (drafts have no msgId mid-stream).
- Where the chat-type branch and the `richDraftStreaming` / legacy-rollback flags live
  (connector vs config schema).
- `draft_id` generation/tracking per streaming session.
