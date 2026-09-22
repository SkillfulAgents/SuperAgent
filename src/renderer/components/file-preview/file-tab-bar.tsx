import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { FileTypeIcon } from '@renderer/components/ui/file-type-icon'
import { DrawerTabStrip, drawerTabClassName } from '@renderer/components/tray/drawer-tab-strip'
import { cn } from '@shared/lib/utils/cn'
import { getPreviewTabKey, type PreviewTab } from '@renderer/context/file-preview-context'

interface FileTabBarProps {
  tabs: PreviewTab[]
  activeIndex: number
  onTabClick: (index: number) => void
  onCloseTab: (tabKey: string) => void
  /**
   * Whether the active tab's left edge is flush with the strip's left inset —
   * true only for the first tab, unscrolled. The body card squares off its
   * top-left corner to meet the tab when it is.
   */
  onLeadingTabFlush?: (flush: boolean) => void
  /** Panel-level controls rendered after the last tab, at the strip's right edge (the drawer close). */
  trailing?: ReactNode
}

export function FileTabBar({
  tabs,
  activeIndex,
  onTabClick,
  onCloseTab,
  onLeadingTabFlush,
  trailing,
}: FileTabBarProps) {
  if (tabs.length === 0) return null
  return (
    <DrawerTabStrip
      tabCount={tabs.length}
      activeIndex={activeIndex}
      onLeadingTabFlush={onLeadingTabFlush}
      trailing={trailing}
      testId="file-tab"
    >
      {(reveal) =>
        tabs.map((tab, index) => (
          // The tab is a shell, not a control: it holds two buttons, and a
          // <button> may not contain another interactive element. The close
          // control used to be a role="button" span nested inside the tab's
          // own button, which is invalid content either way round and left
          // its Enter handling hand-rolled. Two real buttons side by side get
          // keyboard activation from the browser.
          <div
            key={getPreviewTabKey(tab)}
            data-testid="file-tab"
            data-tab-kind={tab.kind}
            data-file-name={tab.displayName}
            data-path={tab.kind === 'file' ? tab.filePath : tab.rootPath}
            data-active={index === activeIndex || undefined}
            className={drawerTabClassName(index, activeIndex)}
          >
            <button
              type="button"
              onClick={() => onTabClick(index)}
              // A clipped tab is still in the tab order, and the strip cannot
              // rely on the browser to reveal it during a smooth scroll of its
              // own; bring it in explicitly.
              onFocus={() => reveal(index)}
              data-testid="file-tab-select"
              className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-3 pr-1 text-left"
            >
              {/* Follow the tab's own color so the icon darkens with the label on the
                    active tab and on hover, instead of the icon's muted default. */}
              <FileTypeIcon
                filename={tab.displayName}
                size="sm"
                folder={tab.kind === 'folder'}
                className="text-inherit"
              />
              {/* Overflowing names fade out at the right edge instead of ellipsizing, as in Chrome. */}
              <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap [mask-image:linear-gradient(to_right,black_calc(100%-16px),transparent)]">
                {tab.displayName}
              </span>
            </button>
            <button
              type="button"
              data-testid="file-tab-close"
              data-file-name={tab.displayName}
              data-path={tab.kind === 'file' ? tab.filePath : tab.rootPath}
              aria-label={`Close ${tab.displayName}`}
              onClick={() => onCloseTab(getPreviewTabKey(tab))}
              className={cn(
                'shrink-0 rounded p-0.5 text-muted-foreground transition-opacity hover:bg-muted-foreground/20 hover:text-foreground group-hover:opacity-100 touch:opacity-100',
                // the selected tab keeps its close visible; the rest reveal it on hover
                index === activeIndex ? 'opacity-100' : 'opacity-0',
              )}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))
      }
    </DrawerTabStrip>
  )
}
