---
title: How do skills and skillsets work?
description: Skills the agent creates and reuses, managing them, and hosting shared skillsets on GitHub.
source_url:
  - https://www.gamut.so/docs/using-superagent/skillsets/overview
  - https://www.gamut.so/docs/using-superagent/skillsets/managing-skills
  - https://www.gamut.so/docs/using-superagent/skillsets/hosting-a-github-skillset
---

## Skillsets Overview

Skillsets are shared collections of skills backed by Git repositories. Each skill is a self-contained package of instructions, tools, and knowledge that teaches an agent how to perform a specific task -- such as reviewing an NDA, querying a database, or triaging support tickets.

By installing skills from a skillset, you give agents instant access to curated capabilities without having to build them from scratch.

### What is a skill?

A skill is a directory containing a `SKILL.md` file and optionally supporting files (templates, reference data, configuration). The `SKILL.md` file uses YAML frontmatter to declare metadata and Markdown body content to provide the instructions that an agent follows when performing the task.

A typical `SKILL.md` looks like this:

```yaml
---
name: NDA Review
description: Reviews NDAs for standard clause coverage and flags unusual terms.
metadata:
  version: 1.2.0
  required_env_vars:
    - name: LEGAL_DB_API_KEY
      description: API key for the legal document database
---

# NDA Review

When asked to review an NDA, follow these steps:

1. Extract all defined terms and party names.
2. Check for standard clauses: confidentiality, term, exclusions, remedies.
3. Flag any unusual or non-standard provisions.
...
```

The agent reads these instructions at runtime and follows them to carry out the task. Skills can also include auxiliary files alongside `SKILL.md` -- for example, a `template.md` with a standard output format or a `reference-data.json` with lookup tables.

### What is a skillset?

A skillset is a Git repository that bundles multiple skills together under a shared `index.json` manifest. The manifest declares the skillset's name, description, version, and lists every skill available in the repository along with its path and version.

```
my-skillset/
  index.json
  skills/
    nda-review/
      SKILL.md
    supabase-query/
      SKILL.md
      schema-reference.json
    email-triage/
      SKILL.md
      templates/
        escalation.md
```

The `index.json` file provides the top-level metadata that SuperAgent reads when discovering available skills:

```json
{
  "skillset_name": "Legal & Ops Skills",
  "description": "Shared skills for the legal and operations team.",
  "version": "2.1.0",
  "skills": [
    {
      "name": "NDA Review",
      "path": "skills/nda-review/SKILL.md",
      "description": "Reviews NDAs for clause coverage and flags unusual terms.",
      "version": "1.2.0"
    },
    {
      "name": "Supabase Query",
      "path": "skills/supabase-query/SKILL.md",
      "description": "Queries a Supabase database and returns formatted results.",
      "version": "1.0.0"
    }
  ]
}
```

### Skill providers

SuperAgent supports three types of skill providers, each with different access and publishing models:

#### GitHub

The default provider. You register a skillset by providing its GitHub repository URL (HTTPS or SSH). SuperAgent clones the repository locally and keeps a cached copy that it refreshes when you pull updates.

GitHub skillsets support full collaboration: you can modify an installed skill locally, then submit your changes back to the upstream repository as a pull request. This makes it easy for teams to iterate on shared skills through standard code review workflows.

**Requirements:** Git must be installed. For private repositories, SSH authentication must be configured.

#### Platform

Platform-provided skillsets are managed through the SuperAgent platform. When you connect to a platform organization, any skillsets published by your organization are automatically synced to your local instance.

Platform skillsets use a hosted submission model instead of pull requests. When you modify a skill and submit changes, they go through the platform's review queue rather than creating a GitHub PR.

**Requirements:** An active platform connection with a valid organization.

#### Public

Public skillsets are read-only skill collections hosted on public GitHub repositories. SuperAgent downloads them as ZIP archives, so Git does not need to be installed. Public skillsets cannot be published to -- they are consume-only.

SuperAgent ships with a default public skillset that provides a starter collection of agent templates and skills.

### How skills extend agents

When a skill is installed into an agent, its files are copied into the agent's workspace under `.claude/skills/<skill-name>/`. The agent reads the `SKILL.md` content as part of its context, gaining the instructions and knowledge contained in the skill.

Skills can declare **required environment variables** in their frontmatter metadata. These are secrets or configuration values that the skill needs at runtime -- for example, an API key for an external service. When you install a skill that requires environment variables, SuperAgent prompts you to provide them, and they are stored securely as agent secrets.

### Next steps

- [Managing Skills](https://www.gamut.so/docs/using-superagent/skillsets/managing-skills) -- Learn how to discover, install, update, and remove skills for your agents.
- [Hosting a GitHub Skillset](https://www.gamut.so/docs/using-superagent/skillsets/hosting-a-github-skillset) -- Create and publish your own skillset as a GitHub repository.

## Managing Skills

SuperAgent provides tools for discovering skills from your configured skillsets, installing them into agents, tracking their status, and keeping them up to date.

### Configuring skillsets

Before you can install skills, you need at least one skillset configured. SuperAgent ships with a default public skillset, but you can add your own.

To add a skillset:

1. Open **Settings** and navigate to the **Skillsets** tab.
2. Enter the Git repository URL of the skillset (HTTPS or SSH format).
3. Click **Add**. SuperAgent validates the repository by cloning it and checking for a valid `index.json`.

Once added, the skillset appears in your list with its name, description, and skill count. You can add multiple skillsets -- skills from all configured skillsets are available for installation across your agents.

For private GitHub repositories, you need SSH authentication configured. SuperAgent clones repositories with `GIT_TERMINAL_PROMPT` disabled, so interactive password prompts are not supported.

#### Platform skillsets

If you are connected to a SuperAgent platform organization, your organization's skillsets are synced automatically. These appear in your skillsets list with a "Platform" badge and do not require manual URL entry.

#### Refreshing a skillset

Click the refresh button next to any skillset to pull the latest changes from the remote repository. This updates the local cache so that new skills and version changes become visible.

#### Removing a skillset

Click the delete button next to a skillset to remove it from your configuration. This removes the skillset from your settings and cleans up the local cache. Skills that were already installed into agents are not affected -- they remain in the agent's workspace.

### Discovering and browsing skills

Each agent has a **Skills** section on its home page. If there are skills available from your configured skillsets that the agent does not yet have installed, an **Add Skill** button appears.

Clicking **Add Skill** opens a browse dialog where you can:

- **Search** skills by name or description.
- **Filter** by skillset when you have multiple skillsets configured.
- **Page** through results if the skill catalog is large.

Each skill card shows the skill name, which skillset it belongs to, and its version number.

### Installing a skill

To install a skill into an agent, click the install button on its card in the browse dialog. SuperAgent copies the skill's files from the skillset cache into the agent's workspace at `.claude/skills/<skill-name>/`.

#### Required environment variables

Some skills declare required environment variables in their `SKILL.md` frontmatter. These are typically API keys or configuration values the skill needs at runtime.

When you install a skill that has required environment variables, SuperAgent opens a dialog prompting you to enter each value. The variables are stored securely as agent secrets and made available to the agent during execution.

Example of a skill that requires environment variables:

```yaml
---
name: Database Query
description: Queries a PostgreSQL database and returns formatted results.
metadata:
  version: 1.0.0
  required_env_vars:
    - name: DATABASE_URL
      description: PostgreSQL connection string
    - name: DB_READ_ONLY_TOKEN
      description: Read-only access token for the database
---
```

You must provide all required environment variables before the install completes.

### Skill status tracking

Every installed skill displays a status badge that tells you whether it is current, has updates available, or has been modified locally. SuperAgent computes status by comparing the installed skill's content hash against the original and the latest version in the skillset cache.

#### Up to date

The skill matches the version in the skillset repository. No action is needed.

#### Update available

The skillset repository contains a newer version of this skill -- either a version bump in `index.json` or changed file content. An **Update** button appears on the skill card. Clicking it pulls the latest version from the skillset and overwrites the local copy.

#### Locally modified

You (or the agent) have edited the skill's files since it was installed, and the content no longer matches the original. This status appears when the SHA-256 hash of the installed skill package differs from the hash recorded at install time.

When a skill is locally modified, you have several options:

- **Submit changes** -- Open a pull request (for GitHub skillsets) or submit through the platform queue (for platform skillsets) to propose your changes back to the upstream repository. SuperAgent generates AI-suggested PR titles, descriptions, and version bumps based on the diff.
- **Force sync** -- Discard your local changes and replace the skill with the latest version from the skillset. This is a destructive action that cannot be undone.

#### Local

The skill was created locally and is not linked to any skillset. Local skills have no upstream tracking. If you have a skillset configured that supports publishing, you can publish a local skill to make it available to others.

### Updating skills

SuperAgent automatically checks for skill updates when you navigate to an agent. A background refresh pulls the latest changes from all configured skillsets and compares them against your installed skills.

To manually update a single skill, click the **Update** button on any skill showing the "update available" status. SuperAgent re-fetches the skillset, copies the latest files into the agent's workspace, and updates the metadata to record the new version and content hash.

### Publishing and submitting changes

When you modify an installed skill, you can contribute your changes back to the skillset. The workflow depends on the skillset's provider:

#### GitHub skillsets (pull request)

1. Click **Open PR** on a locally modified skill.
2. SuperAgent generates a suggested title, description, and version bump using AI.
3. Review and edit the suggestions, then confirm.
4. SuperAgent forks the repository (if needed), creates a branch, commits your changes, and opens a pull request against the upstream repository.

This requires the GitHub CLI (`gh`) to be installed and authenticated.

#### Platform skillsets (hosted submit)

1. Click **Submit** on a locally modified skill.
2. Review the suggested title and description.
3. SuperAgent submits the changes to the platform's review queue.
4. The submission status is tracked in the skill's metadata. Once the platform processes it (merged or rejected), the skill status updates accordingly on the next refresh.

#### Publishing a local skill

If you have a local skill (not linked to any skillset), you can publish it to a configured skillset:

1. Click the publish button on the local skill's card.
2. Select the target skillset.
3. Review the AI-generated PR title, description, and version.
4. Confirm to submit the skill to the skillset repository.

The skill is added to the skillset's `index.json` and placed under `skills/<skill-name>/` in the repository.

### Removing a skill

To remove an installed skill, delete its directory from the agent's workspace. The skill's directory is located at `.claude/skills/<skill-name>/` inside the agent's workspace folder. Removing the directory removes the skill from the agent.

Removing a skill from an agent does not affect other agents that may have the same skill installed, nor does it remove the skill from the skillset repository.

## Hosting a GitHub Skillset

You can host your own skillset as a GitHub repository. Once published, anyone with access to the repository can add it to their SuperAgent instance and install skills from it.

### Repository structure

A skillset repository has a flat structure with an `index.json` manifest at the root and skill directories organized under a `skills/` folder.

```
my-skillset/
  index.json
  skills/
    email-triage/
      SKILL.md
    nda-review/
      SKILL.md
      templates/
        review-checklist.md
    database-query/
      SKILL.md
      schema-reference.json
```

Each skill lives in its own directory under `skills/`. The directory name becomes the skill's identifier -- it is used as the folder name when the skill is installed into an agent's workspace.

#### Naming conventions

- Use **kebab-case** for skill directory names (e.g., `email-triage`, `nda-review`). SuperAgent converts these to Title Case for display (e.g., "Email Triage").
- Keep directory names short and descriptive. They must not contain path separators, `..`, or other special characters.

### The index.json manifest

The `index.json` file at the repository root is the entry point that SuperAgent reads when it clones or refreshes a skillset. It declares the skillset metadata and lists every skill available in the repository.

```json
{
  "skillset_name": "Acme Team Skills",
  "description": "Shared skills for the Acme engineering and ops team.",
  "version": "1.0.0",
  "skills": [
    {
      "name": "Email Triage",
      "path": "skills/email-triage/SKILL.md",
      "description": "Triages incoming emails by urgency and category.",
      "version": "1.0.0"
    },
    {
      "name": "NDA Review",
      "path": "skills/nda-review/SKILL.md",
      "description": "Reviews NDAs for standard clause coverage.",
      "version": "2.1.0"
    },
    {
      "name": "Database Query",
      "path": "skills/database-query/SKILL.md",
      "description": "Queries a PostgreSQL database and formats results.",
      "version": "1.3.0"
    }
  ]
}
```

#### Required fields

| Field | Type | Description |
|---|---|---|
| `skillset_name` | string | Display name for the skillset. |
| `description` | string | Brief description of what the skillset contains. |
| `version` | string | Overall skillset version (informational). |
| `skills` | array | List of skill entries. |

#### Skill entry fields

Each entry in the `skills` array describes one skill:

| Field | Type | Description |
|---|---|---|
| `name` | string | Display name of the skill. |
| `path` | string | Path to the `SKILL.md` file relative to the repository root. |
| `description` | string | Brief description of what the skill does. |
| `version` | string | SemVer version of this individual skill. |

#### Agent templates (optional)

Skillsets can also include agent templates alongside skills. Agent templates are listed in an optional `agents` array in `index.json`:

```json
{
  "skillset_name": "Acme Team Skills",
  "description": "...",
  "version": "1.0.0",
  "skills": [...],
  "agents": [
    {
      "name": "Research Assistant",
      "path": "agents/research-assistant/",
      "description": "Pre-configured agent for research workflows.",
      "version": "1.0.0"
    }
  ]
}
```

### Writing a SKILL.md file

Each skill directory must contain a `SKILL.md` file. This file uses YAML frontmatter for metadata and Markdown for the skill's instructions.

#### Frontmatter format

```yaml
---
name: Email Triage
description: Triages incoming emails by urgency and category.
metadata:
  version: 1.0.0
  required_env_vars:
    - name: GMAIL_FILTER_LABEL
      description: Gmail label to filter incoming messages
---
```

**Top-level fields:**

| Field | Required | Description |
|---|---|---|
| `name` | Recommended | Display name. Falls back to the directory name if omitted. |
| `description` | Recommended | Short description shown in the skill browser. |

**Metadata fields (nested under `metadata`):**

| Field | Required | Description |
|---|---|---|
| `version` | Recommended | SemVer version string. Should match the version in `index.json`. |
| `required_env_vars` | Optional | Array of environment variables the skill needs at runtime. |

Each entry in `required_env_vars` has:

| Field | Description |
|---|---|
| `name` | The environment variable name (e.g., `DATABASE_URL`). |
| `description` | A human-readable explanation shown to the user during installation. |

#### Skill body

After the frontmatter, write the skill's instructions in Markdown. This is what the agent reads and follows when the skill is invoked. Be specific, step-by-step, and clear about what the agent should do.

```markdown
---
name: Email Triage
description: Triages incoming emails by urgency and category.
metadata:
  version: 1.0.0
---

# Email Triage

When asked to triage emails, follow this process:

1. Fetch unread emails from the inbox.
2. For each email, classify it into one of these categories:
   - **Urgent** -- requires response within 1 hour
   - **Action Required** -- requires response within 24 hours
   - **Informational** -- no response needed
   - **Spam** -- can be archived
3. Present a summary table sorted by urgency.
4. For urgent items, draft a brief response for review.
```

#### Supporting files

Skills can include additional files alongside `SKILL.md`. These are copied to the agent's workspace when the skill is installed. Common uses include:

- **Templates** -- Output format templates, checklists, or boilerplate text.
- **Reference data** -- JSON or CSV files with lookup tables, schemas, or configuration.
- **Examples** -- Sample inputs and outputs to guide the agent.

All files in the skill directory (except internal metadata files like `.skillset-metadata.json`) are part of the skill package.

### Versioning

Each skill in a skillset has its own version, declared both in the `index.json` manifest and in the `SKILL.md` frontmatter. SuperAgent uses these versions to detect when updates are available.

#### Version conventions

Follow [Semantic Versioning](https://semver.org/):

- **PATCH** (e.g., 1.0.0 to 1.0.1) -- Bug fixes, typo corrections, minor wording tweaks.
- **MINOR** (e.g., 1.0.0 to 1.1.0) -- New features, added capabilities, significant improvements.
- **MAJOR** (e.g., 1.0.0 to 2.0.0) -- Breaking changes, fundamental restructuring.

#### How updates are detected

SuperAgent determines that an update is available when either:

1. The `version` field in `index.json` for a skill differs from the version recorded when it was installed.
2. The content hash of the skill's files in the repository differs from the hash recorded at install time.

This means that even if you forget to bump the version number, SuperAgent will still detect content changes. However, bumping the version is recommended so that users can see what changed.

#### Keeping versions in sync

The `version` in `index.json` and the `version` in `SKILL.md` frontmatter should match. When SuperAgent generates PR suggestions for skill modifications, it proposes a new version based on the nature of the changes.

### Sharing your skillset

#### Public repositories

If your repository is public on GitHub, anyone can add it to their SuperAgent instance:

1. Share the repository URL (e.g., `https://github.com/your-org/your-skillset`).
2. The recipient opens **Settings > Skillsets**, pastes the URL, and clicks **Add**.

Public repositories work with both the GitHub provider (requires Git) and the public provider (download-only, no Git required).

#### Private repositories

For private repositories, users need read access to the repository. They also need SSH authentication configured for Git, since SuperAgent clones with `GIT_TERMINAL_PROMPT=0` (no interactive prompts).

To set up SSH access:

1. [Generate an SSH key](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/generating-a-new-ssh-key-and-adding-it-to-the-ssh-agent) if you do not have one.
2. Add the public key to your GitHub account.
3. Use the SSH URL when adding the skillset (e.g., `git@github.com:your-org/your-skillset.git`).

#### Accepting contributions

When users modify installed skills and submit pull requests, the PRs are created against your repository. The standard GitHub pull request workflow applies -- you can review changes, request modifications, and merge when ready.

SuperAgent's PR flow works as follows:

1. The contributor forks your repository (via the GitHub CLI).
2. A branch is created with the modified skill files.
3. A pull request is opened from the contributor's fork to your repository's default branch.

The PR title, description, and version bump are AI-generated based on the diff, but the contributor can edit them before submitting.

### Quick start checklist

1. Create a new GitHub repository.
2. Add an `index.json` at the root with your skillset name and an empty `skills` array.
3. Create a `skills/` directory.
4. For each skill, create a subdirectory with a `SKILL.md` file containing frontmatter and instructions.
5. Add each skill to the `skills` array in `index.json` with its name, path, description, and version.
6. Push to GitHub.
7. Share the repository URL with your team.
