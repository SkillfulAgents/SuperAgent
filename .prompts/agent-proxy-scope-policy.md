# Agent Proxy: Scope-Based Policy Enforcement

## 1. Overall Approach

AI agents making API calls pass through a proxy that enforces access policies before forwarding requests. We are going to extend the proxy to enforce access policies - safeguarding what the agent may do using external APIs. Rather than relying on OAuth token scopes to gate access at the auth layer (our root tokens are maximally permissive), we use scopes as a **semantic vocabulary** to classify the nature of each operation, and apply policies based on that classification.

Scope policies are declarative rules that cover the majority of cases and are easy to author. Every incoming request is evaluated against scope policies to determine the access decision.

> **Future extension (not in v1):** Endpoint policies using CEL expressions could be added as overrides where scope granularity isn't sufficient. These would take precedence over scope policies for specific endpoints.

There are three possible policy decisions:

| Decision | Behavior |
|---|---|
| `allow` | Request is forwarded to the upstream API immediately |
| `review` | Request is paused; user is prompted to approve in the UI |
| `block` | Request is rejected with HTTP 403 (see §7) |

---

## 2. Request → Scope Mapping

### Concept

Each API has a **scope map**: a lookup table from URL patterns to the set of scopes that are sufficient to authorize that operation. This mirrors how Google's Discovery Document format works — each API method declares which scopes satisfy it.

### Data Structure

```typescript
// One entry per API method
interface ScopeMapEntry {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  pathPattern: string;      // glob-style, e.g. "/gmail/v1/users/*/messages/*"
  sufficientScopes: string[]; // any one of these is sufficient
  description?: string;
}

// Full scope map for one API
type ScopeMap = ScopeMapEntry[];
```

### Example (Gmail)

```json
[
  {
    "method": "GET",
    "pathPattern": "/gmail/v1/users/*/messages",
    "sufficientScopes": ["gmail.readonly", "gmail.modify", "gmail.full"],
    "description": "List messages"
  },
  {
    "method": "GET",
    "pathPattern": "/gmail/v1/users/*/messages/*",
    "sufficientScopes": ["gmail.readonly", "gmail.modify", "gmail.full"],
    "description": "Get a message"
  },
  {
    "method": "POST",
    "pathPattern": "/gmail/v1/users/*/messages/send",
    "sufficientScopes": ["gmail.modify", "gmail.compose", "gmail.full"],
    "description": "Send a message"
  },
  {
    "method": "POST",
    "pathPattern": "/gmail/v1/users/*/messages/batchModify",
    "sufficientScopes": ["gmail.modify", "gmail.full"],
    "description": "Batch modify messages"
  },
  {
    "method": "DELETE",
    "pathPattern": "/gmail/v1/users/*/messages/*",
    "sufficientScopes": ["gmail.delete"],
    "description": "Permanently delete a message"
  },
  {
    "method": "POST",
    "pathPattern": "/gmail/v1/users/*/messages/batchDelete",
    "sufficientScopes": ["gmail.delete"],
    "description": "Batch delete messages"
  }
]
```

### Path Matching

Path patterns use glob-style wildcards (`*` for a single segment). Matching uses a trie-based router (same logic as Express), with more specific patterns taking precedence over less specific ones. Method must also match.

### Sourcing the Map

For APIs with good Discovery documents (Google), the map can be generated programmatically. For others (Zoom, Slack), it is curated manually from API documentation. The map is a static artifact per API version — it doesn't change at runtime.

---

## 3. Policy Tables

We create two new tables in the database to store policies.

### API Scope Policies

```sql
CREATE TABLE api_scope_policies (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
  scope       TEXT NOT NULL,        -- scope name, or '*' for the account-level default
  decision    TEXT NOT NULL,        -- 'allow' | 'review' | 'block'
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE(account_id, scope)
);
```

- A row with `scope = '*'` is the **account default** — applies to any scope without an explicit row.
- The **global default** (across all APIs) is stored in `user_settings.settings` as `defaultApiPolicy: 'allow' | 'review' | 'block'`.

### MCP Tool Policies

```sql
CREATE TABLE mcp_tool_policies (
  id          TEXT PRIMARY KEY,
  mcp_id      TEXT NOT NULL REFERENCES remote_mcp_servers(id) ON DELETE CASCADE,
  tool_name   TEXT NOT NULL,        -- tool name, or '*' for the MCP-level default
  decision    TEXT NOT NULL,        -- 'allow' | 'review' | 'block'
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE(mcp_id, tool_name)
);
```

Same pattern: `tool_name = '*'` is the MCP-level default, and the global default lives in `user_settings`.

## 4. Resolution Process

For each incoming request:

```
┌──────────────────────────────────────────────────────────┐
│ 1. Match request against scope map                       │
│    → candidate_scopes (scopes sufficient for this call)  │
│                                                          │
│ 2. Look up scope_policies for each candidate scope       │
│    → policy_decisions (one per scope)                    │
│                                                          │
│ 3. Apply most permissive decision                        │
│    (allow > review > block)                   DONE ───►  │
│                                                          │
│ 4. No match in scope map?                                │
│    → use API's default                        DONE ───►  │
│                                                          │
│ 5. No match in API default / no file                     │
│    → user's default                           DONE ───►  │
└──────────────────────────────────────────────────────────┘
```

### Why Most-Permissive for Scope Resolution (step 3)

Scope maps list all scopes that are *sufficient* for an operation. If `gmail.readonly` is sufficient for `GET /messages`, then semantically this is a read operation — regardless of whether a more permissive scope could also authorize it. The most permissive matching policy reflects the true nature of the call.

### Example Walkthrough

**Request:** `GET /gmail/v1/users/me/messages/abc123`

1. Match scope map → `["gmail.readonly", "gmail.modify", "gmail.full"]`
2. Look up policies → `[allow, review, review]`
3. Most permissive → **`allow`** ✅

## UI Integration

### Settings UI

- **Global Settings > Accounts Tab:**
  - Add an "API Request Policy" dropdown at the top to configure the global default policy across all APIs (stored in `user_settings`).
  - In each API account card, add a "Policies" button which opens a modal showing all scopes used by that API (derived from the scope map) and their current policy decisions, allowing the user to edit them inline.
    - For each scope: show name, description (from scope map), and a dropdown to select allow/review/block/default.
    - "default" reverts to the account-level default (the `scope = '*'` row).
    - Add a dropdown at the top of the modal to set the account default policy.
- **Global Settings > MCP Tab:**
  - Similar "Policies" button for each MCP server, showing tool-based policies instead of scope-based. Same structure: tool name, description (from `toolsJson`), decision dropdown.

### Session View

- When an agent requests a connected account (existing flow), add a dropdown after the account is connected (before the user clicks grant) to select the default policy for that account, with a link to configure detailed policies in settings.
- Same for MCP connections in session view.

### Review Prompt (in session view)

When a request is paused for review (SSE event `proxy_review_request`), show an inline prompt in the session message stream (following the existing pattern of `ConnectedAccountRequestItem`, `SecretRequestItem`, etc.):

- **Display:** API name, endpoint (`POST /gmail/v1/users/me/messages/send`), matched scopes with descriptions, and which scope policies triggered the review.
- **Actions:**
  - **Allow** — ad-hoc, one-time allow (resolves this review only)
  - **Deny** — ad-hoc, one-time deny
  - **Always Allow for this scope** — saves a scope policy to DB, then calls `reviewManager.resolveMatchingPending()` to auto-resolve other in-flight reviews
  - **Always Deny for this scope** — saves a scope policy to DB
  - **Always Allow for this API** — saves an account default policy (`scope = '*'`)
- **Description:** Use scope name + description from the scope map for a human-readable explanation (e.g., "Send a message via Gmail"). No LLM summarization needed for v1 — the scope descriptions are already human-friendly.

### Audit Logging

Extend the existing `proxyAuditLog` and `mcpAuditLog` tables with a `policy_decision` column (`'allow' | 'review' | 'block'`) and `matched_scopes` (JSON array) so users can see what policies were applied to past requests.

## 5. Review Mechanism (Proxy ↔ UI Signaling)

When the policy decision is `review`, the proxy must hold the container's HTTP connection while waiting for a human decision that arrives via a separate HTTP request from the UI. This is an in-memory async coordination problem solved by a **ReviewManager** singleton.

### Architecture

```
Container HTTP request
    ↓
Proxy handler (proxy.ts)
    ↓  policy decision = "review"
    ↓
ReviewManager.requestReview(details)
    ├─ Creates Promise, stores resolve/reject callback in Map<reviewId, PendingReview>
    ├─ Broadcasts SSE event to ALL active sessions of this agent
    └─ Returns Promise (proxy handler awaits it)
    ↓
    ⋯ proxy handler is suspended, container HTTP connection held ⋯
    ↓
User sees review prompt in UI, clicks Allow or Deny
    ↓
POST /api/agents/:slug/proxy-review/:reviewId  { decision: 'allow' | 'deny' }
    ↓
ReviewManager.submitDecision(reviewId, decision)
    ├─ Resolves the stored Promise
    └─ Cleans up Map entry + timeout
    ↓
Proxy handler resumes
    ├─ 'allow' → forward request to upstream API
    └─ 'deny'  → return HTTP 403 to container
```

### ReviewManager

Located at `shared/lib/proxy/review-manager.ts`. Singleton, in-memory only (no DB persistence for pending state — if server restarts, held requests fail and the container retries).

```typescript
interface ReviewDetails {
  agentSlug: string;
  accountId: string;       // or mcpId for MCP reviews
  toolkit: string;         // or mcpName
  method: string;
  targetPath: string;
  matchedScopes: string[]; // or matchedTool for MCP
  scopeDescriptions: Record<string, string>;
}

interface PendingReview {
  resolve: (decision: 'allow' | 'deny') => void;
  reject: (reason: Error) => void;
  details: ReviewDetails;
  timeout: NodeJS.Timeout;
}

class ReviewManager {
  private pending = new Map<string, PendingReview>();

  /** Called by proxy handler. Returns when user decides or timeout. */
  async requestReview(details: ReviewDetails): Promise<'allow' | 'deny'> {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Review timeout'));
      }, 5 * 60_000); // 5 minutes

      this.pending.set(id, { resolve, reject, details, timeout });
      broadcastAgentReviewRequest(details.agentSlug, { id, ...details });
    });
  }

  /** Called by the UI decision endpoint. */
  submitDecision(id: string, decision: 'allow' | 'deny'): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timeout);
    this.pending.delete(id);
    entry.resolve(decision);
    return true;
  }

  /** Auto-resolve pending reviews matching a scope (for "Always Allow" shortcut). */
  resolveMatchingPending(agentSlug: string, scope: string, decision: 'allow' | 'deny') {
    for (const [id, entry] of this.pending) {
      if (entry.details.agentSlug === agentSlug &&
          entry.details.matchedScopes.includes(scope)) {
        this.submitDecision(id, decision);
      }
    }
  }

  /** Call on server shutdown to reject all pending reviews gracefully. */
  rejectAll() {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timeout);
      entry.reject(new Error('Server shutting down'));
    }
    this.pending.clear();
  }
}

export const reviewManager = new ReviewManager();
```

### Session Targeting

The proxy knows `agentSlug` but not `sessionId`. Reviews are broadcast to **all active sessions** of the agent. This is correct because:

- The policy review is about the *agent's* behavior, not a specific conversation
- Any authorized user viewing any session of that agent should be able to approve/deny
- Once any viewer decides, the Promise resolves and the review is cleared from all UIs

Implementation: add a `broadcastToAgent(agentSlug, event)` helper that iterates all active SSE connections whose sessions belong to the given agent, reusing the existing per-session broadcast infrastructure in `message-persister.ts`.

### Timeout Handling

- Default timeout: 5 minutes (configurable)
- On timeout: Promise rejects → proxy returns HTTP 408 to container
- Container receives timeout error → agent can inform the user that review timed out
- All pending reviews are rejected on server shutdown via `reviewManager.rejectAll()` in the shutdown hook

### "Always Allow" Race Condition

When user clicks "Always Allow for this scope":

1. Scope policy is saved to DB (future requests auto-allow)
2. `reviewManager.resolveMatchingPending(agentSlug, scope, 'allow')` auto-resolves any other in-flight reviews that match the same scope

This prevents the user from having to approve the same class of request multiple times in quick succession.

---

## 6. MCP Policy Enforcement

For MCP servers, the `mcp-proxy.ts` handler must parse the JSON-RPC request body to extract the tool name:

- Method `tools/call` → tool name is in `params.name`
- Other methods (`tools/list`, `initialize`, etc.) → match against `tool_name = '*'` (MCP default policy)

The resolution chain mirrors API policies: explicit tool policy → MCP default (`tool_name = '*'`) → global default (from `user_settings`).

---

## 7. Proxy Responses to Container

### Block (immediate)

When the policy decision is `block`, the proxy returns HTTP **403 Forbidden** with a structured JSON body:

```json
{
  "error": "blocked_by_policy",
  "message": "This request was blocked by your API access policy.",
  "scopes": ["gmail.compose"],
  "toolkit": "gmail",
  "settingsHint": "You can adjust policies in Settings > Accounts > Gmail > Policies"
}
```

### Review → Denied by user

Same 403 format but with `"error": "denied_by_user"`.

### Review → Timeout

HTTP **408 Request Timeout** with:

```json
{
  "error": "review_timeout",
  "message": "The request required user approval but timed out after 5 minutes."
}
```

### Container-Side Handling

The agent's HTTP client should understand these responses and surface them to the user or adjust behavior. The `error` field is machine-readable; the `message` field is suitable for the LLM agent to include in its response to the user.