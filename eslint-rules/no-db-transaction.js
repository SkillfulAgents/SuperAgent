/**
 * No interactive transactions.
 *
 * The app's database access has to run on drivers that offer only a batch of
 * statements (Cloudflare D1, Durable Object SQLite), so `db.transaction(` is
 * an error outside the database package. Pure multi-statement writes go
 * through `batch()` from `@shared/lib/db/batch`; read-then-decide logic is one
 * conditional statement checked with `changesOf()`. The database package
 * itself (`src/shared/lib/db/`) is exempt: the batch helper's better-sqlite3
 * implementation is a transaction.
 *
 * Existing offenders are listed in `no-db-transaction-allowlist.json` as
 * `{ "<repo-relative file>": <number of calls> }`. The list only shrinks: a
 * file with more calls than its entry is an error, and a file with fewer is
 * also an error (lower or remove the entry), so the count is exact. Test files
 * and `e2e/` are exempted in `.eslintrc.json` because they mock the handle.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
const fs = require('fs')
const path = require('path')

const REPO_ROOT = path.resolve(__dirname, '..')
const ALLOWLIST_PATH = path.join(__dirname, 'no-db-transaction-allowlist.json')
const DATABASE_PACKAGE_PREFIX = 'src/shared/lib/db/'

// Identifiers a drizzle handle is bound to: the app singleton and a nested
// transaction handle, which is the same primitive one level down.
const HANDLE_NAMES = new Set(['db', 'tx'])

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
        'db.transaction is not available on every driver; use batch() from @shared/lib/db/batch for multi-statement writes and a conditional statement checked with changesOf() for read-then-decide logic',
    },
    schema: [],
    messages: {
      transaction:
        "Interactive transaction: use batch() from '@shared/lib/db/batch' for a multi-statement write, or one conditional statement checked with changesOf(). The allowlist in eslint-rules/no-db-transaction-allowlist.json only shrinks.",
      stale:
        'Stale allowlist entry for this file in eslint-rules/no-db-transaction-allowlist.json: it allows {{allowed}} db.transaction call(s) but the file has {{found}}. Lower or remove the entry.',
    },
  },

  create(context) {
    const absFilename = context.filename || context.getFilename()
    const filename = toPosix(path.relative(REPO_ROOT, absFilename))
    if (filename.startsWith(DATABASE_PACKAGE_PREFIX)) return {}

    const allowed = allowlist[filename] || 0
    const calls = []

    return {
      CallExpression(node) {
        const callee = node.callee
        if (callee.type !== 'MemberExpression' || callee.computed) return
        if (callee.property.type !== 'Identifier' || callee.property.name !== 'transaction') return
        if (callee.object.type !== 'Identifier' || !HANDLE_NAMES.has(callee.object.name)) return
        calls.push(node)
      },
      'Program:exit'(node) {
        if (calls.length > allowed) {
          for (const call of calls.slice(allowed)) context.report({ node: call, messageId: 'transaction' })
        } else if (calls.length < allowed) {
          context.report({ node, messageId: 'stale', data: { allowed, found: calls.length } })
        }
      },
    }
  },
}
