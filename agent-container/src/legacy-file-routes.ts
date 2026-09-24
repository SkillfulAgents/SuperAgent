import * as fs from 'fs'
import * as path from 'path'
import { Readable } from 'stream'
import type { Hono } from 'hono'
import {
  normalizeWorkspaceFilePath, openWorkspaceFile, resolveWorkspaceRegularFile,
  WorkspaceFileError, writeWorkspaceFile,
} from './workspace-file-transfer'

function routePath(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.slice('/files/'.length))
  } catch {
    throw new WorkspaceFileError('Invalid encoded file path', 400)
  }
}

/** Existing entries take precedence over the legacy /content operation suffix. */
export function registerLegacyFileRoutes(app: Hono, workspaceRoot = '/workspace'): void {
  app.get('/files/*', async (c) => {
    try {
      const filePath = routePath(c.req.url)
      const fullPath = filePath ? normalizeWorkspaceFilePath(filePath, workspaceRoot).localPath : workspaceRoot
      const root = await fs.promises.realpath(workspaceRoot)
      let stats: fs.Stats | undefined
      try {
        const canonical = await fs.promises.realpath(fullPath)
        const relative = path.relative(root, canonical)
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          throw new WorkspaceFileError('File resolves outside /workspace', 403)
        }
        stats = await fs.promises.stat(canonical)
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      }
      if (!stats && filePath.endsWith('/content')) {
        const sourcePath = filePath.slice(0, -'/content'.length)
        // Hono executes GET for HEAD but does not cancel the response stream.
        // Obtain metadata without opening a handle or constructing a stream.
        if (c.req.method === 'HEAD') {
          const file = await resolveWorkspaceRegularFile(sourcePath, workspaceRoot)
          c.header('Content-Type', 'application/octet-stream')
          c.header('Content-Length', String(file.size))
          c.header('Cache-Control', 'private, no-store')
          return c.body(null)
        }
        const file = await openWorkspaceFile(sourcePath, workspaceRoot)
        c.header('Content-Type', 'application/octet-stream')
        c.header('Content-Length', String(file.size))
        c.header('Cache-Control', 'private, no-store')
        return c.body(Readable.toWeb(file.stream) as ReadableStream<Uint8Array>)
      }
      if (!stats) throw new WorkspaceFileError('File or directory not found', 404)
      if (stats.isDirectory()) {
        const names = await fs.promises.readdir(fullPath)
        return c.json(await Promise.all(names.map(async (name) => {
          const entry = await fs.promises.stat(path.join(fullPath, name))
          return { name, path: path.posix.join(filePath, name), type: entry.isDirectory() ? 'directory' : 'file',
            size: entry.isFile() ? entry.size : undefined, modifiedAt: entry.mtime }
        })))
      }
      return c.json({ name: path.posix.basename(filePath), path: filePath, type: 'file', size: stats.size, modifiedAt: stats.mtime })
    } catch (error) {
      if (error instanceof WorkspaceFileError) return c.json({ error: error.message }, error.status)
      console.error('Error accessing file:', error)
      return c.json({ error: 'Failed to access file' }, 500)
    }
  })

  app.post('/files/*', async (c, next) => {
    try {
      const filePath = routePath(c.req.url)
      if (!filePath.endsWith('/upload')) return next()
      const file = await writeWorkspaceFile(filePath.slice(0, -'/upload'.length), c.req.raw.body, { workspaceRoot })
      return c.json({ success: true, path: file.relativePath })
    } catch (error) {
      if (error instanceof WorkspaceFileError) return c.json({ error: error.message }, error.status)
      console.error('Error uploading file:', error)
      return c.json({ error: 'Failed to upload file' }, 500)
    }
  })
}
