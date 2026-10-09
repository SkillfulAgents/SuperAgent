# Mounted volumes and shutdown

A file closed by an agent can still be waiting in rclone’s upload queue. Safe stop keeps the host API and the volume’s authorization available until those uploads finish.

The container first checks existing uploads and unfinished writer cleanup. It then prevents new writes, closes sessions and dashboards, and drains again to include their final writes. A failed preflight leaves current work alone. A final drain can fail after work was interrupted; the API reports that distinction. A previous failed writer cleanup is checked before interrupting a new turn.

The host closes the host browser after preparation succeeds and before container teardown. Runtime inspection failures mean unknown, not stopped. If the container API is unreachable, a successful runtime inspection can confirm that the container already exited; otherwise safe stop declines. Explicit force stop bypasses preparation and may discard unsynced files.

## Mount configuration

Removing a mount stages its removal in SQLite and displays a restart banner. It does not interrupt the current turn. Its upload grant remains valid until a confirmed stop or until a fresh container starts without that mount. Reattaching the same definition cancels the pending removal. Pending removals survive host restarts.

Adding a mount with immediate restart first obtains a safe stop, before creating the definition or attachment. A declined stop returns the structured upload warning. The renderer can offer an explicit force retry without creating duplicate volumes.

Deletion prevents all new starts, including scheduled tasks and webhooks, throughout stop, credential cleanup, and workspace removal. A launch already submitted to the runtime must settle before teardown.

## Quitting

Desktop quit attempts safe stops while the API, credentials and background services remain available. If any agent cannot stop safely, the app offers **Cancel** or **Quit Anyway**. Cancel keeps the app and pending-upload dependencies available. Quit Anyway explicitly allows discarding remaining uploads. The shared runtime is shut down only after every container has stopped; a safe quit never force-kills the shared VM as a fallback for one agent.

There is no process-exit deadline competing with the safe-drain deadline. Each container shutdown attempt is bounded, including an in-flight launch, preparation, browser cleanup and runtime teardown. The final desktop process-exit fallback only starts after container shutdown succeeds.

The standalone server cancels a SIGTERM/SIGINT shutdown if safe stop fails, logs the failure, and continues serving uploads. Resolve the problem or explicitly force-stop the affected agents through the app/API, then send the signal again. A supervisor can still kill the process externally; that cannot guarantee upload completion.

Vite has already closed its HTTP listener when its shutdown hook runs, so a declined development-server stop preserves the containers and runtime and logs that the server must be restarted to resume uploads. It never shuts down the VM underneath a refused drain.
