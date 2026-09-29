import { useSyncExternalStore } from 'react'
import {
  todoBoardSchema,
  type TodoAgentRef,
  type TodoAttachment,
  type TodoAttentionReason,
  type TodoBoard,
  type TodoCard,
  type TodoColumn,
  type TodoQuestion,
} from './todo-schema'

/**
 * Prototype board state: a module-level store persisted to localStorage so the
 * board survives a reload while nothing real backs it yet. Everything that
 * would later become an API call is a named action here.
 */
const STORAGE_KEY = 'superagent.todo-board.v1'

const now = () => Date.now()
// Stand-in for the session an agent would open for the task.
const mockSessionId = () => `todo-${Math.random().toString(36).slice(2, 10)}`
const minutes = (n: number) => n * 60_000

/**
 * Bump when the sample changes: a stored board from an older sample is
 * replaced on load so the showcase scenarios are always the current ones.
 */
const SEED_VERSION = 6

/**
 * The sample data. One item per scenario the space has to show:
 *   - kinds: one-off tasks, recurring jobs (running, idle, and a run to
 *     review), and a conversation
 *   - drafts: a plain one, and one with a file attached
 *   - attention: a single-choice question, a multi-question ask with a
 *     multi-select, a freeform question, output to review, and two
 *     one-click asks (a permission, a reconnect) resolved on the card
 *   - working: a solo agent, and a pair
 *   - done and archive
 */
function seedBoard(): TodoBoard {
  const t = now()
  const card = (
    partial: Pick<TodoCard, 'title' | 'prompt' | 'column'> &
      Partial<Pick<TodoCard, 'agents' | 'attentionReason' | 'lastUpdate' | 'attachments' | 'titleIsGenerated' | 'questions' | 'request' | 'simStep' | 'source' | 'schedule'>>,
    ageMin: number,
  ): TodoCard => ({
    id: crypto.randomUUID(),
    titleIsGenerated: true,
    source: 'task',
    agents: [],
    attachments: [],
    simStep: 0,
    createdAt: t - minutes(ageMin),
    updatedAt: t - minutes(Math.min(ageMin, 7)),
    ...partial,
  })
  return {
    version: 1,
    seedVersion: SEED_VERSION,
    cards: [
      // ── Drafts ──────────────────────────────────────────────────────────
      card({
        title: 'Summarize last week’s customer calls',
        prompt: 'Go through the Granola notes from last week’s customer calls and pull out the top recurring feature requests.\n\n- Group by theme\n- Note which customers asked\n- Rank by how often it came up',
        column: 'drafts',
      }, 25),
      card({
        title: 'Draft the Q4 onboarding email sequence',
        prompt: 'Three emails: **welcome**, **first-week tips**, and a **check-in at day 14**. Friendly, short, no marketing fluff. Use the tone from our existing docs.',
        column: 'drafts',
        attachments: [{ id: crypto.randomUUID(), name: 'brand-voice.md', size: 4_210, kind: 'file' }],
      }, 90),

      // ── Needs Attention ─────────────────────────────────────────────────
      // A single-choice question: the session question card, one question.
      card({
        title: 'Competitor pricing comparison',
        prompt: 'Compare our pricing page with Linear, Notion and Height. Table with tiers, seat pricing, and what’s gated. Flag anything where we look expensive.',
        column: 'attention',
        agents: [{ slug: 'research-agent', name: 'Research Agent', sessionId: mockSessionId() }],
        attentionReason: 'question',
        lastUpdate: 'I have the tiers and seat prices for all four. One thing to settle before I rank them:',
        questions: [{
          question: 'How should annual-billing discounts be handled?',
          header: 'Pricing',
          options: [
            { label: 'List price only', description: 'Compare monthly list prices; ignore annual discounts.' },
            { label: 'Include annual discounts', description: 'Show both monthly and discounted annual pricing.' },
            { label: 'Annual only', description: 'Assume everyone pays annually.' },
          ],
        }],
        simStep: 1,
      }, 40),
      // Several questions in one ask, including a multi-select.
      card({
        title: 'Plan the launch-week social posts',
        prompt: 'Write a week of launch posts for the new dashboard. One post per day, each with a hook, a one-line benefit, and a link. Keep it in our voice.',
        column: 'attention',
        agents: [{ slug: 'marketing-agent', name: 'Marketing Agent', sessionId: mockSessionId() }],
        attentionReason: 'question',
        lastUpdate: 'Drafted seven hooks. Before I write the full posts, two quick choices:',
        questions: [
          {
            question: 'Which channels should the posts be written for?',
            header: 'Channels',
            multiSelect: true,
            options: [
              { label: 'X', description: 'Short, punchy, one link.' },
              { label: 'LinkedIn', description: 'A little longer, more context.' },
              { label: 'Threads', description: 'Casual, conversational.' },
            ],
          },
          {
            question: 'What should the posts link to?',
            header: 'Destination',
            options: [
              { label: 'Landing page', description: 'The new dashboard page on the site.' },
              { label: 'Blog post', description: 'The launch write-up.' },
              { label: 'Signup', description: 'Straight to the signup flow.' },
            ],
          },
        ],
        simStep: 1,
      }, 65),
      // A freeform question: no choices, so the reply box.
      card({
        title: 'Reconcile March invoices against Stripe',
        prompt: 'Match every March invoice in the shared drive to a Stripe payment. List anything unpaid, partially paid, or paid twice.',
        column: 'attention',
        agents: [{ slug: 'ops-agent', name: 'Ops Agent', sessionId: mockSessionId() }],
        attentionReason: 'question',
        lastUpdate: 'Three invoices (INV-1042, 1057, 1061) have no matching Stripe payment, but each has a bank transfer of the right amount on the statement. Who should I confirm those with, and is there a record of the transfers I should be checking against?',
        simStep: 1,
      }, 20),
      // One-click asks: resolved on the card without opening it.
      card({
        title: 'Publish the docs site',
        prompt: 'Build the docs site from main and publish it. Check every page renders before going live.',
        column: 'attention',
        agents: [{ slug: 'docs-agent', name: 'Docs Agent', sessionId: mockSessionId() }],
        attentionReason: 'action',
        lastUpdate: 'Build is green and every page renders. Ready to publish.',
        request: {
          type: 'script_run',
          scriptType: 'shell',
          explanation: 'Publish the docs site to production',
          script: 'cd ~/code/docs-site && npm run build && npm run deploy -- --prod',
        },
        simStep: 2,
      }, 8),
      card({
        title: 'Sync CRM contacts into the mailing list',
        prompt: 'Pull every contact tagged customer from HubSpot and add them to the launch mailing list. Dedupe on email.',
        column: 'attention',
        agents: [{ slug: 'ops-agent', name: 'Ops Agent', sessionId: mockSessionId() }],
        attentionReason: 'action',
        lastUpdate: 'HubSpot rejected the token. I need the connection refreshed before I can read contacts.',
        request: { type: 'account_reauth', toolkit: 'hubspot', accountStatus: 'expired' },
        simStep: 1,
      }, 15),
      // Output to review.
      card({
        title: 'Fix flaky sidebar drag test',
        prompt: 'The e2e test for dragging agents between folders fails ~1 in 5 runs on CI. Find the race and make it deterministic.',
        column: 'attention',
        agents: [{ slug: 'code-reviewer', name: 'Code Reviewer', sessionId: mockSessionId() }],
        attentionReason: 'review',
        lastUpdate: 'Patch ready. The drop target was measured before layout settled; the test now waits for the sortable to report its rect. 40 green runs in a row locally. PR opened for review.',
        simStep: 2,
      }, 130),

      // A recurring job's run waiting for review.
      card({
        title: 'Daily competitor news roundup',
        prompt: 'Every weekday morning, scan competitor blogs, changelogs and pricing pages and send a short roundup of anything new.',
        column: 'attention',
        source: 'recurring',
        schedule: 'Every weekday at 8:00',
        agents: [{ slug: 'research-agent', name: 'Research Agent', sessionId: mockSessionId() }],
        attentionReason: 'review',
        lastUpdate: 'Today’s roundup is ready: two launches, one pricing change at Height, and a new AI tier at Notion.',
        simStep: 2,
      }, 30),
      // A conversation where the agent needs a freeform answer.
      card({
        title: 'Why did churn spike in August?',
        prompt: 'Why did churn jump in August? Dig into it.',
        column: 'attention',
        source: 'conversation',
        agents: [{ slug: 'analytics-agent', name: 'Analytics Agent', sessionId: mockSessionId() }],
        attentionReason: 'question',
        lastUpdate: 'August churn is up 1.8 points, almost all from annual plans renewing in the first week. Did anything change in billing or renewal emails around then?',
        simStep: 1,
      }, 50),

      // ── Working ─────────────────────────────────────────────────────────
      card({
        title: 'Weekly metrics digest',
        source: 'recurring',
        schedule: 'Every Monday at 9:00',
        prompt: 'Pull signups, activation and retention for the week from Amplitude and write a five-bullet digest for the team channel.',
        column: 'working',
        agents: [{ slug: 'analytics-agent', name: 'Analytics Agent', sessionId: mockSessionId() }],
        lastUpdate: 'Querying Amplitude for the activation cohort…',
      }, 12),
      card({
        title: 'Migrate landing page to new design tokens',
        prompt: 'Replace hard-coded colors on the marketing site with the new token set. Keep light and dark both working; screenshot every page before and after.',
        column: 'working',
        agents: [
          { slug: 'frontend-agent', name: 'Frontend Agent', sessionId: mockSessionId() },
          { slug: 'design-qa', name: 'Design QA', sessionId: mockSessionId() },
        ],
        lastUpdate: 'Swapped tokens on 6 of 11 pages.',
        simStep: 1,
      }, 55),

      // A recurring job idle between runs.
      card({
        title: 'Nightly backup check',
        prompt: 'Every night, confirm last night’s database backups completed and are restorable. Only flag me if something fails.',
        column: 'done',
        source: 'recurring',
        schedule: 'Every day at 2:00',
        agents: [{ slug: 'ops-agent', name: 'Ops Agent', sessionId: mockSessionId() }],
        lastUpdate: 'Last run passed. All three databases backed up and restore-tested.',
      }, 400),

      // ── Done / Archive ──────────────────────────────────────────────────
      card({
        title: 'Rename “Skillset” to “Library” across docs',
        prompt: 'Find every mention of skillset in the docs site and rename to library. Keep redirects for old URLs.',
        column: 'done',
        agents: [{ slug: 'docs-agent', name: 'Docs Agent', sessionId: mockSessionId() }],
        lastUpdate: 'Done — 23 pages updated, 4 redirects added.',
      }, 600),
      card({
        title: 'Set up the status page',
        prompt: 'Stand up a public status page with the API, app and website as components. Hook it to the uptime checks.',
        column: 'archive',
        agents: [{ slug: 'ops-agent', name: 'Ops Agent', sessionId: mockSessionId() }],
        lastUpdate: 'Live at status.gamut.so, checks reporting every minute.',
      }, 4_000),
    ],
  }
}

function loadBoard(): TodoBoard {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const stored = todoBoardSchema.parse(JSON.parse(raw))
      // Prototype: an older sample gives way to the current showcase.
      if (stored.seedVersion === SEED_VERSION) return stored
    }
  } catch {
    // A malformed or outdated board is not worth surfacing in a prototype:
    // fall through to the seed.
  }
  return seedBoard()
}

// Loaded on first use, not at import: the sidebar imports this module for
// everyone, but only people who turned the board on should read or seed it.
let loaded: TodoBoard | null = null
function current(): TodoBoard {
  return (loaded ??= loadBoard())
}
const listeners = new Set<() => void>()

function commit(next: TodoBoard) {
  loaded = next
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Storage may be unavailable (private mode); the in-memory board still works.
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useTodoBoard(): TodoBoard {
  return useSyncExternalStore(subscribe, current)
}

/** The current copy of one card, outside React. */
export function getTodoCard(id: string): TodoCard | undefined {
  return current().cards.find((c) => c.id === id)
}

export function useTodoCard(id: string | null): TodoCard | undefined {
  const current = useTodoBoard()
  return id ? current.cards.find((c) => c.id === id) : undefined
}

function updateCard(id: string, patch: (card: TodoCard) => Partial<TodoCard>) {
  commit({
    ...current(),
    cards: current().cards.map((c) => (c.id === id ? { ...c, ...patch(c), updatedAt: now() } : c)),
  })
}

/**
 * Stand-in for the AI-generated title: the first sentence of the prompt,
 * trimmed to a card-sized line. The real thing would ask a model.
 */
export function deriveTitle(prompt: string): string {
  const firstLine = prompt
    .split(/\n/)
    .map((l) => l.replace(/^[#>*\-\s]+/, '').trim())
    .find((l) => l.length > 0)
  if (!firstLine) return 'Untitled task'
  const sentence = firstLine.split(/(?<=[.!?])\s/)[0]
  const words = sentence.split(/\s+/)
  let out = ''
  for (const word of words) {
    if ((out + ' ' + word).trim().length > 56) break
    out = (out + ' ' + word).trim()
  }
  if (!out) out = sentence.slice(0, 56)
  out = out.replace(/[.,;:]+$/, '')
  return out.charAt(0).toUpperCase() + out.slice(1)
}

export const todoActions = {
  createDraft(prompt: string, attachments: TodoAttachment[] = []): TodoCard {
    const t = now()
    const card: TodoCard = {
      id: crypto.randomUUID(),
      title: deriveTitle(prompt),
      titleIsGenerated: true,
      prompt,
      column: 'drafts',
      source: 'task',
      agents: [],
      attachments,
      simStep: 0,
      createdAt: t,
      updatedAt: t,
    }
    commit({ ...current(), cards: [card, ...current().cards] })
    return card
  },

  setPrompt(id: string, prompt: string) {
    updateCard(id, (c) => ({
      prompt,
      // A generated title tracks the prompt until the user types their own.
      title: c.titleIsGenerated ? deriveTitle(prompt) : c.title,
    }))
  },

  setTitle(id: string, title: string) {
    // Clearing the name hands it back to the generator, so the card never
    // ends up blank and an untouched draft can still be discarded.
    updateCard(id, (c) =>
      title.trim() ? { title, titleIsGenerated: false } : { title: deriveTitle(c.prompt), titleIsGenerated: true },
    )
  },

  addAttachments(id: string, attachments: TodoAttachment[]) {
    updateCard(id, (c) => ({ attachments: [...c.attachments, ...attachments] }))
  },

  removeAttachment(id: string, attachmentId: string) {
    updateCard(id, (c) => ({ attachments: c.attachments.filter((a) => a.id !== attachmentId) }))
  },

  assignAgent(id: string, agent: TodoAgentRef) {
    updateCard(id, (c) => ({
      agents: c.agents.some((a) => a.slug === agent.slug) ? c.agents : [...c.agents, agent],
    }))
  },

  unassignAgent(id: string, slug: string) {
    updateCard(id, (c) => ({ agents: c.agents.filter((a) => a.slug !== slug) }))
  },

  /** Drafts → Working. Routes to `agent` when the card has nobody assigned;
   *  every agent on the card gets a session to run it in. */
  start(id: string, agent?: TodoAgentRef, schedule?: string) {
    updateCard(id, (c) => ({
      column: 'working',
      attentionReason: undefined,
      agents: (c.agents.length > 0 || !agent ? c.agents : [agent]).map((a) => ({ ...a, sessionId: a.sessionId ?? mockSessionId() })),
      // A schedule makes it a recurring job; its first run starts now.
      ...(schedule ? { source: 'recurring' as const, schedule } : {}),
      lastUpdate: 'Starting…',
    }))
  },

  /** Stop a running item. It goes back to Drafts so it can be edited and restarted. */
  stop(id: string) {
    updateCard(id, () => ({
      column: 'drafts',
      attentionReason: undefined,
      questions: undefined,
      request: undefined,
      lastUpdate: 'Stopped by you.',
    }))
  },

  /** Needs Attention → Working, after the user answered or reviewed. */
  resume(id: string, reply?: string) {
    updateCard(id, () => ({
      column: 'working',
      attentionReason: undefined,
      questions: undefined,
      request: undefined,
      lastUpdate: reply ? `You: ${reply}` : 'Resuming…',
    }))
  },

  /** A one-click request answered from the card: the agent carries on either way. */
  resolveRequest(id: string, outcome: string) {
    updateCard(id, () => ({
      column: 'working',
      attentionReason: undefined,
      request: undefined,
      lastUpdate: `You: ${outcome}`,
    }))
  },

  /** Working → Needs Attention, raised by the agent. `questions` makes it a structured ask. */
  requestAttention(id: string, reason: TodoAttentionReason, message: string, questions?: TodoQuestion[]) {
    updateCard(id, (c) => ({
      column: 'attention',
      attentionReason: reason,
      lastUpdate: message,
      questions,
      simStep: c.simStep + 1,
    }))
  },

  markDone(id: string, message?: string) {
    updateCard(id, (c) => ({
      column: 'done',
      attentionReason: undefined,
      lastUpdate: message ?? c.lastUpdate,
    }))
  },

  /** Any column → the given column, from a drag. Keeps agent state sensible. */
  move(id: string, column: TodoColumn) {
    updateCard(id, (c) => {
      if (c.column === column) return {}
      return {
        column,
        attentionReason: column === 'attention' ? (c.attentionReason ?? 'review') : undefined,
      }
    })
  },

  progress(id: string, message: string) {
    updateCard(id, () => ({ lastUpdate: message }))
  },

  remove(id: string) {
    commit({ ...current(), cards: current().cards.filter((c) => c.id !== id) })
  },

  /** Drop a draft the user opened and walked away from without writing anything. */
  discardIfEmpty(id: string) {
    const card = current().cards.find((c) => c.id === id)
    if (!card || card.column !== 'drafts') return
    if (card.prompt.trim() || !card.titleIsGenerated || card.attachments.length > 0 || card.agents.length > 0) return
    todoActions.remove(id)
  },

  resetToSeed() {
    commit(seedBoard())
  },
}
