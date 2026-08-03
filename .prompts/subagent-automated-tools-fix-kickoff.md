You are the implementing session for a diagnosed bug in SuperAgent. The diagnosis is complete and
signed off; your job is the failing-test-first fix, nothing else.

Setup:
1. `cd /Users/jeremybischoff/Desktop/worktrees/SuperAgent/fix+subagent-automated-tool-dispatch`
2. Assert `git branch --show-current` prints `fix/subagent-automated-tool-dispatch`. Stop if not.
3. Ground in the project memory store and standing principles (CLAUDE.md, CLAUDE.local.md) before
   touching code.

Read, in order:
1. `.prompts/subagent-automated-tools-root-cause.md` — the proven diagnosis. Do not re-litigate it.
2. `.prompts/subagent-automated-tools-fix-brief.md` — your contract: the signed-off fix shape, the
   regression-test duties, the verification list, and the Gate C presentation you owe Jeremy.

Hard rules:
- The regression test (already written, untracked:
  `src/shared/lib/container/subagent-automated-tools.repro.test.ts`) must be observed red before
  the fix and green after. Rename it per the brief.
- Smallest fix: 1 source file (`message-persister.ts`) + 1 test file. >5 source files = stop.
- Edits stay in the diagnosed code path. Flag adjacent bugs; do not fix them.
- No `git add` / commit until Jeremy explicitly says go (Cursor review hold).
- Verify per the brief: targeted vitest red→green, container-suite vitest, typecheck + lint.
  Never `npm build`.
- Finish by presenting Gate C exactly as the brief describes: actual flow first, then diff,
  red→green evidence, footprint delta, sibling table — one batched go/revise/stop ask.
