/**
 * Every drizzle terminator is awaited.
 *
 * The app's database access has to run on an asynchronous driver, where
 * `.all()`, `.get()` and `.run()` return Promises. On better-sqlite3 they
 * return the rows, so a call that is not awaited works on the desktop and
 * silently breaks elsewhere: `rows.length` on a Promise is `undefined`, and
 * `if (row)` on a Promise is always true. A terminator on a drizzle chain
 * is therefore an error unless it is the operand of `await`, is returned
 * from an `async` function, is an element of an awaited `Promise.all`-style
 * array, or has `.then()` chained on it.
 *
 * A chain is recognised by its root: the handle (`db`, `tx`, `this.db`,
 * `getDb()`) or a builder helper (`insertWhere()`). A chain stored in a
 * variable first is not seen, which the allowlist counts tolerate in one
 * direction only. The callback of `db.transaction(` is exempt: better-sqlite3
 * throws when a transaction callback returns a Promise, and the only such
 * callback left is the batch helper's.
 *
 * Existing offenders are listed in `no-sync-drizzle-terminator-allowlist.json`
 * as `{ "<repo-relative file>": <number of calls> }`. The list only shrinks:
 * a file with more calls than its entry is an error, and a file with fewer
 * is also an error (lower or remove the entry), so the count is exact. Test
 * files and `e2e/` are exempted in `.eslintrc.json` because they mock the
 * handle.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
const fs = require('fs')
const path = require('path')

const REPO_ROOT = path.resolve(__dirname, '..')
const ALLOWLIST_PATH = path.join(__dirname, 'no-sync-drizzle-terminator-allowlist.json')

const TERMINATORS = new Set(['all', 'get', 'run'])
// Identifiers a drizzle handle is bound to: the app singleton, a nested
// transaction handle, and a handle passed as a parameter under the same name.
const HANDLE_NAMES = new Set(['db', 'tx'])
// Accessors that return the handle.
const HANDLE_ACCESSORS = new Set(['getDb'])
// Helpers that return a drizzle builder the caller terminates.
const BUILDER_HELPERS = new Set(['insertWhere'])
const PROMISE_COMBINATORS = new Set(['all', 'allSettled', 'race', 'any'])
const PROMISE_METHODS = new Set(['then', 'catch', 'finally'])

/** The expression at the root of a member/call chain. */
function chainRoot(node) {
  let current = node
  for (;;) {
    if (current.type === 'CallExpression') current = current.callee
    else if (current.type === 'MemberExpression' && !isThisHandle(current)) current = current.object
    else if (current.type === 'ChainExpression') current = current.expression
    else return current
  }
}

function isThisHandle(node) {
  return (
    node.type === 'MemberExpression' &&
    node.object.type === 'ThisExpression' &&
    !node.computed &&
    node.property.type === 'Identifier' &&
    HANDLE_NAMES.has(node.property.name)
  )
}

function isDrizzleChain(node) {
  const root = chainRoot(node)
  if (root.type === 'Identifier') return HANDLE_NAMES.has(root.name)
  if (isThisHandle(root)) return true
  return false
}

/** `db.select()…` and `getDb().select()…` and `insertWhere(…)…` all count. */
function isDrizzleTerminator(node) {
  const callee = node.callee
  if (callee.type !== 'MemberExpression' || callee.computed) return false
  if (callee.property.type !== 'Identifier' || !TERMINATORS.has(callee.property.name)) return false
  const object = callee.object
  if (isDrizzleChain(object)) return true
  // The root of the chain is a call: an accessor or a builder helper.
  let current = object
  while (current.type === 'MemberExpression' || current.type === 'CallExpression') {
    if (
      current.type === 'CallExpression' &&
      current.callee.type === 'Identifier' &&
      (HANDLE_ACCESSORS.has(current.callee.name) || BUILDER_HELPERS.has(current.callee.name))
    ) {
      return true
    }
    current = current.type === 'CallExpression' ? current.callee : current.object
  }
  return false
}

function isFunction(node) {
  return (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression'
  )
}

function enclosingFunction(node) {
  let current = node.parent
  while (current && !isFunction(current)) current = current.parent
  return current
}

/** Inside the callback of `db.transaction(…)`, which stays synchronous. */
function isInsideTransactionCallback(node) {
  let current = node
  while (current) {
    if (isFunction(current)) {
      const parent = current.parent
      if (
        parent &&
        parent.type === 'CallExpression' &&
        parent.arguments.includes(current) &&
        parent.callee.type === 'MemberExpression' &&
        !parent.callee.computed &&
        parent.callee.property.type === 'Identifier' &&
        parent.callee.property.name === 'transaction'
      ) {
        return true
      }
    }
    current = current.parent
  }
  return false
}

/** Skip the parentheses and type assertions that wrap an expression. */
function outerExpression(node) {
  let current = node
  while (
    current.parent &&
    (current.parent.type === 'TSAsExpression' ||
      current.parent.type === 'TSNonNullExpression' ||
      current.parent.type === 'TSTypeAssertion' ||
      current.parent.type === 'TSSatisfiesExpression')
  ) {
    current = current.parent
  }
  return current
}

function isAwaited(node) {
  const expression = outerExpression(node)
  const parent = expression.parent
  if (!parent) return false
  if (parent.type === 'AwaitExpression') return true
  if (parent.type === 'ReturnStatement') {
    const fn = enclosingFunction(parent)
    return Boolean(fn && fn.async)
  }
  if (parent.type === 'ArrowFunctionExpression' && parent.body === expression) return parent.async
  if (
    parent.type === 'ArrayExpression' &&
    parent.parent &&
    parent.parent.type === 'CallExpression' &&
    parent.parent.callee.type === 'MemberExpression' &&
    parent.parent.callee.object.type === 'Identifier' &&
    parent.parent.callee.object.name === 'Promise' &&
    parent.parent.callee.property.type === 'Identifier' &&
    PROMISE_COMBINATORS.has(parent.parent.callee.property.name)
  ) {
    return true
  }
  if (
    parent.type === 'MemberExpression' &&
    parent.object === expression &&
    !parent.computed &&
    parent.property.type === 'Identifier' &&
    PROMISE_METHODS.has(parent.property.name)
  ) {
    return true
  }
  return false
}

function toPosix(p) {
  return p.split(path.sep).join('/')
}

function loadAllowlist() {
  const parsed = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${ALLOWLIST_PATH} must be an object of { file: count }`)
  }
  for (const [file, count] of Object.entries(parsed)) {
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`${ALLOWLIST_PATH}: entry for ${file} must be a positive integer, got ${count}`)
    }
  }
  return parsed
}

const allowlist = loadAllowlist()

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'A drizzle .all()/.get()/.run() must be awaited: on an asynchronous driver it returns a Promise, and a guard on the bare value silently passes',
    },
    schema: [],
    messages: {
      sync:
        'Synchronous drizzle terminator: await it, or return it from an async function. On an asynchronous driver this returns a Promise. The allowlist in eslint-rules/no-sync-drizzle-terminator-allowlist.json only shrinks.',
      stale:
        'Stale allowlist entry for this file in eslint-rules/no-sync-drizzle-terminator-allowlist.json: it allows {{allowed}} synchronous terminator(s) but the file has {{found}}. Lower or remove the entry.',
    },
  },

  create(context) {
    const absFilename = context.filename || context.getFilename()
    const filename = toPosix(path.relative(REPO_ROOT, absFilename))
    const allowed = allowlist[filename] || 0
    const calls = []

    return {
      CallExpression(node) {
        if (!isDrizzleTerminator(node)) return
        if (isAwaited(node)) return
        if (isInsideTransactionCallback(node)) return
        calls.push(node)
      },
      'Program:exit'(node) {
        if (calls.length > allowed) {
          for (const call of calls.slice(allowed)) context.report({ node: call, messageId: 'sync' })
        } else if (calls.length < allowed) {
          context.report({ node, messageId: 'stale', data: { allowed, found: calls.length } })
        }
      },
    }
  },
}
