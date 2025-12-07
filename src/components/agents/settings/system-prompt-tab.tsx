'use client'

import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

interface SystemPromptTabProps {
  systemPrompt: string
  onSystemPromptChange: (systemPrompt: string) => void
}

export function SystemPromptTab({
  systemPrompt,
  onSystemPromptChange,
}: SystemPromptTabProps) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="system-prompt">System Prompt</Label>
        <p className="text-sm text-muted-foreground">
          Custom instructions that will be appended to the default Claude Code system prompt.
        </p>
        <Textarea
          id="system-prompt"
          value={systemPrompt}
          onChange={(e) => onSystemPromptChange(e.target.value)}
          placeholder="Enter custom instructions for this agent..."
          className="min-h-[300px] font-mono text-sm"
        />
      </div>
    </div>
  )
}
