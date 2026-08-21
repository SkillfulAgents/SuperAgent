import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import fs from 'fs'
import os from 'os'
import path from 'path'

const mockValidateProxyToken = vi.fn()

vi.mock('@shared/lib/proxy/token-store', () => ({
  validateProxyToken: (...args: unknown[]) => mockValidateProxyToken(...args),
}))

import { clearSettingsCache, getSettings, updateSettings } from '@shared/lib/config/settings'
import { PAGE_BODY_MAX_BYTES } from '@shared/lib/types/brain-schema'
import brainAgent from './brain-agent'

function app() {
  const hono = new Hono()
  hono.route('/api/brain/agent', brainAgent)
  return hono
}

function post(body: unknown, token = 'good') {
  return app().request('http://localhost/api/brain/agent/read', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/brain/agent/read', () => {
  const prevDataDir = process.env.SUPERAGENT_DATA_DIR
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-brain-route-'))
    process.env.SUPERAGENT_DATA_DIR = tmp
    clearSettingsCache()
    updateSettings({ ...getSettings(), teamBrain: true })
    mockValidateProxyToken.mockReset().mockResolvedValue('sales-bot')
  })

  afterEach(() => {
    clearSettingsCache()
    fs.rmSync(tmp, { recursive: true, force: true })
    if (prevDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
    else process.env.SUPERAGENT_DATA_DIR = prevDataDir
  })

  it('401 without a valid agent token', async () => {
    mockValidateProxyToken.mockResolvedValue(null)
    const res = await post({ name: 'INDEX.md' })
    expect(res.status).toBe(401)
  })

  it('400 on an invalid page name', async () => {
    const res = await post({ name: '../secret' })
    expect(res.status).toBe(400)
  })

  it('returns INDEX.md for any agent', async () => {
    const res = await post({ name: 'INDEX.md' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.found).toBe(true)
    expect(body.name).toBe('INDEX.md')
    expect(body.description).toBe('Team Brain')
    expect(body.body).toMatch(/Curator-owned catalog/)
  })

  it('returns not found for a missing page', async () => {
    const res = await post({ name: 'missing-page' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ found: false, suggestions: [] })
  })

  it('413s a page over the byte cap', async () => {
    const dir = path.join(tmp, 'brain')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'huge.md'), 'x'.repeat(PAGE_BODY_MAX_BYTES + 1))
    const res = await post({ name: 'huge' })
    expect(res.status).toBe(413)
  })

  it('404s when Team Brain is off', async () => {
    updateSettings({ ...getSettings(), teamBrain: false })
    const res = await post({ name: 'INDEX.md' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Team Brain is off' })
  })
})

describe('GET /api/brain/agent/curator', () => {
  const prevDataDir = process.env.SUPERAGENT_DATA_DIR
  let tmp: string

  function getCurator() {
    return app().request('http://localhost/api/brain/agent/curator', {
      headers: { Authorization: 'Bearer good' },
    })
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-brain-curator-lookup-'))
    process.env.SUPERAGENT_DATA_DIR = tmp
    clearSettingsCache()
    updateSettings({ ...getSettings(), teamBrain: true })
    mockValidateProxyToken.mockReset().mockResolvedValue('sales-bot')
  })

  afterEach(() => {
    clearSettingsCache()
    fs.rmSync(tmp, { recursive: true, force: true })
    if (prevDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
    else process.env.SUPERAGENT_DATA_DIR = prevDataDir
  })

  it('returns the curator slug', async () => {
    expect(await (await getCurator()).json()).toEqual({ agentSlug: null })
    fs.mkdirSync(path.join(tmp, 'brain'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'brain', 'CURATOR'), 'curator-bot')
    expect(await (await getCurator()).json()).toEqual({ agentSlug: 'curator-bot' })
  })

  it('404s when Team Brain is off', async () => {
    updateSettings({ ...getSettings(), teamBrain: false })
    const res = await getCurator()
    expect(res.status).toBe(404)
  })
})

describe('POST /api/brain/agent/write', () => {
  const prevDataDir = process.env.SUPERAGENT_DATA_DIR
  let tmp: string

  function write(body: unknown, token = 'good') {
    return app().request('http://localhost/api/brain/agent/write', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-brain-write-route-'))
    process.env.SUPERAGENT_DATA_DIR = tmp
    clearSettingsCache()
    updateSettings({ ...getSettings(), teamBrain: true })
    mockValidateProxyToken.mockReset().mockResolvedValue('sales-bot')
  })

  afterEach(() => {
    clearSettingsCache()
    fs.rmSync(tmp, { recursive: true, force: true })
    if (prevDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
    else process.env.SUPERAGENT_DATA_DIR = prevDataDir
  })

  function setCurator(slug: string) {
    fs.mkdirSync(path.join(tmp, 'brain'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'brain', 'CURATOR'), slug)
  }

  it('fails with no curator', async () => {
    const res = await write({ name: 'pricing-decisions', body: '# Why\n' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'No curator' })
  })

  it('persists a curator write and refuses INDEX.md delete', async () => {
    setCurator('sales-bot')
    const wrote = await write({ name: 'pricing-decisions', body: '# Why\n' })
    expect(wrote.status).toBe(200)
    const wroteBody = await wrote.json()
    expect(wroteBody.status).toBe('wrote')
    expect(wroteBody.name).toBe('pricing-decisions.md')
    expect(wroteBody.updatedAt).toEqual(expect.any(String))
    expect(fs.readFileSync(path.join(tmp, 'brain', 'pricing-decisions.md'), 'utf8')).toBe('# Why\n')

    const denied = await write({ name: 'INDEX.md', delete: true })
    expect(denied.status).toBe(400)
    expect(await denied.json()).toEqual({ error: 'INDEX.md cannot be deleted' })
    expect(fs.existsSync(path.join(tmp, 'brain', 'INDEX.md'))).toBe(true)
  })

  it('refuses a non-curator persist', async () => {
    setCurator('curator-bot')
    const res = await write({ name: 'pricing-decisions', body: '# sneak\n' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Only the curator can persist' })
    expect(fs.existsSync(path.join(tmp, 'brain', 'pricing-decisions.md'))).toBe(false)
  })

  it('401 without a valid agent token', async () => {
    mockValidateProxyToken.mockResolvedValue(null)
    const res = await write({ name: 'pricing-decisions', body: '# Why\n' })
    expect(res.status).toBe(401)
  })

  it('lets the curator delete a page and 404s a miss', async () => {
    setCurator('sales-bot')
    expect((await write({ name: 'scratch', body: 'tmp' })).status).toBe(200)

    const deleted = await write({ name: 'scratch', delete: true })
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toEqual({ status: 'deleted', name: 'scratch.md' })
    expect(fs.existsSync(path.join(tmp, 'brain', 'scratch.md'))).toBe(false)

    const miss = await write({ name: 'scratch', delete: true })
    expect(miss.status).toBe(404)

    const unnamed = await write({ body: '# no name\n' })
    expect(unnamed.status).toBe(400)
    expect(await unnamed.json()).toEqual({ error: 'Curator must write or delete a named page' })
  })

  it('400s a curator write with an invalid page name', async () => {
    setCurator('sales-bot')
    const res = await write({ name: 'Bad Name', body: '# x\n' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid page name' })
    expect(fs.existsSync(path.join(tmp, 'brain', 'Bad Name.md'))).toBe(false)
  })

  it('413s a curator write over the byte cap', async () => {
    setCurator('sales-bot')
    const res = await write({ name: 'huge', body: 'x'.repeat(PAGE_BODY_MAX_BYTES + 1) })
    expect(res.status).toBe(413)
  })

  it('404s when Team Brain is off', async () => {
    updateSettings({ ...getSettings(), teamBrain: false })
    const res = await write({ name: 'pricing-decisions', body: '# Why\n' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Team Brain is off' })
  })
})
