---
title: How do I connect external accounts (Gmail, GitHub, Notion, …)?
description: Connected accounts via OAuth: connecting services, mapping accounts to agents, and when to use accounts vs MCP.
source_url:
  - https://www.gamut.so/docs/using-superagent/integrations/connected-accounts
  - https://www.gamut.so/docs/using-superagent/integrations/mapping-accounts-to-agents
  - https://www.gamut.so/docs/using-superagent/integrations/accounts-vs-mcp
---

## Connected Accounts

Connected accounts give your agents access to SaaS APIs like Gmail, GitHub, Slack, and Salesforce. Superagent handles the OAuth flow, stores credentials securely via Composio, and proxies all API requests so that agents never see the underlying tokens.

### How the Secure Proxy Works

The proxy is the core security mechanism of connected accounts. Here is the request flow:

1. **Agent makes a request** — The agent sends an HTTP request to Superagent's proxy endpoint, authenticated with a synthetic token unique to that agent.
2. **Token validation** — The proxy verifies the synthetic token and confirms the agent is mapped to the requested account.
3. **Host allowlisting** — The proxy checks that the target API host is in the allowlist for that provider. For example, a Gmail account can only reach `gmail.googleapis.com` and `www.googleapis.com`. Requests to any other host are rejected.
4. **Scope policy enforcement** — The proxy matches the request method and path against the provider's scope map to determine which OAuth scopes the call requires. It then resolves the policy for those scopes (allow, review, or block). See [Scope Policies](https://www.gamut.so/docs/using-superagent/integrations/scope-policies).
5. **Token injection** — If the request is allowed, the proxy fetches the real OAuth token from Composio and injects it into the `Authorization` header.
6. **Forward and stream** — The request is forwarded to the upstream API. The response is streamed back to the agent.
7. **Audit logging** — Every request is logged with the agent slug, account ID, toolkit, target host, path, HTTP method, status code, matched scopes, and policy decision.

At no point does the agent receive the real OAuth token. The synthetic token is only valid for proxy requests and is scoped to a single agent.

#### Composio Proxy Fallback

Some Composio configurations redact OAuth tokens (e.g., Composio-managed auth configs). When Superagent detects a redacted token, it automatically falls back to Composio's proxy execute API, which attaches the real credentials server-side. This fallback is transparent — the agent and the upstream API see the same behavior.

### Adding a Connected Account

#### OAuth Flow

1. Navigate to **Settings > Connections** or open an agent's **Connections** panel.
2. Click **Add Connection** and select a provider from the directory.
3. A popup opens with the provider's OAuth consent screen. Sign in and grant the requested permissions.
4. On success, Superagent creates a local record of the account and attempts to fetch a display name (e.g., your email address for Google accounts, your username for Microsoft accounts).

The OAuth flow works in both the Electron desktop app (using a custom protocol callback) and the web interface (using an HTTP callback endpoint).

#### Display Names

After connecting, Superagent tries to fetch a user-specific display name from the provider. For Google accounts, it queries the userinfo endpoint to get your email address. For Microsoft accounts, it queries the Microsoft Graph `/me` endpoint. If the fetch fails, the provider's display name (e.g., "Gmail") is used as a fallback.

You can rename a connected account at any time by editing its display name in the connections list.

### Supported Providers

Superagent supports 40+ OAuth providers organized into the following categories:

#### Google Workspace
Gmail, Google Calendar, Google Drive, Google Sheets, Google Docs, Google Slides, Google Meet, Google Tasks, YouTube

#### Microsoft
Outlook, Microsoft Teams

#### Communication
Slack, Discord

#### Developer Tools
GitHub, GitLab, Bitbucket, Sentry

#### Project Management
Notion, Linear, Confluence, Asana, Monday.com, ClickUp, Trello

#### CRM and Sales
HubSpot, Salesforce, Zendesk, Intercom

#### Cloud Storage
Airtable, Dropbox, Box

#### Social Media
LinkedIn, Instagram

#### Finance
Stripe, QuickBooks, Xero

#### Marketing
Mailchimp

#### Design
Figma

#### Scheduling and Forms
Calendly, Typeform

#### Video
Zoom

### Account Status

Each connected account has one of three statuses:

- **Active** — The OAuth connection is valid and the account can be used by agents.
- **Revoked** — The user revoked access from the provider's side (e.g., removed the app from Google account settings). The account must be reconnected.
- **Expired** — The OAuth token expired and could not be refreshed. The account must be reconnected.

### Deleting an Account

When you delete a connected account, Superagent removes the local record and also calls Composio's API to delete the upstream connection. Any agent mappings to that account are automatically removed via cascade delete.

### Related

- [Scope Policies](https://www.gamut.so/docs/using-superagent/integrations/scope-policies) — Control which API scopes each account is allowed to use.
- [Mapping Accounts to Agents](https://www.gamut.so/docs/using-superagent/integrations/mapping-accounts-to-agents) — Assign accounts to specific agents.
- [Audit Logging](https://www.gamut.so/docs/self-hosting/administration/audit-logging) — Review the audit trail of all proxied API requests.

## Mapping Accounts to Agents

Superagent uses an explicit mapping model: a connected account or MCP server is only accessible to an agent if you have specifically assigned it. This gives you fine-grained control over which services each agent can use.

### How Mapping Works

Both connected accounts and remote MCP servers are registered at the application level. They are not inherently tied to any agent. To make an integration available to an agent, you create a mapping between the two.

Under the hood, these mappings are stored in junction tables:

- **agent_connected_accounts** — Links an agent slug to a connected account ID.
- **agent_remote_mcps** — Links an agent slug to a remote MCP server ID.

Each mapping is unique — you cannot map the same account to the same agent twice. When a connected account or MCP server is deleted, all of its agent mappings are automatically removed.

### Assigning Integrations to an Agent

#### From the Agent Home Page

1. Open the agent you want to configure.
2. In the **Connections** section of the agent home page, click the **+** button or the **Settings** button.
3. You will see the connections management view, which shows all available accounts and MCP servers.
4. Toggle the integrations you want to assign to this agent.

#### From the Global Connections Page

1. Navigate to **Settings > Connections**.
2. Click on a connected account or MCP server.
3. Use the **Agents** pill to see which agents currently have this integration mapped.
4. Click the agents pill to open the agent assignment dialog, where you can add or remove agent mappings.

### What Happens at Runtime

When an agent runs, the system provides it with information about its mapped integrations:

- For **connected accounts**, the agent receives a list of available accounts with their toolkit slug (e.g., `gmail`), display name, and the proxy URL to use for API requests. The agent authenticates to the proxy with a synthetic token that is unique to that agent. The proxy verifies both the token and the agent-account mapping before forwarding any request.

- For **remote MCP servers**, the agent receives the MCP server's proxy URL and the list of available tools. The MCP proxy similarly validates the agent-MCP mapping before forwarding tool calls.

If an agent tries to use an account or MCP server that is not mapped to it, the proxy returns a 404 error ("Account not found or not mapped to this agent").

### One Account, Many Agents

A single connected account can be mapped to multiple agents. For example, you might have one Gmail account connected and map it to both your "Inbox Manager" agent and your "Daily Digest" agent. Both agents share the same OAuth connection but can have different scope policies.

Similarly, a single MCP server can be mapped to multiple agents, each with their own tool policies.

### One Agent, Many Accounts

An agent can have multiple accounts of the same provider type. For example, you might map two different Gmail accounts to an agent — one for personal email and one for work email. The agent distinguishes them by the account's display name (which typically shows the email address).

### Multi-User Account Ownership (Auth Mode)

When Superagent runs in [auth mode](https://www.gamut.so/docs/self-hosting/administration/auth-mode) with multiple users:

- Each connected account has an **owner** (the user who completed the OAuth flow). The `userId` field on the account record tracks this.
- Users can only see and manage their own accounts. The API scopes all account queries to the current user's ID.
- Agent mappings reference accounts by ID, so an account can only be mapped to agents that the account owner has access to.
- Admins can see and manage all accounts regardless of ownership.

This ensures that in a shared Superagent instance, users' OAuth credentials and account access are isolated from each other.

### Removing a Mapping

To remove an integration from an agent:

1. Open the agent's **Connections** section.
2. Click the remove button on the integration you want to unmap.

Removing a mapping does not delete the connected account or MCP server itself — it only removes the agent's access to it. You can re-add the mapping at any time.

### Agent Requests for New Integrations

If an agent needs an integration that is not currently mapped, it can use a built-in tool to request one:

- **Request Connected Account** — The agent asks for a specific provider (e.g., Gmail). You see a prompt in the chat session where you can connect the account or select an existing one.
- **Request MCP Server** — The agent asks for a specific MCP server by URL or name. You see a prompt to register and connect the server.

These requests appear inline in the conversation and require your explicit approval.

### Related

- [Connected Accounts](https://www.gamut.so/docs/using-superagent/integrations/connected-accounts) — How accounts are set up and authenticated.
- [Remote MCP Servers](https://www.gamut.so/docs/using-superagent/integrations/remote-mcp-servers) — How MCP servers are registered and managed.
- [Scope Policies](https://www.gamut.so/docs/using-superagent/integrations/scope-policies) — Per-scope access control for connected accounts.
- [MCP Tool Policies](https://www.gamut.so/docs/using-superagent/integrations/mcp-tool-policies) — Per-tool access control for MCP servers.

## Accounts vs MCP

Superagent provides two distinct ways to give agents access to external services: **Connected Accounts** and **Remote MCP Servers**. Each model serves different use cases and has different security properties.

### Connected Accounts (OAuth via Composio)

Connected accounts let agents interact with standard SaaS APIs — Gmail, Slack, GitHub, Salesforce, and dozens more — through a secure proxy that handles OAuth tokens on the agent's behalf.

**How it works:**

1. You authenticate with a service through an OAuth consent flow (e.g., "Sign in with Google").
2. Superagent stores the resulting connection via [Composio](https://composio.dev), an OAuth integration platform.
3. When an agent needs to call that service's API, it sends the request through Superagent's proxy. The proxy injects the real OAuth token into the request and forwards it to the upstream API.
4. The agent never sees the OAuth token. It authenticates to the proxy using a synthetic token that is only valid for that agent.

**Key properties:**

- **Token isolation** — Agents never receive OAuth credentials. The proxy injects auth headers server-side.
- **Host allowlisting** — Each provider has an explicit list of allowed API hosts. Requests to other hosts are rejected.
- **Scope-level policy control** — You can allow, review, or block specific API scopes per account. See [Scope Policies](https://www.gamut.so/docs/using-superagent/integrations/scope-policies).
- **Audit logging** — Every proxied request is recorded with the agent, account, method, path, matched scopes, and policy decision.
- **40+ supported providers** — Google Workspace, Microsoft, Slack, GitHub, Notion, Linear, HubSpot, Stripe, and many more.

**Best for:** Standard SaaS integrations where you want managed OAuth, token brokering, and scope-level access control.

### Remote MCP Servers

Remote MCP servers let agents call tools exposed by any server that implements the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP). MCP is an open standard for exposing discrete tools to AI models over HTTP.

**How it works:**

1. You register an MCP server by providing its URL and authentication credentials (bearer token, OAuth, or no auth).
2. Superagent connects to the server, performs the MCP handshake (`initialize`, `notifications/initialized`), and discovers available tools via `tools/list`.
3. When an agent invokes a tool, it sends a JSON-RPC `tools/call` request through Superagent's MCP proxy, which injects the real access token and forwards it to the remote server.
4. As with connected accounts, the agent never sees the real authentication credentials.

**Key properties:**

- **Tool-based model** — MCP servers expose named tools with typed input schemas, not raw HTTP endpoints. The agent calls `search_contacts` or `create_issue`, not `POST /api/v2/contacts`.
- **Per-tool policy control** — You can allow, review, or block individual tools. See [MCP Tool Policies](https://www.gamut.so/docs/using-superagent/integrations/mcp-tool-policies).
- **OAuth and bearer token support** — Servers can require OAuth (with automatic token refresh) or a static bearer token.
- **Protocol-level calls are unblocked** — Handshake and discovery methods (`initialize`, `tools/list`, `ping`) bypass policy enforcement since they carry no data.
- **Audit logging** — Every tool call is recorded with the agent, server, tool name, duration, and policy decision.

**Best for:** Custom internal services, specialized capabilities, or any tool server that speaks MCP.

### Comparison

| | Connected Accounts | Remote MCP Servers |
|---|---|---|
| **Integration model** | Raw HTTP API calls via proxy | Discrete named tools via JSON-RPC |
| **Auth management** | Managed OAuth via Composio | Bearer token or OAuth (including PKCE) |
| **Token exposure** | Never exposed to agents | Never exposed to agents |
| **Policy granularity** | Per-scope (e.g., `gmail.readonly`) | Per-tool (e.g., `search_contacts`) |
| **Provider support** | 40+ built-in SaaS providers | Any MCP-compatible server |
| **Setup** | One-click OAuth consent | Register URL + credentials |
| **Best for** | Gmail, Slack, GitHub, Salesforce, etc. | Custom tools, internal APIs, specialized services |

### Using Both Together

Many agent setups use both integration types. For example, an agent might use a connected Gmail account to read and send emails (via the proxy), while also connecting to a custom MCP server that provides company-specific tools like `search_knowledge_base` or `create_support_ticket`.

Both connected accounts and MCP servers are mapped to agents individually — you control exactly which integrations each agent can access. See [Mapping Accounts to Agents](https://www.gamut.so/docs/using-superagent/integrations/mapping-accounts-to-agents) for details.

## As the agent

- Check the `CONNECTED_ACCOUNTS` env var (and the "Connected Accounts (Already Available)" prompt section) before requesting — access may already exist. The var is JSON mapping toolkit → accounts: `{"gmail": [{"name": "work@company.com", "id": "abc123"}]}`.
- Request new access with `mcp__user-input__request_connected_account` (`toolkit` lowercase, e.g. `gmail`; optional `reason`). Ask for the account — never for raw tokens or API keys of catalog services.
- Make API calls through the proxy; it injects the OAuth token for you:

  ```
  URL:    $PROXY_BASE_URL/<account_id>/<target_host>/<api_path>
  Header: Authorization: Bearer $PROXY_TOKEN
  ```

  Example: `GET $PROXY_BASE_URL/abc123/gmail.googleapis.com/gmail/v1/users/me/profile`.
- Some calls trigger a user approval (scope policy "review"): the proxy handles it transparently, but the first such call can be slow — a long response usually means an approval is pending, not a failure.
- Multiple accounts of one toolkit can be connected (work + personal); pick by account `id`.
