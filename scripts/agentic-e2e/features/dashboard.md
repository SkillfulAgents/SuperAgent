# Dashboard Steps

Dashboards are created by the agent during a chat conversation, not through settings UI.
You must first ensure the agent is running, then ask it to create one.

## ensure-agent-running

Make sure the agent is running (status "idle"). If the agent is sleeping, click the Start button and wait for it to become idle (30-120 seconds).
Take a screenshot confirming the agent is running.
Assert: agent status is "idle" or "running".
DO NOT skip this step — all following steps require an active agent.

---

## create-dashboard-via-chat

Click the agent in the sidebar to open the chat view.
Type the following message and press Enter:
"Create a simple dashboard called 'clock' that shows the current time. Use the plain framework."
Wait for the agent to finish processing — this may take 30-60 seconds as the agent writes code and sets up the dashboard.
Watch for a tool call card (e.g. "create_dashboard") in the message list.
Take a screenshot once the agent confirms the dashboard is created.
Assert: the agent's response mentions the dashboard was created successfully.
DO NOT skip this step — the remaining dashboard tests depend on a dashboard existing.

---

## verify-dashboard-in-sidebar

After the agent has created a dashboard, check the sidebar under the current agent.
Expand the agent's tree if needed — dashboards appear as sub-items.
Take a snapshot of the sidebar.
Assert: a dashboard item is visible under the agent in the sidebar.

---

## open-dashboard

Click the dashboard item in the sidebar.
Take a screenshot.
Assert: the main content area shows the dashboard view with an iframe.

---

## verify-dashboard-loaded

Wait up to 15 seconds for the dashboard iframe to load content.
Take a screenshot.
Assert: the iframe is visible and shows content (not blank, not an error page).

---

## delete-dashboard

Right-click a dashboard item in the sidebar.
Click "Delete Dashboard" from the context menu.
Confirm deletion.
Take a screenshot.
Assert: the dashboard item no longer appears in the sidebar.
