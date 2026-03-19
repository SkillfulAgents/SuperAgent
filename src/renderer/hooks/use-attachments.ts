import { useState, useCallback, useEffect } from 'react'
import { type Attachment } from '@renderer/components/messages/attachment-preview'
import { getItemsFromDataTransfer, getFolderFromDirectoryInput, type FileWithPath, type FolderGroup } from '@renderer/lib/file-utils'

// 500 MB max folder size for in-browser zip upload (no Electron fs.cp available)
const MAX_WEB_FOLDER_SIZE = 500 * 1024 * 1024

interface UseAttachmentsOptions {
  onFoldersReceived?: (folders: FolderGroup[]) => void
}

export function useAttachments(options?: UseAttachmentsOptions) {
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [isDragOver, setIsDragOver] = useState(false)

  const addFiles = useCallback((files: FileWithPath[]) => {
    const newAttachments: Attachment[] = files.map(({ file }) => {
      const attachment: Attachment = {
        type: 'file',
        file,
        id: crypto.randomUUID(),
      }
      if (file.type.startsWith('image/')) {
        attachment.preview = URL.createObjectURL(file)
      }
      return attachment
    })
    setAttachments((prev) => [...prev, ...newAttachments])
  }, [])

  const addFolders = useCallback((folders: FolderGroup[]) => {
    const newAttachments: Attachment[] = []
    for (const folder of folders) {
      const totalSize = folder.files.reduce((sum, f) => sum + f.file.size, 0)
      if (!folder.folderPath && totalSize > MAX_WEB_FOLDER_SIZE) {
        const sizeMB = Math.round(totalSize / (1024 * 1024))
        alert(`Folder "${folder.folderName}" is too large (${sizeMB} MB). The maximum folder size in the browser is 500 MB. Please use the desktop app for larger folders.`)
        continue
      }
      newAttachments.push({
        type: 'folder' as const,
        id: crypto.randomUUID(),
        folderName: folder.folderName,
        folderPath: folder.folderPath,
        files: folder.files,
        totalSize,
      })
    }
    if (newAttachments.length > 0) {
      setAttachments((prev) => [...prev, ...newAttachments])
    }
  }, [])

  const addMounts = useCallback((mounts: { folderName: string; hostPath: string }[]) => {
    const newAttachments: Attachment[] = mounts.map((m) => ({
      type: 'mount' as const,
      id: crypto.randomUUID(),
      folderName: m.folderName,
      hostPath: m.hostPath,
    }))
    setAttachments((prev) => [...prev, ...newAttachments])
  }, [])

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const removed = prev.find((a) => a.id === id)
      if (removed?.type === 'file' && removed.preview) {
        URL.revokeObjectURL(removed.preview)
      }
      return prev.filter((a) => a.id !== id)
    })
  }, [])

  const clearAttachments = useCallback(() => {
    setAttachments((prev) => {
      prev.forEach((a) => {
        if (a.type === 'file' && a.preview) URL.revokeObjectURL(a.preview)
      })
      return []
    })
  }, [])

  // Cleanup object URLs on unmount
  useEffect(() => {
    return () => {
      attachments.forEach((a) => {
        if (a.type === 'file' && a.preview) URL.revokeObjectURL(a.preview)
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    if (e.dataTransfer.items.length > 0) {
      const { files, folders } = await getItemsFromDataTransfer(e.dataTransfer)
      if (files.length > 0) addFiles(files)
      if (folders.length > 0) {
        if (options?.onFoldersReceived) {
          options.onFoldersReceived(folders)
        } else {
          addFolders(folders)
        }
      }
    }
  }, [addFiles, addFolders, options])

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      addFiles(Array.from(e.target.files).map((file) => ({ file })))
      e.target.value = ''
    }
  }, [addFiles])

  const handleFolderSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const folder = getFolderFromDirectoryInput(e.target.files)
      if (folder) {
        if (options?.onFoldersReceived) {
          options.onFoldersReceived([folder])
        } else {
          addFolders([folder])
        }
      }
      e.target.value = ''
    }
  }, [addFolders, options])

  return {
    attachments,
    isDragOver,
    addFiles,
    addFolders,
    addMounts,
    removeAttachment,
    clearAttachments,
    handleFileSelect,
    handleFolderSelect,
    dragHandlers: {
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
    },
  }
}
