'use client'

import { AppSidebar } from '@/components/layout/app-sidebar'
import { MainContent } from '@/components/layout/main-content'
import { SidebarProvider, SidebarInset, SidebarTrigger } from '@/components/ui/sidebar'
import { useState } from 'react'

export default function Home() {
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)

  return (
    <SidebarProvider>
      <AppSidebar
        selectedAgentId={selectedAgentId}
        onSelectAgent={(agentId) => {
          setSelectedAgentId(agentId)
          setSelectedSessionId(null)
        }}
      />
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
        </header>
        <MainContent
          agentId={selectedAgentId}
          sessionId={selectedSessionId}
          onSelectSession={setSelectedSessionId}
        />
      </SidebarInset>
    </SidebarProvider>
  )
}
