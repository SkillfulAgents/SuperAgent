import type { JsonlEntry } from '@shared/lib/types/agent'

/** The tag the CLI wraps a fork's directive in (2.1.302+). */
const FORK_DIRECTIVE_TAG = '<fork-boilerplate>'

function isForkDirective(entry: JsonlEntry): boolean {
  if (entry.type !== 'user') return false
  const content = entry.message.content
  return Array.isArray(content) && content.some(
    (block) => block.type === 'text' && typeof block.text === 'string' && block.text.startsWith(FORK_DIRECTIVE_TAG),
  )
}

/**
 * The entries of a subagent transcript that are the subagent's own work.
 *
 * A fork subagent (Agent `subagent_type: "fork"`) inherits its parent's
 * conversation, and its transcript opens with that inheritance:
 *   - a `fork-context-ref` entry naming the parent session and how much of it
 *     the fork sees;
 *   - a copy of the parent's assistant entry holding the launching Agent call
 *     (same message id and request id as the parent's own);
 *   - a user entry answering that call ("Fork started — processing in
 *     background") and carrying the `<fork-boilerplate>` + "Your directive:"
 *     text.
 * All of it is the parent's, already shown in the parent's transcript; in the
 * fork's own view the copied Agent call renders as the fork launching itself.
 * A later SendMessage run appends ordinary entries after these. Any other
 * subagent's transcript is returned as is.
 */
/** {@link subagentOwnEntries} for a reader that sees the rows one at a time, in file order. */
export class ForkOwnRows {
  private inherited = false
  /** The fork's directive was read: no row before it is the fork's own. */
  ownStart = false

  /** `restart`: the directive, so the rows kept before it were inherited too. */
  classify(entry: JsonlEntry): 'keep' | 'skip' | 'restart' {
    if ((entry as { type: string }).type === 'fork-context-ref') {
      this.inherited = true
      return 'skip'
    }
    if (isForkDirective(entry)) {
      this.inherited = false
      this.ownStart = true
      return 'restart'
    }
    return this.inherited ? 'skip' : 'keep'
  }
}

export function subagentOwnEntries(entries: JsonlEntry[]): JsonlEntry[] {
  const directive = entries.findIndex(isForkDirective)
  if (directive !== -1) return entries.slice(directive + 1)
  // A fork read before its directive is written has nothing of its own yet.
  const isFork = entries.some((entry) => (entry as { type: string }).type === 'fork-context-ref')
  return isFork ? [] : entries
}
