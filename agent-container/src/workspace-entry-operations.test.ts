import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  deleteWorkspaceEntry,
  renameWorkspaceEntry,
  WorkspaceEntryOperationError,
} from './workspace-entry-operations';

describe('workspace entry operations', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'workspace-entry-'));
    await fs.promises.mkdir(path.join(workspaceRoot, 'reports', 'drafts'), { recursive: true });
    await fs.promises.writeFile(path.join(workspaceRoot, 'reports', 'notes.md'), 'notes');
    await fs.promises.writeFile(path.join(workspaceRoot, 'reports', 'drafts', 'old.md'), 'draft');
  });

  afterEach(async () => {
    await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
  });

  it('renames files and returns the container path', async () => {
    const result = await renameWorkspaceEntry({
      path: '/workspace/reports/notes.md',
      name: 'renamed.md',
      type: 'file',
    }, workspaceRoot);

    expect(result).toEqual({ path: '/workspace/reports/renamed.md', name: 'renamed.md' });
    await expect(fs.promises.readFile(path.join(workspaceRoot, 'reports', 'renamed.md'), 'utf8'))
      .resolves.toBe('notes');
    expect(fs.existsSync(path.join(workspaceRoot, 'reports', 'notes.md'))).toBe(false);
  });

  it('recursively deletes directories', async () => {
    await deleteWorkspaceEntry({
      path: '/workspace/reports/drafts',
      type: 'directory',
    }, workspaceRoot);

    expect(fs.existsSync(path.join(workspaceRoot, 'reports', 'drafts'))).toBe(false);
  });

  it('does not overwrite an existing entry', async () => {
    await fs.promises.writeFile(path.join(workspaceRoot, 'reports', 'existing.md'), 'existing');

    await expect(renameWorkspaceEntry({
      path: '/workspace/reports/notes.md',
      name: 'existing.md',
      type: 'file',
    }, workspaceRoot)).rejects.toMatchObject<Partial<WorkspaceEntryOperationError>>({ status: 409 });
  });

  it('rejects the workspace root and paths outside the workspace', async () => {
    await expect(deleteWorkspaceEntry({ path: '/workspace', type: 'directory' }, workspaceRoot))
      .rejects.toMatchObject<Partial<WorkspaceEntryOperationError>>({ status: 400 });
    await expect(deleteWorkspaceEntry({ path: '/etc/passwd', type: 'file' }, workspaceRoot))
      .rejects.toMatchObject<Partial<WorkspaceEntryOperationError>>({ status: 400 });
  });

  it('rejects leaf symlinks instead of mutating their targets', async () => {
    if (process.platform === 'win32') return;
    const targetPath = path.join(workspaceRoot, 'reports', 'notes.md');
    const linkPath = path.join(workspaceRoot, 'reports', 'linked.md');
    await fs.promises.symlink(targetPath, linkPath);

    await expect(deleteWorkspaceEntry({
      path: '/workspace/reports/linked.md',
      type: 'file',
    }, workspaceRoot)).rejects.toMatchObject<Partial<WorkspaceEntryOperationError>>({ status: 404 });
    await expect(fs.promises.readFile(targetPath, 'utf8')).resolves.toBe('notes');
  });
});
