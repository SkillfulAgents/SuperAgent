# X-Agent Work
We want to introduce a new feature to let agents create, invoke and chat with other agents. The idea is to give a set of custom tools to the agent for working with other agents in the same workspace.

## Tools:
This is the general interface I am imagining here:
- Create Agent (name) -> slug
- List Agents () -> slugs + names
- Invoke Agent (slug, prompt, sync?, session_id?) -> session ID
    - If session ID passed, message into existing session. Fail if running / session doesnt exist.
    - If sync is true, awaits until turn ends before returning
- Get Sessions (slug) -> id, name
- Get Session Transcript (session_id, sync?)
    - starts with status line to indicate status
    - If sync AND agent is running, tool hangs until agent is done

## Permissions
We want to use the same concept for permissions as we do with other cases (like computer use or API calls) - intercept requests, apply policies, show user options in the UI.
Permissions are managed at agent level - each agent gets specific permissions for how it can use all other agents.
The permission categories are:
- Create Agent -> no memory / always allow. This always requires manual approval
- List Agents -> allow / deny. Can be remembered
- Use Agent (X) - This has to levels - read messages and invoke. Can remember to auto-allow at a certain level (read / write) per other agent

## Auth Mode
- Disabled for shared agents currently.
- For user - Agent can list and invoke shared agents based on user's permissions level (so obviously if user has view only acess to a shared agent, User's agents can call it)

## UI
- We will need custom components to render the new class of tool calls. They should link to the agent / sessions they refer to.

## Open Questions
- File system based read OR search tools - one thought that I had for letting agents read other agents messages is to somehow give them raw access to the jsonl files for max flexibility - so that they can glob / grep directly as needed. But not sure if this is a good idea / how to implement (esp as we can't dynamically add mounts to an existing container -- maybe mount a virtual folder? idk)
- Any existing Agent SDK tooling - worth checking if Claude Code / Claude Agent SDK has any concept for this built in already. Would rather reuse exiting infra to the extent possible
- General prior art - what are other tools / products / platforms doing? Any cool / interesting novel approaches we can leverage here?

---

# Implementation Plan

## 1. Existing infra we can reuse

### 1.1 MCP tool pattern (pick this, not "built-in Task tool")
We should add a **new MCP server** called `agents` (alongside `user-input`, `browser`, `computer-use`, `dashboards`). Each x-agent tool is a `tool()` definition in `agent-container/src/tools/agents/*.ts`, wired from a new factory in `agent-container/src/mcp-server.ts`.

Why not extend the SDK's built-in `Task` tool? The SDK's `Task` spins a sub-SDK in the *same container*, loading hardcoded subagent types from `.claude/agents/*.md` (today: `web-browser`, `computer-use`). That's a different primitive — ephemeral in-container workers tied to this session. X-Agent Work is cross-agent (across different containers, different slugs, different sessions, persistent). Keep `Task` as-is; add new tools.

Naming (matches existing `mcp__user-input__schedule_task` convention):
- `mcp__agents__create_agent`
- `mcp__agents__list_agents`
- `mcp__agents__invoke_agent`
- `mcp__agents__get_sessions`
- `mcp__agents__get_session_transcript`

### 1.2 Permission / review system (reuse as-is)
`src/shared/lib/proxy/review-manager.ts` is exactly the model we want:
- `reviewManager.requestReview({ agentSlug, toolkit, method, targetPath, matchedScopes, scopeDescriptions })` returns a `Promise<'allow' | 'deny'>`.
- It broadcasts `proxy_review_request` SSE events via `broadcastReview(agentSlug, …)`, with a 5-min timeout.
- Frontend picks these up via `src/renderer/hooks/use-proxy-reviews.ts` and shows `proxy-review-request-item.tsx`.

For persistent "remember" decisions, there are two existing stores in `src/shared/lib/db/schema.ts`:
- `apiScopePolicies` — per-account scope policy (gmail, etc.). Good pattern to copy.
- `mcpToolPolicies` — per-MCP tool policy.

We'll add a new table `agentInvokePolicies` (see §3). The code path:
1. Tool handler calls a proxy-like helper `checkAgentPolicy(callerSlug, op, targetSlug?)`.
2. Helper reads policy row. `allow` → return. `block` → error. `review` (or absent) → `reviewManager.requestReview(...)`.
3. UI prompt includes "Remember this choice" checkbox that writes a new policy row before resolving the review.

### 1.3 Invocation plumbing (reuse container-manager)
`src/shared/lib/container/container-manager.ts` already exposes `createSession`, `sendMessage`, container start/stop per-slug. `message-persister.ts` tracks the running state (`streamingState.isActive`, `isStreaming`, `isAwaitingInput`). We'll drive the remote agent *from the host process*, not from inside Agent A's container — the container calls the host API via an interception pattern just like `schedule_task`.

### 1.4 Tool-call interception: container → host HTTP callback
The container tool handler calls back to the host over HTTP (same model as `input-manager` for `request_secret`), the host does the work under policy/review, and the tool resolves with the returned data. This is required because x-agent tools return synchronous data (slugs, session IDs, transcripts) to the caller — unlike fire-and-forget `schedule_task`.

Host exposes the API at `SUPERAGENT_HOST_API_URL` (already passed as env to the container for other tools). Audit step before coding: read `agent-container/src/server.ts` + the endpoint that resolves `request_secret` / `request_file`, and copy that template.

### 1.5 Auth / ACL (reuse `agentAcl`)
`src/shared/lib/db/schema.ts:270` `agentAcl(userId, agentSlug, role: 'owner'|'user'|'viewer')`. `src/api/middleware/auth.ts` has `AgentRead` / `AgentUser` / owner guards. `ROLE_HIERARCHY` in `src/shared/lib/types/agent.ts`.

Rule (per spec): auth mode disabled → no check; auth mode on → caller agent's *owner user* must have ≥ required role on the target agent.
- `list_agents` → enumerate agents where owner-of-caller has ≥ `viewer` role (non-auth mode: all local agents).
- `get_session_transcript`, `get_sessions` → requires ≥ `viewer` on target.
- `invoke_agent` → requires ≥ `user` on target.
- `create_agent` → in auth mode, requires the owner-of-caller to have the global "create agent" capability (today any authed user can create — `POST /agents` handler). New agent gets an `owner` ACL row for that user.

Caller → owner user lookup: `agentAcl` has no multi-owner model in practice, but `timezone-resolver.ts:28` shows the canonical "find owner for agentSlug" query. Reuse that.

## 2. Tool implementations (agent-container)

New files under `agent-container/src/tools/agents/`:

### 2.1 `create-agent.ts` — `mcp__agents__create_agent`
```
inputs: { name: string, description?: string, instructions?: string }
returns: { slug: string }
```
Policy: **always `review`, never remembered.** On allow, the host calls `createAgent(...)` (from `src/shared/lib/services/agent-service.ts`) — reuses `generateUniqueAgentSlug`. The new agent gets an ACL row for the caller's owner user (auth mode).

### 2.2 `list-agents.ts` — `mcp__agents__list_agents`
```
inputs: {}
returns: [{ slug, name, description? }, ...]
```
Policy: `review` / `allow` / `block`, rememberable at the *caller* level (one policy row — not per-target). On allow, host calls `listAgents()` filtered by the caller's owner ACL in auth mode. Excludes the caller itself.

### 2.3 `invoke-agent.ts` — `mcp__agents__invoke_agent`
```
inputs: {
  slug: string,
  prompt: string,
  session_id?: string,   // if omitted, creates a new session
  sync?: boolean         // default false
}
returns: { session_id: string, status: 'running' | 'completed', last_message?: string }
```
Policy: per-target `(caller_slug, target_slug, 'invoke')`. Rememberable as `allow`.
Host logic:
1. Policy check. Deny → tool error.
2. Resolve target agent; load its container via `containerManager`.
3. If `session_id` passed: verify exists, verify not running (`message-persister.getStreamingState(target, sessionId).isActive === false`) else error.
4. Else: call `containerManager.createSession(targetSlug, {...})` — mirror the `POST /agents/:slug/sessions` flow in `src/api/routes/agents.ts`.
5. `containerManager.sendMessage(targetSlug, sessionId, prompt)`.
6. If `sync`: await a promise that resolves when `message-persister` emits a `result` event for that session (or aborts). Return the final assistant text as `last_message`.
7. If async: return immediately with `status: 'running'`.

Surface this in the **parent's** message stream as a new tool call (custom renderer, §4). The UI links to `/agents/{slug}/sessions/{sessionId}`.

### 2.4 `get-sessions.ts` — `mcp__agents__get_sessions`
```
inputs: { slug: string }
returns: [{ id, name, starred?, createdAt, isRunning }, ...]
```
Policy: read-level on target, rememberable.
Host calls `listSessions(targetSlug)` from `src/shared/lib/services/session-service.ts`. Annotate `isRunning` via `message-persister`.

### 2.5 `get-session-transcript.ts` — `mcp__agents__get_session_transcript`
```
inputs: { slug: string, session_id: string, sync?: boolean }
returns: { status: 'running'|'idle'|'awaiting_input', messages: [...] }
```
Policy: read-level on target, rememberable (same row as `get_sessions`).
Host reads JSONL via `session-service.ts` / `file-storage.ts` (`parseJsonl`). Format per-message as short structured text — **do not** dump raw SDK JSON; strip internal fields.

Format choice: return a compact JSON array `{ role, content, tool_name? }` or a textual transcript. Start with the structured JSON; agents can parse it. First "message" in the returned array is a synthetic status line:
```
{ role: 'system', content: 'status: running' }
```

If `sync && running`: await the same "result" promise as invoke_agent's sync path, then re-read the transcript.

## 3. Database changes (Drizzle)

Add to `src/shared/lib/db/schema.ts`:

```ts
export const agentInvokePolicies = sqliteTable('agent_invoke_policies', {
  id: text('id').primaryKey(),
  callerAgentSlug: text('caller_agent_slug').notNull(),
  targetAgentSlug: text('target_agent_slug'),        // null = applies to all (used for list_agents)
  operation: text('operation', { enum: ['list', 'read', 'invoke'] }).notNull(),
  decision: text('decision', { enum: ['allow', 'review', 'block'] }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => ({
  unique: uniqueIndex('agent_invoke_policies_unique')
    .on(table.callerAgentSlug, table.targetAgentSlug, table.operation),
}))
```

Notes:
- `create_agent` is intentionally absent — spec says always manual, no memory.
- `read` covers both `get_sessions` and `get_session_transcript`.
- `invoke` implies `read` for policy-lookup (code falls back: if `invoke` allow, treat reads as allowed).
- Generate migration with `drizzle-kit` (check `drizzle.config.ts`).

Helper file: `src/shared/lib/services/agent-invoke-policy-service.ts` with `getPolicy`, `setPolicy`, `evaluate(caller, op, target?) → 'allow'|'review'|'block'`.

## 4. UI: tool-call renderers

Files in `src/renderer/components/messages/tool-renderers/`:
- `invoke-agent.tsx`, `create-agent.tsx`, `list-agents.tsx`, `get-sessions.tsx`, `get-session-transcript.tsx`

Each: follow `schedule-task.tsx` / `task.tsx` pattern — export a `ToolRenderer` with `displayName`, `icon`, `getSummary`, optional `StreamingView`, `ExpandedView`.

Register in `src/renderer/components/messages/tool-renderers/index.ts` and tool metadata in `src/shared/lib/tool-definitions/registry.ts`.

Key UX:
- `invoke-agent` renderer: show a card with target agent avatar/name, short prompt preview, session link (`/agents/{slug}/sessions/{sessionId}`), live status chip (running/completed) driven by subscribing to that session's streaming state.
- `get-session-transcript` renderer: collapsed by default showing "Read N messages from {agent}/{session}"; expand to show formatted transcript; clickable to open the session.
- `list-agents` renderer: show the list inline with click-through to each agent.
- `create-agent` renderer: show "Created {name}" card with click-through.

Permission prompt UI: the generic `proxy-review-request-item.tsx` covers this out of the box via `reviewManager`. We may want a dedicated "Allow Agent A to invoke Agent B?" dialog with a "Remember: read only / read+invoke / no" selector — extend `scopeDescriptions` to carry the level.

## 5. Where tool-result plumbing goes (host ↔ container)

Pattern: **HTTP callback from container to host**, exactly like `input-manager`.

1. Host sets env on container start (already done for some vars): `SUPERAGENT_HOST_API_URL`, `SUPERAGENT_AGENT_SLUG` (caller slug), `SUPERAGENT_HOST_TOKEN`.
2. Container tool handler `POST {host}/agents/internal/x-agent/{op}` with `{ callerSlug, args, toolUseId }`.
3. Host route in `src/api/routes/agents.ts` (new sub-router `/agents/internal/x-agent`) does policy check → review → operation → returns JSON.
4. Tool handler resolves with the JSON, formats as content blocks, returns to SDK.

Audit step before coding: confirm the exact existing mechanism by reading how `request_secret` calls back (this is the load-bearing precedent). Files: `agent-container/src/tools/request-secret.ts`, `agent-container/src/input-manager.ts`, `agent-container/src/server.ts`, plus the host endpoint that fulfils it.

## 6. Implementation order (PRs)

1. **DB + policy service** — add `agentInvokePolicies` table, migration, `agent-invoke-policy-service.ts` with tests. No behavior change yet.
2. **Host endpoints** — `/agents/internal/x-agent/{list,create,invoke,get-sessions,get-transcript}` with policy + review integration. Unit-test policy branch.
3. **Container tools** — 5 tool files + new MCP server factory + wire into container. Integration test against a mock host.
4. **UI renderers** — 5 renderers + registry entries. Visual test via a dev session that invokes each.
5. **Permission UI polish** — custom review dialog for invoke_agent with "remember level" selector.
6. **Sync invocation wait** — the `sync=true` awaiter wiring into `message-persister`. Requires exposing a per-session "done" promise from `MessagePersister` (new public API).
7. **System prompt update** — mention these tools in `agent-container/src/system-prompt.md` so agents discover them.
8. **E2E** — playwright test with 2 agents: A invokes B, transcript read back, policy denial path.

## 7. Key files to touch

| # | File | Change |
|---|------|--------|
| 1 | `src/shared/lib/db/schema.ts` | + `agentInvokePolicies` table |
| 2 | `src/shared/lib/services/agent-invoke-policy-service.ts` | **new** |
| 3 | `src/api/routes/agents.ts` | + `/agents/internal/x-agent/*` sub-routes |
| 4 | `src/shared/lib/proxy/review-manager.ts` | maybe extend `ReviewDetails` with agent-agent fields, or add a parallel manager |
| 5 | `agent-container/src/tools/agents/*.ts` | **5 new tools** |
| 6 | `agent-container/src/mcp-server.ts` | + `createAgentsMcpServer()` |
| 7 | `agent-container/src/claude-code.ts` | register new MCP server in SDK options |
| 8 | `agent-container/src/system-prompt.md` | document new tools |
| 9 | `src/shared/lib/tool-definitions/*.ts` + `registry.ts` | + 5 defs |
| 10 | `src/renderer/components/messages/tool-renderers/*.tsx` + `index.ts` | + 5 renderers |
| 11 | `src/renderer/components/messages/proxy-review-request-item.tsx` | extend for "remember level" selector |
| 12 | `src/shared/lib/container/message-persister.ts` | expose per-session "done" promise for sync-invoke |
| 13 | `src/shared/lib/container/mock-container-client.ts` | E2E mocks for x-agent calls |
| 14 | `e2e/*.spec.ts` | **new** x-agent E2E |

## 8. Gotchas

- **Cycles**: A invokes B invokes A. Either detect (track caller chain in the tool call metadata) or cap depth (≤ 3). Put depth in the tool args (`_depth` private param injected by host).
- **Zombie sessions when caller dies**: If A is killed mid-sync-invoke, B is still running. Decide: cancel B, or let it complete orphaned? Default: let it complete; A's next turn can discover the result via `get_session_transcript`.
- **session-metadata.json concurrent writes**: `registerSession` mutates this JSON file. If A invokes B creates a session while user also creates a session in B's UI, ensure atomic write (file lock or write-then-rename). Verify current impl in `session-service.ts`.
- **Policy row cleanup**: when an agent is deleted, cascade-delete policy rows referencing its slug (both caller and target directions). Add to the agent-deletion flow.
- **Auth mode `list_agents` filtering**: must actually filter by ACL of the *owner of the caller agent*, not the current HTTP user (tools run async, there's no request user). Use `timezone-resolver.ts`-style owner lookup.
- **Zod schemas for the new policy table & API payloads** — per CLAUDE.md, every boundary needs a Zod schema (`agent-invoke-policy-schema.ts`).
- **SDK version pinning**: new tools register fine; no SDK upgrade needed (agent-container uses `@anthropic-ai/claude-agent-sdk ^0.2.111`).

## 9. Decisions baked in

- **Review manager**: extend `src/shared/lib/proxy/review-manager.ts` rather than forking. Make `toolkit` / `method` / `targetPath` semantic-free so x-agent reviews reuse the same pending-queue, SSE broadcast, timeout, and UI plumbing. Add only what's needed (e.g. optional `targetAgentSlug`) to `ReviewDetails`.

## 10. Things to verify before coding (quick audit)

- [ ] Read `agent-container/src/input-manager.ts` + host endpoint that resolves it — confirm the host-callback pattern to copy.
- [ ] Read how `POST /agents/:slug/sessions` creates a session (`src/api/routes/agents.ts`) — to extract a non-HTTP helper for `invoke_agent`.
- [ ] Read `message-persister.ts` streaming state — confirm we can add `waitForIdle(sessionId)` cleanly for the `sync` path.
- [ ] Confirm `agentAcl` is populated automatically on agent creation in auth mode (should be; otherwise spec needs adjustment).
