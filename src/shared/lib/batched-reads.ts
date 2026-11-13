/**
 * The reads a page starts together when it opens an agent, a session or the
 * home screen, which a server can answer in one request
 * (`POST /api/batch-reads`). Each is a GET with a JSON answer that the caller
 * could send by itself; nothing here is readable only through a batch.
 *
 * The page and the server ask this one list, so the page never batches a read
 * the server would refuse. A read that streams, sends bytes, or can be large
 * (a session's messages, a file) stays out and goes by itself.
 */

const ID = '[^/?#]+'

/** Reads of the whole workspace. */
const WORKSPACE_READS = [
  'agents',
  'agent-integrations/providers',
  'firewall/status',
  'home-card-health',
  'llm-connections',
  'llm-connections/legacy-platform/model-availability',
  'notifications/unread-count',
  'platform-auth',
  'platform-notifications/unread-count',
  'runtime-status',
  'settings',
  'settings/models',
  'skillsets',
  'user-settings',
  'voice/configured',
  'volume-definitions',
  'webhook-relay',
]

/** Reads of one agent, under `/api/agents/:id`. The empty one is the agent itself. */
const AGENT_READS = [
  '',
  '/artifacts',
  '/bookmarks',
  '/browser/status',
  '/connected-accounts',
  '/discoverable-skills',
  '/hooks',
  '/llm-connections',
  '/mounts',
  '/pending-requests',
  '/preferences',
  '/remote-mcps',
  '/scheduled-tasks',
  '/scheduled-tasks/completed-sessions',
  '/secrets',
  '/sessions',
  '/skills',
  '/webhook-triggers',
  '/widgets',
]

/** Reads of one session, under `/api/agents/:id/sessions/:id`. The empty one is the session itself. */
const SESSION_READS = ['', '/llm-connections']

const QUERY = '(?:\\?[^#]*)?'

const BATCHABLE_READS = [
  new RegExp(`^/api/(?:${WORKSPACE_READS.join('|')})${QUERY}$`),
  new RegExp(`^/api/agents/${ID}(?:${AGENT_READS.join('|')})${QUERY}$`),
  new RegExp(`^/api/agents/${ID}/sessions/${ID}(?:${SESSION_READS.join('|')})${QUERY}$`),
  new RegExp(`^/api/activity/agents/${ID}${QUERY}$`),
  new RegExp(`^/api/agent-integrations/agents/${ID}(?:/sessions/${ID})?${QUERY}$`),
]

/** How many reads one batch request may carry. */
export const MAX_BATCHED_READS = 50

/** One read's answer, as its own route gave it: a line of the batch's response, written when the read finishes. */
export interface BatchedReadAnswer {
  /** The read's place in the request's `paths`. */
  index: number
  status: number
  contentType: string | null
  body: string
}

/**
 * Whether `path` (with its query) is one of the reads. A path that names
 * another route once normalized (`..`) is not the read it claims to be.
 */
export function isBatchableRead(path: string): boolean {
  if (!BATCHABLE_READS.some((read) => read.test(path))) return false
  const url = new URL(path, 'http://batch.invalid')
  return url.pathname + url.search === path
}
