# SuperAgent UI Details

## Product Overview

SuperAgent is an AI Agent management platform. Users create **Agents** (each runs in its own Docker container with Claude Code CLI). Users interact through **Sessions** (chat conversations). Agents can browse the web, run code, create dashboards, schedule tasks, and request secrets/OAuth from the user.

Core concepts: **Agent** (container), **Session** (chat), **Dashboard** (agent-created web app), **Scheduled Task** (cron-triggered prompt), **Skill** (reusable capability), **MCP** (remote tool server), **Connected Account** (OAuth-linked service).

---

## Layout

- **Sidebar** (left): Brand "Super Agent", status warnings, agent list with expandable sessions/dashboards/tasks, footer (Settings, Notifications, user menu).
- **Main content** (right): Varies by selection — Home, Agent Landing, Chat, Dashboard, Scheduled Task.
- **Routing**: No agent → Home. Agent + no session → Agent Landing. Agent + session → Chat. Agent + dashboard → Dashboard View. Agent + task → Scheduled Task View.

---

## Key Behaviors (Not Visible in Snapshot)

### Agent Lifecycle

After creating an agent, the container must start. Status: **created → starting → running**. Startup takes **30–120 seconds**. Do not try to send messages until status is ready. 

### Message Flow

User sends message → agent responds via SSE stream. Response typically takes **5–60 seconds** (longer for multi-tool tasks). Wait for the activity indicator to disappear and input to re-enable before asserting.

### Agent Status Indicators

- **sleeping** (stopped): Moon icon, gray. Container is not running.
- **idle** (running, no active sessions): Blue solid dot.
- **working** (running + active sessions): Green pulsing dot.

### First Launch

A **Getting Started Wizard** dialog may auto-open. Dismiss it by clicking through steps (Next/Skip/Finish) before testing the main UI.

### Offline

When offline, message input shows "No internet connection..." and cannot send. A warning banner may appear in the sidebar.

---

## Key data-testid (Use When Snapshot Is Ambiguous)

| Element | data-testid |
|---|---|
| Create agent button (sidebar) | `create-agent-button` |
| Create agent dialog | `create-agent-dialog` |
| Agent name input | `agent-name-input` |
| Create agent submit | `create-agent-submit` |
| Agent settings (header) | `agent-settings-button` |
| Agent settings dialog | `agent-settings-dialog` |
| Delete agent | `delete-agent-button` |
| Settings (sidebar) | `settings-button` |
| Wizard dialog | `wizard-dialog` |
| Wizard create agent | `wizard-create-agent` |
| Wizard next / skip / finish | `wizard-next`, `wizard-skip`, `wizard-finish` |
| Landing message input | `landing-message-input` |
| Landing send button | `landing-send-button` |
| Message input | `message-input` |
| Send button | `send-button` |
| Stop button | `stop-button` |
| Message list | `message-list` |
| Activity indicator | `activity-indicator` |
| Tool call card | `tool-call-{name}` |

---

## Common Gotchas

- **Wizard on first load**: If setup is incomplete, the wizard blocks the main UI. Complete or skip all steps.
- **Agent not running**: Cannot create sessions or send messages. Use the Start button in the header and wait for "running" or "idle".
- **Streaming response**: Assistant text appears incrementally. Wait for the full response before asserting content.
- **Interactive requests**: Secret/Question/File/Account/MCP requests appear as cards at the bottom of the message list. The agent pauses until the user provides or declines.
- **View-only mode**: Non-owners see a banner and cannot send messages. Select a session from the sidebar to view.
