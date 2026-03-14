# Session Chat

The session chat is the primary conversational interface between the user and an agent. It spans two pages: the **agent landing page** (where a conversation begins) and the **chat view** (where an ongoing conversation lives). The sidebar provides session management.

Prerequisite: the agent must be in an active state (idle or running) for chat features to be available.

## Agent Landing Page

The landing page is the entry point for starting a new conversation with an agent.

### Components

- **Message input** (data-testid=`landing-message-input`): a text field where the user composes their first message.
- **Send button** (data-testid=`landing-send-button`): submits the message. Pressing Enter in the input has the same effect.

### Interactions

- Typing a message and sending it transitions the user into the chat view, with the submitted message displayed as the first user message.

## Chat View

The chat view displays the message history for a session and allows continued conversation.

### Components

- **Message list** (data-testid=`message-list`): a scrollable list of all messages in the current session. Messages are either user messages or assistant messages, displayed in chronological order.
- **Message input** (data-testid=`message-input`): a text field for composing follow-up messages. Disabled while the agent is processing.
- **Send button** (data-testid=`send-button`): submits the current message. Enter also submits.
- **Activity indicator** (data-testid=`activity-indicator`): visible while the agent is processing a response. Disappears when the agent finishes.
- **Stop button** (data-testid=`stop-button`): appears while the agent is processing. Interrupts the agent and halts response generation.
- **Tool call cards**: inline cards within assistant messages that show when the agent invoked a tool. Each card displays the tool name.
- **Attachment button**: allows the user to attach a file to a message. Note: this opens a native OS file picker, which may not be programmatically accessible.

### Interactions

- Sending a message appends it to the message list as a user message. The agent begins processing and the activity indicator appears.
- Once the agent responds, the assistant message appears in the message list, the activity indicator disappears, and the message input re-enables.
- Clicking the stop button while the agent is processing interrupts it, removes the activity indicator, and returns the input to an enabled state.
- Tool call cards are read-only and indicate which tools the agent used during its response.

## Sidebar — Session Management

The sidebar lists all sessions belonging to the current agent.

### Components

- **Agent name link**: navigates back to the agent landing page (used to start a new session).
- **Session list**: a list of sessions under the agent. The currently active session is highlighted.
- **Context menu** (on right-click of a session item): provides session actions including "Delete Session".
- **Deletion confirmation dialog**: appears after selecting "Delete Session", requiring user confirmation.

### Interactions

- Clicking the agent name navigates to the landing page, allowing the user to start a fresh session.
- Sending a message from the landing page creates a new session, which then appears in the sidebar session list.
- Clicking a different session in the sidebar switches the chat view to display that session's message history.
- Right-clicking a session and selecting "Delete Session" opens a confirmation dialog. Confirming removes the session from the sidebar and its message history.
