import { parseAttachedFiles, parseMountedFolders } from '@shared/lib/utils/attached-files'
import { parseSenderPrefix } from '@shared/lib/utils/sender-prefix'

export interface UserMessageParts {
  sender: string | null
  attachedFiles: string[]
  mountedFolders: { containerPath: string; hostPath: string }[]
  text: string
}

export function parseUserMessageParts(rawText: string, opts: { readOnly: boolean }): UserMessageParts {
  const { sender, cleanText: afterSender } = opts.readOnly
    ? parseSenderPrefix(rawText)
    : { sender: null, cleanText: rawText }
  const { cleanText: afterFiles, attachedFiles } = afterSender
    ? parseAttachedFiles(afterSender)
    : { cleanText: afterSender, attachedFiles: [] }
  const { cleanText, mountedFolders } = afterFiles
    ? parseMountedFolders(afterFiles)
    : { cleanText: afterFiles, mountedFolders: [] }
  return { sender, attachedFiles, mountedFolders, text: cleanText }
}
