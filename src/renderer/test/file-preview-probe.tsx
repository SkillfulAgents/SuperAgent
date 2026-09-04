import { useFilePreview } from '@renderer/context/file-preview-context'

export function FilePreviewProbe() {
  const { isOpen, openTabs, activeTabIndex } = useFilePreview()
  const active = openTabs[activeTabIndex]
  return (
    <div data-testid="file-preview-probe">
      {isOpen && active?.kind === 'file'
        ? `${active.filePath}|${active.agentSlug}`
        : 'closed'}
    </div>
  )
}
