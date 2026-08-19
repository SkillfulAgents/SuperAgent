# Scheduling Tasks and Resuming Sessions

Read this guide before creating or changing a scheduled task, or before
pausing a session for later continuation.

## Choose the Correct Mechanism

Use `mcp__user-input__schedule_task` for independent future work:

- a reminder or report that should run in a new session;
- periodic maintenance, monitoring, or notifications;
- work that does not need the current conversation's context.

Use `mcp__user-input__schedule_resume` when the follow-up continues the current
conversation:

- waiting for a reply after sending a message;
- waiting for a review, approval, build, deployment, or external job;
- checking the same unresolved condition later with the current context.

Do not emulate a session pause with `schedule_task`. A scheduled task starts a
new session and loses the conversational state that made the wait meaningful.

## One-Time and Recurring Tasks

`schedule_task` supports:

- `scheduleType: "at"` for one-time work, with expressions such as `at tomorrow
  9am`, `at now + 2 hours`, or `at 2026-09-01 14:00`;
- `scheduleType: "cron"` for recurring work, using standard five-field cron.

Common cron expressions:

```text
0 9 * * 1-5   Weekdays at 9:00 AM
0 0 * * *     Daily at midnight
*/15 * * * *  Every 15 minutes
0 0 1 * *     First day of every month
```

Make the scheduled prompt self-contained. A new session will receive that
prompt, not the conversation that created it. Include the intended output,
destination, relevant scope, and any conditions that should suppress action.

## Managing Scheduled Tasks

Call `mcp__user-input__list_scheduled_tasks` first to resolve task IDs and see
current state. Then use the dedicated cancel, pause, or resume tool.

- One-time tasks disappear after they execute.
- Recurring tasks continue until cancelled.
- Only recurring tasks can be paused and resumed.
- Resuming recomputes the next cron occurrence; missed runs are not replayed.

## Pausing the Current Session

Call `mcp__user-input__schedule_resume` with:

- `wakeTime`: a clear natural-language time such as `tomorrow 9am` or `in 72
  hours`;
- `note`: a compact instruction to the future continuation explaining what to
  check and what outcome is expected.

After scheduling the resume, end the turn. The current session supports one
pending wake; a new wake replaces the previous one. Wakes are one-shot. If the
condition is still unresolved after resuming, inspect the current state and
schedule another wake if appropriate.

## Time and Safety

- Interpret ambiguous times in the user's configured timezone.
- Use an absolute date when communicating a resolved relative date.
- Confirm consequential external actions unless the user already authorized
  them; scheduling a prompt does not broaden its authority.
- Do not create recurring work when the user asked for a one-time reminder.
