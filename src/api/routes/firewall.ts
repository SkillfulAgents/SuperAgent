import { Hono } from 'hono'
import { Authenticated } from '../middleware/auth'
import { getFirewallStatus, fixFirewallBlock } from '../../main/windows-firewall'

const firewall = new Hono()

firewall.use('*', Authenticated())

// GET /api/firewall/status - is Windows Firewall blocking container->host?
// Cheap on non-Windows (static "unsupported"); cached on Windows.
firewall.get('/status', async (c) => {
  const refresh = c.req.query('refresh') === '1'
  return c.json(await getFirewallStatus({ refresh }))
})

// POST /api/firewall/fix - remove our Block rules + add an Allow rule via one
// elevated PowerShell run (shows a standard UAC prompt on the user's machine).
firewall.post('/fix', async (c) => {
  const result = await fixFirewallBlock()
  return c.json(result, result.ok ? 200 : 502)
})

export default firewall
