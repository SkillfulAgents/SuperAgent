# Skills

Skills are modular capabilities that can be installed on an agent. They are discovered and installed from the agent landing page, and managed through the agent settings dialog.

## Agent Landing Page — Discoverable Skills

The landing page includes a section showcasing skills available for installation.

### Components

- **Discoverable skills section**: a collection of skill cards displayed on the agent landing page.
- **Skill card**: each card shows the skill's name and description.
- **Install button** (`+`): located on each skill card, initiates installation.
- **Environment variable dialog**: a modal that appears during installation if the skill requires environment variables to be configured. Contains input fields for each required variable, along with confirm and cancel actions.

### Interactions

- Clicking the install button on a skill card installs the skill. If the skill requires environment variables, the env var dialog appears first; the user must fill in the values and confirm before installation proceeds.
- After successful installation, the skill is added to the agent's installed skills list.

## Agent Settings — Skills Tab

The Skills tab within the agent settings dialog provides management for installed skills.

### Components

- **Installed skills list**: shows all skills currently installed on the agent.
- **Skill status**: each skill displays its current state — "Up to date", "locally-modified", or "update-available".
- **Update button**: appears on skills with "update-available" status.

### Interactions

- Opening the agent settings dialog and navigating to the "Skills" tab displays the list of installed skills and their statuses.
- Clicking "Update" on a skill with available updates applies the update, changing the skill's status to "Up to date".
