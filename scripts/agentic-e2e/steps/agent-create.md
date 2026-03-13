# Agent Create Steps

## create-agent

Navigate to the app URL if not already there.
Click the Create Agent button in the sidebar (data-testid='create-agent-button').
In the dialog that opens (data-testid='create-agent-dialog'), type a name you choose (e.g. "Test Agent") into the agent name input (data-testid='agent-name-input').
Click the submit button (data-testid='create-agent-submit').
Take a screenshot.
Assert: the sidebar now shows an agent with the name you just entered.
DO NOT skip this step — every other test depends on having an agent created.

---

## create-agent-from-template

Navigate to the app URL if not already there.
On the home page, pick a template card that looks interesting and click it.
In the create dialog, review the template. If the template requires environment variables you don't have, click Cancel and note it as "skipped due to missing env vars" — this is acceptable.
If no env vars are required, confirm or adjust the agent name and click Create.
Take a screenshot.
Assert: either a new agent appears in the sidebar, or you cancelled due to missing env vars (both are acceptable outcomes).

---

## wait-agent-running

After creating the agent, click the Start button in the agent header to start the container.
Wait for the agent container to start. Check the agent status indicator (data-testid='agent-status') every 15 seconds.
The status transitions: sleeping → starting → running (or idle).
This takes 30-120 seconds. Do NOT send any messages until the status shows running or idle.
Take a screenshot once the agent is ready.
Assert: agent status is "running" or "idle".
DO NOT skip this step — the agent must be running before any chat or interaction tests.
