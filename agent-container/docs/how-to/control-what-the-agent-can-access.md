---
title: How do I control what the agent can access?
description: Scope policies and MCP tool policies: restricting which API endpoints and tools an agent may use, and approval flows.
source_url:
  - https://www.gamut.so/docs/using-superagent/integrations/scope-policies
  - https://www.gamut.so/docs/using-superagent/integrations/mcp-tool-policies
---

## Scope Policies

Scope policies let you control how agents use connected accounts at a granular level. Instead of giving an agent blanket access to an entire API, you can set per-scope rules that allow, require review, or block specific categories of API operations.

### How Scopes Work

Every connected account provider has a set of OAuth scopes that govern what API operations are possible. For example, Gmail has scopes like `gmail.readonly` (view emails), `gmail.send` (send emails), and `gmail.full` (read, compose, send, and permanently delete emails).

When an agent makes an API request through the proxy, Superagent matches the request's HTTP method and path against a scope map for that provider. The scope map contains over 4,000 endpoint-to-scope mappings across 40 providers. For example, `GET /gmail/v1/users/*/messages` maps to scopes like `gmail.readonly` and `gmail.modify`.

Once the scopes are identified, the policy resolver determines what to do.

### Policy Decisions

Each scope can have one of three policy decisions:

#### Allow

The request proceeds immediately without user intervention. Use this for operations you trust the agent to perform autonomously.

**Example:** You might allow `gmail.readonly` so your agent can check for new emails without asking.

#### Review

The request is paused, and you receive a notification asking you to approve or deny it. The agent waits (up to 5 minutes) for your decision. If you do not respond in time, the request times out and the agent receives an error.

**Example:** You might set `gmail.send` to review so that you can verify email content before the agent sends it.

#### Block

The request is immediately rejected. The agent receives an error indicating the request was blocked by policy. Use this to prevent agents from performing specific operations entirely.

**Example:** You might block `gmail.full` to prevent permanent email deletion.

### Policy Resolution Order

When a request matches one or more scopes, Superagent resolves the effective policy using a three-tier hierarchy:

1. **Explicit scope policy** — If you have set a policy for a specific scope (e.g., `gmail.send` = review), that policy applies.
2. **Account default** — If no explicit scope policy exists, the account-level default applies. This is configured as the `*` scope in the policy editor.
3. **Global default** — If no account default is set, the global default from your user settings applies. The factory default is `review`.

When a request matches multiple scopes and those scopes have different policies, the **most permissive** decision wins. For example, if a request matches both `gmail.readonly` (allow) and `gmail.modify` (review), the request is allowed. This ensures that an agent is not blocked when any of the matched scopes permits the operation.

### Configuring Scope Policies

#### From the Settings Dialog

1. Navigate to **Settings > Connections**.
2. Find the connected account you want to configure.
3. Click the **Policies** button (shield icon) on the account row.
4. The scope policy editor opens, showing:
   - **Account Default** — The fallback policy for scopes without explicit rules. Set to "Default" to inherit from your global settings.
   - **Per-scope list** — Every scope available for the provider, with its current policy and a description of what the scope grants.
5. Use the toggle for each scope to set it to Allow, Review, Block, or Default.
6. Click **Save Policies** to apply.

#### From a Review Prompt

When an agent's request triggers a review, the review prompt appears in the chat session. Along with the approve/deny buttons, the prompt offers an **Always Allow** option that sets an explicit "allow" policy for the matched scopes. This is a convenient way to build up policies as you use the agent, without needing to configure everything upfront.

When you choose "Always Allow" on a review prompt, any other pending reviews for the same agent and scope are automatically resolved as allowed.

### Scope Descriptions

Each scope in the policy editor shows a human-readable description of what that scope grants. These descriptions come from official provider documentation — for example, GitHub's `repo` scope shows "Grants full access to public and private repositories: code, commit statuses, invitations, collaborators, deployments, and webhooks."

The review prompt shown during a review uses a more specific endpoint-level description when available — for example, "Gets the specified message" rather than the broader scope description. This helps you make informed decisions about individual requests.

### Audit Trail

Every policy decision is recorded in the proxy audit log:

- **allow** — The request was auto-approved by policy.
- **approved_by_user** — The request was in review and the user approved it.
- **denied_by_user** — The request was in review and the user denied it.
- **block** — The request was blocked by policy without prompting.
- **review_timeout** — The request was in review but the user did not respond within 5 minutes.

You can review these entries in the [Audit Logging](https://www.gamut.so/docs/self-hosting/administration/audit-logging) interface.

### Related

- [Connected Accounts](https://www.gamut.so/docs/using-superagent/integrations/connected-accounts) — How OAuth accounts are set up and how the proxy works.
- [MCP Tool Policies](https://www.gamut.so/docs/using-superagent/integrations/mcp-tool-policies) — The equivalent per-tool policy system for MCP servers.
- [Audit Logging](https://www.gamut.so/docs/self-hosting/administration/audit-logging) — Review the full audit trail.

## MCP Tool Policies

MCP tool policies let you control which tools agents can invoke on each remote MCP server. This is the MCP equivalent of [scope policies](https://www.gamut.so/docs/using-superagent/integrations/scope-policies) for connected accounts.

### Policy Decisions

Each tool can be assigned one of three policies:

#### Allow

The tool call proceeds immediately without user intervention. Use this for tools you trust the agent to call autonomously.

**Example:** You might allow `list_contacts` on a CRM server since it only reads data.

#### Review

The tool call is paused, and you receive a notification asking you to approve or deny it. The agent waits (up to 5 minutes) for your decision.

The review prompt shows:
- The MCP server name.
- The tool being called (e.g., `send_email`).
- A human-readable description of the action (e.g., "Allow sending email via CRM Server?").

If you do not respond within 5 minutes, the request times out and the agent receives an error.

**Example:** You might set `send_email` to review so you can verify the content before it is sent.

#### Block

The tool call is immediately rejected. The agent receives an error indicating the request was blocked by policy.

**Example:** You might block `delete_all_records` to prevent accidental data loss.

### Policy Resolution Order

When an agent calls a tool, the policy resolver follows this hierarchy:

1. **Explicit tool policy** — If you have set a policy for the specific tool name (e.g., `send_email` = review), that policy applies.
2. **MCP default** — If no explicit tool policy exists, the server-level default applies. This is configured as the `*` tool in the policy editor.
3. **Global default** — If no MCP default is set, the global default from your user settings applies. This defaults to `review`.

#### Protocol Methods Are Exempt

Policy enforcement only applies to `tools/call` requests — the actual tool invocations. MCP protocol-level methods are always allowed without policy checks:

- `initialize` and `notifications/initialized` (handshake)
- `tools/list`, `prompts/list`, `resources/list` (discovery)
- `ping`, `logging/setLevel`, `completion/complete` (housekeeping)
- All `notifications/*` methods

This ensures that tool discovery and connection management work regardless of policy settings.

### Configuring Tool Policies

#### From the Settings Dialog

1. Navigate to **Settings > Connections**.
2. Find the MCP server you want to configure.
3. Click the **Policies** button (shield icon) on the server row.
4. The tool policy editor opens, showing:
   - **MCP Default** — The fallback policy for tools without explicit rules. Set to "Default" to inherit from your global settings.
   - **Per-tool list** — Every tool discovered on the server, with its name, description, and current policy.
5. Use the toggle for each tool to set it to Allow, Review, Block, or Default.
6. Click **Save Policies** to apply.

You can filter the tool list by name or description using the search box, and filter by policy decision using the dropdown.

#### From a Review Prompt

When a tool call triggers a review, the review prompt appears inline in the chat session. Along with the approve/deny buttons, the prompt offers an **Always Allow** option that sets an explicit "allow" policy for that tool. This lets you build up policies incrementally as you use the agent.

### Audit Trail

Every MCP tool call is recorded in the MCP audit log with the following fields:

| Field | Description |
|---|---|
| `agentSlug` | The agent that made the call |
| `remoteMcpId` | The MCP server ID |
| `remoteMcpName` | The MCP server display name |
| `method` | The HTTP method (typically POST) |
| `requestPath` | The JSON-RPC method (e.g., `tools/call: search_contacts`) |
| `statusCode` | The HTTP status code of the upstream response |
| `durationMs` | Round-trip time in milliseconds |
| `policyDecision` | The policy outcome (see below) |
| `matchedTool` | The tool name for `tools/call` requests |

#### Policy Decision Values

The `policyDecision` field in the audit log records the outcome of policy resolution:

- **allow** — The tool call was auto-approved by policy.
- **approved_by_user** — The tool call was in review and the user approved it.
- **denied_by_user** — The tool call was in review and the user denied it.
- **block** — The tool call was blocked by policy without prompting.
- **review_timeout** — The tool call was in review but the user did not respond within 5 minutes.

For protocol-level methods (initialize, tools/list, etc.), the policy decision is recorded as `allow` since these bypass policy enforcement.

You can review these entries in the [Audit Logging](https://www.gamut.so/docs/self-hosting/administration/audit-logging) interface.

### Comparison with Scope Policies

| | Scope Policies | Tool Policies |
|---|---|---|
| **Applies to** | Connected accounts (OAuth APIs) | Remote MCP servers |
| **Granularity** | Per OAuth scope (e.g., `gmail.send`) | Per tool name (e.g., `send_email`) |
| **Resolution** | Most permissive scope wins | Single tool match |
| **Default hierarchy** | Scope -> Account default -> Global | Tool -> MCP default -> Global |

The core mechanics are the same: a three-tier hierarchy of explicit, default, and global policies with the same allow/review/block decisions.

### Related

- [Remote MCP Servers](https://www.gamut.so/docs/using-superagent/integrations/remote-mcp-servers) — How to register and manage MCP servers.
- [Scope Policies](https://www.gamut.so/docs/using-superagent/integrations/scope-policies) — The equivalent policy system for connected accounts.
- [Audit Logging](https://www.gamut.so/docs/self-hosting/administration/audit-logging) — Review the full audit trail.
