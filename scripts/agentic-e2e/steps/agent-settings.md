# Agent Settings Steps

## open-agent-settings

Click the agent settings button in the main content header (data-testid='agent-settings-button').
The agent settings dialog should open (data-testid='agent-settings-dialog').
Take a screenshot.
Assert: the agent settings dialog is visible.
DO NOT skip this step.

---

## settings-rename

In the agent settings dialog, make sure the General tab is selected.
Find the agent name input field and clear it, then type a new name you choose (e.g. "Renamed Agent").
Click Save.
Take a screenshot.
Assert: the agent name in the sidebar and header has changed to the new name you entered.
DO NOT skip this step.

---

## settings-edit-instructions

In the agent settings dialog, click the "System Prompt" tab.
Clear the existing content and type custom instructions of your choice (e.g. "You are a helpful coding assistant. Always respond concisely.").
Click Save.
Take a screenshot.
Assert: the save completes without error.

---

## settings-add-secret

In the agent settings dialog, click the "Secrets" tab.
Type a key name you choose (e.g. "MY_TEST_KEY") in the key name field.
Type a value you choose in the value field.
Click "Add Secret".
Take a screenshot.
Assert: a row with the key name you entered appears in the secrets list.
DO NOT skip this step.

---

## settings-delete-secret

In the Secrets tab, find the row with the key you just added.
Click the delete (trash) icon on that row.
Take a screenshot.
Assert: the row with that key is gone from the list.

---

## settings-add-connected-account

In the agent settings dialog, click the "Accounts" tab.
Click the "Add accounts" button.
In the picker, check the checkbox for an account shown in the list (note its display name).
Click "Add 1 account(s)".
Take a screenshot.
Assert: the account you selected appears in the connected accounts list.
If no accounts are available to add (the list is empty), note "no accounts available" and move on.

---

## settings-remove-connected-account

In the Accounts tab, find the row for the account you just added.
Click the remove (trash) icon.
Take a screenshot.
Assert: that account is no longer in the list.
If you skipped the add step because no accounts were available, skip this step too.

---

## settings-add-mcp

In the agent settings dialog, click the "MCPs" tab.
Click "Add MCP servers".
Check the checkbox for an MCP server from the list (note its name).
Click "Add 1 server(s)".
Take a screenshot.
Assert: the MCP server you selected appears in the MCPs list.
If no MCP servers are available, note "no MCP servers available" and move on.

---

## settings-remove-mcp

In the MCPs tab, find the row for the MCP server you just added.
Click the remove (trash) icon.
Take a screenshot.
Assert: that MCP server is no longer in the list.
If you skipped the add step, skip this step too.
