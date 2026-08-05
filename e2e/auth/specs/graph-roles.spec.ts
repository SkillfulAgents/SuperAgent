/**
 * Home connections graph — role-gated affordances in auth mode.
 *
 * The graph renders shared agents a user can only view; mutation affordances
 * (connect ports, edge delete/edit) must match what the server would allow.
 * This narrative proves the rendered page gates them: the owner's agent card
 * offers connect ports, the same card seen by a viewer offers none.
 */
import { test, expect } from '../fixtures/multi-user.fixture'
import { AuthPage } from '../pages/auth.page'
import { AccessPage } from '../pages/access.page'
import { AppPage } from '../../pages/app.page'

// Serial narrative — each test builds on state from the previous ones.
test.describe.configure({ mode: 'serial' })

const owner = { name: 'Olivia Owner', email: 'olivia@test.com', password: 'password123' }
const viewer = { name: 'Vic Viewer', email: 'vic@test.com', password: 'password123' }
const agentName = 'Graph Roles Agent'
let agentSlug = ''

test.describe('Graph role-gated affordances', () => {
  test('owner signs up and creates an agent', async ({ user1Page }) => {
    const authPage = new AuthPage(user1Page)
    const appPage = new AppPage(user1Page)

    await authPage.resetToAuthPage()
    await authPage.signUpOrSignIn(owner.name, owner.email, owner.password)
    await appPage.waitForAppLoaded()
    await appPage.dismissWizardIfVisible()

    const response = await user1Page.request.post('/api/agents', { data: { name: agentName } })
    expect(response.ok()).toBeTruthy()
    const agent = await response.json() as { slug: string }
    agentSlug = agent.slug
    expect(agentSlug).toBeTruthy()
  })

  test('viewer signs up', async ({ user2Page }) => {
    const authPage = new AuthPage(user2Page)
    const appPage = new AppPage(user2Page)

    await authPage.resetToAuthPage()
    await authPage.signUpOrSignIn(viewer.name, viewer.email, viewer.password)
    await appPage.waitForAppLoaded()
    await appPage.dismissWizardIfVisible()
  })

  test('owner shares the agent with the viewer at viewer role', async ({ user1Page }) => {
    await user1Page.reload()
    const accessPage = new AccessPage(user1Page)
    await accessPage.openAccessTab(agentName)
    await accessPage.inviteUser(viewer.email, 'viewer')
    await accessPage.closeSettings()
  })

  test('owner sees connect ports on their agent card', async ({ user1Page }) => {
    await user1Page.goto('/?view=graph')
    const node = user1Page.getByTestId(`graph-node-agent-${agentSlug}`)
    await expect(node).toBeVisible()
    // Four ports (N/S/E/W) render whenever the user can link resources —
    // they arm visually on selection, but exist in the DOM up front.
    await expect(node.getByTestId('graph-port')).toHaveCount(4)
  })

  test('viewer sees the shared agent but no connect ports', async ({ user2Page }) => {
    // Reload so the fresh ACL row is reflected in the role map.
    await user2Page.goto('/?view=graph')
    const node = user2Page.getByTestId(`graph-node-agent-${agentSlug}`)
    await expect(node).toBeVisible()
    // Selection must not conjure mutation affordances for a read-only role.
    await node.click()
    await expect(node.getByTestId('graph-port')).toHaveCount(0)
  })
})
