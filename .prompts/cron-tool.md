I want to implement another custom tool that the agents can use --> a schedule job scheduler. This tool should allow agents to schedule tasks to be executed at specific times or intervals.

Here's the basic flow:
- The agent figures out it needs to schedule a task (for instance, user asks to send an email tomorrow, or to clean the database every day at midnight).
- The agent calls the cron tool with the task details and the desired schedule
    - It can either provide `at` syntax for one-time tasks (e.g., "at now + 1 day") or `cron` syntax for recurring tasks (e.g., "0 0 * * *" for daily at midnight).
    - It also provides a prompt (the task to be executed). The prompt will be passed to the agent as a new session at the scheduled time.
- The cron tool (running inside the container) only validates the input -- the actual scheduling is handled by the API server (as the container may be ephemeral).
- The API server identifies the tool call and saves it in the database with the schedule and prompt.
- A separate scheduler process (could be a simple cron job or a long-running process) periodically checks the database for due tasks and triggers the agent with the saved prompt at the appropriate times.
    - note that the server might be offline when the task is due, so we need to handle that gracefully (e.g., by checking for overdue tasks when the server starts up) and executing them as soon as possible.
- The agent executes the task as if it was a new user request, using the saved prompt.

In the UI, we will show scheduled tasks in the left nav under the agent name (like regular sessions) but greyed out until they are executed, and with a clock icon.
If you click on a schedule task, you will see a chat view, but the prompt will be in a dotted box at the top indicating it's a scheduled task, and the rest of the chat will be empty until the task is executed. No user input is allowed in scheduled task sessions.
    - You will also see the time it is scheduled for and the next execution time for recurring tasks.
    - You can also have an option to cancel scheduled tasks from the UI before they are executed.

In the session metadat, we should add a flag indicating if the session was created from a scheduled task, and if so, the schedule details (time, recurrence, etc.). And in the UI for existing sessions that have this flag, we can show that it was created from a scheduled task (so users understand the context).