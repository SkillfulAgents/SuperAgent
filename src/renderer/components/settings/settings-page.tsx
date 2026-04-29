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
  const allSections = groups.flatMap((g) => g.sections)
  const sectionIds = allSections.map((s) => s.id)
  const idsKey = sectionIds.join(',')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableIds = React.useMemo(() => sectionIds, [idsKey])

  const [active, setActive] = React.useState(() => {
    if (initialSection && stableIds.includes(initialSection)) return initialSection
    return stableIds[0] ?? ''
  })

  React.useEffect(() => {
    if (initialSection && stableIds.includes(initialSection)) {
      setActive(initialSection)
    }
  }, [initialSection, stableIds])

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
          {groups.map((group, gi) => (
            <SidebarGroup key={gi}>
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
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-10 py-10">
            <h1 className="text-2xl font-normal mb-8">{activeSection?.label}</h1>
            <div className="flex flex-col gap-6">
              {activeSection?.render()}
            </div>
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
