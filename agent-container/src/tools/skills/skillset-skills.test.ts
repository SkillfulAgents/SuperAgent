import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (name: string, description: string, _schema: unknown, execute: (args: unknown) => Promise<unknown>) => ({ name, description, execute }),
}))

import { installSkillTool, searchSkillsTool } from './skillset-skills'

type ToolResult = { content: Array<{ text: string }>; isError?: boolean }
const run = (toolDef: unknown, args: Record<string, unknown>) =>
  (toolDef as { execute(args: Record<string, unknown>): Promise<ToolResult> }).execute(args)

function stubHost(respond: () => Response) {
  const fetch = vi.fn(async (_url: string, _init: { body: string }) => respond())
  vi.stubGlobal('fetch', fetch)
  return fetch
}
const sentBody = (fetch: ReturnType<typeof stubHost>) => JSON.parse(fetch.mock.calls[0][1].body)

const invoiceParser = {
  skillsetId: 'platform--team--skills',
  skillsetName: 'Team Skills',
  name: 'invoice-parser',
  description: 'Read fields from invoice PDFs',
  version: '1.2.0',
  path: 'skills/invoice-parser/SKILL.md',
}

beforeEach(() => {
  vi.stubEnv('SUPERAGENT_HOST_API_URL', 'https://host/api')
  vi.stubEnv('PROXY_TOKEN', 'token')
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

it('searches through the host with the agent token and prints what install_skill needs', async () => {
  const fetch = stubHost(() => Response.json({ skills: [invoiceParser], total: 1 }))

  const result = await run(searchSkillsTool, { query: 'invoice' })

  expect(fetch).toHaveBeenCalledWith('https://host/api/x-agent/skills/search', expect.objectContaining({
    headers: expect.objectContaining({ Authorization: 'Bearer token' }),
  }))
  expect(sentBody(fetch)).toEqual({ query: 'invoice' })
  expect(result.isError).toBeUndefined()
  expect(result.content[0].text).toContain('- invoice-parser v1.2.0 (skillset: Team Skills) - Read fields from invoice PDFs')
  expect(result.content[0].text).toContain('skillset_id: platform--team--skills, skill_path: skills/invoice-parser/SKILL.md')
})

it('says when the host returned only part of the matches', async () => {
  stubHost(() => Response.json({ skills: [invoiceParser], total: 40 }))

  const result = await run(searchSkillsTool, {})

  expect(result.content[0].text).toContain('Showing 1 of 40 skills')
})

it('tells an empty search apart from a failed one', async () => {
  stubHost(() => Response.json({ skills: [], total: 0 }))
  const empty = await run(searchSkillsTool, { query: 'calendar' })
  expect(empty.isError).toBeUndefined()
  expect(empty.content[0].text).toContain('No skill in the connected skillsets matches "calendar"')

  stubHost(() => Response.json({ error: 'Unauthorized' }, { status: 401 }))
  expect(await run(searchSkillsTool, { query: 'calendar' })).toMatchObject({
    isError: true,
    content: [{ text: 'Failed to search skills: Unauthorized' }],
  })
})

it('installs by skillset id and path and points the agent at the installed SKILL.md', async () => {
  const fetch = stubHost(() => Response.json({ name: 'invoice-parser', directory: 'invoice-parser' }))

  const result = await run(installSkillTool, { skillset_id: invoiceParser.skillsetId, skill_path: invoiceParser.path })

  expect(fetch.mock.calls[0][0]).toBe('https://host/api/x-agent/skills/install')
  expect(sentBody(fetch)).toEqual({ skillsetId: 'platform--team--skills', skillPath: 'skills/invoice-parser/SKILL.md' })
  expect(result.content[0].text).toBe('Installed "invoice-parser". Read /workspace/.claude/skills/invoice-parser/SKILL.md and follow it.')
})

it('reports why the host refused an install', async () => {
  stubHost(() => Response.json({ error: 'No such skill to install' }, { status: 404 }))

  expect(await run(installSkillTool, { skillset_id: 'gone', skill_path: 'skills/gone/SKILL.md' })).toMatchObject({
    isError: true,
    content: [{ text: 'Failed to install skill: No such skill to install' }],
  })
})
