import type { Page } from '@playwright/test'
import type { VolumeDefinitionSummary, MountSummaryWithHealth } from '../../src/shared/lib/types/mount'

/** OAuth and Dropbox stay mocked; the real renderer drives both volume creation paths. */
export async function mockDropboxVolumes(page: Page, agentSlug?: string) {
  const definitions: VolumeDefinitionSummary[] = []
  const mounts: MountSummaryWithHealth[] = []
  const created: unknown[] = []
  let foldersFail = false
  await page.route('**/api/connected-accounts', route => route.fulfill({ json: { accounts: [
    { id: 'dropbox-test', toolkitSlug: 'dropbox', providerName: 'composio', displayName: 'Team Dropbox', status: 'active' },
    { id: 'dropbox-expired', toolkitSlug: 'dropbox', providerName: 'composio', displayName: 'Old Dropbox', status: 'expired' },
  ] } }))
  await page.route('**/api/volume-definitions/dropbox/folders?*', route => {
    if (foldersFail) return route.fulfill({ status: 403, json: { error: 'Reconnect this Dropbox account in Connections' } })
    const folder = new URLSearchParams(route.request().url().split('?')[1]).get('path')
    return route.fulfill({ json: { folders: folder === ''
      ? [{ name: 'Team documents', path: '/Team documents' }, { name: 'Research', path: '/Research' }]
      : folder === '/Team documents' ? [{ name: 'Reports', path: '/Team documents/Reports' }] : [] } })
  })
  const save = (body: { name?: string; config: { path: string } }) => {
    created.push(body)
    const source: VolumeDefinitionSummary = {
      id: `dropbox-volume-${definitions.length + 1}`, name: body.name ?? 'Dropbox', type: 'dropbox', hostPath: null,
      sourceLabel: `Dropbox · ${body.config.path || '/'}`, userId: null, canManage: true, health: 'ok', attachmentCount: 0,
    }
    definitions.push(source)
    return source
  }
  await page.route('**/api/volume-definitions', route => {
    if (route.request().method() === 'POST') return route.fulfill({ status: 201, json: { id: save(route.request().postDataJSON()).id } })
    return route.fulfill({ json: definitions })
  })
  if (agentSlug) await page.route(`**/api/agents/${agentSlug}/mounts`, route => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: mounts })
    const body = route.request().postDataJSON()
    const source = body.volumeId ? definitions.find(volume => volume.id === body.volumeId)! : save(body)
    source.attachmentCount++
    const mount = { ...source, id: `mount-${mounts.length + 1}`, volumeId: source.id }
    mounts.push(mount)
    return route.fulfill({ status: 201, json: mount })
  })
  return { definitions, mounts, created, failFolders: (fail: boolean) => { foldersFail = fail } }
}
