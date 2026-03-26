# Skills

This feature covers discovering/installing skills from landing page and managing installed skills from settings.

## Prerequisites

- Agent landing page is accessible.

## Agent Landing Page - Discoverable Skills

### Components
- **Discoverable skills section** - list of available skill cards.
- **Skill card** - displays skill name and description.
- **Install button** (`+`) - starts installation.
- **Environment variable dialog** - appears for skills requiring env vars.

### Interactions
- Install a skill from landing page.
- If env vars are required, complete dialog and confirm.
- Verify skill appears in installed list after installation.

## Agent Settings - Skills Tab

### Components
- **Installed skills list** - all installed skills on agent.
- **Skill status label** - `Up to date`, `locally-modified`, or `update-available`.
- **Update button** - shown when updates are available.

### Interactions
- Open Skills tab and verify installed skills + statuses.
- Click Update on an `update-available` skill and verify status becomes `Up to date`.

