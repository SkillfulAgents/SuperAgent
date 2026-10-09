// Shared by all start paths, including actors retained by queued tasks. A gate
// remains closed throughout deletion/shutdown, not just the container stop.
const deleting = new Set<string>()
let shutdown = false

export function assertAgentCanStart(slug: string): void {
  if (shutdown) throw new Error('Cannot start an agent while the app is shutting down')
  if (deleting.has(slug)) throw new Error(`Cannot start agent ${slug} while it is being deleted`)
}

export async function withAgentDeletion<T>(slug: string, remove: () => Promise<T>): Promise<T> {
  if (deleting.has(slug)) throw new Error(`Agent ${slug} is already being deleted`)
  deleting.add(slug)
  try { return await remove() }
  finally { deleting.delete(slug) }
}

export function blockStartsForShutdown(): () => void {
  if (shutdown) throw new Error('Shutdown is already in progress')
  shutdown = true
  return () => { shutdown = false }
}
