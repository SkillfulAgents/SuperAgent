import * as React from 'react'
import { ArrowLeft, ChevronRight } from 'lucide-react'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from '@renderer/components/ui/sidebar'
import { Button } from '@renderer/components/ui/button'
import { SettingsPageContainer, PageTitle } from '@renderer/components/layout/settings-page'
import { useIsMobile } from '@renderer/hooks/use-mobile'
import { isElectron, getPlatform } from '@renderer/lib/env'
import { useFullScreen } from '@renderer/hooks/use-fullscreen'

export interface SettingsPageSection {
  id: string
  label: string
  icon: React.ReactNode
  /** Returns the content for this section. Lazy so unrelated sections don't render. */
  render: () => React.ReactNode
  /** Optional actions rendered next to the page title (e.g. an "Add" button). */
  headerActions?: React.ReactNode
}

export interface SettingsPageSectionGroup {
  label?: string
  sections: SettingsPageSection[]
}

interface SettingsPageProps {
  groups: SettingsPageSectionGroup[]
  initialSection?: string
  onClose: () => void
  navTestIdPrefix?: string
  'data-testid'?: string
}

export function SettingsPage({
  groups,
  initialSection,
  onClose,
  navTestIdPrefix = 'settings',
  'data-testid': dataTestId,
}: SettingsPageProps) {
  return (
    <SidebarProvider className="h-screen" data-testid={dataTestId}>
      <SettingsPageContent
        groups={groups}
        initialSection={initialSection}
        onClose={onClose}
        navTestIdPrefix={navTestIdPrefix}
      />
    </SidebarProvider>
  )
}

function SettingsPageContent({
  groups,
  initialSection,
  onClose,
  navTestIdPrefix,
}: Omit<SettingsPageProps, 'data-testid'>) {
  const isMobile = useIsMobile()

  const allSections = React.useMemo(() => groups.flatMap((g) => g.sections), [groups])
  const sectionIds = React.useMemo(() => allSections.map((s) => s.id), [allSections])

  const [active, setActive] = React.useState(() => {
    if (initialSection && sectionIds.includes(initialSection)) return initialSection
    return sectionIds[0] ?? ''
  })

  const [mobileView, setMobileView] = React.useState<'menu' | 'content'>(
    initialSection && sectionIds.includes(initialSection) ? 'content' : 'menu',
  )

  React.useEffect(() => {
    if (initialSection && sectionIds.includes(initialSection)) {
      setActive(initialSection)
      if (isMobile) setMobileView('content')
    }
  }, [initialSection, sectionIds, isMobile])

  const handleSectionClick = (id: string) => {
    setActive(id)
    if (isMobile) setMobileView('content')
  }

  const activeSection = allSections.find((s) => s.id === active)
  const isFullScreen = useFullScreen()
  const needsTrafficLightPadding = isElectron() && getPlatform() === 'darwin' && !isFullScreen

  if (isMobile) {
    if (mobileView === 'menu') {
      return (
        <div className="flex h-screen w-full flex-col bg-background">
          <div className="flex items-center h-12 shrink-0 px-2 border-b">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm font-medium px-2">Settings</span>
          </div>
          <div className="flex-1 overflow-auto py-1">
            {groups.map((group) => (
              <div key={group.label ?? '__ungrouped__'}>
                {group.label && (
                  <div className="px-4 pt-4 pb-1 text-xs font-medium text-muted-foreground">
                    {group.label}
                  </div>
                )}
                {group.sections.map((s) => (
                  <button
                    key={s.id}
                    className="flex w-full items-center gap-3 px-4 py-3 text-sm text-left hover:bg-accent active:bg-accent"
                    onClick={() => handleSectionClick(s.id)}
                    data-testid={`${navTestIdPrefix}-nav-${s.id}`}
                  >
                    {s.icon}
                    <span className="flex-1">{s.label}</span>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )
    }

    return (
      <div className="flex h-screen w-full flex-col bg-background">
        <div className="flex items-center h-12 shrink-0 px-2 border-b">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setMobileView('menu')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <span className="flex-1 text-sm font-medium truncate px-2">
            {activeSection?.label ?? 'Settings'}
          </span>
          {activeSection?.headerActions && (
            <div className="shrink-0">{activeSection.headerActions}</div>
          )}
        </div>
        <SettingsPageContainer>
          {activeSection?.render()}
        </SettingsPageContainer>
      </div>
    )
  }

  return (
    <>
      <Sidebar variant="inset" data-testid="settings-sidebar">
        <SidebarHeader
          className="h-12 app-drag-region"
          style={{ paddingLeft: needsTrafficLightPadding ? '80px' : undefined }}
        />
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton onClick={onClose} data-testid="settings-back">
                    <ArrowLeft className="h-4 w-4" />
                    <span>Back to app</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          {groups.map((group) => (
            <SidebarGroup key={group.label ?? '__ungrouped__'}>
              {group.label && <SidebarGroupLabel>{group.label}</SidebarGroupLabel>}
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.sections.map((s) => (
                    <SidebarMenuItem key={s.id}>
                      <SidebarMenuButton
                        isActive={active === s.id}
                        onClick={() => handleSectionClick(s.id)}
                        data-testid={`${navTestIdPrefix}-nav-${s.id}`}
                      >
                        {s.icon}
                        <span>{s.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>
      </Sidebar>
      <SidebarInset className="min-w-0">
        <div className="h-12 shrink-0 app-drag-region" />
        <SettingsPageContainer>
          <PageTitle
            title={activeSection?.label ?? 'Settings'}
            actions={activeSection?.headerActions}
          />
          {activeSection?.render()}
        </SettingsPageContainer>
      </SidebarInset>
    </>
  )
}
