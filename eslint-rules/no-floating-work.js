/**
 * Work that nobody awaits goes through `background(work, { name })`.
 *
 * A Promise that is started and then dropped has two problems. A rejection
 * reaches the process's `unhandledRejection` handler, which quits the Electron
 * app; and on Workers, work still running after the response is cancelled
 * unless it is handed to `waitUntil`. `background()` from
 * `src/shared/lib/background.ts` reports the rejection instead and is where the
 * Workers implementation registers the work.
 *
 * Two shapes are errors:
 *
 * - `void <promise>`, anywhere: `void` discards the Promise.
 * - An expression statement whose value is a Promise and that starts work:
 *   its chain begins with a call (`f()`, `x.send()`, `Promise.resolve(f())`,
 *   `import('…')`) or continues with `.then()`. A `.catch()` handler does
 *   not make that work any less dropped: `f().catch(log)` is still an error.
 *
 * Attaching a rejection handler or a cleanup to a promise that already exists
 * is not new work and stays allowed: `pending.catch(() => {})`,
 * `this.check.finally(clear)`. Its owner awaits it or tracks it.
 * `@typescript-eslint/no-floating-promises` still requires those to be
 * handled.
 *
 * Needs type information (`parserOptions.project`): a value is a Promise when
 * its type has a callable `then`.
 *
 * @type {import('eslint').Rule.RuleModule}
 */

const HANDLERS = new Set(['catch', 'finally'])

/** Skip the type assertions and optional-chain wrapper around an expression. */
function unwrap(node) {
  let current = node
  for (;;) {
    if (
      current.type === 'ChainExpression' ||
      current.type === 'TSAsExpression' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'TSTypeAssertion' ||
      current.type === 'TSSatisfiesExpression'
    ) {
      current = current.expression
    } else {
      return current
    }
  }
}

/** `x.<name>(…)`, with `name` returned, or null. */
function promiseMethod(node) {
  if (node.type !== 'CallExpression') return null
  const callee = unwrap(node.callee)
  if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier') return null
  const name = callee.property.name
  return name === 'then' || HANDLERS.has(name) ? { name, object: unwrap(callee.object) } : null
}

/**
 * Whether a promise-valued statement starts work: the chain under its
 * `.then()`/`.catch()`/`.finally()` links begins with anything other than a
 * reference to an existing promise, or one of the links is `.then()`.
 */
function startsWork(node) {
  let current = unwrap(node)
  for (let link = promiseMethod(current); link; link = promiseMethod(current)) {
    if (!HANDLERS.has(link.name)) return true
    current = link.object
  }
  return !(current.type === 'Identifier' || current.type === 'MemberExpression' || current.type === 'ThisExpression')
}

function isThenable(checker, type) {
  if (type.isUnion()) return type.types.some((part) => isThenable(checker, part))
  const then = type.getProperty('then')
  if (!then) return false
  const declaration = then.valueDeclaration || (then.declarations && then.declarations[0])
  if (!declaration) return false
  return checker.getTypeOfSymbolAtLocation(then, declaration).getCallSignatures().length > 0
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Work that nobody awaits goes through background(work, { name }): a dropped Promise crashes Electron on rejection and is cancelled with the response on Workers',
    },
    schema: [],
    messages: {
      void:
        "`void` drops this Promise: a rejection quits the Electron app, and on Workers the work is cancelled with the response. Await it, or start it with background(work, { name }) from '@shared/lib/background'.",
      floating:
        "This starts work that nobody awaits, and on Workers it is cancelled with the response. Await it, or start it with background(work, { name }) from '@shared/lib/background'; keep any .catch() inside the work.",
    },
  },

  create(context) {
    const services = context.sourceCode ? context.sourceCode.parserServices : context.parserServices
    if (!services || !services.program || !services.esTreeNodeToTSNodeMap) {
      throw new Error('local-rules/no-floating-work needs type information: set parserOptions.project')
    }
    const checker = services.program.getTypeChecker()
    const typeOf = (node) => checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node))

    return {
      'UnaryExpression[operator="void"]'(node) {
        if (isThenable(checker, typeOf(node.argument))) context.report({ node, messageId: 'void' })
      },
      ExpressionStatement(node) {
        const expression = unwrap(node.expression)
        if (
          expression.type === 'AssignmentExpression' ||
          expression.type === 'AwaitExpression' ||
          expression.type === 'UnaryExpression' ||
          expression.type === 'Literal'
        ) {
          return
        }
        if (!startsWork(expression)) return
        if (isThenable(checker, typeOf(node.expression))) context.report({ node, messageId: 'floating' })
      },
    }
  },
}
