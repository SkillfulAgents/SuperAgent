---
title: How do I use remote MCP servers?
description: Connecting remote MCP (Model Context Protocol) servers to give the agent additional tools.
source_url: https://www.gamut.so/docs/using-superagent/integrations/remote-mcp-servers
---

Remote MCP servers let agents use tools exposed by external services that implement the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP). MCP is an open standard that defines how AI applications discover and invoke tools over HTTP using JSON-RPC.

## What is MCP?

The Model Context Protocol defines a simple client-server interaction:

1. **Initialize** — The client sends an `initialize` request with its capabilities. The server responds with its own capabilities.
2. **Discover tools** — The client sends a `tools/list` request. The server responds with a list of available tools, each with a name, description, and typed input schema.
3. **Call tools** — The client sends a `tools/call` request with the tool name and input arguments. The server executes the tool and returns the result.

MCP servers communicate over HTTP, using either standard JSON responses or Server-Sent Events (SSE) for streaming. Superagent acts as an MCP client on behalf of your agents.

## Registering a Remote MCP Server

### No Authentication

1. Navigate to **Settings > Connections** and click **Add Connection**.
2. Select **MCP Server** from the integration type options.
3. Enter a **name** (for display) and the server's **URL**.
4. Superagent connects to the server, performs the MCP handshake, and discovers available tools.
5. If the connection succeeds, the server is saved with its tool list.

### Bearer Token Authentication

If the MCP server requires a static bearer token:

1. Follow the same steps above.
2. Select **Bearer Token** as the authentication type and enter the token.
3. Superagent includes the token in the `Authorization: Bearer <token>` header on all requests.

If the token is rejected (401), Superagent reports the error and does not save the server.

### OAuth Authentication

If the MCP server requires OAuth:

1. Start by adding the server with its URL. If Superagent receives a 401 response and detects an OAuth-capable server (via the `WWW-Authenticate` header and RFC 9728 resource metadata), it prompts you to connect via OAuth.
2. You can also initiate OAuth directly by selecting **OAuth** as the authentication type.
3. Superagent performs the full OAuth discovery flow:
   - Probes the server for a 401 response with `WWW-Authenticate` header.
   - Fetches Protected Resource Metadata (RFC 9728) to find the authorization server.
   - Fetches Authorization Server Metadata (RFC 8414 / OpenID Connect Discovery) to get the authorization and token endpoints.
   - If the server supports dynamic client registration (RFC 7591), Superagent registers itself automatically. Otherwise, you can provide a client ID and secret.
4. A popup opens with the authorization server's consent screen. Authenticate and grant permissions.
5. Superagent exchanges the authorization code for tokens using PKCE (S256), saves the server record, and discovers tools.

### Custom Client Credentials

For OAuth servers that do not support dynamic client registration, you can provide your own client credentials:

- **Client Name** — Display name used during dynamic registration (defaults to "Superagent").
- **Client ID** — Your OAuth client ID, if you have pre-registered one.
- **Client Secret** — Your OAuth client secret, if applicable.

## Tool Discovery

When a server is registered, Superagent performs tool discovery by:

1. Sending an `initialize` request (protocol version `2025-03-26`).
2. Sending a `notifications/initialized` notification.
3. Sending a `tools/list` request.

The discovered tools are cached in the database. Each tool record includes:

- **name** — The tool's identifier (e.g., `search_contacts`, `create_issue`).
- **description** — A human-readable description of what the tool does.
- **inputSchema** — A JSON Schema describing the tool's input parameters.

You can re-run tool discovery at any time by clicking **Discover Tools** on the server's detail page. This is useful when the server has been updated with new tools.

## Server Status

Each MCP server has one of three statuses:

### Active

The server is connected and operational. Tools can be invoked by mapped agents.

### Error

The server could not be reached or returned an error during the last connection attempt. The error message is stored and displayed. Common causes include network issues, server downtime, or server-side errors.

### Auth Required

The server's OAuth token has expired and could not be refreshed, or the server returned a 401 during a proxied request. The server needs to be re-authenticated. Click **Reconnect** on the server row to initiate a new OAuth flow.

## OAuth Token Refresh

For OAuth-authenticated servers, Superagent automatically handles token refresh:

1. Before forwarding a request, the MCP proxy checks whether the stored token has expired (based on `tokenExpiresAt`).
2. If expired and a refresh token is available, it sends a token refresh request to the OAuth token endpoint.
3. On success, the new access token (and optionally a new refresh token) is stored, and the request proceeds.
4. On failure, the server's status is set to `auth_required` and the proxy returns a 401 error to the agent.

The refresh request includes the `resource` parameter (from the original OAuth discovery) to ensure the new token is scoped to the correct MCP server.

## How the MCP Proxy Works

The MCP proxy follows the same security model as the connected accounts proxy:

1. **Token validation** — The proxy verifies the agent's synthetic token.
2. **Mapping check** — The proxy confirms the agent is mapped to the requested MCP server.
3. **Body parsing** — For POST requests, the proxy parses the JSON-RPC body to extract the method name and (for `tools/call`) the tool name.
4. **Policy enforcement** — For tool calls, the proxy resolves the tool policy (allow/review/block). Protocol-level methods like `initialize`, `tools/list`, and `ping` bypass policy checks. See [MCP Tool Policies](https://www.gamut.so/docs/using-superagent/integrations/mcp-tool-policies).
5. **Token injection** — The proxy adds the real access token to the `Authorization` header.
6. **Forward and stream** — The request is forwarded to the MCP server. The response (including SSE streams) is passed through to the agent.
7. **Audit logging** — Every request is logged with the agent, server, method, tool name, duration, and policy decision.

## URL Validation

For security, MCP server URLs are validated:

- Only HTTP and HTTPS URLs are accepted.
- Private and loopback addresses (e.g., `10.x.x.x`, `192.168.x.x`) are blocked, except for `localhost` in the Electron desktop app (where users may run local MCP servers).

## Multi-User Ownership (Auth Mode)

In [auth mode](https://www.gamut.so/docs/self-hosting/administration/auth-mode), each MCP server has an owner (the user who registered it). Users can only see and manage their own MCP servers. Admins can see and manage all servers.

## Related

- [Accounts vs MCP](https://www.gamut.so/docs/using-superagent/integrations/accounts-vs-mcp) — When to use connected accounts vs MCP servers.
- [MCP Tool Policies](https://www.gamut.so/docs/using-superagent/integrations/mcp-tool-policies) — Per-tool access control for MCP servers.
- [Mapping Accounts to Agents](https://www.gamut.so/docs/using-superagent/integrations/mapping-accounts-to-agents) — How to assign MCP servers to agents.
- [Audit Logging](https://www.gamut.so/docs/self-hosting/administration/audit-logging) — Review the audit trail of all MCP tool calls.
