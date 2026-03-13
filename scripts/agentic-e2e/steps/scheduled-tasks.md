# Scheduled Tasks Steps

Scheduled tasks are created by the agent during a chat conversation, not through settings UI.
You must first ensure the agent is running, then ask it to schedule one.

## ensure-agent-running

Make sure the agent is running (status "idle"). If the agent is sleeping, click the Start button and wait for it to become idle (30-120 seconds).
Take a screenshot confirming the agent is running.
Assert: agent status is "idle" or "running".
DO NOT skip this step — all following steps require an active agent.

---

## create-task-via-chat

Click the agent in the sidebar to open the chat view (or use an existing session).
Type the following message and press Enter:
"Schedule a task that runs every 5 minutes and just says 'ping'. Confirm when scheduled."
Wait for the agent to finish processing — this may take 20-40 seconds.
Watch for a tool call card (e.g. "schedule_task") in the message list.
Take a screenshot once the agent confirms the task is scheduled.
Assert: the agent's response mentions the task was scheduled successfully.
DO NOT skip this step — the remaining scheduled task tests depend on a task existing.

---

## verify-task-in-sidebar

After the agent has scheduled a task, check the sidebar under the current agent.
Expand the agent's tree if needed — scheduled tasks appear as sub-items.
Take a snapshot of the sidebar.
Assert: a scheduled task item is visible under the agent in the sidebar.

---

## open-task

Click the scheduled task item in the sidebar.
Take a screenshot.
Assert: the main content area shows the scheduled task view with task details (schedule expression, next run time).

---

## cancel-task

In the scheduled task view, click the "Cancel Task" button.
In the confirmation dialog, click to confirm cancellation.
Take a screenshot.
Assert: the task status shows as "cancelled" and the task item is removed or marked in the sidebar.

---

## verify-task-triggered

Note: this step requires waiting for the scheduled task to actually trigger. If the task was set to run every 5 minutes, you may need to wait.
If you have time, wait up to 90 seconds and check for a new session created by the task.
If you already cancelled the task in the previous step, you can skip this step — note "task was cancelled before trigger".
