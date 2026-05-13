# Snapshots

Each subdirectory is a captured snapshot keyed by `@anthropic-ai/claude-agent-sdk` version.

```
<sdk-version>/
├── meta.json                       ← sdk_version, model, superagent_commit, captured_at
├── pure-claude/<model>/            ← what the bare `claude_code` preset emits
│   ├── system.md
│   ├── messages.md
│   ├── tools.md
│   └── raw.json
└── superagent/<model>/             ← what SuperAgent's agent-container emits
    ├── system.md
    ├── messages.md
    ├── tools.md
    └── raw.json
```

## Two axes, two questions

| Axis          | Cross-snapshot diff answers                                                 |
| ------------- | --------------------------------------------------------------------------- |
| `pure-claude` | What did **Anthropic** change in the `claude_code` preset between SDK versions? |
| `superagent`  | What did **our overlay** add/remove on top, and did it drift?               |

The diff *between* `pure-claude` and `superagent` in a single snapshot is "our known modifications" — intentional, not noise. We don't try to subtract it; we just track both axes independently over time.

## Commit policy

- Commit `<sdk-version>/**/*.md` and `meta.json`.
- Do **not** commit `raw.json` (large, redundant with the `.md` renderings) or `.seen-models.json` (proxy internal state). Both are already gitignored.

## Workflow

```bash
# After bumping @anthropic-ai/claude-agent-sdk in SuperAgent/agent-container:
../capture.sh --superagent-path /abs/path/to/SuperAgent

# Compare against the previous snapshot:
../diff.sh <previous-sdk-version> <new-sdk-version>
```
