---
title: How do I give the agent access to local folders?
description: Volumes and mounts: sharing host folders with the agent workspace.
source_url: https://www.gamut.so/docs/using-superagent/agents/volumes-and-mounts
---

Volumes (also called mounts) give an agent direct read/write access to folders on your host machine. Files inside a mounted folder persist across sessions and container restarts, making volumes the primary mechanism for agents to work with your local projects, documents, and data.

## Why Volumes Matter

By default, each agent runs inside an isolated container with its own filesystem. Files created during a session live inside the container and are accessible across sessions for that agent, but the agent cannot see files elsewhere on your computer.

Volumes solve this by mapping a folder on your host machine to a path inside the container. This enables use cases like:

- **Working on a code repository** -- mount your project folder so the agent can read, edit, and create files in your repo.
- **Processing local documents** -- mount a folder of PDFs, spreadsheets, or data files for the agent to analyze.
- **Sharing output files** -- the agent writes reports, generated code, or other artifacts directly to a folder you can access in Finder/Explorer.
- **Collaborative workflows** -- multiple agents can mount the same host folder to collaborate on shared files.

## How Mounts Work

When you add a mount, Superagent records the mapping between a host path and a container path:

| Property | Example | Description |
| -------------- | --------------------- | ------------------------------------------- |
| Host Path | `/Users/me/projects/myapp` | Absolute path on your machine. |
| Container Path | `/mounts/myapp` | Path the agent sees inside the container. |
| Folder Name | `myapp` | The basename, used for display. |

If multiple mounts share the same folder name, Superagent appends a numeric suffix to the container path (e.g., `/mounts/myapp-2`).

The mount configuration is stored in a `mounts.json` file in the agent's data directory.

## Adding a Mount

1. Open the agent's home page.
2. In the right panel, find the **Volumes** section.
3. Click **Add Mount**.
4. A system file picker dialog opens. Select the folder you want to mount.
5. The mount appears in the volumes list.

If the agent is currently running, a banner appears prompting you to restart. Mount changes only take effect after a container restart.

## Restarting After Changes

When you add or remove a mount while the agent is running, the container needs to restart to pick up the changes. A notification banner appears:

> Restart your agent for mount changes to take effect.

Click **Restart** to stop and restart the agent's container. If the agent is stopped, mount changes are picked up automatically on the next start.

## Managing Mounts

Each mount row in the Volumes section shows the folder name, the full host path, and a health badge.

### Health Status

Superagent checks whether the host path still exists each time the mount list is loaded:

- **OK** -- the folder exists and is accessible.
- **Missing** -- the folder has been moved, renamed, or deleted. The agent will not be able to access it.

### Mount Actions

Hover over a mount row and click the three-dot menu to access:

- **Open in Finder/Explorer** -- opens the host folder in your system file manager.
- **Copy path** -- copies the host path to your clipboard.
- **Remove Mount** -- detaches the folder from the agent. This does not delete any files on the host; it only removes the agent's access.

Removing a mount also requires a restart if the agent is running.

## Attachment Upload vs. Mounts

When you attach a file or folder to a message, Superagent asks how you want to handle it:

- **Upload (copy)** -- copies the file into the agent's container filesystem. Changes made by the agent do not affect your original file.
- **Mount (direct access)** -- adds the folder as a volume mount. The agent gets live read/write access to the original files. Requires a restart if the agent is running.

Use uploads for one-off files you want the agent to reference. Use mounts for ongoing work where the agent needs to read and write to your actual project files.

## Common Use Cases

### Mounting a Code Project

Mount your repository root so the agent can navigate the full project structure, run tools, and make edits:

1. Add a mount pointing to your project directory (e.g., `/Users/me/projects/myapp`).
2. Restart the agent if it is running.
3. In your next message, reference files by their container path (e.g., `/mounts/myapp/src/index.ts`), or simply ask the agent to explore the mounted folder.

### Mounting a Shared Data Folder

Mount a folder of input files (CSVs, logs, documents) and ask the agent to process them. Output files written to the same mount will appear on your host machine immediately.

### Multiple Mounts

You can add multiple mounts to a single agent. Each gets its own container path under `/mounts/`. This is useful when an agent needs access to several independent directories -- for example, a project folder and a reference documentation folder.
