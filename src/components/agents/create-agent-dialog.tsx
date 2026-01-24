'use client'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useState } from 'react'
import { useCreateAgent } from '@/lib/hooks/use-agents'
import { useSelection } from '@/lib/context/selection-context'

interface CreateAgentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CreateAgentDialog({ open, onOpenChange }: CreateAgentDialogProps) {
  const [name, setName] = useState('')
  const createAgent = useCreateAgent()
  const { selectAgent } = useSelection()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return

    try {
      const newAgent = await createAgent.mutateAsync({ name: name.trim() })
      setName('')
      onOpenChange(false)
      // Select the newly created agent
      selectAgent(newAgent.slug)
    } catch (error) {
      console.error('Failed to create agent:', error)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Create New Agent</DialogTitle>
            <DialogDescription>
              Create a new AI agent. Each agent runs in its own Docker container.
            </DialogDescription>
          </DialogHeader>

          <div className="py-4">
            <Input
              placeholder="Agent name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || createAgent.isPending}>
              {createAgent.isPending ? 'Creating...' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
