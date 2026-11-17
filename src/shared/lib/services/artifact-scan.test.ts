import { describe, expect, it } from 'vitest'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import type { FileEntry, FileStat } from '@shared/lib/agent-actor/types'
import { hashWidgetHtml, scanArtifactsIn, type ArtifactFiles } from './artifact-scan'

/** Files held in memory, as a store of an agent's saved files would hand them over. */
function filesOf(contents: Record<string, string>): ArtifactFiles {
  const isDir = (path: string) => Object.keys(contents).some((file) => file.startsWith(`${path}/`))
  return {
    list: async (dir) => {
      if (!isDir(dir)) throw new WorkspaceFileError('not-found', dir)
      const names = new Set(Object.keys(contents).filter((file) => file.startsWith(`${dir}/`)).map((file) => file.slice(dir.length + 1).split('/')[0]))
      return [...names].map((name): FileEntry => ({ name, path: `${dir}/${name}`, kind: isDir(`${dir}/${name}`) ? 'directory' : 'file' }) as FileEntry)
    },
    stat: async (path) => (path in contents ? ({ kind: 'file' } as FileStat) : isDir(path) ? ({ kind: 'directory' } as FileStat) : null),
    resolve: async (path) => (path in contents || isDir(path) ? path : null),
    getDoc: async (path) => (path in contents ? new TextEncoder().encode(contents[path]) : null),
  }
}

describe('scanArtifactsIn', () => {
  it('lists dashboards and widgets from the files it is given', async () => {
    const files = filesOf({
      'artifacts/sales/package.json': JSON.stringify({ name: 'Sales', scripts: { start: 'bun run server.ts' } }),
      'artifacts/sales/screenshot.png': 'png',
      'artifacts/next-meeting/package.json': JSON.stringify({ name: 'Next meeting', gamut: { widget: { size: 'small' } } }),
      'artifacts/next-meeting/widget.html': '<p>10:30 Design review</p>',
    })

    const listing = await scanArtifactsIn(files, { includeWidgets: true, agentSlug: 'agent-1' })

    expect(listing.dashboards).toEqual([
      { slug: 'sales', name: 'Sales', description: '', status: 'stopped', port: 0, hasScreenshot: true, firstRun: true },
    ])
    expect(listing.widgets).toMatchObject([
      { slug: 'next-meeting', name: 'Next meeting', hasHtml: true, htmlHash: hashWidgetHtml('<p>10:30 Design review</p>'), refreshing: false },
    ])
  })

  it('reads an agent without an artifacts directory as having none', async () => {
    expect(await scanArtifactsIn(filesOf({}), { includeWidgets: true, agentSlug: 'agent-1' })).toEqual({ dashboards: [], widgets: [] })
  })
})
