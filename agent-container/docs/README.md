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

- `scheduling-and-resuming.md`
- `webhooks.md`
- `media-generation.md`
- `chat-integrations.md`
- `browser-use.md`
- `building-dashboards.md`
- `computer-use.md`

## Product FAQs

- `faqs/how-do-i-get-help-or-report-a-bug.md`
- `faqs/is-my-data-secure.md`
- `faqs/what-can-the-agent-do.md`
- `faqs/what-integrations-are-supported.md`
- `faqs/what-is-gamut-and-how-does-it-work.md`
