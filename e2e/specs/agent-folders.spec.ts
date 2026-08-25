import { test, expect, type Locator, type Page } from '@playwright/test'
import { createAgent, uniqueName } from '../helpers/agents'

// Every test here mutates ONE user's settings row (folders are a per-user
// projection), and folder writes replace whole fields — so two of these tests
// in different workers silently erase each other's folders: created folders
// vanish across reloads, the move-to-folder menu misses them, order
// assertions find foreign rows. `default` pins the file to one worker in
// order, without `serial`'s failure cascade — the tests stay independent and
// retry individually. Other spec files still parallelize around this one.
test.describe.configure({ mode: 'default' })

/**
 * Left-nav agent folders.
 *
 * Folders are a per-user projection over the shared agent list (see
 * `src/renderer/lib/agent-folders.ts`), stored in user settings alongside
 * `agentOrder`. The top level is folders only — "Your Agents" is the
 * always-present default folder that unfiled agents live in. What this spec
 * protects is the round trip: what a drag produced has to survive a reload,
 * and deleting a folder has to release its agents into "Your Agents" rather
 * than take them with it.
 */

/**
 * Steer a live drag onto `target`, letting the list auto-scroll when the target
 * is off screen.
 *
 * By the time a user has enough agents to want folders, the row being dragged
 * and the folder it is headed for often cannot both be on screen — which is the
 * whole reason dnd-kit auto-scrolls when the pointer nears an edge. Measuring
 * both boxes up front and moving once between them silently misses in exactly
 * that case, so this holds the pointer against the edge the target lies beyond
 * and re-reads its position until it comes into view.
 *
 * Returns false if the target never arrives, so the caller can retry the whole
 * gesture rather than releasing over nothing.
 */
async function steerOnto(page: Page, x: number, target: Locator, list: Locator): Promise<boolean> {
  /** Is the target sitting inside the scroller's visible band right now? */
  const inView = () =>
    target
      .evaluate((el) => {
        const scroller = el.closest('[data-testid="agent-list-scroll"]')
        if (!scroller) return false
        const row = el.getBoundingClientRect()
        const band = scroller.getBoundingClientRect()
        const centre = row.y + row.height / 2
        return centre > band.y + 12 && centre < band.y + band.height - 12
      })
      .catch(() => false)

  if (!(await inView())) {
    const listBox = await list.boundingBox()
    const box = await target.boundingBox()
    if (!listBox || !box) return false

    // Park against the edge the target lies beyond. dnd-kit's auto-scroll runs
    // on its own frame loop from there, so this waits on the list actually
    // scrolling rather than on a fixed delay.
    const edgeY = box.y <= listBox.y ? listBox.y + 12 : listBox.y + listBox.height - 12
    await page.mouse.move(x, edgeY, { steps: 4 })
    try {
      await expect.poll(inView, { timeout: 10_000, intervals: [100] }).toBe(true)
    } catch {
      return false
    }
  }

  const box = await target.boundingBox()
  if (!box) return false
  await page.mouse.move(x, box.y + box.height / 2, { steps: 6 })
  // Rows reflow as an agent drag re-parents on its way past them, and leaving
  // the edge stops the auto-scroll, so take one final reading before releasing.
  const reflowed = await target.boundingBox()
  if (reflowed) await page.mouse.move(x, reflowed.y + reflowed.height / 2, { steps: 4 })
  return true
}

/**
 * Engage a drag on the block with `testId`, retrying dnd-kit's 5px activation
 * threshold, and return the pointer's x. For folder drags aimed at a block
 * EDGE — dropping at a target's centre resolves by the pointer's half of the
 * block, which encodes the block's current height into the gesture; agents
 * accumulated by other suites make the same centre land on the other half.
 */
async function startBlockDrag(page: Page, testId: string): Promise<number> {
  const overlay = page.getByTestId('agent-drag-overlay')
  // The previous drop's overlay animates out for ~250ms; a new press in that
  // window can miss while the old overlay still reads as visible.
  await expect(overlay).toBeHidden()
  const row = page.getByTestId(testId)
  for (let attempt = 0; attempt < 3; attempt++) {
    await row.scrollIntoViewIfNeeded()
    const box = await row.boundingBox()
    expect(box, 'drag source is off screen').not.toBeNull()
    const x = box!.x + box!.width / 2
    await page.mouse.move(x, box!.y + box!.height / 2)
    await page.mouse.down()
    await page.mouse.move(x, box!.y + box!.height / 2 + 10, { steps: 4 })
    if (await overlay.isVisible().catch(() => false)) return x
    await page.mouse.up()
  }
  throw new Error('drag never engaged')
}

/**
 * Mid-drag, park the pointer just inside the TOP edge of `block` and wait for
 * its insert line to promise the ABOVE edge, then release. `steerOnto` gets
 * the block into the scroller's band first when it is off screen.
 */
async function dropAboveBlock(page: Page, x: number, block: Locator, folderId: string): Promise<void> {
  const list = page.getByTestId('agent-list-scroll')
  expect(await steerOnto(page, x, block, list), 'target block never scrolled into view').toBe(true)
  // Park the block's top edge mid-band before aiming. An aim point inside the
  // scroller's auto-scroll zone (the top 20% of the container) keeps the list
  // crawling under the stationary pointer and the block slides away from the
  // cue. Centering the top edge both consumes the upward scroll headroom and
  // puts the aim point outside both zones; dnd-kit honors mid-drag ancestor
  // scrolls by offsetting its droppable rects.
  await block.evaluate((el) => {
    const scroller = el.closest('[data-testid="agent-list-scroll"]')
    if (!scroller) return
    const row = el.getBoundingClientRect()
    const band = scroller.getBoundingClientRect()
    scroller.scrollTop += row.top - (band.top + band.height / 2)
  })
  const box = await block.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(x, box!.y + Math.min(12, box!.height / 4), { steps: 6 })
  await expect(page.getByTestId(`folder-insert-indicator-${folderId}`)).toHaveAttribute(
    'data-edge',
    'above'
  )
  await page.mouse.up()
  await expect(page.getByTestId('agent-drag-overlay')).toBeHidden()
}

/**
 * Drag a sidebar row onto another and keep at it until `settled` agrees the
 * drop landed.
 *
 * Two things make a single attempt unreliable, and both are properties of the
 * real UI rather than of the test:
 * - dnd-kit only engages past a 5px activation threshold, so a gesture can end
 *   up a no-op click. The drag overlay mounting is the signal that it took.
 * - The list scrolls, and crossing it re-parents the row mid-drag. Both are
 *   handled by steering toward the target rather than jumping at it.
 *
 * Only the vertical delta matters: the list is under `restrictToVerticalAxis`.
 */
async function dragRowOnto(
  page: Page,
  source: Locator,
  target: Locator,
  settled: () => Promise<void>
): Promise<void> {
  const overlay = page.getByTestId('agent-drag-overlay')
  const list = page.getByTestId('agent-list-scroll')
  let lastError: unknown = new Error('dragRowOnto: the drop never landed')

  for (let attempt = 0; attempt < 3; attempt++) {
    await source.scrollIntoViewIfNeeded()
    const from = await source.boundingBox()
    expect(from, 'drag source is off screen').not.toBeNull()

    const x = from!.x + from!.width / 2
    const startY = from!.y + from!.height / 2

    await page.mouse.move(x, startY)
    await page.mouse.down()
    await page.mouse.move(x, startY + 10, { steps: 4 })

    try {
      await expect(overlay).toBeVisible({ timeout: 2_000 })
    } catch (error) {
      lastError = error
      await page.mouse.up()
      continue
    }

    const reached = await steerOnto(page, x, target, list)
    await page.mouse.up()
    await expect(overlay).toBeHidden()

    if (!reached) {
      lastError = new Error('dragRowOnto: the target never scrolled into view')
      continue
    }

    try {
      await settled()
      return
    } catch (error) {
      lastError = error
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/** Create a folder from the + on the "Your Agents" folder header. */
async function createFolder(page: Page, name: string): Promise<Locator> {
  await page.getByTestId('new-folder-button').click()
  // The freshly created row mounts straight into rename mode.
  const input = page.getByTestId('folder-name-input')
  await expect(input).toBeVisible()
  await input.fill(name)
  await input.press('Enter')

  const row = page.locator('[data-testid^="agent-folder-"]').filter({ hasText: name })
  await expect(row).toBeVisible()
  return row
}

/** The list body belonging to a folder row, which is where its agents render. */
async function folderBody(page: Page, folderRow: Locator): Promise<Locator> {
  return page.locator(`[data-container-id="agent-section::${await folderIdOf(folderRow)}"]`)
}

async function folderIdOf(folderRow: Locator): Promise<string> {
  const testId = await folderRow.getAttribute('data-testid')
  return testId!.replace('agent-folder-', '')
}

/**
 * The left nav top to bottom, as `agent-item-<slug>` / `agent-folder-<id>` ids
 * in DOM order. Other specs leave their agents in this sidebar, so callers
 * narrow it to the rows they created.
 */
async function listOrder(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll('[data-testid^="agent-item-"], [data-testid^="agent-folder-"]')
    )
      .map((el) => el.getAttribute('data-testid')!)
      .filter(
        (id) =>
          !id.startsWith('agent-folder-empty-') &&
          !id.startsWith('agent-folder-count-') &&
          !id.startsWith('agent-folder-chevron-')
      )
  )
}

test.describe('agent folders in the left nav', () => {
  // Every other spec in the suite leaves its agents behind, so by the time this
  // one runs the sidebar can be long enough to scroll. A tall window keeps the
  // rows being dragged between on screen at the same time, which a pointer
  // gesture needs and dnd-kit's auto-scroll cannot be driven into reliably.
  test.use({ viewport: { width: 1280, height: 1800 } })

  test('files an agent by drag, keeps it across a reload, and releases it on delete', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(90_000)

    const filed = await createAgent(request, uniqueName(testInfo, 'Folder Filed'))
    const loose = await createAgent(request, uniqueName(testInfo, 'Folder Loose'))

    await page.goto('/')
    const filedRow = page.getByTestId(`agent-item-${filed.slug}`)
    const looseRow = page.getByTestId(`agent-item-${loose.slug}`)
    await expect(filedRow).toBeVisible()
    await expect(looseRow).toBeVisible()

    const folderName = uniqueName(testInfo, 'Clients')
    const folderRow = await createFolder(page, folderName)
    const body = await folderBody(page, folderRow)

    // An empty folder says what it is for, and is the drop target itself.
    await expect(body).toContainText('Drag agents here')

    // Dropping on the header files the agent at the end of that folder.
    await dragRowOnto(page, filedRow, folderRow, async () => {
      await expect(body.getByTestId(`agent-item-${filed.slug}`)).toBeVisible({ timeout: 3_000 })
    })
    await expect(body.getByTestId(`agent-item-${loose.slug}`)).toHaveCount(0)

    // Collapsing hides only that folder's members — the strongest available
    // statement that the agent really is inside it. (Hidden, not unmounted:
    // expanding a large folder must not pay to mount every row.)
    await folderRow.click()
    await expect(filedRow).toBeHidden()
    await expect(looseRow).toBeVisible()

    // The whole tree is user settings, so it has to survive a reload.
    await page.reload()
    const reloadedFolder = page.locator('[data-testid^="agent-folder-"]').filter({ hasText: folderName })
    await expect(reloadedFolder).toBeVisible()
    await expect(filedRow).toBeHidden()
    await expect(looseRow).toBeVisible()

    await reloadedFolder.click()
    await expect(filedRow).toBeVisible()

    // Deleting a folder must release its agents, not take them with it.
    await reloadedFolder.click({ button: 'right' })
    await page.getByTestId('delete-folder-item').click()

    await expect(reloadedFolder).toHaveCount(0)
    await expect(filedRow).toBeVisible()
    await expect(looseRow).toBeVisible()
  })

  test('drags agents between folders, back out again, and places folders among them', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(120_000)

    const alpha = await createAgent(request, uniqueName(testInfo, 'Folder Alpha'))
    const beta = await createAgent(request, uniqueName(testInfo, 'Folder Beta'))
    const loose = await createAgent(request, uniqueName(testInfo, 'Folder Stays'))

    await page.goto('/')
    const alphaRow = page.getByTestId(`agent-item-${alpha.slug}`)
    const betaRow = page.getByTestId(`agent-item-${beta.slug}`)
    const looseRow = page.getByTestId(`agent-item-${loose.slug}`)
    await expect(looseRow).toBeVisible()

    const firstName = uniqueName(testInfo, 'First')
    const secondName = uniqueName(testInfo, 'Second')
    const firstRow = await createFolder(page, firstName)
    const secondRow = await createFolder(page, secondName)
    const firstBody = await folderBody(page, firstRow)
    const secondBody = await folderBody(page, secondRow)

    await dragRowOnto(page, alphaRow, firstRow, async () => {
      await expect(firstBody.getByTestId(`agent-item-${alpha.slug}`)).toBeVisible({ timeout: 3_000 })
    })
    await dragRowOnto(page, betaRow, secondRow, async () => {
      await expect(secondBody.getByTestId(`agent-item-${beta.slug}`)).toBeVisible({ timeout: 3_000 })
    })

    // Folder to folder — the path that re-parents mid-drag rather than only on
    // release.
    await dragRowOnto(page, alphaRow, secondRow, async () => {
      await expect(secondBody.getByTestId(`agent-item-${alpha.slug}`)).toBeVisible({ timeout: 3_000 })
    })
    await expect(firstBody.getByTestId(`agent-item-${alpha.slug}`)).toHaveCount(0)
    await expect(firstBody).toContainText('Drag agents here')

    // And back out to the ungrouped list, by aiming at an agent already there.
    await dragRowOnto(page, alphaRow, looseRow, async () => {
      await expect(secondBody.getByTestId(`agent-item-${alpha.slug}`)).toHaveCount(0, { timeout: 3_000 })
    })
    // Landed in the ROOT section specifically — "not in the second folder and
    // still visible" would also pass on a misfile into the first folder.
    const rootBody = page.locator('[data-container-id="agent-section::root"]')
    await expect(rootBody.getByTestId(`agent-item-${alpha.slug}`)).toBeVisible()
    await expect(firstBody.getByTestId(`agent-item-${alpha.slug}`)).toHaveCount(0)

    // Folders take a place in the same order as the unfiled agents, so the
    // second one can be dragged above an agent that is not in any folder.
    const secondId = await folderIdOf(secondRow)
    const firstId = await folderIdOf(firstRow)
    const mine = async () => {
      const ids = await listOrder(page)
      return ids.filter((id) =>
        id === `agent-item-${loose.slug}` ||
        id === `agent-item-${alpha.slug}` ||
        id === `agent-folder-${firstId}` ||
        id === `agent-folder-${secondId}`
      )
    }

    /** Assert `first` renders above `second`, polling past the drop's commit. */
    const expectAbove = async (first: string, second: string) => {
      await expect
        .poll(
          async () => {
            const ids = await mine()
            const a = ids.indexOf(first)
            const b = ids.indexOf(second)
            // A missing row must read as failure — indexOf's -1 would
            // otherwise pass "above" for a row that is not there at all.
            if (a === -1 || b === -1) return Number.POSITIVE_INFINITY
            return a - b
          },
          { message: `${first} should render above ${second}` }
        )
        .toBeLessThan(0)
    }

    const blockFor = (testId: string) =>
      page.locator('li').filter({ has: page.getByTestId(testId) }).first()

    // Folders interleave with the whole ROOT block at the top level (a folder
    // dropped "on a loose agent" resolves against the block that HOLDS it),
    // so putting the second folder above every unfiled agent means dropping
    // on the root block's ABOVE edge — aimed explicitly, because the block's
    // height, and with it which half a given row sits in, depends on how many
    // agents other suites have accumulated.
    {
      const x = await startBlockDrag(page, `agent-folder-${secondId}`)
      await dropAboveBlock(page, x, blockFor('agent-folder-root'), 'root')
      await expectAbove(`agent-folder-${secondId}`, `agent-item-${loose.slug}`)
    }

    // And the arrangement is user settings, so it survives a reload.
    const arranged = await mine()
    await page.reload()
    await expect(firstRow).toBeVisible()
    expect(await mine()).toEqual(arranged)

    // Folders still reorder past each other.
    {
      const x = await startBlockDrag(page, `agent-folder-${firstId}`)
      await dropAboveBlock(page, x, blockFor(`agent-folder-${secondId}`), secondId)
      await expectAbove(`agent-folder-${firstId}`, `agent-folder-${secondId}`)
    }
  })

  test.describe('with the whole list on screen', () => {
    // This test's folder is created last, so it renders at the very bottom of
    // the list — and repeat runs accumulate every previous test's agents above
    // it. If the list overflows, the end of the drag sits inside dnd-kit's
    // auto-scroll band (20% of the container), the folder slides up under the
    // stationary pointer, and in content coordinates the pointer descends out
    // of the folder — a genuine leave, but not the gesture under test. A tall
    // enough viewport keeps the list overflow-free so auto-scroll never runs.
    test.use({ viewport: { width: 1280, height: 3200 } })

    test('never advertises the folder as a drop target while sorting inside it', async ({
      page,
      request,
    }, testInfo) => {
      test.setTimeout(120_000)

    // Five members so the drag crosses several row boundaries and gaps.
    const members = []
    for (let i = 0; i < 5; i++) {
      members.push(await createAgent(request, uniqueName(testInfo, `Sort ${i}`)))
    }

    await page.goto('/')
    await expect(page.getByTestId(`agent-item-${members[0].slug}`)).toBeVisible()

    const folderName = uniqueName(testInfo, 'SortHome')
    const folderRow = await createFolder(page, folderName)
    const folderId = await folderIdOf(folderRow)
    for (const m of members) {
      await page.getByTestId(`agent-item-${m.slug}`).click({ button: 'right' })
      await page.getByTestId('move-agent-to-folder-trigger').hover()
      await page.getByTestId(`move-agent-to-folder-${folderId}`).click()
    }
    const body = await folderBody(page, folderRow)
    await expect(body.getByTestId(`agent-item-${members[4].slug}`)).toBeVisible()

    // While sorting INSIDE a folder, the folder must never light up as a drop
    // target: in the gap between two member rows the pointer is over no row,
    // and before the collision detector snapped gaps to the nearest member
    // row, `over` fell to the folder body there — flashing the header ring and
    // body tint on and off with every gap the pointer crossed. Watch for the
    // highlight classes appearing at all during the sort.
    await page.evaluate((id) => {
      ;(window as any).__highlightFlashes = 0
      const watch = (el: Element | null) => {
        if (!el) return
        new MutationObserver(() => {
          if ((el as HTMLElement).className.includes('bg-sidebar-accent')) {
            ;(window as any).__highlightFlashes++
          }
        }).observe(el, { attributes: true, attributeFilter: ['class'] })
      }
      watch(document.querySelector(`[data-testid="agent-folder-${id}"]`))
      watch(document.querySelector(`[data-container-id="agent-section::${id}"]`))
    }, folderId)

    // Drag the top member down to the bottom row in 2px steps so the pointer
    // dwells in every gap. (Newest-created renders first, so members[4] is the
    // top row.)
    const firstRow = body.getByTestId(`agent-item-${members[4].slug}`)
    const lastRow = body.getByTestId(`agent-item-${members[0].slug}`)
    const overlay = page.getByTestId('agent-drag-overlay')

    // Same activation retry as dragRowOnto: a gesture can end up a no-op click
    // when the 5px threshold races a mid-animation row.
    // Keep the whole travel clear of the auto-scroll zone at the container's
    // bottom edge — this test is about sorting inside a stationary folder.
    await lastRow.scrollIntoViewIfNeeded()

    let x = 0
    let y = 0
    let engaged = false
    for (let attempt = 0; attempt < 3 && !engaged; attempt++) {
      await firstRow.scrollIntoViewIfNeeded()
      const from = await firstRow.boundingBox()
      expect(from).not.toBeNull()
      x = from!.x + from!.width / 2
      y = from!.y + from!.height / 2
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x, y + 6, { steps: 3 })
      engaged = await overlay.isVisible().catch(() => false)
      if (!engaged) {
        await expect(overlay).toBeVisible({ timeout: 1_000 }).then(() => { engaged = true }, () => {})
      }
      if (!engaged) await page.mouse.up()
    }
    expect(engaged, 'drag never engaged').toBe(true)
    const to = await lastRow.boundingBox()
    const endY = to!.y + to!.height / 2

    while (y < endY) {
      y = Math.min(y + 2, endY)
      await page.mouse.move(x, y)
    }
    const flashes = await page.evaluate(() => (window as any).__highlightFlashes)
    await page.mouse.up()
    await expect(overlay).toBeHidden()

    // The folder never advertised itself as a drop target mid-sort…
    expect(flashes, 'drop-target highlight flashed during a within-folder sort').toBe(0)

    // …and the drop is a genuine within-folder reorder: the top row moved
    // down, and nothing left the folder. (Exactly which slot it lands in at
    // the end of travel depends on displaced-row geometry — the precise index
    // math is pinned by the moveAgent unit tests, not here.)
    const order = await body
      .locator('[data-testid^="agent-item-"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')))
    expect(order).toHaveLength(5)
    expect(order.indexOf(`agent-item-${members[4].slug}`)).toBeGreaterThan(0)
    })
  })

  test('folder reordering: drop above everything to be first, and the line lands where the drop does', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(120_000)

    await createAgent(request, uniqueName(testInfo, 'Reorder Anchor'))
    await page.goto('/')
    const overlay = page.getByTestId('agent-drag-overlay')
    await expect(page.getByTestId('agent-folder-root')).toBeVisible()

    const folderName = uniqueName(testInfo, 'Edges')
    const folderRow = await createFolder(page, folderName)
    const edgesId = `agent-folder-${await folderIdOf(folderRow)}`

    // Repeat runs accumulate earlier folders, so every step works on the
    // CURRENT top-level order rather than assuming who the neighbours are.
    const folders = async () =>
      (await listOrder(page)).filter((id) => id.startsWith('agent-folder-'))
    const indicatorFor = (testId: string) =>
      page.getByTestId(testId.replace('agent-folder-', 'folder-insert-indicator-'))
    const blockFor = (testId: string) =>
      page.locator('li').filter({ has: page.getByTestId(testId) }).first()

    /** Engage a drag on the row with `testId`, retrying the 5px threshold. */
    const startDrag = async (testId: string): Promise<number> => {
      // The previous drop's overlay animates out for ~250ms; a new press in
      // that window can miss while the old overlay still reads as visible.
      await expect(overlay).toBeHidden()
      const row = page.getByTestId(testId)
      for (let attempt = 0; attempt < 3; attempt++) {
        const box = await row.boundingBox()
        expect(box).not.toBeNull()
        const x = box!.x + box!.width / 2
        await page.mouse.move(x, box!.y + box!.height / 2)
        await page.mouse.down()
        await page.mouse.move(x, box!.y + box!.height / 2 + 10, { steps: 4 })
        if (await overlay.isVisible().catch(() => false)) return x
        await page.mouse.up()
      }
      throw new Error('drag never engaged')
    }

    // A freshly created folder mounts directly above the default folder — in
    // view next to the + that made it, not below the scroll fold.
    {
      const order = await folders()
      expect(order.indexOf(edgesId)).toBe(order.indexOf('agent-folder-root') - 1)
    }

    // ── The natural "make it first" gesture: drop in the space ABOVE the
    // first block. There used to be nothing droppable there, so the drag
    // just snapped back.
    {
      const topId = (await folders())[0]
      const x = await startDrag(edgesId)
      const topBox = await page.getByTestId(topId).boundingBox()
      // Well above the first header, in the nav area.
      await page.mouse.move(x, topBox!.y - 30, { steps: 10 })
      await expect(indicatorFor(topId)).toHaveAttribute('data-edge', 'above')
      await page.mouse.up()

      await expect.poll(async () => (await folders())[0]).toBe(edgesId)
    }

    // ── Dragging DOWN into a block's lower half: the line must sit on its
    // BOTTOM edge and the drop must land after it. The line used to draw at
    // the top while the drop landed below — lying about the landing spot.
    {
      const below = (await folders())[1]
      const x = await startDrag(edgesId)
      const blockBox = await blockFor(below).boundingBox()
      await page.mouse.move(x, blockBox!.y + blockBox!.height * 0.85, { steps: 10 })
      await expect(indicatorFor(below)).toHaveAttribute('data-edge', 'below')
      await page.mouse.up()

      // Poll the position relation itself — both ids are always present, so
      // polling for mere presence would pass before the drop's React commit
      // and race the real assertion.
      await expect
        .poll(async () => {
          const after = await folders()
          return after.indexOf(edgesId) - after.indexOf(below)
        }, { message: `${edgesId} should sit right after ${below}` })
        .toBe(1)
    }

    // ── And the empty space BELOW the whole list means "last".
    {
      const dragged = (await folders())[0]
      const lastId = (await folders()).at(-1)!
      const x = await startDrag(dragged)
      const lastBox = await blockFor(lastId).boundingBox()
      await page.mouse.move(x, lastBox!.y + lastBox!.height + 120, { steps: 10 })
      await expect(indicatorFor(lastId)).toHaveAttribute('data-edge', 'below')
      await page.mouse.up()

      await expect.poll(async () => (await folders()).at(-1)).toBe(dragged)
    }
  })

  test('files an agent from its context menu, which is the path that works on touch', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(90_000)

    const agent = await createAgent(request, uniqueName(testInfo, 'Folder Menu'))

    await page.goto('/')
    const row = page.getByTestId(`agent-item-${agent.slug}`)
    await expect(row).toBeVisible()

    const folderName = uniqueName(testInfo, 'Menu Target')
    const folderRow = await createFolder(page, folderName)
    const body = await folderBody(page, folderRow)
    const folderId = (await folderRow.getAttribute('data-testid'))!.replace('agent-folder-', '')

    await row.click({ button: 'right' })
    await page.getByTestId('move-agent-to-folder-trigger').hover()
    await page.getByTestId(`move-agent-to-folder-${folderId}`).click()

    await expect(body.getByTestId(`agent-item-${agent.slug}`)).toBeVisible()

    // And back out again.
    await row.click({ button: 'right' })
    await page.getByTestId('move-agent-to-folder-trigger').hover()
    await page.getByTestId('move-agent-to-no-folder-item').click()

    await expect(body.getByTestId(`agent-item-${agent.slug}`)).toHaveCount(0)
    await expect(row).toBeVisible()
  })
})
