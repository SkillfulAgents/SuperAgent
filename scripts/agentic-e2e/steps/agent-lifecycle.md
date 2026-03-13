# Agent Lifecycle Steps

## agent-stop

Click the agent settings button in the header (data-testid='agent-settings-button'), or find the Stop button directly in the agent header.
Click the Stop button to stop the agent container.
Wait for the status indicator to change to "sleeping" (moon icon, gray). This may take 5-15 seconds.
Take a screenshot.
Assert: agent status shows "sleeping".
DO NOT skip this step.

---

## agent-start

With the agent in sleeping state, click the Start button in the agent header.
Wait for the status to return to "running" or "idle" (30-120 seconds).
Take a screenshot.
Assert: agent status is "running" or "idle".
DO NOT skip this step.

---

## verify-session-persisted

After restarting the agent, check the sidebar for the session list under the agent.
Take a snapshot.
Assert: previously created sessions are still visible in the sidebar — they should not have been lost during stop/start.

---

## agent-delete

Right-click the agent you previously created in the sidebar.
Click "Delete Agent" from the context menu (data-testid='delete-agent-item').
In the confirmation dialog (data-testid='confirm-delete-agent-dialog'), click the Delete button (data-testid='confirm-delete-agent-button').
Take a screenshot.
Assert: the agent you deleted no longer appears in the sidebar.
DO NOT skip this step.

---

## verify-agent-gone

Take a snapshot of the sidebar.
Assert: the agent you previously deleted no longer exists in the sidebar.
