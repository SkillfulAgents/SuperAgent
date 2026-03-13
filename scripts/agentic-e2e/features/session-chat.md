# Session Chat Steps

Important: the agent MUST be running (status "idle" or "running") before any of these steps.
If the agent is sleeping, start it first and wait for it to be idle.

## send-landing-message

On the agent landing page, find the message input (data-testid='landing-message-input').
Type a test message of your choice (e.g. "Hello, what is 2+2?").
Click the send button (data-testid='landing-send-button') or press Enter.
Take a screenshot.
Assert: the chat view opens and the message appears as a user message.
DO NOT skip this step.

---

## send-message

In the chat message input (data-testid='message-input'), type a test message of your choice.
Click the send button (data-testid='send-button') or press Enter.
Take a screenshot.
Assert: the message appears in the message list as a user message.

---

## wait-response

Wait for the agent to respond. Watch for:
- The activity indicator (data-testid='activity-indicator') to disappear
- A new assistant message to appear in the message list (data-testid='message-list')
- The message input to become enabled again
This typically takes 10-60 seconds. Check every 10 seconds.
Take a screenshot once the response appears.
Assert: at least one assistant message is visible in the message list.
DO NOT skip this step — you must confirm the agent actually responds.

---

## verify-response-contains

Look at the latest assistant message in the message list.
Take a screenshot.
Assert: the assistant message contains a relevant response to what you asked.

---

## verify-tool-call-visible

Look at the message list for tool call cards.
Take a snapshot to inspect the messages.
Assert: if the agent used any tools, a tool call card is visible with the tool name shown.

---

## new-session

Click on the agent name in the sidebar to go back to the agent landing page.
Find the message input (data-testid='landing-message-input').
Type a different message than before (e.g. "What is the capital of Japan?").
Click send.
Wait for the response.
Take a screenshot.
Assert: a new session is created and appears in the sidebar session list.

---

## switch-session

In the sidebar, under the agent's session list, click on a different session than the one currently active.
Take a screenshot.
Assert: the main content shows the messages for that session (they should be different from the other session).

---

## delete-session

In the sidebar, right-click a session item.
Click "Delete Session" from the context menu.
Confirm deletion in the dialog.
Take a screenshot.
Assert: the session no longer appears in the sidebar.

---

## interrupt-agent

Send a message that would take the agent a long time to process (e.g. "Write a very detailed 2000-word essay about the history of computing").
While the agent is processing (activity indicator visible), click the Stop button (data-testid='stop-button').
Take a screenshot.
Assert: the agent stops and the activity indicator disappears.
Note: if the agent responds too quickly for you to interrupt, that is acceptable — note it and move on.

---

## attach-file

Note: file upload via the Playwright browser may not work if the file picker is a native OS dialog.
If you can click the attachment button and see a way to attach, try it.
If the file picker is a native dialog you cannot interact with, skip this step and note "native file dialog not accessible via browser automation".
