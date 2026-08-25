import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { clearSettingsCache, getSettings, updateSettings } from '@shared/lib/config/settings'
import { getCuratorSlug } from '@shared/lib/services/brain-service'

const mockGetCachedInfo = vi.fn()
const mockStopContainer = vi.fn()
const mockRestartContainer = vi.fn()
vi.mock('@shared/lib/container/container-manager', () => ({
  containerManager: {
    getCachedInfo: (...a: unknown[]) => mockGetCachedInfo(...a),
    stopContainer: (...a: unknown[]) => mockStopContainer(...a),
    restartContainer: (...a: unknown[]) => mockRestartContainer(...a),
  },
}))

import brainAdmin from './brain-admin'

function app() {
  const hono = new Hono()
  hono.route('/api/brain', brainAdmin)
  return hono
}

describe('GET/PUT /api/brain/curator', () => {
  const prevDataDir = process.env.SUPERAGENT_DATA_DIR
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-brain-admin-'))
    process.env.SUPERAGENT_DATA_DIR = tmp
    fs.mkdirSync(path.join(tmp, 'agents', 'sales-bot'), { recursive: true })
    clearSettingsCache()
    updateSettings({ ...getSettings(), teamBrain: true })
    mockGetCachedInfo.mockReturnValue({ status: 'stopped' })
    mockStopContainer.mockReset()
    mockRestartContainer.mockReset()
  })

  afterEach(() => {
    clearSettingsCache()
    fs.rmSync(tmp, { recursive: true, force: true })
    if (prevDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
    else process.env.SUPERAGENT_DATA_DIR = prevDataDir
  })

  it('starts empty, sets one slug, then clears', async () => {
    const empty = await app().request('http://localhost/api/brain/curator')
    expect(empty.status).toBe(200)
    expect(await empty.json()).toEqual({ enabled: true, agentSlug: null })

    const set = await app().request('http://localhost/api/brain/curator', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentSlug: 'sales-bot' }),
    })
    expect(set.status).toBe(200)
    expect(await set.json()).toEqual({ enabled: true, agentSlug: 'sales-bot' })

    const cleared = await app().request('http://localhost/api/brain/curator', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentSlug: null }),
    })
    expect(cleared.status).toBe(200)
    expect(await cleared.json()).toEqual({ enabled: true, agentSlug: null })
  })

  it('replacing the slug clears the previous curator', async () => {
    fs.mkdirSync(path.join(tmp, 'agents', 'curator-bot'), { recursive: true })

    const first = await app().request('http://localhost/api/brain/curator', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentSlug: 'sales-bot' }),
    })
    expect(first.status).toBe(200)

    const second = await app().request('http://localhost/api/brain/curator', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentSlug: 'curator-bot' }),
    })
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ enabled: true, agentSlug: 'curator-bot' })

    const current = await app().request('http://localhost/api/brain/curator')
    expect(await current.json()).toEqual({ enabled: true, agentSlug: 'curator-bot' })
  })

  it('hides the curator and refuses writes when Team Brain is off', async () => {
    updateSettings({ ...getSettings(), teamBrain: false })
    fs.mkdirSync(path.join(tmp, 'brains', 'global'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'brains', 'global', 'CURATOR'), 'sales-bot')
    const hidden = await app().request('http://localhost/api/brain/curator')
    expect(hidden.status).toBe(200)
    expect(await hidden.json()).toEqual({ enabled: false, agentSlug: null })

    const denied = await app().request('http://localhost/api/brain/curator', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentSlug: 'sales-bot' }),
    })
    expect(denied.status).toBe(404)
    expect(await denied.json()).toEqual({ error: 'Team Brain is off' })
  })

  it('404s an unknown agent', async () => {
    const res = await app().request('http://localhost/api/brain/curator', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentSlug: 'missing-bot' }),
    })
    expect(res.status).toBe(404)
  })

  it('stops the old curator before moving the pointer, then restarts the new one', async () => {
    fs.mkdirSync(path.join(tmp, 'agents', 'ops-bot'), { recursive: true })
    await app().request('http://localhost/api/brain/curator', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentSlug: 'sales-bot' }) })
    mockGetCachedInfo.mockReturnValue({ status: 'running' })
    const order: string[] = []
    mockStopContainer.mockImplementation(async (slug: string) => { order.push(`stop:${slug}:${getCuratorSlug()}`) })
    mockRestartContainer.mockImplementation(async (slug: string) => { order.push(`restart:${slug}:${getCuratorSlug()}`) })
    const res = await app().request('http://localhost/api/brain/curator', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentSlug: 'ops-bot' }) })
    expect(res.status).toBe(200)
    expect(order).toEqual(['stop:sales-bot:sales-bot', 'restart:ops-bot:ops-bot'])
  })

  it('leaves the pointer unchanged when stopping the old curator fails', async () => {
    await app().request('http://localhost/api/brain/curator', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentSlug: 'sales-bot' }) })
    fs.mkdirSync(path.join(tmp, 'agents', 'ops-bot'), { recursive: true })
    mockGetCachedInfo.mockReturnValue({ status: 'running' })
    mockStopContainer.mockRejectedValue(new Error('runtime down'))
    const res = await app().request('http://localhost/api/brain/curator', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentSlug: 'ops-bot' }) })
    expect(res.status).toBe(500)
    expect(getCuratorSlug()).toBe('sales-bot')
    expect(mockRestartContainer).not.toHaveBeenCalled()
  })

  it('does not stop when there is no previous curator', async () => {
    mockGetCachedInfo.mockReturnValue({ status: 'stopped' })
    const res = await app().request('http://localhost/api/brain/curator', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentSlug: 'sales-bot' }) })
    expect(res.status).toBe(200)
    expect(mockStopContainer).not.toHaveBeenCalled()
    expect(mockRestartContainer).not.toHaveBeenCalled()
  })

  it('stops the old curator even when the cache says it is already stopped', async () => {
    await app().request('http://localhost/api/brain/curator', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentSlug: 'sales-bot' }) })
    fs.mkdirSync(path.join(tmp, 'agents', 'ops-bot'), { recursive: true })
    mockGetCachedInfo.mockReturnValue({ status: 'stopped' })
    const res = await app().request('http://localhost/api/brain/curator', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentSlug: 'ops-bot' }) })
    expect(res.status).toBe(200)
    expect(mockStopContainer).toHaveBeenCalledWith('sales-bot')
    expect(getCuratorSlug()).toBe('ops-bot')
  })
})
