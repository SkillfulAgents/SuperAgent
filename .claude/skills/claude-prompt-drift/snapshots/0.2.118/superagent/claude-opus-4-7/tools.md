# Tools

> Captured: 2026-05-13T00:20:01.114Z
> Model: `claude-opus-4-7`
> Source: agent-container intercept proxy

---

`body.tools` has **58** definitions.

## Index

- [1. Agent](#1-agent)
- [2. AskUserQuestion](#2-askuserquestion)
- [3. Bash](#3-bash)
- [4. CronCreate](#4-croncreate)
- [5. CronDelete](#5-crondelete)
- [6. CronList](#6-cronlist)
- [7. Edit](#7-edit)
- [8. EnterPlanMode](#8-enterplanmode)
- [9. EnterWorktree](#9-enterworktree)
- [10. ExitPlanMode](#10-exitplanmode)
- [11. ExitWorktree](#11-exitworktree)
- [12. Glob](#12-glob)
- [13. Grep](#13-grep)
- [14. Monitor](#14-monitor)
- [15. NotebookEdit](#15-notebookedit)
- [16. PushNotification](#16-pushnotification)
- [17. Read](#17-read)
- [18. RemoteTrigger](#18-remotetrigger)
- [19. ScheduleWakeup](#19-schedulewakeup)
- [20. Skill](#20-skill)
- [21. TaskOutput](#21-taskoutput)
- [22. TaskStop](#22-taskstop)
- [23. TodoWrite](#23-todowrite)
- [24. WebFetch](#24-webfetch)
- [25. WebSearch](#25-websearch)
- [26. Write](#26-write)
- [27. mcp__agents__create_agent](#27-mcp-agents-create-agent)
- [28. mcp__agents__get_agent_session_transcript](#28-mcp-agents-get-agent-session-transcript)
- [29. mcp__agents__get_agent_sessions](#29-mcp-agents-get-agent-sessions)
- [30. mcp__agents__invoke_agent](#30-mcp-agents-invoke-agent)
- [31. mcp__agents__list_agents](#31-mcp-agents-list-agents)
- [32. mcp__browser__browser_click](#32-mcp-browser-browser-click)
- [33. mcp__browser__browser_close](#33-mcp-browser-browser-close)
- [34. mcp__browser__browser_fill](#34-mcp-browser-browser-fill)
- [35. mcp__browser__browser_get_state](#35-mcp-browser-browser-get-state)
- [36. mcp__browser__browser_hover](#36-mcp-browser-browser-hover)
- [37. mcp__browser__browser_open](#37-mcp-browser-browser-open)
- [38. mcp__browser__browser_press](#38-mcp-browser-browser-press)
- [39. mcp__browser__browser_run](#39-mcp-browser-browser-run)
- [40. mcp__browser__browser_screenshot](#40-mcp-browser-browser-screenshot)
- [41. mcp__browser__browser_scroll](#41-mcp-browser-browser-scroll)
- [42. mcp__browser__browser_select](#42-mcp-browser-browser-select)
- [43. mcp__browser__browser_snapshot](#43-mcp-browser-browser-snapshot)
- [44. mcp__browser__browser_wait](#44-mcp-browser-browser-wait)
- [45. mcp__dashboards__create_dashboard](#45-mcp-dashboards-create-dashboard)
- [46. mcp__dashboards__get_dashboard_logs](#46-mcp-dashboards-get-dashboard-logs)
- [47. mcp__dashboards__list_dashboards](#47-mcp-dashboards-list-dashboards)
- [48. mcp__dashboards__start_dashboard](#48-mcp-dashboards-start-dashboard)
- [49. mcp__user-input__deliver_file](#49-mcp-user-input-deliver-file)
- [50. mcp__user-input__deliver_session](#50-mcp-user-input-deliver-session)
- [51. mcp__user-input__request_browser_input](#51-mcp-user-input-request-browser-input)
- [52. mcp__user-input__request_connected_account](#52-mcp-user-input-request-connected-account)
- [53. mcp__user-input__request_file](#53-mcp-user-input-request-file)
- [54. mcp__user-input__request_remote_mcp](#54-mcp-user-input-request-remote-mcp)
- [55. mcp__user-input__request_secret](#55-mcp-user-input-request-secret)
- [56. mcp__user-input__schedule_task](#56-mcp-user-input-schedule-task)
- [57. mcp__user-input__search_connected_account_services](#57-mcp-user-input-search-connected-account-services)
- [58. mcp__user-input__search_remote_mcp_services](#58-mcp-user-input-search-remote-mcp-services)

---

## 1. Agent

Launch a new agent to handle complex, multi-step tasks. Each agent type has specific capabilities and tools available to it.

Available agent types and the tools they have access to:
- Explore: Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions. (Tools: All tools except Agent, ExitPlanMode, Edit, Write, NotebookEdit)
- general-purpose: General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you. (Tools: *)
- Plan: Software architect agent for designing implementation plans. Use this when you need to plan the implementation strategy for a task. Returns step-by-step plans, identifies critical files, and considers architectural trade-offs. (Tools: All tools except Agent, ExitPlanMode, Edit, Write, NotebookEdit)
- statusline-setup: Use this agent to configure the user's Claude Code status line setting. (Tools: Read, Edit)
- web-browser: Web browsing specialist. Delegate any task that requires interacting with websites — navigating pages, filling forms, clicking buttons, extracting information, searching for products, changing settings on web services, or any multi-step web interaction. The browser should already be open (use browser_open first). This agent runs on a cheaper model and handles all browser interactions autonomously. (Tools: mcp__browser__browser_open, mcp__browser__browser_close, mcp__browser__browser_snapshot, mcp__browser__browser_click, mcp__browser__browser_fill, mcp__browser__browser_scroll, mcp__browser__browser_wait, mcp__browser__browser_press, mcp__browser__browser_screenshot, mcp__browser__browser_select, mcp__browser__browser_hover, mcp__browser__browser_run, mcp__browser__browser_get_state, WebSearch, Read, mcp__user-input__request_browser_input)
- dashboard-builder: Dashboard building specialist. Delegate any task that involves creating, editing, or debugging dashboards (artifacts) — designing layouts, writing HTML/CSS/JS or React code, adding charts, connecting to data sources, fixing visual issues, or iterating on dashboard design. This agent uses Opus and handles the full build cycle: scaffolding, coding, starting, and verifying via screenshots. (Tools: mcp__dashboards__create_dashboard, mcp__dashboards__start_dashboard, mcp__dashboards__list_dashboards, mcp__dashboards__get_dashboard_logs, Read, Write, Edit, Bash)

When using the Agent tool, specify a subagent_type parameter to select which agent type to use. If omitted, the general-purpose agent is used.

## When not to use

If the target is already known, use the direct tool: Read for a known path, the Grep tool for a specific symbol or string. Reserve this tool for open-ended questions that span the codebase, or tasks that match an available agent type.

## Usage notes

- Always include a short description summarizing what the agent will do
- When you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently
- When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.
- Trust but verify: an agent's summary describes what it intended to do, not necessarily what it did. When an agent writes or edits code, check the actual changes before reporting the work as done.
- You can optionally run agents in the background using the run_in_background parameter. When an agent runs in the background, you will be automatically notified when it completes — do NOT sleep, poll, or proactively check on its progress. Continue with other work or respond to the user instead.
- **Foreground vs background**: Use foreground (default) when you need the agent's results before you can proceed — e.g., research agents whose findings inform your next steps. Use background when you have genuinely independent work to do in parallel.
- To continue a previously spawned agent, use SendMessage with the agent's ID or name as the `to` field — that resumes it with full context. A new Agent call starts a fresh agent with no memory of prior runs, so the prompt must be self-contained.
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent
- If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first.
- If the user specifies that they want you to run agents "in parallel", you MUST send a single message with multiple Agent tool use content blocks. For example, if you need to launch both a build-validator agent and a test-runner agent in parallel, send a single message with both tool calls.
- With `isolation: "worktree"`, the worktree is automatically cleaned up if the agent makes no changes; otherwise the path and branch are returned in the result.

## Writing the prompt

Brief the agent like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

Terse command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.

Example usage:

<example>
user: "What's left on this branch before we can ship?"
assistant: <thinking>A survey question across git state, tests, and config. I'll delegate it and ask for a short report so the raw command output stays out of my context.</thinking>
Agent({
  description: "Branch ship-readiness audit",
  prompt: "Audit what's left before this branch can ship. Check: uncommitted changes, commits ahead of main, whether tests exist, whether the GrowthBook gate is wired up, whether CI-relevant files changed. Report a punch list — done vs. missing. Under 200 words."
})
<commentary>
The prompt is self-contained: it states the goal, lists what to check, and caps the response length. The agent's report comes back as the tool result; relay the findings to the user.
</commentary>
</example>

<example>
user: "Can you get a second opinion on whether this migration is safe?"
assistant: <thinking>I'll ask the code-reviewer agent — it won't see my analysis, so it can give an independent read.</thinking>
Agent({
  description: "Independent migration review",
  subagent_type: "code-reviewer",
  prompt: "Review migration 0042_user_schema.sql for safety. Context: we're adding a NOT NULL column to a 50M-row table. Existing rows get a backfill default. I want a second opinion on whether the backfill approach is safe under concurrent writes — I've checked locking behavior but want independent verification. Report: is this safe, and if not, what specifically breaks?"
})
<commentary>
The agent starts with no context from this conversation, so the prompt briefs it: what to assess, the relevant background, and what form the answer should take.
</commentary>
</example>

**input_schema**:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "description": {
      "description": "A short (3-5 word) description of the task",
      "type": "string"
    },
    "prompt": {
      "description": "The task for the agent to perform",
      "type": "string"
    },
    "subagent_type": {
      "description": "The type of specialized agent to use for this task",
      "type": "string"
    },
    "model": {
      "description": "Optional model override for this agent. Takes precedence over the agent definition's model frontmatter. If omitted, uses the agent definition's model, or inherits from the parent.",
      "type": "string",
      "enum": [
        "sonnet",
        "opus",
        "haiku"
      ]
    },
    "run_in_background": {
      "description": "Set to true to run this agent in the background. You will be notified when it completes.",
      "type": "boolean"
    },
    "isolation": {
      "description": "Isolation mode. \"worktree\" creates a temporary git worktree so the agent works on an isolated copy of the repo.",
      "type": "string",
      "enum": [
        "worktree"
      ]
    }
  },
  "required": [
    "description",
    "prompt"
  ],
  "additionalProperties": false
}
```

---

## 2. AskUserQuestion

Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.

Usage notes:
- Users will always be able to select "Other" to provide custom text input
- Use multiSelect: true to allow multiple answers to be selected for a question
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label

Plan mode note: In plan mode, use this tool to clarify requirements or choose between approaches BEFORE finalizing your plan. Do NOT use this tool to ask "Is my plan ready?" or "Should I proceed?" - use ExitPlanMode for plan approval. IMPORTANT: Do not reference "the plan" in your questions (e.g., "Do you have feedback about the plan?", "Does the plan look good?") because the user cannot see the plan in the UI until you call ExitPlanMode. If you need plan approval, use ExitPlanMode instead.

**input_schema**:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "questions": {
      "description": "Questions to ask the user (1-4 questions)",
      "minItems": 1,
      "maxItems": 4,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "question": {
            "description": "The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: \"Which library should we use for date formatting?\" If multiSelect is true, phrase it accordingly, e.g. \"Which features do you want to enable?\"",
            "type": "string"
          },
          "header": {
            "description": "Very short label displayed as a chip/tag (max 12 chars). Examples: \"Auth method\", \"Library\", \"Approach\".",
            "type": "string"
          },
          "options": {
            "description": "The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). There should be no 'Other' option, that will be provided automatically.",
            "minItems": 2,
            "maxItems": 4,
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "label": {
                  "description": "The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.",
                  "type": "string"
                },
                "description": {
                  "description": "Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.",
                  "type": "string"
                },
                "preview": {
                  "description": "Optional preview content rendered when this option is focused. Use for mockups, code snippets, or visual comparisons that help users compare options. See the tool description for the expected content format.",
                  "type": "string"
                }
              },
              "required": [
                "label",
                "description"
              ],
              "additionalProperties": false
            }
          },
          "multiSelect": {
            "description": "Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.",
            "default": false,
            "type": "boolean"
          }
        },
        "required": [
          "question",
          "header",
          "options",
          "multiSelect"
        ],
        "additionalProperties": false
      }
    },
    "answers": {
      "description": "User answers collected by the permission component",
      "type": "object",
      "propertyNames": {
        "type": "string"
      },
      "additionalProperties": {
        "type": "string"
      }
    },
    "annotations": {
      "description": "Optional per-question annotations from the user (e.g., notes on preview selections). Keyed by question text.",
      "type": "object",
      "propertyNames": {
        "type": "string"
      },
      "additionalProperties": {
        "type": "object",
        "properties": {
          "preview": {
            "description": "The preview content of the selected option, if the question used previews.",
            "type": "string"
          },
          "notes": {
            "description": "Free-text notes the user added to their selection.",
            "type": "string"
          }
        },
        "additionalProperties": false
      }
    },
    "metadata": {
      "description": "Optional metadata for tracking and analytics purposes. Not displayed to user.",
      "type": "object",
      "properties": {
        "source": {
          "description": "Optional identifier for the source of this question (e.g., \"remember\" for /remember command). Used for analytics tracking.",
          "type": "string"
        }
      },
      "additionalProperties": false
    }
  },
  "required": [
    "questions"
  ],
  "additionalProperties": false
}
```

---

## 3. Bash

Executes a given bash command and returns its output.

The working directory persists between commands, but shell state does not. The shell environment is initialized from the user's profile (bash or zsh).

IMPORTANT: Avoid using this tool to run `find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo` commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user:

 - File search: Use Glob (NOT find or ls)
 - Content search: Use Grep (NOT grep or rg)
 - Read files: Use Read (NOT cat/head/tail)
 - Edit files: Use Edit (NOT sed/awk)
 - Write files: Use Write (NOT echo >/cat <<EOF)
 - Communication: Output text directly (NOT echo/printf)
While the Bash tool can do similar things, it’s better to use the built-in tools as they provide a better user experience and make it easier to review tool calls and give permission.

# Instructions
 - If your command will create new directories or files, first use this tool to run `ls` to verify the parent directory exists and is the correct location.
 - Always quote file paths that contain spaces with double quotes in your command (e.g., cd "path with spaces/file.txt")
 - Try to maintain your current working directory throughout the session by using absolute paths and avoiding usage of `cd`. You may use `cd` if the User explicitly requests it. In particular, never prepend `cd <current-directory>` to a `git` command — `git` already operates on the current working tree, and the compound triggers a permission prompt.
 - You may specify an optional timeout in milliseconds (up to 600000ms / 10 minutes). By default, your command will timeout after 120000ms (2 minutes).
 - You can use the `run_in_background` parameter to run the command in the background. Only use this if you don't need the result immediately and are OK being notified when the command completes later. You do not need to check the output right away - you'll be notified when it finishes. You do not need to use '&' at the end of the command when using this parameter.
 - When issuing multiple commands:
  - If the commands are independent and can run in parallel, make multiple Bash tool calls in a single message. Example: if you need to run "git status" and "git diff", send a single message with two Bash tool calls in parallel.
  - If the commands depend on each other and must run sequentially, use a single Bash call with '&&' to chain them together.
  - Use ';' only when you need to run commands sequentially but don't care if earlier commands fail.
  - DO NOT use newlines to separate commands (newlines are ok in quoted strings).
 - For git commands:
  - Prefer to create a new commit rather than amending an existing commit.
  - Before running destructive operations (e.g., git reset --hard, git push --force, git checkout --), consider whether there is a safer alternative that achieves the same goal. Only use destructive operations when they are truly the best approach.
  - Never skip hooks (--no-verify) or bypass signing (--no-gpg-sign, -c commit.gpgsign=false) unless the user has explicitly asked for it. If a hook fails, investigate and fix the underlying issue.
 - Avoid unnecessary `sleep` commands:
  - Do not sleep between commands that can run immediately — just run them.
  - Use the Monitor tool to stream events from a background process (each stdout line is a notification). For one-shot "wait until done," use Bash with run_in_background instead.
  - If your command is long running and you would like to be notified when it finishes — use `run_in_background`. No sleep needed.
  - Do not retry failing commands in a sleep loop — diagnose the root cause.
  - If waiting for a background task you started with `run_in_background`, you will be notified when it completes — do not poll.
  - Long leading `sleep` commands are blocked. To poll until a condition is met, use Monitor with an until-loop (e.g. `until <check>; do sleep 2; done`) — you get a notification when the loop exits. Do not chain shorter sleeps to work around the block.


# Committing changes with git

Only create commits when requested by the user. If unclear, ask first. When the user asks you to create a new git commit, follow these steps carefully:

You can call multiple tools in a single response. When multiple independent pieces of information are requested and all commands are likely to succeed, run multiple tool calls in parallel for optimal performance. The numbered steps below indicate which commands should be batched in parallel.

Git Safety Protocol:
- NEVER update the git config
- NEVER run destructive git commands (push --force, reset --hard, checkout ., restore ., clean -f, branch -D) unless the user explicitly requests these actions. Taking unauthorized destructive actions is unhelpful and can result in lost work, so it's best to ONLY run these commands when given direct instructions 
- NEVER skip hooks (--no-verify, --no-gpg-sign, etc) unless the user explicitly requests it
- NEVER run force push to main/master, warn the user if they request it
- CRITICAL: Always create NEW commits rather than amending, unless the user explicitly requests a git amend. When a pre-commit hook fails, the commit did NOT happen — so --amend would modify the PREVIOUS commit, which may result in destroying work or losing previous changes. Instead, after hook failure, fix the issue, re-stage, and create a NEW commit
- When staging files, prefer adding specific files by name rather than using "git add -A" or "git add .", which can accidentally include sensitive files (.env, credentials) or large binaries
- NEVER commit changes unless the user explicitly asks you to. It is VERY IMPORTANT to only commit when explicitly asked, otherwise the user will feel that you are being too proactive

1. Run the following bash commands in parallel, each using the Bash tool:
  - Run a git status command to see all untracked files. IMPORTANT: Never use the -uall flag as it can cause memory issues on large repos.
  - Run a git diff command to see both staged and unstaged changes that will be committed.
  - Run a git log command to see recent commit messages, so that you can follow this repository's commit message style.
2. Analyze all staged changes (both previously staged and newly added) and draft a commit message:
  - Summarize the nature of the changes (eg. new feature, enhancement to an existing feature, bug fix, refactoring, test, docs, etc.). Ensure the message accurately reflects the changes and their purpose (i.e. "add" means a wholly new feature, "update" means an enhancement to an existing feature, "fix" means a bug fix, etc.).
  - Do not commit files that likely contain secrets (.env, credentials.json, etc). Warn the user if they specifically request to commit those files
  - Draft a concise (1-2 sentences) commit message that focuses on the "why" rather than the "what"
  - Ensure it accurately reflects the changes and their purpose
3. Run the following commands in parallel:
   - Add relevant untracked files to the staging area.
   - Create the commit with a message ending with:
   Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
   - Run git status after the commit completes to verify success.
   Note: git status depends on the commit completing, so run it sequentially after the commit.
4. If the commit fails due to pre-commit hook: fix the issue and create a NEW commit

Important notes:
- NEVER run additional commands to read or explore code, besides git bash commands
- NEVER use the TodoWrite or Agent tools
- DO NOT push to the remote repository unless the user explicitly asks you to do so
- IMPORTANT: Never use git commands with the -i flag (like git rebase -i or git add -i) since they require interactive input which is not supported.
- IMPORTANT: Do not use --no-edit with git rebase commands, as the --no-edit flag is not a valid option for git rebase.
- If there are no changes to commit (i.e., no untracked files and no modifications), do not create an empty commit
- In order to ensure good formatting, ALWAYS pass the commit message via a HEREDOC, a la this example:
<example>
git commit -m "$(cat <<'EOF'
   Commit message here.

   Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
   EOF
   )"
</example>

# Creating pull requests
Use the gh command via the Bash tool for ALL GitHub-related tasks including working with issues, pull requests, checks, and releases. If given a Github URL use the gh command to get the information needed.

IMPORTANT: When the user asks you to create a pull request, follow these steps carefully:

1. Run the following bash commands in parallel using the Bash tool, in order to understand the current state of the branch since it diverged from the main branch:
   - Run a git status command to see all untracked files (never use -uall flag)
   - Run a git diff command to see both staged and unstaged changes that will be committed
   - Check if the current branch tracks a remote branch and is up to date with the remote, so you know if you need to push to the remote
   - Run a git log command and `git diff [base-branch]...HEAD` to understand the full commit history for the current branch (from the time it diverged from the base branch)
2. Analyze all changes that will be included in the pull request, making sure to look at all relevant commits (NOT just the latest commit, but ALL commits that will be included in the pull request!!!), and draft a pull request title and summary:
   - Keep the PR title short (under 70 characters)
   - Use the description/body for details, not the title
3. Run the following commands in parallel:
   - Create new branch if needed
   - Push to remote with -u flag if needed
   - Create PR using gh pr create with the format below. Use a HEREDOC to pass the body to ensure correct formatting.
<example>
gh pr create --title "the pr title" --body "$(cat <<'EOF'
## Summary
<1-3 bullet points>

## Test plan
[Bulleted markdown checklist of TODOs for testing the pull request...]

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
</example>

Important:
- DO NOT use the TodoWrite or Agent tools
- Return the PR URL when you're done, so the user can see it

# Other common operations
- View comments on a Github PR: gh api repos/foo/bar/pulls/123/comments

**input_schema**:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "command": {
      "description": "The command to execute",
      "type": "string"
    },
    "timeout": {
      "description": "Optional timeout in milliseconds (max 600000)",
      "type": "number"
    },
    "description": {
      "description": "Clear, concise description of what this command does in active voice. Never use words like \"complex\" or \"risk\" in the description - just describe what it does.\n\nFor simple commands (git, npm, standard CLI tools), keep it brief (5-10 words):\n- ls → \"List files in current directory\"\n- git status → \"Show working tree status\"\n- npm install → \"Install package dependencies\"\n\nFor commands that are harder to parse at a glance (piped commands, obscure flags, etc.), add enough context to clarify what it does:\n- find . -name \"*.tmp\" -exec rm {} \\; → \"Find and delete all .tmp files recursively\"\n- git reset --hard origin/main → \"Discard all local changes and match remote main\"\n- curl -s url | jq '.data[]' → \"Fetch JSON from URL and extract data array elements\"",
      "type": "string"
    },
    "run_in_background": {
      "description": "Set to true to run this command in the background. Use Read to read the output later.",
      "type": "boolean"
    },
    "dangerouslyDisableSandbox": {
      "description": "Set this to true to dangerously override sandbox mode and run commands without sandboxing.",
      "type": "boolean"
    }
  },
  "required": [
    "command"
  ],
  "additionalProperties": false
}
```

---

## 4. CronCreate

Schedule a prompt to be enqueued at a future time. Use for both recurring schedules and one-shot reminders.

Uses standard 5-field cron in the user's local timezone: minute hour day-of-month month day-of-week. "0 9 * * *" means 9am local — no timezone conversion needed.

## One-shot tasks (recurring: false)

For "remind me at X" or "at <time>, do Y" requests — fire once then auto-delete.
Pin minute/hour/day-of-month/month to specific values:
  "remind me at 2:30pm today to check the deploy" → cron: "30 14 <today_dom> <today_month> *", recurring: false
  "tomorrow morning, run the smoke test" → cron: "57 8 <tomorrow_dom> <tomorrow_month> *", recurring: false

## Recurring jobs (recurring: true, the default)

For "every N minutes" / "every hour" / "weekdays at 9am" requests:
  "*/5 * * * *" (every 5 min), "0 * * * *" (hourly), "0 9 * * 1-5" (weekdays at 9am local)

## Avoid the :00 and :30 minute marks when the task allows it

Every user who asks for "9am" gets `0 9`, and every user who asks for "hourly" gets `0 *` — which means requests from across the planet land on the API at the same instant. When the user's request is approximate, pick a minute that is NOT 0 or 30:
  "every morning around 9" → "57 8 * * *" or "3 9 * * *" (not "0 9 * * *")
  "hourly" → "7 * * * *" (not "0 * * * *")
  "in an hour or so, remind me to..." → pick whatever minute you land on, don't round

Only use minute 0 or 30 when the user names that exact time and clearly means it ("at 9:00 sharp", "at half past", coordinating with a meeting). When in doubt, nudge a few minutes early or late — the user will not notice, and the fleet will.

## Session-only

Jobs live only in this Claude session — nothing is written to disk, and the job is gone when Claude exits.

## Runtime behavior

Jobs only fire while the REPL is idle (not mid-query). The scheduler adds a small deterministic jitter on top of whatever you pick: recurring tasks fire up to 10% of their period late (max 15 min); one-shot tasks landing on :00 or :30 fire up to 90 s early. Picking an off-minute is still the bigger lever.

Recurring tasks auto-expire after 7 days — they fire one final time, then are deleted. This bounds session lifetime. Tell the user about the 7-day limit when scheduling recurring jobs.

Returns a job ID you can pass to CronDelete.

**input_schema**:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "cron": {
      "description": "Standard 5-field cron expression in local time: \"M H DoM Mon DoW\" (e.g. \"*/5 * * * *\" = every 5 minutes, \"30 14 28 2 *\" = Feb 28 at 2:30pm local once).",
      "type": "string"
    },
    "prompt": {
      "description": "The prompt to enqueue at each fire time.",
      "type": "string"
    },
    "recurring": {
      "description": "true (default) = fire on every cron match until deleted or auto-expired after 7 days. false = fire once at the next match, then auto-delete. Use false for \"remind me at X\" one-shot requests with pinned minute/hour/dom/month.",
      "type": "boolean"
    },
    "durable": {
      "description": "true = persist to .claude/scheduled_tasks.json and survive restarts. false (default) = in-memory only, dies when this Claude session ends. Use true only when the user asks the task to survive across sessions.",
      "type": "boolean"
    }
  },
  "required": [
    "cron",
    "prompt"
  ],
  "additionalProperties": false
}
```

---

## 5. CronDelete

Cancel a cron job previously scheduled with CronCreate. Removes it from the in-memory session store.

**input_schema**:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "description": "Job ID returned by CronCreate.",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "additionalProperties": false
}
```

---

## 6. CronList

List all cron jobs scheduled via CronCreate in this session.

**input_schema**:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

---

## 7. Edit

Performs exact string replacements in files.

Usage:
- You must use your `Read` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.
- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: line number + tab. Everything after that is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if `old_string` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use `replace_all` to change every instance of `old_string`.
- Use `replace_all` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.

**input_schema**:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "file_path": {
      "description": "The absolute path to the file to modify",
      "type": "string"
    },
    "old_string": {
      "description": "The text to replace",
      "type": "string"
    },
    "new_string": {
      "description": "The text to replace it with (must be different from old_string)",
      "type": "string"
    },
    "replace_all": {
      "description": "Replace all occurrences of old_string (default false)",
      "default": false,
      "type": "boolean"
    }
  },
  "required": [
    "file_path",
    "old_string",
    "new_string"
  ],
  "additionalProperties": false
}
```

---

## 8. EnterPlanMode

Use this tool proactively when you're about to start a non-trivial implementation task. Getting user sign-off on your approach before writing code prevents wasted effort and ensures alignment. This tool transitions you into plan mode where you can explore the codebase and design an implementation approach for user approval.

## When to Use This Tool

**Prefer using EnterPlanMode** for implementation tasks unless they're simple. Use it when ANY of these conditions apply:

1. **New Feature Implementation**: Adding meaningful new functionality
   - Example: "Add a logout button" - where should it go? What should happen on click?
   - Example: "Add form validation" - what rules? What error messages?

2. **Multiple Valid Approaches**: The task can be solved in several different ways
   - Example: "Add caching to the API" - could use Redis, in-memory, file-based, etc.
   - Example: "Improve performance" - many optimization strategies possible

3. **Code Modifications**: Changes that affect existing behavior or structure
   - Example: "Update the login flow" - what exactly should change?
   - Example: "Refactor this component" - what's the target architecture?

4. **Architectural Decisions**: The task requires choosing between patterns or technologies
   - Example: "Add real-time updates" - WebSockets vs SSE vs polling
   - Example: "Implement state management" - Redux vs Context vs custom solution

5. **Multi-File Changes**: The task will likely touch more than 2-3 files
   - Example: "Refactor the authentication system"
   - Example: "Add a new API endpoint with tests"

6. **Unclear Requirements**: You need to explore before understanding the full scope
   - Example: "Make the app faster" - need to profile and identify bottlenecks
   - Example: "Fix the bug in checkout" - need to investigate root cause

7. **User Preferences Matter**: The implementation could reasonably go multiple ways
   - If you would use AskUserQuestion to clarify the approach, use EnterPlanMode instead
   - Plan mode lets you explore first, then present options with context

## When NOT to Use This Tool

Only skip EnterPlanMode for simple tasks:
- Single-line or few-line fixes (typos, obvious bugs, small tweaks)
- Adding a single function with clear requirements
- Tasks where the user has given very specific, detailed instructions
- Pure research/exploration tasks (use the Agent tool with explore agent instead)

## What Happens in Plan Mode

In plan mode, you'll:
1. Thoroughly explore the codebase using Glob, Grep, and Read tools
2. Understand existing patterns and architecture
3. Design an implementation approach
4. Present your plan to the user for approval
5. Use AskUserQuestion if you need to clarify approaches
6. Exit plan mode with ExitPlanMode when ready to implement

## Examples

### GOOD - Use EnterPlanMode:
User: "Add user authentication to the app"
- Requires architectural decisions (session vs JWT, where to store tokens, middleware structure)

User: "Optimize the database queries"
- Multiple approaches possible, need to profile first, significant impact

User: "Implement dark mode"
- Architectural decision on theme system, affects many components

User: "Add a delete button to the user profile"
- Seems simple but involves: where to place it, confirmation dialog, API call, error handling, state updates

User: "Update the error handling in the API"
- Affects multiple files, user should approve the approach

### BAD - Don't use EnterPlanMode:
User: "Fix the typo in the README"
- Straightforward, no planning needed

User: "Add a console.log to debug this function"
- Simple, obvious implementation

User: "What files handle routing?"
- Research task, not implementation planning

## Important Notes

- This tool REQUIRES user approval - they must consent to entering plan mode
- If unsure whether to use it, err on the side of planning - it's better to get alignment upfront than to redo work
- Users appreciate being consulted before significant changes are made to their codebase

**input_schema**:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

---

## 9. EnterWorktree

Use this tool ONLY when explicitly instructed to work in a worktree — either by the user directly, or by project instructions (CLAUDE.md / memory). This tool creates an isolated git worktree and switches the current session into it.

## When to Use

- The user explicitly says "worktree" (e.g., "start a worktree", "work in a worktree", "create a worktree", "use a worktree")
- CLAUDE.md or memory instructions direct you to work in a worktree for the current task

## When NOT to Use

- The user asks to create a branch, switch branches, or work on a different branch — use git commands instead
- The user asks to fix a bug or work on a feature — use normal git workflow unless worktrees are explicitly requested by the user or project instructions
- Never use this tool unless "worktree" is explicitly mentioned by the user or in CLAUDE.md / memory instructions

## Requirements

- Must be in a git repository, OR have WorktreeCreate/WorktreeRemove hooks configured in settings.json
- Must not already be in a worktree

## Behavior

- In a git repository: creates a new git worktree inside `.claude/worktrees/` with a new branch based on HEAD
- Outside a git repository: delegates to WorktreeCreate/WorktreeRemove hooks for VCS-agnostic isolation
- Switches the session's working directory to the new worktree
- Use ExitWorktree to leave the worktree mid-session (keep or remove). On session exit, if still in the worktree, the user will be prompted to keep or remove it

## Entering an existing worktree

Pass `path` instead of `name` to switch the session into a worktree that already exists (e.g., one you just created with `git worktree add`). The path must appear in `git worktree list` for the current repository — paths that are not registered worktrees of this repo are rejected. ExitWorktree will not remove a worktree entered this way; use `action: "keep"` to return to the original directory.

## Parameters

- `name` (optional): A name for a new worktree. If neither `name` nor `path` is provided, a random name is generated.
- `path` (optional): Path to an existing worktree of the current repository to enter instead of creating one. Mutually exclusive with `name`.

**input_schema**:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "name": {
      "description": "Optional name for a new worktree. Each \"/\"-separated segment may contain only letters, digits, dots, underscores, and dashes; max 64 chars total. A random name is generated if not provided. Mutually exclusive with `path`.",
      "type": "string"
    },
    "path": {
      "description": "Path to an existing worktree of the current repository to switch into instead of creating a new one. Must appear in `git worktree list` for the current repo. Mutually exclusive with `name`.",
      "type": "string"
    }
  },
  "additionalProperties": false
}
```

---

## 10. ExitPlanMode

Use this tool when you are in plan mode and have finished writing your plan to the plan file and are ready for user approval.

## How This Tool Works
- You should have already written your plan to the plan file specified in the plan mode system message
- This tool does NOT take the plan content as a parameter - it will read the plan from the file you wrote
- This tool simply signals that you're done planning and ready for the user to review and approve
- The user will see the contents of your plan file when they review it

## When to Use This Tool
IMPORTANT: Only use this tool when the task requires planning the implementation steps of a task that requires writing code. For research tasks where you're gathering information, searching files, reading files or in general trying to understand the codebase - do NOT use this tool.

## Before Using This Tool
Ensure your plan is complete and unambiguous:
- If you have unresolved questions about requirements or approach, use AskUserQuestion first (in earlier phases)
- Once your plan is finalized, use THIS tool to request approval

**Important:** Do NOT use AskUserQuestion to ask "Is this plan okay?" or "Should I proceed?" - that's exactly what THIS tool does. ExitPlanMode inherently requests user approval of your plan.

## Examples

1. Initial task: "Search for and understand the implementation of vim mode in the codebase" - Do not use the exit plan mode tool because you are not planning the implementation steps of a task.
2. Initial task: "Help me implement yank mode for vim" - Use the exit plan mode tool after you have finished planning the implementation steps of the task.
3. Initial task: "Add a new feature to handle user authentication" - If unsure about auth method (OAuth, JWT, etc.), use AskUserQuestion first, then use exit plan mode tool after clarifying the approach.

**input_schema**:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "allowedPrompts": {
      "description": "Prompt-based permissions needed to implement the plan. These describe categories of actions rather than specific commands.",
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "tool": {
            "description": "The tool this prompt applies to",
            "type": "string",
            "enum": [
              "Bash"
            ]
          },
          "prompt": {
            "description": "Semantic description of the action, e.g. \"run tests\", \"install dependencies\"",
            "type": "string"
          }
        },
        "required": [
          "tool",
          "prompt"
        ],
        "additionalProperties": false
      }
    }
  },
  "additionalProperties": {}
}
```

---

## 11. ExitWorktree

Exit a worktree session created by EnterWorktree and return the session to the original working directory.

## Scope

This tool ONLY operates on worktrees created by EnterWorktree in this session. It will NOT touch:
- Worktrees you created manually with `git worktree add`
- Worktrees from a previous session (even if created by EnterWorktree then)
- The directory you're in if EnterWorktree was never called

If called outside an EnterWorktree session, the tool is a **no-op**: it reports that no worktree session is active and takes no action. Filesystem state is unchanged.

## When to Use

- The user explicitly asks to "exit the worktree", "leave the worktree", "go back", or otherwise end the worktree session
- Do NOT call this proactively — only when the user asks

## Parameters

- `action` (required): `"keep"` or `"remove"`
  - `"keep"` — leave the worktree directory and branch intact on disk. Use this if the user wants to come back to the work later, or if there are changes to preserve.
  - `"remove"` — delete the worktree directory and its branch. Use this for a clean exit when the work is done or abandoned.
- `discard_changes` (optional, default false): only meaningful with `action: "remove"`. If the worktree has uncommitted files or commits not on the original branch, the tool will REFUSE to remove it unless this is set to `true`. If the tool returns an error listing changes, confirm with the user before re-invoking with `discard_changes: true`.

## Behavior

- Restores the session's working directory to where it was before EnterWorktree
- Clears CWD-dependent caches (system prompt sections, memory files, plans directory) so the session state reflects the original directory
- If a tmux session was attached to the worktree: killed on `remove`, left running on `keep` (its name is returned so the user can reattach)
- Once exited, EnterWorktree can be called again to create a fresh worktree

**input_schema**:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "action": {
      "description": "\"keep\" leaves the worktree and branch on disk; \"remove\" deletes both.",
      "type": "string",
      "enum": [
        "keep",
        "remove"
      ]
    },
    "discard_changes": {
      "description": "Required true when action is \"remove\" and the worktree has uncommitted files or unmerged commits. The tool will refuse and list them otherwise.",
      "type": "boolean"
    }
  },
  "required": [
    "action"
  ],
  "additionalProperties": false
}
```

---

## 12. Glob

- Fast file pattern matching tool that works with any codebase size
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time
- Use this tool when you need to find files by name patterns
- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead

**input_schema**:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "pattern": {
      "description": "The glob pattern to match files against",
      "type": "string"
    },
    "path": {
      "description": "The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter \"undefined\" or \"null\" - simply omit it for the default behavior. Must be a valid directory path if provided.",
      "type": "string"
    }
  },
  "required": [
    "pattern"
  ],
  "additionalProperties": false
}
```

---

## 13. Grep

A powerful search tool built on ripgrep

  Usage:
  - ALWAYS use Grep for search tasks. NEVER invoke `grep` or `rg` as a Bash command. The Grep tool has been optimized for correct permissions and access.
  - Supports full regex syntax (e.g., "log.*Error", "function\s+\w+")
  - Filter files with glob parameter (e.g., "*.js", "**/*.tsx") or type parameter (e.g., "js", "py", "rust")
  - Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts
  - Use Agent tool for open-ended searches requiring multiple rounds
  - Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use `interface\{\}` to find `interface{}` in Go code)
  - Multiline matching: By default patterns match within single lines only. For cross-line patterns like `struct \{[\s\S]*?field`, use `multiline: true`

**input_schema**:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "pattern": {
      "description": "The regular expression pattern to search for in file contents",
      "type": "string"
    },
    "path": {
      "description": "File or directory to search in (rg PATH). Defaults to current working directory.",
      "type": "string"
    },
    "glob": {
      "description": "Glob pattern to filter files (e.g. \"*.js\", \"*.{ts,tsx}\") - maps to rg --glob",
      "type": "string"
    },
    "output_mode": {
      "description": "Output mode: \"content\" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), \"files_with_matches\" shows file paths (supports head_limit), \"count\" shows match counts (supports head_limit). Defaults to \"files_with_matches\".",
      "type": "string",
      "enum": [
        "content",
        "files_with_matches",
        "count"
      ]
    },
    "-B": {
      "description": "Number of lines to show before each match (rg -B). Requires output_mode: \"content\", ignored otherwise.",
      "type": "number"
    },
    "-A": {
      "description": "Number of lines to show after each match (rg -A). Requires output_mode: \"content\", ignored otherwise.",
      "type": "number"
    },
    "-C": {
      "description": "Alias for context.",
      "type": "number"
    },
    "context": {
      "description": "Number of lines to show before and after each match (rg -C). Requires output_mode: \"content\", ignored otherwise.",
      "type": "number"
    },
    "-n": {
      "description": "Show line numbers in output (rg -n). Requires output_mode: \"content\", ignored otherwise. Defaults to true.",
      "type": "boolean"
    },
    "-i": {
      "description": "Case insensitive search (rg -i)",
      "type": "boolean"
    },
    "type": {
      "description": "File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types.",
      "type": "string"
    },
    "head_limit": {
      "description": "Limit output to first N lines/entries, equivalent to \"| head -N\". Works across all output modes: content (limits output lines), files_with_matches (limits file paths), count (limits count entries). Defaults to 250 when unspecified. Pass 0 for unlimited (use sparingly — large result sets waste context).",
      "type": "number"
    },
    "offset": {
      "description": "Skip first N lines/entries before applying head_limit, equivalent to \"| tail -n +N | head -N\". Works across all output modes. Defaults to 0.",
      "type": "number"
    },
    "multiline": {
      "description": "Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false.",
      "type": "boolean"
    }
  },
  "required": [
    "pattern"
  ],
  "additionalProperties": false
}
```

---

## 14. Monitor

Start a background monitor that streams events from a long-running script. Each stdout line is an event — you keep working and notifications arrive in the chat. Events arrive on their own schedule and are not replies from the user, even if one lands while you're waiting for the user to answer a question.

Monitor is for the **streaming** case: "tell me every time X happens." For one-shot "wait until X is done," use Bash with run_in_background instead — you'll get a completion notification when it exits.

Your script's stdout is the event stream. Each line becomes a notification. Exit ends the watch.

  # Each matching log line is an event
  tail -f /var/log/app.log | grep --line-buffered "ERROR"

  # Each file change is an event
  inotifywait -m --format '%e %f' /watched/dir

  # Poll GitHub for new PR comments and emit one line per new comment
  last=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  while true; do
    now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    gh api "repos/owner/repo/issues/123/comments?since=$last" --jq '.[] | "\(.user.login): \(.body)"'
    last=$now; sleep 30
  done

  # Node script that emits events as they arrive (e.g. WebSocket listener)
  node watch-for-events.js

**Script quality:**
- Always use `grep --line-buffered` in pipes — without it, pipe buffering delays events by minutes.
- In poll loops, handle transient failures (`curl ... || true`) — one failed request shouldn't kill the monitor.
- Poll intervals: 30s+ for remote APIs (rate limits), 0.5-1s for local checks.
- Write a specific `description` — it appears in every notification ("errors in deploy.log" not "watching logs").
- Only stdout is the event stream. Stderr goes to the output file (readable via Read) but does not trigger notifications — for a command you run directly (e.g. `python train.py 2>&1 | grep --line-buffered ...`), merge stderr with `2>&1` so its failures reach your filter. (No effect on `tail -f` of an existing log — that file only contains what its writer redirected.)

**Coverage — silence is not success.** When watching a job or process for an outcome, your filter must match every terminal state, not just the happy path. A monitor that greps only for the success marker stays silent through a crashloop, a hung process, or an unexpected exit — and silence looks identical to "still running." Before arming, ask: *if this process crashed right now, would my filter emit anything?* If not, widen it.

  # Wrong — silent on crash, hang, or any non-success exit
  tail -f run.log | grep --line-buffered "elapsed_steps="

  # Right — one alternation covering progress + the failure signatures you'd act on
  tail -f run.log | grep -E --line-buffered "elapsed_steps=|Traceback|Error|FAILED|assert|Killed|OOM"

For poll loops checking job state, emit on every terminal status (`succeeded|failed|cancelled|timeout`), not just success. If you cannot confidently enumerate the failure signatures, broaden the grep alternation rather than narrow it — some extra noise is better than missing a crashloop.

**Output volume**: Every stdout line is a conversation message, so the filter should be selective — but selective means "the lines you'd act on," not "only good news." Never pipe raw logs; use `grep --line-buffered`, `awk`, or a wrapper that emits exactly the success and failure signals you care about. Monitors that produce too many events are automatically stopped; restart with a tighter filter if this happens.

Stdout lines within 200ms are batched into a single notification, so multiline output from a single event groups naturally.

The script runs in the same shell environment as Bash. Exit ends the watch (exit code is reported). Timeout → killed. Set `persistent: true` for session-length watches (PR monitoring, log tails) — the monitor runs until you call TaskStop or the session ends. Use TaskStop to cancel early.

**input_schema**:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "description": {
      "description": "Short human-readable description of what you are monitoring (shown in notifications).",
      "type": "string"
    },
    "timeout_ms": {
      "description": "Kill the monitor after this deadline. Default 300000ms, max 3600000ms. Ignored when persistent is true.",
      "default": 300000,
      "type": "number",
      "minimum": 1000
    },
    "persistent": {
      "description": "Run for the lifetime of the session (no timeout). Use for session-length watches like PR monitoring or log tails. Stop with TaskStop.",
      "default": false,
      "type": "boolean"
    },
    "command": {
      "description": "Shell command or script. Each stdout line is an event; exit ends the watch.",
      "type": "string"
    }
  },
  "required": [
    "description",
    "timeout_ms",
    "persistent",
    "command"
  ],
  "additionalProperties": false
}
```

---

## 15. NotebookEdit

Completely replaces the contents of a specific cell in a Jupyter notebook (.ipynb file) with new source. Jupyter notebooks are interactive documents that combine code, text, and visualizations, commonly used for data analysis and scientific computing. The notebook_path parameter must be an absolute path, not a relative path. The cell_number is 0-indexed. Use edit_mode=insert to add a new cell at the index specified by cell_number. Use edit_mode=delete to delete the cell at the index specified by cell_number.

**input_schema**:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "notebook_path": {
      "description": "The absolute path to the Jupyter notebook file to edit (must be absolute, not relative)",
      "type": "string"
    },
    "cell_id": {
      "description": "The ID of the cell to edit. When inserting a new cell, the new cell will be inserted after the cell with this ID, or at the beginning if not specified.",
      "type": "string"
    },
    "new_source": {
      "description": "The new source for the cell",
      "type": "string"
    },
    "cell_type": {
      "description": "The type of the cell (code or markdown). If not specified, it defaults to the current cell type. If using edit_mode=insert, this is required.",
      "type": "string",
      "enum": [
        "code",
        "markdown"
      ]
    },
    "edit_mode": {
      "description": "The type of edit to make (replace, insert, delete). Defaults to replace.",
      "type": "string",
      "enum": [
        "replace",
        "insert",
        "delete"
      ]
    }
  },
  "required": [
    "notebook_path",
    "new_source"
  ],
  "additionalProperties": false
}
```

---

## 16. PushNotification

This tool sends a desktop notification in the user's terminal. If Remote Control is connected, it also pushes to their phone. Either way, it pulls their attention from whatever they're doing — a meeting, another task, dinner — to this session. That's the cost. The benefit is they learn something now that they'd want to know now: a long task finished while they were away, a build is ready, you've hit something that needs their decision before you can continue.

Because a notification they didn't need is annoying in a way that accumulates, err toward not sending one. Don't notify for routine progress, or to announce you've answered something they asked seconds ago and are clearly still watching, or when a quick task completes. Notify when there's a real chance they've walked away and there's something worth coming back for — or when they've explicitly asked you to notify them.

Keep the message under 200 characters, one line, no markdown. Lead with what they'd act on — "build failed: 2 auth tests" tells them more than "task done" and more than a status dump.

If the result says the push wasn't sent, that's expected — no action needed.

**input_schema**:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "message": {
      "description": "The notification body. Keep it under 200 characters; mobile OSes truncate.",
      "type": "string",
      "minLength": 1
    },
    "status": {
      "type": "string",
      "const": "proactive"
    }
  },
  "required": [
    "message",
    "status"
  ],
  "additionalProperties": false
}
```

---

## 17. Read

Reads a file from the local filesystem. You can access any file directly by using this tool.
Assume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- The file_path parameter must be an absolute path, not a relative path
- By default, it reads up to 2000 lines starting from the beginning of the file
- When you already know which part of the file you need, only read that part. This can be important for larger files.
- Results are returned using cat -n format, with line numbers starting at 1
- This tool allows Claude Code to read images (eg PNG, JPG, etc). When reading an image file the contents are presented visually as Claude Code is a multimodal LLM.
- This tool can read PDF files (.pdf). For large PDFs (more than 10 pages), you MUST provide the pages parameter to read specific page ranges (e.g., pages: "1-5"). Reading a large PDF without the pages parameter will fail. Maximum 20 pages per request.
- This tool can read Jupyter notebooks (.ipynb files) and returns all cells with their outputs, combining code, text, and visualizations.
- This tool can only read files, not directories. To list files in a directory, use the registered shell tool.
- You will regularly be asked to read screenshots. If the user provides a path to a screenshot, ALWAYS use this tool to view the file at the path. This tool will work with all temporary file paths.
- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.

**input_schema**:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "file_path": {
      "description": "The absolute path to the file to read",
      "type": "string"
    },
    "offset": {
      "description": "The line number to start reading from. Only provide if the file is too large to read at once",
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "limit": {
      "description": "The number of lines to read. Only provide if the file is too large to read at once.",
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "pages": {
      "description": "Page range for PDF files (e.g., \"1-5\", \"3\", \"10-20\"). Only applicable to PDF files. Maximum 20 pages per request.",
      "type": "string"
    }
  },
  "required": [
    "file_path"
  ],
  "additionalProperties": false
}
```

---

## 18. RemoteTrigger

Call the claude.ai remote-trigger API. Use this instead of curl — the OAuth token is added automatically in-process and never exposed.

Actions:
- list: GET /v1/code/triggers
- get: GET /v1/code/triggers/{trigger_id}
- create: POST /v1/code/triggers (requires body)
- update: POST /v1/code/triggers/{trigger_id} (requires body, partial update)
- run: POST /v1/code/triggers/{trigger_id}/run (optional body)

The response is the raw JSON from the API.

**input_schema**:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "enum": [
        "list",
        "get",
        "create",
        "update",
        "run"
      ]
    },
    "trigger_id": {
      "description": "Required for get, update, and run",
      "type": "string",
      "pattern": "^[\\w-]+$"
    },
    "body": {
      "description": "Required for create and update; optional for run",
      "type": "object",
      "propertyNames": {
        "type": "string"
      },
      "additionalProperties": {}
    }
  },
  "required": [
    "action"
  ],
  "additionalProperties": false
}
```

---

## 19. ScheduleWakeup

Schedule when to resume work in /loop dynamic mode — the user invoked /loop without an interval, asking you to self-pace iterations of a specific task.

Pass the same /loop prompt back via `prompt` each turn so the next firing repeats the task. For an autonomous /loop (no user prompt), pass the literal sentinel `<<autonomous-loop-dynamic>>` as `prompt` instead — the runtime resolves it back to the autonomous-loop instructions at fire time. (There is a similar `<<autonomous-loop>>` sentinel for CronCreate-based autonomous loops; do not confuse the two — ScheduleWakeup always uses the `-dynamic` variant.) Omit the call to end the loop.

## Picking delaySeconds

The Anthropic prompt cache has a 5-minute TTL. Sleeping past 300 seconds means the next wake-up reads your full conversation context uncached — slower and more expensive. So the natural breakpoints:

- **Under 5 minutes (60s–270s)**: cache stays warm. Right for active work — checking a build, polling for state that's about to change, watching a process you just started.
- **5 minutes to 1 hour (300s–3600s)**: pay the cache miss. Right when there's no point checking sooner — waiting on something that takes minutes to change, or genuinely idle.

**Don't pick 300s.** It's the worst-of-both: you pay the cache miss without amortizing it. If you're tempted to "wait 5 minutes," either drop to 270s (stay in cache) or commit to 1200s+ (one cache miss buys a much longer wait). Don't think in round-number minutes — think in cache windows.

For idle ticks with no specific signal to watch, default to **1200s–1800s** (20–30 min). The loop checks back, you don't burn cache 12× per hour for nothing, and the user can always interrupt if they need you sooner.

Think about what you're actually waiting for, not just "how long should I sleep." If you kicked off an 8-minute build, sleeping 60s burns the cache 8 times before it finishes — sleep ~270s twice instead.

The runtime clamps to [60, 3600], so you don't need to clamp yourself.

## The reason field

One short sentence on what you chose and why. Goes to telemetry and is shown back to the user. "checking long bun build" beats "waiting." The user reads this to understand what you're doing without having to predict your cadence in advance — make it specific.

**input_schema**:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "delaySeconds": {
      "description": "Seconds from now to wake up. Clamped to [60, 3600] by the runtime.",
      "type": "number"
    },
    "reason": {
      "description": "One short sentence explaining the chosen delay. Goes to telemetry and is shown to the user. Be specific.",
      "type": "string"
    },
    "prompt": {
      "description": "The /loop input to fire on wake-up. Pass the same /loop input verbatim each turn so the next firing re-enters the skill and continues the loop. For autonomous /loop (no user prompt), pass the literal sentinel `<<autonomous-loop-dynamic>>` instead (the dynamic-pacing variant, not the CronCreate-mode `<<autonomous-loop>>`).",
      "type": "string"
    }
  },
  "required": [
    "delaySeconds",
    "reason",
    "prompt"
  ],
  "additionalProperties": false
}
```

---

## 20. Skill

Execute a skill within the main conversation

When users ask you to perform tasks, check if any of the available skills match. Skills provide specialized capabilities and domain knowledge.

When users reference a "slash command" or "/<something>", they are referring to a skill. Use this tool to invoke it.

How to invoke:
- Set `skill` to the exact name of an available skill (no leading slash). For plugin-namespaced skills use the fully qualified `plugin:skill` form.
- Set `args` to pass optional arguments.

Important:
- Available skills are listed in system-reminder messages in the conversation
- Only invoke a skill that appears in that list, or one the user explicitly typed as `/<name>` in their message. Never guess or invent a skill name from training data; otherwise do not call this tool
- When a skill matches the user's request, this is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task
- NEVER mention a skill without actually calling this tool
- Do not invoke a skill that is already running
- Do not use this tool for built-in CLI commands (like /help, /clear, etc.)
- If you see a <command-name> tag in the current conversation turn, the skill has ALREADY been loaded - follow the instructions directly instead of calling this tool again

**input_schema**:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "skill": {
      "description": "The name of a skill from the available-skills list. Do not guess names.",
      "type": "string"
    },
    "args": {
      "description": "Optional arguments for the skill",
      "type": "string"
    }
  },
  "required": [
    "skill"
  ],
  "additionalProperties": false
}
```

---

## 21. TaskOutput

DEPRECATED: Background tasks return their output file path in the tool result, and you receive a <task-notification> with the same path when the task completes.
- For bash tasks: prefer using the Read tool on that output file path — it contains stdout/stderr.
- For local_agent tasks: use the Agent tool result directly. Do NOT Read the .output file — it is a symlink to the full sub-agent conversation transcript (JSONL) and will overflow your context window.
- For remote_agent tasks: prefer using the Read tool on the output file path — it contains the streamed remote session output (same as bash).

- Retrieves output from a running or completed task (background shell, agent, or remote session)
- Takes a task_id parameter identifying the task
- Returns the task output along with status information
- Use block=true (default) to wait for task completion
- Use block=false for non-blocking check of current status
- Task IDs can be found using the /tasks command
- Works with all task types: background shells, async agents, and remote sessions

**input_schema**:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "task_id": {
      "description": "The task ID to get output from",
      "type": "string"
    },
    "block": {
      "description": "Whether to wait for completion",
      "default": true,
      "type": "boolean"
    },
    "timeout": {
      "description": "Max wait time in ms",
      "default": 30000,
      "type": "number",
      "minimum": 0,
      "maximum": 600000
    }
  },
  "required": [
    "task_id",
    "block",
    "timeout"
  ],
  "additionalProperties": false
}
```

---

## 22. TaskStop

- Stops a running background task by its ID
- Takes a task_id parameter identifying the task to stop
- Returns a success or failure status
- Use this tool when you need to terminate a long-running task

**input_schema**:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "task_id": {
      "description": "The ID of the background task to stop",
      "type": "string"
    },
    "shell_id": {
      "description": "Deprecated: use task_id instead",
      "type": "string"
    }
  },
  "additionalProperties": false
}
```

---

## 23. TodoWrite

Use this tool to create and manage a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
It also helps the user understand the progress of the task and overall progress of their requests.

## When to Use This Tool
Use this tool proactively in these scenarios:

1. Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
2. Non-trivial and complex tasks - Tasks that require careful planning or multiple operations
3. User explicitly requests todo list - When the user directly asks you to use the todo list
4. User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)
5. After receiving new instructions - Immediately capture user requirements as todos
6. When you start working on a task - Mark it as in_progress BEFORE beginning work. Ideally you should only have one todo as in_progress at a time
7. After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation

## When NOT to Use This Tool

Skip using this tool when:
1. There is only a single, straightforward task
2. The task is trivial and tracking it provides no organizational benefit
3. The task can be completed in less than 3 trivial steps
4. The task is purely conversational or informational

NOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.

## Examples of When to Use the Todo List

<example>
User: I want to add a dark mode toggle to the application settings. Make sure you run the tests and build when you're done!
Assistant: *Creates todo list with the following items:*
1. Creating dark mode toggle component in Settings page
2. Adding dark mode state management (context/store)
3. Implementing CSS-in-JS styles for dark theme
4. Updating existing components to support theme switching
5. Running tests and build process, addressing any failures or errors that occur
*Begins working on the first task*

<reasoning>
The assistant used the todo list because:
1. Adding dark mode is a multi-step feature requiring UI, state management, and styling changes
2. The user explicitly requested tests and build be run afterward
3. The assistant inferred that tests and build need to pass by adding "Ensure tests and build succeed" as the final task
</reasoning>
</example>

<example>
User: Help me rename the function getCwd to getCurrentWorkingDirectory across my project
Assistant: *Uses grep or search tools to locate all instances of getCwd in the codebase*
I've found 15 instances of 'getCwd' across 8 different files.
*Creates todo list with specific items for each file that needs updating*

<reasoning>
The assistant used the todo list because:
1. First, the assistant searched to understand the scope of the task
2. Upon finding multiple occurrences across different files, it determined this was a complex task with multiple steps
3. The todo list helps ensure every instance is tracked and updated systematically
4. This approach prevents missing any occurrences and maintains code consistency
</reasoning>
</example>


<example>
User: I need to implement these features for my e-commerce site: user registration, product catalog, shopping cart, and checkout flow.
Assistant: *Creates a todo list breaking down each feature into specific tasks based on the project architecture*
Let's start with user registration. This will involve creating database models, API endpoints, and frontend forms that integrate with your existing authentication system.

<reasoning>
The assistant used the todo list because:
1. The user provided multiple complex features to implement in a comma separated list
2. The todo list helps organize these large features into manageable tasks
3. This approach allows for tracking progress across the entire implementation
</reasoning>
</example>

<example>
User: Can you help optimize my React application? It's rendering slowly and has performance issues.
Assistant: *Reviews component structure, render patterns, state management, and data fetching*
After analyzing your codebase, I've identified several performance issues.
*Creates todo list with items like: 1) Implementing memoization for expensive calculations in ProductList, 2) Adding virtualization for long lists in Dashboard, 3) Optimizing image loading in Gallery component, 4) Fixing state update loops in ShoppingCart, 5) Reviewing bundle size and implementing code splitting*
Let's start by implementing memoization for the expensive calculations in your ProductList component.

<reasoning>
The assistant used the todo list because:
1. First, the assistant examined the codebase to identify specific performance issues
2. Based on this analysis, it identified multiple optimization opportunities
3. Performance optimization is a non-trivial task requiring multiple steps
4. The todo list helps methodically track improvements across different components
5. This systematic approach ensures all performance bottlenecks are addressed
</reasoning>
</example>

## Examples of When NOT to Use the Todo List

<example>
User: How do I print 'Hello World' in Python?
Assistant: In Python, you can print "Hello World" with this simple code:

python
print("Hello World")

This will output the text "Hello World" to the console when executed.

<reasoning>
The assistant did not use the todo list because this is a single, trivial task that can be completed in one step. There's no need to track multiple tasks or steps for such a straightforward request.
</reasoning>
</example>

<example>
User: What does the git status command do?
Assistant: The git status command shows the current state of your working directory and staging area. It displays which changes have been staged, which haven't, and which files aren't being tracked by Git. This is a fundamental command for understanding the current state of your repository before making commits.

<reasoning>
The assistant did not use the todo list because this is an informational request with no actual coding task to complete. The user is simply asking for an explanation, not for the assistant to perform multiple steps or tasks.
</reasoning>
</example>

<example>
User: Can you add a comment to the calculateTotal function to explain what it does?
Assistant: Sure, let me add a comment to the calculateTotal function to explain what it does.
* Uses the Edit tool to add a comment to the calculateTotal function *

<reasoning>
The assistant did not use the todo list because this is a single, straightforward task confined to one location in the code. Adding a comment doesn't require tracking multiple steps or systematic organization.
</reasoning>
</example>

<example>
User: Run npm install for me and tell me what happens.
Assistant: I'll run the npm install command for you.

*Executes: npm install*

The command completed successfully. Here's the output:
[Output of npm install command]

All dependencies have been installed according to your package.json file.

<reasoning>
The assistant did not use the todo list because this is a single command execution with immediate results. There are no multiple steps to track or organize, making the todo list unnecessary for this straightforward task.
</reasoning>
</example>

## Task States and Management

1. **Task States**: Use these states to track progress:
   - pending: Task not yet started
   - in_progress: Currently working on (limit to ONE task at a time)
   - completed: Task finished successfully

   **IMPORTANT**: Task descriptions must have two forms:
   - content: The imperative form describing what needs to be done (e.g., "Run tests", "Build the project")
   - activeForm: The present continuous form shown during execution (e.g., "Running tests", "Building the project")

2. **Task Management**:
   - Update task status in real-time as you work
   - Mark tasks complete IMMEDIATELY after finishing (don't batch completions)
   - Exactly ONE task must be in_progress at any time (not less, not more)
   - Complete current tasks before starting new ones
   - Remove tasks that are no longer relevant from the list entirely

3. **Task Completion Requirements**:
   - ONLY mark a task as completed when you have FULLY accomplished it
   - If you encounter errors, blockers, or cannot finish, keep the task as in_progress
   - When blocked, create a new task describing what needs to be resolved
   - Never mark a task as completed if:
     - Tests are failing
     - Implementation is partial
     - You encountered unresolved errors
     - You couldn't find necessary files or dependencies

4. **Task Breakdown**:
   - Create specific, actionable items
   - Break complex tasks into smaller, manageable steps
   - Use clear, descriptive task names
   - Always provide both forms:
     - content: "Fix authentication bug"
     - activeForm: "Fixing authentication bug"

When in doubt, use this tool. Being proactive with task management demonstrates attentiveness and ensures you complete all requirements successfully.

**input_schema**:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "todos": {
      "description": "The updated todo list",
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "content": {
            "type": "string",
            "minLength": 1
          },
          "status": {
            "type": "string",
            "enum": [
              "pending",
              "in_progress",
              "completed"
            ]
          },
          "activeForm": {
            "type": "string",
            "minLength": 1
          }
        },
        "required": [
          "content",
          "status",
          "activeForm"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "todos"
  ],
  "additionalProperties": false
}
```

---

## 24. WebFetch

IMPORTANT: WebFetch WILL FAIL for authenticated or private URLs. Before using this tool, check if the URL points to an authenticated service (e.g. Google Docs, Confluence, Jira, GitHub). If so, look for a specialized MCP tool that provides authenticated access.

- Fetches content from a specified URL and processes it using an AI model
- Takes a URL and a prompt as input
- Fetches the URL content, converts HTML to markdown
- Processes the content with the prompt using a small, fast model
- Returns the model's response about the content
- Use this tool when you need to retrieve and analyze web content

Usage notes:
  - IMPORTANT: If an MCP-provided web fetch tool is available, prefer using that tool instead of this one, as it may have fewer restrictions.
  - The URL must be a fully-formed valid URL
  - HTTP URLs will be automatically upgraded to HTTPS
  - The prompt should describe what information you want to extract from the page
  - This tool is read-only and does not modify any files
  - Results may be summarized if the content is very large
  - Includes a self-cleaning 15-minute cache for faster responses when repeatedly accessing the same URL
  - When a URL redirects to a different host, the tool will inform you and provide the redirect URL in a special format. You should then make a new WebFetch request with the redirect URL to fetch the content.
  - For GitHub URLs, prefer using the gh CLI via Bash instead (e.g., gh pr view, gh issue view, gh api).

**input_schema**:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "url": {
      "description": "The URL to fetch content from",
      "type": "string",
      "format": "uri"
    },
    "prompt": {
      "description": "The prompt to run on the fetched content",
      "type": "string"
    }
  },
  "required": [
    "url",
    "prompt"
  ],
  "additionalProperties": false
}
```

---

## 25. WebSearch

- Allows Claude to search the web and use the results to inform responses
- Provides up-to-date information for current events and recent data
- Returns search result information formatted as search result blocks, including links as markdown hyperlinks
- Use this tool for accessing information beyond Claude's knowledge cutoff
- Searches are performed automatically within a single API call

CRITICAL REQUIREMENT - You MUST follow this:
  - After answering the user's question, you MUST include a "Sources:" section at the end of your response
  - In the Sources section, list all relevant URLs from the search results as markdown hyperlinks: [Title](URL)
  - This is MANDATORY - never skip including sources in your response
  - Example format:

    [Your answer here]

    Sources:
    - [Source Title 1](https://example.com/1)
    - [Source Title 2](https://example.com/2)

Usage notes:
  - Domain filtering is supported to include or block specific websites
  - Web search is only available in the US

IMPORTANT - Use the correct year in search queries:
  - The current month is May 2026. You MUST use this year when searching for recent information, documentation, or current events.
  - Example: If the user asks for "latest React docs", search for "React documentation" with the current year, NOT last year

**input_schema**:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "query": {
      "description": "The search query to use",
      "type": "string",
      "minLength": 2
    },
    "allowed_domains": {
      "description": "Only include search results from these domains",
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "blocked_domains": {
      "description": "Never include search results from these domains",
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "query"
  ],
  "additionalProperties": false
}
```

---

## 26. Write

Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.
- Prefer the Edit tool for modifying existing files — it only sends the diff. Only use this tool to create new files or for complete rewrites.
- NEVER create documentation files (*.md) or README files unless explicitly requested by the User.
- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.

**input_schema**:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "file_path": {
      "description": "The absolute path to the file to write (must be absolute, not relative)",
      "type": "string"
    },
    "content": {
      "description": "The content to write to the file",
      "type": "string"
    }
  },
  "required": [
    "file_path",
    "content"
  ],
  "additionalProperties": false
}
```

---

## 27. mcp__agents__create_agent

Create a new agent in this workspace. The user is asked to approve every create_agent call — there is no "always allow" for this tool.

After creation, you can interact with the new agent using its returned slug via invoke_agent / get_sessions / get_session_transcript.

Provide a short, descriptive name. Optionally provide a description (one line, what the agent is for) and instructions (the system prompt / CLAUDE.md body for the new agent).

**input_schema**:

```json
{
  "type": "object",
  "properties": {
    "name": {
      "description": "Short descriptive name for the new agent (e.g. \"Email Triager\")",
      "type": "string"
    },
    "description": {
      "description": "Optional one-line description of what the agent does",
      "type": "string"
    },
    "instructions": {
      "description": "Optional system prompt / instructions for the new agent (becomes its CLAUDE.md body)",
      "type": "string"
    }
  },
  "required": [
    "name"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

---

## 28. mcp__agents__get_agent_session_transcript

Read the message transcript of a session belonging to another agent. Returns a status line ('running' | 'idle' | 'awaiting_input') followed by the messages.

If sync=true and the session is currently running, the tool waits until the target agent's turn is complete before returning. Otherwise it returns the current transcript immediately.

Tool calls in the transcript are summarized — the raw tool input/output is omitted to keep the result compact.

**input_schema**:

```json
{
  "type": "object",
  "properties": {
    "slug": {
      "description": "Slug of the target agent (from list_agents)",
      "type": "string"
    },
    "session_id": {
      "description": "Session ID (from get_agent_sessions)",
      "type": "string"
    },
    "sync": {
      "description": "If true, wait for the session to idle before reading. Default false.",
      "type": "boolean"
    }
  },
  "required": [
    "slug",
    "session_id"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

---

## 29. mcp__agents__get_agent_sessions

List the sessions of another agent in this workspace, newest first. Returns each session's id, name, last activity time, and whether it is currently running.

Returns up to 50 sessions by default. If more exist, the response includes a hint with the next offset to pass back in for the next page.

Use the returned session ID with get_session_transcript to read the conversation, or with invoke_agent to send a follow-up message into an existing session.

**input_schema**:

```json
{
  "type": "object",
  "properties": {
    "slug": {
      "description": "Slug of the target agent (from list_agents)",
      "type": "string"
    },
    "limit": {
      "description": "Max sessions to return (default 50, max 200)",
      "type": "number"
    },
    "offset": {
      "description": "Number of sessions to skip from the newest (default 0)",
      "type": "number"
    }
  },
  "required": [
    "slug"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

---

## 30. mcp__agents__invoke_agent

Send a message to another agent in this workspace.

If session_id is omitted, a new session is started on the target agent. If session_id is provided, the message is appended to that existing session — the session must exist and not currently be running (use get_session_transcript with sync to wait).

If sync=true, the tool waits for the target agent's turn to finish and returns its last message. If sync=false (default), the tool returns immediately with status 'running' and you can later read the transcript with get_session_transcript.

Use list_agents first to discover available slugs.

Note: sessions started by another agent cannot themselves invoke other agents — invocation is one hop deep.

**input_schema**:

```json
{
  "type": "object",
  "properties": {
    "slug": {
      "description": "Slug of the target agent (from list_agents)",
      "type": "string"
    },
    "prompt": {
      "description": "Message to send to the target agent",
      "type": "string"
    },
    "session_id": {
      "description": "Optional existing session ID to continue. Omit to start a new session.",
      "type": "string"
    },
    "sync": {
      "description": "If true, wait for the target agent to finish its turn and return its final message. Default false.",
      "type": "boolean"
    }
  },
  "required": [
    "slug",
    "prompt"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

---

## 31. mcp__agents__list_agents

List the other agents in this workspace that you can interact with. Returns each agent's slug, name, and description.

Use this before invoke_agent to discover available agents. The list excludes yourself.

In auth mode, the list is filtered to agents the workspace owner has access to.

**input_schema**:

```json
{
  "type": "object",
  "properties": {},
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

---

## 32. mcp__browser__browser_click

Click an element on the page by its ref (e.g., @s1). Get refs from browser_snapshot. Refs persist across snapshots — if you remember a ref from an earlier snapshot, it still works as long as the element is still on the page.

**input_schema**:

```json
{
  "type": "object",
  "properties": {
    "ref": {
      "description": "Element ref from snapshot (e.g., \"@s1\")",
      "type": "string"
    }
  },
  "required": [
    "ref"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

---

## 33. mcp__browser__browser_close

Close the browser and free resources. Call this when you're done browsing.

**input_schema**:

```json
{
  "type": "object",
  "properties": {},
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

---

## 34. mcp__browser__browser_fill

Fill an input field by its ref (e.g., @s2) with a value. Get refs from browser_snapshot.

**input_schema**:

```json
{
  "type": "object",
  "properties": {
    "ref": {
      "description": "Input element ref from snapshot (e.g., \"@s2\")",
      "type": "string"
    },
    "value": {
      "description": "The text to fill into the input",
      "type": "string"
    }
  },
  "required": [
    "ref",
    "value"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

---

## 35. mcp__browser__browser_get_state

Get the current state of the browser in one call. Returns the current URL, a screenshot image, and an accessibility snapshot. Use this to quickly check what the browser is showing without needing multiple tool calls.

**input_schema**:

```json
{
  "type": "object",
  "properties": {},
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

---

## 36. mcp__browser__browser_hover

Hover over an element by its ref. Useful for triggering dropdown menus, tooltips, or hover states. Get refs from browser_snapshot.

**input_schema**:

```json
{
  "type": "object",
  "properties": {
    "ref": {
      "description": "Element ref from snapshot (e.g., \"@s1\")",
      "type": "string"
    }
  },
  "required": [
    "ref"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

---

## 37. mcp__browser__browser_open

Open a headless browser and navigate to a URL. The user can see the browser live in their interface and interact with it directly.

Use this to start browsing a website. The browser preserves cookies/sessions via a persistent profile, so the user only needs to log in once.

**input_schema**:

```json
{
  "type": "object",
  "properties": {
    "url": {
      "description": "The URL to navigate to",
      "type": "string"
    }
  },
  "required": [
    "url"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

---

## 38. mcp__browser__browser_press

Press a keyboard key. Use this for Enter (submit forms), Tab (next field), Escape (close dialogs), or key combos like "Control+a".

**input_schema**:

```json
{
  "type": "object",
  "properties": {
    "key": {
      "description": "Key to press (e.g., \"Enter\", \"Tab\", \"Escape\", \"Control+a\", \"ArrowDown\")",
      "type": "string"
    }
  },
  "required": [
    "key"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

---

## 39. mcp__browser__browser_run

Run any agent-browser CLI command. Use this for advanced browser operations not covered by the dedicated tools.

Pass the command string WITHOUT the "agent-browser" prefix.

Available commands:
- dblclick <ref> — Double-click element
- focus <ref> — Focus element
- type <ref> <text> — Type text (appends, unlike fill which clears first)
- keydown/keyup <key> — Hold/release key
- check/uncheck <ref> — Toggle checkbox
- scrollintoview <ref> — Scroll element into view
- drag <srcRef> <tgtRef> — Drag and drop
- upload <ref> <files> — Upload files
- eval <js> — Run JavaScript
- get text/html/value/attr/title/url/count/box <ref> — Get element info
- is visible/enabled/checked <ref> — Check element state
- find role/text/label/placeholder/alt/title/testid <query> <action> — Semantic locators
- back / forward / reload — Navigation
- tab / tab new / tab <n> / tab close — Tab management
- frame <sel> / frame main — Switch frames
- dialog accept/dismiss — Handle dialogs
- set viewport/device/geo/offline/headers/media — Browser settings
- cookies / cookies set/clear — Cookie management
- storage local/session [get/set/clear] — Storage management
- mouse move/down/up/wheel — Low-level mouse control
- network route/unroute/requests — Network interception
- console / errors — Debug info
- wait <selector|ms|--text|--url|--load|--fn> — Wait for conditions

**input_schema**:

```json
{
  "type": "object",
  "properties": {
    "command": {
      "description": "The agent-browser command to run (without \"agent-browser\" prefix)",
      "type": "string"
    }
  },
  "required": [
    "command"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

---

## 40. mcp__browser__browser_screenshot

Take a screenshot for visual verification. Use annotate=true to overlay numbered labels — each label [N] is paired with a stable ref @sN you can pass to browser_click / browser_fill, same as refs from browser_snapshot.

**input_schema**:

```json
{
  "type": "object",
  "properties": {
    "full": {
      "description": "Capture full scrollable page (default: false, viewport only)",
      "default": false,
      "type": "boolean"
    },
    "annotate": {
      "description": "Overlay numbered labels [N] @sN on interactive elements (default: false). Useful when you want to pick a target visually.",
      "default": false,
      "type": "boolean"
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

---

## 41. mcp__browser__browser_scroll

Scroll the page in a given direction.

**input_schema**:

```json
{
  "type": "object",
  "properties": {
    "direction": {
      "description": "Scroll direction",
      "type": "string",
      "enum": [
        "up",
        "down",
        "left",
        "right"
      ]
    },
    "amount": {
      "description": "Scroll amount in pixels (default: browser default)",
      "type": "number"
    }
  },
  "required": [
    "direction"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

---

## 42. mcp__browser__browser_select

Select an option from a <select> dropdown element by its ref. Get refs from browser_snapshot.

**input_schema**:

```json
{
  "type": "object",
  "properties": {
    "ref": {
      "description": "Select element ref from snapshot (e.g., \"@s3\")",
      "type": "string"
    },
    "value": {
      "description": "The option value to select",
      "type": "string"
    }
  },
  "required": [
    "ref",
    "value"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

---

## 43. mcp__browser__browser_snapshot

Get the current state of the page as an accessibility tree with stable refs (@s1, @s2, ...).

The first call (or one after a navigation / full-page replacement) returns the full tree. Subsequent calls return only what changed since the last call — added / removed / changed elements, plus a count of unchanged ones. You always know which one you got from the response header.

Refs persist across calls: a ref you saw earlier still points to the same element as long as that element is still on the page. Reuse refs you already have. Refs are tool-layer identifiers — pass them only to browser_click / browser_fill / browser_hover / browser_select / browser_run's ref argument. They are NOT DOM attributes; do not put @sN inside a CSS selector or eval.

Call this once per new page, and again after any action (click / fill / scroll / hover / press / select / open).

Parameters:
- fresh=true forces a full tree instead of a diff. Useful when a diff looked wrong or you have lost track of state.
- include_text=true includes non-interactive text content (addresses, prices, paragraphs, list-item text, descriptions). Default false keeps the tree compact by listing only interactive elements + headings + landmarks. Turn this on when the task requires reading content that the default tree is missing. Returns a full tree (no diff) and is ~3-10× larger, so do not leave it on for routine observations.

**input_schema**:

```json
{
  "type": "object",
  "properties": {
    "fresh": {
      "description": "Force a full snapshot instead of a diff (default: false).",
      "default": false,
      "type": "boolean"
    },
    "include_text": {
      "description": "Include non-interactive text nodes (addresses, prices, paragraphs, etc.). Default false. Forces a full snapshot. Use when the default interactive-only tree is missing the content you need to read.",
      "default": false,
      "type": "boolean"
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

---

## 44. mcp__browser__browser_wait

Wait for a CSS selector to appear on the page. Only use this when you need to wait for a specific element to render (e.g. after triggering dynamic content). Do NOT use for "networkidle", "load", or "domcontentloaded" — browser_open already waits for the page to load.

**input_schema**:

```json
{
  "type": "object",
  "properties": {
    "for": {
      "description": "CSS selector to wait for (e.g. \"#results\", \".loaded\"). Avoid \"networkidle\"/\"load\"/\"domcontentloaded\" — browser_open already handles page load.",
      "type": "string"
    }
  },
  "required": [
    "for"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

---

## 45. mcp__dashboards__create_dashboard

Scaffold a new dashboard project at /workspace/artifacts/<slug>/. This creates the directory structure, package.json, and starter code.

After creating, use start_dashboard to start the server.

Arguments:
- slug: URL-safe identifier for the dashboard (e.g., "sales-dashboard")
- name: Human-readable name for the dashboard
- description: Optional description of what the dashboard shows
- framework: "plain" (default) for plain HTML+JS using Bun.serve(), or "react" for a React + Vite setup

**input_schema**:

```json
{
  "type": "object",
  "properties": {
    "slug": {
      "description": "URL-safe identifier for the dashboard",
      "type": "string"
    },
    "name": {
      "description": "Human-readable name for the dashboard",
      "type": "string"
    },
    "description": {
      "description": "Description of what the dashboard shows",
      "type": "string"
    },
    "framework": {
      "description": "Framework to use: \"plain\" (Bun.serve) or \"react\" (React + Vite)",
      "type": "string",
      "enum": [
        "plain",
        "react"
      ]
    }
  },
  "required": [
    "slug",
    "name"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

---

## 46. mcp__dashboards__get_dashboard_logs

Get the stdout/stderr logs from a dashboard server. Useful for debugging when a dashboard crashes or misbehaves.

Optionally clear the log file after reading.

**input_schema**:

```json
{
  "type": "object",
  "properties": {
    "slug": {
      "description": "The slug of the dashboard to get logs for",
      "type": "string"
    },
    "clear": {
      "description": "If true, truncate the log file after reading",
      "type": "boolean"
    }
  },
  "required": [
    "slug"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

---

## 47. mcp__dashboards__list_dashboards

List all dashboards created by the agent. Returns each dashboard's slug, name, description, status, and port.

**input_schema**:

```json
{
  "type": "object",
  "properties": {},
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

---

## 48. mcp__dashboards__start_dashboard

Start a dashboard server, or restart it if already running. Use this after creating a new dashboard or after making code changes.

The dashboard must exist at /workspace/artifacts/<slug>/ with a valid package.json.

**input_schema**:

```json
{
  "type": "object",
  "properties": {
    "slug": {
      "description": "The slug of the dashboard to start",
      "type": "string"
    }
  },
  "required": [
    "slug"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

---

## 49. mcp__user-input__deliver_file

Deliver a file to the user. Provide the path to a file in your workspace that you want the user to be able to download. The file will be presented as a download link in the user's chat interface.

Use this when you've created, processed, or fetched a file that the user needs to download.

Example usage:
- filePath: "/workspace/output/report.pdf" - User can download the generated report
- filePath: "/workspace/data/results.csv" - User can download processed data

**input_schema**:

```json
{
  "type": "object",
  "properties": {
    "filePath": {
      "description": "Path to the file in the workspace (e.g., /workspace/output/report.pdf)",
      "type": "string"
    },
    "description": {
      "description": "Brief description of the file being delivered",
      "type": "string"
    }
  },
  "required": [
    "filePath"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

---

## 50. mcp__user-input__deliver_session

Surface a session to the user as a clickable card in the chat. Use this when you want to point the user at an existing or newly-started agent session — e.g. "Here's the session I started" after invoking another agent, or "Here's the session I found" after searching agent history.

The user sees the card and can click to jump straight to that session.

Provide:
- session_id: the session ID (from invoke_agent, get_agent_sessions, etc.)
- agent_slug (optional): slug of the agent that owns the session. Omit when delivering one of your own sessions; pass the target slug for cross-agent sessions.
- description (optional): a short note shown above the card explaining why you're surfacing this session.

**input_schema**:

```json
{
  "type": "object",
  "properties": {
    "session_id": {
      "description": "Session ID to deliver",
      "type": "string"
    },
    "agent_slug": {
      "description": "Slug of the agent that owns the session. Omit for your own sessions.",
      "type": "string"
    },
    "description": {
      "description": "Short note shown to the user above the session card",
      "type": "string"
    }
  },
  "required": [
    "session_id"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

---

## 51. mcp__user-input__request_browser_input

Request the user to manually interact with the browser. You MUST call this tool whenever you encounter a login page, CAPTCHA, 2FA challenge, password prompt, cookie consent, or any other obstacle that requires manual user interaction. Do NOT just describe the obstacle in chat — always use this tool.

The user will see your message and requirements in the UI alongside the browser preview. The tool blocks until the user clicks "Complete" or chooses to chat with you instead. After the user completes, take a browser snapshot to see the current state.

Example:
- message: "I need you to log in to your bank account"
- requirements: ["Navigate to the login page", "Enter your credentials", "Complete 2FA if prompted"]

**input_schema**:

```json
{
  "type": "object",
  "properties": {
    "message": {
      "description": "A short statement describing what the user needs to do. Never use first person or greetings. Must end with a period. Example: 'Log in to the bank account to continue the data export.'",
      "type": "string"
    },
    "requirements": {
      "description": "Optional formal list of specific actions the user should complete",
      "default": [],
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "message"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

---

## 52. mcp__user-input__request_connected_account

Request access to a connected account (e.g., Gmail, Slack, GitHub) from the user. The user will be prompted to select existing connected accounts or connect a new one via OAuth.

After the user provides access, the CONNECTED_ACCOUNTS environment variable will be updated with the new account metadata. You can then make authenticated API calls through the proxy:

URL pattern: $PROXY_BASE_URL/<account_id>/<target_host>/<api_path>
Authorization: Bearer $PROXY_TOKEN

The CONNECTED_ACCOUNTS env var contains JSON mapping toolkit names to arrays of {name, id} objects.

Common toolkits include gmail, slack, github, notion, linear, salesforce, and many more. Use search_connected_account_services to discover all available services and their toolkit slugs.

**input_schema**:

```json
{
  "type": "object",
  "properties": {
    "toolkit": {
      "description": "The toolkit/service to request access for (e.g., gmail, slack, github). Use lowercase.",
      "type": "string"
    },
    "reason": {
      "description": "A question for the user following the pattern 'Allow access to {service} to {purpose}?'. Never use first person. Must end with '?'. Example: 'Allow access to Gmail to search for the shipping confirmation?'",
      "type": "string"
    }
  },
  "required": [
    "toolkit"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

---

## 53. mcp__user-input__request_file

Request a file from the user. The user will be prompted to upload a file through the UI.

Use this when you need the user to provide a file (document, image, data file, etc.) for processing.

After the user uploads the file, the tool will return the path where the file was saved in the workspace.

The user may also decline the request, optionally providing a reason.

Example usage:
- description: "Please upload the CSV file with sales data"
- description: "Please provide the logo image for the report" with fileTypes: ".png,.jpg,.svg"

**input_schema**:

```json
{
  "type": "object",
  "properties": {
    "description": {
      "description": "A short statement following the pattern 'Upload your {file description} so the agent can {purpose}.'. Never use first person. Must end with a period. Example: 'Upload your sales CSV so the agent can generate the quarterly report.'",
      "type": "string"
    },
    "fileTypes": {
      "description": "Accepted file types hint (e.g., \".csv,.xlsx\" or \"images\"). This is advisory only.",
      "type": "string"
    }
  },
  "required": [
    "description"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

---

## 54. mcp__user-input__request_remote_mcp

Request access to a remote MCP server. The user will be prompted to connect the MCP server (potentially going through OAuth), then assign it to this agent. After approval, the MCP tools become available.

Use this when you need to interact with an MCP server that hasn't been configured for this agent yet. You should know the URL of the MCP server you want to connect to.

**input_schema**:

```json
{
  "type": "object",
  "properties": {
    "url": {
      "description": "The URL of the remote MCP server (e.g., https://mcp.example.com/mcp)",
      "type": "string",
      "format": "uri"
    },
    "name": {
      "description": "Suggested display name for the MCP server",
      "type": "string"
    },
    "reason": {
      "description": "A question for the user following the pattern 'Allow access to {server} to {purpose}?'. Never use first person. Must end with '?'. Example: 'Allow access to Slack MCP to post the weekly summary?'",
      "type": "string"
    },
    "authHint": {
      "description": "Authentication type hint if known (e.g., from reading the MCP server docs). Use \"oauth\" for servers requiring OAuth authorization, \"bearer\" for servers requiring a bearer token.",
      "type": "string",
      "enum": [
        "oauth",
        "bearer"
      ]
    }
  },
  "required": [
    "url"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

---

## 55. mcp__user-input__request_secret

Request a secret (API key, token, password) from the user. The user will be prompted to provide the value through the UI. Use this when you need credentials that are not already available in your environment.

After the user provides the secret, it will be available as an environment variable with the name you specified.

Example usage:
- secretName: "GITHUB_TOKEN" - User provides value, then $GITHUB_TOKEN is available
- secretName: "OPENAI_API_KEY" - User provides value, then $OPENAI_API_KEY is available

Always check your available environment variables first (listed at the start of the conversation) before requesting a new secret.

**input_schema**:

```json
{
  "type": "object",
  "properties": {
    "secretName": {
      "description": "Environment variable name for this secret (e.g., GITHUB_TOKEN, OPENAI_API_KEY). Use UPPER_SNAKE_CASE.",
      "type": "string"
    },
    "reason": {
      "description": "A question for the user following the pattern 'Add {secretName} so the agent can {purpose}?'. Never use first person. Must end with '?'. Example: 'Add GITHUB_TOKEN so the agent can authenticate with the GitHub API?'",
      "type": "string"
    }
  },
  "required": [
    "secretName"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

---

## 56. mcp__user-input__schedule_task

Schedule a task to be executed at a specific time or recurring interval.

For one-time tasks, use 'at' syntax:
- "at now + 1 hour" - Execute 1 hour from now
- "at now + 2 days" - Execute 2 days from now
- "at tomorrow 9am" - Execute tomorrow at 9 AM
- "at next monday" - Execute next Monday
- "at 2024-03-15 14:00" - Execute at specific date/time

For recurring tasks, use cron syntax (5 fields: minute hour day-of-month month day-of-week):
- "0 0 * * *" - Daily at midnight
- "0 9 * * 1-5" - Weekdays at 9 AM
- "*/15 * * * *" - Every 15 minutes
- "0 0 1 * *" - First day of every month at midnight

The prompt you provide will be sent to the agent as a new conversation at the scheduled time.
The task will be executed in a new session, and the agent will have full access to tools and capabilities.

Note: One-time tasks ('at') will execute once and complete. Recurring tasks ('cron') will continue executing on schedule until cancelled.

**input_schema**:

```json
{
  "type": "object",
  "properties": {
    "scheduleType": {
      "description": "Type of schedule: \"at\" for one-time execution, \"cron\" for recurring",
      "type": "string",
      "enum": [
        "at",
        "cron"
      ]
    },
    "scheduleExpression": {
      "description": "The schedule expression. For \"at\": use natural language like \"at now + 1 hour\" or \"at tomorrow 9am\". For \"cron\": use standard cron syntax like \"0 9 * * 1-5\"",
      "type": "string"
    },
    "prompt": {
      "description": "The prompt/task to execute at the scheduled time. This will be sent to the agent as a new conversation.",
      "type": "string"
    },
    "name": {
      "description": "Optional display name for this scheduled task (e.g., \"Daily backup\", \"Send weekly report\")",
      "type": "string"
    },
    "timezone": {
      "description": "Optional IANA timezone for interpreting the schedule (e.g., \"America/New_York\", \"Europe/London\"). If not specified, uses the creating user's timezone.",
      "type": "string"
    },
    "model": {
      "description": "Optional model family to use for this task. If not specified, uses the global default.",
      "type": "string",
      "enum": [
        "opus",
        "sonnet",
        "haiku"
      ]
    },
    "effort": {
      "description": "Optional effort level for this task. If not specified, uses the global default.",
      "type": "string",
      "enum": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    }
  },
  "required": [
    "scheduleType",
    "scheduleExpression",
    "prompt"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

---

## 57. mcp__user-input__search_connected_account_services

Search for available OAuth services that can be connected via the request_connected_account tool. Call with no search term to list all services, or provide a search term to filter by name, category, or description.

**input_schema**:

```json
{
  "type": "object",
  "properties": {
    "search": {
      "description": "Optional search term to filter services (matches name, slug, category, or description). Omit to list all.",
      "type": "string"
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

---

## 58. mcp__user-input__search_remote_mcp_services

Search for well-known remote MCP servers that can be connected via the request_remote_mcp tool. Call with no search term to list all known servers, or provide a search term to filter by name, category, or description. This is a partial directory — if you don't find the service you need, search the web.

**input_schema**:

```json
{
  "type": "object",
  "properties": {
    "search": {
      "description": "Optional search term to filter MCP servers (matches name, slug, category, or description). Omit to list all.",
      "type": "string"
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

---

