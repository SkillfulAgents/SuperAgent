# Agent Create (Standalone Test)

This feature tests the full UI flow of creating, starting, and deleting agents.
When run as a standalone test, you must clean up after yourself by deleting the agents you create.

## create-agent

Navigate to the app URL if not already there.
Click the Create Agent button in the sidebar (data-testid='create-agent-button').
In the dialog that opens (data-testid='create-agent-dialog'), type a name you choose (e.g. "UI Test Agent") into the agent name input (data-testid='agent-name-input').
Click the submit button (data-testid='create-agent-submit').
Take a screenshot.
Assert: the sidebar now shows an agent with the name you just entered.
DO NOT skip this step.

---

## create-agent-from-template

On the home page, pick a template card that looks interesting and click it.
In the create dialog, review the template. If the template requires environment variables you don't have, click Cancel and note it as "skipped due to missing env vars" — this is acceptable.
If no env vars are required, confirm or adjust the agent name and click Create.
Take a screenshot.
Assert: either a new agent appears in the sidebar, or you cancelled due to missing env vars (both are acceptable outcomes).

---

## wait-agent-running

Click on the agent you created in "create-agent" in the sidebar.
Click the Start button in the agent header to start the container.
Wait for the agent container to start. Check the agent status indicator (data-testid='agent-status') every 15 seconds.
The status transitions: sleeping → starting → running (or idle).
This takes 30-120 seconds.
Take a screenshot once the agent is ready.
Assert: agent status is "running" or "idle".
DO NOT skip this step.

---

## cleanup-created-agents

After testing, delete every agent you created during this test:
1. Right-click the agent in the sidebar.
2. Click "Delete Agent" from the context menu (data-testid='delete-agent-item').
3. In the confirmation dialog (data-testid='confirm-delete-agent-dialog'), click the Delete button (data-testid='confirm-delete-agent-button').
4. Take a screenshot.
5. Assert: the agent no longer appears in the sidebar.

Repeat for each agent you created (from "create-agent" and "create-agent-from-template" if applicable).
DO NOT skip this step — leave the environment clean.
