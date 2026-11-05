/**
 * Seed a local auth-mode instance with teammates, @mentions and threads, for
 * working on the thread UI. Run it against the `threads-mock` server in
 * .claude/launch.json (auth mode + the mock agent container):
 *
 *   npx tsx scripts/seed-threads-mock.ts [baseUrl]
 *
 * Everything goes through the HTTP API as each person, so mentions,
 * notifications and threads are exactly what the app itself would write.
 * These are throwaway local test accounts; the password below is test-only.
 * To start over, stop the server, delete its data dir and start it again.
 */
import { appendMentions, type Mention } from '../src/shared/lib/utils/mentions'

const BASE = process.argv[2] ?? 'http://localhost:47898'
const PASSWORD = 'ThreadsMock123!'

interface Person { key: string; name: string; email: string; id: string; token: string }

const PEOPLE = [
  { key: 'west', name: 'West Askew' },
  { key: 'graham', name: 'Graham Lee' },
  { key: 'iddo', name: 'Iddo Gino' },
  { key: 'maya', name: 'Maya Patel' },
  { key: 'sam', name: 'Sam Ortiz' },
] as const
type Key = (typeof PEOPLE)[number]['key']

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function call<T>(who: Person | null, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      origin: BASE,
      ...(who ? { authorization: `Bearer ${who.token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${await response.text()}`)
  const text = await response.text()
  if (!text) return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`${method} ${path} → not JSON: ${text.slice(0, 200)}`)
  }
}

async function signIn(key: string, name: string): Promise<Person> {
  const email = `${key}@threads.test`
  let result: { token: string; user: { id: string } }
  try {
    result = await call(null, 'POST', '/api/auth/sign-up/email', { name, email, password: PASSWORD })
  } catch {
    result = await call(null, 'POST', '/api/auth/sign-in/email', { email, password: PASSWORD })
  }
  const person = { key, name, email, id: result.user.id, token: result.token }
  await call(person, 'PUT', '/api/user-settings', { setupCompleted: true })
  return person
}

const people = {} as Record<Key, Person>

function tag(...keys: Key[]): Mention[] {
  return keys.map((key) => ({ kind: 'user', id: people[key].id, name: people[key].name, email: people[key].email }))
}

/** A message as the composer writes it: `@Name` where each chip stood, then the mentions block. */
function compose(text: string, tagged: Mention[]): string {
  return appendMentions(text, tagged, { silent: tagged.length > 0 && text.startsWith(`@${tagged[0].name}`) })
}

async function say(slug: string, sessionId: string, who: Key, text: string, tagged: Mention[] = []): Promise<string> {
  const sent = await call<{ uuid: string }>(people[who], 'POST', `/api/agents/${slug}/sessions/${sessionId}/messages`, {
    content: compose(text, tagged),
  })
  // A message that runs the agent: let the mock turn finish before the next one.
  await sleep(tagged.length > 0 && text.startsWith('@') ? 400 : 2500)
  return sent.uuid
}

async function reply(slug: string, sessionId: string, parent: string, who: Key, text: string, tagged: Mention[] = []) {
  await call(people[who], 'POST', `/api/agents/${slug}/sessions/${sessionId}/threads/${parent}/replies`, {
    text,
    taggedUserIds: tagged.map((mention) => (mention.kind === 'user' ? mention.id : '')).filter(Boolean),
  })
  await sleep(150)
}

async function main() {
  for (const { key, name } of PEOPLE) people[key] = await signIn(key, name)
  const { west } = people

  const existing = await call<Array<{ slug: string; name: string }>>(west, 'GET', '/api/agents')
  if (existing.some((agent) => agent.name === 'Launch Planner')) {
    console.log('Already seeded. Delete the data dir and restart the server to start over.')
    return printLogins()
  }

  const agent = await call<{ slug: string }>(west, 'POST', '/api/agents', { name: 'Launch Planner' })
  const slug = agent.slug
  for (const key of ['graham', 'iddo', 'maya'] as const) {
    await call(west, 'POST', `/api/agents/${slug}/access`, { userId: people[key].id, role: 'user' })
  }
  await call(west, 'POST', `/api/agents/${slug}/access`, { userId: people.sam.id, role: 'viewer' })

  // ── Session 1: a busy launch plan ──────────────────────────────────────────
  const launch = await call<{ id: string }>(west, 'POST', `/api/agents/${slug}/sessions`, { message: 'Draft the Q4 launch plan for shared agents' })
  await sleep(3000)

  // A long thread with three people, markdown and a late joiner.
  const pricing = await say(slug, launch.id, 'west', `@${people.graham.name} can you sanity-check the pricing section before I send it to finance?`, tag('graham'))
  await reply(slug, launch.id, pricing, 'graham', 'Looking now 👀')
  await reply(slug, launch.id, pricing, 'graham', 'Annual price is off by $10: it says **$290** but the sheet has **$280**. Also the Team tier is missing the seat minimum.', tag('west'))
  await reply(slug, launch.id, pricing, 'west', 'Good catch. Which sheet are you on? I have `pricing-v3.xlsx`.')
  await reply(slug, launch.id, pricing, 'iddo', 'Jumping in: v4 is the right one, finance signed off on $280. I would also spell out the discount:\n\n- Monthly: $29 / seat\n- Annual: $280 / seat (save ~20%)\n- Team: 3 seat minimum')
  await reply(slug, launch.id, pricing, 'graham', 'Agree with Iddo. Want me to update the doc or will you?')
  await reply(slug, launch.id, pricing, 'west', 'I will, updating now. Thanks both!')

  // A mention mid-message: the agent runs, and the thread is short.
  const subject = await say(slug, launch.id, 'graham', `Draft the launch email, then have @${people.west.name} and @${people.maya.name} pick the subject line`, tag('west', 'maya'))
  await reply(slug, launch.id, subject, 'maya', 'Two I like:\n\n1. "Meet your new teammate"\n2. "Your agents, now shared"')
  await reply(slug, launch.id, subject, 'west', 'Second one 👍')

  // No replies yet: the hover "Reply in thread" state.
  await say(slug, launch.id, 'iddo', `@${people.west.name} the deploy checklist is in the drive, can you take a look when you get a chance?`, tag('west'))

  // Long text, for wrapping and code.
  const rollout = await say(
    slug, launch.id, 'maya',
    `@${people.graham.name} @${people.iddo.name} before we flip the flag on Monday I want us to agree on the rollout order. My proposal is internal first for two days, then the design partners, then everyone on the waitlist in batches of 500 so support is not flooded. Does that match what you both had in mind, or should the partners go first?`,
    tag('graham', 'iddo'),
  )
  await reply(slug, launch.id, rollout, 'graham', 'Mostly yes. One worry: the batches of 500 assume the invite job keeps up. Last time it fell behind around 300 a minute, so I would throttle it explicitly rather than trusting the queue:\n\n```ts\nawait inviteBatch(waitlist.slice(0, 500), { perMinute: 200 })\n```\n\nOtherwise, partners second is right: they are the ones who will actually find the rough edges.')
  await reply(slug, launch.id, rollout, 'iddo', 'Same. I can own the throttle change.')
  await reply(slug, launch.id, rollout, 'maya', 'Great, writing it up as the plan of record.')

  // ── Session 2: a quieter one, with a viewer tagged ─────────────────────────
  const hiring = await call<{ id: string }>(west, 'POST', `/api/agents/${slug}/sessions`, { message: 'Summarize the candidate notes for the design role' })
  await sleep(3000)
  const notes = await say(slug, hiring.id, 'west', `@${people.sam.name} can you add your notes from Friday's interview?`, tag('sam'))
  await reply(slug, hiring.id, notes, 'graham', 'Sam can only view this agent, so they cannot reply here. I will grab the notes from them.')

  console.log(`\nSeeded "Launch Planner" with two sessions:`)
  console.log(`  ${BASE}/agents/${slug}/sessions/${launch.id}`)
  console.log(`  ${BASE}/agents/${slug}/sessions/${hiring.id}`)
  printLogins()
}

function printLogins() {
  console.log(`\nLogins (password for all: ${PASSWORD}):`)
  for (const { key, name } of PEOPLE) console.log(`  ${name.padEnd(12)} ${key}@threads.test${key === 'sam' ? '  (viewer)' : ''}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
