# Scheduled Tasks

This feature covers task creation via chat, sidebar task entries, task detail/cancel flow, and automatic scheduled execution.

## Prerequisites

- Agent status is `running` or `idle`.

## Chat View - Task Creation

### Components
- **`schedule_task` tool call card** - confirms task creation invocation.
- **Assistant confirmation message** - confirms scheduling result.

### Interactions
- Ask agent to create a recurring task.
- Verify task appears in sidebar on success.

## Sidebar - Scheduled Task Items

### Components
- **Scheduled task item** - task node under parent agent.

### Interactions
- Expand agent node and view scheduled tasks.
- Click a scheduled task item to open task details.

## Task Detail View

### Components
- **Schedule expression field** - cron expression.
- **Next run time field** - next planned execution time.
- **Task status field** - active/cancelled state.
- **Cancel Task button** - starts cancellation flow.

### Interactions
- Cancel a task via cancel button and confirmation dialog.
- Verify status and sidebar reflect cancellation.

## Automatic Execution

### Components
- **Generated session entry** - new session created by triggered task.

### Interactions
- Wait for schedule trigger window.
- Verify a new session appears when task runs.
- Verify cancelled tasks do not trigger.

