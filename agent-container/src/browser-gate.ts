/**
 * Who may use the browser at the moment. agent-browser commands (the agent's,
 * and the container's own tab queries) run side by side; a saved-session
 * operation (browser-session.ts) runs alone. A capture opens a tab of its
 * own, and agent-browser follows the tabs it discovers: a command run while
 * that tab is open would act on a blank stub page. The operation keeps the
 * daemon on the agent's tab meanwhile (session-routes.ts).
 *
 * An operation waits for the commands under way to finish; a command that
 * starts after it asked waits for it. The live view polls every few seconds,
 * and an operation that waited for a quiet moment might never get one.
 */

let commands = 0
let operation: Promise<void> | null = null
const idle: Array<() => void> = []

/** Run an agent-browser command (CLI or daemon socket), once no session operation is waiting or running. */
export async function browserCommand<T>(work: () => Promise<T>): Promise<T> {
  while (operation) await operation
  commands++
  try {
    return await work()
  } finally {
    commands--
    if (commands === 0) for (const wake of idle.splice(0)) wake()
  }
}

/** Run a saved-session operation alone: no command and no other operation meanwhile. */
export async function browserAlone<T>(work: () => Promise<T>): Promise<T> {
  while (operation) await operation
  let done = () => {}
  operation = new Promise<void>((resolve) => { done = resolve })
  try {
    while (commands > 0) await new Promise<void>((resolve) => idle.push(resolve))
    return await work()
  } finally {
    operation = null
    done()
  }
}
