# Agent and Skill Packages

Read this guide before packaging an agent or a skill into a file someone else
can import.

An agent template is a `.agent` file: a zip whose root is the new agent's
`/workspace`. Importing it creates a new agent from its contents.

## Layout

- `AGENTS.md` (required). The agent's instructions. Its frontmatter `name` and
  `description` become the new agent's name and purpose.
- `.claude/skills/agent-onboarding/SKILL.md` (optional). After import, Gamut
  starts a session that runs this skill, so it can walk the new owner through
  setup. An optional one-line `first_prompt` frontmatter field replaces the
  default opening message. Write it to interview the owner, save each answer
  to `AGENTS.md`, config, or `.env`, then check that setup works. Show the user
  the planned questions before finalizing it.
- `PROMPT.md` (optional, up to 16KB). After import, its text is placed in the
  new agent's message box for the owner to send. A non-empty `PROMPT.md` stops
  the onboarding session from starting on its own.

## Building One

1. Stage a copy in `/tmp/<slug>-template/`, never the live workspace. To
   package this agent itself, run `cp -a /workspace/. /tmp/<slug>-template/`.
2. Write it for a new owner. Remove account ids, email addresses, names, and
   anything else specific to this user. User data also hides in ordinary
   files: empty every database's rows but keep its schema, and clear data
   files, notes, and generated reports. Connected accounts, secrets, and chat
   integrations do not travel with the file. List the secret names, without
   values, in `.env.example`, and set them up in the onboarding skill.
3. Zip from inside the staged folder. The command leaves out `.env` files and
   Gamut's internal state. `-y` stores symlinks as links, which import turns
   into files holding a path, so copy in anything needed as a real file:

   ```bash
   cd /tmp/<slug>-template
   out="/workspace/<Name>.agent"
   skip=('.env' '*/.env' '.DS_Store' '*/.DS_Store' 'node_modules/*' '*/node_modules/*'
     '__pycache__/*' '*/__pycache__/*' '*.pyc' 'bookmarks.json' '*/bookmarks.json'
     'agent-preferences.json' '*/agent-preferences.json' '*session-metadata.json'
     '*.superagent-sessions.json' '*.skillset-agent-metadata.json' '.git/*' '*/.git/*'
     '*/.skillset-metadata.json' '*/.skillset-original.md' '*.agent' '*.skill')
   rm -f "$out"
   zip -qry "$out" . -x '.claude/*' 'uploads/*' 'downloads/*' '.browser-profile/*' "${skip[@]}"
   if [ -d .claude/skills ]; then zip -qry "$out" .claude/skills -x "${skip[@]}"; fi
   ```

4. List the contents with `unzip -Z1 "$out"`. Read every script and every
   dashboard under `artifacts/` for hardcoded keys and account ids, since they
   ship. If anything should not go to a stranger, rebuild instead of
   delivering.

## Sharing One Skill

A `.skill` file is a zip of one skill folder, with the folder as its top-level
entry. Importing it adds the skill to the other agent's `.claude/skills/`.
Skill import keeps every file except Gamut's skillset metadata, so the command
leaves out `.env` files the same way:

```bash
cd /workspace/.claude/skills
out="/workspace/<Name>.skill"
rm -f "$out"
zip -qry "$out" <skill-folder> -x '*/.env' '*/.DS_Store' '*/__pycache__/*' '*.pyc' \
  '*/node_modules/*' '*/.git/*' '*/.skillset-metadata.json' '*/.skillset-original.md'
```

Then check it as in step 4. A skill that needs a secret reads it from the
environment, so name the variable in `SKILL.md`. Quote the `description` in
single quotes: skill import parses the frontmatter as YAML, and an unquoted
`: ` drops the skill's name without an error.
