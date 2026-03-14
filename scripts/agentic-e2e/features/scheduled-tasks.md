# Scheduled Tasks

Scheduled tasks are recurring jobs that an agent can create during a chat conversation using the `schedule_task` tool. They are not created through a settings UI. Once created, tasks appear in the sidebar and can trigger automatically on their defined schedule, spawning new sessions when they run.

Prerequisite: the agent must be in an active state (idle or running) for task creation and execution to work.

## Task Creation via Chat

Tasks are created conversationally — the user asks the agent to schedule something, and the agent invokes the `schedule_task` tool.

### Components

- **Tool call card** (`schedule_task`): an inline card in the assistant message confirming the tool was invoked to create the scheduled task.
- **Agent confirmation message**: the assistant's response indicating the task was successfully scheduled.

### Interactions

- The user sends a message requesting a recurring task. The agent processes the request and calls `schedule_task`.
- On success, the agent responds with confirmation and the new task appears in the sidebar.

## Sidebar — Scheduled Task Items

Scheduled tasks appear as sub-items under their parent agent in the sidebar tree.

### Components

- **Scheduled task item**: a tree node nested under the agent entry. Each item represents one scheduled task.

### Interactions

- Expanding the agent's sidebar tree reveals any scheduled tasks belonging to that agent.
- Clicking a scheduled task item navigates to the task detail view.

## Task Detail View

The main content area for a selected scheduled task, showing its configuration and status.

### Components

- **Schedule expression**: displays the cron expression defining the task's recurrence.
- **Next run time**: shows when the task is next scheduled to execute.
- **Task status**: indicates the current state of the task (e.g., active, cancelled).
- **Cancel Task button**: initiates task cancellation.

### Interactions

- Clicking "Cancel Task" opens a confirmation dialog. Confirming cancels the task, updates its status, and reflects the change in the sidebar.

## Automatic Task Execution

When a scheduled task's cron expression matches the current time, it triggers automatically.

### Behavior

- A triggered task creates a new session under the agent, visible in the sidebar's session list.
- Cancelled tasks do not trigger.
