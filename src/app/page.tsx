'use client'

import { AppSidebar } from '@/components/layout/app-sidebar'
import { MainContent } from '@/components/layout/main-content'
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar'
import { useState } from 'react'

export default function Home() {
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)

  return (
    <SidebarProvider>
      <AppSidebar
        selectedAgentId={selectedAgentId}
        selectedSessionId={selectedSessionId}
        onSelectAgent={(agentId) => {
          setSelectedAgentId(agentId)
          setSelectedSessionId(null)
        }}
        onSelectSession={setSelectedSessionId}
      />
      <SidebarInset className="min-w-0 overflow-hidden">
        <MainContent
          agentId={selectedAgentId}
          sessionId={selectedSessionId}
          onSessionCreated={setSelectedSessionId}
        />
      </SidebarInset>
    </SidebarProvider>
  )
}
