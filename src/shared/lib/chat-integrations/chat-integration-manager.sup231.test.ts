/**
 * SUP-231 — Chat attachment filenames can escape the workspace uploads directory.
 *
 * External chat attachment filenames (Slack/Telegram/iMessage) are concatenated
 * unsanitized into a filesystem path in `writeToWorkspace`. The `Date.now()-`
 * prefix only absorbs the first `..` segment and provides no real protection, so
 * a malicious name like `../../../oauth-token.txt` writes OUTSIDE `<workspace>/uploads`.
 *
 * This suite reproduces the escape against a real temp workspace dir (no file may
 * be written outside `uploads`). The `sanitizeUploadFilename` helper it relies on
 * is unit-tested in `utils/path-safety.test.ts`, where the helper now lives.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { chatIntegrationManager } from './chat-integration-manager'
import { getAgentWorkspaceDir } from '@shared/lib/config/data-dir'

// `sanitizeUploadFilename` itself is unit-tested in utils/path-safety.test.ts
// (where it now lives). This spec covers the manager's writeToWorkspace use of it.

const AGENT_SLUG = 'sup231-agent'

let tempDataDir: string
let prevDataDir: string | undefined

beforeEach(async () => {
  prevDataDir = process.env.SUPERAGENT_DATA_DIR
  tempDataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sup231-data-'))
  process.env.SUPERAGENT_DATA_DIR = tempDataDir
})

afterEach(async () => {
  if (prevDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
  else process.env.SUPERAGENT_DATA_DIR = prevDataDir
  await fs.promises.rm(tempDataDir, { recursive: true, force: true }).catch(() => {})
})

/** Re-derive the locations the manager will use for the given agent. */
function workspacePaths() {
  const workspaceDir = getAgentWorkspaceDir(AGENT_SLUG)
  const uploadsDir = path.resolve(workspaceDir, 'uploads')
  return { workspaceDir, uploadsDir }
}

async function writeToWorkspace(filename: string, data: Buffer): Promise<string> {
  // writeToWorkspace is private; reach it directly for the repro.
  return (chatIntegrationManager as any).writeToWorkspace(AGENT_SLUG, filename, data)
}

describe('SUP-231 writeToWorkspace path containment', () => {
  it('keeps chat attachment uploads inside the workspace uploads directory', async () => {
    const { workspaceDir, uploadsDir } = workspacePaths()
    const data = Buffer.from('secret-data')

    // The classic traversal: pre-fix this resolves to <workspace>/oauth-token.txt
    // (one level ABOVE uploads), leaking outside the uploads sandbox.
    await writeToWorkspace('../../../oauth-token.txt', data)

    // Nothing must be written outside uploads.
    expect(fs.existsSync(path.join(workspaceDir, 'oauth-token.txt'))).toBe(false)
    expect(fs.existsSync(path.join(path.dirname(workspaceDir), 'oauth-token.txt'))).toBe(false)
    expect(fs.existsSync(path.join(tempDataDir, 'oauth-token.txt'))).toBe(false)

    // The (sanitized) file must land strictly under uploads.
    const inUploads = fs.existsSync(uploadsDir)
      ? fs.readdirSync(uploadsDir).filter((f) => f.endsWith('oauth-token.txt'))
      : []
    expect(inUploads.length).toBe(1)
  })

  it('does not let a deep traversal escape the filesystem root area', async () => {
    const { workspaceDir, uploadsDir } = workspacePaths()
    const data = Buffer.from('x')

    await writeToWorkspace('../../../../etc/cron.d/x', data)

    // No file should appear above the workspace dir.
    expect(fs.existsSync(path.join(path.dirname(workspaceDir), 'etc'))).toBe(false)
    const entries = fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir) : []
    expect(entries.length).toBe(1)
    // The resolved destination stays under uploads.
    const rel = path.relative(uploadsDir, path.resolve(uploadsDir, entries[0]))
    expect(rel.startsWith('..')).toBe(false)
    expect(path.isAbsolute(rel)).toBe(false)
  })

  it('writes a normal filename to uploads/<digits>-<name> and returns the workspace path', async () => {
    const { uploadsDir } = workspacePaths()
    const result = await writeToWorkspace('report.pdf', Buffer.from('pdf-bytes'))

    expect(result).toMatch(/^\/workspace\/uploads\/\d+-report\.pdf$/)
    const files = fs.readdirSync(uploadsDir)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^\d+-report\.pdf$/)
    const written = fs.readFileSync(path.join(uploadsDir, files[0]), 'utf8')
    expect(written).toBe('pdf-bytes')
  })
})
