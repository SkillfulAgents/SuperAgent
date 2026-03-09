import { useState, useCallback, useEffect } from 'react'
import { type Attachment } from '@renderer/components/messages/attachment-preview'
import { getItemsFromDataTransfer, getFolderFromDirectoryInput, type FileWithPath, type FolderGroup } from '@renderer/lib/file-utils'

export function useAttachments() {
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
    const newAttachments: Attachment[] = folders.map((folder) => ({
      type: 'folder' as const,
      id: crypto.randomUUID(),
      folderName: folder.folderName,
      files: folder.files,
      totalSize: folder.files.reduce((sum, f) => sum + f.file.size, 0),
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
      if (folders.length > 0) addFolders(folders)
    }
  }, [addFiles, addFolders])

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      addFiles(Array.from(e.target.files).map((file) => ({ file })))
      e.target.value = ''
    }
  }, [addFiles])

  const handleFolderSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const folder = getFolderFromDirectoryInput(e.target.files)
      if (folder) addFolders([folder])
      e.target.value = ''
    }
  }, [addFolders])

  return {
    attachments,
    isDragOver,
    addFiles,
    addFolders,
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
