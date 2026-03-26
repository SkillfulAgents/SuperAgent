
import * as React from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from '@renderer/components/ui/sidebar'
import { useIsMobile } from '@renderer/hooks/use-mobile'

// --- Tab & Group (marker components — never rendered directly) ---

interface SettingsDialogTabProps {
  id: string
  label: string
  icon: React.ReactNode
  footer?: React.ReactNode
  children: React.ReactNode
}

export function SettingsDialogTab(_props: SettingsDialogTabProps) {
  return null
}

interface SettingsDialogGroupProps {
  label?: string
  children: React.ReactNode
}

export function SettingsDialogGroup(_props: SettingsDialogGroupProps) {
  return null
}

// --- Internal types ---

interface TabInfo {
  id: string
  label: string
  icon: React.ReactNode
  footer?: React.ReactNode
  content: React.ReactNode
}

interface GroupInfo {
  label?: string
  tabs: TabInfo[]
}

// --- Child extraction ---

function extractTabsFromChildren(children: React.ReactNode): TabInfo[] {
  const tabs: TabInfo[] = []
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return
    if (child.type === SettingsDialogTab) {
      const props = child.props as SettingsDialogTabProps
      tabs.push({
        id: props.id,
        label: props.label,
        icon: props.icon,
        footer: props.footer,
        content: props.children,
      })
    } else if (child.type === React.Fragment) {
      tabs.push(...extractTabsFromChildren((child.props as { children: React.ReactNode }).children))
    }
  })
  return tabs
}

function extractGroups(children: React.ReactNode): GroupInfo[] {
  const groups: GroupInfo[] = []
  let currentImplicitGroup: TabInfo[] = []

  const flushImplicit = () => {
    if (currentImplicitGroup.length > 0) {
      groups.push({ tabs: currentImplicitGroup })
      currentImplicitGroup = []
    }
  }

  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return

    if (child.type === SettingsDialogGroup) {
      flushImplicit()
      const props = child.props as SettingsDialogGroupProps
      groups.push({
        label: props.label,
        tabs: extractTabsFromChildren(props.children),
      })
    } else if (child.type === SettingsDialogTab) {
      const props = child.props as SettingsDialogTabProps
      currentImplicitGroup.push({
        id: props.id,
        label: props.label,
        icon: props.icon,
        footer: props.footer,
        content: props.children,
      })
    } else if (child.type === React.Fragment) {
      // Unwrap fragments (from conditional rendering like {condition && <>...</>})
      const fragmentGroups = extractGroups((child.props as { children: React.ReactNode }).children)
      for (const g of fragmentGroups) {
        if (g.label !== undefined) {
          flushImplicit()
          groups.push(g)
        } else {
          currentImplicitGroup.push(...g.tabs)
        }
      }
    }
  })

  flushImplicit()
  return groups
}

// --- SettingsDialog ---

interface SettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  initialTab?: string
  overlay?: React.ReactNode
  inert?: boolean
  'data-testid'?: string
  navTestIdPrefix?: string
  children: React.ReactNode
}

export function SettingsDialog({
  open,
  onOpenChange,
  title,
  description,
  initialTab,
  overlay,
  inert,
  'data-testid': dataTestId,
  navTestIdPrefix = 'settings',
  children,
}: SettingsDialogProps) {
  const isMobile = useIsMobile()
  const [mobileShowNav, setMobileShowNav] = React.useState(true)

  const groups = extractGroups(children)
  const allTabs = groups.flatMap((g) => g.tabs)
  const allTabIds = allTabs.map((t) => t.id)
  const tabIdsKey = allTabIds.join(',')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableTabIds = React.useMemo(() => allTabIds, [tabIdsKey])

  const [activeTab, setActiveTab] = React.useState(allTabs[0]?.id ?? '')

  // Reset when dialog opens (track open transition to avoid resetting on every re-render)
  const prevOpen = React.useRef(false)
  React.useEffect(() => {
    if (open && !prevOpen.current) {
      const tab = initialTab && stableTabIds.includes(initialTab) ? initialTab : stableTabIds[0] ?? ''
      setActiveTab(tab)
      setMobileShowNav(!initialTab)
    }
    prevOpen.current = open
  }, [open, initialTab, stableTabIds])

  const activeTabInfo = allTabs.find((t) => t.id === activeTab)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="overflow-hidden p-0 h-[100dvh] md:h-auto md:max-h-[500px] md:max-w-[700px] lg:max-w-[800px]"
        data-testid={dataTestId}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        {overlay}
        <SidebarProvider className="items-start min-h-0" {...(inert ? { inert: '' } : {})}>
          <Sidebar collapsible="none" className="hidden md:flex w-48 max-h-[480px]">
            <SidebarContent>
              {groups.map((group, i) => (
                <SidebarGroup key={i}>
                  {group.label && (
                    <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
                  )}
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {group.tabs.map((tab) => (
                        <SidebarMenuItem key={tab.id}>
                          <SidebarMenuButton
                            isActive={activeTab === tab.id}
                            onClick={() => setActiveTab(tab.id)}
                            data-testid={`${navTestIdPrefix}-nav-${tab.id}`}
                          >
                            {tab.icon}
                            <span>{tab.label}</span>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      ))}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              ))}
            </SidebarContent>
          </Sidebar>
          <main className="flex h-full md:h-[480px] min-h-0 flex-1 flex-col overflow-hidden">
            {isMobile && mobileShowNav ? (
              <div className="flex flex-1 flex-col overflow-y-auto">
                <div className="px-4 py-3 border-b">
                  <span className="text-sm font-medium">{title}</span>
                </div>
                {groups.map((group, i) => (
                  <div key={i}>
                    {group.label && (
                      <div className="px-4 pt-3 pb-1 text-xs font-medium text-muted-foreground">{group.label}</div>
                    )}
                    {group.tabs.map((tab) => (
                      <button
                        key={tab.id}
                        className="flex w-full items-center gap-3 px-4 py-3 text-sm hover:bg-accent transition-colors"
                        onClick={() => { setActiveTab(tab.id); setMobileShowNav(false) }}
                        data-testid={`${navTestIdPrefix}-nav-${tab.id}`}
                      >
                        <span className="text-muted-foreground">{tab.icon}</span>
                        <span>{tab.label}</span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            ) : (
              <>
                <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
                  {isMobile ? (
                    <button
                      className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                      onClick={() => setMobileShowNav(true)}
                    >
                      {title}
                    </button>
                  ) : (
                    <span className="text-sm text-muted-foreground">{title}</span>
                  )}
                  <span className="text-sm text-muted-foreground">/</span>
                  <span className="text-sm font-medium">
                    {activeTabInfo?.label}
                  </span>
                </header>
                <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
                  {activeTabInfo?.content}
                </div>
                {activeTabInfo?.footer}
              </>
            )}
          </main>
        </SidebarProvider>
      </DialogContent>
    </Dialog>
  )
}
