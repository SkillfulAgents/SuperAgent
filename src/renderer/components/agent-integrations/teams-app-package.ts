import type { ApiAgent } from '@shared/lib/types/api'
import { teamsManifest } from '@shared/lib/chat-integrations/teams-manifest'
import { shapePath } from '@shared/lib/types/agent-avatar-shapes'
import { avatarSource, ORB_ON_GROUND_FILL, orbGround } from '@renderer/components/agents/agent-avatar/avatar-source'
import { orbRestingPhi } from '@renderer/components/agents/agent-avatar/agent-avatar'
import { orbSvg, svgToPng } from '@renderer/components/agents/agent-avatar/orb-image'

export type TeamsPackageAgent = Pick<ApiAgent, 'name' | 'slug' | 'description' | 'avatar'>

export async function teamsAppPackage(agent: TeamsPackageAgent, appId: string, name: string, version: string): Promise<Blob> {
  const manifest = teamsManifest({ appId, name, version, description: agent.description })
  const { orb, shape } = avatarSource(agent.avatar ?? { color: 'tonal-purple', shape: 'circle' })
  const color = orbSvg({ orb, shape, size: 192, restingPhi: orbRestingPhi(agent.slug), fill: ORB_ON_GROUND_FILL, background: orbGround(orb) })
  const outline = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><g transform="translate(4 4)"><path d="${shapePath(shape, 24)}" fill="none" stroke="white" stroke-width="2.5"/></g></svg>`
  const [colorIcon, outlineIcon, { zip }] = await Promise.all([svgToPng(color, 192), svgToPng(outline, 32), import('@renderer/lib/browser-zip')])
  const files = {
    'manifest.json': new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
    'color.png': new Uint8Array(await colorIcon.arrayBuffer()),
    'outline.png': new Uint8Array(await outlineIcon.arrayBuffer()),
  }
  return new Promise((resolve, reject) => zip(files, { level: 0 }, (error, bytes) => {
    if (error) reject(error)
    else resolve(new Blob([bytes.buffer as ArrayBuffer], { type: 'application/zip' }))
  }))
}
