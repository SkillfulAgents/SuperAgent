import { test, expect, type BrowserContext } from '@playwright/test'

test('agent home rows show who wrote in each session of a shared agent', async ({ browser, page, baseURL }) => {
  test.setTimeout(90_000)
  const contexts: BrowserContext[] = []
  const stamp = Date.now()
  const users: { id: string; name: string; context: BrowserContext }[] = []
  try {
    for (const [index, name] of ['Olive Owner', 'Mark Member'].entries()) {
      const context = index === 0 ? page.context() : await browser.newContext({ baseURL })
      if (index > 0) contexts.push(context)
      const response = await context.request.post('/api/auth/sign-up/email', {
        data: { name, email: `participants-${stamp}-${index}@example.test`, password: 'CollaborationTesting123!' },
      })
      expect(response.ok()).toBeTruthy()
      const { user } = await response.json()
      users.push({ id: user.id, name, context })
      expect((await context.request.put('/api/user-settings', { data: { setupCompleted: true } })).ok()).toBeTruthy()
    }
    const [owner, member] = users

    const created = await page.request.post('/api/agents', { data: { name: 'Session Participants' } })
    expect(created.ok()).toBeTruthy()
    const { slug } = await created.json()
    const endpoint = `/api/agents/${slug}`

    // Before the agent is shared, rows carry no faces even though the list knows the author.
    const solo = await page.request.post(`${endpoint}/sessions`, { data: { message: 'Just me here' } })
    expect(solo.ok()).toBeTruthy()
    const soloId = (await solo.json()).id as string
    await page.goto(`/agents/${slug}`)
    await expect(page.getByTestId(`session-row-menu-${soloId}`)).toBeAttached({ timeout: 15_000 })
    await expect(page.getByTestId(`session-participants-${soloId}`)).toHaveCount(0)

    expect((await page.request.post(`${endpoint}/access`, { data: { userId: member.id, role: 'user' } })).ok()).toBeTruthy()

    // The member starts a session and the owner joins it.
    const joint = await member.context.request.post(`${endpoint}/sessions`, { data: { message: 'Mark starts this one' } })
    expect(joint.ok()).toBeTruthy()
    const jointId = (await joint.json()).id as string
    await expect.poll(async () => {
      const res = await page.request.post(`${endpoint}/sessions/${jointId}/messages`, { data: { content: 'Olive joins in' } })
      return res.status()
    }, { timeout: 30_000 }).toBeLessThan(300)

    const list = await (await page.request.get(`${endpoint}/sessions`)).json() as { id: string; participants?: { id: string }[] }[]
    expect(list.find(s => s.id === jointId)?.participants?.map(p => p.id)).toEqual([member.id, owner.id])
    expect(list.find(s => s.id === soloId)?.participants?.map(p => p.id)).toEqual([owner.id])

    await page.reload()
    const jointFaces = page.getByTestId(`session-participants-${jointId}`)
    await expect(jointFaces).toHaveAttribute('title', `${member.name}, ${owner.name}`, { timeout: 15_000 })
    await expect(jointFaces.getByRole('img', { includeHidden: true })).toHaveCount(2)
    await expect(page.getByTestId(`session-participants-${soloId}`)).toHaveAttribute('title', owner.name)
  } finally {
    await Promise.all(contexts.map(context => context.close()))
  }
})
