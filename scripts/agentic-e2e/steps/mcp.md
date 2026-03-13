# MCP Steps

Test the full MCP workflow using two no-auth servers:
- **Jina AI** (`https://mcp.jina.ai/v1`) — added manually via global settings UI
- **DeepWiki** (`https://mcp.deepwiki.com/mcp`) — triggered by the agent during chat, registered via the in-chat MCP request card

## add-mcp-global

Open global settings (gear icon in sidebar footer).
Navigate to the "MCPs" tab.
Take a screenshot.
Click "Add MCP Server" to open the add form.
Fill in Name: "Jina AI" and URL: "https://mcp.jina.ai/v1".
Leave Authentication on "No Authentication".
Click "Add" / "Save" to register the server.
Take a screenshot.
Wait a few seconds for tool discovery to complete.
Assert: "Jina AI" appears in the global MCP servers list, ideally with discovered tools shown.

---

## assign-mcp-to-agent

Open the agent settings dialog for the current agent.
Navigate to the "MCPs" tab.
Click "Add MCP servers".
Check the checkbox for "Jina AI" in the available servers list.
Click the add button (e.g. "Add 1 server(s)").
Take a screenshot.
Assert: "Jina AI" appears in the agent's MCP server list.
Close the agent settings dialog.

---

## start-agent-and-chat

Make sure the agent is running. If the agent status shows "sleeping", click the Start button to start it.
Wait until the agent status changes to "idle" (this may take 10-20 seconds as the container starts up).
Then click the agent in the sidebar to open the chat view.
Type a simple message like "Hello, what tools do you have available?" and press Enter.
Wait for the agent to respond (10-30 seconds).
Take a screenshot.
Assert: the agent is running (status "idle"), the chat input is available, and you received a response.
DO NOT skip this step — the following steps all require an active chat session.

---

## verify-mcp-via-chat

Now that the agent is running with Jina AI MCP assigned, send a chat message that triggers the agent to use the Jina AI **primer** tool.
Type: "Use the Jina AI primer tool to give me a primer on 'Anthropic Claude'."
Press Enter and wait for the agent to process — this may take 15-30 seconds as it calls the MCP tool.
Watch for a tool call card showing "primer" (a Jina AI MCP tool) in the message list.
Take a screenshot of the tool call and the agent's response.
Assert: the agent successfully called the Jina AI "primer" tool (NOT the built-in WebSearch) and returned content in its response.
DO NOT skip this step.

---

## trigger-mcp-request-via-chat

In the same chat session, send a new message that causes the agent to request a MCP server it does not yet have.
Type: "Use the DeepWiki MCP to look up the documentation for the github repo 'anthropics/claude-code'."
Press Enter and wait. The agent will attempt to use a tool from `https://mcp.deepwiki.com/mcp`, which is not yet registered.
A purple "MCP Server Requested" card should appear in the message list.
Take a screenshot of the MCP request card.
Assert: the card shows "MCP Server Requested: DeepWiki" (or similar) with the URL `https://mcp.deepwiki.com/mcp`.
DO NOT skip this step.

---

## register-mcp-from-chat

In the MCP request card from the previous step, there should be a "Register" section with a name input and a "Register" button.
Optionally type "DeepWiki" as the display name (it may already be pre-filled).
Click the "Register" button to register the server.
Wait a few seconds for registration and tool discovery.
The card should now show the newly registered DeepWiki server as selectable.
Select it (click on it) and click "Grant Access".
Take a screenshot.
Assert: the card shows "Access Granted", and the agent continues processing with the DeepWiki tools now available.

---

## remove-mcp-from-agent

Open the agent settings dialog.
Navigate to the "MCPs" tab.
Find "Jina AI" in the list and click the remove (trash) icon.
Take a screenshot.
Assert: "Jina AI" is no longer in the agent's MCP list.

---

## remove-mcp-global

Open global settings.
Navigate to the "MCPs" tab.
Find "Jina AI" and "DeepWiki" in the global server list and delete both (click trash icon, confirm if prompted).
Take a screenshot.
Assert: neither "Jina AI" nor "DeepWiki" appear in the global MCP servers list.
