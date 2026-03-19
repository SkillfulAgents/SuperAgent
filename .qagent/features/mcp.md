# MCP Management

This feature covers MCP server registration, per-agent assignment, in-chat MCP tool calls, and MCP server requests.

## Prerequisites

- Global settings are accessible.
- Agent settings dialog is accessible.

## Global Settings - MCPs Tab

### Components
- **MCP servers list** - globally registered MCP servers and discovered tools.
- **Add MCP Server button** - opens registration form.
- **Name input** - display name for server.
- **URL input** - server endpoint URL.
- **Authentication selector** - auth mode selector.
- **Save/Add button** - registers server and triggers tool discovery.
- **Delete icon** - removes a global server.

### Interactions
- Register a new MCP server from global settings.
- Verify server appears in global list.
- Delete a server and verify removal.

## Agent Settings - MCPs Tab

### Components
- **Agent MCP list** - servers assigned to current agent.
- **Add MCP servers button** - opens picker of globally available servers.
- **Server checkboxes** - select one or more servers.
- **Add button** - assigns selected servers to current agent.
- **Remove icon** - unassigns server from agent.

### Interactions
- Assign one or more global MCP servers to agent.
- Unassign a server and verify it remains in global list.

## Chat View - MCP Tool Calls

### Components
- **MCP tool call card** - shows MCP tool name and returned content.

### Interactions
- Trigger an MCP-backed action in chat.
- Verify tool call card appears with expected details.

## Chat View - MCP Server Request Card

### Components
- **MCP Server Requested card** - shows requested server name and URL.
- **Name input** - editable server display name.
- **Register button** - registers requested server globally.
- **Server selector** - choose newly registered server.
- **Grant Access button** - assigns server to agent.
- **Access Granted status** - confirms assignment.

### Interactions
- Trigger request for an unregistered MCP server.
- Register the requested server from card.
- Grant access and verify chat resumes.

