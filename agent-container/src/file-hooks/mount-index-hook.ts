import { indexPath, mountedVolumeIndexes } from '../volume-mounts'
import { FileHook, type FileHookWriteResult } from './file-hook'

const FILE_CHANGING_COMMAND = /(^|[\s;&|(])(\S*\/)?(mv|rm|rmdir|cp|mkdir|touch|ln|rsync|tee|tar|unzip)(?=\s|$)|\s-delete\b/

function indexHint(roots: string[]): string | undefined {
  if (roots.length === 0) return undefined
  const indexes = roots.map((root) => JSON.stringify(indexPath(root))).join(', ')
  return `Drive index: ${indexes}. Update the index if this change makes an entry wrong or missing.`
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function indexedRoots(): string[] {
  return mountedVolumeIndexes().map((m) => m.path)
}

/** Matches on the command text only, so a move by relative path or from inside a script gets no hint. */
export function mountIndexCommandHint(command: unknown): string | undefined {
  if (typeof command !== 'string') return undefined
  const unescaped = command.replace(/\\(.)/g, '$1')
  if (!FILE_CHANGING_COMMAND.test(unescaped)) return undefined
  return indexHint(indexedRoots().filter((root) => {
    const rest = unescaped.replace(new RegExp(`${escapeRegExp(indexPath(root))}(?=[\\s"';|&)]|$)`, 'g'), '')
    return new RegExp(`(^|[\\s"'=])${escapeRegExp(root)}(?=[/\\s"';|&)]|$)`).test(rest)
  }))
}

export class MountIndexFileHook extends FileHook {
  pattern(): string {
    return '/mounts/*/**'
  }

  matches(filePath: string): boolean {
    return this.hint(filePath) !== undefined
  }

  onWrite(filePath: string): FileHookWriteResult {
    return { warning: this.hint(filePath) }
  }

  onEdit(filePath: string): FileHookWriteResult {
    return this.onWrite(filePath)
  }

  private hint(filePath: string): string | undefined {
    return indexHint(indexedRoots().filter((root) => filePath.startsWith(`${root}/`) && filePath !== indexPath(root)))
  }
}
