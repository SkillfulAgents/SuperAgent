# MCP Management

MCP (Model Context Protocol) servers extend an agent's capabilities by providing additional tools. Servers are registered globally, then assigned to individual agents. Agents can also request new MCP servers mid-conversation.

## Global Settings — MCPs Tab

Accessed via the gear icon in the sidebar footer, then selecting the "MCPs" tab.

### Components

- **MCP servers list** — displays all globally registered servers with their discovered tools.
- **"Add MCP Server" button** — opens the add-server form.

### Add MCP Server Form

- **Name** text input — display name for the server.
- **URL** text input — the server's endpoint URL.
- **Authentication** selector — defaults to "No Authentication"; supports additional auth modes.
- **"Add" / "Save" button** — registers the server and triggers tool discovery.

### Per-server Actions

- **Delete (trash) icon** — removes the server from the global list (may prompt for confirmation).

---

## Agent Settings — MCPs Tab

Opened from the agent settings dialog, under the "MCPs" tab.

### Components

- **Agent MCP server list** — shows servers currently assigned to this agent.
- **"Add MCP servers" button** — opens a picker listing globally registered servers not yet assigned.

### Add MCP Servers Picker

- **Checkbox per server** — select one or more servers to assign.
- **Add button** (e.g. "Add N server(s)") — assigns the selected servers to the agent.

### Per-server Actions

- **Remove (trash) icon** — unassigns the server from this agent (does not delete it globally).

---

## Chat View — MCP Tool Calls

When an agent uses an MCP tool during a conversation, the chat message list reflects this.

### Components

- **Tool call card** — appears inline in the message list, showing the MCP tool name invoked and the returned content.

---

## Chat View — MCP Server Request Card

When an agent attempts to use an MCP server that is not yet registered, a request card appears in the chat.

### Components

- **"MCP Server Requested" card** (purple) — displays the requested server name and URL.
- **Name input** — pre-filled or editable display name for the server.
- **"Register" button** — registers the server globally and triggers tool discovery.

### Post-Registration State

After registration completes, the card updates:

- **Server selector** — the newly registered server appears as a selectable item.
- **"Grant Access" button** — assigns the server to the current agent so the conversation can continue.
- **"Access Granted" status** — confirms the server is now available and the agent resumes processing.
