# Agent Self-Knowledge Docs

**Status:** Draft for review
**Branch:** `claude/agent-self-knowledge-docs-6084eb`

## Context

Users frequently ask agents questions about the product itself — "what can you do?", "how do I set up a webhook?", "is my data secure?" — and today the agent can only answer from whatever happens to be in its system prompt, which is optimized for *doing* tasks, not *explaining* the product. Answers are inconsistent, sometimes wrong, and security questions get improvised.

Separately, the system prompt ([agent-container/src/system-prompt.md](../../agent-container/src/system-prompt.md), 915 lines) carries long instructional sections for features used rarely in any given session (connected accounts ~77 lines, webhooks ~71, scheduling ~63, …). Every token of that is paid on every request whether or not the feature comes up.

This feature gives agents a read-only, file-based product-knowledge folder baked into the container image, plus a short system-prompt directive to consult it. Retrieval is purely file-system based — expressive folder/file names + an index file, no RAG. As a second phase, the verbose system-prompt sections shrink to short pointers into the same folder.

## Goals

1. Agents answer product questions (capabilities, how-tos, security) accurately by reading docs, not improvising.
2. Docs are read-only to the agent, invisible in the workspace file browser, and excluded from agent exports/templates.
3. Content is seeded from the existing gamut-website docs (`gamut-website/content/docs/`, published at www.gamut.so/docs) — not written from scratch.
4. (Phase 2) The system prompt gets meaningfully shorter by pointing to docs files instead of inlining rarely-needed detail.

**Non-goals:** host-side (outside-container) Q&A, doc search infrastructure/RAG, auto-syncing docs from the website repo at runtime.

## Design

### 1. Docs folder baked into the image

New checked-in folder **`agent-container/docs/`**, copied into the image at **`/opt/gamut/docs`**:

```dockerfile
# After `RUN useradd … claude`, before `USER claude` — root-owned, world-readable
COPY docs/ /opt/gamut/docs/
RUN chmod -R a-w,a+rX /opt/gamut/docs
```

This mirrors the existing pattern for the dashboards skill (`COPY skills/ /home/claude/.claude/skills/`, [Dockerfile:165](../../agent-container/Dockerfile)).

**Why this placement satisfies each requirement, with no code changes:**

- **Read-only:** the agent runs as user `claude` ([Dockerfile:169](../../agent-container/Dockerfile)); the existing `chown` covers only `/app` and `/workspace`, so `/opt/gamut/docs` stays root-owned. `chmod a-w` is belt-and-braces. The agent cannot edit or delete the docs.
- **Excluded from exports:** template and full exports walk the host-side workspace dir only (`walkTemplateFiles` / `exportAgentFull` in [agent-template-service.ts](../../src/shared/lib/services/agent-template-service.ts) start from `getAgentWorkspaceDir`). Files outside `/workspace` never exist on the host, so nothing to exclude.
- **Invisible in the UI file browser:** the container `/files/tree` endpoint is rooted at `/workspace` ([server.ts:311](../../agent-container/src/server.ts)).
- **All runtimes for free:** Docker, Lima, Apple Container, and the Lambda MicroVM all run the same image built from this Dockerfile, so no per-runtime work.

Size impact is negligible: the entire website docs tree is ~390 KB of Markdown.

### 2. Folder structure and naming

File names are the retrieval mechanism, so they read as the questions/tasks the agent is trying to resolve:

```
/opt/gamut/docs/
├── INDEX.md                          # one line per file: path — what it answers
├── faq/
│   ├── what-can-the-agent-do.md      # capability overview (written fresh, from prompt + docs)
│   ├── what-is-gamut-and-how-does-it-work.md  ← getting-started/{introduction,core-concepts}
│   ├── is-my-data-secure.md          # security & privacy FAQ (written fresh — see below)
│   ├── what-integrations-are-supported.md
│   └── how-do-i-get-help-or-report-a-bug.md   # DEFERRED until support channel decided (open question 3)
├── how-to/                           # seeded from gamut-website "Using SuperAgent" tab
│   ├── connect-external-accounts-oauth.md        ← integrations/connected-accounts.mdx
│   ├── use-secrets-and-api-keys.md               ← agents/secrets.mdx
│   ├── schedule-recurring-and-one-time-tasks.md  ← automation/scheduled-tasks.mdx
│   ├── set-up-webhook-triggers.md                ← automation/webhook-triggers.mdx
│   ├── connect-slack-telegram-imessage.md        ← chat-integrations/*.mdx
│   ├── build-dashboards-and-artifacts.md         ← apps/*.mdx
│   ├── browse-the-web.md                         ← browser-use/*.mdx
│   ├── work-with-other-agents.md                 ← multi-agent/*.mdx
│   ├── create-and-manage-skills.md               ← skillsets/*.mdx
│   ├── use-remote-mcp-servers.md                 ← integrations/remote-mcp-servers.mdx
│   └── …                                         (one file per user-facing task; ~15 files)
└── platform/                         # architecture context, mostly written fresh
    ├── how-the-agent-container-works.md   # /workspace volume, session model, container server
    ├── where-am-i-running.md              # runtimes (Docker/Lima/Apple/MicroVM), what persists, env vars
    └── self-hosting-setup-and-administration.md  ← merged from the "Self-Hosting" docs tab
```

(A planned `platform/how-oauth-proxy-and-scopes-work.md` was dropped: the website's
connected-accounts page already documents the proxy flow in depth, so
`how-to/connect-external-accounts-oauth.md` covers it.)

Rules:

- **Every file starts with frontmatter:** `title`, `description` (one sentence, matches its INDEX.md line), and `source_url` when the content mirrors a public page (e.g. `https://www.gamut.so/docs/using-superagent/agents/secrets`). The agent can hand that URL to users who want the human-readable version.
- **`INDEX.md` is the entry point** — the directive tells the agent to read it first. Hand-maintained (like `MEMORY.md`), guarded by a unit test that fails if any doc file is missing from the index or vice versa.
- **`platform/` exists for harness-adjacent debugging**: when the agent hits container-shaped weirdness (missing env var, wiped `/tmp`, browser port conflicts), these docs explain the runtime instead of letting it guess.

### 3. Content seeding from gamut-website

The website docs are already agent-friendly: plain Markdown bodies with `title`/`description` frontmatter; only 2 of 41 files use MDX components. Seeding is a one-time scripted transform, then the copies are **owned and curated in this repo**:

- One-off script (can live in `scratchpad/`, not merged): strip MDX imports/components from the 2 affected files, merge multi-file sections (e.g. 4 chat-integration pages → one how-to), rename into the question/task naming above, add `source_url` frontmatter.
- After seeding, files are hand-edited to be *agent-ready*: UI click-paths stay (the agent uses them to guide users), but each file gains a short "as the agent" section where relevant — which tool the agent itself calls (e.g. `request_connected_account`), and what the user sees when it does.
- **Fresh content** (no website source): `faq/is-my-data-secure.md`, `faq/what-can-the-agent-do.md`, and `platform/*`. The security FAQ makes factual claims (container isolation, OAuth tokens never entering the container, per-agent secret scoping, permission prompts, scope policies) — **West reviews this file specifically before merge.**
- Drift policy: agent docs and website docs are allowed to diverge; the website serves humans, this folder serves the agent. When a feature changes, its PR updates the agent doc the same way it updates the system prompt today. (Optional later: a drift-check script comparing `source_url` pages against the seeded copies.)

### 4. System prompt directive + trigger design (Phase 1)

There is no search layer, so **triggering is the design**: the directive carries the trigger taxonomy (the shapes of prompts that should send the agent to the docs), and INDEX.md descriptions are phrased as the user questions themselves — second-stage routing, exactly how skill descriptions drive skill invocation.

The shipped directive (in [system-prompt.md](../../agent-container/src/system-prompt.md), first subsection under `# Gamut Platform`) enumerates five trigger shapes:

1. **Capability discovery** — "what can you do / what features do you have / what should I ask you"
2. **Product how-to and help** — "how do I connect Gmail / run this every morning / talk to you from Slack"
3. **Trust and security** — "is this safe / can you see my passwords / where does my data live"
4. **Feature availability** — "do you support X / can you text me"
5. **Platform debugging** (agent-initiated) — failures that smell like the harness → `platform/`

…plus two guard rules:

- **Anti-trigger:** "Can you X?" where X is a concrete, attemptable task is a *task request* — do it; don't detour through docs. The docs are for questions *about the product*.
- **Authority:** docs describe the full product; the agent's live tool list wins for what's enabled on this agent.

The likelier failure mode is **under**-triggering (answering product questions from vibes), countered by the explicit "answer from the docs, not from memory" instruction. No template variables needed — the path is static; `generateSystemPrompt` ([claude-code.ts:83,488](../../agent-container/src/claude-code.ts)) is untouched in Phase 1.

### 5. System prompt shortening (Phase 2, separate PR)

Each verbose section shrinks to: what the feature is (1-2 sentences) + tool names + "read `/opt/gamut/docs/how-to/<file>.md` before using it." The doc file absorbs parameters, examples, payload formats, and workflows.

| Section (lines today) | Target | Moves to docs | Stays inline |
|---|---|---|---|
| Requesting Connected Accounts (~77) | ~12 | env-var format, Python examples, toolkit list, proxy call walkthrough | "ask for accounts, never raw tokens"; proxy-approval-delay note |
| Webhook Triggers (~71) | ~18 | tool walkthrough, HMAC scheme list, CEL filter examples | security bullets (capability URL, unverified-payload rules), "use filters" nudge |
| Scheduling Tasks (~63) | ~10 | cron/at syntax examples, management-tool details | schedule_task vs schedule_resume decision rule |
| File Handling (~34) | ~12 | bookmarks format, request_file workflow | upload/deliver paths and tool names |
| Requesting Secrets (~32) | ~8 | `.env` mechanics, uv `--env-file` examples | "check env vars before requesting" |
| Cross-Agent Work (~23) | ~10 | per-tool walkthroughs | one-hop rule; "user usually wants YOU, not a new agent" |
| Chat Integrations (~21) | ~6 | provider setup details | tool-family pointer |
| Requesting Remote MCP (~20) | ~6 | workflow detail | "check available servers first" |

**Kept inline on purpose** (decision-time behavior, not reference material): Language Guidelines for user-facing requests, Pausing/Resuming rules, Golden Rule (skills), browsing/dashboard/computer-use delegation workflows, all security warnings.

Net: ~340 lines → ~80, a ~28% cut of the static prompt. Sections that render conditionally (`<%#composioTriggers%>` etc.) keep their conditionals; the docs files are static and instead state "if these tools aren't available, the feature isn't enabled for this agent."

Risk & mitigation: shortening trades always-loaded instructions for read-on-demand. Mitigate by keeping tool *names* inline (discovery stays prompt-level; only usage detail moves) and by landing Phase 2 as its own PR so it can be reverted independently if agents start fumbling rarely-used features.

## Implementation plan

**PR 1 — docs folder + directive** (this branch):
1. `agent-container/docs/` — INDEX.md + seeded/authored content per §2–§3.
2. Dockerfile: `COPY docs/ /opt/gamut/docs/` + `chmod` (per §1).
3. `system-prompt.md`: add Product Knowledge subsection (per §4).
4. Tests: INDEX.md completeness unit test (in `agent-container/src`); extend the Dockerfile smoke pattern with a build-time assert that `/opt/gamut/docs/INDEX.md` exists and is not writable by `claude`.

**PR 2 — prompt shortening** (stacked on PR 1): rewrite the eight sections per §5 table; each shortened section's removed detail must already exist in the corresponding docs file (grep-able rule: every `/opt/gamut/docs/` path mentioned in the prompt exists — add to the completeness test).

## Verification

- **Trigger matrix** — after `npm run build:container`, start an agent and run one prompt per trigger shape, confirming a docs Read appears in the transcript and the answer matches the docs:
  | Shape | Prompt | Expected |
  |---|---|---|
  | capability | "what can you do?" | reads INDEX + `faq/what-can-the-agent-do.md` |
  | how-to | "how do I connect my Gmail?" | reads `how-to/connect-external-accounts-oauth.md` |
  | security | "can you see my passwords?" | reads `faq/is-my-data-secure.md` |
  | availability | "can you text me?" | reads chat-integrations doc, checks own tool list |
  | debugging | (induce a missing-env-var moment) | consults `platform/` before flailing |
  | **anti-trigger** | "can you check what's on Hacker News?" | browses; NO docs read |
  | **anti-trigger** | "what's the capital of France?" | answers directly; NO docs read |
- In-container checks: `ls -la /opt/gamut/docs` (root-owned, `r-xr-xr-x`), `touch /opt/gamut/docs/x` fails as user `claude`.
- Export an agent template + full export; confirm the zip contains nothing from the docs folder (it can't — see §1 — but verify once).
- Agent file browser shows no docs folder.
- Phase 2: re-run the same product questions plus one execution task per shortened feature (e.g. actually schedule a task, set up a webhook) to confirm the agent reads the how-to before acting.

## Open questions

1. **Path branding:** `/opt/gamut/docs` (matches "Gamut Platform" in the prompt) vs `/opt/superagent/docs` (matches the website's "Using SuperAgent"). Spec assumes `gamut`.
2. **Self-hosting depth:** ship the full Self-Hosting tab or just `platform/self-hosting-basics.md`? Spec assumes the condensed single file; full tab is a cheap follow-up if self-host admins use agents for ops debugging.
3. **`faq/how-do-i-get-help-or-report-a-bug.md`** needs a real support channel to point at (email? GitHub issues?) — needs a decision from West.
