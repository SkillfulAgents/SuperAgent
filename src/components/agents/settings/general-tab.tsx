'use client'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface GeneralTabProps {
  name: string
  onNameChange: (name: string) => void
}

export function GeneralTab({ name, onNameChange }: GeneralTabProps) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="agent-name">Agent Name</Label>
        <Input
          id="agent-name"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="Enter agent name"
        />
      </div>
    </div>
  )
}
