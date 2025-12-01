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
import { useCreateSession } from '@/lib/hooks/use-sessions'

interface CreateSessionDialogProps {
  agentId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (sessionId: string) => void
}

export function CreateSessionDialog({
  agentId,
  open,
  onOpenChange,
  onCreated,
}: CreateSessionDialogProps) {
  const [name, setName] = useState('')
  const createSession = useCreateSession()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return

    try {
      const session = await createSession.mutateAsync({
        agentId,
        name: name.trim(),
      })
      setName('')
      onOpenChange(false)
      onCreated?.(session.id)
    } catch (error) {
      console.error('Failed to create session:', error)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>New Session</DialogTitle>
            <DialogDescription>
              Start a new conversation session with this agent.
            </DialogDescription>
          </DialogHeader>

          <div className="py-4">
            <Input
              placeholder="Session name"
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
            <Button type="submit" disabled={!name.trim() || createSession.isPending}>
              {createSession.isPending ? 'Creating...' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
