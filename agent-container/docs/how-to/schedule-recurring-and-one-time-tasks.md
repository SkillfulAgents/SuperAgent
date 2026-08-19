---
title: How do I schedule recurring or one-time tasks?
description: Scheduled tasks: cron-style recurring jobs and one-time future runs, and managing them.
source_url: https://www.gamut.so/docs/using-superagent/automation/scheduled-tasks
---

Scheduled tasks let you run agents automatically at specific times or on recurring intervals. You can schedule a one-time task ("run this tomorrow at 9am") or a recurring cron ("every weekday at 9am"). Tasks are created either by you through the UI or by agents themselves using the `schedule_task` MCP tool.

## Schedule types

Superagent supports two schedule types:

- **One-time (`at`)** --- Run once at a specific date and time, then mark as executed. Good for reminders, deferred work, and one-off checks.
- **Recurring (`cron`)** --- Run on a repeating schedule defined by a cron expression. Good for daily reports, periodic monitoring, and maintenance routines.

## Creating a scheduled task

### From the agent conversation

Agents can schedule tasks on their own using the `schedule_task` tool. When you ask an agent to do something later or on a recurring basis, it will call this tool with the appropriate parameters:

| Parameter | Required | Description |
|---|---|---|
| `scheduleType` | Yes | `"at"` for one-time or `"cron"` for recurring |
| `scheduleExpression` | Yes | Natural language time (for `at`) or cron expression (for `cron`) |
| `prompt` | Yes | The instructions the agent will execute when the task fires |
| `name` | No | A human-readable label for the task |
| `timezone` | No | IANA timezone identifier (e.g. `America/New_York`). Falls back to the agent owner's timezone, then UTC |
| `model` | No | Override the model used for this task's sessions |
| `effort` | No | Override the effort level: `low`, `medium`, `high`, `xhigh`, or `max` |

For example, asking your agent "Check my inbox every morning at 9am and summarize anything urgent" will cause it to create a recurring cron task with the appropriate schedule and prompt.

### From the UI

Scheduled tasks appear in the **Triggers** section on your agent's home page. Once created, you can view details, edit the schedule, pause, resume, run immediately, or delete the task.

## Natural language schedules

One-time (`at`) tasks accept natural language date expressions powered by chrono-node. The parser understands a wide variety of formats:

**Relative times:**
- `at now + 30 minutes`
- `at now + 2 hours`
- `at now + 1 day`
- `at now + 2 weeks`
- `at now + 1 month`

**Natural language dates:**
- `at tomorrow`
- `at tomorrow 9am`
- `at next monday`
- `at next friday at 3pm`
- `at December 25 10am`

The parser is case-insensitive and handles both singular and plural units (`hour` / `hours`). Relative times like `at now + 1 hour` are timezone-independent since they are calculated from the current moment. Natural language dates like `at tomorrow 9am` respect the configured timezone.

Dates in the past are rejected with an error.

## Cron expressions

Recurring (`cron`) tasks use standard five-field cron expressions:

```
 ┌───────────── minute (0-59)
 │ ┌───────────── hour (0-23)
 │ │ ┌───────────── day of month (1-31)
 │ │ │ ┌───────────── month (1-12)
 │ │ │ │ ┌───────────── day of week (0-7, 0 and 7 are Sunday)
 │ │ │ │ │
 * * * * *
```

**Common examples:**

| Expression | Meaning |
|---|---|
| `* * * * *` | Every minute |
| `0 * * * *` | Every hour |
| `*/15 * * * *` | Every 15 minutes |
| `0 9 * * *` | Daily at 9:00 AM |
| `0 9 * * 1-5` | Weekdays at 9:00 AM |
| `0 0 * * 0` | Weekly on Sunday at midnight |
| `0 0 1 * *` | Monthly on the 1st at midnight |

### Editing schedules with natural language

In the task detail view, you can edit a recurring task's schedule using plain English. The UI provides a "Convert to Cron" button that translates your description (e.g. "every weekday at 9am") into a validated cron expression before saving.

## Timezone support

All schedule times are interpreted in the task's configured timezone. If no timezone is specified, the system falls back to the agent owner's timezone, then to UTC.

- **Cron tasks** use the IANA timezone for execution. DST transitions are handled automatically --- a task scheduled for "daily at 9am America/New_York" will always fire at 9am local time regardless of the time change.
- **One-time tasks** with natural language dates (e.g. `at tomorrow 9am`) are interpreted in the configured timezone.
- **Relative times** (e.g. `at now + 1 hour`) are timezone-independent.

You can change a task's timezone at any time from the task detail view. The next execution time is recalculated automatically when the timezone changes.

## Task lifecycle

Each scheduled task moves through a defined set of statuses:

| Status | Meaning |
|---|---|
| **Pending** | Active and waiting for its next execution time |
| **Paused** | Temporarily suspended. No executions will fire until resumed |
| **Executed** | One-time task that has completed its single run |
| **Cancelled** | Permanently stopped by the user |
| **Failed** | Execution failed (e.g. the agent no longer exists) |

### Status transitions

- A **pending** recurring task can be **paused** or **cancelled**.
- A **paused** task can be **resumed** (returns to pending with a recalculated next execution time, skipping any missed runs) or **cancelled**.
- A **failed** or **cancelled** task can be **reset** back to pending.
- A **pending** one-time task becomes **executed** after it runs.

## Managing tasks

From the task detail view you can:

- **Run Now** --- Execute the task immediately. For recurring tasks, this triggers an extra run without affecting the schedule. For one-time tasks, this consumes the scheduled run.
- **Pause / Resume** --- Temporarily suspend a recurring task without deleting it. When resumed, the next execution is recalculated from the current time.
- **Edit Instructions** --- Update the prompt that runs when the task fires.
- **Edit Schedule** --- Change the cron expression or timezone for recurring tasks.
- **Delete** --- Permanently cancel the task.

## Runtime overrides

Each task can optionally override the global model and effort level. This lets you run cost-sensitive recurring tasks on a lighter model or boost effort for critical one-time tasks without changing your agent's default settings.

- **Model** --- Override which Claude model handles the task's sessions.
- **Effort** --- Override the thinking effort level (`low`, `medium`, `high`, `xhigh`, `max`).

Set these when creating the task (via the `model` and `effort` parameters in `schedule_task`) or update them later from the task detail view. Set a field to `null` to revert to the global default.

## Run history

Every time a scheduled task fires, it creates a new agent session. The task detail view shows a complete run history with links to each session, so you can review what the agent did on each execution. Recurring tasks also display a total execution count.

## The `schedule_task` MCP tool

Agents have access to the `schedule_task` tool, which means they can create scheduled tasks programmatically during a conversation. This enables patterns like:

- An agent sets up its own recurring monitoring after you describe what to watch for.
- An agent schedules a follow-up task to check on the results of a long-running operation.
- An agent creates a deferred task when it determines the right time to act is later.

The tool is non-blocking --- the agent continues its conversation immediately after scheduling, and the task runs independently at the scheduled time in a new session.

## As the agent

- Create with `mcp__user-input__schedule_task`: `scheduleType` `"at"` (one-time) or `"cron"` (recurring), `scheduleExpression`, `prompt` (what the new session should do), optional `name`.
  - `"at"` accepts natural/relative forms: `at now + 1 hour`, `at tomorrow 9am`, `at next monday`, `at 2026-03-15 14:00`.
  - `"cron"` is standard 5-field syntax: `0 9 * * 1-5` (weekdays 9am), `*/15 * * * *` (every 15 min), `0 0 1 * *` (monthly). Evaluated in the container's `TZ`.
- Manage with `mcp__user-input__list_scheduled_tasks` (get IDs first), then `cancel_scheduled_task`, `pause_scheduled_task`, `resume_scheduled_task` (pause/resume are cron-only; missed runs are skipped on resume).
- Each run starts a **new session** with your `prompt` — write it self-contained; it has no memory of this conversation beyond what's in workspace files and memory.
- One-time tasks disappear after running; recurring ones run until cancelled. The user sees and manages all of them in the UI too.
- If the follow-up needs THIS conversation's context (awaiting a reply, checking on a submission), don't schedule a task — pause this session with `mcp__user-input__schedule_resume` instead and end your turn.
