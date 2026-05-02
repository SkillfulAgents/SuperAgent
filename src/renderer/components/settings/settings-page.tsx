import * as React from 'react'
import { ArrowLeft } from 'lucide-react'
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
import { SettingsPageContainer, PageTitle } from '@renderer/components/layout/settings-page'
import { isElectron, getPlatform } from '@renderer/lib/env'
import { useFullScreen } from '@renderer/hooks/use-fullscreen'

export interface SettingsPageSection {
  id: string
  label: string
  icon: React.ReactNode
  /** Returns the content for this section. Lazy so unrelated sections don't render. */
  render: () => React.ReactNode
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
  const allSections = React.useMemo(() => groups.flatMap((g) => g.sections), [groups])
  const sectionIds = React.useMemo(() => allSections.map((s) => s.id), [allSections])

  const [active, setActive] = React.useState(() => {
    if (initialSection && sectionIds.includes(initialSection)) return initialSection
    return sectionIds[0] ?? ''
  })

  React.useEffect(() => {
    if (initialSection && sectionIds.includes(initialSection)) {
      setActive(initialSection)
    }
  }, [initialSection, sectionIds])

  const activeSection = allSections.find((s) => s.id === active)
  const isFullScreen = useFullScreen()
  const needsTrafficLightPadding = isElectron() && getPlatform() === 'darwin' && !isFullScreen

  return (
    <SidebarProvider className="h-screen" data-testid={dataTestId}>
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
                        onClick={() => setActive(s.id)}
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
          <PageTitle title={activeSection?.label ?? 'Settings'} />
          {activeSection?.render()}
        </SettingsPageContainer>
      </SidebarInset>
    </SidebarProvider>
  )
}
