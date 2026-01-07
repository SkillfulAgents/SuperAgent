'use client'

import { AppSidebar } from '@/components/layout/app-sidebar'
import { MainContent } from '@/components/layout/main-content'
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar'
import { SelectionProvider } from '@/lib/context/selection-context'

export default function Home() {
  return (
    <SelectionProvider>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset className="min-w-0 overflow-hidden">
          <MainContent />
        </SidebarInset>
      </SidebarProvider>
    </SelectionProvider>
  )
}
