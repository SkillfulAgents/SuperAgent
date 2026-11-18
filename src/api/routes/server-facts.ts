import { Hono } from 'hono'
import { getServerFacts } from '@shared/lib/facts/server-facts'

const serverFacts = new Hono()

// GET /api/server-facts - the facts the web build inlines into its HTML, for a
// desktop app driving this server as a cloud workspace (its renderer loads its
// own HTML). Public like that HTML: see serverFactsSchema.
serverFacts.get('/', (c) => c.json(getServerFacts()))

export default serverFacts
