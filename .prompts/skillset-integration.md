I want to add an integration with Skillsets. Skillsets are github repositories that contain a collection of skills. By integrating with skillsets, users can easily discover and download new skills for their agents from public repositories.

- In the app settings: users can add a skillset by providing the URL to the skillset repository. The app will fetch the `index.json` file from the repository to get the list of available skills and display them in a UI.
    - When adding - we should follow the "validate then save" approach we use for LLM providers. So when a user adds a skillset, we should first validate the URL and ensure we can fetch the `index.json` file before saving it to their settings.
    - We should also make sure to use any ssh keys on the client machine to authenticate with private repositories if needed.

- In agent homepage, we currently show "Available Skills" which is a list of skills the user has already downloaded. We should rename it "Agent Skills". On top of that, we should add a new section called "Discover Skills" which shows skills available from the user's added skillsets that they haven't downloaded yet. This will allow users to easily find and add new skills to their agents. Clicking + next to a skill in the "Discover Skills" section will download the skill and add it to the agent's skills.

- For skills that are downlaoded from a skillset, we should also display the source of the skill (e.g. which skillset it came from) in the agent's skill list. This will help users keep track of where their skills are coming from and manage them more effectively. We should also show the skill status:
    - If the skill is up to date with the version in the skillset, show "Up to date"
    - If there's a newer version of the skill available in the skillset, show "Update available" with an option to update the skill.
    - If the skill has been updated locally by the agent, we should show "Locally modified" to indicate that the skill has changes that haven't been pushed back to the skillset repository.
        - We should then have a button to open a PR to submit the local changes back to the skillset repository. This will encourage users to contribute back improvements to the original skillset and foster a collaborative community around skill development.
* As a general note - we should make the skillset management robust - there'll be a lot of focus on getting more skills, getting skill updates etc... - So we should make sure the backend integrations are robust and have a flexible model.
* When installing skills, they might specify required environment variables in their metadata. We should make sure to surface these to the user when they try to install the skill and prompt them to enter the required environment variable values. This will ensure that users have all the necessary configuration in place for the skill to work properly. (use existing secret management system to store these env vars securely)

- At agent creation, we should enchance the modal to show available skills from the user's added skillsets and allow them to select any skills they want to include in the new agent right from the start. This will make it easier for users to get started with their agents and encourage them to explore the skillsets they've added.


# Skillset

A skillset is a collection of skills that an agent may query and download. Skillsets are meant to group related skills together and make them discoverable for agents.

This repo is a skillset template. To create your own skillset, fork it and add skills! 

While skillsets can be stored on any public Git repository, we recommend using GitHub as this template includes built-in support for GitHub Actions to automate the packaging process.

## Skillset Structure

A skillset repository should have the following structure:

```
.
├── skills/
│   ├── skill-1/
│   │   ├── SKILL.md
│   │   └── ... (other skill files)
│   ├── skill-2/
│   │   ├── SKILL.md
│   │   └── ... (other skill files)
│   └── ... (more skills)
├── index.json
├── README.md
└── ... (other files)
```

- `skills/`: This directory contains subdirectories for each skill in the skillset. Each skill should have its own directory with a `SKILL.md` file and any other necessary files.
- `index.json`: This file contains metadata about the skillset and a list of all skills included in the skillset.
- `README.md`: This file provides an overview of the skillset.

  ### The `index.json` File:
  This file provides and index of available skills in the skillset. Here is an example structure for `index.json`:

  ```json
  {
    "skillset_name": "Example Skillset",
    "description": "A collection of example skills.",
    "version": "1.0.0",
    "skills": [
      {
        "name": "Skill 1",
        "path": "skills/skill-1/SKILL.md",
        "description": "Description of Skill 1.",
        "version": "1.0.0"
      },
      {
        "name": "Skill 2",
        "path": "skills/skill-2/SKILL.md",
        "description": "Description of Skill 2.",
        "version": "1.0.0"
      }
    ]
  }
  ```
Skills themselves are in Claude Code format:
- they have a `SKILL.md` file that contains the skill definition in markdown format. This includes the skill name, description, parameters, and the code that implements the skill. Here's an example of what a `SKILL.md` file might look like:

```markdown
---
name: supabase-query
description: Query or modify data in the Datawizz Supabase (PostgreSQL) database. Use when you need to access operational data like workspaces, projects, endpoints, models, providers, prompts, datasets metadata, evaluators, evaluations, or plugins. Provides connection setup, Python code, and schema references.
metadata:
  version: 1.0
  required_env_vars:
    - name: SUPABASE_URL
      description: Supabase project URL (e.g. http://127.0.0.1:54321 for local)
    - name: SUPABASE_SERVICE_KEY
      description: Supabase service role key (bypasses RLS, for agent use)
---

# Supabase Query Skill

Query and modify data in the Datawizz Supabase (PostgreSQL) database, which stores all operational/configuration data.

## Connection
...
```

Here's an example repo you can check out: `https://github.com/DatawizzAI/skills`