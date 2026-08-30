# Gamut Capability Guides

These guides are installed at `/opt/gamut/docs/` in the agent container. They
contain procedural guidance that is useful only when an agent invokes a
specific Gamut capability.

The `faqs/` directory contains user-facing product knowledge. For questions
about Gamut, the agent itself, product capabilities, integrations, support, or
security and privacy, list that directory and read the relevant FAQ before
answering.

The system prompt remains the authority for:

- capability discovery and when to use a capability;
- safety, approval, and user-visible side-effect rules;
- runtime-dependent capability availability;
- dynamic accounts, MCP servers, models, and environment variables.

The guides contain:

- cross-tool workflows;
- examples and command syntax;
- capability-specific failure modes and validation steps.

Tool schemas are the source of truth for individual parameters. Do not copy a
complete schema into a guide unless the relationship between its fields is
itself important.

## Guides

- `session-history.md`
- `scheduling-and-resuming.md`
- `webhooks.md`
- `media-generation.md`
- `chat-integrations.md`
- `browser-use.md`
- `computer-use.md`
- `x.md`

`session-history.md` is the one guide with executable companions: the two
readers under `agent-container/bin/`, installed at `/opt/gamut/bin/`. Keep the
guide's flags and the scripts' argument parsers in step —
`src/session-history-scripts.test.ts` exercises the scripts, not the prose.

Dashboard guidance is not here — it lives in the `dashboards` skill
(`agent-container/skills/dashboards/`), which the agent already discovers
through the skill mechanism. Do not add a second copy under this directory.

## Product FAQs

- `faqs/how-do-i-get-help-or-report-a-bug.md`
- `faqs/is-my-data-secure.md`
- `faqs/what-can-the-agent-do.md`
- `faqs/what-integrations-are-supported.md`
- `faqs/what-is-gamut-and-how-does-it-work.md`
