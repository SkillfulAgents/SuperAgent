import { describe, it } from 'vitest'
// eslint ships no bundled types and @types/eslint isn't a dependency; the
// RuleTester runtime API is all we need here.
// @ts-ignore -- no type declarations for 'eslint'
import { RuleTester } from 'eslint'
import rule from '../../../../eslint-rules/no-path-containment-startswith.js'

// Drive ESLint's RuleTester through vitest's test hooks.
RuleTester.describe = describe as unknown as typeof RuleTester.describe
RuleTester.it = it as unknown as typeof RuleTester.it

const ruleTester = new RuleTester({
  parserOptions: { ecmaVersion: 2021, sourceType: 'module' },
})

ruleTester.run('no-path-containment-startswith', rule as unknown as Parameters<RuleTester['run']>[1], {
  valid: [
    // Ordinary string prefix checks — receiver is not a resolved path.
    { code: "url.startsWith('https://')" },
    { code: "name.startsWith('foo')" },
    { code: "req.url.startsWith('/api/')" },
    // Receiver comes from a non-path call.
    { code: "const x = getThing(); x.startsWith(dir)" },
    // The sanctioned replacement uses the helper, no startsWith at all.
    { code: "import { isPathWithinDir } from '@shared/lib/utils/path-safety'; const ok = isPathWithinDir(base, full)" },
    // path.resolve result used for something other than a containment check.
    { code: "const full = path.resolve(base, x); const n = full.length" },
  ],
  invalid: [
    // Inline path.resolve(...).startsWith(...)
    {
      code: "if (path.resolve(base, input).startsWith(base)) {}",
      errors: [{ messageId: 'pathStartsWith' }],
    },
    // Inline path.join(...).startsWith(...)
    {
      code: "const ok = path.join(base, input).startsWith(base)",
      errors: [{ messageId: 'pathStartsWith' }],
    },
    // Stored-variable form (the SUP-200 / skillset / agent-template shape).
    {
      code: "const full = path.resolve(workspaceDir, filePath); if (!full.startsWith(workspaceDir)) { throw new Error('no') }",
      errors: [{ messageId: 'pathStartsWith' }],
    },
    // Stored var inside a function scope.
    {
      code: "function f(a, b) { const p = path.resolve(a, b); return p.startsWith(a) }",
      errors: [{ messageId: 'pathStartsWith' }],
    },
    // Even the trailing-separator 'safe' form is discouraged — steer to the helper.
    {
      code: "const dest = path.resolve(dir, name); if (dest.startsWith(dir + path.sep)) {}",
      errors: [{ messageId: 'pathStartsWith' }],
    },
  ],
})
