/**
 * The reads a page can send together (`POST /api/batch-reads`), by module: a
 * part of the screen whose reads may show up late as one block. A page's main
 * content is in no module, so each of its reads goes by itself and a slow one
 * holds back nothing else.
 *
 * Each read is a GET with a JSON answer that the caller could send by itself;
 * nothing here is readable only through a batch. The page and the server ask
 * this one list, so the page never batches a read the server would refuse.
 */

const ID = '[^/?#]+'
const QUERY = '(?:\\?[^#]*)?'
const AGENT = `/api/agents/${ID}`

const read = (path: string) => new RegExp(`^${path}${QUERY}$`)

const MODULES = {
  /** The collapsed sections of an agent's page: Triggers, Connections, Skills, External Integrations, Drives, Hooks. */
  'agent-sections': [
    read(`${AGENT}/(?:webhook-triggers|scheduled-tasks|scheduled-tasks/completed-sessions|connected-accounts|remote-mcps|skills|mounts|hooks)`),
    read(`/api/activity/agents/${ID}`),
    read(`/api/agent-integrations/agents/${ID}`),
    read('/api/volume-definitions'),
  ],
  /** What the message box offers beside the text: the model picker and voice input. */
  'composer-options': [
    read('/api/llm-connections'),
    read('/api/llm-connections/legacy-platform/model-availability'),
    read('/api/settings/models'),
    read('/api/voice/configured'),
    read(`${AGENT}/(?:llm-connections|preferences)`),
    read(`${AGENT}/sessions/${ID}/llm-connections`),
  ],
  /** The cards of an agent's page: its bookmarks and widgets. */
  'agent-cards': [
    read(`${AGENT}/(?:bookmarks|widgets)`),
  ],
} satisfies Record<string, RegExp[]>

export type BatchModule = keyof typeof MODULES

/** How many reads one batch request may carry. */
export const MAX_BATCHED_READS = 30

/** One read's answer, as its own route gave it: a line of the batch's response, written when the read finishes. */
export interface BatchedReadAnswer {
  /** The read's place in the request's `paths`. */
  index: number
  status: number
  contentType: string | null
  body: string
}

/**
 * The module `path` (with its query) is a read of, or null for a read that
 * goes by itself. A path that names another route once normalized (`..`) is
 * not the read it claims to be.
 */
export function batchModuleOf(path: string): BatchModule | null {
  const module = (Object.keys(MODULES) as BatchModule[]).find((name) => MODULES[name].some((pattern) => pattern.test(path)))
  if (!module) return null
  const url = new URL(path, 'http://batch.invalid')
  return url.pathname + url.search === path ? module : null
}

/** Whether the server answers `path` in a batch. */
export function isBatchableRead(path: string): boolean {
  return batchModuleOf(path) !== null
}
