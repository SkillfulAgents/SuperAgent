import * as fs from 'fs';
import * as path from 'path';

export type WorkspaceEntryType = 'file' | 'directory';

export interface RenameWorkspaceEntryRequest {
  path: string;
  name: string;
  type: WorkspaceEntryType;
}

export interface DeleteWorkspaceEntryRequest {
  path: string;
  type: WorkspaceEntryType;
}

export class WorkspaceEntryOperationError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

const CONTAINER_WORKSPACE_ROOT = '/workspace';

function isValidEntryName(name: string): boolean {
  return name.length > 0
    && name.length <= 255
    && name !== '.'
    && name !== '..'
    && !name.includes('/')
    && !name.includes('\\')
    && !name.includes('\0');
}

function resolveWorkspaceEntry(rawPath: string, workspaceRoot: string): string {
  if (!rawPath.startsWith('/') || rawPath.includes('\0')) {
    throw new WorkspaceEntryOperationError('Invalid workspace path', 400);
  }

  const normalized = path.posix.normalize(rawPath);
  const relative = path.posix.relative(CONTAINER_WORKSPACE_ROOT, normalized);
  if (
    relative === ''
    || relative === '..'
    || relative.startsWith('../')
    || path.posix.isAbsolute(relative)
  ) {
    throw new WorkspaceEntryOperationError('Invalid workspace path', 400);
  }

  return path.resolve(workspaceRoot, ...relative.split('/').filter(Boolean));
}

async function assertEntryType(entryPath: string, type: WorkspaceEntryType): Promise<void> {
  let entryStat: fs.Stats;
  try {
    entryStat = await fs.promises.lstat(entryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new WorkspaceEntryOperationError(`${type === 'file' ? 'File' : 'Directory'} not found`, 404);
    }
    throw error;
  }

  const matchesType = type === 'file' ? entryStat.isFile() : entryStat.isDirectory();
  if (entryStat.isSymbolicLink() || !matchesType) {
    throw new WorkspaceEntryOperationError(`${type === 'file' ? 'File' : 'Directory'} not found`, 404);
  }
}

export async function renameWorkspaceEntry(
  request: RenameWorkspaceEntryRequest,
  workspaceRoot = CONTAINER_WORKSPACE_ROOT,
): Promise<{ path: string; name: string }> {
  const trimmedName = request.name.trim();
  if (!isValidEntryName(trimmedName)) {
    throw new WorkspaceEntryOperationError('Invalid entry name', 400);
  }

  const sourcePath = resolveWorkspaceEntry(request.path, workspaceRoot);
  await assertEntryType(sourcePath, request.type);

  const destinationContainerPath = path.posix.join(path.posix.dirname(request.path), trimmedName);
  const destinationPath = resolveWorkspaceEntry(destinationContainerPath, workspaceRoot);
  try {
    await fs.promises.lstat(destinationPath);
    throw new WorkspaceEntryOperationError('A file or directory with that name already exists', 409);
  } catch (error) {
    if (error instanceof WorkspaceEntryOperationError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  await fs.promises.rename(sourcePath, destinationPath);
  return { path: destinationContainerPath, name: trimmedName };
}

export async function deleteWorkspaceEntry(
  request: DeleteWorkspaceEntryRequest,
  workspaceRoot = CONTAINER_WORKSPACE_ROOT,
): Promise<void> {
  const entryPath = resolveWorkspaceEntry(request.path, workspaceRoot);
  await assertEntryType(entryPath, request.type);

  if (request.type === 'directory') {
    await fs.promises.rm(entryPath, { recursive: true });
  } else {
    await fs.promises.unlink(entryPath);
  }
}
